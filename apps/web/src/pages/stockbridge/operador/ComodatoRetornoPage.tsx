import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

interface ComodatoAberto {
  movimentacaoId: string;
  produtoCodigoAcxe: number;
  produtoDescricao: string;
  galpaoOrigem: string;
  empresa: 'acxe' | 'q2p';
  quantidadeKg: number;
  cliente: string | null;
  dtPrevistaRetorno: string | null;
  dtSaida: string;
  diasEmAberto: number;
  vencido: boolean;
}

const fmtKg = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
// dt_prevista_retorno e DATE no Postgres -> 'YYYY-MM-DD'. new Date(yyyy-mm-dd)
// interpreta como UTC midnight e em fuso BR (UTC-3) volta um dia. Formatar a
// string direto pra evitar o shift. Para timestamps completos, mantem Date.
const fmtData = (iso: string | null) => {
  if (!iso) return '—';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return new Date(iso).toLocaleDateString('pt-BR');
};

const GALPAO_LABELS: Record<string, string> = {
  '11.1': 'Santo André — Importado (11.1)',
  '11.2': 'Santo André — Nacional (11.2) · Q2P',
  '12.1': 'Santo André — Importado (12.1)',
  '12.2': 'Santo André — Nacional (12.2) · Q2P',
  '21.1': 'Extrema (21.1)',
  '21.2': 'Extrema — Nacional (21.2) · ACXE',
  '31.1': 'Armazém Externo / ATN (31.1)',
  '90': 'TROCA (virtual)',
  '90.0.1': 'TROCA (virtual)',
  '90.0.2': 'TRÂNSITO (virtual)',
};
const labelGalpao = (g: string) => GALPAO_LABELS[g] ?? g;

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string>),
    };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    const body = (await res.json()) as { data: unknown; error: { message?: string } | null };
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body;
  };
}

