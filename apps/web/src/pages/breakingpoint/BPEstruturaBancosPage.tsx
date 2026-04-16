import { useQuery } from '@tanstack/react-query';

interface Banco {
  id: string;
  banco_id: string;
  banco_nome: string;
  cor_hex: string;
  antecip_limite: number;
  antecip_usado: number;
  antecip_taxa: number;
  antecip_disp: number;
  finimp_limite: number;
  finimp_usado: number;
  finimp_garantia_pct: number;
  finimp_disp: number;
  cheque_limite: number;
  cheque_usado: number;
  cheque_disp: number;
  ativo: boolean;
}

const fmtMi = (v: number) => {
  if (v === 0) return 'R$ 0';
  const mi = v / 1_000_000;
  return `R$ ${mi.toFixed(2).replace('.', ',')}Mi`;
};

async function fetchBancos(): Promise<Banco[]> {
  const r = await fetch('/api/v1/bp/bancos?empresa=acxe', { credentials: 'include' });
  return (await r.json()).data;
}

function Bar({ limite, usado, corHex }: { limite: number; usado: number; corHex: string }) {
  const pct = limite > 0 ? Math.min(100, (usado / limite) * 100) : 0;
  const critical = pct >= 90;
  return (
    <div className="w-full h-2 bg-atlas-border/40 rounded overflow-hidden">
      <div
        className="h-full rounded transition-all"
        style={{
          width: `${pct}%`,
          backgroundColor: critical ? '#B83228' : corHex,
        }}
      />
    </div>
  );
}

function LinhaLimite({
  titulo,
  limite,
  usado,
  disp,
  extra,
  corHex,
}: {
  titulo: string;
  limite: number;
  usado: number;
  disp: number;
  extra?: string;
  corHex: string;
}) {
  const pct = limite > 0 ? (usado / limite) * 100 : 0;
  const critical = pct >= 90;
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-atlas-muted">
          {titulo}
          {extra && <span className="ml-2 text-[10px] normal-case">{extra}</span>}
        </span>
        <span className={`text-xs tabular-nums ${critical ? 'text-red-600 font-bold' : ''}`}>
          {fmtMi(usado)} / {fmtMi(limite)}
        </span>
      </div>
      <Bar limite={limite} usado={usado} corHex={corHex} />
      <div className="mt-1 text-[10px] text-atlas-muted tabular-nums">
        Disponível: <span className={critical ? 'text-red-600 font-semibold' : 'font-semibold'}>{fmtMi(disp)}</span>
      </div>
    </div>
  );
}

export function BPEstruturaBancosPage() {
  const { data: bancos = [], isLoading } = useQuery({ queryKey: ['bp', 'bancos'], queryFn: fetchBancos });

  if (isLoading) return (
    <div className="p-6 space-y-5">
      <div className="h-8 w-64 bg-atlas-border rounded animate-pulse" />
      <div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-48 rounded-xl bg-atlas-border animate-pulse" />)}
      </div>
    </div>
  );

  return (
    <div className="p-6 max-w-[1440px] mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-heading font-bold">Breaking Point · Estrutura Bancária</h1>
        <p className="text-xs text-atlas-muted mt-1">
          Limites de crédito por banco — antecipação de recebíveis, FINIMP e cheque especial.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {bancos.map((b) => (
          <div
            key={b.id}
            className="bg-atlas-card border border-atlas-border rounded-xl p-5"
            style={{ borderLeftColor: b.cor_hex, borderLeftWidth: 4 }}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-bold" style={{ color: b.cor_hex }}>{b.banco_nome}</h2>
              {!b.ativo && (
                <span className="text-[10px] px-2 py-0.5 rounded bg-atlas-border text-atlas-muted uppercase">Inativo</span>
              )}
            </div>
            <div className="space-y-4">
              <LinhaLimite
                titulo="Antecipação"
                limite={b.antecip_limite}
                usado={b.antecip_usado}
                disp={b.antecip_disp}
                extra={`taxa ${(b.antecip_taxa * 100).toFixed(1)}%`}
                corHex={b.cor_hex}
              />
              <LinhaLimite
                titulo="FINIMP"
                limite={b.finimp_limite}
                usado={b.finimp_usado}
                disp={b.finimp_disp}
                extra={`garantia ${(b.finimp_garantia_pct * 100).toFixed(1)}%`}
                corHex={b.cor_hex}
              />
              <LinhaLimite
                titulo="Cheque Especial"
                limite={b.cheque_limite}
                usado={b.cheque_usado}
                disp={b.cheque_disp}
                corHex={b.cor_hex}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
