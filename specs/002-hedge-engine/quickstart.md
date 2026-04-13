# Quickstart: Hedge Engine

**Feature**: 002-hedge-engine
**Date**: 2026-04-12

## Pre-requisitos

- Atlas infraestrutura base rodando (spec 001 completa)
- Banco Postgres com schemas `atlas` e `shared` criados
- Tabelas OMIE sincronizadas pelo n8n (`public.tbl_*`)
- `MODULE_HEDGE_ENABLED=true` no .env

## Setup

### 1. Habilitar modulo

```bash
# No .env (raiz ou Portainer)
MODULE_HEDGE_ENABLED=true
```

### 2. Rodar migration do Hedge

```bash
pnpm --filter @atlas/db migrate
```

Cria schema `hedge` com 10 tabelas + triggers de audit log + view `shared.vw_hedge_posicao`.

### 3. Seed de dados iniciais

```bash
# Config default do motor (lambda, thresholds, localidades)
# Executado automaticamente na primeira inicializacao do modulo
```

### 4. Reiniciar API

```bash
pnpm dev
```

Modulo Hedge aparece na sidebar como ativo.

## Verificacao

1. Abrir `http://localhost:5173/hedge` → Dashboard de posicao
2. Ver KPIs (valores podem ser 0 se nao ha titulos a pagar)
3. Acessar `http://localhost:3005/api/v1/hedge/ptax` → PTAX atual do BCB
4. Acessar `http://localhost:3005/api/v1/hedge/posicao` → Posicao consolidada

## Fluxo de teste completo

1. Verificar PTAX carrega do BCB
2. Criar NDF de teste: POST /api/v1/hedge/ndfs
3. Ativar NDF: PATCH /api/v1/hedge/ndfs/:id/ativar
4. Ver cobertura atualizar no dashboard
5. Abrir Motor MV, mover lambda, ver recomendacoes
6. Aprovar recomendacao → NDF pendente criado
7. Liquidar NDF com PTAX → resultado calculado
8. Verificar audit log: GET /api/v1/admin/audit-log?schema=hedge

## Integracao com outros modulos

- **C-Level**: consulta `shared.vw_hedge_posicao` para FX sensitivity no DRE
- **Breaking Point**: consulta `shared.vw_hedge_posicao` para projecao de liquidez BRL
- **ComexFlow**: futuramente alimenta localidade virtual de carga em transito
