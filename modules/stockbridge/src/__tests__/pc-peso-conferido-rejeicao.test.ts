import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017 (ACXEGDP-437), research D20 — gatilho do aviso a compras na rejeicao do gestor
// (avisarComprasSeRejeitouExcedente). As linhas vem do ledger recebimento_fiscal_pc: as sequencias do item da
// movimentacao rejeitada, com o vinculo `concluido` e kg_recebido_pc acima de qtd_nf_kg. Sem linhas, nada e enviado.
// Best-effort: erro de banco vira 'falha' no log, nunca excecao (quem chama nao espera).

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  enviarAviso: vi.fn(),
  contexto: vi.fn(),
  coluna0059: vi.fn(),
  destinatarios: ['compras@q2p.local', 'comprador@q2p.local'] as string[],
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getPool: () => ({ query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params) }),
}));
vi.mock('../services/notificacao.service.js', () => ({
  AVISO_COMPRAS_DEDUP_HORAS: 24,
  destinatariosAvisoCompras: () => ({ destinatarios: mocks.destinatarios, viaOps: false }),
  enviarAvisoComprasExcedenteRejeitado: (...a: unknown[]) => mocks.enviarAviso(...a),
  carregarContextoEntradaNacional: (...a: unknown[]) => mocks.contexto(...a),
}));
vi.mock('../services/pc-sugestao.service.js', () => ({
  colunaKgRecebidoPcExiste: () => mocks.coluna0059(),
}));

import { avisarComprasSeRejeitouExcedente, varrerExcedentesRejeitadosSemAviso, VARREDURA_EXCEDENTE_DIAS, VARREDURA_EXCEDENTE_LIMITE } from '../services/pc-peso-conferido.service.js';

const CHAVE = '35261068176072000128550010000679881752445982';
const ARGS = { aprovacaoId: 'apr-1', movimentacaoId: '11111111-1111-4111-8111-111111111111', motivo: 'Peso real igual ao da nota', usuarioId: 'gestor-1' };
const linha = (over: Record<string, unknown> = {}) => ({
  empresa: 'q2p',
  nf_chave_acesso: CHAVE,
  nota_fiscal: '67988',
  n_sequencia: 1,
  pc_numero: '305',
  qtd_nf_kg: 13382,
  kg_recebido_pc: 13500,
  fornecedor_nome: 'ISOFORMA (ledger)',
  ...over,
});

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.enviarAviso.mockReset();
  mocks.enviarAviso.mockResolvedValue('enviado');
  mocks.contexto.mockReset();
  mocks.contexto.mockResolvedValue({ porNf: true, notaFiscal: '67988', fornecedor: 'ISOFORMA', itemNf: 'PS AI A', produto: 'PS CRISTAL B', quantidadeKg: '13500', local: '11.2', entradaEm: null });
  mocks.logger.error.mockClear();
  mocks.coluna0059.mockReset();
  mocks.coluna0059.mockResolvedValue(true);
  mocks.destinatarios = ['compras@q2p.local', 'comprador@q2p.local'];
});

