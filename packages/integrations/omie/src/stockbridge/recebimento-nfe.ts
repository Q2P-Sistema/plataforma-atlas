import { callOmie, isMockMode, type OmieCnpj } from '../client.js';
import {
  mockAlterarRecebimentoNfeItens,
  mockConcluirRecebimentoNfe,
  mockConsultarRecebimentoNfe,
} from './mock.js';

/**
 * Recebimento de NF-e (caixa "Recebimento de NF-e" do OMIE) — feature 016
 * (ACXEGDP-395). Endpoint `produtos/recebimentonfe/`.
 *
 * EXCECAO AO PRINCIPIO II (documentada em specs/007-stockbridge-module/research.md
 * secao 2 e em specs/016-recebimento-fiscal-nf/research.md):
 *  - `ConsultarRecebimento` (leitura) e chamado UMA vez, imediatamente antes da
 *    escrita, para saber se o fiscal ja foi concluido por alguem no OMIE. A
 *    fila do Atlas NAO le daqui — le do espelho `tbl_recebimentoNFe_Q2P`.
 *  - `AlterarRecebimento` e `ConcluirRecebimento` (escrita) concluem o
 *    recebimento FISCAL sem movimentar estoque, reproduzindo o "Ignorar" da
 *    tela: EDITAR (cNaoGerarMovEstoque=S, cNaoGerarFinanceiro=N) -> IGNORAR ->
 *    Concluir (cEtapa 60). Testado em producao na NF 6842 (02/10/2026).
 *
 * Gotchas medidos:
 *  - IGNORAR com `itensAjustes` no mesmo item devolve SOAP-ENV:Client-151 e nao
 *    altera nada — por isso sao DUAS chamadas e a validacao local recusa antes.
 *  - `ConsultarRecebimento` com corpo identico em < ~1 min devolve resposta
 *    antiga (cache do OMIE): a reconsulta apos falha deve variar o corpo
 *    (nIdReceb x cChaveNfe). O lock de idempotencia e do Atlas (ledger), nao daqui.
 *  - Escritas SEM retry (STK-23): idempotencia pelo ledger + reconsulta.
 */

export type SimNao = 'S' | 'N';

export interface ItemRecebimentoNfe {
  nSequencia: number;
  cDescricaoProduto: string;
  cCodigoProduto: string | null;
  cNCM: string | null;
  /** CFOP do FORNECEDOR (5.102/6.101) — nao e o do recorte da fila. */
  cCFOP: string | null;
  /** CFOP de ENTRADA (1.102/2.102) — este e o do recorte da fila. */
  cCFOPEntrada: string | null;
  nQtdeNFe: number;
  cUnidadeNfe: string | null;
  nPrecoUnit: number | null;
  /** Valor do item com tributos uma vez (= v_prod do espelho de NF — research D7). */
  vTotalItem: number;
  cIgnorarItem: SimNao | null;
  cAssociarExistente: SimNao | null;
  cAdicionarNovo: SimNao | null;
  nIdItem: number | null;
  nIdProduto: number | null;
  cNaoGerarMovEstoque: SimNao | null;
  cNaoGerarFinanceiro: SimNao | null;
}

export interface RecebimentoNfeConsultado {
  nIdReceb: number;
  cChaveNFe: string;
  /** Zero-padded como o OMIE devolve ('000006842'). */
  cNumeroNFe: string;
  cEtapa: string;
  dEmissaoNFe: string | null; // dd/MM/yyyy
  /**
   * null quando o recebimento NAO tem fornecedor cadastrado no OMIE. O OMIE real
   * devolve `nIdFornecedor: 0` nesse caso (NF 1257, sonda de 02/10/2026) — o
   * parser normaliza 0 para null.
   */
  nIdFornecedor: number | null;
  cCNPJ_CPF: string | null;
  cRazaoSocial: string | null;
  nValorNFe: number | null;
  cRecebido: SimNao;
  cCancelada: SimNao;
  /** infoCadastro.cBloqueado / cDevolvido — o Atlas nao conclui recebimento bloqueado ou devolvido. */
  cBloqueado: SimNao | null;
  cDevolvido: SimNao | null;
  cUsuarioRec: string | null;
  dRec: string | null;
  hRec: string | null;
  itens: ItemRecebimentoNfe[];
}

export type RecebimentoNfeRef = { nIdReceb: number } | { cChaveNfe: string };

export type AcaoItemRecebimento = 'EDITAR' | 'IGNORAR';

