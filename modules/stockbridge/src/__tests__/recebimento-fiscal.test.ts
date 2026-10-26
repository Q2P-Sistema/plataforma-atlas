import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Feature 016 (ACXEGDP-395) — concluirRecebimentoFiscal (T022, T037 + revisao pre-UAT).
// OMIE e ledger mockados: o que importa aqui e a ORDEM (ledger em_andamento ANTES
// da primeira chamada OMIE; Consultar -> EDITAR -> IGNORAR -> Concluir), os
// payloads (EDITAR com cNaoGerarMovEstoque S / cNaoGerarFinanceiro N; IGNORAR sem
// itensAjustes), as recusas ANTES de escrever (fornecedor 0, etapa, bloqueio,
// devolucao), a espera apos falha (cache de ~1 min), o token do lock e as
// mensagens sem codigo OMIE (313).

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const poolQuerySpy = vi.fn();
const consultarSpy = vi.fn();
const alterarSpy = vi.fn();
const concluirSpy = vi.fn();
// D21 da 017 (fiscal revertido no portal): o sinal e a marcacao tem testes proprios (fiscal-revertido.test.ts); aqui sao spies.
// Default: D21 desligada — o ledger se comporta como na 016 (jaConcluido sem OMIE, sem SQL de sinal).
const revertido = vi.hoisted(() => ({
  habilitado: vi.fn(),
  nfRevertida: vi.fn(),
  marcar: vi.fn(),
  colunaExiste: vi.fn(),
}));

vi.mock('../services/fiscal-revertido.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/fiscal-revertido.js')>();
  return {
    ...real,
    fiscalRevertidoHabilitado: (...a: unknown[]) => revertido.habilitado(...a),
    nfComFiscalRevertido: (...a: unknown[]) => revertido.nfRevertida(...a),
    marcarLedgerRevertido: (...a: unknown[]) => revertido.marcar(...a),
    colunaRevertidoExiste: (...a: unknown[]) => revertido.colunaExiste(...a),
  };
});

vi.mock('@atlas/core', () => ({
  createLogger: () => loggerMock,
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  getConfig: () => ({ STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: true }),
}));

vi.mock('@atlas/integration-omie', () => ({
  consultarRecebimentoNfe: (...a: unknown[]) => consultarSpy(...a),
  alterarRecebimentoNfeItens: (...a: unknown[]) => alterarSpy(...a),
  concluirRecebimentoNfe: (...a: unknown[]) => concluirSpy(...a),
}));

vi.mock('../services/correlacao-produto.service.js', () => ({
  sugerirProdutosEmLote: vi.fn().mockResolvedValue(new Map()),
}));

import {
  concluirRecebimentoFiscal,
  listarLedgerFiscal,
  RecebimentoFiscalError,
  RecebimentoFiscalEmAndamentoError,
  RecebimentoFiscalAguardeError,
  RecebimentoFiscalSemFornecedorError,
  RecebimentoFiscalNfCanceladaError,
  RecebimentoFiscalEtapaInesperadaError,
  LOCK_FISCAL_ORFAO_MIN,
  ESPERA_APOS_FALHA_SEG,
  segundosAteNovaTentativa,
} from '../services/recebimento-fiscal.service.js';

const CHAVE = '35261014555032000753550010000068421827355174';
const N_ID_RECEB = 8510564869;
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN = '2026-10-02 10:00:00.123456-03';

const itemRec = (nSequencia: number, over: Record<string, unknown> = {}) => ({
  nSequencia,
  cDescricaoProduto: `SUCATA PLASTICO ${nSequencia}`,
  cCodigoProduto: 'SUCPLA',
  cNCM: '3915.90.00',
  cCFOP: '5.102',
  cCFOPEntrada: '1.102',
  nQtdeNFe: 9000,
  cUnidadeNfe: 'KG',
  nPrecoUnit: 11.3,
  vTotalItem: 101700,
  cIgnorarItem: 'N',
  cAssociarExistente: 'N',
  cAdicionarNovo: 'S',
  nIdItem: 0,
  nIdProduto: 0,
  cNaoGerarMovEstoque: 'N',
  cNaoGerarFinanceiro: 'N',
  ...over,
});

const recebimento = (over: Record<string, unknown> = {}) => ({
  nIdReceb: N_ID_RECEB,
  cChaveNFe: CHAVE,
  cNumeroNFe: '000006842',
  cEtapa: '40',
  dEmissaoNFe: '01/10/2026',
  nIdFornecedor: 8498397152,
  cCNPJ_CPF: '14.555.032/0007-53',
  cRazaoSocial: 'REPLAS COMERCIAL LTDA',
  nValorNFe: 203400,
  cRecebido: 'N',
  cCancelada: 'N',
  cBloqueado: 'N',
  cDevolvido: 'N',
  cUsuarioRec: null,
  dRec: null,
  hRec: null,
  // nSequencia da RESPOSTA (3 e 7), nao do espelho — e isto que vai no EDITAR/IGNORAR
  itens: [itemRec(3), itemRec(7)],
  ...over,
});

const input = (over: Partial<Parameters<typeof concluirRecebimentoFiscal>[0]> = {}) => ({
  nfChaveAcesso: CHAVE,
  nIdReceb: null,
  notaFiscal: '6842',
  fornecedorNome: 'REPLAS COMERCIAL LTDA',
  userId: USER,
  ...over,
});

/** Linha do tempo do que aconteceu (ledger + OMIE), para provar a ordem. */
let ordem: string[] = [];
/** Params de cada UPDATE de fechamento do ledger. */
let fechamentos: unknown[][] = [];
/** O INSERT do ledger falha com este erro (uma vez). */
let insertFalha: unknown = null;
/** O INSERT do ledger falha com este erro em TODA tentativa (a trava segue ocupada por outra requisicao). */
let insertFalhaSempre: unknown = null;
/** Linha viva devolvida pelo SELECT apos 23505. */
let linhaViva: Record<string, unknown> | null = null;
/** O UPDATE de retomada do lock orfao encontra a linha? */
let retomadaOk = false;
/** Segundos restantes da espera apos falha (null = sem falha recente). */
let esperaSegundos: number | null = null;
/** Sequencia de respostas da espera, consumida chamada a chamada (tem prioridade sobre esperaSegundos). */
let esperaFila: Array<number | null> = [];
/** O UPDATE de fechamento acha a linha (false = lock perdido)? */
let fechamentoAcha = true;
/** O UPDATE de fechamento lanca (banco fora)? */
let fechamentoLanca = false;
let ledgerRows: Record<string, unknown>[] = [];
/** 017 (T042): linhas de recebimento_fiscal_pc devolvidas para a listagem do ledger */
let vinculoRows: Record<string, unknown>[] = [];

