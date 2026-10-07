import { describe, it, expect, vi, beforeEach } from 'vitest';

// ACXEGDP-409 / migration 0054: o POST /admin/nf-pedido-mapa recebe a aba inteira da FUP de
// hora em hora. Reenviar o mesmo mapa não pode criar linha nova — antes, pedido
// concluído (mapa inativo) virava um mapa NOVO a cada carga (30,8 mil linhas
// para 70 pedidos em PROD). As duas tabelas são simuladas em memória: cada SQL
// que o serviço emite é interpretado aqui, e SQL desconhecido derruba o teste.

interface MapaFake {
  id: string;
  pedido: string;
  nf_mae: string;
  ativo: boolean;
  importado_em: number;
  updated_at: number;
}
interface FilhoteFake {
  mapa_id: string;
  nf: string;
  posicao: number;
  ativo: boolean;
}

let mapas: MapaFake[];
let filhotes: FilhoteFake[];
/** NFs filhote recebidas (OMIE, movimentacao ou legado — a query de pendência resolve isso). */
let recebidas: Set<string>;
/** INSERT/UPDATE emitidos na carga corrente. */
let escritas: string[];
let relogio: number;
let seq: number;

function filhotesAtivas(mapaId: string): FilhoteFake[] {
  return filhotes
    .filter((f) => f.mapa_id === mapaId && f.ativo)
    .sort((a, b) => a.posicao - b.posicao || a.nf.localeCompare(b.nf));
}

function executar(sql: string, params: unknown[] = []): { rows: unknown[] } {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };

  if (s.startsWith('SELECT id, nf_mae, ativo FROM stockbridge.nf_pedido_mapa') && s.includes('FOR UPDATE')) {
    const [pedido] = params as [string];
    const linha = mapas
      .filter((m) => m.pedido === pedido)
      .sort(
        (a, b) =>
          Number(b.ativo) - Number(a.ativo) ||
          b.importado_em - a.importado_em ||
          b.updated_at - a.updated_at ||
          b.id.localeCompare(a.id),
      )[0];
    return { rows: linha ? [{ id: linha.id, nf_mae: linha.nf_mae, ativo: linha.ativo }] : [] };
  }
  if (s.startsWith('INSERT INTO stockbridge.nf_pedido_mapa')) {
    const [pedido, nfMae] = params as [string, string];
    const id = `mapa-${++seq}`;
    relogio++;
    mapas.push({ id, pedido, nf_mae: nfMae, ativo: true, importado_em: relogio, updated_at: relogio });
    escritas.push(s);
    return { rows: [{ id }] };
  }
  if (s.startsWith('SELECT nf_filhote, posicao FROM stockbridge.nf_pedido_filhote')) {
    const [mapaId] = params as [string];
    return { rows: filhotesAtivas(mapaId).map((f) => ({ nf_filhote: f.nf, posicao: f.posicao })) };
  }
  if (s.startsWith('UPDATE stockbridge.nf_pedido_mapa SET nf_mae')) {
    const [mapaId, nfMae] = params as [string, string];
    const m = mapas.find((x) => x.id === mapaId)!;
    m.nf_mae = nfMae;
    m.updated_at = ++relogio;
    escritas.push(s);
    return { rows: [] };
  }
  if (s.startsWith('UPDATE stockbridge.nf_pedido_filhote SET ativo = false')) {
    const [mapaId] = params as [string];
    filhotes.filter((f) => f.mapa_id === mapaId).forEach((f) => (f.ativo = false));
    escritas.push(s);
    return { rows: [] };
  }
  if (s.startsWith('INSERT INTO stockbridge.nf_pedido_filhote')) {
    const [mapaId, nf, posicao] = params as [string, string, number];
    filhotes.push({ mapa_id: mapaId, nf, posicao, ativo: true });
    escritas.push(s);
    return { rows: [] };
  }
  if (s.startsWith('SELECT EXISTS')) {
    const [mapaId] = params as [string];
    return { rows: [{ pendente: filhotesAtivas(mapaId).some((f) => !recebidas.has(f.nf)) }] };
  }
  const situacao = /^UPDATE stockbridge\.nf_pedido_mapa SET ativo = (true|false)/.exec(s);
  if (situacao) {
    const [mapaId] = params as [string];
    const m = mapas.find((x) => x.id === mapaId)!;
    m.ativo = situacao[1] === 'true';
    m.updated_at = ++relogio;
    escritas.push(s);
    return { rows: [] };
  }
  throw new Error(`SQL inesperado no fake: ${s.slice(0, 120)}`);
}

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getPool: () => ({
    query: (sql: string, params?: unknown[]) => Promise.resolve(executar(sql, params)),
    connect: () =>
      Promise.resolve({
        query: (sql: string, params?: unknown[]) => Promise.resolve(executar(sql, params)),
        release: vi.fn(),
      }),
  }),
}));

