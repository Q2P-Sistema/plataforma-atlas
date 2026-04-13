import { useState, type ChangeEvent } from 'react';
import { useQuery } from '@tanstack/react-query';

interface Sku {
  codigo: string; descricao: string; disponivel: number; bloqueado: number;
  transito: number; total: number; cmc: number; venda_dia: number; cobertura: number; lt: number;
}

interface FamiliaRow {
  familia_id: string; familia_nome: string; is_internacional: boolean;
  pool_disponivel: number; pool_bloqueado: number; pool_transito: number; pool_total: number;
  cmc_medio: number; vendas12m: number; venda_diaria_media: number; cobertura_dias: number;
  lt_efetivo: number; status: string; skus_count: number; skus: Sku[];
}

const fmtT = (kg: number) => kg >= 1000 ? `${(kg / 1000).toFixed(1)}t` : `${kg}kg`;

const STATUS_STYLE: Record<string, string> = {
  critico: 'bg-red-500/10 text-red-600 border-red-500/20',
  atencao: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  ok: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
};

export function ForecastDashboard() {
  const [statusFilter, setStatusFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: familias = [], isLoading } = useQuery<FamiliaRow[]>({
    queryKey: ['forecast', 'familias'],
    queryFn: async () => {
      const res = await fetch('/api/v1/forecast/familias', { credentials: 'include' });
      const body = (await res.json()) as any;
      return body.data ?? [];
    },
  });

  const filtered = statusFilter ? familias.filter((f) => f.status === statusFilter) : familias;

  // KPIs
  const totalEstoque = familias.reduce((s, f) => s + f.pool_total, 0);
  const criticas = familias.filter((f) => f.status === 'critico').length;
  const atencao = familias.filter((f) => f.status === 'atencao').length;
  const proxRuptura = familias.filter((f) => f.cobertura_dias < 999).sort((a, b) => a.cobertura_dias - b.cobertura_dias)[0];


  if (isLoading) return <div className="flex items-center justify-center min-h-[40vh]"><p className="text-atlas-muted">Carregando...</p></div>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-bold text-atlas-text">Forecast Planner</h1>
        <select value={statusFilter} onChange={(e: ChangeEvent<HTMLSelectElement>) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm">
          <option value="">Todos</option>
          <option value="critico">Critico</option>
          <option value="atencao">Atencao</option>
          <option value="ok">OK</option>
        </select>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <KpiCard label="Estoque Total" value={fmtT(totalEstoque)} color="#059669" sub={`${familias.length} familias`} />
        <KpiCard label="Proxima Ruptura" value={proxRuptura ? `${proxRuptura.cobertura_dias}d` : '—'} color="#d97706"
          sub={proxRuptura ? proxRuptura.familia_nome : 'Nenhuma ruptura prevista'} />
        <KpiCard label="Familias Criticas" value={String(criticas)} color="#dc2626" sub={`${atencao} em atencao`} />
        <KpiCard label="Total Familias" value={String(familias.length)} color="#7c3aed"
          sub={`${familias.filter((f) => f.is_internacional).length} internacionais`} />
      </div>

      {/* Families table — manual with inline expandable SKU rows */}
      <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
        <p className="text-xs text-atlas-muted uppercase tracking-[3px] mb-3">Familias de Produto — Estoque e Cobertura</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-atlas-bg border-b border-atlas-border">
                <th className="px-3 py-2.5 text-left text-xs text-atlas-muted uppercase">Familia</th>
                <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">Disponivel</th>
                <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">Reservado</th>
                <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">Transito</th>
                <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">Total</th>
                <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">CMC R$/kg</th>
                <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">Venda/dia</th>
                <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">Cobertura</th>
                <th className="px-3 py-2.5 text-center text-xs text-atlas-muted uppercase">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const isOpen = expanded === r.familia_id;
                return (
                  <>{/* Family row */}
                    <tr key={r.familia_id}
                      onClick={() => setExpanded(isOpen ? null : r.familia_id)}
                      className="border-b border-atlas-border/50 cursor-pointer hover:bg-atlas-bg/50 transition-colors">
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-blue-600">{isOpen ? '\u25BC' : '\u25B6'}</span>
                          <div>
                            <span className="font-semibold text-atlas-text">{r.familia_nome}</span>
                            {r.is_internacional && <span className="ml-2 text-xs text-blue-500">INTL</span>}
                            <p className="text-xs text-atlas-muted">{r.skus_count} SKUs</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right">{fmtT(r.pool_disponivel)}</td>
                      <td className="px-3 py-3 text-right">{r.pool_bloqueado > 0 ? <span className="text-amber-600">{fmtT(r.pool_bloqueado)}</span> : '—'}</td>
                      <td className="px-3 py-3 text-right">{r.pool_transito > 0 ? <span className="text-blue-600">{fmtT(r.pool_transito)}</span> : '—'}</td>
                      <td className="px-3 py-3 text-right font-semibold">{fmtT(r.pool_total)}</td>
                      <td className="px-3 py-3 text-right">R$ {r.cmc_medio.toFixed(2)}</td>
                      <td className="px-3 py-3 text-right">{r.venda_diaria_media > 0 ? fmtT(r.venda_diaria_media) : <span className="text-atlas-muted">—</span>}</td>
                      <td className="px-3 py-3 text-right">
                        {r.cobertura_dias >= 999 ? <span className="text-atlas-muted">sem hist.</span> : (
                          <span style={{ color: r.cobertura_dias <= 30 ? '#dc2626' : r.cobertura_dias <= 60 ? '#d97706' : '#059669' }} className="font-semibold">{r.cobertura_dias}d</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span className={`inline-flex text-xs px-1.5 py-0.5 rounded border font-semibold ${STATUS_STYLE[r.status] ?? ''}`}>{r.status}</span>
                      </td>
                    </tr>
                    {/* Expanded SKU rows — inline */}
                    {isOpen && r.skus.map((sk) => (
                      <tr key={`${r.familia_id}-${sk.codigo}`} className="bg-blue-50/30 dark:bg-blue-900/10 border-b border-atlas-border/30">
                        <td className="px-3 py-2 pl-10">
                          <span className="text-xs font-mono font-semibold text-blue-600">{sk.codigo}</span>
                          <span className="ml-2 text-xs text-atlas-muted truncate">{sk.descricao}</span>
                        </td>
                        <td className="px-3 py-2 text-right text-xs">{fmtT(sk.disponivel)}</td>
                        <td className="px-3 py-2 text-right text-xs text-amber-600">{sk.bloqueado > 0 ? fmtT(sk.bloqueado) : '—'}</td>
                        <td className="px-3 py-2 text-right text-xs text-blue-600">{sk.transito > 0 ? fmtT(sk.transito) : '—'}</td>
                        <td className="px-3 py-2 text-right text-xs font-semibold">{fmtT(sk.total)}</td>
                        <td className="px-3 py-2 text-right text-xs">R$ {sk.cmc.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right text-xs">{sk.venda_dia > 0 ? fmtT(sk.venda_dia) : '—'}</td>
                        <td className="px-3 py-2 text-right text-xs">{sk.cobertura < 999 ? `${sk.cobertura}d` : '—'}</td>
                        <td className="px-3 py-2 text-center text-xs text-atlas-muted">{sk.lt}d LT</td>
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

function KpiCard({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div className="bg-atlas-card border border-atlas-border rounded-lg p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ backgroundColor: color }} />
      <p className="text-xs text-atlas-muted uppercase tracking-wider mb-2">{label}</p>
      <p className="text-xl font-bold" style={{ color }}>{value}</p>
      {sub && <p className="text-xs text-atlas-muted mt-1">{sub}</p>}
    </div>
  );
}
