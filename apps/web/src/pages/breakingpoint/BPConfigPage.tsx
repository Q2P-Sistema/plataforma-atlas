import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

interface Params {
  empresa: 'acxe' | 'q2p';
  dup_antecip_usado: number;
  markup_estoque: number;
  alerta_gap_limiar: number;
  cat_finimp_cod: string | null;
  updated_at: string;
}

interface Banco {
  id: string;
  empresa: 'acxe' | 'q2p';
  banco_id: string;
  banco_nome: string;
  cor_hex: string;
  antecip_limite: number;
  antecip_usado: number;
  antecip_taxa: number;
  antecip_disp: number;
  finimp_limite: number;
  finimp_usado: number;
  finimp_garantia_pct: number;
  finimp_disp: number;
  cheque_limite: number;
  cheque_usado: number;
  cheque_disp: number;
  ativo: boolean;
  updated_at: string;
}

interface Conta {
  n_cod_cc: number;
  descricao: string;
  codigo_banco: string | null;
  saldo_atual: number;
  incluir: boolean;
}

const EMPRESA = 'acxe' as const;

async function fetchParams(): Promise<Params> {
  const r = await fetch(`/api/v1/bp/params?empresa=${EMPRESA}`, { credentials: 'include' });
  const j = await r.json();
  return j.data;
}
async function putParams(p: Omit<Params, 'updated_at'>): Promise<void> {
  const r = await fetch('/api/v1/bp/params', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message ?? 'Falha ao salvar');
}

async function fetchBancos(): Promise<Banco[]> {
  const r = await fetch(`/api/v1/bp/bancos?empresa=${EMPRESA}`, { credentials: 'include' });
  return (await r.json()).data;
}
async function putBanco(b: Banco): Promise<void> {
  const r = await fetch(`/api/v1/bp/bancos/${b.id}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      banco_nome: b.banco_nome,
      cor_hex: b.cor_hex,
      antecip_limite: b.antecip_limite,
      antecip_usado: b.antecip_usado,
      antecip_taxa: b.antecip_taxa,
      finimp_limite: b.finimp_limite,
      finimp_usado: b.finimp_usado,
      finimp_garantia_pct: b.finimp_garantia_pct,
      cheque_limite: b.cheque_limite,
      cheque_usado: b.cheque_usado,
      ativo: b.ativo,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message ?? 'Falha ao salvar banco');
}
async function deleteBancoCall(id: string): Promise<void> {
  const r = await fetch(`/api/v1/bp/bancos/${id}`, { method: 'DELETE', credentials: 'include' });
  if (!r.ok) throw new Error('Falha ao remover');
}
async function postBanco(b: Omit<Banco, 'id' | 'antecip_disp' | 'finimp_disp' | 'cheque_disp' | 'updated_at'>): Promise<void> {
  const r = await fetch('/api/v1/bp/bancos', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message ?? 'Falha ao criar banco');
}

async function fetchContas(): Promise<Conta[]> {
  const r = await fetch(`/api/v1/bp/contas?empresa=${EMPRESA}`, { credentials: 'include' });
  return (await r.json()).data;
}
async function putConta(nCodCC: number, incluir: boolean): Promise<void> {
  const r = await fetch(`/api/v1/bp/contas/${nCodCC}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empresa: EMPRESA, incluir }),
  });
  if (!r.ok) throw new Error('Falha ao salvar toggle');
}

const fmtBRL = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v);

function Toast({ msg, kind }: { msg: string; kind: 'ok' | 'err' }) {
  return (
    <div
      role="status"
      className={`fixed bottom-6 right-6 px-4 py-2 rounded-lg shadow-lg text-sm font-semibold ${
        kind === 'ok' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
      }`}
    >
      {msg}
    </div>
  );
}

