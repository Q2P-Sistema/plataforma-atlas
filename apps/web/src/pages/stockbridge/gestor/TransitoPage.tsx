import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

type EstagioTransito = 'transito_intl' | 'porto_dta' | 'transito_interno';

interface LoteTransito {
  id: string;
  codigo: string;
  produtoCodigoAcxe: number;
  fornecedorNome: string;
  paisOrigem: string | null;
  quantidadeFisicaKg: number;
  quantidadeFiscalKg: number;
  custoBrlKg: number | null;
  cnpj: string;
  estagioTransito: EstagioTransito;
  localidadeCodigo: string | null;
  di: string | null;
  dta: string | null;
  notaFiscal: string | null;
  dtPrevChegada: string | null;

  pedidoComprasAcxe: string | null;
  protocoloDi: string | null;
  despachante: string | null;
  terminalAtracacao: string | null;
  numeroBl: string | null;
  dataBl: string | null;
  etd: string | null;
  eta: string | null;
  dataDesembarque: string | null;
  dataLiberacaoTransporte: string | null;
  dataEntradaArmazem: string | null;
  freeTime: number | null;
  etapaFup: string | null;
}

// 'reservado' segue no payload mas e ignorado pelo frontend (sem coluna correspondente)
type TransitoData = Record<EstagioTransito, LoteTransito[]> & { reservado?: LoteTransito[] };

const COLUNAS: Array<{ key: EstagioTransito; label: string; subtitle: string; accent: string }> = [
  { key: 'transito_intl',    label: 'Trânsito Internacional', subtitle: 'Em águas',                accent: 'border-violet-300 bg-violet-50/50 dark:bg-violet-900/10' },
  { key: 'porto_dta',        label: 'Porto / DTA',            subtitle: 'Nacionalização',          accent: 'border-orange-300 bg-orange-50/50 dark:bg-orange-900/10' },
  { key: 'transito_interno', label: 'Trânsito Interno',       subtitle: 'Aguardando recebimento',  accent: 'border-teal-300 bg-teal-50/50 dark:bg-teal-900/10' },
];

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers as Record<string, string>) };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    const body = (await res.json()) as { data: unknown; error: { message?: string } | null };
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body;
  };
}

function fmtDate(d: string | null): string | null {
  if (!d) return null;
  const [y, m, day] = d.slice(0, 10).split('-');
  if (!y || !m || !day) return d;
  return `${day}/${m}/${y.slice(2)}`;
}

const HOJE = new Date().toISOString().slice(0, 10);

/**
 * Data limite por estagio:
 * - Transito Internacional: ETA (chegada no porto)
 * - Porto/DTA: data prevista de entrada no armazem
 * - Transito Interno: data prevista de entrada no armazem
 *
 * Atrasado = data limite < hoje
 */
function getDataLimite(l: LoteTransito): { label: string; valor: string | null } {
  switch (l.estagioTransito) {
    case 'transito_intl':
      return { label: 'ETA', valor: l.eta };
    case 'porto_dta':
    case 'transito_interno':
      return { label: 'Armaz', valor: l.dataEntradaArmazem };
  }
}

function isAtrasado(l: LoteTransito): boolean {
  const { valor } = getDataLimite(l);
  return valor != null && valor.slice(0, 10) < HOJE;
}

