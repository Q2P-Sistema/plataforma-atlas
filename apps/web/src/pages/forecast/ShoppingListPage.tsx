import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../stores/auth.store.js';

interface ForecastResult {
  familia_id: string; familia_nome: string; is_internacional: boolean;
  dia_ruptura: number; dia_pedido_ideal: number; prazo_perdido: boolean;
  qtd_sugerida: number; moq_ativo: number; valor_brl: number; lt_efetivo: number;
  pool_total: number; qtd_em_rota: number; status: string;
  compra_local: { qtd_local: number; valor_local: number } | null;
}

interface ShoppingItem {
  familia_id: string; familia_nome: string; qtd: number; moq: number;
  comprar_em: number; chega_em: number; lt: number; ruptura: number;
  estoque_rota: number; valor: number; obs: string; selected: boolean;
  is_local: boolean;
}

const fmtT = (kg: number) => kg >= 1000 ? `${(kg / 1000).toFixed(1)}t` : `${kg}kg`;
const fmtBrl = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

export function ShoppingListPage() {
  const csrfToken = useAuthStore((s) => s.csrfToken);

  const { data: forecasts = [] } = useQuery<ForecastResult[]>({
    queryKey: ['forecast', 'calcular'],
    queryFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      const res = await fetch('/api/v1/forecast/calcular', {
        method: 'POST', credentials: 'include', headers, body: JSON.stringify({}),
      });
      const body = (await res.json()) as any;
      return body.data ?? [];
    },
    staleTime: 60_000,
  });

  const initialItems: ShoppingItem[] = useMemo(() =>
    forecasts
      .filter((f) => f.qtd_sugerida > 0 || f.compra_local)
      .map((f) => ({
        familia_id: f.familia_id,
        familia_nome: f.familia_nome,
        qtd: f.compra_local ? f.compra_local.qtd_local : f.qtd_sugerida,
        moq: f.moq_ativo,
        comprar_em: f.dia_pedido_ideal,
        chega_em: f.dia_pedido_ideal >= 0 ? f.dia_pedido_ideal + f.lt_efetivo : f.lt_efetivo,
        lt: f.lt_efetivo,
        ruptura: f.dia_ruptura,
        estoque_rota: f.pool_total + f.qtd_em_rota,
        valor: f.compra_local ? f.compra_local.valor_local : f.valor_brl,
        obs: '',
        selected: true,
        is_local: f.prazo_perdido,
      }))
      .sort((a, b) => a.comprar_em - b.comprar_em),
    [forecasts],
  );

  const [items, setItems] = useState<ShoppingItem[]>([]);
  if (items.length === 0 && initialItems.length > 0) setItems(initialItems);

  const toggleSelect = (idx: number) => setItems((prev) => prev.map((it, i) => i === idx ? { ...it, selected: !it.selected } : it));
  const adjustQtd = (idx: number, delta: number) => setItems((prev) => prev.map((it, i) => {
    if (i !== idx) return it;
    const newQtd = Math.max(it.moq, it.qtd + delta * it.moq);
    return { ...it, qtd: newQtd, valor: Math.round(newQtd * (it.valor / it.qtd)) };
  }));
  const setObs = (idx: number, obs: string) => setItems((prev) => prev.map((it, i) => i === idx ? { ...it, obs } : it));

  const selectedItems = items.filter((it) => it.selected);
  const totalValor = selectedItems.reduce((s, it) => s + it.valor, 0);

  const copyToClipboard = () => {
    const lines = selectedItems.map((it) =>
      `${it.familia_nome} | ${fmtT(it.qtd)} | LT ${it.lt}d | ${fmtBrl(it.valor)}${it.is_local ? ' [LOCAL]' : ''}${it.obs ? ` — ${it.obs}` : ''}`
    );
    const text = `LISTA DE COMPRAS — ${new Date().toLocaleDateString('pt-BR')}\n${'—'.repeat(50)}\n${lines.join('\n')}\n${'—'.repeat(50)}\nTOTAL: ${fmtBrl(totalValor)} (${selectedItems.length} itens)`;
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-bold text-atlas-text">Shopping List</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-atlas-muted">{selectedItems.length} itens | {fmtBrl(totalValor)}</span>
          <button onClick={copyToClipboard}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 transition-colors">
            Copiar para Executor
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-8 text-center text-atlas-muted text-xs">
          Nenhuma familia com necessidade de compra detectada.
        </div>
      ) : (
        <div className="bg-atlas-card border border-atlas-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-atlas-bg border-b border-atlas-border">
                <th className="px-2 py-2.5 w-8"></th>
                <th className="px-2 py-2.5 text-left text-[9px] text-atlas-muted uppercase">Familia</th>
                <th className="px-2 py-2.5 text-right text-[9px] text-atlas-muted uppercase">Qtd</th>
                <th className="px-2 py-2.5 text-center text-[9px] text-atlas-muted uppercase">Comprar em</th>
                <th className="px-2 py-2.5 text-center text-[9px] text-atlas-muted uppercase">Chega em</th>
                <th className="px-2 py-2.5 text-right text-[9px] text-atlas-muted uppercase">LT</th>
                <th className="px-2 py-2.5 text-right text-[9px] text-atlas-muted uppercase">Ruptura</th>
                <th className="px-2 py-2.5 text-right text-[9px] text-atlas-muted uppercase">Est+Rota</th>
                <th className="px-2 py-2.5 text-right text-[9px] text-atlas-muted uppercase">Valor</th>
                <th className="px-2 py-2.5 text-left text-[9px] text-atlas-muted uppercase">Obs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-atlas-border/50">
              {items.map((it, idx) => (
                <tr key={it.familia_id} className={`hover:bg-atlas-bg/50 ${!it.selected ? 'opacity-40' : ''}`}>
                  <td className="px-2 py-2">
                    <input type="checkbox" checked={it.selected} onChange={() => toggleSelect(idx)} className="accent-emerald-600" />
                  </td>
                  <td className="px-2 py-2 font-medium text-atlas-text">
                    {it.familia_nome}
                    {it.is_local && <span className="ml-1 text-[8px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-600 border border-purple-500/20">LOCAL</span>}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => adjustQtd(idx, -1)} className="text-[10px] px-1 rounded bg-atlas-border hover:bg-red-100">-</button>
                      <span className="font-mono font-semibold min-w-[40px] text-center">{fmtT(it.qtd)}</span>
                      <button onClick={() => adjustQtd(idx, 1)} className="text-[10px] px-1 rounded bg-atlas-border hover:bg-emerald-100">+</button>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-center">{it.comprar_em >= 0 ? `Dia ${it.comprar_em}` : <span className="text-red-600 font-semibold">AGORA</span>}</td>
                  <td className="px-2 py-2 text-center">Dia {it.chega_em}</td>
                  <td className="px-2 py-2 text-right">{it.lt}d</td>
                  <td className="px-2 py-2 text-right">{it.ruptura >= 0 ? <span className="text-red-600">Dia {it.ruptura}</span> : '—'}</td>
                  <td className="px-2 py-2 text-right font-mono">{fmtT(it.estoque_rota)}</td>
                  <td className="px-2 py-2 text-right font-mono">{fmtBrl(it.valor)}</td>
                  <td className="px-2 py-2">
                    <input type="text" value={it.obs} onChange={(e) => setObs(idx, e.target.value)} placeholder="..."
                      className="w-full px-1 py-0.5 text-[10px] rounded border border-atlas-border/30 bg-transparent" />
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
