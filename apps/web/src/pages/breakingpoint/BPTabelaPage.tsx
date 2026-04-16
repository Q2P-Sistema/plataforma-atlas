import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

interface SemanaProjetada {
  semana: number;
  label: string;
  data_fmt: string;
  pagamento: number;
  tipo: string;
  is_finimp: boolean;
  rec_dup: number;
  rec_estoque: number;
  saldo_cc: number;
  antecip_disp: number;
  finimp_disp: number;
  finimp_saldo: number;
  dup_bloq: number;
  cap_compra: number;
  gap: number;
  status_gap: 'critico' | 'alerta' | 'ok';
}

interface Projecao {
  semanas: SemanaProjetada[];
}

async function fetchProjecao(): Promise<Projecao> {
  const r = await fetch('/api/v1/bp/projecao?empresa=acxe', { credentials: 'include' });
  const j = await r.json();
  return j.data;
}

const fmtMi = (v: number) => {
  if (v === 0) return 'R$ 0';
  const mi = v / 1_000_000;
  const sign = v < 0 ? '− ' : '';
  return `${sign}R$ ${Math.abs(mi).toFixed(2).replace('.', ',')}Mi`;
};

function StatusBadge({ status }: { status: 'critico' | 'alerta' | 'ok' }) {
  if (status === 'critico') {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded bg-red-500/15 text-red-700 border border-red-500/40 font-bold uppercase">
        ⛔ CRISE
      </span>
    );
  }
  if (status === 'alerta') {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-700 border border-amber-500/40 font-bold uppercase">
        ⚠ ALERTA
      </span>
    );
  }
  return (
    <span className="text-[10px] px-2 py-0.5 rounded bg-green-500/15 text-green-700 border border-green-500/40 font-semibold uppercase">
      ✓ OK
    </span>
  );
}

function TipoBadge({ tipo, isFinimp }: { tipo: string; isFinimp: boolean }) {
  const color = isFinimp
    ? 'bg-orange-500/15 text-orange-700'
    : tipo === 'Fornecedor'
      ? 'bg-blue-500/15 text-blue-700'
      : 'bg-gray-500/15 text-gray-700';
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${color}`}>
      {tipo || '—'}
    </span>
  );
}

export function BPTabelaPage() {
  const [showAll, setShowAll] = useState(false);
  const { data: proj, isLoading } = useQuery({
    queryKey: ['bp', 'projecao', 'acxe'],
    queryFn: fetchProjecao,
    staleTime: 60_000,
  });

  if (isLoading || !proj) return (
    <div className="p-6 space-y-5">
      <div className="h-8 w-64 bg-atlas-border rounded animate-pulse" />
      <div className="h-64 rounded-xl bg-atlas-border animate-pulse" />
    </div>
  );

  const semanas = showAll ? proj.semanas : proj.semanas.filter((s) => s.status_gap !== 'ok');

  return (
    <div className="p-6 max-w-[1440px] mx-auto">
      <div className="flex justify-between items-start mb-5">
        <div>
          <h1 className="text-2xl font-heading font-bold">Breaking Point · Tabela Semanal</h1>
          <p className="text-xs text-atlas-muted mt-1">
            Visão detalhada das 26 semanas. Filtro padrão: apenas semanas em CRISE ou ALERTA.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Ver todas as 26 semanas
        </label>
      </div>

      <div className="bg-atlas-card border border-atlas-border rounded-xl overflow-hidden">
        {semanas.length === 0 ? (
          <p className="p-6 text-center text-atlas-muted text-sm">
            Nenhuma semana em CRISE ou ALERTA. ✅
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-atlas-bg">
              <tr className="text-left">
                {['Sem.', 'Data', 'Tipo', 'Pagamento', 'Saldo CC', 'Cap. Antecip', 'Cap. Compras', 'FINIMP', 'Dup. Bloq.', 'Gap', 'Status'].map((h) => (
                  <th key={h} className="px-3 py-2 text-[10px] uppercase tracking-wider text-atlas-muted font-semibold whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {semanas.map((s) => {
                const gapColor = s.gap < 0 ? 'text-red-600' : s.gap < 300_000 ? 'text-amber-600' : 'text-green-600';
                return (
                  <tr key={s.semana} className="border-t border-atlas-border/50 tabular-nums hover:bg-atlas-bg/50">
                    <td className="px-3 py-2 font-bold">{s.label}</td>
                    <td className="px-3 py-2 text-atlas-muted whitespace-nowrap">{s.data_fmt}</td>
                    <td className="px-3 py-2"><TipoBadge tipo={s.tipo} isFinimp={s.is_finimp} /></td>
                    <td className={`px-3 py-2 font-semibold ${s.is_finimp ? 'text-orange-600' : 'text-red-600'}`}>
                      {fmtMi(s.pagamento)}
                    </td>
                    <td className={`px-3 py-2 font-semibold ${s.saldo_cc < 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {fmtMi(s.saldo_cc)}
                    </td>
                    <td className={`px-3 py-2 font-semibold ${s.antecip_disp < 200_000 ? 'text-red-600' : 'text-amber-600'}`}>
                      {fmtMi(s.antecip_disp)}
                    </td>
                    <td className="px-3 py-2 font-semibold text-pink-600">{fmtMi(s.cap_compra)}</td>
                    <td className="px-3 py-2 font-semibold text-purple-600">{fmtMi(s.finimp_saldo)}</td>
                    <td className="px-3 py-2 text-atlas-muted">{fmtMi(s.dup_bloq)}</td>
                    <td className={`px-3 py-2 font-bold ${gapColor}`}>{fmtMi(s.gap)}</td>
                    <td className="px-3 py-2"><StatusBadge status={s.status_gap} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