export function BPConfigPage() {
  const qc = useQueryClient();
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  function notify(msg: string, kind: 'ok' | 'err' = 'ok') {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2500);
  }

  const invalidateProj = () => qc.invalidateQueries({ queryKey: ['bp', 'projecao'] });

  return (
    <div className="p-6 max-w-[1440px] mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold">Breaking Point · Configurar</h1>
        <p className="text-xs text-atlas-muted mt-1">
          Parâmetros manuais não sincronizados do OMIE. Alterações recalculam a projeção em até 2 segundos.
        </p>
      </div>

      <ParamsSection notify={notify} invalidateProj={invalidateProj} />
      <BancosSection notify={notify} invalidateProj={invalidateProj} />
      <ContasSection notify={notify} invalidateProj={invalidateProj} />

      {toast && <Toast msg={toast.msg} kind={toast.kind} />}
    </div>
  );
}

function ParamsSection({ notify, invalidateProj }: { notify: (m: string, k?: 'ok' | 'err') => void; invalidateProj: () => void }) {
  const { data: params } = useQuery({ queryKey: ['bp', 'params'], queryFn: fetchParams });
  const [form, setForm] = useState<Params | null>(null);

  useEffect(() => {
    if (params) setForm(params);
  }, [params]);

  const mut = useMutation({
    mutationFn: putParams,
    onSuccess: () => {
      notify('Parâmetros salvos');
      invalidateProj();
    },
    onError: (e: Error) => notify(e.message, 'err'),
  });

  if (!form) return <div className="text-atlas-muted text-sm">Carregando parâmetros…</div>;

  return (
    <section className="bg-atlas-card border border-atlas-border rounded-xl p-5">
      <h2 className="text-sm font-bold mb-4">Parâmetros Globais</h2>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Antecipação já usada (R$)" hint="Total de duplicatas já antecipadas no período">
          <input
            type="number"
            min={0}
            step={1000}
            className="input w-full"
            value={form.dup_antecip_usado}
            onChange={(e) => setForm({ ...form, dup_antecip_usado: Number(e.target.value) || 0 })}
          />
        </Field>
        <Field label="Markup de estoque (%)" hint="Aplicado sobre o custo para obter valor de venda D+15">
          <input
            type="number"
            min={0}
            max={1000}
            step={1}
            className="input w-full"
            value={Math.round(form.markup_estoque * 100)}
            onChange={(e) => setForm({ ...form, markup_estoque: Number(e.target.value) / 100 })}
          />
        </Field>
        <Field label="Limiar ALERTA (R$)" hint="Gap positivo abaixo deste valor classifica semana como ALERTA">
          <input
            type="number"
            min={0}
            step={10000}
            className="input w-full"
            value={form.alerta_gap_limiar}
            onChange={(e) => setForm({ ...form, alerta_gap_limiar: Number(e.target.value) || 0 })}
          />
        </Field>
        <Field label="Código categoria FINIMP" hint="Código da categoria OMIE que identifica FINIMP (ex: 2.01.01). Deixe vazio se não usa.">
          <input
            type="text"
            className="input w-full"
            placeholder="(nenhum)"
            value={form.cat_finimp_cod ?? ''}
            onChange={(e) => setForm({ ...form, cat_finimp_cod: e.target.value.trim() || null })}
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          className="btn-primary text-xs"
          disabled={mut.isPending}
          onClick={() =>
            mut.mutate({
              empresa: form.empresa,
              dup_antecip_usado: form.dup_antecip_usado,
              markup_estoque: form.markup_estoque,
              alerta_gap_limiar: form.alerta_gap_limiar,
              cat_finimp_cod: form.cat_finimp_cod,
            })
          }
        >
          {mut.isPending ? 'Salvando…' : 'Salvar parâmetros'}
        </button>
      </div>
    </section>
  );
}

