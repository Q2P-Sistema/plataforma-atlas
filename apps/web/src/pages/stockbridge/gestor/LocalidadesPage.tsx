import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@atlas/ui';
import { useAuthStore } from '../../../stores/auth.store.js';

type Tipo = 'proprio' | 'tpl' | 'porto_seco' | 'virtual_transito' | 'virtual_ajuste';

interface Localidade {
  id: string;
  codigo: string;
  nome: string;
  tipo: Tipo;
  cnpj: string | null;
  cidade: string | null;
  ativo: boolean;
}

const TIPO_LABEL: Record<Tipo, string> = {
  proprio: 'Proprio',
  tpl: '3PL',
  porto_seco: 'Porto Seco',
  virtual_transito: 'Virtual (Transito)',
  virtual_ajuste: 'Virtual (Ajuste)',
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

const FORMULARIO_VAZIO = { codigo: '', nome: '', tipo: 'proprio' as Tipo, cnpj: '', cidade: '' };

export function LocalidadesPage() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [abrir, setAbrir] = useState(false);
  const [editando, setEditando] = useState<Localidade | null>(null);
  const [form, setForm] = useState(FORMULARIO_VAZIO);

  const { data = [] } = useQuery<Localidade[]>({
    queryKey: ['sb', 'localidades'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/localidades')).data as Localidade[],
  });

  const salvarMut = useMutation({
    mutationFn: async () => {
      const payload = {
        codigo: form.codigo,
        nome: form.nome,
        tipo: form.tipo,
        cnpj: form.cnpj || null,
        cidade: form.cidade || null,
      };
      if (editando) {
        return apiFetch(`/api/v1/stockbridge/localidades/${editando.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      }
      return apiFetch('/api/v1/stockbridge/localidades', { method: 'POST', body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      setAbrir(false);
      setEditando(null);
      setForm(FORMULARIO_VAZIO);
      queryClient.invalidateQueries({ queryKey: ['sb', 'localidades'] });
    },
  });

  const desativarMut = useMutation({
    mutationFn: async (id: string) => apiFetch(`/api/v1/stockbridge/localidades/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sb', 'localidades'] }),
  });

  function abrirNova() {
    setEditando(null);
    setForm(FORMULARIO_VAZIO);
    setAbrir(true);
  }

  function abrirEdicao(l: Localidade) {
    setEditando(l);
    setForm({
      codigo: l.codigo,
      nome: l.nome,
      tipo: l.tipo,
      cnpj: l.cnpj ?? '',
      cidade: l.cidade ?? '',
    });
    setAbrir(true);
  }

  const ehVirtual = form.tipo === 'virtual_transito' || form.tipo === 'virtual_ajuste';

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex justify-between items-start mb-5">
        <div>
          <h1 className="text-2xl font-serif text-atlas-ink mb-1">Localidades</h1>
          <p className="text-sm text-atlas-muted">
            Armazens proprios, 3PLs, portos secos e virtuais (transito/ajuste).
          </p>
        </div>
        <button onClick={abrirNova} className="px-4 py-2 bg-atlas-ink text-white rounded text-sm font-medium">
          + Nova
        </button>
      </div>

      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/40 text-xs text-atlas-muted">
            <tr>
              <th className="text-left px-3 py-2">Codigo</th>
              <th className="text-left px-3 py-2">Nome</th>
              <th className="text-left px-3 py-2">Tipo</th>
              <th className="text-left px-3 py-2">CNPJ</th>
              <th className="text-left px-3 py-2">Cidade</th>
              <th className="text-center px-3 py-2">Status</th>
              <th className="text-right px-3 py-2">Acoes</th>
            </tr>
          </thead>
          <tbody>
            {data.map((l) => (
              <tr key={l.id} className={`border-t border-slate-200 dark:border-slate-700 ${!l.ativo ? 'opacity-60' : ''}`}>
                <td className="px-3 py-2 font-mono text-xs">{l.codigo}</td>
                <td className="px-3 py-2 font-medium">{l.nome}</td>
                <td className="px-3 py-2 text-atlas-muted">{TIPO_LABEL[l.tipo]}</td>
                <td className="px-3 py-2 text-atlas-muted">{l.cnpj ?? '—'}</td>
                <td className="px-3 py-2 text-atlas-muted">{l.cidade ?? '—'}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`text-xs px-2 py-0.5 rounded ${l.ativo ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                    {l.ativo ? 'ativo' : 'inativo'}
                  </span>
                </td>
                <td className="px-3 py-2 text-right space-x-1">
                  <button onClick={() => abrirEdicao(l)} className="px-2 py-1 text-xs border border-slate-300 rounded">Editar</button>
                  {l.ativo && (
                    <button
                      onClick={() => desativarMut.mutate(l.id)}
                      className="px-2 py-1 text-xs border border-red-300 text-red-700 rounded"
                    >
                      Desativar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {abrir && (
        <Modal open title={editando ? `Editar ${editando.nome}` : 'Nova localidade'} onClose={() => setAbrir(false)}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-semibold text-atlas-muted mb-1">Codigo *</label>
                <input
                  value={form.codigo}
                  onChange={(e) => setForm((f) => ({ ...f, codigo: e.target.value }))}
                  placeholder="Ex: 32.1"
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-atlas-muted mb-1">Tipo *</label>
                <select
                  value={form.tipo}
                  onChange={(e) => setForm((f) => ({ ...f, tipo: e.target.value as Tipo, cnpj: (e.target.value as Tipo).startsWith('virtual_') ? '' : f.cnpj }))}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
                >
                  {(Object.keys(TIPO_LABEL) as Tipo[]).map((t) => (
                    <option key={t} value={t}>{TIPO_LABEL[t]}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-atlas-muted mb-1">Nome *</label>
              <input
                value={form.nome}
                onChange={(e) => setForm((f) => ({ ...f, nome: e.target.value }))}
                placeholder="Ex: ARMAZEM SAO PAULO"
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-semibold text-atlas-muted mb-1">
                  CNPJ {ehVirtual && <span className="text-xs text-amber-700">(nao permitido em virtual)</span>}
                </label>
                <input
                  value={form.cnpj}
                  onChange={(e) => setForm((f) => ({ ...f, cnpj: e.target.value }))}
                  disabled={ehVirtual}
                  placeholder={ehVirtual ? '' : 'Acxe Matriz / Q2P Matriz'}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-atlas-muted mb-1">Cidade</label>
                <input
                  value={form.cidade}
                  onChange={(e) => setForm((f) => ({ ...f, cidade: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
                />
              </div>
            </div>
            {salvarMut.isError && (
              <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                {(salvarMut.error as Error).message}
              </div>
            )}
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setAbrir(false)} className="px-4 py-2 border border-slate-300 rounded text-sm">Cancelar</button>
              <button
                onClick={() => salvarMut.mutate()}
                disabled={!form.codigo.trim() || !form.nome.trim() || salvarMut.isPending}
                className={`px-5 py-2 rounded text-sm font-medium ${form.codigo.trim() && form.nome.trim() ? 'bg-atlas-ink text-white' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}
              >
                {salvarMut.isPending ? 'Salvando...' : editando ? 'Salvar' : 'Criar'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
