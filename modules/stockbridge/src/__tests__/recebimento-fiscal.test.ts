import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Feature 016 (ACXEGDP-395) — concluirRecebimentoFiscal (T022).
// OMIE e ledger mockados: o que importa aqui e a ORDEM (ledger em_andamento ANTES
// da primeira chamada OMIE; Consultar -> EDITAR -> IGNORAR -> Concluir), os
// payloads (EDITAR com cNaoGerarMovEstoque S / cNaoGerarFinanceiro N; IGNORAR sem
// itensAjustes), o fechamento do ledger e as mensagens sem codigo OMIE (313).

const poolQuerySpy = vi.fn();
const consultarSpy = vi.fn();
const alterarSpy = vi.fn();
const concluirSpy = vi.fn();

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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
  RecebimentoFiscalSemFornecedorError,
  RecebimentoFiscalNfCanceladaError,
} from '../services/recebimento-fiscal.service.js';

const CHAVE = '35261014555032000753550010000068421827355174';
const N_ID_RECEB = 8510564869;
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const itemRec = (nSequencia: number) => ({
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
/** Linha viva devolvida pelo SELECT apos 23505. */
let linhaViva: Record<string, unknown> | null = null;
/** O UPDATE de retomada do lock orfao encontra a linha? */
let retomadaOk = false;
let ledgerRows: Record<string, unknown>[] = [];

function responderLedger(sql: string, params?: unknown[]) {
  if (sql.includes('INSERT INTO stockbridge.recebimento_fiscal')) {
    ordem.push('ledger:insert');
    if (insertFalha) {
      const e = insertFalha;
      insertFalha = null;
      throw e;
    }
    return { rows: [{ id: 'ledger-1' }] };
  }
  if (sql.includes('SELECT id, status, iniciado_em')) return { rows: linhaViva ? [linhaViva] : [] };
  if (sql.includes('make_interval')) {
    ordem.push('ledger:retomar');
    return { rows: retomadaOk ? [{ id: String(linhaViva?.id ?? 'ledger-0') }] : [] };
  }
  if (sql.includes('UPDATE stockbridge.recebimento_fiscal') && sql.includes('SET status = $2')) {
    ordem.push(`ledger:${String(params?.[1])}`);
    fechamentos.push(params ?? []);
    return { rows: [{ finalizado_em: '2026-10-02 10:00:00+00' }] };
  }
  if (sql.includes('FROM stockbridge.recebimento_fiscal rf')) return { rows: ledgerRows };
  return { rows: [] };
}

beforeEach(() => {
  ordem = [];
  fechamentos = [];
  insertFalha = null;
  linhaViva = null;
  retomadaOk = false;
  ledgerRows = [];
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

describe('concluirRecebimentoFiscal — caminho feliz (US1)', () => {
  it('ledger em_andamento ANTES do OMIE; Consultar -> EDITAR -> IGNORAR -> Concluir; ledger concluido com itens_total', async () => {
    const r = await concluirRecebimentoFiscal(input());

    expect(ordem).toEqual(['ledger:insert', 'omie:consultar', 'omie:editar', 'omie:ignorar', 'omie:concluir', 'ledger:concluido']);
    expect(r).toMatchObject({ status: 'concluido', ledgerId: 'ledger-1', itensTotal: 2 });
    expect(r.concluidoEm).toBe(new Date('2026-10-02 10:00:00+00').toISOString());

    // INSERT grava chave, NF, fornecedor e quem confirmou, com status em_andamento
    const ins = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO stockbridge.recebimento_fiscal'))!;
    expect(ins[0]).toContain("'em_andamento'");
    expect(ins[1]).toEqual([CHAVE, null, '6842', 'REPLAS COMERCIAL LTDA', USER]);

    // consulta inicial pela CHAVE (corpo A — a reconsulta usa nIdReceb)
    expect(consultarSpy).toHaveBeenCalledWith('q2p', { cChaveNfe: CHAVE });

    // fechamento: status, nIdReceb resolvido da consulta, etapa/recebido antes, itens_total, sem erro
    expect(fechamentos).toHaveLength(1);
    expect(fechamentos[0]).toEqual(['ledger-1', 'concluido', N_ID_RECEB, '40', 'N', 2, null, null, null]);
  });

  it('EDITAR leva cNaoGerarMovEstoque S + cNaoGerarFinanceiro N em TODOS os itens (nSequencia da consulta); IGNORAR vai sem itensAjustes; Concluir na etapa 60', async () => {
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
    consultarSpy.mockImplementation(async () => {
      ordem.push('omie:consultar');
      return recebimento({ nIdReceb: 999 });
    });
    await concluirRecebimentoFiscal(input({ nIdReceb: 111 }));
    const ins = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO stockbridge.recebimento_fiscal'))!;
    expect((ins[1] as unknown[])[1]).toBe(111);
    expect((alterarSpy.mock.calls[0]![1] as { nIdReceb: number }).nIdReceb).toBe(999);
    expect(concluirSpy).toHaveBeenCalledWith('q2p', { nIdReceb: 999, cEtapa: '60' });
    expect(fechamentos[0]![2]).toBe(999);
  });
});

describe('concluirRecebimentoFiscal — ja concluido (FR-011)', () => {
  it('OMIE ja mostra cRecebido=S: nenhuma escrita, ledger ja_concluido', async () => {
    consultarSpy.mockImplementation(async () => {
      ordem.push('omie:consultar');
      return recebimento({ cRecebido: 'S', cEtapa: '60', cUsuarioRec: 'gustavo' });
    });
    const r = await concluirRecebimentoFiscal(input());
    expect(r.status).toBe('ja_concluido');
    expect(r.itensTotal).toBe(0);
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(ordem).toEqual(['ledger:insert', 'omie:consultar', 'ledger:ja_concluido']);
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

describe('concluirRecebimentoFiscal — lock (research D6)', () => {
  it('outra confirmacao em andamento (recente): RecebimentoFiscalEmAndamentoError e zero OMIE', async () => {
    insertFalha = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'recebimento_fiscal_nf_viva_uq' });
    linhaViva = { id: 'ledger-vivo', status: 'em_andamento', iniciado_em: '2026-10-02 09:59:50+00', finalizado_em: null };
    retomadaOk = false;
    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalEmAndamentoError);
    insertFalha = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'recebimento_fiscal_nf_viva_uq' });
    await expect(concluirRecebimentoFiscal(input())).rejects.toThrow(/NF 6842 já está sendo concluído/);
    expect(consultarSpy).not.toHaveBeenCalled();
    expect(ordem).toEqual(['ledger:insert', 'ledger:retomar', 'ledger:insert', 'ledger:retomar']);
  });

  it('lock orfao (processo morreu): retoma a linha e conclui normalmente', async () => {
    insertFalha = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'recebimento_fiscal_nf_viva_uq' });
    linhaViva = { id: 'ledger-orfao', status: 'em_andamento', iniciado_em: '2026-10-02 08:00:00+00', finalizado_em: null };
    retomadaOk = true;
    const r = await concluirRecebimentoFiscal(input());
    expect(r).toMatchObject({ status: 'concluido', ledgerId: 'ledger-orfao' });
    expect(ordem).toEqual(['ledger:insert', 'ledger:retomar', 'omie:consultar', 'omie:editar', 'omie:ignorar', 'omie:concluir', 'ledger:concluido']);
  });

  it('23505 de OUTRO indice nao e tratado como lock — propaga', async () => {
    insertFalha = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'outro_idx' });
    await expect(concluirRecebimentoFiscal(input())).rejects.toThrow('duplicate key');
  });
});

