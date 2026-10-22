import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 016 (revisao pre-UAT, ROT-6/SPEC016-10): a spec exige ALERTA quando o
// espelho de recebimentos passa do limite. Cron a cada 30 min -> e-mail ao ops,
// com reaviso a cada 6 h enquanto durar e nada com a flag desligada.

const idadeMock = vi.fn();
// Os senders devolvem true quando o e-mail foi entregue ao provedor e false quando falhou (infra-03).
const alertaSpy = vi.fn().mockResolvedValue(true);
// Feature 017 (D13): a copia de PCs tem idade e alerta proprios.
const idadeCopiaMock = vi.fn();
const alertaCopiaSpy = vi.fn().mockResolvedValue(true);

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../services/fila-nacional.service.js', () => ({
  idadeEspelhoRecebimentos: () => idadeMock(),
  idadeCopiaPcs: () => idadeCopiaMock(),
}));
vi.mock('../services/notificacao.service.js', () => ({
  enviarAlertaEspelhoRecebimentosDefasado: (a: unknown) => alertaSpy(a),
  enviarAlertaCopiaPcsDefasada: (a: unknown) => alertaCopiaSpy(a),
}));

import {
  verificarEspelhoRecebimentos,
  verificarCopiaPcs,
  __resetAlertaEspelho,
  REALERTA_ESPELHO_MS,
} from '../services/alerta-espelho-recebimentos.service.js';

const T0 = Date.parse('2026-10-02T15:00:00Z');

beforeEach(() => {
  __resetAlertaEspelho();
  idadeMock.mockReset();
  alertaSpy.mockReset();
  alertaSpy.mockResolvedValue(true);
  idadeCopiaMock.mockReset();
  alertaCopiaSpy.mockReset();
  alertaCopiaSpy.mockResolvedValue(true);
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

  // Revisao pos-017, infra-03: o reaviso de 6 h conta a partir da ENTREGA, nao da tentativa.
  it('falha de envio nao suprime o reaviso: a rodada seguinte (30 min depois) tenta de novo e, entregue, passa a suprimir', async () => {
    idadeMock.mockResolvedValue({ idadeMin: 185, status: 'degraded', limiteMin: 120 });
    alertaSpy.mockResolvedValueOnce(false);
    expect(await verificarEspelhoRecebimentos(T0)).toBe('falha');
    expect(alertaSpy).toHaveBeenCalledTimes(1);
    expect(await verificarEspelhoRecebimentos(T0 + 30 * 60_000)).toBe('alertado');
    expect(alertaSpy).toHaveBeenCalledTimes(2);
    expect(await verificarEspelhoRecebimentos(T0 + 60 * 60_000)).toBe('suprimido');
    expect(alertaSpy).toHaveBeenCalledTimes(2);
  });

  it('sender que lanca (nao deveria) e tratado como falha de envio, sem suprimir', async () => {
    idadeMock.mockResolvedValue({ idadeMin: 185, status: 'degraded', limiteMin: 120 });
    alertaSpy.mockRejectedValueOnce(new Error('smtp down'));
    expect(await verificarEspelhoRecebimentos(T0)).toBe('falha');
    expect(await verificarEspelhoRecebimentos(T0 + 30 * 60_000)).toBe('alertado');
  });
});

