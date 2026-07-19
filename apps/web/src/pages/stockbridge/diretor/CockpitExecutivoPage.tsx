import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';
import { fmtBRL, fmtNum, fmtToneladas, fmtDataBr } from '../../../lib/format.js';

// Visão Executiva — "onde está o dinheiro" (ACXEGDP-314).
// Tela do dono: um número-herói (capital em estoque), a alocação por destino
// (galpão / caminho / comodato), a esteira de importação valorizada e a
// composição por família. Sem filtros, sem métricas operacionais — o Cockpit
// operacional continua existindo em /stockbridge/cockpit.
// Referência visual: protótipo StockBridge v5 do Rogério (legacy/vibecodes).

interface ExecutivoGalpao { nome: string; codigos: string[]; kg: number; valorBrl: number; produtos: number; }
interface ExecutivoEstagio { estagio: string; lotes: number; kg: number; valorBrl: number; }
interface ExecutivoProduto { codigoAcxe: number | null; nome: string; kg: number; valorBrl: number; }
interface ExecutivoFamilia { familia: string; kg: number; valorBrl: number; produtos: ExecutivoProduto[]; }

interface CockpitExecutivoData {
  dataPosicao: string | null;
  totais: {
    valorTotalBrl: number; kgTotal: number;
    emGalpaoBrl: number; emGalpaoKg: number;
    emTransitoBrl: number; emTransitoKg: number;
    comodatoBrl: number; comodatoKg: number;
    kgSemCusto: number;
  };
  galpoes: ExecutivoGalpao[];
  transito: ExecutivoEstagio[];
  exposicaoCambial: { brl: number; usd: number; ptax: number };
  posicaoFiscal: { pendenteImportacaoKg: number; pendenteImportacaoBrl: number; kgSemCusto: number };
  familias: ExecutivoFamilia[];
}

const ESTAGIO_LABELS: Record<string, string> = {
  aguardando_embarque: 'Aguardando embarque',
  transito_intl: 'Em águas',
  no_porto: 'No porto',
  transito_local: 'A caminho do galpão',
};

// Acentos da esteira — semântica de cores do protótipo v5 do Rogério (roxo =
// internacional, laranja = porto, teal = trecho final). Diverge do CockpitPage
// atual (amber no porto, orange no trecho final); se esta direção for aprovada,
// migrar o CockpitPage junto para o diretor não ver cores trocadas entre telas.
const ESTAGIO_ACCENT: Record<string, string> = {
  aguardando_embarque: 'text-atlas-muted',
  transito_intl: 'text-violet-700 dark:text-violet-400',
  no_porto: 'text-orange-700 dark:text-orange-400',
  transito_local: 'text-teal-700 dark:text-teal-400',
};

/** R$ compacto executivo: 57.400.000 → "R$ 57,4 mi"; 828.000 → "R$ 828 mil". */
function fmtDinheiro(v: number, casasMi = 1): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `R$ ${(v / 1e6).toLocaleString('pt-BR', { minimumFractionDigits: casasMi, maximumFractionDigits: casasMi })} mi`;
  if (abs >= 1_000) return `R$ ${(v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`;
  return fmtBRL(v, 0);
}

function fmtPctDe(parte: number, total: number): string {
  if (total <= 0) return '—';
  return `${((parte / total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`;
}

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', headers });
    const body = (await res.json()) as { data: unknown; error: { message?: string } | null };
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro ao carregar');
    return body;
  };
}

