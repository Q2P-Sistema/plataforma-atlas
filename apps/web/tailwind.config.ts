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
        q2p: '#1a9944',
        warn: '#d97706',
        crit: '#dc2626',
        ndf: '#7c3aed',
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
