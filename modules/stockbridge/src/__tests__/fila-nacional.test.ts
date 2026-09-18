import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Feature 015 (ACXEGDP-328) — fila e detalhe de NF nacional (T026, T006b, T027b).
// Fonte e o espelho Postgres; prova por inspecao do SQL gerado + mapeamento de rows.
//  - T026: exclusoes obrigatorias (CFOP, cancelada/deletada, fornecedor excluido,
//          corte temporal, ja recebida) e mapeamento.
//  - T006b: o seed de exclusao (PLASTFIX/ACXE) esta na migration 0052 e a fila
//          filtra por exclusao ATIVA (reincluido_em IS NULL).
//  - T027b: zero chamada OMIE (Principio II / FR-016).

const poolQuerySpy = vi.fn();
let dataCorte: string | undefined = '2026-09-11';

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  getConfig: () => ({ STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE: dataCorte }),
}));

const omieSpies = { incluirAjusteEstoque: vi.fn(), listarAjusteEstoque: vi.fn(), consultarNF: vi.fn() };
vi.mock('@atlas/integration-omie', () => ({
  ...omieSpies,
  isMockMode: () => false,
}));

import {
  getFilaNacional,
  getDetalheNfNacional,
  CFOPS_RECEBIMENTO_NACIONAL,
  DataCorteNaoConfiguradaError,
  NfNacionalNaoEncontradaError,
  NfNacionalCanceladaError,
  FornecedorExcluidoError,
} from '../services/fila-nacional.service.js';

const CHAVE = '35260868176072000128550010000667241693158505';

function respostaPadrao(sql: string) {
  if (sql.includes('information_schema')) return { rows: [{ ok: true }] };
  return { rows: [] };
}

beforeEach(() => {
  dataCorte = '2026-09-11';
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation((sql: string) => Promise.resolve(respostaPadrao(sql)));
  for (const s of Object.values(omieSpies)) s.mockReset();
});

/** SQL da query principal da fila (a que nao e information_schema). */
async function sqlDaFila(params: Parameters<typeof getFilaNacional>[0] = {}): Promise<{ sql: string; params: unknown[] }> {
  await getFilaNacional(params);
  const call = poolQuerySpy.mock.calls.find((c) => !String(c[0]).includes('information_schema'));
  if (!call) throw new Error('query da fila nao executada');
  return { sql: String(call[0]), params: (call[1] as unknown[]) ?? [] };
}

describe('getFilaNacional — exclusoes obrigatorias (T026)', () => {
  it('filtra CFOP do recorte, COM PONTO, via parametro (research D6)', async () => {
    const { sql, params } = await sqlDaFila();
    expect(sql).toContain('i.cfop = ANY($1::text[])');
    expect(params[0]).toEqual(['1.101', '1.102', '2.101', '2.102']);
    expect(CFOPS_RECEBIMENTO_NACIONAL).toEqual(['1.101', '1.102', '2.101', '2.102']);
    expect(sql).not.toMatch(/'1102'|'2102'/);
  });

  it('so NF de ENTRADA (tp_nf = 0)', async () => {
    const { sql } = await sqlDaFila();
    expect(sql).toContain('h.tp_nf = 0');
  });

  it('exclui cancelada e deletada (nfValidaSql) — e consulta a coluna na tabela Q2P, nao ACXE', async () => {
    const { sql } = await sqlDaFila();
    expect(sql).toContain('COALESCE(h.deletada, false) = false');
    expect(sql).toContain('COALESCE(h.cancelada, false) = false');
    const infoCall = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('information_schema'));
    expect(infoCall?.[1]).toEqual(['tbl_nf_header_Q2P']);
  });

  it('exclui fornecedor com exclusao ATIVA em stockbridge.fornecedor_exclusao (T006b)', async () => {
    const { sql } = await sqlDaFila();
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('stockbridge.fornecedor_exclusao fe');
    expect(sql).toContain('fe.reincluido_em IS NULL');
    expect(sql).toContain('fe.fornecedor_cnpj = h.dest_cnpj_cpf');
  });

  it('corte temporal FIXO por parametro, vindo da config (research D23)', async () => {
    const { sql, params } = await sqlDaFila();
    expect(sql).toContain('h.d_emi >= $2::date');
    expect(params[1]).toBe('2026-09-11');
    expect(sql).not.toMatch(/CURRENT_DATE\s*-\s*30/);
  });

  it('so devolve NF com item pendente (HAVING) e a pendencia e por DESCRICAO normalizada', async () => {
    const { sql } = await sqlDaFila();
    expect(sql).toContain('HAVING COUNT(DISTINCT desc_norm) FILTER (WHERE NOT recebido) > 0');
    expect(sql).toContain('unaccent(i.x_prod)');
  });

  it('nunca usa n_id_receb (universal em NF de entrada — research D1)', async () => {
    const { sql } = await sqlDaFila();
    expect(sql).not.toContain('n_id_receb');
  });

  it('checagem de "recebida" em duas vias + baixa externa (itemNacionalRecebidoSql)', async () => {
    const { sql } = await sqlDaFila();
    expect(sql).toContain("m.subtipo = 'compra_nacional'");
    expect(sql).toContain('m.nf_chave_acesso = h.c_chave_nfe');
    expect(sql).toContain('m.nf_chave_acesso IS NULL');
    expect(sql).toContain("ltrim(m.nota_fiscal, '0') = ltrim(h.n_nf, '0')");
    expect(sql).toContain("a.tipo_aprovacao = 'recebimento_externo'");
  });

  it('ordena pela emissao mais antiga primeiro', async () => {
    const { sql } = await sqlDaFila();
    expect(sql).toMatch(/ORDER BY d_emi ASC, n_nf ASC/);
  });

  it('filtros q/fornecedor viram parametros (nao interpolacao)', async () => {
    const { sql, params } = await sqlDaFila({ q: '667', fornecedor: 'ISOFORMA' });
    expect(params).toEqual([['1.101', '1.102', '2.101', '2.102'], '2026-09-11', '%ISOFORMA%', '%667%']);
    expect(sql).toContain('$3');
    expect(sql).toContain('$4');
    expect(sql).not.toContain('ISOFORMA');
  });
});

