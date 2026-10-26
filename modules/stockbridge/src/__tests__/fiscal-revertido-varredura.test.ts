import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017 (ACXEGDP-437), research D21 — varredura do cron :05/:35 do recebimento fiscal revertido no portal do OMIE.
// Com o pool mockado (sem banco): o gate (chave da 016 + kill switch + migration 0060; a ACXE so habilitada), a fase A
// (marcar o ledger concluido que o sinal mostra revertido) e a fase B (e-mail ao fiscal quando a entrada fisica ja foi
// lancada e a nota nao volta a fila), com o aviso gravado so apos a entrega. O predicado SQL e o REAL
// (fiscalRevertidoSql); a marcacao (marcarLedgerRevertido) e o envio sao dubles — cada um tem teste proprio.

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  config: {} as Record<string, unknown>,
  /** quando preenchido, getConfig() lanca (config invalida) */
  configErro: null as Error | null,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  marcar: vi.fn(),
  enviar: vi.fn(),
  fiscalEmails: [] as string[],
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getConfig: () => {
    if (mocks.configErro) throw mocks.configErro;
    return mocks.config;
  },
  getPool: () => ({ query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params) }),
}));
vi.mock('../services/notificacao.service.js', () => ({
  enviarAvisoFiscalRevertido: (...a: unknown[]) => mocks.enviar(...a),
  getFiscalEmails: () => mocks.fiscalEmails,
}));
vi.mock('../services/fiscal-revertido.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/fiscal-revertido.js')>();
  return { ...real, marcarLedgerRevertido: (...a: unknown[]) => mocks.marcar(...a) };
});

import {
  VARREDURA_FISCAL_REVERTIDO_AVISAR_DIAS,
  VARREDURA_FISCAL_REVERTIDO_AVISAR_LIMITE,
  VARREDURA_FISCAL_REVERTIDO_MARCAR_DIAS,
  VARREDURA_FISCAL_REVERTIDO_MARCAR_LIMITE,
  varrerFiscaisRevertidos,
} from '../services/fiscal-revertido-varredura.service.js';
import { __resetColunaRevertido } from '../services/fiscal-revertido.js';
import { __resetEmpresaNacional } from '../services/empresa-nacional.js';

const CHAVE = '31261061827663002031550010000192521253216947';
const CHAVE_2 = '35261068176072000128550010000679881752445982';
const norm = (sql: unknown): string => String(sql).replace(/\s+/g, ' ').trim();
/** Consultas feitas ao pool (SQL normalizado + parametros), sem a conferencia da coluna da 0060. */
const consultas = () =>
  mocks.poolQuery.mock.calls
    .map((c) => ({ sql: norm(c[0]), params: c[1] as unknown[] | undefined }))
    .filter((c) => !c.sql.includes('information_schema.columns'));
const fase = (sqlInicio: string) => consultas().filter((c) => c.sql.startsWith(sqlInicio));
const FASE_A = 'SELECT rf.id::text AS id, rf.nf_chave_acesso FROM stockbridge.recebimento_fiscal rf';
const FASE_B = 'SELECT c.* FROM ( SELECT DISTINCT ON (rf.nf_chave_acesso)';
const ENTRADA = 'SELECT COUNT(*) FILTER';
const PCS = 'SELECT DISTINCT pc.pc_numero';
const AVISADO = 'UPDATE stockbridge.recebimento_fiscal SET aviso_fiscal_em = now()';

interface Banco {
  /** linhas da fase A por empresa */
  marcar?: Partial<Record<'q2p' | 'acxe', Array<Record<string, unknown>>>>;
  /** candidatos da fase B por empresa */
  candidatos?: Partial<Record<'q2p' | 'acxe', Array<Record<string, unknown>>>>;
  entrada?: Record<string, unknown>;
  pcs?: Array<{ pc_numero: string | null }>;
  /** erro por trecho de SQL */
  erro?: Record<string, Error>;
}

