import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import boundaries from 'eslint-plugin-boundaries';

export default [
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      boundaries,
    },
    settings: {
      'boundaries/elements': [
        { type: 'package', pattern: 'packages/*' },
        { type: 'package', pattern: 'packages/integrations/*' },
        { type: 'module', pattern: 'modules/*' },
        { type: 'app', pattern: 'apps/*' },
        { type: 'integration', pattern: 'integrations/*' },
      ],
      'boundaries/include': ['packages/**/*', 'modules/**/*', 'apps/**/*', 'integrations/**/*'],
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // Fronteiras do mon\u00f3lito modular:
      // - packages s\u00e3o reutiliz\u00e1veis, sem estado, sem regra de dom\u00ednio
      // - modules cont\u00eam regra de dom\u00ednio, s\u00f3 podem importar de packages e (via index) de outros modules
      // - apps montam tudo; podem importar de qualquer coisa
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'package', allow: ['package'] },
            { from: 'module', allow: ['package', 'module'] },
            { from: 'app', allow: ['package', 'module', 'integration'] },
            { from: 'integration', allow: ['package'] },
          ],
        },
      ],
      // TODO: adicionar regra extra pra bloquear import de caminhos internos
      // (ex: modules/hedge/src/internal/*) a partir de outro module. Por enquanto
      // enforcement \u00e9 via conven\u00e7\u00e3o + review. Avaliar boundaries/no-private ou
      // import/no-internal-modules quando a base crescer.
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**'],
  },
];
