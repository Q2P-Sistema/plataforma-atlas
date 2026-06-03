import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info, ArrowRight, Table2, LayoutGrid, ChevronDown, X } from 'lucide-react';
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

type PendenciaFilter = 'todas' | 'divergencia' | 'aprovacao' | 'provisorio';
type EstagioFilter = 'todos' | 'transito_intl' | 'porto_dta' | 'transito_interno';
type ViewMode = 'tabela' | 'cards';

// Prioridade de ordenacao por criticidade (menor numero = aparece primeiro)
const CRIT_PRIORIDADE: Record<Criticidade, number> = {
  critico: 0,
  alerta: 1,
  excesso: 2,
  ok: 3,
};

export function CockpitPage() {
  const apiFetch = useApiFetch();
  const [cnpjFilter, setCnpjFilter] = useState<'ambos' | 'acxe' | 'q2p'>('ambos');
  const [galpoesFilter, setGalpoesFilter] = useState<string[]>([]);
  const [familiasFilter, setFamiliasFilter] = useState<string[]>([]);
  const [critFilter, setCritFilter] = useState<'todas' | Criticidade>('todas');
  const [pendenciaFilter, setPendenciaFilter] = useState<PendenciaFilter>('todas');
  const [estagioFilter, setEstagioFilter] = useState<EstagioFilter>('todos');
  const [viewMode, setViewMode] = useState<ViewMode>('tabela');

  const { data: galpoesDisponiveis = [] } = useQuery<Array<{ galpao: string; localidades: string[] }>>({
    queryKey: ['admin', 'galpoes-disponiveis'],
    queryFn: async () =>
      (await apiFetch('/api/v1/stockbridge/admin/galpoes-disponiveis')).data as Array<{ galpao: string; localidades: string[] }>,
  });

  const { data: familiasDisponiveis = [] } = useQuery<string[]>({
    queryKey: ['stockbridge', 'familias'],
    queryFn: async () =>
      (await apiFetch('/api/v1/stockbridge/familias')).data as string[],
  });

  const { data: rawData, isLoading, error } = useQuery<CockpitData>({
    queryKey: ['stockbridge', 'cockpit', cnpjFilter, galpoesFilter, familiasFilter, critFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cnpjFilter !== 'ambos') params.set('cnpj', cnpjFilter);
      for (const g of galpoesFilter) params.append('galpao', g);
      for (const f of familiasFilter) params.append('familia', f);
      if (critFilter !== 'todas') params.set('criticidade', critFilter);
      const body = await apiFetch(`/api/v1/stockbridge/cockpit?${params}`);
      return body.data as CockpitData;
    },
  });

  // Filtros derivados aplicados no frontend (pendência e estágio) — o backend
  // não suporta esses filtros nativos. Aplicar aqui evita query nova por toggle.
  // Ordenação default: criticidade (crítico→alerta→excesso→ok) + menor cobertura.
  const data = useMemo(() => {
    if (!rawData) return rawData;
    let skus = rawData.skus;
    if (pendenciaFilter === 'divergencia') skus = skus.filter((s) => s.divergencias > 0);
    if (pendenciaFilter === 'aprovacao') skus = skus.filter((s) => s.aprovacoesPendentes > 0);
    if (pendenciaFilter === 'provisorio') skus = skus.filter((s) => s.provisorioKg > 0);
    if (estagioFilter === 'transito_intl') skus = skus.filter((s) => s.transitoIntlKg > 0);
    if (estagioFilter === 'porto_dta') skus = skus.filter((s) => s.portoDtaKg > 0);
    if (estagioFilter === 'transito_interno') skus = skus.filter((s) => s.transitoInternoKg > 0);
    const ordenados = [...skus].sort((a, b) => {
      const pa = CRIT_PRIORIDADE[a.criticidade];
      const pb = CRIT_PRIORIDADE[b.criticidade];
      if (pa !== pb) return pa - pb;
      const ca = a.coberturaDias ?? Number.POSITIVE_INFINITY;
      const cb = b.coberturaDias ?? Number.POSITIVE_INFINITY;
      return ca - cb;
    });
    // Quando há filtro derivado, mantém o resumo do backend (visão global) para
    // contextualização, mas a lista de SKUs reflete apenas o subconjunto filtrado.
    return { resumo: rawData.resumo, skus: ordenados };
  }, [rawData, pendenciaFilter, estagioFilter]);

  // Top Riscos: 4 rankings executivos derivados da lista atual de SKUs.
  // Pegamos 5 por categoria. Usa rawData para refletir TODOS os SKUs, ignorando
  // filtros derivados (assim o ranking continua mostrando os top riscos globais).
  const topRiscos = useMemo(() => {
    const skus = rawData?.skus ?? [];
    return {
      ruptura: [...skus]
        .filter((s) => s.criticidade === 'critico')
        .sort((a, b) => (a.coberturaDias ?? Infinity) - (b.coberturaDias ?? Infinity))
        .slice(0, 5),
      excesso: [...skus]
        .filter((s) => s.criticidade === 'excesso')
        .sort((a, b) => b.fisicaKg - a.fisicaKg)
        .slice(0, 5),
      portoDta: [...skus]
        .filter((s) => s.portoDtaKg > 0)
        .sort((a, b) => b.portoDtaKg - a.portoDtaKg)
        .slice(0, 5),
      pendencias: [...skus]
        .filter((s) => s.divergencias + s.aprovacoesPendentes > 0)
        .sort((a, b) => (b.divergencias + b.aprovacoesPendentes) - (a.divergencias + a.aprovacoesPendentes))
        .slice(0, 5),
    };
  }, [rawData]);

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
          Visão executiva do estoque físico: onde o material está, quem demanda ação imediata e
          como o pipeline de chegada se distribui. <span className="text-atlas-muted/70">Cobertura
          calculada por consumo médio diário vs lead time configurado por SKU.</span>
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
        <MultiSelectDropdown
          label="Famílias"
          allLabel="Todas as famílias"
          options={familiasDisponiveis.map((f) => ({ value: f, label: f }))}
          selected={familiasFilter}
          onChange={setFamiliasFilter}
          title="Filtrar por uma ou mais famílias de produto"
        />
        <MultiSelectDropdown
          label="Galpões"
          allLabel="Todos os galpões"
          options={galpoesDisponiveis.map((g) => ({ value: g.galpao, label: `Galpão ${g.galpao}` }))}
          selected={galpoesFilter}
          onChange={setGalpoesFilter}
          title="Filtrar por um ou mais galpões físicos (afeta apenas saldo OMIE; trânsito e provisório seguem agregando todos)"
        />
        <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded">
          {(['todas', 'critico', 'alerta', 'ok', 'excesso'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setCritFilter(v)}
              className={`px-3 py-1 rounded text-xs font-medium transition ${critFilter === v ? 'bg-white dark:bg-slate-900 shadow-sm text-atlas-ink' : 'text-atlas-muted'}`}
              title={
                v === 'critico' ? 'Cobertura < 50% do lead time'
                : v === 'alerta' ? 'Cobertura entre 50% e 120% do lead time'
                : v === 'ok' ? 'Cobertura saudável (120%-400% do lead time)'
                : v === 'excesso' ? 'Saldo > 4× consumo no lead time'
                : 'Mostrar todos os SKUs'
              }
            >
              {v === 'todas' ? 'Todas' : v === 'critico' ? 'Ruptura' : v === 'alerta' ? 'Atenção' : CRIT_CFG[v].label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 mb-5 text-sm flex-wrap">
        <span className="text-[11px] uppercase tracking-wide text-atlas-muted/70 font-medium">Drill-down:</span>
        <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded">
          {(['todas', 'divergencia', 'aprovacao', 'provisorio'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setPendenciaFilter(v)}
              className={`px-3 py-1 rounded text-xs font-medium transition ${pendenciaFilter === v ? 'bg-white dark:bg-slate-900 shadow-sm text-atlas-ink' : 'text-atlas-muted'}`}
              title={
                v === 'divergencia' ? 'SKUs com pelo menos uma divergência aberta'
                : v === 'aprovacao' ? 'SKUs com pelo menos uma aprovação pendente'
                : v === 'provisorio' ? 'SKUs com saldo provisório (aguardando OMIE)'
                : 'Sem filtro de pendência'
              }
            >
              {v === 'todas' ? 'Sem pendência' : v === 'divergencia' ? 'Com divergência' : v === 'aprovacao' ? 'Com aprovação' : 'Com provisório'}
            </button>
          ))}
        </div>
        <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded">
          {(['todos', 'transito_intl', 'porto_dta', 'transito_interno'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setEstagioFilter(v)}
              className={`px-3 py-1 rounded text-xs font-medium transition ${estagioFilter === v ? 'bg-white dark:bg-slate-900 shadow-sm text-atlas-ink' : 'text-atlas-muted'}`}
              title={
                v === 'transito_intl' ? 'SKUs com lote em trânsito internacional'
                : v === 'porto_dta' ? 'SKUs com lote no porto/DTA'
                : v === 'transito_interno' ? 'SKUs com lote em trânsito interno'
                : 'Sem filtro de estágio'
              }
            >
              {v === 'todos' ? 'Sem estágio' : v === 'transito_intl' ? 'Trânsito intl' : v === 'porto_dta' ? 'Porto/DTA' : 'Trânsito int.'}
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

      {data && rawData && rawData.skus.length > 0 && (
        <TopRiscos topRiscos={topRiscos} />
      )}

      {data && data.skus.length > 0 && (
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs uppercase tracking-wide text-atlas-muted font-medium">
            SKUs <span className="text-atlas-muted/70 normal-case">— {data.skus.length} item{data.skus.length === 1 ? '' : 's'} {data.skus.length !== rawData?.skus.length ? `(${rawData?.skus.length} no total)` : ''}, ordem por criticidade</span>
          </h2>
          <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded">
            <button
              onClick={() => setViewMode('tabela')}
              className={`px-2 py-1 rounded text-xs font-medium transition flex items-center gap-1 ${viewMode === 'tabela' ? 'bg-white dark:bg-slate-900 shadow-sm text-atlas-ink' : 'text-atlas-muted'}`}
              title="Tabela executiva densa"
            >
              <Table2 size={12} /> Tabela
            </button>
            <button
              onClick={() => setViewMode('cards')}
              className={`px-2 py-1 rounded text-xs font-medium transition flex items-center gap-1 ${viewMode === 'cards' ? 'bg-white dark:bg-slate-900 shadow-sm text-atlas-ink' : 'text-atlas-muted'}`}
              title="Cards visuais"
            >
              <LayoutGrid size={12} /> Cards
            </button>
          </div>
        </div>
      )}

      {data && data.skus.length > 0 && viewMode === 'tabela' && (
        <TabelaSkus skus={data.skus} />
      )}

      {data && data.skus.length > 0 && viewMode === 'cards' && (
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

function TopRiscos({ topRiscos }: { topRiscos: { ruptura: CockpitSku[]; excesso: CockpitSku[]; portoDta: CockpitSku[]; pendencias: CockpitSku[] } }) {
  const blocos = [
    {
      titulo: 'Maior risco de ruptura',
      subtitulo: 'Menor cobertura em dias',
      items: topRiscos.ruptura,
      color: 'text-red-700',
      bg: 'bg-red-50 dark:bg-red-900/20',
      fmtValor: (s: CockpitSku) => s.coberturaDias != null ? `${s.coberturaDias}d` : '—',
    },
    {
      titulo: 'Maior excesso',
      subtitulo: 'Mais kg parados',
      items: topRiscos.excesso,
      color: 'text-blue-700',
      bg: 'bg-blue-50 dark:bg-blue-900/20',
      fmtValor: (s: CockpitSku) => `${fmtKg(s.fisicaKg)} kg`,
    },
    {
      titulo: 'Presos em Porto/DTA',
      subtitulo: 'Maior volume retido',
      items: topRiscos.portoDta,
      color: 'text-orange-700',
      bg: 'bg-orange-50 dark:bg-orange-900/20',
      fmtValor: (s: CockpitSku) => `${fmtKg(s.portoDtaKg)} kg`,
    },
    {
      titulo: 'Mais pendências',
      subtitulo: 'Divergências + aprovações',
      items: topRiscos.pendencias,
      color: 'text-amber-700',
      bg: 'bg-amber-50 dark:bg-amber-900/20',
      fmtValor: (s: CockpitSku) => `${s.divergencias + s.aprovacoesPendentes}`,
    },
  ];
  const algumComItem = blocos.some((b) => b.items.length > 0);
  if (!algumComItem) return null;
  return (
    <div className="mb-5">
      <div className="flex items-center gap-1 mb-2">
        <h2 className="text-xs uppercase tracking-wide text-atlas-muted font-medium">Top riscos</h2>
        <span className="inline-flex cursor-help" title="Os 5 produtos mais críticos de cada categoria. Independe dos filtros aplicados — sempre reflete o panorama global.">
          <Info size={12} className="text-atlas-muted" aria-hidden />
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
        {blocos.map((b) => (
          <div key={b.titulo} className={`border border-slate-200 dark:border-slate-700 rounded-lg ${b.bg}`}>
            <div className="px-3 py-2 border-b border-slate-200/60 dark:border-slate-700/60">
              <div className={`text-xs font-semibold ${b.color}`}>{b.titulo}</div>
              <div className="text-[10px] text-atlas-muted">{b.subtitulo}</div>
            </div>
            <ol className="px-3 py-2 space-y-1">
              {b.items.length === 0 && (
                <li className="text-[11px] text-atlas-muted italic">—</li>
              )}
              {b.items.map((s) => (
                <li key={s.codigoAcxe} className="flex justify-between text-[11px] gap-2">
                  <span className="truncate text-atlas-ink" title={s.nome}>{s.nome}</span>
                  <span className={`font-mono ${b.color} shrink-0`}>{b.fmtValor(s)}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}

function TabelaSkus({ skus }: { skus: CockpitSku[] }) {
  return (
    <div className="overflow-x-auto border border-slate-200 dark:border-slate-700 rounded-lg">
      <table className="min-w-full text-xs">
        <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase tracking-wide text-atlas-muted">
          <tr>
            <th className="text-left px-3 py-2">Status</th>
            <th className="text-left px-3 py-2">Produto</th>
            <th className="text-left px-3 py-2">Família</th>
            <th className="text-right px-3 py-2">Físico</th>
            <th className="text-right px-3 py-2">Tr. intl</th>
            <th className="text-right px-3 py-2">Porto/DTA</th>
            <th className="text-right px-3 py-2">Tr. int.</th>
            <th className="text-right px-3 py-2">Provis.</th>
            <th className="text-right px-3 py-2">Cons./d</th>
            <th className="text-right px-3 py-2">Cob.</th>
            <th className="text-right px-3 py-2">Lead</th>
            <th className="text-left px-3 py-2">Pend.</th>
          </tr>
        </thead>
        <tbody>
          {skus.map((s) => {
            const crit = CRIT_CFG[s.criticidade];
            return (
              <tr key={s.codigoAcxe} className="border-t border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/30">
                <td className="px-3 py-2">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${crit.bg} ${crit.text}`}>
                    {s.criticidade === 'critico' ? 'Ruptura' : s.criticidade === 'alerta' ? 'Atenção' : crit.label}
                  </span>
                </td>
                <td className="px-3 py-2 text-atlas-ink max-w-[220px] truncate" title={s.nome}>{s.nome}</td>
                <td className="px-3 py-2 text-atlas-muted">{s.familia ?? '—'}</td>
                <td className="px-3 py-2 text-right font-mono text-atlas-ink">{fmtKg(s.fisicaKg)}</td>
                <td className={`px-3 py-2 text-right font-mono ${s.transitoIntlKg > 0 ? 'text-violet-700' : 'text-atlas-muted/50'}`}>{fmtKg(s.transitoIntlKg)}</td>
                <td className={`px-3 py-2 text-right font-mono ${s.portoDtaKg > 0 ? 'text-orange-700' : 'text-atlas-muted/50'}`}>{fmtKg(s.portoDtaKg)}</td>
                <td className={`px-3 py-2 text-right font-mono ${s.transitoInternoKg > 0 ? 'text-teal-700' : 'text-atlas-muted/50'}`}>{fmtKg(s.transitoInternoKg)}</td>
                <td className={`px-3 py-2 text-right font-mono ${s.provisorioKg > 0 ? 'text-amber-700' : 'text-atlas-muted/50'}`}>{fmtKg(s.provisorioKg)}</td>
                <td className="px-3 py-2 text-right font-mono text-atlas-muted">{s.consumoMedioDiarioKg != null ? fmtKg(s.consumoMedioDiarioKg) : '—'}</td>
                <td className={`px-3 py-2 text-right font-mono font-medium ${crit.text}`}>{s.coberturaDias != null ? `${s.coberturaDias}d` : '—'}</td>
                <td className="px-3 py-2 text-right font-mono text-atlas-muted">{s.leadTimeDias != null ? `${s.leadTimeDias}d` : '—'}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    {s.divergencias > 0 && (
                      <span className="px-1.5 py-0.5 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded text-[10px]" title={`${s.divergencias} divergência(s) aberta(s)`}>
                        {s.divergencias} div
                      </span>
                    )}
                    {s.aprovacoesPendentes > 0 && (
                      <span className="px-1.5 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 rounded text-[10px]" title={`${s.aprovacoesPendentes} aprovação(ões) pendente(s)`}>
                        {s.aprovacoesPendentes} apr
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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

interface MultiSelectOption {
  value: string;
  label: string;
}

function MultiSelectDropdown({
  label,
  allLabel,
  options,
  selected,
  onChange,
  title,
}: {
  label: string;
  allLabel: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (v: string[]) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (v: string) => {
    if (selected.includes(v)) onChange(selected.filter((s) => s !== v));
    else onChange([...selected, v]);
  };

  const triggerLabel =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? options.find((o) => o.value === selected[0])?.label ?? selected[0]
        : `${label}: ${selected.length} selecionados`;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={title}
        className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-xs flex items-center gap-2 hover:border-slate-400 dark:hover:border-slate-500 transition"
      >
        <span className={selected.length > 0 ? 'text-atlas-ink' : 'text-atlas-muted'}>
          {triggerLabel}
        </span>
        {selected.length > 0 && (
          <span
            role="button"
            aria-label="Limpar seleção"
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
            className="text-atlas-muted hover:text-atlas-ink"
          >
            <X size={12} />
          </span>
        )}
        <ChevronDown size={12} className="text-atlas-muted" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 min-w-[220px] max-h-[320px] overflow-y-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg text-xs">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-atlas-muted">Sem opções disponíveis</div>
          ) : (
            <>
              {options.map((opt) => {
                const checked = selected.includes(opt.value);
                return (
                  <label
                    key={opt.value}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-700/50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(opt.value)}
                      className="w-3.5 h-3.5 accent-atlas-ink"
                    />
                    <span className={checked ? 'text-atlas-ink' : 'text-atlas-muted'}>
                      {opt.label}
                    </span>
                  </label>
                );
              })}
              {selected.length > 0 && (
                <div className="border-t border-slate-200 dark:border-slate-700 px-3 py-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => onChange([])}
                    className="text-[11px] text-atlas-muted hover:text-atlas-ink"
                  >
                    Limpar seleção
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
