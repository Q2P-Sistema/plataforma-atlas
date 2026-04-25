import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';
import { AvancarEstagioModal } from './AvancarEstagioModal.js';

type EstagioTransito = 'transito_intl' | 'porto_dta' | 'transito_interno' | 'reservado';

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
  atrasado: boolean;
}

type TransitoData = Record<EstagioTransito, LoteTransito[]>;

const COLUNAS: Array<{ key: EstagioTransito; label: string; subtitle: string; accent: string }> = [
  { key: 'transito_intl',     label: 'Trânsito Internacional', subtitle: 'Mar · sem DI',           accent: 'border-violet-300 bg-violet-50/50 dark:bg-violet-900/10' },
  { key: 'porto_dta',         label: 'Porto / DTA',            subtitle: 'DI emitida · desembaraço', accent: 'border-orange-300 bg-orange-50/50 dark:bg-orange-900/10' },
  { key: 'transito_interno',  label: 'Trânsito Interno',       subtitle: 'NF emitida · a caminho', accent: 'border-teal-300 bg-teal-50/50 dark:bg-teal-900/10' },
  { key: 'reservado',         label: 'Reservado',              subtitle: 'Reserva operacional',     accent: 'border-blue-300 bg-blue-50/50 dark:bg-blue-900/10' },
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

export function TransitoPage() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [avancando, setAvancando] = useState<LoteTransito | null>(null);

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
          Importações em andamento, agrupadas por estágio. Operador vê apenas trânsito interno e reservado.
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 rounded text-sm text-red-800 dark:text-red-300">
          {(error as Error).message}
        </div>
      )}

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando...</div>}

      {data && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          {COLUNAS.map((col) => {
            const lotes = data[col.key] ?? [];
            return (
              <div key={col.key} className={`rounded-lg border ${col.accent} p-3`}>
                <div className="mb-3 px-1">
                  <div className="font-serif text-sm text-atlas-ink">{col.label}</div>
                  <div className="text-[10px] text-atlas-muted">{col.subtitle} · {lotes.length} lote{lotes.length !== 1 ? 's' : ''}</div>
                </div>

                <div className="flex flex-col gap-2">
                  {lotes.length === 0 && (
                    <div className="text-xs text-atlas-muted italic px-2 py-4 text-center">vazio</div>
                  )}
                  {lotes.map((l) => (
                    <div
                      key={l.id}
                      className={`bg-white dark:bg-slate-800 border rounded p-2.5 text-xs space-y-1 ${l.atrasado ? 'border-red-400 ring-1 ring-red-200 dark:ring-red-800' : 'border-slate-200 dark:border-slate-700'}`}
                    >
                      <div className="flex justify-between">
                        <span className="font-mono text-[10px] text-atlas-muted">{l.codigo}</span>
                        {l.atrasado && <span className="text-[10px] font-semibold text-red-700 dark:text-red-400">⚠ atrasado</span>}
                      </div>
                      <div className="font-medium text-atlas-ink truncate">{l.fornecedorNome}</div>
                      <div className="text-[10px] text-atlas-muted">
                        {l.paisOrigem && `${l.paisOrigem} · `}
                        {l.quantidadeFiscalKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg
                        {l.custoBrlKg != null && ` · R$ ${l.custoBrlKg.toFixed(2)}/kg`}
                      </div>
                      {col.key === 'porto_dta' && (
                        <div className="text-[10px] text-orange-700 dark:text-orange-300">
                          DI {l.di ?? '?'} · DTA {l.dta ?? '?'}
                        </div>
                      )}
                      {col.key === 'transito_interno' && l.notaFiscal && (
                        <div className="text-[10px] text-teal-700 dark:text-teal-300">NF {l.notaFiscal}</div>
                      )}
                      {l.dtPrevChegada && (
                        <div className="text-[10px] text-atlas-muted">Prev: {l.dtPrevChegada}</div>
                      )}
                      {col.key !== 'transito_interno' && col.key !== 'reservado' && (
                        <button
                          onClick={() => setAvancando(l)}
                          className="w-full mt-1 px-2 py-1 bg-atlas-btn-bg text-atlas-btn-text rounded text-[11px] font-medium hover:opacity-90"
                        >
                          Avançar →
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {avancando && (
        <AvancarEstagioModal
          lote={avancando}
          onClose={() => setAvancando(null)}
          onSucesso={() => {
            setAvancando(null);
            queryClient.invalidateQueries({ queryKey: ['stockbridge', 'transito'] });
          }}
        />
      )}
    </div>
  );
}
