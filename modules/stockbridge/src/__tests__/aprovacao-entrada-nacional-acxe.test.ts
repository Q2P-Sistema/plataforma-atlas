import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — aprovacao da entrada nacional da ACXE.
// A entrada de estoque so acontece AQUI (o POST por NF grava movimentacao + aprovacao pendentes):
//  - estoque so da ACXE (20.0.5, 20.0.7, 21.2): ENT/INI so na ACXE, cod_int ${opId}:nacional-acxe;
//  - estoque que tambem e da Q2P (11.1, 12.1, 21.1, 31.1): ENT/INI na ACXE E na Q2P pelo MESMO valor.
// O OMIE (incluirAjusteIdempotente) e mockado: o que se prova e o que e enviado, em que ordem, o que e
// gravado quando a Q2P falha e que a baixa do pedido de compra (344) nunca roda.

type Chamada = { empresa: 'acxe' | 'q2p'; codInt: string; input: Record<string, unknown>; opts?: Record<string, unknown> };
const chamadasOmie: Chamada[] = [];
let respostaOmie: (c: Chamada) => Promise<{ idMovest: string; idAjuste: string; jaExistia: boolean }>;

const updates: Array<{ table: string; set: Record<string, unknown> }> = [];
let transacoes = 0;
let movRows: unknown[] = [];
let apRows: unknown[] = [];
let localRow: Record<string, string | null> = { codigo_acxe: '4553940001', codigo_q2p: '4553940002', codigo: '4553940398' };
let claimFalha = false;
let pendenciasRows: unknown[] = [];

const spies = vi.hoisted(() => ({
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
  const updateChain = (tx: boolean) => (t: { __id?: string }) => {
    const table = t.__id ?? '?';
    return {
      set: (v: Record<string, unknown>) => ({
        where: () => {
          updates.push({ table, set: v });
          const p = Promise.resolve(undefined);
          return Object.assign(p, {
            returning: () => Promise.resolve(table === 'aprovacao' && !claimFalha ? [{ id: 'ap-1', status: 'aprovada' }] : []),
          });
        },
      }),
      _tx: tx,
    };
  };
  const db = {
    ...mk(),
    select: () => mk().select(),
    update: updateChain(false),
    execute: (q: unknown) => {
      const texto = JSON.stringify((q as { queryChunks?: unknown[] }).queryChunks ?? q);
      if (texto.includes('lc.codigo_local_estoque_acxe::text AS codigo_acxe')) return Promise.resolve({ rows: [localRow] });
      if (texto.includes('FROM stockbridge.aprovacao a')) return Promise.resolve({ rows: pendenciasRows });
      // aprovarEntradaNacional (ramo de uma empresa): `lc.<col>::text AS codigo`
      return Promise.resolve({ rows: [{ codigo: localRow.codigo }] });
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      transacoes++;
      const tx = {
        ...mk(),
        select: () => mk().select(),
        update: updateChain(true),
      };
      return fn(tx);
    },
  };
  return db;
}

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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
  incluirAjusteIdempotente: (empresa: 'acxe' | 'q2p', codInt: string, input: Record<string, unknown>, opts?: Record<string, unknown>) => {
    const c: Chamada = { empresa, codInt, input, opts };
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
  enviarNotificacaoAprovacaoOperador: (a: unknown) => spies.notificaOperador(a),
  enviarAlertaAprovacaoPendente: vi.fn(),
  enviarAlertaPendenciaOmie: (a: unknown) => spies.alertaPendencia(a),
}));

vi.mock('../services/baixa-pedido.service.js', () => ({
  dispararBaixaPedidoQ2p: (a: unknown) => spies.baixa(a),
}));

import {
  aprovar,
  listarPendencias,
  entradaNacionalEspelhada,
  paraLatin1,
  EntradaNacionalInconsistenteError,
  AprovacaoStatusInvalidoError,
} from '../services/aprovacao.service.js';
import { OmieAjusteError } from '../services/recebimento.service.js';

const OP_ID = '5a1f0c52-0f6d-4d6b-9a41-3d0a8d0f1111';
const CHAVE = '35261011111111000111550010000009370000009370';

