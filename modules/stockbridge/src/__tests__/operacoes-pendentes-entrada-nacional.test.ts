import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — retry da perna Q2P da compra nacional da ACXE em estoque
// que tambem e da Q2P. A aprovacao lancou a ENTRADA na ACXE; a da Q2P falhou e a movimentacao ficou
// 'pendente_q2p'. O retry repete a ENT/INI da Q2P com o que foi gravado (produto da Q2P, valor, data da
// ACXE), com verificarAntes, e NUNCA baixa pedido de compra. O que nao e dessa entrada segue no retry
// de saida manual (ja coberto em operacoes-pendentes.test.ts).

type Chamada = { empresa: 'acxe' | 'q2p'; codInt: string; input: Record<string, unknown>; opts?: Record<string, unknown> };
const chamadasOmie: Chamada[] = [];
let respostaOmie: (c: Chamada) => Promise<{ idMovest: string; idAjuste: string; jaExistia: boolean }>;

const updates: Array<{ table: string; set: Record<string, unknown> }> = [];
let movRow: Record<string, unknown> | null;
let aprovacoesAprovadas: unknown[];
let localQ2p: string | null;

const spies = vi.hoisted(() => ({
  baixa: vi.fn(),
  correlacaoCompleta: vi.fn(),
}));

function fakeDb() {
  const select = () => {
    let tabela = '?';
    const c: Record<string, unknown> = {};
    c.from = (t: { __id?: string }) => { tabela = t.__id ?? '?'; return c; };
    c.where = () => c;
    c.limit = () => Promise.resolve(tabela === 'aprovacao' ? aprovacoesAprovadas : movRow ? [movRow] : []);
    return c;
  };
  return {
    select,
    execute: () => Promise.resolve({ rows: [{ codigo: localQ2p }] }),
    update: (t: { __id?: string }) => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          updates.push({ table: t.__id ?? '?', set: v });
          return Promise.resolve(undefined);
        },
      }),
    }),
  };
}

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => fakeDb(),
  getConfig: () => ({}),
  getPool: () => ({ query: vi.fn() }),
}));

vi.mock('@atlas/db', () => ({
  movimentacao: { __id: 'movimentacao' },
  lote: { __id: 'lote' },
  localidade: { __id: 'localidade' },
  localidadeCorrelacao: { __id: 'localidadeCorrelacao' },
  aprovacao: { __id: 'aprovacao' },
}));

vi.mock('@atlas/integration-omie', () => ({ incluirAjusteEstoque: vi.fn(), listarAjusteEstoque: vi.fn() }));

vi.mock('../services/omie-idempotente.js', () => ({
  incluirAjusteIdempotente: (empresa: 'acxe' | 'q2p', codInt: string, input: Record<string, unknown>, opts?: Record<string, unknown>) => {
    const c: Chamada = { empresa, codInt, input, opts };
    chamadasOmie.push(c);
    return respostaOmie(c);
  },
}));

vi.mock('../services/omie-saida.service.js', () => ({
  resolverCorrelacaoCompletaGalpao: (...a: unknown[]) => spies.correlacaoCompleta(...a),
  resolverCodigosLocaisTroca: vi.fn(),
  resolverCodigoProdutoOmie: vi.fn(),
}));
vi.mock('../services/aprovacao.service.js', () => ({ consultarValorUnitarioProduto: vi.fn() }));
vi.mock('../services/baixa-pedido.service.js', () => ({ dispararBaixaPedidoQ2p: (a: unknown) => spies.baixa(a) }));

import { retentarOperacaoPendente, OperadorSemRetentativasError } from '../services/operacoes-pendentes.service.js';
import { OmieAjusteError } from '../services/recebimento.service.js';
import { formatarDataOmie } from '../services/omie-shared.js';

const OP_ID = '5a1f0c52-0f6d-4d6b-9a41-3d0a8d0f1111';
const DT_ACXE = new Date('2026-10-22T15:30:00.000Z');
const CHAVE = '35261011111111000111550010000009370000009370';

