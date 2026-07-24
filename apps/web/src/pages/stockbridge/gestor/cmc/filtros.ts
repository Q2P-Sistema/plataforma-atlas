// Estado de filtros compartilhado pelas duas abas (US3) + helper de query string.

export type CmcOrigemFiltro = '' | 'IMPORTADO' | 'NACIONAL'; // '' = ambas

export interface CmcUiFiltros {
  familias: string[];
  produtos: string[];
  origem: CmcOrigemFiltro;
}

export const FILTROS_VAZIOS: CmcUiFiltros = { familias: [], produtos: [], origem: '' };

/** Monta a query string para os endpoints de CMC (família/produto repetidos). */
export function cmcParams(f: CmcUiFiltros, extra?: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const fam of f.familias) p.append('familia', fam);
  for (const prod of f.produtos) p.append('produto', prod);
  if (f.origem) p.set('origem', f.origem);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}