export interface AjustesItemRecebimento {
  cNaoGerarMovEstoque?: SimNao;
  cNaoGerarFinanceiro?: SimNao;
}

export interface ItemRecebimentoEditar {
  nSequencia: number;
  cAcao: AcaoItemRecebimento;
  /** So com cAcao='EDITAR' — com 'IGNORAR' o OMIE recusa (erro 151). */
  itensAjustes?: AjustesItemRecebimento;
}

export interface AlterarRecebimentoNfeItensInput {
  nIdReceb: number;
  itens: ItemRecebimentoEditar[];
}

export interface ConcluirRecebimentoNfeInput {
  nIdReceb: number;
  /** Etapa de destino; default '60' (Recebido). */
  cEtapa?: string;
}

export interface RecebimentoNfeStatusResponse {
  nIdReceb: number;
  cCodStatus: string;
  cDescStatus: string;
}

type RawRecebimento = {
  cabec?: Record<string, unknown>;
  infoCadastro?: Record<string, unknown>;
  itensRecebimento?: Array<{ itensCabec?: Record<string, unknown>; itensAjustes?: Record<string, unknown> }>;
};

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const simNao = (v: unknown): SimNao | null => (v === 'S' || v === 'N' ? v : null);

/** Parser do bloco devolvido por ConsultarRecebimento / ListarRecebimentos (cExibirDetalhes=S). Exportado para testes. */
export function parseRecebimentoNfeConsultado(raw: RawRecebimento): RecebimentoNfeConsultado {
  const c = raw.cabec ?? {};
  const i = raw.infoCadastro ?? {};
  const nIdReceb = num(c.nIdReceb);
  const cChaveNFe = str(c.cChaveNFe);
  if (nIdReceb == null || !cChaveNFe) {
    throw new Error('ConsultarRecebimento devolveu bloco sem nIdReceb/cChaveNFe — estrutura invalida');
  }
  // Sem infoCadastro.cRecebido nao da para saber se o fiscal ja foi concluido —
  // assumir 'N' faria o Atlas escrever num recebimento possivelmente concluido
  // ou cancelado. Falha fechado (revisao pre-UAT, FISC-5).
  const cRecebido = simNao(i.cRecebido);
  if (cRecebido == null) {
    throw new Error('ConsultarRecebimento devolveu bloco sem infoCadastro.cRecebido — estrutura invalida');
  }
  const nIdFornecedor = num(c.nIdFornecedor);
  const itens: ItemRecebimentoNfe[] = (raw.itensRecebimento ?? []).map((it) => {
    const ic = it.itensCabec ?? {};
    const aj = it.itensAjustes ?? {};
    return {
      nSequencia: num(ic.nSequencia) ?? 0,
      cDescricaoProduto: str(ic.cDescricaoProduto) ?? '',
      cCodigoProduto: str(ic.cCodigoProduto),
      cNCM: str(ic.cNCM),
      cCFOP: str(ic.cCFOP),
      cCFOPEntrada: str(aj.cCFOPEntrada),
      nQtdeNFe: num(ic.nQtdeNFe) ?? 0,
      cUnidadeNfe: str(ic.cUnidadeNfe),
      nPrecoUnit: num(ic.nPrecoUnit),
      vTotalItem: num(ic.vTotalItem) ?? 0,
      cIgnorarItem: simNao(ic.cIgnorarItem),
      cAssociarExistente: simNao(ic.cAssociarExistente),
      cAdicionarNovo: simNao(ic.cAdicionarNovo),
      nIdItem: num(ic.nIdItem),
      nIdProduto: num(ic.nIdProduto),
      cNaoGerarMovEstoque: simNao(aj.cNaoGerarMovEstoque),
      cNaoGerarFinanceiro: simNao(aj.cNaoGerarFinanceiro),
    };
  });
  return {
    nIdReceb,
    cChaveNFe,
    cNumeroNFe: str(c.cNumeroNFe) ?? '',
    cEtapa: str(c.cEtapa) ?? '',
    dEmissaoNFe: str(c.dEmissaoNFe),
    nIdFornecedor: nIdFornecedor != null && nIdFornecedor > 0 ? nIdFornecedor : null,
    cCNPJ_CPF: str(c.cCNPJ_CPF),
    cRazaoSocial: str(c.cRazaoSocial),
    nValorNFe: num(c.nValorNFe),
    cRecebido,
    cCancelada: simNao(i.cCancelada) ?? 'N',
    cBloqueado: simNao(i.cBloqueado),
    cDevolvido: simNao(i.cDevolvido),
    cUsuarioRec: str(i.cUsuarioRec),
    dRec: str(i.dRec),
    hRec: str(i.hRec),
    itens,
  };
}

