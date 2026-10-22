import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017 (ACXEGDP-437), T015 — leitores da cópia de PCs passam a usar o SALDO.
//
// A cópia public."tbl_pedidosCompras_ACXE" (n8n Rev 1.5) agora mantém PC recebido em
// parte, com `nqtderec` preenchido. O cockpit (Parte A de fiscal_pend_importacao) e as
// Pendências Fiscais (qtde do pedido) liam `pc.nqtde` e contariam o já recebido como
// pendente. Research D10: saldo = nqtde - COALESCE(nqtderec, 0), e o filtro `nqtde > 0`
// vira `saldo > 0`. A função PL/pgSQL refresh_lotes_em_transito_se_stale (0037) fica
// fora de propósito (decisão de 21/10/2026) e não é coberta aqui.
//
// Pool mockado, como em fila-nacional.test.ts, em duas camadas:
//  1. inspeção do SQL gerado pelos dois serviços;
//  2. valor devolvido — o dublê do pool não executa SQL, mas AVALIA sobre o fixture de
//     PCs a expressão de quantidade e o filtro que o serviço escreveu na query, com a
//     semântica de NULL do Postgres. Se alguém voltar para `pc.nqtde`, o PC de 18.000 kg
//     recebido em 9.000 passa a entrar com 18.000 e o teste falha.

const poolQuerySpy = vi.fn();

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  getConfig: () => ({ STOCKBRIDGE_FISCAL_CUTOFF_DATE: '2026-01-01' }),
}));

import { getCockpit } from '../services/cockpit.service.js';
import { getPendenciasFiscais } from '../services/pendencias-fiscais.service.js';

// ── Fixture: cópia de PCs da ACXE (cada pedido tem mapa NF mãe/filhote ativo, sem filhote recebida)

interface PcFixture {
  cnumero: string;
  ncodprod: number;
  nqtde: number;
  nqtderec: number | null;
}

const PC_PARCIAL: PcFixture = { cnumero: '111', ncodprod: 2001, nqtde: 18_000, nqtderec: 9_000 }; // saldo 9.000
const PC_REC_NULO: PcFixture = { cnumero: '222', ncodprod: 2002, nqtde: 25_000, nqtderec: null }; // NULL conta 0: saldo 25.000
const PC_QUITADO: PcFixture = { cnumero: '333', ncodprod: 2003, nqtde: 10_000, nqtderec: 10_000 }; // sem saldo: fica de fora
const PCS: PcFixture[] = [PC_PARCIAL, PC_REC_NULO, PC_QUITADO];

// ── Mini avaliador de SQL: só o que as duas queries escrevem sobre a cópia de PCs
// (pc.nqtde, pc.nqtderec, números, COALESCE(a, b), +, -, parênteses e `> n`).
// Aritmética com NULL dá NULL; comparação com NULL não é verdadeira. Qualquer outro
// símbolo lança: o teste avisa que o dublê precisa aprender a expressão nova.

type Escalar = number | boolean | null;

function avaliarSql(trecho: string, pc: PcFixture): Escalar {
  const tokens = trecho.match(/[A-Za-z_][\w.]*|\d+(?:\.\d+)?|[(),+\->]/g) ?? [];
  let i = 0;

  const lerToken = (esperado?: string): string => {
    const t = tokens[i++];
    if (t === undefined || (esperado !== undefined && t !== esperado)) {
      throw new Error(`SQL fora do que o dublê entende (esperava "${esperado ?? 'um token'}" na posição ${i}): ${trecho}`);
    }
    return t;
  };

  const primario = (): number | null => {
    const t = lerToken();
    if (t === '(') {
      const v = soma();
      lerToken(')');
      return v;
    }
    if (t.toUpperCase() === 'COALESCE') {
      lerToken('(');
      const a = soma();
      lerToken(',');
      const b = soma();
      lerToken(')');
      return a ?? b;
    }
    if (t === 'pc.nqtde') return pc.nqtde;
    if (t === 'pc.nqtderec') return pc.nqtderec;
    if (/^\d/.test(t)) return Number(t);
    throw new Error(`símbolo desconhecido no SQL: ${t} (em ${trecho})`);
  };

  const soma = (): number | null => {
    let acc = primario();
    while (tokens[i] === '+' || tokens[i] === '-') {
      const op = lerToken();
      const direita = primario();
      acc = acc === null || direita === null ? null : op === '+' ? acc + direita : acc - direita;
    }
    return acc;
  };

  const esquerda = soma();
  let resultado: Escalar = esquerda;
  if (tokens[i] === '>') {
    lerToken('>');
    const direita = soma();
    resultado = esquerda !== null && direita !== null && esquerda > direita;
  }
  if (i !== tokens.length) throw new Error(`sobrou SQL sem avaliar a partir da posição ${i}: ${trecho}`);
  return resultado;
}

/** Expressão somada pelo serviço: o que está dentro de SUM(...)::numeric AS qtde_pedido. */
function expressaoDaQuantidade(sql: string): string {
  const m = sql.match(/SUM\(([^\n]*?)\)::numeric AS qtde_pedido/);
  if (!m) throw new Error('SUM(...)::numeric AS qtde_pedido não encontrado no SQL do serviço');
  return m[1]!;
}

