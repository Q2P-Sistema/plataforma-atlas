import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Feature 017, research D21 (ACXEGDP-437) — o CLIQUE de uma NF revertida no portal, de PONTA A PONTA contra Postgres REAL (opt-in).
//
// A NF 19252 (Zaraplast, Q2P, 25/10/2026): o Atlas concluiu o fiscal as 17:02 e o usuario o reverteu no portal as 17:13.
// Aqui tudo e real — detalhe da fila (SQL do espelho + sinal de reversao), ledger do fiscal, vinculos de PC, sugestao/releitura
// de PC, recebimento fisico (movimentacao + aprovacao) — menos o OMIE (cliente substituido por um duble) e os e-mails. Prova a
// CADEIA: sinal/marcador -> detalhe "fiscal pendente + revertido" -> POST -> adquirirLedger reabre a trava -> fiscal de novo com o PC
// escolhido -> fisico gravado. Os pedacos tem testes proprios (fila-nacional-acxe-db, recebimento-fiscal-revertido-db,
// recebimento-nacional-revertido); este e o que prova que eles se encaixam.
//
// Rodar (banco descartavel migrado ate a 0060; escreve e apaga linhas de teste; shared.audit_log e append-only e fica com rastro —
// NUNCA contra UAT/PROD). As tabelas do espelho OMIE (`public.tbl_*`) sao do n8n: as que faltarem sao criadas e removidas no fim —
// com o opt-in o vitest.config.ts do modulo roda os arquivos um por vez (fora dele, use --no-file-parallelism).
//   ATLAS_DB_INTEGRATION=1 DATABASE_URL=postgres://... REDIS_URL=redis://localhost:6379 SESSION_SECRET=<32+ chars> \
//     pnpm --filter @atlas/stockbridge exec vitest run src/__tests__/recebimento-nacional-revertido-db.test.ts

const DB_URL = process.env.DATABASE_URL;
const temBanco = process.env.ATLAS_DB_INTEGRATION === '1' && typeof DB_URL === 'string' && DB_URL.length > 0;

// Config lida uma vez, na primeira chamada. So com o opt-in do banco (sem ele o arquivo e pulado e nao mexe no ambiente).
vi.hoisted(() => {
  if (process.env.ATLAS_DB_INTEGRATION === '1') {
    process.env.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = 'true';
    process.env.STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED = 'true';
    process.env.STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE = '2026-09-11';
    process.env.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = 'true';
  }
});

const omie = vi.hoisted(() => ({ consultar: vi.fn(), alterar: vi.fn(), concluir: vi.fn(), pedido: vi.fn() }));
vi.mock('@atlas/integration-omie', () => ({
  consultarRecebimentoNfe: (...a: unknown[]) => omie.consultar(...a),
  alterarRecebimentoNfeItens: (...a: unknown[]) => omie.alterar(...a),
  concluirRecebimentoNfe: (...a: unknown[]) => omie.concluir(...a),
  consultarPedidoCompra: (...a: unknown[]) => omie.pedido(...a),
  incluirAjusteEstoque: vi.fn(),
  listarAjusteEstoque: vi.fn(),
  consultarNF: vi.fn(),
  isMockMode: () => false,
}));
vi.mock('../services/notificacao.service.js', () => ({
  enviarAlertaRecebimentoNacionalLote: vi.fn().mockResolvedValue(undefined),
  enviarAvisoComprasNfSemPc: vi.fn().mockResolvedValue('enviado'),
}));
vi.mock('../services/correlacao-produto.service.js', () => ({
  registrarUsoCorrelacao: vi.fn().mockResolvedValue({ criada: true }),
  sugerirProdutosEmLote: vi.fn().mockResolvedValue(new Map()),
}));
// A abertura do detalhe (e da fila) ja marca a tentativa revertida. O e2e da reabertura no adquirirLedger precisa do ledger ainda
// 'concluido' no clique: ali o teste esconde o ledger vigente (ledgerFiscalVigente), como se a marcacao da abertura nao tivesse rodado.
const janela = vi.hoisted(() => ({ semMarcacaoNaAbertura: false }));
vi.mock('../services/fiscal-revertido.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/fiscal-revertido.js')>();
  return {
    ...real,
    ledgerFiscalVigente: (...a: Parameters<typeof real.ledgerFiscalVigente>) =>
      janela.semMarcacaoNaAbertura ? Promise.resolve(null) : real.ledgerFiscalVigente(...a),
  };
});

import type { EscolhaPc } from '../services/pc-sugestao.service.js';

type Linha = Record<string, unknown>;
type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Linha[]; rowCount: number | null }> };

/** Faixa de ids de teste (bigint): nao colide com ids reais do OMIE (10 digitos) nem entre execucoes. */
const BASE = 6_900_000_000_000 + Math.floor(Math.random() * 900_000_000) * 1000;
const FORN = BASE + 1;
const PROD_Q2P = BASE + 2;
const PC_OUTRO = { ncodped: BASE + 3, ncoditem: BASE + 4 };
const CNPJ_FORN = '99.000.019/0001-19';
const MIN = 60 * 1000;
const HORA = 60 * MIN;
const LINHAS = [
  { seq: 1, qtde: 4125, total: 43725.01 },
  { seq: 2, qtde: 1375, total: 14575.01 },
  { seq: 3, qtde: 6875, total: 72875.02 },
  { seq: 4, qtde: 1375, total: 14575.01 },
];
const KG_TOTAL = 13750;
const DESC = 'PEBD EB';