function responderLedger(sql: string, params?: unknown[]) {
  if (sql.includes("status = 'falha'") && sql.includes('make_interval(secs')) {
    ordem.push('ledger:espera?');
    const seg = esperaFila.length > 0 ? esperaFila.shift()! : esperaSegundos;
    return { rows: seg != null ? [{ segundos: seg }] : [] };
  }
  if (sql.includes('INSERT INTO stockbridge.recebimento_fiscal')) {
    ordem.push('ledger:insert');
    if (insertFalha || insertFalhaSempre) {
      const e = insertFalha ?? insertFalhaSempre;
      insertFalha = null;
      throw e;
    }
    return { rows: [{ id: 'ledger-1', token: TOKEN }] };
  }
  if (sql.includes('SELECT id, status, iniciado_em')) return { rows: linhaViva ? [linhaViva] : [] };
  if (sql.includes('make_interval(mins')) {
    ordem.push('ledger:retomar');
    return { rows: retomadaOk ? [{ id: String(linhaViva?.id ?? 'ledger-0'), token: 'TOKEN-RETOMADA' }] : [] };
  }
  if (sql.includes('UPDATE stockbridge.recebimento_fiscal') && sql.includes('SET status = $2')) {
    ordem.push(`ledger:${String(params?.[1])}`);
    fechamentos.push(params ?? []);
    if (fechamentoLanca) throw new Error('connection terminated');
    return { rows: fechamentoAcha ? [{ finalizado_em: '2026-10-02 10:00:00+00' }] : [] };
  }
  if (sql.includes('FROM stockbridge.recebimento_fiscal_pc pc')) return { rows: vinculoRows };
  if (sql.includes('FROM stockbridge.recebimento_fiscal rf')) return { rows: ledgerRows };
  return { rows: [] };
}

/** ordem sem a consulta de espera (que roda em toda aquisicao) */
const ordemSemEspera = () => ordem.filter((o) => o !== 'ledger:espera?');

beforeEach(() => {
  ordem = [];
  fechamentos = [];
  insertFalha = null;
  insertFalhaSempre = null;
  linhaViva = null;
  retomadaOk = false;
  esperaSegundos = null;
  esperaFila = [];
  fechamentoAcha = true;
  fechamentoLanca = false;
  ledgerRows = [];
  vinculoRows = [];
  for (const f of Object.values(loggerMock)) f.mockClear();
  revertido.habilitado.mockReset().mockResolvedValue(false);
  revertido.nfRevertida.mockReset().mockResolvedValue(false);
  revertido.marcar.mockReset().mockResolvedValue([]);
  revertido.colunaExiste.mockReset().mockResolvedValue(true);
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation(async (sql: string, params?: unknown[]) => responderLedger(sql, params));
  consultarSpy.mockReset();
  consultarSpy.mockImplementation(async () => {
    ordem.push('omie:consultar');
    return recebimento();
  });
  alterarSpy.mockReset();
  alterarSpy.mockImplementation(async (_cnpj: string, i: { nIdReceb: number; itens: Array<{ cAcao: string }> }) => {
    ordem.push(`omie:${i.itens[0]!.cAcao.toLowerCase()}`);
    return { nIdReceb: i.nIdReceb, cCodStatus: '0', cDescStatus: 'ok' };
  });
  concluirSpy.mockReset();
  concluirSpy.mockImplementation(async (_cnpj: string, i: { nIdReceb: number }) => {
    ordem.push('omie:concluir');
    return { nIdReceb: i.nIdReceb, cCodStatus: '0', cDescStatus: 'Recebimento concluído com sucesso!' };
  });
});

const fault = (code: string, message: string) => Object.assign(new Error(message), { omieCode: code });
const consultaUnica = (over: Record<string, unknown>) =>
  consultarSpy.mockImplementationOnce(async () => {
    ordem.push('omie:consultar');
    return recebimento(over);
  });

describe('concluirRecebimentoFiscal — caminho feliz (US1)', () => {
  it('ledger em_andamento ANTES do OMIE; Consultar -> EDITAR -> IGNORAR -> Concluir; ledger concluido com itens_total e token do lock', async () => {
    const r = await concluirRecebimentoFiscal(input());

    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'omie:editar', 'omie:ignorar', 'omie:concluir', 'ledger:concluido']);
    expect(ordem[0]).toBe('ledger:espera?'); // a espera apos falha e checada antes do INSERT
    expect(r).toMatchObject({ status: 'concluido', ledgerId: 'ledger-1', itensTotal: 2 });
    expect(r.concluidoEm).toBe(new Date('2026-10-02 10:00:00+00').toISOString());

    const ins = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO stockbridge.recebimento_fiscal'))!;
    expect(ins[0]).toContain("'em_andamento'");
    expect(ins[0]).toContain('RETURNING id, iniciado_em::text AS token');
    expect(ins[1]).toEqual([CHAVE, null, '6842', 'REPLAS COMERCIAL LTDA', USER, 'q2p']);  // 017: empresa

    expect(consultarSpy).toHaveBeenCalledWith('q2p', { cChaveNfe: CHAVE });

    // fechamento: so a linha deste dono (status em_andamento + mesmo iniciado_em)
    const upd = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('SET status = $2'))!;
    expect(String(upd[0])).toContain("WHERE id = $1 AND status = 'em_andamento' AND iniciado_em = $10::timestamptz");
    // 017: $11 itens_vinculados — null = receita da 016 (nenhum item com PC)
    expect(fechamentos[0]).toEqual(['ledger-1', 'concluido', N_ID_RECEB, '40', 'N', 2, null, null, null, TOKEN, null]);
  });

  it('EDITAR leva cNaoGerarMovEstoque S + cNaoGerarFinanceiro N (nSequencia da consulta); IGNORAR vai sem itensAjustes; Concluir na etapa 60', async () => {
    await concluirRecebimentoFiscal(input());

    expect(alterarSpy).toHaveBeenCalledTimes(2);
    const [editar, ignorar] = alterarSpy.mock.calls.map((c) => c[1] as { nIdReceb: number; itens: Array<Record<string, unknown>> });
    expect(editar!.nIdReceb).toBe(N_ID_RECEB);
    expect(editar!.itens).toEqual([
      { nSequencia: 3, cAcao: 'EDITAR', itensAjustes: { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' } },
      { nSequencia: 7, cAcao: 'EDITAR', itensAjustes: { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' } },
    ]);
    expect(ignorar!.itens).toEqual([
      { nSequencia: 3, cAcao: 'IGNORAR' },
      { nSequencia: 7, cAcao: 'IGNORAR' },
    ]);
    for (const it of ignorar!.itens) expect(it).not.toHaveProperty('itensAjustes');
    expect(alterarSpy.mock.calls[0]![0]).toBe('q2p');
    expect(concluirSpy).toHaveBeenCalledTimes(1);
    expect(concluirSpy).toHaveBeenCalledWith('q2p', { nIdReceb: N_ID_RECEB, cEtapa: '60' });
  });

  it('nIdReceb do espelho e gravado no INSERT, mas o usado nas escritas e o da consulta', async () => {
    consultaUnica({ nIdReceb: 999 });
    await concluirRecebimentoFiscal(input({ nIdReceb: 111 }));
    const ins = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO stockbridge.recebimento_fiscal'))!;
    expect((ins[1] as unknown[])[1]).toBe(111);
    expect((alterarSpy.mock.calls[0]![1] as { nIdReceb: number }).nIdReceb).toBe(999);
    expect(concluirSpy).toHaveBeenCalledWith('q2p', { nIdReceb: 999, cEtapa: '60' });
    expect(fechamentos[0]![2]).toBe(999);
  });
});

describe('concluirRecebimentoFiscal — passos ja feitos sao pulados (revisao pre-UAT, FISC-2)', () => {
  it('itens que ja tem os ajustes (EDITAR feito numa tentativa anterior): sem EDITAR, so IGNORAR + Concluir', async () => {
    consultaUnica({ itens: [itemRec(3, { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' }), itemRec(7, { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' })] });
    const r = await concluirRecebimentoFiscal(input());
    expect(r.status).toBe('concluido');
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'omie:ignorar', 'omie:concluir', 'ledger:concluido']);
  });

  it('itens ja ignorados (EDITAR+IGNORAR feitos, Concluir falhou antes): nenhum AlterarRecebimento — EDITAR em item ignorado nunca e enviado', async () => {
    consultaUnica({ itens: [itemRec(3, { cIgnorarItem: 'S', cNaoGerarMovEstoque: 'S' }), itemRec(7, { cIgnorarItem: 'S', cNaoGerarMovEstoque: 'N' })] });
    await concluirRecebimentoFiscal(input());
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'omie:concluir', 'ledger:concluido']);
  });

  it('mistura: so o item pendente recebe EDITAR e IGNORAR', async () => {
    consultaUnica({ itens: [itemRec(3, { cIgnorarItem: 'S' }), itemRec(7)] });
    await concluirRecebimentoFiscal(input());
    const [editar, ignorar] = alterarSpy.mock.calls.map((c) => (c[1] as { itens: Array<{ nSequencia: number }> }).itens.map((i) => i.nSequencia));
    expect(editar).toEqual([7]);
    expect(ignorar).toEqual([7]);
  });
});

