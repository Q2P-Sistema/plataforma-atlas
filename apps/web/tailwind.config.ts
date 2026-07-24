import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './src/**/*.{ts,tsx}',
    './index.html',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        atlas: {
          bg: 'var(--atlas-bg)',
          card: 'var(--atlas-card)',
          text: 'var(--atlas-text)',
          ink: 'var(--atlas-text)',
          muted: 'var(--atlas-muted)',
          border: 'var(--atlas-border)',
          accent: '#0077cc',
          'btn-bg': 'var(--atlas-btn-bg)',
          'btn-bg-hover': 'var(--atlas-btn-bg-hover)',
          'btn-text': 'var(--atlas-btn-text)',
        },
        acxe: '#0077cc',
        // DEFAULT preserva bg-q2p etc.; dark é o hover que vivia como hex cru
        // hover:bg-[#158a3b] espalhado (UI-B).
        q2p: { DEFAULT: '#1a9944', dark: '#158a3b' },
        warn: '#d97706',
        crit: '#dc2626',
        ndf: '#7c3aed',
        // Existia em packages/ui/tokens/colors.ts mas nunca foi exposto aqui,
        // forcando hex cru #059669 nos modulos (UI-B).
        success: '#059669',
      },
      fontFamily: {
        sans: ['DM Sans', 'system-ui', 'sans-serif'],
        heading: ['Fraunces', 'Georgia', 'serif'],
        mono: ['Inconsolata', 'IBM Plex Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
