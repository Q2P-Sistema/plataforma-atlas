import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Feature 017 (ACXEGDP-437), migration 0057 — cache de pedidos de compra (PC) vistos pelo Atlas.
//
// O OMIE tira da lista de PCs PENDENTES (a cópia `tbl_pedidosCompras_<empresa>`, n8n Rev 1.5) o PC que já tem
// item associado a um recebimento de NF-e, ANTES de o recebimento ser concluído: em 22/10/2026 o PC 306 da
// Zaraplast sumiu da cópia entre a associação (13h) e a conclusão (15h) da NF 60199. `pc-visto.service.ts`
// guarda a última versão de cada item de PC que passou pela cópia, em
// stockbridge.pedido_compra_visto (chave empresa + n_cod_item), e a sugestão usa o cache para o que a cópia
// não trouxe.
//
// Aqui, com o pool mockado (sem banco): o SQL do upsert (só grava o que mudou — IS DISTINCT FROM), o limite de
// 1 gravação a cada 5 min por processo, a leitura por fornecedor/raiz de CNPJ/pedido e o mapeamento para a
// forma da cópia, `numerosPcsVistos`, o cron e a fiação real com `carregarContextoPc`. O SQL em Postgres real
// está em auditoria-pedido-compra-visto.test.ts (opt-in ATLAS_DB_INTEGRATION=1).

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  config: {} as Record<string, unknown>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params) }),
  getConfig: () => mocks.config,
}));
vi.mock('@atlas/integration-omie', () => ({ consultarPedidoCompra: vi.fn() }));

import {
  registrarPcsVistos,
  registrarPcsVistosSeVencido,
  lerPcsVistos,
  numerosPcsVistos,
  REGISTRO_OPORTUNISTA_MIN_MS,
  CACHE_PC_VALIDADE_DIAS,
  __resetRegistroPcsVistos,
} from '../services/pc-visto.service.js';
import { carregarContextoPc } from '../services/pc-sugestao.service.js';

const AGORA = Date.UTC(2026, 9, 22, 18, 0, 0);
const CNPJ_ACXE = '42672052000154';
const norm = (sql: unknown): string => String(sql).replace(/\s+/g, ' ').trim();
/** SQL (normalizado) de cada consulta feita ao pool, na ordem. */
const sqls = (): string[] => mocks.poolQuery.mock.calls.map((c) => norm(c[0]));
const chamadasCom = (trecho: string) => mocks.poolQuery.mock.calls.filter((c) => String(c[0]).includes(trecho));

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolQuery.mockResolvedValue({ rows: [{ n: '0' }] });
  for (const f of Object.values(mocks.logger)) f.mockClear();
  __resetRegistroPcsVistos();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
});
afterEach(() => {
  vi.useRealTimers();
});

// ═══ registrarPcsVistos ══════════════════════════════════════════════════════

