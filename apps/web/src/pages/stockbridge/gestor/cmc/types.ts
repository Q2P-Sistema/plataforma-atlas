// Espelha os read-models do backend (modules/stockbridge/src/services/cmc.service.ts).
// Mantido em sincronia manual — feature 008 (Custos de Estoque / CMC).

export type CmcOrigem = 'IMPORTADO' | 'NACIONAL';

export interface CmcResumo {
  volumeTotalKg: number;
  valorTotal: number;
}

export interface CmcProdutoNode {
  codigoProduto: string;
  descricaoProduto: string;
  origem: CmcOrigem;
  cmcPonderado: number | null; // R$/kg; null quando volume 0
  volumeKg: number;
  valor: number;
}

export interface CmcOrigemAgg {
  cmcPonderado: number | null;
  volumeKg: number;
  valor: number;
}

export interface CmcFamiliaNode {
  descricaoFamilia: string;
  cmcPonderado: number | null;
  volumeKg: number;
  valor: number;
  porOrigem: { importado: CmcOrigemAgg; nacional: CmcOrigemAgg };
  produtos: CmcProdutoNode[];
}

export interface CmcSnapshotResponse {
  dataSnapshot: string | null;
  defasado: boolean;
  resumo: CmcResumo;
  familias: CmcFamiliaNode[];
}

// US2 — Tendência histórica
export interface CmcTendenciaPonto {
  data: string;
  cmcPonderado: number | null;
  volumeKg: number;
  valor: number;
}

export interface CmcTendenciaSerie {
  chave: string;
  label: string;
  pontos: (CmcTendenciaPonto | null)[]; // null = dia sem coleta (lacuna)
}

export interface CmcTendenciaResponse {
  datas: string[];
  series: CmcTendenciaSerie[];
}

// US3 — Opções de filtro (combos)
export interface CmcFiltrosResponse {
  familias: string[];
  produtos: { codigo: string; descricao: string; familia: string }[];
}
