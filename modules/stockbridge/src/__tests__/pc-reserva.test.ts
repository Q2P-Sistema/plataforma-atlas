import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017 (ACXEGDP-437) — releitura ao vivo do PC e reserva (research D4; parte da T031).
//
// relerEReservarPcs (pc-sugestao.service.ts) roda no POST, depois da trava da NF e antes de
// qualquer escrita no OMIE:
//   1. ConsultarPedCompra de cada PC distinto, FORA de transacao;
//   2. numa transacao, com pg_advisory_xact_lock por item de PC em ordem crescente: regra dos
//      75 s, etapa/fornecedor/item/unidade do pedido lido, saldo vivo menos reservas de OUTRAS
//      NFs, encerramento das linhas orfas da propria NF e INSERT das linhas `confirmado`.
//
// O OMIE e o client do pg sao dubles: o client responde cada SQL pelo conteudo (BEGIN, trava,
// UPDATE das orfas, regra dos 75 s, reservas, INSERT, COMMIT, ROLLBACK) e SQL desconhecido
// derruba o teste — se o servico passar a perguntar outra coisa, o dublê precisa aprender.
// Os eventos (OMIE, connect e cada SQL) vao para uma lista unica, para provar a ordem.

const mocks = vi.hoisted(() => ({
  consultarPedidoCompra: vi.fn(),
  connect: vi.fn(),
  // pool.query: so a raiz do CNPJ dos cadastros (raizesDosCadastros), consultada FORA da transacao
  poolQuery: vi.fn(),
  config: {} as Record<string, unknown>,
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getPool: () => ({ connect: () => mocks.connect(), query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params) }),
  getConfig: () => mocks.config,
}));

vi.mock('@atlas/integration-omie', () => ({
  consultarPedidoCompra: (...args: unknown[]) => mocks.consultarPedidoCompra(...args),
}));

import {
  relerEReservarPcs,
  fmtKg,
  PcVinculoInvalidoError,
  PcRecemUsadoAguardeError,
  PC_RECEM_USADO_SEG,
  RESERVA_PC_VALIDADE_MIN,
  type EscolhaPcValidada,
  type PcCandidato,
} from '../services/pc-sugestao.service.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FORNECEDOR = 1111;
const CHAVE_NF = '35261012345678000190550010000078131000078130';
const NCODPED_304 = 8516905979;
const NCODITEM_304 = 8516907022;
const NCODPED_302 = 8516905321;
const NCODITEM_302 = 8516906404;

interface ItemPedidoDuble {
  nCodItem: number;
  cUnidade: string | null;
  nQtde: number;
  nQtdeRec: number | null;
  nValUnit: number | null;
}
interface PedidoDuble {
  nCodPed: number;
  cNumero: string | null;
  cEtapa: string | null;
  nCodFor: number;
  produtos: ItemPedidoDuble[];
}

/** Item do PC 304 como o ConsultarPedCompra o devolve: 18.000 kg a R$ 11,30/kg, nada recebido. */
const itemPedido = (over: Partial<ItemPedidoDuble> = {}): ItemPedidoDuble => ({
  nCodItem: NCODITEM_304,
  cUnidade: 'KG',
  nQtde: 18000,
  nQtdeRec: 0,
  nValUnit: 11.3,
  ...over,
});
const pedido304 = (over: Partial<PedidoDuble> = {}, produtos: ItemPedidoDuble[] = [itemPedido()]): PedidoDuble => ({
  nCodPed: NCODPED_304,
  cNumero: '304',
  cEtapa: '15',
  nCodFor: FORNECEDOR,
  produtos,
  ...over,
});

function candidato(over: Partial<PcCandidato> = {}): PcCandidato {
  return {
    nCodPed: NCODPED_304,
    nCodItem: NCODITEM_304,
    pcNumero: '304',
    produtoDescricao: 'PS CRISTAL B',
    qtdPedidaKg: 18000,
    saldoKg: 18000,
    precoUnit: 11.3,
    precoNfKgComparado: 11.3,
    dtPrevisao: '2026-10-30',
    etapa: '15',
    dentroTolerancia: true,
    casaNumeroPedidoNf: true,
    semDadosLocais: false,
    motivo: 'Quantidade e preço compatíveis',
    outroCadastro: false,
    cnpjCadastro: '',
    dadosEmCache: false,
    unidade: 'KG',
    ...over,
  };
}

/** Escolha já validada pelo portão 1: um item da NF (9.000 kg numa só sequência) apontando o item 304. */
function escolha(over: Partial<EscolhaPcValidada> = {}): EscolhaPcValidada {
  const c = over.candidato ?? candidato();
  return {
    indice: 0,
    sequencias: [1],
    origem: 'sugestao',
    candidato: c,
    dentroTolerancia: true,
    justificativa: null,
    nCodPedOmieAnterior: null,
    nCodItemPedOmieAnterior: null,
    nCodItemOmieVisto: null,
    oferecidos: [
      { nCodPed: c.nCodPed, nCodItem: c.nCodItem, pcNumero: c.pcNumero, saldoKg: c.saldoKg, precoUnit: c.precoUnit, motivo: c.motivo, dentroTolerancia: c.dentroTolerancia },
    ],
    qtdNfKg: 9000,
    precoNfKg: 11.3,
    kgPorSequencia: { 1: 9000 },
    itemDescricao: 'SUCATA PLASTICO',
    unidadeNf: 'KG',
    fatorUnidadeNf: 1,
    ...over,
  };
}

type ArgsReserva = Parameters<typeof relerEReservarPcs>[0];
const ARGS_BASE: Omit<ArgsReserva, 'escolhas'> = {
  empresa: 'q2p',
  ledgerId: 'ledger-1',
  nfChaveAcesso: CHAVE_NF,
  notaFiscal: '7813',
  fornecedorCodigo: FORNECEDOR,
  userId: 'user-1',
};
const reservar = (escolhas: EscolhaPcValidada[], over: Partial<Omit<ArgsReserva, 'escolhas'>> = {}) =>
  relerEReservarPcs({ ...ARGS_BASE, escolhas, ...over });

// ── Dublê do banco e do OMIE ─────────────────────────────────────────────────

type TipoSql = 'BEGIN' | 'COMMIT' | 'ROLLBACK' | 'LOCK' | 'UPDATE' | 'RECENTE' | 'RESERVAS' | 'INSERT' | 'DESCONHECIDO';

interface Chamada {
  tipo: TipoSql;
  sql: string;
  params: unknown[];
}

function tipoDe(sql: string): TipoSql {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return s;
  if (s.includes('pg_advisory_xact_lock')) return 'LOCK';
  if (s.startsWith('UPDATE stockbridge.recebimento_fiscal_pc')) return 'UPDATE';
  if (s.startsWith('INSERT INTO stockbridge.recebimento_fiscal_pc')) return 'INSERT';
  if (s.includes('AS segundos')) return 'RECENTE';
  if (s.includes('SUM(qtd_nf_kg)')) return 'RESERVAS';
  return 'DESCONHECIDO';
}

