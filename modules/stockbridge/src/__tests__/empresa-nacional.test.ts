import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — `empresa-nacional.ts`: a empresa da NF no recebimento nacional.
//
// O que o modulo decide e o que o resto da Fase 2 assume:
//  - os nomes das tabelas espelho de cada empresa (enum fechado, interpolado em SQL sem parametro);
//  - a NF da ACXE so entra na fila com TRES coisas juntas: a chave propria, a chave do fiscal pelo Atlas
//    (016) e o corte proprio da ACXE. Faltando qualquer uma a ACXE fica de fora — e a fila da Q2P segue
//    normal; o aviso no log e limitado a um a cada 10 minutos (o health chama isto a cada requisicao).

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getConfig: () => mocks.config,
}));

import {
  EMPRESAS_NACIONAL,
  ROTULO_EMPRESA,
  tabelasNacional,
  recebimentoNacionalAcxeFlag,
  dataCorteAcxe,
  recebimentoNacionalAcxeHabilitado,
  empresasNacionalAtivas,
  __resetEmpresaNacional,
} from '../services/empresa-nacional.js';

const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);
const MIN = 60_000;

beforeEach(() => {
  for (const k of Object.keys(mocks.config)) delete mocks.config[k];
  for (const f of Object.values(mocks.logger)) f.mockClear();
  __resetEmpresaNacional();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const configurar = (flag: boolean | undefined, fiscal: boolean | undefined, corte: string | undefined): void => {
  if (flag !== undefined) mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED = flag;
  if (fiscal !== undefined) mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = fiscal;
  if (corte !== undefined) mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE = corte;
};

describe('tabelasNacional — o espelho de cada empresa', () => {
  it('Q2P: sete tabelas, nomes ja entre aspas (o sufixo e maiusculo)', () => {
    expect(tabelasNacional('q2p')).toEqual({
      nfHeader: '"tbl_nf_header_Q2P"',
      nfItens: '"tbl_nf_itens_Q2P"',
      recebimento: '"tbl_recebimentoNFe_Q2P"',
      recebimentoItens: '"tbl_recebimentoNFe_itens_Q2P"',
      produtos: '"tbl_produtos_Q2P"',
      pedidosCompras: '"tbl_pedidosCompras_Q2P"',
      cadastro: '"tbl_cadastroFornecedoresClientes_Q2P"',
    });
  });

  it('ACXE: as mesmas sete tabelas com o sufixo da ACXE', () => {
    expect(tabelasNacional('acxe')).toEqual({
      nfHeader: '"tbl_nf_header_ACXE"',
      nfItens: '"tbl_nf_itens_ACXE"',
      recebimento: '"tbl_recebimentoNFe_ACXE"',
      recebimentoItens: '"tbl_recebimentoNFe_itens_ACXE"',
      produtos: '"tbl_produtos_ACXE"',
      pedidosCompras: '"tbl_pedidosCompras_ACXE"',
      cadastro: '"tbl_cadastroFornecedoresClientes_ACXE"',
    });
  });

  it('so o sufixo muda entre as empresas, e todo nome e um identificador seguro para interpolar em SQL', () => {
    const q2p = tabelasNacional('q2p');
    const acxe = tabelasNacional('acxe');
    for (const chave of Object.keys(q2p) as Array<keyof typeof q2p>) {
      expect(acxe[chave]).toBe(q2p[chave].replace('Q2P', 'ACXE'));
      expect(q2p[chave]).toMatch(/^"tbl_[A-Za-z_]+_Q2P"$/);
      expect(acxe[chave]).toMatch(/^"tbl_[A-Za-z_]+_ACXE"$/);
    }
  });
});

describe('constantes da empresa', () => {
  it('as empresas na ordem em que a fila as consulta (a Q2P primeiro) e os rotulos da tela e dos e-mails', () => {
    expect(EMPRESAS_NACIONAL).toEqual(['q2p', 'acxe']);
    expect(ROTULO_EMPRESA).toEqual({ q2p: 'Q2P', acxe: 'ACXE' });
  });
});

describe('recebimentoNacionalAcxeFlag — so a chave propria, sem as dependencias', () => {
  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ])('STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED=%s -> %s', (valor, esperado) => {
    if (valor !== undefined) mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED = valor;
    expect(recebimentoNacionalAcxeFlag()).toBe(esperado);
  });

  it('nao olha o fiscal nem o corte e nunca registra aviso', () => {
    mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED = true;
    expect(recebimentoNacionalAcxeFlag()).toBe(true); // sem fiscal e sem corte
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });
});

describe('dataCorteAcxe — YYYY-MM-DD valido ou null', () => {
  it('data valida volta como esta', () => {
    mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE = '2026-10-01';
    expect(dataCorteAcxe()).toBe('2026-10-01');
  });

  it.each([[undefined], [''], ['01/10/2026'], ['2026-10-1'], ['2026-10-01T00:00:00Z'], [' 2026-10-01'], ['20261001']])(
    'ausente ou mal formada (%j) -> null',
    (valor) => {
      if (valor !== undefined) mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE = valor;
      expect(dataCorteAcxe()).toBeNull();
    },
  );

  it('o corte da ACXE e independente do corte da Q2P', () => {
    mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE = '2026-09-11';
    expect(dataCorteAcxe()).toBeNull();
    mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE = '2026-10-15';
    expect(dataCorteAcxe()).toBe('2026-10-15');
  });
});