// Feature 017 (ACXEGDP-437, research D13, FR-030): a copia de pedidos de compra
// decide a sugestao de PC e o bloqueio de NF sem PC — tabela critica do Principio II.
describe('verificarCopiaPcs', () => {
  it('chave da 016 desligada: nada a verificar, nenhum e-mail', async () => {
    idadeCopiaMock.mockResolvedValue({ idadeMin: null, status: 'desligado' });
    expect(await verificarCopiaPcs(T0)).toBe('desligado');
    expect(alertaCopiaSpy).not.toHaveBeenCalled();
  });

  it('copia em dia: ok, sem e-mail', async () => {
    idadeCopiaMock.mockResolvedValue({ idadeMin: 8, status: 'ok', limiteMin: 120 });
    expect(await verificarCopiaPcs(T0)).toBe('ok');
    expect(alertaCopiaSpy).not.toHaveBeenCalled();
  });

  it('copia velha: alerta uma vez, suprime por 6 h e realerta depois', async () => {
    idadeCopiaMock.mockResolvedValue({ idadeMin: 240, status: 'degraded', limiteMin: 120 });
    expect(await verificarCopiaPcs(T0)).toBe('alertado');
    expect(alertaCopiaSpy).toHaveBeenCalledWith({ status: 'degraded', idadeMin: 240, limiteMin: 120 });
    expect(await verificarCopiaPcs(T0 + 30 * 60_000)).toBe('suprimido');
    expect(await verificarCopiaPcs(T0 + REALERTA_ESPELHO_MS + 1)).toBe('alertado');
    expect(alertaCopiaSpy).toHaveBeenCalledTimes(2);
  });

  it('copia vazia ou inacessivel tambem alerta', async () => {
    idadeCopiaMock.mockResolvedValue({ idadeMin: null, status: 'sem_dados', limiteMin: 120 });
    expect(await verificarCopiaPcs(T0)).toBe('alertado');
    __resetAlertaEspelho();
    idadeCopiaMock.mockResolvedValue({ idadeMin: null, status: 'indisponivel', limiteMin: 120 });
    expect(await verificarCopiaPcs(T0)).toBe('alertado');
    expect(alertaCopiaSpy).toHaveBeenLastCalledWith({ status: 'indisponivel', idadeMin: null, limiteMin: 120 });
  });

  it('falha de envio nao suprime o reaviso da copia: a rodada seguinte tenta de novo e, entregue, passa a suprimir (infra-03)', async () => {
    idadeCopiaMock.mockResolvedValue({ idadeMin: 240, status: 'degraded', limiteMin: 120 });
    alertaCopiaSpy.mockResolvedValueOnce(false);
    expect(await verificarCopiaPcs(T0)).toBe('falha');
    expect(await verificarCopiaPcs(T0 + 30 * 60_000)).toBe('alertado');
    expect(alertaCopiaSpy).toHaveBeenCalledTimes(2);
    expect(await verificarCopiaPcs(T0 + 60 * 60_000)).toBe('suprimido');
    expect(alertaCopiaSpy).toHaveBeenCalledTimes(2);
  });

  it('alerta entregue e depois a copia normaliza: zera o controle e o proximo problema alerta de novo', async () => {
    idadeCopiaMock.mockResolvedValue({ idadeMin: 240, status: 'degraded', limiteMin: 120 });
    expect(await verificarCopiaPcs(T0)).toBe('alertado');
    idadeCopiaMock.mockResolvedValue({ idadeMin: 8, status: 'ok', limiteMin: 120 });
    expect(await verificarCopiaPcs(T0 + 30 * 60_000)).toBe('ok');
    idadeCopiaMock.mockResolvedValue({ idadeMin: 300, status: 'degraded', limiteMin: 120 });
    expect(await verificarCopiaPcs(T0 + 60 * 60_000)).toBe('alertado');
    expect(alertaCopiaSpy).toHaveBeenCalledTimes(2);
  });

  it('falha de um nao afeta o controle do outro: espelho entregue e copia com falha', async () => {
    idadeMock.mockResolvedValue({ idadeMin: 185, status: 'degraded', limiteMin: 120 });
    idadeCopiaMock.mockResolvedValue({ idadeMin: 300, status: 'degraded', limiteMin: 120 });
    alertaCopiaSpy.mockResolvedValueOnce(false);
    expect(await verificarEspelhoRecebimentos(T0)).toBe('alertado');
    expect(await verificarCopiaPcs(T0 + 60_000)).toBe('falha');
    expect(await verificarEspelhoRecebimentos(T0 + 30 * 60_000)).toBe('suprimido');
    expect(await verificarCopiaPcs(T0 + 30 * 60_000)).toBe('alertado');
  });

  it('reaviso independente do espelho: alertar um nao suprime o outro', async () => {
    idadeMock.mockResolvedValue({ idadeMin: 185, status: 'degraded', limiteMin: 120 });
    idadeCopiaMock.mockResolvedValue({ idadeMin: 300, status: 'degraded', limiteMin: 120 });
    expect(await verificarEspelhoRecebimentos(T0)).toBe('alertado');
    expect(await verificarCopiaPcs(T0 + 60_000)).toBe('alertado');
    expect(alertaSpy).toHaveBeenCalledTimes(1);
    expect(alertaCopiaSpy).toHaveBeenCalledTimes(1);
  });
});
