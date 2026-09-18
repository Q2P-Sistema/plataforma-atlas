import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Feature 015 (ACXEGDP-328), T071/T072 — baixa por recebimento EXTERNO (Historia 6).
// O item entrou no estoque por fora do Atlas; o operador declara com motivo, o
// gestor aprova e o item sai da fila. Invariante 9 do contrato: NUNCA cria
// movimentacao, NUNCA altera estoque, NUNCA chama o OMIE. Cobre ainda: flag
// desligada, motivo ausente, item ja recebido, idempotencia da solicitacao,
// listagem das baixas aprovadas, reversao pelo gestor (auditada pela trigger
// de `aprovacao`, migration 0008) e o efeito na fila (so 'aprovada' retira).

type Op = { op: 'select' | 'update' | 'insert'; table: string; set?: Record<string, unknown>; values?: Record<string, unknown>; calls: string[] };
const ops: Op[] = [];
let selectQueue: unknown[][] = [];
let updateReturning: unknown[] = [];
let flag: boolean | undefined = true;
const poolQuerySpy = vi.fn();

function chain(op: Op, result: () => unknown): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  c.from = (t: { __id?: string }) => { op.table = t.__id ?? '?'; op.calls.push('from'); return c; };
  for (const m of ['where', 'orderBy', 'limit', 'returning']) c[m] = () => { op.calls.push(m); return c; };
  c.set = (v: Record<string, unknown>) => { op.set = v; op.calls.push('set'); return c; };
  c.values = (v: Record<string, unknown>) => { op.values = v; op.calls.push('values'); return c; };
  c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(result).then(res, rej);
  return c;
}
function fakeDb() {
  return {
    select: () => { const op: Op = { op: 'select', table: '?', calls: [] }; ops.push(op); return chain(op, () => selectQueue.shift() ?? []); },
    update: (t: { __id?: string }) => { const op: Op = { op: 'update', table: t.__id ?? '?', calls: [] }; ops.push(op); return chain(op, () => updateReturning); },
    insert: (t: { __id?: string }) => {
      const op: Op = { op: 'insert', table: t.__id ?? '?', calls: [] };
      ops.push(op);
      return chain(op, () => [{ id: `ap-${ops.filter((o) => o.op === 'insert').length}`, ...(op.values ?? {}) }]);
    },
  };
}

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => fakeDb(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  getConfig: () => ({ STOCKBRIDGE_RECEBIMENTO_EXTERNO_ENABLED: flag }),
}));

vi.mock('@atlas/db', () => ({
  aprovacao: { __id: 'aprovacao', id: {}, tipoAprovacao: {}, status: {}, aprovadoEm: {} },
  movimentacao: { __id: 'movimentacao' },
}));

const omieSpies = { incluirAjusteEstoque: vi.fn(), listarAjusteEstoque: vi.fn(), consultarNF: vi.fn(), alterarPedidoCompra: vi.fn() };
vi.mock('@atlas/integration-omie', () => ({ ...omieSpies, isMockMode: () => false }));

const notificacaoSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/notificacao.service.js', () => ({
  enviarAlertaRecebimentoNacionalLote: (a: unknown) => notificacaoSpy(a),
}));

const detalheMock = vi.fn();
vi.mock('../services/fila-nacional.service.js', () => ({
  getDetalheNfNacional: (c: string) => detalheMock(c),
}));

import {
  solicitarRecebimentoExterno,
  listarBaixasExternasAprovadas,
  reverterRecebimentoExterno,
  recebimentoExternoHabilitado,
  RecebimentoExternoDesabilitadoError,
  MotivoObrigatorioError,
  ItemJaRecebidoError,
  NenhumItemPendenteError,
  RecebimentoExternoNaoEncontradoError,
} from '../services/recebimento-externo.service.js';
import { itemNacionalRecebidoSql } from '../services/fiscal-recebida-sql.js';
import type { ItemNfNacional } from '../services/fila-nacional.service.js';

const CHAVE = '35260868176072000128550010000667241693158505';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GESTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MOTIVO = 'Recebido direto no OMIE em 12/09 por indisponibilidade do Atlas';

