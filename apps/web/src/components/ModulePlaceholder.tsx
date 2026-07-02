import type { LucideIcon } from 'lucide-react';
import { Construction } from 'lucide-react';

interface ModulePlaceholderProps {
  name: string;
  icon?: LucideIcon;
}

export function ModulePlaceholder({ name, icon: Icon = Construction }: ModulePlaceholderProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="p-6 rounded-2xl bg-atlas-card border border-atlas-border shadow-sm">
        <Icon size={48} className="text-atlas-muted mx-auto mb-4" />
        <h2 className="text-xl font-heading font-semibold text-atlas-text mb-2">
          {name}
        </h2>
        <p className="text-atlas-muted text-sm max-w-xs">
          Módulo em implementação. Em breve estará disponível.
        </p>
      </div>
    </div>
  );
}
