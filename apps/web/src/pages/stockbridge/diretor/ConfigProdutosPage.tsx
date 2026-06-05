import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

type CamadaConsumo = '70/30' | '90d' | '365d' | null;

interface ConfigProduto {
  produtoCodigoAcxe: number;
  nomeProduto: string;
  familiaOmie: string | null;
  familiaAtlas: string | null;
  familiaAtlasNomeCompleto: string | null;
  consumoMedioDiarioKg: number | null;
  camadaConsumo: CamadaConsumo;
  leadTimeDias: number | null;
  incluirEmMetricas: boolean;
}

const CAMADA_LABEL: Record<NonNullable<CamadaConsumo>, { label: string; cls: string; tooltip: string }> = {
  '70/30': {
    label: '70/30',
    cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    tooltip: 'Composição preferida: 70% × média 90d + 30% × mesmo mês ano anterior. Captura sazonalidade.',
  },
  '90d': {
    label: '90d',
    cls: 'bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
    tooltip: 'Média dos últimos 90 dias. Usado quando o mesmo mês do ano anterior não tem vendas.',
  },
  '365d': {
    label: '365d',
    cls: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    tooltip: 'Média dos últimos 365 dias. Fallback para produtos com vendas antigas mas zero nos últimos 90 dias.',
  },
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

const GRID_COLS = 'grid-cols-[3fr_2fr_1.5fr_1fr_0.7fr_1fr_1fr]';

export function ConfigProdutosPage() {
  const apiFetch = useApiFetch();
  const [busca, setBusca] = useState('');

  const { data = [] } = useQuery<ConfigProduto[]>({
    queryKey: ['sb', 'config-produtos'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/config/produtos')).data as ConfigProduto[],
  });

  const filtrado = data.filter((p) =>
    !busca ||
    p.nomeProduto.toLowerCase().includes(busca.toLowerCase()) ||
    String(p.produtoCodigoAcxe).includes(busca) ||
    (p.familiaOmie?.toLowerCase().includes(busca.toLowerCase()) ?? false) ||
    (p.familiaAtlas?.toLowerCase().includes(busca.toLowerCase()) ?? false),
  );

  return (
    <div className="p-6 max-w-6xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Indicadores por Produto</h1>
        <p className="text-sm text-atlas-muted mb-2">
          Consumo médio diário (kg/dia), lead time e família por SKU. Dados sincronizados do banco — sem edição manual.
        </p>
        <details className="text-xs text-atlas-muted">
          <summary className="cursor-pointer hover:text-atlas-ink select-none">
            Como o consumo médio diário é calculado?
          </summary>
          <div className="mt-2 pl-4 border-l-2 border-slate-200 dark:border-slate-700 space-y-1">
            <p>
              Soma das vendas Q2P + ACXE (excluindo transferências intercompany ACXE→Q2P), apurada via fallback em 3 camadas:
            </p>
            <ol className="list-decimal list-inside space-y-0.5 ml-1">
              <li>
                <strong>70/30 (preferida):</strong> 70% × média dos últimos 90 dias + 30% × média do mesmo mês do ano anterior — captura sazonalidade quando há histórico anual.
              </li>
              <li>
                <strong>90 dias puro:</strong> usado quando o mesmo mês do ano anterior está vazio (ex.: produto novo, ou histórico OMIE recente).
              </li>
              <li>
                <strong>365 dias puro:</strong> fallback final para produtos com vendas antigas mas zero nos últimos 90 dias.
              </li>
            </ol>
            <p>
              Match Q2P↔ACXE por descrição textual (códigos OMIE são aleatórios por empresa). Produtos sem venda em 365d em ambas as empresas aparecem como <em>Sem dados</em>.
            </p>
            <p className="text-[10px] mt-1">
              Atualização automática a cada 60 minutos no primeiro acesso da janela.
            </p>
          </div>
        </details>
      </div>

      <input
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder="Buscar por nome, código ou família..."
        className="w-full mb-4 px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
      />

      <div
        className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-y-auto"
        style={{ maxHeight: 'calc(100vh - 240px)' }}
      >
        <div className={`sticky top-0 z-10 bg-slate-100 dark:bg-slate-900 border-b-2 border-slate-300 dark:border-slate-600 grid ${GRID_COLS} text-xs text-atlas-muted font-semibold px-3 py-2`}>
          <div>SKU</div>
          <div>Família OMIE</div>
          <div>Família Atlas</div>
          <div className="text-right">Consumo (kg/dia)</div>
          <div className="text-center">Regra</div>
          <div className="text-right">Lead Time (dias)</div>
          <div className="text-center">Em métricas</div>
        </div>

        <div>
          {filtrado.map((p) => (
            <div
              key={p.produtoCodigoAcxe}
              className={`grid ${GRID_COLS} text-xs border-b border-slate-100 dark:border-slate-700/60 px-3 py-2 hover:bg-slate-50/60 dark:hover:bg-slate-900/30 items-center`}
            >
              <div>
                <div className="font-medium">{p.nomeProduto}</div>
                <div className="text-[10px] font-mono text-atlas-muted">{p.produtoCodigoAcxe}</div>
              </div>
              <div className="text-atlas-muted">{p.familiaOmie ?? '—'}</div>
              <div className="text-atlas-muted">
                {p.familiaAtlas ? (
                  <>
                    {p.familiaAtlas}
                    {p.familiaAtlasNomeCompleto && (
                      <span className="text-[10px] ml-1">({p.familiaAtlasNomeCompleto})</span>
                    )}
                  </>
                ) : (
                  '—'
                )}
              </div>
              <div className="text-right">
                {p.consumoMedioDiarioKg != null ? (
                  p.consumoMedioDiarioKg.toFixed(2)
                ) : (
                  <span className="text-atlas-muted italic">Sem dados</span>
                )}
              </div>
              <div className="text-center">
                {p.camadaConsumo ? (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CAMADA_LABEL[p.camadaConsumo].cls}`}
                    title={CAMADA_LABEL[p.camadaConsumo].tooltip}
                  >
                    {CAMADA_LABEL[p.camadaConsumo].label}
                  </span>
                ) : (
                  <span className="text-atlas-muted">—</span>
                )}
              </div>
              <div className="text-right">{p.leadTimeDias ?? '—'}</div>
              <div className="text-center">
                <span className={`text-xs px-2 py-0.5 rounded ${p.incluirEmMetricas ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                  {p.incluirEmMetricas ? 'sim' : 'não'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
