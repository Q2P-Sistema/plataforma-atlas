import type { ReactNode } from 'react';
import { ThemeToggle } from '../components/ThemeToggle.js';

/**
 * Casca das páginas de autenticação (UI-F, ACXEGDP-266): centraliza o card
 * e posiciona o ThemeToggle no canto — o padrão estava copiado em 6 páginas
 * (Login, Esqueci/Reset senha, 2FA, 2FA setup, 404).
 */
export function AuthPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-atlas-bg p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      {children}
    </div>
  );
}