function fmtToneladas(kg: number): string {
  return (kg / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

export function TransitoPage() {
  const apiFetch = useApiFetch();

  const { data, isLoading, error } = useQuery<TransitoData>({
    queryKey: ['stockbridge', 'transito'],
    queryFn: async () => {
      const body = await apiFetch('/api/v1/stockbridge/transito');
      return body.data as TransitoData;
    },
  });

  return (
    <div className="p-6 max-w-full">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Pipeline de Trânsito</h1>
        <p className="text-sm text-atlas-muted">
          Importações em andamento, dados sincronizados da planilha FUP de Comex.
          Apenas visualização — alterações são feitas direto na FUP.
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 rounded text-sm text-red-800 dark:text-red-300">
          {(error as Error).message}
        </div>
      )}

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando...</div>}

      {data && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {COLUNAS.map((col) => {
            const lotes = data[col.key] ?? [];
            const totalKg = lotes.reduce((acc, l) => acc + l.quantidadeFiscalKg, 0);
            const pedidosUnicos = new Set(
              lotes.map((l) => l.pedidoComprasAcxe ?? l.codigo),
            ).size;

            return (
              <div key={col.key} className={`rounded-lg border ${col.accent} p-3`}>
                <div className="mb-3 px-1">
                  <div className="font-serif text-sm text-atlas-ink">{col.label}</div>
                  <div className="text-[10px] text-atlas-muted">{col.subtitle}</div>
                  <div className="text-[11px] text-atlas-ink mt-0.5">
                    <strong>{fmtToneladas(totalKg)} t</strong>
                    {' · '}
                    {pedidosUnicos} pedido{pedidosUnicos !== 1 ? 's' : ''}
                    {' · '}
                    {lotes.length} lote{lotes.length !== 1 ? 's' : ''}
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  {lotes.length === 0 && (
                    <div className="text-xs text-atlas-muted italic px-2 py-4 text-center">vazio</div>
                  )}
                  {lotes.map((l) => {
                    const atrasado = isAtrasado(l);
                    const limite = getDataLimite(l);
                    return (
                      <div
                        key={l.id}
                        className={`bg-white dark:bg-slate-800 border rounded p-2.5 text-xs space-y-1 ${atrasado ? 'border-red-400 ring-1 ring-red-200 dark:ring-red-800' : 'border-slate-200 dark:border-slate-700'}`}
                      >
                        <div className="flex justify-between items-center">
                          <span className="font-mono text-xs font-semibold text-atlas-ink">
                            {l.pedidoComprasAcxe ? `PC ${l.pedidoComprasAcxe}` : l.codigo}
                          </span>
                          {atrasado && <span className="text-[10px] font-semibold text-red-700 dark:text-red-400">⚠ atrasado</span>}
                        </div>

                        <div className="font-medium text-atlas-ink truncate" title={l.fornecedorNome}>{l.fornecedorNome}</div>

                        <div className="text-[10px] text-atlas-muted">
                          {l.paisOrigem && `${l.paisOrigem} · `}
                          {l.quantidadeFiscalKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg
                          {l.custoBrlKg != null && ` · R$ ${l.custoBrlKg.toFixed(2)}/kg`}
                        </div>

                        {l.etapaFup && (
                          <div className="text-[10px] text-atlas-muted italic" title="Etapa atual no FUP">
                            {l.etapaFup}
                          </div>
                        )}

                        {(l.di || l.protocoloDi) && (
                          <div className="text-[10px] text-orange-700 dark:text-orange-300 leading-snug">
                            {l.di && <>DI {l.di}</>}
                            {l.di && l.protocoloDi && ' · '}
                            {l.protocoloDi && <>Prot {l.protocoloDi}</>}
                          </div>
                        )}

                        {(l.terminalAtracacao || l.despachante) && (
                          <div className="text-[10px] text-atlas-muted leading-snug">
                            {l.terminalAtracacao && <>{l.terminalAtracacao}</>}
                            {l.terminalAtracacao && l.despachante && ' · '}
                            {l.despachante && <>{l.despachante}</>}
                          </div>
                        )}

                        <div className="text-[10px] text-atlas-muted leading-snug grid grid-cols-2 gap-x-2 pt-1 border-t border-slate-100 dark:border-slate-700/40">
                          {l.etd && <span>ETD {fmtDate(l.etd)}</span>}
                          {l.eta && <span>ETA {fmtDate(l.eta)}</span>}
                          {l.dataDesembarque && <span>Desemb {fmtDate(l.dataDesembarque)}</span>}
                          {l.dataLiberacaoTransporte && <span>Liber {fmtDate(l.dataLiberacaoTransporte)}</span>}
                          {l.dataEntradaArmazem && <span>Armaz {fmtDate(l.dataEntradaArmazem)}</span>}
                          {l.freeTime != null && <span>Free time {l.freeTime}d</span>}
                        </div>

                        {limite.valor && (
                          <div className={`text-[10px] font-semibold pt-1 ${atrasado ? 'text-red-700 dark:text-red-400' : 'text-atlas-ink'}`}>
                            Limite: {limite.label} {fmtDate(limite.valor)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
