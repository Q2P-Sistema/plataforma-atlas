import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';
import { TIPO_MOVIMENTO_LABEL, SUBTIPO_LABEL, rotulo } from '../labels.js';

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
  produtoCodigoAcxe: number | null;
  produtoDescricao: string | null;
  galpao: string | null;
  empresa: 'acxe' | 'q2p' | null;
  criadoPor: { id: string | null; nome: string | null };
  aprovadoPor: { id: string | null; nome: string | null; em: string | null };
  statusOmie: string | null;
  ladoAcxe: LadoCnpj;
  ladoQ2p: LadoCnpj;
  createdAt: string;
}

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

/**
 * Resolve quais empresas foram tocadas na movimentacao. Quando os dois lados
 * OMIE foram gravados (ladoAcxe.idMovest E ladoQ2p.idMovest), e dual ACXE+Q2P.
 * Senao, cai pra empresa primaria armazenada na linha (m.empresa).
 */
function resolverEmpresas(m: Movimentacao): string {
  const temAcxe = !!m.ladoAcxe.idMovest;
  const temQ2p = !!m.ladoQ2p.idMovest;
  if (temAcxe && temQ2p) return 'ACXE + Q2P';
  if (temAcxe) return 'ACXE';
  if (temQ2p) return 'Q2P';
  return m.empresa ? m.empresa.toUpperCase() : '—';
}

