import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@atlas/ui';
import { useAuthStore } from '../../../stores/auth.store.js';

interface Fornecedor {
  cnpj: string;
  nome: string;
  pais: string | null;
  excluido: boolean;
  motivoExclusao: string | null;
}

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

export function FornecedoresPage() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [busca, setBusca] = useState('');
  const [excluindo, setExcluindo] = useState<Fornecedor | null>(null);
  const [motivo, setMotivo] = useState('');

  const { data = [] } = useQuery<Fornecedor[]>({
    queryKey: ['sb', 'fornecedores'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/fornecedores')).data as Fornecedor[],
  });

  const excluirMut = useMutation({
    mutationFn: async (args: { cnpj: string; nome: string; motivo: string }) =>
      apiFetch(`/api/v1/stockbridge/fornecedores/${encodeURIComponent(args.cnpj)}/excluir`, {
        method: 'POST',
        body: JSON.stringify({ motivo: args.motivo, nome: args.nome }),
      }),
    onSuccess: () => {
      setExcluindo(null);
      setMotivo('');
      queryClient.invalidateQueries({ queryKey: ['sb', 'fornecedores'] });
    },
  });

  const reincluirMut = useMutation({
    mutationFn: async (cnpj: string) =>
      apiFetch(`/api/v1/stockbridge/fornecedores/${encodeURIComponent(cnpj)}/reincluir`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sb', 'fornecedores'] }),
  });

  const filtrado = data.filter((f) =>
    !busca ||
    f.nome.toLowerCase().includes(busca.toLowerCase()) ||
    f.cnpj.includes(busca) ||
    (f.pais?.toLowerCase().includes(busca.toLowerCase()) ?? false),
  );

  const ativos = filtrado.filter((f) => !f.excluido);
  const excluidos = filtrado.filter((f) => f.excluido);

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-1">
          <h1 className="text-2xl font-serif text-atlas-ink">Fornecedores</h1>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700">
            Em desenvolvimento
          </span>
        </div>
        <p className="text-sm text-atlas-muted">
          Excluir/reincluir fornecedores da fila de compra nacional. Importação e devolução não são afetadas.
        </p>
      </div>

      <input
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder="Buscar por nome, CNPJ ou país..."
        className="w-full mb-4 px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm"
      />

      {ativos.length > 0 && (
        <div className="mb-5">
          <div className="text-xs font-semibold text-atlas-muted uppercase mb-2">Ativos ({ativos.length})</div>
          <div className="bg-atlas-card border border-atlas-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-atlas-bg text-xs text-atlas-muted">
                <tr>
                  <th className="text-left px-3 py-2">Fornecedor</th>
                  <th className="text-left px-3 py-2">CNPJ</th>
                  <th className="text-left px-3 py-2">País</th>
                  <th className="text-right px-3 py-2">Ação</th>
                </tr>
              </thead>
              <tbody>
                {ativos.map((f) => (
                  <tr key={f.cnpj} className="border-t border-atlas-border">
                    <td className="px-3 py-2 font-medium">{f.nome}</td>
                    <td className="px-3 py-2 font-mono text-xs text-atlas-muted">{f.cnpj}</td>
                    <td className="px-3 py-2 text-atlas-muted">{f.pais ?? '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => setExcluindo(f)}
                        className="px-3 py-1 border border-red-300 text-red-700 text-xs rounded hover:bg-red-50"
                      >
                        Excluir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {excluidos.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-atlas-muted uppercase mb-2">Excluídos ({excluidos.length})</div>
          <div className="bg-red-50/50 dark:bg-red-900/10 border border-red-200 dark:border-red-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-red-100/50 dark:bg-red-900/20 text-xs text-red-800 dark:text-red-300">
                <tr>
                  <th className="text-left px-3 py-2">Fornecedor</th>
                  <th className="text-left px-3 py-2">Motivo</th>
                  <th className="text-right px-3 py-2">Ação</th>
                </tr>
              </thead>
              <tbody>
                {excluidos.map((f) => (
                  <tr key={f.cnpj} className="border-t border-red-200 dark:border-red-800/40 opacity-70">
                    <td className="px-3 py-2 line-through">{f.nome}</td>
                    <td className="px-3 py-2 text-xs italic text-atlas-muted">{f.motivoExclusao ?? 'sem motivo'}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => reincluirMut.mutate(f.cnpj)}
                        disabled={reincluirMut.isPending}
                        className="px-3 py-1 border border-green-300 text-green-700 text-xs rounded hover:bg-green-50"
                      >
                        Reincluir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {excluindo && (
        <Modal open title={`Excluir fornecedor: ${excluindo.nome}`} onClose={() => setExcluindo(null)}>
          <div className="space-y-3">
            <p className="text-sm text-atlas-muted">
              CNPJ: <code>{excluindo.cnpj}</code>
            </p>
            <div>
              <label className="block text-xs font-semibold text-atlas-muted mb-1">Motivo *</label>
              <textarea
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                rows={3}
                placeholder="Ex: Problemas recorrentes de qualidade"
                className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm"
              />
            </div>
            {excluirMut.isError && (
              <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                {(excluirMut.error as Error).message}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={() => setExcluindo(null)} className="px-4 py-2 border border-atlas-border rounded text-sm">Cancelar</button>
              <button
                onClick={() => excluirMut.mutate({ cnpj: excluindo.cnpj, nome: excluindo.nome, motivo })}
                disabled={!motivo.trim() || excluirMut.isPending}
                className={`px-5 py-2 rounded text-sm font-medium ${motivo.trim() ? 'bg-red-700 text-white' : 'bg-atlas-muted/20 text-atlas-muted cursor-not-allowed'}`}
              >
                Confirmar exclusão
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