const movPendente = (over: Record<string, unknown> = {}) => ({
  id: 'mov-1', opId: OP_ID, loteId: null, notaFiscal: '937', subtipo: 'compra_nacional', tipoMovimento: 'entrada_manual',
  empresa: 'acxe', produtoCodigoAcxe: 4001, produtoCodigoQ2p: 9001, galpao: '21.1', galpaoDestino: null, nfChaveAcesso: CHAVE,
  quantidadeKg: '26000.000', custoUnitarioBrl: '4.833333', statusOmie: 'pendente_q2p', tentativasQ2p: 1, tentativasAcxeFaltando: 0,
  mvAcxe: 1, dtAcxe: DT_ACXE, idMovestAcxe: 'MOV-ACXE', idAjusteAcxe: 'AJ-ACXE', mvQ2p: null, idMovestQ2p: null, idAjusteQ2p: null,
  movimentacaoOrigemId: null, baixaPedidoQ2p: null, ...over,
});

const gestor = { userId: 'gestor-1', role: 'gestor' as const };

beforeEach(() => {
  chamadasOmie.length = 0;
  updates.length = 0;
  movRow = movPendente();
  aprovacoesAprovadas = [{ id: 'ap-1' }];
  localQ2p = '4553940002';
  respostaOmie = async () => ({ idMovest: 'MOV-Q2P', idAjuste: 'AJ-Q2P', jaExistia: false });
  spies.baixa.mockReset();
  spies.correlacaoCompleta.mockReset();
});

describe('retentarOperacaoPendente — perna Q2P da compra nacional da ACXE', () => {
  it('repete a ENT/INI da Q2P com o produto da Q2P gravado, o local da Q2P, o MESMO valor, a data da ACXE e verificarAntes', async () => {
    const r = await retentarOperacaoPendente({ movimentacaoId: 'mov-1', ator: gestor });
    expect(chamadasOmie).toHaveLength(1);
    expect(chamadasOmie[0]).toMatchObject({
      empresa: 'q2p',
      codInt: `${OP_ID}:nacional-q2p`,
      input: {
        codigoLocalEstoque: '4553940002', idProduto: 9001, quantidade: 26000, origem: 'AJU', tipo: 'ENT', motivo: 'INI',
        valor: 4.833333, dataAtual: formatarDataOmie(DT_ACXE),
      },
      opts: { verificarAntes: true },
    });
    // observacao em ASCII puro (Latin-1 no OMIE)
    expect(/^[ -~]*$/.test(String(chamadasOmie[0]!.input.observacao))).toBe(true);
    expect(r).toEqual({ movimentacaoId: 'mov-1', statusOmie: 'concluida', jaExistiaNoOmie: false, tentativasQ2p: 1 });
  });

  it('grava a perna Q2P como ENTRADA (mvQ2p +1, nao -1 da saida), conclui e limpa o erro; nao toca a ACXE', async () => {
    await retentarOperacaoPendente({ movimentacaoId: 'mov-1', ator: gestor });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe('movimentacao');
    expect(updates[0]!.set).toMatchObject({
      idMovestQ2p: 'MOV-Q2P', idAjusteQ2p: 'AJ-Q2P', mvQ2p: 1, idUserQ2p: 'gestor-1', statusOmie: 'concluida', ultimoErroOmie: null,
    });
    expect(updates[0]!.set.dtQ2p).toBeInstanceOf(Date);
    expect(updates[0]!.set).not.toHaveProperty('mvAcxe');
    expect(updates[0]!.set).not.toHaveProperty('idMovestAcxe');
  });

  it('nunca baixa pedido de compra (344) e nao usa o retry de saida manual', async () => {
    await retentarOperacaoPendente({ movimentacaoId: 'mov-1', ator: gestor });
    expect(spies.baixa).not.toHaveBeenCalled();
    expect(spies.correlacaoCompleta).not.toHaveBeenCalled();
  });

  it('o ajuste ja existia no OMIE (a resposta da tentativa anterior se perdeu): conclui sem duplicar e avisa jaExistiaNoOmie', async () => {
    respostaOmie = async () => ({ idMovest: 'MOV-Q2P-EXISTENTE', idAjuste: 'AJ-Q2P-EXISTENTE', jaExistia: true });
    const r = await retentarOperacaoPendente({ movimentacaoId: 'mov-1', ator: gestor });
    expect(r.jaExistiaNoOmie).toBe(true);
    expect(updates[0]!.set).toMatchObject({ idMovestQ2p: 'MOV-Q2P-EXISTENTE', mvQ2p: 1, statusOmie: 'concluida' });
  });

  it('falha no OMIE da Q2P: incrementa as tentativas, guarda o erro, mantem pendente_q2p e sobe OmieAjusteError(q2p)', async () => {
    respostaOmie = async () => {
      throw new Error('OMIE Q2P fora do ar');
    };
    const err = await retentarOperacaoPendente({ movimentacaoId: 'mov-1', ator: gestor }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(OmieAjusteError);
    expect((err as OmieAjusteError).lado).toBe('q2p');
    expect((err as OmieAjusteError).opId).toBe(OP_ID);
    expect((err as OmieAjusteError).movimentacaoId).toBe('mov-1');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set).toMatchObject({ tentativasQ2p: 2, ultimoErroOmie: { lado: 'q2p', mensagem: 'OMIE Q2P fora do ar', timestamp: expect.any(String) } });
    expect(updates[0]!.set).not.toHaveProperty('statusOmie');
    expect(updates[0]!.set).not.toHaveProperty('mvQ2p');
  });
});

