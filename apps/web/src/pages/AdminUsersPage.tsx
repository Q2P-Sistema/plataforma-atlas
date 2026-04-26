import { useState, type FormEvent, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DataTable, Modal, type Column } from '@atlas/ui';
import { UserPlus, Edit2, UserX, UserCheck, KeyRound, ShieldOff } from 'lucide-react';
import { useAuthStore } from '../stores/auth.store.js';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  totp_enabled: boolean;
  last_login_at: string | null;
  created_at: string;
}

const ROLE_LABELS: Record<string, string> = {
  operador: 'Operador',
  gestor: 'Gestor',
  diretor: 'Diretor',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Ativo',
  inactive: 'Inativo',
};

function useAdminFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);

  return async (url: string, options: RequestInit = {}) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;

    const res = await fetch(url, {
      credentials: 'include',
      ...options,
      headers,
    });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body;
  };
}

export function AdminUsersPage() {
  const queryClient = useQueryClient();
  const adminFetch = useAdminFetch();

  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: 'deactivate' | 'reactivate' | 'reset-password' | 'reset-2fa';
    user: AdminUser;
  } | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formRole, setFormRole] = useState('operador');
  const [formError, setFormError] = useState('');

  const { data: users = [], isLoading } = useQuery<AdminUser[]>({
    queryKey: ['admin', 'users'],
    queryFn: async () => {
      const body = await adminFetch('/api/v1/admin/users');
      return body.data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; email: string; role: string }) => {
      return adminFetch('/api/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    onSuccess: (body) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      setCreateOpen(false);
      setTempPassword(body.data.temporaryPassword);
      resetForm();
    },
    onError: (err: Error) => setFormError(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, fields }: { id: string; fields: Record<string, string> }) => {
      return adminFetch(`/api/v1/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(fields),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      setEditUser(null);
      resetForm();
    },
    onError: (err: Error) => setFormError(err.message),
  });

  const actionMutation = useMutation({
    mutationFn: async ({ id, type }: { id: string; type: string }) => {
      if (type === 'reset-password' || type === 'reset-2fa') {
        return adminFetch(`/api/v1/admin/users/${id}/${type}`, { method: 'POST' });
      }
      return adminFetch(`/api/v1/admin/users/${id}/${type}`, { method: 'PATCH' });
    },
    onSuccess: (body, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      if (variables.type === 'reset-password') {
        setTempPassword(body.data.temporaryPassword);
      }
      setConfirmAction(null);
    },
  });

  function resetForm() {
    setFormName('');
    setFormEmail('');
    setFormRole('operador');
    setFormError('');
  }

  function openEdit(user: AdminUser) {
    setFormName(user.name);
    setFormRole(user.role);
    setFormError('');
    setEditUser(user);
  }

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    createMutation.mutate({ name: formName, email: formEmail, role: formRole });
  }

  function handleUpdate(e: FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    const fields: Record<string, string> = {};
    if (formName !== editUser.name) fields.name = formName;
    if (formRole !== editUser.role) fields.role = formRole;
    if (Object.keys(fields).length === 0) {
      setEditUser(null);
      return;
    }
    updateMutation.mutate({ id: editUser.id, fields });
  }

  const columns: Column<AdminUser>[] = [
    { key: 'name', header: 'Nome', sortable: true },
    { key: 'email', header: 'E-mail', sortable: true },
    {
      key: 'role',
      header: 'Perfil',
      sortable: true,
      render: (row) => (
        <span className="text-xs px-2 py-0.5 rounded-full bg-atlas-bg border border-atlas-border">
          {ROLE_LABELS[row.role] ?? row.role}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${
            row.status === 'active'
              ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
              : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
          }`}
        >
          {STATUS_LABELS[row.status] ?? row.status}
        </span>
      ),
    },
    {
      key: 'totp_enabled',
      header: '2FA',
      render: (row) => (row.totp_enabled ? 'Sim' : 'Não'),
    },
    {
      key: 'last_login_at',
      header: 'Último acesso',
      sortable: true,
      render: (row) =>
        row.last_login_at
          ? new Date(row.last_login_at).toLocaleDateString('pt-BR', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '-',
    },
  ];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-atlas-muted">Carregando...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-heading font-bold text-atlas-text">Usuários</h1>
        <button
          onClick={() => {
            resetForm();
            setCreateOpen(true);
          }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-acxe text-white text-sm font-medium hover:bg-acxe/90 transition-colors"
        >
          <UserPlus size={16} />
          Novo usuário
        </button>
      </div>

      <DataTable
        columns={columns}
        data={users}
        rowKey={(row) => row.id}
        actions={(row) => (
          <>
            <button
              onClick={() => openEdit(row)}
              className="p-1.5 rounded hover:bg-atlas-border focus:outline-none focus:ring-2 focus:ring-acxe transition-colors text-atlas-muted"
              title="Editar"
              aria-label={`Editar ${row.name}`}
            >
              <Edit2 size={14} />
            </button>
            {row.status === 'active' ? (
              <button
                onClick={() => setConfirmAction({ type: 'deactivate', user: row })}
                className="p-1.5 rounded hover:bg-atlas-border focus:outline-none focus:ring-2 focus:ring-acxe transition-colors text-atlas-muted hover:text-crit"
                title="Desativar"
                aria-label={`Desativar ${row.name}`}
              >
                <UserX size={14} />
              </button>
            ) : (
              <button
                onClick={() => setConfirmAction({ type: 'reactivate', user: row })}
                className="p-1.5 rounded hover:bg-atlas-border focus:outline-none focus:ring-2 focus:ring-acxe transition-colors text-atlas-muted hover:text-green-600"
                title="Reativar"
                aria-label={`Reativar ${row.name}`}
              >
                <UserCheck size={14} />
              </button>
            )}
            <button
              onClick={() => setConfirmAction({ type: 'reset-password', user: row })}
              className="p-1.5 rounded hover:bg-atlas-border focus:outline-none focus:ring-2 focus:ring-acxe transition-colors text-atlas-muted"
              title="Resetar senha"
              aria-label={`Resetar senha de ${row.name}`}
            >
              <KeyRound size={14} />
            </button>
            {row.totp_enabled && (
              <button
                onClick={() => setConfirmAction({ type: 'reset-2fa', user: row })}
                className="p-1.5 rounded hover:bg-atlas-border focus:outline-none focus:ring-2 focus:ring-acxe transition-colors text-atlas-muted hover:text-warn"
                title="Resetar 2FA"
                aria-label={`Resetar 2FA de ${row.name}`}
              >
                <ShieldOff size={14} />
              </button>
            )}
          </>
        )}
      />

      {/* Create Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Novo usuário"
        footer={
          <>
            <button
              onClick={() => setCreateOpen(false)}
              className="px-4 py-2 rounded-lg border border-atlas-border text-atlas-text text-sm hover:bg-atlas-border/50 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={() =>
                createMutation.mutate({ name: formName, email: formEmail, role: formRole })
              }
              disabled={createMutation.isPending || !formName || !formEmail}
              className="px-4 py-2 rounded-lg bg-acxe text-white text-sm font-medium hover:bg-acxe/90 disabled:opacity-50 transition-colors"
            >
              {createMutation.isPending ? 'Criando...' : 'Criar'}
            </button>
          </>
        }
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label htmlFor="create-name" className="block text-sm font-medium text-atlas-text mb-1">Nome</label>
            <input
              id="create-name"
              type="text"
              required
              value={formName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text focus:outline-none focus:ring-2 focus:ring-acxe"
            />
          </div>
          <div>
            <label htmlFor="create-email" className="block text-sm font-medium text-atlas-text mb-1">E-mail</label>
            <input
              id="create-email"
              type="email"
              required
              value={formEmail}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text focus:outline-none focus:ring-2 focus:ring-acxe"
            />
          </div>
          <div>
            <label htmlFor="create-role" className="block text-sm font-medium text-atlas-text mb-1">Perfil</label>
            <select
              id="create-role"
              value={formRole}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormRole(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text focus:outline-none focus:ring-2 focus:ring-acxe"
            >
              <option value="operador">Operador</option>
              <option value="gestor">Gestor</option>
              <option value="diretor">Diretor</option>
            </select>
          </div>
          {formError && (
            <div className="text-sm text-crit bg-crit/10 border border-crit/20 rounded-lg px-3 py-2">
              {formError}
            </div>
          )}
        </form>
      </Modal>

      {/* Edit Modal */}
      <Modal
        open={!!editUser}
        onClose={() => setEditUser(null)}
        title="Editar usuário"
        footer={
          <>
            <button
              onClick={() => setEditUser(null)}
              className="px-4 py-2 rounded-lg border border-atlas-border text-atlas-text text-sm hover:bg-atlas-border/50 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={() => {
                if (!editUser) return;
                const fields: Record<string, string> = {};
                if (formName !== editUser.name) fields.name = formName;
                if (formRole !== editUser.role) fields.role = formRole;
                if (Object.keys(fields).length === 0) {
                  setEditUser(null);
                  return;
                }
                updateMutation.mutate({ id: editUser.id, fields });
              }}
              disabled={updateMutation.isPending}
              className="px-4 py-2 rounded-lg bg-acxe text-white text-sm font-medium hover:bg-acxe/90 disabled:opacity-50 transition-colors"
            >
              {updateMutation.isPending ? 'Salvando...' : 'Salvar'}
            </button>
          </>
        }
      >
        <form onSubmit={handleUpdate} className="space-y-4">
          <div>
            <label htmlFor="edit-name" className="block text-sm font-medium text-atlas-text mb-1">Nome</label>
            <input
              id="edit-name"
              type="text"
              required
              value={formName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text focus:outline-none focus:ring-2 focus:ring-acxe"
            />
          </div>
          <div>
            <label htmlFor="edit-role" className="block text-sm font-medium text-atlas-text mb-1">Perfil</label>
            <select
              id="edit-role"
              value={formRole}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormRole(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text focus:outline-none focus:ring-2 focus:ring-acxe"
            >
              <option value="operador">Operador</option>
              <option value="gestor">Gestor</option>
              <option value="diretor">Diretor</option>
            </select>
          </div>
          {formError && (
            <div className="text-sm text-crit bg-crit/10 border border-crit/20 rounded-lg px-3 py-2">
              {formError}
            </div>
          )}
        </form>
      </Modal>

      {/* Confirm Action Modal */}
      <Modal
        open={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        title={
          confirmAction?.type === 'deactivate'
            ? 'Desativar usuário'
            : confirmAction?.type === 'reactivate'
              ? 'Reativar usuário'
              : confirmAction?.type === 'reset-2fa'
                ? 'Resetar 2FA'
                : 'Resetar senha'
        }
        footer={
          <>
            <button
              onClick={() => setConfirmAction(null)}
              className="px-4 py-2 rounded-lg border border-atlas-border text-atlas-text text-sm hover:bg-atlas-border/50 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={() => {
                if (!confirmAction) return;
                actionMutation.mutate({
                  id: confirmAction.user.id,
                  type: confirmAction.type,
                });
              }}
              disabled={actionMutation.isPending}
              className={`px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50 transition-colors ${
                confirmAction?.type === 'deactivate'
                  ? 'bg-crit hover:bg-crit/90'
                  : 'bg-acxe hover:bg-acxe/90'
              }`}
            >
              {actionMutation.isPending ? 'Processando...' : 'Confirmar'}
            </button>
          </>
        }
      >
        <p className="text-sm text-atlas-text">
          {confirmAction?.type === 'deactivate' && (
            <>
              Desativar <strong>{confirmAction.user.name}</strong>? Todas as sessões
              ativas serão encerradas.
            </>
          )}
          {confirmAction?.type === 'reactivate' && (
            <>
              Reativar <strong>{confirmAction?.user.name}</strong>?
            </>
          )}
          {confirmAction?.type === 'reset-password' && (
            <>
              Resetar a senha de <strong>{confirmAction?.user.name}</strong>? Uma senha
              temporária será gerada.
            </>
          )}
          {confirmAction?.type === 'reset-2fa' && (
            <>
              Resetar o 2FA de <strong>{confirmAction?.user.name}</strong>? O usuário
              terá que reconfigurar o autenticador no próximo login.
            </>
          )}
        </p>
      </Modal>

      {/* Temporary Password Modal */}
      <Modal
        open={!!tempPassword}
        onClose={() => setTempPassword(null)}
        title="Senha temporária"
        footer={
          <button
            onClick={() => setTempPassword(null)}
            className="px-4 py-2 rounded-lg bg-acxe text-white text-sm font-medium hover:bg-acxe/90 transition-colors"
          >
            Fechar
          </button>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-atlas-text">
            Anote a senha temporária. Ela não será exibida novamente.
          </p>
          <div className="bg-atlas-bg rounded-lg p-3 border border-atlas-border">
            <code className="text-lg font-mono text-atlas-text select-all">
              {tempPassword}
            </code>
          </div>
        </div>
      </Modal>
    </div>
  );
}