const mov = (over: Record<string, unknown> = {}) => ({
  id: 'mov-1', opId: OP_ID, notaFiscal: '937', subtipo: 'compra_nacional', empresa: 'acxe', tipoMovimento: 'entrada_manual',
  quantidadeKg: '26000.000', custoUnitarioBrl: '4.833333', ...over,
});
const apr = (over: Record<string, unknown> = {}) => ({
  id: 'ap-1', loteId: null, status: 'pendente', precisaNivel: 'gestor', tipoAprovacao: 'entrada_manual', lancadoPor: 'op-1',
  movimentacaoId: 'mov-1', empresa: 'acxe', produtoCodigoAcxe: 4001, produtoCodigoQ2p: 9001, galpao: '21.1',
  quantidadeRecebidaKg: '26000.000', observacoes: 'Recebimento nacional NF 937 · via fila | Produto: PP PRETO Q35 | Empresa: ACXE + Q2P · Estoque 21.1',
  nfChaveAcesso: CHAVE, notaFiscal: '937', ...over,
});

const ok = (sufixo: string) => async () => ({ idMovest: `MOV-${sufixo}`, idAjuste: `AJ-${sufixo}`, jaExistia: false });

beforeEach(() => {
  chamadasOmie.length = 0;
  updates.length = 0;
  transacoes = 0;
  claimFalha = false;
  pendenciasRows = [];
  movRows = [mov()];
  apRows = [apr()];
  localRow = { codigo_acxe: '4553940001', codigo_q2p: '4553940002', codigo: '4553940398' };
  respostaOmie = async (c) => ok(c.empresa.toUpperCase())();
  spies.alertaPendencia.mockReset();
  spies.notificaOperador.mockReset();
  spies.baixa.mockReset();
});

const aprovarGestor = () => aprovar({ id: 'ap-1', usuarioId: 'gestor-1', perfilUsuario: 'gestor' });
const updateDe = (tabela: string) => updates.filter((u) => u.table === tabela).map((u) => u.set);

describe('entradaNacionalEspelhada — helper unico', () => {
  const base = { subtipo: 'compra_nacional', empresa: 'acxe', nfChaveAcesso: CHAVE, produtoCodigoQ2p: 9001 };
  it('compra nacional da ACXE, por NF, com produto da Q2P gravado = nas duas empresas', () => {
    expect(entradaNacionalEspelhada(base)).toBe(true);
    expect(entradaNacionalEspelhada({ ...base, produtoCodigoQ2p: '9001' })).toBe(true);
  });
  it('a aprovacao (sem subtipo) e identificada por tipo_aprovacao entrada_manual', () => {
    const { subtipo: _s, ...semSubtipo } = base;
    expect(entradaNacionalEspelhada({ ...semSubtipo, tipoAprovacao: 'entrada_manual' })).toBe(true);
    expect(entradaNacionalEspelhada({ ...semSubtipo, tipoAprovacao: 'saida_amostra' })).toBe(false);
  });
  it.each([
    ['sem produto da Q2P (so ACXE)', { produtoCodigoQ2p: null }],
    ['empresa q2p', { empresa: 'q2p' }],
    ['sem chave de acesso (formulario manual)', { nfChaveAcesso: null }],
    ['outro subtipo', { subtipo: 'importacao' }],
  ])('%s: nao e espelhada', (_n, over) => {
    expect(entradaNacionalEspelhada({ ...base, ...over })).toBe(false);
  });
});

