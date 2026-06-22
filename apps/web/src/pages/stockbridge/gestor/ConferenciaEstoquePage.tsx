import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

type TipoLocal = 'ESPELHADO' | 'INDIVIDUAL';
type StatusGeral = 'Divergente e Negativo' | 'Divergente' | 'Negativo' | 'OK';
type StatusSaldoNegativo = 'ACXE e Q2P negativos' | 'ACXE negativo' | 'Q2P negativo' | 'OK';

interface ConferenciaItem {
  codigoEstoque: string;
  nomeEstoque: string;
  tipoEstoque: TipoLocal;
  produto: string;
  saldoAcxeKg: number;
  saldoQ2pKg: number;
  diferencaKg: number;
  statusSaldoNegativo: StatusSaldoNegativo;
  statusGeral: StatusGeral;
}

interface ConferenciaResumo {
  totalSkusDivergentes: number;
  totalProblemas: number;
  totalQuebrasNegativas: number;
  somaDiferencaKg: number;
  dataPosicaoAcxe: string | null;
  dataPosicaoQ2p: string | null;
  defasagemEntreEmpresas: boolean;
}

interface ConferenciaResponse {
  resumo: ConferenciaResumo;
  itens: ConferenciaItem[];
}

type FiltroStatus = 'problemas' | 'divergente' | 'negativo' | 'todos';

// Cor da linha por severidade do Status Geral (FR-013).
const LINHA_CFG: Record<StatusGeral, string> = {
  'Divergente e Negativo': 'bg-red-50 dark:bg-red-900/20',
  Divergente: 'bg-amber-50 dark:bg-amber-900/20',
  Negativo: 'bg-orange-50 dark:bg-orange-900/20',
  OK: '',
};

const STATUS_BADGE: Record<StatusGeral, string> = {
  'Divergente e Negativo': 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  Divergente: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  Negativo: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  OK: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};

/** kg com separador de milhar, sem decimais; sinal explícito p/ diferença. */
function fmtKg(n: number, comSinal = false): string {
  const abs = Math.abs(n).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  if (comSinal) return `${n < 0 ? '−' : n > 0 ? '+' : ''}${abs}`;
  return n < 0 ? `−${abs}` : abs;
}

