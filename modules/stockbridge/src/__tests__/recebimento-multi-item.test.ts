import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processarRecebimento,
  ratearValorNf,
  agruparItensNf,
  ProdutosSemCorrelatoError,
  QuantidadeExcedeNfError,
  ValidacaoRecebimentoError,
} from '../services/recebimento.service.js';

// Feature 013 (ACXEGDP-115): recebimento de NF de importação com N produtos.
//  - US1: caminho feliz — N entradas independentes, valores RATEADOS por linha
//  - US2: divergência POR ITEM (item exato entra; divergente vai à aprovação)
//  - US3: tudo-ou-nada — produto sem correlato Q2P bloqueia a NF inteira
//  - Resumível: falha de ACXE num item não persiste nada dele; re-submeter
//    completa só os faltantes (idempotência por produto, migration 0046)

const incluirSpy = vi.fn();
const listarSpy = vi.fn();
const consultarNFSpy = vi.fn();
const correlacaoQuerySpy = vi.fn();

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getPool: () => ({
    query: (sql: string, params?: unknown[]) =>
      typeof sql === 'string' && sql.includes('tbl_nf_header')
        ? Promise.resolve({ rows: [{ cancelada: false, emitente_acxe: true }] })
        : correlacaoQuerySpy(sql, params),
  }),
  getConfig: () => ({
    SEED_ADMIN_EMAIL: 'admin@atlas.local',
    MODULE_STOCKBRIDGE_ENABLED: true,
    APP_URL: 'https://atlas.test',
  }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildEmailLayout: (o: { titulo?: string }) => ({ html: String(o?.titulo ?? ''), text: String(o?.titulo ?? '') }),
  escapeHtml: (v: unknown) => (v == null ? '' : String(v)),
  emailDataList: () => '',
  emailActionBox: (html: string) => html,
}));

vi.mock('@atlas/db', () => ({
  lote: { __id: 'lote' },
  movimentacao: { __id: 'movimentacao' },
  movimentacaoLegado: { __id: 'movimentacaoLegado' },
  aprovacao: { __id: 'aprovacao' },
  localidade: { __id: 'localidade' },
  localidadeCorrelacao: { __id: 'localidadeCorrelacao' },
  users: { __id: 'users' },
  userModules: { __id: 'userModules' },
}));

vi.mock('@atlas/integration-omie', () => ({
  incluirAjusteEstoque: (...args: unknown[]) => incluirSpy(...args),
  listarAjusteEstoque: (...args: unknown[]) => listarSpy(...args),
  consultarNF: (...args: unknown[]) => consultarNFSpy(...args),
  isMockMode: () => false,
}));

interface ChainMock {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  transaction: (fn: (tx: ChainMock) => Promise<unknown>) => Promise<unknown>;
}

