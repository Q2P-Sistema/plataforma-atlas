import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';
import { ConferenciaModal } from './ConferenciaModal.js';
import { ReSubmeterModal } from './ReSubmeterModal.js';
import { RecebimentoNacionalForm } from './RecebimentoNacionalForm.js';

type Aba = 'importacao' | 'nacional';

interface FilaItem {
  nf: string;
  tipo: string;
  cnpj: 'acxe' | 'q2p';
  produto: { codigo: number; nome: string };
  qtdOriginal: number;
  unidade: 't' | 'kg' | 'saco' | 'bigbag';
  qtdKg: number;
  localidadeCodigo: string;
  dtEmissao: string;
  custoBrl: number;
}

interface MinhaRejeicao {
  id: string;
  loteId: string | null;
  loteCodigo: string | null;
  tipoAprovacao: string;
  motivoRejeicao: string;
  quantidadeRecebidaKg: number;
  produtoCodigoAcxe: number;
  fornecedor: string;
  galpao: string | null;
  empresa: 'acxe' | 'q2p' | null;
  rejeitadoEm: string;
}

const TIPO_LABEL: Record<string, { label: string; color: string }> = {
  importacao: { label: 'Importação', color: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-400' },
  devolucao_cliente: { label: 'Devolução', color: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400' },
  compra_nacional: { label: 'Compra Nacional', color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' },
  retorno_remessa: { label: 'Retorno Remessa', color: 'bg-atlas-muted/20 text-atlas-muted' },
  retorno_comodato: { label: 'Retorno Comodato', color: 'bg-atlas-muted/20 text-atlas-muted' },
};

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers as Record<string, string>) };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    const body = (await res.json()) as { data: unknown; error: { code?: string; userMessage?: string; message?: string } | null };
    // Prefere userMessage (pt-BR p/ operador) — ex.: bloqueio de NF cancelada / não-ACXE (feature 012).
    if (!res.ok) throw new Error(body.error?.userMessage ?? body.error?.message ?? 'Erro');
    return body;
  };
}

