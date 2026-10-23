import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Feature 017, Historia 5 (ACXEGDP-437) — saude do modulo por empresa.
//
// O espelho de recebimentos de NF-e (n8n) e a copia de pedidos de compra decidem a fila e a sugestao de PC; sem
// eles a fila degrada em silencio. O health mostra a idade de cada um por empresa: a ACXE e 'desligado' enquanto a
// compra nacional da ACXE nao esta valendo (chave + fiscal pelo Atlas + corte proprio) — senao o espelho vazio de
// antes do go-live (o n8n da ACXE existe e esta inativo) viraria 'sem_dados', health degradado e alerta ao ops por
// um workflow que ainda nao roda. Tabela ausente com a ACXE ligada = 'indisponivel' (degradado, e o cron alerta).
// A Q2P nao muda: 'desligado' so com a chave da 016 desligada.

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  config: {} as Record<string, unknown>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  requireModule: vi.fn(),
}));
// dublê dos sub-routers: um Router vazio (vi.hoisted para existir quando os vi.mock abaixo forem executados)
const { routerVazio } = vi.hoisted(() => ({
  routerVazio: async () => ({ default: (await import('express')).Router() }),
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params) }),
  getConfig: () => mocks.config,
}));
vi.mock('@atlas/integration-omie', () => ({ consultarPedidoCompra: vi.fn() }));
vi.mock('../services/correlacao-produto.service.js', () => ({ sugerirProdutosEmLote: vi.fn() }));

