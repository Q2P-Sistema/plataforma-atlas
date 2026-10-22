import { getPool, getConfig, createLogger } from '@atlas/core';
import { fmtCnpj, raizCnpj } from './cnpj.js';
import { consultarPedidoCompra, type PedidoCompraConsultado } from '@atlas/integration-omie';
import { CNPJ_ACXE_NUMERICO } from '../types.js';

const logger = createLogger('stockbridge:pc-sugestao');

/**
 * Sugestao de pedido de compra (PC) por item da NF nacional — feature 017
 * (ACXEGDP-437, research D3/D5/D6, data-model §8).
 *
 * Desde 19/10/2026 compras lanca PC no OMIE para a compra nacional. Ao concluir o
 * fiscal pelo Atlas, cada item precisa ficar vinculado ao item de PC certo (a
 * receita da 016, com IGNORAR, desfazia o vinculo). Este servico monta, para cada
 * item AGREGADO da NF (linhas de mesma descricao — D18/D20 da 015), o que o
 * operador pode escolher:
 *  - o VINCULO DO OMIE: o recebimento ja chega com o item associado a um item de
 *    PC (espelho de recebimentos, colunas da 0056) — sugestao principal (FR-000);
 *  - CANDIDATOS: PCs do mesmo fornecedor, etapa 15, quantidade ate X% acima do
 *    saldo e preco por kg ate Y% do preco do PC (FR-002);
 *  - OUTROS DO FORNECEDOR: etapa 15 com saldo, fora da tolerancia — escolha manual
 *    com justificativa (FR-002a);
 *  - AGUARDANDO APROVACAO: etapa 10 — visiveis, nao selecionaveis (FR-002b).
 *
 * Le SO o Postgres (Principio II): a copia `tbl_pedidosCompras_<empresa>` (n8n
 * Rev 1.5, agenda de 10 min + aviso por evento) e o ledger de vinculos do Atlas.
 * A releitura AO VIVO do PC acontece so no POST, imediatamente antes de escrever
 * (relerEReservarPcs, research D4). A descricao do item nunca entra na regra
 * (FR-004): a NF diz "SUCATA PLASTICO", o PC diz "PS CRISTAL B".
 *
 * Quem chama (fila/detalhe/portao 1) decide o modo seguro da copia defasada (D13)
 * ANTES de chamar — este modulo nao importa a fila, para nao criar ciclo.
 */

export type EmpresaPc = 'q2p' | 'acxe';

/** Situacao do PC da NF na fila — pior caso entre os itens a receber (data-model §8). */
export type PcSituacaoNf = 'vinculado_omie' | 'sugerido' | 'escolha_necessaria' | 'aguardando_aprovacao' | 'sem_pc' | 'nao_aplicavel';
export type PcSituacaoItem = Exclude<PcSituacaoNf, 'nao_aplicavel'>;

export interface PcCandidato {
  /** id do PC no OMIE — so identificador de selecao, NUNCA texto na tela (ACXEGDP-313) */
  nCodPed: number;
  nCodItem: number;
  /** numero legivel do PC ("304"); '' quando o OMIE nao informa e o PC nao esta na copia */
  pcNumero: string;
  /** produto do PC (referencia; nao substitui a correlacao do fisico — FR-017) */
  produtoDescricao: string;
  qtdPedidaKg: number;
  /** saldo a receber em kg: (nqtde - nqtderec) da copia, menos vinculos do Atlas que a copia ainda nao viu e reservas de outras NFs */
  saldoKg: number;
  /** R$/kg do PC (nvalunit em KG, ou /1000 em T/TON) */
  precoUnit: number;
  /**
   * R$/kg da NF na base usada na comparacao com este PC: o preco comercial ou o
   * valor do item por kg, o que ficar mais perto do PC (research D3). null sem preco.
   */
  precoNfKgComparado: number | null;
  dtPrevisao: string | null;
  /** '15' aprovado, '10' aguardando aprovacao; outra etapa so aparece num vinculo do OMIE (com alerta) */
  etapa: string;
  dentroTolerancia: boolean;
  /** o numero do pedido informado na NF (itensInfoAdic.nNumPedCompra) e o numero deste PC */
  casaNumeroPedidoNf: boolean;
  /** true so no vinculo do OMIE cujo PC nao esta na copia: produto, saldo e preco desconhecidos (nao comparado) */
  semDadosLocais: boolean;
  motivo: string;
}

export interface PcDoItem {
  vinculoOmie: PcCandidato | null;
  /** false = o vinculo do OMIE aparece mas nao pode ser mantido (ex.: PC-espelho da importacao) */
  vinculoOmieElegivel: boolean;
  alertaVinculoOmie: string | null;
  /** linhas do item vinculadas a PCs diferentes no OMIE: vinculoOmie null, alerta preenchido; qualquer escolha e troca (justificativa) */
  vinculosDivergentes: boolean;
  candidatos: PcCandidato[];
  outrosDoFornecedor: PcCandidato[];
  aguardandoAprovacao: PcCandidato[];
  preSelecionado: { nCodPed: number; nCodItem: number } | null;
  semPcMotivo: string | null;
  /** NF com fiscal ja feito: PC vinculado a vista (FR-021) */
  vinculadoNoOmie: { pcNumero: string } | null;
}

/** Motivo interno de "sem PC possivel" — vira o `motivo` do aviso a compras (D6). */
export type MotivoSemPc = 'sem_pc' | 'pc_aguardando_aprovacao' | 'vinculo_invalido' | 'unidade';

/** PC aprovado e com saldo lancado em OUTRO cadastro do OMIE com a mesma raiz de CNPJ do fornecedor da NF. */
export interface PcOutroCadastro {
  pcNumero: string;
  /** CNPJ do cadastro do PC, so digitos */
  cnpjCadastroPc: string;
}

export interface ResultadoPcItem {
  pc: PcDoItem;
  /** existe PC possivel (definicao antes do FR-019): vinculo do OMIE elegivel, candidato ou outro do fornecedor */
  possivel: boolean;
  motivoSemPc: MotivoSemPc | null;
  situacao: PcSituacaoItem;
  /**
   * PCs da mesma empresa (raiz do CNPJ) lancados em outro cadastro do OMIE — nao
   * sao oferecidos (FR-002a: mesmo fornecedor = mesmo cadastro; NF 60199 x PC 306,
   * Zaraplast filial x matriz), so citados no motivo e no aviso a compras.
   */
  pcsOutroCadastro: PcOutroCadastro[];
}

/** Vinculo do OMIE de UMA linha (sequencia) do item agregado. */
export interface VinculoLinhaOmie {
  nSequencia: number;
  nIdPedido: number;
  nIdItPedido: number | null;
}

export interface ItemParaSugestao {
  indice: number;
  descricao: string;
  /** quantidade do item agregado em kg; null = unidade nao conversivel (sem sugestao) */
  quantidadeKg: number | null;
  /** preco COMERCIAL por kg (Σ preco comercial × qtd ÷ Σ kg); null quando alguma linha nao tem preco */
  precoNfKg: number | null;
  /** valor do item por kg (Σ valor do item, com tributos ÷ Σ kg) — segunda base de preco (D3); null sem valor */
  precoItemKg: number | null;
  /**
   * itensInfoAdic.nNumPedCompra de alguma linha do item: o pedido que o FORNECEDOR
   * informou no XML (xPed). So ordena candidatos (FR-003) — NAO e o vinculo: vem
   * tambem em NF sem PC ("0", numero do pedido do proprio fornecedor). Vinculo =
   * n_id_pedido (sessao n8n de 21/10/2026).
   */
  numeroPedidoNf: string | null;
  /** so as linhas COM vinculo no OMIE (n_id_pedido > 0) */
  vinculos: VinculoLinhaOmie[];
  sequencias: number[];
  /** kg de cada sequencia (linha) do item — a reserva e gravada por sequencia */
  kgPorSequencia: Record<number, number>;
}

export interface ToleranciasPc {
  /** fracao (0,02 = 2%) */
  qtd: number;
  preco: number;
}

export function toleranciasPc(): ToleranciasPc {
  const cfg = getConfig() as { STOCKBRIDGE_PC_TOLERANCIA_QTD_PCT?: number; STOCKBRIDGE_PC_TOLERANCIA_PRECO_PCT?: number };
  const pct = (v: unknown, padrao: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n / 100 : padrao / 100;
  };
  return { qtd: pct(cfg.STOCKBRIDGE_PC_TOLERANCIA_QTD_PCT, 2), preco: pct(cfg.STOCKBRIDGE_PC_TOLERANCIA_PRECO_PCT, 1) };
}

/** STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC (default true): NF com item sem PC possivel e bloqueada (D6). */
export function exigePcHabilitado(): boolean {
  const cfg = getConfig() as { STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC?: boolean };
  return cfg.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC !== false;
}

