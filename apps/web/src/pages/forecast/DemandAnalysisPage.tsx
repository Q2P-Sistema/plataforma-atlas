import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, ResponsiveContainer, Tooltip,
} from 'recharts';

interface VendaMensal { mes: string; volume_kg: number; valor_brl: number; }
interface SkuContrib { codigo: string; descricao: string; volume_24m: number; contribuicao_pct: number; cobertura_dias: number; }
interface YoY { trimestre_atual: number; trimestre_anterior: number; variacao_pct: number; tendencia: 'subindo' | 'descendo' | 'estavel'; }
interface FamiliaDemanda {
  familia: string; meses: VendaMensal[]; ultimos_3m: VendaMensal[];
  yoy: YoY; sparkline: number[]; skus: SkuContrib[];
}

const fmtT = (kg: number) => kg >= 1000 ? `${(kg / 1000).toFixed(1)}t` : `${kg}kg`;

export function DemandAnalysisPage() {
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: familias = [], isLoading } = useQuery<FamiliaDemanda[]>({
    queryKey: ['forecast', 'demanda'],
    queryFn: async () => {
      const res = await fetch('/api/v1/forecast/demanda', { credentials: 'include' });
      const body = (await res.json()) as any;
      return body.data ?? [];
    },
  });

  if (isLoading) return <div className="flex items-center justify-center min-h-[40vh]"><p className="text-atlas-muted">Carregando...</p></div>;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-heading font-bold text-atlas-text">Analise de Demanda</h1>

      <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
        <p className="text-xs text-atlas-muted uppercase tracking-[3px] mb-3">Vendas por Familia — Ultimos 24 Meses</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-atlas-bg border-b border-atlas-border">
                <th className="px-3 py-2.5 text-left text-xs text-atlas-muted uppercase">Familia</th>
                {familias[0]?.ultimos_3m.map((m) => (
                  <th key={m.mes} className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">{formatMesLabel(m.mes)}</th>
                ))}
                <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">YoY %</th>
                <th className="px-3 py-2.5 text-center text-xs text-atlas-muted uppercase w-28">Tendencia 24m</th>
              </tr>
            </thead>
            <tbody>
              {familias.map((f) => {
                const isOpen = expanded === f.familia;
                return (
                  <>{/* Family row */}
                    <tr key={f.familia}
                      onClick={() => setExpanded(isOpen ? null : f.familia)}
                      className="border-b border-atlas-border/50 cursor-pointer hover:bg-atlas-bg/50 transition-colors">
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-blue-600">{isOpen ? '\u25BC' : '\u25B6'}</span>
                          <div>
                            <span className="font-semibold text-atlas-text">{f.familia}</span>
                            <p className="text-xs text-atlas-muted">{f.skus.length} SKUs</p>
                          </div>
                        </div>
                      </td>
                      {f.ultimos_3m.map((m) => (
                        <td key={m.mes} className="px-3 py-3 text-right font-mono">{fmtT(m.volume_kg)}</td>
                      ))}
                      <td className="px-3 py-3 text-right">
                        <YoYBadge yoy={f.yoy} />
                      </td>
                      <td className="px-3 py-3">
                        <MiniSparkline data={f.sparkline} />
                      </td>
                    </tr>
                    {/* SKU breakdown */}
                    {isOpen && f.skus.map((sk) => (
                      <tr key={`${f.familia}-${sk.codigo}`} className="bg-blue-50/30 dark:bg-blue-900/10 border-b border-atlas-border/30">
                        <td className="px-3 py-2 pl-10">
                          <span className="text-xs font-mono font-semibold text-blue-600">{sk.codigo}</span>
                          <span className="ml-2 text-xs text-atlas-muted truncate">{sk.descricao}</span>
                        </td>
                        <td colSpan={f.ultimos_3m.length} className="px-3 py-2 text-right text-xs">
                          <span className="font-semibold">{fmtT(sk.volume_24m)}</span>
                          <span className="text-atlas-muted ml-1">(24m)</span>
                        </td>
                        <td className="px-3 py-2 text-right text-xs">
                          <span className={sk.contribuicao_pct >= 30 ? 'font-semibold text-blue-600' : 'text-atlas-muted'}>
                            {sk.contribuicao_pct}%
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center text-xs text-atlas-muted">
                          {sk.cobertura_dias < 999 ? `${sk.cobertura_dias}d` : '—'}
                        </td>
                      </tr>
                    ))}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function YoYBadge({ yoy }: { yoy: YoY }) {
  if (yoy.trimestre_anterior === 0) return <span className="text-xs text-atlas-muted">—</span>;

  const color = yoy.tendencia === 'subindo' ? '#059669' : yoy.tendencia === 'descendo' ? '#dc2626' : '#d97706';
  const arrow = yoy.tendencia === 'subindo' ? '\u2191' : yoy.tendencia === 'descendo' ? '\u2193' : '\u2192';

  return (
    <span className="inline-flex items-center gap-1 text-sm font-semibold" style={{ color }}>
      {arrow} {yoy.variacao_pct > 0 ? '+' : ''}{yoy.variacao_pct}%
    </span>
  );
}

function MiniSparkline({ data }: { data: number[] }) {
  if (data.length === 0) return <span className="text-xs text-atlas-muted">Sem dados</span>;
  const chartData = data.map((v, i) => ({ i, v }));
  return (
    <ResponsiveContainer width={100} height={28}>
      <AreaChart data={chartData}>
        <defs>
          <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <Tooltip formatter={(v) => fmtT(Number(v))} labelFormatter={() => ''} />
        <Area type="monotone" dataKey="v" stroke="#3b82f6" fill="url(#sparkGrad)" strokeWidth={1.5} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function formatMesLabel(mes: string): string {
  const [, m] = mes.split('-');
  const nomes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return nomes[parseInt(m!, 10) - 1] ?? m!;
}
