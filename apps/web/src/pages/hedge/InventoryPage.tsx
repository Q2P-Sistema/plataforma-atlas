import { useState, type ChangeEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DataTable, type Column } from '@atlas/ui';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';

interface EstoqueRow {
  localidade: string;
  empresa: string;
  valor_brl: number;
  custo_usd_estimado: number;
  pago: boolean;
  fase: string | null;
}

function formatBrl(val: number) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val); }

export function InventoryPage() {
  const [empresa, setEmpresa] = useState('');

  const { data: estoque = [], isLoading } = useQuery<EstoqueRow[]>({
    queryKey: ['hedge', 'estoque', empresa],
    queryFn: async () => {
      const params = empresa ? `?empresa=${empresa}` : '';
      const res = await fetch(`/api/v1/hedge/estoque${params}`, { credentials: 'include' });
      const body = (await res.json()) as any;
      return body.data ?? [];
    },
  });

  const totalBrl = estoque.reduce((s, r) => s + r.valor_brl, 0);
  const pagoBrl = estoque.filter((r) => r.pago).reduce((s, r) => s + r.valor_brl, 0);
  const pieData = [{ name: 'Pago', value: pagoBrl }, { name: 'A pagar', value: totalBrl - pagoBrl }];

  const columns: Column<EstoqueRow>[] = [
    { key: 'localidade', header: 'Localidade', sortable: true },
    { key: 'empresa', header: 'Empresa', sortable: true },
    { key: 'valor_brl', header: 'Valor BRL', sortable: true, render: (r) => formatBrl(r.valor_brl) },
    { key: 'custo_usd_estimado', header: 'Custo USD Est.', render: (r) => `$ ${r.custo_usd_estimado.toLocaleString('pt-BR')}` },
    { key: 'pago', header: 'Pago', render: (r) => r.pago ? 'Sim' : 'Nao' },
    { key: 'fase', header: 'Fase', render: (r) => r.fase ?? '-' },
  ];

  if (isLoading) return <div className="flex items-center justify-center min-h-[40vh]"><p className="text-atlas-muted">Carregando...</p></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-bold text-atlas-text">Estoque Importado</h1>
        <select value={empresa} onChange={(e: ChangeEvent<HTMLSelectElement>) => setEmpresa(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe">
          <option value="">Todas</option><option value="acxe">ACXE</option><option value="q2p">Q2P</option>
        </select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
          <p className="text-xs text-atlas-muted uppercase mb-1">Total BRL</p>
          <p className="text-lg font-semibold text-atlas-text">{formatBrl(totalBrl)}</p>
        </div>
        <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
          <p className="text-xs text-atlas-muted uppercase mb-1">Localidades</p>
          <p className="text-lg font-semibold text-atlas-text">{estoque.length}</p>
        </div>
        <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
          <p className="text-xs text-atlas-muted uppercase mb-1">Pago / A pagar</p>
          <ResponsiveContainer width="100%" height={80}>
            <PieChart><Pie data={pieData} cx="50%" cy="50%" innerRadius={20} outerRadius={35} dataKey="value">
              <Cell fill="#059669" /><Cell fill="#dc2626" />
            </Pie><Tooltip /><Legend /></PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <DataTable columns={columns} data={estoque} rowKey={(r) => `${r.localidade}-${r.empresa}`} />
    </div>
  );
}
