import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Feature 017 (ACXEGDP-437), research D20 — baixa do PC pelo PESO CONFERIDO (STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO).
//
// NF 67988 x PC 305 (23/10/2026): a balanca marcou 13.500 kg e a NF 13.382. O OMIE baixa o PC pela quantidade
// RECEBIDA do item, que por padrao e a da NF: o PC ficou "recebido parcialmente", com 118 kg em aberto, ate o
// fiscal corrigir a quantidade recebida no portal. Com a chave ligada, a reserva (relerEReservarPcs) devolve a
// quantidade recebida = peso conferido, com teto no saldo do PC, e o EDITAR do fiscal a manda em
// itensAjustes.nQtdeRecebida (o EDITAR e provado em recebimento-fiscal-pc.test.ts). Peso a menos ou dentro da
// tolerancia (1 kg) nunca vai. Sem rede e sem banco: o OMIE e o client do pg sao dubles.

const mocks = vi.hoisted(() => ({
  consultarPedidoCompra: vi.fn(),
  connect: vi.fn(),
  poolQuery: vi.fn(),
  config: {} as Record<string, unknown>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getDb: vi.fn(),
  getPool: () => ({ connect: () => mocks.connect(), query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params) }),
  getConfig: () => mocks.config,
}));
vi.mock('@atlas/integration-omie', () => ({
  consultarPedidoCompra: (...args: unknown[]) => mocks.consultarPedidoCompra(...args),
}));
vi.mock('../services/pc-visto.service.js', () => ({
  registrarPcsVistosSeVencido: vi.fn().mockResolvedValue(undefined),
  lerPcsVistos: vi.fn().mockResolvedValue([]),
}));

import {
  __resetColunaKgRecebidoPc,
  baixaPcPesoConferidoHabilitada,
  excessoConferidoKg,
  excessoAplicavelKg,
  limitePesoConferidoPct,
  relerEReservarPcs,
  TOLERANCIA_PESO_CONFERIDO_KG,
  type EscolhaPcValidada,
  type PcCandidato,
} from '../services/pc-sugestao.service.js';

const CHAVE_NF = '35261068176072000128550010000679881752445982';
const FORNECEDOR = 4242424242;
const PED_305 = 8517543975;
const IT_305 = 8517543976;
const IT_305B = 8517543977;

const pedidoOmie = (produtos: Array<{ nCodItem: number; cUnidade: string; nQtde: number; nQtdeRec?: number }>) => ({
  nCodPed: PED_305,
  cNumero: '305',
  cEtapa: '15',
  nCodFor: FORNECEDOR,
  produtos: produtos.map((p) => ({ nQtdeRec: 0, nValUnit: 11.3, ...p })),
});

const candidato305 = (over: Partial<PcCandidato> = {}): PcCandidato => ({
  nCodPed: PED_305,
  nCodItem: IT_305,
  pcNumero: '305',
  produtoDescricao: 'PS CRISTAL B',
  qtdPedidaKg: 13500,
  saldoKg: 13500,
  precoUnit: 11.3,
  precoNfKgComparado: 11.4,
  dtPrevisao: null,
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
});

/** Item da NF 67988: 13.382 kg na NF, 13.500 kg na balanca, numa sequencia, NF em kg. */
function escolha(over: Partial<EscolhaPcValidada> = {}): EscolhaPcValidada {
  const c = over.candidato ?? candidato305();
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
    vinculosDivergentes: false,
    vinculosPorSequencia: {},
    oferecidos: [],
    qtdNfKg: 13382,
    qtdConferidaKg: 13500,
    precoNfKg: 11.4,
    kgPorSequencia: { 1: 13382 },
    itemDescricao: 'PS AI A',
    unidadeNf: 'KG',
    fatorUnidadeNf: 1,
    ...over,
  };
}