describe('concluirRecebimentoFiscal — ja concluido (FR-011)', () => {
  it('OMIE ja mostra cRecebido=S: nenhuma escrita, ledger ja_concluido', async () => {
    // concluido no portal SEM movimentar estoque (item com "nao movimentar" ou ignorado) — com
    // estoque seria ESTOQUE_JA_LANCADO_PELO_OMIE (017, D7; ver recebimento-fiscal-pc.test.ts)
    consultaUnica({
      cRecebido: 'S', cEtapa: '60', cUsuarioRec: 'gustavo',
      itens: [itemRec(3, { cNaoGerarMovEstoque: 'S' }), itemRec(7, { cIgnorarItem: 'S' })],
    });
    const r = await concluirRecebimentoFiscal(input());
    expect(r.status).toBe('ja_concluido');
    expect(r.itensTotal).toBe(0);
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'ledger:ja_concluido']);
    expect(fechamentos[0]!.slice(1, 5)).toEqual(['ja_concluido', N_ID_RECEB, '60', 'S']);
  });

  it('ledger ja tem linha concluida para a chave (23505): devolve ja_concluido SEM chamar o OMIE', async () => {
    insertFalha = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'recebimento_fiscal_nf_viva_uq' });
    linhaViva = { id: 'ledger-antigo', status: 'concluido', iniciado_em: '2026-10-02 09:00:00+00', finalizado_em: '2026-10-02 09:00:05+00' };
    const r = await concluirRecebimentoFiscal(input());
    expect(r).toMatchObject({ status: 'ja_concluido', ledgerId: 'ledger-antigo', itensTotal: 0 });
    expect(r.concluidoEm).toBe(new Date('2026-10-02 09:00:05+00').toISOString());
    expect(consultarSpy).not.toHaveBeenCalled();
    expect(fechamentos).toHaveLength(0);
  });
});

describe('concluirRecebimentoFiscal — lock e espera (research D6, revisao pre-UAT)', () => {
  it('outra confirmacao em andamento (recente): RecebimentoFiscalEmAndamentoError e zero OMIE', async () => {
    insertFalha = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'recebimento_fiscal_nf_viva_uq' });
    linhaViva = { id: 'ledger-vivo', status: 'em_andamento', iniciado_em: '2026-10-02 09:59:50+00', finalizado_em: null };
    retomadaOk = false;
    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalEmAndamentoError);
    insertFalha = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'recebimento_fiscal_nf_viva_uq' });
    await expect(concluirRecebimentoFiscal(input())).rejects.toThrow(/NF 6842 já está sendo concluído/);
    expect(consultarSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'ledger:retomar', 'ledger:insert', 'ledger:retomar']);
  });

  it(`lock orfao (mais de ${LOCK_FISCAL_ORFAO_MIN} min): retoma com NOVO token e fecha com ele`, async () => {
    insertFalha = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'recebimento_fiscal_nf_viva_uq' });
    linhaViva = { id: 'ledger-orfao', status: 'em_andamento', iniciado_em: '2026-10-02 08:00:00+00', finalizado_em: null };
    retomadaOk = true;
    const r = await concluirRecebimentoFiscal(input());
    expect(r).toMatchObject({ status: 'concluido', ledgerId: 'ledger-orfao' });
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'ledger:retomar', 'omie:consultar', 'omie:editar', 'omie:ignorar', 'omie:concluir', 'ledger:concluido']);
    const ret = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('make_interval(mins'))!;
    expect((ret[1] as unknown[])[3]).toBe(LOCK_FISCAL_ORFAO_MIN);
    expect(LOCK_FISCAL_ORFAO_MIN).toBeGreaterThanOrEqual(15);
    expect(fechamentos[0]![9]).toBe('TOKEN-RETOMADA');  // $10 = token (017 acrescentou $11 itens_vinculados)
  });

  it('23505 de OUTRO indice nao e tratado como lock — propaga', async () => {
    insertFalha = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'outro_idx' });
    await expect(concluirRecebimentoFiscal(input())).rejects.toThrow('duplicate key');
  });

  it(`falha com escrita ha menos de ${ESPERA_APOS_FALHA_SEG} s: RecebimentoFiscalAguardeError, sem INSERT e sem OMIE (cache de ~1 min)`, async () => {
    esperaSegundos = 42;
    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input());
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(RecebimentoFiscalAguardeError);
    expect((erro as Error).message).toContain('NF 6842');
    expect((erro as Error).message).toContain('42 segundos');
    expect(ordem).toEqual(['ledger:espera?']);
    expect(consultarSpy).not.toHaveBeenCalled();
    const sel = poolQuerySpy.mock.calls[0]!;
    expect(String(sel[0])).toContain("passo_falha IN ('associar', 'editar', 'ignorar', 'concluir')");  // 017: associar e escrita
    expect(sel[1]).toEqual([CHAVE, ESPERA_APOS_FALHA_SEG]);
  });

  it('a espera tambem vale na recursao: a outra requisicao fechou em falha entre o INSERT e o SELECT -> Aguarde, sem OMIE (verificacao pos-correcao)', async () => {
    insertFalha = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'recebimento_fiscal_nf_viva_uq' });
    linhaViva = null; // a linha viva sumiu: a outra requisicao fechou em 'falha'
    esperaFila = [null, 55]; // 1a checagem vazia (a outra ainda nao tinha fechado); na recursao, falha recente
    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalAguardeError);
    expect(ordem.filter((o) => o === 'ledger:espera?')).toHaveLength(2);
    expect(consultarSpy).not.toHaveBeenCalled();
  });

  it('segundosAteNovaTentativa: 70 s depois de falha com escrita, 0 na consulta, o restante no Aguarde; mensagem no singular para 1 s', () => {
    expect(segundosAteNovaTentativa(new RecebimentoFiscalError('concluir', '6842', null))).toBe(ESPERA_APOS_FALHA_SEG);
    expect(segundosAteNovaTentativa(new RecebimentoFiscalError('editar', '6842', null))).toBe(ESPERA_APOS_FALHA_SEG);
    expect(segundosAteNovaTentativa(new RecebimentoFiscalError('consultar', '6842', null))).toBe(0);
    expect(segundosAteNovaTentativa(new RecebimentoFiscalAguardeError('6842', 12))).toBe(12);
    expect(new RecebimentoFiscalAguardeError('6842', 1).message).toContain('1 segundo e');
    expect(new RecebimentoFiscalAguardeError('6842', 2).message).toContain('2 segundos');
  });

  it('lock perdido para uma retomada: o desfecho desta requisicao nao sobrescreve o ledger (warn) e o resultado segue', async () => {
    fechamentoAcha = false;
    const r = await concluirRecebimentoFiscal(input());
    expect(r.status).toBe('concluido');
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.objectContaining({ ledgerId: 'ledger-1' }), expect.stringContaining('Lock fiscal perdido'));
  });
});

