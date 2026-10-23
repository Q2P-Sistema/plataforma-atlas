import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — o cron `5,35 * * * *` do StockBridge.
//
// A Q2P roda como antes (alerta do espelho de recebimentos, alerta da copia de PCs e cache de PCs vistos). A ACXE so
// entra com a compra nacional da ACXE HABILITADA (chave + fiscal pelo Atlas + corte proprio), lida a CADA rodada: sem
// ela o espelho vazio da ACXE viraria alerta e o cache so geraria ruido de auditoria (trigger do 0057).

const mocks = vi.hoisted(() => ({
  agendados: [] as Array<{ expr: string; fn: () => void; opts: { timezone?: string } }>,
  config: {} as Record<string, unknown>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  verificarEspelhoRecebimentos: vi.fn(),
  verificarCopiaPcs: vi.fn(),
  registrarPcsVistos: vi.fn(),
  processarAlertasComodatoVencido: vi.fn(),
  reprocessarBaixasAguardandoVinculo: vi.fn(),
}));

vi.mock('node-cron', () => ({
  default: {
    schedule: (expr: string, fn: () => void, opts: { timezone?: string }) => {
      mocks.agendados.push({ expr, fn, opts });
      return { stop: vi.fn() };
    },
  },
}));
vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getConfig: () => mocks.config,
}));
vi.mock('../services/cron-comodato.service.js', () => ({ processarAlertasComodatoVencido: (...a: unknown[]) => mocks.processarAlertasComodatoVencido(...a) }));
vi.mock('../services/baixa-pedido.service.js', () => ({ reprocessarBaixasAguardandoVinculo: (...a: unknown[]) => mocks.reprocessarBaixasAguardandoVinculo(...a) }));
vi.mock('../services/alerta-espelho-recebimentos.service.js', () => ({
  verificarEspelhoRecebimentos: (...a: unknown[]) => mocks.verificarEspelhoRecebimentos(...a),
  verificarCopiaPcs: (...a: unknown[]) => mocks.verificarCopiaPcs(...a),
}));
vi.mock('../services/pc-visto.service.js', () => ({ registrarPcsVistos: (...a: unknown[]) => mocks.registrarPcsVistos(...a) }));

import { iniciarCronsStockBridge } from '../cron/index.js';
import { __resetEmpresaNacional } from '../services/empresa-nacional.js';

/** O job da vigilancia do espelho/copia/cache (o unico que a Historia 5 muda). */
const jobVigilancia = () => mocks.agendados.find((a) => a.expr === '5,35 * * * *')!;

function configurar(opts: { acxe?: boolean; fiscal?: boolean; corte?: string | null } = {}): void {
  const { acxe = true, fiscal = true, corte = '2026-10-01' } = opts;
  for (const k of Object.keys(mocks.config)) delete mocks.config[k];
  mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED = acxe;
  mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = fiscal;
  if (corte) mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE = corte;
}

/** Roda uma rodada do job e espera as promessas soltas (`.catch(...)`) terminarem. */
async function rodar(): Promise<void> {
  jobVigilancia().fn();
  await new Promise((r) => setImmediate(r));
}
const empresasChamadas = (mock: ReturnType<typeof vi.fn>): unknown[] => mock.mock.calls.map((c) => c[0]);

beforeAll(() => {
  iniciarCronsStockBridge();
});
beforeEach(() => {
  configurar();
  __resetEmpresaNacional();
  for (const f of [mocks.verificarEspelhoRecebimentos, mocks.verificarCopiaPcs, mocks.registrarPcsVistos]) {
    f.mockReset();
    f.mockResolvedValue('ok');
  }
  for (const f of Object.values(mocks.logger)) f.mockClear();
});

describe('registro dos jobs', () => {
  it('tres jobs, todos no fuso de Sao Paulo; o da vigilancia e `5,35 * * * *` (depois das rodadas do n8n, :23/:53)', () => {
    expect(mocks.agendados.map((a) => a.expr)).toEqual(['0 8 * * *', '20 * * * *', '5,35 * * * *']);
    for (const a of mocks.agendados) expect(a.opts.timezone).toBe('America/Sao_Paulo');
  });

  it('iniciar de novo (HMR, testes) nao registra em duplicidade e avisa', () => {
    const antes = mocks.agendados.length;
    iniciarCronsStockBridge();
    expect(mocks.agendados).toHaveLength(antes);
    expect(mocks.logger.warn).toHaveBeenCalledWith('Crons do StockBridge ja iniciados — ignorando');
  });
});

