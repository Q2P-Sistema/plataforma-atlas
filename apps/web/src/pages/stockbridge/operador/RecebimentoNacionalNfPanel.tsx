import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@atlas/ui';
import { ProdutoCombobox, useApiFetch, type Localidade } from './RecebimentoNacionalForm.js';

/**
 * Feature 015 (ACXEGDP-328) — recebimento nacional A PARTIR DA NF.
 *
 * Fila de NFs nacionais pendentes (lida do espelho Postgres) + detalhe da NF com
 * os itens ja preenchidos: descricao do fornecedor, quantidade, unidade, valor
 * unitario e total. O operador NAO digita valor nem unidade — escolhe o produto
 * do catalogo e o estoque destino, e so altera a quantidade quando a balanca
 * discorda da NF (divergencia: motivo obrigatorio, aprovacao do gestor).
 *
 * Historia 3: o produto memorizado para (fornecedor, descricao) vem pre-
 * selecionado; a escolha final e memorizada no servidor ao dar entrada.
 * Historia 4: um item da NF pode virar N produtos (sucata classificada por
 * grau) — a soma das linhas tem de fechar com o peso conferido.
 * Historia 6: item recebido por FORA do Atlas (direto no OMIE) e baixado com
 * motivo e aprovacao do gestor — acao escondida quando a flag esta desligada.
 *
 * O formulario manual continua ao lado (FR-014) para NF fora do espelho.
 * Rotulos: a contraparte e "Fornecedor" — nunca "Destinatario" (research D7).
 * Mensagens: produto por descricao, local por nome; nada de codigo OMIE (313).
 */

interface FilaNacionalItem {
  nfChaveAcesso: string;
  notaFiscal: string;
  fornecedorNome: string;
  fornecedorCnpj: string;
  dtEmissao: string;
  diasDesdeEmissao: number;
  itensTotal: number;
  itensPendentes: number;
  valorTotalBrl: number;
}

type Bloqueio = 'unidade_nao_conversivel' | 'unidade_incoerente' | 'sem_correlacao' | null;

interface ProdutoSugerido {
  codigo: number;
  descricao: string;
  vezesUsada: number;
}

interface ItemNf {
  indice: number;
  descricaoFornecedor: string;
  cfop: string;
  quantidadeNf: number;
  unidadeOriginal: string;
  quantidadeNfKg: number | null;
  valorUnitarioBrl: number;
  valorTotalItemBrl: number;
  rsPorKg: number | null;
  linhasAgregadas: number;
  produtosSugeridos: ProdutoSugerido[];
  bloqueio: Bloqueio;
  bloqueioMensagem: string | null;
  jaRecebido: boolean;
  quantidadeNfJaAtribuidaKg: number;
  quantidadeConferidaJaGravadaKg: number;
  quantidadeRestanteKg: number | null;
  baixadoComoExterno: boolean;
  /** ha solicitacao de baixa externa aguardando o gestor */
  baixaSolicitada: boolean;
}

interface DetalheNf {
  nfChaveAcesso: string;
  notaFiscal: string;
  fornecedorNome: string;
  fornecedorCnpj: string;
  dtEmissao: string;
  diasDesdeEmissao: number;
  cfop: string;
  valorTotalBrl: number;
  itens: ItemNf[];
  linhasForaDoRecorte: number;
  /** flag STOCKBRIDGE_RECEBIMENTO_EXTERNO_ENABLED — a acao de baixa some quando false */
  recebimentoExternoHabilitado?: boolean;
}

type StatusProduto = 'aguardando_aprovacao' | 'ja_recebido' | 'bloqueado_unidade' | 'bloqueado_unidade_incoerente' | 'falha';

interface ResultadoPorNf {
  notaFiscal: string;
  produtos: Array<{ indice: number; produto: string; descricaoFornecedor: string; status: StatusProduto; quantidadeKg: number; mensagemErro?: string }>;
  resumo: { enviadosParaAprovacao: number; jaRecebidos: number; bloqueados: number; falhas: number };
}

interface ResultadoBaixa {
  notaFiscal: string;
  aprovacoesCriadas: number;
  jaSolicitados: number;
}

/** Uma linha "produto no estoque" de um item da NF (Historia 4: pode haver N). */
interface LinhaProduto {
  produto: { codigo: number; descricao: string } | null;
  localidadeId: string;
  /** input controlado; so usado quando ha mais de uma linha */
  quantidade: string;
}

/** Estado editavel por item (o resto vem da NF e e somente leitura). */
interface ItemForm {
  linhas: LinhaProduto[];
  /** input controlado; vazio = usa a quantidade da NF */
  quantidadeConferida: string;
  motivoDivergencia: string;
}

const TOLERANCIA_KG = 1;

