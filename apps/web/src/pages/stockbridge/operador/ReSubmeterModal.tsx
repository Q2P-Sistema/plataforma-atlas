import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Modal } from '@atlas/ui';
import { useAuthStore } from '../../../stores/auth.store.js';

interface Props {
  aprovacaoId: string;
  loteCodigo: string;
  quantidadeOriginalKg: number;
  motivoRejeicao: string;
  onClose: () => void;
  onSucesso: () => void;
}

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

export function ReSubmeterModal({ aprovacaoId, loteCodigo, quantidadeOriginalKg, motivoRejeicao, onClose, onSucesso }: Props) {
  const apiFetch = useApiFetch();
  const [quantidade, setQuantidade] = useState(String(quantidadeOriginalKg));
  const [observacoes, setObservacoes] = useState('');

  const resubmeterMut = useMutation({
    mutationFn: async () =>
      apiFetch(`/api/v1/stockbridge/aprovacoes/${aprovacaoId}/resubmeter`, {
        method: 'POST',
        body: JSON.stringify({
          quantidade_recebida_kg: parseFloat(quantidade.replace(',', '.')),
          observacoes,
        }),
      }),
    onSuccess: onSucesso,
  });

  const qtdNum = parseFloat(quantidade.replace(',', '.'));
  const podeEnviar = Number.isFinite(qtdNum) && qtdNum > 0 && observacoes.trim().length > 0;

  return (
    <Modal open title="Re-submeter recebimento rejeitado" onClose={onClose}>
      <div className="space-y-3">
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 rounded text-sm">
          <div className="font-semibold text-red-800 dark:text-red-300 mb-1">Rejeitado pelo gestor</div>
          <p className="text-red-700 dark:text-red-300 italic">"{motivoRejeicao || 'sem motivo registrado'}"</p>
        </div>
        <p className="text-sm text-atlas-muted">
          Lote <strong>{loteCodigo}</strong> — corrija a quantidade e/ou motivo e envie para nova aprovação.
        </p>

        <div>
          <label className="block text-xs font-semibold text-atlas-muted mb-1">Nova quantidade recebida (kg)</label>
          <input
            value={quantidade}
            onChange={(e) => setQuantidade(e.target.value)}
            autoFocus
            className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded font-serif text-lg"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-atlas-muted mb-1">Nova observação / motivo *</label>
          <textarea
            value={observacoes}
            onChange={(e) => setObservacoes(e.target.value)}
            rows={3}
            placeholder="Ex: Recontagem encontrou 2t adicionais"
            className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
          />
        </div>

        {resubmeterMut.isError && (
          <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
            {(resubmeterMut.error as Error).message}
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border border-slate-300 rounded text-sm">Cancelar</button>
          <button
            onClick={() => resubmeterMut.mutate()}
            disabled={!podeEnviar || resubmeterMut.isPending}
            className={`px-5 py-2 rounded text-sm font-medium ${podeEnviar ? 'bg-atlas-btn-bg text-atlas-btn-text' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}
          >
            {resubmeterMut.isPending ? 'Enviando...' : 'Re-submeter para aprovação'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