type Chamada = { sql: string; params: unknown[] };
let chamadas: Chamada[] = [];
let seqId = 0;
let reservasDeOutrasNfs = 0;
/** sequencias desta NF em que uma tentativa anterior mandou quantidade recebida (kg_recebido_pc) */
let anteriores: number[] = [];
/** a coluna kg_recebido_pc da 0059 existe no banco do dublê */
let coluna0059 = true;
const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const client = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = norm(sql);
    chamadas.push({ sql: s, params });
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK' || s.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (s.startsWith('UPDATE stockbridge.recebimento_fiscal_pc')) return { rows: [], rowCount: 0 };
    if (s.includes('AS segundos')) return { rows: [] };
    if (s.includes('SUM(COALESCE(kg_recebido_pc, qtd_nf_kg))') || s.includes('SUM(qtd_nf_kg)')) return { rows: [{ kg: reservasDeOutrasNfs }] };
    if (s.startsWith('SELECT DISTINCT n_sequencia FROM stockbridge.recebimento_fiscal_pc')) return { rows: anteriores.map((n_sequencia) => ({ n_sequencia })) };
    if (s.startsWith('INSERT INTO stockbridge.recebimento_fiscal_pc')) return { rows: [{ id: `reserva-${++seqId}` }] };
    throw new Error(`SQL inesperado no dublê do client: ${s.slice(0, 120)}`);
  }),
  release: vi.fn(),
};
const inserts = (): Chamada[] => chamadas.filter((c) => c.sql.startsWith('INSERT INTO stockbridge.recebimento_fiscal_pc'));
/** $20 do INSERT: kg_recebido_pc. $14: qtd_nf_kg. */
const kgRecebidoGravado = (): unknown[] => inserts().map((c) => c.params[19]);

const ARGS = { empresa: 'q2p' as const, ledgerId: 'ledger-1', nfChaveAcesso: CHAVE_NF, notaFiscal: '67988', fornecedorCodigo: FORNECEDOR, userId: 'user-1' };
const reservar = (escolhas: EscolhaPcValidada[]) => relerEReservarPcs({ ...ARGS, escolhas });
const ligar = () => {
  mocks.config.STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO = true;
};

beforeEach(() => {
  for (const k of Object.keys(mocks.config)) delete mocks.config[k];
  chamadas = [];
  seqId = 0;
  reservasDeOutrasNfs = 0;
  anteriores = [];
  coluna0059 = true;
  __resetColunaKgRecebidoPc();
  client.query.mockClear();
  client.release.mockClear();
  mocks.logger.info.mockClear();
  mocks.connect.mockReset();
  mocks.connect.mockResolvedValue(client);
  mocks.poolQuery.mockReset();
  mocks.poolQuery.mockImplementation(async (sql: string) => (String(sql).includes('information_schema') ? { rows: [{ ok: coluna0059 }] } : { rows: [] }));
  mocks.consultarPedidoCompra.mockReset();
  mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie([{ nCodItem: IT_305, cUnidade: 'KG', nQtde: 13500 }]));
});

// ═══ A. Configuracao e regra do excedente ════════════════════════════════════