function banco(b: Banco = {}): void {
  mocks.poolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = norm(sql);
    if (s.includes('information_schema.columns')) return { rows: [{ ok: true }] };
    for (const [trecho, err] of Object.entries(b.erro ?? {})) if (s.includes(trecho)) throw err;
    const empresa = (params?.[0] as 'q2p' | 'acxe') ?? 'q2p';
    if (s.startsWith(FASE_A)) return { rows: b.marcar?.[empresa] ?? [] };
    if (s.startsWith(FASE_B)) return { rows: b.candidatos?.[empresa] ?? [] };
    if (s.startsWith(ENTRADA)) return { rows: [b.entrada ?? { pendentes: 1, aprovadas: 0, aprovada_em: null }] };
    if (s.startsWith(PCS)) return { rows: b.pcs ?? [] };
    return { rows: [] };
  });
}

const candidato = (over: Record<string, unknown> = {}) => ({
  ledger_id: 'led-1',
  nf_chave_acesso: CHAVE,
  nota_fiscal: '000019252',
  fornecedor_nome: 'ZARAPLAST S/A',
  finalizado_em: new Date('2026-10-25T20:02:01.437Z'),
  revertido_em: new Date('2026-10-25T20:35:00.000Z'),
  revertido_omie_em: new Date('2026-10-25T20:13:36.000Z'),
  ...over,
});

function configurar(over: Record<string, unknown> = {}): void {
  for (const k of Object.keys(mocks.config)) delete mocks.config[k];
  Object.assign(mocks.config, { STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: true, STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: true }, over);
}
const comAcxe = { STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED: true, STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE: '2026-10-01' };

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.marcar.mockReset();
  mocks.marcar.mockImplementation(async (a: { nfChaveAcesso: string; ledgerId?: string }) => [{ id: a.ledgerId ?? 'x', nfChaveAcesso: a.nfChaveAcesso, notaFiscal: '19252' }]);
  mocks.enviar.mockReset();
  mocks.enviar.mockResolvedValue('enviado');
  for (const f of Object.values(mocks.logger)) f.mockClear();
  mocks.configErro = null;
  mocks.fiscalEmails = ['nfe@acxe-polimeros.com.br', 'mauricio@acxe-polimeros.com.br'];
  configurar();
  __resetColunaRevertido();
  __resetEmpresaNacional();
  banco();
});