/** Validade de uma reserva (linha confirmado/associado) — a mesma do lock fiscal orfao (LOCK_FISCAL_ORFAO_MIN da 016). */
export const RESERVA_PC_VALIDADE_MIN = 15;

/** PC-espelho da importacao: fornecedor ACXE com valor total abaixo disto (FR-005). */
export const PC_ESPELHO_VALOR_MAX_BRL = 200;

// ── Copia de PCs ────────────────────────────────────────────────────────────

/** Uma linha (item de PC) da copia local, ja em kg. */
export interface PcCopia {
  nCodPed: number;
  nCodItem: number;
  pcNumero: string;
  etapa: string;
  nCodFor: number;
  produtoDescricao: string;
  qtdPedidaKg: number;
  /** (nqtde - nqtderec) em kg, como a copia mostra */
  saldoCopiaKg: number;
  /** R$/kg; null quando a unidade do PC nao e KG/T/TON */
  precoKg: number | null;
  unidade: string;
  dtPrevisao: string | null;
  /** epoch ms da ultima sincronizacao da linha */
  atualizadoEmMs: number;
  /** fornecedor ACXE com valor total < R$ 200 (FR-005) */
  pcEspelho: boolean;
  /** CNPJ do cadastro do fornecedor do PC, so digitos ('' sem cadastro) */
  cnpjCadastro: string;
  /** 8 primeiros digitos do CNPJ (empresa); null para CPF ou cadastro sem CNPJ */
  raizCnpj: string | null;
}

/** Vinculo gravado pelo Atlas que pesa no saldo (concluido depois do sync, ou reserva viva de outra NF). */
export interface UsoPcAtlas {
  nCodItemPed: number;
  nfChaveAcesso: string;
  status: 'confirmado' | 'associado' | 'concluido';
  qtdKg: number;
  /** epoch ms: concluido_em (concluido) ou confirmado_em (reserva) */
  emMs: number;
}

export interface ContextoPc {
  pcs: PcCopia[];
  usos: UsoPcAtlas[];
  /** epoch ms de referencia para a validade das reservas */
  agoraMs: number;
  /** raiz do CNPJ (8 digitos) de cada fornecedor pedido — base dos PCs de outro cadastro */
  raizPorFornecedor: Map<number, string>;
}



/** Fator para kg da unidade do PC: KG = 1; T/TON/TL = 1000; outra = null (PC fica fora, D3). */
export function fatorUnidadePc(unidade: string | null | undefined): number | null {
  const u = (unidade ?? '').trim().toUpperCase();
  if (u === 'KG') return 1;
  if (u === 'T' || u === 'TON' || u === 'TL') return 1000;
  return null;
}

const tabelaPcs = (empresa: EmpresaPc): string => (empresa === 'acxe' ? '"tbl_pedidosCompras_ACXE"' : '"tbl_pedidosCompras_Q2P"');
const tabelaCadastro = (empresa: EmpresaPc): string =>
  empresa === 'acxe' ? '"tbl_cadastroFornecedoresClientes_ACXE"' : '"tbl_cadastroFornecedoresClientes_Q2P"';

/**
 * Carrega da copia local os PCs dos fornecedores informados (e os PCs apontados
 * por vinculos do OMIE, mesmo de outro fornecedor, e os de OUTROS cadastros com a
 * mesma raiz de CNPJ — so para citar no motivo, nunca oferecidos), mais os usos do
 * Atlas que pesam no saldo: vinculos `concluido` recentes (a copia pode ainda nao
 * te-los visto) e reservas vivas (`confirmado`/`associado` ha menos de 15 min).
 */
export async function carregarContextoPc(
  empresa: EmpresaPc,
  params: { fornecedores: number[]; nCodPedsVinculo: number[] },
): Promise<ContextoPc> {
  const fornecedores = Array.from(new Set(params.fornecedores.filter((n) => Number.isFinite(n) && n > 0)));
  const peds = Array.from(new Set(params.nCodPedsVinculo.filter((n) => Number.isFinite(n) && n > 0)));
  const agoraMs = Date.now();
  const raizPorFornecedor = new Map<number, string>();
  if (fornecedores.length === 0 && peds.length === 0) return { pcs: [], usos: [], agoraMs, raizPorFornecedor };

  const pool = getPool();
  // Raiz do CNPJ de cada fornecedor da NF: a mesma empresa pode ter um cadastro por
  // filial no OMIE, e compras pode lancar o PC no da matriz (NF 60199 x PC 306).
  if (fornecedores.length > 0) {
    const rf = await pool.query<{ codigo: string; cnpj: string | null }>(
      `SELECT c.codigo_cliente_omie::text AS codigo, regexp_replace(COALESCE(c.cnpj_cpf, ''), '\\D', '', 'g') AS cnpj
         FROM public.${tabelaCadastro(empresa)} c
        WHERE c.codigo_cliente_omie = ANY($1::bigint[])`,
      [fornecedores],
    );
    for (const x of rf.rows) {
      const raiz = raizCnpj(x.cnpj);
      if (raiz) raizPorFornecedor.set(Number(x.codigo), raiz);
    }
  }
  const raizes = Array.from(new Set(raizPorFornecedor.values()));
  interface PcRow {
    ncodped: string;
    ncoditem: string;
    cnumero: string | null;
    cetapa: string | null;
    ncodfor: string | null;
    nqtde: number | string | null;
    nqtderec: number | string | null;
    nvalunit: number | string | null;
    cunidade: string | null;
    ddtprevisao: string | null;
    cdescricao: string | null;
    cproduto: string | null;
    atualizado_ms: number | string | null;
    valor_total_pc: number | string | null;
    fornecedor_acxe: boolean | null;
    cnpj_cadastro: string | null;
  }
  const r = await pool.query<PcRow>(
    `SELECT pc.ncodped::text AS ncodped, pc.ncoditem::text AS ncoditem, pc.cnumero, pc.cetapa, pc.ncodfor::text AS ncodfor,
            pc.nqtde::float8 AS nqtde, COALESCE(pc.nqtderec, 0)::float8 AS nqtderec, pc.nvalunit::float8 AS nvalunit,
            pc.cunidade, pc.ddtprevisao::text AS ddtprevisao, pc.cdescricao, pc.cproduto,
            (EXTRACT(EPOCH FROM pc.data_atualizacao) * 1000)::float8 AS atualizado_ms,
            SUM(COALESCE(pc.nvaltot, pc.nqtde * pc.nvalunit, 0)) OVER (PARTITION BY pc.ncodped)::float8 AS valor_total_pc,
            (regexp_replace(COALESCE(cad.cnpj_cpf, ''), '\\D', '', 'g') = $3) AS fornecedor_acxe,
            regexp_replace(COALESCE(cad.cnpj_cpf, ''), '\\D', '', 'g') AS cnpj_cadastro
       FROM public.${tabelaPcs(empresa)} pc
       LEFT JOIN LATERAL (
         SELECT c.cnpj_cpf FROM public.${tabelaCadastro(empresa)} c WHERE c.codigo_cliente_omie = pc.ncodfor LIMIT 1
       ) cad ON true
      WHERE pc.ncodfor = ANY($1::bigint[]) OR pc.ncodped = ANY($2::bigint[])
         OR pc.ncodfor IN (
              SELECT c2.codigo_cliente_omie FROM public.${tabelaCadastro(empresa)} c2
               WHERE length(regexp_replace(COALESCE(c2.cnpj_cpf, ''), '\\D', '', 'g')) = 14
                 AND left(regexp_replace(c2.cnpj_cpf, '\\D', '', 'g'), 8) = ANY($4::text[])
            )`,
    [fornecedores, peds, CNPJ_ACXE_NUMERICO, raizes],
  );

  const pcs: PcCopia[] = [];
  for (const x of r.rows) {
    const fator = fatorUnidadePc(x.cunidade);
    const nqtde = Number(x.nqtde ?? 0);
    const nqtderec = Number(x.nqtderec ?? 0);
    const nvalunit = x.nvalunit == null ? null : Number(x.nvalunit);
    const valorTotal = Number(x.valor_total_pc ?? 0);
    pcs.push({
      nCodPed: Number(x.ncodped),
      nCodItem: Number(x.ncoditem),
      pcNumero: (x.cnumero ?? '').trim(),
      etapa: (x.cetapa ?? '').trim(),
      nCodFor: Number(x.ncodfor ?? 0),
      produtoDescricao: (x.cdescricao ?? x.cproduto ?? '').trim(),
      qtdPedidaKg: fator != null ? nqtde * fator : 0,
      saldoCopiaKg: fator != null ? Math.max(0, (nqtde - nqtderec) * fator) : 0,
      precoKg: fator != null && nvalunit != null && Number.isFinite(nvalunit) ? nvalunit / fator : null,
      unidade: (x.cunidade ?? '').trim().toUpperCase(),
      dtPrevisao: x.ddtprevisao ? String(x.ddtprevisao).slice(0, 10) : null,
      atualizadoEmMs: Number(x.atualizado_ms ?? 0),
      pcEspelho: x.fornecedor_acxe === true && valorTotal < PC_ESPELHO_VALOR_MAX_BRL,
      cnpjCadastro: x.cnpj_cadastro ?? '',
      raizCnpj: raizCnpj(x.cnpj_cadastro),
    });
  }

  const itensPc = Array.from(new Set(pcs.map((p) => p.nCodItem)));
  let usos: UsoPcAtlas[] = [];
  if (itensPc.length > 0) {
    // Concluidos depois do sync mais antigo entre os PCs lidos (o filtro fino, por
    // linha, e feito em TS) e reservas vivas. Tudo do ledger do Atlas (0056).
    const desdeMs = Math.min(...pcs.map((p) => p.atualizadoEmMs).filter((v) => v > 0), agoraMs);
    const u = await pool.query<{
      n_cod_item_ped: string;
      nf_chave_acesso: string;
      status: 'confirmado' | 'associado' | 'concluido';
      qtd_nf_kg: number | string;
      em_ms: number | string;
    }>(
      `SELECT n_cod_item_ped::text AS n_cod_item_ped, nf_chave_acesso, status, qtd_nf_kg::float8 AS qtd_nf_kg,
              (EXTRACT(EPOCH FROM CASE WHEN status = 'concluido' THEN concluido_em ELSE confirmado_em END) * 1000)::float8 AS em_ms
         FROM stockbridge.recebimento_fiscal_pc
        WHERE empresa = $1
          AND n_cod_item_ped = ANY($2::bigint[])
          AND (
                (status = 'concluido' AND concluido_em > to_timestamp($3::float8 / 1000))
             OR (status IN ('confirmado', 'associado') AND confirmado_em > now() - make_interval(mins => $4))
          )`,
      [empresa, itensPc, desdeMs, RESERVA_PC_VALIDADE_MIN],
    );
    usos = u.rows.map((x) => ({
      nCodItemPed: Number(x.n_cod_item_ped),
      nfChaveAcesso: x.nf_chave_acesso,
      status: x.status,
      qtdKg: Number(x.qtd_nf_kg),
      emMs: Number(x.em_ms),
    }));
  }
  return { pcs, usos, agoraMs, raizPorFornecedor };
}