describe('concluirRecebimentoFiscal — falhas (FR-012, STK-23 sem retry)', () => {
  const fault = (code: string, message: string) => Object.assign(new Error(message), { omieCode: code });

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
    expect(e.message).toContain('Nada foi registrado');
    expect(e.message).not.toContain('8510564869');
    expect(e.message).not.toContain('Client-5001');
    expect((e as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);

    // reconsulta usou o OUTRO corpo (nIdReceb) para furar o cache de ~1 min (D2)
    expect(consultarSpy).toHaveBeenCalledTimes(2);
    expect(consultarSpy.mock.calls[1]).toEqual(['q2p', { nIdReceb: N_ID_RECEB }]);
    // nao seguiu para IGNORAR/Concluir, nem tentou de novo
    expect(alterarSpy).toHaveBeenCalledTimes(1);
    expect(concluirSpy).not.toHaveBeenCalled();
    // ledger: falha, passo editar, codigo e mensagem do OMIE guardados (so no banco/log)
    expect(ordem.at(-1)).toBe('ledger:falha');
    expect(fechamentos[0]!.slice(1)).toEqual(['falha', N_ID_RECEB, '40', 'N', 2, 'editar', 'SOAP-ENV:Client-5001', 'Recebimento nao localizado para o id 8510564869']);
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
        return recebimento({ cRecebido: 'S', cEtapa: '60', cUsuarioRec: 'WEBSERVICE' });
      });
    const r = await concluirRecebimentoFiscal(input());
    expect(r.status).toBe('ja_concluido');
    expect(ordem).toEqual(['ledger:insert', 'omie:consultar', 'omie:editar', 'omie:ignorar', 'omie:concluir', 'omie:reconsultar', 'ledger:ja_concluido']);
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
});