describe('cron 5,35 — Q2P como antes; ACXE so habilitada', () => {
  it('ACXE desligada: so a Q2P (espelho, copia de PCs e cache de PCs vistos), e nada com a ACXE', async () => {
    configurar({ acxe: false });
    await rodar();
    expect(empresasChamadas(mocks.verificarEspelhoRecebimentos)).toEqual(['q2p']);
    expect(empresasChamadas(mocks.verificarCopiaPcs)).toEqual(['q2p']);
    expect(empresasChamadas(mocks.registrarPcsVistos)).toEqual(['q2p']);
  });

  it('ACXE habilitada: a Q2P PRIMEIRO, depois as tres da ACXE', async () => {
    await rodar();
    expect(empresasChamadas(mocks.verificarEspelhoRecebimentos)).toEqual(['q2p', 'acxe']);
    expect(empresasChamadas(mocks.verificarCopiaPcs)).toEqual(['q2p', 'acxe']);
    expect(empresasChamadas(mocks.registrarPcsVistos)).toEqual(['q2p', 'acxe']);
    // a Q2P e a primeira a ser vigiada em cada grupo (a ordem global das chamadas)
    const ordem = [mocks.verificarEspelhoRecebimentos, mocks.verificarCopiaPcs, mocks.registrarPcsVistos]
      .flatMap((f) => f.mock.calls.map((c, i) => ({ empresa: c[0] as string, ordem: f.mock.invocationCallOrder[i]! })))
      .sort((a, b) => a.ordem - b.ordem)
      .map((x) => x.empresa);
    expect(ordem.slice(0, 3)).toEqual(['q2p', 'q2p', 'q2p']);
    expect(ordem.slice(3)).toEqual(['acxe', 'acxe', 'acxe']);
  });

  it.each([
    ['chave ligada SEM o fiscal pelo Atlas', { fiscal: false }],
    ['chave ligada SEM o corte da ACXE', { corte: null }],
    ['chave desligada, com fiscal e corte', { acxe: false }],
  ])('%s: a ACXE nao roda (a Q2P sim)', async (_nome, opts) => {
    configurar(opts);
    await rodar();
    expect(empresasChamadas(mocks.verificarEspelhoRecebimentos)).toEqual(['q2p']);
    expect(empresasChamadas(mocks.verificarCopiaPcs)).toEqual(['q2p']);
    expect(empresasChamadas(mocks.registrarPcsVistos)).toEqual(['q2p']);
  });

  it('a chave e lida a CADA rodada: ligar ou desligar a ACXE nao exige reiniciar o processo', async () => {
    configurar({ acxe: false });
    await rodar();
    configurar();
    await rodar();
    configurar({ acxe: false });
    await rodar();
    expect(empresasChamadas(mocks.registrarPcsVistos)).toEqual(['q2p', 'q2p', 'acxe', 'q2p']);
    expect(empresasChamadas(mocks.verificarEspelhoRecebimentos)).toEqual(['q2p', 'q2p', 'acxe', 'q2p']);
  });
});

describe('cron 5,35 — falhas nao se propagam', () => {
  it('a verificacao da ACXE que falha e logada com a mensagem da ACXE e nao derruba a rodada', async () => {
    mocks.verificarEspelhoRecebimentos.mockImplementation((empresa: string) => (empresa === 'acxe' ? Promise.reject(new Error('smtp down')) : Promise.resolve('ok')));
    mocks.verificarCopiaPcs.mockImplementation((empresa: string) => (empresa === 'acxe' ? Promise.reject(new Error('db down')) : Promise.resolve('ok')));
    await rodar();
    const mensagens = mocks.logger.error.mock.calls.map((c) => c[1]);
    expect(mensagens).toContain('Falha ao verificar o espelho de recebimentos de NF-e da ACXE');
    expect(mensagens).toContain('Falha ao verificar a cópia de pedidos de compra da ACXE');
    // o cache da ACXE ainda foi mantido
    expect(empresasChamadas(mocks.registrarPcsVistos)).toEqual(['q2p', 'acxe']);
  });

  it('a falha da Q2P tem a mensagem da Q2P e nao impede a vigilancia da ACXE', async () => {
    mocks.verificarEspelhoRecebimentos.mockImplementation((empresa: string) => (empresa === 'q2p' ? Promise.reject(new Error('timeout')) : Promise.resolve('ok')));
    await rodar();
    expect(mocks.logger.error.mock.calls.map((c) => c[1])).toContain('Falha ao verificar o espelho de recebimentos de NF-e');
    expect(empresasChamadas(mocks.verificarEspelhoRecebimentos)).toEqual(['q2p', 'acxe']);
    expect(empresasChamadas(mocks.verificarCopiaPcs)).toEqual(['q2p', 'acxe']);
  });

  it('a rodada em si nunca lanca (o node-cron nao tem onde tratar)', async () => {
    mocks.verificarEspelhoRecebimentos.mockRejectedValue(new Error('x'));
    mocks.verificarCopiaPcs.mockRejectedValue(new Error('y'));
    expect(() => jobVigilancia().fn()).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});
