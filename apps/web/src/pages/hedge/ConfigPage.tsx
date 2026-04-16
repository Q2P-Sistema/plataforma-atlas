import { useState, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../stores/auth.store.js';

interface ConfigRow { chave: string; valor: any; descricao: string | null; }

const PARAM_GROUPS: { title: string; src: string; srcColor: string; params: { key: string; label: string; desc: string; unit: string; step: number; min?: number; max?: number }[] }[] = [
  {
    title: 'Operacional', src: 'OMIE Q2P + Manual', srcColor: '#1a9944',
    params: [
      { key: 'faturamento_mensal', label: 'Faturamento mensal', desc: 'Base de cálculo do ciclo', unit: 'R$M', step: 0.5 },
      { key: 'pct_custo_importado', label: '% Custo importado', desc: 'Proporção do custo em USD', unit: '%', step: 1, min: 0, max: 100 },
      { key: 'transit_medio_dias', label: 'Trânsito médio', desc: 'D0 ao desembarque', unit: 'dias', step: 5, min: 30, max: 180 },
      { key: 'giro_estoque_dias', label: 'Giro de estoque', desc: 'Dias médios no chão', unit: 'dias', step: 5, min: 15, max: 90 },
      { key: 'prazo_recebimento', label: 'Prazo médio recebimento', desc: 'NF saída ao pagamento cliente', unit: 'dias', step: 1, min: 0, max: 90 },
    ],
  },
  {
    title: 'Motor de Hedge', src: 'MOTOR MV', srcColor: '#059669',
    params: [
      { key: 'lambda_default', label: 'Lambda — Aversão ao risco', desc: '0 = minimiza custo - 1 = max. proteção', unit: '', step: 0.05, min: 0, max: 1 },
      { key: 'camada1_minima', label: 'Camada 1 mínima', desc: 'Hedge automático mínimo por bucket', unit: '%', step: 5, min: 30, max: 90 },
      { key: 'margem_floor', label: 'Margem floor', desc: 'Alerta se margem cair abaixo', unit: '%', step: 1, min: 5, max: 40 },
      { key: 'estoque_bump_threshold', label: 'Threshold est. não pago', desc: 'Eleva L1 se acima', unit: '', step: 0.05, min: 0, max: 1 },
      { key: 'cobertura_bump_pct', label: 'Ajuste L1 se est. alto', desc: 'Eleva Camada 1 automaticamente', unit: '%', step: 1, min: 60, max: 90 },
    ],
  },
];

const NDF_PRAZOS = [30, 60, 90, 120, 180];

function useHedgeFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers as Record<string, string>) };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body;
  };
}

