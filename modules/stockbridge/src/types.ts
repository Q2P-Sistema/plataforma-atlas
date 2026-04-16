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

export type EstagioTransito = 'transito_intl' | 'porto_dta' | 'transito_interno' | 'reservado';

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
  | 'ajuste_inventario';

export type TipoDivergencia = 'faltando' | 'varredura' | 'cruzada' | 'fiscal_pendente';

export type StatusAprovacao = 'pendente' | 'aprovada' | 'rejeitada';

export type StatusDivergencia = 'aberta' | 'regularizada' | 'descartada';

export type TipoLocalidade = 'proprio' | 'tpl' | 'porto_seco' | 'virtual_transito' | 'virtual_ajuste';

export type UnidadeMedida = 't' | 'kg' | 'saco' | 'bigbag';

export const FATOR_PARA_TONELADA: Record<UnidadeMedida, number> = {
  t: 1,
  kg: 0.001,
  saco: 0.025, // saco de 25 kg
  bigbag: 1, // big bag de 1 tonelada
};

export const CNPJ_ACXE = 'Acxe Matriz';
export const CNPJ_Q2P_MATRIZ = 'Q2P Matriz';
export const CNPJ_Q2P_FILIAL = 'Q2P Filial';

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
 * Operador so ve transito_interno e reservado (FR-006).
 */
export const ESTAGIOS_VISIVEIS_POR_PERFIL: Record<Perfil, readonly EstagioTransito[]> = {
  operador: ['transito_interno', 'reservado'],
  gestor: ['transito_intl', 'porto_dta', 'transito_interno', 'reservado'],
  diretor: ['transito_intl', 'porto_dta', 'transito_interno', 'reservado'],
};
