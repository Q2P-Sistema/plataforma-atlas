import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@atlas/ui';
import { useAuthStore } from '../../../stores/auth.store.js';
import { SUBTIPO_LABEL, rotulo, labelGalpao } from '../labels.js';

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
  // Feature 015 (ACXEGDP-328): recebimento nacional por NF e baixa externa —
  // produto Q2P (sem ACXE) e identidade da NF/item, para o card nao cair em "SKU 0".
  produtoCodigoQ2p: number | null;
  notaFiscal: string | null;
  nfItemDescricao: string | null;
  nfChaveAcesso: string | null;
}

/** Baixa por recebimento externo ja APROVADA (feature 015, FR-031) — reversivel pelo gestor. */
interface BaixaExterna {
  id: string;
  nfChaveAcesso: string;
  notaFiscal: string;
  nfItemDescricao: string;
  quantidadeNfKg: number | null;
  motivo: string | null;
  lancadoPor: string;
  lancadoEm: string;
  aprovadoPor: string | null;
  aprovadoEm: string | null;
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
  retorno_comodato: 'Retorno de comodato',
  recebimento_externo: 'Baixa — recebido fora do Atlas',
};

const fmtKg0 = (v: number) => Math.abs(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 });

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
        throw new Error(`HTTP ${res.status}: resposta não-JSON (${text.slice(0, 120)})`);
      }
    }
    if (!res.ok) {
      throw new Error(body.error?.message ?? `HTTP ${res.status} sem resposta — o servidor pode ter reiniciado, tente novamente`);
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
        texto: `✓ Pendência aprovada: ${TIPO_LABEL[pendencia.tipoAprovacao] ?? pendencia.tipoAprovacao} — ${pendencia.produto.fornecedor}`,
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
        texto: `✓ Pendência rejeitada: ${TIPO_LABEL[pendencia.tipoAprovacao] ?? pendencia.tipoAprovacao} — ${pendencia.produto.fornecedor}. O operador foi notificado por e-mail.`,
      });
      queryClient.invalidateQueries({ queryKey: ['stockbridge'] });
    },
    onError: (err) => setFeedback({ tipo: 'erro', texto: `Erro ao rejeitar: ${(err as Error).message}` }),
  });

  return (
    <div className="p-6 max-w-7xl">
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

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando…</div>}

      {!isLoading && pendencias.length === 0 && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-atlas-border rounded-lg">
          ✓ Nenhuma pendência de aprovação
        </div>
      )}

      <div className="flex flex-col gap-3">
        {pendencias.map((p) => {
          const externo = p.tipoAprovacao === 'recebimento_externo';
          const hasDivergencia = !externo && p.deltaKg != null && Math.abs(p.deltaKg) > 1;
          return (
            <div
              key={p.id}
              className={`bg-atlas-card border rounded-lg p-4 ${hasDivergencia ? 'border-red-200 dark:border-red-800 bg-red-50/30 dark:bg-red-900/10' : externo ? 'border-sky-200 dark:border-sky-800 bg-sky-50/30 dark:bg-sky-900/10' : 'border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-900/10'}`}
            >
              <div className="flex justify-between items-start mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold px-2 py-0.5 rounded bg-atlas-bg">
                      {TIPO_LABEL[p.tipoAprovacao] ?? p.tipoAprovacao}
                    </span>
                    {p.precisaNivel === 'diretor' && (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300">
                        Diretor
                      </span>
                    )}
                    {p.tipoDivergencia && (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300">
                        {rotulo(SUBTIPO_LABEL, p.tipoDivergencia)}
                      </span>
                    )}
                  </div>
                  <div className="font-serif text-base text-atlas-ink">
                    {externo
                      ? <>NF {p.notaFiscal} — {p.nfItemDescricao?.trim() || 'item da nota'}</>
                      : <>{p.loteCodigo ? `Lote ${p.loteCodigo} — ` : ''}{p.produto.fornecedor}</>}
                  </div>
                  {externo && (
                    <div className="text-xs text-atlas-muted mt-0.5">
                      {p.quantidadePrevistaKg != null && <>{fmtKg0(p.quantidadePrevistaKg)} kg na nota · </>}
                      sem movimentação de estoque — só retira o item da fila de recebimento
                    </div>
                  )}
                  {!externo && !p.loteCodigo && (p.notaFiscal || p.galpao || p.empresa) && (
                    <div className="text-xs text-atlas-muted mt-0.5">
                      {/* produto ja esta no titulo, por descricao — nunca o codigo OMIE (ACXEGDP-313) */}
                      {[
                        p.notaFiscal ? `NF ${p.notaFiscal}${p.nfItemDescricao ? ` · item "${p.nfItemDescricao.trim()}"` : ''}` : null,
                        p.galpao ? labelGalpao(p.galpao) : null,
                        p.empresa ? p.empresa.toUpperCase() : null,
                        p.quantidadeRecebidaKg != null ? `${fmtKg0(p.quantidadeRecebidaKg)} kg` : null,
                      ].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  <div className="text-xs text-atlas-muted mt-0.5">
                    Lançado por <strong>{p.lancadoPor.nome}</strong> em {new Date(p.lancadoEm).toLocaleString('pt-BR')}
                  </div>
                </div>
              </div>

              {hasDivergencia && (
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <Cell label={p.notaFiscal ? `Na NF ${p.notaFiscal}` : 'Previsto NF'} value={`${p.quantidadePrevistaKg?.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg`} />
                  <Cell label="Conferido" value={`${p.quantidadeRecebidaKg?.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg`} accent="text-amber-700" />
                  <Cell label="Diferença" value={`${p.deltaKg! > 0 ? '+' : ''}${p.deltaKg?.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg`} accent={p.deltaKg! < 0 ? 'text-red-700' : 'text-amber-700'} />
                </div>
              )}

              {p.observacoes && (
                <div className="p-2 bg-atlas-bg rounded text-xs text-atlas-muted italic mb-3">
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
                  {aprovarMut.isPending ? '…' : 'Aprovar'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <BaixasExternasSection apiFetch={apiFetch} onFeedback={setFeedback} />

      {rejeitando && (
        <Modal open title="Rejeitar pendência" onClose={() => setRejeitando(null)}>
          <div className="space-y-3">
            <p className="text-sm text-atlas-muted">
              {rejeitando.loteCodigo
                ? <>Lote <strong>{rejeitando.loteCodigo}</strong> — {rejeitando.produto.fornecedor}</>
                : rejeitando.notaFiscal
                  ? <>NF <strong>{rejeitando.notaFiscal}</strong> — {rejeitando.tipoAprovacao === 'recebimento_externo' ? rejeitando.nfItemDescricao?.trim() : rejeitando.produto.fornecedor}</>
                  : rejeitando.produto.fornecedor}
            </p>
            <div>
              <label className="block text-xs font-semibold text-atlas-muted mb-1">Motivo da rejeição *</label>
              <textarea
                value={motivoRejeicao}
                onChange={(e) => setMotivoRejeicao(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Ex: Quantidade incorreta, solicitar reconferência"
                className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg text-atlas-ink placeholder:text-atlas-muted rounded text-sm"
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
                className="px-4 py-2 border border-atlas-border bg-atlas-card text-atlas-ink hover:bg-atlas-bg/60 rounded text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={() => rejeitarMut.mutate({ p: rejeitando, motivo: motivoRejeicao })}
                disabled={!motivoRejeicao.trim() || rejeitarMut.isPending}
                className={`px-5 py-2 rounded text-sm font-medium ${motivoRejeicao.trim() ? 'bg-red-700 text-white hover:opacity-90' : 'bg-atlas-muted/20 text-atlas-muted cursor-not-allowed'}`}
              >
                {rejeitarMut.isPending ? 'Enviando…' : 'Confirmar rejeição'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * Feature 015 (FR-031) — baixas por recebimento externo ja aprovadas. Sao as
 * que tiraram um item da fila nacional sem movimentar estoque; o gestor pode
 * reverter (com motivo) e o item volta a fila. Auditado.
 */
function BaixasExternasSection({
  apiFetch,
  onFeedback,
}: {
  apiFetch: ReturnType<typeof useApiFetch>;
  onFeedback: (f: { tipo: 'sucesso' | 'erro'; texto: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [revertendo, setRevertendo] = useState<BaixaExterna | null>(null);
  const [motivo, setMotivo] = useState('');

  const { data: baixas = [], isLoading } = useQuery<BaixaExterna[]>({
    queryKey: ['stockbridge', 'aprovacoes', 'baixas-externas'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/aprovacoes/baixas-externas')).data as BaixaExterna[],
    refetchInterval: 60_000,
  });

  const reverterMut = useMutation({
    mutationFn: async (args: { b: BaixaExterna; motivo: string }) =>
      apiFetch(`/api/v1/stockbridge/aprovacoes/${args.b.id}/reverter`, { method: 'POST', body: JSON.stringify({ motivo: args.motivo }) }).then(() => args.b),
    onSuccess: (b) => {
      setRevertendo(null);
      setMotivo('');
      onFeedback({ tipo: 'sucesso', texto: `✓ Baixa revertida: NF ${b.notaFiscal} — ${b.nfItemDescricao.trim()} voltou à fila de recebimento.` });
      queryClient.invalidateQueries({ queryKey: ['stockbridge'] });
      queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional'] });
    },
    onError: (err) => onFeedback({ tipo: 'erro', texto: `Erro ao reverter: ${(err as Error).message}` }),
  });

  if (isLoading || baixas.length === 0) return null;

  return (
    <details className="mt-8 group">
      <summary className="cursor-pointer text-sm font-serif text-atlas-ink select-none">
        Baixas por recebimento fora do Atlas
        <span className="ml-2 text-xs font-sans text-atlas-muted">{baixas.length} {baixas.length === 1 ? 'aprovada' : 'aprovadas'} · itens retirados da fila sem movimentar estoque</span>
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        {baixas.map((b) => (
          <div key={b.id} className="bg-atlas-card border border-atlas-border rounded-lg p-3 flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-[16rem]">
              <div className="text-sm text-atlas-ink">
                <span className="font-mono">NF {b.notaFiscal}</span> — {b.nfItemDescricao.trim()}
                {b.quantidadeNfKg != null && <span className="text-atlas-muted"> · {fmtKg0(b.quantidadeNfKg)} kg na nota</span>}
              </div>
              {b.motivo && <div className="text-xs text-atlas-muted italic mt-0.5">"{b.motivo}"</div>}
              <div className="text-[11px] text-atlas-muted mt-0.5">
                aprovada em {b.aprovadoEm ? new Date(b.aprovadoEm).toLocaleString('pt-BR') : '—'}
              </div>
            </div>
            <button
              onClick={() => setRevertendo(b)}
              disabled={reverterMut.isPending}
              className="px-3 py-1.5 border border-atlas-border text-atlas-ink rounded text-xs font-medium hover:bg-atlas-bg/60 whitespace-nowrap"
            >
              Reverter baixa
            </button>
          </div>
        ))}
      </div>

      {revertendo && (
        <Modal open title="Reverter baixa" onClose={() => { setRevertendo(null); setMotivo(''); }}>
          <div className="space-y-3">
            <p className="text-sm text-atlas-muted">
              NF <strong>{revertendo.notaFiscal}</strong> — {revertendo.nfItemDescricao.trim()} volta à fila de recebimento nacional. Nada é movimentado no estoque.
            </p>
            <div>
              <label className="block text-xs font-semibold text-atlas-muted mb-1">Motivo da reversão *</label>
              <textarea
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Ex.: a baixa foi lançada na nota errada"
                className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg text-atlas-ink placeholder:text-atlas-muted rounded text-sm"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setRevertendo(null); setMotivo(''); }}
                className="px-4 py-2 border border-atlas-border bg-atlas-card text-atlas-ink hover:bg-atlas-bg/60 rounded text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={() => reverterMut.mutate({ b: revertendo, motivo })}
                disabled={!motivo.trim() || reverterMut.isPending}
                className={`px-5 py-2 rounded text-sm font-medium ${motivo.trim() ? 'bg-atlas-btn-bg text-atlas-btn-text hover:opacity-90' : 'bg-atlas-muted/20 text-atlas-muted cursor-not-allowed'}`}
              >
                {reverterMut.isPending ? 'Enviando…' : 'Confirmar reversão'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </details>
  );
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-atlas-bg rounded p-2">
      <div className="text-[10px] text-atlas-muted">{label}</div>
      <div className={`font-serif text-sm ${accent ?? 'text-atlas-ink'}`}>{value}</div>
    </div>
  );
}