describe('varrerFiscaisRevertidos — gate', () => {
  it('sem a chave da 016, nem confere a coluna: nenhuma consulta, nada marcado, nada enviado', async () => {
    configurar({ STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: false });
    expect(await varrerFiscaisRevertidos()).toEqual({ marcados: 0, avisados: 0, falhas: 0 });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
    expect(mocks.marcar).not.toHaveBeenCalled();
    expect(mocks.enviar).not.toHaveBeenCalled();
  });

  it('kill switch STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED=false: nenhuma consulta', async () => {
    configurar({ STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: false });
    expect(await varrerFiscaisRevertidos()).toEqual({ marcados: 0, avisados: 0, falhas: 0 });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('com a ACXE habilitada mas a D21 desligada, a ACXE tambem nao consulta nada', async () => {
    configurar({ ...comAcxe, STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: false });
    await varrerFiscaisRevertidos();
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('migration 0060 ausente: so a conferencia da coluna (com erro no log); nada varrido', async () => {
    mocks.poolQuery.mockImplementation(async () => ({ rows: [{ ok: false }] }));
    expect(await varrerFiscaisRevertidos()).toEqual({ marcados: 0, avisados: 0, falhas: 0 });
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    expect(String(mocks.poolQuery.mock.calls[0]![0])).toContain("column_name = 'revertido_em'");
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('migration 0060'));
    expect(mocks.marcar).not.toHaveBeenCalled();
    expect(mocks.enviar).not.toHaveBeenCalled();
  });

  it('so a Q2P quando a ACXE nao esta habilitada (chave, fiscal e corte): nenhuma consulta com a empresa acxe', async () => {
    await varrerFiscaisRevertidos();
    expect(consultas().map((c) => c.params?.[0])).toEqual(['q2p', 'q2p']);
    expect(consultas().every((c) => !c.sql.includes('_ACXE"'))).toBe(true);
    // chave da ACXE ligada sem o corte: continua de fora
    configurar({ STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED: true });
    mocks.poolQuery.mockClear();
    await varrerFiscaisRevertidos();
    expect(consultas().map((c) => c.params?.[0])).toEqual(['q2p', 'q2p']);
  });

  it('ACXE habilitada: a Q2P PRIMEIRO, depois a ACXE, cada uma com as duas fases e as tabelas do seu espelho', async () => {
    configurar(comAcxe);
    await varrerFiscaisRevertidos();
    const c = consultas();
    expect(c.map((x) => x.params?.[0])).toEqual(['q2p', 'q2p', 'acxe', 'acxe']);
    expect(c[0]!.sql.startsWith(FASE_A)).toBe(true);
    expect(c[1]!.sql.startsWith(FASE_B)).toBe(true);
    expect(c[0]!.sql).toContain('"tbl_recebimentoNFe_Q2P"');
    expect(c[0]!.sql).not.toContain('_ACXE"');
    expect(c[2]!.sql.startsWith(FASE_A)).toBe(true);
    expect(c[3]!.sql.startsWith(FASE_B)).toBe(true);
    expect(c[2]!.sql).toContain('"tbl_recebimentoNFe_ACXE"');
    expect(c[2]!.sql).toContain('"tbl_nf_header_ACXE"');
    expect(c[2]!.sql).not.toContain('_Q2P"');
    expect(c[3]!.sql).not.toContain('_Q2P"');
  });

  it('a chave da ACXE e lida a CADA rodada: ligar ou desligar nao exige reiniciar o processo', async () => {
    await varrerFiscaisRevertidos();
    configurar(comAcxe);
    await varrerFiscaisRevertidos();
    configurar();
    await varrerFiscaisRevertidos();
    expect(consultas().map((c) => c.params?.[0])).toEqual(['q2p', 'q2p', 'q2p', 'q2p', 'acxe', 'acxe', 'q2p', 'q2p']);
  });
});

describe('varrerFiscaisRevertidos — fase A (marcar)', () => {
  it('a consulta pega ledgers concluido/ja_concluido recentes da empresa em que o SINAL esta ligado, os mais antigos primeiro, com limite', async () => {
    await varrerFiscaisRevertidos();
    const [a] = fase(FASE_A);
    expect(a!.sql).toContain('WHERE rf.empresa = $1');
    expect(a!.sql).toContain("rf.status IN ('concluido', 'ja_concluido')");
    expect(a!.sql).toContain('rf.finalizado_em > now() - make_interval(days => $2)');
    // o predicado real, avaliado sobre a chave do proprio ledger
    expect(a!.sql).toContain('AND COALESCE(GREATEST(');
    expect(a!.sql).toContain("rrp.c_chave_nfe = rf.nf_chave_acesso AND rrp.c_recebido = 'N'");
    expect(a!.sql).toContain("rfr.nf_chave_acesso = rf.nf_chave_acesso AND rfr.status = 'revertido'");
    expect(a!.sql).toContain('ORDER BY rf.finalizado_em LIMIT $3');
    expect(a!.params).toEqual(['q2p', VARREDURA_FISCAL_REVERTIDO_MARCAR_DIAS, VARREDURA_FISCAL_REVERTIDO_MARCAR_LIMITE]);
    expect(VARREDURA_FISCAL_REVERTIDO_MARCAR_DIAS).toBe(14);
  });

  it('cada ledger achado e marcado com origem "espelho" (que re-confere o sinal no UPDATE); conta os marcados', async () => {
    banco({ marcar: { q2p: [{ id: 'led-1', nf_chave_acesso: CHAVE }, { id: 'led-2', nf_chave_acesso: CHAVE_2 }] } });
    const r = await varrerFiscaisRevertidos();
    expect(r).toEqual({ marcados: 2, avisados: 0, falhas: 0 });
    expect(mocks.marcar.mock.calls.map((c) => c[0])).toEqual([
      { nfChaveAcesso: CHAVE, empresa: 'q2p', origem: 'espelho', ledgerId: 'led-1' },
      { nfChaveAcesso: CHAVE_2, empresa: 'q2p', origem: 'espelho', ledgerId: 'led-2' },
    ]);
    expect(mocks.logger.info).toHaveBeenCalledWith({ marcados: 2, avisados: 0, falhas: 0 }, expect.stringContaining('Varredura de recebimento fiscal revertido'));
  });

  it('outra requisicao marcou antes (UPDATE sem linhas) ou o sinal desligou: nao conta como marcado', async () => {
    banco({ marcar: { q2p: [{ id: 'led-1', nf_chave_acesso: CHAVE }] } });
    mocks.marcar.mockResolvedValue([]);
    expect(await varrerFiscaisRevertidos()).toEqual({ marcados: 0, avisados: 0, falhas: 0 });
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('a ACXE marca com a empresa da ACXE', async () => {
    configurar(comAcxe);
    banco({ marcar: { acxe: [{ id: 'led-9', nf_chave_acesso: CHAVE_2 }] } });
    expect((await varrerFiscaisRevertidos()).marcados).toBe(1);
    expect(mocks.marcar).toHaveBeenCalledTimes(1);
    expect(mocks.marcar).toHaveBeenCalledWith({ nfChaveAcesso: CHAVE_2, empresa: 'acxe', origem: 'espelho', ledgerId: 'led-9' });
  });

  it('uma NF que falha ao marcar nao impede as outras; o erro e logado e a fase B ainda roda', async () => {
    banco({ marcar: { q2p: [{ id: 'led-1', nf_chave_acesso: CHAVE }, { id: 'led-2', nf_chave_acesso: CHAVE_2 }] } });
    mocks.marcar.mockRejectedValueOnce(new Error('23514 check violation'));
    mocks.marcar.mockResolvedValueOnce([{ id: 'led-2', nfChaveAcesso: CHAVE_2, notaFiscal: '67988' }]);
    const r = await varrerFiscaisRevertidos();
    expect(r.marcados).toBe(1);
    expect(mocks.marcar).toHaveBeenCalledTimes(2);
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.objectContaining({ ledgerId: 'led-1' }), expect.stringContaining('Falha ao marcar'));
    expect(fase(FASE_B)).toHaveLength(1);
  });

  it('erro de banco na consulta da fase A: logado, nao lanca, e a fase B (que le o que o clique marcou) ainda roda', async () => {
    banco({ erro: { 'SELECT rf.id::text AS id': new Error('connection terminated') }, candidatos: { q2p: [candidato()] } });
    await expect(varrerFiscaisRevertidos()).resolves.toEqual({ marcados: 0, avisados: 1, falhas: 0 });
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.objectContaining({ fase: 'marcar', empresa: 'q2p' }), expect.stringContaining('Falha na varredura'));
    expect(mocks.enviar).toHaveBeenCalledTimes(1);
  });
});

describe('varrerFiscaisRevertidos — fase B (avisar o fiscal)', () => {
  it('a consulta: reversao recente sem aviso, AINDA revertida pelo sinal, com entrada fisica ativa e sem dispensa ativa; uma por NF, limite', async () => {
    await varrerFiscaisRevertidos();
    const [b] = fase(FASE_B);
    expect(b!.sql).toContain("SELECT DISTINCT ON (rf.nf_chave_acesso) rf.id::text AS ledger_id, rf.nf_chave_acesso, rf.nota_fiscal, rf.fornecedor_nome, rf.finalizado_em, rf.revertido_em, rf.revertido_omie_em, rf.recebido_antes");
    expect(b!.sql).toContain("WHERE rf.empresa = $1 AND rf.status = 'revertido' AND rf.aviso_fiscal_em IS NULL");
    expect(b!.sql).toContain('rf.revertido_em > now() - make_interval(days => $2)');
    // entrada fisica ATIVA: movimentacao ativa de compra_nacional com a chave (pendente de aprovacao ou aprovada)
    expect(b!.sql).toContain(
      "EXISTS (SELECT 1 FROM stockbridge.movimentacao m WHERE m.nf_chave_acesso = rf.nf_chave_acesso AND m.subtipo = 'compra_nacional' AND m.ativo = true)",
    );
    // sem dispensa ativa
    expect(b!.sql).toContain('NOT EXISTS (SELECT 1 FROM stockbridge.nf_dispensa d WHERE d.nf_chave_acesso = rf.nf_chave_acesso AND d.revertido_em IS NULL)');
    // ainda revertido: o mesmo sinal da fila (uma conclusao mais nova o desliga)
    expect(b!.sql).toContain('AND COALESCE(GREATEST(');
    expect(b!.sql).toContain("rrc.c_chave_nfe = rf.nf_chave_acesso AND rrc.c_recebido = 'S'");
    // o ledger revertido conta como a conclusao que foi desfeita: o aviso nao depende de a nota de entrada ja estar
    // no espelho de NF (sem isso, marcada a reversao, o sinal sem nenhuma outra conclusao viraria falso)
    expect(b!.sql).toContain(
      "WHERE rfc.nf_chave_acesso = rf.nf_chave_acesso AND rfc.status IN ('concluido', 'ja_concluido', 'revertido'))",
    );
    expect(b!.sql).toContain('ORDER BY rf.nf_chave_acesso, rf.revertido_em DESC ) c ORDER BY c.revertido_em LIMIT $3');
    expect(b!.params).toEqual(['q2p', VARREDURA_FISCAL_REVERTIDO_AVISAR_DIAS, VARREDURA_FISCAL_REVERTIDO_AVISAR_LIMITE]);
    expect(VARREDURA_FISCAL_REVERTIDO_AVISAR_DIAS).toBe(7);
    expect(VARREDURA_FISCAL_REVERTIDO_AVISAR_LIMITE).toBe(10);
  });

  it('sem candidato: nenhuma consulta de detalhe, nenhum e-mail, nada marcado', async () => {
    expect(await varrerFiscaisRevertidos()).toEqual({ marcados: 0, avisados: 0, falhas: 0 });
    expect(fase(ENTRADA)).toHaveLength(0);
    expect(fase(PCS)).toHaveLength(0);
    expect(fase(AVISADO)).toHaveLength(0);
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('NF 19252: o e-mail leva NF sem zeros, fornecedor do ledger, conclusao, hora do OMIE, situacao da entrada e PCs legiveis — e NENHUM codigo do OMIE', async () => {
    banco({
      candidatos: { q2p: [candidato()] },
      entrada: { pendentes: 0, aprovadas: 1, aprovada_em: new Date('2026-10-26T14:00:00.000Z') },
      pcs: [{ pc_numero: '308' }],
    });
    const r = await varrerFiscaisRevertidos();
    expect(r).toEqual({ marcados: 0, avisados: 1, falhas: 0 });
    expect(mocks.enviar).toHaveBeenCalledTimes(1);
    const args = mocks.enviar.mock.calls[0]![0] as Record<string, unknown>;
    expect(args).toEqual({
      empresa: 'q2p',
      notaFiscal: '19252',
      fornecedorNome: 'ZARAPLAST S/A',
      concluidoEm: new Date('2026-10-25T20:02:01.437Z'),
      desfeitoEm: new Date('2026-10-25T20:13:36.000Z'),
      entrada: { pendentes: 0, aprovadas: 1, aprovadaEm: new Date('2026-10-26T14:00:00.000Z') },
      pcs: ['308'],
    });
    // nenhum campo carrega a chave de acesso nem id interno do OMIE
    expect(JSON.stringify(args)).not.toMatch(/\d{10}/);
    expect(JSON.stringify(args)).not.toContain(CHAVE);
  });

  it('ledger ja_concluido (recebido_antes S: o fiscal concluiu no portal e o Atlas so viu): o aviso sai com concluidoForaDoAtlas', async () => {
    banco({ candidatos: { q2p: [candidato({ recebido_antes: 'S' })] }, entrada: { pendentes: 1, aprovadas: 0, aprovada_em: null } });
    await varrerFiscaisRevertidos();
    expect(mocks.enviar.mock.calls[0]![0]).toMatchObject({ concluidoForaDoAtlas: true });
    // concluido pelo Atlas (recebido_antes N ou ausente): o campo nem vai
    mocks.enviar.mockClear();
    banco({ candidatos: { q2p: [candidato({ recebido_antes: 'N' })] }, entrada: { pendentes: 1, aprovadas: 0, aprovada_em: null } });
    await varrerFiscaisRevertidos();
    expect(mocks.enviar.mock.calls[0]![0]).not.toHaveProperty('concluidoForaDoAtlas');
  });

  it('os detalhes vem da chave (entrada fisica) e do ledger da tentativa (PCs); a hora do OMIE ausente cai na hora da deteccao', async () => {
    banco({ candidatos: { q2p: [candidato({ revertido_omie_em: null })] } });
    await varrerFiscaisRevertidos();
    const [entrada] = fase(ENTRADA);
    expect(entrada!.params).toEqual([CHAVE]);
    expect(entrada!.sql).toContain("m.nf_chave_acesso = $1 AND m.subtipo = 'compra_nacional' AND m.ativo = true");
    expect(entrada!.sql).toContain("a.tipo_aprovacao = 'entrada_manual'");
    const [pcs] = fase(PCS);
    expect(pcs!.params).toEqual(['led-1']);
    expect(pcs!.sql).toContain("pc.recebimento_fiscal_id = $1::uuid AND pc.status IN ('revertido', 'concluido')");
    expect((mocks.enviar.mock.calls[0]![0] as { desfeitoEm: Date }).desfeitoEm).toEqual(new Date('2026-10-25T20:35:00.000Z'));
  });

  it('contagens como texto (driver) viram numero; PCs repetidos e vazios saem, em ordem natural', async () => {
    banco({
      candidatos: { q2p: [candidato()] },
      entrada: { pendentes: '2', aprovadas: '0', aprovada_em: null },
      pcs: [{ pc_numero: '10' }, { pc_numero: '9' }, { pc_numero: ' 9 ' }, { pc_numero: '' }, { pc_numero: null }],
    });
    await varrerFiscaisRevertidos();
    const args = mocks.enviar.mock.calls[0]![0] as { entrada: unknown; pcs: string[] };
    expect(args.entrada).toEqual({ pendentes: 2, aprovadas: 0, aprovadaEm: null });
    expect(args.pcs).toEqual(['9', '10']);
  });

  it('fornecedor ausente no ledger segue como null (o e-mail trata); NF sem zeros e "0" quando so tem zeros', async () => {
    banco({ candidatos: { q2p: [candidato({ fornecedor_nome: null, nota_fiscal: '0000' })] } });
    await varrerFiscaisRevertidos();
    expect(mocks.enviar.mock.calls[0]![0]).toMatchObject({ fornecedorNome: null, notaFiscal: '0' });
  });

  it('e-mail entregue: grava aviso_fiscal_em de TODAS as reversoes da NF ainda sem aviso (uma NF nao avisa duas vezes)', async () => {
    banco({ candidatos: { q2p: [candidato()] } });
    await varrerFiscaisRevertidos();
    const [u] = fase(AVISADO);
    expect(u!.sql).toBe(
      "UPDATE stockbridge.recebimento_fiscal SET aviso_fiscal_em = now(), updated_at = now() WHERE nf_chave_acesso = $1 AND status = 'revertido' AND aviso_fiscal_em IS NULL",
    );
    expect(u!.params).toEqual([CHAVE]);
    // a marca so e gravada DEPOIS do envio (o UPDATE e a ultima consulta do pool neste cenario)
    expect(mocks.enviar.mock.invocationCallOrder[0]!).toBeLessThan(mocks.poolQuery.mock.invocationCallOrder.at(-1)!);
  });

  it('envio que nao saiu ("falha"): nada e marcado e a rodada seguinte tenta de novo', async () => {
    banco({ candidatos: { q2p: [candidato()] } });
    mocks.enviar.mockResolvedValue('falha');
    expect(await varrerFiscaisRevertidos()).toEqual({ marcados: 0, avisados: 0, falhas: 1 });
    expect(fase(AVISADO)).toHaveLength(0);
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ ledgerId: 'led-1', resultado: 'falha' }), expect.stringContaining('não saiu'));
    mocks.enviar.mockResolvedValue('enviado');
    expect(await varrerFiscaisRevertidos()).toEqual({ marcados: 0, avisados: 1, falhas: 0 });
    expect(mocks.enviar).toHaveBeenCalledTimes(2);
    expect(fase(AVISADO)).toHaveLength(1);
  });

  it('erro no envio: conta falha, loga, nao marca e segue com a proxima NF', async () => {
    banco({ candidatos: { q2p: [candidato(), candidato({ ledger_id: 'led-2', nf_chave_acesso: CHAVE_2, nota_fiscal: '67988' })] } });
    mocks.enviar.mockRejectedValueOnce(new Error('boom'));
    const r = await varrerFiscaisRevertidos();
    expect(r).toEqual({ marcados: 0, avisados: 1, falhas: 1 });
    expect(mocks.enviar).toHaveBeenCalledTimes(2);
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.objectContaining({ ledgerId: 'led-1' }), expect.stringContaining('Falha ao avisar o fiscal'));
    expect(fase(AVISADO).map((c) => c.params)).toEqual([[CHAVE_2]]);
  });

  it('erro nas consultas de detalhe de uma NF: falha dela (volta na proxima rodada), as outras seguem', async () => {
    banco({ candidatos: { q2p: [candidato(), candidato({ ledger_id: 'led-2', nf_chave_acesso: CHAVE_2, nota_fiscal: '67988' })] } });
    const base = mocks.poolQuery.getMockImplementation()!;
    mocks.poolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (norm(sql).startsWith(ENTRADA) && params?.[0] === CHAVE) throw new Error('deadlock');
      return base(sql, params);
    });
    expect(await varrerFiscaisRevertidos()).toEqual({ marcados: 0, avisados: 1, falhas: 1 });
    expect(mocks.enviar).toHaveBeenCalledTimes(1);
    expect(mocks.enviar.mock.calls[0]![0]).toMatchObject({ notaFiscal: '67988' });
    expect(fase(AVISADO).map((c) => c.params)).toEqual([[CHAVE_2]]);
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.objectContaining({ ledgerId: 'led-1' }), expect.stringContaining('Falha ao avisar o fiscal'));
  });

  it('e-mail entregue mas a marca nao gravou: conta como avisado, loga o erro e o aviso sera reenviado na proxima rodada', async () => {
    banco({ candidatos: { q2p: [candidato()] }, erro: { 'UPDATE stockbridge.recebimento_fiscal SET aviso_fiscal_em': new Error('connection reset') } });
    const r = await varrerFiscaisRevertidos();
    expect(r).toEqual({ marcados: 0, avisados: 1, falhas: 0 });
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.objectContaining({ ledgerId: 'led-1' }), expect.stringContaining('aviso_fiscal_em não foi gravado'));
  });

  it('lista de destinatarios vazia: warn, nenhuma consulta de detalhe, nenhum envio e NADA marcado (volta quando a lista voltar)', async () => {
    mocks.fiscalEmails = [];
    banco({ candidatos: { q2p: [candidato()] } });
    expect(await varrerFiscaisRevertidos()).toEqual({ marcados: 0, avisados: 0, falhas: 0 });
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(fase(ENTRADA)).toHaveLength(0);
    expect(fase(AVISADO)).toHaveLength(0);
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ empresa: 'q2p', candidatos: 1 }), expect.stringContaining('STOCKBRIDGE_FISCAL_EMAILS vazio'));
  });

  it('sem candidato e lista vazia: nem o warn (nada a avisar)', async () => {
    mocks.fiscalEmails = [];
    await varrerFiscaisRevertidos();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('varias NFs: um e-mail por NF, na ordem da consulta, cada um com o seu ledger e a sua chave nas consultas de detalhe', async () => {
    banco({ candidatos: { q2p: [candidato(), candidato({ ledger_id: 'led-2', nf_chave_acesso: CHAVE_2, nota_fiscal: '67988', fornecedor_nome: 'ISOFORMA' })] } });
    expect((await varrerFiscaisRevertidos()).avisados).toBe(2);
    expect(mocks.enviar.mock.calls.map((c) => (c[0] as { notaFiscal: string }).notaFiscal)).toEqual(['19252', '67988']);
    expect(fase(ENTRADA).map((c) => c.params)).toEqual([[CHAVE], [CHAVE_2]]);
    expect(fase(PCS).map((c) => c.params)).toEqual([['led-1'], ['led-2']]);
    expect(fase(AVISADO).map((c) => c.params)).toEqual([[CHAVE], [CHAVE_2]]);
  });

  it('a ACXE avisa com a empresa da ACXE', async () => {
    configurar(comAcxe);
    banco({ candidatos: { acxe: [candidato({ nf_chave_acesso: CHAVE_2 })] } });
    expect((await varrerFiscaisRevertidos()).avisados).toBe(1);
    expect(mocks.enviar).toHaveBeenCalledTimes(1);
    expect(mocks.enviar.mock.calls[0]![0]).toMatchObject({ empresa: 'acxe' });
  });
});

