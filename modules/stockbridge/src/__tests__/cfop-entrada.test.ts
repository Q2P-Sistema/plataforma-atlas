import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Feature 017, research D23 (06/11/2026) — CFOP de entrada do recebimento fiscal pela finalidade da compra.
//
// Funcoes puras (cfopEntradaParaFinalidade, finalidadeEntradaPadrao, ehFinalidadeEntrada) e o guard de
// habilitacao (cfopEntradaHabilitado = chave da 016 && chave propria && coluna da migration 0062).
// getConfig e getPool sao mockados como nos demais testes do modulo; o cache da coluna e zerado por teste.

const { cfg, poolQuery, loggerMock } = vi.hoisted(() => ({
  cfg: { fiscal: true as boolean | string | undefined, chave: true as boolean | string | undefined },
  poolQuery: vi.fn(),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => loggerMock,
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuery(sql, params) }),
  getConfig: () => ({
    STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: cfg.fiscal,
    STOCKBRIDGE_FISCAL_CFOP_ENTRADA_ENABLED: cfg.chave,
  }),
}));

import {
  FINALIDADES_ENTRADA,
  cfopEntradaChaveLigada,
  cfopEntradaHabilitado,
  cfopEntradaParaFinalidade,
  colunaFinalidadeEntradaExiste,
  ehFinalidadeEntrada,
  finalidadeEntradaPadrao,
  __resetColunaFinalidadeEntrada,
} from '../services/cfop-entrada.js';

beforeEach(() => {
  cfg.fiscal = true;
  cfg.chave = true;
  for (const f of Object.values(loggerMock)) f.mockClear();
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [{ ok: true }] });
  __resetColunaFinalidadeEntrada();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('cfopEntradaParaFinalidade — so troca o final 101/102 e preserva o 1o digito sugerido', () => {
  it.each([
    // [sugerido, industrializacao, comercializacao]
    ['1.101', '1.101', '1.102'],
    ['1.102', '1.101', '1.102'],
    ['2.101', '2.101', '2.102'],
    ['2.102', '2.101', '2.102'],
    ['3.101', '3.101', '3.102'],
    ['3.102', '3.101', '3.102'],
  ])('sugerido %s -> industrializacao %s / comercializacao %s', (sugerido, industrializacao, comercializacao) => {
    expect(cfopEntradaParaFinalidade(sugerido, 'industrializacao')).toBe(industrializacao);
    expect(cfopEntradaParaFinalidade(sugerido, 'comercializacao')).toBe(comercializacao);
  });

  it.each([
    ['2.556 (uso e consumo)', '2.556'],
    ['1.556', '1.556'],
    ['5.102 (saida, nao entrada)', '5.102'],
    ['6.102', '6.102'],
    ['4.102 (1o digito fora de 1/2/3)', '4.102'],
    ['2.1012 (final longo)', '2.1012'],
    ['2.10 (final curto)', '2.10'],
    ['2.103 (final fora de 101/102)', '2.103'],
    ['sem ponto', '2102'],
    ['com virgula', '2,102'],
    ['texto', 'abc'],
    ['vazio', ''],
    ['so espacos', '   '],
  ])('%s: o Atlas nao mexe (null)', (_nome, sugerido) => {
    expect(cfopEntradaParaFinalidade(sugerido, 'industrializacao')).toBeNull();
    expect(cfopEntradaParaFinalidade(sugerido, 'comercializacao')).toBeNull();
  });

  it('null, undefined e valor que nao e texto: null', () => {
    expect(cfopEntradaParaFinalidade(null, 'industrializacao')).toBeNull();
    expect(cfopEntradaParaFinalidade(undefined, 'comercializacao')).toBeNull();
    expect(cfopEntradaParaFinalidade(2.102 as unknown as string, 'industrializacao')).toBeNull();
  });

  it('espacos nas pontas sao ignorados (trim): " 2.102 " -> 2.101', () => {
    expect(cfopEntradaParaFinalidade(' 2.102 ', 'industrializacao')).toBe('2.101');
    expect(cfopEntradaParaFinalidade('\t1.101\n', 'comercializacao')).toBe('1.102');
  });
});

describe('finalidadeEntradaPadrao — pre-selecao pela empresa da NF', () => {
  it('ACXE compra para industrializar; Q2P para revender', () => {
    expect(finalidadeEntradaPadrao('acxe')).toBe('industrializacao');
    expect(finalidadeEntradaPadrao('q2p')).toBe('comercializacao');
  });

  it('empresa desconhecida ou ausente cai na Q2P (comercializacao)', () => {
    expect(finalidadeEntradaPadrao(null)).toBe('comercializacao');
    expect(finalidadeEntradaPadrao(undefined)).toBe('comercializacao');
  });
});

describe('ehFinalidadeEntrada / FINALIDADES_ENTRADA', () => {
  it('aceita so as duas finalidades', () => {
    expect(ehFinalidadeEntrada('industrializacao')).toBe(true);
    expect(ehFinalidadeEntrada('comercializacao')).toBe(true);
  });

  it.each([[''], ['Industrializacao'], ['industrialização'], ['consumo'], [null], [undefined], [1], [{}], [['industrializacao']]])(
    'recusa %o',
    (v) => {
      expect(ehFinalidadeEntrada(v)).toBe(false);
    },
  );

  it('a lista das finalidades e fixa e congelada', () => {
    expect([...FINALIDADES_ENTRADA]).toEqual(['industrializacao', 'comercializacao']);
    expect(Object.isFrozen(FINALIDADES_ENTRADA)).toBe(true);
  });
});

