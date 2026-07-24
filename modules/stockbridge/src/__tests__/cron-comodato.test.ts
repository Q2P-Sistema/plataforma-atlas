import { describe, it, expect, vi, beforeEach } from 'vitest';

// EML-13: o cron diário deve mandar 1 digest por destinatário, não 1 e-mail por
// comodato. Aqui mockamos a camada de notificação e só exercitamos o agrupamento.

const { rowsMock } = vi.hoisted(() => ({ rowsMock: vi.fn() }));

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => ({ execute: () => rowsMock() }),
}));

const digestMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/notificacao.service.js', () => ({
  enviarDigestComodatosVencidos: (args: unknown) => digestMock(args),
  resolverEmailOperador: vi.fn().mockResolvedValue('operador@acxe.local'),
  resolverEmailsAprovadores: vi.fn().mockResolvedValue(['gestor@acxe.local']),
}));

import { processarAlertasComodatoVencido } from '../services/cron-comodato.service.js';

function comodatoRow(over: Record<string, unknown>) {
  return {
    movimentacao_id: 'm?',
    produto_codigo_acxe: '100',
    produto_descricao: 'PP H301',
    galpao_origem: '11',
    cliente: 'Cliente',
    quantidade_kg: '500',
    dt_saida: '2026-05-01',
    dt_prevista_retorno: '2026-06-01',
    criado_por: 'u1',
    dias_vencido: '1',
    ...over,
  };
}

beforeEach(() => {
  digestMock.mockClear();
  rowsMock.mockReset();
});

describe('cron-comodato — EML-13 agrupamento por destinatário', () => {
  it('2 comodatos (mesmo operador+gestor) → 1 digest por destinatário, cada um com os 2', async () => {
    rowsMock.mockResolvedValue({
      rows: [
        comodatoRow({ movimentacao_id: 'a', cliente: 'Cliente A', dias_vencido: '1' }),
        comodatoRow({ movimentacao_id: 'b', cliente: 'Cliente B', dias_vencido: '1' }),
      ],
    });

    const res = await processarAlertasComodatoVencido();

    // 2 destinatários distintos (operador + gestor) → 2 digests, NÃO 4 e-mails.
    expect(digestMock).toHaveBeenCalledTimes(2);
    const tos = digestMock.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(new Set(tos)).toEqual(new Set(['operador@acxe.local', 'gestor@acxe.local']));

    // Cada digest carrega os 2 comodatos.
    for (const call of digestMock.mock.calls) {
      const arg = call[0] as { comodatos: unknown[] };
      expect(arg.comodatos).toHaveLength(2);
    }

    // 'notificados' conta comodatos notificados (2), não e-mails.
    expect(res).toMatchObject({ total: 2, notificados: 2 });
  });

  it('comodato fora do dia de escala (D+7) não notifica', async () => {
    rowsMock.mockResolvedValue({ rows: [comodatoRow({ dias_vencido: '7' })] });
    const res = await processarAlertasComodatoVencido();
    expect(digestMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ total: 1, notificados: 0 });
  });
});