function BancosSection({ notify, invalidateProj }: { notify: (m: string, k?: 'ok' | 'err') => void; invalidateProj: () => void }) {
  const qc = useQueryClient();
  const { data: bancos = [] } = useQuery({ queryKey: ['bp', 'bancos'], queryFn: fetchBancos });

  const saveMut = useMutation({
    mutationFn: putBanco,
    onSuccess: () => {
      notify('Banco atualizado');
      invalidateProj();
      qc.invalidateQueries({ queryKey: ['bp', 'bancos'] });
    },
    onError: (e: Error) => notify(e.message, 'err'),
  });

  const delMut = useMutation({
    mutationFn: deleteBancoCall,
    onSuccess: () => {
      notify('Banco removido');
      invalidateProj();
      qc.invalidateQueries({ queryKey: ['bp', 'bancos'] });
    },
    onError: (e: Error) => notify(e.message, 'err'),
  });

  const createMut = useMutation({
    mutationFn: postBanco,
    onSuccess: () => {
      notify('Banco criado');
      invalidateProj();
      qc.invalidateQueries({ queryKey: ['bp', 'bancos'] });
      setNewOpen(false);
    },
    onError: (e: Error) => notify(e.message, 'err'),
  });

  const [newOpen, setNewOpen] = useState(false);

  return (
    <section className="bg-atlas-card border border-atlas-border rounded-xl p-5">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-sm font-bold">Limites Bancários</h2>
        <button type="button" className="btn-secondary text-xs" onClick={() => setNewOpen(!newOpen)}>
          {newOpen ? 'Cancelar' : '+ Adicionar banco'}
        </button>
      </div>

      {newOpen && <NovoBancoForm onCreate={(b) => createMut.mutate(b)} pending={createMut.isPending} />}

      <div className="space-y-3">
        {bancos.map((b) => (
          <BancoRow key={b.id} banco={b} onSave={(updated) => saveMut.mutate(updated)} onDelete={() => delMut.mutate(b.id)} />
        ))}
      </div>
    </section>
  );
}

function BancoRow({ banco, onSave, onDelete }: { banco: Banco; onSave: (b: Banco) => void; onDelete: () => void }) {
  const [form, setForm] = useState(banco);
  useEffect(() => { setForm(banco); }, [banco]);
  const dirty = JSON.stringify(form) !== JSON.stringify(banco);

  return (
    <div className="border border-atlas-border rounded-lg p-3" style={{ borderLeftColor: form.cor_hex, borderLeftWidth: 4 }}>
      <div className="flex items-center gap-3 mb-3">
        <input
          type="color"
          className="w-10 h-8 rounded cursor-pointer"
          value={form.cor_hex}
          onChange={(e) => setForm({ ...form, cor_hex: e.target.value })}
        />
        <input
          type="text"
          className="input text-sm font-semibold"
          value={form.banco_nome}
          onChange={(e) => setForm({ ...form, banco_nome: e.target.value })}
        />
        <span className="text-[10px] text-atlas-muted">ID: {form.banco_id}</span>
        <label className="flex items-center gap-1.5 text-xs ml-auto">
          <input type="checkbox" checked={form.ativo} onChange={(e) => setForm({ ...form, ativo: e.target.checked })} />
          Ativo
        </label>
      </div>
      <div className="grid grid-cols-3 gap-3 text-xs">
        <Group title="Antecipação">
          <NumRow label="Limite" value={form.antecip_limite} onChange={(v) => setForm({ ...form, antecip_limite: v })} />
          <NumRow label="Usado" value={form.antecip_usado} onChange={(v) => setForm({ ...form, antecip_usado: v })} />
          <NumRow label="Taxa (%)" value={form.antecip_taxa * 100} onChange={(v) => setForm({ ...form, antecip_taxa: v / 100 })} step={0.1} />
        </Group>
        <Group title="FINIMP">
          <NumRow label="Limite" value={form.finimp_limite} onChange={(v) => setForm({ ...form, finimp_limite: v })} />
          <NumRow label="Usado" value={form.finimp_usado} onChange={(v) => setForm({ ...form, finimp_usado: v })} />
          <NumRow label="Garantia (%)" value={form.finimp_garantia_pct * 100} onChange={(v) => setForm({ ...form, finimp_garantia_pct: v / 100 })} step={0.1} />
        </Group>
        <Group title="Cheque Especial">
          <NumRow label="Limite" value={form.cheque_limite} onChange={(v) => setForm({ ...form, cheque_limite: v })} />
          <NumRow label="Usado" value={form.cheque_usado} onChange={(v) => setForm({ ...form, cheque_usado: v })} />
        </Group>
      </div>
      <div className="flex justify-end gap-2 mt-3">
        <button type="button" className="btn-danger text-xs" onClick={() => confirm('Remover este banco?') && onDelete()}>
          Remover
        </button>
        <button type="button" className="btn-primary text-xs" disabled={!dirty} onClick={() => onSave(form)}>
          Salvar
        </button>
      </div>
    </div>
  );
}

