// Rótulos legíveis dos enums do Hedge — evita expor valores crus (snake_case /
// minúsculos) do banco na UI (auditoria pt-BR PTB-2, ACXEGDP-257).
// Valor desconhecido cai no próprio valor (comportamento aditivo, sem quebra).

export const NDF_STATUS_LABEL: Record<string, string> = {
  ativo: 'Ativo',
  liquidado: 'Liquidado',
  cancelado: 'Cancelado',
  pendente: 'Pendente',
};

export const NDF_TIPO_LABEL: Record<string, string> = {
  ndf: 'NDF',
  trava: 'Trava',
  acc: 'ACC',
};

export const EMPRESA_LABEL: Record<string, string> = {
  acxe: 'ACXE',
  q2p: 'Q2P',
};

export const PRIORIDADE_LABEL: Record<string, string> = {
  critica: 'Crítica',
  alta: 'Alta',
  media: 'Média',
  baixa: 'Baixa',
  nenhuma: 'Nenhuma',
};

/** Aplica um mapa de rótulos; valor desconhecido volta como veio. */
export function rotulo(map: Record<string, string>, v: string | null | undefined): string {
  if (!v) return '—';
  return map[v] ?? v;
}