describe('avisarComprasSeRejeitouExcedente', () => {
  it('sem linha com peso conferido acima da NF: nada e enviado', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    expect(await avisarComprasSeRejeitouExcedente(ARGS)).toBe('sem_excedente');
    expect(mocks.enviarAviso).not.toHaveBeenCalled();
    expect(mocks.contexto).not.toHaveBeenCalled();
  });

  it('a consulta olha so as sequencias do item rejeitado, com o vinculo concluido e o baixado acima da NF', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    await avisarComprasSeRejeitouExcedente(ARGS);
    const [sql, params] = mocks.poolQuery.mock.calls[0]!;
    const s = String(sql).replace(/\s+/g, ' ');
    expect(s).toContain('pc.n_sequencia = ANY(m.nf_item_sequencias)');
    expect(s).toContain("pc.status = 'concluido'");
    expect(s).toContain('pc.kg_recebido_pc > pc.qtd_nf_kg + $2');
    expect(s).toContain("m.subtipo = 'compra_nacional'");
    expect(params).toEqual([ARGS.movimentacaoId, 0.001]);
  });

  it('com excedente: envia o aviso com as linhas, o contexto da entrada e o motivo da rejeicao', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [linha(), linha({ n_sequencia: '2', qtd_nf_kg: '1000.000', kg_recebido_pc: '1010.500' })] });
    expect(await avisarComprasSeRejeitouExcedente(ARGS)).toBe('enviado');
    expect(mocks.contexto).toHaveBeenCalledWith('apr-1');
    expect(mocks.enviarAviso).toHaveBeenCalledWith({
      empresa: 'q2p',
      nfChaveAcesso: CHAVE,
      notaFiscal: '67988',
      fornecedorNome: 'ISOFORMA',
      itemDescricao: 'PS AI A',
      produto: 'PS CRISTAL B',
      motivoRejeicao: 'Peso real igual ao da nota',
      linhas: [
        { nSequencia: 1, pcNumero: '305', qtdNfKg: 13382, kgRecebidoPc: 13500 },
        { nSequencia: 2, pcNumero: '305', qtdNfKg: 1000, kgRecebidoPc: 1010.5 },
      ],
      disparadoPor: 'gestor-1',
    });
  });

  it('sem contexto da entrada: usa o numero da NF da movimentacao, sem zeros a esquerda, e o fornecedor do ledger do fiscal', async () => {
    mocks.contexto.mockResolvedValue(null);
    mocks.poolQuery.mockResolvedValue({ rows: [linha({ nota_fiscal: '000067988', empresa: 'acxe' })] });
    await avisarComprasSeRejeitouExcedente(ARGS);
    expect(mocks.enviarAviso).toHaveBeenCalledWith(
      expect.objectContaining({ empresa: 'acxe', notaFiscal: '67988', fornecedorNome: 'ISOFORMA (ledger)', itemDescricao: null }),
    );
    expect(String(mocks.poolQuery.mock.calls[0]![0])).toContain('LEFT JOIN stockbridge.recebimento_fiscal rf ON rf.id = pc.recebimento_fiscal_id');
  });

  it('NF ainda fora do espelho de NF (contexto sem fornecedor): o nome vem do ledger do fiscal, nunca "nao identificado"', async () => {
    mocks.contexto.mockResolvedValue({ porNf: true, notaFiscal: '67988', fornecedor: null, itemNf: 'PS AI A', produto: null, quantidadeKg: '13500', local: '11.2', entradaEm: null });
    mocks.poolQuery.mockResolvedValue({ rows: [linha()] });
    await avisarComprasSeRejeitouExcedente(ARGS);
    expect(mocks.enviarAviso).toHaveBeenCalledWith(expect.objectContaining({ fornecedorNome: 'ISOFORMA (ledger)' }));
  });

  it('erro de banco: devolve falha, registra no log e nunca lanca', async () => {
    mocks.poolQuery.mockRejectedValue(new Error('column "kg_recebido_pc" does not exist'));
    await expect(avisarComprasSeRejeitouExcedente(ARGS)).resolves.toBe('falha');
    expect(mocks.logger.error).toHaveBeenCalled();
    expect(mocks.enviarAviso).not.toHaveBeenCalled();
  });
});

describe('avisarComprasSeRejeitouExcedente — sem a migration 0059', () => {
  it('sem a coluna kg_recebido_pc nao ha o que avisar: nenhuma consulta, nenhum e-mail', async () => {
    mocks.coluna0059.mockResolvedValue(false);
    expect(await avisarComprasSeRejeitouExcedente(ARGS)).toBe('sem_excedente');
    expect(mocks.poolQuery).not.toHaveBeenCalled();
    expect(mocks.enviarAviso).not.toHaveBeenCalled();
  });
});

