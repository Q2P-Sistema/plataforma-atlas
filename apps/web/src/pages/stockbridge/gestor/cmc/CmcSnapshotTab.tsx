import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useAuthStore } from '../../../../stores/auth.store.js';
import { FamiliaTree } from './FamiliaTree.js';
import { fmtKg, fmtBrl, fmtDataBr } from './format.js';
import { cmcParams, type CmcUiFiltros } from './filtros.js';
import type { CmcSnapshotResponse } from './types.js';

/**
 * Aba "Snapshot diário" (US1): resumo global (volume + valor, sem CMC global —
 * FR-018) + árvore família→produto da posição mais recente, respeitando os
 * filtros compartilhados (US3). Read-only, gestor+.
 */
export function CmcSnapshotTab({ filtros }: { filtros: CmcUiFiltros }) {
  const csrfToken = useAuthStore((s) => s.csrfToken);

  const { data, isLoading, error } = useQuery<CmcSnapshotResponse>({
    queryKey: ['stockbridge', 'cmc', 'snapshot', filtros],
    queryFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      const res = await fetch(`/api/v1/stockbridge/cmc/snapshot${cmcParams(filtros)}`, {
        credentials: 'include',
        headers,
      });
      const body = (await res.json()) as {
        data: CmcSnapshotResponse | null;
        error: { message?: string } | null;
      };
      if (!res.ok) throw new Error(body.error?.message ?? 'Erro ao carregar Custos de Estoque');
      return body.data as CmcSnapshotResponse;
    },
  });

  // Ordena famílias por valor imobilizado (maior primeiro) — concentração de custo.
  const familias = useMemo(
    () => [...(data?.familias ?? [])].sort((a, b) => b.valor - a.valor),
    [data?.familias],
  );

  return (
    <div>
      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          {(error as Error).message}
        </div>
      )}

      {data?.dataSnapshot && (
        <div className="mb-3 flex items-center gap-3 flex-wrap">
          <span className="text-xs text-atlas-muted">
            Posição em <span className="font-medium text-atlas-ink">{fmtDataBr(data.dataSnapshot)}</span>
          </span>
          {data.defasado && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="w-3 h-3" />
              Dado defasado — não é do dia corrente
            </span>
          )}
        </div>
      )}

      {/* Resumo global (FR-018): quantidade + valor; sem CMC global. */}
      {data && (
        <div className="mb-5 flex flex-wrap gap-3">
          <ResumoCard label="Em estoque" value={`${fmtKg(data.resumo.volumeTotalKg)} kg`} tone="text-atlas-ink" />
          <ResumoCard label="Valor total" value={fmtBrl(data.resumo.valorTotal)} tone="text-q2p" />
        </div>
      )}

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando...</div>}

      {data && familias.length === 0 && !isLoading && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-slate-300 dark:border-slate-700 rounded-lg">
          Nenhum dado de custo encontrado para os filtros selecionados.
        </div>
      )}

      {data && familias.length > 0 && <FamiliaTree familias={familias} />}
    </div>
  );
}

function ResumoCard({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 min-w-[180px]">
      <div className="text-xs uppercase tracking-wide text-atlas-muted font-medium mb-0.5">{label}</div>
      <div className={`font-serif text-lg ${tone}`}>{value}</div>
    </div>
  );
}
