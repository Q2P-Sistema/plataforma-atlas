import { useQuery } from '@tanstack/react-query';
import {
  ComposedChart,
  Area,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
} from 'recharts';
import { Countdown } from './components/Countdown.js';

interface BreakingPoint { semana: number; data: string; val: number }
interface TravaEvent { semana: number; data: string }

interface SemanaProjetada {
  semana: number;
  label: string;
  data_fmt: string;
  pagamento: number;
  tipo: string;
  is_finimp: boolean;
  rec_dup: number;
  rec_estoque: number;
  saldo_cc: number;
  antecip_disp: number;
  finimp_disp: number;
  finimp_saldo: number;
  dup_bloq: number;
  dup_livre: number;
  liquidez_total: number;
  gap: number;
  cap_compra: number;
  estoque_rest: number;
  status_gap: 'critico' | 'alerta' | 'ok';
}

interface Projecao {
  kpis: {
    saldo_cc: number;
    dup_total: number;
    estoque_valor_venda: number;
    antecip_disp: number;
    finimp_usado: number;
    dup_bloq: number;
    cap_compra_atual: number;
    cap_compra_med8: number;
    config_incompleta: boolean;
    contas_ativas_count: number;
    contas_excluidas_count: number;
  };
  breaking_points: {
    break_caixa: BreakingPoint | null;
    break_antecip: BreakingPoint | null;
    break_total: BreakingPoint | null;
    trava_finimp: TravaEvent | null;
  };
  semanas: SemanaProjetada[];
  sync_at: string;
}

const fmtMi = (v: number) => {
  if (v === null || v === undefined) return '—';
  const mi = v / 1_000_000;
  const sign = v < 0 ? '− ' : '';
  return `${sign}R$ ${Math.abs(mi).toFixed(2).replace('.', ',')}Mi`;
};
const fmtAxis = (v: number) => `${(v / 1_000_000).toFixed(1)}M`;

async function fetchProjecao(): Promise<Projecao> {
  const res = await fetch('/api/v1/bp/projecao?empresa=acxe', { credentials: 'include' });
  if (!res.ok) throw new Error('Falha ao carregar projeção');
  const json = await res.json();
  return json.data;
}

function CustomTooltip(props: { active?: boolean; payload?: unknown[]; label?: string; semanas: SemanaProjetada[] }) {
  const { active, label, semanas } = props;
  if (!active || !label) return null;
  const d = semanas.find((s) => s.label === label);
  if (!d) return null;

  const gc =
    d.gap < 0 ? 'text-red-600' : d.gap < 300_000 ? 'text-amber-600' : 'text-green-600';

  return (
    <div className="bg-atlas-card border border-atlas-border rounded-lg p-3 text-xs min-w-56 shadow-lg">
      <div className="flex justify-between pb-2 mb-2 border-b border-atlas-border">
        <span className="font-bold">{label}</span>
        <span className="text-atlas-muted">{d.data_fmt}</span>
      </div>
      <Row label="Pagamentos" value={d.pagamento} color={d.is_finimp ? 'text-orange-600' : 'text-red-600'} extra={d.is_finimp ? ' ⚠ FINIMP' : ''} />
      <Row label="Rec. Duplicatas" value={d.rec_dup} color="text-blue-600" />
      <Row label="Rec. Estoque D+15" value={d.rec_estoque} color="text-teal-600" />
      <Row label="Saldo CC" value={d.saldo_cc} color={d.saldo_cc < 0 ? 'text-red-600' : 'text-green-600'} />
      <Row label="Cap. Antecip." value={d.antecip_disp} color={d.antecip_disp < 200_000 ? 'text-red-600' : 'text-amber-600'} />
      <Row label="🛒 Cap. Compras" value={d.cap_compra} color="text-pink-600" />
      <Row label="Gap Liquidez" value={d.gap} color={gc} />
    </div>
  );
}