export function ConfigPage() {
  const queryClient = useQueryClient();
  const hedgeFetch = useHedgeFetch();
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');
  const [taxaForm, setTaxaForm] = useState({ data_ref: '', prazo_dias: '90', taxa: '' });
  const [saveMsg, setSaveMsg] = useState(false);

  const { data: configs = [] } = useQuery<ConfigRow[]>({
    queryKey: ['hedge', 'config'],
    queryFn: async () => {
      const res = await fetch('/api/v1/hedge/config', { credentials: 'include' });
      const body = (await res.json()) as any;
      if (!res.ok) throw new Error(body.error?.message ?? 'Erro ao carregar config');
      return body.data;
    },
  });

  const configMap = new Map(configs.map(c => [c.chave, c.valor]));

  const updateMut = useMutation({
    mutationFn: async ({ chave, valor }: { chave: string; valor: string }) =>
      hedgeFetch('/api/v1/hedge/config', { method: 'PATCH', body: JSON.stringify({ chave, valor }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['hedge', 'config'] });
      setEditKey(null);
      setSaveMsg(true);
      setTimeout(() => setSaveMsg(false), 3000);
    },
  });

  const taxaMut = useMutation({
    mutationFn: async () =>
      hedgeFetch('/api/v1/hedge/taxas-ndf', { method: 'POST', body: JSON.stringify({
        data_ref: taxaForm.data_ref, prazo_dias: parseInt(taxaForm.prazo_dias, 10), taxa: parseFloat(taxaForm.taxa),
      })}),
    onSuccess: () => setTaxaForm({ data_ref: '', prazo_dias: '90', taxa: '' }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-bold text-atlas-text">Configuração</h1>
        {saveMsg && <span className="text-xs text-q2p animate-pulse">Parâmetros salvos e aplicados ao motor.</span>}
      </div>

      {/* Param groups */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {PARAM_GROUPS.map((group) => (
          <div key={group.title} className="bg-atlas-card border border-atlas-border rounded-lg p-5">
            <div className="flex justify-between items-center mb-4 pb-3 border-b border-atlas-border">
              <span className="text-xs tracking-[2px] text-atlas-muted uppercase">{group.title}</span>
              <span className="text-xs px-1.5 py-0.5 rounded border font-semibold tracking-wider uppercase"
                style={{ backgroundColor: group.srcColor + '15', color: group.srcColor, borderColor: group.srcColor + '30' }}>
                {group.src}
              </span>
            </div>
            <div className="space-y-0">
              {group.params.map((p) => {
                const val = configMap.get(p.key);
                const isEditing = editKey === p.key;
                return (
                  <div key={p.key} className="flex items-center justify-between py-2.5 border-b border-atlas-border/50 last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-atlas-text">{p.label}</p>
                      <p className="text-xs text-atlas-muted">{p.desc}</p>
                    </div>
                    <div className="flex items-center gap-2 ml-3">
                      {isEditing ? (
                        <>
                          <input type="number" step={p.step} min={p.min} max={p.max} value={editVal}
                            onChange={(e: ChangeEvent<HTMLInputElement>) => setEditVal(e.target.value)}
                            className="w-20 px-2 py-1 rounded border border-atlas-border bg-atlas-bg text-atlas-text text-xs text-right font-mono focus:outline-none focus:ring-1 focus:ring-emerald-600" />
                          <span className="text-xs text-atlas-muted min-w-[28px]">{p.unit}</span>
                          <button onClick={() => updateMut.mutate({ chave: p.key, valor: editVal })}
                            className="text-xs px-2 py-1 rounded bg-q2p text-white">OK</button>
                          <button onClick={() => setEditKey(null)} className="text-xs px-2 py-1 rounded bg-atlas-border text-atlas-text">X</button>
                        </>
                      ) : (
                        <>
                          <span className="text-xs font-mono text-atlas-text cursor-pointer hover:text-q2p"
                            onClick={() => { setEditKey(p.key); setEditVal(val != null ? String(val) : ''); }}>
                            {val != null ? String(val) : '—'}
                          </span>
                          <span className="text-xs text-atlas-muted min-w-[28px]">{p.unit}</span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {/* NDF Rates */}
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-5">
          <div className="flex justify-between items-center mb-4 pb-3 border-b border-atlas-border">
            <span className="text-xs tracking-[2px] text-atlas-muted uppercase">Taxas NDF — Input Manual</span>
            <span className="text-xs px-1.5 py-0.5 rounded border font-semibold tracking-wider uppercase bg-purple-500/10 text-purple-600 border-purple-500/20">
              BANCO - Atualizar semanalmente
            </span>
          </div>
          {NDF_PRAZOS.map((prazo) => {
            const key = `ndf_${prazo}d`;
            const val = configMap.get(key);
            const isEditing = editKey === key;
            return (
              <div key={prazo} className="flex items-center justify-between py-2.5 border-b border-atlas-border/50 last:border-0">
                <p className="text-sm font-medium text-atlas-text">NDF {prazo} dias</p>
                <div className="flex items-center gap-2">
                  {isEditing ? (
                    <>
                      <input type="number" step={0.01} value={editVal}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => setEditVal(e.target.value)}
                        className="w-20 px-2 py-1 rounded border border-atlas-border bg-atlas-bg text-atlas-text text-xs text-right font-mono focus:outline-none focus:ring-1 focus:ring-purple-600" />
                      <span className="text-xs text-atlas-muted">R$/USD</span>
                      <button onClick={() => updateMut.mutate({ chave: key, valor: editVal })}
                        className="text-xs px-2 py-1 rounded bg-purple-600 text-white">OK</button>
                      <button onClick={() => setEditKey(null)} className="text-xs px-2 py-1 rounded bg-atlas-border text-atlas-text">X</button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs font-mono text-atlas-text cursor-pointer hover:text-purple-600"
                        onClick={() => { setEditKey(key); setEditVal(val != null ? String(val) : ''); }}>
                        {val != null ? `R$ ${Number(val).toFixed(2)}` : '—'}
                      </span>
                      <span className="text-xs text-atlas-muted">R$/USD</span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Insert new NDF rate */}
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-5">
          <div className="flex justify-between items-center mb-4 pb-3 border-b border-atlas-border">
            <span className="text-xs tracking-[2px] text-atlas-muted uppercase">Inserir Nova Cotação NDF</span>
          </div>
          <div className="space-y-3">
            <div>
              <label htmlFor="taxa-data" className="block text-xs text-atlas-muted mb-1">Data referência</label>
              <input id="taxa-data" type="date" value={taxaForm.data_ref}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setTaxaForm({ ...taxaForm, data_ref: e.target.value })}
                className="w-full px-3 py-2 rounded border border-atlas-border bg-atlas-bg text-atlas-text text-xs focus:outline-none focus:ring-1 focus:ring-acxe" />
            </div>
            <div>
              <label htmlFor="taxa-prazo" className="block text-xs text-atlas-muted mb-1">Prazo</label>
              <select id="taxa-prazo" value={taxaForm.prazo_dias}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setTaxaForm({ ...taxaForm, prazo_dias: e.target.value })}
                className="w-full px-3 py-2 rounded border border-atlas-border bg-atlas-bg text-atlas-text text-xs focus:outline-none focus:ring-1 focus:ring-acxe">
                {NDF_PRAZOS.map(p => <option key={p} value={p}>{p}d</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="taxa-valor" className="block text-xs text-atlas-muted mb-1">Taxa (R$/USD)</label>
              <input id="taxa-valor" type="number" step="0.0001" value={taxaForm.taxa} placeholder="5.8500"
                onChange={(e: ChangeEvent<HTMLInputElement>) => setTaxaForm({ ...taxaForm, taxa: e.target.value })}
                className="w-full px-3 py-2 rounded border border-atlas-border bg-atlas-bg text-atlas-text text-xs focus:outline-none focus:ring-1 focus:ring-acxe" />
            </div>
            <button onClick={() => taxaMut.mutate()} disabled={!taxaForm.data_ref || !taxaForm.taxa || taxaMut.isPending}
              className="w-full px-4 py-2 rounded bg-q2p text-white text-xs font-medium hover:bg-[#158a3b] disabled:opacity-50 transition-colors">
              {taxaMut.isPending ? 'Salvando...' : 'Inserir Taxa'}
            </button>
          </div>
        </div>
      </div>

      {/* Info insights */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-r p-3 text-xs leading-relaxed text-atlas-muted" style={{ borderLeft: '2px solid #0077cc', backgroundColor: 'rgba(0,119,204,0.07)' }}>
          <strong className="text-atlas-text">Sincronização automática:</strong> BD VPS Acxe e Q2P sincronizam diariamente via n8n. PTAX BCB disponível via API pública — pull a cada 15 min em dias úteis.
        </div>
        <div className="rounded-r p-3 text-xs leading-relaxed text-atlas-muted" style={{ borderLeft: '2px solid #059669', backgroundColor: 'rgba(5,150,105,0.07)' }}>
          <strong className="text-atlas-text">Taxa NDF:</strong> Inserida manualmente — frequência recomendada: toda segunda-feira. Cotações obtidas com o banco parceiro.
        </div>
      </div>
    </div>
  );
}