/** Filtro aplicado à cópia de PCs: o `AND <...> > 0` sobre pc.nqtde. */
function filtroDeSaldo(sql: string): string {
  const m = sql.match(/AND (\(?pc\.nqtde[^\n]*?> 0)/);
  if (!m) throw new Error('filtro de saldo do PC (... > 0) não encontrado no SQL do serviço');
  return m[1]!;
}

/** SUM(expressão) dos PCs que passam no filtro: ignora NULL e dá NULL quando não sobra linha. */
function somaDaQuantidade(sql: string, pcs: PcFixture[]): number | null {
  const expressao = expressaoDaQuantidade(sql);
  const filtro = filtroDeSaldo(sql);
  const valores = pcs
    .filter((pc) => avaliarSql(filtro, pc) === true)
    .map((pc) => avaliarSql(expressao, pc) as number | null)
    .filter((v): v is number => v !== null);
  return valores.length > 0 ? valores.reduce((s, v) => s + v, 0) : null;
}

// ── Dublê do pool

/** O serviço engole exceção do pool e devolve vazio; o dublê registra aqui para o teste conferir. */
const falhasDoDuble: string[] = [];

function linhaDoSku(codigo: number, pendenteImportacaoKg: number): Record<string, unknown> {
  return {
    produto_codigo_acxe: codigo,
    nome: `Produto ${codigo}`,
    familia: 'PS',
    ncm: null,
    fisica_kg: 0,
    aguardando_embarque_kg: 0,
    transito_intl_kg: 0,
    no_porto_kg: 0,
    transito_local_kg: 0,
    transito_interno_kg: 0,
    provisorio_kg: 0,
    comodato_kg: 0,
    pendente_nacional_kg: 0,
    pendente_importacao_kg: pendenteImportacaoKg,
    consumo_medio_diario_kg: null,
    lead_time_dias: null,
    divs: 0,
    aprs: 0,
  };
}

/** Linhas do cockpit: um SKU por produto com pendência de importação (PC sem saldo não gera linha). */
function linhasDoCockpit(sql: string): Record<string, unknown>[] {
  const pendentePorProduto = new Map<number, number>();
  for (const pc of PCS) {
    const saldoDoPedido = somaDaQuantidade(sql, [pc]);
    if (saldoDoPedido === null) continue;
    // Parte A: GREATEST(qtde do pedido - filhotes recebidas, 0); nenhuma filhote recebida no fixture.
    pendentePorProduto.set(pc.ncodprod, (pendentePorProduto.get(pc.ncodprod) ?? 0) + Math.max(saldoDoPedido, 0));
  }
  return [...pendentePorProduto].map(([codigo, kg]) => linhaDoSku(codigo, kg));
}

/** Cabeçalhos de pedido das Pendências Fiscais: um por mapa ativo, com a qtde que o SQL calcularia. */
function pedidosDePendencias(sql: string): Record<string, unknown>[] {
  return PCS.map((pc) => ({
    mapa_id: `mapa-${pc.cnumero}`,
    pedido_acxe_omie: pc.cnumero,
    nf_mae: `5${pc.cnumero}`,
    mae_emissao: '2026-09-01',
    dias_exoneracao: 10,
    qtde_pedido_kg: somaDaQuantidade(sql, PCS.filter((p) => p.cnumero === pc.cnumero)),
    estagio_fup: null,
    lote_em_transito: false,
  }));
}

function instalarDuble(): void {
  poolQuerySpy.mockImplementation(async (sql: string) => {
    try {
      if (sql.includes('information_schema')) return { rows: [{ ok: true }] };
      if (sql.includes('fiscal_pend_importacao')) return { rows: linhasDoCockpit(sql) };
      if (sql.includes('dias_exoneracao')) return { rows: pedidosDePendencias(sql) };
      return { rows: [] }; // filhotes e importações sem mapa: nada a devolver neste fixture
    } catch (err) {
      falhasDoDuble.push((err as Error).message);
      return { rows: [] };
    }
  });
}

beforeEach(() => {
  poolQuerySpy.mockReset();
  falhasDoDuble.length = 0;
  instalarDuble();
});

/** SQL da query principal do cockpit (a que contém a CTE fiscal_pend_importacao). */
async function sqlDoCockpit(): Promise<string> {
  await getCockpit();
  const call = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('fiscal_pend_importacao'));
  if (!call) throw new Error('query do cockpit não executada');
  return String(call[0]);
}

/** SQL do cabeçalho de pedidos das Pendências Fiscais (a que lê o PC na LATERAL `ped`). */
async function sqlDosPedidosDePendencias(): Promise<string> {
  await getPendenciasFiscais();
  const call = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('dias_exoneracao'));
  if (!call) throw new Error('query de pedidos das pendências fiscais não executada');
  return String(call[0]);
}

const LEITORES: Array<{ nome: string; obterSql: () => Promise<string> }> = [
  { nome: 'cockpit (Parte A de fiscal_pend_importacao)', obterSql: sqlDoCockpit },
  { nome: 'pendências fiscais (qtde do pedido)', obterSql: sqlDosPedidosDePendencias },
];