describe('cfopEntradaChaveLigada — STOCKBRIDGE_FISCAL_CFOP_ENTRADA_ENABLED', () => {
  it('so true literal liga (default desligada)', () => {
    cfg.chave = true;
    expect(cfopEntradaChaveLigada()).toBe(true);
    cfg.chave = false;
    expect(cfopEntradaChaveLigada()).toBe(false);
    cfg.chave = undefined;
    expect(cfopEntradaChaveLigada()).toBe(false);
    cfg.chave = 'true'; // a config ja transforma em boolean; texto cru nunca liga por engano
    expect(cfopEntradaChaveLigada()).toBe(false);
  });
});

describe('colunaFinalidadeEntradaExiste — guard da migration 0062', () => {
  it('confere recebimento_fiscal.finalidade_entrada no information_schema', async () => {
    expect(await colunaFinalidadeEntradaExiste()).toBe(true);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const sql = String(poolQuery.mock.calls[0]![0]);
    expect(sql).toContain('information_schema.columns');
    expect(sql).toContain("table_schema = 'stockbridge'");
    expect(sql).toContain("table_name = 'recebimento_fiscal'");
    expect(sql).toContain("column_name = 'finalidade_entrada'");
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it('presente: o resultado fica em cache (uma consulta so)', async () => {
    await colunaFinalidadeEntradaExiste();
    await colunaFinalidadeEntradaExiste();
    await colunaFinalidadeEntradaExiste();
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('ausente: false com erro no log; dentro de 5 min nao reconsulta, depois reconsulta (a migration pode entrar com a API no ar)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
    poolQuery.mockResolvedValue({ rows: [{ ok: false }] });

    expect(await colunaFinalidadeEntradaExiste()).toBe(false);
    expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining('migration 0062'));
    expect(poolQuery).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-11-06T12:04:59Z'));
    expect(await colunaFinalidadeEntradaExiste()).toBe(false);
    expect(poolQuery).toHaveBeenCalledTimes(1);

    // a migration foi aplicada nesse meio tempo
    poolQuery.mockResolvedValue({ rows: [{ ok: true }] });
    vi.setSystemTime(new Date('2026-11-06T12:05:01Z'));
    expect(await colunaFinalidadeEntradaExiste()).toBe(true);
    expect(poolQuery).toHaveBeenCalledTimes(2);
    // e agora o "presente" fica em cache
    vi.setSystemTime(new Date('2026-11-06T18:00:00Z'));
    expect(await colunaFinalidadeEntradaExiste()).toBe(true);
    expect(poolQuery).toHaveBeenCalledTimes(2);
  });

  it('ausente com a chave propria DESLIGADA: so aviso (warn), sem erro — a listagem do ledger confere a coluna e nao deve alarmar', async () => {
    cfg.chave = false;
    poolQuery.mockResolvedValue({ rows: [{ ok: false }] });

    expect(await colunaFinalidadeEntradaExiste()).toBe(false);
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('migration 0062'));
  });

  it('consulta sem linha (rows vazio): tratada como ausente', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    expect(await colunaFinalidadeEntradaExiste()).toBe(false);
  });

  it('erro de banco ao conferir: ausente por 30 s (warn), depois reconsulta', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
    poolQuery.mockRejectedValueOnce(new Error('connection terminated'));

    expect(await colunaFinalidadeEntradaExiste()).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.objectContaining({ err: 'connection terminated' }), expect.stringContaining('finalidade_entrada'));
    expect(poolQuery).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-11-06T12:00:29Z'));
    expect(await colunaFinalidadeEntradaExiste()).toBe(false);
    expect(poolQuery).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-11-06T12:00:31Z'));
    expect(await colunaFinalidadeEntradaExiste()).toBe(true);
    expect(poolQuery).toHaveBeenCalledTimes(2);
  });

  it('__resetColunaFinalidadeEntrada esquece o que foi conferido', async () => {
    await colunaFinalidadeEntradaExiste();
    __resetColunaFinalidadeEntrada();
    await colunaFinalidadeEntradaExiste();
    expect(poolQuery).toHaveBeenCalledTimes(2);
  });
});

describe('cfopEntradaHabilitado — chave da 016 && chave propria && coluna da 0062', () => {
  it.each([
    // [chave da 016, chave propria, coluna 0062, habilitado]
    [true, true, true, true],
    [true, true, false, false], // sem a migration: desligado (vale a sugestao do OMIE), com erro no log
    [true, false, true, false], // chave propria desligada (default)
    [true, false, false, false],
    [false, true, true, false], // sem o fiscal pelo Atlas nao ha EDITAR
    [false, true, false, false],
    [false, false, true, false],
    [false, false, false, false],
  ])('fiscal=%s, chave propria=%s, coluna=%s -> %s', async (fiscal, chave, coluna, esperado) => {
    cfg.fiscal = fiscal;
    cfg.chave = chave;
    poolQuery.mockResolvedValue({ rows: [{ ok: coluna }] });
    expect(await cfopEntradaHabilitado()).toBe(esperado);
  });

  it('com uma das chaves desligada nem consulta o banco (curto-circuito antes da coluna)', async () => {
    cfg.chave = false;
    expect(await cfopEntradaHabilitado()).toBe(false);
    cfg.chave = true;
    cfg.fiscal = false;
    expect(await cfopEntradaHabilitado()).toBe(false);
    cfg.fiscal = undefined;
    expect(await cfopEntradaHabilitado()).toBe(false);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('chave da 016 so vale com true literal', async () => {
    cfg.fiscal = 'true';
    expect(await cfopEntradaHabilitado()).toBe(false);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('coluna ausente: erro no log a cada reconferencia, nunca excecao', async () => {
    poolQuery.mockResolvedValue({ rows: [{ ok: false }] });
    await expect(cfopEntradaHabilitado()).resolves.toBe(false);
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
  });
});