describe('registrarPcsVistos — upsert só do que mudou', () => {
  it('um único INSERT … ON CONFLICT (empresa, n_cod_item) DO UPDATE sobre a cópia da empresa, parametrizado só pela empresa', async () => {
    await registrarPcsVistos('q2p');
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.poolQuery.mock.calls[0]!;
    const s = norm(sql);
    expect(s).toContain('INSERT INTO stockbridge.pedido_compra_visto');
    expect(s).toContain('ON CONFLICT (empresa, n_cod_item) DO UPDATE');
    expect(s).toContain('FROM public."tbl_pedidosCompras_Q2P" pc');
    expect(s).toContain('WHERE pc.ncodped IS NOT NULL AND pc.ncoditem IS NOT NULL');
    expect(s).toContain('SELECT $1, c.ncodped, c.ncoditem');
    expect(params).toEqual(['q2p']);
  });

  it('a cópia com o mesmo ncoditem em 2 linhas não aborta o upsert (SQLSTATE 21000): DISTINCT ON pelo item, ficando a linha mais recente', async () => {
    await registrarPcsVistos('q2p');
    const s = sqls()[0]!;
    expect(s).toContain('SELECT DISTINCT ON (pc.ncoditem) pc.* FROM public."tbl_pedidosCompras_Q2P" pc');
    expect(s).toContain('ORDER BY pc.ncoditem, pc.data_atualizacao DESC NULLS LAST ), copia AS (');
    // a soma por pedido é calculada DEPOIS da deduplicação
    expect(s).toContain('OVER (PARTITION BY pc.ncodped)::numeric(14,2) AS valor_total_pc FROM itens pc )');
  });

  it('a empresa ACXE lê a cópia da ACXE e grava com empresa "acxe"', async () => {
    await registrarPcsVistos('acxe');
    expect(sqls()[0]).toContain('FROM public."tbl_pedidosCompras_ACXE" pc');
    expect(sqls()[0]).not.toContain('tbl_pedidosCompras_Q2P');
    expect(mocks.poolQuery.mock.calls[0]![1]).toEqual(['acxe']);
  });

  it('só grava o que MUDOU: o DO UPDATE tem WHERE (colunas gravadas) IS DISTINCT FROM (EXCLUDED …) com as mesmas colunas dos dois lados', async () => {
    await registrarPcsVistos('q2p');
    const s = sqls()[0]!;
    const m = s.match(/WHERE \(([^)]*)\) IS DISTINCT FROM \(([^)]*)\) RETURNING 1/);
    expect(m, 'o DO UPDATE precisa de WHERE … IS DISTINCT FROM …').not.toBeNull();
    const atuais = m![1]!.split(',').map((c) => c.trim().replace('pedido_compra_visto.', ''));
    const novas = m![2]!.split(',').map((c) => c.trim().replace('EXCLUDED.', ''));
    expect(atuais).toEqual(novas);
    // todos os dados do PC que importam para a sugestão e para a auditoria
    expect(atuais).toEqual([
      'n_cod_ped', 'pc_numero', 'n_cod_for', 'produto_descricao', 'unidade', 'qtde', 'qtde_rec', 'preco_unit', 'etapa', 'dt_previsao', 'valor_total_pc',
      // Historia 5 (0058): produto e local do item do PC
      'n_cod_prod', 'codigo_local_estoque',
    ]);
  });

  it('visto_em e updated_at NÃO entram na comparação (senão toda sincronização geraria UPDATE e ruído na auditoria)', async () => {
    await registrarPcsVistos('q2p');
    const s = sqls()[0]!;
    const where = s.slice(s.indexOf('WHERE (pedido_compra_visto.'));
    expect(where).not.toContain('visto_em');
    expect(where).not.toContain('updated_at');
    expect(where).not.toContain('n_cod_item');
    // mas o DO UPDATE os atualiza quando há mudança
    expect(s).toContain('visto_em = EXCLUDED.visto_em, updated_at = now()');
  });

  it('o valor total do PC é a soma dos itens do pedido (janela por ncodped), e o preço/quantidade são tipados como no destino', async () => {
    await registrarPcsVistos('q2p');
    const s = sqls()[0]!;
    expect(s).toContain('SUM(COALESCE(pc.nvaltot, pc.nqtde * pc.nvalunit, 0)) OVER (PARTITION BY pc.ncodped)::numeric(14,2) AS valor_total_pc');
    expect(s).toContain('pc.nqtde::numeric(14,3) AS qtde');
    expect(s).toContain('COALESCE(pc.nqtderec, 0)::numeric(14,3) AS qtde_rec');
    expect(s).toContain('pc.nvalunit::numeric(14,6) AS preco_unit');
    expect(s).toContain("upper(btrim(COALESCE(pc.cunidade, ''))) AS unidade");
    expect(s).toContain("btrim(COALESCE(pc.cnumero, '')) AS pc_numero");
  });

  it('devolve o número de linhas gravadas (count vem como texto)', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ n: '7' }] });
    expect(await registrarPcsVistos('q2p')).toBe(7);
  });

  it.each([[{ rows: [] }], [{ rows: [{ n: null }] }], [{ rows: [{ n: '0' }] }]])('resultado vazio/zero (%j) devolve 0', async (resposta) => {
    mocks.poolQuery.mockResolvedValue(resposta);
    expect(await registrarPcsVistos('q2p')).toBe(0);
  });

  it('com linhas gravadas registra no log (empresa e linhas); sem nenhuma, não registra', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ n: '3' }] });
    await registrarPcsVistos('q2p');
    expect(mocks.logger.info).toHaveBeenCalledWith({ empresa: 'q2p', linhas: 3 }, 'Cache de pedidos de compra atualizado');
    mocks.logger.info.mockClear();
    mocks.poolQuery.mockResolvedValue({ rows: [{ n: '0' }] });
    await registrarPcsVistos('q2p');
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('NUNCA lança: falha do banco vira 0 e um aviso no log', async () => {
    mocks.poolQuery.mockRejectedValue(new Error('relation "public.tbl_pedidosCompras_Q2P" does not exist'));
    await expect(registrarPcsVistos('q2p')).resolves.toBe(0);
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn.mock.calls[0]![0]).toMatchObject({ empresa: 'q2p', err: expect.stringContaining('does not exist') });
  });

  it('não lança nem com um erro que não é Error (string solta do driver)', async () => {
    mocks.poolQuery.mockRejectedValue('boom');
    await expect(registrarPcsVistos('q2p')).resolves.toBe(0);
  });
});