describe('concluirRecebimentoFiscal — falhas (FR-012, STK-23 sem retry)', () => {
  it('fault em EDITAR: reconsulta por nIdReceb (outro corpo), ledger falha com passo/erro, RecebimentoFiscalError sem codigo OMIE', async () => {
    alterarSpy.mockImplementationOnce(async () => {
      ordem.push('omie:editar');
      throw fault('SOAP-ENV:Client-5001', 'Recebimento nao localizado para o id 8510564869');
    });
    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input());
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(RecebimentoFiscalError);
    const e = erro as RecebimentoFiscalError;
    expect(e.passo).toBe('editar');
    expect(e.message).toContain('NF 6842');
    expect(e.message).toContain('REPLAS COMERCIAL LTDA');
    expect(e.message).toContain('tente novamente em 1 minuto');
    expect(e.message).not.toContain('8510564869');
    expect(e.message).not.toContain('Client-5001');
    expect((e as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);

    expect(consultarSpy).toHaveBeenCalledTimes(2);
    expect(consultarSpy.mock.calls[1]).toEqual(['q2p', { nIdReceb: N_ID_RECEB }]);
    expect(alterarSpy).toHaveBeenCalledTimes(1);
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(ordem.at(-1)).toBe('ledger:falha');
    expect(fechamentos[0]!.slice(1, 9)).toEqual(['falha', N_ID_RECEB, '40', 'N', 2, 'editar', 'SOAP-ENV:Client-5001', 'Recebimento nao localizado para o id 8510564869']);
    // o erro do OMIE vai para o log ANTES da escrita no ledger (FISC-6)
    const iLog = loggerMock.error.mock.invocationCallOrder[0]!;
    const iUpd = poolQuerySpy.mock.invocationCallOrder[poolQuerySpy.mock.calls.findIndex((c) => String(c[0]).includes('SET status = $2'))]!;
    expect(iLog).toBeLessThan(iUpd);
  });

  it('timeout em Concluir mas a reconsulta mostra cRecebido=S: tratado como ja_concluido (gravou no OMIE)', async () => {
    concluirSpy.mockImplementationOnce(async () => {
      ordem.push('omie:concluir');
      throw new Error('timeout of 30000ms exceeded');
    });
    consultarSpy
      .mockImplementationOnce(async () => {
        ordem.push('omie:consultar');
        return recebimento();
      })
      .mockImplementationOnce(async () => {
        ordem.push('omie:reconsultar');
        // o EDITAR do Atlas ja tinha marcado "nao movimentar estoque" antes do Concluir
        return recebimento({
          cRecebido: 'S', cEtapa: '60', cUsuarioRec: 'WEBSERVICE',
          itens: [itemRec(3, { cNaoGerarMovEstoque: 'S', cIgnorarItem: 'S' }), itemRec(7, { cNaoGerarMovEstoque: 'S', cIgnorarItem: 'S' })],
        });
      });
    const r = await concluirRecebimentoFiscal(input());
    expect(r.status).toBe('ja_concluido');
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'omie:editar', 'omie:ignorar', 'omie:concluir', 'omie:reconsultar', 'ledger:ja_concluido']);
    expect(fechamentos[0]![1]).toBe('ja_concluido');
    expect(String(fechamentos[0]![8])).toContain('[concluir] timeout');
  });

  it('fault em IGNORAR e reconsulta tambem falha: ledger falha no passo ignorar e erro propaga', async () => {
    alterarSpy
      .mockImplementationOnce(async (_c: string, i: { nIdReceb: number }) => {
        ordem.push('omie:editar');
        return { nIdReceb: i.nIdReceb, cCodStatus: '0', cDescStatus: 'ok' };
      })
      .mockImplementationOnce(async () => {
        ordem.push('omie:ignorar');
        throw fault('SOAP-ENV:Client-151', 'Erro ao ignorar item');
      });
    consultarSpy
      .mockImplementationOnce(async () => {
        ordem.push('omie:consultar');
        return recebimento();
      })
      .mockImplementationOnce(async () => {
        throw new Error('ECONNRESET');
      });
    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalError);
    expect(fechamentos[0]![1]).toBe('falha');
    expect(fechamentos[0]![6]).toBe('ignorar');
    expect(fechamentos[0]![7]).toBe('SOAP-ENV:Client-151');
    expect(concluirSpy).not.toHaveBeenCalled();
  });

  it('falha na propria consulta inicial: ledger falha no passo consultar, sem reconsulta', async () => {
    consultarSpy.mockImplementationOnce(async () => {
      ordem.push('omie:consultar');
      throw fault('SOAP-ENV:Server', 'Servico indisponivel');
    });
    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalError);
    expect(consultarSpy).toHaveBeenCalledTimes(1);
    expect(fechamentos[0]![6]).toBe('consultar');
    expect(alterarSpy).not.toHaveBeenCalled();
  });

  it('banco cai ao gravar a falha no ledger: o erro de dominio ainda sobe e o fault do OMIE ja esta no log (FISC-6)', async () => {
    alterarSpy.mockImplementationOnce(async () => {
      ordem.push('omie:editar');
      throw fault('SOAP-ENV:Client-7777', 'falha qualquer');
    });
    fechamentoLanca = true;
    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalError);
    expect(loggerMock.error).toHaveBeenCalledWith(expect.objectContaining({ omieCodigo: 'SOAP-ENV:Client-7777', passo: 'editar' }), expect.any(String));
    expect(loggerMock.error).toHaveBeenCalledWith(expect.objectContaining({ ledgerId: 'ledger-1', desfecho: 'falha' }), expect.stringContaining('ledger fiscal'));
  });

  it("fault em Concluir e a reconsulta segue 'N': ledger falha com passo_falha='concluir' e erro_omie_*", async () => {
    concluirSpy.mockImplementationOnce(async () => {
      ordem.push('omie:concluir');
      throw fault('SOAP-ENV:Client-7001', 'Nao foi possivel concluir o recebimento');
    });
    await expect(concluirRecebimentoFiscal(input())).rejects.toMatchObject({ name: 'RecebimentoFiscalError', passo: 'concluir' });
    expect(consultarSpy).toHaveBeenCalledTimes(2);
    expect(fechamentos[0]!.slice(1, 9)).toEqual(['falha', N_ID_RECEB, '40', 'N', 2, 'concluir', 'SOAP-ENV:Client-7001', 'Nao foi possivel concluir o recebimento']);
  });

  it('fault em EDITAR mas a reconsulta mostra cRecebido=S (concluido no portal no meio): ja_concluido e zero escrita adicional', async () => {
    alterarSpy.mockImplementationOnce(async () => {
      ordem.push('omie:editar');
      throw fault('SOAP-ENV:Client-5002', 'Recebimento ja concluido');
    });
    consultarSpy
      .mockImplementationOnce(async () => {
        ordem.push('omie:consultar');
        return recebimento();
      })
      .mockImplementationOnce(async () => {
        ordem.push('omie:reconsultar');
        // concluido no portal com "nao movimentar estoque" (com estoque: ESTOQUE_JA_LANCADO — 017, D7)
        return recebimento({
          cRecebido: 'S', cEtapa: '60', cUsuarioRec: 'gustavo',
          itens: [itemRec(3, { cNaoGerarMovEstoque: 'S' }), itemRec(7, { cNaoGerarMovEstoque: 'S' })],
        });
      });
    const r = await concluirRecebimentoFiscal(input());
    expect(r.status).toBe('ja_concluido');
    expect(alterarSpy).toHaveBeenCalledTimes(1);
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'omie:editar', 'omie:reconsultar', 'ledger:ja_concluido']);
    expect(consultarSpy.mock.calls[0]).toEqual(['q2p', { cChaveNfe: CHAVE }]);
    expect(consultarSpy.mock.calls[1]).toEqual(['q2p', { nIdReceb: N_ID_RECEB }]);
  });

  it("nova tentativa apos 'falha' abre linha NOVA em_andamento: o indice unico do ledger e parcial e exclui 'falha' (migration 0053)", async () => {
    const sql = readFileSync(resolve(__dirname, '../../../../packages/db/migrations/0053_stockbridge_recebimento_fiscal_nf.sql'), 'utf8');
    expect(sql).toMatch(/recebimento_fiscal_nf_viva_uq[\s\S]*?WHERE status IN \('em_andamento', 'concluido', 'ja_concluido'\)/);
    concluirSpy.mockImplementationOnce(async () => {
      ordem.push('omie:concluir');
      throw new Error('timeout');
    });
    await expect(concluirRecebimentoFiscal(input())).rejects.toMatchObject({ name: 'RecebimentoFiscalError' });
    ordem.length = 0;
    // passado o tempo de espera (o mock da espera devolve vazio), a nova tentativa abre linha nova
    const r = await concluirRecebimentoFiscal(input());
    expect(r.status).toBe('concluido');
    expect(ordemSemEspera()[0]).toBe('ledger:insert');
    expect(ordem).not.toContain('ledger:retomar');
  });
});