describe('getFilaNacional — configuracao e degrade (T013/T014)', () => {
  it('sem data de corte: recusa com DataCorteNaoConfiguradaError e NAO consulta o banco', async () => {
    dataCorte = undefined;
    await expect(getFilaNacional()).rejects.toBeInstanceOf(DataCorteNaoConfiguradaError);
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it('data de corte invalida tambem recusa', async () => {
    dataCorte = '11/09/2026';
    await expect(getFilaNacional()).rejects.toBeInstanceOf(DataCorteNaoConfiguradaError);
  });

  it('falha de BANCO degrada para lista vazia (a fila e informativa)', async () => {
    poolQuerySpy.mockImplementation((sql: string) => {
      if (sql.includes('information_schema')) return Promise.resolve({ rows: [{ ok: true }] });
      return Promise.reject(new Error('connection refused'));
    });
    await expect(getFilaNacional()).resolves.toEqual([]);
  });

  it('mapeia as rows para FilaNacionalItem (conversoes numericas, valor derivado)', async () => {
    poolQuerySpy.mockImplementation((sql: string) => {
      if (sql.includes('information_schema')) return Promise.resolve({ rows: [{ ok: true }] });
      return Promise.resolve({
        rows: [{
          nf_chave_acesso: CHAVE, nota_fiscal: '66724', fornecedor_nome: 'ISOFORMA PLASTICOS INDUSTRIAIS LTDA',
          fornecedor_cnpj: '68.176.072/0001-28', dt_emissao: '2026-08-06', dias_desde_emissao: '42',
          itens_total: '1', itens_pendentes: '1', valor_total_brl: '156604',
        }],
      });
    });
    const [f] = await getFilaNacional();
    expect(f).toEqual({
      nfChaveAcesso: CHAVE, notaFiscal: '66724', fornecedorNome: 'ISOFORMA PLASTICOS INDUSTRIAIS LTDA',
      fornecedorCnpj: '68.176.072/0001-28', dtEmissao: '2026-08-06', diasDesdeEmissao: 42,
      itensTotal: 1, itensPendentes: 1, valorTotalBrl: 156604,
    });
  });
});

describe('Principio II / FR-016 — zero chamada OMIE (T027b)', () => {
  it('fila e detalhe nao invocam o cliente OMIE', async () => {
    await getFilaNacional();
    poolQuerySpy.mockImplementation((sql: string) => {
      if (sql.includes('information_schema')) return Promise.resolve({ rows: [{ ok: true }] });
      return Promise.resolve({ rows: [linha({})] });
    });
    await getDetalheNfNacional(CHAVE);
    for (const s of Object.values(omieSpies)) expect(s).not.toHaveBeenCalled();
  });
});

describe('seed de fornecedor_exclusao na migration 0052 (T006b)', () => {
  it('a migration semeia PLASTFIX e a contraparte ACXE com ON CONFLICT no indice parcial', () => {
    const sql = readFileSync(resolve(__dirname, '../../../../packages/db/migrations/0052_stockbridge_recebimento_nacional_nf.sql'), 'utf8');
    expect(sql).toContain("'29.654.678/0001-70'");
    expect(sql).toContain("'42.672.052/0001-54'");
    expect(sql).toContain('INSERT INTO stockbridge.fornecedor_exclusao');
    expect(sql).toContain('ON CONFLICT (fornecedor_cnpj) WHERE reincluido_em IS NULL DO NOTHING');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS unaccent');
    expect(sql).toContain('movimentacao_nf_nacional_idempotencia_idx');
    expect(sql).toContain("tipo_aprovacao = 'recebimento_externo' AND nf_chave_acesso IS NOT NULL");
  });
});

// ── Detalhe ────────────────────────────────────────────────────────────────

function linha(o: Partial<Record<string, unknown>>) {
  return {
    nf_chave_acesso: CHAVE, n_nf: '000066724', nota_fiscal: '66724',
    fornecedor_nome: 'ISOFORMA PLASTICOS INDUSTRIAIS LTDA', fornecedor_cnpj: '68.176.072/0001-28',
    dt_emissao: '2026-08-06', dias_desde_emissao: 42, cancelada: false, deletada: false, fornecedor_excluido: false,
    n_cod_item: '1', x_prod: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', desc_norm: 'SUCATA PSAI MOIDO MESCLADO GROSSO',
    cfop: '1.102', q_com: 13160, u_com: 'KG', v_tot_item: 156604, recebido: false, baixado_externo: false,
    nf_ja_atribuida_kg: 0, conferida_ja_gravada_kg: 0,
    ...o,
  };
}

function detalheCom(rows: unknown[]) {
  poolQuerySpy.mockImplementation((sql: string) => {
    if (sql.includes('information_schema')) return Promise.resolve({ rows: [{ ok: true }] });
    return Promise.resolve({ rows });
  });
}

describe('getDetalheNfNacional (T015/T016)', () => {
  it('chave invalida -> NfNacionalNaoEncontradaError sem consultar', async () => {
    await expect(getDetalheNfNacional('123')).rejects.toBeInstanceOf(NfNacionalNaoEncontradaError);
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it('sem linhas (fora do espelho ou antes do corte) -> 404', async () => {
    detalheCom([]);
    await expect(getDetalheNfNacional(CHAVE)).rejects.toBeInstanceOf(NfNacionalNaoEncontradaError);
  });

  it('cancelada/deletada -> NfNacionalCanceladaError; fornecedor excluido -> FornecedorExcluidoError', async () => {
    detalheCom([linha({ cancelada: true })]);
    await expect(getDetalheNfNacional(CHAVE)).rejects.toBeInstanceOf(NfNacionalCanceladaError);
    detalheCom([linha({ fornecedor_excluido: true })]);
    await expect(getDetalheNfNacional(CHAVE)).rejects.toBeInstanceOf(FornecedorExcluidoError);
  });

  it('NF sem nenhuma linha no recorte de CFOP -> 404; NF mista conta linhasForaDoRecorte', async () => {
    detalheCom([linha({ cfop: '1.556' })]);
    await expect(getDetalheNfNacional(CHAVE)).rejects.toBeInstanceOf(NfNacionalNaoEncontradaError);
    detalheCom([linha({}), linha({ n_cod_item: '2', cfop: '1.556', x_prod: 'GAS', desc_norm: 'GAS' })]);
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.itens).toHaveLength(1);
    expect(d.linhasForaDoRecorte).toBe(1);
    expect(d.valorTotalBrl).toBe(156604); // so as elegiveis
  });

  it('item 1:1 em KG: quantidade e valor vem da NF, R$/kg coerente, pendente', async () => {
    detalheCom([linha({})]);
    const d = await getDetalheNfNacional(CHAVE);
    const it = d.itens[0]!;
    expect(d.notaFiscal).toBe('66724');
    expect(d.fornecedorNome).toContain('ISOFORMA');
    expect(it.quantidadeNfKg).toBe(13160);
    expect(it.valorTotalItemBrl).toBe(156604);
    expect(it.rsPorKg).toBeCloseTo(11.9, 2);
    expect(it.jaRecebido).toBe(false);
    expect(it.quantidadeRestanteKg).toBe(13160);
    expect(it.bloqueio).toBe('sem_correlacao'); // sugestao so na Historia 3
  });

  it('agrega linhas de MESMA descricao (somando, nunca descartando) — NF 58084 da Zaraplast (D18)', async () => {
    detalheCom([
      linha({ n_cod_item: '1', x_prod: '1.40.101 MC PP HOMO H301+AX', desc_norm: '1.40.101 MC PP HOMO H301+AX', q_com: 2.75, u_com: 'TL', v_tot_item: 39428.21 }),
      linha({ n_cod_item: '2', x_prod: '1.40.101 MC PP HOMO H301+AX', desc_norm: '1.40.101 MC PP HOMO H301+AX', q_com: 1.375, u_com: 'TL', v_tot_item: 19714.1 }),
      linha({ n_cod_item: '3', x_prod: '1.40.101 MC PP HOMO H301+AX', desc_norm: '1.40.101 MC PP HOMO H301+AX', q_com: 8.25, u_com: 'TL', v_tot_item: 118284.64 }),
      linha({ n_cod_item: '4', x_prod: 'PPCO0006 MC PP HECO CP141+AX', desc_norm: 'PPCO0006 MC PP HECO CP141+AX', q_com: 5.5, u_com: 'TL', v_tot_item: 78856.43 }),
    ]);
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.itens).toHaveLength(2);
    const homo = d.itens.find((i) => i.descricaoNormalizada.includes('HOMO'))!;
    expect(homo.linhasAgregadas).toBe(3);
    expect(homo.quantidadeNf).toBeCloseTo(12.375, 3);
    expect(homo.quantidadeNfKg).toBeCloseTo(12375, 3); // TL -> tonelada
    expect(homo.valorTotalItemBrl).toBeCloseTo(177426.95, 2);
    // valor unitario do agregado = media ponderada, nao o v_un_com de uma linha
    expect(homo.valorUnitarioBrl).toBeCloseTo(177426.95 / 12.375, 2);
  });

  it('KG rotulado com quantidade em tonelada (NF 58067) -> bloqueio unidade_incoerente, quantidadeNfKg null', async () => {
    detalheCom([linha({ x_prod: 'MC PEAD GM9450F+ AN', desc_norm: 'MC PEAD GM9450F+ AN', q_com: 1.375, u_com: 'KG', v_tot_item: 20352.34 })]);
    const [it] = (await getDetalheNfNacional(CHAVE)).itens;
    expect(it!.bloqueio).toBe('unidade_incoerente');
    expect(it!.quantidadeNfKg).toBeNull();
    expect(it!.quantidadeRestanteKg).toBeNull();
    expect(it!.bloqueioMensagem).toContain('não escolhe');
  });

  it('unidade desconhecida (UN) -> bloqueio unidade_nao_conversivel', async () => {
    detalheCom([linha({ u_com: 'UN', q_com: 9040, v_tot_item: 4520 })]);
    const [it] = (await getDetalheNfNacional(CHAVE)).itens;
    expect(it!.bloqueio).toBe('unidade_nao_conversivel');
  });

  it('linhas de mesma descricao em unidades diferentes bloqueiam em vez de somar', async () => {
    detalheCom([linha({ n_cod_item: '1', u_com: 'KG' }), linha({ n_cod_item: '2', u_com: 'TL', q_com: 2 })]);
    const [it] = (await getDetalheNfNacional(CHAVE)).itens;
    expect(it!.bloqueio).toBe('unidade_nao_conversivel');
    expect(it!.bloqueioMensagem).toContain('unidades diferentes');
  });

  it('ja recebido e parcialmente recebido: restante do lado da NF (D25)', async () => {
    detalheCom([linha({ recebido: true, nf_ja_atribuida_kg: 13160, conferida_ja_gravada_kg: 13500 })]);
    let [it] = (await getDetalheNfNacional(CHAVE)).itens;
    expect(it!.jaRecebido).toBe(true);
    expect(it!.quantidadeRestanteKg).toBe(0);

    detalheCom([linha({ recebido: true, nf_ja_atribuida_kg: 4386.667, conferida_ja_gravada_kg: 4500 })]);
    [it] = (await getDetalheNfNacional(CHAVE)).itens;
    expect(it!.quantidadeNfJaAtribuidaKg).toBeCloseTo(4386.667, 3);
    expect(it!.quantidadeRestanteKg).toBeCloseTo(13160 - 4386.667, 3);
  });

  it('baixado por recebimento externo aprovado e sinalizado', async () => {
    detalheCom([linha({ recebido: true, baixado_externo: true })]);
    const [it] = (await getDetalheNfNacional(CHAVE)).itens;
    expect(it!.baixadoComoExterno).toBe(true);
  });
});