export function FilaOmiePage() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [aba, setAba] = useState<Aba>('importacao');
  const [buscaNf, setBuscaNf] = useState('');
  const [queryKey, setQueryKey] = useState<{ nf?: string; cnpj?: string }>({});
  const [selecionado, setSelecionado] = useState<FilaItem | null>(null);
  const [resubmitendo, setResubmitendo] = useState<MinhaRejeicao | null>(null);

  // Lista de lancamentos de RECEBIMENTO rejeitados (com lote) — saidas manuais
  // sem lote sao mostradas na pagina /stockbridge/saida-manual.
  const { data: rejeicoes = [], refetch: refetchRejeicoes } = useQuery<MinhaRejeicao[]>({
    queryKey: ['stockbridge', 'minhas-rejeicoes', 'recebimento'],
    queryFn: async () => {
      const body = await apiFetch('/api/v1/stockbridge/aprovacoes/minhas-rejeicoes');
      const todas = body.data as MinhaRejeicao[];
      // Recebimento: lote de importacao OU entrada_manual (recebimento nacional sem lote)
      return todas.filter((r) => r.loteId !== null || r.tipoAprovacao === 'entrada_manual');
    },
  });

  // Soft-dismiss: tira a rejeicao da inbox sem mexer em status/audit (migration 0029).
  const dispensarMut = useMutation({
    mutationFn: async (rejeicaoId: string) =>
      apiFetch(`/api/v1/stockbridge/aprovacoes/${rejeicaoId}/dispensar`, { method: 'POST' }),
    onSuccess: () => {
      refetchRejeicoes();
      queryClient.invalidateQueries({ queryKey: ['stockbridge', 'minhas-rejeicoes', 'count'] });
    },
  });

  // Auto-abrir modal de re-submeter quando o email manda o usuario para
  // /stockbridge/recebimento#rejeicao=<id>. Tentativa em todo render — guard
  // por ref garante que so abrimos uma vez e nao reabrimos se o usuario fechar.
  const hashHandledRef = useRef(false);
  useEffect(() => {
    if (hashHandledRef.current || rejeicoes.length === 0) return;
    const hash = window.location.hash;
    const match = hash.match(/^#rejeicao=([0-9a-f-]{36})$/i);
    if (!match) {
      hashHandledRef.current = true; // sem hash, marca como tratado
      return;
    }
    const targetId = match[1]!.toLowerCase();
    const target = rejeicoes.find((r) => r.id.toLowerCase() === targetId);
    if (target) {
      hashHandledRef.current = true;
      setResubmitendo(target);
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, [rejeicoes]);

  const { data: itens = [], isLoading, error } = useQuery<FilaItem[]>({
    queryKey: ['stockbridge', 'fila', queryKey],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (queryKey.nf) params.set('nf', queryKey.nf);
      if (queryKey.cnpj) params.set('cnpj', queryKey.cnpj);
      const body = await apiFetch(`/api/v1/stockbridge/fila?${params}`);
      return body.data as FilaItem[];
    },
    enabled: queryKey.nf != null && queryKey.nf.length > 0,
    // Evita refetch automatico no foco da janela / re-mount — OMIE bloqueia
    // consulta repetida da mesma NF em <40s (REDUNDANT).
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    staleTime: Infinity,
  });

  function handleBuscar(e: FormEvent) {
    e.preventDefault();
    if (!buscaNf.trim()) return;
    setQueryKey({ nf: buscaNf.trim(), cnpj: 'acxe' });
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Recebimento</h1>
        <p className="text-sm text-atlas-muted">
          {aba === 'importacao'
            ? 'Busque uma NF de importação ou devolução de cliente para confirmar o recebimento físico.'
            : 'Registre a entrada de uma NF nacional escolhendo produto, empresa e estoque destino.'}
        </p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-atlas-border">
        <button
          type="button"
          onClick={() => setAba('importacao')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            aba === 'importacao'
              ? 'border-atlas-accent text-atlas-ink'
              : 'border-transparent text-atlas-muted hover:text-atlas-ink'
          }`}
        >
          Importação
        </button>
        <button
          type="button"
          onClick={() => setAba('nacional')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            aba === 'nacional'
              ? 'border-atlas-accent text-atlas-ink'
              : 'border-transparent text-atlas-muted hover:text-atlas-ink'
          }`}
        >
          Compra nacional
        </button>
      </div>

      {aba === 'nacional' ? (
        <RecebimentoNacionalForm />
      ) : (
        <ImportacaoSection
          buscaNf={buscaNf}
          setBuscaNf={setBuscaNf}
          queryKey={queryKey}
          handleBuscar={handleBuscar}
          itens={itens}
          isLoading={isLoading}
          error={error}
          onSelecionar={setSelecionado}
        />
      )}

      {selecionado && (
        <ConferenciaModal
          item={selecionado}
          onClose={() => setSelecionado(null)}
          onSucesso={() => {
            setSelecionado(null);
            setBuscaNf('');
            setQueryKey({});
          }}
        />
      )}

      {resubmitendo && (
        <ReSubmeterModal
          aprovacaoId={resubmitendo.id}
          loteCodigo={resubmitendo.loteCodigo ?? ''}
          quantidadeOriginalKg={resubmitendo.quantidadeRecebidaKg}
          motivoRejeicao={resubmitendo.motivoRejeicao}
          onClose={() => setResubmitendo(null)}
          onSucesso={() => {
            setResubmitendo(null);
            refetchRejeicoes();
          }}
        />
      )}

      {(() => {
        const rejeicaoImportacao = rejeicoes.filter((r) => r.loteId !== null);
        const rejeicaoNacional = rejeicoes.filter((r) => r.tipoAprovacao === 'entrada_manual');
        const lista = aba === 'importacao' ? rejeicaoImportacao : rejeicaoNacional;
        if (lista.length === 0) return null;
        return (
          <div className="mt-8">
            <h2 className="text-lg font-serif text-atlas-ink mb-2">
              Recebimentos rejeitados ({lista.length})
            </h2>
            <p className="text-xs text-atlas-muted mb-3">
              {aba === 'importacao'
                ? 'Recebimentos que foram rejeitados pelo gestor. Corrija e re-submeta para nova aprovação.'
                : 'O gestor rejeitou estes itens. Registre um novo recebimento nacional com as correções necessárias.'}
            </p>
            <div className="flex flex-col gap-2">
              {lista.map((r) => (
                <div
                  key={r.id}
                  className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 flex items-center gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 mb-0.5">
                      <span className="font-serif text-base text-atlas-ink">
                        {r.loteCodigo ?? `NF · ${r.empresa?.toUpperCase() ?? ''} · ${r.galpao ?? ''}`}
                      </span>
                      <span className="text-xs text-atlas-muted">
                        {r.empresa?.toUpperCase()} · {r.quantidadeRecebidaKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg
                      </span>
                    </div>
                    <div className="text-xs text-red-700 dark:text-red-300 italic truncate">
                      "{r.motivoRejeicao || 'sem motivo registrado'}"
                    </div>
                  </div>
                  <div className="text-right text-xs text-atlas-muted whitespace-nowrap">
                    rejeitado em {new Date(r.rejeitadoEm).toLocaleDateString('pt-BR')}
                  </div>
                  <div className="flex flex-col gap-1.5 whitespace-nowrap">
                    {aba === 'importacao' && (
                      <button
                        onClick={() => setResubmitendo(r)}
                        disabled={dispensarMut.isPending}
                        className="px-3 py-1.5 bg-atlas-btn-bg text-atlas-btn-text rounded text-xs font-medium hover:opacity-90"
                      >
                        Re-submeter →
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (confirm(`Descartar esta rejeição da sua caixa de entrada?\n\nO histórico permanece para auditoria — você só não vai ver mais aqui.`)) {
                          dispensarMut.mutate(r.id);
                        }
                      }}
                      disabled={dispensarMut.isPending}
                      className="px-3 py-1.5 border border-atlas-border text-atlas-ink rounded text-xs font-medium hover:bg-atlas-bg/60"
                    >
                      Descartar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

interface ImportacaoSectionProps {
  buscaNf: string;
  setBuscaNf: (v: string) => void;
  queryKey: { nf?: string; cnpj?: string };
  handleBuscar: (e: FormEvent) => void;
  itens: FilaItem[];
  isLoading: boolean;
  error: unknown;
  onSelecionar: (it: FilaItem) => void;
}

function ImportacaoSection({
  buscaNf,
  setBuscaNf,
  queryKey,
  handleBuscar,
  itens,
  isLoading,
  error,
  onSelecionar,
}: ImportacaoSectionProps) {
  return (
    <>
      <form onSubmit={handleBuscar} className="flex items-end gap-3 mb-6 p-4 bg-atlas-card border border-atlas-border rounded-lg">
        <div className="flex-1">
          <label className="block text-xs font-medium text-atlas-muted mb-1">Número da NF</label>
          <input
            value={buscaNf}
            onChange={(e) => setBuscaNf(e.target.value)}
            placeholder="Ex: 4878 ou IMP-2026-0301"
            className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm outline-none focus:ring-2 focus:ring-atlas-accent"
          />
        </div>
        <button type="submit" className="px-5 py-2 bg-atlas-btn-bg text-atlas-btn-text rounded text-sm font-medium hover:opacity-90">
          Buscar
        </button>
      </form>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          {(error as Error).message}
        </div>
      )}

      {!queryKey.nf && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-atlas-border rounded-lg">
          Informe um número de NF para buscar.
        </div>
      )}

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Consultando OMIE…</div>}

      {queryKey.nf && !isLoading && itens.length === 0 && !error && (
        <div className="p-6 text-sm text-atlas-muted border border-dashed border-atlas-border rounded-lg">
          Nenhuma NF encontrada ou já processada. Verifique o número.
        </div>
      )}

      <div className="flex flex-col gap-3">
        {itens.map((item) => {
          const tipoCfg = TIPO_LABEL[item.tipo] ?? { label: item.tipo, color: 'bg-atlas-muted/20 text-atlas-muted' };
          return (
            <div key={item.nf} className="bg-atlas-card border border-atlas-border rounded-lg p-4 flex items-center gap-4">
              <span className={`text-xs font-semibold px-2 py-1 rounded ${tipoCfg.color}`}>{tipoCfg.label}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-3 mb-1">
                  <span className="font-serif text-lg text-atlas-ink">{item.produto.nome}</span>
                  <span className="font-mono text-xs text-atlas-muted">NF {item.nf}</span>
                </div>
                <div className="text-xs text-atlas-muted">
                  {item.cnpj.toUpperCase()} · cód. {item.produto.codigo} · {item.dtEmissao}
                </div>
              </div>
              <div className="text-right">
                <div className="font-serif text-xl text-atlas-ink">{item.qtdKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}<span className="text-xs text-atlas-muted ml-1">kg</span></div>
                <div className="text-xs text-atlas-muted">= {(item.qtdKg / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} t</div>
              </div>
              <button
                onClick={() => onSelecionar(item)}
                className="px-4 py-2 bg-atlas-btn-bg text-atlas-btn-text rounded text-sm font-medium hover:opacity-90"
              >
                Receber →
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
