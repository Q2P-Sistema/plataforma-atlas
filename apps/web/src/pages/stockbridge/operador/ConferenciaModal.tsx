import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
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
  item: FilaItem;
  onClose: () => void;
  onSucesso: () => void;
}

interface Localidade {
  id: string;
  codigo: string;
  nome: string;
  ativo: boolean;
}

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers as Record<string, string>) };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    const body = (await res.json()) as { data: unknown; error: { code?: string; message?: string } | null };
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body;
  };
}

export function ConferenciaModal({ item, onClose, onSucesso }: Props) {
  const apiFetch = useApiFetch();
  const [qtdInput, setQtdInput] = useState(String(item.qtdOriginal));
  const [unidadeInput, setUnidadeInput] = useState<Unidade>(item.unidade);
  const [localidadeId, setLocalidadeId] = useState('');
  const [obs, setObs] = useState('');
  const [tipoDivergencia, setTipoDivergencia] = useState<'faltando' | 'varredura'>('faltando');
  const [sucesso, setSucesso] = useState<{ tipo: 'ok' | 'divergencia'; mensagem: string } | null>(null);

  const { data: localidades = [] } = useQuery<Localidade[]>({
    queryKey: ['stockbridge', 'localidades', 'ativas'],
    queryFn: async () => {
      const body = await apiFetch('/api/v1/stockbridge/localidades?ativo=true');
      return body.data as Localidade[];
    },
  });

  const qtdFisicaKg = useMemo(() => {
    const n = parseFloat(qtdInput.replace(',', '.'));
    return Number.isFinite(n) ? n * FATOR_KG[unidadeInput] : 0;
  }, [qtdInput, unidadeInput]);
  const deltaKg = qtdFisicaKg - item.qtdKg;
  const temDivergencia = Math.abs(deltaKg) > 1; // tolerancia 1 kg
  const motivoObrigatorio = temDivergencia && qtdFisicaKg > 0;
  // Legado so aceita "recebido < NF" (delta negativo) — excedente nao e tratado
  const excedente = deltaKg > 1 && qtdFisicaKg > 0;
  const podeConfirmar = qtdFisicaKg > 0 && localidadeId
    && (!motivoObrigatorio || obs.trim().length > 0)
    && !excedente;

  const recebimentoMut = useMutation({
    mutationFn: async () =>
      apiFetch('/api/v1/stockbridge/recebimento', {
        method: 'POST',
        body: JSON.stringify({
          nf: item.nf,
          cnpj: item.cnpj,
          quantidade_input: parseFloat(qtdInput.replace(',', '.')),
          unidade_input: unidadeInput,
          localidade_id: localidadeId,
          observacoes: obs || undefined,
          tipo_divergencia: temDivergencia ? tipoDivergencia : undefined,
        }),
      }),
    onSuccess: (res) => {
      const data = res.data as { status: string; deltaKg?: number };
      if (data.status === 'aguardando_aprovacao') {
        const deltaAbs = Math.abs(data.deltaKg ?? 0);
        setSucesso({ tipo: 'divergencia', mensagem: `Recebido com divergencia de ${deltaAbs.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg — encaminhado para aprovacao do Gestor.` });
      } else {
        setSucesso({ tipo: 'ok', mensagem: 'Recebimento registrado com sucesso em ACXE + Q2P.' });
      }
    },
  });

  if (sucesso) {
    return (
      <Modal open title="Recebimento registrado" onClose={() => { onClose(); onSucesso(); }}>
        <div className="text-center py-6">
          <div className="text-5xl mb-3">{sucesso.tipo === 'divergencia' ? '⚠' : '✓'}</div>
          <p className="text-sm text-atlas-muted mb-4">{sucesso.mensagem}</p>
          <button
            onClick={() => { onClose(); onSucesso(); }}
            className="px-5 py-2 bg-atlas-btn-bg text-atlas-btn-text rounded text-sm font-medium"
          >
            Fechar
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open title={`Conferencia — ${item.produto.nome}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded text-sm">
          <div className="flex justify-between mb-1"><span className="text-atlas-muted">NF:</span><span className="font-mono">{item.nf}</span></div>
          <div className="flex justify-between mb-1"><span className="text-atlas-muted">CNPJ:</span><span>{item.cnpj.toUpperCase()}</span></div>
          <div className="flex justify-between"><span className="text-atlas-muted">Qtd NF:</span><span className="font-semibold">{item.qtdKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg <span className="text-xs text-atlas-muted font-normal">({(item.qtdKg / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} t)</span></span></div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-atlas-muted mb-1">Quantidade fisica recebida</label>
          <div className="grid grid-cols-[2fr_1fr] gap-2">
            <input
              value={qtdInput}
              onChange={(e) => setQtdInput(e.target.value)}
              autoFocus
              className={`w-full px-3 py-2 border rounded text-lg font-serif outline-none ${temDivergencia && qtdFisicaKg > 0 ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20' : 'border-slate-300 dark:border-slate-600'}`}
            />
            <select
              value={unidadeInput}
              onChange={(e) => setUnidadeInput(e.target.value as Unidade)}
              className="px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm outline-none"
            >
              <option value="t">t (tonelada)</option>
              <option value="kg">kg</option>
              <option value="saco">saco (25 kg)</option>
              <option value="bigbag">big bag (1 t)</option>
            </select>
          </div>
          {qtdFisicaKg > 0 && unidadeInput !== 'kg' && (
            <div className="text-xs text-atlas-muted mt-1">= {qtdFisicaKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg</div>
          )}
        </div>

        {qtdFisicaKg > 0 && (
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="p-2 bg-slate-50 dark:bg-slate-800 rounded">
              <div className="text-xs text-atlas-muted">NF</div>
              <div className="font-serif text-sm">{item.qtdKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg</div>
            </div>
            <div className="p-2 bg-slate-50 dark:bg-slate-800 rounded">
              <div className="text-xs text-atlas-muted">Recebido</div>
              <div className={`font-serif text-sm ${temDivergencia ? 'text-amber-700' : 'text-green-700'}`}>{qtdFisicaKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg</div>
            </div>
            <div className="p-2 bg-slate-50 dark:bg-slate-800 rounded">
              <div className="text-xs text-atlas-muted">Delta</div>
              <div className={`font-serif text-sm ${Math.abs(deltaKg) < 1 ? 'text-green-700' : deltaKg > 0 ? 'text-amber-700' : 'text-red-700'}`}>
                {deltaKg > 0 ? '+' : ''}{deltaKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg
              </div>
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-atlas-muted mb-1">Localidade destino *</label>
          <select
            value={localidadeId}
            onChange={(e) => setLocalidadeId(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
          >
            <option value="">— Selecione —</option>
            {localidades.filter((l) => l.ativo).map((l) => (
              <option key={l.id} value={l.id}>{l.codigo} — {l.nome}</option>
            ))}
          </select>
          {localidades.length === 0 && (
            <div className="text-xs text-atlas-muted mt-1">
              Nenhuma localidade ativa cadastrada. Peca ao gestor para cadastrar em /stockbridge/localidades.
            </div>
          )}
        </div>

        {motivoObrigatorio && (
          <div>
            <label className="block text-xs font-semibold text-atlas-muted mb-1">Tipo de divergencia *</label>
            <select
              value={tipoDivergencia}
              onChange={(e) => setTipoDivergencia(e.target.value as 'faltando' | 'varredura')}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
            >
              <option value="faltando">Faltando — material nao chegou (vai para ACXE-COMEX-FALTANDO)</option>
              <option value="varredura">Varredura — material para inspecao (vai para ACXE-VARREDURA)</option>
            </select>
            <div className="text-[11px] text-atlas-muted mt-1">
              Os {Math.abs(deltaKg).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg divergentes serao transferidos do Extrema para o estoque especial conforme o tipo escolhido.
            </div>
          </div>
        )}

        {excedente && (
          <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 rounded text-sm text-red-800 dark:text-red-300">
            Quantidade recebida nao pode ser maior que a NF. Se houve excedente, registre o recebimento normal e depois lance uma <strong>entrada manual</strong> para a diferenca.
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-atlas-muted mb-1">
            {motivoObrigatorio ? 'Motivo da divergencia (obrigatorio)' : 'Observacao (opcional)'}
          </label>
          <textarea
            value={obs}
            onChange={(e) => setObs(e.target.value)}
            rows={3}
            placeholder={motivoObrigatorio ? 'Ex: 2 big bags avariados na conferencia fisica' : 'Material conferido, embalagens integras'}
            className={`w-full px-3 py-2 border rounded text-sm outline-none ${motivoObrigatorio && !obs.trim() ? 'border-red-300' : 'border-slate-300 dark:border-slate-600'}`}
          />
        </div>

        {recebimentoMut.isError && (
          <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 rounded text-sm text-red-800 dark:text-red-300">
            {(recebimentoMut.error as Error).message}
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border border-slate-300 dark:border-slate-600 rounded text-sm">Cancelar</button>
          <button
            onClick={() => recebimentoMut.mutate()}
            disabled={!podeConfirmar || recebimentoMut.isPending}
            className={`px-5 py-2 rounded text-sm font-medium ${podeConfirmar && !recebimentoMut.isPending ? 'bg-atlas-btn-bg text-atlas-btn-text hover:opacity-90' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}
          >
            {recebimentoMut.isPending ? 'Enviando...' : temDivergencia ? 'Registrar com divergencia' : 'Confirmar recebimento'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