describe('concluirRecebimentoFiscal — recusas ANTES de escrever no OMIE', () => {
  it('fornecedor nao cadastrado na forma REAL do OMIE (NF 1257: nIdFornecedor 0 normalizado para null, sem CNPJ): recusa sem escrita', async () => {
    consultaUnica({ nIdFornecedor: null, cRazaoSocial: null, cCNPJ_CPF: null, cNumeroNFe: '000001257' });
    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input({ notaFiscal: '1257', fornecedorNome: null }));
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(RecebimentoFiscalSemFornecedorError);
    expect((erro as Error).message).toContain('NF 1257');
    expect((erro as Error).message).toContain('sem fornecedor cadastrado');
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(fechamentos[0]![1]).toBe('falha');
    expect(fechamentos[0]![6]).toBe('consultar');
  });

  it('nIdFornecedor 0 que escape do parser (defesa em profundidade) tambem recusa; idem CNPJ ausente com id preenchido', async () => {
    consultaUnica({ nIdFornecedor: 0 });
    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalSemFornecedorError);
    consultaUnica({ cCNPJ_CPF: null });
    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalSemFornecedorError);
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
  });

  it('fault do OMIE falando em fornecedor nao cadastrado tambem vira RecebimentoFiscalSemFornecedorError', async () => {
    alterarSpy.mockImplementationOnce(async () => {
      ordem.push('omie:editar');
      throw Object.assign(new Error('Fornecedor não cadastrado para o CNPJ informado'), { omieCode: 'SOAP-ENV:Client-102' });
    });
    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalSemFornecedorError);
    expect(fechamentos[0]![1]).toBe('falha');
  });

  it('NF cancelada no OMIE: RecebimentoFiscalNfCanceladaError, nenhuma escrita', async () => {
    consultaUnica({ cCancelada: 'S' });
    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalNfCanceladaError);
    expect(alterarSpy).not.toHaveBeenCalled();
  });

  it.each([
    [{ cEtapa: '50' }, 'etapa', /Faturado pelo fornecedor/],
    [{ cEtapa: '' }, 'etapa', /Faturado pelo fornecedor/],
    [{ cBloqueado: 'S' }, 'bloqueado', /bloqueado no OMIE/],
    [{ cDevolvido: 'S' }, 'devolvido', /devolvida no OMIE/],
  ])('%o: RecebimentoFiscalEtapaInesperadaError (%s), nenhuma escrita (receita so validada na etapa 40)', async (over, motivo, msg) => {
    consultaUnica(over as Record<string, unknown>);
    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input());
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(RecebimentoFiscalEtapaInesperadaError);
    expect((erro as RecebimentoFiscalEtapaInesperadaError).motivo).toBe(motivo);
    expect((erro as Error).message).toMatch(msg);
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(fechamentos[0]![6]).toBe('consultar');
  });

  it('consulta sem itens: RecebimentoFiscalError no passo consultar (nada a editar)', async () => {
    consultaUnica({ itens: [] });
    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalError);
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(fechamentos[0]![6]).toBe('consultar');
  });
});

