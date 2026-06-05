import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

type StatusDivergencia = 'aberta' | 'regularizada' | 'descartada';
type TipoDivergencia = 'faltando' | 'varredura' | 'cruzada' | 'fiscal_pendente';

interface Divergencia {
  id: string;
  tipo: TipoDivergencia;
  status: StatusDivergencia;
  quantidadeDeltaKg: number;
  valorUsd: number | null;
  observacoes: string | null;
  createdAt: string;
  regularizadaEm: string | null;
  produtoCodigoAcxe: number | null;
  produtoNome: string | null;
  produtoFamilia: string | null;
  produtoNcm: string | null;
  loteId: string | null;
  loteCodigo: string | null;
  loteCnpj: string | null;
  loteLocalidadeCodigo: string | null;
  loteLocalidadeNome: string | null;
  movimentacaoId: string;
  notaFiscal: string | null;
  subtipo: string | null;
  movimentacaoCreatedAt: string;
}

const TIPO_CFG: Record<TipoDivergencia, { label: string; descr: string; bg: string; text: string }> = {
  faltando: {
    label: 'Faltando',
    descr: 'NF dizia X kg, operador conferiu menos',
    bg: 'bg-red-50 dark:bg-red-900/20',
    text: 'text-red-700 dark:text-red-300',
  },
  varredura: {
    label: 'Varredura',
    descr: 'NF dizia X kg, operador conferiu mais',
    bg: 'bg-amber-50 dark:bg-amber-900/20',
    text: 'text-amber-700 dark:text-amber-300',
  },
  cruzada: {
    label: 'Cruzada',
    descr: 'NF emitida por uma empresa, físico está na outra',
    bg: 'bg-violet-50 dark:bg-violet-900/20',
    text: 'text-violet-700 dark:text-violet-300',
  },
  fiscal_pendente: {
    label: 'Fiscal pendente',
    descr: 'Saída manual sem NF (amostra/descarte/quebra) aguardando regularização',
    bg: 'bg-slate-100 dark:bg-slate-800',
    text: 'text-slate-700 dark:text-slate-300',
  },
};

const STATUS_CFG: Record<StatusDivergencia, { label: string; color: string }> = {
  aberta: { label: 'Aberta', color: 'text-red-700 dark:text-red-300' },
  regularizada: { label: 'Regularizada', color: 'text-green-700 dark:text-green-300' },
  descartada: { label: 'Descartada', color: 'text-slate-500 dark:text-slate-400' },
};

