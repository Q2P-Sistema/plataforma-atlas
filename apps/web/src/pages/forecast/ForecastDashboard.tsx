import { useState, useMemo, type ChangeEvent } from 'react';
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

interface UrgenteForecast {
  familia_id: string; familia_nome: string; is_internacional: boolean; lt_efetivo: number;
  pool_disponivel: number; pool_bloqueado: number; pool_transito: number; pool_total: number;
  cmc_medio: number; vendas12m: number; venda_diaria_media: number;
  dia_ruptura: number; dia_pedido_ideal: number; prazo_perdido: boolean; status: string;
  qtd_sugerida: number; moq_ativo: number; valor_brl: number; qtd_em_rota: number;
  compra_local: { dia_abrir: number; gap_dias: number; custo_oportunidade: number; qtd_local: number; valor_local: number } | null;
}

const fmtT = (kg: number) => kg >= 1000 ? `${(kg / 1000).toFixed(1)}t` : `${kg}kg`;
const fmtBrl = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

const STATUS_STYLE: Record<string, string> = {
  critico: 'bg-red-500/10 text-red-600 border-red-500/20',
  atencao: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  ok: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
};

export function ForecastDashboard() {
  const [tab, setTab] = useState<'familias' | 'urgentes'>('familias');
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

  const { data: urgentes = [] } = useQuery<UrgenteForecast[]>({
    queryKey: ['forecast', 'urgentes'],
    queryFn: async () => {
      const res = await fetch('/api/v1/forecast/urgentes', { credentials: 'include' });
      const body = (await res.json()) as any;
      return body.data ?? [];
    },
  });

  const filtered = statusFilter ? familias.filter((f) => f.status === statusFilter) : familias;

  // Separate urgentes into 3 categories (GAP-F6)
  const { intl, local, nacional } = useMemo(() => {
    const intl: UrgenteForecast[] = [];
    const local: UrgenteForecast[] = [];
    const nacional: UrgenteForecast[] = [];
    for (const u of urgentes) {
      if (u.compra_local) local.push(u);
      if (!u.is_internacional && u.dia_ruptura >= 0) nacional.push(u);
      if (u.is_internacional && u.dia_pedido_ideal >= 0 && u.dia_pedido_ideal <= 15) intl.push(u);
    }
    return { intl, local, nacional };
  }, [urgentes]);

  // KPIs
  const totalEstoque = familias.reduce((s, f) => s + f.pool_total, 0);
  const proxRuptura = familias.filter((f) => f.cobertura_dias < 999).sort((a, b) => a.cobertura_dias - b.cobertura_dias)[0];
  const valorTotal = urgentes.reduce((s, u) => s + u.valor_brl, 0);

  if (isLoading) return <div className="flex items-center justify-center min-h-[40vh]"><p className="text-atlas-muted">Carregando...</p></div>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-bold text-atlas-text">Forecast Planner</h1>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border border-atlas-border overflow-hidden">
            <button onClick={() => setTab('familias')}
              className={`px-4 py-1.5 text-sm font-medium transition-colors ${tab === 'familias' ? 'bg-acxe text-white' : 'bg-atlas-bg text-atlas-muted hover:text-atlas-text'}`}>
              Familias
            </button>
            <button onClick={() => setTab('urgentes')}
              className={`px-4 py-1.5 text-sm font-medium transition-colors ${tab === 'urgentes' ? 'bg-red-600 text-white' : 'bg-atlas-bg text-atlas-muted hover:text-atlas-text'}`}>
              Compras 15d {urgentes.length > 0 && <span className="ml-1 bg-white/20 rounded-full px-1.5 text-xs">{urgentes.length}</span>}
            </button>
          </div>
          {tab === 'familias' && (
            <select value={statusFilter} onChange={(e: ChangeEvent<HTMLSelectElement>) => setStatusFilter(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm">
              <option value="">Todos</option>
              <option value="critico">Critico</option>
              <option value="atencao">Atencao</option>
              <option value="ok">OK</option>
            </select>
          )}
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <KpiCard label="Estoque Total" value={fmtT(totalEstoque)} color="#059669" sub={`${familias.length} familias`} />
        <KpiCard label="Proxima Ruptura" value={proxRuptura ? `${proxRuptura.cobertura_dias}d` : '—'} color="#d97706"
          sub={proxRuptura ? proxRuptura.familia_nome : 'Nenhuma ruptura'} />
        <KpiCard label="Compra Intl." value={String(intl.length)} color="#dc2626" sub="urgentes 15 dias" />
        <KpiCard label="Compra Local" value={String(local.length)} color="#7c3aed" sub="prazo perdido" />
        <KpiCard label="Valor a Comprar" value={fmtBrl(valorTotal)} color="#0077cc" sub={`${urgentes.length} familias`} />
      </div>

      {/* TAB: Familias */}
      {tab === 'familias' && (
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
      )}

      {/* TAB: Urgentes — 3 categorias (GAP-F6) */}
      {tab === 'urgentes' && (
        <div className="space-y-5">
          {/* Internacional */}
          <UrgentSection
            title="Compras Internacionais"
            subtitle="Pedido necessario nos proximos 15 dias"
            color="#dc2626"
            items={intl}
            type="intl"
          />

          {/* Local emergencial */}
          <UrgentSection
            title="Compras Locais Emergenciais"
            subtitle="Prazo internacional perdido — negociacao spot"
            color="#7c3aed"
            items={local}
            type="local"
          />

          {/* Nacional */}
          <UrgentSection
            title="Compras Nacionais"
            subtitle="Sem pipeline internacional — planejamento por estoque e demanda"
            color="#0891b2"
            items={nacional}
            type="nacional"
          />

          {intl.length === 0 && local.length === 0 && nacional.length === 0 && (
            <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-8 text-center">
              <p className="text-emerald-600 font-semibold">Nenhuma compra urgente nos proximos 15 dias.</p>
            </div>
          )}
        </div>
      )}
      {/* Definitions */}
      <DefinitionsPanel />
    </div>
  );
}

function DefinitionsPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-atlas-border rounded-lg overflow-hidden">
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-atlas-bg text-xs text-atlas-muted hover:text-atlas-text transition-colors">
        <span className="uppercase tracking-[2px] font-medium">Definicoes e Metodologia</span>
        <span className="text-sm">{open ? '\u25B2' : '\u25BC'}</span>
      </button>
      {open && (
        <div className="px-4 py-3 bg-atlas-card text-xs text-atlas-muted space-y-3 leading-relaxed">
          <div>
            <p className="font-semibold text-atlas-text mb-0.5">Pool de Estoque (3 camadas)</p>
            <p><strong>Disponivel</strong> = saldo - reservado. <strong>Bloqueado</strong> = reservado para pedidos em carteira. <strong>Transito</strong> = pedidos de compra pendentes de recebimento. <strong>Total</strong> = disponivel + bloqueado + transito.</p>
          </div>
          <div>
            <p className="font-semibold text-atlas-text mb-0.5">Cobertura (dias)</p>
            <p>Estoque total dividido pela demanda diaria sazonalizada. Indica quantos dias o estoque atual cobre sem novas chegadas.</p>
          </div>
          <div>
            <p className="font-semibold text-atlas-text mb-0.5">Sazonalidade</p>
            <p>Fator multiplicador mensal aplicado a demanda diaria media. Valores &gt;1.0 indicam mes de alta demanda, &lt;1.0 indica baixa. Editavel em Config &gt; Sazonalidade.</p>
          </div>
          <div>
            <p className="font-semibold text-atlas-text mb-0.5">Qtd Sugerida (net-of-pipeline)</p>
            <p>Demanda total para LT + 60 dias de cobertura, descontando pedidos em rota. Arredondada para cima ao MOQ (Internacional: 25t, Nacional: 12t). So calculada se ruptura detectada.</p>
          </div>
          <div>
            <p className="font-semibold text-atlas-text mb-0.5">Compra Local Emergencial</p>
            <p>Quando o prazo de pedido internacional esta perdido (dia ideal &lt; 0), sugere compra local com LT curto (7d) para cobrir o gap ate a chegada do pedido internacional.</p>
          </div>
          <div>
            <p className="font-semibold text-atlas-text mb-0.5">Status</p>
            <p><strong>Critico</strong> = ruptura em ate 30 dias. <strong>Atencao</strong> = ruptura entre 31-60 dias. <strong>OK</strong> = sem ruptura nos proximos 60 dias.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function UrgentSection({ title, subtitle, color, items, type }: {
  title: string; subtitle: string; color: string;
  items: UrgenteForecast[]; type: 'intl' | 'local' | 'nacional';
}) {
  if (items.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <div className="w-1 h-6 rounded" style={{ backgroundColor: color }} />
        <div>
          <p className="text-sm font-bold text-atlas-text">{title}</p>
          <p className="text-xs text-atlas-muted">{subtitle}</p>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border" style={{ borderColor: color + '30' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ backgroundColor: color + '08' }} className="border-b" >
              <th className="px-3 py-2.5 text-center text-xs text-atlas-muted uppercase w-20">Urgencia</th>
              <th className="px-3 py-2.5 text-left text-xs text-atlas-muted uppercase">Familia</th>
              <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">Estoque</th>
              <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">{type === 'local' ? 'Ruptura' : 'Cobertura'}</th>
              <th className="px-3 py-2.5 text-center text-xs text-atlas-muted uppercase">LT</th>
              <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">{type === 'local' ? 'Gap' : 'Qtd Sugerida'}</th>
              <th className="px-3 py-2.5 text-right text-xs text-atlas-muted uppercase">{type === 'local' ? 'Custo Oport.' : 'Valor Est.'}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((u) => {
              const dias = type === 'local'
                ? u.compra_local?.dia_abrir ?? 0
                : u.dia_pedido_ideal;
              const urgColor = dias === 0 ? '#dc2626' : dias <= 5 ? '#ea580c' : color;
              return (
                <tr key={u.familia_id} className="border-b border-atlas-border/30 hover:bg-atlas-bg/30">
                  <td className="px-3 py-3 text-center">
                    <span className="text-xl font-bold" style={{ color: urgColor }}>{dias === 0 ? 'HOJE' : `${dias}d`}</span>
                  </td>
                  <td className="px-3 py-3">
                    <span className="font-semibold text-atlas-text">{u.familia_nome}</span>
                    {type === 'local' && <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 border border-purple-500/20">LOCAL</span>}
                    {type === 'nacional' && <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-600 border border-cyan-500/20">NACIONAL</span>}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <span className="font-semibold">{fmtT(u.pool_total)}</span>
                    {u.qtd_em_rota > 0 && <span className="ml-1 text-xs text-blue-600">+{fmtT(u.qtd_em_rota)} rota</span>}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {type === 'local'
                      ? <span className="text-red-600 font-semibold">{u.dia_ruptura >= 0 ? `${u.dia_ruptura}d` : '—'}</span>
                      : <span className="font-semibold" style={{ color: u.dia_ruptura <= 30 ? '#dc2626' : '#d97706' }}>{u.dia_ruptura >= 0 ? `${u.dia_ruptura}d` : '>120d'}</span>
                    }
                  </td>
                  <td className="px-3 py-3 text-center text-atlas-muted">{u.lt_efetivo}d</td>
                  <td className="px-3 py-3 text-right">
                    {type === 'local'
                      ? <span className="text-red-600 font-semibold">{u.compra_local ? `${u.compra_local.gap_dias}d` : '—'}</span>
                      : <><span className="font-semibold" style={{ color }}>{fmtT(u.qtd_sugerida)}</span>
                          <span className="text-xs text-atlas-muted ml-1">MOQ {u.moq_ativo / 1000}t</span></>
                    }
                  </td>
                  <td className="px-3 py-3 text-right">
                    {type === 'local'
                      ? <span className="text-red-600 font-semibold">{fmtBrl(u.compra_local?.custo_oportunidade ?? 0)}</span>
                      : <span className="font-semibold" style={{ color }}>{fmtBrl(u.valor_brl)}</span>
                    }
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
