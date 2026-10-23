import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — o job do cron `5,35 * * * *` vigia o espelho de recebimentos de NF-e e a
// copia de pedidos de compra POR EMPRESA, cada um com o seu estado de reaviso: a defasagem da ACXE nao suprime a da
// Q2P nem o contrario, e o aviso da ACXE so existe com a compra nacional da ACXE habilitada (a leitura da idade
// devolve 'desligado' sem ela e nada e enviado). O job continua aceitando a assinatura anterior (so o `agora`).
// O texto dos e-mails esta em notificacao-alertas-espelho-acxe.test.ts; o comportamento da Q2P sozinha, em
// alerta-espelho-recebimentos.test.ts.

const idadeEspelho = vi.fn();
const idadeCopia = vi.fn();
const alertaEspelho = vi.fn().mockResolvedValue(true);
const alertaCopia = vi.fn().mockResolvedValue(true);
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('@atlas/core', () => ({ createLogger: () => logger }));
vi.mock('../services/fila-nacional.service.js', () => ({
  idadeEspelhoRecebimentos: (empresa?: string) => idadeEspelho(empresa),
  idadeCopiaPcs: (empresa?: string) => idadeCopia(empresa),
}));
vi.mock('../services/notificacao.service.js', () => ({
  enviarAlertaEspelhoRecebimentosDefasado: (a: unknown, empresa?: string) => alertaEspelho(a, empresa),
  enviarAlertaCopiaPcsDefasada: (a: unknown, empresa?: string) => alertaCopia(a, empresa),
}));

import {
  verificarEspelhoRecebimentos,
  verificarCopiaPcs,
  __resetAlertaEspelho,
  REALERTA_ESPELHO_MS,
} from '../services/alerta-espelho-recebimentos.service.js';

const T0 = Date.parse('2026-10-23T15:00:00Z');
const MIN = 60_000;
const VELHO = { idadeMin: 185, status: 'degraded' as const, limiteMin: 120 };
const EM_DIA = { idadeMin: 10, status: 'ok' as const, limiteMin: 120 };
const DESLIGADO = { idadeMin: null, status: 'desligado' as const };

/** idade por empresa: `{ q2p: ..., acxe: ... }` */
const idades = (q2p: unknown, acxe: unknown) => (empresa?: string) => Promise.resolve(empresa === 'acxe' ? acxe : q2p);

beforeEach(() => {
  __resetAlertaEspelho();
  for (const f of [idadeEspelho, idadeCopia, alertaEspelho, alertaCopia]) f.mockReset();
  alertaEspelho.mockResolvedValue(true);
  alertaCopia.mockResolvedValue(true);
  for (const f of Object.values(logger)) f.mockClear();
});

