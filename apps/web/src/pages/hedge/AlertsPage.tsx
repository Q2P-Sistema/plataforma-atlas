import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../stores/auth.store.js';

interface AlertaRow {
  id: string;
  tipo: string;
  severidade: string;
  mensagem: string;
  lido: boolean;
  resolvido: boolean;
  created_at: string;
}

const SEV_COLORS: Record<string, string> = {
  critico: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  alta: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  media: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
};

export function AlertsPage() {
  const queryClient = useQueryClient();
  const csrfToken = useAuthStore((s) => s.csrfToken);

  const { data: alertas = [], isLoading } = useQuery<AlertaRow[]>({
    queryKey: ['hedge', 'alertas'],
    queryFn: async () => {
      const res = await fetch('/api/v1/hedge/alertas?resolvido=false', { credentials: 'include' });
      const body = (await res.json()) as any;
      return body.data ?? [];
    },
  });

  const actionMut = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: string }) => {
      const headers: Record<string, string> = {};
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      await fetch(`/api/v1/hedge/alertas/${id}/${action}`, { method: 'PATCH', credentials: 'include', headers });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['hedge', 'alertas'] }),
  });

  if (isLoading) return <div className="flex items-center justify-center min-h-[40vh]"><p className="text-atlas-muted">Carregando...</p></div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-heading font-bold text-atlas-text">Alertas</h1>

      {alertas.length === 0 ? (
        <div className="bg-atlas-card border border-atlas-border rounded-xl p-8 text-center text-atlas-muted">
          Nenhum alerta pendente
        </div>
      ) : (
        <div className="space-y-3">
          {alertas.map((a) => (
            <div key={a.id} className={`bg-atlas-card border border-atlas-border rounded-xl p-4 flex items-start justify-between ${a.lido ? 'opacity-60' : ''}`}>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${SEV_COLORS[a.severidade] ?? ''}`}>{a.severidade}</span>
                  <span className="text-xs text-atlas-muted">{new Date(a.created_at).toLocaleString('pt-BR')}</span>
                </div>
                <p className="text-sm text-atlas-text">{a.mensagem}</p>
              </div>
              <div className="flex gap-2 ml-4">
                {!a.lido && (
                  <button onClick={() => actionMut.mutate({ id: a.id, action: 'lido' })}
                    className="text-xs px-3 py-1 rounded bg-atlas-border text-atlas-text hover:bg-atlas-muted/20 transition-colors"
                    aria-label="Marcar como lido">Lido</button>
                )}
                <button onClick={() => actionMut.mutate({ id: a.id, action: 'resolver' })}
                  className="text-xs px-3 py-1 rounded bg-green-100 text-green-800 hover:bg-green-200 transition-colors"
                  aria-label="Resolver alerta">Resolver</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