describe('STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO e excessoConferidoKg', () => {
  it('a chave e desligada por padrao; so o booleano true (config ja convertida) liga', () => {
    expect(baixaPcPesoConferidoHabilitada()).toBe(false);
    mocks.config.STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO = 'true';
    expect(baixaPcPesoConferidoHabilitada()).toBe(false);
    ligar();
    expect(baixaPcPesoConferidoHabilitada()).toBe(true);
  });

  it('excedente = peso conferido - NF, so acima da tolerancia de 1 kg', () => {
    expect(excessoConferidoKg({ qtdNfKg: 13382, qtdConferidaKg: 13500, fatorUnidadeNf: 1 })).toBe(118);
    expect(excessoConferidoKg({ qtdNfKg: 13382, qtdConferidaKg: 13383, fatorUnidadeNf: 1 })).toBe(0);
    expect(excessoConferidoKg({ qtdNfKg: 13382, qtdConferidaKg: 13383.5, fatorUnidadeNf: 1 })).toBe(1.5);
  });

  it('peso a menos, peso igual, sem peso conferido ou sem unidade da NF: 0', () => {
    expect(excessoConferidoKg({ qtdNfKg: 13382, qtdConferidaKg: 13000, fatorUnidadeNf: 1 })).toBe(0);
    expect(excessoConferidoKg({ qtdNfKg: 13382, qtdConferidaKg: 13382, fatorUnidadeNf: 1 })).toBe(0);
    expect(excessoConferidoKg({ qtdNfKg: 13382, fatorUnidadeNf: 1 })).toBe(0);
    expect(excessoConferidoKg({ qtdNfKg: 13382, qtdConferidaKg: 13500, fatorUnidadeNf: null })).toBe(0);
  });

  it('a tolerancia e a mesma da divergencia do recebimento nacional (TOLERANCIA_DIVERGENCIA_KG)', () => {
    const fonte = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'services', 'recebimento-nacional.service.ts'), 'utf8');
    const m = /export const TOLERANCIA_DIVERGENCIA_KG = ([\d.]+);/.exec(fonte);
    expect(m).not.toBeNull();
    expect(TOLERANCIA_PESO_CONFERIDO_KG).toBe(Number(m![1]));
  });
});

// ═══ B. Reserva: quantidade recebida pelo peso conferido ═════════════════════

