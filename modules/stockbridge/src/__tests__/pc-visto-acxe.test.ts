import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437), migration 0058 — o cache de PCs vistos guarda tambem o PRODUTO
// (`n_cod_prod`) e o LOCAL (`codigo_local_estoque`) do item do PC: a NF da ACXE pre-seleciona o estoque de entrada e
// o produto pelo PC mesmo quando o OMIE o tira da lista de pendentes (o caso do PC 306 em 22/10/2026).
//
// Aqui, com o pool mockado: o INSERT/UPSERT com as duas colunas novas (lista de colunas alinhada com o SELECT,
// DO UPDATE e as duas tuplas do IS DISTINCT FROM), a leitura que as devolve, a regra do PC-espelho so na Q2P e a
// fiacao com o contexto de PC (cache real, copia vazia). O SQL em Postgres real (o regex do local numerico, o
// upsert so do que mudou) esta em auditoria-pedido-compra-visto.test.ts e fila-nacional-acxe-db.test.ts (opt-in).
// pc-visto.test.ts cobre o resto do modulo.

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  config: {} as Record<string, unknown>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params) }),
  getConfig: () => mocks.config,
}));
vi.mock('@atlas/integration-omie', () => ({ consultarPedidoCompra: vi.fn() }));

import { registrarPcsVistos, lerPcsVistos, __resetRegistroPcsVistos } from '../services/pc-visto.service.js';
import { carregarContextoPc } from '../services/pc-sugestao.service.js';

const AGORA = Date.UTC(2026, 9, 23, 15, 0, 0);
const CNPJ_ACXE = '42672052000154';
const norm = (sql: unknown): string => String(sql).replace(/\s+/g, ' ').trim();
const sqlDoUpsert = (): string => norm(mocks.poolQuery.mock.calls[0]![0]);

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolQuery.mockResolvedValue({ rows: [{ n: '0' }] });
  for (const f of Object.values(mocks.logger)) f.mockClear();
  __resetRegistroPcsVistos();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
});
afterEach(() => {
  vi.useRealTimers();
});

// ═══ registrarPcsVistos — as colunas novas ═══════════════════════════════════

describe('registrarPcsVistos — produto e local do item do PC (0058)', () => {
  it('a copia fornece o produto (ncodprod) e o local (codigo_local_estoque, varchar): o local so vira numero se for numerico de ate 18 digitos', async () => {
    await registrarPcsVistos('acxe');
    const s = sqlDoUpsert();
    expect(s).toContain('pc.ncodprod::bigint AS n_cod_prod');
    expect(s).toContain("CASE WHEN btrim(COALESCE(pc.codigo_local_estoque, '')) ~ '^[0-9]{1,18}$' THEN btrim(pc.codigo_local_estoque)::bigint END AS codigo_local_estoque");
    // sem regex o ::bigint de um local nao numerico (ou nulo ou com texto) abortaria o upsert inteiro
    expect(s.indexOf("~ '^[0-9]{1,18}$'")).toBeLessThan(s.indexOf('::bigint END AS codigo_local_estoque'));
  });

  it('a lista de colunas do INSERT esta ALINHADA com o SELECT (uma coluna fora de posicao gravaria o dado no campo errado)', async () => {
    await registrarPcsVistos('q2p');
    const s = sqlDoUpsert();
    const colunas = /INSERT INTO stockbridge\.pedido_compra_visto \(([^)]*)\)/.exec(s)![1]!.split(',').map((c) => c.trim());
    const selecao = /\) SELECT (\$1, c\.ncodped[^]*?) FROM copia c ON CONFLICT/.exec(s)![1]!.split(',').map((c) => c.trim());
    expect(colunas).toEqual([
      'empresa', 'n_cod_ped', 'n_cod_item', 'pc_numero', 'n_cod_for', 'produto_descricao', 'unidade', 'qtde', 'qtde_rec', 'preco_unit',
      'etapa', 'dt_previsao', 'valor_total_pc', 'n_cod_prod', 'codigo_local_estoque', 'visto_em',
    ]);
    expect(selecao).toHaveLength(colunas.length);
    // $1 = empresa, now() = visto_em; as demais sao c.<coluna da CTE> (a CTE usa os nomes da copia para tres delas)
    const nomeNaCte: Record<string, string> = { n_cod_ped: 'ncodped', n_cod_item: 'ncoditem', n_cod_for: 'ncodfor' };
    colunas.forEach((col, i) => {
      if (col === 'empresa') expect(selecao[i]).toBe('$1');
      else if (col === 'visto_em') expect(selecao[i]).toBe('now()');
      else expect(selecao[i], `coluna ${col}`).toBe(`c.${nomeNaCte[col] ?? col}`);
    });
  });

  it('o DO UPDATE regrava produto e local (mudou o PC no OMIE: o cache acompanha)', async () => {
    await registrarPcsVistos('q2p');
    expect(sqlDoUpsert()).toContain('n_cod_prod = EXCLUDED.n_cod_prod, codigo_local_estoque = EXCLUDED.codigo_local_estoque');
  });

  it('produto e local entram nas DUAS tuplas do IS DISTINCT FROM: mudar so o local do PC gera UPDATE (e linha de auditoria); sync sem mudanca, nao', async () => {
    await registrarPcsVistos('q2p');
    const m = /WHERE \(([^)]*)\) IS DISTINCT FROM \(([^)]*)\) RETURNING 1/.exec(sqlDoUpsert())!;
    const atuais = m[1]!.split(',').map((c) => c.trim().replace('pedido_compra_visto.', ''));
    const novas = m[2]!.split(',').map((c) => c.trim().replace('EXCLUDED.', ''));
    expect(atuais).toEqual(novas);
    expect(atuais.slice(-2)).toEqual(['n_cod_prod', 'codigo_local_estoque']);
    expect(atuais).not.toContain('visto_em'); // senao toda sincronizacao geraria UPDATE
  });

  it('grava na empresa certa e le a copia da propria empresa (a ACXE nao grava com a copia da Q2P)', async () => {
    await registrarPcsVistos('acxe');
    expect(mocks.poolQuery.mock.calls[0]![1]).toEqual(['acxe']);
    expect(sqlDoUpsert()).toContain('FROM public."tbl_pedidosCompras_ACXE" pc');
    expect(sqlDoUpsert()).not.toContain('tbl_pedidosCompras_Q2P');
  });
});

