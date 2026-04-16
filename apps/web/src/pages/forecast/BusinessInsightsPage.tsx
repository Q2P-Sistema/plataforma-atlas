import { useQuery } from '@tanstack/react-query';
import {
  Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart,
} from 'recharts';

interface Fornecedor { fornecedor: string; pais_origem: string; familias: string[]; lt_efetivo_dias: number; total_importacoes: number; ultimo_embarque: string; }
interface ScoreCOMEX { mes: string; score: number; classificacao: string; preco_ton_usd: number; volume_kg: number; taxa_dolar: number; }
interface HistImport { mes: string; volume_kg: number; valor_usd: number; preco_ton_usd: number; taxa_dolar: number; }
interface InsightsData { fornecedores: Fornecedor[]; score_comex: ScoreCOMEX[]; historico_importacao: HistImport[]; }

const fmtT = (kg: number) => kg >= 1000 ? `${(kg / 1000).toFixed(1)}t` : `${kg}kg`;
const fmtK = (v: number) => `$${Math.round(v / 1000)}K`;

const SCORE_STYLE: Record<string, { bg: string; text: string; border: string }> = {
  COMPRAR: { bg: 'bg-emerald-500/10', text: 'text-emerald-600', border: 'border-emerald-500/20' },
  BOM: { bg: 'bg-green-500/10', text: 'text-green-600', border: 'border-green-500/20' },
  NEUTRO: { bg: 'bg-amber-500/10', text: 'text-amber-600', border: 'border-amber-500/20' },
  CAUTELA: { bg: 'bg-orange-500/10', text: 'text-orange-600', border: 'border-orange-500/20' },
  EVITAR: { bg: 'bg-red-500/10', text: 'text-red-600', border: 'border-red-500/20' },
};

export function BusinessInsightsPage() {
  const { data, isLoading } = useQuery<InsightsData>({
    queryKey: ['forecast', 'insights'],
    queryFn: async () => {
      const res = await fetch('/api/v1/forecast/insights', { credentials: 'include' });
      const body = (await res.json()) as any;
      return body.data;
    },
  });

  if (isLoading || !data) return (
    <div className="space-y-5">
      <div className="h-8 w-48 bg-atlas-border rounded animate-pulse" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-28 rounded-lg bg-atlas-border animate-pulse" />)}
      </div>
      <div className="h-64 rounded-lg bg-atlas-border animate-pulse" />
    </div>
  );

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-heading font-bold text-atlas-text">Business Insights</h1>

      {/* Score COMEX cards */}
      {data.score_comex.length > 0 && (
        <div>
          <p className="text-xs text-atlas-muted uppercase tracking-[3px] mb-3">Score COMEX — Favorabilidade de Compra</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {data.score_comex.slice(-4).map((s) => {
              const style = SCORE_STYLE[s.classificacao] ?? SCORE_STYLE['NEUTRO']!;
              return (
                <div key={s.mes} className={`border rounded-lg p-4 ${style.bg} ${style.border}`}>
                  <p className="text-xs text-atlas-muted uppercase mb-1">{formatMesLabel(s.mes)}</p>
                  <div className="flex items-end gap-2 mb-2">
                    <span className={`text-3xl font-bold ${style.text}`}>{s.score}</span>
                    <span className={`text-xs font-semibold px-1.5 py-0.5 rounded border ${style.bg} ${style.text} ${style.border}`}>
                      {s.classificacao}
                    </span>
                  </div>
                  <div className="h-2 rounded bg-atlas-border/30">
                    <div className="h-full rounded transition-all" style={{
                      width: `${s.score}%`,
                      backgroundColor: s.score >= 70 ? '#059669' : s.score >= 55 ? '#22c55e' : s.score >= 40 ? '#d97706' : s.score >= 25 ? '#ea580c' : '#dc2626',
                    }} />
                  </div>
                  <div className="flex justify-between text-xs text-atlas-muted mt-2">
                    <span>${s.preco_ton_usd}/t</span>
                    <span>R$ {s.taxa_dolar.toFixed(2)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Fornecedores */}
      <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
        <p className="text-xs text-atlas-muted uppercase tracking-[3px] mb-3">Fornecedores — Lead Time e Histórico</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-atlas-bg border-b border-atlas-border">
                <th className="px-3 py-2.5 text-left text-xs text-atlas-muted uppercase">Fornecedor</th>
                <th className="px-3 py-2.5 text-left text-xs text-atlas-muted uppercase">País</th>
                <th className="px-3 py-2.5 text-left text-xs text-atlas-muted uppercase">Famílias</th>
                <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">LT Efetivo</th>
                <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">Importações</th>
                <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">Último Embarque</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-atlas-border/50">
              {data.fornecedores.map((f) => (
                <tr key={f.fornecedor} className="hover:bg-atlas-bg/50">
                  <td className="px-3 py-3 font-semibold text-atlas-text">{f.fornecedor}</td>
                  <td className="px-3 py-3 text-xs">{f.pais_origem}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      {f.familias.slice(0, 3).map((fam) => (
                        <span key={fam} className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 border border-blue-500/20">{fam}</span>
                      ))}
                      {f.familias.length > 3 && <span className="text-xs text-atlas-muted">+{f.familias.length - 3}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{f.lt_efetivo_dias}d</td>
                  <td className="px-3 py-3 text-right">{f.total_importacoes}</td>
                  <td className="px-3 py-3 text-right text-xs text-atlas-muted">{f.ultimo_embarque ? new Date(f.ultimo_embarque).toLocaleDateString('pt-BR') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Historico importacao chart */}
      {data.historico_importacao.length > 0 && (
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
          <p className="text-xs text-atlas-muted uppercase tracking-[3px] mb-3">Histórico de Importação — 12 Meses</p>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={data.historico_importacao.map((h) => ({ ...h, mes: formatMesLabel(h.mes) }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-border)" />
              <XAxis dataKey="mes" tick={{ fontSize: 10 }} />
              <YAxis yAxisId="vol" tick={{ fontSize: 9 }} tickFormatter={(v: number) => fmtT(v)} />
              <YAxis yAxisId="preco" orientation="right" tick={{ fontSize: 9 }} tickFormatter={(v: number) => `$${v}`} />
              <Tooltip formatter={(v, name) => name === 'Volume (kg)' ? fmtT(Number(v)) : name === 'Valor USD' ? fmtK(Number(v)) : `$${Number(v).toFixed(0)}/t`} />
              <Legend />
              <Bar yAxisId="vol" dataKey="volume_kg" name="Volume (kg)" fill="#3b82f6" opacity={0.7} />
              <Line yAxisId="preco" type="monotone" dataKey="preco_ton_usd" name="Preço/ton USD" stroke="#dc2626" strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {data.score_comex.length === 0 && data.fornecedores.length === 0 && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-8 text-center">
          <p className="text-amber-600 font-semibold">Dados de importação não disponíveis.</p>
          <p className="text-xs text-atlas-muted mt-1">A tabela FUP Comex não contém registros suficientes para gerar insights.</p>
        </div>
      )}
    </div>
  );
}

function formatMesLabel(mes: string): string {
  const parts = mes.split('-');
  if (parts.length < 2) return mes;
  const nomes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${nomes[parseInt(parts[1]!, 10) - 1]} ${parts[0]!.slice(2)}`;
}
