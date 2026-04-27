import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

interface LadoCnpj {
  status: string | null;
  dt: string | null;
  idMovest: string | null;
  usuario: string | null;
}

interface Movimentacao {
  id: string;
  notaFiscal: string;
  tipoMovimento: string;
  subtipo: string | null;
  quantidadeKg: number;
  loteCodigo: string | null;
  observacoes: string | null;
  ladoAcxe: LadoCnpj;
  ladoQ2p: LadoCnpj;
  createdAt: string;
}

const TIPO_COLOR: Record<string, string> = {
  entrada_nf: 'bg-green-50 text-green-700 border-green-200',
  entrada_manual: 'bg-amber-50 text-amber-700 border-amber-200',
  saida_automatica: 'bg-blue-50 text-blue-700 border-blue-200',
  saida_manual: 'bg-orange-50 text-orange-700 border-orange-200',
  debito_cruzado: 'bg-red-50 text-red-700 border-red-200',
  regularizacao_fiscal: 'bg-violet-50 text-violet-700 border-violet-200',
  ajuste: 'bg-slate-50 text-slate-700 border-slate-200',
};

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers as Record<string, string>) };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    const body = (await res.json()) as { data: unknown; meta?: { total: number; page: number; pageSize: number }; error: { message?: string } | null };
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body;
  };
}

export function MovimentacoesPage() {
  const apiFetch = useApiFetch();
  const [page, setPage] = useState(1);
  const [filtroTipo, setFiltroTipo] = useState('');
  const [filtroNf, setFiltroNf] = useState('');
  const [filtroCnpj, setFiltroCnpj] = useState<'' | 'acxe' | 'q2p' | 'ambos'>('');

  const { data, isLoading, error } = useQuery<{ items: Movimentacao[]; total: number }>({
    queryKey: ['sb', 'movimentacoes', page, filtroTipo, filtroNf, filtroCnpj],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '50' });
      if (filtroTipo) params.set('tipoMovimento', filtroTipo);
      if (filtroNf) params.set('nf', filtroNf);
      if (filtroCnpj) params.set('cnpj', filtroCnpj);
      const body = await apiFetch(`/api/v1/stockbridge/movimentacoes?${params}`);
      return { items: body.data as Movimentacao[], total: body.meta?.total ?? 0 };
    },
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / 50)) : 1;

  return (
    <div className="p-6 max-w-7xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Movimentações</h1>
        <p className="text-sm text-atlas-muted">
          Log consolidado dual-CNPJ (ACXE + Q2P). Para reverter um lançamento, registre uma movimentação compensatória — soft delete daria divergência silenciosa com OMIE.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <input
          value={filtroNf}
          onChange={(e) => setFiltroNf(e.target.value)}
          placeholder="Buscar por NF..."
          className="px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm flex-1 min-w-48"
        />
        <select
          value={filtroTipo}
          onChange={(e) => { setPage(1); setFiltroTipo(e.target.value); }}
          className="px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
        >
          <option value="">Todos os tipos</option>
          <option value="entrada_nf">Entrada NF</option>
          <option value="entrada_manual">Entrada manual</option>
          <option value="saida_automatica">Saída automática</option>
          <option value="saida_manual">Saída manual</option>
          <option value="debito_cruzado">Débito cruzado</option>
          <option value="regularizacao_fiscal">Regularização fiscal</option>
          <option value="ajuste">Ajuste</option>
        </select>
        <select
          value={filtroCnpj}
          onChange={(e) => { setPage(1); setFiltroCnpj(e.target.value as '' | 'acxe' | 'q2p' | 'ambos'); }}
          className="px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
        >
          <option value="">Todos CNPJs</option>
          <option value="acxe">Só ACXE</option>
          <option value="q2p">Só Q2P</option>
          <option value="ambos">Ambos (dual)</option>
        </select>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
          {(error as Error).message}
        </div>
      )}

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando...</div>}

      {data && data.items.length === 0 && !isLoading && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-slate-300 dark:border-slate-700 rounded-lg">
          Nenhuma movimentação para os filtros aplicados.
        </div>
      )}

      {data && data.items.length > 0 && (
        <>
          <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden mb-3">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 dark:bg-slate-900/40 text-atlas-muted">
                <tr>
                  <th className="text-left px-3 py-2">Data</th>
                  <th className="text-left px-3 py-2">NF</th>
                  <th className="text-left px-3 py-2">Tipo</th>
                  <th className="text-right px-3 py-2">Qtd (kg)</th>
                  <th className="text-left px-3 py-2">Lote</th>
                  <th className="text-left px-3 py-2">ACXE</th>
                  <th className="text-left px-3 py-2">Q2P</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((m) => (
                  <tr key={m.id} className="border-t border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900/30">
                    <td className="px-3 py-2 text-atlas-muted">{new Date(m.createdAt).toLocaleString('pt-BR')}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{m.notaFiscal}</td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] px-2 py-0.5 rounded border ${TIPO_COLOR[m.tipoMovimento] ?? 'bg-slate-50 text-slate-700 border-slate-200'}`}>
                        {m.tipoMovimento}{m.subtipo ? ` · ${m.subtipo}` : ''}
                      </span>
                    </td>
                    <td className={`px-3 py-2 text-right font-serif ${m.quantidadeKg >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {m.quantidadeKg > 0 ? '+' : ''}{m.quantidadeKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-atlas-muted">{m.loteCodigo ?? '—'}</td>
                    <td className="px-3 py-2">
                      {m.ladoAcxe.status ? (
                        <div className="text-[11px]">
                          <div className={m.ladoAcxe.status === 'Sucesso' ? 'text-green-700' : 'text-red-700'}>{m.ladoAcxe.status}</div>
                          <div className="text-atlas-muted">{m.ladoAcxe.usuario ?? '—'}</div>
                        </div>
                      ) : (
                        <span className="text-atlas-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {m.ladoQ2p.status ? (
                        <div className="text-[11px]">
                          <div className={m.ladoQ2p.status === 'Sucesso' ? 'text-green-700' : 'text-red-700'}>{m.ladoQ2p.status}</div>
                          <div className="text-atlas-muted">{m.ladoQ2p.usuario ?? '—'}</div>
                        </div>
                      ) : (
                        <span className="text-atlas-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm">
            <div className="text-atlas-muted">
              {data.total} movimentações · Página {page} de {totalPages}
            </div>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1 border border-slate-300 rounded disabled:opacity-50"
              >
                ← Anterior
              </button>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-3 py-1 border border-slate-300 rounded disabled:opacity-50"
              >
                Próxima →
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