describe('relerEReservarPcs — peso conferido acima da NF', () => {
  it('chave DESLIGADA (padrao): nada muda — sem quantidade recebida explicita, kg_recebido_pc nulo', async () => {
    const r = await reservar([escolha()]);
    expect(r[0]).toMatchObject({ nQtdeRecebida: null, kgRecebidoPc: null });
    expect(inserts()[0]!.params[13]).toBe('13382.000');
    expect(kgRecebidoGravado()).toEqual([null]);
  });

  it('chave ligada, NF 67988 x PC 305: a quantidade recebida e o peso conferido (13.500 kg) e vai para o ledger', async () => {
    ligar();
    const r = await reservar([escolha()]);
    expect(r[0]).toMatchObject({ nSequencia: 1, nQtdeRecebida: 13500, kgRecebidoPc: 13500 });
    // qtd_nf_kg continua a da NF; kg_recebido_pc e o que foi baixado no PC
    expect(inserts()[0]!.params[13]).toBe('13382.000');
    expect(kgRecebidoGravado()).toEqual(['13500.000']);
    expect(inserts()[0]!.sql).toContain('confirmado_por, kg_recebido_pc)');
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ excessoPedidoKg: 118, excessoAplicadoKg: 118 }),
      'Peso conferido acima da NF vai como quantidade recebida no PC',
    );
  });

  it('teto no saldo do PC: com 13.450 kg de saldo, a quantidade recebida para em 13.450 (e o log diz que limitou)', async () => {
    ligar();
    mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie([{ nCodItem: IT_305, cUnidade: 'KG', nQtde: 13450 }]));
    const r = await reservar([escolha()]);
    expect(r[0]).toMatchObject({ nQtdeRecebida: 13450, kgRecebidoPc: 13450 });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ excessoPedidoKg: 118, excessoAplicadoKg: 68 }),
      'Peso conferido acima da NF limitado ao saldo do PC',
    );
  });

  it('o teto desconta as reservas de OUTRAS NFs, contadas pelo que cada uma baixa do PC', async () => {
    ligar();
    reservasDeOutrasNfs = 50; // PC de 13.500 kg com 50 kg reservados por outra NF: sobram 13.450
    const r = await reservar([escolha()]);
    expect(r[0]).toMatchObject({ nQtdeRecebida: 13450 });
    const consulta = chamadas.find((c) => c.sql.includes('SUM(COALESCE(kg_recebido_pc, qtd_nf_kg))'))!;
    expect(consulta.sql).toContain("status IN ('confirmado', 'associado')");
  });

  it('NF que ja passa do saldo (dentro da tolerancia): nenhum excedente — a NF baixa o que baixaria hoje', async () => {
    ligar();
    mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie([{ nCodItem: IT_305, cUnidade: 'KG', nQtde: 13300 }]));
    const r = await reservar([escolha()]);
    expect(r[0]).toMatchObject({ nQtdeRecebida: null, kgRecebidoPc: null });
    expect(kgRecebidoGravado()).toEqual([null]);
  });

  it('dentro da tolerancia (1 kg) ou peso a menos: sem quantidade recebida explicita', async () => {
    ligar();
    mocks.consultarPedidoCompra.mockResolvedValue(
      pedidoOmie([
        { nCodItem: IT_305, cUnidade: 'KG', nQtde: 13500 },
        { nCodItem: IT_305B, cUnidade: 'KG', nQtde: 13500 },
      ]),
    );
    await reservar([escolha({ qtdConferidaKg: 13383 }), escolha({ indice: 1, sequencias: [2], kgPorSequencia: { 2: 13382 }, candidato: candidato305({ nCodItem: IT_305B }), qtdConferidaKg: 13000 })]);
    expect(kgRecebidoGravado()).toEqual([null, null]);
  });

  it('item em duas sequencias: o excedente se divide pelo kg da NF de cada uma e a soma fecha no peso conferido', async () => {
    ligar();
    const r = await reservar([escolha({ sequencias: [1, 2], kgPorSequencia: { 1: 10000, 2: 3382 } })]);
    const [s1, s2] = r;
    // 4 casas, como o OMIE guarda, e para BAIXO (a soma nunca passa do teto):
    // 10.000 + 118 x 10.000 / 13.382 = 10.088,17814975... -> 10.088,1781; 3.411,82185025 -> 3.411,8218
    expect(s1!.nQtdeRecebida).toBe(10088.1781);
    expect(s2!.nQtdeRecebida).toBe(3411.8218);
    expect(s1!.nQtdeRecebida! + s2!.nQtdeRecebida!).toBeLessThanOrEqual(13500);
    expect(s1!.nQtdeRecebida! + s2!.nQtdeRecebida!).toBeCloseTo(13500, 3);
    for (const x of [s1!, s2!]) expect(Number.isInteger(Math.round(x.nQtdeRecebida! * 1e4))).toBe(true);
  });

  it('dois itens da NF no MESMO item do PC, com teto: o excedente aplicado se divide pelo excedente de cada item', async () => {
    ligar();
    // PC com 10.200 kg; NF: A 6.000 (+100 na balanca) e B 4.000 (+300) -> folga de 200 kg: A leva 50, B leva 150
    mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie([{ nCodItem: IT_305, cUnidade: 'KG', nQtde: 10200 }]));
    const r = await reservar([
      escolha({ indice: 0, sequencias: [1], qtdNfKg: 6000, qtdConferidaKg: 6100, kgPorSequencia: { 1: 6000 } }),
      escolha({ indice: 1, sequencias: [2], qtdNfKg: 4000, qtdConferidaKg: 4300, kgPorSequencia: { 2: 4000 } }),
    ]);
    expect(r.map((x) => x.nQtdeRecebida)).toEqual([6050, 4150]);
    expect(kgRecebidoGravado()).toEqual(['6050.000', '4150.000']);
  });

  it('PC e NF em toneladas: a quantidade recebida vai na unidade do PC (13,5 t), o ledger em kg', async () => {
    ligar();
    mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie([{ nCodItem: IT_305, cUnidade: 'TON', nQtde: 13.5 }]));
    const r = await reservar([escolha({ unidadeNf: 'TON', fatorUnidadeNf: 1000, candidato: candidato305({ unidade: 'TON' }) })]);
    expect(r[0]).toMatchObject({ nQtdeRecebida: 13.5, kgRecebidoPc: 13500 });
  });

  it("modo 'converter' (NF em toneladas, PC em kg): sem a chave vai a NF convertida; com ela, o peso conferido", async () => {
    mocks.config.STOCKBRIDGE_PC_UNIDADE_DIFERENTE = 'converter';
    mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie([{ nCodItem: IT_305, cUnidade: 'KG', nQtde: 8400 }]));
    const e = escolha({ qtdNfKg: 8250, qtdConferidaKg: 8300, kgPorSequencia: { 1: 8250 }, unidadeNf: 'TON', fatorUnidadeNf: 1000 });
    const sem = await reservar([e]);
    expect(sem[0]).toMatchObject({ nQtdeRecebida: 8250, kgRecebidoPc: 8250 });
    ligar();
    const com = await reservar([e]);
    expect(com[0]).toMatchObject({ nQtdeRecebida: 8300, kgRecebidoPc: 8300 });
  });

  it('a validacao do saldo continua pela NF: o peso conferido nunca faz a NF ser recusada', async () => {
    ligar();
    // PC com 13.382 kg exatos: a NF cabe; a balanca marcou 14.000 — sem folga, nada a mais e nenhuma recusa
    mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie([{ nCodItem: IT_305, cUnidade: 'KG', nQtde: 13382 }]));
    const r = await reservar([escolha({ qtdConferidaKg: 14000 })]);
    expect(r[0]).toMatchObject({ nQtdeRecebida: null });
  });
});