function NovoBancoForm({ onCreate, pending }: { onCreate: (b: Omit<Banco, 'id' | 'antecip_disp' | 'finimp_disp' | 'cheque_disp' | 'updated_at'>) => void; pending: boolean }) {
  const [id, setId] = useState('');
  const [nome, setNome] = useState('');
  const [cor, setCor] = useState('#666666');
  return (
    <div className="mb-4 p-3 border border-dashed border-atlas-border rounded-lg">
      <div className="grid grid-cols-4 gap-2 items-end">
        <Field label="Slug (único)"><input className="input w-full" value={id} onChange={(e) => setId(e.target.value)} placeholder="caixa" /></Field>
        <Field label="Nome"><input className="input w-full" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Caixa Econômica" /></Field>
        <Field label="Cor"><input type="color" className="w-full h-9 rounded" value={cor} onChange={(e) => setCor(e.target.value)} /></Field>
        <button
          type="button"
          className="btn-primary text-xs h-9"
          disabled={!id || !nome || pending}
          onClick={() =>
            onCreate({
              empresa: EMPRESA,
              banco_id: id,
              banco_nome: nome,
              cor_hex: cor,
              antecip_limite: 0,
              antecip_usado: 0,
              antecip_taxa: 0.85,
              finimp_limite: 0,
              finimp_usado: 0,
              finimp_garantia_pct: 0.4,
              cheque_limite: 0,
              cheque_usado: 0,
              ativo: true,
            })
          }
        >
          {pending ? 'Criando…' : 'Criar'}
        </button>
      </div>
    </div>
  );
}

function ContasSection({ notify, invalidateProj }: { notify: (m: string, k?: 'ok' | 'err') => void; invalidateProj: () => void }) {
  const qc = useQueryClient();
  const { data: contas = [] } = useQuery({ queryKey: ['bp', 'contas'], queryFn: fetchContas });
  const mut = useMutation({
    mutationFn: ({ n, incluir }: { n: number; incluir: boolean }) => putConta(n, incluir),
    onSuccess: () => {
      notify('Toggle salvo');
      invalidateProj();
      qc.invalidateQueries({ queryKey: ['bp', 'contas'] });
    },
    onError: (e: Error) => notify(e.message, 'err'),
  });

  return (
    <section className="bg-atlas-card border border-atlas-border rounded-xl p-5">
      <h2 className="text-sm font-bold mb-4">Contas Correntes no Cálculo de Saldo CC</h2>
      {contas.length === 0 ? (
        <p className="text-xs text-atlas-muted">Nenhuma conta corrente ativa encontrada no OMIE.</p>
      ) : (
        <div className="divide-y divide-atlas-border">
          {contas.map((c) => (
            <label key={c.n_cod_cc} className="flex items-center gap-3 py-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={c.incluir}
                onChange={(e) => mut.mutate({ n: c.n_cod_cc, incluir: e.target.checked })}
              />
              <span className="flex-1">{c.descricao}</span>
              <span className="text-xs text-atlas-muted">Banco {c.codigo_banco ?? '—'}</span>
              <span className="tabular-nums text-xs w-28 text-right">{fmtBRL(c.saldo_atual)}</span>
            </label>
          ))}
        </div>
      )}
      <p className="text-[10px] text-atlas-muted mt-3">
        Contas não listadas (PDV, aplicações, bloqueadas) podem ser excluídas individualmente. Inclusão é padrão.
      </p>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-semibold block mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-atlas-muted mt-1">{hint}</p>}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-atlas-border rounded p-2">
      <div className="text-[10px] uppercase tracking-wider text-atlas-muted font-semibold mb-2">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function NumRow({ label, value, onChange, step = 1000 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-atlas-muted w-20">{label}</span>
      <input
        type="number"
        className="input flex-1 text-xs"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </div>
  );
}
