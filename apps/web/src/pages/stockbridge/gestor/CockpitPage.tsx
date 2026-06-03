import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info, ArrowRight } from 'lucide-react';
import { useAuthStore } from '../../../stores/auth.store.js';

type Criticidade = 'critico' | 'alerta' | 'ok' | 'excesso';

interface CockpitSku {
  codigoAcxe: number;
  nome: string;
  familia: string | null;
  ncm: string | null;
  fisicaKg: number;
  fiscalKg: number;
  fiscalPendenteNacionalKg: number;
  fiscalPendenteImportacaoKg: number;
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
  totalFiscalPendenteNacionalKg: number;
  totalFiscalPendenteImportacaoKg: number;
  transitoIntlKg: number;
  portoDtaKg: number;
  transitoInternoKg: number;
  provisorioKg: number;
  divergenciasCount: number;
  aprovacoesPendentes: number;
  skusCriticos: number;
  skusAlerta: number;
  skusExcesso: number;
}

interface CockpitData {
  resumo: CockpitResumo;
  skus: CockpitSku[];
}

interface ResumoCard {
  label: string;
  value: string;
  color: string;
  info: string;
  hint?: string;
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
  const [galpaoFilter, setGalpaoFilter] = useState<string>('');
  const [critFilter, setCritFilter] = useState<'todas' | Criticidade>('todas');

  const { data: galpoesDisponiveis = [] } = useQuery<Array<{ galpao: string; localidades: string[] }>>({
    queryKey: ['admin', 'galpoes-disponiveis'],
    queryFn: async () =>
      (await apiFetch('/api/v1/stockbridge/admin/galpoes-disponiveis')).data as Array<{ galpao: string; localidades: string[] }>,
  });

