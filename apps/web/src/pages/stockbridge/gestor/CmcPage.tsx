import { useState } from 'react';
import { LineChart } from 'lucide-react';
import { CmcSnapshotTab } from './cmc/CmcSnapshotTab.js';

type CmcTab = 'snapshot' | 'tendencia';

/**
 * Custos de Estoque (CMC por família e produto) — feature 008. Acesso gestor+.
 * Duas abas (FR-016): Snapshot diário (US1, default) e Tendência histórica (US2).
 */
export function CmcPage() {
  const [tab, setTab] = useState<CmcTab>('snapshot');

  return (
    <div className="p-6 max-w-7xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Custos de Estoque</h1>
        <p className="text-sm text-atlas-muted">
          Custo médio contábil (CMC) ponderado do estoque, por família e produto. Valores em kg e R$/kg.
        </p>
      </div>

      <div role="tablist" aria-label="Visões de custo" className="mb-5 flex rounded-lg border border-atlas-border overflow-hidden w-fit">
        <TabButton active={tab === 'snapshot'} onClick={() => setTab('snapshot')}>
          Snapshot diário
        </TabButton>
        <TabButton active={tab === 'tendencia'} onClick={() => setTab('tendencia')}>
          Tendência histórica
        </TabButton>
      </div>

      {tab === 'snapshot' && <CmcSnapshotTab />}
      {tab === 'tendencia' && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-slate-300 dark:border-slate-700 rounded-lg">
          <LineChart className="w-6 h-6 mx-auto mb-2 opacity-60" />
          A evolução histórica do CMC estará disponível em breve.
        </div>
      )}
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
