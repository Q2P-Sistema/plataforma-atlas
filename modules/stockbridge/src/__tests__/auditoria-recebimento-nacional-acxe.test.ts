import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437), migration 0058 — compra nacional da ACXE contra um Postgres REAL.
//
// Os testes unitarios (recebimento-nacional-acxe, aprovacao-entrada-nacional-acxe, operacoes-pendentes-entrada-
// nacional, ...) trocam o banco por fakes: provam a logica, nao o SQL nem o schema. Aqui o SQL, os indices unicos
// (0052 e 0058), os CHECKs, as FKs e as triggers de auditoria (Principio IV) rodam de verdade, de ponta a ponta:
//   POST por NF (INSERT de movimentacao + aprovacao) -> aprovacao do gestor (duas pernas no OMIE) -> perna Q2P
//   pendente -> "Retentar Q2P" -> Movimentacoes; mais destinos, correspondente (gemeo) e exclusao por empresa.
// So o limite com o mundo e substituido: o OMIE (incluirAjusteIdempotente e @atlas/integration-omie — o OMIE real
// NUNCA e chamado), a leitura do detalhe da NF no espelho (montarDetalheNfNacional) e os e-mails.
//
// Mesmo opt-in dos outros auditoria-*.test.ts: ATLAS_DB_INTEGRATION=1 + DATABASE_URL. Sem ele o describe e PULADO
// (nunca falha por falta de banco, nunca "passa" fingindo).
//
// Rodar:  ATLAS_DB_INTEGRATION=1 DATABASE_URL=postgres://... pnpm --filter @atlas/stockbridge exec vitest run src/__tests__/auditoria-recebimento-nacional-acxe.test.ts
//
// Precisa de: migrations ate a 0058 aplicadas (locais 11.1/12.1/21.1/21.2/31.1/20.0.5/20.0.7 com correlacao, indice
// movimentacao_nf_nacional_acxe_idempotencia_idx, fornecedor_exclusao.empresa), shared.audit_log e ao menos um
// usuario em atlas.users. As tabelas do ESPELHO OMIE (public."tbl_produtos_*" e "tbl_nf_header_*") sao do n8n, nao das
// migrations: este teste as CRIA (so com as colunas que as consultas leem) e as remove no fim — e SO se ainda NAO
// existirem. Se ja existirem (banco com o espelho real) os testes que dependem delas sao PULADOS: este teste nunca
// escreve no espelho. Use um Postgres descartavel (nunca PROD/UAT): as linhas de teste de movimentacao/aprovacao/
// fornecedor_exclusao sao apagadas no fim, mas shared.audit_log e append-only e guarda o rastro.

const DB_URL = process.env.DATABASE_URL;
const temBanco = process.env.ATLAS_DB_INTEGRATION === '1' && typeof DB_URL === 'string' && DB_URL.length > 0;

type ChamadaOmie = { empresa: 'acxe' | 'q2p'; codInt: string; input: Record<string, unknown>; opts?: Record<string, unknown> };

const h = vi.hoisted(() => ({
  chamadas: [] as Array<{ empresa: 'acxe' | 'q2p'; codInt: string; input: Record<string, unknown>; opts?: Record<string, unknown> }>,
  resposta: null as null | ((c: { empresa: 'acxe' | 'q2p'; codInt: string; input: Record<string, unknown> }) => Promise<{ idMovest: string; idAjuste: string; jaExistia: boolean }>),
  detalhe: vi.fn(),
  alertaPendencia: vi.fn(),
  digest: vi.fn(),
  notificaOperador: vi.fn(),
  notificaRejeicao: vi.fn(),
  baixa: vi.fn(),
  userId: '' as string,
  role: 'gestor' as 'operador' | 'gestor' | 'diretor',
}));

// ── Limites com o mundo (sempre mockados; o banco e o resto sao REAIS) ─────────────────────────────────
vi.mock('../services/omie-idempotente.js', () => ({
  incluirAjusteIdempotente: (empresa: 'acxe' | 'q2p', codInt: string, input: Record<string, unknown>, opts?: Record<string, unknown>) => {
    h.chamadas.push({ empresa, codInt, input, opts });
    if (!h.resposta) throw new Error('teste sem resposta do OMIE configurada');
    return h.resposta({ empresa, codInt, input });
  },
}));

vi.mock('@atlas/integration-omie', () => {
  const proibido = (nome: string) => () => {
    throw new Error(`OMIE real proibido neste teste (${nome})`);
  };
  return {
    consultarRecebimentoNfe: proibido('consultarRecebimentoNfe'),
    alterarRecebimentoNfeItens: proibido('alterarRecebimentoNfeItens'),
    concluirRecebimentoNfe: proibido('concluirRecebimentoNfe'),
    consultarPedidoCompra: proibido('consultarPedidoCompra'),
    incluirAjusteEstoque: proibido('incluirAjusteEstoque'),
    listarAjusteEstoque: proibido('listarAjusteEstoque'),
    consultarNF: proibido('consultarNF'),
    isMockMode: () => false,
  };
});

vi.mock('../services/baixa-pedido.service.js', () => ({ dispararBaixaPedidoQ2p: (a: unknown) => h.baixa(a) }));

// So para o bloco de contrato HTTP: a autenticacao e o vinculo de armazem sao os do usuario de teste (os servicos e o banco sao reais).
vi.mock('../middleware/role.js', () => {
  const auth = (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: h.userId, role: h.role };
    next();
  };
  return { requireOperador: auth, requireGestor: auth, requireDiretor: auth };
});
vi.mock('../middleware/armazem-vinculado.js', () => ({ requireArmazemVinculado: (_req: unknown, _res: unknown, next: () => void) => next() }));

vi.mock('../services/notificacao.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/notificacao.service.js')>('../services/notificacao.service.js');
  return {
    ...real,
    enviarAlertaPendenciaOmie: (a: unknown) => h.alertaPendencia(a),
    enviarAlertaRecebimentoNacionalLote: (a: unknown) => h.digest(a),
    enviarNotificacaoAprovacaoOperador: (a: unknown) => h.notificaOperador(a),
    enviarNotificacaoRejeicaoOperador: (a: unknown) => h.notificaRejeicao(a),
    enviarAlertaAprovacaoPendente: vi.fn(),
  };
});

vi.mock('../services/fila-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/fila-nacional.service.js')>('../services/fila-nacional.service.js');
  return { ...real, montarDetalheNfNacional: (c: string) => h.detalhe(c) };
});

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> };

/** Faixa propria de codigos de produto (bigint) — nao colide com codigos reais do OMIE nem entre execucoes. */
const BASE = 9_000_000_000_000 + Math.floor(Math.random() * 900_000_000) * 100;
const SUFIXO = String(BASE).slice(-8);
const P = {
  comGemeo: BASE + 1, // produto da ACXE com correspondente ativo na Q2P
  gemeo: BASE + 2, // o correspondente na Q2P
  semGemeo: BASE + 3, // produto da ACXE sem correspondente
  outroComMesmoGemeo: BASE + 4, // outro produto da ACXE com a MESMA descricao (mesmo correspondente)
  inativoAcxe: BASE + 5, // produto da ACXE inativo
  gemeoInativo: BASE + 6, // correspondente Q2P inativo (de um produto da ACXE que so tem esse)
  comGemeoInativo: BASE + 7, // produto da ACXE cujo unico correspondente na Q2P esta inativo
  dois1: BASE + 8, // produto da ACXE com DOIS correspondentes ativos na Q2P
  dois2a: BASE + 9, // correspondente Q2P de menor codigo
  dois2b: BASE + 10, // correspondente Q2P de maior codigo
};
const DESC = {
  comGemeo: `TESTE H5 PP PRETO ${SUFIXO}`,
  semGemeo: `TESTE H5 SUCATA SEM GEMEO ${SUFIXO}`,
  inativo: `TESTE H5 PRODUTO INATIVO ${SUFIXO}`,
  gemeoInativo: `TESTE H5 SO GEMEO INATIVO ${SUFIXO}`,
  dois: `TESTE H5 DOIS GEMEOS ${SUFIXO}`,
};
const FORNECEDOR_NF = `TESTE H5 FORNECEDOR ${SUFIXO}`;
const CNPJ_TESTE = `99.${SUFIXO.slice(0, 3)}.${SUFIXO.slice(3, 6)}/0001-${SUFIXO.slice(6, 8)}`;

