import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ChevronDown, AlertTriangle } from 'lucide-react';
import { useAuthStore } from '../../../stores/auth.store.js';
import { ESTAGIO_FUP_LABEL, rotulo } from '../labels.js';

type StatusPendencia = 'recebida' | 'parcial' | 'pendente';
type FonteRecebimento = 'omie' | 'movimentacao' | 'movimentacao_legado' | null;

interface FilhoteItem {
  nfFilhote: string;
  posicao: number;
  qtdeKg: number;
  recebida: boolean;
  fonteRecebimento: FonteRecebimento;
  nfEmitida: boolean;
  diasDesdeEmissao: number | null;
}

interface PedidoPendencia {
  pedidoAcxeOmie: string;
  nfMae: string;
  qtdePedidoKg: number;
  recebidoKg: number;
  saldoPendenteKg: number;
  statusAgregado: StatusPendencia;
  exoneracaoDataEntrada: string | null;
  diasEmExoneracao: number | null;
  estagioFup: string | null;
  loteEmTransito: boolean;
  inconsistencia: boolean;
  filhotes: FilhoteItem[];
}

interface ImportacaoSemMapa {
  notaFiscal: string;
  produtoCodigoAcxe: number | null;
  produtoNome: string | null;
  qtdeKg: number;
  cfop: string | null;
  dataEmissao: string | null;
  emMetricas: boolean;
}

interface PendenciasFiscaisData {
  pedidos: PedidoPendencia[];
  semMapa: ImportacaoSemMapa[];
  resumo: {
    totalPedidos: number;
    totalSaldoPendenteKg: number;
    totalInconsistencias: number;
    totalSemMapaKg: number;
  };
}

const STATUS_CFG: Record<StatusPendencia, { label: string; bg: string; text: string }> = {
  recebida: { label: 'Recebida', bg: 'bg-green-50 dark:bg-green-900/20', text: 'text-green-700 dark:text-green-300' },
  parcial: { label: 'Parcial', bg: 'bg-amber-50 dark:bg-amber-900/20', text: 'text-amber-700 dark:text-amber-300' },
  pendente: { label: 'Pendente', bg: 'bg-red-50 dark:bg-red-900/20', text: 'text-red-700 dark:text-red-300' },
};

const FONTE_LABEL: Record<Exclude<FonteRecebimento, null>, string> = {
  omie: 'OMIE',
  movimentacao: 'Atlas',
  movimentacao_legado: 'Legado',
};

function fmtKg(n: number) {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

function fmtData(iso: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return iso;
  }
}

// Faixas de aging (FR-021 / T042) — limites PROVISÓRIOS em dias. O número de dias é sempre
// exibido (o gestor julga); as faixas são só realce visual. Calibrar com a equipe de comex
// (SLA real de transporte) ou vincular ao config_produto.lead_time_dias no futuro.
const AGING_ATENCAO_DIAS = 30;
const AGING_CRITICO_DIAS = 60;