// ═══ registrarPcsVistosSeVencido ═════════════════════════════════════════════

describe('registrarPcsVistosSeVencido — no máximo 1× a cada 5 min por processo e empresa', () => {
  it('o intervalo é de 5 minutos', () => {
    expect(REGISTRO_OPORTUNISTA_MIN_MS).toBe(5 * 60 * 1000);
  });

  it('a primeira chamada grava; a segunda, logo depois, não faz nada', async () => {
    await registrarPcsVistosSeVencido('q2p', AGORA);
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    await registrarPcsVistosSeVencido('q2p', AGORA + 1000);
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
  });

  it('quase 5 minutos depois (4 min 59 s) ainda não grava; com 5 min exatos grava de novo', async () => {
    await registrarPcsVistosSeVencido('q2p', AGORA);
    vi.setSystemTime(AGORA + REGISTRO_OPORTUNISTA_MIN_MS - 1000);
    await registrarPcsVistosSeVencido('q2p', Date.now());
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    vi.setSystemTime(AGORA + REGISTRO_OPORTUNISTA_MIN_MS);
    await registrarPcsVistosSeVencido('q2p', Date.now());
    expect(mocks.poolQuery).toHaveBeenCalledTimes(2);
  });

  it('o limite é por empresa: gravar a Q2P não adia a ACXE', async () => {
    await registrarPcsVistosSeVencido('q2p', AGORA);
    await registrarPcsVistosSeVencido('acxe', AGORA);
    expect(mocks.poolQuery).toHaveBeenCalledTimes(2);
    expect(mocks.poolQuery.mock.calls.map((c) => (c[1] as string[])[0])).toEqual(['q2p', 'acxe']);
  });

  it('sem o 2º argumento usa o relógio atual', async () => {
    await registrarPcsVistosSeVencido('q2p');
    await registrarPcsVistosSeVencido('q2p');
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
  });

  it('a gravação que FALHA também conta como tentativa: a chamada seguinte (no prazo) não repete — a página não paga o banco em falha', async () => {
    mocks.poolQuery.mockRejectedValue(new Error('timeout'));
    await registrarPcsVistosSeVencido('q2p', AGORA);
    await registrarPcsVistosSeVencido('q2p', AGORA + 60_000);
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
  });

  it('nunca lança', async () => {
    mocks.poolQuery.mockRejectedValue(new Error('connection refused'));
    await expect(registrarPcsVistosSeVencido('q2p', AGORA)).resolves.toBeUndefined();
  });

  it('registrar direto (cron) também zera o prazo: a oportunista logo depois não repete', async () => {
    await registrarPcsVistos('q2p');
    await registrarPcsVistosSeVencido('q2p', AGORA + 1000);
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
  });

  it('__resetRegistroPcsVistos (testes) libera a próxima chamada', async () => {
    await registrarPcsVistosSeVencido('q2p', AGORA);
    __resetRegistroPcsVistos();
    await registrarPcsVistosSeVencido('q2p', AGORA + 1000);
    expect(mocks.poolQuery).toHaveBeenCalledTimes(2);
  });
});

// ═══ lerPcsVistos ════════════════════════════════════════════════════════════

/** Linha do cache como o Postgres a devolve: bigint e numeric em texto, visto_ms em float8. */
function linha(over: Record<string, unknown> = {}) {
  return {
    n_cod_ped: '7974140306',
    n_cod_item: '7974140311',
    pc_numero: '306',
    n_cod_for: '7974140605',
    produto_descricao: 'MC PEAD ES',
    unidade: 'KG',
    qtde: '13750.000',
    qtde_rec: '0.000',
    preco_unit: '10.800000',
    etapa: '15',
    dt_previsao: '2026-11-05',
    valor_total_pc: '297000.00',
    visto_ms: AGORA - 3_600_000,
    cnpj_cadastro: '61827663000179',
    ...over,
  };
}
const PARAMS = { fornecedores: [3098999518], raizes: ['61827663'], nCodPeds: [7974140306] };

