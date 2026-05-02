import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

interface UserComGalpoes {
  userId: string;
  nome: string;
  email: string;
  role: 'operador' | 'gestor' | 'diretor';
  status: string;
  galpoes: string[];
}

interface GalpaoDisponivel {
  galpao: string;
  localidades: string[];
}

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string>),
    };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    const body = (await res.json()) as { data: unknown; error: { message?: string } | null };
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body;
  };
}

const ROLE_COLOR: Record<string, string> = {
  operador: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  gestor: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  diretor: 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
};

export function UserGalpaoPage() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [editandoUser, setEditandoUser] = useState<UserComGalpoes | null>(null);
  const [galpoesEditando, setGalpoesEditando] = useState<Set<string>>(new Set());
  const [busca, setBusca] = useState('');

  const { data: usuarios = [], isLoading } = useQuery<UserComGalpoes[]>({
    queryKey: ['admin', 'user-galpao'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/admin/user-galpao')).data as UserComGalpoes[],
  });

  const { data: galpoesDisponiveis = [] } = useQuery<GalpaoDisponivel[]>({
    queryKey: ['admin', 'galpoes-disponiveis'],
    queryFn: async () =>
      (await apiFetch('/api/v1/stockbridge/admin/galpoes-disponiveis')).data as GalpaoDisponivel[],
  });

  const salvarMutation = useMutation({
    mutationFn: async ({ userId, galpoes }: { userId: string; galpoes: string[] }) => {
      return apiFetch(`/api/v1/stockbridge/admin/user-galpao/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({ galpoes }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'user-galpao'] });
      setEditandoUser(null);
    },
  });

  function abrirEdicao(user: UserComGalpoes) {
    setEditandoUser(user);
    setGalpoesEditando(new Set(user.galpoes));
  }

  function toggleGalpao(galpao: string) {
    const novo = new Set(galpoesEditando);
    if (novo.has(galpao)) novo.delete(galpao);
    else novo.add(galpao);
    setGalpoesEditando(novo);
  }

  function salvar() {
    if (!editandoUser) return;
    salvarMutation.mutate({
      userId: editandoUser.userId,
      galpoes: Array.from(galpoesEditando).sort(),
    });
  }

  const usuariosFiltrados = usuarios.filter((u) =>
    !busca ||
    u.nome.toLowerCase().includes(busca.toLowerCase()) ||
    u.email.toLowerCase().includes(busca.toLowerCase()),
  );

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Vinculação Usuário × Galpão</h1>
        <p className="text-sm text-atlas-muted">
          Define quais galpões físicos cada usuário acessa em "Meu Estoque". Operador sem galpão vinculado
          recebe 403. Gestor/diretor sem vínculo vê todos.
        </p>
      </div>

      <input
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder="Buscar por nome ou email..."
        className="w-full mb-4 px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
      />

      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-y-auto" style={{ maxHeight: 'calc(100vh - 240px)' }}>
        <div className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-900 border-b-2 border-slate-300 dark:border-slate-600 grid grid-cols-[2.5fr_3fr_1fr_2fr_0.8fr] text-xs text-atlas-muted font-semibold px-3 py-2">
          <div>Nome</div>
          <div>Email</div>
          <div>Perfil</div>
          <div>Galpões</div>
          <div className="text-right">Ações</div>
        </div>

        <div>
          {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando...</div>}
          {!isLoading && usuariosFiltrados.length === 0 && (
            <div className="p-6 text-sm text-atlas-muted text-center italic">Nenhum usuário</div>
          )}
          {usuariosFiltrados.map((u) => (
            <div
              key={u.userId}
              className="grid grid-cols-[2.5fr_3fr_1fr_2fr_0.8fr] text-xs border-b border-slate-100 dark:border-slate-700/60 px-3 py-2 hover:bg-slate-50/60 dark:hover:bg-slate-900/30 items-center"
            >
              <div className="font-medium text-atlas-ink truncate" title={u.nome}>{u.nome}</div>
              <div className="text-atlas-muted truncate" title={u.email}>{u.email}</div>
              <div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${ROLE_COLOR[u.role] ?? 'bg-slate-100 text-slate-700'}`}>
                  {u.role}
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {u.galpoes.length === 0 ? (
                  <span className="text-atlas-muted italic text-[10px]">
                    {u.role === 'operador' ? '⚠ sem galpão' : 'todos'}
                  </span>
                ) : (
                  u.galpoes.map((g) => (
                    <span key={g} className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                      {g}
                    </span>
                  ))
                )}
              </div>
              <div className="text-right">
                <button
                  onClick={() => abrirEdicao(u)}
                  className="text-[10px] px-2 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700"
                >
                  Editar
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {editandoUser && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setEditandoUser(null)}>
          <div className="bg-white dark:bg-slate-800 rounded-lg p-6 max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-serif text-lg text-atlas-ink mb-1">Galpões de {editandoUser.nome}</h2>
            <p className="text-xs text-atlas-muted mb-4">{editandoUser.email} · {editandoUser.role}</p>

            <div className="space-y-2 mb-5">
              {galpoesDisponiveis.length === 0 && (
                <div className="text-xs text-atlas-muted italic">Nenhum galpão cadastrado em stockbridge.localidade</div>
              )}
              {galpoesDisponiveis.map((g) => (
                <label key={g.galpao} className="flex items-start gap-3 p-2 rounded hover:bg-slate-50 dark:hover:bg-slate-900/30 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={galpoesEditando.has(g.galpao)}
                    onChange={() => toggleGalpao(g.galpao)}
                    className="mt-0.5"
                  />
                  <div className="flex-1">
                    <div className="font-mono text-sm text-atlas-ink">{g.galpao}</div>
                    <div className="text-[10px] text-atlas-muted">{g.localidades.join(' · ')}</div>
                  </div>
                </label>
              ))}
            </div>

            {salvarMutation.error && (
              <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                {(salvarMutation.error as Error).message}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setEditandoUser(null)}
                className="px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded hover:bg-slate-100 dark:hover:bg-slate-700"
              >
                Cancelar
              </button>
              <button
                onClick={salvar}
                disabled={salvarMutation.isPending}
                className="px-3 py-1.5 text-sm bg-atlas-btn-bg text-atlas-btn-text rounded hover:opacity-90 disabled:opacity-50"
              >
                {salvarMutation.isPending ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
