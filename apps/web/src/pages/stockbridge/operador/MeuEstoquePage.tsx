import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

type Empresa = 'ACXE' | 'Q2P' | 'Ambos';

interface MeuEstoqueItem {
  empresa: 'ACXE' | 'Q2P';
  codigoEstoque: string;
  descricaoEstoque: string;
  codigoProduto: string;
  descricaoProduto: string;
  descricaoFamilia: string | null;
  ncm: string | null;
  saldoKg: number;
  reservadoKg: number;
  volumeTotalKg: number;
}

interface MeuEstoqueResponse {
  galpoes: string[];
  principal: MeuEstoqueItem[];
  especiais: MeuEstoqueItem[];
}

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', headers });
    const body = (await res.json()) as { data: unknown; error: { message?: string; code?: string } | null };
    if (!res.ok) {
      const err = new Error(body.error?.message ?? 'Erro') as Error & { code?: string };
      err.code = body.error?.code;
      throw err;
    }
    return body;
  };
}

const GRID_COLS = 'grid-cols-[3fr_1.5fr_1fr_1.3fr_1fr_1fr]';
const fmtKg = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });

function filtrarItens(itens: MeuEstoqueItem[], busca: string): MeuEstoqueItem[] {
  if (!busca) return itens;
  const b = busca.toLowerCase();
  return itens.filter((i) =>
    i.descricaoProduto.toLowerCase().includes(b) ||
    i.codigoProduto.includes(busca) ||
    (i.descricaoFamilia?.toLowerCase().includes(b) ?? false),
  );
}

function TabelaEstoque({
  itens,
  vazioMsg,
  showEstoqueColumn = true,
}: {
  itens: MeuEstoqueItem[];
  vazioMsg: string;
  showEstoqueColumn?: boolean;
}) {
  return (
    <div
      className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-y-auto"
      style={{ maxHeight: 'calc(100vh - 320px)' }}
    >
      <div className={`sticky top-0 z-10 bg-slate-100 dark:bg-slate-900 border-b-2 border-slate-300 dark:border-slate-600 grid ${GRID_COLS} text-xs text-atlas-muted font-semibold px-3 py-2`}>
        <div>Produto</div>
        <div>Família</div>
        <div>Empresa</div>
        <div>{showEstoqueColumn ? 'Estoque' : 'Local'}</div>
        <div className="text-right">Saldo (kg)</div>
        <div className="text-right">Reservado (kg)</div>
      </div>

      <div>
        {itens.length === 0 && (
          <div className="text-xs text-atlas-muted italic px-3 py-6 text-center">{vazioMsg}</div>
        )}
        {itens.map((p) => (
          <div
            key={`${p.empresa}-${p.codigoEstoque}-${p.codigoProduto}`}
            className={`grid ${GRID_COLS} text-xs border-b border-slate-100 dark:border-slate-700/60 px-3 py-2 hover:bg-slate-50/60 dark:hover:bg-slate-900/30 items-center`}
          >
            <div>
              <div className="font-medium text-atlas-ink truncate" title={p.descricaoProduto}>{p.descricaoProduto}</div>
              <div className="text-[10px] font-mono text-atlas-muted">{p.codigoProduto}</div>
            </div>
            <div className="text-atlas-muted truncate" title={p.descricaoFamilia ?? ''}>{p.descricaoFamilia ?? '—'}</div>
            <div>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                p.empresa === 'ACXE'
                  ? 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
                  : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
              }`}>
                {p.empresa}
              </span>
            </div>
            <div className="text-atlas-muted text-[11px]">
              <span className="font-mono">{p.codigoEstoque}</span>
              <span className="block text-[10px]">{p.descricaoEstoque}</span>
            </div>
            <div className="text-right font-mono">{fmtKg(p.saldoKg)}</div>
            <div className="text-right font-mono text-atlas-muted">{p.reservadoKg > 0 ? fmtKg(p.reservadoKg) : '—'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MeuEstoquePage() {
  const apiFetch = useApiFetch();
  const [busca, setBusca] = useState('');
  const [empresa, setEmpresa] = useState<Empresa>('Q2P');

  const { data, isLoading, error } = useQuery<MeuEstoqueResponse, Error & { code?: string }>({
    queryKey: ['sb', 'meu-estoque', empresa],
    queryFn: async () => {
      const params = new URLSearchParams({ empresa });
      const body = await apiFetch(`/api/v1/stockbridge/meu-estoque?${params}`);
      return body.data as MeuEstoqueResponse;
    },
  });

  const semGalpao = error?.code === 'SEM_GALPAO_VINCULADO';

  const principalFiltrado = filtrarItens(data?.principal ?? [], busca);
  const especiaisFiltrado = filtrarItens(data?.especiais ?? [], busca);

  const totalPrincipalKg = principalFiltrado.reduce((acc, i) => acc + i.saldoKg, 0);
  const totalEspeciaisKg = especiaisFiltrado.reduce((acc, i) => acc + i.saldoKg, 0);

  return (
    <div className="p-6 max-w-6xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Meu Estoque</h1>
        <p className="text-sm text-atlas-muted">
          Saldo físico dos SKUs no(s) galpão(ões) vinculados ao seu usuário. Dados sincronizados do OMIE
          (vw_posicaoEstoqueUnificadaFamilia).
          {data?.galpoes && data.galpoes.length > 0 && (
            <> Galpão(ões): <strong>{data.galpoes.join(', ')}</strong>.</>
          )}
          {data?.galpoes && data.galpoes.length === 0 && (
            <> Visualizando <strong>todos os galpões</strong> (perfil gestor/diretor).</>
          )}
        </p>
      </div>

      {semGalpao && (
        <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 rounded text-sm text-amber-800 dark:text-amber-300">
          Você não tem nenhum galpão vinculado. Solicite ao gestor para configurar via{' '}
          <code className="font-mono">stockbridge.user_galpao</code>.
        </div>
      )}

      {error && !semGalpao && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 rounded text-sm text-red-800 dark:text-red-300">
          {error.message}
        </div>
      )}

      {!semGalpao && (
        <>
          <div className="flex gap-3 mb-4 items-center">
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por nome, código ou família..."
              className="flex-1 px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
            />
            <select
              value={empresa}
              onChange={(e) => setEmpresa(e.target.value as Empresa)}
              className="px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
            >
              <option value="Q2P">Q2P</option>
              <option value="ACXE">ACXE</option>
              <option value="Ambos">Ambos</option>
            </select>
          </div>

          {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando...</div>}

          {data && (
            <>
              <h2 className="font-serif text-lg text-atlas-ink mt-2 mb-2">
                Estoque físico
                <span className="text-xs font-sans text-atlas-muted ml-2">
                  · {principalFiltrado.length} SKU{principalFiltrado.length !== 1 ? 's' : ''}
                  {' · '}
                  {(totalPrincipalKg / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} t
                </span>
              </h2>
              <TabelaEstoque itens={principalFiltrado} vazioMsg="Sem saldo no(s) galpão(ões)" />

              <h2 className="font-serif text-lg text-atlas-ink mt-6 mb-2">
                Estoques especiais
                <span className="text-xs font-sans text-atlas-muted ml-2">
                  · VARREDURA, FALTANDO, TRÂNSITO, TROCA — {especiaisFiltrado.length} SKU{especiaisFiltrado.length !== 1 ? 's' : ''}
                  {' · '}
                  {(totalEspeciaisKg / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} t
                </span>
              </h2>
              <TabelaEstoque itens={especiaisFiltrado} vazioMsg="Sem saldo nos estoques especiais" />
            </>
          )}
        </>
      )}
    </div>
  );
}
