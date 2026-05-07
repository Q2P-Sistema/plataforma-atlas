import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@atlas/ui';
import { useAuthStore } from '../../../stores/auth.store.js';

interface Pendencia {
  id: string;
  /** Pode ser null para saidas manuais sem lote (migration 0026). */
  loteId: string | null;
  loteCodigo: string | null;
  tipoAprovacao: string;
  precisaNivel: 'gestor' | 'diretor';
  quantidadePrevistaKg: number | null;
  quantidadeRecebidaKg: number | null;
  deltaKg: number | null;
  tipoDivergencia: string | null;
  observacoes: string | null;
  lancadoPor: { id: string; nome: string };
  lancadoEm: string;
  produto: { codigoAcxe: number; fornecedor: string };
  /** Saidas manuais sem lote: galpao + empresa do material. */
  galpao: string | null;
  empresa: 'acxe' | 'q2p' | null;
}

const TIPO_LABEL: Record<string, string> = {
  recebimento_divergencia: 'Recebimento com divergência',
  entrada_manual: 'Entrada manual',
  saida_transf_intra: 'Transferência intra-CNPJ',
  saida_comodato: 'Comodato',
  saida_amostra: 'Amostra/Brinde',
  saida_descarte: 'Descarte/Perda',
  saida_quebra: 'Quebra técnica',
  ajuste_inventario: 'Ajuste de inventário',
  retorno_comodato: 'Retorno de Comodato',
};