describe('lerPcsVistos — consulta', () => {
  it('sem fornecedores, raízes nem pedidos (ou só valores inválidos) não consulta o banco', async () => {
    expect(await lerPcsVistos('q2p', { fornecedores: [], raizes: [], nCodPeds: [] })).toEqual([]);
    expect(
      await lerPcsVistos('q2p', { fornecedores: [0, -1, Number.NaN], raizes: ['123', '1234567', '123456789', 'abcdefgh', ''], nCodPeds: [0, Number.POSITIVE_INFINITY] }),
    ).toEqual([]);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('o SQL filtra por empresa e por fornecedor OU pedido OU raiz de CNPJ (14 dígitos, 8 primeiros), com os parâmetros na ordem', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    await lerPcsVistos('q2p', PARAMS);
    const [sql, params] = mocks.poolQuery.mock.calls[0]!;
    const s = norm(sql);
    expect(s).toContain('FROM stockbridge.pedido_compra_visto v');
    expect(s).toContain('LEFT JOIN LATERAL ( SELECT c.cnpj_cpf FROM public."tbl_cadastroFornecedoresClientes_Q2P" c WHERE c.codigo_cliente_omie = v.n_cod_for LIMIT 1 ) cad ON true');
    expect(s).toContain('WHERE v.empresa = $1');
    expect(s).toContain('v.n_cod_for = ANY($2::bigint[])');
    expect(s).toContain('v.n_cod_ped = ANY($3::bigint[])');
    expect(s).toContain("length(regexp_replace(COALESCE(cad.cnpj_cpf, ''), '\\D', '', 'g')) = 14");
    expect(s).toContain("left(regexp_replace(cad.cnpj_cpf, '\\D', '', 'g'), 8) = ANY($4::text[])");
    // fornecedores, pedidos, raizes, validade — a ordem dos params é $2 fornecedores, $3 pedidos, $4 raizes, $5 dias
    expect(params).toEqual(['q2p', [3098999518], [7974140306], ['61827663'], CACHE_PC_VALIDADE_DIAS]);
  });

  it('candidatos por fornecedor/raiz só dentro da validade (7 dias); PC apontado por vínculo do OMIE entra sempre', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    await lerPcsVistos('q2p', PARAMS);
    const s = sqls()[0]!;
    expect(CACHE_PC_VALIDADE_DIAS).toBe(7);
    // o pedido fica FORA do bloco com validade; fornecedor e raiz ficam DENTRO
    expect(s).toContain('( v.n_cod_ped = ANY($3::bigint[]) OR (v.visto_em > now() - make_interval(days => $5) AND (v.n_cod_for = ANY($2::bigint[]) OR (');
  });

  it('a ACXE lê o cadastro da ACXE', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    await lerPcsVistos('acxe', PARAMS);
    expect(sqls()[0]).toContain('public."tbl_cadastroFornecedoresClientes_ACXE" c');
    expect(mocks.poolQuery.mock.calls[0]![1]![0]).toBe('acxe');
  });

  it('limpa os parâmetros: fornecedores/pedidos inválidos saem, raízes que não têm exatamente 8 dígitos saem', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    await lerPcsVistos('q2p', { fornecedores: [0, 5, Number.NaN], raizes: ['61827663', '123', '6182766x', '618276630'], nCodPeds: [-3, 7] });
    expect(mocks.poolQuery.mock.calls[0]![1]).toEqual(['q2p', [5], [7], ['61827663'], CACHE_PC_VALIDADE_DIAS]);
  });

  it('basta UM dos três critérios para consultar (só pedido, só raiz, só fornecedor)', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    await lerPcsVistos('q2p', { fornecedores: [], raizes: [], nCodPeds: [7] });
    await lerPcsVistos('q2p', { fornecedores: [], raizes: ['61827663'], nCodPeds: [] });
    await lerPcsVistos('q2p', { fornecedores: [9], raizes: [], nCodPeds: [] });
    expect(mocks.poolQuery).toHaveBeenCalledTimes(3);
  });

  it('NÃO engole erro de banco (o chamador, carregarContextoPc, trata como "sem cache")', async () => {
    mocks.poolQuery.mockRejectedValue(new Error('relation "stockbridge.pedido_compra_visto" does not exist'));
    await expect(lerPcsVistos('q2p', PARAMS)).rejects.toThrow(/does not exist/);
  });
});

