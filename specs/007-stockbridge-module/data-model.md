# Data Model: StockBridge

**Feature**: 007-stockbridge-module
**Created**: 2026-04-16

## Visao Geral

Schema `stockbridge.*` no PostgreSQL 16. 8 tabelas novas. Todas com triggers de audit log para `shared.audit_log` (Principio IV). Leituras de dados OMIE (produtos, fornecedores, clientes) via views em `public.*` (sync n8n, nao modificavel).

Views cross-modulo em `shared.vw_sb_*` para exposicao controlada a Hedge, Forecast e C-Level.

## Tabelas

### 1. `stockbridge.localidade`

Locais fisicos e virtuais de estoque. Cada localidade vincula opcionalmente a um CNPJ, e os codigos OMIE ACXE/Q2P sao armazenados na correlacao (tabela 2).

| Coluna | Tipo | Null | Default | Observacao |
|---|---|---|---|---|
| `id` | `uuid` | N | `gen_random_uuid()` | PK |
| `codigo` | `varchar(50)` | N | — | Ex: "11.1", "21.1", "90.0.2" (codigo de negocio, unico) |
| `nome` | `varchar(255)` | N | — | Ex: "SANTO ANDRE (antigo Galpao 5)" |
| `tipo` | `varchar(20)` | N | — | enum: `proprio`, `tpl`, `porto_seco`, `virtual_transito`, `virtual_ajuste` |
| `cnpj` | `varchar(50)` | Y | NULL | "Acxe Matriz", "Q2P Matriz", "Q2P Filial" — NULL para virtuais |
| `cidade` | `varchar(100)` | Y | NULL | |
| `ativo` | `boolean` | N | `true` | |
| `created_at` | `timestamptz` | N | `now()` | |
| `updated_at` | `timestamptz` | N | `now()` | Trigger de update |

**Indices**: UNIQUE(`codigo`), btree(`tipo`, `ativo`)

**Regras**:
- Localidade com tipo `virtual_*` sempre tem `cnpj=NULL`.
- Localidades inativas nao aparecem em dropdowns mas permanecem para historico.

### 2. `stockbridge.localidade_correlacao`

Mapeamento ACXE↔Q2P de localidades. Uma localidade de negocio pode ter um codigo OMIE ACXE, um codigo OMIE Q2P, ou ambos.

| Coluna | Tipo | Null | Default | Observacao |
|---|---|---|---|---|
| `id` | `uuid` | N | `gen_random_uuid()` | PK |
| `localidade_id` | `uuid` | N | — | FK → `stockbridge.localidade(id)` |
| `codigo_local_estoque_acxe` | `bigint` | Y | NULL | Codigo OMIE na instancia ACXE |
| `codigo_local_estoque_q2p` | `bigint` | Y | NULL | Codigo OMIE na instancia Q2P |
| `created_at` | `timestamptz` | N | `now()` | |

**Indices**: UNIQUE(`localidade_id`), UNIQUE(`codigo_local_estoque_acxe`) WHERE not null, UNIQUE(`codigo_local_estoque_q2p`) WHERE not null

**Regras**:
- Pelo menos um dos dois codigos deve ser preenchido (CHECK constraint).
- Uma localidade virtual (transito/ajuste) pode ter so um lado (ex: VARREDURA so tem ACXE).

### 3. `stockbridge.lote`

Unidade rastreavel de estoque. Um lote e criado no recebimento, evolui por estagios de transito (se for importacao), e consome saldo com saidas.

