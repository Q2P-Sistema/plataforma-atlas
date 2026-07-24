import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';
import { CmcSnapshotTab } from './cmc/CmcSnapshotTab.js';
import { CmcTendenciaTab } from './cmc/CmcTendenciaTab.js';
import { MultiSelectCombo } from './cmc/MultiSelectCombo.js';
import type { CmcOrigemFiltro, CmcUiFiltros } from './cmc/filtros.js';
import type { CmcFiltrosResponse } from './cmc/types.js';

type CmcTab = 'snapshot' | 'tendencia';

const ORIGENS: { value: CmcOrigemFiltro; label: string }[] = [
  { value: '', label: 'Ambas' },
  { value: 'IMPORTADO', label: 'Importado' },
  { value: 'NACIONAL', label: 'Nacional' },
];

/**
 * Custos de Estoque (CMC por família e produto) — feature 008. Acesso gestor+.
 * Duas abas (FR-016): Snapshot diário (US1) e Tendência histórica (US2). A barra
 * de filtros (US3) é compartilhada pelas duas abas.
 */
export function CmcPage() {
  const [tab, setTab] = useState<CmcTab>('snapshot');
  const [familias, setFamilias] = useState<string[]>([]);
  const [produtos, setProdutos] = useState<string[]>([]);
  const [origem, setOrigem] = useState<CmcOrigemFiltro>('');
  const csrfToken = useAuthStore((s) => s.csrfToken);

  const filtros: CmcUiFiltros = useMemo(
    () => ({ familias, produtos, origem }),
    [familias, produtos, origem],
  );

  // Opções dos combos (do snapshot mais recente).
  const { data: opcoes } = useQuery<CmcFiltrosResponse>({
    queryKey: ['stockbridge', 'cmc', 'filtros'],
    queryFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      const res = await fetch('/api/v1/stockbridge/cmc/filtros', { credentials: 'include', headers });
      const body = (await res.json()) as { data: CmcFiltrosResponse | null; error: { message?: string } | null };
      if (!res.ok) throw new Error(body.error?.message ?? 'Erro ao carregar filtros');
      return body.data as CmcFiltrosResponse;
    },
  });

  const familiaOptions = (opcoes?.familias ?? []).map((f) => ({ value: f, label: f }));
  // Combo de produto respeita as famílias selecionadas (FR-009).
  const produtosFonte = opcoes?.produtos ?? [];
  const produtoOptions = (
    familias.length > 0 ? produtosFonte.filter((p) => familias.includes(p.familia)) : produtosFonte
  ).map((p) => ({ value: p.codigo, label: `${p.descricao} (${p.codigo})` }));

  function onChangeFamilias(next: string[]) {
    setFamilias(next);
    // Remove produtos que não pertencem mais às famílias filtradas.
    if (next.length > 0) {
      setProdutos((prev) =>
        prev.filter((cod) => {
          const p = produtosFonte.find((x) => x.codigo === cod);
          return p && next.includes(p.familia);
        }),
      );
    }
  }

  return (
    <div className="p-6 max-w-7xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Custos de Estoque</h1>
        <p className="text-sm text-atlas-muted">
          Custo médio contábil (CMC) ponderado do estoque, por família e produto. Valores em kg e R$/kg.
        </p>
      </div>

      <div role="tablist" aria-label="Visões de custo" className="mb-4 flex rounded-lg border border-atlas-border overflow-hidden w-fit">
        <TabButton active={tab === 'snapshot'} onClick={() => setTab('snapshot')}>
          Snapshot diário
        </TabButton>
        <TabButton active={tab === 'tendencia'} onClick={() => setTab('tendencia')}>
          Tendência histórica
        </TabButton>
      </div>

      {/* Barra de filtros compartilhada (US3) */}
      <div className="mb-5 flex items-center gap-3 flex-wrap">
        <MultiSelectCombo
          label="Famílias"
          allLabel="Todas as famílias"
          options={familiaOptions}
          selected={familias}
          onChange={onChangeFamilias}
          title="Filtrar por uma ou mais famílias"
        />
        <MultiSelectCombo
          label="Produtos"
          allLabel="Todos os produtos"
          options={produtoOptions}
          selected={produtos}
          onChange={setProdutos}
          title="Filtrar por um ou mais produtos"
        />
        <div className="flex rounded border border-atlas-border overflow-hidden">
          {ORIGENS.map((o) => (
            <button
              key={o.value || 'ambas'}
              type="button"
              onClick={() => setOrigem(o.value)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                origem === o.value ? 'bg-acxe text-white' : 'bg-atlas-bg text-atlas-muted hover:text-atlas-text'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'snapshot' && <CmcSnapshotTab filtros={filtros} />}
      {tab === 'tendencia' && <CmcTendenciaTab filtros={filtros} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-4 py-1.5 text-sm font-medium transition-colors ${
        active ? 'bg-acxe text-white' : 'bg-atlas-bg text-atlas-muted hover:text-atlas-text'
      }`}
    >
      {children}
    </button>
  );
}