// O router do modulo importa todos os sub-routers; aqui so o /health importa.
vi.mock('@atlas/auth', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  csrfProtection: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireModule: (chave: string) => {
    mocks.requireModule(chave);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock('../routes/fila.routes.js', routerVazio);
vi.mock('../routes/recebimento.routes.js', routerVazio);
vi.mock('../routes/recebimento-nacional.routes.js', routerVazio);
vi.mock('../routes/cockpit.routes.js', routerVazio);
vi.mock('../routes/cockpit-executivo.routes.js', routerVazio);
vi.mock('../routes/aprovacao.routes.js', routerVazio);
vi.mock('../routes/divergencia.routes.js', routerVazio);
vi.mock('../routes/transito.routes.js', routerVazio);
vi.mock('../routes/saida-automatica.routes.js', routerVazio);
vi.mock('../routes/saida-manual.routes.js', routerVazio);
vi.mock('../routes/metricas.routes.js', routerVazio);
vi.mock('../routes/fornecedor.routes.js', routerVazio);
vi.mock('../routes/localidade.routes.js', routerVazio);
vi.mock('../routes/config.routes.js', routerVazio);
vi.mock('../routes/movimentacao.routes.js', routerVazio);
vi.mock('../routes/meu-estoque.routes.js', routerVazio);
vi.mock('../routes/admin-user-galpao.routes.js', routerVazio);
vi.mock('../routes/operacoes-pendentes.routes.js', routerVazio);
vi.mock('../routes/admin-cron.routes.js', routerVazio);
vi.mock('../routes/cmc.routes.js', routerVazio);
vi.mock('../routes/conferencia.routes.js', routerVazio);
vi.mock('../routes/nf-pedido-mapa.routes.js', routerVazio);
vi.mock('../routes/pendencias-fiscais.routes.js', routerVazio);
vi.mock('../routes/baixa-pedido.routes.js', routerVazio);

import {
  idadeEspelhoRecebimentos,
  idadeCopiaPcs,
  copiaPcsDefasada,
  statusHealthModulo,
  limiteIdadeEspelhoMin,
  limiteIdadeCopiaPcsMin,
} from '../services/fila-nacional.service.js';
import { __resetEmpresaNacional } from '../services/empresa-nacional.js';
import stockbridgeRouter from '../routes/stockbridge.routes.js';

const CORTE = '2026-10-01';
const norm = (sql: unknown): string => String(sql).replace(/\s+/g, ' ').trim();

/** Config da fila: a chave da 016 e as duas da ACXE (chave propria + corte). */
function configurar(opts: { fiscal?: boolean; acxe?: boolean; corte?: string | null } = {}): void {
  const { fiscal = true, acxe = true, corte = CORTE } = opts;
  for (const k of Object.keys(mocks.config)) delete mocks.config[k];
  mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = fiscal;
  mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED = acxe;
  if (corte) mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE = corte;
}

/** Idade (min) devolvida pelo banco para cada leitura, por empresa; null = tabela vazia; 'erro' = tabela ausente. */
type Idade = number | null | 'erro';
function bancoComIdades(idades: {
  espelho: { q2p: Idade; acxe: Idade };
  copia: { q2p: Idade; acxe: Idade };
  /** batimento do n8n da ACXE em tbl_sync_debounce (chave receb_acxe); ausente = tabela de batimento inexistente */
  batimentoAcxe?: number | null;
}): void {
  mocks.poolQuery.mockImplementation((sql: string) => {
    const s = String(sql);
    if (s.includes("to_regclass('public.tbl_sync_debounce')")) return Promise.resolve({ rows: [{ existe: idades.batimentoAcxe !== undefined }] });
    if (s.includes('FROM public.tbl_sync_debounce')) {
      const b = idades.batimentoAcxe;
      return Promise.resolve({ rows: b == null ? [] : [{ idade_min: String(b) }] });
    }
    const empresa = s.includes('_ACXE"') ? 'acxe' : 'q2p';
    const idade = s.includes('MAX(synced_at)') ? idades.espelho[empresa] : s.includes('MAX(data_atualizacao)') ? idades.copia[empresa] : undefined;
    if (idade === undefined) return Promise.reject(new Error(`SQL inesperado: ${s.slice(0, 60)}`));
    if (idade === 'erro') return Promise.reject(Object.assign(new Error('relation "public.tbl_recebimentoNFe_ACXE" does not exist'), { code: '42P01' }));
    return Promise.resolve({ rows: [{ idade_min: idade == null ? null : String(idade) }] });
  });
}
const todosEmDia = { espelho: { q2p: 10, acxe: 12 }, copia: { q2p: 5, acxe: 7 } } as const;

beforeEach(() => {
  configurar();
  __resetEmpresaNacional();
  mocks.poolQuery.mockReset();
  bancoComIdades(todosEmDia);
  for (const f of Object.values(mocks.logger)) f.mockClear();
});

describe('idadeEspelhoRecebimentos — por empresa', () => {
  it('ACXE habilitada: le MAX(synced_at) do espelho da ACXE e informa idade e limite', async () => {
    expect(await idadeEspelhoRecebimentos('acxe')).toEqual({ idadeMin: 12, status: 'ok', limiteMin: 120 });
    const chamada = mocks.poolQuery.mock.calls.find((c) => String(c[0]).includes('MAX(synced_at)'))!;
    expect(norm(chamada[0])).toBe('SELECT (EXTRACT(EPOCH FROM (now() - MAX(synced_at))) / 60)::numeric(12,1) AS idade_min FROM public."tbl_recebimentoNFe_ACXE"');
  });

  describe('batimento do n8n da ACXE (tbl_sync_debounce, chave receb_acxe) — revisao da Fase 2', () => {
    it('vale o sinal mais recente: espelho parado ha 300 min (poucas NFs) com o n8n rodando ha 20 min = ok, 20 min', async () => {
      bancoComIdades({ ...todosEmDia, espelho: { q2p: 10, acxe: 300 }, batimentoAcxe: 20 });
      expect(await idadeEspelhoRecebimentos('acxe')).toEqual({ idadeMin: 20, status: 'ok', limiteMin: 120 });
      const bat = mocks.poolQuery.mock.calls.find((c) => String(c[0]).includes('FROM public.tbl_sync_debounce'))!;
      expect(bat[1]).toEqual(['receb_acxe']);
    });

    it('n8n parado (batimento velho) e espelho velho: degraded pela idade mais recente dos dois', async () => {
      bancoComIdades({ ...todosEmDia, espelho: { q2p: 10, acxe: 500 }, batimentoAcxe: 400 });
      expect(await idadeEspelhoRecebimentos('acxe')).toEqual({ idadeMin: 400, status: 'degraded', limiteMin: 120 });
    });

    it('espelho vazio com o n8n rodando: ok pelo batimento (nao "sem_dados")', async () => {
      bancoComIdades({ ...todosEmDia, espelho: { q2p: 10, acxe: null }, batimentoAcxe: 15 });
      expect(await idadeEspelhoRecebimentos('acxe')).toEqual({ idadeMin: 15, status: 'ok', limiteMin: 120 });
    });

    it('sem a tabela de batimento (ou sem a chave): so MAX(synced_at), como antes', async () => {
      bancoComIdades({ ...todosEmDia, espelho: { q2p: 10, acxe: 300 } });
      expect(await idadeEspelhoRecebimentos('acxe')).toEqual({ idadeMin: 300, status: 'degraded', limiteMin: 120 });
      bancoComIdades({ ...todosEmDia, espelho: { q2p: 10, acxe: 300 }, batimentoAcxe: null });
      expect(await idadeEspelhoRecebimentos('acxe')).toEqual({ idadeMin: 300, status: 'degraded', limiteMin: 120 });
    });

    it('a Q2P nao le batimento (o SQL e as chamadas dela nao mudam)', async () => {
      bancoComIdades({ ...todosEmDia, batimentoAcxe: 1 });
      await idadeEspelhoRecebimentos('q2p');
      expect(mocks.poolQuery.mock.calls.every((c) => !String(c[0]).includes('tbl_sync_debounce'))).toBe(true);
    });
  });

  it('o default e a Q2P e le o espelho da Q2P', async () => {
    expect(await idadeEspelhoRecebimentos()).toEqual({ idadeMin: 10, status: 'ok', limiteMin: 120 });
    expect(norm(mocks.poolQuery.mock.calls[0]![0])).toContain('FROM public."tbl_recebimentoNFe_Q2P"');
    expect(norm(mocks.poolQuery.mock.calls[0]![0])).not.toContain('ACXE');
  });

  it.each([
    ['chave da ACXE desligada', { acxe: false }],
    ['chave da ACXE ligada SEM o fiscal pelo Atlas', { fiscal: false }],
    ['chave da ACXE ligada SEM o corte da ACXE', { corte: null }],
  ])('ACXE fora da fila (%s): "desligado" e NENHUMA consulta ao banco (o espelho vazio do n8n inativo nao pode virar alerta)', async (_nome, opts) => {
    configurar(opts);
    expect(await idadeEspelhoRecebimentos('acxe')).toEqual({ idadeMin: null, status: 'desligado' });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('a Q2P so depende da chave da 016: "desligado" sem ela, mesmo com a ACXE ligada; com ela, normal mesmo sem o corte da ACXE', async () => {
    configurar({ fiscal: false, acxe: true });
    expect(await idadeEspelhoRecebimentos('q2p')).toEqual({ idadeMin: null, status: 'desligado' });
    configurar({ fiscal: true, acxe: false });
    expect((await idadeEspelhoRecebimentos('q2p')).status).toBe('ok');
    configurar({ fiscal: true, acxe: true, corte: null });
    expect((await idadeEspelhoRecebimentos('q2p')).status).toBe('ok');
  });

  it('acima do limite = degraded; vazio = sem_dados; tabela ausente ou erro de banco = indisponivel (com o limite informado)', async () => {
    bancoComIdades({ ...todosEmDia, espelho: { q2p: 10, acxe: 200 } });
    expect(await idadeEspelhoRecebimentos('acxe')).toEqual({ idadeMin: 200, status: 'degraded', limiteMin: 120 });
    bancoComIdades({ ...todosEmDia, espelho: { q2p: 10, acxe: null } });
    expect(await idadeEspelhoRecebimentos('acxe')).toEqual({ idadeMin: null, status: 'sem_dados', limiteMin: 120 });
    bancoComIdades({ ...todosEmDia, espelho: { q2p: 10, acxe: 'erro' } });
    expect(await idadeEspelhoRecebimentos('acxe')).toEqual({ idadeMin: null, status: 'indisponivel', limiteMin: 120 });
    const aviso = mocks.logger.warn.mock.calls.find((c) => String(c[1]).includes('Idade do espelho de recebimentos indisponível'));
    expect(aviso![0]).toMatchObject({ empresa: 'acxe' });
  });

  it('o limite (STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN) vale para as duas empresas', async () => {
    bancoComIdades({ ...todosEmDia, espelho: { q2p: 200, acxe: 200 } });
    expect(limiteIdadeEspelhoMin()).toBe(120);
    expect((await idadeEspelhoRecebimentos('q2p')).status).toBe('degraded');
    expect((await idadeEspelhoRecebimentos('acxe')).status).toBe('degraded');
    mocks.config.STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN = 360;
    expect(await idadeEspelhoRecebimentos('q2p')).toEqual({ idadeMin: 200, status: 'ok', limiteMin: 360 });
    expect(await idadeEspelhoRecebimentos('acxe')).toEqual({ idadeMin: 200, status: 'ok', limiteMin: 360 });
  });

  it('as duas empresas sao independentes: a Q2P velha nao degrada a leitura da ACXE em dia', async () => {
    bancoComIdades({ ...todosEmDia, espelho: { q2p: 500, acxe: 12 } });
    expect((await idadeEspelhoRecebimentos('q2p')).status).toBe('degraded');
    expect((await idadeEspelhoRecebimentos('acxe')).status).toBe('ok');
  });
});

describe('idadeCopiaPcs / copiaPcsDefasada — por empresa', () => {
  it('ACXE habilitada: le MAX(data_atualizacao) da copia da ACXE', async () => {
    expect(await idadeCopiaPcs('acxe')).toEqual({ idadeMin: 7, status: 'ok', limiteMin: 120 });
    expect(norm(mocks.poolQuery.mock.calls[0]![0])).toBe(
      'SELECT (EXTRACT(EPOCH FROM (now() - MAX(data_atualizacao))) / 60)::numeric(12,1) AS idade_min FROM public."tbl_pedidosCompras_ACXE"',
    );
  });

  it('o default e a Q2P', async () => {
    expect(await idadeCopiaPcs()).toEqual({ idadeMin: 5, status: 'ok', limiteMin: 120 });
    expect(norm(mocks.poolQuery.mock.calls[0]![0])).toContain('FROM public."tbl_pedidosCompras_Q2P"');
  });

  it.each([
    ['chave da ACXE desligada', { acxe: false }],
    ['sem o fiscal pelo Atlas', { fiscal: false }],
    ['sem o corte da ACXE', { corte: null }],
  ])('ACXE fora da fila (%s): "desligado" sem consultar o banco', async (_nome, opts) => {
    configurar(opts);
    expect(await idadeCopiaPcs('acxe')).toEqual({ idadeMin: null, status: 'desligado' });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('copiaPcsDefasada: velha, vazia ou inacessivel = true (modo seguro); em dia ou desligada = false', async () => {
    bancoComIdades({ ...todosEmDia, copia: { q2p: 5, acxe: 500 } });
    expect(await copiaPcsDefasada('acxe')).toBe(true);
    expect(await copiaPcsDefasada('q2p')).toBe(false);
    bancoComIdades({ ...todosEmDia, copia: { q2p: 5, acxe: null } });
    expect(await copiaPcsDefasada('acxe')).toBe(true);
    bancoComIdades({ ...todosEmDia, copia: { q2p: 5, acxe: 'erro' } });
    expect(await copiaPcsDefasada('acxe')).toBe(true);
    bancoComIdades(todosEmDia);
    expect(await copiaPcsDefasada('acxe')).toBe(false);
    configurar({ acxe: false });
    expect(await copiaPcsDefasada('acxe')).toBe(false);
  });

  it('o default de copiaPcsDefasada e a Q2P', async () => {
    bancoComIdades({ ...todosEmDia, copia: { q2p: 500, acxe: 5 } });
    expect(await copiaPcsDefasada()).toBe(true);
    bancoComIdades({ ...todosEmDia, copia: { q2p: 5, acxe: 500 } });
    expect(await copiaPcsDefasada()).toBe(false);
  });

  it('o limite (STOCKBRIDGE_COPIA_PCS_MAX_MIN) e o mesmo das duas empresas', async () => {
    bancoComIdades({ ...todosEmDia, copia: { q2p: 200, acxe: 200 } });
    expect(limiteIdadeCopiaPcsMin()).toBe(120);
    mocks.config.STOCKBRIDGE_COPIA_PCS_MAX_MIN = 1440;
    expect(await idadeCopiaPcs('acxe')).toEqual({ idadeMin: 200, status: 'ok', limiteMin: 1440 });
    expect(await idadeCopiaPcs('q2p')).toEqual({ idadeMin: 200, status: 'ok', limiteMin: 1440 });
  });

  it('falha de banco: indisponivel e o log leva a empresa', async () => {
    bancoComIdades({ ...todosEmDia, copia: { q2p: 5, acxe: 'erro' } });
    expect((await idadeCopiaPcs('acxe')).status).toBe('indisponivel');
    const aviso = mocks.logger.warn.mock.calls.find((c) => String(c[1]).includes('Idade da cópia de pedidos de compra indisponível'));
    expect(aviso![0]).toMatchObject({ empresa: 'acxe' });
  });
});

describe('statusHealthModulo — varias leituras', () => {
  const ok = { idadeMin: 5, status: 'ok' as const };
  it('basta UMA leitura degradada, vazia ou inacessivel (de qualquer empresa) para degradar o modulo', () => {
    expect(statusHealthModulo(ok, ok, ok, ok)).toBe('ok');
    expect(statusHealthModulo(ok, ok, ok, { idadeMin: 300, status: 'degraded' })).toBe('degraded');
    expect(statusHealthModulo(ok, ok, { idadeMin: null, status: 'sem_dados' }, ok)).toBe('degraded');
    expect(statusHealthModulo({ idadeMin: null, status: 'indisponivel' }, ok, ok, ok)).toBe('degraded');
  });
  it('"desligado" nunca degrada (a ACXE desligada nao e problema)', () => {
    expect(statusHealthModulo(ok, ok, { idadeMin: null, status: 'desligado' }, { idadeMin: null, status: 'desligado' })).toBe('ok');
  });
});

describe('GET /api/v1/stockbridge/health — por empresa', () => {
  const app = express();
  app.use(stockbridgeRouter);
  const health = () => request(app).get('/api/v1/stockbridge/health');

  it('o health fica atras da sessao e do modulo stockbridge (como o resto da API)', () => {
    expect(mocks.requireModule).toHaveBeenCalledWith('stockbridge');
  });

  it('ACXE desligada: os campos da Q2P de sempre e os da ACXE "desligado"; a chave nao esta ligada; status ok', async () => {
    configurar({ acxe: false });
    const res = await health();
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data).toEqual({
      status: 'ok',
      module: 'stockbridge',
      recebimentoNfeEspelhoIdadeMin: 10,
      recebimentoNfeEspelho: { idadeMin: 10, status: 'ok', limiteMin: 120 },
      pedidosCompraCopiaIdadeMin: 5,
      pedidosCompraCopia: { idadeMin: 5, status: 'ok', limiteMin: 120 },
      recebimentoNfeEspelhoAcxeIdadeMin: null,
      recebimentoNfeEspelhoAcxe: { idadeMin: null, status: 'desligado' },
      pedidosCompraCopiaAcxeIdadeMin: null,
      pedidosCompraCopiaAcxe: { idadeMin: null, status: 'desligado' },
      recebimentoNacionalAcxe: { chave: false, habilitada: false },
    });
  });

  it('ACXE habilitada e em dia: as quatro leituras com idade, chave e "habilitada" verdadeiras', async () => {
    const res = await health();
    expect(res.body.data).toMatchObject({
      status: 'ok',
      recebimentoNfeEspelhoIdadeMin: 10,
      pedidosCompraCopiaIdadeMin: 5,
      recebimentoNfeEspelhoAcxeIdadeMin: 12,
      recebimentoNfeEspelhoAcxe: { idadeMin: 12, status: 'ok', limiteMin: 120 },
      pedidosCompraCopiaAcxeIdadeMin: 7,
      pedidosCompraCopiaAcxe: { idadeMin: 7, status: 'ok', limiteMin: 120 },
      recebimentoNacionalAcxe: { chave: true, habilitada: true },
    });
  });

  it('chave da ACXE ligada sem o corte (ou sem o fiscal): o health MOSTRA a chave ligada e "habilitada: false" — e nao degrada', async () => {
    configurar({ corte: null });
    let res = await health();
    expect(res.body.data.recebimentoNacionalAcxe).toEqual({ chave: true, habilitada: false });
    expect(res.body.data.recebimentoNfeEspelhoAcxe.status).toBe('desligado');
    expect(res.body.data.status).toBe('ok');
    configurar({ fiscal: false });
    res = await health();
    expect(res.body.data.recebimentoNacionalAcxe).toEqual({ chave: true, habilitada: false });
    expect(res.body.data.pedidosCompraCopiaAcxe.status).toBe('desligado');
  });

  it.each([
    ['espelho de recebimentos da ACXE velho', { espelho: { q2p: 10, acxe: 500 }, copia: { q2p: 5, acxe: 7 } }],
    ['espelho de recebimentos da ACXE vazio', { espelho: { q2p: 10, acxe: null }, copia: { q2p: 5, acxe: 7 } }],
    ['espelho de recebimentos da ACXE inacessivel (tabela ausente)', { espelho: { q2p: 10, acxe: 'erro' }, copia: { q2p: 5, acxe: 7 } }],
    ['copia de PCs da ACXE velha', { espelho: { q2p: 10, acxe: 12 }, copia: { q2p: 5, acxe: 500 } }],
    ['copia de PCs da ACXE inacessivel', { espelho: { q2p: 10, acxe: 12 }, copia: { q2p: 5, acxe: 'erro' } }],
    ['espelho da Q2P velho (como antes)', { espelho: { q2p: 500, acxe: 12 }, copia: { q2p: 5, acxe: 7 } }],
    ['copia de PCs da Q2P vazia (como antes)', { espelho: { q2p: 10, acxe: 12 }, copia: { q2p: null, acxe: 7 } }],
  ])('com a ACXE habilitada, %s -> status "degraded"', async (_nome, idades) => {
    bancoComIdades(idades as Parameters<typeof bancoComIdades>[0]);
    const res = await health();
    expect(res.body.data.status).toBe('degraded');
  });

  it('a mesma defasagem da ACXE com a ACXE DESLIGADA nao degrada o modulo (o n8n da ACXE inativo nao e problema)', async () => {
    configurar({ acxe: false });
    bancoComIdades({ espelho: { q2p: 10, acxe: null }, copia: { q2p: 5, acxe: 'erro' } });
    const res = await health();
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.recebimentoNfeEspelhoAcxe.status).toBe('desligado');
  });

  it('o health nao consulta o espelho da ACXE quando ela esta desligada', async () => {
    configurar({ acxe: false });
    await health();
    expect(mocks.poolQuery.mock.calls.some((c) => String(c[0]).includes('_ACXE"'))).toBe(false);
  });

  it('a ACXE ligada: uma consulta por leitura (4) + a checagem do batimento do n8n da ACXE — nada de consulta repetida por requisicao', async () => {
    await health();
    // espelho Q2P, espelho ACXE, copia Q2P, copia ACXE + to_regclass do batimento (sem a tabela de batimento no dublê)
    expect(mocks.poolQuery).toHaveBeenCalledTimes(5);
  });
});

