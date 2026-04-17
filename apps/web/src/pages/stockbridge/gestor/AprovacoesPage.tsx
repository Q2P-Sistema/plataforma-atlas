import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@atlas/ui';
import { useAuthStore } from '../../../stores/auth.store.js';

interface Pendencia {
  id: string;
  loteId: string;
  loteCodigo: string;
  tipoAprovacao: string;
  precisaNivel: 'gestor' | 'diretor';
  quantidadePrevistaT: number | null;
  quantidadeRecebidaT: number | null;
  deltaT: number | null;
  tipoDivergencia: string | null;
  observacoes: string | null;
  lancadoPor: { id: string; nome: string };
  lancadoEm: string;
  produto: { codigoAcxe: number; fornecedor: string };
}

const TIPO_LABEL: Record<string, string> = {
  recebimento_divergencia: 'Recebimento com divergencia',
  entrada_manual: 'Entrada manual',
  saida_transf_intra: 'Transferencia intra-CNPJ',
  saida_comodato: 'Comodato',
  saida_amostra: 'Amostra/Brinde',
  saida_descarte: 'Descarte/Perda',
  saida_quebra: 'Quebra tecnica',
  ajuste_inventario: 'Ajuste de inventario',
};

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

export function AprovacoesPage() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [rejeitando, setRejeitando] = useState<Pendencia | null>(null);
  const [motivoRejeicao, setMotivoRejeicao] = useState('');

  const { data: pendencias = [], isLoading, error } = useQuery<Pendencia[]>({
    queryKey: ['stockbridge', 'aprovacoes'],
    queryFn: async () => {
      const body = await apiFetch('/api/v1/stockbridge/aprovacoes');
      return body.data as Pendencia[];
    },
    refetchInterval: 30_000,
  });

  const aprovarMut = useMutation({
    mutationFn: async (id: string) =>
      apiFetch(`/api/v1/stockbridge/aprovacoes/${id}/aprovar`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['stockbridge'] }),
  });

  const rejeitarMut = useMutation({
    mutationFn: async (args: { id: string; motivo: string }) =>
      apiFetch(`/api/v1/stockbridge/aprovacoes/${args.id}/rejeitar`, {
        method: 'POST',
        body: JSON.stringify({ motivo: args.motivo }),
      }),
    onSuccess: () => {
      setRejeitando(null);
      setMotivoRejeicao('');
      queryClient.invalidateQueries({ queryKey: ['stockbridge'] });
    },
  });

  return (
    <div className="p-6 max-w-6xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Aprovacoes Pendentes</h1>
        <p className="text-sm text-atlas-muted">
          Divergencias de recebimento, entradas manuais e saidas que exigem sua autorizacao.
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
          ✓ Nenhuma pendencia de aprovacao
        </div>
      )}

      <div className="flex flex-col gap-3">
        {pendencias.map((p) => {
          const hasDivergencia = p.deltaT != null && Math.abs(p.deltaT) > 0.01;
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
                    Lote {p.loteCodigo} — {p.produto.fornecedor}
                  </div>
                  <div className="text-xs text-atlas-muted mt-0.5">
                    Lancado por <strong>{p.lancadoPor.nome}</strong> em {new Date(p.lancadoEm).toLocaleString('pt-BR')}
                  </div>
                </div>
              </div>

              {hasDivergencia && (
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <Cell label="Previsto NF" value={`${p.quantidadePrevistaT?.toFixed(3)} t`} />
                  <Cell label="Recebido" value={`${p.quantidadeRecebidaT?.toFixed(3)} t`} accent="text-amber-700" />
                  <Cell label="Delta" value={`${p.deltaT! > 0 ? '+' : ''}${p.deltaT?.toFixed(3)} t`} accent={p.deltaT! < 0 ? 'text-red-700' : 'text-amber-700'} />
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
                  onClick={() => aprovarMut.mutate(p.id)}
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

      {aprovarMut.isError && (
        <div className="fixed bottom-4 right-4 p-3 bg-red-50 border border-red-300 rounded shadow-lg text-sm text-red-800">
          Erro ao aprovar: {(aprovarMut.error as Error).message}
        </div>
      )}

      {rejeitando && (
        <Modal open title="Rejeitar pendencia" onClose={() => setRejeitando(null)}>
          <div className="space-y-3">
            <p className="text-sm text-atlas-muted">
              Lote <strong>{rejeitando.loteCodigo}</strong> — {rejeitando.produto.fornecedor}
            </p>
            <div>
              <label className="block text-xs font-semibold text-atlas-muted mb-1">Motivo da rejeicao *</label>
              <textarea
                value={motivoRejeicao}
                onChange={(e) => setMotivoRejeicao(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Ex: Quantidade incorreta, solicitar reconferencia"
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
              />
            </div>
            {rejeitarMut.isError && (
              <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                {(rejeitarMut.error as Error).message}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={() => setRejeitando(null)} className="px-4 py-2 border border-slate-300 rounded text-sm">Cancelar</button>
              <button
                onClick={() => rejeitarMut.mutate({ id: rejeitando.id, motivo: motivoRejeicao })}
                disabled={!motivoRejeicao.trim() || rejeitarMut.isPending}
                className={`px-5 py-2 rounded text-sm font-medium ${motivoRejeicao.trim() ? 'bg-red-700 text-white hover:opacity-90' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}
              >
                {rejeitarMut.isPending ? 'Enviando...' : 'Confirmar rejeicao'}
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
