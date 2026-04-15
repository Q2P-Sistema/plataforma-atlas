import { Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

interface PtaxAtual {
  dataRef: string;
  venda: number;
  variacao_pct: number;
  fetchedAt?: string;
}

interface PtaxResult {
  atual: PtaxAtual;
}

function formatFetchedAt(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

export function HedgePtaxBadge() {
  const { data } = useQuery<PtaxResult>({
    queryKey: ['hedge', 'ptax', 'badge'],
    queryFn: async () => {
      const res = await fetch('/api/v1/hedge/ptax?dias=2', { credentials: 'include' });
      const body = await res.json() as any;
      return body.data;
    },
    staleTime: 60 * 60 * 1000,
  });

  if (!data) return null;

  const { venda, variacao_pct, fetchedAt } = data.atual;
  const subiu = variacao_pct > 0;
  const neutro = variacao_pct === 0;
  const color = neutro ? 'text-atlas-muted' : subiu ? 'text-red-500' : 'text-emerald-500';
  const arrow = neutro ? '' : subiu ? '▲' : '▼';
  const varStr = `${arrow} ${Math.abs(variacao_pct).toFixed(2)}%`;

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-atlas-muted uppercase tracking-wider">USD</span>
      <span className={`font-bold text-sm ${color}`}>
        R$ {venda.toFixed(4)}
      </span>
      {!neutro && (
        <span className={`font-semibold ${color}`}>{varStr}</span>
      )}
      <span className="text-atlas-muted">{formatFetchedAt(fetchedAt)}</span>
    </div>
  );
}

export function HedgeLayout() {
  return <Outlet />;
}