const estado = {
  /** PCs que o ConsultarPedCompra devolve, por nCodPed. */
  pedidos: new Map<number, PedidoDuble>(),
  /** segundos que faltam para vencer a regra dos 75 s, por item de PC (ausente = nenhum concluído recente). */
  recentePorItem: new Map<number, number>(),
  /** kg reservados por OUTRAS NFs, por item de PC. */
  reservasPorItem: new Map<number, number>(),
  rollbackFalha: false,
  omieFalha: null as Error | null,
  seqId: 0,
  /** Eventos na ordem em que aconteceram: OMIE:<nCodPed>, CONNECT e o tipo de cada SQL. */
  eventos: [] as string[],
  chamadas: [] as Chamada[],
  /**
   * Linhas `confirmado` que os INSERTs desta execução deixaram no "ledger": é o que permite provar o protocolo entre
   * duas NFs (a 2ª vê a reserva da 1ª). A consulta de reservas soma as de OUTRAS NFs; o UPDATE das órfãs tira as da
   * própria NF — a mesma regra do SQL real, no mínimo necessário.
   */
  gravadas: [] as Array<{ chave: string; item: number; kg: number }>,
};

const client = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    const tipo = tipoDe(sql);
    estado.eventos.push(tipo);
    estado.chamadas.push({ tipo, sql, params });
    switch (tipo) {
      case 'BEGIN':
      case 'COMMIT':
      case 'LOCK':
        return { rows: [] };
      case 'ROLLBACK':
        if (estado.rollbackFalha) throw new Error('conexão perdida no ROLLBACK');
        return { rows: [] };
      case 'UPDATE':
        estado.gravadas = estado.gravadas.filter((r) => r.chave !== params[0]);
        return { rows: [], rowCount: 0 };
      case 'RECENTE': {
        const segundos = estado.recentePorItem.get(Number(params[1]));
        return { rows: segundos == null ? [] : [{ segundos }] };
      }
      case 'RESERVAS': {
        const item = Number(params[1]);
        const deOutrasNfs = estado.gravadas.filter((r) => r.item === item && r.chave !== params[2]).reduce((acc, r) => acc + r.kg, 0);
        return { rows: [{ kg: (estado.reservasPorItem.get(item) ?? 0) + deOutrasNfs }] };
      }
      case 'INSERT':
        estado.gravadas.push({ chave: String(params[2]), item: Number(params[6]), kg: Number(params[13]) });
        return { rows: [{ id: `reserva-${++estado.seqId}` }] };
      default:
        throw new Error(`SQL inesperado no dublê do client: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }),
  release: vi.fn(),
};

beforeEach(() => {
  estado.pedidos = new Map([[NCODPED_304, pedido304()]]);
  estado.recentePorItem = new Map();
  estado.reservasPorItem = new Map();
  estado.rollbackFalha = false;
  estado.omieFalha = null;
  estado.seqId = 0;
  estado.eventos = [];
  estado.chamadas = [];
  estado.gravadas = [];
  for (const k of Object.keys(mocks.config)) delete mocks.config[k];

  client.query.mockClear();
  client.release.mockClear();
  mocks.connect.mockReset();
  mocks.connect.mockImplementation(async () => {
    estado.eventos.push('CONNECT');
    return client;
  });
  // raiz do CNPJ dos cadastros (so consultada quando algum PC lido esta em outro cadastro): padrao = sem cadastros
  mocks.poolQuery.mockReset();
  mocks.poolQuery.mockImplementation(async () => {
    estado.eventos.push('RAIZ');
    return { rows: [] };
  });
  mocks.consultarPedidoCompra.mockReset();
  mocks.consultarPedidoCompra.mockImplementation(async (_empresa: string, ref: { nCodPed: number }) => {
    estado.eventos.push(`OMIE:${ref.nCodPed}`);
    if (estado.omieFalha) throw estado.omieFalha;
    const p = estado.pedidos.get(ref.nCodPed);
    if (!p) throw new Error(`pedido ${ref.nCodPed} não registrado no dublê`);
    return p;
  });
});

const chamadasDe = (tipo: TipoSql): Chamada[] => estado.chamadas.filter((c) => c.tipo === tipo);
const tipos = (): string[] => estado.chamadas.map((c) => c.tipo);
const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

async function falha(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('a chamada deveria ter rejeitado');
}

/** Nada foi reservado: transação desfeita, sem INSERT nem COMMIT, e a conexão devolvida. */
function expectSemReserva(): void {
  expect(tipos()).toContain('ROLLBACK');
  expect(tipos()).not.toContain('INSERT');
  expect(tipos()).not.toContain('COMMIT');
  expect(client.release).toHaveBeenCalledTimes(1);
}

// ═══ Recusas pela releitura ao vivo ══════════════════════════════════════════

describe('relerEReservarPcs — PC que o OMIE recusa hoje (PcVinculoInvalidoError)', () => {
  it('PC na etapa 10: recusa "aguardando aprovação no OMIE", com ROLLBACK e sem INSERT', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({ cEtapa: '10' }));
    const err = await falha(reservar([escolha()]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.message).toMatch(/aguardando aprovação/);
    expect(err.message).toContain('PC 304');
    expect(err.message).toContain('NF 7813');
    expect(err.message).toMatch(/outro PC/);
    expectSemReserva();
  });

  it.each([
    ['20', /etapa 20/],
    ['', /desconhecida/],
  ])('PC na etapa "%s": recusa com a situação atual', async (cEtapa, trecho) => {
    estado.pedidos.set(NCODPED_304, pedido304({ cEtapa: cEtapa || null }));
    const err = await falha(reservar([escolha()]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.message).toMatch(trecho);
    expect(err.message).toMatch(/não está aprovado/);
    expectSemReserva();
  });

  it('saldo vivo 0 (nQtde = nQtdeRec): recusa "não tem saldo disponível"', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ nQtde: 18000, nQtdeRec: 18000 })]));
    const err = await falha(reservar([escolha()]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.message).toContain('não tem saldo disponível');
    expectSemReserva();
  });

  it('recebido acima do pedido (nQtdeRec > nQtde) também é saldo zero', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ nQtde: 18000, nQtdeRec: 20000 })]));
    const err = await falha(reservar([escolha()]));
    expect(err.message).toContain('não tem saldo disponível');
  });

  it('nQtdeRec nulo conta como zero: o saldo vivo é a quantidade inteira', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ nQtde: 18000, nQtdeRec: null })]));
    await reservar([escolha({ qtdNfKg: 18000, kgPorSequencia: { 1: 18000 } })]);
    expect(chamadasDe('INSERT')[0]!.params[15]).toBe('18000.000');
  });

  it('PC de outro fornecedor: recusa "é de outro fornecedor"', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({ nCodFor: 2222 }));
    const err = await falha(reservar([escolha()]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.message).toMatch(/outro fornecedor/);
    expectSemReserva();
  });

  it('sem fornecedor conhecido (null) a checagem de fornecedor não se aplica', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({ nCodFor: 2222 }));
    const r = await reservar([escolha()], { fornecedorCodigo: null });
    expect(r).toHaveLength(1);
  });

  it('item ausente do PC: recusa "o item escolhido não existe mais no pedido"', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ nCodItem: 1 })]));
    const err = await falha(reservar([escolha()]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.message).toMatch(/não existe mais/);
    expectSemReserva();
  });

  it.each([
    ['UN', /unidade do pedido \(UN\)/],
    [null, /unidade do pedido/],
  ])('unidade %s do item no PC: recusa', async (cUnidade, trecho) => {
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ cUnidade })]));
    const err = await falha(reservar([escolha()]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.message).toMatch(trecho);
    expect(err.message).toMatch(/não é comparável em kg/);
    expectSemReserva();
  });

  it('número do PC na mensagem é o lido ao vivo (o da cópia pode estar em branco)', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({ cEtapa: '10', cNumero: '304' }));
    const err = await falha(reservar([escolha({ candidato: candidato({ pcNumero: '' }) })]));
    expect(err.message).toContain('PC 304');
    // sem número em lugar nenhum, a mensagem diz "(sem número)" e nunca expõe o id do OMIE
    estado.pedidos.set(NCODPED_304, pedido304({ cEtapa: '10', cNumero: null }));
    const semNumero = await falha(reservar([escolha({ candidato: candidato({ pcNumero: '' }) })]));
    expect(semNumero.message).toContain('(sem número)');
    expect(semNumero.message).not.toMatch(/\d{10}/);
  });

  it('com dois itens, a recusa do segundo desfaz tudo: nenhuma reserva é gravada para o primeiro', async () => {
    estado.pedidos.set(NCODPED_302, { ...pedido304({ cEtapa: '10', cNumero: '302' }), nCodPed: NCODPED_302, produtos: [itemPedido({ nCodItem: NCODITEM_302 })] });
    const e1 = escolha({ indice: 0 });
    const e2 = escolha({ indice: 1, sequencias: [2], kgPorSequencia: { 2: 9000 }, candidato: candidato({ nCodPed: NCODPED_302, nCodItem: NCODITEM_302, pcNumero: '302' }) });
    const err = await falha(reservar([e1, e2]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expectSemReserva();
  });
});

// ═══ Regra dos 75 s ═══════════════════════════════════════════════════════════

describe('relerEReservarPcs — PC recém-usado (cache de ~1 min do OMIE)', () => {
  it('concluído no mesmo item há menos de 75 s: PcRecemUsadoAguardeError com os segundos que faltam', async () => {
    estado.recentePorItem.set(NCODITEM_304, 42);
    const err = await falha(reservar([escolha()]));
    expect(err).toBeInstanceOf(PcRecemUsadoAguardeError);
    expect((err as PcRecemUsadoAguardeError).segundos).toBe(42);
    expect((err as PcRecemUsadoAguardeError).pcNumero).toBe('304');
    expect(err.message).toContain('42 segundos');
    expectSemReserva();
  });

  it('a consulta da regra é por empresa + item de PC + janela de 75 s, só sobre vínculos concluídos', async () => {
    await reservar([escolha()]);
    const [c] = chamadasDe('RECENTE');
    const sql = norm(c!.sql);
    expect(sql).toContain("status = 'concluido'");
    expect(sql).toContain('concluido_em > now() - make_interval(secs => $3)');
    expect(c!.params).toEqual(['q2p', NCODITEM_304, PC_RECEM_USADO_SEG]);
    expect(PC_RECEM_USADO_SEG).toBe(75);
  });

  it('1 segundo fica no singular; 0 ou negativo vira 1', async () => {
    estado.recentePorItem.set(NCODITEM_304, 1);
    const umSegundo = (await falha(reservar([escolha()]))).message;
    expect(umSegundo).toMatch(/\b1 segundo\b/);
    expect(umSegundo).not.toContain('1 segundos');
    estado.recentePorItem.set(NCODITEM_304, 0);
    expect(((await falha(reservar([escolha()]))) as PcRecemUsadoAguardeError).segundos).toBe(1);
    estado.recentePorItem.set(NCODITEM_304, -3);
    expect(((await falha(reservar([escolha()]))) as PcRecemUsadoAguardeError).segundos).toBe(1);
  });

  it('a regra dos 75 s vem antes das checagens do pedido lido (a leitura pode ser cache)', async () => {
    estado.recentePorItem.set(NCODITEM_304, 30);
    estado.pedidos.set(NCODPED_304, pedido304({ cEtapa: '10' }));
    expect(await falha(reservar([escolha()]))).toBeInstanceOf(PcRecemUsadoAguardeError);
  });

  // O vínculo do OMIE fora da cópia chega com pcNumero '': a regra dos 75 s usa o número lido ao vivo
  // (cNumero '304', lido antes da transação), como as recusas de etapa, fornecedor e saldo.
  it('PC recém-usado de vínculo fora da cópia cita o número lido ao vivo, não "(sem número)"', async () => {
    estado.recentePorItem.set(NCODITEM_304, 30);
    const err = await falha(reservar([escolha({ origem: 'omie', candidato: candidato({ pcNumero: '' }) })]));
    expect(err).toBeInstanceOf(PcRecemUsadoAguardeError);
    expect(err.message).toContain('PC 304');
    expect((err as PcRecemUsadoAguardeError).pcNumero).toBe('304');
  });

  it('só vale para o MESMO item de PC: concluído recente em outro item não bloqueia', async () => {
    estado.recentePorItem.set(NCODITEM_302, 30);
    const r = await reservar([escolha()]);
    expect(r).toHaveLength(1);
  });
});

// ═══ Saldo vivo e reservas ════════════════════════════════════════════════════

describe('relerEReservarPcs — saldo disponível (nQtde − nQtdeRec ao vivo − reservas de OUTRAS NFs)', () => {
  it('PC de 18.000 kg com nQtdeRec 9.000 (o OMIE já contou a 1ª NF) e NF de 9.000 kg: passa — o saldo vivo não desconta concluídos', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ nQtde: 18000, nQtdeRec: 9000 })]));
    const r = await reservar([escolha({ qtdNfKg: 9000 })]);
    expect(r).toHaveLength(1);
    // o que fica gravado é o saldo vivo: 18.000 − 9.000
    expect(chamadasDe('INSERT')[0]!.params[15]).toBe('9000.000');
    expect(tipos()).toContain('COMMIT');
  });

  it('a consulta de reservas só olha confirmado/associado de OUTRAS NFs da janela de 15 min — nunca concluídos', async () => {
    await reservar([escolha()]);
    const [c] = chamadasDe('RESERVAS');
    const sql = norm(c!.sql);
    expect(sql).toContain("status IN ('confirmado', 'associado')");
    expect(sql).not.toContain('concluido');
    expect(sql).toContain('nf_chave_acesso <> $3');
    expect(sql).toContain('confirmado_em > now() - make_interval(mins => $4)');
    expect(c!.params).toEqual(['q2p', NCODITEM_304, CHAVE_NF, RESERVA_PC_VALIDADE_MIN]);
  });

  it('mesma situação com reserva de 9.000 kg de OUTRA NF: recusa (disponível 0)', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ nQtde: 18000, nQtdeRec: 9000 })]));
    estado.reservasPorItem.set(NCODITEM_304, 9000);
    const err = await falha(reservar([escolha({ qtdNfKg: 9000 })]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.message).toContain('não tem saldo disponível');
    expectSemReserva();
  });

  it('com reserva de outra NF, grava o saldo RELIDO do OMIE (data-model §4), não o disponível depois das reservas', async () => {
    estado.reservasPorItem.set(NCODITEM_304, 4500); // disponível 13.500 dos 18.000 vivos
    await reservar([escolha({ qtdNfKg: 9000 })]);
    expect(chamadasDe('INSERT')[0]!.params[15]).toBe('18000.000');
  });

  it('reserva parcial de outra NF reduz o disponível: 4.000 kg cabem, 4.200 kg não (tolerância de 2% = 4.080)', async () => {
    estado.reservasPorItem.set(NCODITEM_304, 14000); // sobram 4.000 dos 18.000 vivos
    const cabe = await reservar([escolha({ qtdNfKg: 4000, kgPorSequencia: { 1: 4000 } })]);
    expect(cabe).toHaveLength(1);

    estado.chamadas = [];
    const err = await falha(reservar([escolha({ qtdNfKg: 4200, kgPorSequencia: { 1: 4200 } })]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.message).toMatch(/não cobre a NF/);
    expect(err.message).toContain(fmtKg(4000));
    expect(err.message).toContain(fmtKg(4200));
  });

  it('NF de 9.500 kg com disponível de 9.000 kg: sem justificativa recusa; com justificativa passa', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ nQtde: 18000, nQtdeRec: 9000 })]));
    const semJustificativa = escolha({ qtdNfKg: 9500, kgPorSequencia: { 1: 9500 } });
    const err = await falha(reservar([semJustificativa]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.message).toMatch(/não cobre a NF/);
    expect(err.message).toContain(fmtKg(9000)); // disponível
    expect(err.message).toContain(fmtKg(9500)); // NF
    expectSemReserva();

    estado.chamadas = [];
    client.release.mockClear();
    const comJustificativa = escolha({ qtdNfKg: 9500, kgPorSequencia: { 1: 9500 }, justificativa: 'Excedente aceito pelo comprador', dentroTolerancia: false });
    const r = await reservar([comJustificativa]);
    expect(r).toHaveLength(1);
    expect(chamadasDe('INSERT')[0]!.params[11]).toBe('Excedente aceito pelo comprador');
  });

  it('o limite é 2% sobre o disponível: 9.180 kg passa sem justificativa, 9.181 kg não', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ nQtde: 18000, nQtdeRec: 9000 })]));
    expect(await reservar([escolha({ qtdNfKg: 9180, kgPorSequencia: { 1: 9180 } })])).toHaveLength(1);
    estado.chamadas = [];
    expect(await falha(reservar([escolha({ qtdNfKg: 9181, kgPorSequencia: { 1: 9181 } })]))).toBeInstanceOf(PcVinculoInvalidoError);
  });

  it('a tolerância de quantidade vem da configuração', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ nQtde: 18000, nQtdeRec: 9000 })]));
    mocks.config.STOCKBRIDGE_PC_TOLERANCIA_QTD_PCT = 10;
    expect(await reservar([escolha({ qtdNfKg: 9500, kgPorSequencia: { 1: 9500 } })])).toHaveLength(1);
  });

  it('sem saldo disponível nem a justificativa salva: a recusa vale mesmo com justificativa', async () => {
    estado.reservasPorItem.set(NCODITEM_304, 18000);
    const err = await falha(reservar([escolha({ justificativa: 'Mesmo assim', dentroTolerancia: false })]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.message).toContain('não tem saldo disponível');
  });

  it('PC em tonelada (NF também em toneladas): o saldo vivo e o preço são convertidos para kg', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ cUnidade: 'T', nQtde: 18, nQtdeRec: 9, nValUnit: 11300 })]));
    await reservar([escolha({ qtdNfKg: 9000, unidadeNf: 'TON', fatorUnidadeNf: 1000 })]);
    const [ins] = chamadasDe('INSERT');
    expect(ins!.params[15]).toBe('9000.000');
    expect(ins!.params[16]).toBe('11.300000');
  });

  it('dois itens da NF no MESMO item de PC somam: 6.000 + 4.000 kg passam de 9.000 × 1,02 e exigem justificativa em todos', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ nQtde: 18000, nQtdeRec: 9000 })]));
    const e1 = escolha({ indice: 0, sequencias: [1], qtdNfKg: 6000, kgPorSequencia: { 1: 6000 } });
    const e2 = escolha({ indice: 1, sequencias: [2], qtdNfKg: 4000, kgPorSequencia: { 2: 4000 } });
    const err = await falha(reservar([e1, e2]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.message).toMatch(/não cobre a NF/);
    expect(err.message).toContain(fmtKg(10000));

    // justificativa só num dos dois não basta
    estado.chamadas = [];
    expect(await falha(reservar([{ ...e1, justificativa: 'ok' }, e2]))).toBeInstanceOf(PcVinculoInvalidoError);

    // nos dois, passa — com uma trava só e uma reserva por item da NF
    estado.chamadas = [];
    const r = await reservar([{ ...e1, justificativa: 'ok' }, { ...e2, justificativa: 'ok' }]);
    expect(r.map((x) => x.nSequencia)).toEqual([1, 2]);
    expect(chamadasDe('LOCK')).toHaveLength(1);
    expect(chamadasDe('RECENTE')).toHaveLength(1);
  });
});

// ═══ Protocolo entre duas NFs ═════════════════════════════════════════════════

describe('relerEReservarPcs — duas NFs no mesmo item de PC (a reserva fecha a janela)', () => {
  /** Uma NF de `qtd` kg no item 304 (18.000 kg vivos, nada recebido). */
  const nf = (chave: string, qtd: number) =>
    reservar([escolha({ qtdNfKg: qtd, kgPorSequencia: { 1: qtd } })], { nfChaveAcesso: chave, ledgerId: `ledger-${chave}` });

  it('a 2ª NF vê a reserva da 1ª; a 3ª, sem saldo, é recusada', async () => {
    await nf('NF-A', 9000);
    await nf('NF-B', 9000); // sobravam 9.000 depois da reserva da A
    const err = await falha(nf('NF-C', 9000));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.message).toContain('não tem saldo disponível');
    // a recusada não deixou reserva: continuam só as de A e B
    expect(estado.gravadas.map((r) => r.chave).sort()).toEqual(['NF-A', 'NF-B']);
  });

  it('a 2ª NF maior que o que sobrou é recusada, citando o disponível e a NF', async () => {
    await nf('NF-A', 9000);
    const err = await falha(nf('NF-B', 18000));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.message).toMatch(/não cobre a NF/);
    expect(err.message).toContain(fmtKg(9000));
    expect(err.message).toContain(fmtKg(18000));
    expect(estado.gravadas.map((r) => r.chave)).toEqual(['NF-A']);
  });

  it('a mesma NF confirmada de novo (retentativa) não se bloqueia nem reserva em dobro', async () => {
    await nf('NF-A', 18000);
    await nf('NF-A', 18000); // a reserva antiga vira falha e a própria NF não conta no disponível
    expect(estado.gravadas).toEqual([{ chave: 'NF-A', item: NCODITEM_304, kg: 18000 }]);
    expect(chamadasDe('UPDATE')).toHaveLength(2);
  });

  it('PC com NF já concluída no OMIE (nQtdeRec 9.000) e uma reserva de outra NF: só sobra o que o OMIE mostra menos a reserva', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ nQtde: 18000, nQtdeRec: 9000 })]));
    await nf('NF-B', 6000); // 9.000 vivos → sobram 3.000
    const err = await falha(nf('NF-C', 4000)); // 4.000 > 3.000 × 1,02
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(await nf('NF-D', 3000)).toHaveLength(1); // 3.000 cabe
  });
});

// ═══ Ordem das operações ══════════════════════════════════════════════════════

describe('relerEReservarPcs — ordem: OMIE fora da transação, travas crescentes, limpeza, reservas', () => {
  /** Registra o PC `ped` com um item `item` de 18.000 kg. */
  function registrar(ped: number, item: number, numero: string): void {
    estado.pedidos.set(ped, { nCodPed: ped, cNumero: numero, cEtapa: '15', nCodFor: FORNECEDOR, produtos: [itemPedido({ nCodItem: item })] });
  }
  const escolhaDe = (indice: number, ped: number, item: number, numero: string): EscolhaPcValidada =>
    escolha({
      indice,
      sequencias: [indice + 1],
      kgPorSequencia: { [indice + 1]: 1000 },
      qtdNfKg: 1000,
      candidato: candidato({ nCodPed: ped, nCodItem: item, pcNumero: numero }),
    });

  it('travas pg_advisory_xact_lock em ordem crescente de item de PC (numérica, não textual)', async () => {
    // textual daria 10, 100, 9; numérico dá 9, 10, 100
    registrar(9000, 9, 'A');
    registrar(10000, 10, 'B');
    registrar(100000, 100, 'C');
    await reservar([escolhaDe(0, 100000, 100, 'C'), escolhaDe(1, 9000, 9, 'A'), escolhaDe(2, 10000, 10, 'B')]);

    const locks = chamadasDe('LOCK');
    expect(locks.map((c) => c.params)).toEqual([['sb:pc-item:q2p:9'], ['sb:pc-item:q2p:10'], ['sb:pc-item:q2p:100']]);
    expect(norm(locks[0]!.sql)).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
  });

  it('a chave da trava leva a empresa', async () => {
    await reservar([escolha()], { empresa: 'acxe' });
    expect(chamadasDe('LOCK')[0]!.params).toEqual([`sb:pc-item:acxe:${NCODITEM_304}`]);
  });

  it('o UPDATE que encerra linhas vivas antigas da mesma NF roda depois das travas e antes dos INSERTs', async () => {
    await reservar([escolha({ sequencias: [1, 2], kgPorSequencia: { 1: 5000, 2: 4000 } })]);
    const t = tipos();
    expect(chamadasDe('UPDATE')).toHaveLength(1);
    expect(t.indexOf('UPDATE')).toBeGreaterThan(t.lastIndexOf('LOCK'));
    expect(t.indexOf('UPDATE')).toBeLessThan(t.indexOf('INSERT'));

    const [u] = chamadasDe('UPDATE');
    const sql = norm(u!.sql);
    expect(sql).toContain("SET status = 'falha'");
    expect(sql).toContain("WHERE nf_chave_acesso = $1 AND status IN ('confirmado', 'associado')");
    expect(u!.params).toEqual([CHAVE_NF]);
  });

  it('todas as checagens vêm antes do primeiro INSERT; BEGIN abre, COMMIT fecha, sem ROLLBACK', async () => {
    registrar(9000, 9, 'A');
    registrar(10000, 10, 'B');
    await reservar([escolhaDe(0, 9000, 9, 'A'), escolhaDe(1, 10000, 10, 'B')]);
    const t = tipos();
    expect(t[0]).toBe('BEGIN');
    expect(t[t.length - 1]).toBe('COMMIT');
    expect(t).not.toContain('ROLLBACK');
    const primeiroInsert = t.indexOf('INSERT');
    expect(t.lastIndexOf('RECENTE')).toBeLessThan(primeiroInsert);
    expect(t.lastIndexOf('RESERVAS')).toBeLessThan(primeiroInsert);
    expect(t.filter((x) => x === 'INSERT')).toHaveLength(2);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('consultarPedidoCompra: uma vez por PC distinto, em ordem de nCodPed, com a empresa, antes de abrir a conexão e o BEGIN', async () => {
    registrar(NCODPED_302, NCODITEM_302, '302');
    // dois itens da NF no PC 304 (mesmo pedido) + um no 302: 2 leituras, não 3
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido(), itemPedido({ nCodItem: NCODITEM_304 + 1 })]));
    await reservar([
      escolha({ indice: 0 }),
      escolha({ indice: 1, sequencias: [2], kgPorSequencia: { 2: 1000 }, qtdNfKg: 1000, candidato: candidato({ nCodItem: NCODITEM_304 + 1 }) }),
      escolha({ indice: 2, sequencias: [3], kgPorSequencia: { 3: 1000 }, qtdNfKg: 1000, candidato: candidato({ nCodPed: NCODPED_302, nCodItem: NCODITEM_302, pcNumero: '302' }) }),
    ]);

    expect(mocks.consultarPedidoCompra).toHaveBeenCalledTimes(2);
    expect(mocks.consultarPedidoCompra.mock.calls.map((c) => c[1])).toEqual([{ nCodPed: NCODPED_302 }, { nCodPed: NCODPED_304 }]);
    expect(mocks.consultarPedidoCompra.mock.calls.every((c) => c[0] === 'q2p')).toBe(true);

    const ev = estado.eventos;
    const ultimaLeitura = Math.max(...ev.map((e, i) => (e.startsWith('OMIE:') ? i : -1)));
    expect(ultimaLeitura).toBeLessThan(ev.indexOf('CONNECT'));
    expect(ev.indexOf('CONNECT')).toBeLessThan(ev.indexOf('BEGIN'));
  });

  it('a leitura da ACXE usa a empresa acxe', async () => {
    await reservar([escolha()], { empresa: 'acxe' });
    expect(mocks.consultarPedidoCompra).toHaveBeenCalledWith('acxe', { nCodPed: NCODPED_304 });
    expect(chamadasDe('INSERT')[0]!.params[1]).toBe('acxe');
    expect(chamadasDe('RECENTE')[0]!.params[0]).toBe('acxe');
    expect(chamadasDe('RESERVAS')[0]!.params[0]).toBe('acxe');
  });

  it('falha na leitura do OMIE: propaga o erro sem abrir conexão nem transação', async () => {
    estado.omieFalha = new Error('OMIE indisponível');
    const err = await falha(reservar([escolha()]));
    expect(err.message).toBe('OMIE indisponível');
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(estado.chamadas).toEqual([]);
  });

  it('sem escolhas devolve lista vazia sem chamar o OMIE nem o banco', async () => {
    expect(await reservar([])).toEqual([]);
    expect(mocks.consultarPedidoCompra).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('erro no ROLLBACK não mascara o erro original e a conexão é devolvida', async () => {
    estado.rollbackFalha = true;
    estado.pedidos.set(NCODPED_304, pedido304({ cEtapa: '10' }));
    const err = await falha(reservar([escolha()]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('a conexão é devolvida também no caminho feliz', async () => {
    await reservar([escolha()]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// ═══ Gravação da reserva ══════════════════════════════════════════════════════

describe('relerEReservarPcs — linhas `confirmado` (a reserva)', () => {
  it('um INSERT confirmado por sequência, com o kg da sequência, e COMMIT', async () => {
    const e = escolha({ sequencias: [1, 2], qtdNfKg: 9000, kgPorSequencia: { 1: 6000, 2: 3000 } });
    const r = await reservar([e]);

    const inserts = chamadasDe('INSERT');
    expect(inserts).toHaveLength(2);
    for (const c of inserts) {
      const sql = norm(c.sql);
      expect(sql).toContain('INSERT INTO stockbridge.recebimento_fiscal_pc');
      expect(sql).toContain("'confirmado'");
      expect(sql).toContain('RETURNING id');
    }
    expect(inserts.map((c) => c.params[3])).toEqual([1, 2]); // n_sequencia
    expect(inserts.map((c) => c.params[13])).toEqual(['6000.000', '3000.000']); // qtd_nf_kg
    expect(tipos()[tipos().length - 1]).toBe('COMMIT');
    expect(r).toHaveLength(2);
  });

  it('os parâmetros do INSERT gravam o que foi escolhido e o que foi relido', async () => {
    const e = escolha({
      origem: 'omie',
      dentroTolerancia: false,
      justificativa: 'Excedente combinado',
      nCodPedOmieAnterior: NCODPED_302,
      nCodItemPedOmieAnterior: NCODITEM_302,
      qtdNfKg: 9000,
      precoNfKg: 11.35,
    });
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ nQtde: 18000, nQtdeRec: 4500, nValUnit: 11.3 })]));
    await reservar([e]);
    const p = chamadasDe('INSERT')[0]!.params;
    expect(p[0]).toBe('ledger-1'); // recebimento_fiscal_id
    expect(p[1]).toBe('q2p'); // empresa
    expect(p[2]).toBe(CHAVE_NF); // nf_chave_acesso
    expect(p[3]).toBe(1); // n_sequencia
    expect(p[4]).toBe('omie'); // origem
    expect(p[5]).toBe(NCODPED_304); // n_cod_ped
    expect(p[6]).toBe(NCODITEM_304); // n_cod_item_ped
    expect(p[7]).toBe('304'); // pc_numero
    expect(p[8]).toBe(NCODPED_302); // n_cod_ped_omie_anterior
    expect(p[9]).toBe(NCODITEM_302); // n_cod_item_ped_omie_anterior
    expect(p[10]).toBe(false); // dentro_tolerancia
    expect(p[11]).toBe('Excedente combinado'); // justificativa
    expect(JSON.parse(p[12] as string)).toEqual(e.oferecidos); // candidatos (retrato)
    expect(p[13]).toBe('9000.000'); // qtd_nf_kg
    expect(p[14]).toBe('11.350000'); // preco_nf
    expect(p[15]).toBe('13500.000'); // saldo_pc_kg_lido (18.000 − 4.500)
    expect(p[16]).toBe('11.300000'); // preco_pc_lido
    expect(p[17]).toBe('15'); // etapa_pc_lida
    expect(p[18]).toBe('user-1'); // confirmado_por
  });

  it('sem vínculo anterior nem justificativa, os campos opcionais vão como null', async () => {
    await reservar([escolha()]);
    const p = chamadasDe('INSERT')[0]!.params;
    expect(p[8]).toBeNull();
    expect(p[9]).toBeNull();
    expect(p[11]).toBeNull();
  });

  it('PC sem preço lido (nValUnit nulo): preco_pc_lido vai null', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({}, [itemPedido({ nValUnit: null })]));
    await reservar([escolha()]);
    expect(chamadasDe('INSERT')[0]!.params[16]).toBeNull();
  });

  it('o retorno lista as reservas (id, sequência, índice do item, PC, origem e quantidade na unidade do PC), na ordem das escolhas', async () => {
    estado.pedidos.set(NCODPED_302, { ...pedido304({ cNumero: '302' }), nCodPed: NCODPED_302, produtos: [itemPedido({ nCodItem: NCODITEM_302 })] });
    const e1 = escolha({ indice: 0, sequencias: [1, 2], kgPorSequencia: { 1: 5000, 2: 4000 }, qtdNfKg: 9000, origem: 'sugestao' });
    const e2 = escolha({
      indice: 1,
      sequencias: [3],
      kgPorSequencia: { 3: 2000 },
      qtdNfKg: 2000,
      origem: 'manual',
      candidato: candidato({ nCodPed: NCODPED_302, nCodItem: NCODITEM_302, pcNumero: '302' }),
    });
    const r = await reservar([e1, e2]);
    expect(r).toEqual([
      { id: 'reserva-1', nSequencia: 1, indice: 0, nCodPed: NCODPED_304, nCodItemPed: NCODITEM_304, pcNumero: '304', origem: 'sugestao', nQtdeRecebida: null },
      { id: 'reserva-2', nSequencia: 2, indice: 0, nCodPed: NCODPED_304, nCodItemPed: NCODITEM_304, pcNumero: '304', origem: 'sugestao', nQtdeRecebida: null },
      { id: 'reserva-3', nSequencia: 3, indice: 1, nCodPed: NCODPED_302, nCodItemPed: NCODITEM_302, pcNumero: '302', origem: 'manual', nQtdeRecebida: null },
    ]);
  });

  it('sequência sem kg informado grava 0,000 (nunca NaN)', async () => {
    await reservar([escolha({ sequencias: [1, 7], kgPorSequencia: { 1: 9000 } })]);
    expect(chamadasDe('INSERT').map((c) => c.params[13])).toEqual(['9000.000', '0.000']);
  });

  // Regressão: para o vínculo do OMIE fora da cópia o candidato nasce com pcNumero '' (montarPcDoItem) e a
  // releitura, que já tinha o número certo em `numeroVivo`, só o usava nas mensagens de erro: o ledger ficava com
  // pc_numero '' e fiscal.vinculos[].pcNumero '' (a mensagem final caía no texto genérico "…vinculados aos pedidos
  // de compra" em vez de "…vinculado ao PC 304"). Corrigido no serviço durante a escrita desta suíte.
  it('vínculo do OMIE fora da cópia (pcNumero em branco): o ledger e o retorno levam o número lido ao vivo', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({ cNumero: '304' }));
    const r = await reservar([escolha({ origem: 'omie', candidato: candidato({ pcNumero: '' }) })]);
    expect(chamadasDe('INSERT')[0]!.params[7]).toBe('304'); // pc_numero
    expect(r[0]!.pcNumero).toBe('304');
  });

  it('sem número em lugar nenhum (cópia em branco e OMIE sem cNumero): grava vazio, sem quebrar', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({ cNumero: null }));
    const r = await reservar([escolha({ origem: 'omie', candidato: candidato({ pcNumero: '' }) })]);
    expect(chamadasDe('INSERT')[0]!.params[7]).toBe('');
    expect(r[0]!.pcNumero).toBe('');
  });
});

describe('fmtKg', () => {
  it('formata em pt-BR com ponto de milhar (as mensagens de saldo dependem disso)', () => {
    expect(fmtKg(9000)).toBe('9.000');
    expect(fmtKg(18360.5)).toBe('18.360,5');
    expect(fmtKg(0)).toBe('0');
  });
});

// ═══ Correcoes da revisao adversarial de 22/10/2026 ═════════════════════════════

describe('relerEReservarPcs — item de PC recusado vai no erro (achado tela-04)', () => {
  it('PcVinculoInvalidoError leva nCodPed/nCodItem do PC recusado (id de seleção para a tela, fora da mensagem)', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({ cEtapa: '10' }));
    const err = (await falha(reservar([escolha()]))) as PcVinculoInvalidoError;
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.pc).toEqual({ nCodPed: NCODPED_304, nCodItem: NCODITEM_304 });
    expect(err.message).not.toMatch(/\d{10}/);
  });

  it('também na recusa por saldo e por fornecedor', async () => {
    estado.reservasPorItem.set(NCODITEM_304, 18000);
    expect(((await falha(reservar([escolha()]))) as PcVinculoInvalidoError).pc).toEqual({ nCodPed: NCODPED_304, nCodItem: NCODITEM_304 });
    estado.reservasPorItem = new Map();
    estado.pedidos.set(NCODPED_304, pedido304({ nCodFor: 2222 }));
    expect(((await falha(reservar([escolha()]))) as PcVinculoInvalidoError).pc).toEqual({ nCodPed: NCODPED_304, nCodItem: NCODITEM_304 });
  });
});

describe('relerEReservarPcs — vínculo que o próprio OMIE fez, em outro cadastro do mesmo fornecedor (achado sugestao-01)', () => {
  const VIVO_304 = { 1: { nIdPedido: NCODPED_304, nIdItPedido: NCODITEM_304 } };

  it('origem omie com o vínculo VIVO no OMIE: PC de outro cadastro (ex.: matriz) passa — o OMIE já aceitou o vínculo', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({ nCodFor: 2222 }));
    const r = await reservar([escolha({ origem: 'omie' })], { vinculosVivos: VIVO_304 });
    expect(r).toHaveLength(1);
  });

  it('origem omie mas o vínculo SUMIU do OMIE (o Atlas o recriaria com ASSOCIAR): vale o FR-009 — "é de outro fornecedor" (achado sugestao-v01)', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({ nCodFor: 2222 }));
    const err = await falha(reservar([escolha({ origem: 'omie' })], { vinculosVivos: { 1: null } }));
    expect(err.message).toContain('é de outro fornecedor');
  });

  it('origem omie com o vínculo vivo em só UMA das linhas: a outra seria associada pelo Atlas — recusa', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({ nCodFor: 2222 }));
    const e = escolha({ origem: 'omie', sequencias: [1, 2], kgPorSequencia: { 1: 4500, 2: 4500 } });
    const err = await falha(reservar([e], { vinculosVivos: { ...VIVO_304, 2: null } }));
    expect(err.message).toContain('é de outro fornecedor');
  });

  it('origem omie sem o retrato vivo (chamador antigo): a checagem de fornecedor vale', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({ nCodFor: 2222 }));
    const err = await falha(reservar([escolha({ origem: 'omie' })]));
    expect(err.message).toContain('é de outro fornecedor');
  });

  it('se outra escolha da NF aponta o mesmo item de PC por sugestão/manual, a checagem de fornecedor vale', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({ nCodFor: 2222 }));
    const err = await falha(
      reservar([escolha({ origem: 'omie' }), escolha({ indice: 1, sequencias: [2], kgPorSequencia: { 2: 1000 }, qtdNfKg: 1000 })], {
        vinculosVivos: { ...VIVO_304, 2: { nIdPedido: NCODPED_304, nIdItPedido: NCODITEM_304 } },
      }),
    );
    expect(err.message).toContain('é de outro fornecedor');
  });
});

describe('relerEReservarPcs — PC de outro cadastro com a MESMA raiz de CNPJ passa (filial × matriz, NF 60199 × PC 306; T033)', () => {
  const MATRIZ = 2222;
  const CNPJ_FILIAL = '61.827.663/0013-02';
  const CNPJ_MATRIZ = '61827663000179';
  const raizes = (...linhas: Array<[number, string | null]>) =>
    mocks.poolQuery.mockImplementation(async () => {
      estado.eventos.push('RAIZ');
      return { rows: linhas.map(([codigo, cnpj]) => ({ codigo: String(codigo), cnpj })) };
    });
  const pcDaMatriz = () => estado.pedidos.set(NCODPED_304, pedido304({ nCodFor: MATRIZ }));

  it('mesma raiz: a escolha por SUGESTÃO (sem vínculo do OMIE) passa e a reserva é gravada', async () => {
    pcDaMatriz();
    raizes([FORNECEDOR, CNPJ_FILIAL], [MATRIZ, CNPJ_MATRIZ]);
    const r = await reservar([escolha({ origem: 'sugestao' })]);
    expect(r).toHaveLength(1);
    expect(tipos()).toContain('COMMIT');
  });

  it('a consulta da raiz lê o cadastro da própria empresa e leva o fornecedor da NF e o do PC, sem repetidos', async () => {
    pcDaMatriz();
    raizes([FORNECEDOR, CNPJ_FILIAL], [MATRIZ, CNPJ_MATRIZ]);
    await reservar([escolha(), escolha({ indice: 1, sequencias: [2], kgPorSequencia: { 2: 1000 }, qtdNfKg: 1000 })], { empresa: 'acxe' });
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.poolQuery.mock.calls[0]!;
    expect(String(sql)).toContain('public."tbl_cadastroFornecedoresClientes_ACXE"');
    expect(String(sql)).toContain('codigo_cliente_omie = ANY($1::bigint[])');
    expect(params).toEqual([[FORNECEDOR, MATRIZ]]);
  });

  it('raiz diferente: "é de outro fornecedor" (CNPJs de empresas distintas)', async () => {
    pcDaMatriz();
    raizes([FORNECEDOR, CNPJ_FILIAL], [MATRIZ, '99999999000100']);
    const err = await falha(reservar([escolha()]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
    expect(err.message).toContain('é de outro fornecedor');
    expectSemReserva();
  });

  it.each([
    ['cadastro da NF sem CNPJ', [[FORNECEDOR, null], [MATRIZ, CNPJ_MATRIZ]]],
    ['cadastro do PC de pessoa física (CPF)', [[FORNECEDOR, CNPJ_FILIAL], [MATRIZ, '12345678901']]],
    ['cadastro do PC inexistente no OMIE local', [[FORNECEDOR, CNPJ_FILIAL]]],
    ['nenhum cadastro encontrado', []],
  ] as Array<[string, Array<[number, string | null]>]>)('%s: sem raiz comparável, recusa', async (_nome, linhas) => {
    pcDaMatriz();
    raizes(...linhas);
    const err = await falha(reservar([escolha()]));
    expect(err.message).toContain('é de outro fornecedor');
  });

  it('a raiz só é consultada quando o PC está em OUTRO cadastro: PC do próprio fornecedor não faz consulta extra', async () => {
    await reservar([escolha()]);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('sem fornecedor da NF (null) não há checagem nem consulta de raiz', async () => {
    pcDaMatriz();
    await reservar([escolha()], { fornecedorCodigo: null });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('PC com nCodFor 0 (OMIE não informou o fornecedor) não dispara a consulta e, sem vínculo do OMIE, é recusado', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({ nCodFor: 0 }));
    const err = await falha(reservar([escolha()]));
    expect(mocks.poolQuery).not.toHaveBeenCalled();
    expect(err.message).toContain('é de outro fornecedor');
  });

  it('dois PCs em dois outros cadastros: UMA consulta com todos os códigos', async () => {
    estado.pedidos.set(NCODPED_304, pedido304({ nCodFor: MATRIZ }));
    estado.pedidos.set(NCODPED_302, { ...pedido304({ cNumero: '302', nCodFor: 3333 }), nCodPed: NCODPED_302, produtos: [itemPedido({ nCodItem: NCODITEM_302 })] });
    raizes([FORNECEDOR, CNPJ_FILIAL], [MATRIZ, CNPJ_MATRIZ], [3333, '61827663000926']);
    const r = await reservar([
      escolha({ indice: 0 }),
      escolha({ indice: 1, sequencias: [2], kgPorSequencia: { 2: 1000 }, qtdNfKg: 1000, candidato: candidato({ nCodPed: NCODPED_302, nCodItem: NCODITEM_302, pcNumero: '302' }) }),
    ]);
    expect(r).toHaveLength(2);
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    // a ordem dos codigos nao e contrato (vem da ordem de leitura dos PCs): o fornecedor da NF + os dois cadastros
    const [codigos] = mocks.poolQuery.mock.calls[0]![1] as [number[]];
    expect([...codigos].sort((a, b) => a - b)).toEqual([FORNECEDOR, MATRIZ, 3333]);
  });

  it('a consulta da raiz acontece FORA da transação: depois das leituras do OMIE e antes da conexão e do BEGIN', async () => {
    pcDaMatriz();
    raizes([FORNECEDOR, CNPJ_FILIAL], [MATRIZ, CNPJ_MATRIZ]);
    await reservar([escolha()]);
    const ev = estado.eventos;
    expect(ev.indexOf(`OMIE:${NCODPED_304}`)).toBeLessThan(ev.indexOf('RAIZ'));
    expect(ev.indexOf('RAIZ')).toBeLessThan(ev.indexOf('CONNECT'));
    expect(ev.indexOf('CONNECT')).toBeLessThan(ev.indexOf('BEGIN'));
  });

  it('falha ao consultar a raiz: propaga o erro sem abrir conexão nem transação', async () => {
    pcDaMatriz();
    mocks.poolQuery.mockRejectedValue(new Error('connection terminated'));
    const err = await falha(reservar([escolha()]));
    expect(err.message).toBe('connection terminated');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('o vínculo do OMIE ainda vale sem a raiz: origem omie com o vínculo vivo passa mesmo sem cadastros (o OMIE já aceitou)', async () => {
    pcDaMatriz();
    const r = await reservar([escolha({ origem: 'omie' })], { vinculosVivos: { 1: { nIdPedido: NCODPED_304, nIdItPedido: NCODITEM_304 } } });
    expect(r).toHaveLength(1);
  });
});

describe('relerEReservarPcs — PC anterior registrado por LINHA (FR-007; vínculos divergentes)', () => {
  const VINCULO_302 = { nIdPedido: NCODPED_302, nIdItPedido: NCODITEM_302 };
  const VINCULO_304 = { nIdPedido: NCODPED_304, nIdItPedido: NCODITEM_304 };

  it('troca só na linha que estava em outro PC: a linha já no escolhido grava anterior nulo', async () => {
    const e = escolha({
      sequencias: [1, 2], qtdNfKg: 9000, kgPorSequencia: { 1: 4500, 2: 4500 }, justificativa: 'Um PC só para o item', dentroTolerancia: true,
      nCodPedOmieAnterior: NCODPED_302, nCodItemPedOmieAnterior: NCODITEM_302,
      vinculosDivergentes: true, vinculosPorSequencia: { 1: VINCULO_304, 2: VINCULO_302 },
    });
    await reservar([e]);
    const ins = chamadasDe('INSERT');
    expect(ins.map((c) => [c.params[3], c.params[8], c.params[9]])).toEqual([
      [1, null, null],
      [2, NCODPED_302, NCODITEM_302],
    ]);
  });

  it('linha sem vínculo no portão: anterior nulo; sem o retrato por linha (chamador antigo), vale o anterior do item', async () => {
    await reservar([escolha({ sequencias: [1, 2], kgPorSequencia: { 1: 4500, 2: 4500 }, justificativa: 'Troca', vinculosPorSequencia: { 1: VINCULO_302 } })]);
    expect(chamadasDe('INSERT').map((c) => [c.params[3], c.params[8]])).toEqual([
      [1, NCODPED_302],
      [2, null],
    ]);

    estado.chamadas = [];
    await reservar([escolha({ nCodPedOmieAnterior: NCODPED_302, nCodItemPedOmieAnterior: NCODITEM_302, justificativa: 'Troca' })]);
    expect(chamadasDe('INSERT')[0]!.params[8]).toBe(NCODPED_302);
  });
});
