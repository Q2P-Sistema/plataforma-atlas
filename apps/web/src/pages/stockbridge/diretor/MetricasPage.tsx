import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

interface KPIs {
  valorEstoqueBrl: number;
  valorEstoqueUsd: number;
  exposicaoCambialUsd: number;
  exposicaoCambialBrl: number;
  giroMedioDias: Record<string, number>;
  taxaDivergenciaPct: number;
  ptaxBrl: number;
}
interface Evolucao { mes: string; familia: string | null; quantidadeT: number; valorBrl: number; }
interface AnaliticaSku {
  codigoAcxe: number; nome: string; familia: string | null; ncm: string | null;
  quantidadeT: number; cmpUsd: number; valorBrl: number; coberturaDias: number | null; divergencias: number;
}

const fmtBRL = (n: number) => `R$ ${(n / 1e6).toFixed(2)} M`;
const fmtUSD = (n: number) => `USD ${(n / 1e3).toFixed(0)} k`;

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', headers });
    const body = (await res.json()) as { data: unknown; error: { message?: string } | null };
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body;
  };
}

export function MetricasPage() {
  const apiFetch = useApiFetch();

  const { data: kpis } = useQuery<KPIs>({
    queryKey: ['sb', 'metricas'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/metricas')).data as KPIs,
  });
  const { data: evolucao = [] } = useQuery<Evolucao[]>({
    queryKey: ['sb', 'metricas', 'evolucao'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/metricas/evolucao?meses=6')).data as Evolucao[],
  });
  const { data: analitica = [] } = useQuery<AnaliticaSku[]>({
    queryKey: ['sb', 'metricas', 'analitica'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/metricas/tabela-analitica')).data as AnaliticaSku[],
  });

  // Agrupa evolucao por mes somando familias
  const evolucaoAgrupada = [...new Set(evolucao.map((e) => e.mes))].sort().map((mes) => {
    const meses = evolucao.filter((e) => e.mes === mes);
    return {
      mes,
      quantidadeT: meses.reduce((a, b) => a + b.quantidadeT, 0),
      valorBrl: meses.reduce((a, b) => a + b.valorBrl, 0),
    };
  });
  const maxEvol = Math.max(1, ...evolucaoAgrupada.map((e) => e.quantidadeT));

  return (
    <div className="p-6 max-w-7xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Metricas</h1>
        <p className="text-sm text-atlas-muted">Valor do estoque, exposicao cambial, giro, taxa de divergencia.</p>
      </div>

      {kpis && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-6">
          <Card label="Valor Estoque" value={fmtBRL(kpis.valorEstoqueBrl)} sub={fmtUSD(kpis.valorEstoqueUsd)} />
          <Card label="Exposicao Cambial" value={fmtUSD(kpis.exposicaoCambialUsd)} sub={fmtBRL(kpis.exposicaoCambialBrl)} accent="text-violet-700" />
          <Card label="PTAX" value={`R$ ${kpis.ptaxBrl.toFixed(4)}`} sub="BCB" />
          <Card label="Taxa Divergencia" value={`${kpis.taxaDivergenciaPct}%`} accent={kpis.taxaDivergenciaPct > 5 ? 'text-red-700' : 'text-amber-700'} />
          <Card
            label="Giro Medio"
            value={Object.entries(kpis.giroMedioDias).map(([f, d]) => `${f}: ${d}d`).join(' · ') || '—'}
            accent="text-blue-700"
          />
        </div>
      )}

      {evolucaoAgrupada.length > 0 && (
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-5 mb-6">
          <h2 className="font-serif text-sm text-atlas-ink mb-3">Evolucao — ultimos 6 meses</h2>
          <div className="flex items-end gap-2 h-32">
            {evolucaoAgrupada.map((e) => {
              const h = (e.quantidadeT / maxEvol) * 100;
              return (
                <div key={e.mes} className="flex-1 flex flex-col items-center gap-1">
                  <div className="text-[10px] text-atlas-muted">{Math.round(e.quantidadeT)}t</div>
                  <div className="w-full bg-atlas-ink rounded-t" style={{ height: `${h}%` }} />
                  <div className="text-[10px] text-atlas-muted">{e.mes}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {analitica.length > 0 && (
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <div className="p-3 border-b border-slate-200 dark:border-slate-700 font-serif text-sm text-atlas-ink">
            Tabela Analitica por SKU
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-900/40 border-b border-slate-200 dark:border-slate-700">
                {['SKU', 'Familia', 'NCM', 'Qtd (t)', 'CMP USD/t', 'Valor BRL', 'Cobertura', 'Div.'].map((h) => (
                  <th key={h} className="text-left px-3 py-2 font-semibold text-atlas-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {analitica.map((s) => (
                <tr key={s.codigoAcxe} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-900/30">
                  <td className="px-3 py-2 font-medium">{s.nome}</td>
                  <td className="px-3 py-2 text-atlas-muted">{s.familia ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-atlas-muted">{s.ncm ?? '—'}</td>
                  <td className="px-3 py-2 text-right">{s.quantidadeT.toFixed(1)}</td>
                  <td className="px-3 py-2 text-right">{s.cmpUsd > 0 ? s.cmpUsd.toFixed(0) : '—'}</td>
                  <td className="px-3 py-2 text-right">{fmtBRL(s.valorBrl)}</td>
                  <td className="px-3 py-2 text-right">{s.coberturaDias != null ? `${s.coberturaDias}d` : '—'}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-1.5 py-0.5 rounded ${s.divergencias > 0 ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
                      {s.divergencias > 0 ? s.divergencias : '✓'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Card({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
      <div className="text-xs text-atlas-muted">{label}</div>
      <div className={`font-serif text-lg ${accent ?? 'text-atlas-ink'}`}>{value}</div>
      {sub && <div className="text-xs text-atlas-muted mt-0.5">{sub}</div>}
    </div>
  );
}
