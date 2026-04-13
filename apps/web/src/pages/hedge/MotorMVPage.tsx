import { useState, useEffect, useRef, useCallback, type ChangeEvent } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { DataTable, type Column } from '@atlas/ui';
import { useAuthStore } from '../../stores/auth.store.js';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

interface CamadasResult { l1_pct: number; l2_pct: number; l3_pct: number; }
interface Recomendacao {
  bucket_id: string; mes_ref: string; instrumento: string;
  notional_sugerido: number; gap_atual: number; cobertura_alvo: number;
  taxa_ndf: number; custo_ndf_brl: number;
  prioridade: 'critica' | 'alta' | 'media' | 'nenhuma';
  status: 'ok' | 'sub_hedged'; acao_recomendada: string;
}
interface MotorResult {
  camadas: CamadasResult; recomendacoes: Recomendacao[];
  cobertura_global_pct: number; gap_total_usd: number;
  custo_acao_brl: number;
}

const fmtK = (v: number) => '$' + Math.round(v / 1000) + 'K';
const fmtM = (v: number) => '$' + (v / 1e6).toFixed(2) + 'M';

export function MotorMVPage() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [lambda, setLambda] = useState(0.65);
  const [pctEstoque, setPctEstoque] = useState(52);
  // Debounced versions for query key — prevents request on every slider tick
  const [debouncedLambda, setDebouncedLambda] = useState(0.65);
  const [debouncedEstoque, setDebouncedEstoque] = useState(52);
  const [spotRate, setSpotRate] = useState(5.0);
  const [ndf90Rate, setNdf90Rate] = useState(5.10);

  // Get pct_nao_pago and ptax from posicao on mount
  const { data: posData } = useQuery({
    queryKey: ['hedge', 'posicao-motor'],
    queryFn: async () => {
      const res = await fetch('/api/v1/hedge/posicao', { credentials: 'include' });
      const body = await res.json() as any;
      return body.data?.kpis;
    },
  });

  // Sync posData values into local state once
  const posDataApplied = useRef(false);
  useEffect(() => {
    if (!posData || posDataApplied.current) return;
    posDataApplied.current = true;
    if (posData.pct_nao_pago != null) {
      const ep = Number(posData.pct_nao_pago);
      setPctEstoque(ep);
      setDebouncedEstoque(ep);
    }
    if (posData.ptax_atual?.venda != null) setSpotRate(Number(posData.ptax_atual.venda));
  }, [posData]);

  // Motor calculation as useQuery — fires automatically, refetches on param change
  const fetchMotor = async (l: number, ep: number): Promise<MotorResult> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch('/api/v1/hedge/motor/calcular', {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ lambda: l, pct_estoque_nao_pago: ep / 100 }),
    });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body.data as MotorResult;
  };

  const { data: result = null } = useQuery<MotorResult | null>({
    queryKey: ['hedge', 'motor', debouncedLambda, debouncedEstoque],
    queryFn: () => fetchMotor(debouncedLambda, debouncedEstoque),
    enabled: !!posData,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  // Debounce slider changes — update queryKey only after user stops sliding
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const commitSliders = useCallback((l: number, e: number) => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedLambda(l);
      setDebouncedEstoque(e);
    }, 500);
  }, []);

  const lambdaDesc = lambda < 0.3 ? 'Conservador' : lambda < 0.5 ? 'Moderado' : lambda < 0.7 ? 'Moderado-alto' : 'Alto — max. protecao';

  // Charts: Custo vs Protecao by lambda
  const mvChartData = Array.from({ length: 11 }, (_, i) => {
    const l = i * 0.1;
    const volUsd = 1e6; // reference
    return {
      lambda: l.toFixed(1),
      custo: Math.round(volUsd * (ndf90Rate - spotRate) * l / 1000),
      protecao: Math.round(volUsd * spotRate * 0.05 * l / 1000),
    };
  });

  // Sim margem chart — uses motor layers for accurate coverage split
  const simData: { cambio: string; sem_hedge: number; com_hedge: number; floor: number }[] = [];
  const fat = 25e6;
  const pctImp = 0.7;
  const l1 = result?.camadas.l1_pct ?? 60;
  const l2 = result?.camadas.l2_pct ?? 16;
  const pctAberta = (100 - l1 - l2) / 100;
  const vu = fat * pctImp / spotRate;
  for (let c = 4.5; c <= 7.5; c += 0.10) {
    const cambio = parseFloat(c.toFixed(2));
    simData.push({
      cambio: `R$${cambio.toFixed(2)}`,
      sem_hedge: +((fat - vu * cambio - fat * 0.1) / fat * 100).toFixed(2),
      com_hedge: +((fat - vu * (ndf90Rate * (1 - pctAberta) + cambio * pctAberta) - fat * 0.1) / fat * 100).toFixed(2),
      floor: 15,
    });
  }

  const prioridadeStyle = (p: string) =>
    p === 'critica' ? 'bg-red-500/10 text-red-600 border-red-500/20'
    : p === 'alta' ? 'bg-amber-500/10 text-amber-600 border-amber-500/20'
    : p === 'media' ? 'bg-blue-500/10 text-blue-600 border-blue-500/20'
    : 'bg-gray-500/10 text-gray-500 border-gray-500/20';

  const columns: Column<Recomendacao>[] = [
    { key: 'mes_ref', header: 'Bucket', render: (r) => r.mes_ref.slice(0, 7) },
    { key: 'gap_atual', header: 'Gap USD', render: (r) => fmtK(r.gap_atual) },
    { key: 'notional_sugerido', header: 'NDF a contratar', render: (r) => r.notional_sugerido > 0 ? <span className="text-red-600">{fmtK(r.notional_sugerido)}</span> : <span className="text-emerald-600">OK</span> },
    { key: 'instrumento', header: 'Instrumento', render: (r) => <span className="text-xs font-semibold">{r.instrumento}</span> },
    { key: 'taxa_ndf', header: 'Taxa NDF', render: (r) => r.taxa_ndf > 0 ? `R$ ${r.taxa_ndf.toFixed(2)}` : '—' },
    { key: 'cobertura_alvo', header: 'Cobertura Alvo', render: (r) => `${r.cobertura_alvo.toFixed(1)}%` },
    { key: 'prioridade', header: 'Prioridade', render: (r) => <span className={`inline-flex text-[10px] px-1.5 py-0.5 rounded border font-semibold ${prioridadeStyle(r.prioridade)}`}>{r.prioridade}</span> },
  ];

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-heading font-bold text-atlas-text">Motor de Minima Variancia</h1>

      {/* Engine container */}
      <div className="bg-atlas-card border border-emerald-500/30 rounded-lg p-5 shadow-sm shadow-emerald-500/5">
        <p className="text-[9px] uppercase tracking-[3px] text-emerald-600 mb-5">Motor de Minima Variancia — Recomendacao de Hedge Otimo</p>

        {/* Lambda control */}
        <div className="grid grid-cols-[auto_1fr_auto] gap-4 items-center bg-atlas-bg rounded-lg p-4 border border-atlas-border mb-5">
          <div>
            <p className="text-[9px] tracking-[2px] text-atlas-muted uppercase mb-1">AVERSAO AO RISCO (lambda)</p>
            <p className="text-[9px] text-atlas-muted">0 = minimiza custo / 1 = maximiza protecao</p>
          </div>
          <input type="range" min={0} max={1} step={0.05} value={lambda}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { const v = parseFloat(e.target.value); setLambda(v); commitSliders(v, pctEstoque); }}
            className="w-full accent-emerald-600" />
          <div className="text-right">
            <p className="text-3xl font-bold text-emerald-600">{lambda.toFixed(2)}</p>
            <p className="text-[9px] text-atlas-muted mt-1">{lambdaDesc}</p>
          </div>
        </div>

        {/* Summary cards */}
        {result && (
          <div className="grid grid-cols-3 gap-3 mb-5">
            <div className="bg-atlas-bg border border-atlas-border rounded-lg p-3">
              <p className="text-[9px] tracking-[2px] text-atlas-muted uppercase mb-1">Cobertura Global</p>
              <p className="text-2xl font-bold" style={{ color: result.cobertura_global_pct >= 60 ? '#059669' : result.cobertura_global_pct >= 40 ? '#d97706' : '#dc2626' }}>
                {result.cobertura_global_pct.toFixed(1)}%
              </p>
              <p className="text-[10px] text-atlas-muted mt-1">% da exposicao total coberta</p>
            </div>
            <div className="bg-atlas-bg border border-atlas-border rounded-lg p-3">
              <p className="text-[9px] tracking-[2px] text-atlas-muted uppercase mb-1">Gap Total USD</p>
              <p className="text-2xl font-bold" style={{ color: result.gap_total_usd > 0 ? '#dc2626' : '#059669' }}>
                {fmtM(Math.abs(result.gap_total_usd))}
              </p>
              <p className="text-[10px] text-atlas-muted mt-1">Exposicao residual descoberta</p>
            </div>
            <div className="bg-atlas-bg border border-atlas-border rounded-lg p-3">
              <p className="text-[9px] tracking-[2px] text-atlas-muted uppercase mb-1">Custo da Acao</p>
              <p className="text-2xl font-bold text-purple-600">
                R$ {Math.round(result.custo_acao_brl / 1000)}K
              </p>
              <p className="text-[10px] text-atlas-muted mt-1">Custo estimado para fechar gaps</p>
            </div>
          </div>
        )}

        {/* Extra sliders — like legacy */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
          <div>
            <div className="flex justify-between text-[10px] text-atlas-muted mb-1">
              <span>Cambio Spot (R$)</span>
              <span className="font-bold text-blue-600">R$ {spotRate.toFixed(2)}</span>
            </div>
            <input type="range" min={4.5} max={7.5} step={0.05} value={spotRate}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setSpotRate(parseFloat(e.target.value))}
              className="w-full accent-blue-600" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-atlas-muted mb-1">
              <span>Taxa NDF 90d (R$)</span>
              <span className="font-bold text-purple-600">R$ {ndf90Rate.toFixed(2)}</span>
            </div>
            <input type="range" min={4.5} max={8.0} step={0.05} value={ndf90Rate}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setNdf90Rate(parseFloat(e.target.value))}
              className="w-full accent-purple-600" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-atlas-muted mb-1">
              <span>% Estoque nao pago</span>
              <span className="font-bold text-amber-600">{pctEstoque}%</span>
            </div>
            <input type="range" min={0} max={100} step={5} value={pctEstoque}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { const v = parseInt(e.target.value); setPctEstoque(v); commitSliders(lambda, v); }}
              className="w-full accent-amber-600" />
          </div>
        </div>

        {/* 3 Layers */}
        {result && (
          <div className="grid grid-cols-3 gap-3 mb-5">
            <LayerCard num="01" name="Automatico" pct={result.camadas.l1_pct} color="#059669"
              desc="Contratado automaticamente ao consolidar o bucket." />
            <LayerCard num="02" name="Tatico" pct={result.camadas.l2_pct} color="#7c3aed"
              desc="Decisao semanal — spot vs. media 30d e tendencia." />
            <LayerCard num="03" name="Aberto" pct={result.camadas.l3_pct} color="#d97706"
              desc="Exposicao intencional — captura ganho se cambio cair." />
          </div>
        )}

        {/* Recommendation table */}
        {result && (
          <div>
            <p className="text-[9px] tracking-[2px] text-atlas-muted uppercase mb-2">Recomendacao por Bucket</p>
            <DataTable columns={columns} data={result.recomendacoes} rowKey={(r) => r.bucket_id}
              emptyMessage="Nenhuma recomendacao — cobertura ja atinge o alvo" />
          </div>
        )}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
          <p className="text-[9px] text-atlas-muted uppercase tracking-[2px] mb-2">Custo do Hedge vs Protecao — por lambda</p>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={mvChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(221,225,232,0.5)" />
              <XAxis dataKey="lambda" tick={{ fontSize: 9 }} />
              <YAxis tick={{ fontSize: 9 }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="custo" name="Custo hedge (R$K)" stroke="#d97706" strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="protecao" name="Protecao (R$K)" stroke="#059669" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
          <p className="text-[9px] text-atlas-muted uppercase tracking-[2px] mb-2">Simulacao: Impacto na Margem por Variacao Cambial</p>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={simData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(221,225,232,0.5)" />
              <XAxis dataKey="cambio" tick={{ fontSize: 9 }} interval={4} />
              <YAxis tick={{ fontSize: 9 }} tickFormatter={(v: number) => `${v}%`} />
              <Tooltip formatter={(v) => `${Number(v).toFixed(2)}%`} />
              <Legend />
              <Line type="monotone" dataKey="sem_hedge" name="Sem hedge" stroke="#dc2626" strokeWidth={1.5} strokeDasharray="3 2" dot={false} />
              <Line type="monotone" dataKey="com_hedge" name={`Modelo MV (${l1}/${l2}/${100 - l1 - l2})`} stroke="#059669" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="floor" name="Floor 15%" stroke="rgba(220,38,38,0.3)" strokeWidth={1} strokeDasharray="2 4" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function LayerCard({ num, name, pct, color, desc }: { num: string; name: string; pct: number; color: string; desc: string }) {
  return (
    <div className="rounded-lg p-4 border border-atlas-border" style={{ borderColor: color + '33', background: color + '0a' }}>
      <p className="text-[9px] tracking-[2px] uppercase mb-2" style={{ color }}>{`CAMADA ${num}`}</p>
      <p className="text-sm font-bold mb-1" style={{ color }}>{name}</p>
      <p className="text-2xl font-extrabold leading-none mb-2" style={{ color }}>{pct.toFixed(1)}%</p>
      <p className="text-[10px] text-atlas-muted leading-relaxed">{desc}</p>
      <div className="h-1.5 rounded bg-atlas-border/50 mt-3">
        <div className="h-full rounded transition-all duration-300" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}
