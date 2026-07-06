import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const INTEGRATION_KEY = 'test-integration-key-1234567890';

// getConfig controlável por teste (para cobrir o caso "não configurada").
let configuredKey: string | undefined = INTEGRATION_KEY;
vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getConfig: () => ({ ATLAS_INTEGRATION_KEY: configuredKey }),
}));

import { requireIntegrationKey } from '../middleware/integration-key.js';

function makeApp() {
  const app = express();
  app.post('/protegido', requireIntegrationKey, (_req, res) => {
    res.status(200).json({ data: 'ok', error: null });
  });
  return app;
}

describe('requireIntegrationKey — SEG-08 comparação timing-safe', () => {
  it('aceita a chave correta', async () => {
    configuredKey = INTEGRATION_KEY;
    const res = await request(makeApp()).post('/protegido').set('X-Atlas-Integration-Key', INTEGRATION_KEY);
    expect(res.status).toBe(200);
  });

  it('rejeita chave errada de MESMO tamanho com 401', async () => {
    configuredKey = INTEGRATION_KEY;
    const errada = 'x'.repeat(INTEGRATION_KEY.length);
    const res = await request(makeApp()).post('/protegido').set('X-Atlas-Integration-Key', errada);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_INTEGRATION_KEY');
  });

  it('rejeita chave de tamanho DIFERENTE com 401 (não 500) — guard antes do timingSafeEqual', async () => {
    // Sem o guard de tamanho, timingSafeEqual lançaria com buffers de tamanhos
    // distintos e o handler viraria 500. O guard garante 401.
    configuredKey = INTEGRATION_KEY;
    const res = await request(makeApp()).post('/protegido').set('X-Atlas-Integration-Key', 'curta');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_INTEGRATION_KEY');
  });

  it('rejeita header ausente com 401', async () => {
    configuredKey = INTEGRATION_KEY;
    const res = await request(makeApp()).post('/protegido');
    expect(res.status).toBe(401);
  });

  it('retorna 503 quando ATLAS_INTEGRATION_KEY não está configurada', async () => {
    configuredKey = undefined;
    const res = await request(makeApp()).post('/protegido').set('X-Atlas-Integration-Key', 'qualquer');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('INTEGRATION_DISABLED');
  });
});
