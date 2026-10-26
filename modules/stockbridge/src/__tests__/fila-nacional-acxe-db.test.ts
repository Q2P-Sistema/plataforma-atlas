import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — o SQL da fila, do detalhe, da sugestao de PC e do cache de PCs vistos
// EXECUTADO num Postgres real com as DUAS empresas (nada de pool mockado).
//
// So um banco de verdade prova o que os outros testes apenas leem no texto: tipos e colunas dos dois espelhos
// (`NULLIF(i.codigo_local_estoque, 0)::bigint`, o UNION ALL entre as fontes (a) e (b) de cada empresa), o corte
// proprio da ACXE, a exclusao de fornecedor e a via 2 do "ja recebida" casando a EMPRESA da linha (o numero de NF colide
// entre os espelhos), a degradacao quando o espelho da ACXE nao existe (42P01/42703 REAIS do driver), o regex do local
// numerico do cache, o gemeo Q2P por descricao exata, o local do PC resolvido para a localidade do Atlas.
//
// Opt-in, como auditoria-pedido-compra-visto.test.ts: ATLAS_DB_INTEGRATION=1 + DATABASE_URL. Sem isso o describe e PULADO
// (nunca falha por falta de banco, nunca "passa" fingindo). Os testes de banco e os de auditoria criam as mesmas tabelas do
// espelho no schema public: com o opt-in o vitest.config.ts do modulo roda os arquivos um por vez.
//
//   ATLAS_DB_INTEGRATION=1 DATABASE_URL=postgres://... REDIS_URL=redis://localhost:6379 SESSION_SECRET=<32+ chars> \
//     pnpm --filter @atlas/stockbridge exec vitest run src/__tests__/fila-nacional-acxe-db.test.ts
//
// Precisa do schema `stockbridge` com as migrations ate a 0058 (a D21 da 017 pede a 0060: sem ela so o describe dela e pulado) e
// `unaccent`. As tabelas do ESPELHO OMIE (`public.tbl_*`)
// sao do n8n, nao das migrations: cada uma e CRIADA no inicio se faltar (e removida no fim), ou reaproveitada se existir
// VAZIA (as linhas do teste saem no fim). Se alguma ja tiver dados (espelho real), o teste e PULADO — nunca escreve num
// espelho com dados. Chaves de acesso do teste comecam com 99 (UF inexistente) e os ids ficam numa faixa propria.
// Nunca chama o OMIE (o cliente e substituido por um dublê que falha se for usado). A auditoria e append-only: as linhas
// de shared.audit_log geradas ficam.

const DB_URL = process.env.DATABASE_URL;
const temBanco = process.env.ATLAS_DB_INTEGRATION === '1' && typeof DB_URL === 'string' && DB_URL.length > 0;

const cfg = vi.hoisted(() => ({ valores: {} as Record<string, unknown> }));

vi.mock('@atlas/core', async () => {
  const real = await vi.importActual<typeof import('@atlas/core')>('@atlas/core');
  const calado = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
  // pool e demais utilidades reais; so a configuracao da fila e controlada pelo teste (o pool le a dele, do ambiente)
  return { ...real, createLogger: () => calado, getConfig: () => cfg.valores };
});
vi.mock('@atlas/integration-omie', () => ({
  consultarPedidoCompra: () => {
    throw new Error('o OMIE nao pode ser chamado neste teste');
  },
}));

type Linha = Record<string, unknown>;
type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Linha[]; rowCount: number | null }>; end?: () => Promise<void> };
type Emp = 'q2p' | 'acxe';

/** Faixa de ids de teste (bigint): nao colide com ids reais do OMIE (10 digitos) nem entre execucoes. */
const BASE = 7_000_000_000_000 + Math.floor(Math.random() * 900_000_000) * 1000;
const id = (n: number): number => BASE + n;
/** Chave de acesso de 44 digitos que comeca com 99: UF inexistente, nunca colide com NF real. */
const chave = (n: number): string => `99${String(BASE + n).padStart(42, '0')}`;
const FAIXA = { de: BASE, ate: BASE + 999 };

const CORTE_Q2P = '2026-09-11';
const CORTE_ACXE = '2026-10-01';

// Fornecedores e CNPJs de teste
const FORN = { replas: id(1), zaraplast: id(2), solutec: id(3), gga: id(4), tritec: id(5), isoforma: id(6) };
const CNPJ = {
  replas: '99.000.001/0001-01',
  zaraplast: '99.000.002/0001-02',
  solutec: '11.222.333/0001-81',
  gga: '99.000.004/0001-04',
  tritec: '99.000.005/0001-05',
  isoforma: '99.000.006/0001-06',
  intercompanyAcxe: '99.001.001/0001-01', // a ACXE como fornecedor da Q2P: excluida da fila da Q2P
  intercompanyQ2p: '99.001.002/0001-02', // a Q2P como fornecedora da ACXE: excluida da fila da ACXE
  soAcxe: '99.001.003/0001-03', // excluido SO na ACXE: a mesma empresa vende para a Q2P e continua na fila dela
};

// Produtos (codigos do OMIE)
const PROD = { ppAcxe: id(11), ppQ2pInativo: id(12), ppQ2pGemeo: id(13), ppQ2pMaior: id(14), masterAcxe: id(15), masterQ2pInativo: id(16), psAcxe: id(17), psQ2pEspaco: id(18), psQ2pCaixa: id(19), absAcxeInativo: id(20), absQ2p: id(21) };

// Locais do OMIE da ACXE (seeds das migrations: 20.0.7 operacional, 11.1 proprio, 90.0.2 transito virtual)
const LOCAL = { l2007: 4553940398, l111: 4498926337, transito: 4503767789, t1: id(701), t2: id(702), t3: id(703), t4: id(704) };