function fmtData(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
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

function ResumoCard({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 min-w-[160px]">
      <div className="text-xs uppercase tracking-wide text-atlas-muted font-medium mb-0.5">{label}</div>
      <div className={`font-serif text-lg ${tone}`}>{value}</div>
    </div>
  );
}

export function ConferenciaEstoquePage() {
  const apiFetch = useApiFetch();
  const [statusFilter, setStatusFilter] = useState<FiltroStatus>('problemas');
  const [tipoFilter, setTipoFilter] = useState<'todos' | TipoLocal>('todos');
  const [busca, setBusca] = useState('');

  // Carrega o universo completo (resumo + itens) e filtra no cliente — chips
  // instantâneos, sem refetch. O `resumo` reflete sempre a posição inteira.
  const { data, isLoading, error } = useQuery<ConferenciaResponse>({
    queryKey: ['stockbridge', 'conferencia'],
    queryFn: async () => {
      const body = await apiFetch('/api/v1/stockbridge/conferencia');
      return body.data as ConferenciaResponse;
    },
  });

  const itens = data?.itens ?? [];
  const resumo = data?.resumo;

  const filtrados = useMemo(() => {
    const q = busca.trim().toUpperCase();
    return itens.filter((i) => {
      if (statusFilter === 'problemas' && i.statusGeral === 'OK') return false;
      if (
        statusFilter === 'divergente' &&
        i.statusGeral !== 'Divergente' &&
        i.statusGeral !== 'Divergente e Negativo'
      )
        return false;
      if (statusFilter === 'negativo' && i.statusSaldoNegativo === 'OK') return false;
      if (tipoFilter !== 'todos' && i.tipoEstoque !== tipoFilter) return false;
      if (q && !i.produto.includes(q) && !i.nomeEstoque.toUpperCase().includes(q)) return false;
      return true;
    });
  }, [itens, statusFilter, tipoFilter, busca]);

  return (
    <div className="p-6 max-w-7xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Conferência de Estoque</h1>
        <p className="text-sm text-atlas-muted">
          Comparativo da posição física <strong>ACXE × Q2P</strong> por local e produto. Substitui a
          planilha de conferência: os itens com divergência ou saldo negativo aparecem no topo.
        </p>
      </div>

      {/* Frescor dos dados (US4 / FR-015) */}
      {resumo && (
        <div className="mb-4 text-xs text-atlas-muted flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            Posição ACXE: <strong className="text-atlas-ink">{fmtData(resumo.dataPosicaoAcxe)}</strong>
          </span>
          <span>
            Posição Q2P: <strong className="text-atlas-ink">{fmtData(resumo.dataPosicaoQ2p)}</strong>
          </span>
          {resumo.defasagemEntreEmpresas && (
            <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 font-medium">
              ⚠ Datas de posição defasadas entre ACXE e Q2P
            </span>
          )}
        </div>
      )}

      {/* KPI cards (US3 / FR-014) — sempre sobre o universo completo */}
      {resumo && (
        <div className="mb-5 flex flex-wrap gap-3">
          <ResumoCard label="Problemas" value={String(resumo.totalProblemas)} tone="text-red-700 dark:text-red-300" />
          <ResumoCard label="SKUs divergentes" value={String(resumo.totalSkusDivergentes)} tone="text-amber-700 dark:text-amber-300" />
          <ResumoCard label="Quebras (negativos)" value={String(resumo.totalQuebrasNegativas)} tone="text-orange-700 dark:text-orange-300" />
          <ResumoCard label="Soma da diferença (kg)" value={fmtKg(resumo.somaDiferencaKg, true)} tone="text-atlas-ink" />
        </div>
      )}

      {/* Filtros (US3 / FR-012) */}
      <div className="flex items-center gap-3 mb-5 text-sm flex-wrap">
        <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded">
          {(
            [
              ['problemas', 'Problemas'],
              ['divergente', 'Divergentes'],
              ['negativo', 'Negativos'],
              ['todos', 'Todos'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setStatusFilter(v)}
              className={`px-3 py-1 rounded text-xs font-medium transition ${statusFilter === v ? 'bg-white dark:bg-slate-900 shadow-sm text-atlas-ink' : 'text-atlas-muted'}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded">
          {(['todos', 'ESPELHADO', 'INDIVIDUAL'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setTipoFilter(v)}
              className={`px-3 py-1 rounded text-xs font-medium transition ${tipoFilter === v ? 'bg-white dark:bg-slate-900 shadow-sm text-atlas-ink' : 'text-atlas-muted'}`}
            >
              {v === 'todos' ? 'Todos os tipos' : v === 'ESPELHADO' ? 'Espelhado' : 'Individual'}
            </button>
          ))}
        </div>

        <input
          type="text"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar produto ou local…"
          className="px-3 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-atlas-ink placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500/40 w-56"
        />
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          {(error as Error).message}
        </div>
      )}

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando posição...</div>}

      {!isLoading && !error && filtrados.length === 0 && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-slate-300 dark:border-slate-700 rounded-lg">
          Nenhum item para este filtro.
        </div>
      )}

      {filtrados.length > 0 && (
        <>
          <div className="mb-2 text-xs text-atlas-muted">
            {filtrados.length.toLocaleString('pt-BR')} de {itens.length.toLocaleString('pt-BR')} linhas
          </div>
          <div className="overflow-x-auto border border-slate-200 dark:border-slate-700 rounded-lg">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase text-atlas-muted">
                <tr>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-left px-3 py-2">Local</th>
                  <th className="text-left px-3 py-2">Tipo</th>
                  <th className="text-left px-3 py-2">Produto</th>
                  <th className="text-right px-3 py-2">Saldo ACXE (kg)</th>
                  <th className="text-right px-3 py-2">Saldo Q2P (kg)</th>
                  <th className="text-right px-3 py-2">Diferença (kg)</th>
                  <th className="text-left px-3 py-2">Saldo negativo</th>
                </tr>
              </thead>
              <tbody>
                {filtrados.map((i, idx) => (
                  <tr
                    key={`${i.codigoEstoque}|${i.produto}|${idx}`}
                    className={`border-t border-slate-200 dark:border-slate-700 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/30 ${LINHA_CFG[i.statusGeral]}`}
                  >
                    <td className="px-3 py-2">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded whitespace-nowrap ${STATUS_BADGE[i.statusGeral]}`}>
                        {i.statusGeral}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-atlas-ink">{i.nomeEstoque}</div>
                      <div className="text-[11px] text-atlas-muted font-mono">{i.codigoEstoque}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-atlas-muted">{i.tipoEstoque === 'ESPELHADO' ? 'Espelhado' : 'Individual'}</td>
                    <td className="px-3 py-2 text-atlas-ink">{i.produto}</td>
                    <td className={`px-3 py-2 text-right font-mono ${i.saldoAcxeKg < 0 ? 'text-red-700 dark:text-red-300' : 'text-atlas-ink'}`}>
                      {fmtKg(i.saldoAcxeKg)}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${i.saldoQ2pKg < 0 ? 'text-red-700 dark:text-red-300' : 'text-atlas-ink'}`}>
                      {fmtKg(i.saldoQ2pKg)}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${i.diferencaKg !== 0 ? 'text-amber-700 dark:text-amber-300 font-semibold' : 'text-atlas-muted'}`}>
                      {fmtKg(i.diferencaKg, true)}
                    </td>
                    <td className="px-3 py-2 text-xs text-atlas-muted">
                      {i.statusSaldoNegativo === 'OK' ? '—' : i.statusSaldoNegativo}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