describe('a empresa chega ate a leitura da idade e ao e-mail', () => {
  it('verificarEspelhoRecebimentos("acxe") le a idade da ACXE e o alerta sai com a empresa', async () => {
    idadeEspelho.mockImplementation(idades(EM_DIA, VELHO));
    expect(await verificarEspelhoRecebimentos('acxe', T0)).toBe('alertado');
    expect(idadeEspelho).toHaveBeenCalledTimes(1);
    expect(idadeEspelho).toHaveBeenCalledWith('acxe');
    expect(alertaEspelho).toHaveBeenCalledWith({ status: 'degraded', idadeMin: 185, limiteMin: 120 }, 'acxe');
  });

  it('verificarCopiaPcs("acxe") idem para a copia de pedidos de compra', async () => {
    idadeCopia.mockImplementation(idades(EM_DIA, { idadeMin: 300, status: 'degraded', limiteMin: 120 }));
    expect(await verificarCopiaPcs('acxe', T0)).toBe('alertado');
    expect(idadeCopia).toHaveBeenCalledWith('acxe');
    expect(alertaCopia).toHaveBeenCalledWith({ status: 'degraded', idadeMin: 300, limiteMin: 120 }, 'acxe');
  });

  it('sem argumento e a Q2P (o cron da Q2P de antes)', async () => {
    idadeEspelho.mockImplementation(idades(VELHO, EM_DIA));
    expect(await verificarEspelhoRecebimentos()).toBe('alertado');
    expect(idadeEspelho).toHaveBeenCalledWith('q2p');
    expect(alertaEspelho).toHaveBeenCalledWith(expect.anything(), 'q2p');
  });

  it('a assinatura anterior (so o `agora`, numerico) continua valendo e significa Q2P', async () => {
    idadeEspelho.mockImplementation(idades(VELHO, VELHO));
    idadeCopia.mockImplementation(idades(VELHO, VELHO));
    expect(await verificarEspelhoRecebimentos(T0)).toBe('alertado');
    expect(await verificarEspelhoRecebimentos(T0 + 30 * MIN)).toBe('suprimido');
    expect(await verificarEspelhoRecebimentos(T0 + REALERTA_ESPELHO_MS + 1)).toBe('alertado');
    expect(await verificarCopiaPcs(T0)).toBe('alertado');
    expect(idadeEspelho.mock.calls.every((c) => c[0] === 'q2p')).toBe(true);
    expect(idadeCopia.mock.calls.every((c) => c[0] === 'q2p')).toBe(true);
    expect(alertaEspelho.mock.calls.every((c) => c[1] === 'q2p')).toBe(true);
  });

  it('empresa e `agora` explicitos (a forma da Historia 5) controlam o reaviso da ACXE', async () => {
    idadeEspelho.mockImplementation(idades(EM_DIA, VELHO));
    expect(await verificarEspelhoRecebimentos('acxe', T0)).toBe('alertado');
    expect(await verificarEspelhoRecebimentos('acxe', T0 + 30 * MIN)).toBe('suprimido');
    expect(await verificarEspelhoRecebimentos('acxe', T0 + REALERTA_ESPELHO_MS + 1)).toBe('alertado');
    expect(alertaEspelho).toHaveBeenCalledTimes(2);
  });

  it('sem `agora`, usa o relogio atual', async () => {
    idadeEspelho.mockImplementation(idades(VELHO, VELHO));
    expect(await verificarEspelhoRecebimentos('acxe')).toBe('alertado');
    expect(await verificarEspelhoRecebimentos('acxe')).toBe('suprimido');
  });
});

describe('ACXE desligada: nada a verificar, nenhum e-mail', () => {
  it('a idade devolve "desligado" para a ACXE (sem a chave, o fiscal pelo Atlas ou o corte) -> o job nao faz nada', async () => {
    idadeEspelho.mockImplementation(idades(EM_DIA, DESLIGADO));
    idadeCopia.mockImplementation(idades(EM_DIA, DESLIGADO));
    expect(await verificarEspelhoRecebimentos('acxe', T0)).toBe('desligado');
    expect(await verificarCopiaPcs('acxe', T0)).toBe('desligado');
    expect(alertaEspelho).not.toHaveBeenCalled();
    expect(alertaCopia).not.toHaveBeenCalled();
  });

  it('o espelho vazio da ACXE (n8n ainda inativo) nao vira alerta enquanto a ACXE esta desligada', async () => {
    idadeEspelho.mockImplementation(idades(EM_DIA, DESLIGADO));
    for (let i = 0; i < 4; i++) expect(await verificarEspelhoRecebimentos('acxe', T0 + i * 30 * MIN)).toBe('desligado');
    expect(alertaEspelho).not.toHaveBeenCalled();
  });

  it('ligada e com o espelho vazio ou inacessivel: ai sim alerta (a ACXE foi ligada sem o n8n pronto)', async () => {
    idadeEspelho.mockImplementation(idades(EM_DIA, { idadeMin: null, status: 'sem_dados', limiteMin: 120 }));
    expect(await verificarEspelhoRecebimentos('acxe', T0)).toBe('alertado');
    __resetAlertaEspelho();
    idadeEspelho.mockImplementation(idades(EM_DIA, { idadeMin: null, status: 'indisponivel', limiteMin: 120 }));
    expect(await verificarEspelhoRecebimentos('acxe', T0)).toBe('alertado');
    expect(alertaEspelho).toHaveBeenLastCalledWith({ status: 'indisponivel', idadeMin: null, limiteMin: 120 }, 'acxe');
  });
});