describe.skipIf(!temBanco)('migration 0058 — compra nacional da ACXE: POST, aprovacao nas duas empresas, retry e destinos (integracao)', () => {
  let pool: Pool;
  let userId = '';
  let svc: {
    receber: typeof import('../services/recebimento-nacional.service.js');
    aprov: typeof import('../services/aprovacao.service.js');
    pend: typeof import('../services/operacoes-pendentes.service.js');
    mov: typeof import('../services/movimentacao.service.js');
    forn: typeof import('../services/fornecedor.service.js');
    notif: typeof import('../services/notificacao.service.js');
    unidade: typeof import('../services/unidade-nf.js');
    erros: typeof import('../services/recebimento.service.js');
  };
  /** id + codigos OMIE (texto) de cada estoque usado, lidos do proprio banco */
  const loc: Record<string, { id: string; acxe: string | null; q2p: string | null }> = {};
  const criou = { produtos: false, headers: false };
  const chaves: string[] = [];
  const testLocalIds: string[] = [];
  let seq = 0;

  const existe = async (tabela: string): Promise<boolean> => {
    const { rows } = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS existe`, [`public."${tabela}"`]);
    return rows[0]!.existe === true;
  };

  const chaveNova = (): string => {
    seq += 1;
    const c = `99${String(Date.now()).padStart(13, '0')}${String(seq).padStart(2, '0')}`.padEnd(44, '1');
    chaves.push(c);
    return c;
  };

  const ok = (sufixo: string) => async () => ({ idMovest: `MOV-${sufixo}`, idAjuste: `AJ-${sufixo}`, jaExistia: false });

  function detalheAcxe(chave: string, over: { itens?: unknown[]; valorTotal?: number; kg?: number; descricao?: string } = {}) {
    const kg = over.kg ?? 26000;
    const valor = over.valorTotal ?? 124800;
    const descricao = over.descricao ?? DESC.comGemeo;
    const item = {
      indice: 0, descricaoFornecedor: descricao, descricaoNormalizada: descricao.toUpperCase(), cfop: '1.101', quantidadeNf: kg, unidadeOriginal: 'KG',
      quantidadeNfKg: kg, valorUnitarioBrl: valor / kg, valorTotalItemBrl: valor, rsPorKg: valor / kg, linhasAgregadas: 1, produtosSugeridos: [],
      bloqueio: 'sem_correlacao', bloqueioMensagem: null, jaRecebido: false, quantidadeNfJaAtribuidaKg: 0, quantidadeConferidaJaGravadaKg: 0,
      quantidadeRestanteKg: kg, baixadoComoExterno: false, baixaSolicitada: false, conversao: svc.unidade.converterItemNfParaKg(kg, 'KG', valor),
      sequenciasRecebimento: [1], pc: null,
    };
    return {
      detalhe: {
        nfChaveAcesso: chave, notaFiscal: `H5${SUFIXO.slice(-4)}`, fornecedorNome: FORNECEDOR_NF, fornecedorCnpj: CNPJ_TESTE,
        dtEmissao: '2026-10-20', diasDesdeEmissao: 2, cfop: '1.101', valorTotalBrl: valor, valorNotaBrl: valor, itens: over.itens ?? [item],
        linhasForaDoRecorte: 0, fiscal: 'concluido', nIdReceb: null, dispensavel: true, empresa: 'acxe', exigePc: false,
        estoqueLancadoPeloOmie: false, copiaPcsDefasada: false, itensSemAvaliacaoPc: [], pcsDaNf: { pcs: [], preSelecionado: null },
      },
      interno: { fornecedorCodigo: 1111, espelhoConfirmaConclusao: true, pcPorIndice: new Map() },
    };
  }

  /** POST por NF da ACXE com os produtos informados no item 0; devolve o resultado do servico. */
  async function receberNaAcxe(
    chave: string,
    produtos: Array<{ produtoCodigoAcxe: number; localidade: string; quantidadeKg: number }>,
    detalheOver: Parameters<typeof detalheAcxe>[1] = {},
  ) {
    h.detalhe.mockResolvedValue(detalheAcxe(chave, detalheOver));
    return svc.receber.processarRecebimentoNacionalPorNf({
      nfChaveAcesso: chave,
      userId,
      itens: [
        {
          indice: 0,
          descricaoFornecedor: detalheOver.descricao ?? DESC.comGemeo,
          produtos: produtos.map((p) => ({ produtoCodigoAcxe: p.produtoCodigoAcxe, quantidadeKg: p.quantidadeKg, localidadeId: loc[p.localidade]!.id })),
        },
      ],
    });
  }

  const movDaNf = async (chave: string) =>
    (await pool.query(`SELECT * FROM stockbridge.movimentacao WHERE nf_chave_acesso = $1 ORDER BY created_at, id`, [chave])).rows;
  const aprDaNf = async (chave: string) =>
    (await pool.query(`SELECT * FROM stockbridge.aprovacao WHERE nf_chave_acesso = $1 ORDER BY created_at, id`, [chave])).rows;
  const movPorId = async (id: string) => (await pool.query(`SELECT * FROM stockbridge.movimentacao WHERE id = $1`, [id])).rows[0]!;
  const aprPorId = async (id: string) => (await pool.query(`SELECT * FROM stockbridge.aprovacao WHERE id = $1`, [id])).rows[0]!;
  const auditoriaDe = async (tabela: string, id: string) =>
    (
      await pool.query(
        `SELECT operation FROM shared.audit_log WHERE schema_name = 'stockbridge' AND table_name = $1 AND record_id = $2 ORDER BY id`,
        [tabela, id],
      )
    ).rows.map((r) => r.operation);

  /** Cria uma entrada (movimentacao + aprovacao pendentes) pelo POST por NF e devolve os ids. */
  async function criarEntrada(localidade: string, produtoCodigoAcxe = P.comGemeo) {
    const chave = chaveNova();
    const r = await receberNaAcxe(chave, [{ produtoCodigoAcxe, localidade, quantidadeKg: 26000 }]);
    const prod = r.produtos[0]!;
    expect(prod.status, JSON.stringify(prod)).toBe('aguardando_aprovacao');
    return { chave, movId: prod.movimentacaoId!, aprId: prod.aprovacaoId!, resultado: prod };
  }

  const aprovarGestor = (aprId: string) => svc.aprov.aprovar({ id: aprId, usuarioId: userId, perfilUsuario: 'gestor' });
  const retentar = (movId: string, role: 'gestor' | 'operador' = 'gestor') =>
    svc.pend.retentarOperacaoPendente({ movimentacaoId: movId, ator: { userId, role } });

  beforeAll(async () => {
    const core = await import('@atlas/core');
    pool = core.getPool() as unknown as Pool;
    svc = {
      receber: await import('../services/recebimento-nacional.service.js'),
      aprov: await import('../services/aprovacao.service.js'),
      pend: await import('../services/operacoes-pendentes.service.js'),
      mov: await import('../services/movimentacao.service.js'),
      forn: await import('../services/fornecedor.service.js'),
      notif: await import('../services/notificacao.service.js'),
      unidade: await import('../services/unidade-nf.js'),
      erros: await import('../services/recebimento.service.js'),
    };

    const { rows: users } = await pool.query(`SELECT id FROM atlas.users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`);
    expect(users.length, 'precisa de ao menos um usuario em atlas.users').toBeGreaterThan(0);
    userId = String(users[0]!.id);

    const { rows: locais } = await pool.query(
      `SELECT l.id::text AS id, l.codigo, lc.codigo_local_estoque_acxe::text AS acxe, lc.codigo_local_estoque_q2p::text AS q2p
         FROM stockbridge.localidade l
         JOIN stockbridge.localidade_correlacao lc ON lc.localidade_id = l.id
        WHERE l.codigo = ANY($1::text[])`,
      [['11.1', '12.1', '21.1', '31.1', '21.2', '20.0.5', '20.0.7', '11.2', '12.2', '90.0.2']],
    );
    for (const l of locais) loc[String(l.codigo)] = { id: String(l.id), acxe: (l.acxe as string | null) ?? null, q2p: (l.q2p as string | null) ?? null };
    for (const c of ['21.1', '12.1', '11.1', '20.0.7', '11.2', '90.0.2']) {
      expect(loc[c], `estoque ${c} precisa existir com correlacao (migrations ate a 0058)`).toBeDefined();
    }

    // Espelho de produtos (so se ainda nao existir — nunca escreve no espelho real)
    const [temAcxe, temQ2p] = [await existe('tbl_produtos_ACXE'), await existe('tbl_produtos_Q2P')];
    if (!temAcxe && !temQ2p) {
      for (const t of ['tbl_produtos_ACXE', 'tbl_produtos_Q2P']) {
        await pool.query(`CREATE TABLE public."${t}" (codigo_produto bigint PRIMARY KEY, descricao text, inativo varchar(1), unidade varchar(10))`);
      }
      criou.produtos = true;
      const ins = (t: string, codigo: number, descricao: string, inativo: string | null) =>
        pool.query(`INSERT INTO public."${t}" (codigo_produto, descricao, inativo, unidade) VALUES ($1, $2, $3, 'KG')`, [codigo, descricao, inativo]);
      await ins('tbl_produtos_ACXE', P.comGemeo, DESC.comGemeo, 'N');
      await ins('tbl_produtos_ACXE', P.semGemeo, DESC.semGemeo, 'N');
      await ins('tbl_produtos_ACXE', P.outroComMesmoGemeo, DESC.comGemeo, 'N');
      await ins('tbl_produtos_ACXE', P.inativoAcxe, DESC.inativo, 'S');
      await ins('tbl_produtos_ACXE', P.comGemeoInativo, DESC.gemeoInativo, null);
      await ins('tbl_produtos_ACXE', P.dois1, DESC.dois, 'N');
      await ins('tbl_produtos_Q2P', P.gemeo, DESC.comGemeo, 'N');
      await ins('tbl_produtos_Q2P', P.gemeoInativo, DESC.gemeoInativo, 'S');
      await ins('tbl_produtos_Q2P', P.dois2b, DESC.dois, null);
      await ins('tbl_produtos_Q2P', P.dois2a, DESC.dois, 'N');
    }
    // Espelho de NF (fornecedor pela chave de acesso) — so se ainda nao existir
    const [hAcxe, hQ2p] = [await existe('tbl_nf_header_ACXE'), await existe('tbl_nf_header_Q2P')];
    if (!hAcxe && !hQ2p) {
      for (const t of ['tbl_nf_header_ACXE', 'tbl_nf_header_Q2P']) {
        await pool.query(`CREATE TABLE public."${t}" (c_chave_nfe varchar(44), dest_razao varchar(255))`);
      }
      criou.headers = true;
    }
  });

  afterAll(async () => {
    if (!pool) return;
    // Dado de teste: hard delete e permitido aqui (a trigger registra o DELETE). Ordem das FKs: aprovacao -> movimentacao.
    if (chaves.length) {
      await pool.query(`DELETE FROM stockbridge.aprovacao WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
      await pool.query(`DELETE FROM stockbridge.movimentacao WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
    }
    await pool.query(`DELETE FROM stockbridge.fornecedor_exclusao WHERE fornecedor_cnpj = $1`, [CNPJ_TESTE]);
    if (testLocalIds.length) await pool.query(`DELETE FROM stockbridge.localidade WHERE id = ANY($1::uuid[])`, [testLocalIds]); // a correlacao sai em cascata
    if (criou.produtos) for (const t of ['tbl_produtos_ACXE', 'tbl_produtos_Q2P']) await pool.query(`DROP TABLE IF EXISTS public."${t}"`);
    if (criou.headers) for (const t of ['tbl_nf_header_ACXE', 'tbl_nf_header_Q2P']) await pool.query(`DROP TABLE IF EXISTS public."${t}"`);
  });

  beforeEach(() => {
    h.chamadas.length = 0;
    h.resposta = async (c) => ok(c.empresa.toUpperCase())();
    h.detalhe.mockReset();
    h.alertaPendencia.mockReset();
    h.digest.mockReset();
    h.digest.mockResolvedValue(undefined);
    h.notificaOperador.mockReset();
    h.notificaRejeicao.mockReset();
    h.baixa.mockReset();
  });

  // ───────────────────────────── destinos e produtos ─────────────────────────────

  it('destinos da ACXE (SQL real): 11.1/12.1/21.1/31.1 entram nas duas e vem primeiro; 21.2/20.0.5/20.0.7 so na ACXE; sem virtuais nem estoque so da Q2P; sem codigo OMIE', async () => {
    const acxe = await svc.receber.listarDestinosEntradaNf('acxe');
    const codigos = acxe.map((d) => d.codigo);
    expect(codigos).toEqual(expect.arrayContaining(['11.1', '12.1', '21.1', '31.1', '21.2', '20.0.5', '20.0.7']));
    for (const fora of ['90.0.1', '90.0.2', '10.0.3', '11.2', '12.2']) expect(codigos, `${fora} nao e destino da ACXE`).not.toContain(fora);
    expect(acxe.every((d) => !d.tipo.startsWith('virtual'))).toBe(true);
    const porCodigo = Object.fromEntries(acxe.map((d) => [d.codigo, d.entradaEm]));
    for (const c of ['11.1', '12.1', '21.1', '31.1']) expect(porCodigo[c], c).toEqual(['acxe', 'q2p']);
    for (const c of ['21.2', '20.0.5', '20.0.7']) expect(porCodigo[c], c).toEqual(['acxe']);
    // ordem: todos os que entram nas duas antes dos so-ACXE
    const ultimaDuas = Math.max(...acxe.map((d, i) => (d.entradaEm.length === 2 ? i : -1)));
    const primeiraSo = Math.min(...acxe.map((d, i) => (d.entradaEm.length === 1 ? i : Infinity)));
    expect(ultimaDuas).toBeLessThan(primeiraSo);
    // nada de codigo do OMIE (ACXEGDP-313) nem dos 10 digitos em qualquer campo
    for (const d of acxe) {
      expect(Object.keys(d).sort()).toEqual(['codigo', 'entradaEm', 'id', 'nome', 'tipo']);
      expect(JSON.stringify(d)).not.toMatch(/\d{9,}/);
    }
    // o tipo novo 'operacional' e destino valido
    expect(acxe.find((d) => d.codigo === '20.0.7')!.tipo).toBe('operacional');
  });

  it('destinos da Q2P (SQL real): so os estoques so-Q2P (11.2/12.2), entradaEm [q2p]', async () => {
    const q2p = await svc.receber.listarDestinosEntradaNf('q2p');
    const codigos = q2p.map((d) => d.codigo);
    expect(codigos).toEqual(expect.arrayContaining(['11.2', '12.2']));
    for (const fora of ['11.1', '21.1', '31.1', '21.2', '20.0.7', '90.0.2']) expect(codigos).not.toContain(fora);
    expect(q2p.every((d) => d.entradaEm.length === 1 && d.entradaEm[0] === 'q2p')).toBe(true);
  });

  it('correspondente na Q2P (SQL real): mesma descricao, ativo nas duas pontas, o de MENOR codigo; fora do cadastro fica fora do mapa', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const { resolverGemeosQ2p } = await import('../services/produto-gemeo-q2p.js');
    const m = await resolverGemeosQ2p([P.comGemeo, P.semGemeo, P.inativoAcxe, P.comGemeoInativo, P.dois1, BASE + 999]);
    expect(m.get(P.comGemeo)).toMatchObject({ descricaoAcxe: DESC.comGemeo, ativoAcxe: true, gemeoQ2p: { codigo: P.gemeo, descricao: DESC.comGemeo } });
    expect(m.get(P.semGemeo)).toMatchObject({ ativoAcxe: true, gemeoQ2p: null });
    expect(m.get(P.inativoAcxe)).toMatchObject({ ativoAcxe: false });
    // o unico correspondente esta inativo na Q2P: sem gemeo (como getCorrelacao)
    expect(m.get(P.comGemeoInativo)).toMatchObject({ ativoAcxe: true, gemeoQ2p: null });
    // dois correspondentes ativos: o de menor codigo (STK-22, deterministico)
    expect(m.get(P.dois1)!.gemeoQ2p!.codigo).toBe(P.dois2a);
    expect(m.has(BASE + 999)).toBe(false);
  });

  it('GET produtos da ACXE (SQL real): semCorrelatoQ2p por produto', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const lista = await svc.receber.buscarProdutosNacional({ empresa: 'acxe', q: `TESTE H5%${SUFIXO}`, limit: 50 });
    const por = Object.fromEntries(lista.map((p) => [p.codigo, p.semCorrelatoQ2p]));
    expect(por[P.comGemeo]).toBe(false);
    expect(por[P.semGemeo]).toBe(true);
    expect(por[P.comGemeoInativo]).toBe(true);
    expect(por[P.dois1]).toBe(false);
    expect(P.inativoAcxe in por, 'produto inativo da ACXE nao e oferecido').toBe(false);
    // a Q2P nao traz a marca
    const q2p = await svc.receber.buscarProdutosNacional({ empresa: 'q2p', q: `TESTE H5%${SUFIXO}`, limit: 50 });
    expect(q2p.length).toBeGreaterThan(0);
    expect(q2p.every((p) => p.semCorrelatoQ2p === undefined)).toBe(true);
  });

  // ───────────────────────────── POST por NF (INSERTs reais) ─────────────────────────────

  it('POST em estoque que entra nas duas (21.1): grava movimentacao + aprovacao com produto da ACXE E correspondente da Q2P, custo da NF e pendente_q2p', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const chave = chaveNova();
    const r = await receberNaAcxe(chave, [{ produtoCodigoAcxe: P.comGemeo, localidade: '21.1', quantidadeKg: 26000 }]);
    expect(r.resumo).toEqual({ enviadosParaAprovacao: 1, jaRecebidos: 0, bloqueados: 0, falhas: 0 });
    expect(r.produtos[0]).toMatchObject({
      status: 'aguardando_aprovacao', produtoCodigoAcxe: P.comGemeo, produtoCodigoQ2p: P.gemeo, entradaEm: ['acxe', 'q2p'], produto: DESC.comGemeo,
    });

    const [m] = await movDaNf(chave);
    expect(m).toMatchObject({
      tipo_movimento: 'entrada_manual', subtipo: 'compra_nacional', lote_id: null, empresa: 'acxe', galpao: '21.1', status_omie: 'pendente_q2p',
      criado_por: userId, ativo: true, tentativas_q2p: 0, mv_acxe: null, mv_q2p: null, baixa_pedido_q2p: null,
    });
    expect(String(m!.produto_codigo_acxe)).toBe(String(P.comGemeo));
    expect(String(m!.produto_codigo_q2p)).toBe(String(P.gemeo));
    expect(Number(m!.quantidade_kg)).toBe(26000);
    expect(Number(m!.quantidade_nf_kg)).toBe(26000);
    expect(Number(m!.custo_unitario_brl)).toBe(4.8);
    expect(m!.nf_item_sequencias).toEqual([1]);
    expect(m!.nf_item_descricao_normalizada).toBe(DESC.comGemeo.toUpperCase());
    expect(String(m!.observacoes)).toContain(`Produto: ${DESC.comGemeo} | Empresa: ACXE + Q2P · Estoque 21.1`);

    const [a] = await aprDaNf(chave);
    expect(a).toMatchObject({
      tipo_aprovacao: 'entrada_manual', precisa_nivel: 'gestor', status: 'pendente', empresa: 'acxe', galpao: '21.1', lote_id: null,
      movimentacao_id: m!.id, lancado_por: userId, nota_fiscal: `H5${SUFIXO.slice(-4)}`,
    });
    expect(String(a!.produto_codigo_acxe)).toBe(String(P.comGemeo));
    expect(String(a!.produto_codigo_q2p)).toBe(String(P.gemeo));
    expect(Number(a!.quantidade_recebida_kg)).toBe(26000);

    // Principio IV: a gravacao foi auditada
    expect(await auditoriaDe('movimentacao', String(m!.id))).toContain('INSERT');
    expect(await auditoriaDe('aprovacao', String(a!.id))).toContain('INSERT');
    // o digest ao gestor diz onde a entrada sera lancada
    expect(h.digest.mock.calls[0]![0]).toMatchObject({ itens: [{ empresa: 'ACXE + Q2P', galpao: '21.1' }] });
  });

  it('POST em estoque so da ACXE (20.0.7): produto da Q2P NULL (nem para produto que tem correspondente) e produto sem correspondente PODE entrar', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const c1 = chaveNova();
    await receberNaAcxe(c1, [{ produtoCodigoAcxe: P.comGemeo, localidade: '20.0.7', quantidadeKg: 26000 }]);
    const [m1] = await movDaNf(c1);
    expect(m1!.produto_codigo_q2p).toBeNull();
    expect(String(m1!.produto_codigo_acxe)).toBe(String(P.comGemeo));
    expect(m1!.galpao).toBe('20.0.7');

    const c2 = chaveNova();
    const r2 = await receberNaAcxe(c2, [{ produtoCodigoAcxe: P.semGemeo, localidade: '20.0.7', quantidadeKg: 26000 }], { descricao: DESC.semGemeo });
    expect(r2.produtos[0]).toMatchObject({ status: 'aguardando_aprovacao', entradaEm: ['acxe'], produtoCodigoQ2p: null, produtoCodigoAcxe: P.semGemeo });
    expect((await movDaNf(c2))[0]!.produto_codigo_q2p).toBeNull();
  });

  it('portao 1 com banco real: sem correspondente em estoque compartilhado, estoque so da Q2P, virtual, produto inativo ou fora do cadastro — 4xx e NENHUMA linha gravada', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const c = chaveNova();
    await expect(receberNaAcxe(c, [{ produtoCodigoAcxe: P.semGemeo, localidade: '21.1', quantidadeKg: 26000 }], { descricao: DESC.semGemeo })).rejects.toBeInstanceOf(
      svc.receber.ProdutoSemCorrelatoQ2pError,
    );
    await expect(receberNaAcxe(c, [{ produtoCodigoAcxe: P.comGemeoInativo, localidade: '21.1', quantidadeKg: 26000 }], { descricao: DESC.gemeoInativo })).rejects.toBeInstanceOf(
      svc.receber.ProdutoSemCorrelatoQ2pError,
    );
    await expect(receberNaAcxe(c, [{ produtoCodigoAcxe: P.comGemeo, localidade: '11.2', quantidadeKg: 26000 }])).rejects.toBeInstanceOf(
      svc.receber.LocalidadeNaoElegivelError,
    );
    await expect(receberNaAcxe(c, [{ produtoCodigoAcxe: P.comGemeo, localidade: '90.0.2', quantidadeKg: 26000 }])).rejects.toBeInstanceOf(
      svc.receber.LocalidadeNaoElegivelError,
    );
    await expect(receberNaAcxe(c, [{ produtoCodigoAcxe: P.inativoAcxe, localidade: '20.0.7', quantidadeKg: 26000 }])).rejects.toBeInstanceOf(
      svc.receber.ProdutoNaoEncontradoError,
    );
    await expect(receberNaAcxe(c, [{ produtoCodigoAcxe: BASE + 999, localidade: '20.0.7', quantidadeKg: 26000 }])).rejects.toBeInstanceOf(
      svc.receber.ProdutoNaoEncontradoError,
    );
    expect(await movDaNf(c)).toHaveLength(0);
    expect(await aprDaNf(c)).toHaveLength(0);
  });

  it('dois produtos da mesma linha com o MESMO correspondente: 422 se os dois vao para estoque compartilhado; ok se um vai para estoque so da ACXE', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const c = chaveNova();
    await expect(
      receberNaAcxe(c, [
        { produtoCodigoAcxe: P.comGemeo, localidade: '21.1', quantidadeKg: 13000 },
        { produtoCodigoAcxe: P.outroComMesmoGemeo, localidade: '11.1', quantidadeKg: 13000 },
      ]),
    ).rejects.toBeInstanceOf(svc.receber.ProdutoCorrelatoQ2pRepetidoError);
    expect(await movDaNf(c)).toHaveLength(0);

    const r = await receberNaAcxe(c, [
      { produtoCodigoAcxe: P.comGemeo, localidade: '21.1', quantidadeKg: 13000 },
      { produtoCodigoAcxe: P.outroComMesmoGemeo, localidade: '20.0.7', quantidadeKg: 13000 },
    ]);
    expect(r.resumo.enviadosParaAprovacao).toBe(2);
    const movs = await movDaNf(c);
    expect(movs).toHaveLength(2);
    const porProduto = Object.fromEntries(movs.map((m) => [String(m.produto_codigo_acxe), m.produto_codigo_q2p == null ? null : String(m.produto_codigo_q2p)]));
    expect(porProduto).toEqual({ [String(P.comGemeo)]: String(P.gemeo), [String(P.outroComMesmoGemeo)]: null });
    // rateio: cada produto leva a sua fatia do valor do item (13.000/26.000 de 124.800), mesmo custo por kg
    expect(movs.map((m) => Number(m.custo_unitario_brl))).toEqual([4.8, 4.8]);
  });

  it('idempotencia com o banco real: reenviar a mesma NF vira ja_recebido nos DOIS indices (0052 em estoque compartilhado, 0058 so ACXE) e nao duplica linha', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    // estoque compartilhado: o 23505 vem do indice da 0052 OU da 0058 (o Postgres informa o primeiro que violar)
    const c1 = chaveNova();
    await receberNaAcxe(c1, [{ produtoCodigoAcxe: P.comGemeo, localidade: '21.1', quantidadeKg: 26000 }]);
    const r1 = await receberNaAcxe(c1, [{ produtoCodigoAcxe: P.comGemeo, localidade: '21.1', quantidadeKg: 26000 }]);
    expect(r1.produtos[0]).toMatchObject({ status: 'ja_recebido', entradaEm: ['acxe', 'q2p'] });
    expect(r1.resumo).toMatchObject({ jaRecebidos: 1, falhas: 0, enviadosParaAprovacao: 0 });
    expect(await movDaNf(c1)).toHaveLength(1);
    expect(await aprDaNf(c1)).toHaveLength(1);

    // estoque so da ACXE: so o indice da 0058 protege (produto_codigo_q2p NULL fica fora do da 0052)
    const c2 = chaveNova();
    await receberNaAcxe(c2, [{ produtoCodigoAcxe: P.comGemeo, localidade: '20.0.7', quantidadeKg: 26000 }]);
    const r2 = await receberNaAcxe(c2, [{ produtoCodigoAcxe: P.comGemeo, localidade: '20.0.7', quantidadeKg: 26000 }]);
    expect(r2.produtos[0]).toMatchObject({ status: 'ja_recebido', entradaEm: ['acxe'] });
    expect(r2.resumo).toMatchObject({ jaRecebidos: 1, falhas: 0 });
    expect(await movDaNf(c2)).toHaveLength(1);

    // o nome do indice que o Postgres reporta e o que violacaoIdempotenciaNacional reconhece
    await expect(
      pool.query(
        `INSERT INTO stockbridge.movimentacao (nota_fiscal, tipo_movimento, subtipo, quantidade_kg, produto_codigo_acxe, galpao, empresa, nf_chave_acesso, nf_item_descricao_normalizada)
         VALUES ('X', 'entrada_manual', 'compra_nacional', 1, $1, '20.0.7', 'acxe', $2, $3)`,
        [P.comGemeo, c2, DESC.comGemeo.toUpperCase()],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'movimentacao_nf_nacional_acxe_idempotencia_idx' });
  });

  it('a 0058 restringe o indice da 0052 a Q2P: dois produtos DIFERENTES da ACXE com o mesmo correspondente, em envios separados da mesma linha, gravam os dois (sem "ja recebido" falso)', async () => {
    // Antes da restricao, o segundo INSERT batia no indice da 0052 (nf + linha + produto da Q2P) e o servico o traduzia
    // para ja_recebido, perdendo o peso em silencio. Agora so o indice da ACXE (por produto da ACXE) vale para a linha.
    const c = chaveNova();
    const inserir = (produtoAcxe: number) =>
      pool.query(
        `INSERT INTO stockbridge.movimentacao (nota_fiscal, tipo_movimento, subtipo, quantidade_kg, produto_codigo_acxe, produto_codigo_q2p, galpao, empresa, nf_chave_acesso, nf_item_descricao_normalizada)
         VALUES ('X', 'entrada_manual', 'compra_nacional', 1, $1, 3100320435, '21.1', 'acxe', $2, 'LINHA COMPARTILHADA')`,
        [produtoAcxe, c],
      );
    await inserir(P.comGemeo);
    await expect(inserir(P.comGemeo + 1)).resolves.toMatchObject({ rowCount: 1 });
    expect(await movDaNf(c)).toHaveLength(2);
    // o mesmo produto da ACXE de novo continua barrado (agora pelo indice da ACXE)
    await expect(inserir(P.comGemeo)).rejects.toMatchObject({ code: '23505', constraint: 'movimentacao_nf_nacional_acxe_idempotencia_idx' });
  });

  it('rejeicao devolve a NF: movimentacao.ativo=false libera os indices parciais e o mesmo item pode ser recebido de novo', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const { chave, movId, aprId } = await criarEntrada('21.1');
    await svc.aprov.rejeitar({ id: aprId, usuarioId: userId, perfilUsuario: 'gestor', motivo: 'teste de rejeicao' });
    expect((await movPorId(movId)).ativo).toBe(false);
    expect((await aprPorId(aprId)).status).toBe('rejeitada');
    expect(h.chamadas, 'rejeitar nao toca o OMIE').toHaveLength(0);

    const r = await receberNaAcxe(chave, [{ produtoCodigoAcxe: P.comGemeo, localidade: '21.1', quantidadeKg: 26000 }]);
    expect(r.produtos[0]!.status).toBe('aguardando_aprovacao');
    const movs = await movDaNf(chave);
    expect(movs.map((m) => m.ativo).sort()).toEqual([false, true]);
  });

  // ───────────────────────────── aprovacao do gestor ─────────────────────────────

  it('pendencias: entradaEm por linha ([acxe,q2p] / [acxe]) e produto pelo nome da ACXE', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const dupla = await criarEntrada('21.1');
    const so = await criarEntrada('20.0.7');
    const lista = await svc.aprov.listarPendencias('gestor');
    const d = lista.find((p) => p.id === dupla.aprId)!;
    const s = lista.find((p) => p.id === so.aprId)!;
    expect(d).toMatchObject({ empresa: 'acxe', galpao: '21.1', entradaEm: ['acxe', 'q2p'], produto: { fornecedor: DESC.comGemeo } });
    expect(d.produtoCodigoQ2p).toBe(P.gemeo);
    expect(s).toMatchObject({ empresa: 'acxe', galpao: '20.0.7', entradaEm: ['acxe'], produto: { fornecedor: DESC.comGemeo }, produtoCodigoQ2p: null });
    // movimentacao ainda 'pendente_q2p' (marcador pre-aprovacao) mas com aprovacao pendente: NAO e retentavel nem pendencia OMIE
    const { items } = await svc.mov.listar({ nf: `H5${SUFIXO.slice(-4)}`, pageSize: 200 });
    for (const id of [dupla.movId, so.movId]) {
      const it = items.find((i) => i.id === id)!;
      expect(it.statusOmie).toBe('pendente_q2p');
      expect(it.retentavelQ2p).toBe(false);
    }
    const pendentesOmie = await svc.pend.listarPendentes();
    expect(pendentesOmie.map((p) => p.id)).not.toContain(dupla.movId);
    await expect(retentar(dupla.movId)).rejects.toThrow(/ainda não tem aprovação concluída/);
    expect(h.chamadas).toHaveLength(0);
  });

  it('aprovar nas duas empresas: ACXE e DEPOIS Q2P, mesmo valor/quantidade/data, locais e produtos de cada empresa; grava as duas pernas e audita', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const { movId, aprId } = await criarEntrada('21.1');
    const r = await aprovarGestor(aprId);
    expect(r).toEqual({ id: aprId, loteStatus: 'reconciliado', pendenciaOmie: undefined });

    expect(h.chamadas.map((c) => c.empresa)).toEqual(['acxe', 'q2p']);
    const [acxe, q2p] = h.chamadas as [ChamadaOmie, ChamadaOmie];
    const op = String((await movPorId(movId)).op_id);
    expect(acxe).toMatchObject({
      codInt: `${op}:nacional-acxe`,
      input: { codigoLocalEstoque: loc['21.1']!.acxe, idProduto: P.comGemeo, quantidade: 26000, origem: 'AJU', tipo: 'ENT', motivo: 'INI', valor: 4.8 },
    });
    expect(q2p).toMatchObject({
      codInt: `${op}:nacional-q2p`,
      input: { codigoLocalEstoque: loc['21.1']!.q2p, idProduto: P.gemeo, quantidade: 26000, origem: 'AJU', tipo: 'ENT', motivo: 'INI', valor: 4.8 },
    });
    expect(q2p.input.valor).toBe(acxe.input.valor);
    expect(q2p.input.dataAtual).toBe(acxe.input.dataAtual);

    const m = await movPorId(movId);
    expect(m).toMatchObject({
      status_omie: 'concluida', mv_acxe: 1, mv_q2p: 1, id_movest_acxe: 'MOV-ACXE', id_ajuste_acxe: 'AJ-ACXE', id_movest_q2p: 'MOV-Q2P', id_ajuste_q2p: 'AJ-Q2P',
      id_user_acxe: userId, id_user_q2p: userId, ultimo_erro_omie: null, tentativas_q2p: 0, baixa_pedido_q2p: null,
    });
    expect(m.dt_acxe).toBeInstanceOf(Date);
    expect(m.dt_q2p).toBeInstanceOf(Date);
    expect(Number(m.custo_unitario_brl)).toBe(4.8); // o valor gravado no POST e preservado
    expect(await aprPorId(aprId)).toMatchObject({ status: 'aprovada', aprovado_por: userId });
    expect(h.baixa, 'a compra nacional da ACXE nunca baixa pedido na Q2P (344)').not.toHaveBeenCalled();
    expect(h.alertaPendencia).not.toHaveBeenCalled();
    expect(h.notificaOperador).toHaveBeenCalledTimes(1);
    expect(await auditoriaDe('movimentacao', movId)).toEqual(expect.arrayContaining(['INSERT', 'UPDATE']));
    expect(await auditoriaDe('aprovacao', aprId)).toEqual(expect.arrayContaining(['INSERT', 'UPDATE']));

    // aprovar de novo: a decisao ja foi tomada
    await expect(aprovarGestor(aprId)).rejects.toBeInstanceOf(svc.aprov.AprovacaoStatusInvalidoError);
    expect(h.chamadas).toHaveLength(2);
  });

  it('aprovar em estoque so da ACXE (20.0.7): UMA chamada (cod_int nacional-acxe), local da ACXE; a perna Q2P fica intocada', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const { movId, aprId } = await criarEntrada('20.0.7', P.semGemeo);
    const r = await aprovarGestor(aprId);
    expect(r.pendenciaOmie).toBeUndefined();
    expect(h.chamadas).toHaveLength(1);
    const op = String((await movPorId(movId)).op_id);
    expect(h.chamadas[0]).toMatchObject({
      empresa: 'acxe', codInt: `${op}:nacional-acxe`,
      input: { codigoLocalEstoque: loc['20.0.7']!.acxe, idProduto: P.semGemeo, tipo: 'ENT', motivo: 'INI', valor: 4.8 },
    });
    expect(await movPorId(movId)).toMatchObject({ status_omie: 'concluida', mv_acxe: 1, mv_q2p: null, id_movest_q2p: null, id_ajuste_q2p: null });
    expect(h.baixa).not.toHaveBeenCalled();
  });

  it('OMIE da ACXE falha: nada e gravado, a aprovacao segue pendente e o gestor aprova de novo (cod_int idempotente)', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const { movId, aprId } = await criarEntrada('21.1');
    h.resposta = async () => {
      throw new Error('OMIE ACXE indisponivel');
    };
    const err = await aprovarGestor(aprId).catch((e: Error) => e);
    expect(err).toBeInstanceOf(svc.erros.OmieAjusteError);
    expect((err as InstanceType<typeof svc.erros.OmieAjusteError>).lado).toBe('acxe');
    expect(h.chamadas.map((c) => c.empresa), 'a Q2P nunca e chamada sem a ACXE').toEqual(['acxe']);
    expect(await aprPorId(aprId)).toMatchObject({ status: 'pendente', aprovado_por: null });
    expect(await movPorId(movId)).toMatchObject({ status_omie: 'pendente_q2p', mv_acxe: null, mv_q2p: null, id_movest_acxe: null, tentativas_q2p: 0 });
    expect(h.alertaPendencia).not.toHaveBeenCalled();

    h.chamadas.length = 0;
    h.resposta = async (c) => ok(c.empresa.toUpperCase())();
    await aprovarGestor(aprId);
    expect(h.chamadas.map((c) => c.empresa)).toEqual(['acxe', 'q2p']);
    expect(await movPorId(movId)).toMatchObject({ status_omie: 'concluida', mv_acxe: 1, mv_q2p: 1 });
  });

  it('Q2P falha DEPOIS da ACXE: aprovada + pendente_q2p + tentativas 1 + erro + alerta + pendenciaOmie; entra em Movimentacoes como retentavel e no painel; "Retentar Q2P" conclui com o mesmo valor e data', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const { movId, aprId } = await criarEntrada('21.1');
    h.resposta = async (c) => {
      if (c.empresa === 'q2p') throw new Error('OMIE Q2P fora do ar');
      return ok('ACXE')();
    };
    const r = await aprovarGestor(aprId);
    const op = String((await movPorId(movId)).op_id);
    expect(r.pendenciaOmie).toEqual({ lado: 'q2p', opId: op, movimentacaoId: movId, mensagem: 'OMIE Q2P fora do ar' });
    expect(h.chamadas.map((c) => c.empresa)).toEqual(['acxe', 'q2p']);

    const pendente = await movPorId(movId);
    expect(pendente).toMatchObject({
      status_omie: 'pendente_q2p', mv_acxe: 1, id_movest_acxe: 'MOV-ACXE', mv_q2p: null, id_movest_q2p: null, tentativas_q2p: 1, baixa_pedido_q2p: null,
    });
    expect(pendente.ultimo_erro_omie).toMatchObject({ lado: 'q2p', mensagem: 'OMIE Q2P fora do ar' });
    expect(await aprPorId(aprId)).toMatchObject({ status: 'aprovada' });
    expect(h.alertaPendencia).toHaveBeenCalledTimes(1);
    expect(h.alertaPendencia.mock.calls[0]![0]).toMatchObject({ movimentacaoId: movId, opId: op, ladoPendente: 'q2p', tentativas: 1 });
    expect(h.baixa).not.toHaveBeenCalled();

    // Movimentacoes: retentavelQ2p (aprovacao concluida + pendente_q2p)
    const { items } = await svc.mov.listar({ nf: `H5${SUFIXO.slice(-4)}`, pageSize: 200 });
    expect(items.find((i) => i.id === movId)).toMatchObject({ statusOmie: 'pendente_q2p', retentavelQ2p: true, empresa: 'acxe', galpao: '21.1' });
    // painel de pendencias OMIE: a linha sem lote traz subtipo/empresa/galpao e o produto da propria movimentacao
    const painel = (await svc.pend.listarPendentes()).find((p) => p.id === movId);
    expect(painel, 'a pendencia Q2P aparece no painel').toBeDefined();
    expect(painel).toMatchObject({ subtipo: 'compra_nacional', empresa: 'acxe', galpao: '21.1', tentativas: 1 });
    expect(painel!.lote).toMatchObject({ id: null, produtoCodigoAcxe: P.comGemeo });

    // retry: sucesso, repete o cod_int da aprovacao com verificarAntes, valor e data da ACXE
    h.chamadas.length = 0;
    h.resposta = async () => ({ idMovest: 'MOV-Q2P-RETRY', idAjuste: 'AJ-Q2P-RETRY', jaExistia: false });
    const res = await retentar(movId);
    expect(res).toMatchObject({ movimentacaoId: movId, statusOmie: 'concluida', jaExistiaNoOmie: false });
    expect(h.chamadas).toHaveLength(1);
    expect(h.chamadas[0]).toMatchObject({
      empresa: 'q2p', codInt: `${op}:nacional-q2p`, opts: { verificarAntes: true },
      input: { codigoLocalEstoque: loc['21.1']!.q2p, idProduto: P.gemeo, quantidade: 26000, tipo: 'ENT', motivo: 'INI', valor: 4.8 },
    });
    const dtAcxe = (pendente.dt_acxe as Date);
    const dd = (n: number) => String(n).padStart(2, '0');
    expect(h.chamadas[0]!.input.dataAtual).toBe(`${dd(dtAcxe.getDate())}/${dd(dtAcxe.getMonth() + 1)}/${dtAcxe.getFullYear()}`);
    const concluida = await movPorId(movId);
    expect(concluida).toMatchObject({
      status_omie: 'concluida', mv_q2p: 1, id_movest_q2p: 'MOV-Q2P-RETRY', id_ajuste_q2p: 'AJ-Q2P-RETRY', id_user_q2p: userId, ultimo_erro_omie: null,
      mv_acxe: 1, id_movest_acxe: 'MOV-ACXE',
    });
    expect(concluida.dt_q2p).toBeInstanceOf(Date);
    expect(h.baixa, 'o retry nunca baixa pedido (344)').not.toHaveBeenCalled();
    const { items: depois } = await svc.mov.listar({ nf: `H5${SUFIXO.slice(-4)}`, pageSize: 200 });
    expect(depois.find((i) => i.id === movId)!.retentavelQ2p).toBe(false);
    expect((await svc.pend.listarPendentes()).some((p) => p.id === movId)).toBe(false);
    // concluida: nada mais a retentar
    await expect(retentar(movId)).rejects.toBeInstanceOf(svc.pend.OperacaoNaoPendenteError);
    expect(await auditoriaDe('movimentacao', movId)).toEqual(expect.arrayContaining(['INSERT', 'UPDATE']));
  });

  it('retry em estoque tpl (31.1): o local da Q2P vem do join direto, sem filtro de tipo (resolverCorrelacaoCompletaGalpao so aceita proprio e quebraria)', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const { movId, aprId } = await criarEntrada('31.1');
    h.resposta = async (c) => {
      if (c.empresa === 'q2p') throw new Error('Q2P fora');
      return ok('ACXE')();
    };
    await aprovarGestor(aprId);
    expect(await movPorId(movId)).toMatchObject({ status_omie: 'pendente_q2p', mv_acxe: 1, mv_q2p: null });
    h.chamadas.length = 0;
    h.resposta = async () => ok('Q2P-31')();
    await retentar(movId);
    expect(h.chamadas).toHaveLength(1);
    expect(h.chamadas[0]!.input.codigoLocalEstoque).toBe(loc['31.1']!.q2p);
    expect(await movPorId(movId)).toMatchObject({ status_omie: 'concluida', mv_q2p: 1, id_movest_q2p: 'MOV-Q2P-31' });
  });

  it('retry que falha: soma tentativa, guarda o erro, sobe OmieAjusteError(q2p) e continua pendente; operador esgotou o limite', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const { movId, aprId } = await criarEntrada('12.1');
    h.resposta = async (c) => {
      if (c.empresa === 'q2p') throw new Error('Q2P 1');
      return ok('ACXE')();
    };
    await aprovarGestor(aprId);
    h.chamadas.length = 0;
    h.resposta = async () => {
      throw new Error('Q2P 2');
    };
    const err = await retentar(movId, 'operador').catch((e: Error) => e);
    expect(err).toBeInstanceOf(svc.erros.OmieAjusteError);
    expect((err as InstanceType<typeof svc.erros.OmieAjusteError>).lado).toBe('q2p');
    const m = await movPorId(movId);
    expect(m).toMatchObject({ status_omie: 'pendente_q2p', tentativas_q2p: 2, mv_q2p: null });
    expect(m.ultimo_erro_omie).toMatchObject({ lado: 'q2p', mensagem: 'Q2P 2' });
    // o operador tinha 2 tentativas (a da aprovacao + 1): acabou; o gestor segue sem limite
    await expect(retentar(movId, 'operador')).rejects.toBeInstanceOf(svc.pend.OperadorSemRetentativasError);
    expect(h.chamadas).toHaveLength(1);
    h.resposta = async () => ok('Q2P-GESTOR')();
    await retentar(movId, 'gestor');
    expect(await movPorId(movId)).toMatchObject({ status_omie: 'concluida', mv_q2p: 1, id_movest_q2p: 'MOV-Q2P-GESTOR' });
  });

  it('retry nas guardas com banco real: a entrada so da ACXE (sem produto da Q2P) nao tem perna a retentar', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const { movId, aprId } = await criarEntrada('20.0.7');
    await aprovarGestor(aprId);
    // forca o estado "pendente_q2p" so para provar a guarda (nao ha perna Q2P nesta entrada)
    await pool.query(`UPDATE stockbridge.movimentacao SET status_omie = 'pendente_q2p' WHERE id = $1`, [movId]);
    h.chamadas.length = 0;
    await expect(retentar(movId)).rejects.toThrow(/não é uma entrada nas duas empresas/);
    expect(h.chamadas).toHaveLength(0);
  });

  // ───────────────────────────── divergencia, tpl, estoque que muda, decisao definitiva ─────────────────────────────

  it('divergencia de peso: motivo obrigatorio; custo = valor do item / kg conferido; a observacao do ajuste vai em Latin-1 nas DUAS pernas', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const chave = chaveNova();
    h.detalhe.mockResolvedValue(detalheAcxe(chave));
    const item = {
      indice: 0, descricaoFornecedor: DESC.comGemeo, quantidadeConferidaKg: 25900,
      produtos: [{ produtoCodigoAcxe: P.comGemeo, quantidadeKg: 25900, localidadeId: loc['21.1']!.id }],
    };
    await expect(svc.receber.processarRecebimentoNacionalPorNf({ nfChaveAcesso: chave, userId, itens: [item] })).rejects.toMatchObject({ code: 'MOTIVO_DIVERGENCIA_OBRIGATORIO' });
    expect(await movDaNf(chave)).toHaveLength(0);

    const r = await svc.receber.processarRecebimentoNacionalPorNf({
      nfChaveAcesso: chave, userId, itens: [{ ...item, motivoDivergencia: 'Balança “nova” — conferido duas vezes…' }],
    });
    const prod = r.produtos[0]!;
    expect(prod).toMatchObject({ status: 'aguardando_aprovacao', quantidadeKg: 25900, quantidadeNfKg: 26000, divergenciaKg: -100, entradaEm: ['acxe', 'q2p'] });
    const m = await movPorId(prod.movimentacaoId!);
    expect(Number(m.quantidade_kg)).toBe(25900);
    expect(Number(m.quantidade_nf_kg)).toBe(26000);
    expect(Number(m.quantidade_divergencia_kg)).toBe(-100);
    expect(Number(m.custo_unitario_brl)).toBe(4.818533); // 124.800 / 25.900 kg, 6 casas

    await aprovarGestor(prod.aprovacaoId!);
    expect(h.chamadas).toHaveLength(2);
    for (const c of h.chamadas) {
      const obs = String(c.input.observacao);
      expect(/[^\u0000-ÿ]/.test(obs), `${c.empresa}: observacao fora do Latin-1`).toBe(false);
      expect(obs).toContain('Balança "nova" - conferido duas vezes...');
      expect(c.input.quantidade).toBe(25900);
      expect(c.input.valor).toBe(4.818533);
    }
  });

  it('estoque tpl (31.1): o local da Q2P vem do join direto, sem filtro de tipo — as duas pernas saem com o codigo de cada empresa', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    expect(loc['31.1'], '31.1 precisa existir').toBeDefined();
    const { aprId } = await criarEntrada('31.1');
    await aprovarGestor(aprId);
    expect(h.chamadas.map((c) => c.empresa)).toEqual(['acxe', 'q2p']);
    expect(h.chamadas[0]!.input.codigoLocalEstoque).toBe(loc['31.1']!.acxe);
    expect(h.chamadas[1]!.input.codigoLocalEstoque).toBe(loc['31.1']!.q2p);
  });

  it('o estoque deixou de ser compartilhado com a Q2P entre o POST e a aprovacao: 422, NENHUMA chamada ao OMIE e a aprovacao segue pendente', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const codigo = `T${SUFIXO}`;
    const { rows } = await pool.query(
      `INSERT INTO stockbridge.localidade (codigo, nome, tipo, ativo) VALUES ($1, 'TESTE H5 COMPARTILHADO', 'proprio', true) RETURNING id::text AS id`,
      [codigo],
    );
    const id = String(rows[0]!.id);
    testLocalIds.push(id);
    await pool.query(`INSERT INTO stockbridge.localidade_correlacao (localidade_id, codigo_local_estoque_acxe, codigo_local_estoque_q2p) VALUES ($1, $2, $3)`, [id, BASE + 501, BASE + 502]);
    loc[codigo] = { id, acxe: String(BASE + 501), q2p: String(BASE + 502) };

    const { aprId } = await criarEntrada(codigo);
    await pool.query(`UPDATE stockbridge.localidade_correlacao SET codigo_local_estoque_q2p = NULL WHERE localidade_id = $1`, [id]);
    const err = await aprovarGestor(aprId).catch((e: Error) => e);
    expect(err).toBeInstanceOf(svc.aprov.EntradaNacionalInconsistenteError);
    expect((err as Error).message).toContain(codigo);
    expect(h.chamadas).toHaveLength(0);
    expect(await aprPorId(aprId)).toMatchObject({ status: 'pendente', aprovado_por: null });
  });

  it('decisao tomada nao se desfaz: rejeitar entrada ja aprovada (Q2P pendente) e aprovar entrada rejeitada dao 409, sem tocar o OMIE', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const a = await criarEntrada('21.1');
    h.resposta = async (c) => {
      if (c.empresa === 'q2p') throw new Error('Q2P fora');
      return ok('ACXE')();
    };
    await aprovarGestor(a.aprId); // aprovada, perna Q2P pendente
    await expect(svc.aprov.rejeitar({ id: a.aprId, usuarioId: userId, perfilUsuario: 'gestor', motivo: 'tarde demais' })).rejects.toBeInstanceOf(
      svc.aprov.AprovacaoStatusInvalidoError,
    );
    expect((await movPorId(a.movId)).ativo, 'a perna ACXE ja esta no OMIE: a movimentacao segue ativa').toBe(true);

    const b = await criarEntrada('21.1');
    await svc.aprov.rejeitar({ id: b.aprId, usuarioId: userId, perfilUsuario: 'gestor', motivo: 'nao confere' });
    h.chamadas.length = 0;
    await expect(aprovarGestor(b.aprId)).rejects.toBeInstanceOf(svc.aprov.AprovacaoStatusInvalidoError);
    expect(h.chamadas).toHaveLength(0);
  });

  it('marcar a pendencia Q2P como falha definitiva tira o "Retentar Q2P" (retentavelQ2p false) e o painel; o retry passa a ser recusado', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const { movId, aprId } = await criarEntrada('11.1');
    h.resposta = async (c) => {
      if (c.empresa === 'q2p') throw new Error('Q2P fora');
      return ok('ACXE')();
    };
    await aprovarGestor(aprId);
    await svc.pend.marcarComoFalhaDefinitiva({ movimentacaoId: movId, motivo: 'estorno feito direto no OMIE da ACXE', ator: { userId, role: 'gestor' } });
    expect(await movPorId(movId)).toMatchObject({ status_omie: 'falha' });
    const { items } = await svc.mov.listar({ nf: `H5${SUFIXO.slice(-4)}`, pageSize: 200 });
    expect(items.find((i) => i.id === movId)!.retentavelQ2p).toBe(false);
    expect((await svc.pend.listarPendentes()).some((p) => p.id === movId)).toBe(false);
    h.chamadas.length = 0;
    await expect(retentar(movId)).rejects.toBeInstanceOf(svc.pend.OperacaoNaoPendenteError);
    expect(h.chamadas).toHaveLength(0);
  });

  // ───────────────────────────── concorrencia ─────────────────────────────

  it('dois POSTs simultaneos da mesma NF: exatamente um grava, o outro vira ja_recebido (indice unico) e fica UMA linha', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const chave = chaveNova();
    h.detalhe.mockResolvedValue(detalheAcxe(chave));
    const post = () =>
      svc.receber.processarRecebimentoNacionalPorNf({
        nfChaveAcesso: chave,
        userId,
        itens: [{ indice: 0, descricaoFornecedor: DESC.comGemeo, produtos: [{ produtoCodigoAcxe: P.comGemeo, quantidadeKg: 26000, localidadeId: loc['21.1']!.id }] }],
      });
    const [a, b] = await Promise.all([post(), post()]);
    expect([a.produtos[0]!.status, b.produtos[0]!.status].sort()).toEqual(['aguardando_aprovacao', 'ja_recebido']);
    expect(await movDaNf(chave)).toHaveLength(1);
    expect(await aprDaNf(chave)).toHaveLength(1);
  });

  it('duas aprovacoes simultaneas da mesma entrada: so uma registra (a outra leva 409); as chamadas ao OMIE sao as mesmas duas chaves idempotentes', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const { movId, aprId } = await criarEntrada('21.1');
    const resultados = await Promise.allSettled([aprovarGestor(aprId), aprovarGestor(aprId)]);
    const cumpridas = resultados.filter((r) => r.status === 'fulfilled');
    const recusadas = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(cumpridas).toHaveLength(1);
    expect(recusadas).toHaveLength(1);
    expect(recusadas[0]!.reason).toBeInstanceOf(svc.aprov.AprovacaoStatusInvalidoError);
    // o OMIE dedupa pelo cod_int: nao importa quantas chamadas, so ha duas chaves
    expect(new Set(h.chamadas.map((c) => c.codInt)).size).toBe(2);
    expect(await movPorId(movId)).toMatchObject({ status_omie: 'concluida', mv_acxe: 1, mv_q2p: 1 });
    expect(await aprPorId(aprId)).toMatchObject({ status: 'aprovada' });
  });

  // ───────────────────────────── e-mails e telas que leem o espelho ─────────────────────────────

  it('contexto do e-mail e "minhas rejeicoes" (SQL real): fornecedor pelo espelho de NF da ACXE, produto pelo cadastro da ACXE, entradaEm', async (ctx) => {
    if (!criou.produtos || !criou.headers) ctx.skip();
    const dupla = await criarEntrada('21.1');
    const so = await criarEntrada('20.0.7');
    for (const c of [dupla.chave, so.chave]) {
      await pool.query(`INSERT INTO public."tbl_nf_header_ACXE" (c_chave_nfe, dest_razao) VALUES ($1, $2)`, [c, FORNECEDOR_NF]);
    }
    const c1 = await svc.notif.carregarContextoEntradaNacional(dupla.aprId);
    expect(c1).toMatchObject({ fornecedor: FORNECEDOR_NF, produto: DESC.comGemeo, entradaEm: 'ACXE + Q2P' });
    const c2 = await svc.notif.carregarContextoEntradaNacional(so.aprId);
    expect(c2).toMatchObject({ fornecedor: FORNECEDOR_NF, produto: DESC.comGemeo, entradaEm: 'ACXE' });

    await svc.aprov.rejeitar({ id: dupla.aprId, usuarioId: userId, perfilUsuario: 'gestor', motivo: 'conferir' });
    const rej = (await svc.aprov.listarMinhasRejeicoes(userId)).find((x) => x.id === dupla.aprId);
    expect(rej, 'a rejeicao da ACXE aparece para quem lancou').toBeDefined();
    expect(rej).toMatchObject({ empresa: 'acxe', fornecedorNome: FORNECEDOR_NF, produtoDescricao: DESC.comGemeo, galpao: '21.1' });
  });

  it('dois cliques simultaneos em "Retentar Q2P": nenhum quebra (o 2o ou refaz com a mesma chave idempotente ou leva 409 porque o 1o ja concluiu) e o estado final e coerente', async (ctx) => {
    if (!criou.produtos) ctx.skip();
    const { movId, aprId } = await criarEntrada('21.1');
    h.resposta = async (c) => {
      if (c.empresa === 'q2p') throw new Error('Q2P fora');
      return ok('ACXE')();
    };
    await aprovarGestor(aprId);
    h.chamadas.length = 0;
    h.resposta = async () => ok('Q2P-DUPLO')();
    const resultados = await Promise.allSettled([retentar(movId), retentar(movId)]);
    // a ordem das leituras decide: se as duas leem antes de qualquer escrita, as duas chamam o OMIE (cod_int idempotente);
    // se a 2a le depois da conclusao da 1a, recebe OperacaoNaoPendenteError (409 na rota). Nunca outro erro.
    const cumpridas = resultados.filter((r) => r.status === 'fulfilled');
    const recusadas = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(cumpridas.length, JSON.stringify(resultados)).toBeGreaterThanOrEqual(1);
    for (const r of recusadas) expect(r.reason).toBeInstanceOf(svc.pend.OperacaoNaoPendenteError);
    expect(new Set(h.chamadas.map((c) => c.codInt)).size, 'uma unica chave idempotente').toBe(1);
    expect(await movPorId(movId)).toMatchObject({ status_omie: 'concluida', mv_q2p: 1, id_movest_q2p: 'MOV-Q2P-DUPLO', ultimo_erro_omie: null });
  });

  // ───────────────────────────── contrato HTTP (rotas reais + servicos reais + banco real) ─────────────────────────────
  // O contrato de API que a tela da Historia 5 le (spec 017): a mesma jornada, agora pelo HTTP.

  describe('contrato HTTP', () => {
    type Api = { status: number; body: any };
    let api: (metodo: 'get' | 'post', url: string, corpo?: unknown) => Promise<Api>;
    const BASE_URL = '/api/v1/stockbridge';

    beforeAll(async () => {
      const express = (await import('express')).default;
      const supertest = (await import('supertest')).default;
      const rotas = await Promise.all([
        import('../routes/recebimento-nacional.routes.js'),
        import('../routes/aprovacao.routes.js'),
        import('../routes/operacoes-pendentes.routes.js'),
        import('../routes/movimentacao.routes.js'),
      ]);
      const app = express();
      app.use(express.json());
      for (const r of rotas) app.use(r.default);
      api = async (metodo, url, corpo) => {
        const res = metodo === 'get' ? await supertest(app).get(url) : await supertest(app).post(url).send((corpo ?? {}) as object);
        return { status: res.status, body: res.body };
      };
      h.userId = userId;
    });

    const porNf = (chave: string, produtos: Array<Record<string, unknown>>, descricao = DESC.comGemeo) => ({
      nf_chave_acesso: chave,
      itens: [{ indice: 0, descricao_fornecedor: descricao, produtos }],
    });
    const prodHttp = (produtoCodigoAcxe: number, localidade: string, quantidadeKg = 26000) => ({
      produto_codigo_acxe: produtoCodigoAcxe, quantidade_kg: quantidadeKg, localidade_id: loc[localidade]!.id,
    });
    const nfDaRodada = () => `H5${SUFIXO.slice(-4)}`;

    it('GET /localidades?empresa=acxe&destino=nf: lista com entradaEm, sem codigo OMIE; empresa=q2p no mesmo formato; sem destino, a lista do formulario manual', async () => {
      const acxe = await api('get', `${BASE_URL}/recebimento/nacional/localidades?empresa=acxe&destino=nf`);
      expect(acxe.status).toBe(200);
      const porCodigo = Object.fromEntries((acxe.body.data as Array<{ codigo: string; entradaEm: string[] }>).map((d) => [d.codigo, d.entradaEm]));
      expect(porCodigo['21.1']).toEqual(['acxe', 'q2p']);
      expect(porCodigo['20.0.7']).toEqual(['acxe']);
      expect(porCodigo['90.0.2']).toBeUndefined();
      expect(JSON.stringify(acxe.body)).not.toMatch(/\d{9,}/);

      const q2p = await api('get', `${BASE_URL}/recebimento/nacional/localidades?empresa=q2p&destino=nf`);
      expect(q2p.status).toBe(200);
      expect(q2p.body.data.every((d: { entradaEm: string[] }) => d.entradaEm.length === 1 && d.entradaEm[0] === 'q2p')).toBe(true);

      // sem destino: o formato do formulario manual (com codigoLocalEstoqueOmie), inalterado
      const manual = await api('get', `${BASE_URL}/recebimento/nacional/localidades?empresa=acxe`);
      expect(manual.status).toBe(200);
      expect(manual.body.data.map((l: { codigo: string }) => l.codigo)).toEqual(expect.arrayContaining(['21.2', '20.0.5', '20.0.7']));
      expect(manual.body.data[0]).toHaveProperty('codigoLocalEstoqueOmie');
    });

    it('GET /produtos?empresa=acxe traz semCorrelatoQ2p por produto', async (ctx) => {
      if (!criou.produtos) ctx.skip();
      const r = await api('get', `${BASE_URL}/recebimento/nacional/produtos?empresa=acxe&q=${encodeURIComponent(`TESTE H5`)}`);
      expect(r.status).toBe(200);
      const por = Object.fromEntries((r.body.data as Array<{ codigo: number; semCorrelatoQ2p?: boolean }>).map((p) => [p.codigo, p.semCorrelatoQ2p]));
      expect(por[P.comGemeo]).toBe(false);
      expect(por[P.semGemeo]).toBe(true);
    });

    it('jornada completa pela API: POST por-nf -> GET aprovacoes -> aprovar (Q2P pendente) -> GET movimentacoes/painel -> retentar (falha 502, depois 200) -> concluida', async (ctx) => {
      if (!criou.produtos) ctx.skip();
      const chave = chaveNova();
      h.detalhe.mockResolvedValue(detalheAcxe(chave));

      // 1) POST por-nf: 201 e o desfecho por produto no formato da tela
      const post = await api('post', `${BASE_URL}/recebimento/nacional/por-nf`, porNf(chave, [prodHttp(P.comGemeo, '21.1')]));
      expect(post.status, JSON.stringify(post.body)).toBe(201);
      expect(post.body.error).toBeNull();
      const prod = post.body.data.produtos[0];
      expect(prod).toMatchObject({
        status: 'aguardando_aprovacao', produtoCodigoAcxe: P.comGemeo, produtoCodigoQ2p: P.gemeo, entradaEm: ['acxe', 'q2p'], produto: DESC.comGemeo,
        quantidadeKg: 26000, quantidadeNfKg: 26000, divergenciaKg: 0, valorItemBrl: 124800,
      });
      expect(typeof prod.movimentacaoId).toBe('string');
      expect(typeof prod.aprovacaoId).toBe('string');

      // 2) reenvio: continua 201, ja_recebido (idempotencia pelo banco)
      const de_novo = await api('post', `${BASE_URL}/recebimento/nacional/por-nf`, porNf(chave, [prodHttp(P.comGemeo, '21.1')]));
      expect(de_novo.status).toBe(201);
      expect(de_novo.body.data.produtos[0].status).toBe('ja_recebido');

      // 3) GET /aprovacoes: a pendencia traz entradaEm
      const pend = await api('get', `${BASE_URL}/aprovacoes`);
      expect(pend.status).toBe(200);
      const minha = pend.body.data.find((p: { id: string }) => p.id === prod.aprovacaoId);
      expect(minha).toMatchObject({ empresa: 'acxe', galpao: '21.1', entradaEm: ['acxe', 'q2p'], tipoAprovacao: 'entrada_manual', produtoCodigoQ2p: P.gemeo });

      // 4) GET /movimentacoes: aguardando o gestor = ainda NAO retentavel
      let mov = await api('get', `${BASE_URL}/movimentacoes?nf=${nfDaRodada()}&pageSize=200`);
      expect(mov.body.data.find((m: { id: string }) => m.id === prod.movimentacaoId)).toMatchObject({ statusOmie: 'pendente_q2p', retentavelQ2p: false, empresa: 'acxe' });

      // 5) aprovar com a Q2P fora do ar: 200 e pendenciaOmie
      h.resposta = async (c) => {
        if (c.empresa === 'q2p') throw new Error('Q2P fora do ar');
        return ok('ACXE')();
      };
      const aprovou = await api('post', `${BASE_URL}/aprovacoes/${prod.aprovacaoId}/aprovar`);
      expect(aprovou.status, JSON.stringify(aprovou.body)).toBe(200);
      expect(aprovou.body.data).toMatchObject({ id: prod.aprovacaoId, loteStatus: 'reconciliado', pendenciaOmie: { lado: 'q2p', movimentacaoId: prod.movimentacaoId, mensagem: 'Q2P fora do ar' } });
      expect(typeof aprovou.body.data.pendenciaOmie.opId).toBe('string');

      // 6) Movimentacoes: agora retentavel; painel de pendencias OMIE lista com subtipo/empresa/galpao
      mov = await api('get', `${BASE_URL}/movimentacoes?nf=${nfDaRodada()}&pageSize=200`);
      expect(mov.body.data.find((m: { id: string }) => m.id === prod.movimentacaoId)).toMatchObject({
        statusOmie: 'pendente_q2p', retentavelQ2p: true, ladoAcxe: { status: 'Sucesso' }, ladoQ2p: { status: null },
      });
      const painel = await api('get', `${BASE_URL}/operacoes-pendentes`);
      expect(painel.body.data.find((p: { id: string }) => p.id === prod.movimentacaoId)).toMatchObject({
        ladoPendente: 'q2p', subtipo: 'compra_nacional', empresa: 'acxe', galpao: '21.1', tentativas: 1,
      });

      // 7) "Retentar Q2P" falha: 502 OMIE_Q2P_FAIL (estado parcial, pode retentar) e a tentativa conta
      h.resposta = async () => {
        throw new Error('Q2P ainda fora');
      };
      const falhou = await api('post', `${BASE_URL}/operacoes-pendentes/${prod.movimentacaoId}/retentar`);
      expect(falhou.status).toBe(502);
      expect(falhou.body.error).toMatchObject({ code: 'OMIE_Q2P_FAIL', stateClean: false, retryable: true, userAction: 'retry_q2p', movimentacaoId: prod.movimentacaoId });

      // 8) "Retentar Q2P" ok: 200 concluida, Movimentacoes deixa de oferecer o botao
      h.resposta = async () => ok('Q2P-RETRY')();
      const refeito = await api('post', `${BASE_URL}/operacoes-pendentes/${prod.movimentacaoId}/retentar`);
      expect(refeito.status).toBe(200);
      expect(refeito.body.data).toMatchObject({ movimentacaoId: prod.movimentacaoId, statusOmie: 'concluida', jaExistiaNoOmie: false, tentativasQ2p: 2 });
      mov = await api('get', `${BASE_URL}/movimentacoes?nf=${nfDaRodada()}&pageSize=200`);
      expect(mov.body.data.find((m: { id: string }) => m.id === prod.movimentacaoId)).toMatchObject({
        statusOmie: 'concluida', retentavelQ2p: false, ladoQ2p: { status: 'Sucesso', idMovest: 'MOV-Q2P-RETRY' },
      });
      expect(h.baixa).not.toHaveBeenCalled();
    });

    it('POST /aprovar: OMIE da ACXE fora do ar = 502 OMIE_ACXE_FAIL e a pendencia segue na lista; sem custo gravado = 422 ENTRADA_NACIONAL_INCONSISTENTE com userMessage', async (ctx) => {
      if (!criou.produtos) ctx.skip();
      const a = await criarEntrada('21.1');
      h.resposta = async () => {
        throw new Error('ACXE fora');
      };
      const r1 = await api('post', `${BASE_URL}/aprovacoes/${a.aprId}/aprovar`);
      expect(r1.status).toBe(502);
      expect(r1.body.error).toMatchObject({ code: 'OMIE_ACXE_FAIL', stateClean: true, retryable: true, opId: expect.any(String), movimentacaoId: a.movId });
      expect(r1.body.error.userMessage).toContain('Nada foi registrado');
      const lista = await api('get', `${BASE_URL}/aprovacoes`);
      expect(lista.body.data.some((p: { id: string }) => p.id === a.aprId)).toBe(true);

      // custo da NF some do registro (inconsistencia): 422, nada vai ao OMIE
      await pool.query(`UPDATE stockbridge.movimentacao SET custo_unitario_brl = NULL WHERE id = $1`, [a.movId]);
      h.chamadas.length = 0;
      h.resposta = async (c) => ok(c.empresa.toUpperCase())();
      const r2 = await api('post', `${BASE_URL}/aprovacoes/${a.aprId}/aprovar`);
      expect(r2.status).toBe(422);
      expect(r2.body.error.code).toBe('ENTRADA_NACIONAL_INCONSISTENTE');
      expect(r2.body.error.userMessage).toContain('valor unitário da NF');
      expect(h.chamadas).toHaveLength(0);
    });

    it('POST /por-nf: 400 PRODUTO_EMPRESA_INCOMPATIVEL, 400 LOCALIDADE_NAO_ELEGIVEL, 404 PRODUTO_NAO_ENCONTRADO e 422 PRODUTO_SEM_CORRELATO_Q2P / PRODUTO_CORRELATO_Q2P_REPETIDO com o banco real — e nada gravado', async (ctx) => {
      if (!criou.produtos) ctx.skip();
      const chave = chaveNova();
      h.detalhe.mockResolvedValue(detalheAcxe(chave));
      const url = `${BASE_URL}/recebimento/nacional/por-nf`;

      const q2p = await api('post', url, porNf(chave, [{ produto_codigo_q2p: P.gemeo, quantidade_kg: 26000, localidade_id: loc['20.0.7']!.id }]));
      expect(q2p.status).toBe(400);
      expect(q2p.body.error.code).toBe('PRODUTO_EMPRESA_INCOMPATIVEL');

      const local = await api('post', url, porNf(chave, [prodHttp(P.comGemeo, '11.2')]));
      expect(local.status).toBe(400);
      expect(local.body.error.code).toBe('LOCALIDADE_NAO_ELEGIVEL');
      expect(JSON.stringify(local.body)).not.toContain(loc['11.2']!.id);

      const inexistente = await api('post', url, porNf(chave, [prodHttp(BASE + 999, '20.0.7')]));
      expect(inexistente.status).toBe(404);
      expect(inexistente.body.error.code).toBe('PRODUTO_NAO_ENCONTRADO');

      h.detalhe.mockResolvedValue(detalheAcxe(chave, { descricao: DESC.semGemeo }));
      const semGemeo = await api('post', url, porNf(chave, [prodHttp(P.semGemeo, '21.1')], DESC.semGemeo));
      expect(semGemeo.status).toBe(422);
      expect(semGemeo.body.error).toMatchObject({ code: 'PRODUTO_SEM_CORRELATO_Q2P' });
      expect(semGemeo.body.error.userMessage).toBe(
        `O produto "${DESC.semGemeo}" não tem correspondente na Q2P, então não pode entrar em estoque que também é da Q2P. Escolha um estoque só da ACXE ou peça o cadastro do produto na Q2P.`,
      );

      h.detalhe.mockResolvedValue(detalheAcxe(chave));
      const repetido = await api('post', url, porNf(chave, [prodHttp(P.comGemeo, '21.1', 13000), prodHttp(P.outroComMesmoGemeo, '11.1', 13000)]));
      expect(repetido.status).toBe(422);
      expect(repetido.body.error.code).toBe('PRODUTO_CORRELATO_Q2P_REPETIDO');

      expect(await movDaNf(chave)).toHaveLength(0);
      expect(await aprDaNf(chave)).toHaveLength(0);
    });
  });

  // ───────────────────────────── fornecedor_exclusao por empresa ─────────────────────────────

  it('exclusao de fornecedor por empresa (indice unico (empresa, cnpj)): excluir na ACXE nao exclui na Q2P; duplicada na mesma empresa e recusada; reincluir so a da empresa', async () => {
    const { excluirFornecedor, reincluirFornecedor, listarFornecedores, FornecedorJaExcluidoError, ExclusaoNaoEncontradaError } = svc.forn;

    await excluirFornecedor({ cnpj: CNPJ_TESTE, nome: FORNECEDOR_NF, motivo: 'intercompany ACXE', usuarioId: userId, empresa: 'acxe' });
    await expect(excluirFornecedor({ cnpj: CNPJ_TESTE, nome: FORNECEDOR_NF, motivo: null, usuarioId: userId, empresa: 'acxe' })).rejects.toBeInstanceOf(FornecedorJaExcluidoError);

    // a Q2P e independente (sem empresa = q2p) e tem o proprio motivo
    await excluirFornecedor({ cnpj: CNPJ_TESTE, nome: FORNECEDOR_NF, motivo: 'motivo da Q2P', usuarioId: userId });
    await expect(excluirFornecedor({ cnpj: CNPJ_TESTE, nome: FORNECEDOR_NF, motivo: null, usuarioId: userId, empresa: 'q2p' })).rejects.toBeInstanceOf(FornecedorJaExcluidoError);

    const daAcxe = (await listarFornecedores('acxe')).find((f) => f.cnpj === CNPJ_TESTE);
    const daQ2p = (await listarFornecedores('q2p')).find((f) => f.cnpj === CNPJ_TESTE);
    const padrao = (await listarFornecedores()).find((f) => f.cnpj === CNPJ_TESTE);
    expect(daAcxe).toMatchObject({ excluido: true, motivoExclusao: 'intercompany ACXE' });
    expect(daQ2p).toMatchObject({ excluido: true, motivoExclusao: 'motivo da Q2P' });
    expect(padrao).toMatchObject({ excluido: true, motivoExclusao: 'motivo da Q2P' }); // sem empresa = q2p

    // reincluir na ACXE: a Q2P continua excluida; excluir de novo na ACXE volta a ser possivel
    await reincluirFornecedor({ cnpj: CNPJ_TESTE, usuarioId: userId, empresa: 'acxe' });
    expect((await listarFornecedores('acxe')).find((f) => f.cnpj === CNPJ_TESTE)).toBeUndefined();
    expect((await listarFornecedores('q2p')).find((f) => f.cnpj === CNPJ_TESTE)).toMatchObject({ excluido: true });
    await expect(reincluirFornecedor({ cnpj: CNPJ_TESTE, usuarioId: userId, empresa: 'acxe' })).rejects.toBeInstanceOf(ExclusaoNaoEncontradaError);
    await excluirFornecedor({ cnpj: CNPJ_TESTE, nome: FORNECEDOR_NF, motivo: 'de novo', usuarioId: userId, empresa: 'acxe' });

    const { rows } = await pool.query(
      `SELECT empresa, reincluido_em IS NULL AS ativa FROM stockbridge.fornecedor_exclusao WHERE fornecedor_cnpj = $1 ORDER BY excluido_em, id`,
      [CNPJ_TESTE],
    );
    expect(rows.map((r) => `${r.empresa}:${r.ativa}`)).toEqual(['acxe:false', 'q2p:true', 'acxe:true']);
    // CHECK da coluna
    await expect(
      pool.query(`INSERT INTO stockbridge.fornecedor_exclusao (empresa, fornecedor_cnpj, fornecedor_nome, excluido_por) VALUES ('zzzz', $1, 'x', $2)`, [CNPJ_TESTE, userId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('seed da 0058: a Q2P (matriz e filial) esta excluida da fila da ACXE e NAO da fila da Q2P', async () => {
    const { rows } = await pool.query(
      `SELECT empresa, fornecedor_cnpj FROM stockbridge.fornecedor_exclusao WHERE reincluido_em IS NULL AND fornecedor_cnpj IN ('27.019.059/0001-88', '27.019.059/0002-69') ORDER BY empresa, fornecedor_cnpj`,
    );
    const acxe = rows.filter((r) => r.empresa === 'acxe').map((r) => r.fornecedor_cnpj);
    // o seed exige um usuario gestor/diretor ativo; sem ele a migration so avisa (ver o RAISE WARNING da 0058)
    if (acxe.length > 0) expect(acxe).toEqual(['27.019.059/0001-88', '27.019.059/0002-69']);
  });
});