describe('recebimentoNacionalAcxeHabilitado — so com as TRES condicoes', () => {
  const CASOS: Array<[string, boolean, boolean, string | undefined, boolean]> = [
    ['nada configurado', false, false, undefined, false],
    ['so o corte', false, false, '2026-10-01', false],
    ['so o fiscal pelo Atlas', false, true, undefined, false],
    ['fiscal + corte, sem a chave da ACXE', false, true, '2026-10-01', false],
    ['so a chave da ACXE', true, false, undefined, false],
    ['chave + corte, sem o fiscal pelo Atlas', true, false, '2026-10-01', false],
    ['chave + fiscal, sem o corte', true, true, undefined, false],
    ['chave + fiscal + corte mal formado', true, true, '01/10/2026', false],
    ['chave + fiscal + corte valido', true, true, '2026-10-01', true],
  ];

  it.each(CASOS)('%s -> %s', (_nome, flag, fiscal, corte, esperado) => {
    configurar(flag, fiscal, corte);
    expect(recebimentoNacionalAcxeHabilitado()).toBe(esperado);
  });

  it('as tres condicoes sao lidas a cada chamada (a chave pode ser trocada sem reiniciar o processo)', () => {
    configurar(true, true, '2026-10-01');
    expect(recebimentoNacionalAcxeHabilitado()).toBe(true);
    mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = false;
    expect(recebimentoNacionalAcxeHabilitado()).toBe(false);
    mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    expect(recebimentoNacionalAcxeHabilitado()).toBe(true);
    delete mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE;
    expect(recebimentoNacionalAcxeHabilitado()).toBe(false);
  });
});

describe('recebimentoNacionalAcxeHabilitado — aviso no log (limitado a 1 a cada 10 minutos)', () => {
  it('chave desligada: silencio total, mesmo sem fiscal e sem corte (e o estado normal de hoje)', () => {
    for (let i = 0; i < 5; i++) recebimentoNacionalAcxeHabilitado();
    expect(mocks.logger.error).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('tudo configurado: silencio', () => {
    configurar(true, true, '2026-10-01');
    recebimentoNacionalAcxeHabilitado();
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it('chave ligada sem o fiscal e sem o corte: error no log dizendo o que falta, com as variaveis a ajustar', () => {
    configurar(true, undefined, undefined);
    expect(recebimentoNacionalAcxeHabilitado()).toBe(false);
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    const [dados, mensagem] = mocks.logger.error.mock.calls[0]!;
    expect(dados).toEqual({ fiscalPeloAtlas: false, corteAcxe: null });
    expect(mensagem).toContain('STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED');
    expect(mensagem).toContain('STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED');
    expect(mensagem).toContain('STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE');
    expect(mensagem).toContain('fora da fila nacional');
  });

  it('o log diz qual das duas dependencias esta faltando', () => {
    configurar(true, true, undefined);
    recebimentoNacionalAcxeHabilitado();
    expect(mocks.logger.error.mock.calls[0]![0]).toEqual({ fiscalPeloAtlas: true, corteAcxe: null });

    mocks.logger.error.mockClear();
    __resetEmpresaNacional();
    configurar(true, false, '2026-10-01');
    recebimentoNacionalAcxeHabilitado();
    expect(mocks.logger.error.mock.calls[0]![0]).toEqual({ fiscalPeloAtlas: false, corteAcxe: '2026-10-01' });
  });

  it('o aviso se repete no maximo a cada 10 minutos; antes disso, chamadas seguidas nao enchem o log', () => {
    configurar(true, false, '2026-10-01');
    recebimentoNacionalAcxeHabilitado();
    recebimentoNacionalAcxeHabilitado();
    vi.setSystemTime(T0 + 9 * MIN + 59_000);
    recebimentoNacionalAcxeHabilitado();
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 10 * MIN);
    recebimentoNacionalAcxeHabilitado();
    expect(mocks.logger.error).toHaveBeenCalledTimes(2);
    vi.setSystemTime(T0 + 15 * MIN);
    recebimentoNacionalAcxeHabilitado();
    expect(mocks.logger.error).toHaveBeenCalledTimes(2);
    vi.setSystemTime(T0 + 20 * MIN);
    recebimentoNacionalAcxeHabilitado();
    expect(mocks.logger.error).toHaveBeenCalledTimes(3);
  });

  it('__resetEmpresaNacional zera o controle (so teste): o aviso volta na chamada seguinte', () => {
    configurar(true, false, '2026-10-01');
    recebimentoNacionalAcxeHabilitado();
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    __resetEmpresaNacional();
    recebimentoNacionalAcxeHabilitado();
    expect(mocks.logger.error).toHaveBeenCalledTimes(2);
  });

  it('corrigir a configuracao devolve true sem novo aviso', () => {
    configurar(true, false, '2026-10-01');
    expect(recebimentoNacionalAcxeHabilitado()).toBe(false);
    mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    expect(recebimentoNacionalAcxeHabilitado()).toBe(true);
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('empresasNacionalAtivas', () => {
  it('a Q2P sempre; a ACXE so quando habilitada', () => {
    expect(empresasNacionalAtivas()).toEqual(['q2p']);
    configurar(true, true, undefined);
    expect(empresasNacionalAtivas()).toEqual(['q2p']);
    configurar(undefined, undefined, '2026-10-01');
    expect(empresasNacionalAtivas()).toEqual(['q2p', 'acxe']);
  });

  it('a Q2P vem primeiro (a numeracao dos parametros do SQL depende da ordem)', () => {
    configurar(true, true, '2026-10-01');
    expect(empresasNacionalAtivas()[0]).toBe('q2p');
  });

  it('nao devolve a lista compartilhada: alterar o resultado nao afeta a chamada seguinte', () => {
    const a = empresasNacionalAtivas();
    a.push('acxe');
    expect(empresasNacionalAtivas()).toEqual(['q2p']);
  });
});
