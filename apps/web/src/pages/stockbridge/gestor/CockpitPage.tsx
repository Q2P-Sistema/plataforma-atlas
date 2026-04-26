import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';
import { ModalDivergencias } from './ModalDivergencias.js';

type Criticidade = 'critico' | 'alerta' | 'ok' | 'excesso';

interface CockpitSku {
  codigoAcxe: number;
  nome: string;
  familia: string | null;
  ncm: string | null;
  fisicaKg: number;
  fiscalKg: number;
  transitoIntlKg: number;
  portoDtaKg: number;
  transitoInternoKg: number;
  provisorioKg: number;
  consumoMedioDiarioKg: number | null;
  leadTimeDias: number | null;
  coberturaDias: number | null;
  criticidade: Criticidade;
  divergencias: number;
  aprovacoesPendentes: number;
}

interface CockpitResumo {
  totalFisicoKg: number;
  totalFiscalKg: number;
  transitoIntlKg: number;
  portoDtaKg: number;
  transitoInternoKg: number;
  provisorioKg: number;
  divergenciasCount: number;
  aprovacoesPendentes: number;
  skusCriticos: number;
  skusAlerta: number;
}

interface CockpitData {
  resumo: CockpitResumo;
  skus: CockpitSku[];
}

const CRIT_CFG: Record<Criticidade, { label: string; bg: string; text: string; bar: string }> = {
  critico: { label: 'Crítico',  bg: 'bg-red-50 dark:bg-red-900/20',    text: 'text-red-700 dark:text-red-300',    bar: 'bg-red-500' },
  alerta:  { label: 'Alerta',   bg: 'bg-amber-50 dark:bg-amber-900/20', text: 'text-amber-700 dark:text-amber-300', bar: 'bg-amber-500' },
  ok:      { label: 'OK',       bg: 'bg-green-50 dark:bg-green-900/20', text: 'text-green-700 dark:text-green-300', bar: 'bg-green-500' },
  excesso: { label: 'Excesso',  bg: 'bg-blue-50 dark:bg-blue-900/20',   text: 'text-blue-700 dark:text-blue-300',   bar: 'bg-blue-500' },
};

function fmtKg(n: number) {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', headers });
    const body = (await res.json()) as { data: unknown; error: { message?: string } | null };
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body;
  };
}