function item(o: Partial<ItemNfNacional> & { indice?: number; descricao?: string }): ItemNfNacional {
  const desc = o.descricao ?? 'SUCATA  PSAI MOIDO MESCLADO GROSSO';
  return {
    indice: o.indice ?? 0, descricaoFornecedor: desc, descricaoNormalizada: desc.trim().replace(/\s+/g, ' ').toUpperCase(),
    quantidadeNfKg: 13160, jaRecebido: false, quantidadeNfJaAtribuidaKg: 0, quantidadeConferidaJaGravadaKg: 0,
    quantidadeRestanteKg: 13160, baixadoComoExterno: false, baixaSolicitada: false,
    ...o,
  } as ItemNfNacional;
}
function detalhe(itens: ItemNfNacional[]) {
  return { nfChaveAcesso: CHAVE, notaFiscal: '66724', fornecedorNome: 'ISOFORMA PLASTICOS INDUSTRIAIS LTDA', fornecedorCnpj: '68.176.072/0001-28', itens };
}

const inserts = () => ops.filter((o) => o.op === 'insert');
const updates = () => ops.filter((o) => o.op === 'update');

beforeEach(() => {
  ops.length = 0;
  selectQueue = [];
  updateReturning = [];
  flag = true;
  poolQuerySpy.mockReset();
  poolQuerySpy.mockResolvedValue({ rows: [] }); // sem solicitacao pendente previa
  notificacaoSpy.mockClear();
  for (const s of Object.values(omieSpies)) s.mockReset();
  detalheMock.mockReset();
  detalheMock.mockResolvedValue(detalhe([item({ indice: 0 }), item({ indice: 1, descricao: 'PAPELAO MISTO' })]));
});

describe('flag STOCKBRIDGE_RECEBIMENTO_EXTERNO_ENABLED (T064)', () => {
  it('default (ausente) = ligada; false desliga e a solicitacao e recusada ANTES de consultar a NF', async () => {
    flag = undefined;
    expect(recebimentoExternoHabilitado()).toBe(true);
    flag = false;
    expect(recebimentoExternoHabilitado()).toBe(false);
    await expect(solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: MOTIVO, userId: USER })).rejects.toBeInstanceOf(RecebimentoExternoDesabilitadoError);
    expect(detalheMock).not.toHaveBeenCalled();
    expect(ops).toHaveLength(0);
  });
});

