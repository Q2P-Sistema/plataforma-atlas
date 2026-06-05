import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

interface KPIs {
  valorEstoqueBrl: number;
  valorEstoqueUsd: number;
  exposicaoCambialUsd: number;
  exposicaoCambialBrl: number;
  giroMedioDias: Record<string, number>;
  taxaDivergenciaPct: number;
  ptaxBrl: number;
}
interface Evolucao { mes: string; familia: string | null; quantidadeKg: number; valorBrl: number; }
interface AnaliticaSku {
  codigoAcxe: number; nome: string; familia: string | null; ncm: string | null;
  quantidadeKg: number; cmpBrlKg: number; valorBrl: number; coberturaDias: number | null; divergencias: number;
}

const fmtBRL = (n: number) => `R$ ${(n / 1e6).toFixed(2)} M`;
const fmtUSD = (n: number) => `USD ${(n / 1e3).toFixed(0)} k`;

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

export function MetricasPage() {
  const apiFetch = useApiFetch();

  const { data: kpis } = useQuery<KPIs>({
    queryKey: ['sb', 'metricas'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/metricas')).data as KPIs,
  });
  const { data: evolucao = [] } = useQuery<Evolucao[]>({
    queryKey: ['sb', 'metricas', 'evolucao'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/metricas/evolucao?meses=6')).data as Evolucao[],
  });
  const { data: analitica = [] } = useQuery<AnaliticaSku[]>({
    queryKey: ['sb', 'metricas', 'analitica'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/metricas/tabela-analitica')).data as AnaliticaSku[],
  });

  // Agrupa evolucao por mes somando familias
  const evolucaoAgrupada = [...new Set(evolucao.map((e) => e.mes))].sort().map((mes) => {
    const meses = evolucao.filter((e) => e.mes === mes);
    return {
      mes,
      quantidadeKg: meses.reduce((a, b) => a + b.quantidadeKg, 0),
      valorBrl: meses.reduce((a, b) => a + b.valorBrl, 0),
    };
  });
  const maxEvol = Math.max(1, ...evolucaoAgrupada.map((e) => e.quantidadeKg));

  return (
    <div className="p-6 max-w-7xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Métricas</h1>
        <p className="text-sm text-atlas-muted">Valor do estoque, exposição cambial, giro, taxa de divergência.</p>
      </div>

      {kpis && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            <Card label="Valor Estoque" value={fmtBRL(kpis.valorEstoqueBrl)} sub={fmtUSD(kpis.valorEstoqueUsd)} />
            <Card label="Exposição Cambial" value={fmtBRL(kpis.exposicaoCambialBrl)} sub={fmtUSD(kpis.exposicaoCambialUsd)} accent="text-violet-700" />
            <Card label="PTAX" value={`R$ ${kpis.ptaxBrl.toFixed(4)}`} sub="BCB" />
            <Card label="Taxa Divergência" value={`${kpis.taxaDivergenciaPct}%`} accent={kpis.taxaDivergenciaPct > 5 ? 'text-red-700' : 'text-amber-700'} />
          </div>

          <GiroMedioPanel giro={kpis.giroMedioDias} />
        </>
      )}

      {evolucaoAgrupada.length > 0 && (
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-5 mb-6">
          <h2 className="font-serif text-sm text-atlas-ink mb-3">Evolução — últimos 6 meses</h2>
          <div className="flex items-end gap-2 h-32">
            {evolucaoAgrupada.map((e) => {
              const h = (e.quantidadeKg / maxEvol) * 100;
              return (
                <div key={e.mes} className="flex-1 flex flex-col items-center gap-1">
                  <div className="text-[10px] text-atlas-muted">{Math.round(e.quantidadeKg).toLocaleString('pt-BR')} kg</div>
                  <div className="w-full bg-atlas-ink rounded-t" style={{ height: `${h}%` }} />
                  <div className="text-[10px] text-atlas-muted">{e.mes}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {analitica.length > 0 && <TabelaAnalitica analitica={analitica} />}
    </div>
  );
}

type SortKey = 'nome' | 'familia' | 'ncm' | 'quantidadeKg' | 'cmpBrlKg' | 'valorBrl' | 'coberturaDias' | 'divergencias';
type SortDir = 'asc' | 'desc';

interface ColFiltros {
  nome: string;
  familias: Set<string>;     // multiselect (vazio = todas)
  ncm: string;
  qtdMin: string;
  qtdMax: string;
  cmpMin: string;
  cmpMax: string;
  valorMin: string;
  valorMax: string;
  cobMin: string;
  cobMax: string;
  divMode: 'todos' | 'so_com_div' | 'so_sem_div';
}

const FILTROS_VAZIOS: ColFiltros = {
  nome: '', familias: new Set(), ncm: '',
  qtdMin: '', qtdMax: '',
  cmpMin: '', cmpMax: '',
  valorMin: '', valorMax: '',
  cobMin: '', cobMax: '',
  divMode: 'todos',
};

function inRange(v: number | null, min: string, max: string): boolean {
  if (v == null) return min === '' && max === '';
  if (min !== '' && v < Number(min)) return false;
  if (max !== '' && v > Number(max)) return false;
  return true;
}

function TabelaAnalitica({ analitica }: { analitica: AnaliticaSku[] }) {
  const [busca, setBusca] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('valorBrl');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [filtros, setFiltros] = useState<ColFiltros>(FILTROS_VAZIOS);

  function clickHeader(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'nome' || key === 'familia' || key === 'ncm' ? 'asc' : 'desc');
    }
  }

  const familiasUnicas = useMemo(
    () => Array.from(new Set(analitica.map((s) => s.familia).filter((f): f is string => Boolean(f)))).sort(),
    [analitica],
  );

  const filtrosAtivos = useMemo(() => {
    return (
      filtros.nome !== '' || filtros.ncm !== '' ||
      filtros.familias.size > 0 ||
      filtros.qtdMin !== '' || filtros.qtdMax !== '' ||
      filtros.cmpMin !== '' || filtros.cmpMax !== '' ||
      filtros.valorMin !== '' || filtros.valorMax !== '' ||
      filtros.cobMin !== '' || filtros.cobMax !== '' ||
      filtros.divMode !== 'todos'
    );
  }, [filtros]);

  const filtrada = useMemo(() => {
    const b = busca.trim().toLowerCase();
    const fNome = filtros.nome.trim().toLowerCase();
    const fNcm = filtros.ncm.trim().toLowerCase();

    const arr = analitica.filter((s) => {
      // Busca global
      if (b && !(
        s.nome.toLowerCase().includes(b) ||
        (s.familia?.toLowerCase().includes(b) ?? false) ||
        String(s.codigoAcxe).includes(busca)
      )) return false;

      // Filtros por coluna
      if (fNome && !s.nome.toLowerCase().includes(fNome)) return false;
      if (fNcm && !(s.ncm ?? '').toLowerCase().includes(fNcm)) return false;
      if (filtros.familias.size > 0 && !filtros.familias.has(s.familia ?? '')) return false;
      if (!inRange(s.quantidadeKg, filtros.qtdMin, filtros.qtdMax)) return false;
      if (!inRange(s.cmpBrlKg, filtros.cmpMin, filtros.cmpMax)) return false;
      if (!inRange(s.valorBrl, filtros.valorMin, filtros.valorMax)) return false;
      if (!inRange(s.coberturaDias, filtros.cobMin, filtros.cobMax)) return false;
      if (filtros.divMode === 'so_com_div' && s.divergencias === 0) return false;
      if (filtros.divMode === 'so_sem_div' && s.divergencias > 0) return false;
      return true;
    });

    arr.sort((a, b2) => {
      const av = a[sortKey];
      const bv = b2[sortKey];
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av ?? '').localeCompare(String(bv ?? ''), 'pt-BR', { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [analitica, busca, filtros, sortKey, sortDir]);

  const colunas: Array<{ key: SortKey; label: string; align?: 'right' | 'center' | 'left' }> = [
    { key: 'nome', label: 'SKU', align: 'left' },
    { key: 'familia', label: 'Família', align: 'left' },
    { key: 'ncm', label: 'NCM', align: 'left' },
    { key: 'quantidadeKg', label: 'Qtd (kg)', align: 'right' },
    { key: 'cmpBrlKg', label: 'Custo BRL/kg', align: 'right' },
    { key: 'valorBrl', label: 'Valor BRL', align: 'right' },
    { key: 'coberturaDias', label: 'Cobertura', align: 'right' },
    { key: 'divergencias', label: 'Div.', align: 'center' },
  ];

  function setF<K extends keyof ColFiltros>(k: K, v: ColFiltros[K]) {
    setFiltros((prev) => ({ ...prev, [k]: v }));
  }

  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <div className="p-3 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3">
        <div className="font-serif text-sm text-atlas-ink">Tabela Analítica por SKU</div>
        <span className="text-xs text-atlas-muted">{filtrada.length} de {analitica.length}</span>
        {filtrosAtivos && (
          <button
            onClick={() => { setBusca(''); setFiltros(FILTROS_VAZIOS); }}
            className="text-[10px] px-2 py-1 rounded border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-300"
          >
            Limpar filtros
          </button>
        )}
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por SKU, código ou família..."
          className="ml-auto px-3 py-1.5 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-xs w-72"
        />
      </div>
      <div
        className="overflow-y-auto overflow-x-auto"
        style={{ maxHeight: 'calc(100vh - 360px)' }}
      >
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="sticky top-0 z-20 bg-slate-100 dark:bg-slate-900 border-b-2 border-slate-300 dark:border-slate-600">
            {colunas.map((c, i) => (
              <th
                key={c.key}
                onClick={() => clickHeader(c.key)}
                className={`px-3 py-2 font-semibold text-atlas-muted cursor-pointer select-none hover:text-atlas-ink text-${c.align ?? 'left'} ${i < colunas.length - 1 ? 'border-r border-slate-200 dark:border-slate-700' : ''}`}
              >
                {c.label}
                {sortKey === c.key && <span className="ml-1 text-atlas-ink">{sortDir === 'asc' ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
          {/* Linha de filtros por coluna (sticky logo abaixo do header) */}
          <tr className="sticky top-[33px] z-20 bg-slate-50 dark:bg-slate-900/80 border-b border-slate-200 dark:border-slate-700">
            <th className="px-2 py-1 border-r border-slate-200 dark:border-slate-700">
              <input
                value={filtros.nome}
                onChange={(e) => setF('nome', e.target.value)}
                placeholder="contém..."
                className="w-full px-1.5 py-0.5 text-[11px] border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded"
              />
            </th>
            <th className="px-2 py-1 border-r border-slate-200 dark:border-slate-700">
              <select
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  const novo = new Set(filtros.familias);
                  if (novo.has(v)) novo.delete(v); else novo.add(v);
                  setF('familias', novo);
                }}
                className="w-full px-1.5 py-0.5 text-[11px] border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded"
                title="Selecione uma ou mais (clique de novo pra remover)"
              >
                <option value="">{filtros.familias.size === 0 ? 'todas' : `${filtros.familias.size} selecionadas`}</option>
                {familiasUnicas.map((f) => (
                  <option key={f} value={f}>{filtros.familias.has(f) ? '✓ ' : ''}{f}</option>
                ))}
              </select>
            </th>
            <th className="px-2 py-1 border-r border-slate-200 dark:border-slate-700">
              <input
                value={filtros.ncm}
                onChange={(e) => setF('ncm', e.target.value)}
                placeholder="contém..."
                className="w-full px-1.5 py-0.5 text-[11px] border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded"
              />
            </th>
            <th className="px-2 py-1 border-r border-slate-200 dark:border-slate-700">
              <RangeInputs min={filtros.qtdMin} max={filtros.qtdMax} onMin={(v) => setF('qtdMin', v)} onMax={(v) => setF('qtdMax', v)} />
            </th>
            <th className="px-2 py-1 border-r border-slate-200 dark:border-slate-700">
              <RangeInputs min={filtros.cmpMin} max={filtros.cmpMax} onMin={(v) => setF('cmpMin', v)} onMax={(v) => setF('cmpMax', v)} />
            </th>
            <th className="px-2 py-1 border-r border-slate-200 dark:border-slate-700">
              <RangeInputs min={filtros.valorMin} max={filtros.valorMax} onMin={(v) => setF('valorMin', v)} onMax={(v) => setF('valorMax', v)} />
            </th>
            <th className="px-2 py-1 border-r border-slate-200 dark:border-slate-700">
              <RangeInputs min={filtros.cobMin} max={filtros.cobMax} onMin={(v) => setF('cobMin', v)} onMax={(v) => setF('cobMax', v)} />
            </th>
            <th className="px-2 py-1">
              <select
                value={filtros.divMode}
                onChange={(e) => setF('divMode', e.target.value as ColFiltros['divMode'])}
                className="w-full px-1.5 py-0.5 text-[11px] border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded"
              >
                <option value="todos">todos</option>
                <option value="so_com_div">só com div.</option>
                <option value="so_sem_div">só sem div.</option>
              </select>
            </th>
          </tr>
        </thead>
        <tbody>
          {filtrada.map((s) => (
            <tr key={s.codigoAcxe} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-900/30">
              <td className="px-3 py-2 font-medium border-r border-slate-100 dark:border-slate-700/40">{s.nome}</td>
              <td className="px-3 py-2 text-atlas-muted border-r border-slate-100 dark:border-slate-700/40">{s.familia ?? '—'}</td>
              <td className="px-3 py-2 font-mono text-[11px] text-atlas-muted border-r border-slate-100 dark:border-slate-700/40">{s.ncm ?? '—'}</td>
              <td className="px-3 py-2 text-right border-r border-slate-100 dark:border-slate-700/40">{s.quantidadeKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}</td>
              <td className="px-3 py-2 text-right border-r border-slate-100 dark:border-slate-700/40">{s.cmpBrlKg > 0 ? s.cmpBrlKg.toFixed(2) : '—'}</td>
              <td className="px-3 py-2 text-right border-r border-slate-100 dark:border-slate-700/40">{fmtBRL(s.valorBrl)}</td>
              <td className="px-3 py-2 text-right border-r border-slate-100 dark:border-slate-700/40">{s.coberturaDias != null ? `${s.coberturaDias}d` : '—'}</td>
              <td className="px-3 py-2 text-center">
                <span className={`px-1.5 py-0.5 rounded ${s.divergencias > 0 ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
                  {s.divergencias > 0 ? s.divergencias : '✓'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function RangeInputs({
  min, max, onMin, onMax,
}: { min: string; max: string; onMin: (v: string) => void; onMax: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-0.5">
      <input
        type="number"
        value={min}
        onChange={(e) => onMin(e.target.value)}
        placeholder="≥ min"
        className="w-full px-1 py-0.5 text-[10px] border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-right"
      />
      <input
        type="number"
        value={max}
        onChange={(e) => onMax(e.target.value)}
        placeholder="≤ max"
        className="w-full px-1 py-0.5 text-[10px] border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-right"
      />
    </div>
  );
}

function Card({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
      <div className="text-xs text-atlas-muted">{label}</div>
      <div className={`font-serif text-lg ${accent ?? 'text-atlas-ink'}`}>{value}</div>
      {sub && <div className="text-sm text-atlas-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/**
 * Cobertura por familia. Cor reflete saude:
 *   < 30d   → vermelho (perto de ruptura)
 *   30-60d  → âmbar
 *   60-180d → verde (saudavel)
 *   > 180d  → azul claro (estoque alto / excesso)
 */
function GiroMedioPanel({ giro }: { giro: Record<string, number> }) {
  const entries = Object.entries(giro);
  if (entries.length === 0) return null;

  const cor = (d: number) =>
    d < 30 ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800'
    : d < 60 ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'
    : d <= 180 ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800'
    : 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-800';

  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 mb-6">
      <div className="text-xs text-atlas-muted mb-2">
        <span title="Para cada SKU com consumo > 0: cobertura = saldo_OMIE / consumo_medio_diario. Giro família = média entre os SKUs.">
          Giro Médio (cobertura em dias por família)
          <span className="ml-1 text-atlas-ink cursor-help">ⓘ</span>
        </span>
        <span className="ml-3 text-[10px]">
          <span className="text-red-700">&lt;30d ruptura</span> ·{' '}
          <span className="text-amber-700">30-60d</span> ·{' '}
          <span className="text-emerald-700">60-180d saudável</span> ·{' '}
          <span className="text-sky-700">&gt;180d excesso</span>
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {entries.sort((a, b) => a[1] - b[1]).map(([fam, d]) => (
          <div key={fam} className={`flex items-baseline gap-1.5 px-2.5 py-1 rounded border ${cor(d)}`}>
            <span className="text-xs font-semibold">{fam}</span>
            <span className="text-sm font-mono">{d}d</span>
          </div>
        ))}
      </div>
    </div>
  );
}