| Coluna | Tipo | Null | Default | Observacao |
|---|---|---|---|---|
| `id` | `uuid` | N | `gen_random_uuid()` | PK |
| `codigo` | `varchar(50)` | N | — | "L001", "T001" — humano, unico |
| `produto_codigo_acxe` | `bigint` | N | — | FK logico para `public.tb_produtos_ACXE.codigo_produto` |
| `produto_codigo_q2p` | `bigint` | Y | NULL | Resolvido via correlacao de descricao; NULL ate correlato cadastrado |
| `fornecedor_nome` | `varchar(255)` | N | — | Nome textual (legado) |
| `pais_origem` | `varchar(100)` | Y | NULL | "China", "USA", "Korea", etc. |
| `quantidade_fisica` | `numeric(12,3)` | N | 0 | Toneladas (sempre em t apos conversao) |
| `quantidade_fiscal` | `numeric(12,3)` | N | 0 | Toneladas |
| `custo_usd` | `numeric(12,2)` | Y | NULL | USD/tonelada |
| `status` | `varchar(30)` | N | `'provisorio'` | enum: `reconciliado`, `divergencia`, `transito`, `provisorio`, `aguardando_aprovacao`, `rejeitado` |
| `estagio_transito` | `varchar(30)` | Y | NULL | enum: `transito_intl`, `porto_dta`, `transito_interno`, `reservado`; NULL se nao esta em transito |
| `localidade_id` | `uuid` | Y | NULL | FK → `stockbridge.localidade(id)`; NULL para transito_intl |
| `cnpj` | `varchar(50)` | N | — | "Acxe Matriz", "Q2P Matriz", "Q2P Filial" |
| `nota_fiscal` | `varchar(50)` | Y | NULL | NF vinculada (NULL para entrada manual sem NF) |
| `manual` | `boolean` | N | `false` | TRUE se criado por entrada manual |
| `di` | `varchar(50)` | Y | NULL | Numero DI (obrigatorio em estagio porto_dta) |
| `dta` | `varchar(50)` | Y | NULL | Numero DTA (obrigatorio em estagio porto_dta) |
| `dt_entrada` | `date` | N | — | Data de entrada fisica ou estimada |
| `dt_prev_chegada` | `date` | Y | NULL | Data prevista de chegada (para transito) |
| `ativo` | `boolean` | N | `true` | Soft delete |
| `created_at` | `timestamptz` | N | `now()` | |
| `updated_at` | `timestamptz` | N | `now()` | Trigger |

**Indices**: UNIQUE(`codigo`), btree(`produto_codigo_acxe`, `status`, `ativo`), btree(`cnpj`, `localidade_id`), btree(`nota_fiscal`)

**Regras de transicao de status** (enforced em TS):
```
provisorio → reconciliado (quando OMIE confirma)
provisorio → divergencia (quando fiscal != fisico)
aguardando_aprovacao → provisorio (gestor aprova)
aguardando_aprovacao → rejeitado (gestor rejeita)
rejeitado → aguardando_aprovacao (operador re-submete — clarificacao Q7)
transito → provisorio (operador recebe no armazem)
```

### 4. `stockbridge.movimentacao`

Log dual-CNPJ de movimentacoes. Uma linha por NF, com lados ACXE e Q2P consolidados (modelo legado preservado — clarificacao Q8).

| Coluna | Tipo | Null | Default | Observacao |
|---|---|---|---|---|
| `id` | `uuid` | N | `gen_random_uuid()` | PK |
| `nota_fiscal` | `varchar(50)` | N | — | Chave logica de idempotencia |
| `tipo_movimento` | `varchar(30)` | N | — | enum: `entrada_nf`, `entrada_manual`, `saida_automatica`, `saida_manual`, `ajuste`, `regularizacao_fiscal`, `debito_cruzado` |
| `subtipo` | `varchar(50)` | Y | NULL | Refina o tipo. Cobre os 19 tipos do diagrama legado: **Entradas (7):** `importacao`, `devolucao_cliente`, `compra_nacional`, `retorno_remessa`, `retorno_comodato`, `entrada_manual`, `inventario_mais`. **Saidas (12):** `venda`, `remessa_beneficiamento`, `transf_cnpj`, `devolucao_fornecedor`, `debito_cruzado`, `regularizacao_fiscal`, `transf_intra_cnpj`, `comodato`, `amostra`, `descarte`, `quebra`, `inventario_menos` |
| `lote_id` | `uuid` | Y | NULL | FK → `stockbridge.lote(id)` (NULL para ajuste global) |
| `quantidade_t` | `numeric(12,3)` | N | — | Toneladas (positiva para entrada, negativa para saida) |
| `mv_acxe` | `smallint` | Y | NULL | Status do lancamento ACXE (1=sucesso) |
| `dt_acxe` | `timestamptz` | Y | NULL | Quando foi lancado no OMIE ACXE |
| `id_movest_acxe` | `varchar(100)` | Y | NULL | ID retornado pelo OMIE ACXE |
| `id_ajuste_acxe` | `varchar(100)` | Y | NULL | ID do ajuste OMIE ACXE |
| `id_user_acxe` | `uuid` | Y | NULL | FK → `shared.users(id)` |
| `mv_q2p` | `smallint` | Y | NULL | Status do lancamento Q2P |
| `dt_q2p` | `timestamptz` | Y | NULL | |
| `id_movest_q2p` | `varchar(100)` | Y | NULL | |
| `id_ajuste_q2p` | `varchar(100)` | Y | NULL | |
| `id_user_q2p` | `uuid` | Y | NULL | |
| `observacoes` | `text` | Y | NULL | Motivo de divergencia, manual, etc. |
| `ativo` | `boolean` | N | `true` | Soft delete (clarificacao Q7) |
| `created_at` | `timestamptz` | N | `now()` | |
| `updated_at` | `timestamptz` | N | `now()` | Trigger |

