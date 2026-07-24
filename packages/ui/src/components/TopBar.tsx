import { LogOut } from 'lucide-react';
import { Badge } from './Badge.js';
import { ThemeToggle } from './ThemeToggle.js';

interface TopBarProps {
  userName: string;
  userRole: string;
  onLogout: () => void;
  centerSlot?: React.ReactNode;
}

const ROLE_LABELS: Record<string, string> = {
  operador: 'Operador',
  gestor: 'Gestor',
  diretor: 'Diretor',
};


export function TopBar({ userName, userRole, onLogout, centerSlot }: TopBarProps) {
  return (
    <header className="h-16 bg-atlas-card border-b border-atlas-border flex items-center justify-between px-6">
      <div className="flex-1">{centerSlot}</div>

      <div className="flex items-center gap-4">
        <ThemeToggle />

        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-sm font-medium text-atlas-text">{userName}</p>
            <Badge variant={(['operador', 'gestor', 'diretor'].includes(userRole) ? userRole : 'operador') as 'operador' | 'gestor' | 'diretor'}>
              {ROLE_LABELS[userRole] ?? userRole}
            </Badge>
          </div>

          <button
            onClick={onLogout}
            className="p-2 rounded-lg hover:bg-atlas-border focus:outline-none focus:ring-2 focus:ring-acxe transition-colors text-atlas-muted hover:text-crit"
            title="Sair"
            aria-label="Sair"
          >
            <LogOut size={18} />
          </button>
        </div>
      </div>
    </header>
  );
}