describe('lerPcsVistos — mapeamento para a forma da cópia (PcCopia sem fonte)', () => {
  it('unidade KG: quantidades e preço ficam como vieram, ids viram número, visto_ms vira atualizadoEmMs e vistoEmMs', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [linha({ qtde: '13750.000', qtde_rec: '3750.000' })] });
    const [pc] = await lerPcsVistos('q2p', PARAMS);
    expect(pc).toEqual({
      nCodPed: 7974140306,
      nCodItem: 7974140311,
      pcNumero: '306',
      etapa: '15',
      nCodFor: 7974140605,
      produtoDescricao: 'MC PEAD ES',
      qtdPedidaKg: 13750,
      saldoCopiaKg: 10000,
      precoKg: 10.8,
      unidade: 'KG',
      dtPrevisao: '2026-11-05',
      atualizadoEmMs: AGORA - 3_600_000,
      pcEspelho: false,
      cnpjCadastro: '61827663000179',
      raizCnpj: '61827663',
      vistoEmMs: AGORA - 3_600_000,
    });
    expect(pc).not.toHaveProperty('fonte');
  });

  it.each(['T', 'TON', 'ton', 'TL'])('unidade %s: multiplica a quantidade por 1000 e divide o preço por 1000', async (unidade) => {
    mocks.poolQuery.mockResolvedValue({ rows: [linha({ unidade, qtde: '13.750', qtde_rec: '3.750', preco_unit: '10800.000000' })] });
    const [pc] = await lerPcsVistos('q2p', PARAMS);
    expect(pc!.qtdPedidaKg).toBe(13750);
    expect(pc!.saldoCopiaKg).toBe(10000);
    expect(pc!.precoKg).toBeCloseTo(10.8, 10);
  });

  it('unidade não comparável (UN): quantidades zeradas e preço null — o PC não entra em nenhuma lista da sugestão', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [linha({ unidade: 'UN' })] });
    const [pc] = await lerPcsVistos('q2p', PARAMS);
    expect(pc).toMatchObject({ qtdPedidaKg: 0, saldoCopiaKg: 0, precoKg: null, unidade: 'UN' });
  });

  it('o saldo nunca fica negativo (recebido acima do pedido)', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [linha({ qtde: '1000.000', qtde_rec: '1200.000' })] });
    expect((await lerPcsVistos('q2p', PARAMS))[0]!.saldoCopiaKg).toBe(0);
  });

  it('campos nulos viram vazios/zero: número, fornecedor, descrição, unidade, quantidades, preço, etapa, previsão', async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [
        linha({
          pc_numero: null, n_cod_for: null, produto_descricao: null, unidade: null, qtde: null, qtde_rec: null, preco_unit: null,
          etapa: null, dt_previsao: null, valor_total_pc: null, visto_ms: null, cnpj_cadastro: null,
        }),
      ],
    });
    const [pc] = await lerPcsVistos('q2p', PARAMS);
    expect(pc).toMatchObject({
      pcNumero: '', nCodFor: 0, produtoDescricao: '', unidade: '', qtdPedidaKg: 0, saldoCopiaKg: 0, precoKg: null, etapa: '',
      dtPrevisao: null, atualizadoEmMs: 0, vistoEmMs: 0, cnpjCadastro: '', raizCnpj: null, pcEspelho: false,
    });
  });

  it('apara espaços (número, descrição, etapa, unidade) e coloca a unidade em caixa alta', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [linha({ pc_numero: ' 306 ', produto_descricao: '  MC PEAD ES ', etapa: ' 15 ', unidade: ' kg ' })] });
    expect((await lerPcsVistos('q2p', PARAMS))[0]).toMatchObject({ pcNumero: '306', produtoDescricao: 'MC PEAD ES', etapa: '15', unidade: 'KG' });
  });

  it('a previsão é cortada na data (10 caracteres)', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [linha({ dt_previsao: '2026-11-05 00:00:00' })] });
    expect((await lerPcsVistos('q2p', PARAMS))[0]!.dtPrevisao).toBe('2026-11-05');
  });

  it('visto_ms pode vir em texto (bigint/float) e vira número', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [linha({ visto_ms: String(AGORA) })] });
    expect((await lerPcsVistos('q2p', PARAMS))[0]!.vistoEmMs).toBe(AGORA);
  });

  it('CPF no cadastro: cnpjCadastro guardado, raiz nula (só CNPJ de 14 dígitos tem raiz)', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [linha({ cnpj_cadastro: '12345678901' })] });
    expect((await lerPcsVistos('q2p', PARAMS))[0]).toMatchObject({ cnpjCadastro: '12345678901', raizCnpj: null });
  });

  describe('pcEspelho (importação): fornecedor ACXE com valor total < R$ 200', () => {
    const espelho = async (cnpj: string, valor: string | null) => {
      mocks.poolQuery.mockResolvedValue({ rows: [linha({ cnpj_cadastro: cnpj, valor_total_pc: valor })] });
      return (await lerPcsVistos('q2p', PARAMS))[0]!.pcEspelho;
    };
    it('ACXE com R$ 150 e R$ 199,99 é espelho', async () => {
      expect(await espelho(CNPJ_ACXE, '150.00')).toBe(true);
      expect(await espelho(CNPJ_ACXE, '199.99')).toBe(true);
    });
    it('ACXE com R$ 200 (200 não é < 200) ou PC real não é espelho', async () => {
      expect(await espelho(CNPJ_ACXE, '200.00')).toBe(false);
      expect(await espelho(CNPJ_ACXE, '203400.00')).toBe(false);
    });
    it('fornecedor comum com valor baixo não é espelho; ACXE sem valor (null -> 0) é espelho', async () => {
      expect(await espelho('61827663000179', '50.00')).toBe(false);
      expect(await espelho(CNPJ_ACXE, null)).toBe(true);
    });
  });

  it('vários itens: a ordem do banco é preservada', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [linha({ n_cod_item: '2' }), linha({ n_cod_item: '1' }), linha({ n_cod_item: '3' })] });
    expect((await lerPcsVistos('q2p', PARAMS)).map((p) => p.nCodItem)).toEqual([2, 1, 3]);
  });
});