/**
 * Saldo do item de PC na COPIA LOCAL (sugestao, portao 1): o que a copia mostra,
 * menos os vinculos concluidos pelo Atlas depois do sync da linha (a copia ainda
 * nao os viu) e menos as reservas de OUTRAS NFs (research D3/D4).
 */
export function saldoDisponivelCopiaKg(pc: PcCopia, ctx: ContextoPc, chaveNf: string): number {
  let saldo = pc.saldoCopiaKg;
  for (const u of ctx.usos) {
    if (u.nCodItemPed !== pc.nCodItem) continue;
    if (u.status === 'concluido') {
      if (u.emMs > pc.atualizadoEmMs) saldo -= u.qtdKg;
    } else if (u.nfChaveAcesso !== chaveNf) {
      saldo -= u.qtdKg;
    }
  }
  return Math.max(0, saldo);
}

// ── Montagem por item (pura — testada sem banco) ────────────────────────────

const EPS = 1e-9;
/** Primeira letra minuscula, preservando sigla ("PC sem saldo" fica como esta). */
const minusculaInicial = (t: string): string =>
  t.length > 1 && t[1] !== t[1]!.toUpperCase() ? t[0]!.toLowerCase() + t.slice(1) : t;
const pctBr = (frac: number): string => `${(Math.abs(frac) * 100).toFixed(1).replace('.', ',')}%`;
export const fmtKg = (v: number): string => v.toLocaleString('pt-BR', { maximumFractionDigits: 3 });

