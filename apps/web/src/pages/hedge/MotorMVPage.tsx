import { useState, type ChangeEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { DataTable, type Column } from '@atlas/ui';
import { useAuthStore } from '../../stores/auth.store.js';

interface CamadasResult {
  l1_pct: number;
  l2_pct: number;
  l3_pct: number;
}

interface Recomendacao {
  bucket_id: string;
  mes_ref: string;
  instrumento: string;
  notional_sugerido: number;
  gap_atual: number;
  cobertura_alvo: number;
}

interface MotorResult {
  camadas: CamadasResult;
  recomendacoes: Recomendacao[];
}

function formatUsd(val: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(val);
}

export function MotorMVPage() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [lambda, setLambda] = useState(0.5);
  const [pctEstoque, setPctEstoque] = useState(0.3);
  const [result, setResult] = useState<MotorResult | null>(null);

  const calcMutation = useMutation({
    mutationFn: async (params: { lambda: number; pct_estoque_nao_pago: number }) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;

      const res = await fetch('/api/v1/hedge/motor/calcular', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(params),
      });
      const body = (await res.json()) as any;
      if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
      return body.data as MotorResult;
    },
    onSuccess: (data) => setResult(data),
  });

  function handleCalc() {
    calcMutation.mutate({ lambda, pct_estoque_nao_pago: pctEstoque });
  }

  const columns: Column<Recomendacao>[] = [
    {
      key: 'mes_ref',
      header: 'Bucket',
      render: (row) => row.mes_ref.slice(0, 7),
    },
    { key: 'instrumento', header: 'Instrumento' },
    {
      key: 'notional_sugerido',
      header: 'Notional Sugerido',
      render: (row) => formatUsd(row.notional_sugerido),
    },
    {
      key: 'gap_atual',
      header: 'Gap Atual',
      render: (row) => formatUsd(row.gap_atual),
    },
    {
      key: 'cobertura_alvo',
      header: 'Cobertura Alvo',
      render: (row) => `${row.cobertura_alvo.toFixed(1)}%`,
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-heading font-bold text-atlas-text">Motor de Minima Variancia</h1>

      {/* Sliders */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SliderControl
          label="Lambda (aversao ao risco)"
          value={lambda}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => { setLambda(v); handleCalc(); }}
          display={lambda.toFixed(2)}
        />
        <SliderControl
          label="% Estoque nao-pago"
          value={pctEstoque}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => { setPctEstoque(v); handleCalc(); }}
          display={`${(pctEstoque * 100).toFixed(0)}%`}
        />
      </div>

      <button
        onClick={handleCalc}
        disabled={calcMutation.isPending}
        className="px-4 py-2 rounded-lg bg-acxe text-white text-sm font-medium hover:bg-acxe/90 disabled:opacity-50 transition-colors"
      >
        {calcMutation.isPending ? 'Calculando...' : 'Calcular'}
      </button>

      {/* Camadas Cards */}
      {result && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <CamadaCard
              label="L1 — Base"
              pct={result.camadas.l1_pct}
              desc="Cobertura automatica"
              color="bg-acxe"
            />
            <CamadaCard
              label="L2 — Tatica"
              pct={result.camadas.l2_pct}
              desc={`Lambda × 25 = ${result.camadas.l2_pct.toFixed(1)}%`}
              color="bg-q2p"
            />
            <CamadaCard
              label="L3 — Aberta"
              pct={result.camadas.l3_pct}
              desc="Gap intencional"
              color="bg-warn"
            />
          </div>

          {/* Recomendacoes Table */}
          <div>
            <h2 className="text-lg font-heading font-semibold text-atlas-text mb-3">Recomendacoes</h2>
            <DataTable
              columns={columns}
              data={result.recomendacoes}
              rowKey={(row) => row.bucket_id}
              emptyMessage="Nenhuma recomendacao — cobertura ja atinge o alvo"
            />
          </div>
        </>
      )}
    </div>
  );
}

function SliderControl({
  label,
  value,
  min,
  max,
  step,
  onChange,
  display,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  display: string;
}) {
  return (
    <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm font-medium text-atlas-text">{label}</label>
        <span className="text-sm font-mono text-acxe">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(parseFloat(e.target.value))}
        className="w-full accent-acxe"
        aria-label={label}
      />
    </div>
  );
}

function CamadaCard({
  label,
  pct,
  desc,
  color,
}: {
  label: string;
  pct: number;
  desc: string;
  color: string;
}) {
  return (
    <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
      <p className="text-xs text-atlas-muted uppercase tracking-wider mb-1">{label}</p>
      <p className="text-2xl font-bold text-atlas-text mb-1">{pct.toFixed(1)}%</p>
      <div className="w-full h-2 bg-atlas-border rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-atlas-muted mt-2">{desc}</p>
    </div>
  );
}