describe('estado de reaviso independente por empresa', () => {
  it('Q2P alertada nao suprime a ACXE: cada uma recebe o seu primeiro aviso', async () => {
    idadeEspelho.mockImplementation(idades(VELHO, VELHO));
    expect(await verificarEspelhoRecebimentos('q2p', T0)).toBe('alertado');
    expect(await verificarEspelhoRecebimentos('acxe', T0 + MIN)).toBe('alertado');
    expect(alertaEspelho).toHaveBeenCalledTimes(2);
    expect(alertaEspelho.mock.calls.map((c) => c[1])).toEqual(['q2p', 'acxe']);
  });

  it('cada empresa tem a SUA janela de 6 h: a ACXE alertada depois so volta a alertar 6 h depois do SEU aviso', async () => {
    idadeEspelho.mockImplementation(idades(VELHO, VELHO));
    await verificarEspelhoRecebimentos('q2p', T0);
    await verificarEspelhoRecebimentos('acxe', T0 + 3 * 60 * MIN);
    // 6 h depois do aviso da Q2P: ela realerta; a ACXE (avisada 3 h depois) ainda esta suprimida
    expect(await verificarEspelhoRecebimentos('q2p', T0 + REALERTA_ESPELHO_MS + 1)).toBe('alertado');
    expect(await verificarEspelhoRecebimentos('acxe', T0 + REALERTA_ESPELHO_MS + 1)).toBe('suprimido');
    expect(await verificarEspelhoRecebimentos('acxe', T0 + 3 * 60 * MIN + REALERTA_ESPELHO_MS + 1)).toBe('alertado');
  });

  it('a Q2P normalizar nao zera o controle da ACXE (e vice-versa)', async () => {
    idadeEspelho.mockImplementation(idades(VELHO, VELHO));
    await verificarEspelhoRecebimentos('q2p', T0);
    await verificarEspelhoRecebimentos('acxe', T0);
    idadeEspelho.mockImplementation(idades(EM_DIA, VELHO));
    expect(await verificarEspelhoRecebimentos('q2p', T0 + 30 * MIN)).toBe('ok');
    expect(await verificarEspelhoRecebimentos('acxe', T0 + 30 * MIN)).toBe('suprimido');
    // a ACXE normaliza: zera so o dela; a proxima defasagem da Q2P ja nao encontra controle (normalizou antes)
    idadeEspelho.mockImplementation(idades(VELHO, EM_DIA));
    expect(await verificarEspelhoRecebimentos('acxe', T0 + 60 * MIN)).toBe('ok');
    expect(await verificarEspelhoRecebimentos('q2p', T0 + 60 * MIN)).toBe('alertado');
  });

  it('espelho e copia de PCs tambem sao independentes dentro da mesma empresa (4 controles)', async () => {
    idadeEspelho.mockImplementation(idades(VELHO, VELHO));
    idadeCopia.mockImplementation(idades(VELHO, VELHO));
    expect(await verificarEspelhoRecebimentos('acxe', T0)).toBe('alertado');
    expect(await verificarCopiaPcs('acxe', T0)).toBe('alertado');
    expect(await verificarEspelhoRecebimentos('q2p', T0)).toBe('alertado');
    expect(await verificarCopiaPcs('q2p', T0)).toBe('alertado');
    expect(alertaEspelho).toHaveBeenCalledTimes(2);
    expect(alertaCopia).toHaveBeenCalledTimes(2);
    // segunda rodada: todos suprimidos
    for (const empresa of ['q2p', 'acxe'] as const) {
      expect(await verificarEspelhoRecebimentos(empresa, T0 + 30 * MIN)).toBe('suprimido');
      expect(await verificarCopiaPcs(empresa, T0 + 30 * MIN)).toBe('suprimido');
    }
  });

  it('falha de envio da ACXE nao suprime o reaviso dela (a rodada seguinte tenta de novo) e nao mexe no controle da Q2P', async () => {
    idadeEspelho.mockImplementation(idades(VELHO, VELHO));
    expect(await verificarEspelhoRecebimentos('q2p', T0)).toBe('alertado');
    alertaEspelho.mockResolvedValueOnce(false);
    expect(await verificarEspelhoRecebimentos('acxe', T0)).toBe('falha');
    expect(await verificarEspelhoRecebimentos('acxe', T0 + 30 * MIN)).toBe('alertado');
    expect(await verificarEspelhoRecebimentos('acxe', T0 + 60 * MIN)).toBe('suprimido');
    expect(await verificarEspelhoRecebimentos('q2p', T0 + 60 * MIN)).toBe('suprimido');
  });

  it('sender da ACXE que lanca e tratado como falha de envio (sem suprimir)', async () => {
    idadeCopia.mockImplementation(idades(EM_DIA, VELHO));
    alertaCopia.mockRejectedValueOnce(new Error('smtp down'));
    expect(await verificarCopiaPcs('acxe', T0)).toBe('falha');
    expect(await verificarCopiaPcs('acxe', T0 + 30 * MIN)).toBe('alertado');
  });

  it('__resetAlertaEspelho zera o controle das DUAS empresas', async () => {
    idadeEspelho.mockImplementation(idades(VELHO, VELHO));
    idadeCopia.mockImplementation(idades(VELHO, VELHO));
    await verificarEspelhoRecebimentos('q2p', T0);
    await verificarEspelhoRecebimentos('acxe', T0);
    await verificarCopiaPcs('q2p', T0);
    await verificarCopiaPcs('acxe', T0);
    __resetAlertaEspelho();
    expect(await verificarEspelhoRecebimentos('q2p', T0 + MIN)).toBe('alertado');
    expect(await verificarEspelhoRecebimentos('acxe', T0 + MIN)).toBe('alertado');
    expect(await verificarCopiaPcs('q2p', T0 + MIN)).toBe('alertado');
    expect(await verificarCopiaPcs('acxe', T0 + MIN)).toBe('alertado');
  });
});

