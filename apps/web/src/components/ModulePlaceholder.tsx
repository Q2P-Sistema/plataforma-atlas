import type { LucideIcon } from 'lucide-react';
import { Construction, Lock } from 'lucide-react';

interface ModulePlaceholderProps {
  name: string;
  icon?: LucideIcon;
  /**
   * 'em_breve' (default): módulo habilitado, telas em implementação.
   * 'indisponivel': módulo desativado ou fora do perfil do usuário — o backend
   * expõe um único boolean (/auth/modules), então a mensagem cobre os dois
   * motivos honestamente (UI-C, ACXEGDP-263).
   */
  variante?: 'em_breve' | 'indisponivel';
}

export function ModulePlaceholder({ name, icon, variante = 'em_breve' }: ModulePlaceholderProps) {
  const Icon = icon ?? (variante === 'indisponivel' ? Lock : Construction);
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="p-6 rounded-2xl bg-atlas-card border border-atlas-border shadow-sm">
        <Icon size={48} className="text-atlas-muted mx-auto mb-4" />
        <h2 className="text-xl font-heading font-semibold text-atlas-text mb-2">
          {name}
        </h2>
        <p className="text-atlas-muted text-sm max-w-xs">
          {variante === 'indisponivel'
            ? 'Este módulo não está disponível para o seu perfil ou ainda não foi ativado. Se você acredita que deveria ter acesso, fale com o administrador do sistema.'
            : 'Módulo em implementação. Em breve estará disponível.'}
        </p>
      </div>
    </div>
  );
}
