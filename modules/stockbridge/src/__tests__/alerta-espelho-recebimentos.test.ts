import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 016 (revisao pre-UAT, ROT-6/SPEC016-10): a spec exige ALERTA quando o
// espelho de recebimentos passa do limite. Cron a cada 30 min -> e-mail ao ops,
// com reaviso a cada 6 h enquanto durar e nada com a flag desligada.

const idadeMock = vi.fn();
const alertaSpy = vi.fn().mockResolvedValue(undefined);

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../services/fila-nacional.service.js', () => ({
  idadeEspelhoRecebimentos: () => idadeMock(),
}));
vi.mock('../services/notificacao.service.js', () => ({
  enviarAlertaEspelhoRecebimentosDefasado: (a: unknown) => alertaSpy(a),
}));

import { verificarEspelhoRecebimentos, __resetAlertaEspelho, REALERTA_ESPELHO_MS } from '../services/alerta-espelho-recebimentos.service.js';

const T0 = Date.parse('2026-10-02T15:00:00Z');

beforeEach(() => {
  __resetAlertaEspelho();
  idadeMock.mockReset();
  alertaSpy.mockClear();
});

describe('verificarEspelhoRecebimentos', () => {
  it('flag desligada: nada a verificar, nenhum e-mail', async () => {
    idadeMock.mockResolvedValue({ idadeMin: null, status: 'desligado' });
    expect(await verificarEspelhoRecebimentos(T0)).toBe('desligado');
    expect(alertaSpy).not.toHaveBeenCalled();
  });

  it('defasado: alerta uma vez, suprime por 6 h, realerta depois; normalizou -> reseta e volta a alertar na proxima defasagem', async () => {
    idadeMock.mockResolvedValue({ idadeMin: 185, status: 'degraded', limiteMin: 120 });
    expect(await verificarEspelhoRecebimentos(T0)).toBe('alertado');
    expect(alertaSpy).toHaveBeenCalledWith({ status: 'degraded', idadeMin: 185, limiteMin: 120 });
    expect(await verificarEspelhoRecebimentos(T0 + 30 * 60_000)).toBe('suprimido');
    expect(await verificarEspelhoRecebimentos(T0 + REALERTA_ESPELHO_MS + 1)).toBe('alertado');
    expect(alertaSpy).toHaveBeenCalledTimes(2);

    idadeMock.mockResolvedValue({ idadeMin: 12, status: 'ok', limiteMin: 120 });
    expect(await verificarEspelhoRecebimentos(T0 + REALERTA_ESPELHO_MS + 60_000)).toBe('ok');
    idadeMock.mockResolvedValue({ idadeMin: null, status: 'sem_dados', limiteMin: 120 });
    expect(await verificarEspelhoRecebimentos(T0 + REALERTA_ESPELHO_MS + 120_000)).toBe('alertado');
    expect(alertaSpy).toHaveBeenLastCalledWith({ status: 'sem_dados', idadeMin: null, limiteMin: 120 });
  });

  it('espelho inacessivel (tabela ausente) tambem alerta', async () => {
    idadeMock.mockResolvedValue({ idadeMin: null, status: 'indisponivel', limiteMin: 120 });
    expect(await verificarEspelhoRecebimentos(T0)).toBe('alertado');
  });
});