const juntarE = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`);

/** "PC 302" / "PCs 302 e 304" / "PCs 302, 304 e 306" — so o numero legivel (ACXEGDP-313). */
export const rotuloPcs = (numeros: string[]): string =>
  numeros.length === 1 ? `PC ${numeros[0] || '(sem número)'}` : `PCs ${juntarE(numeros.map((n) => n || '(sem número)'))}`;

/** "o PC 306 lançado em outro cadastro do mesmo fornecedor (CNPJ 61.827.663/0001-79)" e variantes. */
function textoPcsOutroCadastro(pcs: PcOutroCadastro[]): string {
  const doc = (cnpj: string): string => (fmtCnpj(cnpj) ? ` (CNPJ ${fmtCnpj(cnpj)})` : '');
  const cnpjs = Array.from(new Set(pcs.map((p) => p.cnpjCadastroPc)));
  if (cnpjs.length === 1) {
    return pcs.length === 1
      ? `o ${rotuloPcs([pcs[0]!.pcNumero])} lançado em outro cadastro do mesmo fornecedor${doc(cnpjs[0]!)}`
      : `os ${rotuloPcs(pcs.map((p) => p.pcNumero))} lançados em outro cadastro do mesmo fornecedor${doc(cnpjs[0]!)}`;
  }
  const lista = juntarE(pcs.map((p) => `${p.pcNumero || '(sem número)'}${doc(p.cnpjCadastroPc)}`));
  return `os PCs ${lista} lançados em outros cadastros do mesmo fornecedor`;
}

interface Avaliacao {
  dentroTolerancia: boolean;
  /** diferenca relativa de preco (NF vs PC) na base mais proxima do PC, null sem preco */
  difPreco: number | null;
  /** R$/kg da NF na base usada (comercial ou valor do item), null sem preco */
  precoNfKgUsado: number | null;
  /** excesso relativo da quantidade sobre o saldo (0 quando cabe) */
  excessoQtd: number;
  saldoKg: number;
  desvios: string[];
}

function avaliar(item: ItemParaSugestao, pc: PcCopia, saldoKg: number, tol: ToleranciasPc): Avaliacao {
  const desvios: string[] = [];
  const qtd = item.quantidadeKg ?? 0;
  const excessoQtd = saldoKg > 0 ? Math.max(0, qtd / saldoKg - 1) : qtd > 0 ? Infinity : 0;
  const qtdOk = qtd <= saldoKg * (1 + tol.qtd) + EPS;
  if (!qtdOk) {
    desvios.push(saldoKg > 0 ? `Quantidade ${pctBr(excessoQtd)} acima do saldo` : 'PC sem saldo');
  }
  let difPreco: number | null = null;
  let precoNfKgUsado: number | null = null;
  let precoOk = false;
  // Duas bases para o preco da NF (research D3, revisto em 22/10/2026): o comercial
  // (sem IPI) e o valor do item por kg (com IPI). Ha fornecedor cujo PC e lancado com
  // o preco com IPI (PC 306 da Zaraplast: R$ 10,80/kg = valor do item ÷ kg da NF
  // 60199, enquanto o comercial fica 2,7% a 4,8% abaixo) e fornecedor sem IPI, em que
  // as duas coincidem. Vale a base mais proxima do preco do PC.
  const bases = [item.precoNfKg, item.precoItemKg].filter((p): p is number => p != null && Number.isFinite(p));
  if (bases.length === 0 || pc.precoKg == null) {
    desvios.push('Preço não comparável');
  } else {
    const precoPc = pc.precoKg;
    const dif = (b: number): number => (precoPc > 0 ? (b - precoPc) / precoPc : b === 0 ? 0 : Infinity);
    precoNfKgUsado = bases.reduce((melhor, b) => (Math.abs(dif(b)) < Math.abs(dif(melhor)) ? b : melhor));
    difPreco = dif(precoNfKgUsado);
    precoOk = Math.abs(precoNfKgUsado - precoPc) <= precoPc * tol.preco + EPS;
    if (!precoOk) {
      desvios.push(Number.isFinite(difPreco) ? `Preço da NF ${pctBr(difPreco)} ${difPreco > 0 ? 'acima' : 'abaixo'} do PC` : 'Preço não comparável');
    }
  }
  return { dentroTolerancia: qtdOk && precoOk, difPreco, precoNfKgUsado, excessoQtd, saldoKg, desvios };
}

function paraCandidato(item: ItemParaSugestao, pc: PcCopia, av: Avaliacao, motivo: string): PcCandidato {
  return {
    nCodPed: pc.nCodPed,
    nCodItem: pc.nCodItem,
    pcNumero: pc.pcNumero,
    produtoDescricao: pc.produtoDescricao,
    qtdPedidaKg: pc.qtdPedidaKg,
    saldoKg: av.saldoKg,
    precoUnit: pc.precoKg ?? 0,
    precoNfKgComparado: av.precoNfKgUsado,
    dtPrevisao: pc.dtPrevisao,
    etapa: pc.etapa,
    dentroTolerancia: av.dentroTolerancia,
    casaNumeroPedidoNf: casaNumero(item, pc),
    semDadosLocais: false,
    motivo,
  };
}

function casaNumero(item: ItemParaSugestao, pc: PcCopia): boolean {
  const n = (item.numeroPedidoNf ?? '').trim();
  return n.length > 0 && pc.pcNumero.length > 0 && n.replace(/^0+/, '') === pc.pcNumero.replace(/^0+/, '');
}

/** Ordem D3: numero do pedido na NF; menor diferenca de preco; previsao mais antiga; nCodPed. */
function ordenar(item: ItemParaSugestao, lista: Array<{ pc: PcCopia; av: Avaliacao }>): Array<{ pc: PcCopia; av: Avaliacao }> {
  return [...lista].sort((a, b) => {
    const na = casaNumero(item, a.pc) ? 0 : 1;
    const nb = casaNumero(item, b.pc) ? 0 : 1;
    if (na !== nb) return na - nb;
    const da = a.av.difPreco == null || !Number.isFinite(a.av.difPreco) ? Infinity : Math.abs(a.av.difPreco);
    const db = b.av.difPreco == null || !Number.isFinite(b.av.difPreco) ? Infinity : Math.abs(b.av.difPreco);
    if (da !== db) return da - db;
    const pa = a.pc.dtPrevisao ?? '9999-12-31';
    const pb = b.pc.dtPrevisao ?? '9999-12-31';
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.pc.nCodPed - b.pc.nCodPed || a.pc.nCodItem - b.pc.nCodItem;
  });
}

const VAZIO: Omit<PcDoItem, 'semPcMotivo'> = {
  vinculoOmie: null,
  vinculoOmieElegivel: false,
  alertaVinculoOmie: null,
  vinculosDivergentes: false,
  candidatos: [],
  outrosDoFornecedor: [],
  aguardandoAprovacao: [],
  preSelecionado: null,
  vinculadoNoOmie: null,
};

/**
 * Monta o PcDoItem de um item agregado com fiscal PENDENTE (data-model §8).
 * `fornecedorCodigo` = nIdFornecedor do recebimento (a NF sem fornecedor no OMIE
 * ja e recusada pelo fiscal da 016 — RECEBIMENTO_FISCAL_SEM_FORNECEDOR).
 */
export function montarPcDoItem(
  item: ItemParaSugestao,
  ctx: ContextoPc,
  fornecedorCodigo: number | null,
  chaveNf: string,
  tol: ToleranciasPc,
): ResultadoPcItem {
  if (item.quantidadeKg == null) {
    return {
      pc: { ...VAZIO, semPcMotivo: 'Sem sugestão de pedido de compra: a unidade do item não pôde ser convertida para kg.' },
      possivel: false,
      motivoSemPc: 'unidade',
      situacao: 'sem_pc',
      pcsOutroCadastro: [],
    };
  }

  // ── Vinculo do OMIE (por sequencia) ──
  const chavesVinculo = new Map<string, VinculoLinhaOmie>();
  for (const v of item.vinculos) chavesVinculo.set(`${v.nIdPedido}:${v.nIdItPedido ?? ''}`, v);
  const divergentes = chavesVinculo.size > 1;
  let vinculoOmie: PcCandidato | null = null;
  let vinculoOmieElegivel = false;
  let vinculoSemAlerta = false;
  const alertas: string[] = [];
  let pcDoVinculo: PcCopia | null = null;

  if (divergentes) {
    // Numeros legiveis so quando todos estao na copia (vinculo fora dela nao tem numero confiavel).
    const numeros = Array.from(chavesVinculo.values()).map(
      (v) => ctx.pcs.find((p) => p.nCodPed === v.nIdPedido && (v.nIdItPedido == null || p.nCodItem === v.nIdItPedido))?.pcNumero ?? '',
    );
    const distintos = Array.from(new Set(numeros));
    const lista = distintos.length > 1 && distintos.every((n) => n.length > 0) ? ` (${rotuloPcs(distintos)})` : '';
    alertas.push(`As linhas deste item estão vinculadas a pedidos de compra diferentes no OMIE${lista}. Escolha um pedido para o item inteiro.`);
  } else if (chavesVinculo.size === 1) {
    const v = item.vinculos[0]!;
    pcDoVinculo =
      ctx.pcs.find((p) => p.nCodPed === v.nIdPedido && (v.nIdItPedido == null || p.nCodItem === v.nIdItPedido)) ?? null;
    if (!pcDoVinculo) {
      // PC fora da copia: recebido por inteiro (sai da copia na Rev 1.5), cancelado/excluido
      // ou ainda nao sincronizado. A releitura ao vivo decide (FR-009); sem dado local,
      // manter o vinculo exige justificativa (nao da para afirmar que esta na tolerancia).
      vinculoOmie = {
        nCodPed: v.nIdPedido,
        nCodItem: v.nIdItPedido ?? 0,
        // sem a copia nao ha numero confiavel: o xPed da NF e do fornecedor, nao do vinculo
        pcNumero: '',
        produtoDescricao: '',
        qtdPedidaKg: 0,
        saldoKg: 0,
        precoUnit: 0,
        precoNfKgComparado: null,
        dtPrevisao: null,
        etapa: '',
        dentroTolerancia: false,
        casaNumeroPedidoNf: false,
        semDadosLocais: true,
        motivo: 'Vínculo do OMIE',
      };
      vinculoOmieElegivel = v.nIdItPedido != null;
      alertas.push(
        'O pedido vinculado no OMIE não está na lista local de pedidos (pode ter sido recebido por inteiro, cancelado ou ainda não sincronizado). Se mantiver o vínculo, a confirmação confere a situação no OMIE.',
      );
    } else {
      const saldo = saldoDisponivelCopiaKg(pcDoVinculo, ctx, chaveNf);
      const av = avaliar(item, pcDoVinculo, saldo, tol);
      vinculoOmie = paraCandidato(item, pcDoVinculo, av, 'Vínculo do OMIE');
      // Vinculo PARCIAL a PC de OUTRO cadastro do fornecedor (filial x matriz): manter o vinculo
      // obriga o Atlas a ASSOCIAR as demais linhas a um PC de outro cadastro — o que ele nao faz
      // (FR-009; ASSOCIAR entre cadastros nao testado). O vinculo nao pode ser mantido: o
      // operador troca por outro PC, ou a NF vai para "sem PC" e compras e avisado (achado
      // fiscal-r01 — antes o detalhe pre-selecionava e o POST dava 409 em laco).
      const linhasSemVinculo = item.sequencias.filter((seq) => !item.vinculos.some((v) => v.nSequencia === seq));
      const outroCadastroParcial =
        linhasSemVinculo.length > 0 && fornecedorCodigo != null && pcDoVinculo.nCodFor > 0 && pcDoVinculo.nCodFor !== fornecedorCodigo;
      if (pcDoVinculo.pcEspelho) {
        vinculoOmieElegivel = false;
        alertas.push('O item está vinculado no OMIE a um pedido de importação (pedido-espelho), que não pode ser usado aqui. Escolha outro pedido.');
      } else if (outroCadastroParcial) {
        vinculoOmieElegivel = false;
        alertas.push(
          `O PC ${pcDoVinculo.pcNumero} foi lançado em outro cadastro do fornecedor e está vinculado no OMIE só a parte das linhas deste item. Peça à equipe de Compras para ajustar o fornecedor do pedido, ou ao fiscal para vincular as demais linhas no OMIE.`,
        );
      } else {
        vinculoOmieElegivel = pcDoVinculo.precoKg != null || fatorUnidadePc(pcDoVinculo.unidade) != null;
        if (pcDoVinculo.etapa !== '15') {
          alertas.push(
            pcDoVinculo.etapa === '10'
              ? `O PC ${pcDoVinculo.pcNumero} consta como aguardando aprovação na lista local. A confirmação confere a situação no OMIE.`
              : `O PC ${pcDoVinculo.pcNumero} não consta como aprovado na lista local. A confirmação confere a situação no OMIE.`,
          );
        }
        if (!av.dentroTolerancia) {
          alertas.push(`PC ${pcDoVinculo.pcNumero} fora da tolerância: ${av.desvios.map(minusculaInicial).join('; ')}. Para manter o vínculo, informe a justificativa.`);
        }
        vinculoSemAlerta = vinculoOmieElegivel && pcDoVinculo.etapa === '15' && av.dentroTolerancia;
      }
    }
  }

  // ── Candidatos, outros e aguardando (PCs do fornecedor) ──
  const doFornecedor = fornecedorCodigo != null ? ctx.pcs.filter((p) => p.nCodFor === fornecedorCodigo && !p.pcEspelho) : [];
  const ehVinculo = (p: PcCopia) => pcDoVinculo != null && p.nCodPed === pcDoVinculo.nCodPed && p.nCodItem === pcDoVinculo.nCodItem;
  const dentro: Array<{ pc: PcCopia; av: Avaliacao }> = [];
  const fora: Array<{ pc: PcCopia; av: Avaliacao }> = [];
  const aguardando: Array<{ pc: PcCopia; av: Avaliacao }> = [];
  for (const p of doFornecedor) {
    if (ehVinculo(p)) continue;
    if (fatorUnidadePc(p.unidade) == null) {
      logger.info({ pc: p.pcNumero, unidade: p.unidade }, 'PC com unidade não comparável fica fora da sugestão');
      continue;
    }
    const saldo = saldoDisponivelCopiaKg(p, ctx, chaveNf);
    const av = avaliar(item, p, saldo, tol);
    if (p.etapa === '10') {
      if (p.saldoCopiaKg > 0) aguardando.push({ pc: p, av });
    } else if (p.etapa === '15' && saldo > 0) {
      (av.dentroTolerancia ? dentro : fora).push({ pc: p, av });
    }
  }
  const candidatos = ordenar(item, dentro).map(({ pc, av }) =>
    paraCandidato(item, pc, av, casaNumero(item, pc) ? 'Número do pedido na NF' : 'Quantidade e preço compatíveis'),
  );
  const outrosDoFornecedor = ordenar(item, fora).map(({ pc, av }) => paraCandidato(item, pc, av, av.desvios.join(' · ')));
  const aguardandoAprovacao = ordenar(item, aguardando).map(({ pc, av }) => paraCandidato(item, pc, av, 'Aguardando aprovação'));

  // ── Pre-selecao (D3): vinculo do OMIE sem alerta, ou candidato unico pelo numero do pedido ──
  let preSelecionado: PcDoItem['preSelecionado'] = null;
  if (vinculoSemAlerta && vinculoOmie) {
    preSelecionado = { nCodPed: vinculoOmie.nCodPed, nCodItem: vinculoOmie.nCodItem };
  } else if (!vinculoOmie && !divergentes) {
    const peloNumero = candidatos.filter((c) => c.casaNumeroPedidoNf);
    if (peloNumero.length === 1) preSelecionado = { nCodPed: peloNumero[0]!.nCodPed, nCodItem: peloNumero[0]!.nCodItem };
  }

  // ── PCs da mesma empresa em OUTRO cadastro do OMIE (filial x matriz): so informativos ──
  const raiz = fornecedorCodigo != null ? (ctx.raizPorFornecedor.get(fornecedorCodigo) ?? null) : null;
  const outroCadastro = new Map<number, PcOutroCadastro>();
  if (raiz) {
    for (const p of ctx.pcs) {
      if (p.nCodFor === fornecedorCodigo || p.raizCnpj !== raiz || p.pcEspelho || p.etapa !== '15' || ehVinculo(p)) continue;
      if (fatorUnidadePc(p.unidade) == null || saldoDisponivelCopiaKg(p, ctx, chaveNf) <= 0) continue;
      if (!outroCadastro.has(p.nCodPed)) outroCadastro.set(p.nCodPed, { pcNumero: p.pcNumero, cnpjCadastroPc: p.cnpjCadastro });
    }
  }
  const pcsOutroCadastro = Array.from(outroCadastro.values());

  const possivel = (vinculoOmie != null && vinculoOmieElegivel) || candidatos.length > 0 || outrosDoFornecedor.length > 0;
  let motivoSemPc: MotivoSemPc | null = null;
  let semPcMotivo: string | null = null;
  if (!possivel) {
    if ((vinculoOmie && !vinculoOmieElegivel) || divergentes) {
      // FR-011a: item que veio vinculado no OMIE nunca e ignorado — sem PC possivel, a NF e
      // recusada nos dois modos (inclusive com as linhas ligadas a pedidos diferentes).
      motivoSemPc = 'vinculo_invalido';
      semPcMotivo = divergentes
        ? 'Os pedidos vinculados no OMIE às linhas deste item não podem ser usados e o fornecedor não tem outro pedido de compra aprovado com saldo.'
        : 'O pedido vinculado no OMIE não pode ser usado e o fornecedor não tem outro pedido de compra aprovado com saldo.';
    } else if (aguardandoAprovacao.length > 0) {
      motivoSemPc = 'pc_aguardando_aprovacao';
      const nums = aguardandoAprovacao.map((c) => (c.pcNumero ? `PC ${c.pcNumero}` : 'PC sem número')).join(', ');
      semPcMotivo =
        aguardandoAprovacao.length === 1
          ? `O pedido de compra deste fornecedor ainda está aguardando aprovação no OMIE (${nums}). Ele só pode ser vinculado depois de aprovado.`
          : `Os pedidos de compra deste fornecedor ainda estão aguardando aprovação no OMIE (${nums}). Eles só podem ser vinculados depois de aprovados.`;
    } else {
      motivoSemPc = 'sem_pc';
      semPcMotivo =
        pcsOutroCadastro.length > 0
          ? `O cadastro do fornecedor desta nota não tem pedido de compra aprovado com saldo para este item, mas há ${textoPcsOutroCadastro(pcsOutroCadastro)}. Peça à equipe de Compras para ajustar o fornecedor do pedido para o cadastro da nota.`
          : 'O fornecedor não tem pedido de compra aprovado com saldo para este item.';
    }
  }

  let situacao: PcSituacaoItem;
  if (!possivel) situacao = motivoSemPc === 'pc_aguardando_aprovacao' ? 'aguardando_aprovacao' : 'sem_pc';
  else if (preSelecionado && vinculoSemAlerta) situacao = 'vinculado_omie';
  else if (preSelecionado) situacao = 'sugerido';
  else if (!vinculoOmie && !divergentes && candidatos.length === 1) situacao = 'sugerido';
  else situacao = 'escolha_necessaria';

  return {
    pc: {
      vinculoOmie,
      vinculoOmieElegivel,
      alertaVinculoOmie: alertas.length > 0 ? alertas.join(' ') : null,
      vinculosDivergentes: divergentes,
      candidatos,
      outrosDoFornecedor,
      aguardandoAprovacao,
      preSelecionado,
      semPcMotivo,
      vinculadoNoOmie: null,
    },
    possivel,
    motivoSemPc,
    situacao,
    pcsOutroCadastro,
  };
}

const ORDEM_SITUACAO: readonly PcSituacaoItem[] = Object.freeze(['sem_pc', 'aguardando_aprovacao', 'escolha_necessaria', 'sugerido', 'vinculado_omie']);

/** Pior caso entre os itens a receber (data-model §8). Sem item: 'nao_aplicavel'. */
export function pcSituacaoDaNf(situacoes: PcSituacaoItem[]): PcSituacaoNf {
  for (const s of ORDEM_SITUACAO) if (situacoes.includes(s)) return s;
  return 'nao_aplicavel';
}

/**
 * Sugestao para os itens de UMA NF com fiscal pendente. Carrega a copia uma vez
 * (fornecedor da NF + PCs dos vinculos do OMIE).
 */
export async function sugerirPcPorItens(
  empresa: EmpresaPc,
  fornecedorCodigo: number | null,
  chaveNf: string,
  itens: ItemParaSugestao[],
): Promise<Map<number, ResultadoPcItem>> {
  const ctx = await carregarContextoPc(empresa, {
    fornecedores: fornecedorCodigo != null ? [fornecedorCodigo] : [],
    nCodPedsVinculo: itens.flatMap((i) => i.vinculos.map((v) => v.nIdPedido)),
  });
  const tol = toleranciasPc();
  const out = new Map<number, ResultadoPcItem>();
  for (const it of itens) out.set(it.indice, montarPcDoItem(it, ctx, fornecedorCodigo, chaveNf, tol));
  return out;
}

// ── Escolha do operador (portao 1 — T023) ───────────────────────────────────

/** Corpo `itens[].pc` do POST por-nf (data-model §9). */
export interface EscolhaPc {
  n_cod_ped: number;
  n_cod_item: number;
  justificativa?: string | null;
  n_cod_item_omie_visto?: number | null;
}

export type OrigemVinculoPc = 'omie' | 'sugestao' | 'manual';

/** Escolha validada contra o detalhe recalculado — o que vai para recebimento_fiscal_pc. */
export interface EscolhaPcValidada {
  indice: number;
  sequencias: number[];
  origem: OrigemVinculoPc;
  candidato: PcCandidato;
  dentroTolerancia: boolean;
  justificativa: string | null;
  nCodPedOmieAnterior: number | null;
  nCodItemPedOmieAnterior: number | null;
  /** vinculo do OMIE que a TELA mostrou (n_cod_item_omie_visto) — base do 409 VINCULO_OMIE_MUDOU */
  nCodItemOmieVisto: number | null;
  /**
   * Linhas do item ligadas a PCs diferentes no OMIE (data-model §8): a tela nao tem um
   * unico "visto" para mandar, entao a base do VINCULO_OMIE_MUDOU passa a ser, por
   * sequencia, o vinculo que o servidor leu no portao 1 (`vinculosPorSequencia`).
   */
  vinculosDivergentes: boolean;
  /** vinculo do OMIE de cada sequencia lido no portao 1 (so as que tinham vinculo) — tambem o "anterior" por linha */
  vinculosPorSequencia: Record<number, { nIdPedido: number; nIdItPedido: number | null }>;
  /** retrato do que foi oferecido (jsonb candidatos) */
  oferecidos: Array<{ nCodPed: number; nCodItem: number; pcNumero: string; saldoKg: number; precoUnit: number; motivo: string; dentroTolerancia: boolean }>;
  qtdNfKg: number;
  precoNfKg: number;
  /** kg de cada sequencia do item (soma = qtdNfKg) */
  kgPorSequencia: Record<number, number>;
  /** descricao do item (mensagens) */
  itemDescricao: string;
}

const rotuloNf = (notaFiscal: string, fornecedorNome: string | null): string =>
  fornecedorNome && fornecedorNome.trim() ? `NF ${notaFiscal} (${fornecedorNome.trim()})` : `NF ${notaFiscal}`;

export class PcNaoEscolhidoError extends Error {
  constructor(public readonly notaFiscal: string, public readonly fornecedorNome: string | null, public readonly itemDescricao: string) {
    super(`Escolha o pedido de compra do item ${itemDescricao.trim()} da ${rotuloNf(notaFiscal, fornecedorNome)}.`);
    this.name = 'PcNaoEscolhidoError';
  }
}

export class PcNaoElegivelError extends Error {
  constructor(public readonly notaFiscal: string, public readonly pcNumero: string | null, public readonly itemDescricao: string, motivo: string) {
    super(
      `${pcNumero ? `O PC ${pcNumero}` : 'O pedido de compra escolhido'} não pode ser vinculado ao item ${itemDescricao.trim()} da NF ${notaFiscal}: ${motivo}.`,
    );
    this.name = 'PcNaoElegivelError';
  }
}

export class PcJustificativaObrigatoriaError extends Error {
  constructor(public readonly notaFiscal: string, public readonly pcNumero: string, public readonly itemDescricao: string, motivo: string) {
    super(`Informe por que o PC ${pcNumero || '(sem número)'} foi escolhido para o item ${itemDescricao.trim()} da NF ${notaFiscal} (${motivo}).`);
    this.name = 'PcJustificativaObrigatoriaError';
  }
}

/**
 * 422 NF_SEM_PC: item a gravar sem PC possivel no modo bloquear, vinculo do OMIE que
 * nao serve sem outro PC (FR-011a), ou — so no modo bloquear — item que o Atlas nao
 * recebe (unidade nao convertida) e sem PC no OMIE, que o fiscal concluiria sem PC.
 * Compras e avisado dos dois primeiros; o de unidade orienta o fiscal (nao e falta de PC).
 */
export class NfSemPcError extends Error {
  constructor(
    public readonly notaFiscal: string,
    public readonly fornecedorNome: string | null,
    public readonly itens: Array<{ descricao: string; motivo: MotivoSemPc; pcsOutroCadastro?: PcOutroCadastro[] }>,
  ) {
    const nf = rotuloNf(notaFiscal, fornecedorNome);
    const lista = (xs: Array<{ descricao: string }>) => xs.map((i) => i.descricao.trim()).join(', ');
    const deUnidade = itens.filter((i) => i.motivo === 'unidade');
    // Item sem PC no cadastro da nota mas com PC em OUTRO cadastro do mesmo fornecedor (filial x
    // matriz): a orientacao e ajustar o fornecedor do pedido, nao lancar outro (achado sugestao-v03).
    const comOutroCadastro = itens.filter((i) => i.motivo === 'sem_pc' && (i.pcsOutroCadastro?.length ?? 0) > 0);
    const outros = itens.filter((i) => i.motivo !== 'unidade' && !comOutroCadastro.includes(i));
    const partes: string[] = [];
    if (outros.length > 0) {
      const soAguardando = outros.every((i) => i.motivo === 'pc_aguardando_aprovacao');
      const vinculoInvalido = outros.some((i) => i.motivo === 'vinculo_invalido');
      partes.push(
        vinculoInvalido
          ? `A ${nf} tem item vinculado no OMIE a um pedido que não pode ser usado, sem outro pedido de compra possível (${lista(outros)}). A equipe de Compras foi avisada. Peça a correção do pedido ou do vínculo antes de receber.`
          : soAguardando
            ? `A ${nf} tem item com pedido de compra ainda aguardando aprovação no OMIE (${lista(outros)}). A equipe de Compras foi avisada. A NF fica na fila até o pedido ser aprovado.`
            : `A ${nf} tem item sem pedido de compra no OMIE (${lista(outros)}). A equipe de Compras foi avisada. A NF fica na fila até o PC ser lançado e aprovado.`,
      );
    }
    if (comOutroCadastro.length > 0) {
      const vistos = new Set<string>();
      const pcs = comOutroCadastro
        .flatMap((i) => i.pcsOutroCadastro ?? [])
        .filter((p) => (vistos.has(`${p.pcNumero}|${p.cnpjCadastroPc}`) ? false : (vistos.add(`${p.pcNumero}|${p.cnpjCadastroPc}`), true)));
      partes.push(
        outros.length > 0
          ? `Para ${lista(comOutroCadastro)}, há ${textoPcsOutroCadastro(pcs)}: a equipe de Compras foi avisada para ajustar o fornecedor do pedido.`
          : `A ${nf} tem item sem pedido de compra no cadastro do fornecedor da nota (${lista(comOutroCadastro)}), mas há ${textoPcsOutroCadastro(pcs)}. A equipe de Compras foi avisada para ajustar o fornecedor do pedido; a NF fica na fila até o ajuste.`,
      );
    }
    if (deUnidade.length > 0) {
      const um = deUnidade.length === 1;
      partes.push(
        outros.length > 0 || comOutroCadastro.length > 0
          ? `Além disso, ${um ? 'o item' : 'os itens'} ${lista(deUnidade)} ${um ? 'não pode ser recebido' : 'não podem ser recebidos'} pelo Atlas (unidade não convertida para kg) e ${um ? 'não tem' : 'não têm'} pedido de compra vinculado no OMIE: peça ao fiscal para corrigir a unidade ou concluir o recebimento desta NF no OMIE, vinculando o pedido.`
          : `A ${nf} tem ${um ? 'item' : 'itens'} que o Atlas não recebe (unidade não convertida para kg) e sem pedido de compra vinculado no OMIE (${lista(deUnidade)}). Peça ao fiscal para corrigir a unidade ou concluir o recebimento desta NF no OMIE, vinculando o pedido.`,
      );
    }
    super(partes.join(' '));
    this.name = 'NfSemPcError';
  }
}

/** 503 COPIA_PCS_DEFASADA (D13): a copia nao decide nada; nada e gravado nem avisado. */
export class CopiaPcsDefasadaError extends Error {
  constructor() {
    super('A lista de pedidos de compra está desatualizada. Nada foi registrado. Tente de novo em alguns minutos; se persistir, avise o suporte.');
    this.name = 'CopiaPcsDefasadaError';
  }
}

/**
 * Valida a escolha do operador para UM item contra o detalhe recalculado
 * (contrato §3, passo 1). Devolve null quando o item segue sem PC (sem PC
 * possivel — a regra NF_SEM_PC e do chamador). Matriz de justificativa do
 * data-model §4: fora da tolerancia (qualquer origem), escolha manual e troca do
 * vinculo do OMIE.
 */
export function validarEscolhaPc(args: {
  notaFiscal: string;
  fornecedorNome: string | null;
  itemDescricao: string;
  indice: number;
  sequencias: number[];
  vinculos: VinculoLinhaOmie[];
  resultado: ResultadoPcItem;
  escolha: EscolhaPc | null | undefined;
  quantidadeKg: number;
  precoNfKg: number | null;
  kgPorSequencia: Record<number, number>;
}): EscolhaPcValidada | null {
  const { resultado, escolha } = args;
  const pc = resultado.pc;
  if (escolha == null) {
    if (resultado.possivel) throw new PcNaoEscolhidoError(args.notaFiscal, args.fornecedorNome, args.itemDescricao);
    return null;
  }
  const mesmo = (c: PcCandidato | null) => c != null && c.nCodPed === escolha.n_cod_ped && c.nCodItem === escolha.n_cod_item;

  let origem: OrigemVinculoPc;
  let candidato: PcCandidato | undefined;
  if (pc.vinculoOmie && mesmo(pc.vinculoOmie)) {
    if (!pc.vinculoOmieElegivel) {
      throw new PcNaoElegivelError(args.notaFiscal, pc.vinculoOmie.pcNumero || null, args.itemDescricao, 'o pedido vinculado no OMIE não pode ser usado aqui');
    }
    origem = 'omie';
    candidato = pc.vinculoOmie;
  } else if ((candidato = pc.candidatos.find(mesmo))) {
    origem = 'sugestao';
  } else if ((candidato = pc.outrosDoFornecedor.find(mesmo))) {
    origem = 'manual';
  } else {
    const aguardando = pc.aguardandoAprovacao.find(mesmo);
    throw new PcNaoElegivelError(
      args.notaFiscal,
      aguardando?.pcNumero ?? null,
      args.itemDescricao,
      aguardando ? 'está aguardando aprovação' : 'não é um pedido aprovado, com saldo, do fornecedor da nota',
    );
  }

  // Troca do vinculo do OMIE: alguma linha do item vinculada a outro item de PC.
  const anterior = args.vinculos.find((v) => !(v.nIdPedido === candidato!.nCodPed && (v.nIdItPedido == null || v.nIdItPedido === candidato!.nCodItem)));
  const dentroTolerancia = origem !== 'manual' && candidato.dentroTolerancia;
  const justificativa = (escolha.justificativa ?? '').trim();
  const exige = !dentroTolerancia || anterior != null;
  if (exige && justificativa.length === 0) {
    const motivo = anterior
      ? 'troca do pedido vinculado no OMIE'
      : candidato.motivo && origem !== 'omie'
        ? minusculaInicial(candidato.motivo)
        : 'fora da tolerância de quantidade ou preço';
    throw new PcJustificativaObrigatoriaError(args.notaFiscal, candidato.pcNumero, args.itemDescricao, motivo);
  }

  const oferecidos = [pc.vinculoOmie, ...pc.candidatos, ...pc.outrosDoFornecedor]
    .filter((c): c is PcCandidato => c != null)
    .map((c) => ({ nCodPed: c.nCodPed, nCodItem: c.nCodItem, pcNumero: c.pcNumero, saldoKg: c.saldoKg, precoUnit: c.precoUnit, motivo: c.motivo, dentroTolerancia: c.dentroTolerancia }));

  return {
    indice: args.indice,
    sequencias: args.sequencias,
    origem,
    candidato,
    dentroTolerancia,
    justificativa: justificativa.length > 0 ? justificativa.slice(0, 500) : null,
    nCodPedOmieAnterior: anterior ? anterior.nIdPedido : null,
    nCodItemPedOmieAnterior: anterior ? anterior.nIdItPedido : null,
    nCodItemOmieVisto: escolha.n_cod_item_omie_visto ?? null,
    vinculosDivergentes: pc.vinculosDivergentes,
    vinculosPorSequencia: Object.fromEntries(args.vinculos.map((v) => [v.nSequencia, { nIdPedido: v.nIdPedido, nIdItPedido: v.nIdItPedido }])),
    oferecidos,
    qtdNfKg: args.quantidadeKg,
    // preco da NF na base que foi comparada com o PC escolhido (comercial ou valor do item — D3)
    precoNfKg: candidato.precoNfKgComparado ?? args.precoNfKg ?? 0,
    kgPorSequencia: args.kgPorSequencia,
    itemDescricao: args.itemDescricao,
  };
}

/**
 * PC anterior de UMA linha (FR-007: troca registrada com o PC original): o vinculo que a
 * sequencia tinha no portao 1, quando difere do escolhido. Sem o retrato por linha
 * (chamador antigo), o anterior do item inteiro.
 */
export function anteriorDaSequencia(e: EscolhaPcValidada, seq: number): { nIdPedido: number; nIdItPedido: number | null } | null {
  if (!e.vinculosPorSequencia) {
    return e.nCodPedOmieAnterior != null ? { nIdPedido: e.nCodPedOmieAnterior, nIdItPedido: e.nCodItemPedOmieAnterior } : null;
  }
  const v = e.vinculosPorSequencia[seq];
  if (!v) return null;
  const mesmo = v.nIdPedido === e.candidato.nCodPed && (v.nIdItPedido == null || v.nIdItPedido === e.candidato.nCodItem);
  return mesmo ? null : v;
}

// ── Releitura ao vivo e reserva (POST — T026, research D4) ────────────────────

/** Regra "PC recem-usado" (D4): o OMIE devolve cache de ~1 min para a mesma ConsultarPedCompra. */
export const PC_RECEM_USADO_SEG = 75;

/** 409 PC_RECEM_USADO_AGUARDE: o mesmo item de PC foi concluido pelo Atlas ha menos de 75 s. */
export class PcRecemUsadoAguardeError extends Error {
  constructor(public readonly pcNumero: string, public readonly segundos: number) {
    super(
      `O PC ${pcNumero || '(sem número)'} acabou de ser usado em outro recebimento. Aguarde cerca de ${segundos} ` +
        `${segundos === 1 ? 'segundo' : 'segundos'} e tente de novo — o OMIE leva até 1 minuto para mostrar o saldo atualizado.`,
    );
    this.name = 'PcRecemUsadoAguardeError';
  }
}

/** 409 PC_VINCULO_INVALIDO: a releitura AO VIVO do PC recusa o vinculo (situacao atual na mensagem). */
export class PcVinculoInvalidoError extends Error {
  constructor(
    public readonly notaFiscal: string,
    public readonly pcNumero: string,
    situacao: string,
    /** item de PC recusado — so identificador de selecao para a tela, NUNCA texto (ACXEGDP-313) */
    public readonly pc: { nCodPed: number; nCodItem: number } | null = null,
  ) {
    super(`O PC ${pcNumero || '(sem número)'} não pode ser vinculado à NF ${notaFiscal}: ${situacao}. Escolha outro PC.`);
    this.name = 'PcVinculoInvalidoError';
  }
}

/** Uma linha `confirmado` gravada (reserva) — uma por sequencia do item. */
export interface ReservaPc {
  id: string;
  nSequencia: number;
  indice: number;
  nCodPed: number;
  nCodItemPed: number;
  pcNumero: string;
  origem: OrigemVinculoPc;
}

interface LeituraPc {
  pedido: PedidoCompraConsultado;
}

/**
 * Releitura AO VIVO dos PCs escolhidos + reserva (research D4). Chamada DEPOIS da
 * trava da NF (ledger da 016) e da ConsultarRecebimento — so com o recebimento ainda
 * aberto (NF ja concluida nao rele o PC: achado fiscal-02) — e ANTES de qualquer escrita.
 *
 *  1. ConsultarPedCompra de cada PC distinto, FORA de transacao. EXCECAO AO
 *     PRINCIPIO II (specs/007-stockbridge-module/research.md secao 2, ACXEGDP-437):
 *     a copia local pode estar minutos atras e outra NF pode ter consumido o saldo.
 *  2. Numa transacao, com pg_advisory_xact_lock por item de PC em ordem crescente
 *     (sem ciclo entre duas NFs):
 *       - vinculo `concluido` no mesmo item ha < 75 s -> PcRecemUsadoAguardeError
 *         (a leitura do passo 1 pode ter vindo do cache);
 *       - etapa != 15, sem o item, outro fornecedor ou saldo disponivel
 *         insuficiente -> PcVinculoInvalidoError. Saldo disponivel = nQtde - nQtdeRec
 *         AO VIVO (sem descontar vinculos concluidos: o OMIE ja os mostra) menos as
 *         reservas de OUTRAS NFs (confirmado/associado ha < 15 min). Acima da
 *         tolerancia so passa com justificativa; sem saldo nunca passa;
 *       - linhas vivas desta NF de tentativa anterior (orfa) viram `falha` — o lock
 *         da NF garante que nenhuma outra tentativa dela esta viva;
 *       - grava as linhas `confirmado` (a RESERVA), uma por sequencia.
 *  A trava solta no COMMIT; a reserva vale ate a linha virar concluido ou falha.
 */
export async function relerEReservarPcs(args: {
  empresa: EmpresaPc;
  ledgerId: string;
  nfChaveAcesso: string;
  notaFiscal: string;
  /** nIdFornecedor do recebimento — PC de outro fornecedor e recusado */
  fornecedorCodigo: number | null;
  userId: string;
  escolhas: EscolhaPcValidada[];
  /**
   * Vinculo VIVO de cada sequencia na ConsultarRecebimento desta tentativa (null = sem
   * vinculo). So com ele a escolha de origem 'omie' escapa da checagem de fornecedor.
   */
  vinculosVivos?: Record<number, { nIdPedido: number; nIdItPedido: number | null } | null>;
}): Promise<ReservaPc[]> {
  if (args.escolhas.length === 0) return [];
  const tol = toleranciasPc();

  // 1. Leitura ao vivo — uma por PC distinto, fora da transacao (chamada externa nao segura trava).
  const leituras = new Map<number, LeituraPc>();
  for (const ped of Array.from(new Set(args.escolhas.map((e) => e.candidato.nCodPed))).sort((a, b) => a - b)) {
    const pedido = await consultarPedidoCompra(args.empresa, { nCodPed: ped });
    leituras.set(ped, { pedido });
  }

  // Quanto cada item de PC precisa nesta NF (dois itens da NF podem apontar o mesmo item de PC).
  const porItemPc = new Map<number, EscolhaPcValidada[]>();
  for (const e of args.escolhas) {
    const lista = porItemPc.get(e.candidato.nCodItem);
    if (lista) lista.push(e);
    else porItemPc.set(e.candidato.nCodItem, [e]);
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const itensOrdenados = Array.from(porItemPc.keys()).sort((a, b) => a - b);
    for (const item of itensOrdenados) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`sb:pc-item:${args.empresa}:${item}`]);
    }

    // Tentativa anterior desta NF sem desfecho (orfa): libera a reserva antiga.
    await client.query(
      `UPDATE stockbridge.recebimento_fiscal_pc
          SET status = 'falha', updated_at = now(),
              erro_omie_mensagem = COALESCE(erro_omie_mensagem, 'Tentativa anterior sem desfecho; substituída por nova confirmação')
        WHERE nf_chave_acesso = $1 AND status IN ('confirmado', 'associado')`,
      [args.nfChaveAcesso],
    );

    const lidos = new Map<number, { saldoKg: number; precoKg: number | null; etapa: string; pcNumero: string }>();
    for (const item of itensOrdenados) {
      const escolhas = porItemPc.get(item)!;
      const c = escolhas[0]!.candidato;
      const pcNumero = c.pcNumero;
      // Numero lido AO VIVO antes de qualquer recusa: o vinculo do OMIE fora da copia
      // chega com pcNumero '' e as mensagens precisam do numero legivel.
      const pedido = leituras.get(c.nCodPed)!.pedido;
      const numeroVivo = (pedido.cNumero ?? '').trim() || pcNumero;
      const idPc = { nCodPed: c.nCodPed, nCodItem: item };

      const recente = await client.query<{ segundos: number | string }>(
        `SELECT CEIL(EXTRACT(EPOCH FROM (concluido_em + make_interval(secs => $3) - now())))::int AS segundos
           FROM stockbridge.recebimento_fiscal_pc
          WHERE empresa = $1 AND n_cod_item_ped = $2 AND status = 'concluido'
            AND concluido_em > now() - make_interval(secs => $3)
          ORDER BY concluido_em DESC LIMIT 1`,
        [args.empresa, item, PC_RECEM_USADO_SEG],
      );
      if (recente.rows[0]) throw new PcRecemUsadoAguardeError(numeroVivo, Math.max(1, Number(recente.rows[0].segundos)));

      const etapa = (pedido.cEtapa ?? '').trim();
      if (etapa !== '15') {
        throw new PcVinculoInvalidoError(
          args.notaFiscal,
          numeroVivo,
          etapa === '10' ? 'está aguardando aprovação no OMIE' : `não está aprovado no OMIE (etapa ${etapa || 'desconhecida'})`,
          idPc,
        );
      }
      // Vinculo que o proprio OMIE fez e que esta VIVO em todas as linhas da escolha: o OMIE ja
      // aceitou o PC, ainda que de outro cadastro do mesmo fornecedor (filial x matriz). Vinculo que
      // sumiu, ou que nao cobre todas as linhas, seria CRIADO pelo Atlas (ASSOCIAR): vale o FR-009
      // (revisao de 22/10/2026, achado sugestao-v01 — a origem vem do espelho lido no portao 1).
      const omieJaAceitou = escolhas.every(
        (e) =>
          e.origem === 'omie' &&
          e.sequencias.every((seq) => {
            const v = args.vinculosVivos?.[seq];
            return v != null && v.nIdPedido === e.candidato.nCodPed && v.nIdItPedido === e.candidato.nCodItem;
          }),
      );
      if (args.fornecedorCodigo != null && pedido.nCodFor !== args.fornecedorCodigo && !omieJaAceitou) {
        throw new PcVinculoInvalidoError(args.notaFiscal, numeroVivo, 'é de outro fornecedor', idPc);
      }
      const linha = pedido.produtos.find((p) => p.nCodItem === item);
      if (!linha) throw new PcVinculoInvalidoError(args.notaFiscal, numeroVivo, 'o item escolhido não existe mais no pedido', idPc);
      const fator = fatorUnidadePc(linha.cUnidade);
      if (fator == null) throw new PcVinculoInvalidoError(args.notaFiscal, numeroVivo, `a unidade do pedido (${linha.cUnidade ?? '—'}) não é comparável em kg`, idPc);

      const reservas = await client.query<{ kg: number | string }>(
        `SELECT COALESCE(SUM(qtd_nf_kg), 0)::float8 AS kg
           FROM stockbridge.recebimento_fiscal_pc
          WHERE empresa = $1 AND n_cod_item_ped = $2 AND status IN ('confirmado', 'associado')
            AND nf_chave_acesso <> $3 AND confirmado_em > now() - make_interval(mins => $4)`,
        [args.empresa, item, args.nfChaveAcesso, RESERVA_PC_VALIDADE_MIN],
      );
      const saldoVivoKg = Math.max(0, (Number(linha.nQtde) - Number(linha.nQtdeRec ?? 0)) * fator);
      const disponivelKg = Math.max(0, saldoVivoKg - Number(reservas.rows[0]?.kg ?? 0));
      const precisaKg = escolhas.reduce((acc, e) => acc + e.qtdNfKg, 0);
      if (disponivelKg <= 0) {
        throw new PcVinculoInvalidoError(args.notaFiscal, numeroVivo, `não tem saldo disponível (saldo atual: ${fmtKg(disponivelKg)} kg)`, idPc);
      }
      const cabe = precisaKg <= disponivelKg * (1 + tol.qtd) + EPS;
      const justificado = escolhas.every((e) => e.justificativa != null);
      if (!cabe && !justificado) {
        throw new PcVinculoInvalidoError(
          args.notaFiscal,
          numeroVivo,
          `o saldo disponível (${fmtKg(disponivelKg)} kg) não cobre a NF (${fmtKg(precisaKg)} kg)`,
          idPc,
        );
      }
      lidos.set(item, {
        // data-model §4: o saldo RELIDO do OMIE (nQtde - nQtdeRec), nao o disponivel apos as reservas
        saldoKg: saldoVivoKg,
        precoKg: linha.nValUnit != null ? Number(linha.nValUnit) / fator : null,
        etapa,
        // numero lido AO VIVO: o vinculo do OMIE fora da copia chega aqui com pcNumero ''
        pcNumero: numeroVivo,
      });
    }

    // Reserva: uma linha `confirmado` por sequencia do item.
    const reservasGravadas: ReservaPc[] = [];
    for (const e of args.escolhas) {
      const l = lidos.get(e.candidato.nCodItem)!;
      for (const seq of e.sequencias) {
        const kg = e.kgPorSequencia[seq] ?? 0;
        const anterior = anteriorDaSequencia(e, seq);
        const ins = await client.query<{ id: string }>(
          `INSERT INTO stockbridge.recebimento_fiscal_pc
             (recebimento_fiscal_id, empresa, nf_chave_acesso, n_sequencia, origem, n_cod_ped, n_cod_item_ped, pc_numero,
              n_cod_ped_omie_anterior, n_cod_item_ped_omie_anterior, dentro_tolerancia, justificativa, candidatos,
              qtd_nf_kg, preco_nf, saldo_pc_kg_lido, preco_pc_lido, etapa_pc_lida, status, confirmado_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, 'confirmado', $19)
           RETURNING id`,
          [
            args.ledgerId, args.empresa, args.nfChaveAcesso, seq, e.origem, e.candidato.nCodPed, e.candidato.nCodItem,
            l.pcNumero || e.candidato.pcNumero || '', anterior?.nIdPedido ?? null, anterior?.nIdItPedido ?? null, e.dentroTolerancia, e.justificativa,
            JSON.stringify(e.oferecidos), kg.toFixed(3), e.precoNfKg.toFixed(6), l.saldoKg.toFixed(3),
            l.precoKg != null ? l.precoKg.toFixed(6) : null, l.etapa.slice(0, 2), args.userId,
          ],
        );
        reservasGravadas.push({
          id: ins.rows[0]!.id,
          nSequencia: seq,
          indice: e.indice,
          nCodPed: e.candidato.nCodPed,
          nCodItemPed: e.candidato.nCodItem,
          pcNumero: l.pcNumero || e.candidato.pcNumero,
          origem: e.origem,
        });
      }
    }
    await client.query('COMMIT');
    logger.info(
      { nf: args.notaFiscal, ledgerId: args.ledgerId, reservas: reservasGravadas.length, itensPc: itensOrdenados.length },
      'PCs relidos no OMIE e reservados',
    );
    return reservasGravadas;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