  const { data, isLoading, error } = useQuery<CockpitData>({
    queryKey: ['stockbridge', 'cockpit', cnpjFilter, galpaoFilter, critFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cnpjFilter !== 'ambos') params.set('cnpj', cnpjFilter);
      if (galpaoFilter) params.set('galpao', galpaoFilter);
      if (critFilter !== 'todas') params.set('criticidade', critFilter);
      const body = await apiFetch(`/api/v1/stockbridge/cockpit?${params}`);
      return body.data as CockpitData;
    },
  });

  // Cards "Volume" — onde está o estoque
  const cardsVolume: ResumoCard[] = useMemo(() => {
    const r = data?.resumo;
    if (!r) return [];
    const totalTransito = r.transitoIntlKg + r.portoDtaKg + r.transitoInternoKg;
    const totalPendente = r.totalFiscalPendenteNacionalKg + r.totalFiscalPendenteImportacaoKg;
    return [
      {
        label: 'Disponível',
        value: `${fmtKg(r.totalFisicoKg)} kg`,
        color: 'text-atlas-ink',
        info: 'Estoque físico imediatamente disponível para venda (saldo OMIE consolidado em ambos os CNPJs).',
      },
      {
        label: 'Em Trânsito',
        value: `${fmtKg(totalTransito)} kg`,
        color: 'text-violet-700',
        info: 'Soma dos lotes nos três estágios de trânsito: internacional, porto/DTA e trânsito interno.',
        hint: totalTransito > 0
          ? `${fmtKg(r.transitoIntlKg)} intl · ${fmtKg(r.portoDtaKg)} porto · ${fmtKg(r.transitoInternoKg)} interno`
          : undefined,
      },
      {
        label: 'Provisório',
        value: `${fmtKg(r.provisorioKg)} kg`,
        color: 'text-amber-700',
        info: 'Material já recebido fisicamente pelo operador, mas com ajuste OMIE ainda pendente (em retry ou aguardando consolidação).',
      },
      {
        label: 'Posição Fiscal',
        value: `${fmtKg(r.totalFiscalKg)} kg`,
        color: 'text-atlas-ink',
        info: 'Posição contábil total = físico + NFs emitidas sem recebimento físico confirmado (nacionais via n_id_receb e importações via movimentação Atlas).',
        hint: totalPendente > 0
          ? `+${fmtKg(totalPendente)} kg pendentes (${fmtKg(r.totalFiscalPendenteNacionalKg)} nac · ${fmtKg(r.totalFiscalPendenteImportacaoKg)} imp)`
          : undefined,
      },
    ];
  }, [data]);

  // Cards "Saúde" — o que demanda ação
  const cardsSaude: ResumoCard[] = useMemo(() => {
    const r = data?.resumo;
    if (!r) return [];
    return [
      {
        label: 'Ruptura',
        value: String(r.skusCriticos),
        color: 'text-red-700',
        info: 'SKUs com cobertura abaixo de 50% do lead time. Risco real de faltar antes do próximo lote chegar.',
      },
      {
        label: 'Atenção',
        value: String(r.skusAlerta),
        color: 'text-amber-700',
        info: 'SKUs com cobertura entre 50% e 120% do lead time. Repor logo ou vira ruptura.',
      },
      {
        label: 'Excesso',
        value: String(r.skusExcesso),
        color: 'text-blue-700',
        info: 'SKUs com saldo acima de 4× o consumo no lead time. Capital parado em estoque.',
      },
      {
        label: 'Pendências',
        value: String(r.divergenciasCount + r.aprovacoesPendentes),
        color: r.divergenciasCount + r.aprovacoesPendentes > 0 ? 'text-red-700' : 'text-atlas-ink',
        info: 'Total de aprovações pendentes + divergências abertas que demandam ação do gestor.',
        hint: (r.divergenciasCount > 0 || r.aprovacoesPendentes > 0)
          ? `${r.divergenciasCount} divergências · ${r.aprovacoesPendentes} aprovações`
          : undefined,
      },
    ];
  }, [data]);

  // Esteira de estágios — fluxo físico do material
  const esteira = useMemo(() => {
    const r = data?.resumo;
    if (!r) return null;
    return [
      { label: 'Trânsito intl',    value: r.transitoIntlKg,     color: 'text-violet-700', bg: 'bg-violet-50 dark:bg-violet-900/20' },
      { label: 'Porto / DTA',      value: r.portoDtaKg,         color: 'text-orange-700', bg: 'bg-orange-50 dark:bg-orange-900/20' },
      { label: 'Trânsito interno', value: r.transitoInternoKg,  color: 'text-teal-700',   bg: 'bg-teal-50 dark:bg-teal-900/20' },
      { label: 'Provisório',       value: r.provisorioKg,       color: 'text-amber-700',  bg: 'bg-amber-50 dark:bg-amber-900/20' },
      { label: 'Disponível',       value: r.totalFisicoKg,      color: 'text-green-700',  bg: 'bg-green-50 dark:bg-green-900/20' },
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

      <div className="flex items-center gap-3 mb-5 text-sm flex-wrap">
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
        <select
          value={galpaoFilter}
          onChange={(e) => setGalpaoFilter(e.target.value)}
          className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-xs"
          title="Filtrar por galpão físico (apenas estoque OMIE; trânsito/provisório seguem agregando todos os galpões)"
        >
          <option value="">Todos os galpões</option>
          {galpoesDisponiveis.map((g) => (
            <option key={g.galpao} value={g.galpao}>
              Galpão {g.galpao}
            </option>
          ))}
        </select>
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

      {data && esteira && (
        <div className="mb-5">
          <div className="flex items-center gap-1 mb-2">
            <h2 className="text-xs uppercase tracking-wide text-atlas-muted font-medium">Fluxo do material</h2>
            <span
              className="inline-flex cursor-help"
              title="Estágios em sequência: material começa no exterior, passa por porto/DTA, chega ao trânsito interno, vira lote provisório quando recebido, e finalmente fica disponível para venda."
            >
              <Info size={12} className="text-atlas-muted" aria-hidden />
            </span>
          </div>
          <div className="flex items-stretch gap-1 overflow-x-auto">
            {esteira.map((stage, i) => (
              <div key={stage.label} className="flex items-center gap-1 flex-1 min-w-[140px]">
                <div className={`flex-1 rounded-lg border border-slate-200 dark:border-slate-700 p-3 ${stage.bg}`}>
                  <div className={`text-[11px] font-medium ${stage.color}`}>{stage.label}</div>
                  <div className="font-serif text-base text-atlas-ink mt-0.5">{fmtKg(stage.value)} kg</div>
                </div>
                {i < esteira.length - 1 && (
                  <ArrowRight size={16} className="text-atlas-muted shrink-0" aria-hidden />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {data && (
        <div className="space-y-4 mb-6">
          <ResumoBloco titulo="Volume" descricao="Onde está o estoque agora" cards={cardsVolume} />
          <ResumoBloco titulo="Saúde" descricao="O que demanda ação" cards={cardsSaude} />
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

                <div className="grid grid-cols-3 gap-2 mb-3">
                  <Cell label="Físico" value={`${fmtKg(sku.fisicaKg)} kg`} />
                  <Cell label="Fiscal" value={`${fmtKg(sku.fiscalKg)} kg`} accent={Math.abs(sku.fisicaKg - sku.fiscalKg) > 1 ? 'text-red-700' : undefined} />
                  <Cell label="Provisório" value={`${fmtKg(sku.provisorioKg)} kg`} accent="text-amber-700" />
                  <Cell label="Trânsito intl" value={`${fmtKg(sku.transitoIntlKg)} kg`} accent="text-violet-700" />
                  <Cell label="Porto / DTA" value={`${fmtKg(sku.portoDtaKg)} kg`} accent="text-orange-700" />
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
                </div>
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}

function ResumoBloco({
  titulo,
  descricao,
  cards,
}: {
  titulo: string;
  descricao: string;
  cards: ResumoCard[];
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="text-xs uppercase tracking-wide text-atlas-muted font-medium">{titulo}</h2>
        <span className="text-[11px] text-atlas-muted">— {descricao}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {cards.map((c) => (
          <div
            key={c.label}
            className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3"
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs text-atlas-muted">{c.label}</div>
              <span className="inline-flex cursor-help shrink-0" title={c.info}>
                <Info size={12} className="text-atlas-muted" aria-hidden />
              </span>
            </div>
            <div className={`font-serif text-lg ${c.color}`}>{c.value}</div>
            {c.hint && (
              <div className="text-[10px] text-atlas-muted mt-1 leading-tight">{c.hint}</div>
            )}
          </div>
        ))}
      </div>
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