export function ComodatoRetornoPage() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const podeDispararCron = role === 'gestor' || role === 'diretor';
  const [busca, setBusca] = useState('');
  const [comodatoModal, setComodatoModal] = useState<ComodatoAberto | null>(null);
  const [feedbackCron, setFeedbackCron] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<ComodatoAberto[], Error>({
    queryKey: ['sb', 'comodato', 'abertos'],
    queryFn: async () => {
      const r = await apiFetch('/api/v1/stockbridge/comodato/abertos');
      return r.data as ComodatoAberto[];
    },
  });

  const dispararCronMut = useMutation({
    mutationFn: async () => {
      const r = await apiFetch('/api/v1/stockbridge/admin/cron/comodato-vencido/run', { method: 'POST' });
      return r.data as { total: number; notificados: number };
    },
    onSuccess: (res) => {
      setFeedbackCron(
        `Cron rodou — ${res.total} comodato(s) vencido(s); ${res.notificados} notificacao(oes) disparada(s).`,
      );
      queryClient.invalidateQueries({ queryKey: ['stockbridge', 'comodatos', 'count'] });
    },
    onError: (err) => setFeedbackCron(`Erro: ${(err as Error).message}`),
  });

  const filtrados = useMemo(() => {
    if (!data) return [];
    if (!busca) return data;
    const b = busca.toLowerCase();
    return data.filter(
      (c) =>
        c.produtoDescricao.toLowerCase().includes(b) ||
        String(c.produtoCodigoAcxe).includes(busca) ||
        (c.cliente?.toLowerCase().includes(b) ?? false),
    );
  }, [data, busca]);

  return (
    <div className="p-6">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-serif text-atlas-ink mb-1">Retorno de Comodato</h1>
          <p className="text-sm text-atlas-muted">
            Material em comodato (estoque virtual TROCA Q2P) aguardando retorno do cliente. O retorno
            aceita SKU/quantidade diferentes do comodato original — divergências serão justificadas e
            aprovadas por gestor.
          </p>
        </div>
        {podeDispararCron && (
          <div className="shrink-0 text-right">
            <button
              onClick={() => {
                setFeedbackCron(null);
                dispararCronMut.mutate();
              }}
              disabled={dispararCronMut.isPending}
              title="Roda agora o cron de alerta — normalmente roda às 08:00 BR todo dia"
              className="px-3 py-1.5 text-xs font-medium border border-atlas-border rounded hover:bg-atlas-bg/60 disabled:opacity-50"
            >
              {dispararCronMut.isPending ? 'Rodando…' : '🔔 Disparar alerta agora'}
            </button>
            {feedbackCron && (
              <div className="mt-1 text-[11px] text-atlas-muted max-w-[280px] text-right">
                {feedbackCron}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mb-4">
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por produto, SKU ou cliente"
          className="w-full max-w-md px-3 py-1.5 border border-atlas-border bg-atlas-bg rounded text-sm"
        />
      </div>

      {isLoading && <div className="text-sm text-atlas-muted">Carregando comodatos...</div>}
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          Erro: {error.message}
        </div>
      )}

      {data && (
        <div
          className="bg-atlas-card border border-atlas-border rounded-lg overflow-y-auto"
          style={{ maxHeight: 'calc(100vh - 250px)' }}
        >
          <div className="sticky top-0 z-10 bg-atlas-bg border-b-2 border-atlas-border grid grid-cols-[2.5fr_1fr_1fr_1fr_1fr_0.8fr_0.8fr] text-xs text-atlas-muted font-semibold px-3 py-2">
            <div>Produto</div>
            <div>Cliente</div>
            <div>Qtd saída (kg)</div>
            <div>Saída em</div>
            <div>Retorno previsto</div>
            <div className="text-center">Dias</div>
            <div className="text-right">Ação</div>
          </div>

          {filtrados.length === 0 && (
            <div className="text-xs text-atlas-muted italic px-3 py-6 text-center">
              {busca ? 'Nenhum resultado.' : 'Nenhum comodato em aberto.'}
            </div>
          )}

          {filtrados.map((c) => (
            <div
              key={c.movimentacaoId}
              className={`grid grid-cols-[2.5fr_1fr_1fr_1fr_1fr_0.8fr_0.8fr] text-xs border-b border-atlas-border/60 px-3 py-2 hover:bg-atlas-bg/60 items-center ${
                c.vencido ? 'bg-rose-50/50 dark:bg-rose-900/20' : ''
              }`}
            >
              <div>
                <div className="font-medium text-atlas-ink truncate" title={c.produtoDescricao}>
                  {c.produtoDescricao}
                </div>
                <div className="text-[10px] font-mono text-atlas-muted">{c.produtoCodigoAcxe}</div>
              </div>
              <div className="truncate" title={c.cliente ?? ''}>
                {c.cliente ?? '—'}
              </div>
              <div className="font-mono">{fmtKg(c.quantidadeKg)}</div>
              <div className="text-atlas-muted">{fmtData(c.dtSaida)}</div>
              <div className={c.vencido ? 'text-rose-700 dark:text-rose-400 font-semibold' : 'text-atlas-muted'}>
                {fmtData(c.dtPrevistaRetorno)}
              </div>
              <div className="text-center">
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    c.vencido ? 'bg-rose-100 text-rose-800' : 'bg-atlas-muted/20 text-atlas-muted'
                  }`}
                >
                  {c.diasEmAberto}d
                </span>
              </div>
              <div className="text-right">
                <button
                  onClick={() => setComodatoModal(c)}
                  className="px-2.5 py-1 text-[11px] bg-atlas-btn-bg text-atlas-btn-text rounded hover:opacity-90 font-medium"
                >
                  Registrar retorno
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {comodatoModal && (
        <RetornoModal
          comodato={comodatoModal}
          onClose={() => setComodatoModal(null)}
          onSuccess={() => setComodatoModal(null)}
        />
      )}
    </div>
  );
}

interface RetornoModalProps {
  comodato: ComodatoAberto;
  onClose: () => void;
  onSuccess: () => void;
}

interface ProdutoQ2P {
  codigoAcxe: number;
  descricao: string;
}

function RetornoModal({ comodato, onClose, onSuccess }: RetornoModalProps) {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();

  // Default = produto original do comodato. Operador pode trocar via combobox.
  const [produtoSelecionado, setProdutoSelecionado] = useState<ProdutoQ2P>({
    codigoAcxe: comodato.produtoCodigoAcxe,
    descricao: comodato.produtoDescricao,
  });
  const [galpaoDestino, setGalpaoDestino] = useState(comodato.galpaoOrigem);
  const [quantidadeKg, setQuantidadeKg] = useState(String(comodato.quantidadeKg));
  const [observacoes, setObservacoes] = useState('');

  // Galpoes do operador (mesmo endpoint da SaidaManualPage — operador tem acesso).
  // Filtra '90' (TROCA virtual nao recebe retorno).
  const galpoesQuery = useQuery<{ galpoes: string[] }, Error>({
    queryKey: ['sb', 'meu-estoque', 'galpoes', 'q2p'],
    queryFn: async () => {
      const r = await apiFetch('/api/v1/stockbridge/meu-estoque?empresa=Q2P');
      return r.data as { galpoes: string[] };
    },
  });
  const galpoesDisponiveis = useMemo(
    () => (galpoesQuery.data?.galpoes ?? []).filter((g) => !g.startsWith('90')),
    [galpoesQuery.data],
  );

  const qtdNum = parseFloat(quantidadeKg.replace(',', '.'));

  const skuMudou = produtoSelecionado.codigoAcxe !== comodato.produtoCodigoAcxe;
  const qtdMudou = Number.isFinite(qtdNum) && qtdNum !== comodato.quantidadeKg;

  const podeEnviar =
    produtoSelecionado.codigoAcxe > 0 &&
    Number.isFinite(qtdNum) &&
    qtdNum > 0 &&
    galpaoDestino &&
    observacoes.trim().length > 0;

  const mut = useMutation({
    mutationFn: async () =>
      apiFetch(`/api/v1/stockbridge/comodato/${comodato.movimentacaoId}/retorno`, {
        method: 'POST',
        body: JSON.stringify({
          produto_codigo_acxe_recebido: produtoSelecionado.codigoAcxe,
          galpao_destino: galpaoDestino,
          quantidade_kg_recebida: qtdNum,
          observacoes,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sb', 'comodato', 'abertos'] });
      // Atualiza o contador da sidebar (bolinha verde/vermelha) — App.tsx usa
      // uma key diferente porque conta vencidos vs no prazo separadamente.
      queryClient.invalidateQueries({ queryKey: ['stockbridge', 'comodatos', 'count'] });
      onSuccess();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-atlas-card border border-atlas-border rounded-lg shadow-xl max-w-xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-atlas-border">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-serif text-atlas-ink mb-1">Retorno de Comodato</h2>
              <div className="text-sm font-medium text-atlas-ink truncate">{comodato.produtoDescricao}</div>
              <div className="text-[11px] text-atlas-muted">
                Cliente: <strong>{comodato.cliente ?? '—'}</strong> · Saída de{' '}
                <strong>{fmtKg(comodato.quantidadeKg)} kg</strong> em {fmtData(comodato.dtSaida)}
              </div>
            </div>
            <button onClick={onClose} className="text-atlas-muted hover:text-atlas-ink text-xl leading-none px-2">
              ×
            </button>
          </div>
        </div>

        <div className="p-5 space-y-4">
          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded p-3 text-xs text-amber-900 dark:text-amber-200">
            ⚠ O retorno aceita SKU/quantidade diferentes. Diferenças geram divergência para
            justificativa do operador. Aprovação por <strong>gestor</strong>.
          </div>

          <div>
            <label className="block text-xs font-semibold text-atlas-muted mb-1">Produto recebido *</label>
            <ProdutoCombobox
              valor={produtoSelecionado}
              onChange={setProdutoSelecionado}
              destacar={skuMudou}
            />
            {skuMudou && (
              <div className="mt-1 text-[11px] text-amber-700">
                ⚠ Produto diferente do original — vai gerar divergência
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-atlas-muted mb-1">Galpão destino *</label>
            <select
              value={galpaoDestino}
              onChange={(e) => setGalpaoDestino(e.target.value)}
              className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm"
              disabled={galpoesQuery.isLoading}
            >
              <option value="">— selecione —</option>
              {galpoesDisponiveis.map((g) => (
                <option key={g} value={g}>
                  {labelGalpao(g)}
                </option>
              ))}
            </select>
            {galpoesQuery.isLoading && (
              <div className="mt-1 text-[11px] text-atlas-muted">Carregando galpões…</div>
            )}
            {!galpoesQuery.isLoading && galpoesDisponiveis.length === 0 && (
              <div className="mt-1 text-[11px] text-amber-700">
                Você não está vinculado a nenhum galpão Q2P. Solicite ao gestor.
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-atlas-muted mb-1">Quantidade recebida (kg) *</label>
            <input
              value={quantidadeKg}
              onChange={(e) => setQuantidadeKg(e.target.value)}
              placeholder="0,000"
              className={`w-full px-3 py-2 border rounded text-sm font-serif bg-atlas-bg ${
                qtdMudou ? 'border-amber-400' : 'border-atlas-border'
              }`}
            />
            {qtdMudou && (
              <div className="mt-1 text-[11px] text-amber-700">
                ⚠ Diferença vs. original ({fmtKg(comodato.quantidadeKg)} kg): delta{' '}
                {(qtdNum - comodato.quantidadeKg > 0 ? '+' : '') +
                  (qtdNum - comodato.quantidadeKg).toLocaleString('pt-BR', { maximumFractionDigits: 3 })}{' '}
                kg — vai gerar divergência
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-atlas-muted mb-1">Observações *</label>
            <textarea
              value={observacoes}
              onChange={(e) => setObservacoes(e.target.value)}
              rows={3}
              placeholder={
                skuMudou || qtdMudou
                  ? 'Justifique a divergência (SKU/qtd diferentes do comodato original)'
                  : 'Observações sobre o retorno'
              }
              className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm"
            />
          </div>

          {mut.isError && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
              {(mut.error as Error).message}
            </div>
          )}

          {mut.isSuccess && (
            <div className="p-2 bg-green-50 border border-green-200 rounded text-xs text-green-800">
              ✓ Retorno registrado. Aguardando aprovação do gestor.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-atlas-border flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded text-sm border border-atlas-border hover:bg-atlas-bg/60"
          >
            Cancelar
          </button>
          <button
            onClick={() => mut.mutate()}
            disabled={!podeEnviar || mut.isPending}
            className={`px-5 py-2 rounded text-sm font-medium ${
              podeEnviar
                ? 'bg-atlas-btn-bg text-atlas-btn-text hover:opacity-90'
                : 'bg-atlas-muted/20 text-atlas-muted cursor-not-allowed'
            }`}
          >
            {mut.isPending ? 'Enviando...' : 'Registrar retorno'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ProdutoComboboxProps {
  valor: ProdutoQ2P;
  onChange: (p: ProdutoQ2P) => void;
  destacar: boolean;
}

/**
 * Combobox com busca por descricao em tbl_produtos_Q2P. Backend retorna o
 * codigoAcxe canonico via JOIN por descricao. Operador escolhe pela descricao
 * (codigos OMIE internos sao opacos pra ele).
 */
function ProdutoCombobox({ valor, onChange, destacar }: ProdutoComboboxProps) {
  const apiFetch = useApiFetch();
  const [aberto, setAberto] = useState(false);
  const [termo, setTermo] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora
  useEffect(() => {
    if (!aberto) return;
    const onClickFora = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setAberto(false);
      }
    };
    window.addEventListener('mousedown', onClickFora);
    return () => window.removeEventListener('mousedown', onClickFora);
  }, [aberto]);

  // Debounce de 250ms na busca
  const [termoDebounced, setTermoDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTermoDebounced(termo), 250);
    return () => clearTimeout(t);
  }, [termo]);

  const { data: opcoes = [], isFetching } = useQuery<ProdutoQ2P[], Error>({
    queryKey: ['sb', 'produtos-q2p', termoDebounced],
    enabled: aberto,
    queryFn: async () => {
      const url = termoDebounced.trim().length > 0
        ? `/api/v1/stockbridge/produtos-q2p?q=${encodeURIComponent(termoDebounced.trim())}&limit=50`
        : '/api/v1/stockbridge/produtos-q2p?limit=50';
      const r = await apiFetch(url);
      return r.data as ProdutoQ2P[];
    },
  });

  const escolher = (p: ProdutoQ2P) => {
    onChange(p);
    setAberto(false);
    setTermo('');
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className={`w-full px-3 py-2 border rounded text-sm text-left bg-atlas-bg ${
          destacar ? 'border-amber-400' : 'border-atlas-border'
        } hover:border-atlas-muted flex items-center justify-between gap-2`}
      >
        <span className="truncate" title={valor.descricao}>
          {valor.descricao}
        </span>
        <span className="text-atlas-muted text-xs">▾</span>
      </button>

      {aberto && (
        <div className="absolute z-10 mt-1 w-full bg-atlas-card border border-atlas-border rounded shadow-lg max-h-72 overflow-hidden flex flex-col">
          <input
            autoFocus
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            placeholder="Buscar produto pela descrição..."
            className="w-full px-3 py-2 border-b border-atlas-border bg-atlas-bg text-sm focus:outline-none"
          />
          <div className="overflow-y-auto flex-1">
            {isFetching && opcoes.length === 0 && (
              <div className="px-3 py-2 text-xs text-atlas-muted italic">Buscando...</div>
            )}
            {!isFetching && opcoes.length === 0 && (
              <div className="px-3 py-2 text-xs text-atlas-muted italic">Nenhum produto encontrado.</div>
            )}
            {opcoes.map((p) => (
              <button
                key={p.codigoAcxe}
                type="button"
                onClick={() => escolher(p)}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-atlas-bg/60 ${
                  p.codigoAcxe === valor.codigoAcxe ? 'bg-atlas-bg font-medium' : ''
                }`}
              >
                <div className="truncate" title={p.descricao}>{p.descricao}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
