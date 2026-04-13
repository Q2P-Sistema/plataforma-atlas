# plataforma-master Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-04-12

## Active Technologies
- TypeScript 5.5+ (strict mode) / Node.js 20 LTS + Express 4 (API), React 18 + Vite (frontend), Drizzle ORM (queries), decimal.js (aritmetica financeira), recharts (graficos), Zod (validacao) (002-hedge-engine)
- PostgreSQL 16, schema `hedge.*` (10 tabelas), Redis 8 (cache PTAX 15min) (002-hedge-engine)

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
- 002-hedge-engine: Added TypeScript 5.5+ (strict mode) / Node.js 20 LTS + Express 4 (API), React 18 + Vite (frontend), Drizzle ORM (queries), decimal.js (aritmetica financeira), recharts (graficos), Zod (validacao)

- 001-atlas-infra-base: Added TypeScript 5.5+ (strict mode, ES2022, bundler resolution) / Node.js 20 LTS + Express 4.x (backend), React 18 (frontend), Vite 5 (build), Drizzle ORM (query builder + migrations), shadcn/ui + Tailwind CSS (design system), Zustand (client state), TanStack Query (server state), Zod (validação runtime), Pino (logs estruturados), argon2 (hash senhas), otplib (TOTP 2FA)

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
