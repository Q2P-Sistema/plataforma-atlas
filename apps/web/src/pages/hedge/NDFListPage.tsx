import { useState, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DataTable, Modal, type Column } from '@atlas/ui';
import { Plus } from 'lucide-react';
import { useAuthStore } from '../../stores/auth.store.js';

interface NdfRow {
  id: string;
  tipo: string;
  notional_usd: number;
  taxa_ndf: number;
  ptax_contratacao: number;
  prazo_dias: number;
  data_contratacao: string;
  data_vencimento: string;
  custo_brl: number;
  resultado_brl: number | null;
  status: string;
  empresa: string;
}

const STATUS_COLORS: Record<string, string> = {
  pendente: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  ativo: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  liquidado: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  cancelado: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
};

function formatUsd(val: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(val);
}

function formatBrl(val: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val);
}

function useHedgeFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers as Record<string, string>) };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body;
  };
}

export function NDFListPage() {
  const queryClient = useQueryClient();
  const hedgeFetch = useHedgeFetch();
  const [statusFilter, setStatusFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [liquidarId, setLiquidarId] = useState<string | null>(null);
  const [ptaxLiq, setPtaxLiq] = useState('');
  const [error, setError] = useState('');

  // Form state
  const [form, setForm] = useState({
    tipo: 'ndf', notional_usd: '', taxa_ndf: '', prazo_dias: '90',
    data_vencimento: '', empresa: 'acxe', observacao: '',
  });

  const { data: ndfs = [], isLoading } = useQuery<NdfRow[]>({
    queryKey: ['hedge', 'ndfs', statusFilter],
    queryFn: async () => {
      const params = statusFilter ? `?status=${statusFilter}` : '';
      const body = await hedgeFetch(`/api/v1/hedge/ndfs${params}`);
      return body.data;
    },
  });

  const createMut = useMutation({
    mutationFn: async () => hedgeFetch('/api/v1/hedge/ndfs', { method: 'POST', body: JSON.stringify({
      tipo: form.tipo, notional_usd: parseFloat(form.notional_usd), taxa_ndf: parseFloat(form.taxa_ndf),
      prazo_dias: parseInt(form.prazo_dias, 10), data_vencimento: form.data_vencimento,
      empresa: form.empresa, observacao: form.observacao || undefined,
    })}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['hedge', 'ndfs'] }); setCreateOpen(false); },
    onError: (e: Error) => setError(e.message),
  });

  const actionMut = useMutation({
    mutationFn: async ({ id, action, body }: { id: string; action: string; body?: any }) =>
      hedgeFetch(`/api/v1/hedge/ndfs/${id}/${action}`, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['hedge', 'ndfs'] }); setLiquidarId(null); },
  });

  const columns: Column<NdfRow>[] = [
    { key: 'tipo', header: 'Tipo', sortable: true, render: (r) => r.tipo.toUpperCase() },
    { key: 'notional_usd', header: 'Notional', sortable: true, render: (r) => formatUsd(r.notional_usd) },
    { key: 'taxa_ndf', header: 'Taxa', sortable: true, render: (r) => r.taxa_ndf.toFixed(4) },
    { key: 'data_vencimento', header: 'Vencimento', sortable: true, render: (r) => r.data_vencimento },
    { key: 'custo_brl', header: 'Custo BRL', render: (r) => formatBrl(r.custo_brl) },
    { key: 'resultado_brl', header: 'Resultado', render: (r) => r.resultado_brl != null ? formatBrl(r.resultado_brl) : '-' },
    {
      key: 'status', header: 'Status', sortable: true,
      render: (r) => <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[r.status] ?? ''}`}>{r.status}</span>,
    },
    { key: 'empresa', header: 'Empresa' },
  ];

  if (isLoading) return <div className="flex items-center justify-center min-h-[40vh]"><p className="text-atlas-muted">Carregando...</p></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-bold text-atlas-text">NDFs / Contratos</h1>
        <div className="flex items-center gap-3">
          <select value={statusFilter} onChange={(e: ChangeEvent<HTMLSelectElement>) => setStatusFilter(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe">
            <option value="">Todos</option>
            <option value="pendente">Pendente</option>
            <option value="ativo">Ativo</option>
            <option value="liquidado">Liquidado</option>
            <option value="cancelado">Cancelado</option>
          </select>
          <button onClick={() => { setError(''); setCreateOpen(true); }}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-acxe text-white text-sm font-medium hover:bg-acxe/90 transition-colors">
            <Plus size={16} /> Novo NDF
          </button>
        </div>
      </div>

      <DataTable columns={columns} data={ndfs} rowKey={(r) => r.id} pageSize={15}
        actions={(row) => (
          <>
            {row.status === 'pendente' && (
              <button onClick={() => actionMut.mutate({ id: row.id, action: 'ativar' })}
                className="text-xs px-2 py-1 rounded bg-green-100 text-green-800 hover:bg-green-200 transition-colors"
                aria-label={`Ativar NDF ${row.id.slice(0,8)}`}>Ativar</button>
            )}
            {row.status === 'ativo' && (
              <button onClick={() => { setLiquidarId(row.id); setPtaxLiq(''); }}
                className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-800 hover:bg-blue-200 transition-colors"
                aria-label={`Liquidar NDF ${row.id.slice(0,8)}`}>Liquidar</button>
            )}
            {(row.status === 'pendente' || row.status === 'ativo') && (
              <button onClick={() => actionMut.mutate({ id: row.id, action: 'cancelar' })}
                className="text-xs px-2 py-1 rounded bg-red-100 text-red-800 hover:bg-red-200 transition-colors"
                aria-label={`Cancelar NDF ${row.id.slice(0,8)}`}>Cancelar</button>
            )}
          </>
        )}
      />

      {/* Create Modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Novo NDF"
        footer={<>
          <button onClick={() => setCreateOpen(false)} className="px-4 py-2 rounded-lg border border-atlas-border text-atlas-text text-sm">Cancelar</button>
          <button onClick={() => createMut.mutate()} disabled={createMut.isPending}
            className="px-4 py-2 rounded-lg bg-acxe text-white text-sm font-medium disabled:opacity-50">{createMut.isPending ? 'Criando...' : 'Criar'}</button>
        </>}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="ndf-tipo" className="block text-sm font-medium text-atlas-text mb-1">Tipo</label>
              <select id="ndf-tipo" value={form.tipo} onChange={(e: ChangeEvent<HTMLSelectElement>) => setForm({ ...form, tipo: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe">
                <option value="ndf">NDF</option><option value="trava">Trava</option><option value="acc">ACC</option>
              </select>
            </div>
            <div>
              <label htmlFor="ndf-empresa" className="block text-sm font-medium text-atlas-text mb-1">Empresa</label>
              <select id="ndf-empresa" value={form.empresa} onChange={(e: ChangeEvent<HTMLSelectElement>) => setForm({ ...form, empresa: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe">
                <option value="acxe">ACXE</option><option value="q2p">Q2P</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="ndf-notional" className="block text-sm font-medium text-atlas-text mb-1">Notional USD</label>
              <input id="ndf-notional" type="number" step="0.01" value={form.notional_usd}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, notional_usd: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe" />
            </div>
            <div>
              <label htmlFor="ndf-taxa" className="block text-sm font-medium text-atlas-text mb-1">Taxa NDF</label>
              <input id="ndf-taxa" type="number" step="0.0001" value={form.taxa_ndf}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, taxa_ndf: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="ndf-prazo" className="block text-sm font-medium text-atlas-text mb-1">Prazo (dias)</label>
              <input id="ndf-prazo" type="number" value={form.prazo_dias}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, prazo_dias: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe" />
            </div>
            <div>
              <label htmlFor="ndf-vencimento" className="block text-sm font-medium text-atlas-text mb-1">Vencimento</label>
              <input id="ndf-vencimento" type="date" value={form.data_vencimento}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, data_vencimento: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe" />
            </div>
          </div>
          {error && <div className="text-sm text-crit bg-crit/10 border border-crit/20 rounded-lg px-3 py-2">{error}</div>}
        </div>
      </Modal>

      {/* Liquidar Modal */}
      <Modal open={!!liquidarId} onClose={() => setLiquidarId(null)} title="Liquidar NDF"
        footer={<>
          <button onClick={() => setLiquidarId(null)} className="px-4 py-2 rounded-lg border border-atlas-border text-atlas-text text-sm">Cancelar</button>
          <button onClick={() => { if (liquidarId && ptaxLiq) actionMut.mutate({ id: liquidarId, action: 'liquidar', body: { ptax_liquidacao: parseFloat(ptaxLiq) } }); }}
            disabled={!ptaxLiq || actionMut.isPending}
            className="px-4 py-2 rounded-lg bg-acxe text-white text-sm font-medium disabled:opacity-50">{actionMut.isPending ? 'Liquidando...' : 'Liquidar'}</button>
        </>}>
        <div>
          <label htmlFor="ptax-liq" className="block text-sm font-medium text-atlas-text mb-1">PTAX de Liquidacao</label>
          <input id="ptax-liq" type="number" step="0.0001" value={ptaxLiq} placeholder="5.4500"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setPtaxLiq(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe" />
        </div>
      </Modal>
    </div>
  );
}