describe('varrerFiscaisRevertidos — nunca lanca', () => {
  it('erro de banco nas duas fases: logado como erro, contadores zerados, sem excecao', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('information_schema.columns')) return { rows: [{ ok: true }] };
      throw new Error('connection terminated');
    });
    await expect(varrerFiscaisRevertidos()).resolves.toEqual({ marcados: 0, avisados: 0, falhas: 0 });
    expect(mocks.logger.error).toHaveBeenCalledTimes(2);
  });

  it('espelho ou coluna ausente (42P01 / 42703, tambem em `cause`): aviso no log, nao erro; a Q2P nao e afetada pela ACXE', async () => {
    configurar(comAcxe);
    const ausente = Object.assign(new Error('relation "tbl_recebimentoNFe_ACXE" does not exist'), { code: '42P01' });
    mocks.poolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      const s = norm(sql);
      if (s.includes('information_schema.columns')) return { rows: [{ ok: true }] };
      if (params?.[0] === 'acxe') throw new Error('falha de driver', { cause: ausente });
      if (s.startsWith(FASE_A)) return { rows: [{ id: 'led-1', nf_chave_acesso: CHAVE }] };
      return { rows: [] };
    });
    const r = await varrerFiscaisRevertidos();
    expect(r.marcados).toBe(1);
    expect(mocks.marcar).toHaveBeenCalledTimes(1);
    expect(mocks.logger.error).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ empresa: 'acxe', fase: 'marcar' }), expect.stringContaining('Tabela ou coluna ausente'));
  });

  it('falha ao ler a configuracao ou o gate: nao lanca e nao consulta nada', async () => {
    mocks.configErro = new Error('config invalida');
    await expect(varrerFiscaisRevertidos()).resolves.toEqual({ marcados: 0, avisados: 0, falhas: 0 });
    expect(mocks.logger.error).toHaveBeenCalled();
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });
});