/**
 * Consulta um recebimento de NF-e por id OMIE ou pela chave de acesso.
 * Leitura idempotente — retry em falha transiente (STK-23).
 *
 * Para furar o cache de ~1 min do OMIE, a reconsulta apos uma escrita deve usar
 * a OUTRA forma de referencia (se a primeira foi por cChaveNfe, reconsultar por
 * nIdReceb) — ver research D2 da feature 016.
 */
export async function consultarRecebimentoNfe(cnpj: OmieCnpj, ref: RecebimentoNfeRef): Promise<RecebimentoNfeConsultado> {
  if (isMockMode()) {
    return mockConsultarRecebimentoNfe(cnpj, ref);
  }
  const params: Record<string, unknown> = 'nIdReceb' in ref ? { nIdReceb: ref.nIdReceb } : { cChaveNfe: ref.cChaveNfe };
  const raw = await callOmie<RawRecebimento>(
    cnpj,
    { endpoint: 'produtos/recebimentonfe/', method: 'ConsultarRecebimento', params },
    { retries: 2 },
  );
  return parseRecebimentoNfeConsultado(raw);
}

/**
 * Valida localmente o que o OMIE recusaria com erro 151 — recusar ANTES de
 * chamar evita gastar a chamada e deixar a sequencia pela metade.
 */
export function validarItensRecebimentoEditar(itens: ItemRecebimentoEditar[]): void {
  if (itens.length === 0) throw new Error('alterarRecebimentoNfeItens exige ao menos um item');
  for (const it of itens) {
    if (it.cAcao !== 'EDITAR' && it.itensAjustes !== undefined) {
      throw new Error(
        `alterarRecebimentoNfeItens: item ${it.nSequencia} com cAcao='${it.cAcao}' nao pode levar itensAjustes ` +
          '(o OMIE recusa com SOAP-ENV:Client-151). Faca EDITAR com ajustes e depois IGNORAR sem ajustes.',
      );
    }
  }
}

/**
 * Altera os itens de um recebimento (cAcao EDITAR | IGNORAR). Escrita — SEM retry.
 * Endpoint produtos/recebimentonfe/ -> AlterarRecebimento.
 */
export async function alterarRecebimentoNfeItens(
  cnpj: OmieCnpj,
  input: AlterarRecebimentoNfeItensInput,
): Promise<RecebimentoNfeStatusResponse> {
  validarItensRecebimentoEditar(input.itens);
  if (isMockMode()) {
    return mockAlterarRecebimentoNfeItens(cnpj, input);
  }
  const params = {
    ide: { nIdReceb: input.nIdReceb },
    itensRecebimentoEditar: input.itens.map((it) => {
      const item: Record<string, unknown> = { itensIde: { nSequencia: it.nSequencia, cAcao: it.cAcao } };
      if (it.itensAjustes !== undefined) item.itensAjustes = it.itensAjustes;
      return item;
    }),
  };
  const raw = await callOmie<Partial<RecebimentoNfeStatusResponse>>(cnpj, {
    endpoint: 'produtos/recebimentonfe/',
    method: 'AlterarRecebimento',
    params,
  });
  return {
    nIdReceb: raw.nIdReceb ?? input.nIdReceb,
    cCodStatus: raw.cCodStatus ?? '0',
    cDescStatus: raw.cDescStatus ?? '',
  };
}

/**
 * Conclui o recebimento (move o card para a etapa informada; 60 = Recebido).
 * Escrita — SEM retry. Endpoint produtos/recebimentonfe/ -> ConcluirRecebimento.
 */
export async function concluirRecebimentoNfe(
  cnpj: OmieCnpj,
  input: ConcluirRecebimentoNfeInput,
): Promise<RecebimentoNfeStatusResponse> {
  if (isMockMode()) {
    return mockConcluirRecebimentoNfe(cnpj, input);
  }
  const raw = await callOmie<Partial<RecebimentoNfeStatusResponse>>(cnpj, {
    endpoint: 'produtos/recebimentonfe/',
    method: 'ConcluirRecebimento',
    params: { nIdReceb: input.nIdReceb, cEtapa: input.cEtapa ?? '60' },
  });
  return {
    nIdReceb: raw.nIdReceb ?? input.nIdReceb,
    cCodStatus: raw.cCodStatus ?? '0',
    cDescStatus: raw.cDescStatus ?? '',
  };
}
