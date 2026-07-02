import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

type Empresa = 'acxe' | 'q2p';
type Subtipo = 'transf_intra_cnpj' | 'comodato' | 'amostra' | 'descarte' | 'quebra' | 'inventario_menos';
type Unidade = 't' | 'kg' | 'saco' | 'bigbag';

interface MeuEstoqueItem {
  empresa: 'ACXE' | 'Q2P';
  codigoEstoque: string;
  descricaoEstoque: string;
  codigoProduto: string;
  /** Codigo numerico ACXE — null se nao houve match na tbl_produtos_ACXE. */
  codigoProdutoAcxe: number | null;
  descricaoProduto: string;
  descricaoFamilia: string | null;
  ncm: string | null;
  saldoKg: number;
  reservadoKg: number;
  volumeTotalKg: number;
}

/** Sub-estoques pos migration 0030 (granularidade .1 importado / .2 nacional). */
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
function labelGalpao(g: string): string {
  return GALPAO_LABELS[g] ?? g;
}

interface MeuEstoqueResponse {
  galpoes: string[];
  principal: MeuEstoqueItem[];
  especiais: MeuEstoqueItem[];
}

interface SaldoDisponivel {
  produtoCodigoAcxe: number;
  galpao: string;
  empresa: Empresa;
  saldoOmieKg: number;
  reservadoKg: number;
  disponivelKg: number;
}

const SUBTIPO_CFG: Record<Subtipo, { label: string; nivel: 'gestor' | 'diretor'; help: string; cor: string }> = {
  transf_intra_cnpj: { label: 'Transferência intra-CNPJ',  nivel: 'gestor',  help: 'Mesmo CNPJ, outro galpão — sem impacto fiscal', cor: 'bg-sky-100 text-sky-800' },
  comodato:          { label: 'Comodato (empréstimo)',     nivel: 'diretor', help: 'Saída temporária pra TROCA — só Q2P; requer diretor', cor: 'bg-purple-100 text-purple-800' },
  amostra:           { label: 'Amostra / brinde',          nivel: 'gestor',  help: 'Saída definitiva sem venda — gera divergência fiscal', cor: 'bg-amber-100 text-amber-800' },
  descarte:          { label: 'Descarte / perda',          nivel: 'gestor',  help: 'Material inutilizável — gera divergência fiscal', cor: 'bg-rose-100 text-rose-800' },
  quebra:            { label: 'Quebra técnica',            nivel: 'gestor',  help: 'Perda no manuseio — gera divergência fiscal', cor: 'bg-orange-100 text-orange-800' },
  inventario_menos:  { label: 'Ajuste inventário (-)',     nivel: 'gestor',  help: 'Contagem apurou saldo menor — gera divergência', cor: 'bg-zinc-100 text-zinc-800' },
};

const fmtKg = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string>),
    };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    const body = (await res.json()) as { data: unknown; error: { message?: string; code?: string } | null };
    if (!res.ok) {
      const err = new Error(body.error?.message ?? 'Erro') as Error & { code?: string };
      err.code = body.error?.code;
      throw err;
    }
    return body;
  };
}

interface SkuSelecionado {
  produtoCodigoAcxe: number;
  descricaoProduto: string;
  saldoOmieKg: number;
  galpao: string;
  empresa: Empresa;
  empresaUI: 'ACXE' | 'Q2P';
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

const TIPO_APROVACAO_LABEL: Record<string, string> = {
  saida_transf_intra: 'Transferência intra-CNPJ',
  saida_comodato: 'Comodato',
  saida_amostra: 'Amostra/Brinde',
  saida_descarte: 'Descarte/Perda',
  saida_quebra: 'Quebra técnica',
  ajuste_inventario: 'Ajuste de inventário',
  retorno_comodato: 'Retorno de Comodato',
};

export function SaidaManualPage() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [empresa, setEmpresa] = useState<Empresa>('q2p');
  const [galpaoSelecionado, setGalpaoSelecionado] = useState<string>('');
  const [busca, setBusca] = useState('');
  const [skuModal, setSkuModal] = useState<SkuSelecionado | null>(null);
  // Quando o modal foi aberto via "Lancar novamente" de uma rejeicao, guarda
  // o id pra dispensar automaticamente apos o sucesso da nova saida.
  const [rejeicaoOrigemId, setRejeicaoOrigemId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tipo: 'sucesso' | 'erro'; texto: string } | null>(null);