export function CockpitExecutivoPage() {
  const apiFetch = useApiFetch();

  const { data, isLoading, error } = useQuery<CockpitExecutivoData>({
    queryKey: ['stockbridge', 'cockpit-executivo'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/cockpit-executivo')).data as CockpitExecutivoData,
  });

  return (
    // max-w-5xl (não o 7xl padrão do módulo): coluna estreita deliberada —
    // leitura de extrato, uma rolagem, sem tabelas largas.
    <div className="p-6 max-w-5xl">
      <header className="mb-8">
        <div className="text-[11px] uppercase tracking-[0.18em] text-atlas-muted mb-1">StockBridge</div>
        <h1 className="font-heading text-2xl text-atlas-ink">Visão Executiva</h1>
        {data?.dataPosicao && (
          <p className="text-xs text-atlas-muted mt-1">
            Posição OMIE de {fmtDataBr(data.dataPosicao)} ·{' '}
            <span
              title="FUP — planilha de follow-up do Comex que acompanha cada importação do embarque à chegada"
              className="cursor-help underline decoration-dotted underline-offset-2"
            >
              trânsito pelo FUP de Comex
            </span>{' '}
            ·{' '}
            <span
              title="CMC — custo médio de compra registrado no OMIE"
              className="cursor-help underline decoration-dotted underline-offset-2"
            >
              custos pelo CMC
            </span>
          </p>
        )}
      </header>

      {isLoading && <SkeletonExecutivo />}

      {error && (
        <div className="border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 rounded-lg p-4 text-sm text-red-700 dark:text-red-300">
          Não foi possível carregar a visão executiva: {(error as Error).message}
        </div>
      )}

      {data && !isLoading && (
        <>
          <Hero data={data} />
          <DestinoCards data={data} />
          <Esteira data={data} />
          <Galpoes galpoes={data.galpoes} total={data.totais.valorTotalBrl} />
          <PosicaoFiscal data={data} />
          <Familias familias={data.familias} totalBrl={data.totais.valorTotalBrl} />
          <Rodape data={data} />
        </>
      )}
    </div>
  );
}

/* ── Hero: o número + a barra de alocação ─────────────────────────────────── */

function Hero({ data }: { data: CockpitExecutivoData }) {
  const t = data.totais;
  const totalSkus = data.familias.reduce((a, f) => a + f.produtos.length, 0);

  const segmentos = [
    { label: 'Em galpão', valor: t.emGalpaoBrl, cor: 'bg-emerald-600 dark:bg-emerald-500' },
    { label: 'No caminho', valor: t.emTransitoBrl, cor: 'bg-violet-600 dark:bg-violet-500' },
    { label: 'Em comodato', valor: t.comodatoBrl, cor: 'bg-amber-500 dark:bg-amber-400' },
  ].filter((s) => s.valor > 0);

  return (
    <section className="mb-8">
      <div className="text-[11px] uppercase tracking-[0.18em] text-atlas-muted">Capital em estoque</div>
      <div className="font-heading text-5xl sm:text-6xl leading-tight text-atlas-ink tabular-nums">
        {fmtDinheiro(t.valorTotalBrl)}
      </div>
      <div className="text-sm text-atlas-muted mt-1">
        {fmtToneladas(t.kgTotal)} de material · {totalSkus} {totalSkus === 1 ? 'produto' : 'produtos'} em{' '}
        {data.familias.length} {data.familias.length === 1 ? 'família' : 'famílias'}
      </div>

      {t.valorTotalBrl > 0 && (
        <div className="mt-5">
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-atlas-border">
            {segmentos.map((s) => (
              <div
                key={s.label}
                className={`${s.cor} transition-all duration-500`}
                style={{ width: `${(s.valor / t.valorTotalBrl) * 100}%` }}
                title={`${s.label}: ${fmtDinheiro(s.valor)}`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2">
            {segmentos.map((s) => (
              <div key={s.label} className="flex items-center gap-1.5 text-xs text-atlas-muted">
                <span className={`inline-block w-2 h-2 rounded-full ${s.cor}`} />
                {s.label} <span className="text-atlas-ink font-medium">{fmtPctDe(s.valor, t.valorTotalBrl)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/* ── Destinos: 3 cards ────────────────────────────────────────────────────── */

function DestinoCards({ data }: { data: CockpitExecutivoData }) {
  const t = data.totais;
  const cards = [
    {
      label: 'Em galpão',
      hint: 'material disponível nos armazéns',
      brl: t.emGalpaoBrl,
      kg: t.emGalpaoKg,
      borda: 'border-t-emerald-600 dark:border-t-emerald-500',
    },
    {
      label: 'No caminho',
      hint: 'importações em curso (FUP)',
      brl: t.emTransitoBrl,
      kg: t.emTransitoKg,
      borda: 'border-t-violet-600 dark:border-t-violet-500',
    },
    {
      label: 'Em comodato',
      hint: 'emprestado a clientes',
      brl: t.comodatoBrl,
      kg: t.comodatoKg,
      borda: 'border-t-amber-500 dark:border-t-amber-400',
    },
  ];

  return (
    <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-10">
      {cards.map((c) => (
        <div key={c.label} className={`bg-atlas-card border border-atlas-border border-t-2 ${c.borda} rounded-lg p-4`}>
          <div className="text-xs text-atlas-muted">{c.label}</div>
          <div className="font-heading text-2xl text-atlas-ink tabular-nums mt-0.5">{fmtDinheiro(c.brl)}</div>
          <div className="text-xs text-atlas-muted mt-1">
            {fmtToneladas(c.kg)} · {fmtPctDe(c.brl, t.valorTotalBrl)} do total
          </div>
          <div className="text-[11px] text-atlas-muted/80 mt-2">{c.hint}</div>
        </div>
      ))}
    </section>
  );
}

/* ── Esteira de importação valorizada ─────────────────────────────────────── */

function Esteira({ data }: { data: CockpitExecutivoData }) {
  const temTransito = data.transito.some((e) => e.kg > 0);

  return (
    <section className="mb-10">
      <SecaoTitulo titulo="No caminho" sub="pipeline de importação, do embarque ao galpão" />
      {!temTransito ? (
        // Texto solto (sem a caixa tracejada padrão do módulo): decisão
        // editorial — vazio aqui é informação normal, não estado de alerta.
        <p className="text-sm text-atlas-muted">Nenhuma importação em trânsito no momento.</p>
      ) : (
        <>
          <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
            {data.transito.map((e, i) => (
              <div key={e.estagio} className="flex items-center gap-2 flex-1 min-w-[150px]">
                <div className="bg-atlas-card border border-atlas-border rounded-lg p-3 flex-1">
                  <div className={`text-[11px] font-medium ${ESTAGIO_ACCENT[e.estagio] ?? 'text-atlas-muted'}`}>
                    {ESTAGIO_LABELS[e.estagio] ?? e.estagio}
                  </div>
                  <div className="font-heading text-lg text-atlas-ink tabular-nums mt-0.5">
                    {e.kg > 0 ? fmtDinheiro(e.valorBrl) : '—'}
                  </div>
                  <div className="text-[11px] text-atlas-muted">
                    {e.kg > 0 ? `${fmtToneladas(e.kg)} · ${e.lotes} ${e.lotes === 1 ? 'lote' : 'lotes'}` : 'vazio'}
                  </div>
                </div>
                {i < data.transito.length - 1 && <span aria-hidden="true" className="text-atlas-muted shrink-0">→</span>}
              </div>
            ))}
          </div>
          {data.exposicaoCambial.brl > 0 && (
            <p className="text-xs text-atlas-muted mt-2">
              Exposição cambial (em águas): <span className="text-atlas-ink font-medium">{fmtDinheiro(data.exposicaoCambial.brl)}</span>
              {' '}≈ US$ {fmtNum(data.exposicaoCambial.usd / 1e6, 1)} mi
              <span className="text-atlas-muted/70"> · PTAX {data.exposicaoCambial.ptax.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</span>
            </p>
          )}
        </>
      )}
    </section>
  );
}

/* ── Galpões ──────────────────────────────────────────────────────────────── */

function Galpoes({ galpoes, total }: { galpoes: ExecutivoGalpao[]; total: number }) {
  return (
    <section className="mb-10">
      <SecaoTitulo titulo="Em galpão" sub="onde o material está guardado" />
      {galpoes.length === 0 ? (
        <p className="text-sm text-atlas-muted">Sem saldo em galpões físicos na posição atual.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {galpoes.map((g) => (
            <div key={g.nome} className="bg-atlas-card border border-atlas-border rounded-lg p-4 hover:border-atlas-muted transition-colors">
              {/* Sem tooltip com os códigos OMIE: nunca expor código de sistema ao usuário (ACXEGDP-313). */}
              <div className="text-xs text-atlas-muted truncate">{g.nome}</div>
              <div className="font-heading text-xl text-atlas-ink tabular-nums mt-0.5">{fmtDinheiro(g.valorBrl)}</div>
              <div className="text-[11px] text-atlas-muted mt-1">
                {fmtToneladas(g.kg)} · {g.produtos} {g.produtos === 1 ? 'produto' : 'produtos'} · {fmtPctDe(g.valorBrl, total)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ── Posição fiscal (informativa — não soma) ──────────────────────────────── */

function PosicaoFiscal({ data }: { data: CockpitExecutivoData }) {
  const pf = data.posicaoFiscal;
  if (pf.pendenteImportacaoKg <= 0) return null;

  return (
    <section className="mb-10">
      <SecaoTitulo titulo="Posição fiscal" sub="importações com nota emitida aguardando entrada" />
      <div className="bg-atlas-card border border-atlas-border rounded-lg p-4 flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div>
          <span className="font-heading text-xl text-atlas-ink tabular-nums">{fmtToneladas(pf.pendenteImportacaoKg)}</span>
          <span className="text-sm text-atlas-muted"> ≈ {fmtDinheiro(pf.pendenteImportacaoBrl)}</span>
          {pf.kgSemCusto > 0 && (
            <span className="text-[11px] text-atlas-muted"> (+ {fmtToneladas(pf.kgSemCusto)} sem custo de referência)</span>
          )}
        </div>
        <div className="text-[11px] text-atlas-muted">
          Já contado em “No caminho” — não soma duas vezes.{' '}
          <Link to="/stockbridge/pendencias-fiscais" className="underline hover:text-atlas-ink">Ver detalhe</Link>
        </div>
      </div>
    </section>
  );
}

/* ── Composição por família ───────────────────────────────────────────────── */

const FAMILIAS_VISIVEIS = 12;

function Familias({ familias, totalBrl }: { familias: ExecutivoFamilia[]; totalBrl: number }) {
  const [expandida, setExpandida] = useState<string | null>(null);
  const [mostrarTodas, setMostrarTodas] = useState(false);

  if (familias.length === 0) return null;

  const visiveis = mostrarTodas ? familias : familias.slice(0, FAMILIAS_VISIVEIS);
  const maiorValor = Math.max(1, ...familias.map((f) => f.valorBrl));

  return (
    <section className="mb-10">
      <SecaoTitulo titulo="Composição por família" sub="onde o capital está aplicado — clique para abrir os produtos" />
      <div className="bg-atlas-card border border-atlas-border rounded-lg divide-y divide-atlas-border/60">
        {visiveis.map((f) => {
          const aberta = expandida === f.familia;
          return (
            <div key={f.familia}>
              <button
                onClick={() => setExpandida(aberta ? null : f.familia)}
                aria-expanded={aberta}
                className="w-full px-4 py-2.5 grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_auto] items-center gap-3 text-left hover:bg-atlas-bg/60 transition-colors focus:outline-none focus:ring-2 focus:ring-acxe rounded"
              >
                <div className="min-w-0">
                  <span aria-hidden="true" className={`text-atlas-muted text-xs mr-1.5 inline-block transition-transform ${aberta ? 'rotate-90' : ''}`}>▸</span>
                  <span className="text-sm text-atlas-ink truncate">{f.familia}</span>
                </div>
                <div className="hidden sm:block h-1.5 rounded-full bg-atlas-border overflow-hidden">
                  <div
                    className="h-full bg-atlas-ink/70 dark:bg-atlas-ink transition-all duration-500"
                    style={{ width: `${(f.valorBrl / maiorValor) * 100}%` }}
                  />
                </div>
                <div className="text-right whitespace-nowrap">
                  <span className="font-heading text-sm text-atlas-ink tabular-nums">{fmtDinheiro(f.valorBrl)}</span>
                  <span className="text-[11px] text-atlas-muted ml-2">{fmtToneladas(f.kg)} · {fmtPctDe(f.valorBrl, totalBrl)}</span>
                </div>
              </button>
              {aberta && (
                <div className="px-4 pb-3 pt-1 bg-atlas-bg/40">
                  {f.produtos.map((p) => (
                    <div key={p.codigoAcxe ?? p.nome} className="flex items-baseline justify-between py-1 text-xs border-b border-atlas-border/40 last:border-0">
                      <span className="text-atlas-ink truncate pr-3">{p.nome}</span>
                      <span className="whitespace-nowrap text-atlas-muted">
                        <span className="text-atlas-ink tabular-nums">{fmtDinheiro(p.valorBrl)}</span>
                        {' '}· {fmtToneladas(p.kg)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {familias.length > FAMILIAS_VISIVEIS && (
        <button
          onClick={() => setMostrarTodas((v) => !v)}
          className="mt-2 text-xs text-atlas-muted underline hover:text-atlas-ink"
        >
          {mostrarTodas ? 'Mostrar menos' : `Mostrar todas as ${familias.length} famílias`}
        </button>
      )}
    </section>
  );
}

/* ── Rodapé de notas ──────────────────────────────────────────────────────── */

function Rodape({ data }: { data: CockpitExecutivoData }) {
  return (
    <footer className="border-t border-atlas-border pt-3 space-y-1">
      {data.totais.kgSemCusto > 0 && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          <span aria-hidden="true">⚠ </span>
          {fmtToneladas(data.totais.kgSemCusto)} sem custo cadastrado no OMIE — entram na tonelagem, mas valem R$ 0 nesta visão.
        </p>
      )}
      <p className="text-[11px] text-atlas-muted">
        Saldo e custo médio (CMC) do OMIE · trânsito do FUP de Comex, valorizado pelo custo de compra de cada lote ·
        {' '}espelhamento ACXE↔Q2P contado uma única vez. A visão operacional completa continua no{' '}
        <Link to="/stockbridge/cockpit" className="underline hover:text-atlas-ink">Cockpit</Link>.
      </p>
    </footer>
  );
}

/* ── Apoio ────────────────────────────────────────────────────────────────── */

function SecaoTitulo({ titulo, sub }: { titulo: string; sub: string }) {
  return (
    <div className="mb-3">
      <h2 className="font-heading text-base text-atlas-ink">{titulo}</h2>
      <p className="text-[11px] text-atlas-muted">{sub}</p>
    </div>
  );
}

function SkeletonExecutivo() {
  return (
    <div className="animate-pulse space-y-8">
      <div>
        <div className="h-3 w-32 bg-atlas-border rounded mb-3" />
        <div className="h-14 w-64 bg-atlas-border rounded mb-3" />
        <div className="h-2.5 w-full bg-atlas-border rounded-full" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 bg-atlas-border/60 rounded-lg" />
        ))}
      </div>
      <div className="h-40 bg-atlas-border/40 rounded-lg" />
    </div>
  );
}
