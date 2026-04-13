import { useState, type ChangeEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DataTable, type Column } from '@atlas/ui';
import {
  PieChart, Pie, Cell, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';

interface PosicaoData {
  kpis: {
    exposure_usd: number;
    cobertura_pct: number;
    ndf_ativo_usd: number;
    gap_usd: number;
    ptax_atual: {
      venda: number;
      compra: number;
      data_ref: string;
      atualizada: boolean;
    };
  };
  buckets: BucketRow[];
}

interface BucketRow {
  id: string;
  mes_ref: string;
  empresa: string;
  pagar_usd: number;
  ndf_usd: number;
  cobertura_pct: number;
  status: string;
}

interface HistoricoRow {
  data_ref: string;
  exposure_usd: number;
  ndf_ativo_usd: number;
  gap_usd: number;
  cobertura_pct: number;
  ptax_ref: number;
}

const STATUS_LABELS: Record<string, string> = {
  ok: 'OK',
  sub_hedged: 'Sub-hedged',
  over_hedged: 'Over-hedged',
};

const STATUS_COLORS: Record<string, string> = {
  ok: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  sub_hedged: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  over_hedged: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
};

const DONUT_COLORS = ['#0077cc', '#e5e7eb'];
const BAR_COLOR = '#0077cc';
const LINE_COLOR = '#1a9944';

function formatUsd(val: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(val);
}

function formatPct(val: number): string {
  return `${val.toFixed(1)}%`;
}

export function PositionDashboard() {
  const [empresa, setEmpresa] = useState<string>('');

  const { data: posicao, isLoading } = useQuery<PosicaoData>({
    queryKey: ['hedge', 'posicao', empresa],
    queryFn: async () => {
      const params = empresa ? `?empresa=${empresa}` : '';
      const res = await fetch(`/api/v1/hedge/posicao${params}`, { credentials: 'include' });
      const body = (await res.json()) as any;
      return body.data;
    },
  });

  const { data: historico = [] } = useQuery<HistoricoRow[]>({
    queryKey: ['hedge', 'historico'],
    queryFn: async () => {
      const res = await fetch('/api/v1/hedge/posicao/historico?dias=90', { credentials: 'include' });
      const body = (await res.json()) as any;
      return body.data ?? [];
    },
  });

  if (isLoading || !posicao) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-atlas-muted">Carregando posicao...</p>
      </div>
    );
  }

  const { kpis, buckets } = posicao;

  const donutData = [
    { name: 'Coberto', value: kpis.ndf_ativo_usd },
    { name: 'Descoberto', value: kpis.gap_usd > 0 ? kpis.gap_usd : 0 },
  ];

  const barData = buckets.map((b) => ({
    mes: b.mes_ref.slice(0, 7),
    pagar: b.pagar_usd,
    ndf: b.ndf_usd,
  }));

  const columns: Column<BucketRow>[] = [
    {
      key: 'mes_ref',
      header: 'Mes',
      sortable: true,
      render: (row) => row.mes_ref.slice(0, 7),
    },
    { key: 'empresa', header: 'Empresa', sortable: true },
    {
      key: 'pagar_usd',
      header: 'Exposicao USD',
      sortable: true,
      render: (row) => formatUsd(row.pagar_usd),
    },
    {
      key: 'ndf_usd',
      header: 'NDF USD',
      sortable: true,
      render: (row) => formatUsd(row.ndf_usd),
    },
    {
      key: 'cobertura_pct',
      header: 'Cobertura',
      sortable: true,
      render: (row) => formatPct(row.cobertura_pct),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[row.status] ?? ''}`}>
          {STATUS_LABELS[row.status] ?? row.status}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header + Filter */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-bold text-atlas-text">Posicao Cambial</h1>
        <div className="flex items-center gap-3">
          <select
            value={empresa}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => setEmpresa(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe"
          >
            <option value="">Todas empresas</option>
            <option value="acxe">ACXE</option>
            <option value="q2p">Q2P</option>
          </select>
          <span
            className={`text-xs px-2 py-1 rounded-full ${
              kpis.ptax_atual.atualizada
                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
            }`}
          >
            PTAX {Number(kpis.ptax_atual.venda).toFixed(4)} ({kpis.ptax_atual.atualizada ? 'atualizada' : 'desatualizada'})
          </span>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard label="Exposicao Total" value={formatUsd(kpis.exposure_usd)} />
        <KpiCard label="Cobertura" value={formatPct(kpis.cobertura_pct)} accent={kpis.cobertura_pct >= 60} />
        <KpiCard label="NDF Ativo" value={formatUsd(kpis.ndf_ativo_usd)} />
        <KpiCard label="Gap Descoberto" value={formatUsd(kpis.gap_usd)} warn={kpis.gap_usd > 500000} />
        <KpiCard label="PTAX Atual" value={`R$ ${Number(kpis.ptax_atual.venda).toFixed(4)}`} />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Donut: Cobertura */}
        <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-atlas-muted mb-3">Cobertura</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={donutData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value">
                {donutData.map((_, i) => (
                  <Cell key={i} fill={DONUT_COLORS[i]} />
                ))}
              </Pie>
              <Tooltip formatter={(val) => formatUsd(Number(val))} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Bar: Exposicao por Mes */}
        <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-atlas-muted mb-3">Exposicao por Mes</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={barData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(val) => formatUsd(Number(val))} />
              <Bar dataKey="pagar" fill={BAR_COLOR} name="Exposicao" />
              <Bar dataKey="ndf" fill={LINE_COLOR} name="NDF" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Line: PTAX Historico */}
        <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
          <h3 className="text-sm font-medium text-atlas-muted mb-3">PTAX 90 dias</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={historico}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="data_ref" tick={{ fontSize: 10 }} />
              <YAxis domain={['auto', 'auto']} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="ptax_ref" stroke={LINE_COLOR} dot={false} name="PTAX" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Buckets Table */}
      <div>
        <h2 className="text-lg font-heading font-semibold text-atlas-text mb-3">Buckets Mensais</h2>
        <DataTable
          columns={columns}
          data={buckets}
          rowKey={(row) => row.id}
          pageSize={12}
        />
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
      <p className="text-xs text-atlas-muted uppercase tracking-wider mb-1">{label}</p>
      <p
        className={`text-lg font-semibold ${
          warn
            ? 'text-crit'
            : accent
              ? 'text-acxe'
              : 'text-atlas-text'
        }`}
      >
        {value}
      </p>
    </div>
  );
}