/** Chain por-tabela; leafs resolvem em .limit() E por await direto (thenable). */
function criarChain(rowsByTable: Map<{ __id: string }, unknown[]>): ChainMock {
  let seq = 0;
  const chain: ChainMock = {
    select: vi.fn(() => chain) as never,
    from: vi.fn((table: { __id: string }) => {
      const rows = rowsByTable.get(table) ?? [];
      const leaf = {
        where: vi.fn(() => leaf),
        innerJoin: vi.fn(() => leaf),
        limit: vi.fn(() => Promise.resolve(rows)),
        then: (res?: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(res, rej),
      };
      return leaf;
    }) as never,
    insert: vi.fn().mockReturnThis() as never,
    values: vi.fn().mockReturnThis() as never,
    // Cada INSERT devolve um id/codigo sequencial — suficiente para N itens.
    returning: vi.fn(() => {
      seq += 1;
      return Promise.resolve([{ id: `id-${seq}`, codigo: `L${String(seq).padStart(3, '0')}` }]);
    }) as never,
    execute: vi.fn().mockResolvedValue({ rows: [{ next_val: '42' }] }) as never,
    transaction: async (fn) => fn(chain),
  };
  return chain;
}

const LOC_A = '00000000-0000-0000-0000-0000000000aa';
const LOC_B = '00000000-0000-0000-0000-0000000000bb';

/** NF de 3 produtos: pesos comerciais 30k/15k/15k sobre vNF=60k → rateio 30k/15k/15k. */
const nfTresProdutos = {
  nNF: '00004302', cChaveNFe: 'C', dEmi: '15/07/2026',
  vNF: 60_000, nCodCli: 1, cRazao: 'FORN MOCK',
  itens: [
    { nCodProd: 1001, codigoLocalEstoque: '999', qCom: 25_000, uCom: 'KG', xProd: 'PEAD 5502', vUnCom: 1.2 },
    { nCodProd: 1002, codigoLocalEstoque: '999', qCom: 10_000, uCom: 'KG', xProd: 'PP RAFIA', vUnCom: 1.5 },
    { nCodProd: 1003, codigoLocalEstoque: '999', qCom: 5_000, uCom: 'KG', xProd: 'ABS GP22', vUnCom: 3 },
  ],
};

function inputTresItens(overrides?: Partial<Record<1001 | 1002 | 1003, Partial<{
  quantidadeInput: number; observacoes: string; tipoDivergencia: 'faltando' | 'varredura'; localidadeId: string;
}>>>) {
  const base = {
    1001: { quantidadeInput: 25_000, localidadeId: LOC_A },
    1002: { quantidadeInput: 10_000, localidadeId: LOC_A },
    1003: { quantidadeInput: 5_000, localidadeId: LOC_B },
  } as const;
  return {
    nf: '4302',
    cnpj: 'acxe' as const,
    itens: ([1001, 1002, 1003] as const).map((cod) => ({
      produtoCodigoAcxe: cod,
      quantidadeInput: overrides?.[cod]?.quantidadeInput ?? base[cod].quantidadeInput,
      unidadeInput: 'kg' as const,
      localidadeId: overrides?.[cod]?.localidadeId ?? base[cod].localidadeId,
      observacoes: overrides?.[cod]?.observacoes,
      tipoDivergencia: overrides?.[cod]?.tipoDivergencia,
    })),
    userId: '00000000-0000-0000-0000-000000000001',
  };
}

async function cenarioTresProdutos(opts?: { semCorrelato?: number[] }): Promise<ChainMock> {
  const dbMod = await import('@atlas/db');
  const rows = new Map<{ __id: string }, unknown[]>([
    [dbMod.movimentacao as never, []],
    [dbMod.lote as never, []],
    [dbMod.movimentacaoLegado as never, []],
    [dbMod.localidade as never, [
      { id: LOC_A, codigo: 'EXT', nome: 'Extrema', ativo: true },
      { id: LOC_B, codigo: 'STO', nome: 'Santo André', ativo: true },
    ]],
    [dbMod.localidadeCorrelacao as never, [
      { localidadeId: LOC_A, codigoLocalEstoqueAcxe: 111, codigoLocalEstoqueQ2p: 222 },
      { localidadeId: LOC_B, codigoLocalEstoqueAcxe: 333, codigoLocalEstoqueQ2p: 444 },
    ]],
    [(dbMod as never as Record<string, { __id: string }>).users as never, [{ email: 'gestor@acxe.local' }]],
  ]);
  const chain = criarChain(rows);
  const { getDb } = await import('@atlas/core');
  vi.mocked(getDb).mockReturnValue(chain as never);

  // Correlação por produto: params[0] = codigoProdutoAcxe. Produtos em
  // `semCorrelato` devolvem 0 linhas (e a query de contexto legível devolve labels).
  correlacaoQuerySpy.mockImplementation((sql: string, params?: unknown[]) => {
    if (typeof sql === 'string' && sql.includes('produto_label')) {
      return Promise.resolve({ rows: [{ produto_label: 'PRODUTO X', local_label: '11.1 — Santo André' }] });
    }
    const cod = Number(params?.[0]);
    if (opts?.semCorrelato?.includes(cod)) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({
      rows: [{
        codigo_produto_acxe: cod,
        codigo_produto_q2p: cod + 1000,
        descricao: nfTresProdutos.itens.find((i) => i.nCodProd === cod)?.xProd ?? 'PROD',
        codigo_local_estoque_acxe: 111,
        codigo_local_estoque_q2p: 222,
      }],
    });
  });

  return chain;
}

beforeEach(() => {
  incluirSpy.mockReset();
  listarSpy.mockReset();
  consultarNFSpy.mockReset();
  correlacaoQuerySpy.mockReset();
  incluirSpy.mockImplementation((cnpj: string) =>
    Promise.resolve({ idMovest: `M-${cnpj}-${incluirSpy.mock.calls.length}`, idAjuste: `A-${cnpj}-${incluirSpy.mock.calls.length}`, descricaoStatus: 'ok' }),
  );
  consultarNFSpy.mockResolvedValue(nfTresProdutos);
});

// ── Funções puras (rateio + agregação) ─────────────────────

describe('ratearValorNf (D2 — rateio com tributos)', () => {
  it('N=1 devolve o vNF inteiro (reduz ao single-item)', () => {
    expect(ratearValorNf(30_000, [123])).toEqual([30_000]);
  });

  it('rateia proporcional ao peso comercial e a soma bate EXATA com o vNF (resíduo no último)', () => {
    const valores = ratearValorNf(100, [1, 1, 1]);
    expect(valores).toEqual([33.33, 33.33, 33.34]);
    expect(valores.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
  });

  it('pesos proporcionais → fatias proporcionais', () => {
    expect(ratearValorNf(60_000, [30_000, 15_000, 15_000])).toEqual([30_000, 15_000, 15_000]);
  });

  it('pesos todos zero → rateio igualitário (sem divisão por zero)', () => {
    expect(ratearValorNf(90, [0, 0, 0])).toEqual([30, 30, 30]);
  });
});

describe('agruparItensNf (FR-013 — linhas repetidas do mesmo produto)', () => {
  it('duas linhas do MESMO produto somam quantidade e peso (nada se perde)', () => {
    const agregados = agruparItensNf([
      { nCodProd: 1001, codigoLocalEstoque: '999', qCom: 10_000, uCom: 'KG', xProd: 'PEAD', vUnCom: 1.2 },
      { nCodProd: 1001, codigoLocalEstoque: '999', qCom: 5_000, uCom: 'KG', xProd: 'PEAD', vUnCom: 1.2 },
      { nCodProd: 1002, codigoLocalEstoque: '999', qCom: 2, uCom: 't', xProd: 'PP', vUnCom: 900 },
    ]);
    expect(agregados).toHaveLength(2);
    const pead = agregados.find((a) => a.nCodProd === 1001)!;
    expect(pead.qtdNfKg).toBe(15_000);
    expect(pead.pesoValorComercial).toBeCloseTo(1.2 * 15_000, 6);
    const pp = agregados.find((a) => a.nCodProd === 1002)!;
    expect(pp.qtdNfKg).toBe(2_000); // 2 t → kg
  });
});

// ── US1 — caminho feliz multi-item ─────────────────────────

describe('US1 — NF de 3 produtos, quantidades conferem (T013/T014)', () => {
  it('cria 3 entradas independentes: 6 ajustes OMIE com cod_int_ajuste distintos por produto', async () => {
    const chain = await cenarioTresProdutos();

    const res = await processarRecebimento(inputTresItens());

    expect(res.resumo).toMatchObject({ recebidos: 3, aguardandoAprovacao: 0, pendentesOmie: 0, falhas: 0 });
    expect(res.itens.every((i) => i.status === 'provisorio')).toBe(true);

    // 6 ajustes: (acxe-trf + q2p-ent) × 3 produtos, cada par com opId próprio
    expect(incluirSpy).toHaveBeenCalledTimes(6);
    const codInts = incluirSpy.mock.calls.map((c) => (c[1] as { codIntAjuste: string }).codIntAjuste);
    expect(new Set(codInts).size).toBe(6);
    const opIds = new Set(codInts.map((c) => c.split(':')[0]));
    expect(opIds.size).toBe(3);

    // 3 lotes + 3 movimentações persistidos
    const valuesCalls = (chain.values as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    expect(valuesCalls.filter((c) => 'quantidadeFiscalKg' in c[0]!)).toHaveLength(3);
    expect(valuesCalls.filter((c) => 'idMovestAcxe' in c[0]!)).toHaveLength(3);
  });

  it('cada produto é valorado pela SUA linha (rateio) — não pelo total da NF', async () => {
    await cenarioTresProdutos();

    await processarRecebimento(inputTresItens());

    // ACXE recebe valor unitário = valorItem/qtdItem (não vNF/qtdTotal):
    // produto 1001: 30_000/25_000 = 1.2 · 1002: 15_000/10_000 = 1.5 · 1003: 15_000/5_000 = 3
    const chamadasAcxe = incluirSpy.mock.calls.filter((c) => c[0] === 'acxe');
    const valoresAcxe = chamadasAcxe.map((c) => (c[1] as { valor: number }).valor).sort((a, b) => a - b);
    expect(valoresAcxe).toEqual([1.2, 1.5, 3]);

    // Q2P com markup 14,5%: ceil(v×1.145×100)/100 → 1.38 / 1.72 / 3.44
    const chamadasQ2p = incluirSpy.mock.calls.filter((c) => c[0] === 'q2p');
    const valoresQ2p = chamadasQ2p.map((c) => (c[1] as { valor: number }).valor).sort((a, b) => a - b);
    expect(valoresQ2p).toEqual([1.38, 1.72, 3.44]);
  });

  it('valorTotalNfBrl de cada lote carrega o valor RATEADO do item e a soma bate com o vNF', async () => {
    const chain = await cenarioTresProdutos();

    await processarRecebimento(inputTresItens());

    const valuesCalls = (chain.values as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    const lotes = valuesCalls.filter((c) => 'valorTotalNfBrl' in c[0]!);
    const soma = lotes.reduce((acc, c) => acc + Number(c[0]!.valorTotalNfBrl), 0);
    expect(soma).toBe(60_000);
  });

  it('produtos podem ir para localidades DIFERENTES (por item)', async () => {
    const chain = await cenarioTresProdutos();

    await processarRecebimento(inputTresItens());

    const valuesCalls = (chain.values as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    const lotes = valuesCalls.filter((c) => 'localidadeId' in c[0]! && 'quantidadeFiscalKg' in c[0]!);
    const locs = new Set(lotes.map((c) => c[0]!.localidadeId));
    expect(locs).toEqual(new Set([LOC_A, LOC_B]));
  });
});

// ── US2 — divergência por item ─────────────────────────────

describe('US2 — divergência por produto (T021/T022/T023)', () => {
  it('1 item divergente + 2 exatos: os exatos entram, o divergente vai à aprovação', async () => {
    const chain = await cenarioTresProdutos();

    const res = await processarRecebimento(inputTresItens({
      1002: { quantidadeInput: 9_680, observacoes: 'faltaram 8 sacos', tipoDivergencia: 'faltando' },
    }));

    expect(res.resumo).toMatchObject({ recebidos: 2, aguardandoAprovacao: 1, pendentesOmie: 0, falhas: 0 });
    const divergente = res.itens.find((i) => i.produtoCodigoAcxe === 1002)!;
    expect(divergente.status).toBe('aguardando_aprovacao');
    expect(divergente.aprovacaoId).toBeDefined();
    expect(divergente.deltaKg).toBe(-320);

    // OMIE: só os 2 itens exatos (4 chamadas); o divergente NÃO toca OMIE agora
    expect(incluirSpy).toHaveBeenCalledTimes(4);

    // aprovacao criada para o item divergente
    const valuesCalls = (chain.values as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    const aprovacoes = valuesCalls.filter((c) => 'tipoAprovacao' in c[0]!);
    expect(aprovacoes).toHaveLength(1);
    expect(aprovacoes[0]![0]).toMatchObject({ tipoAprovacao: 'recebimento_divergencia', tipoDivergencia: 'faltando' });
  });

  it('excedente em um item bloqueia a NF inteira ANTES de qualquer OMIE (regra por item)', async () => {
    await cenarioTresProdutos();

    await expect(
      processarRecebimento(inputTresItens({ 1003: { quantidadeInput: 5_500 } })),
    ).rejects.toBeInstanceOf(QuantidadeExcedeNfError);
    await expect(
      processarRecebimento(inputTresItens({ 1003: { quantidadeInput: 5_500 } })),
    ).rejects.toThrow(/ABS GP22/);

    expect(incluirSpy).not.toHaveBeenCalled();
  });

  it('item divergente sem motivo/tipo → bloqueio nomeando o produto, zero escrita', async () => {
    await cenarioTresProdutos();

    await expect(
      processarRecebimento(inputTresItens({ 1002: { quantidadeInput: 9_000 } })),
    ).rejects.toBeInstanceOf(ValidacaoRecebimentoError);
    await expect(
      processarRecebimento(inputTresItens({ 1002: { quantidadeInput: 9_000 } })),
    ).rejects.toThrow(/PP RAFIA/);
    expect(incluirSpy).not.toHaveBeenCalled();
  });

  it('2+ itens divergentes → UM e-mail digest por gestor (não um por item)', async () => {
    await cenarioTresProdutos();
    const core = await import('@atlas/core');
    vi.mocked(core.sendEmail).mockClear();

    const res = await processarRecebimento(inputTresItens({
      1002: { quantidadeInput: 9_000, observacoes: 'avaria', tipoDivergencia: 'faltando' },
      1003: { quantidadeInput: 4_500, observacoes: 'varredura', tipoDivergencia: 'varredura' },
    }));
    expect(res.resumo.aguardandoAprovacao).toBe(2);

    await vi.waitFor(() => expect(core.sendEmail).toHaveBeenCalled());
    const emailsAprovacao = vi.mocked(core.sendEmail).mock.calls
      .map((c) => c[0] as { to: string; subject: string })
      .filter((e) => e.subject.includes('divergência'));
    // 1 gestor mockado → 1 e-mail digest, listando os 2 itens no assunto
    expect(emailsAprovacao).toHaveLength(1);
    expect(emailsAprovacao[0]!.subject).toMatch(/2 itens com divergência/);
  });
});

// ── US3 — tudo-ou-nada por correlação ──────────────────────

describe('US3 — produto sem correlato bloqueia a NF inteira (T029/T030)', () => {
  it('1 de 3 sem correlato → ProdutosSemCorrelatoError nomeando o produto; ZERO escrita', async () => {
    const chain = await cenarioTresProdutos({ semCorrelato: [1002] });

    let capturado: unknown;
    try {
      await processarRecebimento(inputTresItens());
    } catch (err) {
      capturado = err;
    }

    expect(capturado).toBeInstanceOf(ProdutosSemCorrelatoError);
    expect((capturado as Error).message).toMatch(/PP RAFIA/);
    expect((capturado as Error).message).toMatch(/nenhum item da NF foi recebido/);

    // Nada no OMIE, nada no banco — INV-4 (zero-write)
    expect(incluirSpy).not.toHaveBeenCalled();
    expect(chain.insert).not.toHaveBeenCalled();
    expect(chain.values).not.toHaveBeenCalled();
  });

  it('item que não pertence à NF → bloqueio total com orientação', async () => {
    await cenarioTresProdutos();
    const input = inputTresItens();
    input.itens[0]!.produtoCodigoAcxe = 9999;

    await expect(processarRecebimento(input)).rejects.toBeInstanceOf(ValidacaoRecebimentoError);
    expect(incluirSpy).not.toHaveBeenCalled();
  });

  it('cobertura incompleta (faltou um produto da NF no request) → bloqueio nomeando o faltante', async () => {
    await cenarioTresProdutos();
    const input = inputTresItens();
    input.itens = input.itens.slice(0, 2); // omite o produto 1003

    await expect(processarRecebimento(input)).rejects.toThrow(/ABS GP22/);
    expect(incluirSpy).not.toHaveBeenCalled();
  });
});

// ── Resumível (T031) ───────────────────────────────────────

describe('Recebimento resumível (idempotência por produto, migration 0046)', () => {
  it('falha de ACXE no 2º produto: os outros concluem; re-submeter completa só o faltante', async () => {
    await cenarioTresProdutos();
    // ACXE do produto 1002 falha (2ª chamada acxe); demais ok.
    let chamadasAcxe = 0;
    incluirSpy.mockImplementation((cnpj: string) => {
      if (cnpj === 'acxe') {
        chamadasAcxe += 1;
        if (chamadasAcxe === 2) return Promise.reject(new Error('OMIE ACXE timeout'));
      }
      return Promise.resolve({ idMovest: `M-${cnpj}-${incluirSpy.mock.calls.length}`, idAjuste: `A-${cnpj}-${incluirSpy.mock.calls.length}`, descricaoStatus: 'ok' });
    });

    const res1 = await processarRecebimento(inputTresItens());
    expect(res1.resumo).toMatchObject({ recebidos: 2, falhas: 1 });
    const falho = res1.itens.find((i) => i.status === 'falha_acxe')!;
    expect(falho.produtoCodigoAcxe).toBe(1002);
    expect(falho.loteId).toBeUndefined(); // nada persistido do item que falhou

    // Re-submissão: produtos 1001/1003 agora constam como recebidos no banco.
    const dbMod = await import('@atlas/db');
    const rows = new Map<{ __id: string }, unknown[]>([
      // produtoDaNfJaRecebido: movimentacao ativa existe (mock devolve linha p/
      // qualquer produto — exceto quando a query for do produto 1002, que o mock
      // por-tabela não distingue; simplificação: usamos lote para diferenciar).
      [dbMod.movimentacaoLegado as never, []],
      [dbMod.localidade as never, [
        { id: LOC_A, codigo: 'EXT', nome: 'Extrema', ativo: true },
        { id: LOC_B, codigo: 'STO', nome: 'Santo André', ativo: true },
      ]],
      [dbMod.localidadeCorrelacao as never, [
        { localidadeId: LOC_A, codigoLocalEstoqueAcxe: 111, codigoLocalEstoqueQ2p: 222 },
        { localidadeId: LOC_B, codigoLocalEstoqueAcxe: 333, codigoLocalEstoqueQ2p: 444 },
      ]],
      [(dbMod as never as Record<string, { __id: string }>).users as never, [{ email: 'gestor@acxe.local' }]],
    ]);
    // Discrimina por produto: a chain simples não lê o where; este teste usa um
    // from(movimentacao) custom que devolve linha para 1001/1003 e nada p/ 1002.
    // A ordem das checagens segue a ordem dos itens do request (1001, 1002, 1003).
    let checagem = 0;
    const chain2 = criarChain(rows);
    const fromOriginal = chain2.from;
    (chain2 as { from: unknown }).from = vi.fn((table: { __id: string }) => {
      if (table.__id === 'movimentacao') {
        checagem += 1;
        const recebido = checagem !== 2; // 2ª checagem = produto 1002 (não recebido)
        const data = recebido ? [{ id: `mov-${checagem}` }] : [];
        const leaf = {
          where: vi.fn(() => leaf),
          innerJoin: vi.fn(() => leaf),
          limit: vi.fn(() => Promise.resolve(data)),
          then: (res?: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve(data).then(res, rej),
        };
        return leaf;
      }
      return (fromOriginal as (t: { __id: string }) => unknown)(table);
    }) as never;
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(chain2 as never);

    incluirSpy.mockClear();
    incluirSpy.mockImplementation((cnpj: string) =>
      Promise.resolve({ idMovest: `M2-${cnpj}`, idAjuste: `A2-${cnpj}`, descricaoStatus: 'ok' }),
    );

    const res2 = await processarRecebimento(inputTresItens());

    expect(res2.resumo).toMatchObject({ recebidos: 1, jaRecebidos: 2, falhas: 0 });
    const completado = res2.itens.find((i) => i.status === 'provisorio')!;
    expect(completado.produtoCodigoAcxe).toBe(1002);
    // Só o produto faltante tocou o OMIE (1 par de ajustes)
    expect(incluirSpy).toHaveBeenCalledTimes(2);
  });
});