describe('solicitarRecebimentoExterno (T065/T066)', () => {
  it('motivo ausente ou em branco recusa, sem consultar nada', async () => {
    await expect(solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: '   ', userId: USER })).rejects.toBeInstanceOf(MotivoObrigatorioError);
    await expect(solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: '', userId: USER })).rejects.toBeInstanceOf(MotivoObrigatorioError);
    expect(detalheMock).not.toHaveBeenCalled();
  });

  it('itens ausente = TODOS os pendentes: uma aprovacao de gestor por item, sem lote, sem produto, com NF/chave/descricao e motivo', async () => {
    const r = await solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: MOTIVO, userId: USER });
    expect(r).toEqual({ notaFiscal: '66724', aprovacoesCriadas: 2, jaSolicitados: 0, status: 'pendente_aprovacao', aprovacaoIds: ['ap-1', 'ap-2'] });
    expect(inserts().map((i) => i.table)).toEqual(['aprovacao', 'aprovacao']);
    expect(inserts()[0]!.values).toMatchObject({
      loteId: null, movimentacaoId: null, produtoCodigoAcxe: null, produtoCodigoQ2p: null, galpao: null,
      empresa: 'q2p', precisaNivel: 'gestor', tipoAprovacao: 'recebimento_externo',
      quantidadePrevistaKg: '13160', quantidadeRecebidaKg: null, lancadoPor: USER,
      nfChaveAcesso: CHAVE, notaFiscal: '66724', nfItemDescricao: 'SUCATA  PSAI MOIDO MESCLADO GROSSO',
    });
    expect(String(inserts()[0]!.values!.observacoes)).toContain(MOTIVO);
    expect(inserts()[1]!.values!.nfItemDescricao).toBe('PAPELAO MISTO');
    // notifica o gestor uma vez (digest), nivel gestor
    expect(notificacaoSpy).toHaveBeenCalledTimes(1);
    expect(notificacaoSpy.mock.calls[0]![0]).toMatchObject({ notaFiscal: '66724', nivel: 'gestor' });
  });

  it('INVARIANTE 9: nenhuma movimentacao, nenhum UPDATE, nenhuma chamada OMIE — o unico efeito e a aprovacao', async () => {
    await solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: MOTIVO, userId: USER });
    expect(ops.some((o) => o.table === 'movimentacao')).toBe(false);
    expect(updates()).toHaveLength(0);
    for (const s of Object.values(omieSpies)) expect(s).not.toHaveBeenCalled();
    // o pool so e usado para a checagem de idempotencia (SELECT em aprovacao)
    for (const [sql] of poolQuerySpy.mock.calls) {
      expect(String(sql).trim().toUpperCase().startsWith('SELECT')).toBe(true);
      expect(String(sql)).not.toContain('movimentacao');
    }
  });

  it('itens informados: so os pedidos; descricao que nao corresponde a linha e recusada', async () => {
    const r = await solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: MOTIVO, userId: USER, itens: [{ indice: 1, descricaoFornecedor: 'papelao  MISTO' }] });
    expect(r.aprovacoesCriadas).toBe(1);
    expect(inserts()[0]!.values!.nfItemDescricao).toBe('PAPELAO MISTO');
    await expect(
      solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: MOTIVO, userId: USER, itens: [{ indice: 0, descricaoFornecedor: 'OUTRA COISA' }] }),
    ).rejects.toThrow('não corresponde');
  });

  it('item ja recebido no Atlas (integral) ou ja baixado -> ItemJaRecebidoError; parcialmente recebido (restante > 1 kg) ainda cabe', async () => {
    detalheMock.mockResolvedValue(detalhe([item({ jaRecebido: true, quantidadeNfJaAtribuidaKg: 0, quantidadeRestanteKg: 13160 })])); // via manual (sem parcela)
    await expect(solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: MOTIVO, userId: USER, itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO' }] })).rejects.toBeInstanceOf(ItemJaRecebidoError);
    detalheMock.mockResolvedValue(detalhe([item({ jaRecebido: true, baixadoComoExterno: true })]));
    await expect(solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: MOTIVO, userId: USER, itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO' }] })).rejects.toBeInstanceOf(ItemJaRecebidoError);
    expect(inserts()).toHaveLength(0);

    detalheMock.mockResolvedValue(detalhe([item({ jaRecebido: true, quantidadeNfJaAtribuidaKg: 8000, quantidadeRestanteKg: 5160 })]));
    const r = await solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: MOTIVO, userId: USER });
    expect(r.aprovacoesCriadas).toBe(1);
  });

  it('nenhum item pendente na NF -> NenhumItemPendenteError', async () => {
    detalheMock.mockResolvedValue(detalhe([item({ jaRecebido: true, quantidadeNfJaAtribuidaKg: 13160, quantidadeRestanteKg: 0 })]));
    await expect(solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: MOTIVO, userId: USER })).rejects.toBeInstanceOf(NenhumItemPendenteError);
  });

  it('idempotente: item com solicitacao PENDENTE nao ganha outra (jaSolicitados), e sem nada novo nao notifica', async () => {
    poolQuerySpy.mockResolvedValue({ rows: [{ id: 'ap-existente' }] });
    const r = await solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: MOTIVO, userId: USER });
    expect(r).toMatchObject({ aprovacoesCriadas: 0, jaSolicitados: 2, aprovacaoIds: [] });
    expect(inserts()).toHaveLength(0);
    expect(notificacaoSpy).not.toHaveBeenCalled();
    // a checagem e por (chave, descricao normalizada) e so olha status pendente
    const [sql, params] = poolQuerySpy.mock.calls[0]!;
    expect(String(sql)).toContain("tipo_aprovacao = 'recebimento_externo' AND status = 'pendente'");
    expect(params).toEqual([CHAVE, 'SUCATA PSAI MOIDO MESCLADO GROSSO']);
  });
});

describe('efeito na fila (T069) — so a baixa APROVADA retira o item', () => {
  it('itemNacionalRecebidoSql conta recebimento_externo apenas com status aprovada: pendente segue na fila, rejeitada volta a pendente', () => {
    const sql = itemNacionalRecebidoSql({ chaveExpr: 'h.c_chave_nfe', descricaoNormalizadaExpr: 'x', nfNumeroExpr: 'h.n_nf' });
    expect(sql).toContain("a.tipo_aprovacao = 'recebimento_externo'");
    expect(sql).toContain("a.status = 'aprovada'");
    expect(sql).not.toContain("'rejeitada'");
    expect(sql).not.toMatch(/a\.status\s*=\s*'pendente'/);
  });
});

