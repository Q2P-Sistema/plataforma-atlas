import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

type Empresa = 'acxe' | 'q2p';
type Unidade = 't' | 'kg' | 'saco' | 'bigbag';

interface Localidade {
  id: string;
  codigo: string;
  nome: string;
  tipo: string;
  cidade: string | null;
  cnpj: string | null;
  empresa: Empresa;
  codigoLocalEstoqueOmie: string;
}

interface ProdutoNacional {
  codigo: number; // codigo da empresa selecionada (acxe=cod ACXE, q2p=cod Q2P)
  descricao: string;
  unidadeMedida: string | null;
}

interface ItemForm {
  uid: string; // chave estável para React
  produtoCodigo: number | null; // cod ACXE se empresa=acxe, cod Q2P se empresa=q2p
  produtoDescricao: string;
  empresa: Empresa;
  localidadeId: string;
  quantidade: string; // input controlado
  unidade: Unidade;
  valorTotalBrl: string; // valor total do item na NF em R$
}

function novoItem(): ItemForm {
  return {
    uid: crypto.randomUUID(),
    produtoCodigo: null,
    produtoDescricao: '',
    empresa: 'q2p',
    localidadeId: '',
    quantidade: '',
    unidade: 'kg',
    valorTotalBrl: '',
  };
}

const FATOR_KG: Record<Unidade, number> = { t: 1000, kg: 1, saco: 25, bigbag: 1000 };

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string>),
    };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    const body = (await res.json()) as { data: unknown; error: { code?: string; message?: string } | null };
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body;
  };
}

/**
 * Formulário de recebimento de NF nacional.
 *
 * Diferente do recebimento de importação, aqui o operador monta o recebimento
 * manualmente — a NF do OMIE é apenas referência (texto livre que vai pra
 * observação do ajuste). Cada item gera uma aprovação independente do gestor.
 *
 * Estoques espelhados (com correlação ACXE+Q2P) ficam fora do menu de
 * localidades — esse fluxo é exclusivo de localidades não-espelhadas.
 */