// ═══ C. Revisao de 23/10/2026 (achados 1, 3, 4 e 7) ═════════════════════════

describe('relerEReservarPcs — limite relativo do excedente (STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT)', () => {
  it('default 10%; a configuracao muda; valor invalido volta ao default', () => {
    expect(limitePesoConferidoPct()).toBe(10);
    mocks.config.STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT = 15;
    expect(limitePesoConferidoPct()).toBe(15);
    mocks.config.STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT = 0;
    expect(limitePesoConferidoPct()).toBe(10);
  });

  it('excessoAplicavelKg: ate o limite vai inteiro; acima dele, nada (provavel erro de digitacao)', () => {
    const base = { qtdNfKg: 10000, fatorUnidadeNf: 1 };
    expect(excessoAplicavelKg({ ...base, qtdConferidaKg: 11000 }, 10)).toBe(1000);
    expect(excessoAplicavelKg({ ...base, qtdConferidaKg: 11001 }, 10)).toBe(0);
    expect(excessoAplicavelKg({ ...base, qtdConferidaKg: 100000 }, 10)).toBe(0);
  });

  it('13.382 digitado 15.000 (12% acima): o PC segue pela NF e o log avisa — mesmo com saldo sobrando', async () => {
    ligar();
    mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie([{ nCodItem: IT_305, cUnidade: 'KG', nQtde: 20000 }]));
    const r = await reservar([escolha({ qtdConferidaKg: 15000 })]);
    expect(r[0]).toMatchObject({ nQtdeRecebida: null, kgRecebidoPc: null });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ nfKg: 13382, conferidoKg: 15000, limitePct: 10 }),
      expect.stringContaining('acima do limite relativo'),
    );
  });

  it('com o limite em 15%, o mesmo peso vai, ainda limitado ao saldo do PC', async () => {
    ligar();
    mocks.config.STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT = 15;
    mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie([{ nCodItem: IT_305, cUnidade: 'KG', nQtde: 14000 }]));
    const r = await reservar([escolha({ qtdConferidaKg: 15000 })]);
    expect(r[0]).toMatchObject({ nQtdeRecebida: 14000, kgRecebidoPc: 14000 });
  });
});

