import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: any[]) => args),
  and: vi.fn((...args: any[]) => args),
}));

vi.mock('@atlas/db', () => ({
  users: { id: 'id' },
  userModules: { userId: 'userId', moduleKey: 'moduleKey' },
  sessions: { id: 'id' },
}));

const configMock = {
  MODULE_HEDGE_ENABLED: true,
  MODULE_STOCKBRIDGE_ENABLED: false,
  MODULE_BREAKINGPOINT_ENABLED: true,
  MODULE_CLEVEL_ENABLED: false,
  MODULE_COMEXINSIGHT_ENABLED: false,
  MODULE_COMEXFLOW_ENABLED: false,
  MODULE_FORECAST_ENABLED: false,
};

let dbResult: Array<{ moduleKey: string }> = [];

vi.mock('@atlas/core', () => ({
  getConfig: () => configMock,
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(dbResult),
        }),
      }),
    }),
  }),
}));

const { requireModule } = await import('@atlas/auth');

function fakeReq(overrides: Partial<Request> = {}): Request {
  return { ...overrides } as Request;
}

function fakeRes() {
  const res: Partial<Response> & { status: any; json: any } = {
    status: vi.fn().mockReturnThis() as any,
    json: vi.fn().mockReturnThis() as any,
  };
  return res as Response & { status: any; json: any };
}

describe('requireModule', () => {
  beforeEach(() => {
    dbResult = [];
  });

  it('returns 401 when no user on request', async () => {
    const res = fakeRes();
    const next = vi.fn() as NextFunction;
    const mw = requireModule('hedge');

    mw(fakeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 404 when module is globally disabled', async () => {
    const res = fakeRes();
    const next = vi.fn() as NextFunction;
    const mw = requireModule('stockbridge'); // disabled in configMock

    mw(
      fakeReq({ user: { id: 'u1', role: 'operador' } as any }),
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets diretor through without checking grants', async () => {
    const res = fakeRes();
    const next = vi.fn() as NextFunction;
    const mw = requireModule('hedge');

    mw(
      fakeReq({ user: { id: 'd1', role: 'diretor' } as any }),
      res,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 when operador has no grant', async () => {
    dbResult = []; // no rows
    const res = fakeRes();
    const next = vi.fn() as NextFunction;
    const mw = requireModule('hedge');

    await mw(
      fakeReq({ user: { id: 'op1', role: 'operador' } as any }),
      res,
      next,
    );
    // Wait for the .then promise chain
    await new Promise((r) => setImmediate(r));

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes when operador has explicit grant', async () => {
    dbResult = [{ moduleKey: 'hedge' }];
    const res = fakeRes();
    const next = vi.fn() as NextFunction;
    const mw = requireModule('hedge');

    mw(
      fakeReq({ user: { id: 'op1', role: 'operador' } as any }),
      res,
      next,
    );
    await new Promise((r) => setImmediate(r));

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