**Indices**: UNIQUE(`nota_fiscal`) WHERE `tipo_movimento IN ('entrada_nf', 'saida_automatica')` (idempotencia), btree(`tipo_movimento`, `ativo`), btree(`created_at`), btree(`lote_id`)

**Regras**:
- Idempotencia em NFs: UNIQUE parcial permite multiplas entradas manuais/ajustes com `nota_fiscal=NULL` mas bloqueia duplicatas de NFs reais do OMIE.
- `ativo=false` significa soft delete (nao aparece em listagens mas preserva auditoria).

### 5. `stockbridge.aprovacao`

Pendencias de aprovacao hierarquica (operador→gestor→diretor).

| Coluna | Tipo | Null | Default | Observacao |
|---|---|---|---|---|
| `id` | `uuid` | N | `gen_random_uuid()` | PK |
| `lote_id` | `uuid` | N | — | FK → `stockbridge.lote(id)` |
| `precisa_nivel` | `varchar(20)` | N | — | enum: `gestor`, `diretor` |
| `tipo_aprovacao` | `varchar(30)` | N | — | enum: `recebimento_divergencia`, `entrada_manual`, `saida_transf_intra`, `saida_comodato`, `saida_amostra`, `saida_descarte`, `saida_quebra`, `ajuste_inventario` |
| `quantidade_prevista_t` | `numeric(12,3)` | Y | NULL | Para divergencias |
| `quantidade_recebida_t` | `numeric(12,3)` | Y | NULL | Para divergencias |
| `tipo_divergencia` | `varchar(30)` | Y | NULL | enum: `faltando`, `varredura`, `cruzada` (para recebimento_divergencia) |
| `observacoes` | `text` | Y | NULL | Motivo/justificativa |
| `lancado_por` | `uuid` | N | — | FK → `shared.users(id)` |
| `lancado_em` | `timestamptz` | N | `now()` | |
| `aprovado_por` | `uuid` | Y | NULL | FK → `shared.users(id)` |
| `aprovado_em` | `timestamptz` | Y | NULL | |
| `status` | `varchar(20)` | N | `'pendente'` | enum: `pendente`, `aprovada`, `rejeitada` |
| `rejeicao_motivo` | `text` | Y | NULL | |
| `created_at` | `timestamptz` | N | `now()` | |

**Indices**: btree(`status`, `precisa_nivel`), btree(`lote_id`), btree(`lancado_por`)

**Regras**:
- Quando `status=aprovada`, um trigger (ou o servico) atualiza `stockbridge.lote.status` para `provisorio`.
- Quando `status=rejeitada`, `stockbridge.lote.status` vai para `rejeitado`.

### 6. `stockbridge.divergencia`

Divergencias fiscais detectadas (separado de aprovacao para permitir divergencia sem aprovacao — caso do debito cruzado automatico).

| Coluna | Tipo | Null | Default | Observacao |
|---|---|---|---|---|
| `id` | `uuid` | N | `gen_random_uuid()` | PK |
| `lote_id` | `uuid` | Y | NULL | FK → `stockbridge.lote(id)`; NULL se divergencia a nivel de CNPJ (ex: cruzada) |
| `movimentacao_id` | `uuid` | Y | NULL | FK → `stockbridge.movimentacao(id)` |
| `tipo` | `varchar(30)` | N | — | enum: `faltando`, `varredura`, `cruzada`, `fiscal_pendente` |
| `quantidade_delta_t` | `numeric(12,3)` | N | — | Diferenca fisica - fiscal (pode ser negativa) |
| `valor_usd` | `numeric(12,2)` | Y | NULL | Impacto financeiro estimado |
| `status` | `varchar(20)` | N | `'aberta'` | enum: `aberta`, `regularizada`, `descartada` |
| `regularizada_em` | `timestamptz` | Y | NULL | |
| `regularizada_por_movimentacao_id` | `uuid` | Y | NULL | FK → `stockbridge.movimentacao(id)` (a NF de transf que fechou a divergencia) |
| `observacoes` | `text` | Y | NULL | |
| `created_at` | `timestamptz` | N | `now()` | |