describe('listarLedgerFiscal (contrato §7)', () => {
  it('mapeia as linhas e NAO expoe erro_omie_* (fica no banco e no log)', async () => {
    ledgerRows = [
      {
        id: 'l1', nf_chave_acesso: CHAVE, nota_fiscal: '6842', fornecedor_nome: 'REPLAS COMERCIAL LTDA', status: 'concluido',
        passo_falha: null, itens_total: 1, confirmado_por: USER, confirmado_por_nome: 'Gustavo',
        iniciado_em: '2026-10-02 10:00:00+00', finalizado_em: '2026-10-02 10:00:04+00',
      },
    ];
    const lista = await listarLedgerFiscal({ status: 'concluido', limit: 10 });
    const chamada = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('FROM stockbridge.recebimento_fiscal rf'))!;
    const sql = String(chamada[0]);
    expect(sql).not.toContain('erro_omie');
    expect(sql).toContain('rf.status = $2');
    expect(chamada[1]).toEqual([10, 'concluido']);
    // 017 (T042): os vinculos da pagina vem numa segunda consulta, tambem sem erro_omie_*
    const vinc = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('FROM stockbridge.recebimento_fiscal_pc pc'))!;
    expect(String(vinc[0])).not.toContain('erro_omie');
    expect(vinc[1]).toEqual([['l1']]);
    expect(lista[0]).toMatchObject({ empresa: 'q2p', vinculos: [] });
    expect(lista[0]).toMatchObject({ id: 'l1', notaFiscal: '6842', status: 'concluido', itensTotal: 1, confirmadoPor: { id: USER, nome: 'Gustavo' } });
    expect(lista[0]!.finalizadoEm).toBe(new Date('2026-10-02 10:00:04+00').toISOString());
  });
});

describe('listarLedgerFiscal — vinculos com PC (017, T042)', () => {
  it('cada tentativa traz empresa e vinculos[] legiveis (numero do PC, origem, justificativa, quem e quando) — sem erro_omie_*', async () => {
    ledgerRows = [
      {
        id: 'l1', nf_chave_acesso: CHAVE, nota_fiscal: '7813', fornecedor_nome: 'REPLAS COMERCIAL LTDA', status: 'concluido',
        passo_falha: null, itens_total: 1, confirmado_por: USER, confirmado_por_nome: 'Gustavo',
        iniciado_em: '2026-10-22 10:00:00+00', finalizado_em: '2026-10-22 10:00:06+00', empresa: 'q2p',
      },
      {
        id: 'l2', nf_chave_acesso: CHAVE, nota_fiscal: '7813', fornecedor_nome: 'REPLAS COMERCIAL LTDA', status: 'falha',
        passo_falha: 'associar', itens_total: 1, confirmado_por: USER, confirmado_por_nome: 'Gustavo',
        iniciado_em: '2026-10-22 09:58:00+00', finalizado_em: '2026-10-22 09:58:03+00', empresa: 'q2p',
      },
    ];
    vinculoRows = [
      { recebimento_fiscal_id: 'l2', n_sequencia: 1, pc_numero: '302', origem: 'manual', justificativa: 'PC certo era o 302', status: 'falha', confirmado_por: USER, confirmado_por_nome: 'Gustavo', confirmado_em: '2026-10-22 09:58:00+00' },
      { recebimento_fiscal_id: 'l1', n_sequencia: 1, pc_numero: '302', origem: 'manual', justificativa: 'PC certo era o 302', status: 'concluido', confirmado_por: USER, confirmado_por_nome: 'Gustavo', confirmado_em: '2026-10-22 10:00:00+00' },
    ];
    const lista = await listarLedgerFiscal({ limit: 10 });
    expect(lista[0]).toMatchObject({ id: 'l1', empresa: 'q2p' });
    expect(lista[0]!.vinculos).toEqual([
      {
        nSequencia: 1, pcNumero: '302', origem: 'manual', justificativa: 'PC certo era o 302', status: 'concluido',
        confirmadoPor: { id: USER, nome: 'Gustavo' }, confirmadoEm: new Date('2026-10-22 10:00:00+00').toISOString(),
      },
    ]);
    expect(lista[1]).toMatchObject({ id: 'l2', passoFalha: 'associar', vinculos: [expect.objectContaining({ status: 'falha' })] });
    expect(JSON.stringify(lista)).not.toContain('erro_omie');
    const vinc = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('FROM stockbridge.recebimento_fiscal_pc pc'))!;
    expect(vinc[1]).toEqual([['l1', 'l2']]);
  });

  it('pagina vazia: nenhuma consulta de vinculos', async () => {
    ledgerRows = [];
    expect(await listarLedgerFiscal({})).toEqual([]);
    expect(poolQuerySpy.mock.calls.some((c) => String(c[0]).includes('recebimento_fiscal_pc'))).toBe(false);
  });
});