describe('log do job: a empresa aparece no que e da ACXE; o da Q2P segue como era', () => {
  const avisos = () => logger.warn.mock.calls.filter((c) => String(c[1]).includes('defasado — alertando'));

  it('espelho: o rotulo da ACXE leva "(ACXE)" e o dado do log leva a empresa; o da Q2P nao leva sufixo', async () => {
    idadeEspelho.mockImplementation(idades(VELHO, VELHO));
    await verificarEspelhoRecebimentos('q2p', T0);
    await verificarEspelhoRecebimentos('acxe', T0);
    expect(avisos().map((c) => c[1])).toEqual([
      'Espelho de recebimentos de NF-e defasado — alertando',
      'Espelho de recebimentos de NF-e (ACXE) defasado — alertando',
    ]);
    expect(avisos().map((c) => (c[0] as { empresa: string }).empresa)).toEqual(['q2p', 'acxe']);
  });

  it('copia de pedidos de compra idem', async () => {
    idadeCopia.mockImplementation(idades(VELHO, VELHO));
    await verificarCopiaPcs('q2p', T0);
    await verificarCopiaPcs('acxe', T0);
    expect(avisos().map((c) => c[1])).toEqual(['Cópia de pedidos de compra defasado — alertando', 'Cópia de pedidos de compra (ACXE) defasado — alertando']);
  });

  it('normalizacao so e registrada para a empresa que tinha sido alertada', async () => {
    idadeEspelho.mockImplementation(idades(VELHO, EM_DIA));
    await verificarEspelhoRecebimentos('q2p', T0);
    idadeEspelho.mockImplementation(idades(EM_DIA, EM_DIA));
    await verificarEspelhoRecebimentos('acxe', T0 + MIN); // nunca alertada: nada a registrar
    expect(logger.info).not.toHaveBeenCalled();
    await verificarEspelhoRecebimentos('q2p', T0 + 2 * MIN);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]![1]).toBe('Espelho de recebimentos de NF-e normalizado');
  });
});