export function CockpitPage() {
  const apiFetch = useApiFetch();
  const [cnpjFilter, setCnpjFilter] = useState<'ambos' | 'acxe' | 'q2p'>('ambos');
  const [critFilter, setCritFilter] = useState<'todas' | Criticidade>('todas');
  const [showDivs, setShowDivs] = useState(false);

  const { data, isLoading, error } = useQuery<CockpitData>({
    queryKey: ['stockbridge', 'cockpit', cnpjFilter, critFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cnpjFilter !== 'ambos') params.set('cnpj', cnpjFilter);
      if (critFilter !== 'todas') params.set('criticidade', critFilter);
      const body = await apiFetch(`/api/v1/stockbridge/cockpit?${params}`);
      return body.data as CockpitData;
    },
  });

  const resumoCards = useMemo(() => {
    const r = data?.resumo;
    if (!r) return [];
    return [
      { label: 'Físico Disponível',  value: `${fmtKg(r.totalFisicoKg)} kg`, color: 'text-atlas-ink' },
      { label: 'Posição Fiscal',     value: `${fmtKg(r.totalFiscalKg)} kg`, color: 'text-atlas-ink' },
      { label: 'Trânsito Intl',      value: `${fmtKg(r.transitoIntlKg)} kg`, color: 'text-violet-700' },
      { label: 'Porto / DTA',        value: `${fmtKg(r.portoDtaKg)} kg`, color: 'text-orange-700' },
      { label: 'Trânsito Interno',   value: `${fmtKg(r.transitoInternoKg)} kg`, color: 'text-teal-700' },
      { label: 'Provisório',         value: `${fmtKg(r.provisorioKg)} kg`, color: 'text-amber-700' },
      { label: 'Divergências',       value: String(r.divergenciasCount), color: 'text-red-700', onClick: () => setShowDivs(true) },
      { label: 'Aprovações',         value: String(r.aprovacoesPendentes), color: 'text-amber-700' },
      { label: 'SKUs Críticos',      value: String(r.skusCriticos), color: 'text-red-700' },
      { label: 'SKUs Alerta',        value: String(r.skusAlerta), color: 'text-amber-700' },
    ];
  }, [data]);

  return (
    <div className="p-6 max-w-7xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Cockpit de Estoque</h1>
        <p className="text-sm text-atlas-muted">
          Saldo consolidado por SKU com cobertura em dias e criticidade segundo lead time e consumo médio.
        </p>
      </div>

      <div className="flex items-center gap-3 mb-5 text-sm">
        <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded">
          {(['ambos', 'acxe', 'q2p'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setCnpjFilter(v)}
              className={`px-3 py-1 rounded text-xs font-medium transition ${cnpjFilter === v ? 'bg-white dark:bg-slate-900 shadow-sm text-atlas-ink' : 'text-atlas-muted'}`}
            >
              {v === 'ambos' ? 'Ambos CNPJs' : v.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded">
          {(['todas', 'critico', 'alerta', 'ok', 'excesso'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setCritFilter(v)}
              className={`px-3 py-1 rounded text-xs font-medium transition ${critFilter === v ? 'bg-white dark:bg-slate-900 shadow-sm text-atlas-ink' : 'text-atlas-muted'}`}
            >
              {v === 'todas' ? 'Todas' : CRIT_CFG[v].label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          {(error as Error).message}
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-6">
          {resumoCards.map((c) => (
            <div
              key={c.label}
              onClick={c.onClick}
              className={`bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 ${c.onClick ? 'cursor-pointer hover:shadow-md transition-shadow' : ''}`}
            >
              <div className="text-xs text-atlas-muted mb-1">{c.label}</div>
              <div className={`font-serif text-lg ${c.color}`}>{c.value}</div>
            </div>
          ))}
        </div>
      )}

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando...</div>}

      {data && data.skus.length === 0 && !isLoading && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-slate-300 dark:border-slate-700 rounded-lg">
          Nenhum SKU com saldo encontrado neste filtro. Em dev sem sync OMIE, essa lista fica vazia.
        </div>
      )}

      {data && data.skus.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {data.skus.map((sku) => {
            const crit = CRIT_CFG[sku.criticidade];
            const pctCobertura = sku.coberturaDias != null && sku.leadTimeDias
              ? Math.min(100, (sku.coberturaDias / (sku.leadTimeDias * 4)) * 100)
              : 0;
            return (
              <div key={sku.codigoAcxe} className={`bg-white dark:bg-slate-800 border rounded-lg p-4 ${crit.bg} border-slate-200 dark:border-slate-700`}>
                <div className="flex justify-between items-start mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-serif text-base text-atlas-ink truncate">{sku.nome}</div>
                    <div className="text-xs text-atlas-muted mt-0.5">
                      {sku.familia ?? '—'} {sku.ncm ? `· ${sku.ncm}` : ''}
                    </div>
                  </div>
                  <span className={`text-xs font-semibold px-2 py-1 rounded ${crit.bg} ${crit.text}`}>{crit.label}</span>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-3">
                  <Cell label="Físico" value={`${fmtKg(sku.fisicaKg)} kg`} />
                  <Cell label="Fiscal" value={`${fmtKg(sku.fiscalKg)} kg`} accent={Math.abs(sku.fisicaKg - sku.fiscalKg) > 1 ? 'text-red-700' : undefined} />
                  <Cell label="Trânsito intl" value={`${fmtKg(sku.transitoIntlKg)} kg`} accent="text-violet-700" />
                  <Cell label="Trânsito int." value={`${fmtKg(sku.transitoInternoKg)} kg`} accent="text-teal-700" />
                </div>

                <div className="mb-2">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-atlas-muted">Cobertura</span>
                    <span className={`font-medium ${crit.text}`}>
                      {sku.coberturaDias != null ? `${sku.coberturaDias}d` : 'sem consumo médio'}
                    </span>
                  </div>
                  <div className="h-1.5 bg-slate-200 dark:bg-slate-700 rounded overflow-hidden">
                    <div className={`h-full ${crit.bar} transition-all`} style={{ width: `${pctCobertura}%` }} />
                  </div>
                  <div className="flex justify-between text-[10px] text-atlas-muted mt-0.5">
                    <span>0</span>
                    {sku.leadTimeDias && <span>Lead {sku.leadTimeDias}d</span>}
                    {sku.leadTimeDias && <span>Alvo {sku.leadTimeDias * 4}d</span>}
                  </div>
                </div>

                <div className="flex gap-2 text-[11px]">
                  {sku.divergencias > 0 && (
                    <span className="px-2 py-0.5 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded">
                      {sku.divergencias} div
                    </span>
                  )}
                  {sku.aprovacoesPendentes > 0 && (
                    <span className="px-2 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 rounded">
                      {sku.aprovacoesPendentes} apr
                    </span>
                  )}
                  {sku.provisorioKg > 0 && (
                    <span className="px-2 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 rounded">
                      +{fmtKg(sku.provisorioKg)}kg prov
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showDivs && <ModalDivergencias onClose={() => setShowDivs(false)} />}
    </div>
  );
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-slate-50 dark:bg-slate-900/40 rounded p-2">
      <div className="text-[10px] text-atlas-muted">{label}</div>
      <div className={`font-serif text-sm ${accent ?? 'text-atlas-ink'}`}>{value}</div>
    </div>
  );
}