function agingClass(dias: number | null) {
  if (dias == null) return 'text-atlas-muted';
  if (dias > AGING_CRITICO_DIAS) return 'text-red-700 dark:text-red-300';
  if (dias > AGING_ATENCAO_DIAS) return 'text-amber-700 dark:text-amber-300';
  return 'text-green-700 dark:text-green-300';
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

export function PendenciasFiscaisPage() {
  const apiFetch = useApiFetch();
  const [statusFilter, setStatusFilter] = useState<StatusPendencia | 'todas'>('pendente');
  const [incluirMetricas, setIncluirMetricas] = useState(false);
  const [expandidos, setExpandidos] = useState<Set<string>>(new Set());

  const { data, isLoading, error } = useQuery<PendenciasFiscaisData>({
    queryKey: ['stockbridge', 'pendencias-fiscais', statusFilter, incluirMetricas],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'todas') params.set('status', statusFilter);
      if (incluirMetricas) params.set('incluir_metricas', 'true');
      const body = await apiFetch(`/api/v1/stockbridge/pendencias-fiscais?${params}`);
      return body.data as PendenciasFiscaisData;
    },
  });

  const pedidos = data?.pedidos ?? [];
  const semMapa = data?.semMapa ?? [];
  const resumo = data?.resumo;

  function toggle(pedido: string) {
    setExpandidos((prev) => {
      const next = new Set(prev);
      if (next.has(pedido)) next.delete(pedido);
      else next.add(pedido);
      return next;
    });
  }

  return (
    <div className="p-6 max-w-7xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Pendências Fiscais</h1>
        <p className="text-sm text-atlas-muted">
          Importações com NF emitida e recebimento ainda não confirmado. Detalha, por pedido, o que já foi
          recebido (e por qual fonte) e o que falta — com o tempo em exoneração e o aging das filhotes,
          para distinguir atraso normal de recebimento não lançado ou container extraviado.
        </p>
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-3 mb-5 text-sm flex-wrap">
        <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded">
          {(['pendente', 'parcial', 'recebida', 'todas'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setStatusFilter(v)}
              className={`px-3 py-1 rounded text-xs font-medium transition ${statusFilter === v ? 'bg-white dark:bg-slate-900 shadow-sm text-atlas-ink' : 'text-atlas-muted'}`}
            >
              {v === 'todas' ? 'Todas' : STATUS_CFG[v].label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-atlas-muted cursor-pointer">
          <input
            type="checkbox"
            checked={incluirMetricas}
            onChange={(e) => setIncluirMetricas(e.target.checked)}
            className="rounded border-slate-300 dark:border-slate-600"
          />
          Incluir produtos fora de métrica
        </label>
      </div>

      {/* Resumo */}
      {resumo && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-5">
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-3">
            <div className="text-xs font-medium text-atlas-muted">Pedidos</div>
            <div className="font-serif text-xl text-atlas-ink mt-1">{resumo.totalPedidos}</div>
          </div>
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-3">
            <div className="text-xs font-medium text-atlas-muted">Saldo pendente</div>
            <div className="font-serif text-xl text-atlas-ink mt-1">{fmtKg(resumo.totalSaldoPendenteKg)} kg</div>
          </div>
          <div className={`border rounded-lg p-3 ${resumo.totalInconsistencias > 0 ? 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20' : 'border-slate-200 dark:border-slate-700'}`}>
            <div className="text-xs font-medium text-red-700 dark:text-red-300 flex items-center gap-1">
              {resumo.totalInconsistencias > 0 && <AlertTriangle size={12} />} Inconsistências
            </div>
            <div className="font-serif text-xl text-atlas-ink mt-1">{resumo.totalInconsistencias}</div>
          </div>
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-3">
            <div className="text-xs font-medium text-atlas-muted">Sem mapa</div>
            <div className="font-serif text-xl text-atlas-ink mt-1">{fmtKg(resumo.totalSemMapaKg)} kg</div>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          {(error as Error).message}
        </div>
      )}

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando...</div>}

      {/* Pedidos com mapa */}
      {!isLoading && pedidos.length === 0 && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-slate-300 dark:border-slate-700 rounded-lg">
          Nenhum pedido neste filtro.
        </div>
      )}

      {pedidos.length > 0 && (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-200 dark:divide-slate-700 overflow-hidden">
          {pedidos.map((p) => {
            const cfg = STATUS_CFG[p.statusAgregado];
            const aberto = expandidos.has(p.pedidoAcxeOmie);
            return (
              <div key={p.pedidoAcxeOmie}>
                <button
                  onClick={() => toggle(p.pedidoAcxeOmie)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/30"
                >
                  {aberto ? <ChevronDown size={15} className="text-atlas-muted shrink-0" /> : <ChevronRight size={15} className="text-atlas-muted shrink-0" />}
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded ${cfg.bg} ${cfg.text} shrink-0`}>{cfg.label}</span>
                  <div className="shrink-0">
                    <span className="text-atlas-ink font-medium">Pedido {p.pedidoAcxeOmie}</span>
                    <span className="text-[11px] text-atlas-muted ml-2">NF mãe {p.nfMae}</span>
                  </div>
                  {p.inconsistencia && (
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 flex items-center gap-1 shrink-0">
                      <AlertTriangle size={11} /> Chegou — NF aberta
                    </span>
                  )}
                  {p.estagioFup && (
                    <span className="text-[11px] text-atlas-muted px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 shrink-0">{rotulo(ESTAGIO_FUP_LABEL, p.estagioFup)}</span>
                  )}
                  {p.diasEmExoneracao != null && (
                    <span className={`text-[11px] shrink-0 ${agingClass(p.diasEmExoneracao)}`} title={`Em exoneração desde ${fmtData(p.exoneracaoDataEntrada)}`}>
                      exoneração há {p.diasEmExoneracao}d
                    </span>
                  )}
                  <div className="ml-auto text-right shrink-0">
                    <span className="font-mono text-atlas-ink">{fmtKg(p.saldoPendenteKg)} kg</span>
                    <span className="text-[11px] text-atlas-muted ml-1">/ {fmtKg(p.qtdePedidoKg)}</span>
                  </div>
                </button>

                {aberto && (
                  <div className="bg-slate-50/60 dark:bg-slate-900/30 px-3 pb-3 pt-1">
                    <table className="min-w-full text-xs">
                      <thead className="text-[11px] uppercase text-atlas-muted">
                        <tr>
                          <th className="text-left px-2 py-1">#</th>
                          <th className="text-left px-2 py-1">NF filhote</th>
                          <th className="text-right px-2 py-1">kg</th>
                          <th className="text-left px-2 py-1">Recebida</th>
                          <th className="text-left px-2 py-1">Emitida há</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.filhotes.map((f) => (
                          <tr key={f.nfFilhote} className="border-t border-slate-200 dark:border-slate-700/50">
                            <td className="px-2 py-1 text-atlas-muted">{f.posicao}</td>
                            <td className="px-2 py-1 font-mono">{f.nfFilhote}</td>
                            <td className="px-2 py-1 text-right font-mono text-atlas-ink">{fmtKg(f.qtdeKg)}</td>
                            <td className="px-2 py-1">
                              {f.recebida ? (
                                <span className="text-green-700 dark:text-green-300">
                                  ✓ {f.fonteRecebimento ? FONTE_LABEL[f.fonteRecebimento] : ''}
                                </span>
                              ) : f.nfEmitida ? (
                                <span className="text-red-700 dark:text-red-300">aguardando</span>
                              ) : (
                                <span className="text-atlas-muted">NF não emitida</span>
                              )}
                            </td>
                            <td className={`px-2 py-1 ${agingClass(f.diasDesdeEmissao)}`}>
                              {f.diasDesdeEmissao != null ? `${f.diasDesdeEmissao}d` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Importação sem mapa (Parte B) */}
      {semMapa.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-serif text-atlas-ink mb-1">Importação sem mapa</h2>
          <p className="text-xs text-atlas-muted mb-3">
            NFs de importação (CFOP 3) sem mapa NF mãe/filhote cadastrado e sem recebimento reconhecido.
            Valide se não são falsas pendências (já recebidas mas não lançadas) ou pedidos a mapear.
          </p>
          <div className="overflow-x-auto border border-slate-200 dark:border-slate-700 rounded-lg">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase text-atlas-muted">
                <tr>
                  <th className="text-left px-3 py-2">NF</th>
                  <th className="text-left px-3 py-2">Produto</th>
                  <th className="text-right px-3 py-2">kg</th>
                  <th className="text-left px-3 py-2">CFOP</th>
                  <th className="text-left px-3 py-2">Emissão</th>
                </tr>
              </thead>
              <tbody>
                {semMapa.map((n) => (
                  <tr key={`${n.notaFiscal}-${n.produtoCodigoAcxe}`} className="border-t border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/30">
                    <td className="px-3 py-2 font-mono text-xs">{n.notaFiscal}</td>
                    <td className="px-3 py-2">
                      <div className="text-atlas-ink">{n.produtoNome ?? '—'}</div>
                      <div className="text-[11px] text-atlas-muted">
                        {n.produtoCodigoAcxe ? `cod ${n.produtoCodigoAcxe}` : '—'}
                        {!n.emMetricas && <span className="ml-1 text-amber-700 dark:text-amber-400">· fora de métrica</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-atlas-ink">{fmtKg(n.qtdeKg)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{n.cfop ?? '—'}</td>
                    <td className="px-3 py-2 text-xs">{fmtData(n.dataEmissao)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