const fmtKg = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const fmtBrl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtData = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('pt-BR');
};
const parseNum = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  // aceita "13.500,5" e "13500.5"
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  return Number.isFinite(n) ? n : NaN;
};

/** Aging da fila do operador: verde ≤3 dias, âmbar ≤7, vermelho depois. */
function agingClass(dias: number): string {
  if (dias <= 3) return 'text-green-700 dark:text-green-400';
  if (dias <= 7) return 'text-amber-700 dark:text-amber-400';
  return 'text-red-700 dark:text-red-400';
}

const STATUS_LABEL: Record<StatusProduto, { label: string; cls: string }> = {
  aguardando_aprovacao: { label: 'Enviado para aprovação', cls: 'text-green-700 dark:text-green-400' },
  ja_recebido: { label: 'Já recebido', cls: 'text-atlas-muted' },
  bloqueado_unidade: { label: 'Bloqueado — unidade', cls: 'text-amber-700 dark:text-amber-400' },
  bloqueado_unidade_incoerente: { label: 'Bloqueado — unidade incoerente', cls: 'text-amber-700 dark:text-amber-400' },
  falha: { label: 'Falha', cls: 'text-red-700 dark:text-red-400' },
};

/** Item que o operador pode receber por aqui: conversivel, nao recebido por inteiro, sem baixa em andamento. */
function itemRecebivel(it: ItemNf): boolean {
  if (it.quantidadeNfKg == null) return false;
  if (it.bloqueio === 'unidade_nao_conversivel' || it.bloqueio === 'unidade_incoerente') return false;
  if (it.jaRecebido && (it.quantidadeRestanteKg ?? 0) <= TOLERANCIA_KG) return false;
  if (it.baixaSolicitada) return false;
  return true;
}

/** Item que pode ser declarado como recebido fora do Atlas. */
function itemBaixavel(it: ItemNf): boolean {
  if (it.baixadoComoExterno || it.baixaSolicitada) return false;
  return !(it.jaRecebido && (it.quantidadeNfJaAtribuidaKg === 0 || (it.quantidadeRestanteKg ?? 0) <= TOLERANCIA_KG));
}

/** Form inicial de um item: os produtos memorizados ja vem selecionados (Historia 3). */
function formInicial(it: ItemNf): ItemForm {
  const linhas: LinhaProduto[] =
    it.produtosSugeridos.length > 0
      ? it.produtosSugeridos.map((s) => ({ produto: { codigo: s.codigo, descricao: s.descricao }, localidadeId: '', quantidade: '' }))
      : [{ produto: null, localidadeId: '', quantidade: '' }];
  return { linhas, quantidadeConferida: '', motivoDivergencia: '' };
}

interface Props {
  /** Abre o formulario manual (NF fora do espelho / fornecedor sem NF-e). */
  onAbrirManual: () => void;
}

export function RecebimentoNacionalNfPanel({ onAbrirManual }: Props) {
  const [chave, setChave] = useState<string | null>(null);
  return chave ? (
    <DetalheSection chave={chave} onVoltar={() => setChave(null)} onAbrirManual={onAbrirManual} />
  ) : (
    <FilaSection onSelecionar={setChave} onAbrirManual={onAbrirManual} />
  );
}

// ── Fila ────────────────────────────────────────────────────────────────────