describe.skipIf(!temBanco)('NF nacional Q2P + ACXE — SQL executado em Postgres real (integração)', () => {
  let pool: Pool;
  let pronto = false;
  let motivoSkip = '';
  const tabelasCriadas: string[] = [];
  const tabelasVazias: string[] = [];
  let usuario = '';
  let criouUsuario = false;
  const idsMovimentacao: string[] = [];
  const idsExclusao: string[] = [];
  const idsDispensa: string[] = [];
  const idsLedger: string[] = [];
  let svc: typeof import('../services/fila-nacional.service.js');
  let pcs: typeof import('../services/pc-sugestao.service.js');
  let visto: typeof import('../services/pc-visto.service.js');
  let gemeo: typeof import('../services/produto-gemeo-q2p.js');
  let core: typeof import('@atlas/core');

  const q = (sql: string, params?: unknown[]) => pool.query(sql, params);

  // ── Esquema minimo dos espelhos (tipos de PROD, lidos de information_schema em 23/10/2026) ──────────────────
  const sufixo = (e: Emp): string => (e === 'acxe' ? 'ACXE' : 'Q2P');
  const tab = (base: string, e: Emp): string => `${base}_${sufixo(e)}`;
  const ddl = (e: Emp): Array<[string, string]> => {
    const S = sufixo(e);
    return [
      [`tbl_nf_header_${S}`, `CREATE TABLE public."tbl_nf_header_${S}" (
         n_id_nf bigint PRIMARY KEY, c_chave_nfe varchar(44), n_nf varchar(20), dest_razao varchar(200), dest_cnpj_cpf varchar(20),
         d_emi date, n_id_receb bigint, cancelada boolean NOT NULL DEFAULT false, deletada boolean NOT NULL DEFAULT false, tp_nf smallint,
         d_alt date, h_alt time)`],
      [`tbl_nf_itens_${S}`, `CREATE TABLE public."tbl_nf_itens_${S}" (
         n_id_nf bigint NOT NULL, n_cod_item bigint NOT NULL, n_cod_prod bigint, c_prod varchar(60), x_prod varchar(200), cfop varchar(10),
         q_com numeric(14,3), u_com varchar(6), v_un_com numeric(14,4), v_prod numeric(14,2), v_tot_item numeric(14,2), codigo_local_estoque bigint,
         PRIMARY KEY (n_id_nf, n_cod_item))`],
      [`tbl_recebimentoNFe_${S}`, `CREATE TABLE public."tbl_recebimentoNFe_${S}" (
         n_id_receb bigint PRIMARY KEY, c_chave_nfe varchar(44) NOT NULL, c_numero_nfe varchar(20), c_serie_nfe varchar(5), c_modelo_nfe varchar(3),
         d_emissao date, n_id_fornecedor bigint, c_cnpj_cpf varchar(20), c_razao_social varchar(255), c_nome varchar(255), c_natureza_operacao varchar(60),
         n_valor_nfe numeric(14,2), c_etapa varchar(2), c_recebido char(1), c_cancelada char(1), c_faturado char(1), c_bloqueado char(1), c_devolvido char(1),
         d_inc date, h_inc varchar(8), d_alt date, h_alt varchar(8), d_rec date, h_rec varchar(8), c_usuario_rec varchar(30),
         synced_at timestamptz NOT NULL DEFAULT now())`],
      [`tbl_recebimentoNFe_itens_${S}`, `CREATE TABLE public."tbl_recebimentoNFe_itens_${S}" (
         n_id_receb bigint NOT NULL REFERENCES public."tbl_recebimentoNFe_${S}"(n_id_receb) ON DELETE CASCADE, n_sequencia integer NOT NULL,
         c_descricao_produto varchar(500), c_codigo_produto varchar(60), c_ncm varchar(10), c_cfop varchar(10), c_cfop_entrada varchar(10),
         n_qtde_nfe numeric(14,4), c_unidade_nfe varchar(10), n_preco_unit numeric(18,6), v_total_item numeric(14,2), v_desconto numeric(14,2),
         c_ignorar_item char(1), c_associar_existente char(1), c_adicionar_novo char(1), n_id_item bigint, n_id_produto bigint,
         c_nao_gerar_mov_estoque char(1), c_nao_gerar_financeiro char(1), n_qtde_recebida numeric(14,4), codigo_local_estoque bigint,
         synced_at timestamptz NOT NULL DEFAULT now(), n_id_pedido bigint, n_id_it_pedido bigint, n_num_ped_compra varchar(15), c_num_it_ped_compra integer,
         PRIMARY KEY (n_id_receb, n_sequencia))`],
      [`tbl_produtos_${S}`, `CREATE TABLE public."tbl_produtos_${S}" (codigo_produto bigint, codigo varchar(50), descricao text, inativo char(1), unidade varchar(10))`],
      [`tbl_pedidosCompras_${S}`, `CREATE TABLE public."tbl_pedidosCompras_${S}" (
         ncoditem bigint NOT NULL, ncodped bigint, cetapa varchar(20), cnumero varchar(50), ddtprevisao date, ncodfor bigint, cdescricao text, cproduto varchar(50),
         cunidade varchar(10), codigo_local_estoque varchar(50), ncodprod bigint, nqtde numeric(15,2), nqtderec numeric(15,2), nvaltot numeric(15,2),
         nvalunit numeric(15,2), data_atualizacao timestamptz)`],
      [`tbl_cadastroFornecedoresClientes_${S}`, `CREATE TABLE public."tbl_cadastroFornecedoresClientes_${S}" (
         codigo_cliente_omie bigint NOT NULL, cnpj_cpf text NOT NULL, razao_social text NOT NULL, nome_fantasia text, inativo char(1))`],
    ];
  };

  /** Colunas que o teste le/escreve em cada tabela do espelho: uma tabela que ja exista (vazia) sem elas nao serve (outro teste a criou?). */
  const COLUNAS: Record<string, string[]> = {
    tbl_nf_header: ['n_id_nf', 'c_chave_nfe', 'n_nf', 'dest_razao', 'dest_cnpj_cpf', 'd_emi', 'n_id_receb', 'cancelada', 'deletada', 'tp_nf', 'd_alt', 'h_alt'],
    tbl_nf_itens: ['n_id_nf', 'n_cod_item', 'n_cod_prod', 'x_prod', 'cfop', 'q_com', 'u_com', 'v_un_com', 'v_prod', 'v_tot_item', 'codigo_local_estoque'],
    tbl_recebimentoNFe: ['n_id_receb', 'c_chave_nfe', 'c_numero_nfe', 'd_emissao', 'n_id_fornecedor', 'c_cnpj_cpf', 'c_razao_social', 'c_etapa', 'c_recebido', 'c_cancelada', 'c_bloqueado', 'c_devolvido', 'd_alt', 'h_alt', 'd_rec', 'h_rec', 'synced_at'],
    tbl_recebimentoNFe_itens: ['n_id_receb', 'n_sequencia', 'c_descricao_produto', 'c_cfop_entrada', 'n_qtde_nfe', 'c_unidade_nfe', 'n_preco_unit', 'v_total_item', 'n_id_item', 'n_id_produto', 'codigo_local_estoque', 'n_id_pedido', 'n_id_it_pedido', 'c_ignorar_item', 'c_associar_existente', 'c_nao_gerar_mov_estoque', 'synced_at'],
    tbl_produtos: ['codigo_produto', 'descricao', 'inativo', 'unidade'],
    tbl_pedidosCompras: ['ncoditem', 'ncodped', 'cetapa', 'cnumero', 'ddtprevisao', 'ncodfor', 'cdescricao', 'cproduto', 'cunidade', 'codigo_local_estoque', 'ncodprod', 'nqtde', 'nqtderec', 'nvaltot', 'nvalunit', 'data_atualizacao'],
    tbl_cadastroFornecedoresClientes: ['codigo_cliente_omie', 'cnpj_cpf', 'razao_social'],
  };

  // ── Semeadura ────────────────────────────────────────────────────────────────────────────────────────────────
  interface ItemNf { nCodItem: number; xProd: string; cfop: string; qCom: number; uCom: string; vProd: number; vUnCom: number; nCodProd?: number | null; local?: number | null }
  async function nf(
    e: Emp,
    o: { nIdNf: number; chave: string; numero: string; razao: string; cnpj: string; dEmi: string; nIdReceb?: number | null; cancelada?: boolean; deletada?: boolean; dAlt?: string | null; hAlt?: string | null; itens: ItemNf[] },
  ): Promise<void> {
    // dAlt/hAlt: quando a nota de entrada foi alterada no OMIE (a D21 compara com a conclusao do fiscal); NULL como o espelho antigo
    await q(
      `INSERT INTO public."${tab('tbl_nf_header', e)}" (n_id_nf, c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, n_id_receb, tp_nf, cancelada, deletada, d_alt, h_alt) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11)`,
      [o.nIdNf, o.chave, o.numero, o.razao, o.cnpj, o.dEmi, o.nIdReceb ?? null, o.cancelada ?? false, o.deletada ?? false, o.dAlt ?? null, o.hAlt ?? null],
    );
    for (const i of o.itens) {
      await q(
        `INSERT INTO public."${tab('tbl_nf_itens', e)}" (n_id_nf, n_cod_item, n_cod_prod, x_prod, cfop, q_com, u_com, v_un_com, v_prod, v_tot_item, codigo_local_estoque)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)`,
        [o.nIdNf, i.nCodItem, i.nCodProd ?? null, i.xProd, i.cfop, i.qCom, i.uCom, i.vUnCom, i.vProd, i.local ?? null],
      );
    }
  }
  interface ItemRec {
    seq: number; descricao: string; cfopEntrada: string; qtde: number; un: string; preco: number; total: number;
    nIdItem?: number | null; nIdProduto?: number | null; local?: number | null; nIdPedido?: number | null; nIdItPedido?: number | null;
    ignorar?: string; naoGerarMov?: string;
  }
  async function receb(
    e: Emp,
    o: { nIdReceb: number; chave: string; numero: string; dEmissao: string; fornecedor: number; cnpj: string; razao: string; recebido?: string; etapa?: string; dAlt?: string | null; hAlt?: string | null; dRec?: string | null; hRec?: string | null; itens: ItemRec[] },
  ): Promise<void> {
    // dAlt/hAlt: quando o recebimento foi alterado no OMIE ('HH:MI:SS' em varchar, como no espelho); a D21 le a hora do 'N' e do 'S'.
    // dRec/hRec: quando foi concluido (concluir no portal nao mexe em d_alt — NF 67988); a D21 conta o 'S' tambem por ela
    await q(
      `INSERT INTO public."${tab('tbl_recebimentoNFe', e)}" (n_id_receb, c_chave_nfe, c_numero_nfe, d_emissao, n_id_fornecedor, c_cnpj_cpf, c_razao_social, c_etapa, c_recebido, c_cancelada, c_bloqueado, c_devolvido, d_alt, h_alt, d_rec, h_rec)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'N','N','N',$10,$11,$12,$13)`,
      [o.nIdReceb, o.chave, o.numero, o.dEmissao, o.fornecedor, o.cnpj, o.razao, o.etapa ?? '40', o.recebido ?? 'N', o.dAlt ?? null, o.hAlt ?? null, o.dRec ?? null, o.hRec ?? null],
    );
    for (const i of o.itens) {
      await q(
        `INSERT INTO public."${tab('tbl_recebimentoNFe_itens', e)}"
           (n_id_receb, n_sequencia, c_descricao_produto, c_cfop_entrada, n_qtde_nfe, c_unidade_nfe, n_preco_unit, v_total_item, n_id_item, n_id_produto, codigo_local_estoque,
            n_id_pedido, n_id_it_pedido, c_ignorar_item, c_associar_existente, c_nao_gerar_mov_estoque)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'N',$15)`,
        [o.nIdReceb, i.seq, i.descricao, i.cfopEntrada, i.qtde, i.un, i.preco, i.total, i.nIdItem ?? 0, i.nIdProduto ?? null, i.local ?? null, i.nIdPedido ?? null, i.nIdItPedido ?? null, i.ignorar ?? 'N', i.naoGerarMov ?? 'N'],
      );
    }
  }
  async function pc(e: Emp, o: { ncodped: number; ncoditem: number; numero: string; fornecedor: number; qtde: number; preco: number; produto: number | null; local: string | null; descricao: string; etapa?: string }): Promise<void> {
    await q(
      `INSERT INTO public."${tab('tbl_pedidosCompras', e)}" (ncodped, ncoditem, cnumero, cetapa, ncodfor, nqtde, nqtderec, nvalunit, nvaltot, cunidade, ddtprevisao, cdescricao, cproduto, ncodprod, codigo_local_estoque, data_atualizacao)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,'KG','2026-11-05',$9,'X',$10,$11, now())`,
      [o.ncodped, o.ncoditem, o.numero, o.etapa ?? '15', o.fornecedor, o.qtde, o.preco, o.qtde * o.preco, o.descricao, o.produto, o.local],
    );
  }
  const cadastro = (e: Emp, codigo: number, cnpj: string, razao: string) =>
    q(`INSERT INTO public."${tab('tbl_cadastroFornecedoresClientes', e)}" (codigo_cliente_omie, cnpj_cpf, razao_social) VALUES ($1,$2,$3)`, [codigo, cnpj, razao]);
  // unidade 'KG': o recebimento so aceita produto em kg (revisao da Fase 2)
  const produto = (e: Emp, codigo: number, descricao: string, inativo: string | null = null, unidade = 'KG') =>
    q(`INSERT INTO public."${tab('tbl_produtos', e)}" (codigo_produto, descricao, inativo, unidade) VALUES ($1,$2,$3,$4)`, [codigo, descricao, inativo, unidade]);
  const movimentoManual = async (e: Emp, numero: string, criadoEm: string): Promise<void> => {
    const r = await q(
      `INSERT INTO stockbridge.movimentacao (nota_fiscal, tipo_movimento, subtipo, quantidade_kg, empresa, galpao, produto_codigo_acxe, produto_codigo_q2p, status_omie, ativo, created_at)
       VALUES ($1, 'entrada_manual', 'compra_nacional', 1000, $2, '11.2', $3, $4, 'concluida', true, $5) RETURNING id`,
      [numero, e, e === 'acxe' ? id(99) : null, e === 'q2p' ? id(98) : null, criadoEm],
    );
    idsMovimentacao.push(String(r.rows[0]!.id));
  };

  // ── Cenario ──────────────────────────────────────────────────────────────────────────────────────────────────
  // Q = Q2P, A = ACXE. Os casos e o que cada um prova:
  //  Q5   Q2P pendente emitida 20/09 (apos o corte da Q2P, antes do da ACXE)        -> na fila (o corte da Q2P e o dela)
  //  Q2   Q2P pendente NF 5832 (mesmo numero que a A-5832)                           -> na fila
  //  A2   ACXE pendente NF 5832, com lancamento manual da ACXE                       -> FORA (via 2 casa a empresa)
  //  Q1   Q2P pendente NF 6842, com lancamento manual da Q2P                         -> FORA
  //  A1   ACXE pendente NF 6842 (mesmo numero que a Q1)                              -> na fila (a via 2 da Q2P nao a alcanca)
  //  Q8201 / A8200  mesmo CNPJ, excluido SO na ACXE                                  -> Q na fila; A fora
  //  Q3   Q2P com fiscal ja feito (espelho de NF)                                    -> na fila, fiscal concluido
  //  A3   ACXE pendente NF 937 com PC 580 (local 20.0.7) e o item no local 11.1      -> na fila; PC sugerido; local do PC
  //  A4   ACXE com fiscal feito no portal COM estoque                                -> na fila, estoqueLancadoPeloOmie
  //  A9   ACXE com fiscal feito e PC vinculado sem movimentar estoque                -> na fila; PC vinculado no OMIE
  //  A7   ACXE pendente NF 938 cujo PC 582 so existe no cache de PCs vistos          -> candidato com local e produto do cache
  //  A10  ACXE recebida pelo caminho novo, com a DESCRICAO do item trocada depois do fiscal -> FORA (identidade pela sequencia)
  //  A11  ACXE recebida so em parte (3.000 de 6.128 kg), mesma troca de descricao           -> na fila, restante 3.128 kg
  //  A12  ACXE com o fiscal concluido PELO ATLAS (ledger) e o espelho ainda atrasado       -> na fila, fiscal concluido
  //  A13 / A14  ACXE cancelada / excluida no OMIE                                          -> FORA; o detalhe recusa
  //  A5 / Q4  intercompany (Q2P fornece a ACXE / ACXE fornece a Q2P)                 -> FORA das duas filas
  //  A6   ACXE pendente emitida 20/09 (antes do corte da ACXE)                       -> FORA (corte proprio)
  //  A8   ACXE pendente dispensada                                                   -> FORA
  //  Q6   Q2P recebida pelo Atlas (13.382 kg da NF), depois o fiscal editou a quantidade RECEBIDA para 13.500 no portal: a
  //       nota de entrada passou a 13.500 e o XML segue 13.382 (NF 67988, 23/10/2026)                      -> FORA
  //  Q7   a mesma situacao SEM o recebimento no espelho (sem o XML): vale a nota de entrada, como antes   -> na fila, restante 118 kg
  //  Q8   gravacao parcial (600 de 1.375 kg) com o XML em toneladas rotulado KG (1,375): o XML fica fora da faixa
  //       comparavel e vale a nota de entrada                                                             -> na fila, restante 775 kg
  //  Q9   nota de entrada editada para mais (13.500) ANTES do fisico, XML 13.382; gravacao parcial ancorada na nota de
  //       entrada (13.400 de 13.500): o XML menor nao pode esconder os 100 kg (revisao de 23/10/2026)  -> na fila, restante 100 kg
  //  Q10  nota de entrada editada para MENOS (13.382) que o XML (13.500), item 1:N recebido em duas levas com bases diferentes:
  //       8.070,543 na 1a (ancorada no XML) + 5.311,457 na retomada, que reparte o restante da fila (2a revisao) -> FORA
  const C = {
    q5: chave(5), q2: chave(6), a2: chave(7), q1: chave(8), a1: chave(9), q8201: chave(10), a8200: chave(11), q3: chave(12), a3: chave(13), a4: chave(14),
    a9: chave(15), a7: chave(16), a5: chave(17), q4: chave(18), a6: chave(19), a8: chave(20), a10: chave(21), a11: chave(22), a12: chave(23), a13: chave(24), a14: chave(25),
    q6: chave(26), q7: chave(27), q8: chave(28), q9: chave(29), q10: chave(30),
  };
  // O que a consulta SO da Q2P (ACXE desligada ou ?empresa=q2p) devolve: a Q8201 esta la, porque a exclusao feita so para a
  // ACXE nao vale na Q2P (defeito achado por este teste e corrigido com `fe.empresa = 'q2p'` na consulta so da Q2P).
  const ESPERADA_Q2P = [C.q5, C.q2, C.q8201, C.q3, C.q7, C.q8, C.q9];
  const ESPERADA_ACXE = [C.a1, C.a3, C.a4, C.a9, C.a7, C.a11, C.a12];
  const ESPERADA_AMBAS = [C.q5, C.q2, C.a1, C.q8201, C.q3, C.a3, C.a4, C.a9, C.a7, C.a11, C.a12, C.q7, C.q8, C.q9]; // por emissao, numero, empresa

  async function semear(): Promise<void> {
    await cadastro('q2p', FORN.replas, CNPJ.replas, 'REPLAS COMERCIAL LTDA');
    await cadastro('q2p', FORN.zaraplast, CNPJ.zaraplast, 'ZARAPLAST SA');
    await cadastro('acxe', FORN.solutec, CNPJ.solutec, 'SOLUTEC PLASTICOS LTDA');
    await cadastro('acxe', FORN.gga, CNPJ.gga, 'GGA RECICLAGEM LTDA');
    await cadastro('acxe', FORN.tritec, CNPJ.tritec, 'TRITEC LTDA');

    // produtos: o gemeo Q2P por descricao exata (ativo, menor codigo); ACXE com e sem gemeo; ACXE inativo
    await produto('acxe', PROD.ppAcxe, 'PP PRETO Q35');
    await produto('q2p', PROD.ppQ2pInativo, 'PP PRETO Q35', 'S'); // menor codigo, mas INATIVO: nao conta
    await produto('q2p', PROD.ppQ2pGemeo, 'PP PRETO Q35'); // o gemeo
    await produto('q2p', PROD.ppQ2pMaior, 'PP PRETO Q35'); // codigo maior: nao ganha
    await produto('acxe', PROD.masterAcxe, 'MASTER PRETO');
    await produto('q2p', PROD.masterQ2pInativo, 'MASTER PRETO', 'S'); // so existe inativo: sem gemeo
    await produto('acxe', PROD.psAcxe, 'PS POLIESTIRENO BRANCO');
    await produto('q2p', PROD.psQ2pEspaco, 'PS POLIESTIRENO BRANCO '); // espaco no fim: descricao nao e identica
    await produto('q2p', PROD.psQ2pCaixa, 'ps poliestireno branco'); // caixa diferente: nao e identica
    await produto('acxe', PROD.absAcxeInativo, 'ABS PRETO GP22', 'S'); // inativo na ACXE
    await produto('q2p', PROD.absQ2p, 'ABS PRETO GP22');

    // pedidos de compra: PC 580 (ACXE, local 20.0.7), um PC qualquer na Q2P (a copia da Q2P precisa estar em dia)
    await pc('acxe', { ncodped: id(40), ncoditem: id(41), numero: '580', fornecedor: FORN.solutec, qtde: 26000, preco: 4.8, produto: PROD.ppAcxe, local: String(LOCAL.l2007), descricao: 'PP PRETO Q35' });
    await pc('q2p', { ncodped: id(42), ncoditem: id(43), numero: '304', fornecedor: FORN.zaraplast, qtde: 13750, preco: 10.8, produto: id(60), local: '8115873874', descricao: 'MC PEAD ES' });

    // Q2P
    await receb('q2p', { nIdReceb: id(101), chave: C.q5, numero: '000009100', dEmissao: '2026-09-20', fornecedor: FORN.replas, cnpj: CNPJ.replas, razao: 'REPLAS COMERCIAL LTDA',
      itens: [{ seq: 1, descricao: 'SUCATA PLASTICO', cfopEntrada: '1.102', qtde: 18000, un: 'KG', preco: 11.3, total: 203400 }] });
    await receb('q2p', { nIdReceb: id(102), chave: C.q2, numero: '000005832', dEmissao: '2026-10-03', fornecedor: FORN.zaraplast, cnpj: CNPJ.zaraplast, razao: 'ZARAPLAST SA',
      itens: [{ seq: 1, descricao: 'MC PEAD ES', cfopEntrada: '1.102', qtde: 13750, un: 'KG', preco: 10.8, total: 148500, local: 8115873874 }] });
    await receb('q2p', { nIdReceb: id(103), chave: C.q1, numero: '000006842', dEmissao: '2026-10-05', fornecedor: FORN.replas, cnpj: CNPJ.replas, razao: 'REPLAS COMERCIAL LTDA',
      itens: [{ seq: 1, descricao: 'SUCATA PLASTICO', cfopEntrada: '1.102', qtde: 18000, un: 'KG', preco: 11.3, total: 203400 }] });
    await nf('q2p', { nIdNf: id(111), chave: C.q8201, numero: '000008201', razao: 'FORNECEDOR SO EXCLUIDO NA ACXE', cnpj: CNPJ.soAcxe, dEmi: '2026-10-07',
      itens: [{ nCodItem: 1, xProd: 'SUCATA PE', cfop: '1.102', qCom: 9000, uCom: 'KG', vProd: 45000, vUnCom: 5 }] });
    await nf('q2p', { nIdNf: id(112), chave: C.q3, numero: '000007000', razao: 'ZARAPLAST SA', cnpj: CNPJ.zaraplast, dEmi: '2026-10-08',
      itens: [{ nCodItem: 1, xProd: 'MC PEAD ES', cfop: '1.102', qCom: 13750, uCom: 'KG', vProd: 148500, vUnCom: 10.8 }] });
    await nf('q2p', { nIdNf: id(113), chave: C.q4, numero: '000008100', razao: 'ACXE (INTERCOMPANY)', cnpj: CNPJ.intercompanyAcxe, dEmi: '2026-10-09',
      itens: [{ nCodItem: 1, xProd: 'PP PRETO Q35', cfop: '1.102', qCom: 5000, uCom: 'KG', vProd: 25000, vUnCom: 5 }] });

    // ACXE
    await receb('acxe', { nIdReceb: id(201), chave: C.a2, numero: '000005832', dEmissao: '2026-10-04', fornecedor: FORN.gga, cnpj: CNPJ.gga, razao: 'GGA RECICLAGEM LTDA',
      itens: [{ seq: 1, descricao: 'SUCATA DE PLASTICO', cfopEntrada: '1.101', qtde: 8000, un: 'KG', preco: 2.5, total: 20000 }] });
    await receb('acxe', { nIdReceb: id(202), chave: C.a1, numero: '000006842', dEmissao: '2026-10-06', fornecedor: FORN.gga, cnpj: CNPJ.gga, razao: 'GGA RECICLAGEM LTDA',
      itens: [{ seq: 1, descricao: 'SUCATA DE PLASTICO', cfopEntrada: '1.101', qtde: 12000, un: 'KG', preco: 2.5, total: 30000 }] });
    await nf('acxe', { nIdNf: id(211), chave: C.a8200, numero: '000008200', razao: 'FORNECEDOR SO EXCLUIDO NA ACXE', cnpj: CNPJ.soAcxe, dEmi: '2026-10-07',
      itens: [{ nCodItem: 1, xProd: 'SUCATA PE', cfop: '1.101', qCom: 9000, uCom: 'KG', vProd: 45000, vUnCom: 5 }] });
    // A3: o item no recebimento esta no local 11.1 (padrao do cadastro do produto); o PC 580 aponta para o 20.0.7 e e ele que vale
    await receb('acxe', { nIdReceb: id(203), chave: C.a3, numero: '000000937', dEmissao: '2026-10-10', fornecedor: FORN.solutec, cnpj: CNPJ.solutec, razao: 'SOLUTEC PLASTICOS LTDA',
      itens: [{ seq: 1, descricao: 'PP PRETO Q35', cfopEntrada: '1.101', qtde: 26000, un: 'KG', preco: 4.8, total: 124800, nIdProduto: PROD.ppAcxe, local: LOCAL.l111 }] });
    // A4: fiscal concluido no portal COM movimento de estoque
    await nf('acxe', { nIdNf: id(212), chave: C.a4, numero: '000001234', razao: 'GGA RECICLAGEM LTDA', cnpj: CNPJ.gga, dEmi: '2026-10-12', nIdReceb: id(204),
      itens: [{ nCodItem: 77, xProd: 'ABS PRETO GP22', cfop: '1.101', qCom: 5000, uCom: 'KG', vProd: 40000, vUnCom: 8, nCodProd: PROD.absAcxeInativo }] });
    await receb('acxe', { nIdReceb: id(204), chave: C.a4, numero: '000001234', dEmissao: '2026-10-12', fornecedor: FORN.gga, cnpj: CNPJ.gga, razao: 'GGA RECICLAGEM LTDA', recebido: 'S', etapa: '60',
      itens: [{ seq: 1, descricao: 'ABS PRETO GP22', cfopEntrada: '1.101', qtde: 5000, un: 'KG', preco: 8, total: 40000, nIdItem: 77, ignorar: 'N', naoGerarMov: 'N' }] });
    // A9: fiscal concluido, item vinculado ao PC 580 SEM movimentar estoque
    await nf('acxe', { nIdNf: id(213), chave: C.a9, numero: '000009009', razao: 'SOLUTEC PLASTICOS LTDA', cnpj: CNPJ.solutec, dEmi: '2026-10-14', nIdReceb: id(205),
      itens: [{ nCodItem: 5, xProd: 'PP PRETO Q35', cfop: '1.101', qCom: 26000, uCom: 'KG', vProd: 124800, vUnCom: 4.8, nCodProd: PROD.ppAcxe }] });
    await receb('acxe', { nIdReceb: id(205), chave: C.a9, numero: '000009009', dEmissao: '2026-10-14', fornecedor: FORN.solutec, cnpj: CNPJ.solutec, razao: 'SOLUTEC PLASTICOS LTDA', recebido: 'S', etapa: '60',
      itens: [{ seq: 1, descricao: 'PP PRETO Q35', cfopEntrada: '1.101', qtde: 26000, un: 'KG', preco: 4.8, total: 124800, nIdItem: 5, nIdPedido: id(40), nIdItPedido: id(41), ignorar: 'N', naoGerarMov: 'S' }] });
    // A7: PC 582 so no cache de PCs vistos (o OMIE o tirou da lista de pendentes)
    await receb('acxe', { nIdReceb: id(206), chave: C.a7, numero: '000000938', dEmissao: '2026-10-15', fornecedor: FORN.tritec, cnpj: CNPJ.tritec, razao: 'TRITEC LTDA',
      itens: [{ seq: 1, descricao: 'MASTER PRETO', cfopEntrada: '1.101', qtde: 10000, un: 'KG', preco: 6, total: 60000, nIdProduto: PROD.masterAcxe }] });
    await q(
      `INSERT INTO stockbridge.pedido_compra_visto (empresa, n_cod_ped, n_cod_item, pc_numero, n_cod_for, produto_descricao, unidade, qtde, qtde_rec, preco_unit, etapa, valor_total_pc, n_cod_prod, codigo_local_estoque)
       VALUES ('acxe', $1, $2, '582', $3, 'MASTER PRETO', 'KG', 10000, 0, 6, '15', 60000, $4, $5)`,
      [id(90), id(91), FORN.tritec, PROD.masterAcxe, LOCAL.l2007],
    );
    await nf('acxe', { nIdNf: id(214), chave: C.a5, numero: '000008000', razao: 'Q2P (INTERCOMPANY)', cnpj: CNPJ.intercompanyQ2p, dEmi: '2026-10-11',
      itens: [{ nCodItem: 1, xProd: 'PP PRETO Q35', cfop: '1.101', qCom: 5000, uCom: 'KG', vProd: 25000, vUnCom: 5 }] });
    await receb('acxe', { nIdReceb: id(207), chave: C.a6, numero: '000001111', dEmissao: '2026-09-20', fornecedor: FORN.gga, cnpj: CNPJ.gga, razao: 'GGA RECICLAGEM LTDA',
      itens: [{ seq: 1, descricao: 'SUCATA DE PLASTICO', cfopEntrada: '1.101', qtde: 7000, un: 'KG', preco: 2.5, total: 17500 }] });
    await receb('acxe', { nIdReceb: id(208), chave: C.a8, numero: '000000940', dEmissao: '2026-10-16', fornecedor: FORN.gga, cnpj: CNPJ.gga, razao: 'GGA RECICLAGEM LTDA',
      itens: [{ seq: 1, descricao: 'SUCATA DE PLASTICO', cfopEntrada: '1.101', qtde: 6000, un: 'KG', preco: 2.5, total: 15000 }] });

    // A10 / A11: depois do fiscal o espelho traz a descricao do XML ('... - POS CONSUMO'), a movimentacao guardou a do item no
    // recebimento ('SUCATA DE PP') e a sequencia do item: so a sequencia liga as duas (ACXEGDP-412, quase todo item da ACXE vem pre-associado)
    for (const [k, nIdNf, nIdReceb, numero, dEmi, kgAtribuido] of [
      ['a10', id(215), id(209), '000001000', '2026-10-16', 6128],
      ['a11', id(216), id(210), '000001700', '2026-10-17', 3000],
    ] as const) {
      await nf('acxe', { nIdNf, chave: C[k], numero, razao: 'GGA RECICLAGEM LTDA', cnpj: CNPJ.gga, dEmi, nIdReceb,
        itens: [{ nCodItem: 3, xProd: 'SUCATA DE PLASTICO - POS CONSUMO', cfop: '1.101', qCom: 6128, uCom: 'KG', vProd: 49024, vUnCom: 8 }] });
      await receb('acxe', { nIdReceb, chave: C[k], numero, dEmissao: dEmi, fornecedor: FORN.gga, cnpj: CNPJ.gga, razao: 'GGA RECICLAGEM LTDA', recebido: 'S', etapa: '60',
        itens: [{ seq: 1, descricao: 'SUCATA DE PP', cfopEntrada: '1.101', qtde: 6128, un: 'KG', preco: 8, total: 49024, nIdItem: 3, naoGerarMov: 'S' }] });
      const m = await q(
        `INSERT INTO stockbridge.movimentacao (nota_fiscal, tipo_movimento, subtipo, quantidade_kg, empresa, galpao, produto_codigo_acxe, status_omie, ativo,
            nf_chave_acesso, nf_item_descricao, nf_item_descricao_normalizada, nf_item_sequencias, quantidade_nf_kg)
         VALUES ($1, 'entrada_manual', 'compra_nacional', $2, 'acxe', '20.0.7', $3, 'pendente_q2p', true, $4, 'SUCATA DE PP', 'SUCATA DE PP', ARRAY[1], $5) RETURNING id`,
        [numero.replace(/^0+/, ''), kgAtribuido - 50, PROD.ppAcxe, C[k], kgAtribuido],
      );
      idsMovimentacao.push(String(m.rows[0]!.id));
    }
    // A13 / A14: NF invalida no OMIE (cancelada / excluida): o espelho de NF da ACXE tem as duas colunas
    await nf('acxe', { nIdNf: id(217), chave: C.a13, numero: '000001300', razao: 'GGA RECICLAGEM LTDA', cnpj: CNPJ.gga, dEmi: '2026-10-19', cancelada: true,
      itens: [{ nCodItem: 1, xProd: 'SUCATA DE PLASTICO', cfop: '1.101', qCom: 3000, uCom: 'KG', vProd: 7500, vUnCom: 2.5 }] });
    await nf('acxe', { nIdNf: id(218), chave: C.a14, numero: '000001400', razao: 'GGA RECICLAGEM LTDA', cnpj: CNPJ.gga, dEmi: '2026-10-19', deletada: true,
      itens: [{ nCodItem: 1, xProd: 'SUCATA DE PLASTICO', cfop: '1.101', qCom: 3000, uCom: 'KG', vProd: 7500, vUnCom: 2.5 }] });
    // A12: fiscal concluido pelo Atlas; o espelho de recebimentos ainda mostra a NF como pendente (janela entre syncs)
    await receb('acxe', { nIdReceb: id(211), chave: C.a12, numero: '000001212', dEmissao: '2026-10-18', fornecedor: FORN.gga, cnpj: CNPJ.gga, razao: 'GGA RECICLAGEM LTDA',
      itens: [{ seq: 1, descricao: 'SUCATA DE PLASTICO', cfopEntrada: '1.101', qtde: 4000, un: 'KG', preco: 2.5, total: 10000 }] });
    const lf = await q(
      `INSERT INTO stockbridge.recebimento_fiscal (nf_chave_acesso, nota_fiscal, status, confirmado_por, empresa, finalizado_em, itens_total)
       VALUES ($1, '1212', 'concluido', $2, 'acxe', '2026-10-18T15:00:00Z', 1) RETURNING id`,
      [C.a12, usuario],
    );
    idsLedger.push(String(lf.rows[0]!.id));

    // Q6 / Q7: NF 67988 (23/10/2026). O Atlas recebeu 13.500 kg conferidos de uma NF de 13.382 kg; depois o fiscal editou a
    // quantidade RECEBIDA para 13.500 no portal e o OMIE refez a nota de entrada com 13.500. A movimentacao guardou a
    // descricao do item no recebimento ('PS AI A') e a sequencia; os espelhos trazem a do produto ('PS CRISTAL B').
    await cadastro('q2p', FORN.isoforma, CNPJ.isoforma, 'ISOFORMA PLASTICOS LTDA');
    for (const [k, nIdNf, nCodItem, numero, dEmi, comRecebimento, descricaoMov] of [
      ['q6', id(114), id(120), '000067988', '2026-10-22', true, 'PS AI A'],
      ['q7', id(115), id(121), '000067989', '2026-10-23', false, 'PS CRISTAL B'],
    ] as const) {
      await nf('q2p', { nIdNf, chave: C[k], numero, razao: 'ISOFORMA PLASTICOS LTDA', cnpj: CNPJ.isoforma, dEmi, nIdReceb: comRecebimento ? id(104) : null,
        itens: [{ nCodItem, xProd: 'PS CRISTAL B', cfop: '1.102', qCom: 13500, uCom: 'KG', vProd: 152554.8, vUnCom: 11.3004 }] });
      if (comRecebimento) {
        await receb('q2p', { nIdReceb: id(104), chave: C[k], numero, dEmissao: dEmi, fornecedor: FORN.isoforma, cnpj: CNPJ.isoforma, razao: 'ISOFORMA PLASTICOS LTDA', recebido: 'S', etapa: '60',
          itens: [{ seq: 1, descricao: 'PS CRISTAL B', cfopEntrada: '1.102', qtde: 13382, un: 'KG', preco: 11.4, total: 152554.8, nIdItem: nCodItem, naoGerarMov: 'S' }] });
      }
      const m = await q(
        `INSERT INTO stockbridge.movimentacao (nota_fiscal, tipo_movimento, subtipo, quantidade_kg, empresa, galpao, produto_codigo_q2p, status_omie, ativo,
            nf_chave_acesso, nf_item_descricao, nf_item_descricao_normalizada, nf_item_sequencias, quantidade_nf_kg)
         VALUES ($1, 'entrada_manual', 'compra_nacional', 13500, 'q2p', '11.2', $2, 'concluida', true, $3, $4, $4, ARRAY[1], 13382) RETURNING id`,
        [numero.replace(/^0+/, ''), id(98), C[k], descricaoMov],
      );
      idsMovimentacao.push(String(m.rows[0]!.id));
    }

    // Q8: CATA-like — o XML veio em toneladas rotulado KG (1,375) e o fiscal lancou 1.375 kg na nota de entrada; o
    // Atlas gravou so um dos produtos do item (600 kg da NF): a gravacao parcial precisa continuar visivel
    await nf('q2p', { nIdNf: id(116), chave: C.q8, numero: '000067995', razao: 'ISOFORMA PLASTICOS LTDA', cnpj: CNPJ.isoforma, dEmi: '2026-10-23', nIdReceb: id(105),
      itens: [{ nCodItem: id(122), xProd: 'PP COPO 40', cfop: '1.102', qCom: 1375, uCom: 'KG', vProd: 9625, vUnCom: 7 }] });
    await receb('q2p', { nIdReceb: id(105), chave: C.q8, numero: '000067995', dEmissao: '2026-10-23', fornecedor: FORN.isoforma, cnpj: CNPJ.isoforma, razao: 'ISOFORMA PLASTICOS LTDA', recebido: 'S', etapa: '60',
      itens: [{ seq: 1, descricao: 'PP COPO 40', cfopEntrada: '1.102', qtde: 1.375, un: 'KG', preco: 7000, total: 9625, nIdItem: id(122), naoGerarMov: 'S' }] });
    const m8 = await q(
      `INSERT INTO stockbridge.movimentacao (nota_fiscal, tipo_movimento, subtipo, quantidade_kg, empresa, galpao, produto_codigo_q2p, status_omie, ativo,
          nf_chave_acesso, nf_item_descricao, nf_item_descricao_normalizada, nf_item_sequencias, quantidade_nf_kg)
       VALUES ('67995', 'entrada_manual', 'compra_nacional', 600, 'q2p', '11.2', $1, 'concluida', true, $2, 'PP COPO 40', 'PP COPO 40', ARRAY[1], 600) RETURNING id`,
      [id(98), C.q8],
    );
    idsMovimentacao.push(String(m8.rows[0]!.id));
    // Q9: nota de entrada 13.500 (editada para mais no portal antes do fisico), XML 13.382; um dos dois produtos gravado
    await nf('q2p', { nIdNf: id(117), chave: C.q9, numero: '000067996', razao: 'ISOFORMA PLASTICOS LTDA', cnpj: CNPJ.isoforma, dEmi: '2026-10-23', nIdReceb: id(106),
      itens: [{ nCodItem: id(123), xProd: 'PS CRISTAL B', cfop: '1.102', qCom: 13500, uCom: 'KG', vProd: 152554.8, vUnCom: 11.3004 }] });
    await receb('q2p', { nIdReceb: id(106), chave: C.q9, numero: '000067996', dEmissao: '2026-10-23', fornecedor: FORN.isoforma, cnpj: CNPJ.isoforma, razao: 'ISOFORMA PLASTICOS LTDA', recebido: 'S', etapa: '60',
      itens: [{ seq: 1, descricao: 'PS CRISTAL B', cfopEntrada: '1.102', qtde: 13382, un: 'KG', preco: 11.4, total: 152554.8, nIdItem: id(123), naoGerarMov: 'S' }] });
    const m9 = await q(
      `INSERT INTO stockbridge.movimentacao (nota_fiscal, tipo_movimento, subtipo, quantidade_kg, empresa, galpao, produto_codigo_q2p, status_omie, ativo,
          nf_chave_acesso, nf_item_descricao, nf_item_descricao_normalizada, nf_item_sequencias, quantidade_nf_kg)
       VALUES ('67996', 'entrada_manual', 'compra_nacional', 13400, 'q2p', '11.2', $1, 'concluida', true, $2, 'PS CRISTAL B', 'PS CRISTAL B', ARRAY[1], 13400) RETURNING id`,
      [id(98), C.q9],
    );
    idsMovimentacao.push(String(m9.rows[0]!.id));
    // Q10: XML 13.500, nota de entrada 13.382. 1a leva na fonte "fiscal pendente" (base XML, conferida 13.382): A = 8.000 kg
    // gravou 13.500 x 8.000/13.382 = 8.070,543 e B falhou. A retomada (base nota de entrada) repartiu o restante da fila
    // (13.382 - 8.070,543 = 5.311,457) para B = 5.382 kg: a soma fecha na nota de entrada.
    await nf('q2p', { nIdNf: id(118), chave: C.q10, numero: '000067997', razao: 'ISOFORMA PLASTICOS LTDA', cnpj: CNPJ.isoforma, dEmi: '2026-10-23', nIdReceb: id(107),
      itens: [{ nCodItem: id(124), xProd: 'PS CRISTAL B', cfop: '1.102', qCom: 13382, uCom: 'KG', vProd: 153900, vUnCom: 11.5005 }] });
    await receb('q2p', { nIdReceb: id(107), chave: C.q10, numero: '000067997', dEmissao: '2026-10-23', fornecedor: FORN.isoforma, cnpj: CNPJ.isoforma, razao: 'ISOFORMA PLASTICOS LTDA', recebido: 'S', etapa: '60',
      itens: [{ seq: 1, descricao: 'PS CRISTAL B', cfopEntrada: '1.102', qtde: 13500, un: 'KG', preco: 11.4, total: 153900, nIdItem: id(124), naoGerarMov: 'S' }] });
    for (const [produto, kg, nfKg] of [[id(98), 8000, 8070.543], [id(97), 5382, 5311.457]] as const) {
      const m10 = await q(
        `INSERT INTO stockbridge.movimentacao (nota_fiscal, tipo_movimento, subtipo, quantidade_kg, empresa, galpao, produto_codigo_q2p, status_omie, ativo,
            nf_chave_acesso, nf_item_descricao, nf_item_descricao_normalizada, nf_item_sequencias, quantidade_nf_kg)
         VALUES ('67997', 'entrada_manual', 'compra_nacional', $1, 'q2p', '11.2', $2, 'concluida', true, $3, 'PS CRISTAL B', 'PS CRISTAL B', ARRAY[1], $4) RETURNING id`,
        [kg, produto, C.q10, nfKg],
      );
      idsMovimentacao.push(String(m10.rows[0]!.id));
    }

    // stockbridge: lancamentos manuais (via 2), exclusoes por empresa, dispensa
    await movimentoManual('q2p', '6842', '2026-10-20T12:00:00Z');
    await movimentoManual('acxe', '5832', '2026-10-20T12:00:00Z');
    for (const [empresa, cnpj, nome] of [
      ['q2p', CNPJ.intercompanyAcxe, 'ACXE (intercompany, teste)'],
      ['acxe', CNPJ.intercompanyQ2p, 'Q2P (intercompany, teste)'],
      ['acxe', CNPJ.soAcxe, 'Fornecedor excluido so na ACXE (teste)'],
    ] as const) {
      const r = await q(`INSERT INTO stockbridge.fornecedor_exclusao (empresa, fornecedor_cnpj, fornecedor_nome, motivo, excluido_por) VALUES ($1,$2,$3,'teste 0058',$4) RETURNING id`, [empresa, cnpj, nome, usuario]);
      idsExclusao.push(String(r.rows[0]!.id));
    }
    const d = await q(
      `INSERT INTO stockbridge.nf_dispensa (nf_chave_acesso, nota_fiscal, situacao_fiscal_na_dispensa, motivo, dispensado_por) VALUES ($1,'940','pendente','teste 0058',$2) RETURNING id`,
      [C.a8, usuario],
    );
    idsDispensa.push(String(d.rows[0]!.id));
  }

  function configurar(o: { acxe?: boolean; fiscal?: boolean; corteAcxe?: string | null; revertido?: boolean } = {}): void {
    const { acxe = true, fiscal = true, corteAcxe = CORTE_ACXE, revertido } = o;
    for (const k of Object.keys(cfg.valores)) delete cfg.valores[k];
    cfg.valores.STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE = CORTE_Q2P;
    cfg.valores.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = fiscal;
    cfg.valores.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED = acxe;
    if (corteAcxe) cfg.valores.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE = corteAcxe;
    // D21: o kill switch fica no default (ligada, com a chave da 016 e a coluna da 0060); `revertido: false` e o caminho de antes
    if (revertido !== undefined) cfg.valores.STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED = revertido;
  }
  const doTeste = <T extends { nfChaveAcesso: string }>(fila: T[]): T[] => fila.filter((f) => f.nfChaveAcesso.startsWith('99'));
  const chaves = (fila: Array<{ nfChaveAcesso: string }>): string[] => doTeste(fila).map((f) => f.nfChaveAcesso);

  beforeAll(async () => {
    core = await import('@atlas/core');
    pool = core.getPool() as unknown as Pool;
    configurar();
    svc = await import('../services/fila-nacional.service.js');
    pcs = await import('../services/pc-sugestao.service.js');
    visto = await import('../services/pc-visto.service.js');
    gemeo = await import('../services/produto-gemeo-q2p.js');
    visto.__resetRegistroPcsVistos();

    // pre-requisitos: schema stockbridge ate a 0058
    const cols = await q(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'stockbridge' AND ((table_name = 'pedido_compra_visto' AND column_name = 'n_cod_prod')
           OR (table_name = 'fornecedor_exclusao' AND column_name = 'empresa'))`,
    );
    if (cols.rows.length < 2) {
      motivoSkip = 'schema stockbridge sem a migration 0058 (pedido_compra_visto.n_cod_prod / fornecedor_exclusao.empresa)';
      console.warn(`[fila-nacional-acxe-db] testes pulados: ${motivoSkip}`);
      return;
    }
    // a fila normaliza descricoes com unaccent() sem schema: tem de resolver pelo search_path da conexao
    try {
      await q(`SELECT unaccent('Ação')`);
    } catch {
      motivoSkip = 'extensao unaccent fora do search_path da conexao (a fila nacional depende dela, migration 0052)';
      console.warn(`[fila-nacional-acxe-db] testes pulados: ${motivoSkip}`);
      return;
    }
    // tabelas do espelho: criar as que faltam; reaproveitar as vazias; pular se alguma tiver dados
    const todas = [...ddl('q2p'), ...ddl('acxe')];
    const estado = new Map<string, 'falta' | 'vazia'>();
    for (const [nome] of todas) {
      const r = await q(`SELECT to_regclass($1) IS NOT NULL AS existe`, [`public."${nome}"`]);
      if (r.rows[0]!.existe !== true) {
        estado.set(nome, 'falta');
        continue;
      }
      const n = Number((await q(`SELECT count(*)::int AS n FROM public."${nome}"`)).rows[0]!.n);
      if (n > 0) {
        motivoSkip = `public."${nome}" ja tem dados (espelho real): o teste nao escreve nele`;
        console.warn(`[fila-nacional-acxe-db] testes pulados: ${motivoSkip}`);
        return;
      }
      const base = nome.replace(/_(Q2P|ACXE)$/, '');
      const existentes = new Set((await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [nome])).rows.map((c) => String(c.column_name)));
      const faltam = (COLUNAS[base] ?? []).filter((c) => !existentes.has(c));
      if (faltam.length > 0) {
        motivoSkip = `public."${nome}" ja existe (vazia) sem as colunas ${faltam.join(', ')} — criada por outro teste de integracao? Rode este arquivo sozinho`;
        console.warn(`[fila-nacional-acxe-db] testes pulados: ${motivoSkip}`);
        return;
      }
      estado.set(nome, 'vazia');
    }
    for (const [nome, create] of todas) {
      if (estado.get(nome) === 'falta') {
        try {
          await q(create);
        } catch (err) {
          // outro teste de integracao criou a mesma tabela entre a checagem e o CREATE (execucao em paralelo): este arquivo desiste
          if ((err as { code?: string }).code === '42P07') {
            motivoSkip = `public."${nome}" foi criada por outro processo durante a preparacao — rode este arquivo sozinho`;
            console.warn(`[fila-nacional-acxe-db] testes pulados: ${motivoSkip}`);
            return;
          }
          throw err;
        }
        tabelasCriadas.push(nome);
      } else {
        tabelasVazias.push(nome);
      }
    }
    const u = await q(`SELECT id FROM atlas.users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`);
    if (u.rows[0]) {
      usuario = String(u.rows[0].id);
    } else {
      const novo = await q(`INSERT INTO atlas.users (name, email, password_hash, role) VALUES ('teste 0058', $1, 'x', 'gestor') RETURNING id`, [`teste-0058-${BASE}@t.local`]);
      usuario = String(novo.rows[0]!.id);
      criouUsuario = true;
    }
    await semear();
    pronto = true;
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    const apagar = async (sql: string, params?: unknown[]) => {
      try {
        await q(sql, params);
      } catch {
        /* limpeza em melhor esforco: tabela que nunca foi criada */
      }
    };
    await apagar(`DELETE FROM stockbridge.movimentacao WHERE id = ANY($1::uuid[])`, [idsMovimentacao]);
    await apagar(`DELETE FROM stockbridge.fornecedor_exclusao WHERE id = ANY($1::uuid[])`, [idsExclusao]);
    await apagar(`DELETE FROM stockbridge.nf_dispensa WHERE id = ANY($1::uuid[])`, [idsDispensa]);
    await apagar(`DELETE FROM stockbridge.recebimento_fiscal WHERE id = ANY($1::uuid[])`, [idsLedger]);
    await apagar(`DELETE FROM stockbridge.pedido_compra_visto WHERE n_cod_item BETWEEN $1 AND $2`, [FAIXA.de, FAIXA.ate]);
    await apagar(`DELETE FROM stockbridge.localidade_correlacao WHERE localidade_id IN (SELECT id FROM stockbridge.localidade WHERE codigo LIKE 'T9.9.%')`);
    await apagar(`DELETE FROM stockbridge.localidade WHERE codigo LIKE 'T9.9.%'`);
    for (const nome of [...tabelasVazias].reverse()) await apagar(`DELETE FROM public."${nome}"`); // filhos primeiro
    for (const nome of [...tabelasCriadas].reverse()) await apagar(`DROP TABLE IF EXISTS public."${nome}" CASCADE`);
    if (criouUsuario) await apagar(`DELETE FROM atlas.users WHERE id = $1`, [usuario]);
    await core.closePool();
  });

  // ═══ Fila ═══════════════════════════════════════════════════════════════════════════════════════════════════

  describe('fila — as duas empresas na mesma consulta', () => {
    it('ACXE habilitada: o conjunto exato de NFs, em ordem de emissao (numero e empresa desempatam)', async (ctx) => {
      if (!pronto) return ctx.skip();
      const fila = await svc.getFilaNacional();
      expect(chaves(fila)).toEqual(ESPERADA_AMBAS);
    });

    it('empresa por NF, valor, fiscal e itens pendentes', async (ctx) => {
      if (!pronto) return ctx.skip();
      const por = Object.fromEntries(doTeste(await svc.getFilaNacional()).map((f) => [f.nfChaveAcesso, f]));
      expect(por[C.q5]).toMatchObject({ empresa: 'q2p', notaFiscal: '9100', fiscal: 'pendente', valorTotalBrl: 203400, itensTotal: 1, itensPendentes: 1 });
      expect(por[C.a3]).toMatchObject({ empresa: 'acxe', notaFiscal: '937', fornecedorNome: 'SOLUTEC PLASTICOS LTDA', fiscal: 'pendente', valorTotalBrl: 124800, estoqueLancadoPeloOmie: false });
      expect(por[C.q3]).toMatchObject({ empresa: 'q2p', notaFiscal: '7000', fiscal: 'concluido', valorTotalBrl: 148500 });
      expect(por[C.a9]).toMatchObject({ empresa: 'acxe', fiscal: 'concluido', estoqueLancadoPeloOmie: false });
    });

    it('cada NF com o selo de PC da copia da PROPRIA empresa', async (ctx) => {
      if (!pronto) return ctx.skip();
      const por = Object.fromEntries(doTeste(await svc.getFilaNacional()).map((f) => [f.nfChaveAcesso, f.pcSituacao]));
      expect(por[C.a3]).toBe('sugerido'); // PC 580 na copia da ACXE
      expect(por[C.a7]).toBe('sugerido'); // PC 582 so no cache de PCs vistos
      expect(por[C.q2]).toBe('sugerido'); // PC 304 na copia da Q2P
      expect(por[C.q5]).toBe('sem_pc');
      expect(por[C.a1]).toBe('sem_pc');
      expect(por[C.q3]).toBe('nao_aplicavel'); // fiscal ja feito: sem selo
    });

    it('corte PROPRIO: a ACXE emitida em 20/09 (antes do corte da ACXE) fica de fora; a Q2P de 20/09 (apos o corte da Q2P) entra', async (ctx) => {
      if (!pronto) return ctx.skip();
      const k = chaves(await svc.getFilaNacional());
      expect(k).toContain(C.q5);
      expect(k).not.toContain(C.a6);
    });

    it('via 2 por empresa: o lancamento manual da Q2P (NF 6842) nao marca a NF 6842 da ACXE como recebida — e o da ACXE (NF 5832) nao marca a da Q2P', async (ctx) => {
      if (!pronto) return ctx.skip();
      const k = chaves(await svc.getFilaNacional());
      expect(k).not.toContain(C.q1); // Q2P 6842: recebida pelo manual da Q2P
      expect(k).toContain(C.a1); //     ACXE 6842: o MESMO numero, outra empresa: segue pendente
      expect(k).not.toContain(C.a2); // ACXE 5832: recebida pelo manual da ACXE
      expect(k).toContain(C.q2); //     Q2P 5832: segue pendente
    });

    it('exclusao de fornecedor por empresa: a contraparte intercompany sai da fila dela; o mesmo CNPJ excluido so na ACXE segue na fila da Q2P', async (ctx) => {
      if (!pronto) return ctx.skip();
      const k = chaves(await svc.getFilaNacional());
      expect(k).not.toContain(C.q4); // ACXE como fornecedora da Q2P: excluida da fila da Q2P
      expect(k).not.toContain(C.a5); // Q2P como fornecedora da ACXE: excluida da fila da ACXE
      expect(k).not.toContain(C.a8200); // excluido na ACXE
      expect(k).toContain(C.q8201); //     o MESMO CNPJ na Q2P: nao excluido la
    });

    it('NF concluida no portal COM estoque aparece como bloqueada (estoque ja lancado pelo OMIE); a que nao movimentou estoque, nao', async (ctx) => {
      if (!pronto) return ctx.skip();
      const por = Object.fromEntries(doTeste(await svc.getFilaNacional()).map((f) => [f.nfChaveAcesso, f]));
      expect(por[C.a4]).toMatchObject({ empresa: 'acxe', fiscal: 'concluido', estoqueLancadoPeloOmie: true });
      expect(por[C.a9]!.estoqueLancadoPeloOmie).toBe(false);
    });

    it('NF dispensada (por chave de acesso) sai da fila da ACXE', async (ctx) => {
      if (!pronto) return ctx.skip();
      expect(chaves(await svc.getFilaNacional())).not.toContain(C.a8);
    });

    it('filtros q e fornecedor valem nas duas empresas', async (ctx) => {
      if (!pronto) return ctx.skip();
      expect(chaves(await svc.getFilaNacional({ q: '937' }))).toEqual([C.a3]);
      expect(chaves(await svc.getFilaNacional({ q: '6842' }))).toEqual([C.a1]); // a Q2P 6842 foi recebida
      expect(chaves(await svc.getFilaNacional({ fornecedor: 'SOLUTEC' }))).toEqual([C.a3, C.a9]);
      expect(chaves(await svc.getFilaNacional({ fornecedor: CNPJ.zaraplast }))).toEqual([C.q2, C.q3]);
    });

    it('empresa=q2p e empresa=acxe restringem a fila', async (ctx) => {
      if (!pronto) return ctx.skip();
      expect(chaves(await svc.getFilaNacional({ empresa: 'q2p' }))).toEqual(ESPERADA_Q2P);
      expect(chaves(await svc.getFilaNacional({ empresa: 'acxe' }))).toEqual(ESPERADA_ACXE);
    });
  });

  describe('fila — recebimento da ACXE pelo caminho novo e fiscal concluido pelo Atlas', () => {
    it('movimentacao da ACXE com a chave e a sequencia do item: a NF sai da fila MESMO com a descricao trocada depois do fiscal (ACXEGDP-412)', async (ctx) => {
      if (!pronto) return ctx.skip();
      expect(chaves(await svc.getFilaNacional())).not.toContain(C.a10);
      const d = await svc.getDetalheNfNacional(C.a10);
      expect(d.itens[0]).toMatchObject({ jaRecebido: true, quantidadeNfJaAtribuidaKg: 6128, quantidadeRestanteKg: 0, sequenciasRecebimento: [1] });
      expect(d.dispensavel).toBe(false);
    });

    it('recebimento so em parte (3.000 de 6.128 kg): a NF continua na fila e o detalhe mostra o restante (a retomada completa o resto)', async (ctx) => {
      if (!pronto) return ctx.skip();
      const por = Object.fromEntries(doTeste(await svc.getFilaNacional()).map((f) => [f.nfChaveAcesso, f]));
      expect(por[C.a11]).toMatchObject({ empresa: 'acxe', fiscal: 'concluido', itensTotal: 1, itensPendentes: 1 });
      const d = await svc.getDetalheNfNacional(C.a11);
      expect(d.itens[0]).toMatchObject({ jaRecebido: true, quantidadeNfJaAtribuidaKg: 3000, quantidadeRestanteKg: 3128 });
      expect(d.dispensavel).toBe(true);
    });

    it('fiscal concluido PELO ATLAS (ledger da ACXE) com o espelho de recebimentos atrasado: a NF aparece como fiscal concluido, com a data do ledger', async (ctx) => {
      if (!pronto) return ctx.skip();
      const por = Object.fromEntries(doTeste(await svc.getFilaNacional()).map((f) => [f.nfChaveAcesso, f]));
      expect(por[C.a12]).toMatchObject({ empresa: 'acxe', fiscal: 'concluido', fiscalConcluidoPeloAtlasEm: '2026-10-18T15:00:00.000Z' });
      const d = await svc.getDetalheNfNacional(C.a12);
      expect(d).toMatchObject({ empresa: 'acxe', fiscal: 'concluido' });
    });
  });

  // DEFEITO CORRIGIDO (achado ao rodar o SQL de verdade): a consulta SO da Q2P (ACXE desligada, ou ?empresa=q2p com a ACXE ligada)
  // era identica byte a byte a de antes da Historia 5 — e o `NOT EXISTS (... stockbridge.fornecedor_exclusao fe ...)`
  // dela nao tinha o filtro de empresa que a consulta com a ACXE tem (`fe.empresa = u.empresa`). Desde a 0058 a tabela tem linhas
  // de empresa 'acxe' (o seed da Q2P matriz e filial) e o gestor pode excluir um fornecedor so na ACXE: essas exclusoes passam
  // a esconder a NF da Q2P quando a fila era so da Q2P — e a mesma NF aparecia na fila sem filtro (as duas empresas) e sumia no
  // filtro empresa=q2p. Corrigido com `AND fe.empresa = 'q2p'` na consulta so da Q2P (golden regenerado).
  describe('exclusao de fornecedor feita so para a ACXE nao vaza para a consulta so da Q2P (defeito corrigido)', () => {
    it('empresa=q2p com a ACXE ligada: a NF da Q2P do CNPJ excluido so na ACXE (Q8201) esta na fila', async (ctx) => {
      if (!pronto) return ctx.skip();
      expect(chaves(await svc.getFilaNacional())).toContain(C.q8201); // sem filtro: aparece
      expect(chaves(await svc.getFilaNacional({ empresa: 'q2p' }))).toContain(C.q8201); // com o filtro da Q2P tambem
    });

    it('ACXE desligada: a mesma NF da Q2P esta na fila (a exclusao da ACXE nao vale na Q2P)', async (ctx) => {
      if (!pronto) return ctx.skip();
      configurar({ acxe: false });
      try {
        expect(chaves(await svc.getFilaNacional())).toContain(C.q8201);
      } finally {
        configurar();
      }
    });

    it('detalhe com a ACXE desligada: a NF da Q2P do CNPJ excluido so na ACXE abre', async (ctx) => {
      if (!pronto) return ctx.skip();
      configurar({ acxe: false });
      try {
        await expect(svc.getDetalheNfNacional(C.q8201)).resolves.toMatchObject({ empresa: 'q2p', notaFiscal: '8201' });
      } finally {
        configurar();
      }
    });
  });

  describe('quantidade recebida editada no portal depois do recebimento pelo Atlas (NF 67988, 23/10/2026)', () => {
    it('nota de entrada com a quantidade RECEBIDA (13.500) e XML com 13.382: o item recebido pelo Atlas com 13.382 nao volta a fila', async (ctx) => {
      if (!pronto) return ctx.skip();
      for (const empresa of [undefined, 'q2p'] as const) {
        expect(chaves(await svc.getFilaNacional(empresa ? { empresa } : {}))).not.toContain(C.q6);
      }
      const d = await svc.getDetalheNfNacional(C.q6);
      expect(d.itens).toHaveLength(1);
      expect(d.itens[0]).toMatchObject({ jaRecebido: true, quantidadeNfKg: 13500, quantidadeNfJaAtribuidaKg: 13382, quantidadeRestanteKg: 0 });
      expect(svc.itemNfPendente(d.itens[0]!)).toBe(false);
    });

    it('com a chave da 016 desligada (so a fonte do espelho de NF) a regra e a mesma', async (ctx) => {
      if (!pronto) return ctx.skip();
      configurar({ fiscal: false });
      try {
        expect(chaves(await svc.getFilaNacional())).not.toContain(C.q6);
      } finally {
        configurar();
      }
    });

    it('XML com unidade trocada (1,375 "KG" x nota de entrada 1.375 kg) fica fora da faixa comparavel: a gravacao parcial segue pendente', async (ctx) => {
      if (!pronto) return ctx.skip();
      expect(chaves(await svc.getFilaNacional({ empresa: 'q2p' }))).toContain(C.q8);
      const d = await svc.getDetalheNfNacional(C.q8);
      expect(d.itens[0]).toMatchObject({ quantidadeNfKg: 1375, quantidadeNfJaAtribuidaKg: 600, quantidadeRestanteKg: 775 });
      expect(svc.itemNfPendente(d.itens[0]!)).toBe(true);
    });

    it('nota de entrada editada para mais antes do fisico e gravacao parcial ancorada nela: o XML menor nao esconde os 100 kg', async (ctx) => {
      if (!pronto) return ctx.skip();
      expect(chaves(await svc.getFilaNacional({ empresa: 'q2p' }))).toContain(C.q9);
      const d = await svc.getDetalheNfNacional(C.q9);
      expect(d.itens[0]).toMatchObject({ quantidadeNfKg: 13500, quantidadeNfJaAtribuidaKg: 13400, quantidadeRestanteKg: 100 });
      expect(svc.itemNfPendente(d.itens[0]!)).toBe(true);
    });

    it('nota de entrada MENOR que o XML e item 1:N recebido em duas levas com bases diferentes: fecha na nota de entrada e sai da fila', async (ctx) => {
      if (!pronto) return ctx.skip();
      for (const empresa of [undefined, 'q2p'] as const) {
        expect(chaves(await svc.getFilaNacional(empresa ? { empresa } : {}))).not.toContain(C.q10);
      }
      const d = await svc.getDetalheNfNacional(C.q10);
      expect(d.itens[0]).toMatchObject({ jaRecebido: true, quantidadeNfKg: 13382, quantidadeNfJaAtribuidaKg: 13382, quantidadeRestanteKg: 0 });
      expect(svc.itemNfPendente(d.itens[0]!)).toBe(false);
    });

    it('sem o recebimento no espelho (sem o XML) vale a nota de entrada, como antes: a diferenca de 118 kg segue pendente', async (ctx) => {
      if (!pronto) return ctx.skip();
      expect(chaves(await svc.getFilaNacional({ empresa: 'q2p' }))).toContain(C.q7);
      const d = await svc.getDetalheNfNacional(C.q7);
      expect(d.itens[0]).toMatchObject({ jaRecebido: true, quantidadeNfKg: 13500, quantidadeRestanteKg: 118 });
      expect(svc.itemNfPendente(d.itens[0]!)).toBe(true);
    });
  });

  describe('fila — a ACXE desligada (ou sem alguma das tres condicoes) e so a Q2P', () => {
    const CASOS: Array<[string, { acxe?: boolean; fiscal?: boolean; corteAcxe?: string | null }]> = [
      ['chave da ACXE desligada', { acxe: false }],
      ['chave ligada SEM o fiscal pelo Atlas', { fiscal: false }],
      ['chave ligada SEM o corte da ACXE', { corteAcxe: null }],
    ];
    for (const [nome, opts] of CASOS) {
      it(nome, async (ctx) => {
        if (!pronto) return ctx.skip();
        configurar(opts);
        try {
          const fila = await svc.getFilaNacional();
          // sem a chave do fiscal pelo Atlas a fonte (b) some tambem na Q2P; com ela, a Q2P e a de sempre
          const q2p = chaves(fila);
          expect(q2p.every((k) => [C.q5, C.q2, C.q8201, C.q3, C.q1, C.q4, C.q7, C.q8, C.q9].includes(k))).toBe(true);
          expect(doTeste(fila).every((f) => f.empresa === 'q2p')).toBe(true);
          if (opts.fiscal !== false) expect(q2p).toEqual(ESPERADA_Q2P);
          expect(await svc.getFilaNacional({ empresa: 'acxe' })).toEqual([]);
        } finally {
          configurar();
        }
      });
    }
  });

  describe('fila e detalhe — o espelho da ACXE ausente nao derruba a Q2P (erros 42P01 e 42703 reais do driver)', () => {
    async function comEspelhoAcxeQuebrado(quebrar: () => Promise<unknown>, consertar: () => Promise<unknown>, corpo: () => Promise<void>): Promise<void> {
      await quebrar();
      try {
        await corpo();
      } finally {
        await consertar();
      }
    }
    const renomear = (de: string, para: string, tipo: 'TABLE' | 'COLUMN' = 'TABLE', tabela = '') =>
      tipo === 'TABLE' ? q(`ALTER TABLE public."${de}" RENAME TO "${para}"`) : q(`ALTER TABLE public."${tabela}" RENAME COLUMN ${de} TO ${para}`);

    it('tabela da ACXE ausente (42P01): a fila devolve a da Q2P inteira; so a ACXE e o erro visivel; o detalhe da NF da Q2P abre e o da ACXE nao e encontrado', async (ctx) => {
      if (!pronto) return ctx.skip();
      await comEspelhoAcxeQuebrado(
        () => renomear('tbl_recebimentoNFe_itens_ACXE', 'tbl_recebimentoNFe_itens_ACXE_off'),
        () => renomear('tbl_recebimentoNFe_itens_ACXE_off', 'tbl_recebimentoNFe_itens_ACXE'),
        async () => {
          expect(chaves(await svc.getFilaNacional())).toEqual(ESPERADA_Q2P);
          await expect(svc.getFilaNacional({ empresa: 'acxe' })).rejects.toBeInstanceOf(svc.FilaNacionalIncompletaError);
          const d = await svc.getDetalheNfNacional(C.q3);
          expect(d).toMatchObject({ empresa: 'q2p', notaFiscal: '7000' });
          await expect(svc.getDetalheNfNacional(C.a3)).rejects.toBeInstanceOf(svc.NfNacionalNaoEncontradaError);
        },
      );
      // consertado: a ACXE volta
      expect(chaves(await svc.getFilaNacional())).toEqual(ESPERADA_AMBAS);
    });

    it('coluna ausente num espelho da ACXE (42703, ex.: o n8n da ACXE com DDL antiga): mesmo tratamento', async (ctx) => {
      if (!pronto) return ctx.skip();
      await comEspelhoAcxeQuebrado(
        () => renomear('n_id_pedido', 'n_id_pedido_off', 'COLUMN', 'tbl_recebimentoNFe_itens_ACXE'),
        () => renomear('n_id_pedido_off', 'n_id_pedido', 'COLUMN', 'tbl_recebimentoNFe_itens_ACXE'),
        async () => {
          expect(chaves(await svc.getFilaNacional())).toEqual(ESPERADA_Q2P);
          await expect(svc.getDetalheNfNacional(C.a3)).rejects.toBeInstanceOf(svc.NfNacionalNaoEncontradaError);
        },
      );
    });

    it('coluna `cancelada` ausente do espelho de NF da ACXE (sync PROD -> UAT a derruba): a fila segue sem erro, sem o filtro dela SO na ACXE', async (ctx) => {
      if (!pronto) return ctx.skip();
      await comEspelhoAcxeQuebrado(
        () => renomear('cancelada', 'cancelada_off', 'COLUMN', 'tbl_nf_header_ACXE'),
        () => renomear('cancelada_off', 'cancelada', 'COLUMN', 'tbl_nf_header_ACXE'),
        async () => {
          const k = chaves(await svc.getFilaNacional());
          for (const esperada of ESPERADA_AMBAS) expect(k).toContain(esperada); // nada some
          expect(k).toContain(C.a13); // sem a coluna nao ha como saber que foi cancelada (fail-safe de nfValidaSql); a excluida (`deletada`) continua fora
          expect(k).not.toContain(C.a14);
        },
      );
      expect(chaves(await svc.getFilaNacional())).toEqual(ESPERADA_AMBAS); // consertado: voltou a filtrar
    });

    it('tabela da Q2P ausente continua sendo erro visivel (503), nunca fila vazia nem so a ACXE', async (ctx) => {
      if (!pronto) return ctx.skip();
      await comEspelhoAcxeQuebrado(
        () => renomear('tbl_recebimentoNFe_itens_Q2P', 'tbl_recebimentoNFe_itens_Q2P_off'),
        () => renomear('tbl_recebimentoNFe_itens_Q2P_off', 'tbl_recebimentoNFe_itens_Q2P'),
        async () => {
          await expect(svc.getFilaNacional()).rejects.toBeInstanceOf(svc.FilaNacionalIncompletaError);
        },
      );
    });
  });

  // ═══ Detalhe ════════════════════════════════════════════════════════════════════════════════════════════════

  describe('detalhe da NF da ACXE', () => {
    it('NF 937: empresa, produto sugerido com a marca do gemeo, candidato de PC com o LOCAL DO PC (20.0.7, nao o do item, 11.1)', async (ctx) => {
      if (!pronto) return ctx.skip();
      const d = await svc.getDetalheNfNacional(C.a3);
      expect(d).toMatchObject({ empresa: 'acxe', notaFiscal: '937', fiscal: 'pendente', copiaPcsDefasada: false, estoqueLancadoPeloOmie: false });
      expect(d.itens).toHaveLength(1);
      const item = d.itens[0]!;
      expect(item.produtosSugeridos).toEqual([{ codigo: PROD.ppAcxe, descricao: 'PP PRETO Q35', vezesUsada: 0, semCorrelatoQ2p: false }]);
      expect(item.bloqueio).toBeNull();
      expect(item.quantidadeNfKg).toBe(26000);
      const c = item.pc!.candidatos[0]!;
      expect(c).toMatchObject({ pcNumero: '580', localDescricao: '20.0.7 · PRODUÇÃO' });
      expect(c.localidadeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(d.pcsDaNf.pcs[0]!.itens[0]).toMatchObject({ localidadeId: c.localidadeId, localDescricao: '20.0.7 · PRODUÇÃO' });
      // ACXEGDP-313: nenhum codigo OMIE de 10 digitos nos textos da tela
      expect(c.localDescricao).not.toMatch(/\d{10}/);
    });

    it('NF 938: o PC 582 so existe no cache de PCs vistos — vem com local, produto (sem gemeo) e o aviso de dados em cache', async (ctx) => {
      if (!pronto) return ctx.skip();
      const d = await svc.getDetalheNfNacional(C.a7);
      const c = d.itens[0]!.pc!.candidatos[0]!;
      expect(c).toMatchObject({ pcNumero: '582', dadosEmCache: true, localDescricao: '20.0.7 · PRODUÇÃO' });
      expect(d.itens[0]!.produtosSugeridos).toEqual([{ codigo: PROD.masterAcxe, descricao: 'MASTER PRETO', vezesUsada: 0, semCorrelatoQ2p: true }]);
    });

    it('NF 1234 (portal com estoque): bloqueada por estoque ja lancado; NF 9009: o PC vinculado no OMIE aparece com o numero da COPIA DA ACXE', async (ctx) => {
      if (!pronto) return ctx.skip();
      const bloqueada = await svc.getDetalheNfNacional(C.a4);
      expect(bloqueada).toMatchObject({ empresa: 'acxe', fiscal: 'concluido', estoqueLancadoPeloOmie: true });
      const vinculada = await svc.getDetalheNfNacional(C.a9);
      expect(vinculada).toMatchObject({ empresa: 'acxe', fiscal: 'concluido', estoqueLancadoPeloOmie: false });
      expect(vinculada.itens[0]!.pc).toMatchObject({ vinculadoNoOmie: { pcNumero: '580' } });
      // a sugestao de produto vem do item (n_cod_prod da NF), tambem com o fiscal ja feito
      expect(vinculada.itens[0]!.produtosSugeridos.map((p) => p.codigo)).toEqual([PROD.ppAcxe]);
    });

    it('NF da ACXE inativa/dispensada/intercompany/pre-corte: recusada como a fila a esconde', async (ctx) => {
      if (!pronto) return ctx.skip();
      await expect(svc.getDetalheNfNacional(C.a8)).rejects.toBeInstanceOf(svc.NfNacionalDispensadaError);
      await expect(svc.getDetalheNfNacional(C.a5)).rejects.toBeInstanceOf(svc.FornecedorExcluidoError);
      await expect(svc.getDetalheNfNacional(C.a8200)).rejects.toBeInstanceOf(svc.FornecedorExcluidoError);
      await expect(svc.getDetalheNfNacional(C.a6)).rejects.toBeInstanceOf(svc.NfNacionalNaoEncontradaError); // emitida antes do corte da ACXE
    });

    it('NF cancelada ou excluida no OMIE (ACXE): recusada pelo detalhe, e a fila nao a mostra', async (ctx) => {
      if (!pronto) return ctx.skip();
      await expect(svc.getDetalheNfNacional(C.a13)).rejects.toBeInstanceOf(svc.NfNacionalCanceladaError);
      await expect(svc.getDetalheNfNacional(C.a14)).rejects.toBeInstanceOf(svc.NfNacionalCanceladaError);
      const k = chaves(await svc.getFilaNacional());
      expect(k).not.toContain(C.a13);
      expect(k).not.toContain(C.a14);
    });

    it('o mesmo CNPJ excluido so na ACXE: o detalhe da NF da Q2P abre', async (ctx) => {
      if (!pronto) return ctx.skip();
      const d = await svc.getDetalheNfNacional(C.q8201);
      expect(d).toMatchObject({ empresa: 'q2p', notaFiscal: '8201' });
    });

    it('NF da Q2P: como era — sem marca de gemeo nos produtos, sem local nos candidatos (mesmo com o local no PC da copia da Q2P)', async (ctx) => {
      if (!pronto) return ctx.skip();
      const d = await svc.getDetalheNfNacional(C.q2);
      expect(d.empresa).toBe('q2p');
      const c = d.itens[0]!.pc!.candidatos[0]!;
      expect(c).toMatchObject({ pcNumero: '304', localidadeId: null, localDescricao: null });
      for (const p of d.itens[0]!.produtosSugeridos) expect(p).not.toHaveProperty('semCorrelatoQ2p');
    });

    it('NF 5832 e 6842 existem nas duas empresas: cada chave abre o detalhe da PROPRIA empresa', async (ctx) => {
      if (!pronto) return ctx.skip();
      expect((await svc.getDetalheNfNacional(C.a1)).empresa).toBe('acxe');
      expect((await svc.getDetalheNfNacional(C.q2)).empresa).toBe('q2p');
      // recebidas pelo manual: o detalhe mostra o item como ja recebido, da empresa certa
      const q1 = await svc.getDetalheNfNacional(C.q1);
      expect(q1).toMatchObject({ empresa: 'q2p', notaFiscal: '6842' });
      expect(q1.itens[0]!.jaRecebido).toBe(true);
      const a2 = await svc.getDetalheNfNacional(C.a2);
      expect(a2).toMatchObject({ empresa: 'acxe', notaFiscal: '5832' });
      expect(a2.itens[0]!.jaRecebido).toBe(true);
      expect((await svc.getDetalheNfNacional(C.a1)).itens[0]!.jaRecebido).toBe(false);
    });

    it('o resultado interno (usado pelo POST) traz o fornecedor do recebimento da ACXE e o PC por item', async (ctx) => {
      if (!pronto) return ctx.skip();
      const { detalhe, interno } = await svc.montarDetalheNfNacional(C.a3);
      expect(detalhe.empresa).toBe('acxe');
      expect(interno.fornecedorCodigo).toBe(FORN.solutec);
      expect(interno.pcPorIndice.get(0)!.resultado!.pc.candidatos.map((c) => c.pcNumero)).toEqual(['580']);
    });
  });

  // ═══ Gemeo Q2P ══════════════════════════════════════════════════════════════════════════════════════════════

  describe('resolverGemeosQ2p — descricao exata, produto Q2P ativo, menor codigo', () => {
    it('PP PRETO Q35: ignora o gemeo INATIVO de menor codigo e fica com o ativo de menor codigo', async (ctx) => {
      if (!pronto) return ctx.skip();
      const m = await gemeo.resolverGemeosQ2p([PROD.ppAcxe]);
      expect(m.get(PROD.ppAcxe)).toEqual({
        codigoAcxe: PROD.ppAcxe, descricaoAcxe: 'PP PRETO Q35', ativoAcxe: true, unidadeAcxe: 'KG', emKgAcxe: true,
        gemeoQ2p: { codigo: PROD.ppQ2pGemeo, descricao: 'PP PRETO Q35' },
      });
    });

    it('unidade (revisao da Fase 2): produto da ACXE fora de KG vem marcado (emKgAcxe false) e gemeo da Q2P fora de KG nao conta', async (ctx) => {
      if (!pronto) return ctx.skip();
      const cabo = PROD.ppAcxe + 900;
      const tubo = PROD.ppAcxe + 901;
      await produto('acxe', cabo, 'CABO PP 3X2,5MM', null, ' mt ');
      await produto('acxe', tubo, 'TUBO PRETO TESTE');
      await produto('q2p', PROD.ppQ2pGemeo + 901, 'TUBO PRETO TESTE', null, 'UN'); // so existe fora de KG na Q2P
      try {
        const m = await gemeo.resolverGemeosQ2p([cabo, tubo]);
        expect(m.get(cabo)).toMatchObject({ unidadeAcxe: 'MT', emKgAcxe: false });
        expect(m.get(tubo)).toMatchObject({ emKgAcxe: true, gemeoQ2p: null });
      } finally {
        await q(`DELETE FROM public."${tab('tbl_produtos', 'acxe')}" WHERE codigo_produto IN ($1, $2)`, [cabo, tubo]);
        await q(`DELETE FROM public."${tab('tbl_produtos', 'q2p')}" WHERE codigo_produto = $1`, [PROD.ppQ2pGemeo + 901]);
      }
    });

    it('sem gemeo: so ha o inativo; descricao com espaco no fim ou outra caixa NAO e identica', async (ctx) => {
      if (!pronto) return ctx.skip();
      const m = await gemeo.resolverGemeosQ2p([PROD.masterAcxe, PROD.psAcxe]);
      expect(m.get(PROD.masterAcxe)!.gemeoQ2p).toBeNull();
      expect(m.get(PROD.psAcxe)!.gemeoQ2p).toBeNull();
      expect(m.get(PROD.psAcxe)!.ativoAcxe).toBe(true);
    });

    it('produto inativo na ACXE vem marcado como inativo (e com o gemeo); codigo fora do cadastro fica fora do mapa', async (ctx) => {
      if (!pronto) return ctx.skip();
      const m = await gemeo.resolverGemeosQ2p([PROD.absAcxeInativo, id(999)]);
      expect(m.get(PROD.absAcxeInativo)).toMatchObject({ ativoAcxe: false, gemeoQ2p: { codigo: PROD.absQ2p } });
      expect(m.has(id(999))).toBe(false);
    });

    it('e a MESMA regra de getCorrelacao (correlacao.service): o mesmo gemeo para o produto ativo', async (ctx) => {
      if (!pronto) return ctx.skip();
      const seed = await q(`SELECT 1 FROM stockbridge.localidade_correlacao WHERE codigo_local_estoque_acxe = $1`, [LOCAL.l111]);
      if (seed.rows.length === 0) return ctx.skip();
      const { getCorrelacao } = await import('../services/correlacao.service.js');
      const c = await getCorrelacao(PROD.ppAcxe, LOCAL.l111);
      const m = await gemeo.resolverGemeosQ2p([PROD.ppAcxe]);
      expect(c.codigoProdutoQ2p).toBe(m.get(PROD.ppAcxe)!.gemeoQ2p!.codigo);
    });
  });

  // ═══ Locais ═════════════════════════════════════════════════════════════════════════════════════════════════

  describe('resolverLocaisAcxePorCodigoOmie — so localidade ativa e nao virtual', () => {
    it('20.0.7 (operacional) e 11.1 entram; o 90.0.2 (virtual) e os locais inativos ou virtuais de teste ficam de fora', async (ctx) => {
      if (!pronto) return ctx.skip();
      const t = async (codigo: string, tipo: string, ativo: boolean, omie: number) => {
        const l = await q(`INSERT INTO stockbridge.localidade (codigo, nome, tipo, ativo) VALUES ($1, $2, $3, $4) RETURNING id`, [codigo, `LOCAL ${codigo}`, tipo, ativo]);
        await q(`INSERT INTO stockbridge.localidade_correlacao (localidade_id, codigo_local_estoque_acxe) VALUES ($1, $2)`, [l.rows[0]!.id, omie]);
      };
      await t('T9.9.1', 'proprio', true, LOCAL.t1);
      await t('T9.9.2', 'proprio', false, LOCAL.t2); // inativo
      await t('T9.9.3', 'virtual_ajuste', true, LOCAL.t3); // virtual
      await t('T9.9.4', 'operacional', true, LOCAL.t4);
      const m = await pcs.resolverLocaisAcxePorCodigoOmie([LOCAL.l2007, LOCAL.l111, LOCAL.transito, LOCAL.t1, LOCAL.t2, LOCAL.t3, LOCAL.t4, id(777)]);
      expect([...m.keys()].sort()).toEqual([LOCAL.l2007, LOCAL.l111, LOCAL.t1, LOCAL.t4].sort());
      expect(m.get(LOCAL.l2007)).toMatchObject({ codigo: '20.0.7', nome: 'PRODUÇÃO' });
      expect(m.get(LOCAL.t4)).toMatchObject({ codigo: 'T9.9.4', nome: 'LOCAL T9.9.4' });
      expect(m.has(LOCAL.transito)).toBe(false);
    });
  });

  // ═══ Cache de PCs vistos ════════════════════════════════════════════════════════════════════════════════════

  describe('registrarPcsVistos — produto e local do item do PC, so o que mudou', () => {
    const linhaCache = async (item: number) => (await q(`SELECT *, codigo_local_estoque::text AS local_txt FROM stockbridge.pedido_compra_visto WHERE empresa = 'acxe' AND n_cod_item = $1`, [item])).rows[0] ?? null;

    it('grava produto e local numericos; local nao numerico (texto, vazio, grande demais) e produto nulo viram NULL sem abortar o upsert', async (ctx) => {
      if (!pronto) return ctx.skip();
      const base = id(300);
      const novo = (n: number, local: string | null, prod: number | null) =>
        pc('acxe', { ncodped: base + n, ncoditem: base + n, numero: `9${n}`, fornecedor: FORN.gga, qtde: 1000, preco: 2, produto: prod, local, descricao: `ITEM ${n}` });
      await novo(1, String(LOCAL.l2007), PROD.ppAcxe);
      await novo(2, `  ${LOCAL.l111}  `, PROD.ppAcxe); // com espacos: valem
      await novo(3, 'ESTOQUE PRODUCAO', PROD.ppAcxe);
      await novo(4, '', PROD.ppAcxe);
      await novo(5, null, null);
      await novo(6, '12345678901234567890', PROD.ppAcxe); // 20 digitos: nao cabe em bigint
      visto.__resetRegistroPcsVistos();
      const n = await visto.registrarPcsVistos('acxe');
      expect(n).toBeGreaterThanOrEqual(6);
      expect(await linhaCache(base + 1)).toMatchObject({ n_cod_prod: String(PROD.ppAcxe), local_txt: String(LOCAL.l2007) });
      expect(await linhaCache(base + 2)).toMatchObject({ local_txt: String(LOCAL.l111) });
      for (const k of [3, 4, 6]) expect(await linhaCache(base + k), `item ${k}`).toMatchObject({ codigo_local_estoque: null });
      expect(await linhaCache(base + 5)).toMatchObject({ n_cod_prod: null, codigo_local_estoque: null });
    });

    it('segunda rodada sem mudanca: nenhuma linha gravada (nem auditada); mudar so o LOCAL do PC na copia grava essa linha', async (ctx) => {
      if (!pronto) return ctx.skip();
      const base = id(300);
      visto.__resetRegistroPcsVistos();
      expect(await visto.registrarPcsVistos('acxe')).toBe(0);
      const antes = await q(`SELECT count(*)::int AS n FROM shared.audit_log WHERE schema_name = 'stockbridge' AND table_name = 'pedido_compra_visto' AND record_id = $1`, [String((await linhaCache(base + 1))!.id)]);
      await q(`UPDATE public."tbl_pedidosCompras_ACXE" SET codigo_local_estoque = $1 WHERE ncoditem = $2`, [String(LOCAL.l111), base + 1]);
      expect(await visto.registrarPcsVistos('acxe')).toBe(1);
      expect((await linhaCache(base + 1))!.local_txt).toBe(String(LOCAL.l111));
      const depois = await q(`SELECT count(*)::int AS n FROM shared.audit_log WHERE schema_name = 'stockbridge' AND table_name = 'pedido_compra_visto' AND record_id = $1`, [String((await linhaCache(base + 1))!.id)]);
      expect(Number(depois.rows[0]!.n)).toBe(Number(antes.rows[0]!.n) + 1);
    });

    it('lerPcsVistos devolve produto e local como numeros, e o PC-espelho nunca existe na ACXE', async (ctx) => {
      if (!pronto) return ctx.skip();
      const lidos = await visto.lerPcsVistos('acxe', { fornecedores: [FORN.tritec], raizes: [], nCodPeds: [] });
      const p = lidos.find((x) => x.pcNumero === '582')!;
      expect(p).toMatchObject({ nCodProd: PROD.masterAcxe, codigoLocalEstoque: LOCAL.l2007, pcEspelho: false, nCodFor: FORN.tritec });
    });
  });

  // ═══ Saude ══════════════════════════════════════════════════════════════════════════════════════════════════

  describe('saude por empresa — idade do espelho e da copia de PCs', () => {
    it('em dia: ok nas duas empresas, lendo o espelho de cada uma', async (ctx) => {
      if (!pronto) return ctx.skip();
      for (const e of ['q2p', 'acxe'] as const) {
        expect((await svc.idadeEspelhoRecebimentos(e)).status).toBe('ok');
        expect((await svc.idadeCopiaPcs(e)).status).toBe('ok');
      }
      expect(await svc.copiaPcsDefasada('acxe')).toBe(false);
    });

    it('espelho da ACXE velho: degraded so na ACXE; a copia de PCs da ACXE velha: copiaPcsDefasada so da ACXE', async (ctx) => {
      if (!pronto) return ctx.skip();
      await q(`UPDATE public."tbl_recebimentoNFe_ACXE" SET synced_at = now() - interval '3 hours'`);
      await q(`UPDATE public."tbl_pedidosCompras_ACXE" SET data_atualizacao = now() - interval '5 hours'`);
      try {
        expect(await svc.idadeEspelhoRecebimentos('acxe')).toMatchObject({ status: 'degraded', limiteMin: 120 });
        expect((await svc.idadeEspelhoRecebimentos('acxe')).idadeMin).toBeGreaterThan(170);
        expect((await svc.idadeEspelhoRecebimentos('q2p')).status).toBe('ok');
        expect(await svc.copiaPcsDefasada('acxe')).toBe(true);
        expect(await svc.copiaPcsDefasada('q2p')).toBe(false);
        // modo seguro: a NF da ACXE abre sem PC lido da copia
        const d = await svc.getDetalheNfNacional(C.a3);
        expect(d.copiaPcsDefasada).toBe(true);
        expect(d.itens[0]!.pc!.candidatos).toEqual([]);
        // e a da Q2P segue normal
        expect((await svc.getDetalheNfNacional(C.q2)).copiaPcsDefasada).toBe(false);
      } finally {
        await q(`UPDATE public."tbl_recebimentoNFe_ACXE" SET synced_at = now()`);
        await q(`UPDATE public."tbl_pedidosCompras_ACXE" SET data_atualizacao = now()`);
      }
    });

    it('ACXE desligada: "desligado" nas duas leituras (o espelho vazio do n8n inativo nao vira alerta)', async (ctx) => {
      if (!pronto) return ctx.skip();
      configurar({ acxe: false });
      try {
        expect(await svc.idadeEspelhoRecebimentos('acxe')).toEqual({ idadeMin: null, status: 'desligado' });
        expect(await svc.idadeCopiaPcs('acxe')).toEqual({ idadeMin: null, status: 'desligado' });
        expect((await svc.idadeEspelhoRecebimentos('q2p')).status).toBe('ok');
      } finally {
        configurar();
      }
    });
  });

  // ═══ D21 da 017 — recebimento fiscal REVERTIDO no portal do OMIE ═════════════════════════════════════════════
  //
  // NF 19252 (Zaraplast, Q2P, 25/10/2026): o Atlas concluiu o fiscal as 17:02 (ledger 'concluido'), o usuario o reverteu no portal as
  // 17:13 (etapa 40, cRecebido N) e a fila seguia mostrando "fiscal ja feito" — a nota de entrada nunca sai do espelho de NF e ela tem
  // 1 das 4 linhas do recebimento. Aqui o SINAL (fiscal-revertido.ts) roda de verdade num Postgres, com as horas de EVENTO do OMIE
  // (d_alt + h_alt, horario de Brasilia) contra o instante da conclusao (ledger finalizado_em, timestamptz): margem de 2 min, fuso
  // explicito, hora malformada = sem evidencia (nunca erro de cast: um 22007 derrubaria a fila inteira), marcador do ledger estrito.
  // As NFs deste bloco sao semeadas e apagadas AQUI (os outros testes, que comparam o conjunto inteiro da fila, nao as veem); pede a
  // migration 0060 (stockbridge.recebimento_fiscal.revertido_em) — sem ela o bloco e pulado, e o codigo segue sem a D21.
  describe('fiscal REVERTIDO no OMIE (D21 da 017, NF 19252) — o sinal executado de verdade', () => {
    const K = (n: number): string => chave(700 + n);
    const R = { r1: K(1), r2: K(2), r3: K(3), r4a: K(4), r4b: K(5), r5a: K(6), r5b: K(7), r5c: K(8), r6: K(9), r7: K(10), r11: K(11), r12: K(12), r13: K(13), r14: K(14), r15: K(15), r16: K(16) };
    /** As NFs que o bloco espera ver na fila (a r11 tem a entrada fisica lancada: fica de fora; a r15 so volta com a nota de entrada). */
    const NA_FILA = [R.r1, R.r2, R.r3, R.r4a, R.r4b, R.r5a, R.r5b, R.r5c, R.r6, R.r7, R.r12, R.r13, R.r14, R.r16];
    // as 4 linhas do recebimento da 19252, em kg (a 19252 vem em toneladas; a conversao tem testes proprios): 13.750 kg, R$ 145.750,05
    const LINHAS = [
      { seq: 1, qtde: 4125, total: 43725.01 },
      { seq: 2, qtde: 1375, total: 14575.01 },
      { seq: 3, qtde: 6875, total: 72875.02 },
      { seq: 4, qtde: 1375, total: 14575.01 },
    ];
    const PC308 = { ncodped: id(1046), ncoditem: id(1047) };

    interface Cen {
      k: string;
      n: number;
      e?: Emp;
      numero: string;
      /** nota de entrada valida no espelho de NF (1 linha das 4): [d_alt, h_alt]; ausente = a NF so existe no espelho de recebimentos */
      header?: [string, string];
      receb: { recebido: 'N' | 'S'; etapa: string; dAlt: string | null; hAlt: string | null; dRec?: string; hRec?: string };
      ledger?: { status: 'concluido' | 'revertido'; finalizadoEm: string; revertidoEm?: string; origem?: 'espelho' | 'omie_ao_vivo'; omieEm?: string };
      /** c_nao_gerar_mov_estoque dos itens do recebimento (default 'S', como na 19252) */
      naoGerarMov?: 'S' | 'N';
      /** os itens do recebimento ja vinculados ao PC 308 (vinculo preservado pela reversao) */
      pc?: boolean;
      /** entrada fisica ja lancada (movimentacao ativa dos 13.750 kg) */
      fisicaLancada?: boolean;
    }

    let semeado = false;
    const ledgers: string[] = [];
    const movs: string[] = [];
    const nfs: Array<{ e: Emp; nIdNf: number; nIdReceb: number }> = [];

    async function cenario(c: Cen): Promise<void> {
      const e = c.e ?? 'q2p';
      const nIdNf = id(1100 + c.n);
      const nIdReceb = id(1200 + c.n);
      const nCodItem = id(1300 + c.n);
      const [forn, cnpj, razao, cfop] = e === 'acxe' ? [FORN.gga, CNPJ.gga, 'GGA RECICLAGEM LTDA', '1.101'] : [FORN.zaraplast, CNPJ.zaraplast, 'ZARAPLAST SA', '2.102'];
      nfs.push({ e, nIdNf, nIdReceb });
      if (c.header) {
        await nf(e, {
          nIdNf, chave: c.k, numero: c.numero, razao, cnpj, dEmi: '2026-10-20', nIdReceb, dAlt: c.header[0], hAlt: c.header[1],
          itens: [{ nCodItem, xProd: 'PEBD EB', cfop, qCom: 1375, uCom: 'KG', vProd: 14575.01, vUnCom: 10.6 }],
        });
      }
      await receb(e, {
        nIdReceb, chave: c.k, numero: c.numero, dEmissao: '2026-10-20', fornecedor: forn, cnpj, razao, recebido: c.receb.recebido, etapa: c.receb.etapa, dAlt: c.receb.dAlt, hAlt: c.receb.hAlt,
        dRec: c.receb.dRec ?? null, hRec: c.receb.hRec ?? null,
        itens: LINHAS.map((l) => ({
          seq: l.seq, descricao: 'PEBD EB', cfopEntrada: cfop, qtde: l.qtde, un: 'KG', preco: 10.6, total: l.total, nIdItem: nCodItem,
          naoGerarMov: c.naoGerarMov ?? 'S', ...(c.pc ? { nIdPedido: PC308.ncodped, nIdItPedido: PC308.ncoditem } : {}),
        })),
      });
      if (c.ledger) {
        const r = await q(
          `INSERT INTO stockbridge.recebimento_fiscal (nf_chave_acesso, nota_fiscal, status, confirmado_por, empresa, finalizado_em, itens_total, revertido_em, revertido_origem, revertido_omie_em)
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9) RETURNING id`,
          [c.k, c.numero, c.ledger.status, usuario, e, c.ledger.finalizadoEm, c.ledger.revertidoEm ?? null, c.ledger.origem ?? null, c.ledger.omieEm ?? null],
        );
        ledgers.push(String(r.rows[0]!.id));
      }
      if (c.fisicaLancada) {
        const m = await q(
          `INSERT INTO stockbridge.movimentacao (nota_fiscal, tipo_movimento, subtipo, quantidade_kg, empresa, galpao, produto_codigo_q2p, status_omie, ativo,
              nf_chave_acesso, nf_item_descricao, nf_item_descricao_normalizada, nf_item_sequencias, quantidade_nf_kg)
           VALUES ($1, 'entrada_manual', 'compra_nacional', 13750, 'q2p', '11.2', $2, 'concluida', true, $3, 'PEBD EB', 'PEBD EB', ARRAY[1,2,3,4], 13750) RETURNING id`,
          [c.numero, id(98), c.k],
        );
        movs.push(String(m.rows[0]!.id));
      }
    }

    // Conclusao 25/10 17:02:01 (Brasilia) = 20:02:01Z; reversao no portal 17:13:36. As outras NFs: conclusao 24/10 12:00:00 = 15:00:00Z.
    const CONCLUIDO_19252 = '2026-10-25T20:02:01Z';
    const CONCLUIDO_24 = '2026-10-24T15:00:00Z';

    beforeAll(async () => {
      if (!pronto) return;
      const col = await q(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'stockbridge' AND table_name = 'recebimento_fiscal' AND column_name = 'revertido_em'`);
      if (col.rows.length === 0) {
        console.warn('[fila-nacional-acxe-db] D21 pulada: schema stockbridge sem a migration 0060 (recebimento_fiscal.revertido_em)');
        return;
      }
      // PC 308 da Zaraplast (Q2P): o vinculo que a reversao preserva nos itens da 19252
      await pc('q2p', { ncodped: PC308.ncodped, ncoditem: PC308.ncoditem, numero: '308', fornecedor: FORN.zaraplast, qtde: 13750, preco: 10.6, produto: id(1062), local: '8115873874', descricao: 'PEBD EB' });
      // R1 — a 19252: ledger concluido 17:02:01, nota de entrada valida (1 linha), recebimento N/40 alterado as 17:13:36 (11 min depois)
      await cenario({ k: R.r1, n: 1, numero: '19252', header: ['2026-10-25', '17:02:00'], receb: { recebido: 'N', etapa: '40', dAlt: '2026-10-25', hAlt: '17:13:36' }, ledger: { status: 'concluido', finalizadoEm: CONCLUIDO_19252 }, pc: true });
      // R2 — revertida PELO MARCADOR (leitura ao vivo do clique) com a linha do espelho ainda 'S'/etapa 60 e "estoque lancado" aparente
      await cenario({
        k: R.r2, n: 2, numero: '19253', header: ['2026-10-25', '17:02:00'], receb: { recebido: 'S', etapa: '60', dAlt: '2026-10-25', hAlt: '17:02:00' }, naoGerarMov: 'N',
        ledger: { status: 'revertido', finalizadoEm: CONCLUIDO_19252, revertidoEm: '2026-10-25T20:20:00Z', origem: 'omie_ao_vivo' },
      });
      // R3 — NAO revertida: o espelho confirma a conclusao (S/60, mesma hora)
      await cenario({ k: R.r3, n: 3, numero: '19254', header: ['2026-10-25', '17:02:00'], receb: { recebido: 'S', etapa: '60', dAlt: '2026-10-25', hAlt: '17:02:00' }, ledger: { status: 'concluido', finalizadoEm: CONCLUIDO_19252 } });
      // R4 — a margem de 2 min do sinal pelo espelho: 1m59s depois da conclusao NAO marca; 2m01s marca
      await cenario({ k: R.r4a, n: 4, numero: '19255', receb: { recebido: 'N', etapa: '40', dAlt: '2026-10-24', hAlt: '12:01:59' }, ledger: { status: 'concluido', finalizadoEm: CONCLUIDO_24 } });
      await cenario({ k: R.r4b, n: 5, numero: '19256', receb: { recebido: 'N', etapa: '40', dAlt: '2026-10-24', hAlt: '12:02:01' }, ledger: { status: 'concluido', finalizadoEm: CONCLUIDO_24 } });
      // R5 — hora de alteracao ausente ou malformada: sem evidencia, NUNCA erro de cast que derrube a fila
      await cenario({ k: R.r5a, n: 6, numero: '19257', receb: { recebido: 'N', etapa: '40', dAlt: '2026-10-24', hAlt: null }, ledger: { status: 'concluido', finalizadoEm: CONCLUIDO_24 } });
      await cenario({ k: R.r5b, n: 7, numero: '19258', receb: { recebido: 'N', etapa: '40', dAlt: '2026-10-24', hAlt: '' }, ledger: { status: 'concluido', finalizadoEm: CONCLUIDO_24 } });
      await cenario({ k: R.r5c, n: 8, numero: '19259', receb: { recebido: 'N', etapa: '40', dAlt: '2026-10-24', hAlt: '25:61' }, ledger: { status: 'concluido', finalizadoEm: CONCLUIDO_24 } });
      // R6 — o fiscal reconcluiu no portal DEPOIS do marcador (S/60 as 12:05, marcador 12:03): a conclusao mais nova desliga o sinal
      await cenario({
        k: R.r6, n: 9, numero: '19260', header: ['2026-10-24', '12:05:00'], receb: { recebido: 'S', etapa: '60', dAlt: '2026-10-24', hAlt: '12:05:00' },
        ledger: { status: 'revertido', finalizadoEm: CONCLUIDO_24, revertidoEm: '2026-10-24T15:03:00Z', origem: 'espelho' },
      });
      // R7 — o equivalente na ACXE (o sinal le o espelho da ACXE)
      await cenario({ k: R.r7, n: 10, e: 'acxe', numero: '19261', header: ['2026-10-24', '12:00:00'], receb: { recebido: 'N', etapa: '40', dAlt: '2026-10-24', hAlt: '12:11:00' }, ledger: { status: 'concluido', finalizadoEm: CONCLUIDO_24 } });
      // R11 — revertida, mas a entrada fisica ja foi lancada: nao volta a fila (nada a receber), o detalhe ainda avisa
      await cenario({ k: R.r11, n: 11, numero: '19262', header: ['2026-10-25', '17:02:00'], receb: { recebido: 'N', etapa: '40', dAlt: '2026-10-25', hAlt: '17:13:36' }, ledger: { status: 'concluido', finalizadoEm: CONCLUIDO_19252 }, fisicaLancada: true });
      // R12 — espelho N com hora ANTERIOR a conclusao (linha defasada de antes do Concluir): nao marca
      await cenario({ k: R.r12, n: 12, numero: '19263', receb: { recebido: 'N', etapa: '40', dAlt: '2026-10-24', hAlt: '11:30:00' }, ledger: { status: 'concluido', finalizadoEm: CONCLUIDO_24 } });
      // R13 — marcador (leitura ao vivo) com a linha do espelho ainda N de ANTES da conclusao: a hora mostrada e a do marcador, nunca a antiga
      await cenario({
        k: R.r13, n: 13, numero: '19264', header: ['2026-10-24', '12:00:00'], receb: { recebido: 'N', etapa: '40', dAlt: '2026-10-24', hAlt: '11:30:00' },
        ledger: { status: 'revertido', finalizadoEm: CONCLUIDO_24, revertidoEm: '2026-10-24T15:10:00Z', origem: 'omie_ao_vivo' },
      });
      // R14 — o fiscal reverteu (12:13:36) e RECONCLUIU no portal (12:28) ANTES de o Atlas perceber: a varredura so marcou as 12:35
      // (revertido_em), com a hora do OMIE da reversao (revertido_omie_em 12:13:36). O recebimento volta 'S' com d_alt na hora da
      // reversao (concluir nao mexe em d_alt) e d_rec 12:28; a nota de entrada nova e das 12:28. A reconclusao desliga o sinal
      await cenario({
        k: R.r14, n: 14, numero: '19265', header: ['2026-10-24', '12:28:00'],
        receb: { recebido: 'S', etapa: '60', dAlt: '2026-10-24', hAlt: '12:13:36', dRec: '2026-10-24', hRec: '12:28:10' },
        ledger: { status: 'revertido', finalizadoEm: CONCLUIDO_24, revertidoEm: '2026-10-24T15:35:00Z', origem: 'espelho', omieEm: '2026-10-24T15:13:36Z' },
      });
      // R15 — o mesmo, sem a nota de entrada no espelho de NF ainda: so o recebimento 'S' (pelo d_rec) prova a reconclusao
      await cenario({
        k: R.r15, n: 15, numero: '19266',
        receb: { recebido: 'S', etapa: '60', dAlt: '2026-10-24', hAlt: '12:13:36', dRec: '2026-10-24', hRec: '12:28:10' },
        ledger: { status: 'revertido', finalizadoEm: CONCLUIDO_24, revertidoEm: '2026-10-24T15:35:00Z', origem: 'espelho', omieEm: '2026-10-24T15:13:36Z' },
      });
      // R16 — duas reversoes: a 1a (12:03) marcada pelo espelho com a hora do OMIE; o Atlas concluiu de novo (13:00) e a 2a reversao so
      // foi percebida pela leitura ao vivo do clique (13:20), antes do sync — o espelho ainda traz o 'S' da 2a conclusao (d_rec 13:00:05)
      await cenario({
        k: R.r16, n: 16, numero: '19267', header: ['2026-10-24', '13:00:05'],
        receb: { recebido: 'S', etapa: '60', dAlt: '2026-10-24', hAlt: '12:03:00', dRec: '2026-10-24', hRec: '13:00:05' },
        ledger: { status: 'revertido', finalizadoEm: CONCLUIDO_24, revertidoEm: '2026-10-24T15:05:00Z', origem: 'espelho', omieEm: '2026-10-24T15:03:00Z' },
      });
      const b = await q(
        `INSERT INTO stockbridge.recebimento_fiscal (nf_chave_acesso, nota_fiscal, status, confirmado_por, empresa, finalizado_em, itens_total, revertido_em, revertido_origem)
         VALUES ($1, '19267', 'revertido', $2, 'q2p', '2026-10-24T16:00:00Z', 1, '2026-10-24T16:20:00Z', 'omie_ao_vivo') RETURNING id`,
        [R.r16, usuario],
      );
      ledgers.push(String(b.rows[0]!.id));
      semeado = true;
    }, 60_000);

    afterAll(async () => {
      if (!pool) return;
      const apagar = async (sql: string, params?: unknown[]) => {
        try {
          await q(sql, params);
        } catch {
          /* limpeza em melhor esforco */
        }
      };
      await apagar(`DELETE FROM stockbridge.movimentacao WHERE id = ANY($1::uuid[])`, [movs]);
      await apagar(`DELETE FROM stockbridge.recebimento_fiscal WHERE id = ANY($1::uuid[])`, [ledgers]);
      for (const e of ['q2p', 'acxe'] as const) {
        const meus = nfs.filter((x) => x.e === e);
        await apagar(`DELETE FROM public."${tab('tbl_recebimentoNFe', e)}" WHERE n_id_receb = ANY($1::bigint[])`, [meus.map((x) => x.nIdReceb)]); // itens em cascata
        await apagar(`DELETE FROM public."${tab('tbl_nf_itens', e)}" WHERE n_id_nf = ANY($1::bigint[])`, [meus.map((x) => x.nIdNf)]);
        await apagar(`DELETE FROM public."${tab('tbl_nf_header', e)}" WHERE n_id_nf = ANY($1::bigint[])`, [meus.map((x) => x.nIdNf)]);
      }
      await apagar(`DELETE FROM public."${tab('tbl_pedidosCompras', 'q2p')}" WHERE ncodped = $1`, [PC308.ncodped]);
    });

    const daFila = async (opts: Parameters<typeof svc.getFilaNacional>[0] = {}) =>
      Object.fromEntries(doTeste(await svc.getFilaNacional(opts)).map((f) => [f.nfChaveAcesso, f]));
    /** Os ledgers da NF: status[:origem][@revertido_omie_em], na ordem em que foram finalizados. */
    const estadoLedger = async (k: string): Promise<string[]> =>
      (await q(`SELECT status, revertido_origem, revertido_omie_em FROM stockbridge.recebimento_fiscal WHERE nf_chave_acesso = $1 ORDER BY finalizado_em`, [k])).rows.map(
        (x) => `${x.status}${x.revertido_origem ? `:${x.revertido_origem}` : ''}${x.revertido_omie_em ? `@${new Date(x.revertido_omie_em as string).toISOString()}` : ''}`,
      );
    const voltarLedgerParaConcluido = (k: string) =>
      q(
        `UPDATE stockbridge.recebimento_fiscal SET status = 'concluido', revertido_em = NULL, revertido_origem = NULL, revertido_omie_em = NULL, revertido_por = NULL
          WHERE nf_chave_acesso = $1`,
        [k],
      );

    it('R1 — a 19252: ledger concluido, nota de entrada valida com 1 linha, recebimento N/40 11 min depois -> a fila a mostra como fiscal PENDENTE + revertida, com as 4 linhas (R$ 145.750,05)', async (ctx) => {
      if (!semeado) return ctx.skip();
      const f = (await daFila())[R.r1]!;
      expect(f).toMatchObject({
        empresa: 'q2p', notaFiscal: '19252', fiscal: 'pendente', fiscalRevertido: true, fiscalConcluidoPeloAtlasEm: null,
        itensTotal: 1, itensPendentes: 1, estoqueLancadoPeloOmie: false, pcSituacao: 'vinculado_omie',
      });
      expect(f.valorTotalBrl).toBeCloseTo(145750.05, 2); // as 4 linhas do recebimento — a nota de entrada so tem 1 (R$ 14.575,01)
      // a listagem ja marca a tentativa antiga (ainda 'concluido') de cada NF revertida da pagina, antes do selo do PC, no espelho da
      // empresa da NF e com a hora do OMIE; as nao revertidas seguem 'concluido'
      expect(await estadoLedger(R.r1)).toEqual(['revertido:espelho@2026-10-25T20:13:36.000Z']);
      expect(await estadoLedger(R.r4b)).toEqual(['revertido:espelho@2026-10-24T15:02:01.000Z']);
      expect(await estadoLedger(R.r7)).toEqual(['revertido:espelho@2026-10-24T15:11:00.000Z']);
      for (const k of [R.r3, R.r4a, R.r5a, R.r12]) expect(await estadoLedger(k), k).toEqual(['concluido']);
    });

    it('R1 — o detalhe: 4 linhas (13.750 kg), vinculo do OMIE com o PC 308 preservado, fornecedor, e a hora da reversao no OMIE (17:13:36 de Brasilia)', async (ctx) => {
      if (!semeado) return ctx.skip();
      // a listagem acima ja marcou a tentativa antiga: volta ao estado da fixture para o detalhe marcar por conta propria
      await voltarLedgerParaConcluido(R.r1);
      const d = await svc.getDetalheNfNacional(R.r1);
      expect(d).toMatchObject({ empresa: 'q2p', notaFiscal: '19252', fiscal: 'pendente', fiscalRevertido: true, fiscalRevertidoEm: '2026-10-25T20:13:36.000Z', dispensavel: true, estoqueLancadoPeloOmie: false });
      expect(d.itens).toHaveLength(1);
      expect(d.itens[0]).toMatchObject({ linhasAgregadas: 4, jaRecebido: false, sequenciasRecebimento: [1, 2, 3, 4] });
      expect(d.itens[0]!.quantidadeNfKg).toBeCloseTo(13750, 3);
      expect(d.itens[0]!.pc!.vinculoOmie).toMatchObject({ pcNumero: '308', dentroTolerancia: true });
      const { interno } = await svc.montarDetalheNfNacional(R.r1);
      expect(interno.fornecedorCodigo).toBe(FORN.zaraplast); // so a fonte (b) traz o fornecedor: a nota de entrada nao
      // abrir a NF revertida marcou a tentativa antiga (ainda 'concluido'): os vinculos dela saem do saldo do PC da sugestao
      const l = await q(`SELECT status, revertido_origem, revertido_omie_em FROM stockbridge.recebimento_fiscal WHERE nf_chave_acesso = $1`, [R.r1]);
      expect(l.rows).toHaveLength(1);
      expect(l.rows[0]).toMatchObject({ status: 'revertido', revertido_origem: 'espelho' });
      expect(new Date(l.rows[0]!.revertido_omie_em as string).toISOString()).toBe('2026-10-25T20:13:36.000Z');
    });

    it('R1 — CONTROLE: com a D21 desligada (kill switch) o defeito da 19252 reaparece: fiscal ja feito, 1 linha, com a data do ledger', async (ctx) => {
      if (!semeado) return ctx.skip();
      // o detalhe aberto antes marcou a tentativa como revertida: volta ao estado da fixture (ledger 'concluido')
      await voltarLedgerParaConcluido(R.r1);
      configurar({ revertido: false });
      try {
        const f = (await daFila())[R.r1]!;
        expect(f).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false, fiscalConcluidoPeloAtlasEm: '2026-10-25T20:02:01.000Z' });
        expect(f.valorTotalBrl).toBeCloseTo(14575.01, 2); // so a linha da nota de entrada
        expect(await svc.getDetalheNfNacional(R.r1)).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false, fiscalRevertidoEm: null });
      } finally {
        configurar();
      }
    });

    it('R2 — revertida PELO MARCADOR do ledger com a linha do espelho ainda S/60: fiscal pendente + revertida; a linha "S" sem "nao movimentar estoque" NAO e estoque lancado; sem hora do OMIE (leitura ao vivo), o banner fica sem hora', async (ctx) => {
      if (!semeado) return ctx.skip();
      const f = (await daFila())[R.r2]!;
      expect(f).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true, fiscalConcluidoPeloAtlasEm: null, estoqueLancadoPeloOmie: false });
      const d = await svc.getDetalheNfNacional(R.r2);
      // a hora do clique (20:20) nao e a da reversao: sem a hora do OMIE, nula
      expect(d).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true, estoqueLancadoPeloOmie: false, fiscalRevertidoEm: null });
      // controle: a MESMA linha de uma NF de fiscal concluido no portal COM movimento de estoque (A4) segue bloqueando
      expect((await svc.getDetalheNfNacional(C.a4)).estoqueLancadoPeloOmie).toBe(true);
    });

    it('R3 — NAO revertida (o espelho confirma a conclusao, S/60 na mesma hora): igual a hoje — fiscal concluido, com a data do Atlas', async (ctx) => {
      if (!semeado) return ctx.skip();
      const f = (await daFila())[R.r3]!;
      expect(f).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false, fiscalConcluidoPeloAtlasEm: '2026-10-25T20:02:01.000Z' });
      expect(await svc.getDetalheNfNacional(R.r3)).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false, fiscalRevertidoEm: null });
    });

    it('R4 — margem de 2 min: espelho N 1m59s depois da conclusao NAO marca; 2m01s depois marca', async (ctx) => {
      if (!semeado) return ctx.skip();
      const por = await daFila();
      expect(por[R.r4a]).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false });
      expect(por[R.r4b]).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true });
      expect((await svc.getDetalheNfNacional(R.r4b)).fiscalRevertidoEm).toBe('2026-10-24T15:02:01.000Z');
    });

    it('R5 — hora de alteracao NULL, vazia ou malformada (25:61): nao marca e NAO derruba a fila (sem erro de cast)', async (ctx) => {
      if (!semeado) return ctx.skip();
      const por = await daFila();
      for (const k of [R.r5a, R.r5b, R.r5c]) expect(por[k], k).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false });
      for (const k of [R.r5a, R.r5b, R.r5c]) expect(await svc.getDetalheNfNacional(k), k).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false });
    });

    it('R6 — o fiscal reconcluiu no portal DEPOIS do marcador (S/60 as 12:05, marcador 12:03): a conclusao mais nova desliga o sinal', async (ctx) => {
      if (!semeado) return ctx.skip();
      expect((await daFila())[R.r6]).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false });
    });

    it('R14 — reconclusao no portal ANTES de o Atlas perceber a reversao: o marcador vale pela hora do OMIE e a reconclusao desliga o sinal (fiscal ja feito)', async (ctx) => {
      if (!semeado) return ctx.skip();
      expect((await daFila())[R.r14]).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false });
      expect(await svc.getDetalheNfNacional(R.r14)).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false, fiscalRevertidoEm: null });
    });

    it('R15 — o mesmo sem a nota de entrada no espelho de NF: o recebimento S (d_rec) desliga o sinal; a NF so volta a fila com a nota de entrada', async (ctx) => {
      if (!semeado) return ctx.skip();
      const { fiscalRevertidoSql } = await import('../services/fiscal-revertido.js');
      const sinal = await q(`SELECT ${fiscalRevertidoSql('$1::text', 'q2p')} AS rev`, [R.r15]);
      expect(sinal.rows[0]!.rev).toBe(false);
      expect((await daFila())[R.r15]).toBeUndefined();
    });

    it('R7 — ACXE: o sinal le o espelho da ACXE — fiscal pendente + revertida, e a hora vem das tabelas da ACXE', async (ctx) => {
      if (!semeado) return ctx.skip();
      const f = (await daFila())[R.r7]!;
      expect(f).toMatchObject({ empresa: 'acxe', notaFiscal: '19261', fiscal: 'pendente', fiscalRevertido: true });
      expect(f.valorTotalBrl).toBeCloseTo(145750.05, 2);
      expect(await svc.getDetalheNfNacional(R.r7)).toMatchObject({ empresa: 'acxe', fiscal: 'pendente', fiscalRevertido: true, fiscalRevertidoEm: '2026-10-24T15:11:00.000Z' });
      // restringindo a fila a uma empresa o resultado e o mesmo
      expect((await daFila({ empresa: 'acxe' }))[R.r7]).toMatchObject({ fiscalRevertido: true });
      expect((await daFila({ empresa: 'q2p' }))[R.r7]).toBeUndefined();
    });

    it('R11 — revertida com a entrada fisica ja lancada: sai da fila (nada a receber), mas o detalhe responde com fiscalRevertido para a tela avisar o fiscal', async (ctx) => {
      if (!semeado) return ctx.skip();
      expect(chaves(await svc.getFilaNacional())).not.toContain(R.r11);
      const d = await svc.getDetalheNfNacional(R.r11);
      expect(d).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true, dispensavel: false });
      expect(d.itens[0]).toMatchObject({ jaRecebido: true, quantidadeNfJaAtribuidaKg: 13750, quantidadeRestanteKg: 0 });
    });

    it('R12 — espelho N com hora ANTERIOR a conclusao (linha defasada de antes do Concluir): nao marca', async (ctx) => {
      if (!semeado) return ctx.skip();
      expect((await daFila())[R.r12]).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false });
    });

    it('R13 — marcador do clique + espelho ainda N de ANTES da conclusao: revertida; a hora nunca e a do N antigo (11:30) nem a do clique (12:10): fica nula ate o espelho trazer a do OMIE', async (ctx) => {
      if (!semeado) return ctx.skip();
      expect((await daFila())[R.r13]).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true });
      expect((await svc.getDetalheNfNacional(R.r13)).fiscalRevertidoEm).toBeNull();
    });

    it('R16 — duas reversoes, a ultima percebida so pela leitura ao vivo: revertida, e a hora fica nula — nunca a da 1a reversao (12:03), anterior a conclusao desfeita depois', async (ctx) => {
      if (!semeado) return ctx.skip();
      expect((await daFila())[R.r16]).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true });
      expect(await svc.getDetalheNfNacional(R.r16)).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true, fiscalRevertidoEm: null });
      // nada a marcar: as duas tentativas ja estao 'revertido'
      expect(await estadoLedger(R.r16)).toEqual(['revertido:espelho@2026-10-24T15:03:00.000Z', 'revertido:omie_ao_vivo']);
    });

    it('o conjunto do bloco na fila: exatamente as NFs esperadas (a r11 fica de fora), e SO as revertidas viram pendente + fiscalRevertido', async (ctx) => {
      if (!semeado) return ctx.skip();
      const meus = (await svc.getFilaNacional()).filter((f) => Object.values(R).includes(f.nfChaveAcesso));
      expect(meus.map((f) => f.nfChaveAcesso).sort()).toEqual([...NA_FILA].sort());
      expect(meus.filter((f) => f.fiscalRevertido).map((f) => f.nfChaveAcesso).sort()).toEqual([R.r1, R.r2, R.r4b, R.r7, R.r13, R.r16].sort());
      // toda NF revertida e fiscal pendente (a tela compara fiscal === 'pendente'); nenhuma outra e
      for (const f of meus) expect(f.fiscal === 'pendente' && f.fiscalRevertido === true || !f.fiscalRevertido, f.nfChaveAcesso).toBe(true);
    });

    it('o resto da fila nao mudou: nenhuma NF dos cenarios de antes virou revertida (conjunto exato e fiscalRevertido false)', async (ctx) => {
      if (!semeado) return ctx.skip();
      const outras = doTeste(await svc.getFilaNacional()).filter((f) => !Object.values(R).includes(f.nfChaveAcesso));
      expect(outras.map((f) => f.nfChaveAcesso)).toEqual(ESPERADA_AMBAS);
      for (const f of outras) expect(f.fiscalRevertido, f.nfChaveAcesso).toBe(false);
    });

    it('sem a chave da 016 (ou com ela e a D21 desligada) nenhuma NF vem como revertida e a fila nao pergunta pelo sinal', async (ctx) => {
      if (!semeado) return ctx.skip();
      for (const opts of [{ fiscal: false }, { revertido: false }]) {
        configurar(opts);
        try {
          const fila = await svc.getFilaNacional();
          expect(fila.every((f) => f.fiscalRevertido === false)).toBe(true);
          if (opts.fiscal === false) expect(chaves(fila)).not.toContain(R.r7); // sem a 016 a ACXE nem entra
        } finally {
          configurar();
        }
      }
    });

    it('fuso: o sinal e o mesmo com a sessao em UTC, em America/Sao_Paulo ou em Asia/Tokyo (as horas do OMIE sao de Brasilia, convertidas de forma explicita)', async (ctx) => {
      if (!semeado) return ctx.skip();
      const { fiscalRevertidoSql } = await import('../services/fiscal-revertido.js');
      const pool2 = core.getPool() as unknown as { connect: () => Promise<{ query: Pool['query']; release: () => void }> };
      const client = await pool2.connect();
      try {
        for (const tz of ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo']) {
          await client.query(`SET TIME ZONE '${tz}'`);
          const rev = async (k: string, e: Emp) => (await client.query(`SELECT ${fiscalRevertidoSql('$1::text', e)} AS rev`, [k])).rows[0]!.rev;
          expect(await rev(R.r1, 'q2p'), `${tz} r1`).toBe(true);
          expect(await rev(R.r4a, 'q2p'), `${tz} r4a`).toBe(false);
          expect(await rev(R.r4b, 'q2p'), `${tz} r4b`).toBe(true);
          expect(await rev(R.r3, 'q2p'), `${tz} r3`).toBe(false);
          expect(await rev(R.r7, 'acxe'), `${tz} r7`).toBe(true);
        }
      } finally {
        await client.query('RESET TIME ZONE');
        client.release();
      }
    });

    it('nfComFiscalRevertido (usado pelo adquirirLedger e pela leitura do clique) avalia o MESMO sinal; chave desconhecida = false', async (ctx) => {
      if (!semeado) return ctx.skip();
      const rv = await import('../services/fiscal-revertido.js');
      expect(await rv.nfComFiscalRevertido(R.r1, 'q2p')).toBe(true);
      expect(await rv.nfComFiscalRevertido(R.r13, 'q2p')).toBe(true);
      expect(await rv.nfComFiscalRevertido(R.r3, 'q2p')).toBe(false);
      expect(await rv.nfComFiscalRevertido(R.r6, 'q2p')).toBe(false);
      expect(await rv.nfComFiscalRevertido(R.r7, 'acxe')).toBe(true);
      expect(await rv.nfComFiscalRevertido(chave(799), 'q2p')).toBe(false);
    });
  });
});
