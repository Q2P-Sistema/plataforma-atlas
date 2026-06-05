import { useAuthStore } from '../stores/auth.store.js';

export function DashboardPage() {
  const user = useAuthStore((s) => s.user);

  return (
    <div>
      <h1 className="text-2xl font-heading font-bold text-atlas-text mb-2">
        Bem-vindo{user ? `, ${user.name}` : ''}
      </h1>
      <p className="text-atlas-muted text-sm mb-8">
        Selecione um módulo no menu lateral para começar.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard label="Módulos ativos" value="-" />
        <StatCard label="Último acesso" value={formatDate(user?.last_login_at)} />
        <StatCard label="Perfil" value={capitalize(user?.role)} />
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-atlas-card border border-atlas-border rounded-xl p-5">
      <p className="text-xs text-atlas-muted uppercase tracking-wider mb-1">{label}</p>
      <p className="text-lg font-semibold text-atlas-text">{value}</p>
    </div>
  );
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function capitalize(s: string | undefined): string {
  if (!s) return '-';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
