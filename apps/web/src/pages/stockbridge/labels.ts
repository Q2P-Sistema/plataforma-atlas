// Rótulos legíveis dos enums do StockBridge — evita expor valores crus
// (snake_case) do banco na UI (auditoria pt-BR PTB-4, ACXEGDP-259).
// Fontes: TransitoPage (COLUNAS) e MovimentacoesPage (<option>). Valor
// desconhecido cai no próprio valor (comportamento aditivo, sem quebra).

export const ESTAGIO_FUP_LABEL: Record<string, string> = {
  aguardando_embarque: 'Aguardando Embarque',
  transito_intl: 'Em Águas',
  no_porto: 'No Porto',
  transito_local: 'Em Trânsito Local',
  transito_interno: 'Trânsito Interno',
};

export const TIPO_MOVIMENTO_LABEL: Record<string, string> = {
  entrada_nf: 'Entrada NF',
  entrada_manual: 'Entrada manual',
  saida_automatica: 'Saída automática',
  saida_manual: 'Saída manual',
  debito_cruzado: 'Débito cruzado',
  regularizacao_fiscal: 'Regularização fiscal',
  ajuste: 'Ajuste',
};

export const SUBTIPO_LABEL: Record<string, string> = {
  transf_intra_cnpj: 'Transferência intra-CNPJ',
  comodato: 'Comodato',
  retorno_comodato: 'Retorno de comodato',
  amostra: 'Amostra',
  descarte: 'Descarte',
  quebra: 'Quebra',
  inventario_menos: 'Inventário (-)',
  inventario_mais: 'Inventário (+)',
  importacao: 'Importação',
  venda: 'Venda',
  remessa_beneficiamento: 'Remessa p/ beneficiamento',
  devolucao_fornecedor: 'Devolução a fornecedor',
  devolucao_cliente: 'Devolução de cliente',
  compra_nacional: 'Compra nacional',
  transf_cnpj: 'Transferência entre CNPJ',
  faltando: 'Faltando',
  varredura: 'Varredura',
};

export const ROLE_LABEL: Record<string, string> = {
  operador: 'Operador',
  gestor: 'Gestor',
  diretor: 'Diretor',
  admin: 'Administrador',
};

/** Aplica um mapa de rótulos; valor desconhecido volta como veio. */
export function rotulo(map: Record<string, string>, v: string | null | undefined): string {
  if (!v) return '—';
  return map[v] ?? v;
}
