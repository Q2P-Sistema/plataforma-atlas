import { useState, type ChangeEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DataTable, type Column } from '@atlas/ui';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  LineChart, Line, ReferenceLine,
} from 'recharts';

interface PtaxQuote { dataRef: string; venda: number; compra: number; atualizada: boolean; }
interface PtaxHistoricoItem { data_ref: string; venda: number; compra: number; }
interface PtaxAtualComVariacao extends PtaxQuote { ptax_anterior: number; variacao_pct: number; fetchedAt?: string; }
interface PtaxResult { atual: PtaxAtualComVariacao; historico: PtaxHistoricoItem[]; }

interface Kpis {
  exposure_usd: number;
  cobertura_pct: number;
  ndf_ativo_usd: number;
  gap_usd: number;
  ptax_atual: PtaxQuote;
  total_pagar_usd: number;
  total_pagar_brl: number;
  pagar_mercadoria_usd: number;
  pagar_despesa_usd: number;
  total_est_brl: number;
  est_importado_brl: number;
  est_transito_brl: number;
  est_nacional_brl: number;
  pct_nao_pago: number;
  est_nao_pago_usd: number;
  recebiveis_brl: number;
  recebiveis_usd: number;
  importacoes_pendentes_usd: number;
  exposicao_usd_total: number;
}

interface Bucket {
  id: string;
  mes_ref: string;
  empresa: string;
  pagar_usd: number;
  est_nao_pago_usd: number;
  exposicao_usd: number;
  ndf_usd: number;
  cobertura_pct: number;
  status: string;
}


const fmtM = (v: number) => '$' + (v / 1e6).toFixed(2) + 'M';
const fmtBrlM = (v: number) => 'R$' + (v / 1e6).toFixed(1) + 'M';
const fmtK = (v: number) => '$' + Math.round(v / 1000) + 'K';
const fmtPct = (v: number) => v.toFixed(1) + '%';

function SourceBadge({ src }: { src: 'acxe' | 'q2p' | 'bcb' | 'calc' | 'manual' }) {
  const styles: Record<string, string> = {
    acxe: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
    q2p: 'bg-green-500/10 text-green-600 border-green-500/20',
    bcb: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    calc: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
    manual: 'bg-purple-500/10 text-purple-600 border-purple-500/20',
  };
  return (
    <span className={`inline-flex text-xs px-1.5 py-0.5 rounded border font-semibold tracking-wider uppercase ${styles[src]}`}>
      {src}
    </span>
  );
}

function KpiCard({ label, value, color, src, sub }: { label: string; value: string; color: string; src: 'acxe' | 'q2p' | 'bcb' | 'calc' | 'manual'; sub?: string }) {
  return (
    <div className="bg-atlas-card border border-atlas-border rounded-lg p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ backgroundColor: color }} />
      <div className="flex items-center gap-2 mb-2">
        <p className="text-xs text-atlas-muted uppercase tracking-wider">{label}</p>
        <SourceBadge src={src} />
      </div>
      <p className="text-xl font-bold" style={{ color }}>{value}</p>
      {sub && <p className="text-xs text-atlas-muted mt-1">{sub}</p>}
    </div>
  );
}

function InsightCard({ color, border, children }: { color: string; border: string; children: React.ReactNode }) {
  return (
    <div className="rounded-r p-3 text-xs leading-relaxed" style={{ borderLeft: `2px solid ${border}`, backgroundColor: color }}>
      {children}
    </div>
  );
}