**Indices**: btree(`tipo`, `status`), btree(`lote_id`), btree(`movimentacao_id`)

### 7. `stockbridge.fornecedor_exclusao`

Fornecedores excluidos da fila de compra nacional pelo diretor (clarificacao spec — `AbaFornecedores` no frontend v5).

| Coluna | Tipo | Null | Default | Observacao |
|---|---|---|---|---|
| `id` | `uuid` | N | `gen_random_uuid()` | PK |
| `fornecedor_cnpj` | `varchar(50)` | N | — | UNIQUE |
| `fornecedor_nome` | `varchar(255)` | N | — | Cache textual |
| `motivo` | `text` | Y | NULL | |
| `excluido_por` | `uuid` | N | — | FK → `shared.users(id)` |
| `excluido_em` | `timestamptz` | N | `now()` | |
| `reincluido_em` | `timestamptz` | Y | NULL | NULL se atualmente excluido |
| `reincluido_por` | `uuid` | Y | NULL | FK → `shared.users(id)` |

**Indices**: UNIQUE(`fornecedor_cnpj`) WHERE `reincluido_em IS NULL`

### 8. `stockbridge.config_produto`

Configuracao por SKU (consumo medio, lead time). Nao vem do OMIE — editavel pelo diretor.

| Coluna | Tipo | Null | Default | Observacao |
|---|---|---|---|---|
| `id` | `uuid` | N | `gen_random_uuid()` | PK |
| `produto_codigo_acxe` | `bigint` | N | — | UNIQUE, FK logico para OMIE |
| `consumo_medio_diario_t` | `numeric(10,3)` | Y | NULL | Toneladas/dia |
| `lead_time_dias` | `integer` | Y | NULL | Dias |
| `familia_categoria` | `varchar(50)` | Y | NULL | PP / PE / PS (derivado mas configuravel) |
| `incluir_em_metricas` | `boolean` | N | `true` | Exclui "USO E CONSUMO", "ATIVO IMOBILIZADO" |
| `updated_by` | `uuid` | Y | NULL | |
| `updated_at` | `timestamptz` | N | `now()` | |

**Indices**: UNIQUE(`produto_codigo_acxe`)

---

## Views em `shared`

### `shared.vw_sb_saldo_por_produto`

Saldo agregado por produto/localidade/CNPJ.

```sql
CREATE VIEW shared.vw_sb_saldo_por_produto AS
SELECT
  l.produto_codigo_acxe,
  l.cnpj,
  l.localidade_id,
  SUM(CASE WHEN l.status = 'reconciliado' AND l.estagio_transito IS NULL THEN l.quantidade_fisica ELSE 0 END) AS fisica_disponivel_t,
  SUM(CASE WHEN l.status = 'reconciliado' AND l.estagio_transito IS NULL THEN l.quantidade_fiscal ELSE 0 END) AS fiscal_t,
  SUM(CASE WHEN l.status = 'provisorio' THEN l.quantidade_fisica ELSE 0 END) AS provisorio_t,
  SUM(CASE WHEN l.estagio_transito = 'transito_intl' THEN l.quantidade_fisica ELSE 0 END) AS transito_intl_t,
  SUM(CASE WHEN l.estagio_transito = 'porto_dta' THEN l.quantidade_fisica ELSE 0 END) AS porto_dta_t,
  SUM(CASE WHEN l.estagio_transito = 'transito_interno' THEN l.quantidade_fisica ELSE 0 END) AS transito_interno_t
FROM stockbridge.lote l
WHERE l.ativo = true
GROUP BY l.produto_codigo_acxe, l.cnpj, l.localidade_id;
```

### `shared.vw_sb_correlacao_produto`

Correlacao ACXE↔Q2P por descricao (preserva match textual do legado).