// ── D21 da 017 — fiscal REVERTIDO no portal do OMIE (NF 19252, 25/10/2026) ──────────────────────────
// A conclusao `concluido`/`ja_concluido` deixou de ser final: quando o espelho mostra o recebimento pendente
// DEPOIS da conclusao, adquirirLedger marca a linha 'revertido' (marcarLedgerRevertido faz os vinculos de PC
// na mesma transacao) e recomeca a aquisicao — o indice parcial so lista os status vivos, entao o INSERT passa.
// O sinal em si (SQL, margem, fuso) e a marcacao (transacao) tem testes proprios em fiscal-revertido.test.ts e
// no banco real; aqui prova-se o ENCAIXE no ledger: ordem, recursao, corrida, limite e o que nunca muda.
describe('concluirRecebimentoFiscal — fiscal revertido no portal (D21 da 017)', () => {
  const violacaoViva = () => Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'recebimento_fiscal_nf_viva_uq' });
  const concluidaPeloAtlas = (over: Record<string, unknown> = {}) => ({
    id: 'ledger-antigo', status: 'concluido', iniciado_em: '2026-10-25 20:01:00+00', finalizado_em: '2026-10-25 20:02:05+00', empresa: 'q2p', ...over,
  });
  const marcouAntigo = async () => {
    ordem.push('ledger:revertido');
    return [{ id: 'ledger-antigo', nfChaveAcesso: CHAVE, notaFiscal: '6842' }];
  };

  beforeEach(() => {
    revertido.habilitado.mockResolvedValue(true);
    revertido.marcar.mockImplementation(marcouAntigo);
    insertFalha = violacaoViva();
    linhaViva = concluidaPeloAtlas();
  });

  it('sinal ligado: marca o ledger como revertido (origem espelho, a linha lida) e abre a trava NOVA — o fiscal roda de novo', async () => {
    revertido.nfRevertida.mockResolvedValue(true);

    const r = await concluirRecebimentoFiscal(input());

    expect(ordemSemEspera()).toEqual([
      'ledger:insert', 'ledger:revertido', 'ledger:insert', 'omie:consultar', 'omie:editar', 'omie:ignorar', 'omie:concluir', 'ledger:concluido',
    ]);
    expect(r).toMatchObject({ status: 'concluido', ledgerId: 'ledger-1', itensTotal: 2 });
    expect(revertido.nfRevertida).toHaveBeenCalledWith(CHAVE, 'q2p');
    expect(revertido.marcar).toHaveBeenCalledTimes(1);
    expect(revertido.marcar).toHaveBeenCalledWith({ nfChaveAcesso: CHAVE, empresa: 'q2p', origem: 'espelho', ledgerId: 'ledger-antigo' });
    // a conclusao nova fecha a linha NOVA, com o token dela — nunca a antiga
    expect(fechamentos).toHaveLength(1);
    expect(fechamentos[0]![0]).toBe('ledger-1');
    expect(fechamentos[0]![9]).toBe(TOKEN);
    // a consulta do fiscal e por chave, como sempre (corpo A); a leitura por nIdReceb e so do clique
    expect(consultarSpy).toHaveBeenCalledWith('q2p', { cChaveNfe: CHAVE });
  });

  it('ja_concluido (fiscal feito no portal e visto pelo Atlas) revertido depois: a mesma reabertura', async () => {
    linhaViva = concluidaPeloAtlas({ status: 'ja_concluido' });
    revertido.nfRevertida.mockResolvedValue(true);

    const r = await concluirRecebimentoFiscal(input());

    expect(r.status).toBe('concluido');
    expect(revertido.marcar).toHaveBeenCalledWith(expect.objectContaining({ ledgerId: 'ledger-antigo', origem: 'espelho' }));
    expect(ordemSemEspera().slice(0, 3)).toEqual(['ledger:insert', 'ledger:revertido', 'ledger:insert']);
  });

  it('sem sinal: continua ja_concluido, sem OMIE, sem marcar — o clique repetido logo depois de concluir (comportamento da 016)', async () => {
    revertido.nfRevertida.mockResolvedValue(false);

    const r = await concluirRecebimentoFiscal(input());

    expect(r).toMatchObject({ status: 'ja_concluido', ledgerId: 'ledger-antigo', itensTotal: 0 });
    expect(r.concluidoEm).toBe(new Date('2026-10-25 20:02:05+00').toISOString());
    expect(revertido.nfRevertida).toHaveBeenCalledTimes(1);
    expect(revertido.marcar).not.toHaveBeenCalled();
    expect(consultarSpy).not.toHaveBeenCalled();
    expect(fechamentos).toHaveLength(0);
    expect(ordemSemEspera()).toEqual(['ledger:insert']);
  });

  it('D21 indisponivel (chave da 016, kill switch ou migration 0060 ausente): nem avalia o sinal — ja_concluido como na 016', async () => {
    revertido.habilitado.mockResolvedValue(false);
    revertido.nfRevertida.mockResolvedValue(true); // se fosse avaliado, reabriria

    const r = await concluirRecebimentoFiscal(input());

    expect(r.status).toBe('ja_concluido');
    expect(revertido.nfRevertida).not.toHaveBeenCalled();
    expect(revertido.marcar).not.toHaveBeenCalled();
    expect(consultarSpy).not.toHaveBeenCalled();
  });

  it('o sinal e a marcacao usam a empresa gravada no ledger (acxe); sem ela na linha, a da chamada', async () => {
    revertido.nfRevertida.mockResolvedValue(true);
    // a chamada nao diz a empresa (default q2p): vale a do ledger
    linhaViva = concluidaPeloAtlas({ empresa: 'acxe' });
    await concluirRecebimentoFiscal(input());
    expect(revertido.nfRevertida).toHaveBeenLastCalledWith(CHAVE, 'acxe');
    expect(revertido.marcar).toHaveBeenLastCalledWith({ nfChaveAcesso: CHAVE, empresa: 'acxe', origem: 'espelho', ledgerId: 'ledger-antigo' });

    // linha sem a coluna (nulo/ausente): vale a empresa da chamada
    insertFalha = violacaoViva();
    linhaViva = concluidaPeloAtlas({ empresa: null });
    await concluirRecebimentoFiscal(input({ empresa: 'acxe' }));
    expect(revertido.nfRevertida).toHaveBeenLastCalledWith(CHAVE, 'acxe');
    insertFalha = violacaoViva();
    linhaViva = concluidaPeloAtlas({ empresa: undefined });
    await concluirRecebimentoFiscal(input());
    expect(revertido.nfRevertida).toHaveBeenLastCalledWith(CHAVE, 'q2p');
  });

  it('a consulta da linha viva traz a empresa do ledger (sem mudar o prefixo que o harness reconhece)', async () => {
    revertido.nfRevertida.mockResolvedValue(false);
    await concluirRecebimentoFiscal(input());
    const viva = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('SELECT id, status, iniciado_em'))!;
    expect(String(viva[0])).toMatch(/SELECT id, status, iniciado_em::text AS iniciado_em, finalizado_em::text AS finalizado_em, empresa\s+FROM stockbridge\.recebimento_fiscal/);
    expect(String(viva[0])).toContain("status IN ('em_andamento', 'concluido', 'ja_concluido')");
  });

  it('corrida: a marcacao devolve 0 linhas (cron ou outro clique marcou antes) e a trava passou para outra requisicao -> EmAndamento, zero OMIE', async () => {
    revertido.nfRevertida.mockResolvedValue(true);
    revertido.marcar.mockImplementation(async () => {
      ordem.push('ledger:revertido');
      // enquanto isso, a outra requisicao gravou o em_andamento dela
      insertFalha = violacaoViva();
      linhaViva = { id: 'ledger-outro', status: 'em_andamento', iniciado_em: '2026-10-25 20:20:00+00', finalizado_em: null, empresa: 'q2p' };
      retomadaOk = false;
      return [];
    });

    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalEmAndamentoError);

    expect(ordemSemEspera()).toEqual(['ledger:insert', 'ledger:revertido', 'ledger:insert', 'ledger:retomar']);
    expect(consultarSpy).not.toHaveBeenCalled();
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(fechamentos).toHaveLength(0);
  });

  it('corrida: a marcacao devolve 0 linhas mas a trava esta livre (o cron marcou antes) -> a aquisicao segue e conclui', async () => {
    revertido.nfRevertida.mockResolvedValue(true);
    revertido.marcar.mockImplementation(async () => {
      ordem.push('ledger:revertido');
      return [];
    });

    const r = await concluirRecebimentoFiscal(input());

    expect(r).toMatchObject({ status: 'concluido', ledgerId: 'ledger-1' });
    expect(ordemSemEspera().slice(0, 3)).toEqual(['ledger:insert', 'ledger:revertido', 'ledger:insert']);
  });

  it('a espera apos falha com escrita tambem vale depois da reabertura (a recursao passa de novo por ela)', async () => {
    revertido.nfRevertida.mockResolvedValue(true);
    esperaFila = [null, 55];

    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalAguardeError);

    expect(ordem.filter((o) => o === 'ledger:espera?')).toHaveLength(2);
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'ledger:revertido']);
    expect(consultarSpy).not.toHaveBeenCalled();
  });

  it('dado oscilando (o sinal segue ligado e a marcacao nao resolve): reabre no maximo 2 vezes e entao pede para recarregar — nunca ja_concluido, que faria so o fisico', async () => {
    revertido.nfRevertida.mockResolvedValue(true);
    revertido.marcar.mockImplementation(async () => {
      ordem.push('ledger:revertido');
      return [];
    });
    insertFalha = null;
    insertFalhaSempre = violacaoViva(); // a trava nunca libera

    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalEmAndamentoError);

    expect(revertido.marcar).toHaveBeenCalledTimes(2);
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'ledger:revertido', 'ledger:insert', 'ledger:revertido', 'ledger:insert']);
    expect(consultarSpy).not.toHaveBeenCalled();
  });

  it('erro de banco ao marcar sobe como esta (500 na rota): nao segue para o OMIE nem devolve ja_concluido', async () => {
    revertido.nfRevertida.mockResolvedValue(true);
    revertido.marcar.mockRejectedValue(new Error('connection terminated'));

    await expect(concluirRecebimentoFiscal(input())).rejects.toThrow('connection terminated');

    expect(consultarSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual(['ledger:insert']);
  });

  it('em_andamento (duplo clique) e lock orfao nunca consultam o sinal: so a linha concluida pode ser reaberta', async () => {
    revertido.nfRevertida.mockResolvedValue(true);
    linhaViva = { id: 'ledger-vivo', status: 'em_andamento', iniciado_em: '2026-10-25 20:20:00+00', finalizado_em: null, empresa: 'q2p' };
    retomadaOk = false;
    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalEmAndamentoError);

    insertFalha = violacaoViva();
    linhaViva = { id: 'ledger-orfao', status: 'em_andamento', iniciado_em: '2026-10-25 08:00:00+00', finalizado_em: null, empresa: 'q2p' };
    retomadaOk = true;
    const r = await concluirRecebimentoFiscal(input());
    expect(r).toMatchObject({ status: 'concluido', ledgerId: 'ledger-orfao' });

    expect(revertido.nfRevertida).not.toHaveBeenCalled();
    expect(revertido.marcar).not.toHaveBeenCalled();
  });
});

