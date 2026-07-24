import { describe, it, expect, vi } from 'vitest';
import { csrfProtection } from '@atlas/auth';

function mockRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json = vi.fn((b: unknown) => { res.body = b; return res; });
  return res;
}

describe('csrfProtection — SEG-07 (ACXEGDP-245)', () => {
  it('deixa passar métodos seguros (GET) sem validar', () => {
    const next = vi.fn();
    csrfProtection({ method: 'GET', headers: {} } as any, mockRes() as any, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('deixa passar POST com header batendo com a sessão', () => {
    const next = vi.fn();
    const req = { method: 'POST', session: { csrfToken: 'tok' }, headers: { 'x-csrf-token': 'tok' } };
    csrfProtection(req as any, mockRes() as any, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('nega POST com header errado (403 CSRF_INVALID)', () => {
    const next = vi.fn();
    const res = mockRes();
    const req = { method: 'POST', session: { csrfToken: 'tok' }, headers: { 'x-csrf-token': 'xxx' } };
    csrfProtection(req as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('nega POST sem header (403)', () => {
    const next = vi.fn();
    const res = mockRes();
    const req = { method: 'POST', session: { csrfToken: 'tok' }, headers: {} };
    csrfProtection(req as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  // Regressão central do SEG-07: fail-CLOSED. Antes, sessão sem csrfToken
  // chamava next() (fail-open) — este teste falha nesse código antigo.
  it('fail-closed: nega POST quando a sessão não tem csrfToken (403)', () => {
    const next = vi.fn();
    const res = mockRes();
    const req = { method: 'POST', session: {}, headers: {} };
    csrfProtection(req as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });
});