describe('estoque so da ACXE (20.0.7, 20.0.5, 21.2): ENT/INI so na ACXE', () => {
  beforeEach(() => {
    apRows = [apr({ galpao: '20.0.7', produtoCodigoQ2p: null })];
    movRows = [mov({ custoUnitarioBrl: '4.800000' })];
  });

  it('chama o OMIE da ACXE uma vez, com o produto da ACXE, o local da ACXE, o valor da NF e o cod_int nacional-acxe', async () => {
    const r = await aprovarGestor();
    expect(r).toEqual({ id: 'ap-1', loteStatus: 'reconciliado' });
    expect(chamadasOmie).toHaveLength(1);
    expect(chamadasOmie[0]).toMatchObject({
      empresa: 'acxe',
      codInt: `${OP_ID}:nacional-acxe`,
      input: { codigoLocalEstoque: '4553940398', idProduto: 4001, quantidade: 26000, origem: 'AJU', tipo: 'ENT', motivo: 'INI', valor: 4.8 },
    });
  });

  it('grava so a perna ACXE (mv/dt/ids/usuario), concluida, e nao toca a Q2P', async () => {
    await aprovarGestor();
    const [m] = updateDe('movimentacao');
    expect(m).toMatchObject({ statusOmie: 'concluida', mvAcxe: 1, idMovestAcxe: 'MOV-ACXE', idAjusteAcxe: 'AJ-ACXE', idUserAcxe: 'gestor-1' });
    expect(m).not.toHaveProperty('mvQ2p');
    expect(updateDe('aprovacao')[0]).toMatchObject({ status: 'aprovada', aprovadoPor: 'gestor-1' });
    expect(spies.baixa).not.toHaveBeenCalled();
  });

  it('a observacao enviada ao OMIE nao tem caractere fora do Latin-1 (o travessao do motivo de divergencia vira hifen)', async () => {
    apRows = [apr({ galpao: '20.0.7', produtoCodigoQ2p: null, observacoes: 'Divergência: NF 26.000 kg × conferido 25.900 kg (-100 kg) — balança “nova”…' })];
    await aprovarGestor();
    const obs = String(chamadasOmie[0]!.input.observacao);
    expect(obs).toContain('Divergência: NF 26.000 kg × conferido 25.900 kg (-100 kg) - balança "nova"...');
    expect(/[^\u0000-ÿ]/.test(obs)).toBe(false);
  });

  it('sem o custo da NF gravado: recusa (422) SEM preco de estoque como substituto e sem chamar o OMIE', async () => {
    movRows = [mov({ custoUnitarioBrl: null })];
    await expect(aprovarGestor()).rejects.toBeInstanceOf(EntradaNacionalInconsistenteError);
    movRows = [mov({ custoUnitarioBrl: '0.000000' })];
    await expect(aprovarGestor()).rejects.toBeInstanceOf(EntradaNacionalInconsistenteError);
    expect(chamadasOmie).toHaveLength(0);
    expect(transacoes).toBe(0);
  });

  it('falha no OMIE da ACXE: OmieAjusteError(acxe) -> 502 OMIE_ACXE_FAIL, nada gravado e a aprovacao segue pendente', async () => {
    respostaOmie = async () => {
      throw new Error('SOAP-ENV:Client-103 timeout');
    };
    const err = await aprovarGestor().catch((e: Error) => e);
    expect(err).toBeInstanceOf(OmieAjusteError);
    expect((err as OmieAjusteError).lado).toBe('acxe');
    expect(transacoes).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('produto da ACXE ausente na aprovacao: registro inconsistente, nada chamado', async () => {
    apRows = [apr({ galpao: '20.0.7', produtoCodigoQ2p: null, produtoCodigoAcxe: null })];
    await expect(aprovarGestor()).rejects.toThrow(/sem produto/);
    expect(chamadasOmie).toHaveLength(0);
  });
});

describe('Q2P so (11.2): inalterada', () => {
  it('continua com cod_int nacional-q2p, produto da Q2P e perna Q2P gravada', async () => {
    apRows = [apr({ empresa: 'q2p', produtoCodigoAcxe: null, produtoCodigoQ2p: 3033097757, galpao: '11.2', nfChaveAcesso: CHAVE })];
    movRows = [mov({ empresa: 'q2p', custoUnitarioBrl: '11.300000' })];
    localRow = { codigo_acxe: null, codigo_q2p: '8123584710', codigo: '8123584710' };
    await aprovarGestor();
    expect(chamadasOmie).toHaveLength(1);
    expect(chamadasOmie[0]).toMatchObject({
      empresa: 'q2p', codInt: `${OP_ID}:nacional-q2p`, input: { codigoLocalEstoque: '8123584710', idProduto: 3033097757, tipo: 'ENT', motivo: 'INI', valor: 11.3 },
    });
    expect(updateDe('movimentacao')[0]).toMatchObject({ statusOmie: 'concluida', mvQ2p: 1, idMovestQ2p: 'MOV-Q2P', idAjusteQ2p: 'AJ-Q2P' });
    expect(updateDe('movimentacao')[0]).not.toHaveProperty('mvAcxe');
  });

  it('a falha do OMIE da Q2P continua subindo CRUA (nao vira OmieAjusteError)', async () => {
    apRows = [apr({ empresa: 'q2p', produtoCodigoAcxe: null, produtoCodigoQ2p: 3033097757, galpao: '11.2' })];
    movRows = [mov({ empresa: 'q2p', custoUnitarioBrl: '11.300000' })];
    respostaOmie = async () => {
      throw new Error('boom Q2P');
    };
    const err = await aprovarGestor().catch((e: Error) => e);
    expect((err as Error).message).toBe('boom Q2P');
    expect(err).not.toBeInstanceOf(OmieAjusteError);
  });
});

describe('estoque que tambem e da Q2P (21.1): ENT/INI na ACXE E na Q2P, mesmo valor', () => {
  it('chama a ACXE e DEPOIS a Q2P, com o MESMO valor, a MESMA quantidade e a MESMA data; produto e local de cada empresa', async () => {
    const r = await aprovarGestor();
    expect(r).toEqual({ id: 'ap-1', loteStatus: 'reconciliado', pendenciaOmie: undefined });
    expect(chamadasOmie.map((c) => c.empresa)).toEqual(['acxe', 'q2p']);
    const [acxe, q2p] = chamadasOmie;
    expect(acxe).toMatchObject({
      codInt: `${OP_ID}:nacional-acxe`,
      input: { codigoLocalEstoque: '4553940001', idProduto: 4001, quantidade: 26000, tipo: 'ENT', motivo: 'INI', origem: 'AJU' },
    });
    expect(q2p).toMatchObject({
      codInt: `${OP_ID}:nacional-q2p`,
      input: { codigoLocalEstoque: '4553940002', idProduto: 9001, quantidade: 26000, tipo: 'ENT', motivo: 'INI', origem: 'AJU' },
    });
    // o mesmo numero, 6 casas, sem x1,145 e sem arredondar
    expect(acxe!.input.valor).toBe(4.833333);
    expect(q2p!.input.valor).toBe(acxe!.input.valor);
    expect(q2p!.input.dataAtual).toBe(acxe!.input.dataAtual);
    expect(q2p!.input.observacao).toBe(acxe!.input.observacao);
  });

  it('as duas pernas concluem: mv/ids/usuarios das duas empresas, status concluida, erro limpo e NENHUMA baixa de pedido (344)', async () => {
    await aprovarGestor();
    expect(transacoes).toBe(1);
    const [m] = updateDe('movimentacao');
    expect(m).toMatchObject({
      mvAcxe: 1, idMovestAcxe: 'MOV-ACXE', idAjusteAcxe: 'AJ-ACXE', idUserAcxe: 'gestor-1',
      mvQ2p: 1, idMovestQ2p: 'MOV-Q2P', idAjusteQ2p: 'AJ-Q2P', idUserQ2p: 'gestor-1',
      statusOmie: 'concluida', ultimoErroOmie: null,
    });
    expect(m).not.toHaveProperty('baixaPedidoQ2p');
    expect(m).not.toHaveProperty('tentativasQ2p');
    expect(spies.baixa).not.toHaveBeenCalled();
    expect(updateDe('aprovacao')[0]).toMatchObject({ status: 'aprovada', aprovadoPor: 'gestor-1' });
    expect(spies.alertaPendencia).not.toHaveBeenCalled();
    expect(spies.notificaOperador).toHaveBeenCalledTimes(1);
  });

  it('o estoque em 31.1 (tipo tpl) e aceito: o local da Q2P vem do join direto, sem filtro de tipo', async () => {
    apRows = [apr({ galpao: '31.1' })];
    await aprovarGestor();
    expect(chamadasOmie).toHaveLength(2);
  });

  it('Q2P falha DEPOIS da ACXE: aprovacao aprovada, movimentacao pendente_q2p com os ids da ACXE, tentativas 1, erro, alerta e pendenciaOmie', async () => {
    respostaOmie = async (c) => {
      if (c.empresa === 'q2p') throw new Error('OMIE Q2P fora do ar');
      return ok('ACXE')();
    };
    const r = await aprovarGestor();
    expect(chamadasOmie.map((c) => c.empresa)).toEqual(['acxe', 'q2p']);
    expect(r.pendenciaOmie).toEqual({ lado: 'q2p', opId: OP_ID, movimentacaoId: 'mov-1', mensagem: 'OMIE Q2P fora do ar' });
    const [m] = updateDe('movimentacao');
    expect(m).toMatchObject({
      mvAcxe: 1, idMovestAcxe: 'MOV-ACXE', idAjusteAcxe: 'AJ-ACXE',
      statusOmie: 'pendente_q2p', tentativasQ2p: 1,
      ultimoErroOmie: { lado: 'q2p', mensagem: 'OMIE Q2P fora do ar', timestamp: expect.any(String) },
    });
    expect(m).not.toHaveProperty('mvQ2p');
    expect(m).not.toHaveProperty('idMovestQ2p');
    expect(updateDe('aprovacao')[0]).toMatchObject({ status: 'aprovada' });
    expect(spies.alertaPendencia).toHaveBeenCalledTimes(1);
    expect(spies.alertaPendencia.mock.calls[0]![0]).toMatchObject({
      movimentacaoId: 'mov-1', opId: OP_ID, notaFiscal: '937', ladoPendente: 'q2p', mensagemErro: 'OMIE Q2P fora do ar', tentativas: 1,
    });
    expect(spies.baixa).not.toHaveBeenCalled();
  });

  it('ACXE falha: nada e gravado, a Q2P NUNCA e chamada e a aprovacao segue pendente (502 OMIE_ACXE_FAIL)', async () => {
    respostaOmie = async () => {
      throw new Error('OMIE ACXE indisponivel');
    };
    const err = await aprovarGestor().catch((e: Error) => e);
    expect(err).toBeInstanceOf(OmieAjusteError);
    expect((err as OmieAjusteError).lado).toBe('acxe');
    expect((err as OmieAjusteError).opId).toBe(OP_ID);
    expect(chamadasOmie.map((c) => c.empresa)).toEqual(['acxe']);
    expect(transacoes).toBe(0);
    expect(updates).toHaveLength(0);
    expect(spies.alertaPendencia).not.toHaveBeenCalled();
  });

  it('o estoque deixou de ser compartilhado com a Q2P desde o POST: 422, nada chamado', async () => {
    localRow = { codigo_acxe: '4553940001', codigo_q2p: null, codigo: '4553940001' };
    const err = await aprovarGestor().catch((e: Error) => e);
    expect(err).toBeInstanceOf(EntradaNacionalInconsistenteError);
    expect((err as Error).message).toContain('21.1');
    expect(chamadasOmie).toHaveLength(0);
  });

  it('sem o custo da NF gravado: 422, sem preco vivo, nada chamado', async () => {
    movRows = [mov({ custoUnitarioBrl: null })];
    await expect(aprovarGestor()).rejects.toBeInstanceOf(EntradaNacionalInconsistenteError);
    expect(chamadasOmie).toHaveLength(0);
  });

  it('perde a corrida contra outra decisao DEPOIS do OMIE: o erro de status sobe (409); as chamadas ja foram idempotentes', async () => {
    claimFalha = true;
    // tx.select(...).limit devolve a aprovacao ja decidida
    apRows = [apr()];
    const err = await aprovarGestor().catch((e: Error) => e);
    // o claim nao devolve linha e a releitura devolve a aprovacao (mock) -> AprovacaoStatusInvalidoError
    expect(err).toBeInstanceOf(AprovacaoStatusInvalidoError);
    expect(chamadasOmie.map((c) => c.empresa)).toEqual(['acxe', 'q2p']);
  });

  it('aprovacao do formulario manual (sem chave de acesso) NAO e espelhada, mesmo com produto da Q2P: lanca so na ACXE', async () => {
    apRows = [apr({ nfChaveAcesso: null, galpao: '21.2' })];
    await aprovarGestor();
    expect(chamadasOmie.map((c) => c.empresa)).toEqual(['acxe']);
    expect(chamadasOmie[0]!.input.idProduto).toBe(4001);
  });
});

describe('persistencia — as chaves do UPDATE existem no schema', () => {
  // O UPDATE da aprovacao e montado como Record<string, unknown> (o TypeScript nao confere as chaves): uma chave
  // com erro de grafia seria ignorada em silencio e a perna ficaria sem registro. Confere contra o schema real.
  it('movimentacao e aprovacao: toda chave gravada e coluna da tabela', async () => {
    const real = await vi.importActual<typeof import('@atlas/db')>('@atlas/db');
    const { getTableColumns } = await import('drizzle-orm');
    const colMov = Object.keys(getTableColumns(real.movimentacao));
    const colApr = Object.keys(getTableColumns(real.aprovacao));
    // as duas variantes: tudo certo e Q2P pendente
    await aprovarGestor();
    respostaOmie = async (c) => {
      if (c.empresa === 'q2p') throw new Error('fora do ar');
      return ok('ACXE')();
    };
    apRows = [apr()];
    await aprovarGestor();
    expect(updates.length).toBeGreaterThanOrEqual(4);
    for (const u of updates) {
      const colunas = u.table === 'movimentacao' ? colMov : colApr;
      for (const chave of Object.keys(u.set)) expect(colunas, `${u.table}.${chave}`).toContain(chave);
    }
  });
});

describe('listarPendencias — entradaEm', () => {
  const linha = (over: Record<string, unknown> = {}) => ({
    id: 'ap-1', lote_id: null, tipo_aprovacao: 'entrada_manual', precisa_nivel: 'gestor',
    quantidade_prevista_kg: '26000', quantidade_recebida_kg: '26000', tipo_divergencia: null, observacoes: null,
    lancado_por: 'op-1', lancado_em: '2026-10-22T12:00:00.000Z', lote_codigo: null, lote_produto_codigo_acxe: null,
    lote_fornecedor_nome: null, aprov_produto_codigo_acxe: '4001', aprov_galpao: '21.1', aprov_empresa: 'acxe',
    produto_descricao: 'PP PRETO Q35', aprov_produto_codigo_q2p: '9001', aprov_nota_fiscal: '937',
    aprov_nf_item_descricao: 'PP PRETO Q35', aprov_nf_chave_acesso: CHAVE, ...over,
  });

  it('ACXE em estoque que entra nas duas: [acxe, q2p]; so ACXE: [acxe]; Q2P: [q2p]; outros tipos: []', async () => {
    pendenciasRows = [
      linha({ id: 'a' }),
      linha({ id: 'b', aprov_produto_codigo_q2p: null, aprov_galpao: '20.0.7' }),
      linha({ id: 'c', aprov_empresa: 'q2p', aprov_produto_codigo_acxe: null, aprov_produto_codigo_q2p: '3033097757', aprov_galpao: '11.2' }),
      linha({ id: 'd', tipo_aprovacao: 'saida_amostra', aprov_nf_chave_acesso: null }),
      linha({ id: 'e', tipo_aprovacao: 'recebimento_divergencia', aprov_empresa: null, aprov_nf_chave_acesso: null }),
      // formulario manual da ACXE (sem chave): so ACXE, mesmo com os dois codigos
      linha({ id: 'f', aprov_nf_chave_acesso: null }),
    ];
    const lista = await listarPendencias('gestor');
    expect(Object.fromEntries(lista.map((p) => [p.id, p.entradaEm]))).toEqual({
      a: ['acxe', 'q2p'],
      b: ['acxe'],
      c: ['q2p'],
      d: [],
      e: [],
      f: ['acxe'],
    });
    // o produto da pendencia da ACXE sai pelo nome, nunca pelo codigo
    expect(lista[0]!.produto.fornecedor).toBe('PP PRETO Q35');
  });
});

describe('paraLatin1', () => {
  it('troca travessao, aspas curvas e reticencias; acento comum e preservado; o resto vira ?', () => {
    expect(paraLatin1('a — b – c')).toBe('a - b - c');
    expect(paraLatin1('“x” ‘y’')).toBe('"x" \'y\'');
    expect(paraLatin1('espera…')).toBe('espera...');
    expect(paraLatin1('Divergência · balança × nota')).toBe('Divergência · balança × nota');
    expect(paraLatin1('ok ✓')).toBe('ok ?');
  });
});