// ═══ lerPcsVistos — as colunas novas ═════════════════════════════════════════

function linha(over: Record<string, unknown> = {}) {
  return {
    n_cod_ped: '8516990580',
    n_cod_item: '8516990581',
    pc_numero: '580',
    n_cod_for: '4700001001',
    produto_descricao: 'PP PRETO Q35',
    unidade: 'KG',
    qtde: '26000.000',
    qtde_rec: '0.000',
    preco_unit: '4.800000',
    etapa: '15',
    dt_previsao: '2026-10-30',
    valor_total_pc: '124800.00',
    visto_ms: AGORA - 3_600_000,
    cnpj_cadastro: '11222333000181',
    n_cod_prod: '4501234567',
    codigo_local_estoque: '4553940398',
    ...over,
  };
}
const PARAMS = { fornecedores: [4700001001], raizes: ['11222333'], nCodPeds: [8516990580] };

describe('lerPcsVistos — produto e local do item do PC', () => {
  it('a consulta traz n_cod_prod e codigo_local_estoque como texto (bigint do pg)', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    await lerPcsVistos('acxe', PARAMS);
    expect(norm(mocks.poolQuery.mock.calls[0]![0])).toContain('v.n_cod_prod::text, v.codigo_local_estoque::text');
  });

  it('devolve nCodProd e codigoLocalEstoque como numeros', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [linha()] });
    const [pc] = await lerPcsVistos('acxe', PARAMS);
    expect(pc).toMatchObject({ pcNumero: '580', nCodProd: 4501234567, codigoLocalEstoque: 4553940398 });
  });

  it.each([[null], [undefined], [''], ['0'], ['-3'], ['abc'], ['45.5'], ['12345678901234567890']])(
    'produto/local %j nao e id do OMIE: os campos ficam AUSENTES (nunca NaN nem 0), o resto do PC e mantido',
    async (invalido) => {
      mocks.poolQuery.mockResolvedValue({ rows: [linha({ n_cod_prod: invalido, codigo_local_estoque: invalido })] });
      const [pc] = await lerPcsVistos('acxe', PARAMS);
      expect(pc).not.toHaveProperty('nCodProd');
      expect(pc).not.toHaveProperty('codigoLocalEstoque');
      expect(pc).toMatchObject({ pcNumero: '580', nCodItem: 8516990581, saldoCopiaKg: 26000 });
    },
  );

  it('produto presente e local ausente (e o contrario) sao independentes', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [linha({ codigo_local_estoque: null }), linha({ n_cod_item: '2', n_cod_prod: null })] });
    const [a, b] = await lerPcsVistos('acxe', PARAMS);
    expect(a).toMatchObject({ nCodProd: 4501234567 });
    expect(a).not.toHaveProperty('codigoLocalEstoque');
    expect(b).toMatchObject({ codigoLocalEstoque: 4553940398 });
    expect(b).not.toHaveProperty('nCodProd');
  });

  it('espacos nas pontas do id sao tolerados', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [linha({ n_cod_prod: ' 4501234567 ', codigo_local_estoque: ' 4553940398' })] });
    const [pc] = await lerPcsVistos('acxe', PARAMS);
    expect(pc).toMatchObject({ nCodProd: 4501234567, codigoLocalEstoque: 4553940398 });
  });
});