function FilaSection({ onSelecionar, onAbrirManual }: { onSelecionar: (chave: string) => void; onAbrirManual: () => void }) {
  const apiFetch = useApiFetch();
  const [filtro, setFiltro] = useState('');

  const { data: fila = [], isLoading, error } = useQuery<FilaNacionalItem[], Error>({
    queryKey: ['sb', 'rec-nacional', 'fila'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/recebimento/nacional/fila')).data as FilaNacionalItem[],
  });

  const f = filtro.trim().toLowerCase();
  const filtrada = f
    ? fila.filter((x) => x.notaFiscal.toLowerCase().includes(f) || x.fornecedorNome.toLowerCase().includes(f))
    : fila;

  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <h2 className="text-lg font-serif text-atlas-ink">
          Notas fiscais aguardando recebimento
          {!isLoading && fila.length > 0 && (
            <span className="ml-2 text-xs font-sans font-normal text-atlas-muted">
              {f ? `${filtrada.length} de ${fila.length}` : `${fila.length} ${fila.length === 1 ? 'nota fiscal' : 'notas fiscais'}`}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {!isLoading && fila.length > 0 && (
            <input
              value={filtro}
              onChange={(e) => setFiltro(e.target.value)}
              placeholder="Filtrar por NF ou fornecedor…"
              aria-label="Filtrar fila por número da NF ou fornecedor"
              className="w-64 px-3 py-1.5 border border-atlas-border bg-atlas-bg rounded text-sm outline-none focus:ring-2 focus:ring-atlas-accent"
            />
          )}
          <button
            type="button"
            onClick={onAbrirManual}
            className="px-3 py-1.5 border border-atlas-border text-atlas-ink rounded text-xs font-medium hover:bg-atlas-bg/60 whitespace-nowrap"
          >
            Não encontrou a NF? Registrar manualmente
          </button>
        </div>
      </div>
      <p className="text-xs text-atlas-muted mb-4">
        A lista vem das notas de compra já registradas no OMIE. Escolha a nota, confira os itens e dê entrada — quantidade e valor vêm do documento.
      </p>

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando notas…</div>}

      {!isLoading && error != null && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          {error.message}
        </div>
      )}

      {!isLoading && error == null && fila.length === 0 && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-atlas-border rounded-lg">
          Nenhuma nota nacional aguardando recebimento. Se a nota ainda não aparece aqui, registre pelo formulário manual.
        </div>
      )}

      {!isLoading && fila.length > 0 && filtrada.length === 0 && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-atlas-border rounded-lg">
          Nenhuma nota corresponde ao filtro "{filtro.trim()}".
        </div>
      )}

      {!isLoading && filtrada.length > 0 && (
        <div className="flex flex-col gap-2">
          {filtrada.map((x) => {
            const parcial = x.itensPendentes < x.itensTotal;
            return (
              <div key={x.nfChaveAcesso} className="bg-atlas-card border border-atlas-border rounded-lg p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <span className="font-mono text-sm text-atlas-ink">NF {x.notaFiscal}</span>
                    <span className="text-sm text-atlas-ink truncate" title={x.fornecedorNome}>
                      <span className="text-xs text-atlas-muted mr-1">Fornecedor</span>
                      {x.fornecedorNome}
                    </span>
                    {parcial ? (
                      <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                        {x.itensPendentes} de {x.itensTotal} itens pendentes
                      </span>
                    ) : (
                      <span className="text-xs text-atlas-muted">{x.itensTotal} {x.itensTotal === 1 ? 'item' : 'itens'}</span>
                    )}
                  </div>
                  <div className="text-xs text-atlas-muted mt-0.5">
                    <span className={agingClass(x.diasDesdeEmissao)}>
                      {x.diasDesdeEmissao === 0
                        ? 'emitida hoje'
                        : `emitida em ${fmtData(x.dtEmissao)} · há ${x.diasDesdeEmissao} ${x.diasDesdeEmissao === 1 ? 'dia' : 'dias'}`}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-serif text-atlas-ink">{fmtBrl(x.valorTotalBrl)}</div>
                  <div className="text-[11px] uppercase tracking-wide text-atlas-muted">Valor da nota</div>
                </div>
                <button
                  onClick={() => onSelecionar(x.nfChaveAcesso)}
                  className="px-4 py-2 bg-atlas-btn-bg text-atlas-btn-text rounded text-sm font-medium hover:opacity-90 whitespace-nowrap"
                >
                  Conferir →
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Detalhe ─────────────────────────────────────────────────────────────────

type PedidoBaixa = { modo: 'item'; item: ItemNf } | { modo: 'todos' };

function DetalheSection({ chave, onVoltar, onAbrirManual }: { chave: string; onVoltar: () => void; onAbrirManual: () => void }) {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Record<number, ItemForm>>({});
  const [resultado, setResultado] = useState<ResultadoPorNf | null>(null);
  const [erroEnvio, setErroEnvio] = useState<string | null>(null);
  const [pedidoBaixa, setPedidoBaixa] = useState<PedidoBaixa | null>(null);
  const [motivoBaixa, setMotivoBaixa] = useState('');
  const [avisoBaixa, setAvisoBaixa] = useState<string | null>(null);

  const { data: nf, isLoading, error } = useQuery<DetalheNf, Error>({
    queryKey: ['sb', 'rec-nacional', 'detalhe', chave],
    queryFn: async () => (await apiFetch(`/api/v1/stockbridge/recebimento/nacional/fila/${chave}`)).data as DetalheNf,
  });

  const { data: localidades = [] } = useQuery<Localidade[], Error>({
    queryKey: ['sb', 'rec-nacional', 'localidades', 'q2p'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/recebimento/nacional/localidades?empresa=q2p')).data as Localidade[],
  });

  const getForm = (it: ItemNf): ItemForm => form[it.indice] ?? formInicial(it);
  const setItem = (it: ItemNf, patch: Partial<ItemForm>) => setForm((prev) => ({ ...prev, [it.indice]: { ...getForm(it), ...patch } }));

  const recebiveis = useMemo(() => (nf?.itens ?? []).filter(itemRecebivel), [nf]);
  const baixaveis = useMemo(() => (nf?.itens ?? []).filter(itemBaixavel), [nf]);
  const baixaHabilitada = nf?.recebimentoExternoHabilitado !== false;

  /** Peso que ainda entra por este envio: conferido (ou da NF) menos o que ja foi gravado. */
  function alvoKg(it: ItemNf, fi: ItemForm): number {
    const conferida = parseNum(fi.quantidadeConferida);
    const kg = conferida !== null && !Number.isNaN(conferida) ? conferida : (it.quantidadeNfKg ?? 0);
    return Math.max(0, kg - it.quantidadeConferidaJaGravadaKg);
  }

  /** Quantidade por linha: uma linha leva tudo; N linhas usam o que o operador distribuiu. */
  function quantidadesDasLinhas(it: ItemNf, fi: ItemForm): Array<number | null> {
    const alvo = alvoKg(it, fi);
    if (fi.linhas.length === 1) return [alvo];
    return fi.linhas.map((l) => parseNum(l.quantidade));
  }

  /** Validacao local — espelha a do servidor para o operador ver antes de enviar. */
  function validar(): string | null {
    if (recebiveis.length === 0) return 'Nenhum item desta nota pode ser recebido por aqui.';
    for (const it of recebiveis) {
      const fi = getForm(it);
      const rot = `"${it.descricaoFornecedor.trim()}"`;
      const conferida = parseNum(fi.quantidadeConferida);
      if (conferida !== null && (Number.isNaN(conferida) || conferida <= 0)) return `Quantidade conferida de ${rot} deve ser positiva.`;
      const nfKg = it.quantidadeNfKg ?? 0;
      const delta = (conferida ?? nfKg) - nfKg;
      if (Math.abs(delta) > TOLERANCIA_KG && !fi.motivoDivergencia.trim()) {
        return `${rot}: a balança marcou ${fmtKg(conferida ?? nfKg)} kg e a nota declara ${fmtKg(nfKg)} kg. Informe o motivo da diferença.`;
      }
      const vistos = new Set<number>();
      const qtds = quantidadesDasLinhas(it, fi);
      for (let i = 0; i < fi.linhas.length; i++) {
        const l = fi.linhas[i]!;
        const n = fi.linhas.length > 1 ? ` (linha ${i + 1})` : '';
        if (!l.produto) return `Escolha o produto para ${rot}${n}.`;
        if (vistos.has(l.produto.codigo)) return `O produto "${l.produto.descricao}" aparece mais de uma vez em ${rot}. Some as quantidades numa linha só.`;
        vistos.add(l.produto.codigo);
        if (!l.localidadeId) return `Escolha o estoque destino para ${rot}${n}.`;
        const q = qtds[i];
        if (q === null || q === undefined || Number.isNaN(q) || q <= 0) return `Informe a quantidade de "${l.produto.descricao}" em ${rot}.`;
      }
      if (fi.linhas.length > 1) {
        const soma = qtds.reduce<number>((s, q) => s + (q ?? 0), 0);
        const alvo = alvoKg(it, fi);
        if (Math.abs(soma - alvo) > TOLERANCIA_KG) {
          return `${rot}: a soma dos produtos (${fmtKg(soma)} kg) não fecha com o peso conferido (${fmtKg(alvo)} kg).`;
        }
      }
    }
    return null;
  }

  const enviarMut = useMutation<ResultadoPorNf, Error>({
    mutationFn: async () => {
      const payload = {
        nf_chave_acesso: chave,
        itens: recebiveis.map((it) => {
          const fi = getForm(it);
          const conferida = parseNum(fi.quantidadeConferida);
          const qtds = quantidadesDasLinhas(it, fi);
          return {
            indice: it.indice,
            descricao_fornecedor: it.descricaoFornecedor,
            ...(conferida !== null ? { quantidade_conferida_kg: conferida } : {}),
            ...(fi.motivoDivergencia.trim() ? { motivo_divergencia: fi.motivoDivergencia.trim() } : {}),
            produtos: fi.linhas.map((l, i) => ({ produto_codigo_q2p: l.produto!.codigo, quantidade_kg: qtds[i] ?? 0, localidade_id: l.localidadeId })),
          };
        }),
      };
      const r = await apiFetch('/api/v1/stockbridge/recebimento/nacional/por-nf', { method: 'POST', body: JSON.stringify(payload) });
      return r.data as ResultadoPorNf;
    },
    onSuccess: (r) => {
      setResultado(r);
      setErroEnvio(null);
      // Historia 3/4: o servidor memoriza o que foi GRAVADO; se o operador tirou um
      // produto que vinha sugerido, o conjunto memorizado e corrigido aqui (best-effort).
      for (const it of recebiveis) {
        if (it.produtosSugeridos.length === 0) continue;
        const escolhidos = getForm(it).linhas.map((l) => l.produto!.codigo);
        const sugeridos = it.produtosSugeridos.map((s) => s.codigo);
        const mesmoConjunto = escolhidos.length === sugeridos.length && sugeridos.every((c) => escolhidos.includes(c));
        if (mesmoConjunto) continue;
        void apiFetch('/api/v1/stockbridge/recebimento/nacional/correlacao', {
          method: 'PUT',
          body: JSON.stringify({ nf_chave_acesso: chave, descricao_nf: it.descricaoFornecedor, produtos_codigo_q2p: escolhidos }),
        }).catch(() => undefined);
      }
      queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'fila'] });
      queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'detalhe', chave] });
      queryClient.invalidateQueries({ queryKey: ['stockbridge'] });
    },
    onError: (e) => setErroEnvio(e.message),
  });

  const baixaMut = useMutation<ResultadoBaixa, Error, PedidoBaixa>({
    mutationFn: async (pedido) => {
      const payload = {
        nf_chave_acesso: chave,
        motivo: motivoBaixa.trim(),
        ...(pedido.modo === 'item' ? { itens: [{ indice: pedido.item.indice, descricao_fornecedor: pedido.item.descricaoFornecedor }] } : {}),
      };
      const r = await apiFetch('/api/v1/stockbridge/recebimento/nacional/recebimento-externo', { method: 'POST', body: JSON.stringify(payload) });
      return r.data as ResultadoBaixa;
    },
    onSuccess: (r) => {
      setPedidoBaixa(null);
      setMotivoBaixa('');
      const n = r.aprovacoesCriadas;
      setAvisoBaixa(
        n > 0
          ? `Baixa solicitada para ${n} ${n === 1 ? 'item' : 'itens'} da NF ${r.notaFiscal} — aguardando aprovação do gestor.`
          : `Os itens desta nota já tinham baixa solicitada — nada foi duplicado.`,
      );
      queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'fila'] });
      queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'detalhe', chave] });
      queryClient.invalidateQueries({ queryKey: ['stockbridge'] });
    },
  });

  function handleEnviar() {
    const msg = validar();
    if (msg) {
      setErroEnvio(msg);
      return;
    }
    setErroEnvio(null);
    enviarMut.mutate();
  }

  return (
    <div>
      <button type="button" onClick={onVoltar} className="mb-3 text-sm text-atlas-muted hover:text-atlas-ink transition-colors">
        ← Voltar à lista de notas
      </button>

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando nota…</div>}

      {!isLoading && error != null && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          {error.message}{' '}
          <button type="button" onClick={onAbrirManual} className="underline">
            Registrar manualmente
          </button>
        </div>
      )}

      {nf && (
        <>
          <div className="bg-atlas-card border border-atlas-border rounded-lg p-4 mb-4 flex flex-wrap gap-x-8 gap-y-2 items-baseline">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-atlas-muted">Nota fiscal</div>
              <div className="font-mono text-lg text-atlas-ink">NF {nf.notaFiscal}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-atlas-muted">Fornecedor</div>
              <div className="text-sm text-atlas-ink truncate" title={nf.fornecedorNome}>{nf.fornecedorNome}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-atlas-muted">Emissão</div>
              <div className="text-sm text-atlas-ink">{fmtData(nf.dtEmissao)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-atlas-muted">CFOP</div>
              <div className="text-sm font-mono text-atlas-ink">{nf.cfop}</div>
            </div>
            <div className="ml-auto text-right">
              <div className="text-[11px] uppercase tracking-wide text-atlas-muted">Valor da nota</div>
              <div className="font-serif text-lg text-atlas-ink">{fmtBrl(nf.valorTotalBrl)}</div>
            </div>
          </div>

          {nf.linhasForaDoRecorte > 0 && (
            <div className="mb-3 text-xs text-atlas-muted">
              {nf.linhasForaDoRecorte} {nf.linhasForaDoRecorte === 1 ? 'linha desta nota não é' : 'linhas desta nota não são'} de compra de mercadoria e {nf.linhasForaDoRecorte === 1 ? 'fica' : 'ficam'} fora deste recebimento.
            </div>
          )}

          {avisoBaixa && (
            <div className="mb-3 p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded text-sm text-emerald-900 dark:text-emerald-200 flex items-start gap-2">
              <span className="flex-1">{avisoBaixa}</span>
              <button type="button" onClick={() => setAvisoBaixa(null)} className="opacity-60 hover:opacity-100" aria-label="Fechar">×</button>
            </div>
          )}

          <div className="flex flex-col gap-3">
            {nf.itens.map((it) => (
              <ItemCard
                key={it.indice}
                item={it}
                form={getForm(it)}
                localidades={localidades}
                alvoKg={alvoKg(it, getForm(it))}
                onChange={(patch) => setItem(it, patch)}
                onSolicitarBaixa={baixaHabilitada && itemBaixavel(it) && !resultado ? () => setPedidoBaixa({ modo: 'item', item: it }) : undefined}
              />
            ))}
          </div>

          {resultado && (
            <div className="mt-4 p-4 bg-atlas-card border border-atlas-border rounded-lg">
              <div className="text-sm text-atlas-ink mb-2">
                NF {resultado.notaFiscal}: {resultado.resumo.enviadosParaAprovacao} {resultado.resumo.enviadosParaAprovacao === 1 ? 'item enviado' : 'itens enviados'} para aprovação do gestor
                {resultado.resumo.jaRecebidos > 0 && ` · ${resultado.resumo.jaRecebidos} já ${resultado.resumo.jaRecebidos === 1 ? 'recebido' : 'recebidos'}`}
                {resultado.resumo.bloqueados > 0 && ` · ${resultado.resumo.bloqueados} ${resultado.resumo.bloqueados === 1 ? 'bloqueado' : 'bloqueados'}`}
                {resultado.resumo.falhas > 0 && ` · ${resultado.resumo.falhas} ${resultado.resumo.falhas === 1 ? 'falha' : 'falhas'}`}
              </div>
              <ul className="text-xs space-y-1">
                {resultado.produtos.map((p, i) => (
                  <li key={i} className="flex gap-2">
                    <span className={STATUS_LABEL[p.status].cls}>{STATUS_LABEL[p.status].label}</span>
                    <span className="text-atlas-ink">{p.produto || p.descricaoFornecedor.trim()}</span>
                    <span className="text-atlas-muted">{fmtKg(p.quantidadeKg)} kg</span>
                    {p.mensagemErro && <span className="text-atlas-muted">— {p.mensagemErro}</span>}
                  </li>
                ))}
              </ul>
              <button type="button" onClick={onVoltar} className="mt-3 px-4 py-2 bg-atlas-btn-bg text-atlas-btn-text rounded text-sm font-medium hover:opacity-90">
                Voltar à lista
              </button>
            </div>
          )}

          {erroEnvio && (
            <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
              {erroEnvio}
            </div>
          )}

          {!resultado && (
            <div className="mt-4 flex items-center justify-between gap-4 flex-wrap">
              <div className="text-xs text-atlas-muted">
                Cada item vira uma aprovação do gestor. O ajuste no OMIE acontece na aprovação.
                {baixaHabilitada && baixaveis.length > 0 && (
                  <>
                    {' '}
                    <button type="button" onClick={() => setPedidoBaixa({ modo: 'todos' })} className="underline hover:text-atlas-ink">
                      {baixaveis.length === 1 ? 'O item já foi recebido fora do Atlas?' : 'Todos os itens já foram recebidos fora do Atlas?'}
                    </button>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={handleEnviar}
                disabled={enviarMut.isPending || recebiveis.length === 0}
                className="px-5 py-2 bg-atlas-btn-bg text-atlas-btn-text rounded text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {enviarMut.isPending ? 'Enviando…' : `Dar entrada em ${recebiveis.length} ${recebiveis.length === 1 ? 'item' : 'itens'} →`}
              </button>
            </div>
          )}

          {pedidoBaixa && (
            <Modal open title="Baixa por recebimento fora do Atlas" onClose={() => { setPedidoBaixa(null); setMotivoBaixa(''); }}>
              <div className="space-y-3">
                <p className="text-sm text-atlas-muted">
                  {pedidoBaixa.modo === 'item'
                    ? <>O item <strong className="text-atlas-ink">{pedidoBaixa.item.descricaoFornecedor.trim()}</strong> da NF {nf.notaFiscal} será marcado como já recebido por outro caminho.</>
                    : <>{baixaveis.length === 1 ? 'O item pendente' : `Os ${baixaveis.length} itens pendentes`} da NF {nf.notaFiscal} {baixaveis.length === 1 ? 'será marcado' : 'serão marcados'} como já recebidos por outro caminho.</>}
                  {' '}Isso <strong className="text-atlas-ink">não</strong> movimenta estoque nem altera o OMIE — só tira a nota da fila, depois que o gestor aprovar.
                </p>
                <div>
                  <label className="block text-xs font-semibold text-atlas-muted mb-1">Onde e como foi recebido *</label>
                  <textarea
                    value={motivoBaixa}
                    onChange={(e) => setMotivoBaixa(e.target.value)}
                    rows={3}
                    autoFocus
                    placeholder="Ex.: lançado direto no OMIE em 12/09 por indisponibilidade do Atlas"
                    className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg text-atlas-ink placeholder:text-atlas-muted rounded text-sm"
                  />
                </div>
                {baixaMut.isError && (
                  <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-800 dark:text-red-300">
                    {baixaMut.error.message}
                  </div>
                )}
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => { setPedidoBaixa(null); setMotivoBaixa(''); }}
                    className="px-4 py-2 border border-atlas-border bg-atlas-card text-atlas-ink hover:bg-atlas-bg/60 rounded text-sm"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => baixaMut.mutate(pedidoBaixa)}
                    disabled={!motivoBaixa.trim() || baixaMut.isPending}
                    className={`px-5 py-2 rounded text-sm font-medium ${motivoBaixa.trim() ? 'bg-atlas-btn-bg text-atlas-btn-text hover:opacity-90' : 'bg-atlas-muted/20 text-atlas-muted cursor-not-allowed'}`}
                  >
                    {baixaMut.isPending ? 'Enviando…' : 'Solicitar baixa ao gestor'}
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </>
      )}
    </div>
  );
}

// ── Item ────────────────────────────────────────────────────────────────────

function ItemCard({
  item,
  form,
  localidades,
  alvoKg,
  onChange,
  onSolicitarBaixa,
}: {
  item: ItemNf;
  form: ItemForm;
  localidades: Localidade[];
  /** peso que este envio vai distribuir entre as linhas */
  alvoKg: number;
  onChange: (p: Partial<ItemForm>) => void;
  /** ausente = acao indisponivel (flag desligada, item ja recebido/baixado, envio concluido) */
  onSolicitarBaixa?: () => void;
}) {
  const bloqueadoUnidade = item.bloqueio === 'unidade_nao_conversivel' || item.bloqueio === 'unidade_incoerente';
  const recebidoIntegral = item.jaRecebido && (item.quantidadeRestanteKg ?? 0) <= TOLERANCIA_KG;
  const parcial = item.quantidadeNfJaAtribuidaKg > 0 && !recebidoIntegral;
  const editavel = itemRecebivel(item);
  const nfKg = item.quantidadeNfKg ?? 0;
  const conferida = parseNum(form.quantidadeConferida);
  const conferidaEfetiva = conferida !== null && !Number.isNaN(conferida) ? conferida : nfKg;
  const delta = conferidaEfetiva - nfKg;
  const temDivergencia = Math.abs(delta) > TOLERANCIA_KG;
  const sugeridos = new Set(item.produtosSugeridos.map((s) => s.codigo));

  const multi = form.linhas.length > 1;
  const somaLinhas = multi ? form.linhas.reduce((s, l) => s + (parseNum(l.quantidade) ?? 0), 0) : alvoKg;
  const falta = alvoKg - somaLinhas;

  const setLinha = (i: number, patch: Partial<LinhaProduto>) =>
    onChange({ linhas: form.linhas.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const addLinha = () => onChange({ linhas: [...form.linhas, { produto: null, localidadeId: form.linhas[0]?.localidadeId ?? '', quantidade: '' }] });
  const removeLinha = (i: number) => onChange({ linhas: form.linhas.filter((_, j) => j !== i) });

  return (
    <div className={`bg-atlas-card border rounded-lg p-4 ${bloqueadoUnidade ? 'border-amber-300 dark:border-amber-800' : 'border-atlas-border'}`}>
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-[16rem]">
          <div className="text-[11px] uppercase tracking-wide text-atlas-muted">Item da nota</div>
          <div className="font-serif text-base text-atlas-ink" title={item.descricaoFornecedor}>{item.descricaoFornecedor.trim()}</div>
          <div className="text-xs text-atlas-muted mt-0.5">
            {fmtKg(item.quantidadeNf)} {item.unidadeOriginal}
            {item.quantidadeNfKg != null && item.unidadeOriginal !== 'KG' && ` = ${fmtKg(item.quantidadeNfKg)} kg`}
            {' · '}
            {fmtBrl(item.valorTotalItemBrl)}
            {item.rsPorKg != null && ` (${fmtBrl(item.rsPorKg)}/kg)`}
            {item.linhasAgregadas > 1 && ` · ${item.linhasAgregadas} linhas da nota somadas`}
          </div>
        </div>

        {recebidoIntegral && (
          <div className="text-xs font-medium px-2 py-1 rounded bg-atlas-muted/20 text-atlas-muted self-center">
            {item.baixadoComoExterno ? 'Baixado como recebido fora do Atlas' : 'Já recebido'}
          </div>
        )}
        {!recebidoIntegral && item.baixaSolicitada && (
          <div className="text-xs font-medium px-2 py-1 rounded bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300 self-center">
            Baixa solicitada — aguardando o gestor
          </div>
        )}
        {parcial && (
          <div className="text-xs font-medium px-2 py-1 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 self-center">
            {fmtKg(item.quantidadeNfJaAtribuidaKg)} kg já recebidos · faltam {fmtKg(item.quantidadeRestanteKg ?? 0)} kg
          </div>
        )}
        {onSolicitarBaixa && (
          <button
            type="button"
            onClick={onSolicitarBaixa}
            className="text-xs text-atlas-muted underline hover:text-atlas-ink self-center whitespace-nowrap"
          >
            Recebido fora do Atlas?
          </button>
        )}
      </div>

      {bloqueadoUnidade && (
        <div className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-sm text-amber-900 dark:text-amber-200">
          {item.bloqueioMensagem}
        </div>
      )}

      {editavel && (
        <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-8 flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <label className="block text-xs font-medium text-atlas-muted">
                {multi ? 'Produtos no estoque' : 'Produto no estoque'}
              </label>
              {item.produtosSugeridos.length > 0 && (
                <span className="text-[11px] text-atlas-muted">
                  {item.produtosSugeridos.length === 1 ? 'sugestão pelo histórico deste fornecedor' : `${item.produtosSugeridos.length} produtos pelo histórico deste fornecedor`}
                </span>
              )}
            </div>
            {form.linhas.map((l, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-start">
                <div className={multi ? 'col-span-6' : 'col-span-7'}>
                  <ProdutoCombobox empresa="q2p" valor={l.produto} onChange={(p) => setLinha(i, { produto: p })} />
                  {l.produto && sugeridos.has(l.produto.codigo) && (
                    <div className="text-[11px] text-atlas-muted mt-0.5">sugerido pelo histórico — pode trocar</div>
                  )}
                </div>
                <div className={multi ? 'col-span-3' : 'col-span-5'}>
                  <select
                    value={l.localidadeId}
                    onChange={(e) => setLinha(i, { localidadeId: e.target.value })}
                    aria-label="Estoque destino"
                    className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm"
                  >
                    <option value="">Estoque destino…</option>
                    {localidades.map((loc) => (
                      <option key={loc.id} value={loc.id}>{loc.codigo} — {loc.nome}</option>
                    ))}
                  </select>
                </div>
                {multi && (
                  <div className="col-span-3 flex items-start gap-1">
                    <input
                      inputMode="decimal"
                      value={l.quantidade}
                      onChange={(e) => setLinha(i, { quantidade: e.target.value })}
                      placeholder="kg"
                      aria-label="Quantidade deste produto em kg"
                      className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => removeLinha(i)}
                      aria-label="Remover produto"
                      title="Remover produto"
                      className="px-2 py-2 text-atlas-muted hover:text-red-700 dark:hover:text-red-400"
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
            ))}
            <div className="flex items-center justify-between gap-2">
              <button type="button" onClick={addLinha} className="text-xs text-atlas-muted underline hover:text-atlas-ink self-start">
                + Este item vira mais de um produto
              </button>
              {multi && (
                <span className={`text-[11px] ${Math.abs(falta) > TOLERANCIA_KG ? 'text-amber-700 dark:text-amber-400' : 'text-green-700 dark:text-green-400'}`}>
                  {Math.abs(falta) <= TOLERANCIA_KG
                    ? `Distribuídos ${fmtKg(somaLinhas)} kg — fecha com o peso conferido`
                    : falta > 0
                      ? `Faltam ${fmtKg(falta)} kg para fechar ${fmtKg(alvoKg)} kg`
                      : `${fmtKg(-falta)} kg acima do peso conferido (${fmtKg(alvoKg)} kg)`}
                </span>
              )}
            </div>
          </div>
          <div className="md:col-span-4">
            <label className="block text-xs font-medium text-atlas-muted mb-1">Peso conferido na balança (kg)</label>
            <input
              inputMode="decimal"
              value={form.quantidadeConferida}
              onChange={(e) => onChange({ quantidadeConferida: e.target.value })}
              placeholder={fmtKg(nfKg)}
              className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm font-mono"
            />
            <div className={`text-[11px] mt-1 ${temDivergencia ? 'text-amber-700 dark:text-amber-400' : 'text-atlas-muted'}`}>
              {temDivergencia
                ? `${delta > 0 ? '+' : ''}${fmtKg(delta)} kg em relação à nota — exige motivo e aprovação`
                : 'Em branco = quantidade da nota'}
            </div>
          </div>
          {temDivergencia && (
            <div className="md:col-span-12">
              <label className="block text-xs font-medium text-atlas-muted mb-1">Motivo da diferença</label>
              <input
                value={form.motivoDivergencia}
                onChange={(e) => onChange({ motivoDivergencia: e.target.value })}
                placeholder="Ex.: peso da balança acima do declarado na nota"
                className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
