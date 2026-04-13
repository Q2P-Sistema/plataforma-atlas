# Data Model: Hedge Engine

**Feature**: 002-hedge-engine
**Schema**: `hedge`

## Entity Relationship Overview

```
titulos_pagar (OMIE sync) ──┐
                             ├── bucket_mensal ──── posicao_snapshot
ndf_registro ────────────────┘        │
                                      │
ndf_taxas ──── (usado no calculo) ────┘
ptax_historico ── (referencia global)
estoque_snapshot ── (por localidade)
alerta ── (gerado por calculo)
config_motor ── (parametros)
sync_log ── (auditoria de sync)
```

## Entities

### hedge.bucket_mensal

Agregacao de exposicao USD por mes-calendario.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK, default random | |
| mes_ref | DATE | NOT NULL, unique per empresa | Primeiro dia do mes |
| empresa | VARCHAR(10) | NOT NULL, CHECK (acxe, q2p) | |
| pagar_usd | NUMERIC(15,2) | NOT NULL, default 0 | Total titulos a pagar USD |
| ndf_usd | NUMERIC(15,2) | NOT NULL, default 0 | Total NDF ativo cobrindo este bucket |
| cobertura_pct | NUMERIC(5,2) | NOT NULL, default 0 | ndf_usd / pagar_usd * 100 |
| status | VARCHAR(20) | NOT NULL | ok / sub_hedged / over_hedged |
| created_at | TIMESTAMPTZ | NOT NULL, default now() | |
| updated_at | TIMESTAMPTZ | NOT NULL, default now() | |

### hedge.ndf_registro

Contrato NDF/Trava/ACC individual.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK, default random | |
| tipo | VARCHAR(10) | NOT NULL, CHECK (ndf, trava, acc) | Tipo de instrumento |
| notional_usd | NUMERIC(15,2) | NOT NULL | Valor nocional em USD |
| taxa_ndf | NUMERIC(8,4) | NOT NULL | Taxa contratada BRL/USD |
| ptax_contratacao | NUMERIC(8,4) | NOT NULL | PTAX no dia da contratacao |
| prazo_dias | INTEGER | NOT NULL | Prazo em dias |
| data_contratacao | DATE | NOT NULL | |
| data_vencimento | DATE | NOT NULL | |
| custo_brl | NUMERIC(15,2) | NOT NULL | notional * (taxa_ndf - ptax_contratacao) |
| resultado_brl | NUMERIC(15,2) | | notional * (taxa_ndf - ptax_liquidacao), preenchido na liquidacao |
| ptax_liquidacao | NUMERIC(8,4) | | PTAX usada na liquidacao |
| status | VARCHAR(20) | NOT NULL, default 'pendente' | pendente / ativo / liquidado / cancelado |
| bucket_id | UUID | FK → bucket_mensal | Bucket associado |
| empresa | VARCHAR(10) | NOT NULL | |
| observacao | TEXT | | |
| created_at | TIMESTAMPTZ | NOT NULL, default now() | |
| updated_at | TIMESTAMPTZ | NOT NULL, default now() | |

**State transitions**: pendente → ativo, pendente → cancelado, ativo → liquidado, ativo → cancelado

### hedge.titulos_pagar

Titulos a pagar USD vindos do OMIE.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK, default random | |
| omie_id | BIGINT | NOT NULL, UNIQUE | ID no OMIE |
| valor_usd | NUMERIC(15,2) | NOT NULL | |
| vencimento | DATE | NOT NULL | |
| bucket_mes | DATE | NOT NULL | Primeiro dia do mes de vencimento |
| ptax_nf | NUMERIC(8,4) | | PTAX da nota fiscal |
| status | VARCHAR(20) | NOT NULL, default 'aberto' | aberto / liquidado / arquivado |
| empresa | VARCHAR(10) | NOT NULL | |
| fornecedor | VARCHAR(255) | | |
| numero_documento | VARCHAR(50) | | |
| created_at | TIMESTAMPTZ | NOT NULL, default now() | |
| updated_at | TIMESTAMPTZ | NOT NULL, default now() | |

### hedge.ptax_historico

Cotacoes PTAX diarias do BCB.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| data_ref | DATE | PK | Data de referencia |
| venda | NUMERIC(8,4) | NOT NULL | Cotacao de venda |
| compra | NUMERIC(8,4) | NOT NULL | Cotacao de compra |
| created_at | TIMESTAMPTZ | NOT NULL, default now() | |