const GALPAO_LABELS: Record<string, string> = {
  '11.1': 'Santo André — Importado (11.1)',
  '11.2': 'Santo André — Nacional (11.2) · Q2P',
  '12.1': 'Santo André — Importado (12.1)',
  '12.2': 'Santo André — Nacional (12.2) · Q2P',
  '21.1': 'Extrema (21.1)',
  '31.1': 'Armazém Externo / ATN (31.1)',
};
const labelGalpao = (g: string) => GALPAO_LABELS[g] ?? g;

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers as Record<string, string>) };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    // Body pode estar vazio (server reiniciou no meio do request, proxy timeout,
    // 204, etc). Ler como texto e parsear defensivamente para nao mascarar o
    // status real com "Unexpected end of JSON input".
    const text = await res.text();
    let body: { data: unknown; error: { message?: string } | null } = { data: null, error: null };
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${res.status}: resposta nao-JSON (${text.slice(0, 120)})`);
      }
    }
    if (!res.ok) {
      throw new Error(body.error?.message ?? `HTTP ${res.status} sem body — servidor pode ter reiniciado, tente novamente`);
    }
    return body;
  };
}

export function AprovacoesPage() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [rejeitando, setRejeitando] = useState<Pendencia | null>(null);
  const [motivoRejeicao, setMotivoRejeicao] = useState('');
  const [feedback, setFeedback] = useState<{ tipo: 'sucesso' | 'erro'; texto: string } | null>(null);

  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 5000);
    return () => clearTimeout(t);
  }, [feedback]);

  const { data: pendencias = [], isLoading, error } = useQuery<Pendencia[]>({
    queryKey: ['stockbridge', 'aprovacoes'],
    queryFn: async () => {
      const body = await apiFetch('/api/v1/stockbridge/aprovacoes');
      return body.data as Pendencia[];
    },
    refetchInterval: 30_000,
  });

  const aprovarMut = useMutation({
    mutationFn: async (p: Pendencia) =>
      apiFetch(`/api/v1/stockbridge/aprovacoes/${p.id}/aprovar`, { method: 'POST' }).then((body) => ({
        body,
        pendencia: p,
      })),
    onSuccess: ({ pendencia }) => {
      setFeedback({
        tipo: 'sucesso',
        texto: `✓ ${TIPO_LABEL[pendencia.tipoAprovacao] ?? pendencia.tipoAprovacao} aprovada — ${pendencia.produto.fornecedor}`,
      });
      queryClient.invalidateQueries({ queryKey: ['stockbridge'] });
    },
    onError: (err) => setFeedback({ tipo: 'erro', texto: `Erro ao aprovar: ${(err as Error).message}` }),
  });

  const rejeitarMut = useMutation({
    mutationFn: async (args: { p: Pendencia; motivo: string }) =>
      apiFetch(`/api/v1/stockbridge/aprovacoes/${args.p.id}/rejeitar`, {
        method: 'POST',
        body: JSON.stringify({ motivo: args.motivo }),
      }).then((body) => ({ body, pendencia: args.p })),
    onSuccess: ({ pendencia }) => {
      setRejeitando(null);
      setMotivoRejeicao('');
      setFeedback({
        tipo: 'sucesso',
        texto: `✓ ${TIPO_LABEL[pendencia.tipoAprovacao] ?? pendencia.tipoAprovacao} rejeitada — ${pendencia.produto.fornecedor}. Operador foi notificado por email.`,
      });
      queryClient.invalidateQueries({ queryKey: ['stockbridge'] });
    },
    onError: (err) => setFeedback({ tipo: 'erro', texto: `Erro ao rejeitar: ${(err as Error).message}` }),
  });

  return (
    <div className="p-6 max-w-6xl">
      {feedback && (
        <div
          className={`fixed top-4 right-4 z-50 max-w-md p-4 rounded-lg shadow-lg border ${
            feedback.tipo === 'sucesso'
              ? 'bg-emerald-50 border-emerald-300 text-emerald-900 dark:bg-emerald-900/40 dark:border-emerald-700 dark:text-emerald-100'
              : 'bg-red-50 border-red-300 text-red-900 dark:bg-red-900/40 dark:border-red-700 dark:text-red-100'
          }`}
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 text-sm font-medium">{feedback.texto}</div>
            <button
              onClick={() => setFeedback(null)}
              className="text-lg leading-none opacity-60 hover:opacity-100"
              aria-label="Fechar"
            >
              ×
            </button>
          </div>
        </div>
      )}
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Aprovações Pendentes</h1>
        <p className="text-sm text-atlas-muted">
          Divergências de recebimento, entradas manuais e saídas que exigem sua autorização.
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 rounded text-sm text-red-800 dark:text-red-300">
          {(error as Error).message}
        </div>
      )}

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando...</div>}

      {!isLoading && pendencias.length === 0 && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-slate-300 dark:border-slate-700 rounded-lg">
          ✓ Nenhuma pendência de aprovação
        </div>
      )}

      <div className="flex flex-col gap-3">
        {pendencias.map((p) => {
          const hasDivergencia = p.deltaKg != null && Math.abs(p.deltaKg) > 1;
          return (
            <div
              key={p.id}
              className={`bg-white dark:bg-slate-800 border rounded-lg p-4 ${hasDivergencia ? 'border-red-200 dark:border-red-800 bg-red-50/30 dark:bg-red-900/10' : 'border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-900/10'}`}
            >
              <div className="flex justify-between items-start mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-700">
                      {TIPO_LABEL[p.tipoAprovacao] ?? p.tipoAprovacao}
                    </span>
                    {p.precisaNivel === 'diretor' && (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300">
                        Diretor
                      </span>
                    )}
                    {p.tipoDivergencia && (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300">
                        {p.tipoDivergencia}
                      </span>
                    )}
                  </div>
                  <div className="font-serif text-base text-atlas-ink">
                    {p.loteCodigo ? `Lote ${p.loteCodigo} — ` : ''}{p.produto.fornecedor}
                  </div>
                  {!p.loteCodigo && (p.galpao || p.empresa) && (
                    <div className="text-xs text-atlas-muted mt-0.5">
                      SKU <span className="font-mono">{p.produto.codigoAcxe}</span>
                      {p.galpao && <> · {labelGalpao(p.galpao)}</>}
                      {p.empresa && <> · {p.empresa.toUpperCase()}</>}
                      {p.quantidadeRecebidaKg != null && <> · {Math.abs(p.quantidadeRecebidaKg).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg</>}
                    </div>
                  )}
                  <div className="text-xs text-atlas-muted mt-0.5">
                    Lançado por <strong>{p.lancadoPor.nome}</strong> em {new Date(p.lancadoEm).toLocaleString('pt-BR')}
                  </div>
                </div>
              </div>

              {hasDivergencia && (
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <Cell label="Previsto NF" value={`${p.quantidadePrevistaKg?.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg`} />
                  <Cell label="Recebido" value={`${p.quantidadeRecebidaKg?.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg`} accent="text-amber-700" />
                  <Cell label="Delta" value={`${p.deltaKg! > 0 ? '+' : ''}${p.deltaKg?.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg`} accent={p.deltaKg! < 0 ? 'text-red-700' : 'text-amber-700'} />
                </div>
              )}

              {p.observacoes && (
                <div className="p-2 bg-white dark:bg-slate-900/50 rounded text-xs text-atlas-muted italic mb-3">
                  "{p.observacoes}"
                </div>
              )}

              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setRejeitando(p)}
                  disabled={aprovarMut.isPending || rejeitarMut.isPending}
                  className="px-3 py-1.5 border border-red-300 text-red-700 dark:text-red-300 rounded text-sm hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  Rejeitar
                </button>
                <button
                  onClick={() => aprovarMut.mutate(p)}
                  disabled={aprovarMut.isPending || rejeitarMut.isPending}
                  className="px-4 py-1.5 bg-green-700 text-white rounded text-sm font-medium hover:opacity-90"
                >
                  {aprovarMut.isPending ? '...' : 'Aprovar'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {rejeitando && (
        <Modal open title="Rejeitar pendência" onClose={() => setRejeitando(null)}>
          <div className="space-y-3">
            <p className="text-sm text-atlas-muted">
              Lote <strong>{rejeitando.loteCodigo}</strong> — {rejeitando.produto.fornecedor}
            </p>
            <div>
              <label className="block text-xs font-semibold text-atlas-muted mb-1">Motivo da rejeição *</label>
              <textarea
                value={motivoRejeicao}
                onChange={(e) => setMotivoRejeicao(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Ex: Quantidade incorreta, solicitar reconferência"
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded text-sm"
              />
            </div>
            {rejeitarMut.isError && (
              <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                {(rejeitarMut.error as Error).message}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setRejeitando(null)}
                className="px-4 py-2 border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 rounded text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={() => rejeitarMut.mutate({ p: rejeitando, motivo: motivoRejeicao })}
                disabled={!motivoRejeicao.trim() || rejeitarMut.isPending}
                className={`px-5 py-2 rounded text-sm font-medium ${motivoRejeicao.trim() ? 'bg-red-700 text-white hover:opacity-90' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}
              >
                {rejeitarMut.isPending ? 'Enviando...' : 'Confirmar rejeição'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-white dark:bg-slate-900/50 rounded p-2">
      <div className="text-[10px] text-atlas-muted">{label}</div>
      <div className={`font-serif text-sm ${accent ?? 'text-atlas-ink'}`}>{value}</div>
    </div>
  );
}
