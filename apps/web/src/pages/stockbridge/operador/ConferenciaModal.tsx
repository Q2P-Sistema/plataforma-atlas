import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { Modal } from '@atlas/ui';
import { useAuthStore } from '../../../stores/auth.store.js';

type Unidade = 't' | 'kg' | 'saco' | 'bigbag';

const FATOR_KG: Record<Unidade, number> = { t: 1000, kg: 1, saco: 25, bigbag: 1000 };

interface FilaItem {
  nf: string;
  cnpj: 'acxe' | 'q2p';
  produto: { codigo: number; nome: string };
  qtdOriginal: number;
  unidade: Unidade;
  qtdKg: number;
  localidadeCodigo: string;
  custoBrl: number;
}

interface Props {
  /** Feature 013: TODOS os produtos da NF (1..N) — o recebimento é da nota inteira. */
  itens: FilaItem[];
  onClose: () => void;
  onSucesso: () => void;
}

interface Localidade {
  id: string;
  codigo: string;
  nome: string;
  ativo: boolean;
}

/** Estado editável de um item da conferência (uma linha da NF). */
interface ItemForm {
  produtoCodigo: number;
  qtdInput: string;
  unidadeInput: Unidade;
  localidadeId: string;
  obs: string;
  tipoDivergencia: 'faltando' | 'varredura';
}

interface ItemResultado {
  produtoCodigoAcxe: number;
  produto: string;
  status: 'provisorio' | 'aguardando_aprovacao' | 'pendente_q2p' | 'falha_acxe' | 'ja_recebido';
  deltaKg?: number;
  mensagemErro?: string;
}

interface RecebimentoResult {
  nf: string;
  itens: ItemResultado[];
  resumo: { recebidos: number; aguardandoAprovacao: number; pendentesOmie: number; falhas: number; jaRecebidos: number };
}

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

const STATUS_RESULTADO: Record<ItemResultado['status'], { icone: typeof CheckCircle2; classe: string; label: (r: ItemResultado) => string }> = {
  provisorio: {
    icone: CheckCircle2,
    classe: 'text-green-700 dark:text-green-400',
    label: () => 'Recebido — estoque ajustado em ACXE + Q2P',
  },
  aguardando_aprovacao: {
    icone: AlertTriangle,
    classe: 'text-amber-700 dark:text-amber-400',
    label: (r) => `Divergência de ${Math.abs(r.deltaKg ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg — encaminhado para aprovação do gestor`,
  },
  pendente_q2p: {
    icone: Clock,
    classe: 'text-amber-700 dark:text-amber-400',
    label: () => 'Parcial: ACXE registrado, Q2P pendente — retente pelo painel de Movimentações',
  },
  falha_acxe: {
    icone: XCircle,
    classe: 'text-red-700 dark:text-red-400',
    label: () => 'Falha no OMIE ACXE — nada foi gravado deste produto; busque a NF novamente para completar',
  },
  ja_recebido: {
    icone: CheckCircle2,
    classe: 'text-atlas-muted',
    label: () => 'Já recebido anteriormente — nada a fazer',
  },
};