export function PositionDashboard() {
  const [empresa, setEmpresa] = useState('');

  const { data, isLoading } = useQuery<{ kpis: Kpis; buckets: Bucket[] }>({
    queryKey: ['hedge', 'posicao', empresa],
    queryFn: async () => {
      const params = empresa ? `?empresa=${empresa}` : '';
      const res = await fetch(`/api/v1/hedge/posicao${params}`, { credentials: 'include' });
      const body = await res.json() as any;
      return body.data;
    },
  });

  const { data: ptaxData } = useQuery<PtaxResult>({
    queryKey: ['hedge', 'ptax', '15d'],
    queryFn: async () => {
      const res = await fetch('/api/v1/hedge/ptax?dias=15', { credentials: 'include' });
      const body = await res.json() as any;
      return body.data;
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  });

  if (isLoading || !data) {
    return <div className="flex items-center justify-center min-h-[40vh]"><p className="text-atlas-muted">Carregando...</p></div>;
  }

  const { kpis, buckets } = data;

  // Donut: NDF Contratado vs Exp. Tatica vs Exp. Intencional
  const donutData = [
    { name: 'NDF Contratado', value: kpis.ndf_ativo_usd, color: '#7c3aed' },
    { name: 'Exp. Tatica', value: Math.max(0, kpis.gap_usd * 0.4), color: '#d97706' },
    { name: 'Exp. Intencional', value: Math.max(0, kpis.gap_usd * 0.6), color: '#dc2626' },
  ];

  // Bar: exposure vs NDF per bucket
  const barData = buckets.map(b => ({
    mes: b.mes_ref.slice(0, 7),
    exposicao: b.exposicao_usd / 1e6,
    ndf: b.ndf_usd / 1e6,
  }));

  // PTAX card data
  const ptaxAtual = ptaxData?.atual;
  const ptaxSubiu = (ptaxAtual?.variacao_pct ?? 0) > 0;
  const ptaxNeutro = (ptaxAtual?.variacao_pct ?? 0) === 0;
  const ptaxColor = ptaxNeutro ? '#6b7280' : ptaxSubiu ? '#dc2626' : '#059669';
  const ptaxArrow = ptaxNeutro ? '' : ptaxSubiu ? '▲' : '▼';
  const ptaxVarStr = ptaxAtual ? `${ptaxArrow} ${Math.abs(ptaxAtual.variacao_pct).toFixed(2)}%` : '';

  const MESES_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const ptaxMiniData = (() => {
    const base = (ptaxData?.historico ?? []).map(h => {
      const [, mm, dd] = h.data_ref.split('-');
      const label = `${dd} ${MESES_PT[parseInt(mm!, 10) - 1]}`;
      return { data: label, venda: h.venda };
    });
    if (base.length < 2) return base;
    const n = base.length;
    const sumX = (n * (n - 1)) / 2;
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
    const sumY = base.reduce((acc, p) => acc + p.venda, 0);
    const sumXY = base.reduce((acc, p, i) => acc + i * p.venda, 0);
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    return base.map((p, i) => ({ ...p, tendencia: parseFloat((intercept + slope * i).toFixed(4)) }));
  })();

  function formatFetchedAt(iso?: string) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
      + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  // Bucket table columns
  const bucketColumns: Column<Bucket>[] = [
    { key: 'mes_ref', header: 'Bucket', sortable: true, render: (r) => r.mes_ref.slice(0, 7) },
    { key: 'pagar_usd', header: 'A pagar USD', sortable: true, render: (r) => fmtK(r.pagar_usd) },
    { key: 'est_nao_pago_usd', header: 'Est. N/Pago', sortable: true, render: (r) => r.est_nao_pago_usd > 0 ? <span className="text-amber-600">{fmtK(r.est_nao_pago_usd)}</span> : '—' },
    { key: 'exposicao_usd', header: 'Exposicao', sortable: true, render: (r) => <span className="font-semibold">{fmtK(r.exposicao_usd)}</span> },
    { key: 'ndf_usd', header: 'NDF Contrat.', sortable: true, render: (r) => <span className="text-purple-600">{fmtK(r.ndf_usd)}</span> },
    {
      key: 'gap' as any, header: 'Liquido',
      render: (r) => {
        const liq = r.exposicao_usd - r.ndf_usd;
        return <span style={{ color: liq > 500000 ? '#dc2626' : '#059669' }}>{fmtK(liq)}</span>;
      },
    },
    {
      key: 'cobertura_pct', header: 'Cobertura', sortable: true,
      render: (r) => {
        const cls = r.cobertura_pct >= 60 ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
          : r.cobertura_pct >= 40 ? 'bg-amber-500/10 text-amber-600 border-amber-500/20'
            : 'bg-red-500/10 text-red-600 border-red-500/20';
        return <span className={`inline-flex text-xs px-1.5 py-0.5 rounded border font-semibold ${cls}`}>{fmtPct(r.cobertura_pct)}</span>;
      },
    },
    {
      key: 'status', header: 'Acao',
      render: (r) => {
        if (r.cobertura_pct >= 60) return <span className="text-emerald-600 text-xs font-semibold">OK</span>;
        return <span className="text-red-600 text-xs font-semibold">NDF NEEDED</span>;
      },
    },
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-bold text-atlas-text">Posicao Consolidada</h1>
        <select value={empresa} onChange={(e: ChangeEvent<HTMLSelectElement>) => setEmpresa(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe">
          <option value="">Todas</option><option value="acxe">ACXE</option><option value="q2p">Q2P</option>
        </select>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <KpiCard label="Exposicao USD Total" value={fmtM(kpis.exposicao_usd_total)} color="#0077cc" src="acxe" sub="Titulos a pagar em aberto" />
        <KpiCard label="Receita BRL Projetada" value={fmtBrlM(kpis.recebiveis_brl)} color="#1a9944" src="q2p" sub="Contas a receber 90d" />
        <KpiCard label="Estoque nao pago" value={fmtPct(kpis.pct_nao_pago)} color="#d97706" src="calc" sub={`R$ ${(kpis.est_importado_brl / 1e6).toFixed(1)}M importado`} />
        <KpiCard label="Cobertura NDF Ativa" value={fmtM(kpis.ndf_ativo_usd)} color="#7c3aed" src="manual" sub={fmtPct(kpis.cobertura_pct) + ' da exposicao'} />
        <KpiCard label="Exposicao Liquida" value={fmtM(kpis.gap_usd)} color="#059669" src="calc" sub="Residual descoberto" />
      </div>

      {/* Main content: Bucket table + Donut */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-atlas-card border border-atlas-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <p className="text-xs text-atlas-muted uppercase tracking-[3px]">Posicao Agregada por Bucket de Vencimento</p>
            <SourceBadge src="acxe" />
            <SourceBadge src="calc" />
          </div>
          <DataTable columns={bucketColumns} data={buckets} rowKey={(r) => r.id} />
        </div>
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
          <p className="text-xs text-atlas-muted uppercase tracking-[2px] mb-2">Composicao da Posicao</p>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={donutData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="value">
                {donutData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Pie>
              <Tooltip formatter={(v) => fmtM(Number(v))} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
          <p className="text-xs text-atlas-muted uppercase tracking-[2px] mb-2">Exposicao por Bucket ($M)</p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={barData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(221,225,232,0.5)" />
              <XAxis dataKey="mes" tick={{ fontSize: 9 }} />
              <YAxis tick={{ fontSize: 9 }} tickFormatter={(v: number) => `$${v}M`} />
              <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}M`} />
              <Bar dataKey="exposicao" name="Exposicao Total" fill="rgba(220,38,38,0.45)" radius={[3, 3, 0, 0]} />
              <Bar dataKey="ndf" name="NDF Contratado" fill="rgba(124,58,237,0.6)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <p className="text-xs text-atlas-muted uppercase tracking-[2px]">USD / BRL — PTAX</p>
            <SourceBadge src="bcb" />
          </div>
          {ptaxAtual ? (
            <>
              <div className="flex items-baseline gap-3 mb-1">
                <span className="text-3xl font-bold" style={{ color: ptaxColor }}>
                  R$ {ptaxAtual.venda.toFixed(4)}
                </span>
                {!ptaxNeutro && (
                  <span className="text-sm font-semibold" style={{ color: ptaxColor }}>{ptaxVarStr}</span>
                )}
              </div>
              <div className="flex items-center gap-3 mb-3">
                <span className="text-xs text-atlas-muted">
                  Ref. {ptaxAtual.dataRef} · Atualizado {formatFetchedAt(ptaxAtual.fetchedAt)}
                </span>
              </div>
              <ResponsiveContainer width="100%" height={130}>
                <LineChart data={ptaxMiniData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(221,225,232,0.3)" />
                  <XAxis dataKey="data" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 9 }} domain={['auto', 'auto']} tickFormatter={(v: number) => v.toFixed(2)} width={38} />
                  <Tooltip formatter={(v) => `R$ ${Number(v).toFixed(4)}`} />
                  <ReferenceLine y={ptaxAtual.ptax_anterior} stroke="rgba(107,114,128,0.4)" strokeDasharray="4 2" />
                  <Line type="monotone" dataKey="venda" stroke={ptaxColor} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="tendencia" stroke="rgba(107,114,128,0.7)" strokeWidth={2} strokeDasharray="5 3" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </>
          ) : (
            <p className="text-xs text-atlas-muted">Carregando...</p>
          )}
        </div>
      </div>

      {/* Insights */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <InsightCard border="#0077cc" color="rgba(0,119,204,0.07)">
          <strong className="text-atlas-text">Acxe — Titulos a pagar:</strong>{' '}
          <span className="text-atlas-muted">
            {fmtM(kpis.total_pagar_usd)} em {buckets.length} buckets mensais ({fmtBrlM(kpis.total_pagar_brl)})
          </span>
        </InsightCard>
        <InsightCard border="#1a9944" color="rgba(26,153,68,0.07)">
          <strong className="text-atlas-text">Q2P — Receita projetada:</strong>{' '}
          <span className="text-atlas-muted">
            {fmtBrlM(kpis.recebiveis_brl)} a receber ({fmtM(kpis.recebiveis_usd)} equiv. USD)
          </span>
        </InsightCard>
        <InsightCard border="#d97706" color="rgba(217,119,6,0.08)">
          <strong className="text-atlas-text">Estoque nao pago estimado:</strong>{' '}
          <span className="text-atlas-muted">
            {fmtPct(kpis.pct_nao_pago)} do estoque importado — {fmtM(kpis.est_nao_pago_usd)} de exposicao adicional
          </span>
        </InsightCard>
        <InsightCard border="#059669" color="rgba(5,150,105,0.07)">
          <strong className="text-atlas-text">Estoque total:</strong>{' '}
          <span className="text-atlas-muted">
            {fmtBrlM(kpis.total_est_brl)} — Importado {fmtBrlM(kpis.est_importado_brl)} | Transito {fmtBrlM(kpis.est_transito_brl)} | Nacional {fmtBrlM(kpis.est_nacional_brl)}
          </span>
        </InsightCard>
      </div>
    </div>
  );
}