function Row({ label, value, color, extra }: { label: string; value: number; color: string; extra?: string }) {
  return (
    <div className="flex justify-between gap-4 mb-1">
      <span className="text-atlas-muted">
        {label}
        {extra && <span className="text-orange-600 text-[10px] ml-1">{extra}</span>}
      </span>
      <span className={`font-semibold ${color}`}>{fmtMi(value)}</span>
    </div>
  );
}

function KpiCard({ label, value, color, icon }: { label: string; value: string; color: string; icon: string }) {
  return (
    <div className="bg-atlas-card border border-atlas-border rounded-lg p-3 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ backgroundColor: color }} />
      <div className="text-sm mb-1" aria-hidden>{icon}</div>
      <div className="text-[10px] text-atlas-muted uppercase tracking-wider mb-1">{label}</div>
      <div className="text-sm font-bold" style={{ color }}>{value}</div>
    </div>
  );
}

export function BPDashboardPage() {
  const { data: proj, isLoading, error } = useQuery({
    queryKey: ['bp', 'projecao', 'acxe'],
    queryFn: fetchProjecao,
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-5">
        <div className="h-8 w-64 bg-atlas-border rounded animate-pulse" />
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-20 rounded-lg bg-atlas-border animate-pulse" />)}
        </div>
        <div className="h-80 rounded-xl bg-atlas-border animate-pulse" />
      </div>
    );
  }
  if (error || !proj) {
    return (
      <div className="p-6">
        <p className="text-red-600 font-semibold">Erro ao carregar projeção</p>
        <p className="text-atlas-muted text-sm mt-2">{(error as Error)?.message}</p>
      </div>
    );
  }

  const { kpis, breaking_points: bp, semanas } = proj;

  const alarmColor =
    bp.break_total
      ? bp.break_total.semana <= 4
        ? '#B83228'
        : bp.break_total.semana <= 8
          ? '#CF6437'
          : '#A85A08'
      : '#2A7A4A';

  return (
    <div className="p-6 max-w-[1440px] mx-auto">
      {/* Header com status geral */}
      <div
        className="rounded-xl px-5 py-3 mb-4 flex justify-between items-center border"
        style={{ backgroundColor: `${alarmColor}12`, borderColor: `${alarmColor}55` }}
      >
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: alarmColor }} />
          <span className="text-sm font-semibold" style={{ color: alarmColor }}>
            {bp.break_total
              ? `⚠ BREAKING POINT · Semana ${bp.break_total.semana} · ${bp.break_total.data} · Gap de ${fmtMi(Math.abs(bp.break_total.val))}`
              : '✓ NENHUM BREAKING POINT NOS 180 DIAS'}
          </span>
        </div>
        <span className="text-xs text-atlas-muted">
          Sync: {new Date(proj.sync_at).toLocaleString('pt-BR')}
        </span>
      </div>

      {/* Título */}
      <div className="mb-5">
        <div className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: alarmColor }}>
          Atlas · Tesouraria · Breaking Point
        </div>
        <h1 className="text-2xl font-heading font-bold mt-1">Quando Fico Sem Caixa?</h1>
        <p className="text-xs text-atlas-muted mt-1">
          180 dias · Caixa + Antecipação + Estoque D+15 · FINIMP = Financiamento OMIE
        </p>
      </div>

      {/* Aviso config incompleta */}
      {kpis.config_incompleta && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-xs text-amber-700"
        >
          ⚠ Configuração incompleta — limites bancários zerados ou categoria FINIMP não configurada.
          Acesse a aba <strong>Configurar</strong> para completar os parâmetros e obter projeção precisa.
        </div>
      )}

      {/* Countdowns */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <Countdown semana={bp.break_total?.semana ?? null} label="Colapso de Liquidez" icon="⛔" sub={bp.break_total?.data} />
        <Countdown semana={bp.break_caixa?.semana ?? null} label="Saldo CC Negativo" icon="🏦" sub={bp.break_caixa?.data} />
        <Countdown semana={bp.break_antecip?.semana ?? null} label="Antecipação Esgotada" icon="📄" sub={bp.break_antecip?.data} />
        <Countdown semana={bp.trava_finimp?.semana ?? null} label="Trava FINIMP↔Antecip." icon="🔒" sub={bp.trava_finimp?.data} />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-6 gap-2 mb-5">
        <KpiCard label="Saldo CC" value={fmtMi(kpis.saldo_cc)} color="#2A7A4A" icon="💰" />
        <KpiCard label="Estoque → D+15" value={fmtMi(kpis.estoque_valor_venda)} color="#0C6E8A" icon="📦" />
        <KpiCard label="Cap. Antecip." value={fmtMi(kpis.antecip_disp)} color="#CF6437" icon="📄" />
        <KpiCard label="FINIMP Devedor" value={fmtMi(kpis.finimp_usado)} color="#A85A08" icon="🏛" />
        <KpiCard label="Dup. Bloqueadas" value={fmtMi(kpis.dup_bloq)} color="#7236CC" icon="🔒" />
        <KpiCard label="🛒 Cap. Compras" value={fmtMi(kpis.cap_compra_atual)} color="#B05A8A" icon="🛒" />
      </div>

      {/* Gráfico principal */}
      <div className="bg-atlas-card border border-atlas-border rounded-xl p-4 mb-4">
        <div className="flex justify-between items-start mb-3">
          <div>
            <h2 className="text-sm font-bold">Liquidez · Pagamentos · Capacidade de Compras — 26 Semanas</h2>
            <p className="text-xs text-atlas-muted mt-1">
              Cap. Compras = Caixa + Antecip. + FINIMP disp. − obrigações (buffer 20%) · valores em Mi
            </p>
          </div>
          <div className="bg-pink-500/10 border border-pink-500/30 rounded-lg px-4 py-2 text-center min-w-[170px]">
            <div className="text-[10px] text-atlas-muted uppercase tracking-wider">🛒 Cap. Compras Agora</div>
            <div className="text-xl font-bold text-pink-600 leading-tight">{fmtMi(kpis.cap_compra_atual)}</div>
            <div className="text-[10px] text-atlas-muted mt-1">Média 8 sem: {fmtMi(kpis.cap_compra_med8)}</div>
          </div>
        </div>

        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={semanas} margin={{ top: 10, right: 10, left: 5, bottom: 0 }}>
            <defs>
              <linearGradient id="gLiq" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#2A7A4A" stopOpacity={0.22} />
                <stop offset="95%" stopColor="#2A7A4A" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gCC" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#0C6E8A" stopOpacity={0.18} />
                <stop offset="95%" stopColor="#0C6E8A" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-border)" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} interval={1} />
            <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={fmtAxis} width={60} />
            <Tooltip content={<CustomTooltip semanas={semanas} />} />
            <Area type="monotone" dataKey="liquidez_total" stroke="#2A7A4A" strokeWidth={2} fill="url(#gLiq)" />
            <Area type="monotone" dataKey="saldo_cc" stroke="#0C6E8A" strokeWidth={2} fill="url(#gCC)" />
            <Line type="monotone" dataKey="antecip_disp" stroke="#CF6437" strokeWidth={2} strokeDasharray="5 3" dot={false} />
            <Line type="monotone" dataKey="cap_compra" stroke="#B05A8A" strokeWidth={2} strokeDasharray="5 3" dot={false} />
            <Bar dataKey="pagamento" fill="#B83228" opacity={0.7} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Gráfico FINIMP ↔ Duplicatas Bloqueadas */}
      <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
        <h2 className="text-sm font-bold mb-2">FINIMP ↔ Duplicatas Bloqueadas — 26 Semanas</h2>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={semanas} margin={{ top: 10, right: 10, left: 5, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-border)" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} interval={1} />
            <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={fmtAxis} width={60} />
            <Tooltip formatter={(v: unknown) => fmtMi(Number(v))} />
            <Line type="monotone" name="Saldo FINIMP" dataKey="finimp_saldo" stroke="#A85A08" strokeWidth={2} dot={false} />
            <Line type="monotone" name="Dup. Bloqueadas" dataKey="dup_bloq" stroke="#7236CC" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