export function RecebimentoNacionalForm() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [nf, setNf] = useState('');
  const [observacoes, setObservacoes] = useState('');
  const [itens, setItens] = useState<ItemForm[]>(() => [novoItem()]);
  const [erroEnvio, setErroEnvio] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);

  function atualizarItem(uid: string, patch: Partial<ItemForm>) {
    setItens((prev) => prev.map((it) => (it.uid === uid ? { ...it, ...patch } : it)));
  }

  function removerItem(uid: string) {
    setItens((prev) => (prev.length === 1 ? prev : prev.filter((it) => it.uid !== uid)));
  }

  const enviarMut = useMutation({
    mutationFn: async () => {
      const payload = {
        nf: nf.trim(),
        observacoes: observacoes.trim() || undefined,
        itens: itens.map((it) => ({
          produto_codigo_acxe: it.empresa === 'acxe' ? it.produtoCodigo : null,
          produto_codigo_q2p: it.empresa === 'q2p' ? it.produtoCodigo : null,
          empresa: it.empresa,
          localidade_id: it.localidadeId,
          quantidade: Number(it.quantidade.replace(',', '.')),
          unidade: it.unidade,
          valor_total_nf_brl: Number(it.valorTotalBrl.replace(',', '.')),
        })),
      };
      return apiFetch('/api/v1/stockbridge/recebimento/nacional', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: (resp) => {
      const data = resp.data as { itens: Array<{ aprovacaoId: string }> };
      setSucesso(
        `Recebimento registrado: ${data.itens.length} ${
          data.itens.length === 1 ? 'item enviado' : 'itens enviados'
        } para aprovação do gestor.`,
      );
      setErroEnvio(null);
      setNf('');
      setObservacoes('');
      setItens([novoItem()]);
      queryClient.invalidateQueries({ queryKey: ['stockbridge'] });
    },
    onError: (err: Error) => {
      setErroEnvio(err.message);
      setSucesso(null);
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErroEnvio(null);
    setSucesso(null);
    if (!nf.trim()) {
      setErroEnvio('Informe o número da NF.');
      return;
    }
    for (const it of itens) {
      if (it.produtoCodigo == null) {
        setErroEnvio('Selecione o produto em todos os itens.');
        return;
      }
      if (!it.localidadeId) {
        setErroEnvio('Selecione o estoque destino em todos os itens.');
        return;
      }
      const q = Number(it.quantidade.replace(',', '.'));
      if (!Number.isFinite(q) || q <= 0) {
        setErroEnvio('Informe quantidade válida (> 0) em todos os itens.');
        return;
      }
      const v = Number(it.valorTotalBrl.replace(',', '.'));
      if (!Number.isFinite(v) || v <= 0) {
        setErroEnvio('Informe o valor total da NF (> 0) em todos os itens.');
        return;
      }
    }
    enviarMut.mutate();
  }

  const totalKg = itens.reduce((soma, it) => {
    const q = Number(it.quantidade.replace(',', '.'));
    if (!Number.isFinite(q) || q <= 0) return soma;
    return soma + q * FATOR_KG[it.unidade];
  }, 0);

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 p-4 bg-atlas-card border border-atlas-border rounded-lg">
        <div className="md:col-span-1">
          <label className="block text-xs font-medium text-atlas-muted mb-1">
            Número da NF <span className="text-red-500">*</span>
          </label>
          <input
            value={nf}
            onChange={(e) => setNf(e.target.value)}
            placeholder="Ex: 12345"
            required
            className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm outline-none focus:ring-2 focus:ring-atlas-accent"
          />
          <p className="text-[11px] text-atlas-muted mt-1">
            Vai pra observação do ajuste OMIE — não consultamos a NF, só registramos a referência.
          </p>
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-atlas-muted mb-1">
            Observações <span className="text-atlas-muted/70">(opcional)</span>
          </label>
          <input
            value={observacoes}
            onChange={(e) => setObservacoes(e.target.value)}
            placeholder="Detalhe adicional que deve aparecer na aprovação"
            className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm outline-none focus:ring-2 focus:ring-atlas-accent"
          />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {itens.map((it, idx) => (
          <ItemRow
            key={it.uid}
            indice={idx}
            valor={it}
            podeRemover={itens.length > 1}
            onMudar={(patch) => atualizarItem(it.uid, patch)}
            onRemover={() => removerItem(it.uid)}
          />
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setItens((prev) => [...prev, novoItem()])}
          className="px-3 py-1.5 text-sm font-medium text-atlas-accent border border-atlas-accent/40 rounded hover:bg-atlas-accent/5"
        >
          + Adicionar item
        </button>
        <div className="text-sm text-atlas-muted">
          Total: <span className="font-serif text-atlas-ink">{totalKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg</span>
        </div>
      </div>

      {erroEnvio && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          {erroEnvio}
        </div>
      )}
      {sucesso && (
        <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded text-sm text-emerald-800 dark:text-emerald-300">
          {sucesso}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={enviarMut.isPending}
          className="px-5 py-2 bg-atlas-btn-bg text-atlas-btn-text rounded text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {enviarMut.isPending ? 'Enviando...' : 'Enviar para aprovação'}
        </button>
      </div>
    </form>
  );
}

interface ItemRowProps {
  indice: number;
  valor: ItemForm;
  podeRemover: boolean;
  onMudar: (patch: Partial<ItemForm>) => void;
  onRemover: () => void;
}

function ItemRow({ indice, valor, podeRemover, onMudar, onRemover }: ItemRowProps) {
  const apiFetch = useApiFetch();

  const { data: localidades = [] } = useQuery<Localidade[]>({
    queryKey: ['sb', 'rec-nacional', 'localidades', valor.empresa],
    queryFn: async () => {
      const body = await apiFetch(
        `/api/v1/stockbridge/recebimento/nacional/localidades?empresa=${valor.empresa}`,
      );
      return body.data as Localidade[];
    },
  });

  // Limpa localidade ao trocar empresa, se a antiga não pertence à nova lista
  useEffect(() => {
    if (!valor.localidadeId) return;
    const continuaValida = localidades.some((l) => l.id === valor.localidadeId);
    if (!continuaValida && localidades.length > 0) {
      onMudar({ localidadeId: '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valor.empresa, localidades]);

  return (
    <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-atlas-muted">Item {indice + 1}</span>
        {podeRemover && (
          <button
            type="button"
            onClick={onRemover}
            className="text-xs text-red-700 dark:text-red-400 hover:underline"
          >
            Remover
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-atlas-muted mb-1">Empresa</label>
          <select
            value={valor.empresa}
            onChange={(e) => onMudar({ empresa: e.target.value as Empresa, produtoCodigo: null, produtoDescricao: '', localidadeId: '' })}
            className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm outline-none"
          >
            <option value="q2p">Q2P</option>
            <option value="acxe">ACXE</option>
          </select>
        </div>

        <div className="md:col-span-4">
          <label className="block text-xs font-medium text-atlas-muted mb-1">Produto</label>
          <ProdutoCombobox
            empresa={valor.empresa}
            valor={
              valor.produtoCodigo != null
                ? { codigo: valor.produtoCodigo, descricao: valor.produtoDescricao }
                : null
            }
            onChange={(p) =>
              onMudar({ produtoCodigo: p.codigo, produtoDescricao: p.descricao })
            }
          />
        </div>

        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-atlas-muted mb-1">Estoque</label>
          <select
            value={valor.localidadeId}
            onChange={(e) => onMudar({ localidadeId: e.target.value })}
            className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm outline-none"
          >
            <option value="">Selecione...</option>
            {localidades.map((l) => (
              <option key={l.id} value={l.id}>
                {l.codigo} — {l.nome}
              </option>
            ))}
          </select>
          {localidades.length === 0 && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">
              Nenhum estoque {valor.empresa.toUpperCase()} sem espelho cadastrado.
            </p>
          )}
        </div>

        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-atlas-muted mb-1">Quantidade</label>
          <div className="flex gap-1">
            <input
              type="text"
              inputMode="decimal"
              value={valor.quantidade}
              onChange={(e) => onMudar({ quantidade: e.target.value })}
              placeholder="0"
              className="flex-1 min-w-0 px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm outline-none focus:ring-2 focus:ring-atlas-accent"
            />
            <select
              value={valor.unidade}
              onChange={(e) => onMudar({ unidade: e.target.value as Unidade })}
              className="px-2 py-2 border border-atlas-border bg-atlas-bg rounded text-sm outline-none"
            >
              <option value="kg">kg</option>
              <option value="t">t</option>
              <option value="saco">saco</option>
              <option value="bigbag">big bag</option>
            </select>
          </div>
        </div>

        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-atlas-muted mb-1">
            Valor total NF <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-atlas-muted">R$</span>
            <input
              type="text"
              inputMode="decimal"
              value={valor.valorTotalBrl}
              onChange={(e) => onMudar({ valorTotalBrl: e.target.value })}
              placeholder="0,00"
              className="w-full pl-7 pr-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm outline-none focus:ring-2 focus:ring-atlas-accent"
            />
          </div>
          {(() => {
            const qtd = Number(valor.quantidade.replace(',', '.'));
            const val = Number(valor.valorTotalBrl.replace(',', '.'));
            const qtdKg = Number.isFinite(qtd) && qtd > 0 ? qtd * FATOR_KG[valor.unidade] : 0;
            if (qtdKg > 0 && Number.isFinite(val) && val > 0) {
              return (
                <p className="text-[11px] text-atlas-muted mt-1">
                  = R$ {(val / qtdKg).toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}/kg
                </p>
              );
            }
            return null;
          })()}
        </div>
      </div>
    </div>
  );
}

interface ProdutoComboboxProps {
  empresa: Empresa;
  valor: { codigo: number; descricao: string } | null;
  onChange: (p: { codigo: number; descricao: string }) => void;
}

function ProdutoCombobox({ empresa, valor, onChange }: ProdutoComboboxProps) {
  const apiFetch = useApiFetch();
  const [aberto, setAberto] = useState(false);
  const [termo, setTermo] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

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

  const [termoDebounced, setTermoDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTermoDebounced(termo), 250);
    return () => clearTimeout(t);
  }, [termo]);

  const { data: opcoes = [], isFetching } = useQuery<ProdutoNacional[], Error>({
    queryKey: ['sb', 'rec-nacional', 'produtos', empresa, termoDebounced],
    enabled: aberto,
    queryFn: async () => {
      const params = new URLSearchParams({ empresa, limit: '50' });
      if (termoDebounced.trim().length > 0) params.set('q', termoDebounced.trim());
      const r = await apiFetch(`/api/v1/stockbridge/recebimento/nacional/produtos?${params}`);
      return r.data as ProdutoNacional[];
    },
  });

  const escolher = (p: ProdutoNacional) => {
    onChange({ codigo: p.codigo, descricao: p.descricao });
    setAberto(false);
    setTermo('');
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm text-left hover:border-atlas-muted flex items-center justify-between gap-2"
      >
        <span className={valor ? 'truncate' : 'truncate text-atlas-muted'} title={valor?.descricao}>
          {valor?.descricao ?? 'Selecionar produto...'}
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
                key={p.codigo}
                type="button"
                onClick={() => escolher(p)}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-atlas-bg/60 ${
                  p.codigo === valor?.codigo ? 'bg-atlas-bg font-medium' : ''
                }`}
              >
                <div className="truncate" title={p.descricao}>
                  {p.descricao}
                </div>
                <div className="text-[11px] text-atlas-muted">cod. {p.codigo}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