describe.skipIf(!temBanco)('D21 — o clique da NF revertida no portal, de ponta a ponta (integracao)', () => {
  let pool: Pool;
  let pronto = false;
  let uid = '';
  let locId = '';
  const tabelasCriadas: string[] = [];
  const nfs: Array<{ chave: string; nIdReceb: number; nIdNf: number; pcPed: number; pcItem: number }> = [];
  let seq = 0;
  let svc: typeof import('../services/fila-nacional.service.js');
  let nac: typeof import('../services/recebimento-nacional.service.js');
  let rev: typeof import('../services/fiscal-revertido.js');
  let fiscalSvc: typeof import('../services/recebimento-fiscal.service.js');

  const q = (sql: string, params?: unknown[]) => pool.query(sql, params);

  const DDL: Array<[string, string, string[]]> = [
    ['tbl_nf_header_Q2P', `CREATE TABLE public."tbl_nf_header_Q2P" (
       n_id_nf bigint PRIMARY KEY, c_chave_nfe varchar(44), n_nf varchar(20), dest_razao varchar(200), dest_cnpj_cpf varchar(20),
       d_emi date, n_id_receb bigint, cancelada boolean NOT NULL DEFAULT false, deletada boolean NOT NULL DEFAULT false, tp_nf smallint,
       d_alt date, h_alt time)`, ['n_id_nf', 'c_chave_nfe', 'n_nf', 'dest_razao', 'dest_cnpj_cpf', 'd_emi', 'n_id_receb', 'cancelada', 'deletada', 'tp_nf', 'd_alt', 'h_alt']],
    ['tbl_nf_itens_Q2P', `CREATE TABLE public."tbl_nf_itens_Q2P" (
       n_id_nf bigint NOT NULL, n_cod_item bigint NOT NULL, n_cod_prod bigint, c_prod varchar(60), x_prod varchar(200), cfop varchar(10),
       q_com numeric(14,3), u_com varchar(6), v_un_com numeric(14,4), v_prod numeric(14,2), v_tot_item numeric(14,2), codigo_local_estoque bigint,
       PRIMARY KEY (n_id_nf, n_cod_item))`, ['n_id_nf', 'n_cod_item', 'x_prod', 'cfop', 'q_com', 'u_com', 'v_prod']],
    ['tbl_produtos_Q2P', `CREATE TABLE public."tbl_produtos_Q2P" (codigo_produto bigint, codigo varchar(50), descricao text, inativo char(1), unidade varchar(10))`,
      ['codigo_produto', 'descricao', 'inativo', 'unidade']],
    ['tbl_pedidosCompras_Q2P', `CREATE TABLE public."tbl_pedidosCompras_Q2P" (
       ncoditem bigint NOT NULL, ncodped bigint, cetapa varchar(20), cnumero varchar(50), ddtprevisao date, ncodfor bigint, cdescricao text, cproduto varchar(50),
       cunidade varchar(10), codigo_local_estoque varchar(50), ncodprod bigint, nqtde numeric(15,2), nqtderec numeric(15,2), nvaltot numeric(15,2),
       nvalunit numeric(15,2), data_atualizacao timestamptz)`, ['ncoditem', 'ncodped', 'cetapa', 'cnumero', 'ncodfor', 'nqtde', 'nqtderec', 'nvalunit', 'data_atualizacao']],
    ['tbl_cadastroFornecedoresClientes_Q2P', `CREATE TABLE public."tbl_cadastroFornecedoresClientes_Q2P" (
       codigo_cliente_omie bigint NOT NULL, cnpj_cpf text NOT NULL, razao_social text NOT NULL, nome_fantasia text, inativo char(1))`,
      ['codigo_cliente_omie', 'cnpj_cpf', 'razao_social']],
  ];

  beforeAll(async () => {
    const core = await import('@atlas/core');
    pool = core.getPool() as unknown as Pool;
    const col = await q(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'stockbridge' AND table_name = 'recebimento_fiscal' AND column_name = 'revertido_em'`);
    if (col.rows.length === 0) {
      console.warn('[recebimento-nacional-revertido-db] migration 0060 ausente neste banco — testes pulados');
      return;
    }
    const us = await q(`SELECT id FROM atlas.users ORDER BY created_at LIMIT 1`);
    const lo = await q(`SELECT id::text AS id FROM stockbridge.localidade WHERE codigo = '11.2' AND ativo = true`);
    if (us.rows.length === 0 || lo.rows.length === 0) {
      console.warn('[recebimento-nacional-revertido-db] precisa de um usuario em atlas.users e da localidade 11.2 — testes pulados');
      return;
    }
    uid = String(us.rows[0]!.id);
    locId = String(lo.rows[0]!.id);
    // Espelho OMIE: confere tudo antes de criar. O que ja existir precisa estar VAZIO (espelho real: o teste nao escreve nele) e ter
    // as colunas que este teste usa (senao e de outro teste: pula); o que faltar e criado e removido no fim.
    const faltam: Array<[string, string]> = [];
    for (const [nome, ddl, colunas] of DDL) {
      const ex = await q(`SELECT to_regclass($1) IS NOT NULL AS existe`, [`public."${nome}"`]);
      if (ex.rows[0]!.existe !== true) {
        faltam.push([nome, ddl]);
        continue;
      }
      if (Number((await q(`SELECT count(*)::int AS n FROM public."${nome}"`)).rows[0]!.n) > 0) {
        console.warn(`[recebimento-nacional-revertido-db] public."${nome}" ja tem dados (espelho real) — testes pulados`);
        return;
      }
      const cs = await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [nome]);
      const tem = new Set(cs.rows.map((r) => String(r.column_name)));
      if (colunas.some((c) => !tem.has(c))) {
        console.warn(`[recebimento-nacional-revertido-db] public."${nome}" existe sem as colunas do teste — testes pulados`);
        return;
      }
    }
    for (const [nome, ddl] of faltam) {
      await q(ddl);
      tabelasCriadas.push(nome);
    }
    // Fornecedor, produto e uma linha QUALQUER na copia de PCs (a copia precisa estar em dia: senao o POST da 503 COPIA_PCS_DEFASADA).
    // O PC da NF fica de fora da copia, como o da 19252 (o OMIE o tira da lista de pendentes ao associa-lo a um recebimento aberto).
    await q(`INSERT INTO public."tbl_cadastroFornecedoresClientes_Q2P" (codigo_cliente_omie, cnpj_cpf, razao_social) VALUES ($1, $2, 'ZARAPLAST S/A')`, [FORN, CNPJ_FORN]);
    await q(`INSERT INTO public."tbl_produtos_Q2P" (codigo_produto, descricao, inativo, unidade) VALUES ($1, 'PEBD EB RECICLADO', NULL, 'KG')`, [PROD_Q2P]);
    await q(
      `INSERT INTO public."tbl_pedidosCompras_Q2P" (ncodped, ncoditem, cnumero, cetapa, ncodfor, nqtde, nqtderec, nvalunit, nvaltot, cunidade, ddtprevisao, cdescricao, cproduto, ncodprod, data_atualizacao)
       VALUES ($1, $2, '999', '15', $3, 1000, 0, 5, 5000, 'KG', CURRENT_DATE + 5, 'OUTRO PRODUTO', 'X', $4, now())`,
      [PC_OUTRO.ncodped, PC_OUTRO.ncoditem, FORN + 100, PROD_Q2P],
    );
    svc = await import('../services/fila-nacional.service.js');
    nac = await import('../services/recebimento-nacional.service.js');
    rev = await import('../services/fiscal-revertido.js');
    fiscalSvc = await import('../services/recebimento-fiscal.service.js');
    pronto = await rev.fiscalRevertidoHabilitado();
    if (!pronto) console.warn('[recebimento-nacional-revertido-db] fiscalRevertidoHabilitado() = false neste ambiente — testes pulados');
  });

  afterAll(async () => {
    if (!pool) return;
    const chaves = nfs.map((n) => n.chave);
    if (chaves.length > 0) {
      // Dado de teste: hard delete permitido aqui (a trigger registra o DELETE). Filhas antes do ledger (FK).
      await q(`DELETE FROM stockbridge.aprovacao WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
      await q(`DELETE FROM stockbridge.movimentacao WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
      await q(`DELETE FROM stockbridge.recebimento_fiscal_pc WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
      await q(`DELETE FROM stockbridge.recebimento_fiscal WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
      await q(`DELETE FROM public."tbl_recebimentoNFe_Q2P" WHERE c_chave_nfe = ANY($1::text[])`, [chaves]); // itens saem em cascata
    }
    await q(`DELETE FROM stockbridge.pedido_compra_visto WHERE empresa = 'q2p' AND n_cod_for = ANY($1::bigint[])`, [[FORN, FORN + 100]]);
    for (const n of nfs) await q(`DELETE FROM stockbridge.pedido_compra_visto WHERE empresa = 'q2p' AND n_cod_item = $1`, [n.pcItem]);
    // Sempre, mesmo com tabela criada aqui (o DROP vem depois): a tabela que ja existia fica vazia como estava
    const idsNf = nfs.map((n) => n.nIdNf);
    await q(`DELETE FROM public."tbl_nf_itens_Q2P" WHERE n_id_nf = ANY($1::bigint[])`, [idsNf]).catch(() => undefined);
    await q(`DELETE FROM public."tbl_nf_header_Q2P" WHERE n_id_nf = ANY($1::bigint[])`, [idsNf]).catch(() => undefined);
    await q(`DELETE FROM public."tbl_pedidosCompras_Q2P" WHERE ncoditem = $1`, [PC_OUTRO.ncoditem]).catch(() => undefined);
    await q(`DELETE FROM public."tbl_produtos_Q2P" WHERE codigo_produto = $1`, [PROD_Q2P]).catch(() => undefined);
    await q(`DELETE FROM public."tbl_cadastroFornecedoresClientes_Q2P" WHERE codigo_cliente_omie = $1`, [FORN]).catch(() => undefined);
    for (const nome of tabelasCriadas) await q(`DROP TABLE IF EXISTS public."${nome}" CASCADE`);
  });

  beforeEach(() => {
    omie.consultar.mockReset();
    omie.alterar.mockReset();
    omie.concluir.mockReset();
    omie.pedido.mockReset();
  });

  interface Cen {
    /** conclusao do fiscal pelo Atlas: ha quanto tempo (ms) */
    concluidoHa: number;
    ledger?: 'concluido' | 'revertido';
    /** marcador do ledger, quando 'revertido': ha quanto tempo (ms) e como */
    revertidoHa?: number;
    origem?: 'espelho' | 'omie_ao_vivo';
    /** espelho de recebimentos: c_recebido e quando foi alterado (ms atras) */
    receb: { recebido: 'N' | 'S'; alteradoHa: number };
    /** nota de entrada no espelho de NF: quando foi alterada (ms atras); ausente = nao existe */
    header?: { alteradoHa: number };
  }

  /** Semeia uma NF "19252" (4 linhas, PC 308 vinculado, ledger concluido com as 4 linhas de PC) e devolve seus ids. */
  async function semear(c: Cen): Promise<{ chave: string; nIdReceb: number; pcPed: number; pcItem: number; ledgerId: string }> {
    seq += 1;
    const chave = `95${String(BASE + seq).padStart(42, '0')}`.slice(0, 44);
    const nIdReceb = BASE + 10 + seq * 10;
    const nIdNf = BASE + 11 + seq * 10;
    const pcPed = BASE + 12 + seq * 10;
    const pcItem = BASE + 13 + seq * 10;
    const numero = String(19250 + seq);
    nfs.push({ chave, nIdReceb, nIdNf, pcPed, pcItem });
    const em = (msAtras: number) => new Date(Date.now() - msAtras).toISOString();
    const brtDate = `($1::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date`;
    const brtHora = `to_char($1::timestamptz AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI:SS')`;

    await q(
      `INSERT INTO public."tbl_recebimentoNFe_Q2P" (n_id_receb, c_chave_nfe, c_numero_nfe, d_emissao, n_id_fornecedor, c_cnpj_cpf, c_razao_social, c_etapa, c_recebido, c_cancelada, c_bloqueado, c_devolvido, d_alt, h_alt)
       VALUES ($2, $3, $4, CURRENT_DATE - 2, $5, $6, 'ZARAPLAST S/A', $7, $8, 'N', 'N', 'N', ${brtDate}, ${brtHora})`,
      [em(c.receb.alteradoHa), nIdReceb, chave, numero.padStart(9, '0'), FORN, CNPJ_FORN, c.receb.recebido === 'N' ? '40' : '60', c.receb.recebido],
    );
    for (const l of LINHAS) {
      await q(
        `INSERT INTO public."tbl_recebimentoNFe_itens_Q2P"
           (n_id_receb, n_sequencia, c_descricao_produto, c_cfop_entrada, n_qtde_nfe, c_unidade_nfe, n_preco_unit, v_total_item, n_id_item, c_ignorar_item, c_associar_existente,
            c_nao_gerar_mov_estoque, c_nao_gerar_financeiro, n_id_pedido, n_id_it_pedido)
         VALUES ($1, $2, $3, '2.102', $4, 'KG', 10.6, $5, $6, 'N', 'S', 'S', 'N', $7, $8)`,
        [nIdReceb, l.seq, DESC, l.qtde, l.total, nIdNf + l.seq, pcPed, pcItem],
      );
    }
    if (c.header) {
      await q(
        `INSERT INTO public."tbl_nf_header_Q2P" (n_id_nf, c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, n_id_receb, tp_nf, d_alt, h_alt)
         VALUES ($2, $3, $4, 'ZARAPLAST S/A', $5, CURRENT_DATE - 2, $6, 0, ${brtDate}, ${brtHora}::time)`,
        [em(c.header.alteradoHa), nIdNf, chave, numero.padStart(9, '0'), CNPJ_FORN, nIdReceb],
      );
      // a nota de entrada traz as 4 linhas (a fonte (a) da fila e orientada a itens); n_cod_item = n_id_item do recebimento liga as sequencias
      for (const l of LINHAS) {
        await q(
          `INSERT INTO public."tbl_nf_itens_Q2P" (n_id_nf, n_cod_item, x_prod, cfop, q_com, u_com, v_un_com, v_prod, v_tot_item)
           VALUES ($1, $2, $3, '2.102', $4, 'KG', 10.6, $5, $5)`,
          [nIdNf, nIdNf + l.seq, DESC, l.qtde, l.total],
        );
      }
    }
    // PC 308: so no cache de PCs vistos, visto ANTES da conclusao (o OMIE o tirou da lista de pendentes ao associa-lo ao recebimento)
    await q(
      `INSERT INTO stockbridge.pedido_compra_visto (empresa, n_cod_ped, n_cod_item, pc_numero, n_cod_for, produto_descricao, unidade, qtde, qtde_rec, preco_unit, etapa, valor_total_pc, n_cod_prod, visto_em)
       VALUES ('q2p', $1, $2, '308', $3, 'PEBD EB RECICLADO', 'KG', $4, 0, 10.6, '15', 145750.05, $5, now() - interval '5 hours')`,
      [pcPed, pcItem, FORN, KG_TOTAL, PROD_Q2P],
    );
    const l = await q(
      `INSERT INTO stockbridge.recebimento_fiscal (nf_chave_acesso, n_id_receb, nota_fiscal, fornecedor_nome, status, confirmado_por, iniciado_em, finalizado_em, itens_total, empresa,
                                                    revertido_em, revertido_origem)
       VALUES ($1, $2, $3, 'ZARAPLAST S/A', $4::text, $5, now() - ($6::numeric * interval '1 millisecond') - interval '1 minute', now() - ($6::numeric * interval '1 millisecond'), 4, 'q2p',
               CASE WHEN $4::text = 'revertido' THEN now() - ($7::numeric * interval '1 millisecond') END, CASE WHEN $4::text = 'revertido' THEN $8::text END) RETURNING id`,
      [chave, nIdReceb, numero, c.ledger ?? 'concluido', uid, c.concluidoHa, c.revertidoHa ?? 0, c.origem ?? 'espelho'],
    );
    const ledgerId = String(l.rows[0]!.id);
    for (const ln of LINHAS) {
      await q(
        `INSERT INTO stockbridge.recebimento_fiscal_pc
           (recebimento_fiscal_id, nf_chave_acesso, n_sequencia, origem, n_cod_ped, n_cod_item_ped, pc_numero, dentro_tolerancia, qtd_nf_kg, preco_nf, status, confirmado_por, concluido_em)
         VALUES ($1, $2, $3, 'omie', $4, $5, '308', true, $6, 10.6, $7::text, $8, now() - ($9::numeric * interval '1 millisecond'))`,
        [ledgerId, chave, ln.seq, pcPed, pcItem, ln.qtde, (c.ledger ?? 'concluido') === 'revertido' ? 'revertido' : 'concluido', uid, c.concluidoHa],
      );
    }
    return { chave, nIdReceb, pcPed, pcItem, ledgerId };
  }

  /** O OMIE como a reversao no portal o deixou: etapa 40, nao recebido, os 4 itens ainda vinculados ao PC 308, "nao movimentar estoque" mantido. */
  function omieComoNaReversao(n: { chave: string; nIdReceb: number; pcPed: number; pcItem: number }, over: Record<string, unknown> = {}) {
    omie.consultar.mockImplementation(async () => ({
      nIdReceb: n.nIdReceb, cChaveNFe: n.chave, cNumeroNFe: '000019252', cEtapa: '40', dEmissaoNFe: '23/10/2026', nIdFornecedor: FORN, cCNPJ_CPF: CNPJ_FORN,
      cRazaoSocial: 'ZARAPLAST S/A', nValorNFe: 145750.05, cRecebido: 'N', cCancelada: 'N', cBloqueado: 'N', cDevolvido: 'N', cUsuarioRec: null, dRec: null, hRec: null,
      itens: LINHAS.map((l) => ({
        nSequencia: l.seq, cDescricaoProduto: DESC, cCodigoProduto: 'PEBD', cNCM: '3901.10.00', cCFOP: '6.101', cCFOPEntrada: '2.102', nQtdeNFe: l.qtde, cUnidadeNfe: 'KG',
        nPrecoUnit: 10.6, vTotalItem: l.total, cIgnorarItem: 'N', cAssociarExistente: 'S', cAdicionarNovo: 'N', nIdItem: 0, nIdProduto: 0, nIdPedido: n.pcPed, nIdItPedido: n.pcItem,
        nNumPedCompra: null, cNumItPedCompra: null, cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N',
      })),
      ...over,
    }));
    omie.alterar.mockResolvedValue({ cCodStatus: '0' });
    omie.concluir.mockResolvedValue({ cCodStatus: '0' });
    // releitura ao vivo do PC pela confirmacao: o PC voltou a 0 recebido e a etapa 15 (a reversao devolveu o saldo)
    omie.pedido.mockImplementation(async () => ({
      nCodPed: n.pcPed, cNumero: '308', cEtapa: '15', nCodFor: FORN,
      produtos: [{ nCodItem: n.pcItem, cUnidade: 'KG', nQtde: KG_TOTAL, nQtdeRec: 0, nValUnit: 10.6 }],
    }));
  }

  const corpo = (n: { chave: string; pcPed: number; pcItem: number }, pc: EscolhaPc | null = { n_cod_ped: n.pcPed, n_cod_item: n.pcItem, n_cod_item_omie_visto: n.pcItem }) => ({
    nfChaveAcesso: n.chave,
    userId: uid,
    itens: [{ indice: 0, descricaoFornecedor: DESC, produtos: [{ produtoCodigoQ2p: PROD_Q2P, quantidadeKg: KG_TOTAL, localidadeId: locId }], ...(pc ? { pc } : {}) }],
  });

  const ledgers = async (chave: string) => (await q(`SELECT id::text AS id, status, revertido_origem FROM stockbridge.recebimento_fiscal WHERE nf_chave_acesso = $1 ORDER BY iniciado_em`, [chave])).rows;
  const pcs = async (chave: string) => (await q(`SELECT recebimento_fiscal_id::text AS lid, n_sequencia, status FROM stockbridge.recebimento_fiscal_pc WHERE nf_chave_acesso = $1 ORDER BY created_at, n_sequencia`, [chave])).rows;
  const gravacoes = async (chave: string) => ({
    mov: Number((await q(`SELECT count(*)::int AS n FROM stockbridge.movimentacao WHERE nf_chave_acesso = $1`, [chave])).rows[0]!.n),
    apr: Number((await q(`SELECT count(*)::int AS n FROM stockbridge.aprovacao WHERE nf_chave_acesso = $1`, [chave])).rows[0]!.n),
  });

  // A janela: o espelho de recebimentos ja mostra o recebimento desfeito (c_recebido N, depois da conclusao) mas o ledger do Atlas
  // ainda esta 'concluido' — o cron :05/:35 ainda nao o marcou. Abrir o detalhe ja marca a tentativa antiga (melhor esforco): o PC 308
  // (so no cache de PCs vistos, de ANTES da conclusao) deixa de ter o consumo da propria NF descontado e volta dentro da tolerancia,
  // pre-selecionado, sem justificativa. O clique conclui o fiscal de novo. (Sem essa marcacao, quem libera a trava e o adquirirLedger:
  // teste seguinte.)
  it('NF 19252, espelho em N depois da conclusao e ledger ainda concluido: abrir o detalhe marca a tentativa antiga (PC 308 com saldo de novo) e o clique conclui o fiscal de novo e grava o fisico', async (ctx) => {
    if (!pronto) ctx.skip();
    const n = await semear({ concluidoHa: 3 * HORA, receb: { recebido: 'N', alteradoHa: 3 * HORA - 11 * MIN }, header: { alteradoHa: 3 * HORA } });
    omieComoNaReversao(n);

    const d = await svc.getDetalheNfNacional(n.chave);
    expect(d).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true, estoqueLancadoPeloOmie: false, copiaPcsDefasada: false });
    expect(d.fiscalRevertidoEm).not.toBeNull();
    expect(d.itens).toHaveLength(1);
    expect(d.itens[0]!.quantidadeNfKg).toBe(KG_TOTAL);
    expect(d.itens[0]!.pc?.vinculoOmie).toMatchObject({ pcNumero: '308', nCodPed: n.pcPed, nCodItem: n.pcItem, dentroTolerancia: true });
    expect(d.itens[0]!.pc?.preSelecionado).not.toBeNull();
    expect(JSON.stringify(d)).not.toMatch(/erro_omie/);
    expect((await ledgers(n.chave)).map((x) => `${x.status}:${x.revertido_origem}`)).toEqual(['revertido:espelho']);

    // o operador confirma o PC 308 (o vinculo do OMIE), sem justificativa
    const r = await nac.processarRecebimentoNacionalPorNf(corpo(n));

    expect(r.fiscal.status).toBe('concluido');
    expect(r.resumo).toMatchObject({ enviadosParaAprovacao: 1, falhas: 0 });
    expect(r.produtos[0]).toMatchObject({ status: 'aguardando_aprovacao', quantidadeKg: KG_TOTAL });
    // OMIE: vinculo e ajustes ja estavam la (a reversao os preservou) — so o Concluir; a consulta do fiscal e por chave
    expect(omie.consultar).toHaveBeenCalledWith('q2p', { cChaveNfe: n.chave });
    expect(omie.alterar).not.toHaveBeenCalled();
    expect(omie.concluir).toHaveBeenCalledTimes(1);
    expect(omie.concluir).toHaveBeenCalledWith('q2p', { nIdReceb: n.nIdReceb, cEtapa: '60' });
    // ledger: o antigo revertido (pelo espelho), o novo concluido; vinculos idem, 4 linhas de cada lado
    const ls = await ledgers(n.chave);
    expect(ls.map((x) => `${x.status}${x.revertido_origem ? `:${x.revertido_origem}` : ''}`)).toEqual(['revertido:espelho', 'concluido']);
    expect(String(ls[0]!.id)).toBe(n.ledgerId);
    expect((await pcs(n.chave)).map((p) => `${p.lid === n.ledgerId ? 'antigo' : 'novo'}:${p.n_sequencia}:${p.status}`)).toEqual([
      'antigo:1:revertido', 'antigo:2:revertido', 'antigo:3:revertido', 'antigo:4:revertido',
      'novo:1:concluido', 'novo:2:concluido', 'novo:3:concluido', 'novo:4:concluido',
    ]);
    expect(await gravacoes(n.chave)).toEqual({ mov: 1, apr: 1 });

    // depois do clique a nota nao tem mais nada a receber (fisico gravado) — e o sinal desligou: a conclusao nova e a mais recente
    expect(await rev.nfComFiscalRevertido(n.chave, 'q2p')).toBe(false);
  });

  // A mesma janela sem a marcacao da abertura (melhor esforco: falhou ou nao rodou): o ledger chega 'concluido' ao clique e o detalhe
  // ainda desconta o consumo da propria NF (PC 308 sem saldo: pede justificativa). Quem libera a trava e o adquirirLedger — marca a
  // tentativa antiga 'revertido' com os 4 vinculos de PC, na mesma transacao — e a reserva nova grava os vinculos de novo: o indice
  // de item de PC vivo aceita porque os antigos sairam dos status vivos.
  it('sem a marcacao na abertura do detalhe: o adquirirLedger reabre a trava no clique e a reserva nova grava os vinculos de PC de novo', async (ctx) => {
    if (!pronto) ctx.skip();
    const n = await semear({ concluidoHa: 3 * HORA, receb: { recebido: 'N', alteradoHa: 3 * HORA - 11 * MIN }, header: { alteradoHa: 3 * HORA } });
    omieComoNaReversao(n);
    janela.semMarcacaoNaAbertura = true;
    try {
      const d = await svc.getDetalheNfNacional(n.chave);
      expect(d).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true });
      expect(d.itens[0]!.pc?.vinculoOmie).toMatchObject({ pcNumero: '308', dentroTolerancia: false });
      expect((await ledgers(n.chave)).map((x) => x.status)).toEqual(['concluido']);

      const r = await nac.processarRecebimentoNacionalPorNf(corpo(n, { n_cod_ped: n.pcPed, n_cod_item: n.pcItem, n_cod_item_omie_visto: n.pcItem, justificativa: 'Reversão no portal: o PC 308 é o do pedido' }));

      expect(r.fiscal.status).toBe('concluido');
      expect(omie.concluir).toHaveBeenCalledTimes(1);
      const ls = await ledgers(n.chave);
      expect(ls.map((x) => `${x.status}${x.revertido_origem ? `:${x.revertido_origem}` : ''}`)).toEqual(['revertido:espelho', 'concluido']);
      expect(String(ls[0]!.id)).toBe(n.ledgerId);
      expect((await pcs(n.chave)).map((p) => `${p.lid === n.ledgerId ? 'antigo' : 'novo'}:${p.n_sequencia}:${p.status}`)).toEqual([
        'antigo:1:revertido', 'antigo:2:revertido', 'antigo:3:revertido', 'antigo:4:revertido',
        'novo:1:concluido', 'novo:2:concluido', 'novo:3:concluido', 'novo:4:concluido',
      ]);
      expect(await gravacoes(n.chave)).toEqual({ mov: 1, apr: 1 });
    } finally {
      janela.semMarcacaoNaAbertura = false;
    }
  });

  it('NF revertida cujo ledger o cron JA marcou: o detalhe volta ao normal (PC 308 dentro da tolerancia e pre-selecionado, sem justificativa) e o clique conclui o fiscal de novo', async (ctx) => {
    if (!pronto) ctx.skip();
    const n = await semear({ concluidoHa: 3 * HORA, receb: { recebido: 'N', alteradoHa: 3 * HORA - 11 * MIN }, header: { alteradoHa: 3 * HORA } });
    omieComoNaReversao(n);
    const marcadas = await rev.marcarLedgerRevertido({ nfChaveAcesso: n.chave, empresa: 'q2p', origem: 'espelho' }); // o que a varredura do cron faz
    expect(marcadas.map((m) => m.id)).toEqual([n.ledgerId]);

    const d = await svc.getDetalheNfNacional(n.chave);
    expect(d).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true });
    expect(d.itens[0]!.pc?.vinculoOmie).toMatchObject({ pcNumero: '308', dentroTolerancia: true });
    expect(d.itens[0]!.pc?.preSelecionado).not.toBeNull();

    const r = await nac.processarRecebimentoNacionalPorNf(corpo(n)); // sem justificativa
    expect(r.fiscal.status).toBe('concluido');
    expect(omie.concluir).toHaveBeenCalledTimes(1);
    expect((await ledgers(n.chave)).map((x) => x.status)).toEqual(['revertido', 'concluido']);
    expect(await gravacoes(n.chave)).toEqual({ mov: 1, apr: 1 });
  });

  // O espelho ainda nao percebeu (sync de ate ~30 min): ele mostra o recebimento CONCLUIDO, o ledger diz concluido ha 10 min, a fila diz
  // "fiscal ja feito". So a leitura ao vivo do clique descobre a reversao — marca o ledger ANTES do 409 e a nota recarregada volta pendente.
  it('espelho ainda em S (reversao nao sincronizada): o 1o clique le o OMIE, marca o ledger (omie_ao_vivo) e responde 409 sem gravar; a nota volta pendente e o 2o clique conclui o fiscal', async (ctx) => {
    if (!pronto) ctx.skip();
    const n = await semear({ concluidoHa: 10 * MIN, receb: { recebido: 'S', alteradoHa: 10 * MIN }, header: { alteradoHa: 10 * MIN } });
    omieComoNaReversao(n);

    const antes = await svc.getDetalheNfNacional(n.chave);
    expect(antes).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false });

    const err = await nac.processarRecebimentoNacionalPorNf(corpo(n, null)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(rev.RecebimentoFiscalRevertidoError);
    expect((err as Error).message).toMatch(/NF 19\d{3}/);
    // a leitura foi por nIdReceb (o fiscal usa a chave), uma so, sem retry (so confere a reversao: o espelho confirmava a
    // conclusao), e nada foi escrito no OMIE nem no estoque
    expect(omie.consultar).toHaveBeenCalledTimes(1);
    expect(omie.consultar).toHaveBeenCalledWith('q2p', { nIdReceb: n.nIdReceb }, { retries: 0 });
    expect(omie.alterar).not.toHaveBeenCalled();
    expect(omie.concluir).not.toHaveBeenCalled();
    expect(await gravacoes(n.chave)).toEqual({ mov: 0, apr: 0 });
    const m = await q(`SELECT status, revertido_origem, revertido_por::text AS por, revertido_omie_em FROM stockbridge.recebimento_fiscal WHERE id = $1`, [n.ledgerId]);
    expect(m.rows[0]).toMatchObject({ status: 'revertido', revertido_origem: 'omie_ao_vivo', por: uid, revertido_omie_em: null });
    expect((await pcs(n.chave)).every((p) => p.status === 'revertido')).toBe(true);

    // a nota recarregada: fiscal pendente + revertida (o marcador do ledger vale como evidencia), sem o desconto do consumo antigo
    const depois = await svc.getDetalheNfNacional(n.chave);
    expect(depois).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true });
    // so a leitura ao vivo percebeu (o espelho ainda em S): a hora do clique nao e a da reversao, e o banner fica sem hora
    expect(depois.fiscalRevertidoEm).toBeNull();
    expect(depois.itens[0]!.pc?.vinculoOmie).toMatchObject({ pcNumero: '308', dentroTolerancia: true });

    omie.consultar.mockClear();
    const r = await nac.processarRecebimentoNacionalPorNf(corpo(n));
    expect(r.fiscal.status).toBe('concluido');
    expect(omie.consultar).toHaveBeenCalledWith('q2p', { cChaveNfe: n.chave }); // o fiscal consulta por chave
    expect(omie.concluir).toHaveBeenCalledTimes(1);
    expect((await ledgers(n.chave)).map((x) => `${x.status}${x.revertido_origem ? `:${x.revertido_origem}` : ''}`)).toEqual(['revertido:omie_ao_vivo', 'concluido']);
    expect(await gravacoes(n.chave)).toEqual({ mov: 1, apr: 1 });
  });

  it('REGRESSAO: NF "fiscal ja feito" que o Atlas concluiu e NAO foi revertida (OMIE segue concluido sem estoque): uma leitura ao vivo, nada marcado, so o fisico — o fluxo de sempre', async (ctx) => {
    if (!pronto) ctx.skip();
    const n = await semear({ concluidoHa: 10 * MIN, receb: { recebido: 'S', alteradoHa: 10 * MIN }, header: { alteradoHa: 10 * MIN } });
    omieComoNaReversao(n, { cRecebido: 'S', cEtapa: '60' });

    const d = await svc.getDetalheNfNacional(n.chave);
    expect(d).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false });
    const r = await nac.processarRecebimentoNacionalPorNf(corpo(n, null));

    expect(r.fiscal.status).toBe('nao_aplicavel');
    expect(omie.consultar).toHaveBeenCalledTimes(1);
    expect(omie.concluir).not.toHaveBeenCalled();
    expect((await ledgers(n.chave)).map((x) => x.status)).toEqual(['concluido']);
    expect((await pcs(n.chave)).every((p) => p.status === 'concluido')).toBe(true);
    expect(await gravacoes(n.chave)).toEqual({ mov: 1, apr: 1 });
  });

  it('REGRESSAO: conclusao ha menos de 75 s — a leitura ao vivo nao declara reversao (cache do OMIE): nenhuma consulta, so o fisico', async (ctx) => {
    if (!pronto) ctx.skip();
    const n = await semear({ concluidoHa: 20 * 1000, receb: { recebido: 'S', alteradoHa: 20 * 1000 }, header: { alteradoHa: 20 * 1000 } });
    omieComoNaReversao(n); // se fosse lida, "reverteria"
    const r = await nac.processarRecebimentoNacionalPorNf(corpo(n, null));
    expect(r.fiscal.status).toBe('nao_aplicavel');
    expect(omie.consultar).not.toHaveBeenCalled();
    expect((await ledgers(n.chave)).map((x) => x.status)).toEqual(['concluido']);
    expect(await gravacoes(n.chave)).toEqual({ mov: 1, apr: 1 });
  });

  it('dois cliques ao mesmo tempo na janela: o fiscal conclui UMA vez no OMIE e o fisico e gravado UMA vez (o outro clique recebe EmAndamento ou ja_concluido/ja_recebido)', async (ctx) => {
    if (!pronto) ctx.skip();
    const n = await semear({ concluidoHa: 3 * HORA, receb: { recebido: 'N', alteradoHa: 3 * HORA - 11 * MIN }, header: { alteradoHa: 3 * HORA } });
    omieComoNaReversao(n);
    const lenta = omie.consultar.getMockImplementation()!;
    omie.consultar.mockImplementation(async (...a: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 150)); // segura o 1o clique "em andamento" para o 2o bater na trava
      return lenta(...a);
    });
    const c = corpo(n, { n_cod_ped: n.pcPed, n_cod_item: n.pcItem, n_cod_item_omie_visto: n.pcItem, justificativa: 'PC 308 do pedido' });

    const rs = await Promise.allSettled([nac.processarRecebimentoNacionalPorNf(c), nac.processarRecebimentoNacionalPorNf(c)]);

    const ok = rs.filter((x) => x.status === 'fulfilled') as Array<PromiseFulfilledResult<Awaited<ReturnType<typeof nac.processarRecebimentoNacionalPorNf>>>>;
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(ok.filter((x) => x.value.fiscal.status === 'concluido')).toHaveLength(1);
    for (const f of rs.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) {
      expect([fiscalSvc.RecebimentoFiscalEmAndamentoError, nac.NfNacionalJaProcessadaError].some((K) => f.reason instanceof K), String(f.reason)).toBe(true);
    }
    expect(omie.concluir).toHaveBeenCalledTimes(1);
    expect((await ledgers(n.chave)).map((x) => x.status).sort()).toEqual(['concluido', 'revertido']);
    expect((await gravacoes(n.chave)).mov).toBe(1);
  });
});
