/**
 * Tipos compartilhados do modulo StockBridge.
 * Centralizados aqui para evitar duplicacao entre services, routes e tests.
 */

export type Perfil = 'operador' | 'gestor' | 'diretor';

export type StatusLote =
  | 'reconciliado'
  | 'divergencia'
  | 'transito'
  | 'provisorio'
  | 'aguardando_aprovacao'
  | 'rejeitado';

export type EstagioTransito = 'aguardando_embarque' | 'transito_intl' | 'no_porto' | 'transito_local' | 'transito_interno' | 'reservado';

export type TipoMovimento =
  | 'entrada_nf'
  | 'entrada_manual'
  | 'saida_automatica'
  | 'saida_manual'
  | 'ajuste'
  | 'regularizacao_fiscal'
  | 'debito_cruzado';

/**
 * 19 subtipos cobrindo todos os tipos do diagrama legado.
 * Entradas: 7 | Saidas: 12
 */
export type SubtipoMovimento =
  // Entradas (7)
  | 'importacao'
  | 'devolucao_cliente'
  | 'compra_nacional'
  | 'retorno_remessa'
  | 'retorno_comodato'
  | 'entrada_manual'
  | 'inventario_mais'
  // Saidas (12)
  | 'venda'
  | 'remessa_beneficiamento'
  | 'transf_cnpj'
  | 'devolucao_fornecedor'
  | 'debito_cruzado'
  | 'regularizacao_fiscal'
  | 'transf_intra_cnpj'
  | 'comodato'
  | 'amostra'
  | 'descarte'
  | 'quebra'
  | 'inventario_menos';

export type TipoAprovacao =
  | 'recebimento_divergencia'
  | 'entrada_manual'
  | 'saida_transf_intra'
  | 'saida_comodato'
  | 'saida_amostra'
  | 'saida_descarte'
  | 'saida_quebra'
  | 'ajuste_inventario'
  | 'retorno_comodato';

export type TipoDivergencia = 'faltando' | 'varredura' | 'cruzada' | 'fiscal_pendente';

export type StatusAprovacao = 'pendente' | 'aprovada' | 'rejeitada';

export type StatusDivergencia = 'aberta' | 'regularizada' | 'descartada';

/**
 * Estado de sincronizacao com OMIE de uma movimentacao.
 * - concluida: ambos lados (ACXE + Q2P) confirmados (default).
 * - pendente_q2p: ACXE escreveu mas Q2P falhou — aguarda retry.
 * - pendente_acxe_faltando: segunda chamada ACXE (transferirDiferenca) falhou.
 * - falha: marcada manualmente por admin como nao-recuperavel.
 */
export type StatusOmie = 'concluida' | 'pendente_q2p' | 'pendente_acxe_faltando' | 'falha';

export function isStatusOmiePendente(status: StatusOmie): boolean {
  return status === 'pendente_q2p' || status === 'pendente_acxe_faltando';
}

/**
 * Estado da baixa do pedido de compra Q2P de uma entrada de importacao
 * (ACXEGDP-344, migration 0047). NULL na movimentacao = nao se aplica.
 * - pendente: aguardando a baixa (recem-recebida, ou backfill).
 * - concluida: toda a quantidade recebida foi descontada de pedidos Q2P.
 * - sem_saldo: descontou o que havia mas sobrou quantidade sem pedido aberto —
 *   revisao manual (mesmo alerta que o legado enviava por e-mail).
 * - falha: OMIE falhou em alguma chamada — retentavel pelo painel.
 */
export type StatusBaixaPedidoQ2p = 'pendente' | 'concluida' | 'sem_saldo' | 'falha';

/**
 * O OMIE rejeita nQtde=0 no AlteraPedCompra. O legado PHP zerava pedidos
 * gravando 0,1 kg (`'nQtde' => $novoEstoque ?: 0.1`) — 62 pedidos em PROD
 * carregam essa marca. Mantido por paridade: um pedido com saldo <= sentinela
 * e considerado ZERADO (nao entra na FIFO).
 */
export const QTD_SENTINELA_PEDIDO_ZERADO_KG = 0.1;

/**
 * Sufixos do cod_int_ajuste enviado ao OMIE. Combinados com o op_id da
 * movimentacao para identificar de forma unica cada chamada IncluirAjusteEstoque.
 *
 * Os sufixos de saida manual (STK-03, ACXEGDP-283) sao LOAD-BEARING em dois
 * pontos que precisam concordar byte a byte: a chamada original em
 * omie-saida.service.ts e o retry em operacoes-pendentes.service.ts (que
 * verifica via ListarAjusteEstoque se a chamada anterior chegou a persistir).
 */
