import { useEffect, useState } from 'react';
import { Moon, Monitor, Sun, type LucideIcon } from 'lucide-react';

type Theme = 'light' | 'dark' | 'system';

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function applyTheme(theme: Theme): void {
  const resolved = theme === 'system' ? getSystemTheme() : theme;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

// Ícone lucide + label pt-BR visível (UI-F, ACXEGDP-266) — antes eram emojis
// ☀️/🌙/💻 e o estado só aparecia no title/aria-label (baixa affordance:
// usuário não percebia "escuro fixo" vs "seguindo o sistema").
const THEME_META: Record<Theme, { icon: LucideIcon; label: string }> = {
  light: { icon: Sun, label: 'Claro' },
  dark: { icon: Moon, label: 'Escuro' },
  system: { icon: Monitor, label: 'Sistema' },
};

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'system';
    return (localStorage.getItem('atlas-theme') as Theme) ?? 'system';
  });

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem('atlas-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const next: Record<Theme, Theme> = {
    light: 'dark',
    dark: 'system',
    system: 'light',
  };

  const { icon: Icon, label } = THEME_META[theme];

  return (
    <button
      onClick={() => setTheme(next[theme])}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-atlas-border text-atlas-muted hover:text-atlas-text hover:bg-atlas-border/50 transition-colors text-xs font-medium focus:outline-none focus:ring-2 focus:ring-acxe"
      title={`Tema: ${label} — clique para alternar`}
      aria-label={`Mudar tema (atual: ${label})`}
    >
      <Icon size={16} aria-hidden />
      <span>{label}</span>
    </button>
  );
}
