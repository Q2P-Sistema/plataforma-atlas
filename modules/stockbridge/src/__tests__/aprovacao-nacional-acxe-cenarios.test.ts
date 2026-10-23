import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — cenarios da aprovacao da entrada nacional da ACXE que complementam
// aprovacao-entrada-nacional-acxe.test.ts: a data do lancamento (a mesma nas duas empresas e a que o retry reusa),
// as chaves de idempotencia, o OMIE que ja tinha o ajuste (jaExistia), erro que nao e Error, o ALERTA de log quando a
// decisao concorrente vence DEPOIS das chamadas ao OMIE, registro inconsistente (nada chamado), permissao e a
// caracterizacao do que a Q2P NAO mudou. O OMIE (incluirAjusteIdempotente) e o banco sao fakes.

type Chamada = { empresa: 'acxe' | 'q2p'; codInt: string; input: Record<string, unknown> };
const chamadasOmie: Chamada[] = [];
let respostaOmie: (c: Chamada) => Promise<{ idMovest: string; idAjuste: string; jaExistia: boolean }>;

const updates: Array<{ table: string; set: Record<string, unknown> }> = [];
let movRows: unknown[] = [];
let apRows: unknown[] = [];
let localRow: Record<string, string | null> = {};
let claimFalha = false;
let sqlsExecutados: string[] = [];

const h = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  alertaPendencia: vi.fn(),
  notificaOperador: vi.fn(),
  baixa: vi.fn(),
}));

function fakeDb() {
  const mk = () => {
    let tabela = '?';
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.from = (t: { __id?: string }) => { tabela = t.__id ?? '?'; return c; };
    c.where = () => c;
    c.limit = () => Promise.resolve(tabela === 'aprovacao' ? apRows : tabela === 'movimentacao' ? movRows : []);
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(tabela === 'users' ? [{ id: 'op-1', name: 'Operador' }] : []).then(res, rej);
    return c;
  };
  const updateChain = (t: { __id?: string }) => {
    const table = t.__id ?? '?';
    return {
      set: (v: Record<string, unknown>) => ({
        where: () => {
          updates.push({ table, set: v });
          return Object.assign(Promise.resolve(undefined), {
            returning: () => Promise.resolve(table === 'aprovacao' && !claimFalha ? [{ id: 'ap-1', status: 'aprovada' }] : []),
          });
        },
      }),
    };
  };
  return {
    ...mk(),
    select: () => (mk() as { select: () => unknown }).select(),
    update: updateChain,
    execute: (q: unknown) => {
      const texto = JSON.stringify((q as { queryChunks?: unknown[] }).queryChunks ?? q);
      sqlsExecutados.push(texto);
      if (texto.includes('lc.codigo_local_estoque_acxe::text AS codigo_acxe')) return Promise.resolve({ rows: [localRow] });
      // aprovarEntradaNacional (uma empresa): `lc.<col>::text AS codigo`; qualquer outra consulta (listagens): vazia
      if (texto.includes('stockbridge.localidade l')) return Promise.resolve({ rows: [{ codigo: localRow.codigo }] });
      return Promise.resolve({ rows: [] });
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...mk(), select: () => (mk() as { select: () => unknown }).select(), update: updateChain }),
  };
}