import { upsertNfPedidoMapa, type NfPedidoMapaInput } from '../services/nf-pedido-mapa.service.js';

/** Uma carga do n8n: zera o registro de escritas antes de enviar. */
async function carga(items: NfPedidoMapaInput[]) {
  escritas = [];
  return upsertNfPedidoMapa(items);
}

function mapasDo(pedido: string): MapaFake[] {
  return mapas.filter((m) => m.pedido === pedido);
}

function nfsAtivas(pedido: string): string[] {
  const [m] = mapasDo(pedido);
  return m ? filhotesAtivas(m.id).map((f) => f.nf) : [];
}

const PEDIDO_499: NfPedidoMapaInput = {
  pedido: '499',
  nf_mae: '5204',
  nf_filhotes: ['5212', '5213', '5214', '5215', '5218', '5219'],
};
const PEDIDO_545: NfPedidoMapaInput = { pedido: '545', nf_mae: '5556', nf_filhotes: ['5659', '5660'] };

beforeEach(() => {
  mapas = [];
  filhotes = [];
  recebidas = new Set();
  escritas = [];
  relogio = 0;
  seq = 0;
});

describe('upsertNfPedidoMapa — um mapa por pedido (migration 0054)', () => {
  it('o mesmo payload enviado duas vezes: a 2ª carga dá 0 inseridos e não grava nada', async () => {
    PEDIDO_499.nf_filhotes.forEach((nf) => recebidas.add(nf)); // 499 concluído, 545 pendente

    const primeira = await carga([PEDIDO_499, PEDIDO_545]);
    expect(primeira).toEqual({ inseridos: 2, atualizados: 0, inalterados: 0, reabertos: 0, concluidos: 1 });

    const segunda = await carga([PEDIDO_499, PEDIDO_545]);
    expect(segunda).toEqual({ inseridos: 0, atualizados: 0, inalterados: 2, reabertos: 0, concluidos: 0 });
    expect(escritas).toEqual([]);
    expect(mapas).toHaveLength(2);
    expect(mapasDo('499')[0]!.ativo).toBe(false);
    expect(mapasDo('545')[0]!.ativo).toBe(true);
  });

  it('pedido concluído reenviado a cada hora continua com UMA linha e as mesmas filhotes', async () => {
    PEDIDO_499.nf_filhotes.forEach((nf) => recebidas.add(nf));

    for (let hora = 0; hora < 11; hora++) await carga([PEDIDO_499]);

    expect(mapasDo('499')).toHaveLength(1);
    expect(mapasDo('499')[0]!.ativo).toBe(false);
    // 6 filhotes da 1ª carga, nenhuma regravada depois
    expect(filhotes).toHaveLength(6);
    expect(nfsAtivas('499')).toEqual(PEDIDO_499.nf_filhotes);
  });

  it('filhote nova depois do fechamento: a MESMA linha é reaberta e recebe as filhotes novas', async () => {
    recebidas = new Set(['5659', '5660']);
    await carga([PEDIDO_545]);
    const [fechado] = mapasDo('545');
    expect(fechado!.ativo).toBe(false);

    const comFilhoteNova = { ...PEDIDO_545, nf_filhotes: ['5659', '5660', '5661'] };
    const r = await carga([comFilhoteNova]);

    expect(r).toEqual({ inseridos: 0, atualizados: 1, inalterados: 0, reabertos: 1, concluidos: 0 });
    expect(mapasDo('545')).toHaveLength(1);
    expect(mapasDo('545')[0]!.id).toBe(fechado!.id);
    expect(mapasDo('545')[0]!.ativo).toBe(true);
    expect(nfsAtivas('545')).toEqual(['5659', '5660', '5661']);
    // as filhotes anteriores ficam como histórico (soft delete)
    expect(filhotes.filter((f) => !f.ativo).map((f) => f.nf)).toEqual(['5659', '5660']);

    // a filhote nova chega ao galpão: a carga seguinte fecha o mapa de novo, sem regravar filhotes
    recebidas.add('5661');
    const depois = await carga([comFilhoteNova]);
    expect(depois).toEqual({ inseridos: 0, atualizados: 0, inalterados: 1, reabertos: 0, concluidos: 1 });
    expect(escritas.filter((e) => e.includes('nf_pedido_filhote'))).toEqual([]);
    expect(mapasDo('545')).toHaveLength(1);
  });

  it('filhote nova que já chegou recebida: atualiza as filhotes sem reabrir o mapa', async () => {
    recebidas = new Set(['5659', '5660', '5661']);
    await carga([PEDIDO_545]);

    const r = await carga([{ ...PEDIDO_545, nf_filhotes: ['5659', '5660', '5661'] }]);

    expect(r).toEqual({ inseridos: 0, atualizados: 1, inalterados: 0, reabertos: 0, concluidos: 0 });
    expect(mapasDo('545')[0]!.ativo).toBe(false);
    expect(nfsAtivas('545')).toEqual(['5659', '5660', '5661']);
  });

  it('só a NF mãe mudou: atualiza a mesma linha e não mexe nas filhotes', async () => {
    await carga([PEDIDO_545]);

    const r = await carga([{ ...PEDIDO_545, nf_mae: '5557' }]);

    expect(r).toEqual({ inseridos: 0, atualizados: 1, inalterados: 0, reabertos: 0, concluidos: 0 });
    expect(mapasDo('545')).toHaveLength(1);
    expect(mapasDo('545')[0]!.nf_mae).toBe('5557');
    expect(escritas.filter((e) => e.includes('nf_pedido_filhote'))).toEqual([]);
  });

  it('a posição faz parte do conteúdo: a mesma NF em outra coluna da FUP é atualização', async () => {
    await carga([PEDIDO_545]);

    const r = await carga([{ ...PEDIDO_545, nf_filhotes: ['5660', '5659'] }]);

    expect(r.atualizados).toBe(1);
    expect(nfsAtivas('545')).toEqual(['5660', '5659']);
  });

  it('recebimento desfeito (movimentação desativada): o mapa concluído reabre sem regravar o conteúdo', async () => {
    recebidas = new Set(['5659', '5660']);
    await carga([PEDIDO_545]);
    expect(mapasDo('545')[0]!.ativo).toBe(false);

    recebidas.delete('5660');
    const r = await carga([PEDIDO_545]);

    expect(r).toEqual({ inseridos: 0, atualizados: 0, inalterados: 1, reabertos: 1, concluidos: 0 });
    expect(mapasDo('545')[0]!.ativo).toBe(true);
    expect(escritas).toHaveLength(1);
    expect(escritas[0]).toContain('SET ativo = true');
  });

  it('pedido só com NF mãe (sem filhote ainda) fica ativo e é inalterado na carga seguinte', async () => {
    const soMae = { pedido: '554', nf_mae: '5790', nf_filhotes: [] };

    expect(await carga([soMae])).toEqual({ inseridos: 1, atualizados: 0, inalterados: 0, reabertos: 0, concluidos: 0 });
    expect(await carga([soMae])).toEqual({ inseridos: 0, atualizados: 0, inalterados: 1, reabertos: 0, concluidos: 0 });
    expect(mapasDo('554')).toHaveLength(1);
    expect(mapasDo('554')[0]!.ativo).toBe(true);
  });

  it('com duplicatas antigas ainda no banco (antes da 0054): usa a mais recente e não cria outra', async () => {
    recebidas = new Set(PEDIDO_499.nf_filhotes);
    for (let i = 1; i <= 3; i++) {
      relogio++;
      mapas.push({ id: `antigo-${i}`, pedido: '499', nf_mae: '5204', ativo: false, importado_em: relogio, updated_at: relogio });
      PEDIDO_499.nf_filhotes.forEach((nf, p) =>
        filhotes.push({ mapa_id: `antigo-${i}`, nf, posicao: p + 1, ativo: true }),
      );
    }

    const r = await carga([PEDIDO_499]);

    expect(r).toEqual({ inseridos: 0, atualizados: 0, inalterados: 1, reabertos: 0, concluidos: 0 });
    expect(mapasDo('499')).toHaveLength(3);
    expect(escritas).toEqual([]);
  });

  it('com duplicatas antigas, a linha ativa tem precedência sobre as inativas mais novas', async () => {
    relogio++;
    mapas.push({ id: 'ativo', pedido: '545', nf_mae: '5556', ativo: true, importado_em: relogio, updated_at: relogio });
    relogio++;
    mapas.push({ id: 'inativo-novo', pedido: '545', nf_mae: '5556', ativo: false, importado_em: relogio, updated_at: relogio });

    const r = await carga([PEDIDO_545]);

    // a ativa não tinha filhotes: recebe as do payload (as da inativa não contam)
    expect(r.atualizados).toBe(1);
    expect(filhotes.filter((f) => f.ativo).every((f) => f.mapa_id === 'ativo')).toBe(true);
  });
});
