# Research: Hedge Engine

**Feature**: 002-hedge-engine
**Date**: 2026-04-12

## R1: Decimal Arithmetic for Financial Calculations

**Decision**: Use `decimal.js` (already used in legacy `motor.service.js`)
**Rationale**: IEEE 754 float causes rounding errors in currency calculations. `decimal.js` provides arbitrary-precision decimal arithmetic. Legacy already uses it, so formulas port directly.
**Alternatives considered**: `big.js` (simpler but less features), `dinero.js` (currency-specific but opinionated about cents), native `BigInt` (integer-only, requires manual scaling). `decimal.js` wins because legacy already validated with it and it handles all operations needed (multiply, divide, subtract, compare).

## R2: Chart Library for Dashboard

**Decision**: Use `recharts` (React-native, composable, Tailwind-friendly)
**Rationale**: Need donut chart, bar chart, and line chart for the dashboard. `recharts` is the most popular React charting library, works well with Tailwind, and has low bundle size. Legacy used inline SVG/Canvas — not portable.
**Alternatives considered**: `chart.js` + `react-chartjs-2` (heavier, less React-native), `visx` (low-level, more work), `nivo` (beautiful but heavier). `recharts` is the pragmatic choice for 3 chart types.

## R3: PTAX BCB API Integration Pattern

**Decision**: Dedicated service in `packages/integrations/bcb/` with Redis cache (15min TTL), sanity validation (3.00-10.00 range), graceful fallback to last valid quote.
**Rationale**: BCB API is public, rate-limited but sufficient for 1 req/15min. Legacy pattern works well — preserve it. The integration lives in `packages/integrations/bcb/` (not in the hedge module) because Breaking Point and C-Level will also need PTAX.
**Alternatives considered**: Fetch via n8n (violates Principle III — PTAX feeds financial calculations), store in config (stale), use third-party FX API (unnecessary cost, BCB is authoritative for PTAX).

## R4: NDF State Machine Implementation

**Decision**: State transitions enforced in TypeScript service with explicit transition map. Database stores current state; service validates transitions before persisting.
**Rationale**: NDF lifecycle (pendente → ativo → liquidado/cancelado) is simple enough for a transition map in code. No need for a state machine library.
**Alternatives considered**: `xstate` (overkill for 4 states), database constraints (can't express valid transitions in CHECK), trigger-based (violates Principle III).

## R5: Hedge Schema Design

**Decision**: All Hedge tables in `hedge.*` schema. 10 tables ported from legacy schema.sql with UUID PKs (matching Atlas convention), plus audit log triggers.
**Rationale**: Constitution Principle I requires module-specific schemas. Legacy already has a clean 10-table design that works — port it with minimal changes (add UUIDs, timestamps, soft-delete where appropriate).
**Alternatives considered**: Merge some tables (loses clarity), add more normalization (over-engineering for the data volume).

## R6: OMIE Data Access Pattern

**Decision**: Hedge reads from existing `public.tbl_*` tables (synced by n8n). No new OMIE sync logic in Hedge. Hedge's `titulos_pagar` table is populated by a scheduled position calculation that reads from OMIE tables and aggregates into buckets.
**Rationale**: Constitution Principle II — Atlas reads from Postgres, never from OMIE API. The n8n sync pipeline is already in production. Hedge just queries the synced data.
**Alternatives considered**: Direct OMIE API calls (violates Principle II), duplicate sync in Hedge (duplicates n8n work).

## R7: Cross-Module Data Sharing

**Decision**: Hedge exposes `shared.vw_hedge_posicao` view for C-Level and Breaking Point consumption. View contains: data_ref, exposure_usd, ndf_ativo_usd, gap_usd, cobertura_pct, ptax_ref.
**Rationale**: Constitution Principle I — cross-module data only via `shared` schema views. C-Level needs FX position for DRE sensitivity; Breaking Point needs NDF exposure for 26-week liquidity projection.
**Alternatives considered**: Direct table access (violates Principle I), API endpoint (adds latency, couples modules at runtime).

## R8: Motor MV Calculation — Frontend vs Backend

**Decision**: Motor MV calculation runs on the backend (API endpoint). Frontend sends parameters (lambda, cambio_simulado), backend returns calculated layers + recommendations. Frontend renders results.
**Rationale**: Constitution Principle III — financial calculations in TypeScript on the server. The motor involves decimal arithmetic, multiple table joins, and business rules that must be tested. Real-time recalc (< 500ms) is achievable server-side for the data volume involved (~12 buckets).
**Alternatives considered**: Client-side calculation (violates Principle III, can't test server-side, exposes business logic), hybrid (complexity without benefit).
