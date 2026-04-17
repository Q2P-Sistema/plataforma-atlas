import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

type Subtipo = 'transf_intra_cnpj' | 'comodato' | 'amostra' | 'descarte' | 'quebra' | 'inventario_menos';
type Unidade = 't' | 'kg' | 'saco' | 'bigbag';

const SUBTIPO_CFG: Record<Subtipo, { label: string; nivel: 'gestor' | 'diretor'; help: string }> = {
  transf_intra_cnpj: { label: 'Transferencia intra-CNPJ',  nivel: 'gestor',  help: 'Mesmo CNPJ, outro armazem — sem impacto fiscal' },
  comodato:          { label: 'Comodato / emprestimo',     nivel: 'diretor', help: 'Saida temporaria — fiscal permanece; requer diretor' },
  amostra:           { label: 'Amostra / brinde',          nivel: 'gestor',  help: 'Saida definitiva sem venda — gera divergencia fiscal' },
  descarte:          { label: 'Descarte / perda',          nivel: 'gestor',  help: 'Material inutilizavel — gera divergencia fiscal' },
  quebra:            { label: 'Quebra tecnica',            nivel: 'gestor',  help: 'Perda no manuseio — gera divergencia fiscal' },
  inventario_menos:  { label: 'Ajuste inventario (-)',     nivel: 'gestor',  help: 'Contagem apurou saldo menor — gera divergencia' },
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

export function SaidaManualPage() {
  const apiFetch = useApiFetch();
  const [subtipo, setSubtipo] = useState<Subtipo>('descarte');
  const [loteId, setLoteId] = useState('');
  const [quantidade, setQuantidade] = useState('');
  const [unidade, setUnidade] = useState<Unidade>('t');
  const [referencia, setReferencia] = useState('');
  const [observacoes, setObservacoes] = useState('');

  const cfg = SUBTIPO_CFG[subtipo];

  const mut = useMutation({
    mutationFn: async () =>
      apiFetch('/api/v1/stockbridge/saida-manual', {
        method: 'POST',
        body: JSON.stringify({
          subtipo,
          lote_id: loteId,
          quantidade_original: parseFloat(quantidade.replace(',', '.')),
          unidade,
          referencia: referencia || undefined,
          observacoes,
        }),
      }),
    onSuccess: () => {
      setLoteId('');
      setQuantidade('');
      setReferencia('');
      setObservacoes('');
    },
  });

  const qtdNum = parseFloat(quantidade.replace(',', '.'));
  const podeEnviar = loteId && Number.isFinite(qtdNum) && qtdNum > 0 && observacoes.trim().length > 0;

  return (
    <div className="p-6 max-w-2xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Saida Manual</h1>
        <p className="text-sm text-atlas-muted">
          Registre saidas sem NF no OMIE (comodato, descarte, amostra, etc). Toda saida manual
          passa por aprovacao de gestor ou diretor — o saldo so e debitado apos aprovacao.
        </p>
      </div>

      {mut.isSuccess && (
        <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 rounded text-sm text-green-800 dark:text-green-300">
          ✓ Saida registrada. Aguardando aprovacao de <strong>{cfg.nivel}</strong>.
        </div>
      )}

      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-5 space-y-4">
        <div>
          <label className="block text-xs font-semibold text-atlas-muted mb-1">Tipo de saida *</label>
          <select
            value={subtipo}
            onChange={(e) => setSubtipo(e.target.value as Subtipo)}
            className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
          >
            {(Object.keys(SUBTIPO_CFG) as Subtipo[]).map((s) => (
              <option key={s} value={s}>{SUBTIPO_CFG[s].label}</option>
            ))}
          </select>
          <div className="mt-1 text-xs text-atlas-muted">{cfg.help}</div>
          <div className={`mt-1 text-xs font-semibold ${cfg.nivel === 'diretor' ? 'text-purple-700' : 'text-amber-700'}`}>
            ⚠ Requer aprovacao de <strong>{cfg.nivel.toUpperCase()}</strong>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-atlas-muted mb-1">UUID do lote *</label>
          <input
            value={loteId}
            onChange={(e) => setLoteId(e.target.value)}
            placeholder="uuid do lote (consulte via Cockpit ou SQL)"
            className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-xs font-mono"
          />
        </div>

        <div className="grid grid-cols-[2fr_1fr] gap-2">
          <div>
            <label className="block text-xs font-semibold text-atlas-muted mb-1">Quantidade *</label>
            <input
              value={quantidade}
              onChange={(e) => setQuantidade(e.target.value)}
              placeholder="0,000"
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm font-serif"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-atlas-muted mb-1">Unidade</label>
            <select
              value={unidade}
              onChange={(e) => setUnidade(e.target.value as Unidade)}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
            >
              <option value="t">t</option>
              <option value="kg">kg</option>
              <option value="saco">saco (25 kg)</option>
              <option value="bigbag">big bag (1 t)</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-atlas-muted mb-1">Referencia (opcional)</label>
          <input
            value={referencia}
            onChange={(e) => setReferencia(e.target.value)}
            placeholder={subtipo === 'comodato' ? 'Ex: COM-2026-001' : 'Ex: DESC-2026-042'}
            className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-atlas-muted mb-1">Motivo / observacoes *</label>
          <textarea
            value={observacoes}
            onChange={(e) => setObservacoes(e.target.value)}
            rows={3}
            placeholder="Explique o motivo da saida (obrigatorio)"
            className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
          />
        </div>

        {mut.isError && (
          <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
            {(mut.error as Error).message}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={() => mut.mutate()}
            disabled={!podeEnviar || mut.isPending}
            className={`px-5 py-2 rounded text-sm font-medium ${podeEnviar ? 'bg-atlas-ink text-white hover:opacity-90' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}
          >
            {mut.isPending ? 'Enviando...' : 'Registrar saida (aguarda aprovacao)'}
          </button>
        </div>
      </div>
    </div>
  );
}