### hedge.ndf_taxas

Taxas NDF de mercado por prazo.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK, default random | |
| data_ref | DATE | NOT NULL | |
| prazo_dias | INTEGER | NOT NULL, CHECK (30,60,90,120,180) | |
| taxa | NUMERIC(8,4) | NOT NULL | |
| created_at | TIMESTAMPTZ | NOT NULL, default now() | |

**Unique**: (data_ref, prazo_dias)

### hedge.posicao_snapshot

Foto diaria da posicao consolidada.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK, default random | |
| data_ref | DATE | NOT NULL, UNIQUE | |
| exposure_usd | NUMERIC(15,2) | NOT NULL | Total exposicao |
| ndf_ativo_usd | NUMERIC(15,2) | NOT NULL | Total NDF ativo |
| gap_usd | NUMERIC(15,2) | NOT NULL | exposure - ndf_ativo |
| cobertura_pct | NUMERIC(5,2) | NOT NULL | |
| ptax_ref | NUMERIC(8,4) | NOT NULL | PTAX usada no snapshot |
| raw_json | JSONB | | Dados completos para debug |
| created_at | TIMESTAMPTZ | NOT NULL, default now() | |

### hedge.estoque_snapshot

Estoque importado por localidade.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK, default random | |
| data_ref | DATE | NOT NULL | |
| empresa | VARCHAR(10) | NOT NULL | |
| localidade | VARCHAR(100) | NOT NULL | Nome do deposito/armazem |
| valor_brl | NUMERIC(15,2) | NOT NULL | |
| custo_usd_estimado | NUMERIC(15,2) | NOT NULL | |
| pago | BOOLEAN | NOT NULL, default false | |
| fase | VARCHAR(30) | | maritimo / alfandega / deposito |
| created_at | TIMESTAMPTZ | NOT NULL, default now() | |

### hedge.alerta

Alertas gerados pelo sistema.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK, default random | |
| tipo | VARCHAR(50) | NOT NULL | Tipo do alerta |
| severidade | VARCHAR(20) | NOT NULL, CHECK (critico, alta, media) | |
| mensagem | TEXT | NOT NULL | |
| bucket_id | UUID | FK → bucket_mensal | Bucket relacionado |
| lido | BOOLEAN | NOT NULL, default false | |
| resolvido | BOOLEAN | NOT NULL, default false | |
| resolvido_at | TIMESTAMPTZ | | |
| created_at | TIMESTAMPTZ | NOT NULL, default now() | |

### hedge.config_motor

Parametros operacionais do motor.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| chave | VARCHAR(100) | PK | Nome do parametro |
| valor | JSONB | NOT NULL | Valor (suporta string, number, array) |
| descricao | TEXT | | |
| updated_at | TIMESTAMPTZ | NOT NULL, default now() | |

**Default values**: lambda_default=0.5, localidades_ativas=[...], threshold_critico=1000000, threshold_alta=500000

### hedge.sync_log

Log de operacoes de sincronizacao.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK, default random | |
| fonte | VARCHAR(50) | NOT NULL | omie / bcb / calculo |
| operacao | VARCHAR(100) | NOT NULL | |
| status | VARCHAR(20) | NOT NULL | sucesso / erro |
| registros | INTEGER | default 0 | Quantidade processada |
| duracao_ms | INTEGER | | |
| erro | TEXT | | Mensagem de erro se houver |
| created_at | TIMESTAMPTZ | NOT NULL, default now() | |

## Shared Views (Cross-Module)

### shared.vw_hedge_posicao

Exposicao para C-Level e Breaking Point.

```sql
CREATE VIEW shared.vw_hedge_posicao AS
SELECT data_ref, exposure_usd, ndf_ativo_usd, gap_usd, cobertura_pct, ptax_ref
FROM hedge.posicao_snapshot
ORDER BY data_ref DESC;
```

## Audit Log Triggers

Tabelas com trigger de audit log: `ndf_registro`, `titulos_pagar`, `config_motor`, `alerta`.
Tabelas sem trigger (snapshots/logs, append-only por natureza): `posicao_snapshot`, `estoque_snapshot`, `ptax_historico`, `ndf_taxas`, `sync_log`, `bucket_mensal`.