describe('lerPcsVistos — PC-espelho da importacao so existe na empresa Q2P', () => {
  const espelho = async (empresa: 'q2p' | 'acxe', cnpj: string, valor: string) => {
    mocks.poolQuery.mockResolvedValue({ rows: [linha({ cnpj_cadastro: cnpj, valor_total_pc: valor })] });
    return (await lerPcsVistos(empresa, PARAMS))[0]!.pcEspelho;
  };

  it('Q2P: fornecedor ACXE com valor total < R$ 200 e espelho', async () => {
    expect(await espelho('q2p', CNPJ_ACXE, '150.00')).toBe(true);
  });

  it('ACXE: o mesmo dado NUNCA e espelho (na copia da ACXE o fornecedor nunca e a propria ACXE)', async () => {
    expect(await espelho('acxe', CNPJ_ACXE, '150.00')).toBe(false);
    expect(await espelho('acxe', CNPJ_ACXE, '199.99')).toBe(false);
  });
});

// ═══ Fiacao real: carregarContextoPc ← cache ═════════════════════════════════

describe('carregarContextoPc com o cache REAL — NF da ACXE', () => {
  const FORN = 4700001001;

  function bancoComCacheDaAcxe(opts: { linhaCache?: Record<string, unknown>; locais?: unknown[] } = {}) {
    mocks.poolQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('INSERT INTO stockbridge.pedido_compra_visto')) return Promise.resolve({ rows: [{ n: '0' }] });
      if (s.includes('FROM stockbridge.pedido_compra_visto v')) return Promise.resolve({ rows: [linha(opts.linhaCache ?? {})] });
      if (s.includes('tbl_pedidosCompras_')) return Promise.resolve({ rows: [] }); // o OMIE tirou o PC 580 da lista de pendentes
      if (s.includes('AS codigo') && s.includes('tbl_cadastroFornecedoresClientes_')) return Promise.resolve({ rows: [] });
      if (s.includes('stockbridge.recebimento_fiscal_pc')) return Promise.resolve({ rows: [] });
      if (s.includes('stockbridge.localidade_correlacao')) {
        return Promise.resolve({
          rows: opts.locais ?? [{ codigo_omie: '4553940398', id: '5b1a1c2e-7d1f-4d0e-9a53-0a7c6e0b2007', codigo: '20.0.7', nome: 'PRODUÇÃO' }],
        });
      }
      return Promise.reject(new Error(`SQL inesperado: ${s.slice(0, 80)}`));
    });
  }

  it('PC fora da lista de pendentes volta do cache com produto e local, e o local e resolvido para a localidade do Atlas', async () => {
    bancoComCacheDaAcxe();
    const ctx = await carregarContextoPc('acxe', { fornecedores: [FORN], nCodPedsVinculo: [] });
    expect(ctx.pcs).toHaveLength(1);
    expect(ctx.pcs[0]).toMatchObject({ pcNumero: '580', fonte: 'cache', nCodProd: 4501234567, codigoLocalEstoque: 4553940398, pcEspelho: false });
    expect(ctx.locais!.get(4553940398)).toEqual({ id: '5b1a1c2e-7d1f-4d0e-9a53-0a7c6e0b2007', codigo: '20.0.7', nome: 'PRODUÇÃO' });
    // o cache lido e o da ACXE
    const leitura = mocks.poolQuery.mock.calls.find((c) => String(c[0]).includes('FROM stockbridge.pedido_compra_visto v'))!;
    expect(leitura[1]![0]).toBe('acxe');
  });

  it('o cache da ACXE tambem e atualizado ao abrir a NF (no maximo uma vez a cada 5 min), com a empresa da NF', async () => {
    bancoComCacheDaAcxe();
    await carregarContextoPc('acxe', { fornecedores: [FORN], nCodPedsVinculo: [] });
    await carregarContextoPc('acxe', { fornecedores: [FORN], nCodPedsVinculo: [] });
    const gravacoes = mocks.poolQuery.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO stockbridge.pedido_compra_visto'));
    expect(gravacoes).toHaveLength(1);
    expect(gravacoes[0]![1]).toEqual(['acxe']);
  });

  it('cache sem local (PC antigo, de antes da 0058): o PC volta SEM local e a correlacao nem e consultada', async () => {
    bancoComCacheDaAcxe({ linhaCache: { codigo_local_estoque: null, n_cod_prod: null } });
    const ctx = await carregarContextoPc('acxe', { fornecedores: [FORN], nCodPedsVinculo: [] });
    expect(ctx.pcs[0]).not.toHaveProperty('codigoLocalEstoque');
    expect(ctx.pcs[0]).not.toHaveProperty('nCodProd');
    expect(mocks.poolQuery.mock.calls.some((c) => String(c[0]).includes('localidade_correlacao'))).toBe(false);
    expect(ctx).not.toHaveProperty('locais');
  });
});
