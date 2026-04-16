import { useQuery } from '@tanstack/react-query';

interface Banco {
  id: string;
  banco_nome: string;
  cor_hex: string;
  antecip_limite: number;
  antecip_usado: number;
  antecip_disp: number;
  finimp_limite: number;
  finimp_usado: number;
  finimp_disp: number;
  cheque_limite: number;
  cheque_usado: number;
  cheque_disp: number;
  ativo: boolean;
}

async function fetchBancos(): Promise<Banco[]> {
  const r = await fetch('/api/v1/bp/bancos?empresa=acxe', { credentials: 'include' });
  return (await r.json()).data;
}

const fmtMi = (v: number) => {
  const mi = v / 1_000_000;
  return `R$ ${mi.toFixed(2).replace('.', ',')}Mi`;
};
const fmtBRL = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v);

function TotalCard({
  titulo,
  icone,
  limite,
  usado,
  disp,
  cor,
}: {
  titulo: string;
  icone: string;
  limite: number;
  usado: number;
  disp: number;
  cor: string;
}) {
  const pct = limite > 0 ? (usado / limite) * 100 : 0;
  return (
    <div className="bg-atlas-card border border-atlas-border rounded-xl p-5" style={{ borderTopColor: cor, borderTopWidth: 3 }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xl" aria-hidden>{icone}</span>
        <h2 className="text-sm font-bold uppercase tracking-wider">{titulo}</h2>
      </div>
      <div className="text-3xl font-bold tabular-nums" style={{ color: cor }}>{fmtMi(limite)}</div>
      <div className="text-xs text-atlas-muted mt-1">Limite total agregado</div>
      <div className="mt-4 space-y-1.5">
        <div className="flex justify-between text-xs">
          <span className="text-atlas-muted">Usado</span>
          <span className="font-semibold tabular-nums">{fmtBRL(usado)}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-atlas-muted">Disponível</span>
          <span className="font-semibold tabular-nums" style={{ color: cor }}>{fmtBRL(disp)}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-atlas-muted">Utilização</span>
          <span className="font-semibold tabular-nums">{pct.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  );
}

export function BPLimitesPage() {
  const { data: bancos = [], isLoading } = useQuery({ queryKey: ['bp', 'bancos'], queryFn: fetchBancos });

  if (isLoading) return (
    <div className="p-6 space-y-5">
      <div className="h-8 w-64 bg-atlas-border rounded animate-pulse" />
      <div className="grid grid-cols-3 gap-4">
        {Array.from({ length: 3 }, (_, i) => <div key={i} className="h-48 rounded-xl bg-atlas-border animate-pulse" />)}
      </div>
    </div>
  );

  const ativos = bancos.filter((b) => b.ativo);
  const totalAntecip = {
    limite: ativos.reduce((a, b) => a + b.antecip_limite, 0),
    usado: ativos.reduce((a, b) => a + b.antecip_usado, 0),
    disp: ativos.reduce((a, b) => a + b.antecip_disp, 0),
  };
  const totalFinimp = {
    limite: ativos.reduce((a, b) => a + b.finimp_limite, 0),
    usado: ativos.reduce((a, b) => a + b.finimp_usado, 0),
    disp: ativos.reduce((a, b) => a + b.finimp_disp, 0),
  };
  const totalCheque = {
    limite: ativos.reduce((a, b) => a + b.cheque_limite, 0),
    usado: ativos.reduce((a, b) => a + b.cheque_usado, 0),
    disp: ativos.reduce((a, b) => a + b.cheque_disp, 0),
  };

  return (
    <div className="p-6 max-w-[1440px] mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-heading font-bold">Breaking Point · Limites Consolidados</h1>
        <p className="text-xs text-atlas-muted mt-1">Totais agregados de crédito bancário ativo — visão de tesouraria.</p>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <TotalCard titulo="Antecipação" icone="📄" {...totalAntecip} cor="#CF6437" />
        <TotalCard titulo="FINIMP" icone="🏛" {...totalFinimp} cor="#A85A08" />
        <TotalCard titulo="Cheque Especial" icone="💳" {...totalCheque} cor="#0C6E8A" />
      </div>

      <div className="bg-atlas-card border border-atlas-border rounded-xl p-5">
        <h2 className="text-sm font-bold mb-4">Detalhamento por Banco</h2>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-atlas-muted border-b border-atlas-border">
              <th className="pb-2">Banco</th>
              <th className="pb-2 text-right">Antecip. Limite</th>
              <th className="pb-2 text-right">Antecip. Disp.</th>
              <th className="pb-2 text-right">FINIMP Limite</th>
              <th className="pb-2 text-right">FINIMP Disp.</th>
              <th className="pb-2 text-right">Cheque Disp.</th>
              <th className="pb-2 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {ativos.map((b) => (
              <tr key={b.id} className="border-b border-atlas-border/50 tabular-nums">
                <td className="py-2 font-semibold" style={{ color: b.cor_hex }}>{b.banco_nome}</td>
                <td className="py-2 text-right">{fmtBRL(b.antecip_limite)}</td>
                <td className="py-2 text-right">{fmtBRL(b.antecip_disp)}</td>
                <td className="py-2 text-right">{fmtBRL(b.finimp_limite)}</td>
                <td className="py-2 text-right">{fmtBRL(b.finimp_disp)}</td>
                <td className="py-2 text-right">{fmtBRL(b.cheque_disp)}</td>
                <td className="py-2 text-right">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 uppercase font-semibold">
                    Ativo
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