describe('relerEReservarPcs — retomada: desfaz a quantidade que uma tentativa anterior mandou (achado 1)', () => {
  it('tentativa anterior mandou 13.500 e agora a chave esta desligada: manda a da NF (13.382) de volta', async () => {
    anteriores = [1];
    const r = await reservar([escolha()]);
    expect(r[0]).toMatchObject({ nQtdeRecebida: 13382, kgRecebidoPc: 13382 });
    const consulta = chamadas.find((c) => c.sql.startsWith('SELECT DISTINCT n_sequencia FROM stockbridge.recebimento_fiscal_pc'))!;
    expect(consulta.sql).toContain('kg_recebido_pc IS NOT NULL');
    expect(consulta.params).toEqual([CHAVE_NF, 'q2p']);
  });

  it('peso corrigido para dentro da tolerancia: tambem volta a NF; sequencia sem tentativa anterior segue sem quantidade', async () => {
    ligar();
    anteriores = [1];
    const r = await reservar([escolha({ sequencias: [1, 2], kgPorSequencia: { 1: 10000, 2: 3382 }, qtdConferidaKg: 13382.5 })]);
    expect(r.map((x) => x.nQtdeRecebida)).toEqual([10000, null]);
  });

  it('com peso a mais de novo, vale o peso conferido (a retomada nao atrapalha)', async () => {
    ligar();
    anteriores = [1];
    const r = await reservar([escolha()]);
    expect(r[0]).toMatchObject({ nQtdeRecebida: 13500 });
  });
});

describe('relerEReservarPcs — sem a migration 0059 (imagem antes da migration, achado 7)', () => {
  it('chave ligada e peso a mais: nada vai ao PC, a soma das reservas usa a NF e o INSERT nao leva a coluna', async () => {
    ligar();
    coluna0059 = false;
    const r = await reservar([escolha()]);
    expect(r[0]).toMatchObject({ nQtdeRecebida: null, kgRecebidoPc: null });
    const sqls = chamadas.map((c) => c.sql);
    expect(sqls.some((x) => x.includes('SUM(qtd_nf_kg)'))).toBe(true);
    expect(sqls.some((x) => x.includes('kg_recebido_pc'))).toBe(false);
    expect(inserts()[0]!.params).toHaveLength(19);
  });
});

describe('relerEReservarPcs — arredondamento e kg do que foi mandado (achado 4)', () => {
  it('PC em toneladas: 13.500,75 kg na balanca vira 13,5007 t (para baixo) e o ledger guarda 13.500,7 kg — o que o OMIE recebe', async () => {
    ligar();
    mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie([{ nCodItem: IT_305, cUnidade: 'TON', nQtde: 14 }]));
    const r = await reservar([escolha({ unidadeNf: 'TON', fatorUnidadeNf: 1000, qtdConferidaKg: 13500.75, candidato: candidato305({ unidade: 'TON' }) })]);
    expect(r[0]).toMatchObject({ nQtdeRecebida: 13.5007, kgRecebidoPc: 13500.7 });
    expect(kgRecebidoGravado()).toEqual(['13500.700']);
  });

  it("modo 'converter' com sequencia sem kg: manda 0 como antes, mas o ledger fica nulo (CHECK > 0 da 0059)", async () => {
    mocks.config.STOCKBRIDGE_PC_UNIDADE_DIFERENTE = 'converter';
    mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie([{ nCodItem: IT_305, cUnidade: 'KG', nQtde: 9000 }]));
    const r = await reservar([escolha({ sequencias: [1, 7], qtdNfKg: 8250, qtdConferidaKg: 8250, kgPorSequencia: { 1: 8250 }, unidadeNf: 'TON', fatorUnidadeNf: 1000 })]);
    expect(r.map((x) => x.nQtdeRecebida)).toEqual([8250, 0]);
    expect(kgRecebidoGravado()).toEqual(['8250.000', null]);
  });

  it('o retorno leva o kg da NF da sequencia e o fator do PC (o ja_concluido confere a quantidade viva com eles)', async () => {
    ligar();
    const r = await reservar([escolha()]);
    expect(r[0]).toMatchObject({ kgNfSeq: 13382, fatorPc: 1 });
  });
});
