# plataforma-atlas Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-04-16

## Active Technologies
- TypeScript 5.5+ (strict mode) / Node.js 20 LTS + Express 4 (API), React 18 + Vite (frontend), Drizzle ORM (queries), decimal.js (aritmetica financeira), recharts (graficos), Zod (validacao) (002-hedge-engine)
- PostgreSQL 16, schema `hedge.*` (10 tabelas), Redis 8 (cache PTAX 15min) (002-hedge-engine)
- TypeScript 5.5+ (strict mode) / Node.js 20 LTS + Express 4 (API), React 18 + Vite (frontend), Drizzle ORM (queries forecast schema), raw SQL via getPool() (leitura tabelas OMIE public.*), recharts (graficos), Zod (validacao) (003-forecast-planner)
- PostgreSQL 16 — leitura de tabelas OMIE em public.*, escrita em schema forecast.* (config, sazonalidade) (003-forecast-planner)
- PostgreSQL 16, schema `hedge.*` (6 tabelas), Redis 8 (cache PTAX 15min — expandir para posicao/estoque) (004-hedge-gaps-closure)
- TypeScript 5.5+ (strict mode) / Node.js 20 LTS + Express 4 (API), React 18 + Vite (frontend), Drizzle ORM + raw SQL via getPool(), recharts (graficos/sparklines), Zod (validacao) (005-forecast-advanced-features)
- PostgreSQL 16 — leitura de tabelas OMIE em public.* (tbl_movimentacaoEstoqueHistorico_Q2P, tbl_dadosPlanilhaFUPComex, tbl_cadastroFornecedoresClientes_ACXE) (005-forecast-advanced-features)
- TypeScript 5.5+ strict, Node.js 20 LTS + Express 4 (API), React 18 + Vite (frontend), Drizzle ORM (schema + migrations), raw SQL via getPool() (queries OMIE), Recharts (gráficos), Zod (validação), shadcn/ui + Tailwind (UI) (006-breaking-point-module)
- PostgreSQL 16 — leitura em `public.*` (tabelas OMIE), escrita em `breakingpoint.*` (config manual) (006-breaking-point-module)
- TypeScript 5.5+ strict, Node.js 20 LTS + Express 4 (API), React 18 + Vite (frontend), Drizzle ORM (schema + migrations), raw SQL via getPool() (queries OMIE), mysql2 (migracao one-shot do legado), axios (cliente OMIE), decimal.js (aritmetica financeira), Recharts (graficos), Zod (validacao), shadcn/ui + Tailwind (UI) (007-stockbridge-module)
- PostgreSQL 16 — leitura em `public.*` (tabelas OMIE sincronizadas), escrita em `stockbridge.*` (schema proprio do modulo); MySQL legado acessado apenas no script one-shot de migracao (007-stockbridge-module)

- TypeScript 5.5+ (strict mode, ES2022, bundler resolution) / Node.js 20 LTS + Express 4.x (backend), React 18 (frontend), Vite 5 (build), Drizzle ORM (query builder + migrations), shadcn/ui + Tailwind CSS (design system), Zustand (client state), TanStack Query (server state), Zod (validação runtime), Pino (logs estruturados), argon2 (hash senhas), otplib (TOTP 2FA) (001-atlas-infra-base)

## Project Structure

```text
backend/
frontend/
tests/
```

## Commands

npm test && npm run lint

## Code Style

TypeScript 5.5+ (strict mode, ES2022, bundler resolution) / Node.js 20 LTS: Follow standard conventions

## Recent Changes
- 007-stockbridge-module: Added TypeScript 5.5+ strict, Node.js 20 LTS + Express 4 (API), React 18 + Vite (frontend), Drizzle ORM (schema + migrations), raw SQL via getPool() (queries OMIE), mysql2 (migracao one-shot do legado), axios (cliente OMIE), decimal.js (aritmetica financeira), Recharts (graficos), Zod (validacao), shadcn/ui + Tailwind (UI)
- 006-breaking-point-module: Added TypeScript 5.5+ strict, Node.js 20 LTS + Express 4 (API), React 18 + Vite (frontend), Drizzle ORM (schema + migrations), raw SQL via getPool() (queries OMIE), Recharts (gráficos), Zod (validação), shadcn/ui + Tailwind (UI)
- 005-forecast-advanced-features: Added TypeScript 5.5+ (strict mode) / Node.js 20 LTS + Express 4 (API), React 18 + Vite (frontend), Drizzle ORM + raw SQL via getPool(), recharts (graficos/sparklines), Zod (validacao)


<!-- MANUAL ADDITIONS START -->

## StockBridge — status operacional (007)

- **Modulo funcionalmente completo** (8/8 user stories + movimentacoes). Ainda nao esta em producao — aguarda **validacao paralela** de 2 semanas com o legado PHP (Principio V).
- **Feature flag**: `MODULE_STOCKBRIDGE_ENABLED`. Em prod deve subir em `false` ate paridade confirmada.
- **OMIE em modo real exige**: `OMIE_ACXE_KEY/SECRET`, `OMIE_Q2P_KEY/SECRET`. Em dev, `OMIE_MODE=mock` retorna fixtures sinteticas (nao bate na API).
- **Saidas automaticas via n8n**: requer `ATLAS_INTEGRATION_KEY` (shared secret com o workflow) + workflow importado de `workflows/stockbridge-saida-automatica.json`.
- **Excecao documentada ao Principio II**: escrita na API OMIE (`estoque/ajuste/`, `produtos/pedidocompra/`) e leitura de NF individual (`produtos/nfconsultar/`). Justificativa em `specs/007-stockbridge-module/research.md` secao 2 — unica alternativa viavel porque OMIE nao tem webhook de saida.
- **Correlacao ACXE↔Q2P por match textual de descricao**: mantido do legado (clarificacao Q6). Produto sem correlato Q2P bloqueia recebimento + dispara email admin.
- **Migracao MySQL → PG**: script em `modules/stockbridge/src/scripts/migrate-from-mysql.ts` (ainda nao escrito — Phase 12). Executar apenas no dia do cutover; dep `mysql2` instala on-demand via `pnpm add -D mysql2 --filter @atlas/stockbridge`.
- **Auditoria**: 8 triggers dedicados em `stockbridge.*` gravando em `shared.audit_log` (Principio IV). Soft delete em `movimentacao.ativo=false` preserva historico — nao ha hard delete.

<!-- MANUAL ADDITIONS END -->
