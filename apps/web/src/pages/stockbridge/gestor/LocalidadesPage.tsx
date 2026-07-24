import { useQuery } from '@tanstack/react-query';
import { EmptyState, ErrorState } from '@atlas/ui';
import { useAuthStore } from '../../../stores/auth.store.js';

type Tipo = 'proprio' | 'tpl' | 'porto_seco' | 'virtual_transito' | 'virtual_ajuste';

interface Localidade {
  id: string;
  codigo: string;
  nome: string;
  tipo: Tipo;
  cnpj: string | null;
  cidade: string | null;
  ativo: boolean;
}

const TIPO_LABEL: Record<Tipo, string> = {
  proprio: 'Próprio',
  tpl: '3PL',
  porto_seco: 'Porto Seco',
  virtual_transito: 'Virtual (Trânsito)',
  virtual_ajuste: 'Virtual (Ajuste)',
};

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers as Record<string, string>) };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    const body = (await res.json()) as { data: unknown; error: { message?: string } | null };
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body;
  };
}

const GRID_COLS = 'grid-cols-[1fr_3fr_1.2fr_1.5fr_1.5fr_1fr]';

export function LocalidadesPage() {
  const apiFetch = useApiFetch();

  // Era a única página sem tratamento de loading/erro/empty — falha rendia
  // tabela vazia sem feedback (UI-E, ACXEGDP-265).
  const { data = [], isLoading, error, refetch } = useQuery<Localidade[]>({
    queryKey: ['sb', 'localidades'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/localidades')).data as Localidade[],
  });

  return (
    <div className="p-6 max-w-7xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Localidades</h1>
        <p className="text-sm text-atlas-muted">
          Armazéns próprios, 3PLs, portos secos e virtuais (trânsito/ajuste).
        </p>
      </div>

      <div
        className="bg-atlas-card border border-atlas-border rounded-lg overflow-y-auto"
        style={{ maxHeight: 'calc(100vh - 200px)' }}
      >
        <div className={`sticky top-0 z-10 bg-atlas-bg border-b-2 border-atlas-border grid ${GRID_COLS} text-xs text-atlas-muted font-semibold px-3 py-2`}>
          <div>Código</div>
          <div>Nome</div>
          <div>Tipo</div>
          <div>CNPJ</div>
          <div>Cidade</div>
          <div className="text-center">Status</div>
        </div>

        <div>
          {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando...</div>}
          {!isLoading && error && (
            <div className="p-4">
              <ErrorState message={(error as Error).message} retry={() => refetch()} />
            </div>
          )}
          {!isLoading && !error && data.length === 0 && (
            <div className="p-4">
              <EmptyState>Nenhuma localidade cadastrada.</EmptyState>
            </div>
          )}
          {data.map((l) => (
            <div
              key={l.id}
              className={`grid ${GRID_COLS} text-sm border-b border-atlas-border/60 px-3 py-2 items-center ${!l.ativo ? 'opacity-60' : ''}`}
            >
              <div className="font-mono text-xs">{l.codigo}</div>
              <div className="font-medium">{l.nome}</div>
              <div className="text-atlas-muted">{TIPO_LABEL[l.tipo]}</div>
              <div className="text-atlas-muted">{l.cnpj ?? '—'}</div>
              <div className="text-atlas-muted">{l.cidade ?? '—'}</div>
              <div className="text-center">
                <span className={`text-xs px-2 py-0.5 rounded ${l.ativo ? 'bg-green-50 text-green-700' : 'bg-atlas-muted/20 text-atlas-muted'}`}>
                  {l.ativo ? 'ativo' : 'inativo'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