describe('listarBaixasExternasAprovadas / reverterRecebimentoExterno (T071a/T071b/T072)', () => {
  it('lista so aprovadas, mapeando NF, item, quantidade, motivo e quem aprovou', async () => {
    selectQueue = [[{
      id: 'ap-9', nfChaveAcesso: CHAVE, notaFiscal: '66724', nfItemDescricao: 'SUCATA PSAI', quantidadePrevistaKg: '13160.000',
      observacoes: `Recebimento externo · ${MOTIVO}`, lancadoPor: USER, lancadoEm: new Date('2026-09-15T12:00:00Z'),
      aprovadoPor: GESTOR, aprovadoEm: new Date('2026-09-15T13:00:00Z'),
    }]];
    const [b] = await listarBaixasExternasAprovadas();
    expect(b).toEqual({
      id: 'ap-9', nfChaveAcesso: CHAVE, notaFiscal: '66724', nfItemDescricao: 'SUCATA PSAI', quantidadeNfKg: 13160,
      motivo: `Recebimento externo · ${MOTIVO}`, lancadoPor: USER, lancadoEm: '2026-09-15T12:00:00.000Z',
      aprovadoPor: GESTOR, aprovadoEm: '2026-09-15T13:00:00.000Z',
    });
    expect(ops[0]!.calls).toEqual(['from', 'where', 'orderBy', 'limit']);
  });

  it('reversao: so gestor/diretor, motivo obrigatorio', async () => {
    await expect(reverterRecebimentoExterno({ id: 'ap-9', usuarioId: USER, perfilUsuario: 'operador', motivo: 'x' })).rejects.toThrow('Somente gestor');
    await expect(reverterRecebimentoExterno({ id: 'ap-9', usuarioId: GESTOR, perfilUsuario: 'gestor', motivo: '  ' })).rejects.toBeInstanceOf(MotivoObrigatorioError);
    expect(updates()).toHaveLength(0);
  });

  it('reversao pelo gestor: UPDATE aprovada -> rejeitada com "Reversão: <motivo>", quem e quando; o item volta a fila (T072)', async () => {
    updateReturning = [{ id: 'ap-9', notaFiscal: '66724', nfItemDescricao: 'SUCATA PSAI' }];
    const r = await reverterRecebimentoExterno({ id: 'ap-9', usuarioId: GESTOR, perfilUsuario: 'gestor', motivo: 'baixa lançada na NF errada' });
    expect(r).toEqual({ id: 'ap-9', notaFiscal: '66724', nfItemDescricao: 'SUCATA PSAI' });
    const [up] = updates();
    expect(up!.table).toBe('aprovacao');
    expect(up!.set).toMatchObject({ status: 'rejeitada', rejeicaoMotivo: 'Reversão: baixa lançada na NF errada', aprovadoPor: GESTOR });
    expect(up!.set!.aprovadoEm).toBeInstanceOf(Date);
    expect(up!.calls).toEqual(['set', 'where', 'returning']);
    // nada alem da aprovacao muda: sem movimentacao, sem OMIE
    expect(ops.some((o) => o.table === 'movimentacao')).toBe(false);
    for (const s of Object.values(omieSpies)) expect(s).not.toHaveBeenCalled();
  });

  it('reversao de id inexistente / nao aprovada / de outro tipo -> RecebimentoExternoNaoEncontradoError (o WHERE restringe tipo e status)', async () => {
    updateReturning = [];
    await expect(reverterRecebimentoExterno({ id: 'ap-x', usuarioId: GESTOR, perfilUsuario: 'diretor', motivo: 'm' })).rejects.toBeInstanceOf(RecebimentoExternoNaoEncontradoError);
  });

  it('a reversao e um UPDATE em stockbridge.aprovacao — auditado pela trigger existente (migration 0008), sem trigger nova', () => {
    const sql = readFileSync(resolve(__dirname, '../../../../packages/db/migrations/0008_stockbridge_core.sql'), 'utf8');
    expect(sql).toMatch(/AFTER INSERT OR UPDATE OR DELETE ON stockbridge\.aprovacao/);
    expect(sql).toContain('shared.audit_log');
  });
});