// ═══ numerosPcsVistos ════════════════════════════════════════════════════════

describe('numerosPcsVistos — número legível dos PCs pelo cache', () => {
  it('sem pedidos válidos não consulta', async () => {
    expect((await numerosPcsVistos('q2p', [])).size).toBe(0);
    expect((await numerosPcsVistos('q2p', [0, -1, Number.NaN])).size).toBe(0);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('SQL por empresa e pedidos, agrupado por pedido com o número não vazio; params [empresa, pedidos]', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    await numerosPcsVistos('acxe', [7974140306, 0, 7974140310]);
    const [sql, params] = mocks.poolQuery.mock.calls[0]!;
    const s = norm(sql);
    expect(s).toContain('FROM stockbridge.pedido_compra_visto WHERE empresa = $1 AND n_cod_ped = ANY($2::bigint[]) GROUP BY n_cod_ped');
    expect(s).toContain("MIN(NULLIF(btrim(pc_numero), '')) AS pc_numero");
    expect(params).toEqual(['acxe', [7974140306, 7974140310]]);
  });

  it('mapa pedido -> número; o pedido sem número no cache (null) fica de fora', async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [
        { n_cod_ped: '7974140306', pc_numero: '306' },
        { n_cod_ped: '7974140310', pc_numero: null },
        { n_cod_ped: '7974140311', pc_numero: '' },
      ],
    });
    const m = await numerosPcsVistos('q2p', [7974140306, 7974140310, 7974140311]);
    expect([...m.entries()]).toEqual([[7974140306, '306']]);
  });

  it('NÃO engole erro de banco', async () => {
    mocks.poolQuery.mockRejectedValue(new Error('timeout'));
    await expect(numerosPcsVistos('q2p', [7])).rejects.toThrow('timeout');
  });
});

// ═══ Fiação real: carregarContextoPc + pc-visto.service ══════════════════════