export function ConferenciaModal({ itens, onClose, onSucesso }: Props) {
  const apiFetch = useApiFetch();
  // Sempre inicia em Kg (convenção do projeto) — nunca herdar a unidade original da
  // NF (ex.: 't'), senão um operador que edita a quantidade pensando em Kg mas não
  // troca o seletor faz o backend multiplicar por 1000 (ACXEGDP-176).
  const [forms, setForms] = useState<ItemForm[]>(() =>
    itens.map((it) => ({
      produtoCodigo: it.produto.codigo,
      qtdInput: String(it.qtdKg),
      unidadeInput: 'kg' as Unidade,
      localidadeId: '',
      obs: '',
      tipoDivergencia: 'faltando' as const,
    })),
  );
  const [resultado, setResultado] = useState<RecebimentoResult | null>(null);

  const nf = itens[0]!.nf;
  const cnpj = itens[0]!.cnpj;
  const multiItem = itens.length > 1;

  const { data: localidades = [] } = useQuery<Localidade[]>({
    queryKey: ['stockbridge', 'localidades', 'espelhadas'],
    queryFn: async () => {
      const body = await apiFetch('/api/v1/stockbridge/localidades?ativo=true&espelhadas=true');
      return body.data as Localidade[];
    },
  });

  function atualizar(produtoCodigo: number, patch: Partial<ItemForm>) {
    setForms((prev) => prev.map((f) => (f.produtoCodigo === produtoCodigo ? { ...f, ...patch } : f)));
  }

  // Cálculo por item: qtd física em kg, delta vs NF, divergência (tolerância 1 kg)
  const calculados = useMemo(
    () =>
      forms.map((f) => {
        const item = itens.find((i) => i.produto.codigo === f.produtoCodigo)!;
        const n = parseFloat(f.qtdInput.replace(',', '.'));
        const qtdFisicaKg = Number.isFinite(n) ? n * FATOR_KG[f.unidadeInput] : 0;
        const deltaKg = qtdFisicaKg - item.qtdKg;
        const temDivergencia = Math.abs(deltaKg) > 1;
        // Legado so aceita "recebido < NF" (delta negativo) — excedente nao e tratado
        const excedente = deltaKg > 1 && qtdFisicaKg > 0;
        const motivoObrigatorio = temDivergencia && qtdFisicaKg > 0;
        const valido = qtdFisicaKg > 0 && !!f.localidadeId && !excedente && (!motivoObrigatorio || f.obs.trim().length > 0);
        return { form: f, item, qtdFisicaKg, deltaKg, temDivergencia, excedente, motivoObrigatorio, valido };
      }),
    [forms, itens],
  );

  const podeConfirmar = calculados.every((c) => c.valido);
  const totalDivergentes = calculados.filter((c) => c.temDivergencia && c.qtdFisicaKg > 0).length;

  const recebimentoMut = useMutation({
    mutationFn: async () =>
      apiFetch('/api/v1/stockbridge/recebimento', {
        method: 'POST',
        body: JSON.stringify({
          nf,
          cnpj,
          itens: calculados.map((c) => ({
            produto_codigo_acxe: c.form.produtoCodigo,
            quantidade_input: parseFloat(c.form.qtdInput.replace(',', '.')),
            unidade_input: c.form.unidadeInput,
            localidade_id: c.form.localidadeId,
            observacoes: c.form.obs || undefined,
            tipo_divergencia: c.temDivergencia ? c.form.tipoDivergencia : undefined,
          })),
        }),
      }),
    onSuccess: (res) => {
      setResultado(res.data as RecebimentoResult);
    },
  });

  if (resultado) {
    const tudoOk = resultado.resumo.pendentesOmie === 0 && resultado.resumo.falhas === 0;
    return (
      <Modal open title={`Recebimento — NF ${resultado.nf}`} onClose={() => { onClose(); onSucesso(); }}>
        <div className="py-2">
          <div className="mb-4 flex justify-center">
            {tudoOk ? (
              <CheckCircle2 size={44} className="text-success" aria-hidden />
            ) : (
              <AlertTriangle size={44} className="text-warn" aria-hidden />
            )}
          </div>
          <ul className="space-y-2 mb-4">
            {resultado.itens.map((r) => {
              const cfg = STATUS_RESULTADO[r.status];
              const Icone = cfg.icone;
              return (
                <li key={r.produtoCodigoAcxe} className="flex items-start gap-2 p-2 bg-atlas-bg rounded text-sm">
                  <Icone size={18} className={`${cfg.classe} mt-0.5 shrink-0`} aria-hidden />
                  <div>
                    <div className="font-medium text-atlas-ink">{r.produto}</div>
                    <div className={`text-xs ${cfg.classe}`}>{cfg.label(r)}</div>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="text-center">
            <button
              onClick={() => { onClose(); onSucesso(); }}
              className="px-5 py-2 bg-atlas-btn-bg text-atlas-btn-text rounded text-sm font-medium"
            >
              Fechar
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      title={multiItem ? `Conferência — NF ${nf} (${itens.length} produtos)` : `Conferência — ${itens[0]!.produto.nome}`}
      onClose={onClose}
    >
      <div className="space-y-4">
        <div className="p-3 bg-atlas-bg rounded text-sm">
          <div className="flex justify-between mb-1"><span className="text-atlas-muted">NF:</span><span className="font-mono">{nf}</span></div>
          <div className="flex justify-between"><span className="text-atlas-muted">CNPJ:</span><span>{cnpj.toUpperCase()}</span></div>
          {multiItem && (
            <div className="mt-2 pt-2 border-t border-atlas-border text-xs text-atlas-muted">
              A NF é recebida por inteiro: confira a quantidade física e o destino de cada produto abaixo.
            </div>
          )}
        </div>

        {calculados.map(({ form, item, qtdFisicaKg, deltaKg, temDivergencia, excedente, motivoObrigatorio }) => (
          <div
            key={form.produtoCodigo}
            className={multiItem ? 'border border-atlas-border rounded-lg p-3 space-y-3' : 'space-y-4'}
          >
            {multiItem && (
              <div className="flex items-baseline justify-between">
                <span className="font-serif text-atlas-ink">{item.produto.nome}</span>
                <span className="text-xs text-atlas-muted">
                  NF: {item.qtdKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg
                </span>
              </div>
            )}
            {!multiItem && (
              <div className="flex justify-between text-sm">
                <span className="text-atlas-muted">Qtd NF:</span>
                <span className="font-semibold">
                  {item.qtdKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg{' '}
                  <span className="text-xs text-atlas-muted font-normal">({(item.qtdKg / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} t)</span>
                </span>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-atlas-muted mb-1">Quantidade física recebida</label>
              <div className="grid grid-cols-[2fr_1fr] gap-2">
                <input
                  value={form.qtdInput}
                  onChange={(e) => atualizar(form.produtoCodigo, { qtdInput: e.target.value })}
                  className={`w-full px-3 py-2 border rounded text-lg font-serif outline-none ${temDivergencia && qtdFisicaKg > 0 ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20' : 'border-atlas-border'}`}
                />
                <select
                  value={form.unidadeInput}
                  onChange={(e) => atualizar(form.produtoCodigo, { unidadeInput: e.target.value as Unidade })}
                  className="px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm outline-none"
                >
                  <option value="t">t (tonelada)</option>
                  <option value="kg">kg</option>
                  <option value="saco">saco (25 kg)</option>
                  <option value="bigbag">big bag (1 t)</option>
                </select>
              </div>
              {qtdFisicaKg > 0 && form.unidadeInput !== 'kg' && (
                <div className="text-xs font-medium text-amber-700 dark:text-amber-400 mt-1">
                  Confirme a conversão: {form.qtdInput} {form.unidadeInput} = {qtdFisicaKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg
                </div>
              )}
            </div>

            {qtdFisicaKg > 0 && (
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="p-2 bg-atlas-bg rounded">
                  <div className="text-xs text-atlas-muted">NF</div>
                  <div className="font-serif text-sm">{item.qtdKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg</div>
                </div>
                <div className="p-2 bg-atlas-bg rounded">
                  <div className="text-xs text-atlas-muted">Recebido</div>
                  <div className={`font-serif text-sm ${temDivergencia ? 'text-amber-700 dark:text-amber-400' : 'text-green-700 dark:text-green-400'}`}>{qtdFisicaKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg</div>
                </div>
                <div className="p-2 bg-atlas-bg rounded">
                  <div className="text-xs text-atlas-muted">Diferença</div>
                  <div className={`font-serif text-sm ${Math.abs(deltaKg) < 1 ? 'text-green-700 dark:text-green-400' : deltaKg > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-red-700 dark:text-red-400'}`}>
                    {deltaKg > 0 ? '+' : ''}{deltaKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg
                  </div>
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-atlas-muted mb-1">Localidade destino *</label>
              <select
                value={form.localidadeId}
                onChange={(e) => atualizar(form.produtoCodigo, { localidadeId: e.target.value })}
                className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm"
              >
                <option value="">— Selecione —</option>
                {localidades.filter((l) => l.ativo).map((l) => (
                  <option key={l.id} value={l.id}>{l.codigo} — {l.nome}</option>
                ))}
              </select>
              {localidades.length === 0 && (
                <div className="text-xs text-atlas-muted mt-1">
                  Nenhuma localidade ativa cadastrada. Peça ao gestor para cadastrar na tela de Localidades.
                </div>
              )}
            </div>

            {motivoObrigatorio && (
              <div>
                <label className="block text-xs font-semibold text-atlas-muted mb-1">Tipo de divergência *</label>
                <select
                  value={form.tipoDivergencia}
                  onChange={(e) => atualizar(form.produtoCodigo, { tipoDivergencia: e.target.value as 'faltando' | 'varredura' })}
                  className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm"
                >
                  <option value="faltando">Faltando — material não chegou (vai para ACXE-COMEX-FALTANDO)</option>
                  <option value="varredura">Varredura — material para inspeção (vai para ACXE-VARREDURA)</option>
                </select>
                <div className="text-[11px] text-atlas-muted mt-1">
                  Os {Math.abs(deltaKg).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg divergentes serão transferidos do Extrema para o estoque especial conforme o tipo escolhido.
                </div>
              </div>
            )}

            {excedente && (
              <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 rounded text-sm text-red-800 dark:text-red-300">
                Quantidade recebida não pode ser maior que a NF. Se houve excedente, registre o recebimento normal e depois lance uma <strong>entrada manual</strong> para a diferença.
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-atlas-muted mb-1">
                {motivoObrigatorio ? 'Motivo da divergência (obrigatório)' : 'Observação (opcional)'}
              </label>
              <textarea
                value={form.obs}
                onChange={(e) => atualizar(form.produtoCodigo, { obs: e.target.value })}
                rows={multiItem ? 2 : 3}
                placeholder={motivoObrigatorio ? 'Ex: 2 big bags avariados na conferência física' : 'Material conferido, embalagens íntegras'}
                className={`w-full px-3 py-2 border rounded text-sm outline-none ${motivoObrigatorio && !form.obs.trim() ? 'border-red-400 bg-red-50 dark:border-red-600 dark:bg-red-900/20' : 'border-atlas-border'}`}
              />
            </div>
          </div>
        ))}

        {recebimentoMut.isError && (
          <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 rounded text-sm text-red-800 dark:text-red-300">
            {(recebimentoMut.error as Error).message}
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border border-atlas-border rounded text-sm">Cancelar</button>
          <button
            onClick={() => recebimentoMut.mutate()}
            disabled={!podeConfirmar || recebimentoMut.isPending}
            className={`px-5 py-2 rounded text-sm font-medium ${podeConfirmar && !recebimentoMut.isPending ? 'bg-atlas-btn-bg text-atlas-btn-text hover:opacity-90' : 'bg-atlas-muted/20 text-atlas-muted cursor-not-allowed'}`}
          >
            {recebimentoMut.isPending
              ? 'Enviando…'
              : totalDivergentes > 0
                ? multiItem
                  ? `Registrar recebimento (${totalDivergentes} com divergência)`
                  : 'Registrar com divergência'
                : multiItem
                  ? `Confirmar recebimento dos ${itens.length} produtos`
                  : 'Confirmar recebimento'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