function fmtKg(n: number) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : n > 0 ? '+' : '';
  return `${sign}${abs.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;
}

function fmtData(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return iso;
  }
}

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

export function DivergenciasPage() {
  const apiFetch = useApiFetch();
  const [statusFilter, setStatusFilter] = useState<StatusDivergencia>('aberta');
  const [tipoFilter, setTipoFilter] = useState<'todos' | TipoDivergencia>('todos');
  const [cnpjFilter, setCnpjFilter] = useState<'ambos' | 'acxe' | 'q2p'>('ambos');

  const { data = [], isLoading, error } = useQuery<Divergencia[]>({
    queryKey: ['stockbridge', 'divergencias', statusFilter, tipoFilter, cnpjFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ status: statusFilter });
      if (tipoFilter !== 'todos') params.set('tipo', tipoFilter);
      if (cnpjFilter !== 'ambos') params.set('cnpj', cnpjFilter);
      const body = await apiFetch(`/api/v1/stockbridge/divergencias?${params}`);
      return body.data as Divergencia[];
    },
  });

  const totaisPorTipo = (Object.keys(TIPO_CFG) as TipoDivergencia[]).map((t) => ({
    tipo: t,
    count: data.filter((d) => d.tipo === t).length,
  }));

  return (
    <div className="p-6 max-w-7xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Divergências</h1>
        <p className="text-sm text-atlas-muted">
          Discrepâncias entre o que a NF previu e o que aconteceu fisicamente. Inclui faltas e sobras
          de recebimento, débitos cruzados ACXE↔Q2P e saídas manuais sem NF.
        </p>
      </div>

      <div className="flex items-center gap-3 mb-5 text-sm flex-wrap">
        <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded">
          {(['aberta', 'regularizada', 'descartada'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setStatusFilter(v)}
              className={`px-3 py-1 rounded text-xs font-medium transition ${statusFilter === v ? 'bg-white dark:bg-slate-900 shadow-sm text-atlas-ink' : 'text-atlas-muted'}`}
            >
              {STATUS_CFG[v].label}
            </button>
          ))}
        </div>

        <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded">
          {(['todos', 'faltando', 'varredura', 'cruzada', 'fiscal_pendente'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setTipoFilter(v)}
              className={`px-3 py-1 rounded text-xs font-medium transition ${tipoFilter === v ? 'bg-white dark:bg-slate-900 shadow-sm text-atlas-ink' : 'text-atlas-muted'}`}
            >
              {v === 'todos' ? 'Todos os tipos' : TIPO_CFG[v].label}
            </button>
          ))}
        </div>

        <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded">
          {(['ambos', 'acxe', 'q2p'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setCnpjFilter(v)}
              className={`px-3 py-1 rounded text-xs font-medium transition ${cnpjFilter === v ? 'bg-white dark:bg-slate-900 shadow-sm text-atlas-ink' : 'text-atlas-muted'}`}
            >
              {v === 'ambos' ? 'Ambos CNPJs' : v.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {data.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-5">
          {totaisPorTipo.map(({ tipo, count }) => {
            const cfg = TIPO_CFG[tipo];
            return (
              <div
                key={tipo}
                className={`border border-slate-200 dark:border-slate-700 rounded-lg p-3 ${cfg.bg}`}
              >
                <div className={`text-xs font-medium ${cfg.text}`}>{cfg.label}</div>
                <div className="font-serif text-xl text-atlas-ink mt-1">{count}</div>
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          {(error as Error).message}
        </div>
      )}

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando...</div>}

      {!isLoading && data.length === 0 && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-slate-300 dark:border-slate-700 rounded-lg">
          Nenhuma divergência {STATUS_CFG[statusFilter].label.toLowerCase()} encontrada para este filtro.
        </div>
      )}

      {data.length > 0 && (
        <div className="overflow-x-auto border border-slate-200 dark:border-slate-700 rounded-lg">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase text-atlas-muted">
              <tr>
                <th className="text-left px-3 py-2">Tipo</th>
                <th className="text-left px-3 py-2">Produto</th>
                <th className="text-right px-3 py-2">Δ kg</th>
                <th className="text-left px-3 py-2">CNPJ / Galpão</th>
                <th className="text-left px-3 py-2">NF</th>
                <th className="text-left px-3 py-2">Data</th>
                <th className="text-left px-3 py-2">Observação</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => {
                const cfg = TIPO_CFG[d.tipo];
                return (
                  <tr
                    key={d.id}
                    className="border-t border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/30"
                  >
                    <td className="px-3 py-2">
                      <span
                        className={`text-xs font-semibold px-2 py-0.5 rounded ${cfg.bg} ${cfg.text}`}
                        title={cfg.descr}
                      >
                        {cfg.label}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-atlas-ink">{d.produtoNome ?? '—'}</div>
                      <div className="text-[11px] text-atlas-muted">
                        {d.produtoFamilia ?? '—'}
                        {d.produtoCodigoAcxe ? ` · cod ${d.produtoCodigoAcxe}` : ''}
                      </div>
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${d.quantidadeDeltaKg < 0 ? 'text-red-700' : d.quantidadeDeltaKg > 0 ? 'text-amber-700' : 'text-atlas-ink'}`}>
                      {fmtKg(d.quantidadeDeltaKg)} kg
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-atlas-ink uppercase">{d.loteCnpj ?? '—'}</div>
                      <div className="text-[11px] text-atlas-muted">
                        {d.loteLocalidadeCodigo ? `Galpão ${d.loteLocalidadeCodigo}` : '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {d.notaFiscal ?? '—'}
                      {d.subtipo && (
                        <div className="text-[10px] text-atlas-muted normal-case">{d.subtipo}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {fmtData(d.createdAt)}
                      {d.status === 'regularizada' && d.regularizadaEm && (
                        <div className="text-[10px] text-green-700 dark:text-green-300">
                          reg {fmtData(d.regularizadaEm)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-atlas-muted max-w-[280px] truncate" title={d.observacoes ?? undefined}>
                      {d.observacoes ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