// ── Camada 1: SQL gerado

describe('SQL dos leitores da cópia de PCs — saldo em vez de quantidade cheia (T015, research D10)', () => {
  it.each(LEITORES)('$nome: soma o saldo e filtra por saldo > 0', async ({ obterSql }) => {
    const sql = await obterSql();
    expect(sql).toContain('SUM(pc.nqtde - COALESCE(pc.nqtderec, 0))::numeric AS qtde_pedido');
    expect(sql).toContain('(pc.nqtde - COALESCE(pc.nqtderec, 0)) > 0');
    expect(sql).not.toMatch(/SUM\(pc\.nqtde\)/);
    expect(sql).not.toMatch(/pc\.nqtde\s*>\s*0/);
  });

  it.each(LEITORES)('$nome: nenhum uso de pc.nqtde fora da expressão do saldo', async ({ obterSql }) => {
    const sql = await obterSql();
    const usosDeNqtde = sql.match(/pc\.nqtde\b/g) ?? []; // \b: pc.nqtderec não entra na conta
    const usosDoSaldo = sql.match(/pc\.nqtde - COALESCE\(pc\.nqtderec, 0\)/g) ?? [];
    expect(usosDeNqtde.length).toBeGreaterThan(0);
    expect(usosDeNqtde.length).toBe(usosDoSaldo.length);
  });

  it.each(LEITORES)('$nome: continua lendo a cópia de PCs da ACXE', async ({ obterSql }) => {
    expect(await obterSql()).toContain('public."tbl_pedidosCompras_ACXE" pc');
  });
});

// ── Camada 2: valor devolvido pelas funções

describe('valor devolvido — PC recebido em parte entra com o saldo (T015)', () => {
  it('pendências fiscais: qtdePedidoKg = saldo (9.000), não a quantidade cheia (18.000)', async () => {
    const data = await getPendenciasFiscais();

    expect(falhasDoDuble).toEqual([]);
    const porPedido = new Map(data.pedidos.map((p) => [p.pedidoAcxeOmie, p]));
    expect(porPedido.get('111')).toMatchObject({
      qtdePedidoKg: 9_000,
      recebidoKg: 0,
      saldoPendenteKg: 9_000,
      statusAgregado: 'pendente',
    });
    // nqtderec NULL conta como 0: a quantidade cheia é o saldo
    expect(porPedido.get('222')).toMatchObject({ qtdePedidoKg: 25_000, saldoPendenteKg: 25_000 });
    // PC recebido por inteiro não tem saldo: sai do SUM, o pedido não deixa pendência
    expect(porPedido.get('333')).toMatchObject({ qtdePedidoKg: 0, saldoPendenteKg: 0, statusAgregado: 'recebida' });
    expect(data.resumo.totalSaldoPendenteKg).toBe(34_000);
  });

  it('cockpit: fiscalPendenteImportacaoKg do SKU = saldo do PC (9.000, não 18.000)', async () => {
    const data = await getCockpit();

    expect(falhasDoDuble).toEqual([]);
    const porCodigo = new Map(data.skus.map((s) => [s.codigoAcxe, s]));
    expect(porCodigo.get(2001)?.fiscalPendenteImportacaoKg).toBe(9_000);
    expect(porCodigo.get(2001)?.fiscalKg).toBe(9_000); // fisicaKg 0 + pendências
    expect(porCodigo.get(2002)?.fiscalPendenteImportacaoKg).toBe(25_000); // nqtderec NULL conta 0
    expect(porCodigo.has(2003)).toBe(false); // PC recebido por inteiro não vira pendência
    expect(data.resumo.totalFiscalPendenteImportacaoKg).toBe(34_000);
  });
});

// ── O dublê precisa enxergar a diferença: sem isto, os testes acima poderiam passar vazios.

describe('dublê do pool — sensibilidade ao SQL', () => {
  it('SQL antigo (quantidade cheia) devolveria 18.000 e contaria o PC já recebido por inteiro', () => {
    const antigo = [
      'SELECT SUM(pc.nqtde)::numeric AS qtde_pedido',
      'FROM public."tbl_pedidosCompras_ACXE" pc',
      'WHERE pc.cnumero = mapa.pedido_acxe_omie AND pc.nqtde > 0',
      '',
    ].join('\n');

    expect(somaDaQuantidade(antigo, [PC_PARCIAL])).toBe(18_000);
    expect(somaDaQuantidade(antigo, [PC_QUITADO])).toBe(10_000);
  });

  it('saldo sem COALESCE derrubaria a linha de nqtderec NULL (NULL na conta dá NULL)', () => {
    const semCoalesce = [
      'SELECT SUM(pc.nqtde - pc.nqtderec)::numeric AS qtde_pedido',
      'FROM public."tbl_pedidosCompras_ACXE" pc',
      'WHERE pc.cnumero = mapa.pedido_acxe_omie AND (pc.nqtde - pc.nqtderec) > 0',
      '',
    ].join('\n');

    expect(somaDaQuantidade(semCoalesce, [PC_REC_NULO])).toBeNull();
  });
});
