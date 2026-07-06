import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@atlas/ui';
import { useAuthStore } from '../../../stores/auth.store.js';
import { ROLE_LABEL, rotulo } from '../labels.js';

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

  function toggleGalpao(galpao: string, marcar: boolean) {
    setGalpoesEditando((prev) => {
      const novo = new Set(prev);
      if (marcar) novo.add(galpao);
      else novo.delete(galpao);
      return novo;
    });
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
        className="w-full mb-4 px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm"
      />

      <div className="bg-atlas-card border border-atlas-border rounded-lg overflow-y-auto" style={{ maxHeight: 'calc(100vh - 240px)' }}>
        <div className="sticky top-0 z-10 bg-atlas-bg border-b-2 border-atlas-border grid grid-cols-[2.5fr_3fr_1fr_2fr_0.8fr] text-xs text-atlas-muted font-semibold px-3 py-2">
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
              className="grid grid-cols-[2.5fr_3fr_1fr_2fr_0.8fr] text-xs border-b border-atlas-border/60 px-3 py-2 hover:bg-atlas-bg/60 items-center"
            >
              <div className="font-medium text-atlas-ink truncate" title={u.nome}>{u.nome}</div>
              <div className="text-atlas-muted truncate" title={u.email}>{u.email}</div>
              <div>
                <Badge variant={(u.role === 'gestor' || u.role === 'diretor' ? u.role : 'operador')}>
                  {rotulo(ROLE_LABEL, u.role)}
                </Badge>
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
                  className="text-[10px] px-2 py-1 rounded border border-atlas-border hover:bg-atlas-bg/60"
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
          <div className="bg-atlas-card rounded-lg p-6 max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-serif text-lg text-atlas-ink mb-1">Galpões de {editandoUser.nome}</h2>
            <p className="text-xs text-atlas-muted mb-4">{editandoUser.email} · {rotulo(ROLE_LABEL, editandoUser.role)}</p>

            <div className="space-y-2 mb-5">
              {galpoesDisponiveis.length === 0 && (
                <div className="text-xs text-atlas-muted italic">Nenhum galpão cadastrado em stockbridge.localidade</div>
              )}
              {galpoesDisponiveis.map((g) => {
                const checked = galpoesEditando.has(g.galpao);
                return (
                  <label
                    key={g.galpao}
                    className="flex items-start gap-3 p-2 rounded hover:bg-atlas-bg/60 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => toggleGalpao(g.galpao, e.target.checked)}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <div className="font-mono text-sm text-atlas-ink">{g.galpao}</div>
                      <div className="text-[10px] text-atlas-muted">{g.localidades.join(' · ')}</div>
                    </div>
                  </label>
                );
              })}
            </div>

            {salvarMutation.error && (
              <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                {(salvarMutation.error as Error).message}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setEditandoUser(null)}
                className="px-3 py-1.5 text-sm border border-atlas-border rounded hover:bg-atlas-bg/60"
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