describe('carregarContextoPc com o cache REAL (sem mock do pc-visto)', () => {
  const FORN = 3098999518;

  /** A cópia tem o PC 304; o cache tem o PC 306 (saiu da lista de pendentes). */
  function bancoComCopiaECache(opts: { cacheFalha?: boolean } = {}) {
    mocks.poolQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('INSERT INTO stockbridge.pedido_compra_visto')) return Promise.resolve({ rows: [{ n: '1' }] });
      if (s.includes('FROM stockbridge.pedido_compra_visto v')) {
        if (opts.cacheFalha) return Promise.reject(new Error('relation does not exist'));
        return Promise.resolve({ rows: [linha()] });
      }
      if (s.includes('tbl_pedidosCompras_')) {
        return Promise.resolve({
          rows: [
            {
              ncodped: '8516905979', ncoditem: '8516907022', cnumero: '304', cetapa: '15', ncodfor: String(FORN), nqtde: 18000, nqtderec: 0,
              nvalunit: 11.3, cunidade: 'KG', ddtprevisao: '2026-10-30', cdescricao: 'PS CRISTAL B', cproduto: null, atualizado_ms: AGORA - 300_000,
              valor_total_pc: 203400, fornecedor_acxe: false, cnpj_cadastro: '61827663000130',
            },
          ],
        });
      }
      if (s.includes('AS codigo')) return Promise.resolve({ rows: [{ codigo: String(FORN), cnpj: '61827663000130' }] });
      if (s.includes('stockbridge.recebimento_fiscal_pc')) return Promise.resolve({ rows: [] });
      return Promise.reject(new Error(`SQL inesperado: ${s.slice(0, 80)}`));
    });
  }

  it('grava o cache (uma vez) e junta o PC que só existe nele, com fonte "cache", ao PC da cópia', async () => {
    bancoComCopiaECache();
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORN], nCodPedsVinculo: [] });
    expect(chamadasCom('INSERT INTO stockbridge.pedido_compra_visto')).toHaveLength(1);
    expect(ctx.pcs.map((p) => [p.pcNumero, p.fonte])).toEqual([['304', 'copia'], ['306', 'cache']]);
    expect(ctx.pcs[1]).toMatchObject({ nCodFor: 7974140605, saldoCopiaKg: 13750, cnpjCadastro: '61827663000179', raizCnpj: '61827663' });
    // a leitura do cache pediu as raízes do cadastro do fornecedor da NF
    const leitura = chamadasCom('FROM stockbridge.pedido_compra_visto v')[0]!;
    expect(leitura[1]).toEqual(['q2p', [FORN], [], ['61827663'], CACHE_PC_VALIDADE_DIAS]);
  });

  it('a gravação do cache é limitada a 1× por 5 min: a 2ª abertura de NF só LÊ o cache', async () => {
    bancoComCopiaECache();
    await carregarContextoPc('q2p', { fornecedores: [FORN], nCodPedsVinculo: [] });
    await carregarContextoPc('q2p', { fornecedores: [FORN], nCodPedsVinculo: [] });
    expect(chamadasCom('INSERT INTO stockbridge.pedido_compra_visto')).toHaveLength(1);
    expect(chamadasCom('FROM stockbridge.pedido_compra_visto v')).toHaveLength(2);
    // passados 5 min, grava de novo
    vi.setSystemTime(AGORA + REGISTRO_OPORTUNISTA_MIN_MS);
    await carregarContextoPc('q2p', { fornecedores: [FORN], nCodPedsVinculo: [] });
    expect(chamadasCom('INSERT INTO stockbridge.pedido_compra_visto')).toHaveLength(2);
  });

  it('falha ao LER o cache não derruba o contexto: só a cópia, com aviso no log', async () => {
    bancoComCopiaECache({ cacheFalha: true });
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORN], nCodPedsVinculo: [] });
    expect(ctx.pcs.map((p) => p.fonte)).toEqual(['copia']);
    expect(mocks.logger.warn.mock.calls.some((c) => String(c[1]).includes('Cache de pedidos de compra indisponível'))).toBe(true);
  });

  it('falha ao GRAVAR o cache (registrar nunca lança) também não impede a leitura', async () => {
    bancoComCopiaECache();
    const base = mocks.poolQuery.getMockImplementation()!;
    mocks.poolQuery.mockImplementation((sql: string, params?: unknown[]) =>
      String(sql).includes('INSERT INTO stockbridge.pedido_compra_visto') ? Promise.reject(new Error('deadlock')) : base(sql, params),
    );
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORN], nCodPedsVinculo: [] });
    expect(ctx.pcs.map((p) => p.fonte)).toEqual(['copia', 'cache']);
  });
});

// Validade e duplicata estao cobertas acima (SQL): a validade de 7 dias em `lerPcsVistos — consulta` e o DISTINCT ON
// em `registrarPcsVistos`; contra o Postgres real, em auditoria-pedido-compra-visto.test.ts.