describe('concluirRecebimentoFiscal — recusas de dominio', () => {
  it('sem fornecedor cadastrado (nIdFornecedor nulo): RecebimentoFiscalSemFornecedorError antes de qualquer escrita', async () => {
    consultarSpy.mockImplementationOnce(async () => {
      ordem.push('omie:consultar');
      return recebimento({ nIdFornecedor: null, cRazaoSocial: null, cCNPJ_CPF: null });
    });
    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input({ fornecedorNome: null }));
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(RecebimentoFiscalSemFornecedorError);
    expect((erro as Error).message).toContain('NF 6842');
    expect((erro as Error).message).toContain('sem fornecedor cadastrado');
    expect((erro as Error).message).not.toContain('8510564869');
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(fechamentos[0]![1]).toBe('falha');
    expect(fechamentos[0]![6]).toBe('consultar');
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
    consultarSpy.mockImplementationOnce(async () => {
      ordem.push('omie:consultar');
      return recebimento({ cCancelada: 'S' });
    });
    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(RecebimentoFiscalNfCanceladaError);
    expect(alterarSpy).not.toHaveBeenCalled();
  });

  it('consulta sem itens: RecebimentoFiscalError no passo consultar (nada a editar)', async () => {
    consultarSpy.mockImplementationOnce(async () => {
      ordem.push('omie:consultar');
      return recebimento({ itens: [] });
    });
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
    const sql = String(poolQuerySpy.mock.calls.at(-1)![0]);
    expect(sql).not.toContain('erro_omie');
    expect(sql).toContain('rf.status = $2');
    expect(poolQuerySpy.mock.calls.at(-1)![1]).toEqual([10, 'concluido']);
    expect(lista[0]).toMatchObject({ id: 'l1', notaFiscal: '6842', status: 'concluido', itensTotal: 1, confirmadoPor: { id: USER, nome: 'Gustavo' } });
    expect(lista[0]!.finalizadoEm).toBe(new Date('2026-10-02 10:00:04+00').toISOString());
  });
});

describe('concluirRecebimentoFiscal — T037 (US3): repeticoes e falhas com estado conhecido', () => {
  const fault = (code: string, message: string) => Object.assign(new Error(message), { omieCode: code });

  it('fault em EDITAR mas a reconsulta mostra cRecebido=S (alguem concluiu no portal no meio): ja_concluido e ZERO escrita adicional', async () => {
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
        return recebimento({ cRecebido: 'S', cEtapa: '60', cUsuarioRec: 'gustavo' });
      });
    const r = await concluirRecebimentoFiscal(input());
    expect(r.status).toBe('ja_concluido');
    expect(alterarSpy).toHaveBeenCalledTimes(1);
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(ordem).toEqual(['ledger:insert', 'omie:consultar', 'omie:editar', 'omie:reconsultar', 'ledger:ja_concluido']);
    // a reconsulta foi pelo OUTRO corpo
    expect(consultarSpy.mock.calls[0]).toEqual(['q2p', { cChaveNfe: CHAVE }]);
    expect(consultarSpy.mock.calls[1]).toEqual(['q2p', { nIdReceb: N_ID_RECEB }]);
  });

  it("fault em Concluir e a reconsulta segue 'N': ledger falha com passo_falha='concluir' e erro_omie_*", async () => {
    concluirSpy.mockImplementationOnce(async () => {
      ordem.push('omie:concluir');
      throw fault('SOAP-ENV:Client-7001', 'Nao foi possivel concluir o recebimento');
    });
    await expect(concluirRecebimentoFiscal(input())).rejects.toMatchObject({ name: 'RecebimentoFiscalError', passo: 'concluir' });
    expect(consultarSpy).toHaveBeenCalledTimes(2);
    expect(fechamentos[0]!.slice(1)).toEqual(['falha', N_ID_RECEB, '40', 'N', 2, 'concluir', 'SOAP-ENV:Client-7001', 'Nao foi possivel concluir o recebimento']);
  });

  it("nova tentativa apos 'falha' abre linha NOVA em_andamento: o indice unico do ledger e parcial e exclui 'falha' (migration 0053)", async () => {
    const sql = readFileSync(resolve(__dirname, '../../../../packages/db/migrations/0053_stockbridge_recebimento_fiscal_nf.sql'), 'utf8');
    expect(sql).toMatch(/recebimento_fiscal_nf_viva_uq[\s\S]*?WHERE status IN \('em_andamento', 'concluido', 'ja_concluido'\)/);
    // e o service nao tenta "retomar" uma linha em falha: so em_andamento entra na retomada
    concluirSpy.mockImplementationOnce(async () => {
      ordem.push('omie:concluir');
      throw new Error('timeout');
    });
    await expect(concluirRecebimentoFiscal(input())).rejects.toMatchObject({ name: 'RecebimentoFiscalError' });
    ordem.length = 0;
    const r = await concluirRecebimentoFiscal(input());
    expect(r.status).toBe('concluido');
    expect(ordem[0]).toBe('ledger:insert');
    expect(ordem).not.toContain('ledger:retomar');
  });
});
