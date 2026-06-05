import { useQuery } from '@tanstack/react-query';
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

  const { data = [] } = useQuery<Localidade[]>({
    queryKey: ['sb', 'localidades'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/localidades')).data as Localidade[],
  });

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Localidades</h1>
        <p className="text-sm text-atlas-muted">
          Armazéns próprios, 3PLs, portos secos e virtuais (trânsito/ajuste).
        </p>
      </div>

      <div
        className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-y-auto"
        style={{ maxHeight: 'calc(100vh - 200px)' }}
      >
        <div className={`sticky top-0 z-10 bg-slate-100 dark:bg-slate-900 border-b-2 border-slate-300 dark:border-slate-600 grid ${GRID_COLS} text-xs text-atlas-muted font-semibold px-3 py-2`}>
          <div>Código</div>
          <div>Nome</div>
          <div>Tipo</div>
          <div>CNPJ</div>
          <div>Cidade</div>
          <div className="text-center">Status</div>
        </div>

        <div>
          {data.map((l) => (
            <div
              key={l.id}
              className={`grid ${GRID_COLS} text-sm border-b border-slate-100 dark:border-slate-700/60 px-3 py-2 items-center ${!l.ativo ? 'opacity-60' : ''}`}
            >
              <div className="font-mono text-xs">{l.codigo}</div>
              <div className="font-medium">{l.nome}</div>
              <div className="text-atlas-muted">{TIPO_LABEL[l.tipo]}</div>
              <div className="text-atlas-muted">{l.cnpj ?? '—'}</div>
              <div className="text-atlas-muted">{l.cidade ?? '—'}</div>
              <div className="text-center">
                <span className={`text-xs px-2 py-0.5 rounded ${l.ativo ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
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