// ═══ Cron 5,35 ═══════════════════════════════════════════════════════════════

describe('cron :05/:35 — registra o cache de PCs vistos (junto dos alertas de espelho e cópia)', () => {
  it('o job "5,35 * * * *" (fuso de Brasília) chama verificarEspelhoRecebimentos, verificarCopiaPcs e registrarPcsVistos("q2p")', async () => {
    vi.resetModules();
    const jobs: Array<{ expr: string; fn: () => void; opts: unknown }> = [];
    const registrarSpy = vi.fn().mockResolvedValue(0);
    const espelhoSpy = vi.fn().mockResolvedValue(undefined);
    const copiaSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('node-cron', () => ({ default: { schedule: (expr: string, fn: () => void, opts: unknown) => jobs.push({ expr, fn, opts }) } }));
    vi.doMock('../services/cron-comodato.service.js', () => ({ processarAlertasComodatoVencido: vi.fn() }));
    vi.doMock('../services/baixa-pedido.service.js', () => ({ reprocessarBaixasAguardandoVinculo: vi.fn() }));
    vi.doMock('../services/alerta-espelho-recebimentos.service.js', () => ({ verificarEspelhoRecebimentos: espelhoSpy, verificarCopiaPcs: copiaSpy }));
    vi.doMock('../services/pc-visto.service.js', () => ({ registrarPcsVistos: registrarSpy }));
    const { iniciarCronsStockBridge } = await import('../cron/index.js');
    iniciarCronsStockBridge();

    const job = jobs.find((j) => j.expr === '5,35 * * * *');
    expect(job, 'cron 5,35 * * * * deve estar registrado').toBeDefined();
    expect(job!.opts).toEqual({ timezone: 'America/Sao_Paulo' });
    job!.fn();
    expect(espelhoSpy).toHaveBeenCalledTimes(1);
    expect(copiaSpy).toHaveBeenCalledTimes(1);
    expect(registrarSpy).toHaveBeenCalledTimes(1);
    expect(registrarSpy).toHaveBeenCalledWith('q2p');
    // os outros dois jobs seguem registrados (comodato 08:00 e baixa de pedido :20)
    expect(jobs.map((j) => j.expr)).toEqual(['0 8 * * *', '20 * * * *', '5,35 * * * *']);

    vi.doUnmock('node-cron');
    vi.doUnmock('../services/cron-comodato.service.js');
    vi.doUnmock('../services/baixa-pedido.service.js');
    vi.doUnmock('../services/alerta-espelho-recebimentos.service.js');
    vi.doUnmock('../services/pc-visto.service.js');
    vi.resetModules();
  });

  it('um alerta que falha não impede o registro do cache (cada chamada é independente)', async () => {
    vi.resetModules();
    const jobs: Array<{ expr: string; fn: () => void }> = [];
    const registrarSpy = vi.fn().mockResolvedValue(0);
    vi.doMock('node-cron', () => ({ default: { schedule: (expr: string, fn: () => void) => jobs.push({ expr, fn }) } }));
    vi.doMock('../services/cron-comodato.service.js', () => ({ processarAlertasComodatoVencido: vi.fn() }));
    vi.doMock('../services/baixa-pedido.service.js', () => ({ reprocessarBaixasAguardandoVinculo: vi.fn() }));
    vi.doMock('../services/alerta-espelho-recebimentos.service.js', () => ({
      verificarEspelhoRecebimentos: vi.fn().mockRejectedValue(new Error('SendGrid fora')),
      verificarCopiaPcs: vi.fn().mockRejectedValue(new Error('banco fora')),
    }));
    vi.doMock('../services/pc-visto.service.js', () => ({ registrarPcsVistos: registrarSpy }));
    const { iniciarCronsStockBridge } = await import('../cron/index.js');
    iniciarCronsStockBridge();

    jobs.find((j) => j.expr === '5,35 * * * *')!.fn();
    await Promise.resolve();
    expect(registrarSpy).toHaveBeenCalledWith('q2p');

    vi.doUnmock('node-cron');
    vi.doUnmock('../services/cron-comodato.service.js');
    vi.doUnmock('../services/baixa-pedido.service.js');
    vi.doUnmock('../services/alerta-espelho-recebimentos.service.js');
    vi.doUnmock('../services/pc-visto.service.js');
    vi.resetModules();
  });
});