vi.mock('@atlas/core', () => ({
  createLogger: () => h.logger,
  getDb: () => fakeDb(),
  getPool: () => ({ query: vi.fn() }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
}));

vi.mock('@atlas/db', () => ({
  aprovacao: { __id: 'aprovacao', id: {}, status: {}, loteId: {}, movimentacaoId: {} },
  lote: { __id: 'lote' },
  movimentacao: { __id: 'movimentacao', id: {} },
  localidadeCorrelacao: { __id: 'localidadeCorrelacao' },
  users: { __id: 'users', id: {}, name: {} },
  reservaSaldo: { __id: 'reservaSaldo' },
}));

vi.mock('@atlas/integration-omie', () => ({
  incluirAjusteEstoque: vi.fn(),
  listarAjusteEstoque: vi.fn(),
  consultarNF: vi.fn(),
  isMockMode: () => true,
}));

vi.mock('../services/omie-idempotente.js', () => ({
  incluirAjusteIdempotente: (empresa: 'acxe' | 'q2p', codInt: string, input: Record<string, unknown>) => {
    const c: Chamada = { empresa, codInt, input };
    chamadasOmie.push(c);
    return respostaOmie(c);
  },
}));

vi.mock('../services/omie-saida.service.js', () => ({
  executarSaidaOmieDual: vi.fn(),
  executarTransferenciaIntraDual: vi.fn(),
  executarComodatoOmieDual: vi.fn(),
  executarRetornoComodatoOmieDual: vi.fn(),
  resolverCodigoProdutoOmie: vi.fn(),
}));

vi.mock('../services/notificacao.service.js', () => ({
  enviarNotificacaoRejeicaoOperador: vi.fn(),
  enviarNotificacaoAprovacaoOperador: (a: unknown) => h.notificaOperador(a),
  enviarAlertaAprovacaoPendente: vi.fn(),
  enviarAlertaPendenciaOmie: (a: unknown) => h.alertaPendencia(a),
}));

vi.mock('../services/baixa-pedido.service.js', () => ({ dispararBaixaPedidoQ2p: (a: unknown) => h.baixa(a) }));

import { aprovar, listarMinhasRejeicoes, AprovacaoNivelInsuficienteError, AprovacaoStatusInvalidoError } from '../services/aprovacao.service.js';
import { formatarDataOmie } from '../services/omie-shared.js';

const OP_ID = '5a1f0c52-0f6d-4d6b-9a41-3d0a8d0f1111';
const CHAVE = '35261011111111000111550010000009370000009370';

const mov = (over: Record<string, unknown> = {}) => ({
  id: 'mov-1', opId: OP_ID, notaFiscal: '937', subtipo: 'compra_nacional', empresa: 'acxe', tipoMovimento: 'entrada_manual',
  quantidadeKg: '26000.000', custoUnitarioBrl: '4.833333', ...over,
});
const apr = (over: Record<string, unknown> = {}) => ({
  id: 'ap-1', loteId: null, status: 'pendente', precisaNivel: 'gestor', tipoAprovacao: 'entrada_manual', lancadoPor: 'op-1',
  movimentacaoId: 'mov-1', empresa: 'acxe', produtoCodigoAcxe: 4001, produtoCodigoQ2p: 9001, galpao: '21.1',
  quantidadeRecebidaKg: '26000.000', observacoes: 'Recebimento nacional NF 937 · via fila', nfChaveAcesso: CHAVE, notaFiscal: '937', ...over,
});
const ok = (s: string) => async () => ({ idMovest: `MOV-${s}`, idAjuste: `AJ-${s}`, jaExistia: false });

beforeEach(() => {
  chamadasOmie.length = 0;
  updates.length = 0;
  sqlsExecutados = [];
  claimFalha = false;
  movRows = [mov()];
  apRows = [apr()];
  localRow = { codigo_acxe: '4553940001', codigo_q2p: '4553940002', codigo: '4553940398' };
  respostaOmie = async (c) => ok(c.empresa.toUpperCase())();
  h.logger.info.mockClear();
  h.logger.warn.mockClear();
  h.logger.error.mockClear();
  h.alertaPendencia.mockReset();
  h.notificaOperador.mockReset();
  h.baixa.mockReset();
});

const gestor = () => aprovar({ id: 'ap-1', usuarioId: 'gestor-1', perfilUsuario: 'gestor' });
const movUpdate = () => updates.find((u) => u.table === 'movimentacao')!.set;

describe('entrada nas duas empresas: data, chaves e respostas do OMIE', () => {
  it('as duas pernas levam a MESMA data do lancamento, e e a que fica gravada em dt_acxe (o retry da Q2P a reusa)', async () => {
    await gestor();
    const [acxe, q2p] = chamadasOmie;
    expect(acxe!.input.dataAtual).toBe(q2p!.input.dataAtual);
    const dtAcxe = movUpdate().dtAcxe as Date;
    expect(dtAcxe).toBeInstanceOf(Date);
    expect(acxe!.input.dataAtual).toBe(formatarDataOmie(dtAcxe));
  });

  it('cod_int_ajuste: uma chave por empresa, ambas do op_id da movimentacao, dentro do limite do OMIE (60)', async () => {
    await gestor();
    const chaves = chamadasOmie.map((c) => c.codInt);
    expect(chaves).toEqual([`${OP_ID}:nacional-acxe`, `${OP_ID}:nacional-q2p`]);
    expect(new Set(chaves).size).toBe(2);
    for (const k of chaves) expect(k.length).toBeLessThanOrEqual(60);
  });

  it('o OMIE ja tinha os ajustes (resposta da tentativa anterior perdida, jaExistia): conclui normalmente, sem pendencia nem alerta', async () => {
    respostaOmie = async (c) => ({ idMovest: `JA-${c.empresa}`, idAjuste: `JA-AJ-${c.empresa}`, jaExistia: true });
    const r = await gestor();
    expect(r.pendenciaOmie).toBeUndefined();
    expect(movUpdate()).toMatchObject({ statusOmie: 'concluida', idMovestAcxe: 'JA-acxe', idMovestQ2p: 'JA-q2p', mvAcxe: 1, mvQ2p: 1 });
    expect(h.alertaPendencia).not.toHaveBeenCalled();
  });

  it('falha da Q2P que nao e Error (string/objeto): a pendencia guarda "erro desconhecido" e o alerta sai', async () => {
    respostaOmie = async (c) => {
      if (c.empresa === 'q2p') throw 'timeout cru';
      return ok('ACXE')();
    };
    const r = await gestor();
    expect(r.pendenciaOmie).toMatchObject({ lado: 'q2p', mensagem: 'erro desconhecido' });
    expect(movUpdate()).toMatchObject({ statusOmie: 'pendente_q2p', tentativasQ2p: 1, ultimoErroOmie: { lado: 'q2p', mensagem: 'erro desconhecido' } });
    expect(h.alertaPendencia).toHaveBeenCalledTimes(1);
  });

  it('o valor das duas pernas e o NUMERO gravado (6 casas), sem 1,145 da importacao e sem arredondar para 2 casas', async () => {
    movRows = [mov({ custoUnitarioBrl: '4.807692' })];
    await gestor();
    for (const c of chamadasOmie) expect(c.input.valor).toBe(4.807692);
    expect(chamadasOmie[0]!.input.valor).not.toBeCloseTo(4.807692 * 1.145, 3);
  });

  it('nunca consulta preco vivo nem resolve o correspondente de novo: so le o local (um SQL) — produto vem da aprovacao', async () => {
    await gestor();
    expect(sqlsExecutados).toHaveLength(1);
    expect(sqlsExecutados[0]).toContain('stockbridge.localidade_correlacao');
    expect(sqlsExecutados[0]).not.toContain('vw_posicaoEstoque');
    expect(sqlsExecutados[0]).not.toContain('tbl_produtos');
    // join direto em localidade_correlacao, SEM filtro de tipo: o 31.1 e 'tpl' e resolverCorrelacaoCompletaGalpao (tipo = proprio) o recusaria
    expect(sqlsExecutados[0]).not.toMatch(/l\.tipo|'proprio'/);
    expect(sqlsExecutados[0]).toContain('l.codigo = ');
  });
});

describe('a decisao concorrente vence DEPOIS do OMIE', () => {
  it('as duas pernas ja foram lancadas e o claim falha: o erro sobe (409) e o log de ALERTA leva os ids para conferencia/estorno', async () => {
    claimFalha = true;
    const err = await gestor().catch((e: Error) => e);
    expect(err).toBeInstanceOf(AprovacaoStatusInvalidoError);
    expect(chamadasOmie.map((c) => c.empresa)).toEqual(['acxe', 'q2p']);
    const alerta = h.logger.error.mock.calls.find((c) => String(c[1]).startsWith('ALERTA: entrada nacional lançada no OMIE'));
    expect(alerta, 'log ALERTA presente').toBeDefined();
    expect(alerta![0]).toMatchObject({
      aprovacaoId: 'ap-1', movimentacaoId: 'mov-1', opId: OP_ID,
      idAcxe: { idMovest: 'MOV-ACXE', idAjuste: 'AJ-ACXE' }, idQ2p: { idMovest: 'MOV-Q2P', idAjuste: 'AJ-Q2P' },
    });
    // nada a notificar: a aprovacao nao foi registrada
    expect(h.notificaOperador).not.toHaveBeenCalled();
    expect(h.alertaPendencia).not.toHaveBeenCalled();
  });
});

describe('registro inconsistente ou sem permissao: nenhuma chamada ao OMIE', () => {
  it('movimentacao de outra empresa/subtipo: erro generico e nada chamado', async () => {
    movRows = [mov({ empresa: 'q2p' })];
    await expect(gestor()).rejects.toThrow(/não é uma compra nacional da ACXE/);
    movRows = [mov({ subtipo: 'importacao' })];
    await expect(gestor()).rejects.toThrow(/não é uma compra nacional da ACXE/);
    expect(chamadasOmie).toHaveLength(0);
  });

  it('movimentacao nao encontrada ou quantidade zero: erro e nada chamado', async () => {
    movRows = [];
    await expect(gestor()).rejects.toThrow(/Movimentação .* não encontrada/);
    movRows = [mov()];
    apRows = [apr({ quantidadeRecebidaKg: '0' })];
    await expect(gestor()).rejects.toThrow(/sem quantidade válida/);
    expect(chamadasOmie).toHaveLength(0);
  });

  it('estoque sem codigo da ACXE: erro e nada chamado', async () => {
    localRow = { codigo_acxe: null, codigo_q2p: '4553940002', codigo: null };
    await expect(gestor()).rejects.toThrow(/sem código OMIE para a ACXE/);
    expect(chamadasOmie).toHaveLength(0);
  });

  it('operador nao aprova; diretor aprova pendencia de gestor', async () => {
    await expect(aprovar({ id: 'ap-1', usuarioId: 'op-1', perfilUsuario: 'operador' })).rejects.toBeInstanceOf(AprovacaoNivelInsuficienteError);
    expect(chamadasOmie).toHaveLength(0);
    await aprovar({ id: 'ap-1', usuarioId: 'dir-1', perfilUsuario: 'diretor' });
    expect(chamadasOmie.map((c) => c.empresa)).toEqual(['acxe', 'q2p']);
  });

  it('aprovacao que ja foi decidida: 409 antes de qualquer chamada', async () => {
    apRows = [apr({ status: 'aprovada' })];
    await expect(gestor()).rejects.toBeInstanceOf(AprovacaoStatusInvalidoError);
    expect(chamadasOmie).toHaveLength(0);
  });
});

describe('caracterizacao: a Q2P (NF da Q2P) NAO mudou', () => {
  const q2pPuro = () => {
    apRows = [apr({ empresa: 'q2p', produtoCodigoAcxe: null, produtoCodigoQ2p: 3033097757, galpao: '11.2' })];
    movRows = [mov({ empresa: 'q2p', custoUnitarioBrl: '11.300000' })];
    localRow = { codigo_acxe: null, codigo_q2p: '8123584710', codigo: '8123584710' };
  };

  it('a observacao enviada ao OMIE e a gravada, sem saneamento de Latin-1 (so a ACXE passou a sanear)', async () => {
    q2pPuro();
    apRows = [apr({ empresa: 'q2p', produtoCodigoAcxe: null, produtoCodigoQ2p: 3033097757, galpao: '11.2', observacoes: 'NF 937 — balança “nova”' })];
    await gestor();
    expect(chamadasOmie).toHaveLength(1);
    expect(chamadasOmie[0]!.input.observacao).toBe('NF 937 — balança “nova”');
  });

  it('uma chamada so (nacional-q2p), data de hoje, e a baixa de pedido (344) nao e disparada', async () => {
    q2pPuro();
    await gestor();
    expect(chamadasOmie.map((c) => [c.empresa, c.codInt])).toEqual([['q2p', `${OP_ID}:nacional-q2p`]]);
    expect(chamadasOmie[0]!.input.dataAtual).toBe(formatarDataOmie());
    expect(h.baixa).not.toHaveBeenCalled();
  });

  it('com produto da Q2P e chave de acesso mas empresa q2p, NUNCA vira entrada nas duas empresas', async () => {
    q2pPuro();
    apRows = [apr({ empresa: 'q2p', produtoCodigoAcxe: 4001, produtoCodigoQ2p: 3033097757, galpao: '11.2' })];
    await gestor();
    expect(chamadasOmie.map((c) => c.empresa)).toEqual(['q2p']);
  });
});

describe('listarMinhasRejeicoes: o fornecedor da NF da ACXE vem do espelho da ACXE', () => {
  it('a consulta procura a chave de acesso nos DOIS espelhos de NF (COALESCE) e no cadastro de produtos das duas empresas', async () => {
    sqlsExecutados = [];
    await listarMinhasRejeicoes('op-1');
    expect(sqlsExecutados).toHaveLength(1);
    const sql = sqlsExecutados[0]!;
    expect(sql).toContain('tbl_nf_header_Q2P');
    expect(sql).toContain('tbl_nf_header_ACXE');
    expect(sql).toContain('COALESCE(');
    expect(sql).toContain('tbl_produtos_ACXE');
    expect(sql).toContain('tbl_produtos_Q2P');
  });
});