```sql
CREATE VIEW shared.vw_sb_correlacao_produto AS
SELECT
  a.codigo_produto AS codigo_produto_acxe,
  q.codigo_produto AS codigo_produto_q2p,
  a.descricao,
  a.codigo_familia AS codigo_familia_acxe,
  q.codigo_familia AS codigo_familia_q2p
FROM public.tb_produtos_ACXE a
INNER JOIN public.tb_produtos_Q2P q ON a.descricao = q.descricao
WHERE (a.inativo IS NULL OR a.inativo != 'S')
  AND (q.inativo IS NULL OR q.inativo != 'S');
```

### `shared.vw_sb_fornecedor_ativo`

Fornecedores disponiveis para recebimento (respeitando exclusoes do diretor).

```sql
CREATE VIEW shared.vw_sb_fornecedor_ativo AS
SELECT f.*
FROM public.tbl_cadastroFornecedoresClientes_ACXE f
LEFT JOIN stockbridge.fornecedor_exclusao e
  ON e.fornecedor_cnpj = f.cnpj_cpf
  AND e.reincluido_em IS NULL
WHERE e.id IS NULL;
```

---

## Auditoria (Principio IV)

Triggers em `stockbridge.lote`, `stockbridge.movimentacao`, `stockbridge.aprovacao`, `stockbridge.divergencia`, `stockbridge.fornecedor_exclusao`, `stockbridge.config_produto`, `stockbridge.localidade`, `stockbridge.localidade_correlacao` gravando em `shared.audit_log` para INSERT/UPDATE/DELETE.

Padrao exato seguindo a migration 0002_hedge_engine.sql:

```sql
CREATE TRIGGER sb_lote_audit
AFTER INSERT OR UPDATE OR DELETE ON stockbridge.lote
FOR EACH ROW EXECUTE FUNCTION shared.audit_log_trigger('stockbridge.lote');
```

---

## Tabelas OMIE Lidas (read-only, em `public.*`)

Sync n8n ja mantem estas tabelas no `pg-acxe` — StockBridge apenas le:

| Tabela | Uso no StockBridge |
|---|---|
| `public.tb_produtos_ACXE` | Catalogo ACXE (522 rows), nome/NCM/familia |
| `public.tb_produtos_Q2P` | Catalogo Q2P (546 rows), para correlacao |
| `public.tbl_cadastroFornecedoresClientes_ACXE` | Cadastro fornecedores (297 rows) |
| `public.tbl_cadastroFornecedoresClientes_Q2P` | Idem Q2P (1934 rows) |

**Nota**: Os dados vem originalmente da API OMIE via n8n. StockBridge nunca escreve nessas tabelas — apenas consulta.

---

## Migracao do MySQL

### Mapeamento de tabelas

| MySQL (legado) | PostgreSQL (novo) | Rows | Nota |
|---|---|---|---|
| `tb_movimentacao` | `stockbridge.movimentacao` | 731 | Mapear `id_user_acxe`/`id_user_q2p` via email do `tb_users` → `shared.users(id)` |
| `tb_estoque_local_acxe` + `tb_estoque_local_q2p` + `tb_converteCodigoLocalEstoque` | `stockbridge.localidade` + `stockbridge.localidade_correlacao` | 6+3+10 | Consolidar em modelo unificado |
| `tb_tp_divergencia` | Valores seed em `stockbridge.divergencia.tipo` | 2 | Faltando, Varredura |
| `tb_tp_status_movimento` | enum inline | 1 | So "Sucesso" → `mv_acxe=1`/`mv_q2p=1` |
| `tb_users` | `shared.users` | 4 | So criar se email nao existir; forcar reset password |

### Script de migracao

`modules/stockbridge/scripts/migrate-from-mysql.ts` executa:
1. Validacao de conectividade (pg-atlas-dev + mysql-q2p)
2. Leitura com `mysql2/promise`, insercao em transacao Postgres
3. Log de progresso e relatorio final (contagens antes/depois)
4. Modo `--dry-run` para testar em staging sem escrever

---

## Estado inicial (seeds)

Depois da migration:
- 4 locais ACXE ativos (Santo Andre x2, Extrema, ATN)
- 3 locais Q2P ativos (correlacionados aos ACXE)
- 2 locais virtuais (TRANSITO, VARREDURA)
- Configuracao padrao por familia:
  - PP / PE / PS com `incluir_em_metricas=true`
  - USO E CONSUMO, ATIVO IMOBILIZADO com `incluir_em_metricas=false`