// Revisao da D20 (achado 2b): o aviso da hora da rejeicao pode falhar; o cron :05/:35 varre as rejeicoes recentes.
describe('varrerExcedentesRejeitadosSemAviso', () => {
  const rejeicao = (n: number, over: Record<string, unknown> = {}) => ({
    aprovacao_id: `apr-${n}`, movimentacao_id: `mov-${n}`, rejeicao_motivo: `motivo ${n}`, aprovado_por: 'gestor-1',
    aprovado_em: new Date(`2026-10-2${n}T15:00:00Z`), ...over,
  });
  const roteia = (rejeicoes: Array<Record<string, unknown>>) =>
    mocks.poolQuery.mockImplementation(async (sql: string) =>
      String(sql).includes('FROM stockbridge.aprovacao a') ? { rows: rejeicoes } : { rows: [linha()] },
    );

  it('a consulta pega entrada rejeitada nos ultimos dias, movimentacao inativa, vinculo concluido acima da NF e sequencia sem aviso', async () => {
    roteia([]);
    expect(await varrerExcedentesRejeitadosSemAviso()).toBe(0);
    const [sql, params] = mocks.poolQuery.mock.calls[0]!;
    const s = String(sql).replace(/\s+/g, ' ');
    expect(s).toContain("a.tipo_aprovacao = 'entrada_manual'");
    expect(s).toContain("a.status = 'rejeitada'");
    expect(s).toContain('a.aprovado_em > now() - make_interval(days => $2)');
    expect(s).toContain('m.ativo = false');
    expect(s).toContain("pc.status = 'concluido'");
    expect(s).toContain('pc.kg_recebido_pc > pc.qtd_nf_kg + $1');
    expect(s).toContain("av.motivo = 'excedente_rejeitado'");
    expect(s).toContain("av.itens @> jsonb_build_array(jsonb_build_object('nSequencia', pc.n_sequencia))");
    // aviso de rejeicao ANTIGA do mesmo item nao cobre a nova: so conta o enviado depois dela ou ate 24 h antes
    expect(s).toContain('av.enviado_em > a.aprovado_em - make_interval(hours => $4)');
    // falta algum destinatario ATUAL de compras: a rejeicao volta (entrega parcial)
    expect(s).toContain('FROM unnest($5::text[]) AS dest(email)');
    expect(s).toContain("dest.email = ANY (SELECT lower(btrim(x)) FROM unnest(string_to_array(av.enviado_para, ',')) AS x)");
    expect(params).toEqual([0.001, VARREDURA_EXCEDENTE_DIAS, VARREDURA_EXCEDENTE_LIMITE, 24, ['compras@q2p.local', 'comprador@q2p.local']]);
    // a hora da rejeicao volta para ancorar a deduplicacao do envio (2a revisao, achado 4)
    expect(s).toContain('a.aprovado_por::text AS aprovado_por, a.aprovado_em');
    expect(VARREDURA_EXCEDENTE_DIAS).toBe(7);
  });

  it('destinatarios em caixa e com espacos: comparados em minusculas', async () => {
    mocks.destinatarios = [' Compras@Q2P.local '];
    roteia([]);
    await varrerExcedentesRejeitadosSemAviso();
    expect((mocks.poolQuery.mock.calls[0]![1] as unknown[])[4]).toEqual(['compras@q2p.local']);
  });

  it('cada rejeicao achada vira um aviso, com o motivo da rejeicao e quem rejeitou', async () => {
    roteia([rejeicao(1), rejeicao(2, { rejeicao_motivo: null })]);
    expect(await varrerExcedentesRejeitadosSemAviso()).toBe(2);
    expect(mocks.enviarAviso).toHaveBeenCalledTimes(2);
    expect(mocks.enviarAviso.mock.calls[0]![0]).toMatchObject({ motivoRejeicao: 'motivo 1', disparadoPor: 'gestor-1', coberturaDesde: new Date('2026-10-21T15:00:00Z') });
    expect(mocks.enviarAviso.mock.calls[1]![0]).toMatchObject({ motivoRejeicao: 'Motivo não registrado', coberturaDesde: new Date('2026-10-22T15:00:00Z') });
    expect(mocks.contexto).toHaveBeenNthCalledWith(1, 'apr-1');
  });

  it('sem a coluna da 0059: nada a varrer; erro de banco: 0 e log, nunca lanca', async () => {
    mocks.coluna0059.mockResolvedValue(false);
    expect(await varrerExcedentesRejeitadosSemAviso()).toBe(0);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
    mocks.coluna0059.mockResolvedValue(true);
    mocks.poolQuery.mockRejectedValue(new Error('connection terminated'));
    await expect(varrerExcedentesRejeitadosSemAviso()).resolves.toBe(0);
    expect(mocks.logger.error).toHaveBeenCalled();
  });
});