  const empresaUI = empresa === 'acxe' ? 'ACXE' : 'Q2P';

  // Toast: limpa após 5s
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 5000);
    return () => clearTimeout(t);
  }, [feedback]);

  const meuEstoque = useQuery<MeuEstoqueResponse, Error & { code?: string }>({
    queryKey: ['sb', 'saida-manual', 'estoque', empresaUI],
    queryFn: async () => {
      const r = await apiFetch(`/api/v1/stockbridge/meu-estoque?empresa=${empresaUI}`);
      return r.data as MeuEstoqueResponse;
    },
  });

  // Saidas manuais rejeitadas pelo operador (sem lote — comodato/ajuste/descarte/etc).
  // Mesmo modelo da FilaOmiePage para recebimento divergente.
  const { data: rejeicoes = [] } = useQuery<MinhaRejeicao[]>({
    queryKey: ['sb', 'minhas-rejeicoes', 'saida-manual'],
    queryFn: async () => {
      const r = await apiFetch('/api/v1/stockbridge/aprovacoes/minhas-rejeicoes');
      const todas = r.data as MinhaRejeicao[];
      // Saida manual: sem lote e nao sendo entrada_manual (recebimento nacional vai pro Recebimento)
      return todas.filter((it) => it.loteId === null && it.tipoAprovacao !== 'entrada_manual');
    },
  });

  // Soft-dismiss: tira a rejeicao da inbox sem mexer em status/audit (migration 0029).
  const dispensarMut = useMutation({
    mutationFn: async (rejeicaoId: string) =>
      apiFetch(`/api/v1/stockbridge/aprovacoes/${rejeicaoId}/dispensar`, { method: 'POST' }),
    onSuccess: () => {
      // Atualiza tanto a lista local quanto o contador da sidebar.
      queryClient.invalidateQueries({ queryKey: ['sb', 'minhas-rejeicoes', 'saida-manual'] });
      queryClient.invalidateQueries({ queryKey: ['stockbridge', 'minhas-rejeicoes', 'count'] });
    },
    onError: (err) =>
      setFeedback({ tipo: 'erro', texto: `Erro ao descartar: ${(err as Error).message}` }),
  });

  // Re-lanca uma saida rejeitada: seta filtros + abre modal pre-populado.
  // Nao "edita" a rejeicao — cria uma saida nova do zero (a rejeicao fica
  // arquivada com status='rejeitada' para auditoria). Apos o sucesso da nova
  // saida, dispensa automaticamente a rejeicao original (vide onSucessoSaida).
  const handleRelancarRejeicao = (r: MinhaRejeicao) => {
    if (!r.galpao || !r.empresa) return;
    setEmpresa(r.empresa);
    setGalpaoSelecionado(r.galpao);
    setRejeicaoOrigemId(r.id);
    setSkuModal({
      produtoCodigoAcxe: r.produtoCodigoAcxe,
      descricaoProduto: r.fornecedor,
      saldoOmieKg: 0, // saldoQuery dentro do modal vai buscar o real
      galpao: r.galpao,
      empresa: r.empresa,
      empresaUI: r.empresa === 'acxe' ? 'ACXE' : 'Q2P',
    });
  };

  // Auto-abrir o modal quando o email manda o operador para
  // /stockbridge/saida-manual#rejeicao=<id>. Mesmo guard pattern da FilaOmiePage.
  const hashHandledRef = useRef(false);
  useEffect(() => {
    if (hashHandledRef.current || rejeicoes.length === 0) return;
    const hash = window.location.hash;
    const match = hash.match(/^#rejeicao=([0-9a-f-]{36})$/i);
    if (!match) {
      hashHandledRef.current = true;
      return;
    }
    const targetId = match[1]!.toLowerCase();
    const target = rejeicoes.find((r) => r.id.toLowerCase() === targetId);
    if (target) {
      hashHandledRef.current = true;
      handleRelancarRejeicao(target);
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, [rejeicoes]);

  // Auto-seleciona primeiro galpao quando carrega
  useEffect(() => {
    if (meuEstoque.data?.galpoes.length && !galpaoSelecionado) {
      setGalpaoSelecionado(meuEstoque.data.galpoes[0] ?? '');
    }
  }, [meuEstoque.data, galpaoSelecionado]);

  // Filtra itens pelo galpao selecionado
  const itensFiltrados = useMemo(() => {
    if (!meuEstoque.data) return [];
    const todos = [...meuEstoque.data.principal];
    return todos
      .filter((it) => {
        if (galpaoSelecionado && it.codigoEstoque !== galpaoSelecionado) return false;
        if (busca) {
          const b = busca.toLowerCase();
          if (
            !it.descricaoProduto.toLowerCase().includes(b) &&
            !it.codigoProduto.includes(busca) &&
            !(it.descricaoFamilia?.toLowerCase().includes(b) ?? false)
          )
            return false;
        }
        return it.saldoKg > 0;
      })
      .sort((a, b) => b.saldoKg - a.saldoKg);
  }, [meuEstoque.data, galpaoSelecionado, busca]);

  // Agrupa por SKU (mesmo SKU em estoques diferentes do galpao soma).
  // Usa o codigoProdutoAcxe (numerico, vindo do backend via JOIN tbl_produtos_ACXE)
  // como chave canonica — o codigo da view varia por empresa.
  const skusAgrupados = useMemo(() => {
    const m = new Map<
      number,
      { codigoProdutoAcxe: number; descricaoProduto: string; familia: string | null; saldoTotal: number }
    >();
    for (const it of itensFiltrados) {
      if (it.codigoProdutoAcxe == null) continue; // sem match na tbl_produtos_ACXE — pula
      const existente = m.get(it.codigoProdutoAcxe);
      if (existente) existente.saldoTotal += it.saldoKg;
      else
        m.set(it.codigoProdutoAcxe, {
          codigoProdutoAcxe: it.codigoProdutoAcxe,
          descricaoProduto: it.descricaoProduto,
          familia: it.descricaoFamilia,
          saldoTotal: it.saldoKg,
        });
    }
    return Array.from(m.values()).sort((a, b) => b.saldoTotal - a.saldoTotal);
  }, [itensFiltrados]);

  const onSucessoSaida = (info: { subtipo: Subtipo; nivel: 'gestor' | 'diretor'; descricao: string; qtdKg: number }) => {
    setSkuModal(null);
    setFeedback({
      tipo: 'sucesso',
      texto: `✓ Saída de ${info.qtdKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg de "${info.descricao}" registrada. Aguardando aprovação do ${info.nivel}.`,
    });
    queryClient.invalidateQueries({ queryKey: ['sb', 'saida-manual'] });
    queryClient.invalidateQueries({ queryKey: ['sb', 'meu-estoque'] });
    // Se o operador re-lancou a partir de uma rejeicao, dispensa a antiga
    // automaticamente — ela cumpriu seu papel (avisar) e nao deve mais aparecer.
    if (rejeicaoOrigemId) {
      dispensarMut.mutate(rejeicaoOrigemId);
      setRejeicaoOrigemId(null);
    }
  };

  return (
    <div className="p-6">
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
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Saída Manual</h1>
        <p className="text-sm text-atlas-muted">
          Selecione o material no estoque e registre a saída. Toda saída passa por aprovação de gestor
          (ou diretor, no caso de comodato) — o saldo só é debitado no OMIE após aprovação.
        </p>
      </div>

      {/* Filtros */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-semibold text-atlas-muted mb-1">Empresa</label>
          <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 rounded p-1">
            {(['acxe', 'q2p'] as Empresa[]).map((e) => (
              <button
                key={e}
                onClick={() => {
                  setEmpresa(e);
                  setGalpaoSelecionado('');
                }}
                className={`px-3 py-1 text-xs rounded font-medium ${
                  empresa === e ? 'bg-white dark:bg-slate-700 shadow-sm' : 'text-atlas-muted'
                }`}
              >
                {e.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-atlas-muted mb-1">Galpão</label>
          <select
            value={galpaoSelecionado}
            onChange={(e) => setGalpaoSelecionado(e.target.value)}
            className="px-3 py-1.5 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
            disabled={!meuEstoque.data}
          >
            <option value="">— selecione —</option>
            {meuEstoque.data?.galpoes.map((g) => (
              <option key={g} value={g}>
                {labelGalpao(g)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-semibold text-atlas-muted mb-1">Buscar SKU/produto</label>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="código, descrição ou família"
            className="w-full px-3 py-1.5 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
          />
        </div>
      </div>

      {meuEstoque.isLoading && <div className="text-sm text-atlas-muted">Carregando estoque...</div>}
      {meuEstoque.error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          Erro: {meuEstoque.error.message}
        </div>
      )}

      {meuEstoque.data && (
        <div
          className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-y-auto"
          style={{ maxHeight: 'calc(100vh - 280px)' }}
        >
          <div className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-900 border-b-2 border-slate-300 dark:border-slate-600 grid grid-cols-[3fr_1.5fr_1fr_1fr] text-xs text-atlas-muted font-semibold px-3 py-2">
            <div>Produto</div>
            <div>Família</div>
            <div className="text-right">Saldo (kg)</div>
            <div className="text-right">Ação</div>
          </div>

          {skusAgrupados.length === 0 && (
            <div className="text-xs text-atlas-muted italic px-3 py-6 text-center">
              {galpaoSelecionado ? 'Nenhum SKU com saldo nesse galpão.' : 'Selecione um galpão para listar SKUs.'}
            </div>
          )}

          {skusAgrupados.map((s) => (
            <div
              key={s.codigoProdutoAcxe}
              className="grid grid-cols-[3fr_1.5fr_1fr_1fr] text-xs border-b border-slate-100 dark:border-slate-700/60 px-3 py-2 hover:bg-slate-50/60 dark:hover:bg-slate-900/30 items-center"
            >
              <div>
                <div className="font-medium text-atlas-ink truncate" title={s.descricaoProduto}>
                  {s.descricaoProduto}
                </div>
                <div className="text-[10px] font-mono text-atlas-muted">SKU {s.codigoProdutoAcxe}</div>
              </div>
              <div className="text-atlas-muted truncate">{s.familia ?? '—'}</div>
              <div className="text-right font-mono">{fmtKg(s.saldoTotal)}</div>
              <div className="text-right">
                <button
                  onClick={() =>
                    setSkuModal({
                      produtoCodigoAcxe: s.codigoProdutoAcxe,
                      descricaoProduto: s.descricaoProduto,
                      saldoOmieKg: s.saldoTotal,
                      galpao: galpaoSelecionado,
                      empresa,
                      empresaUI,
                    })
                  }
                  className="px-2.5 py-1 text-[11px] bg-atlas-btn-bg text-atlas-btn-text rounded hover:opacity-90 font-medium"
                >
                  Registrar saída
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {skuModal && (
        <SaidaManualModal
          sku={skuModal}
          onClose={() => {
            setSkuModal(null);
            setRejeicaoOrigemId(null);
          }}
          onSuccess={onSucessoSaida}
          galpoesDisponiveis={meuEstoque.data?.galpoes ?? []}
        />
      )}

      {rejeicoes.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-serif text-atlas-ink mb-2">
            Lançamentos rejeitados ({rejeicoes.length})
          </h2>
          <p className="text-xs text-atlas-muted mb-3">
            Saídas que foram rejeitadas pelo gestor. Ajuste o que for necessário e lance novamente.
          </p>
          <div className="flex flex-col gap-2">
            {rejeicoes.map((r) => (
              <div
                key={r.id}
                className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 mb-0.5 flex-wrap">
                    <span className="text-xs font-semibold px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-700">
                      {TIPO_APROVACAO_LABEL[r.tipoAprovacao] ?? r.tipoAprovacao}
                    </span>
                    <span className="font-serif text-base text-atlas-ink truncate">{r.fornecedor}</span>
                    <span className="text-xs text-atlas-muted">
                      SKU {r.produtoCodigoAcxe}
                      {r.galpao && <> · {labelGalpao(r.galpao)}</>}
                      {r.empresa && <> · {r.empresa.toUpperCase()}</>}
                    </span>
                  </div>
                  <div className="text-xs text-red-700 dark:text-red-300 italic truncate">
                    "{r.motivoRejeicao || 'sem motivo registrado'}"
                  </div>
                </div>
                <div className="text-right text-xs text-atlas-muted whitespace-nowrap">
                  {fmtKg(r.quantidadeRecebidaKg)} kg<br />
                  rejeitado em {new Date(r.rejeitadoEm).toLocaleDateString('pt-BR')}
                </div>
                <div className="flex flex-col gap-1.5 whitespace-nowrap">
                  {r.galpao && r.empresa ? (
                    <button
                      onClick={() => handleRelancarRejeicao(r)}
                      disabled={dispensarMut.isPending}
                      className="px-3 py-1.5 bg-atlas-btn-bg text-atlas-btn-text rounded text-xs font-medium hover:opacity-90"
                    >
                      Lançar novamente →
                    </button>
                  ) : null}
                  <button
                    onClick={() => {
                      if (confirm(`Descartar esta rejeição da sua caixa de entrada?\n\nO histórico permanece para auditoria — você só não vai ver mais aqui.`)) {
                        dispensarMut.mutate(r.id);
                      }
                    }}
                    disabled={dispensarMut.isPending}
                    className="px-3 py-1.5 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 rounded text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Descartar
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface SaidaManualModalProps {
  sku: SkuSelecionado;
  onClose: () => void;
  onSuccess: (info: { subtipo: Subtipo; nivel: 'gestor' | 'diretor'; descricao: string; qtdKg: number }) => void;
  galpoesDisponiveis: string[];
}

function SaidaManualModal({ sku, onClose, onSuccess, galpoesDisponiveis }: SaidaManualModalProps) {
  const apiFetch = useApiFetch();

  // Comodato disponivel pra ACXE e Q2P (TROCA criada nas duas — migration 0027)
  const subtiposPermitidos: Subtipo[] = ['transf_intra_cnpj', 'comodato', 'amostra', 'descarte', 'quebra', 'inventario_menos'];

  const [subtipo, setSubtipo] = useState<Subtipo>('descarte');
  const [quantidade, setQuantidade] = useState('');
  const [unidade, setUnidade] = useState<Unidade>('kg');
  const [galpaoDestino, setGalpaoDestino] = useState('');
  const [dtPrevistaRetorno, setDtPrevistaRetorno] = useState('');
  const [cliente, setCliente] = useState('');
  const [observacoes, setObservacoes] = useState('');

  const cfg = SUBTIPO_CFG[subtipo];

  // Saldo disponivel real (OMIE - reservas) — atualiza ao montar
  const saldoQuery = useQuery<SaldoDisponivel, Error>({
    queryKey: ['sb', 'saida-manual', 'saldo', sku.produtoCodigoAcxe, sku.galpao, sku.empresa],
    queryFn: async () => {
      const r = await apiFetch(
        `/api/v1/stockbridge/saida-manual/saldo-disponivel?empresa=${sku.empresa}&galpao=${sku.galpao}&produto_codigo_acxe=${sku.produtoCodigoAcxe}`,
      );
      return r.data as SaldoDisponivel;
    },
  });

  const saldoDisponivelKg = saldoQuery.data?.disponivelKg ?? sku.saldoOmieKg;

  const qtdNum = parseFloat(quantidade.replace(',', '.'));
  const qtdEmKg = useMemo(() => {
    if (!Number.isFinite(qtdNum) || qtdNum <= 0) return 0;
    if (unidade === 't' || unidade === 'bigbag') return qtdNum * 1000;
    if (unidade === 'saco') return qtdNum * 25;
    return qtdNum;
  }, [qtdNum, unidade]);
  const saldoSuficiente = qtdEmKg > 0 && qtdEmKg <= saldoDisponivelKg;

  const podeEnviar = useMemo(() => {
    if (!saldoSuficiente) return false;
    if (observacoes.trim().length === 0) return false;
    if (subtipo === 'transf_intra_cnpj' && (!galpaoDestino || galpaoDestino === sku.galpao)) return false;
    if (subtipo === 'comodato' && (!dtPrevistaRetorno || cliente.trim().length === 0)) return false;
    return true;
  }, [saldoSuficiente, observacoes, subtipo, galpaoDestino, sku.galpao, dtPrevistaRetorno, cliente]);

  const mut = useMutation({
    mutationFn: async () =>
      apiFetch('/api/v1/stockbridge/saida-manual', {
        method: 'POST',
        body: JSON.stringify({
          subtipo,
          produto_codigo_acxe: sku.produtoCodigoAcxe,
          galpao: sku.galpao,
          empresa: sku.empresa,
          quantidade_original: qtdNum,
          unidade,
          galpao_destino: subtipo === 'transf_intra_cnpj' ? galpaoDestino : null,
          dt_prevista_retorno: subtipo === 'comodato' ? dtPrevistaRetorno : null,
          cliente: subtipo === 'comodato' ? cliente : null,
          observacoes,
        }),
      }),
    onSuccess: () =>
      onSuccess({
        subtipo,
        nivel: cfg.nivel,
        descricao: sku.descricaoProduto,
        qtdKg: qtdEmKg,
      }),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl max-w-xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-serif text-atlas-ink mb-1">Registrar saída</h2>
              <div className="text-sm font-medium text-atlas-ink truncate">{sku.descricaoProduto}</div>
              <div className="text-[11px] text-atlas-muted">
                SKU <span className="font-mono">{sku.produtoCodigoAcxe}</span> ·{' '}
                <strong>{labelGalpao(sku.galpao)}</strong> · Empresa{' '}
                <strong>{sku.empresaUI}</strong>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-atlas-muted hover:text-atlas-ink text-xl leading-none px-2"
            >
              ×
            </button>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <div className="bg-slate-50 dark:bg-slate-900 rounded p-2">
              <div className="text-[10px] text-atlas-muted">Saldo OMIE</div>
              <div className="font-mono font-medium">{fmtKg(saldoQuery.data?.saldoOmieKg ?? sku.saldoOmieKg)} kg</div>
            </div>
            <div className="bg-slate-50 dark:bg-slate-900 rounded p-2">
              <div className="text-[10px] text-atlas-muted">Reservado (pendentes)</div>
              <div className="font-mono font-medium">{fmtKg(saldoQuery.data?.reservadoKg ?? 0)} kg</div>
            </div>
            <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded p-2">
              <div className="text-[10px] text-atlas-muted">Disponível</div>
              <div className="font-mono font-semibold text-emerald-700 dark:text-emerald-300">
                {fmtKg(saldoDisponivelKg)} kg
              </div>
            </div>
          </div>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-atlas-muted mb-1">Tipo de saída *</label>
            <select
              value={subtipo}
              onChange={(e) => setSubtipo(e.target.value as Subtipo)}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
            >
              {subtiposPermitidos.map((s) => (
                <option key={s} value={s}>
                  {SUBTIPO_CFG[s].label}
                </option>
              ))}
            </select>
            <div className="mt-1 text-xs text-atlas-muted">{cfg.help}</div>
            <div className={`mt-1 inline-block text-[10px] px-1.5 py-0.5 rounded font-semibold ${cfg.cor}`}>
              Aprova {cfg.nivel.toUpperCase()}
            </div>
          </div>

          <div className="grid grid-cols-[2fr_1fr] gap-2">
            <div>
              <label className="block text-xs font-semibold text-atlas-muted mb-1">Quantidade *</label>
              <input
                value={quantidade}
                onChange={(e) => setQuantidade(e.target.value)}
                placeholder="0,000"
                className={`w-full px-3 py-2 border rounded text-sm font-serif dark:bg-slate-900 ${
                  qtdEmKg > saldoDisponivelKg && qtdEmKg > 0
                    ? 'border-red-400'
                    : 'border-slate-300 dark:border-slate-600'
                }`}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-atlas-muted mb-1">Unidade</label>
              <select
                value={unidade}
                onChange={(e) => setUnidade(e.target.value as Unidade)}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
              >
                <option value="kg">kg</option>
                <option value="t">t</option>
                <option value="saco">saco (25 kg)</option>
                <option value="bigbag">big bag (1 t)</option>
              </select>
            </div>
          </div>
          {qtdEmKg > 0 && (
            <div className={`text-[11px] ${qtdEmKg > saldoDisponivelKg ? 'text-red-600' : 'text-atlas-muted'}`}>
              {qtdEmKg > saldoDisponivelKg
                ? `Excede o disponível (${fmtKg(saldoDisponivelKg)} kg)`
                : `Equivale a ${fmtKg(qtdEmKg)} kg`}
            </div>
          )}

          {subtipo === 'transf_intra_cnpj' && (
            <div>
              <label className="block text-xs font-semibold text-atlas-muted mb-1">Galpão destino *</label>
              <select
                value={galpaoDestino}
                onChange={(e) => setGalpaoDestino(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
              >
                <option value="">— selecione —</option>
                {galpoesDisponiveis
                  .filter((g) => g !== sku.galpao)
                  .map((g) => (
                    <option key={g} value={g}>
                      {labelGalpao(g)}
                    </option>
                  ))}
              </select>
            </div>
          )}

          {subtipo === 'comodato' && (
            <>
              <div>
                <label className="block text-xs font-semibold text-atlas-muted mb-1">Cliente / destinatário *</label>
                <input
                  value={cliente}
                  onChange={(e) => setCliente(e.target.value)}
                  placeholder="Nome do cliente"
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-atlas-muted mb-1">Data prevista de retorno *</label>
                <input
                  type="date"
                  value={dtPrevistaRetorno}
                  onChange={(e) => setDtPrevistaRetorno(e.target.value)}
                  min={new Date().toISOString().slice(0, 10)}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-semibold text-atlas-muted mb-1">Motivo / observações *</label>
            <textarea
              value={observacoes}
              onChange={(e) => setObservacoes(e.target.value)}
              rows={3}
              placeholder="Explique o motivo da saída (obrigatório)"
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
            />
          </div>

          {mut.isError && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
              {(mut.error as Error).message}
            </div>
          )}

          {mut.isSuccess && (
            <div className="p-2 bg-green-50 border border-green-200 rounded text-xs text-green-800">
              ✓ Saída registrada. Aguardando aprovação de {cfg.nivel}.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded text-sm border border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700"
          >
            Cancelar
          </button>
          <button
            onClick={() => mut.mutate()}
            disabled={!podeEnviar || mut.isPending}
            className={`px-5 py-2 rounded text-sm font-medium ${
              podeEnviar
                ? 'bg-atlas-btn-bg text-atlas-btn-text hover:opacity-90'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            {mut.isPending ? 'Enviando...' : 'Registrar saída'}
          </button>
        </div>
      </div>
    </div>
  );
}
