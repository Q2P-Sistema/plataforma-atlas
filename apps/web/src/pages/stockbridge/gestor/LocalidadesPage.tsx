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

      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-900/95 text-xs text-atlas-muted shadow-sm">
            <tr>
              <th className="text-left px-3 py-2">Código</th>
              <th className="text-left px-3 py-2">Nome</th>
              <th className="text-left px-3 py-2">Tipo</th>
              <th className="text-left px-3 py-2">CNPJ</th>
              <th className="text-left px-3 py-2">Cidade</th>
              <th className="text-center px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((l) => (
              <tr key={l.id} className={`border-t border-slate-200 dark:border-slate-700 ${!l.ativo ? 'opacity-60' : ''}`}>
                <td className="px-3 py-2 font-mono text-xs">{l.codigo}</td>
                <td className="px-3 py-2 font-medium">{l.nome}</td>
                <td className="px-3 py-2 text-atlas-muted">{TIPO_LABEL[l.tipo]}</td>
                <td className="px-3 py-2 text-atlas-muted">{l.cnpj ?? '—'}</td>
                <td className="px-3 py-2 text-atlas-muted">{l.cidade ?? '—'}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`text-xs px-2 py-0.5 rounded ${l.ativo ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                    {l.ativo ? 'ativo' : 'inativo'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