const TIPO_COLOR: Record<string, string> = {
  entrada_nf: 'bg-green-50 text-green-700 border-green-200',
  entrada_manual: 'bg-amber-50 text-amber-700 border-amber-200',
  saida_automatica: 'bg-blue-50 text-blue-700 border-blue-200',
  saida_manual: 'bg-orange-50 text-orange-700 border-orange-200',
  debito_cruzado: 'bg-red-50 text-red-700 border-red-200',
  regularizacao_fiscal: 'bg-violet-50 text-violet-700 border-violet-200',
  ajuste: 'bg-atlas-muted/20 text-atlas-muted border-atlas-border',
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
  const role = useAuthStore((s) => s.user?.role) ?? 'operador';
  const [page, setPage] = useState(1);
  const [filtroTipo, setFiltroTipo] = useState('');
  const [filtroSubtipo, setFiltroSubtipo] = useState('');
  const [filtroNf, setFiltroNf] = useState('');
  const [filtroCnpj, setFiltroCnpj] = useState<'' | 'acxe' | 'q2p' | 'ambos'>('');
  const [apenasMinhas, setApenasMinhas] = useState(role === 'operador');

  const { data, isLoading, error } = useQuery<{ items: Movimentacao[]; total: number }>({
    queryKey: ['sb', 'movimentacoes', page, filtroTipo, filtroSubtipo, filtroNf, filtroCnpj, apenasMinhas],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '50' });
      if (filtroTipo) params.set('tipoMovimento', filtroTipo);
      if (filtroSubtipo) params.set('subtipo', filtroSubtipo);
      if (filtroNf) params.set('nf', filtroNf);
      if (filtroCnpj) params.set('cnpj', filtroCnpj);
      if (apenasMinhas) params.set('apenasMinhas', 'true');
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
          className="px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm flex-1 min-w-48"
        />
        <select
          value={filtroTipo}
          onChange={(e) => { setPage(1); setFiltroTipo(e.target.value); setFiltroSubtipo(''); }}
          className="px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm"
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
        {filtroTipo === 'saida_manual' && (
          <select
            value={filtroSubtipo}
            onChange={(e) => { setPage(1); setFiltroSubtipo(e.target.value); }}
            className="px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm"
          >
            <option value="">Todos subtipos</option>
            <option value="transf_intra_cnpj">Transferência intra-CNPJ</option>
            <option value="comodato">Comodato</option>
            <option value="amostra">Amostra</option>
            <option value="descarte">Descarte</option>
            <option value="quebra">Quebra</option>
            <option value="inventario_menos">Inventário (-)</option>
          </select>
        )}
        <select
          value={filtroCnpj}
          onChange={(e) => { setPage(1); setFiltroCnpj(e.target.value as '' | 'acxe' | 'q2p' | 'ambos'); }}
          className="px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm"
        >
          <option value="">Todos CNPJs</option>
          <option value="acxe">Só ACXE</option>
          <option value="q2p">Só Q2P</option>
          <option value="ambos">Ambos (dual)</option>
        </select>
        {role !== 'operador' && (
          <label className="flex items-center gap-1.5 px-3 py-2 border border-atlas-border rounded text-sm cursor-pointer hover:bg-atlas-bg/60">
            <input
              type="checkbox"
              checked={apenasMinhas}
              onChange={(e) => { setPage(1); setApenasMinhas(e.target.checked); }}
              className="rounded"
            />
            Apenas minhas
          </label>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
          {(error as Error).message}
        </div>
      )}

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando...</div>}

      {data && data.items.length === 0 && !isLoading && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-atlas-border rounded-lg">
          Nenhuma movimentação para os filtros aplicados.
        </div>
      )}

      {data && data.items.length > 0 && (
        <>
          <div
            className="bg-atlas-card border border-atlas-border rounded-lg overflow-y-auto mb-3"
            style={{ maxHeight: 'calc(100vh - 320px)' }}
          >
            <table className="w-full text-xs">
              <thead className="bg-atlas-bg text-atlas-muted sticky top-0 z-10 border-b-2 border-atlas-border">
                <tr>
                  <th className="text-left px-3 py-2">Data</th>
                  <th className="text-left px-3 py-2">Produto</th>
                  <th className="text-right px-3 py-2">Qtd (kg)</th>
                  <th className="text-left px-3 py-2">NF</th>
                  <th className="text-left px-3 py-2">Empresa(s) / Galpão</th>
                  <th className="text-left px-3 py-2">Lançado por</th>
                  <th className="text-left px-3 py-2">Aprovado por</th>
                  <th className="text-left px-3 py-2">Status OMIE</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((m) => (
                  <tr key={m.id} className="border-t border-atlas-border hover:bg-atlas-bg/60">
                    <td className="px-3 py-2 text-atlas-muted">{new Date(m.createdAt).toLocaleString('pt-BR')}</td>
                    <td className="px-3 py-2 text-[11px]">
                      {m.produtoDescricao ? (
                        <div>
                          <div className="text-atlas-ink font-medium">{m.produtoDescricao}</div>
                          <div>
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded border ${TIPO_COLOR[m.tipoMovimento] ?? 'bg-atlas-muted/20 text-atlas-muted border-atlas-border'}`}
                            >
                              {rotulo(TIPO_MOVIMENTO_LABEL, m.tipoMovimento)}{m.subtipo ? ` · ${rotulo(SUBTIPO_LABEL, m.subtipo)}` : ''}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded border ${TIPO_COLOR[m.tipoMovimento] ?? 'bg-atlas-muted/20 text-atlas-muted border-atlas-border'}`}
                        >
                          {rotulo(TIPO_MOVIMENTO_LABEL, m.tipoMovimento)}{m.subtipo ? ` · ${rotulo(SUBTIPO_LABEL, m.subtipo)}` : ''}
                        </span>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-right font-serif ${m.quantidadeKg >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {m.quantidadeKg > 0 ? '+' : ''}{m.quantidadeKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg
                    </td>
                    <td className="px-3 py-2 text-[10px] font-mono text-atlas-muted">{m.notaFiscal}</td>
                    <td className="px-3 py-2 text-[11px] text-atlas-muted">
                      {m.galpao ? (
                        <div>
                          <div className="text-[10px] font-semibold text-atlas-ink">{resolverEmpresas(m)}</div>
                          <div>{labelGalpao(m.galpao)}</div>
                        </div>
                      ) : m.loteCodigo ? (
                        <div>
                          <div className="text-[10px] font-semibold text-atlas-ink">{resolverEmpresas(m)}</div>
                          <div className="font-mono text-[10px]">{m.loteCodigo}</div>
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2 text-[11px]">{m.criadoPor.nome ?? '—'}</td>
                    <td className="px-3 py-2 text-[11px]">
                      {m.aprovadoPor.nome ? (
                        <div>
                          <div>{m.aprovadoPor.nome}</div>
                          {m.aprovadoPor.em && (
                            <div className="text-[10px] text-atlas-muted">
                              {new Date(m.aprovadoPor.em).toLocaleString('pt-BR')}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-atlas-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {m.statusOmie === 'concluida' ? (
                        <span className="text-[10px] px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded">Concluída</span>
                      ) : m.statusOmie === 'pendente_q2p' ? (
                        <span className="text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded">Pendente</span>
                      ) : m.statusOmie === 'pendente_acxe_faltando' ? (
                        <span className="text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded">Pend. ACXE</span>
                      ) : m.statusOmie === 'falha' ? (
                        <span className="text-[10px] px-1.5 py-0.5 bg-red-50 text-red-700 rounded">Falha</span>
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
                className="px-3 py-1 border border-atlas-border rounded disabled:opacity-50"
              >
                ← Anterior
              </button>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-3 py-1 border border-atlas-border rounded disabled:opacity-50"
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