describe('guardas: nada vai ao OMIE se alguma falhar', () => {
  it('aprovacao ainda nao concluida (a movimentacao nasce pendente_q2p na submissao): recusa', async () => {
    aprovacoesAprovadas = [];
    await expect(retentarOperacaoPendente({ movimentacaoId: 'mov-1', ator: gestor })).rejects.toThrow(/ainda não tem aprovação concluída/);
    expect(chamadasOmie).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('perna ACXE ainda nao feita: recusa (senao criaria estoque na Q2P sem entrada na ACXE)', async () => {
    movRow = movPendente({ mvAcxe: null, idMovestAcxe: null });
    await expect(retentarOperacaoPendente({ movimentacaoId: 'mov-1', ator: gestor })).rejects.toThrow(/entrada na ACXE ainda não foi lançada/);
    expect(chamadasOmie).toHaveLength(0);
  });

  it('perna Q2P ja registrada: recusa', async () => {
    movRow = movPendente({ mvQ2p: 1, idMovestQ2p: 'MOV-Q2P-ANTIGO' });
    await expect(retentarOperacaoPendente({ movimentacaoId: 'mov-1', ator: gestor })).rejects.toThrow(/já consta como lançada/);
    expect(chamadasOmie).toHaveLength(0);
  });

  it.each([
    ['sem produto da Q2P (entrada so na ACXE)', { produtoCodigoQ2p: null }],
    ['empresa q2p', { empresa: 'q2p' }],
    ['sem chave de acesso (formulario manual)', { nfChaveAcesso: null }],
  ])('%s: nao e entrada nas duas empresas -> recusa', async (_n, over) => {
    movRow = movPendente(over);
    await expect(retentarOperacaoPendente({ movimentacaoId: 'mov-1', ator: gestor })).rejects.toThrow(/não é uma entrada nas duas empresas/);
    expect(chamadasOmie).toHaveLength(0);
  });

  it('sem custo unitario persistido: recusa — o retry nunca recalcula o valor nem usa preco vivo', async () => {
    movRow = movPendente({ custoUnitarioBrl: null });
    await expect(retentarOperacaoPendente({ movimentacaoId: 'mov-1', ator: gestor })).rejects.toThrow(/sem custo unitário persistido/);
    movRow = movPendente({ custoUnitarioBrl: '0.000000' });
    await expect(retentarOperacaoPendente({ movimentacaoId: 'mov-1', ator: gestor })).rejects.toThrow(/sem custo unitário persistido/);
    expect(chamadasOmie).toHaveLength(0);
  });

  it('local sem codigo da Q2P: recusa', async () => {
    localQ2p = null;
    await expect(retentarOperacaoPendente({ movimentacaoId: 'mov-1', ator: gestor })).rejects.toThrow(/sem código OMIE da Q2P/);
    expect(chamadasOmie).toHaveLength(0);
  });
});

describe('RBAC (inalterado)', () => {
  it('operador pode retentar a Q2P ate o limite de tentativas; depois so gestor/diretor', async () => {
    movRow = movPendente({ tentativasQ2p: 1 });
    await expect(retentarOperacaoPendente({ movimentacaoId: 'mov-1', ator: { userId: 'op-1', role: 'operador' } })).resolves.toMatchObject({ statusOmie: 'concluida' });
    chamadasOmie.length = 0;
    movRow = movPendente({ tentativasQ2p: 2 });
    await expect(retentarOperacaoPendente({ movimentacaoId: 'mov-1', ator: { userId: 'op-1', role: 'operador' } })).rejects.toBeInstanceOf(OperadorSemRetentativasError);
    expect(chamadasOmie).toHaveLength(0);
  });
});
