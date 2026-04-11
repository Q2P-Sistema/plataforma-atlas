# ADR-0001: Monólito modular em monorepo

**Status:** Aceito
**Data:** 2026-04-11

## Contexto

A Plataforma ACXE+Q2P consolida 7 módulos internos (Hedge Engine, StockBridge, Breaking Point, C-Level, ComexInsight, ComexFlow, Forecast Planner) + 1 CRM externo. O plano original do chefe previa 7 microserviços independentes, cada um com sua porta (conflito de porta em :3006 já era sintoma), x-api-key entre módulos na mesma VPS, polling OMIE multiplicado e fallback gracioso obrigatório quando outro serviço caía.

Todos os módulos operam sobre o mesmo banco Postgres (`dev_acxe_q2p_sanitizado`, 28 tabelas OMIE). Equipe é pequena — Flavio como executor principal, com apoio esporádico de um colega part-time. Domínios são fortemente entrelaçados (o ciclo de trânsito de uma carga atravessa ComexFlow → Hedge → ComexInsight → StockBridge dentro do mesmo processo de negócio).

## Decisão

Construir a plataforma como **monólito modular** em monorepo pnpm + Turborepo, escrito em TypeScript. **NÃO** microserviços.

## Consequências

- Módulos vivem em `modules/*` e só se importam uns aos outros via `index.ts` público. Enforcement via `eslint-plugin-boundaries`.
- Módulos compartilham dados apenas via views no schema `shared` (ver ADR-0002).
- Uma única pasta `packages/db/migrations/` centraliza evolução do schema — sem inferno de ordem entre módulos.
- Um único `apps/api` roda todos os módulos habilitados (ver ADR-0005).
- Se um dia um módulo precisar escalar sozinho, extrai depois. Começar monólito e extrair é fácil. O contrário é brutal.

## Alternativas rejeitadas

**7 microserviços independentes (plano original).** Descartado: o benefício principal de microserviços é isolamento de dados, que é impossível com banco compartilhado. Sobra só o custo: polling duplicado, fallback gracioso entre serviços internos, autenticação cruzada, deploy coordenado. Com equipe pequena e domínios entrelaçados, monólito ganha em todos os eixos.