describe('listarLedgerFiscal — fiscal revertido (D21 da 017, migration 0060)', () => {
  const linhaRevertida = {
    id: 'l9', nf_chave_acesso: CHAVE, nota_fiscal: '19252', fornecedor_nome: 'ZARAPLAST S/A', status: 'revertido',
    passo_falha: null, itens_total: 4, confirmado_por: USER, confirmado_por_nome: 'Operador',
    iniciado_em: '2026-10-25 20:01:00+00', finalizado_em: '2026-10-25 20:02:05+00', empresa: 'q2p',
    revertido_em: '2026-10-25 20:23:00+00', revertido_origem: 'espelho', revertido_omie_em: '2026-10-25 20:13:36+00',
  };

  it('devolve revertidoEm/revertidoOrigem/revertidoOmieEm (ISO) e nada de erro_omie_*; vinculo revertido aparece com o status', async () => {
    ledgerRows = [linhaRevertida];
    vinculoRows = [
      { recebimento_fiscal_id: 'l9', n_sequencia: 1, pc_numero: '308', origem: 'omie', justificativa: null, status: 'revertido', confirmado_por: USER, confirmado_por_nome: 'Operador', confirmado_em: '2026-10-25 20:01:30+00' },
    ];

    const lista = await listarLedgerFiscal({ status: 'revertido', limit: 10 });

    const chamada = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('FROM stockbridge.recebimento_fiscal rf'))!;
    const sql = String(chamada[0]);
    expect(sql).toContain('rf.revertido_em::text AS revertido_em');
    expect(sql).toContain('rf.revertido_origem');
    expect(sql).toContain('rf.revertido_omie_em::text AS revertido_omie_em');
    expect(sql).not.toContain('erro_omie');
    expect(sql).not.toContain('revertido_por'); // quem clicou fica no banco; a listagem nao o expoe
    expect(chamada[1]).toEqual([10, 'revertido']);
    expect(lista[0]).toMatchObject({
      id: 'l9', status: 'revertido', notaFiscal: '19252',
      revertidoEm: new Date('2026-10-25 20:23:00+00').toISOString(),
      revertidoOrigem: 'espelho',
      revertidoOmieEm: new Date('2026-10-25 20:13:36+00').toISOString(),
      vinculos: [expect.objectContaining({ nSequencia: 1, pcNumero: '308', status: 'revertido' })],
    });
    expect(JSON.stringify(lista)).not.toContain('erro_omie');
  });

  it('origem omie_ao_vivo sem a hora do OMIE (leitura ao vivo): revertidoOmieEm nulo; linha que nao e revertida traz os tres campos nulos', async () => {
    ledgerRows = [
      { ...linhaRevertida, revertido_origem: 'omie_ao_vivo', revertido_omie_em: null },
      { ...linhaRevertida, id: 'l1', status: 'concluido', revertido_em: null, revertido_origem: null, revertido_omie_em: null },
    ];
    const lista = await listarLedgerFiscal({});
    expect(lista[0]).toMatchObject({ revertidoOrigem: 'omie_ao_vivo', revertidoOmieEm: null });
    expect(lista[0]!.revertidoEm).toBe(new Date('2026-10-25 20:23:00+00').toISOString());
    expect(lista[1]).toMatchObject({ status: 'concluido', revertidoEm: null, revertidoOrigem: null, revertidoOmieEm: null });
  });

  it('antes da migration 0060 (coluna ausente): a listagem segue sem as colunas novas — nunca 42703 — e os campos saem nulos', async () => {
    revertido.colunaExiste.mockResolvedValue(false);
    ledgerRows = [{ ...linhaRevertida, status: 'concluido', revertido_em: undefined, revertido_origem: undefined, revertido_omie_em: undefined }];

    const lista = await listarLedgerFiscal({});

    const sql = String(poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('FROM stockbridge.recebimento_fiscal rf'))![0]);
    expect(sql).not.toContain('rf.revertido_em');
    expect(sql).not.toContain('rf.revertido_origem');
    expect(sql).not.toContain('rf.revertido_omie_em');
    expect(sql).toContain('NULL::text AS revertido_em');
    expect(lista[0]).toMatchObject({ revertidoEm: null, revertidoOrigem: null, revertidoOmieEm: null });
  });

  it('hora invalida no banco nao derruba a listagem: vira nula', async () => {
    ledgerRows = [{ ...linhaRevertida, revertido_em: 'nao-e-data' }];
    const lista = await listarLedgerFiscal({});
    expect(lista[0]!.revertidoEm).toBeNull();
  });
});