export const COD_INT_AJUSTE_SUFIXO = {
  // Recebimento (fluxo com lote)
  acxeTrf: 'acxe-trf',
  q2pEnt: 'q2p-ent',
  acxeFaltando: 'acxe-faltando',
  // Saidas manuais SAI (amostra/descarte/quebra = PER; inventario_menos = INV)
  saidaPerAcxe: 'saida-per-acxe',
  saidaPerQ2p: 'saida-per-q2p',
  saidaInvAcxe: 'saida-inv-acxe',
  saidaInvQ2p: 'saida-inv-q2p',
  // Transferencia intra-CNPJ (TRF origem -> destino)
  trfIntraAcxe: 'trf-intra-acxe',
  trfIntraQ2p: 'trf-intra-q2p',
  // Comodato (TRF origem -> TROCA 90.0.1)
  comodatoTrfAcxe: 'comodato-trf-acxe',
  comodatoTrfQ2p: 'comodato-trf-q2p',
  // Retorno de comodato (SAI baixa no TROCA + ENT no destino, por empresa)
  retBaixaAcxe: 'ret-baixa-acxe',
  retEntradaAcxe: 'ret-entrada-acxe',
  retBaixaQ2p: 'ret-baixa-q2p',
  retEntradaQ2p: 'ret-entrada-q2p',
} as const;

export type CodIntAjusteSufixo = (typeof COD_INT_AJUSTE_SUFIXO)[keyof typeof COD_INT_AJUSTE_SUFIXO];

export function buildCodIntAjuste(opId: string, sufixo: CodIntAjusteSufixo): string {
  return `${opId}:${sufixo}`;
}

export type TipoLocalidade = 'proprio' | 'tpl' | 'porto_seco' | 'virtual_transito' | 'virtual_ajuste';

export type UnidadeMedida = 't' | 'kg' | 'saco' | 'bigbag';

export const FATOR_PARA_KG: Record<UnidadeMedida, number> = {
  t: 1000,
  kg: 1,
  saco: 25, // saco de 25 kg
  bigbag: 1000, // big bag de 1 tonelada = 1000 kg
};

export const CNPJ_ACXE = 'Acxe Matriz';
export const CNPJ_Q2P_MATRIZ = 'Q2P Matriz';
export const CNPJ_Q2P_FILIAL = 'Q2P Filial';

/**
 * CNPJ numérico (14 díg, sem máscara) da ACXE — usado para identificar o emitente
 * de uma NF a partir da chave NFe (`tbl_nf_header_ACXE.c_chave_nfe`, posições 7-20)
 * na validação do recebimento (feature 012 / ACXEGDP-205). ACXE IMPORTACAO...
 */
export const CNPJ_ACXE_NUMERICO = '42672052000154';

export type CnpjValor = typeof CNPJ_ACXE | typeof CNPJ_Q2P_MATRIZ | typeof CNPJ_Q2P_FILIAL;

/**
 * Mapa de subtipo → nivel de aprovacao exigido para saidas manuais.
 * Fonte: research.md secao 10 + StockBridge_Diagrama.html do legado.
 */
export const NIVEL_APROVACAO_POR_SUBTIPO: Partial<Record<SubtipoMovimento, 'gestor' | 'diretor'>> = {
  transf_intra_cnpj: 'gestor',
  comodato: 'diretor',
  amostra: 'gestor',
  descarte: 'gestor',
  quebra: 'gestor',
  inventario_menos: 'gestor',
  inventario_mais: 'gestor',
  entrada_manual: 'gestor',
};

/**
 * Visibilidade por perfil.
 * Todos os perfis veem os 3 estagios — modulo e puramente espelho do FUP de Comex,
 * sem acoes que justifiquem RBAC mais restritivo.
 * O estagio 'reservado' permanece no enum por compatibilidade mas nao e usado mais.
 */
export const ESTAGIOS_VISIVEIS_POR_PERFIL: Record<Perfil, readonly EstagioTransito[]> = {
  operador: ['transito_interno', 'reservado'],
  gestor:   ['aguardando_embarque', 'transito_intl', 'no_porto', 'transito_local', 'reservado'],
  diretor:  ['aguardando_embarque', 'transito_intl', 'no_porto', 'transito_local', 'reservado'],
};
