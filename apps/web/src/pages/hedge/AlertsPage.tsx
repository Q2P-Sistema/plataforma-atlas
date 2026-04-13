import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DataTable, type Column } from '@atlas/ui';
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

interface NdfRow {
  id: string;
  tipo: string;
  notional_usd: number;
  taxa_ndf: number;
  data_contratacao: string;
  data_vencimento: string;
  custo_brl: number;
  resultado_brl: number | null;
  status: string;
  empresa: string;
}

const SEV_STYLES: Record<string, { bg: string; border: string; color: string; icon: string }> = {
  critico: { bg: 'rgba(220,38,38,0.07)', border: 'rgba(255,77,109,0.25)', color: '#dc2626', icon: '\u26A0' },
  alta: { bg: 'rgba(217,119,6,0.08)', border: 'rgba(255,181,71,0.25)', color: '#d97706', icon: '\u25C8' },
  media: { bg: 'rgba(5,150,105,0.07)', border: 'rgba(0,229,160,0.2)', color: '#059669', icon: '\u25CE' },
};

const fmtK = (v: number) => '$' + Math.round(v / 1000) + 'K';

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

  // NDF history
  const { data: ndfs = [] } = useQuery<NdfRow[]>({
    queryKey: ['hedge', 'ndfs-historico'],
    queryFn: async () => {
      const res = await fetch('/api/v1/hedge/ndfs', { credentials: 'include' });
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

  const ndfColumns: Column<NdfRow>[] = [
    { key: 'data_contratacao', header: 'Data', sortable: true, render: (r) => r.data_contratacao ? new Date(r.data_contratacao).toLocaleDateString('pt-BR') : '-' },
    { key: 'tipo', header: 'Tipo' },
    { key: 'empresa', header: 'Empresa', render: (r) => r.empresa.toUpperCase() },
    { key: 'notional_usd', header: 'Notional', sortable: true, render: (r) => fmtK(r.notional_usd) },
    { key: 'taxa_ndf', header: 'Taxa', render: (r) => `R$ ${r.taxa_ndf.toFixed(4)}` },
    { key: 'custo_brl', header: 'Custo BRL', render: (r) => `R$ ${r.custo_brl.toLocaleString('pt-BR')}` },
    {
      key: 'resultado_brl', header: 'Resultado',
      render: (r) => r.resultado_brl != null
        ? <span style={{ color: r.resultado_brl >= 0 ? '#059669' : '#dc2626' }}>R$ {r.resultado_brl.toLocaleString('pt-BR')}</span>
        : <span className="text-atlas-muted">—</span>,
    },
    {
      key: 'status', header: 'Status',
      render: (r) => {
        const cls = r.status === 'ativo' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
          : r.status === 'liquidado' ? 'bg-blue-500/10 text-blue-600 border-blue-500/20'
          : r.status === 'cancelado' ? 'bg-red-500/10 text-red-600 border-red-500/20'
          : 'bg-amber-500/10 text-amber-600 border-amber-500/20';
        return <span className={`inline-flex text-xs px-1.5 py-0.5 rounded border font-semibold ${cls}`}>{r.status}</span>;
      },
    },
  ];

  if (isLoading) return <div className="flex items-center justify-center min-h-[40vh]"><p className="text-atlas-muted">Carregando...</p></div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-heading font-bold text-atlas-text">
        Alertas{' '}
        {alertas.length > 0 && (
          <span className="inline-flex items-center justify-center text-xs bg-red-600 text-white rounded-full w-5 h-5 ml-1">{alertas.length}</span>
        )}
      </h1>

      {/* Active alerts */}
      {alertas.length === 0 ? (
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-6 text-center text-atlas-muted text-xs font-mono">
          Nenhum alerta ativo.
        </div>
      ) : (
        <div className="space-y-2">
          {alertas.map((a) => {
            const style = SEV_STYLES[a.severidade] ?? SEV_STYLES.media!;
            const { bg, border, color, icon } = style;
            return (
              <div key={a.id}
                className={`flex items-start gap-3 p-3.5 rounded-lg border ${a.lido ? 'opacity-50' : ''}`}
                style={{ backgroundColor: bg, borderColor: border, color }}>
                <span className="text-base leading-none mt-0.5 shrink-0">{icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold mb-0.5">{a.mensagem}</p>
                  <p className="text-xs tracking-wider text-atlas-muted">{new Date(a.created_at).toLocaleString('pt-BR')}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  {!a.lido && (
                    <button onClick={() => actionMut.mutate({ id: a.id, action: 'lido' })}
                      className="text-xs px-2.5 py-1 rounded border font-mono transition-colors"
                      style={{ background: 'rgba(221,225,232,0.3)', borderColor: 'rgba(221,225,232,0.5)', color: '#8492a6' }}>
                      Lido
                    </button>
                  )}
                  <button onClick={() => actionMut.mutate({ id: a.id, action: 'resolver' })}
                    className="text-xs px-2.5 py-1 rounded border font-mono transition-colors"
                    style={{ background: 'rgba(5,150,105,0.1)', borderColor: 'rgba(0,229,160,0.3)', color: '#059669' }}>
                    Resolver
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* NDF History */}
      <div>
        <p className="text-xs text-atlas-muted uppercase tracking-[3px] mb-3">Historico — NDFs Registrados</p>
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
          <DataTable columns={ndfColumns} data={ndfs} rowKey={(r) => r.id}
            emptyMessage="Nenhum NDF registrado ainda" />
        </div>
      </div>
    </div>
  );
}
