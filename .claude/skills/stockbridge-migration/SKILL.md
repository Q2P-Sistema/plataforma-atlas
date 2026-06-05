---
name: stockbridge-migration
description: Use ao criar, alterar ou revisar migrations SQL em packages/db/migrations/ — especialmente de tabelas stockbridge.*. Cobre numeração, nomenclatura, triggers de auditoria obrigatórios, padrão de schema Drizzle paralelo e idempotência OMIE. Ative quando o usuário mencionar "nova migration", "migration", "alter table stockbridge", "drizzle generate", ou estiver editando arquivos em packages/db/migrations/ ou packages/db/src/schemas/.
---

# StockBridge Migration

Como criar e revisar migrations SQL no projeto Atlas, com foco no schema `stockbridge.*`.

## 1. Numeração e nomenclatura

Padrão fixo:

```
NNNN_<modulo>_<descricao>.sql
```

- `NNNN` — 4 dígitos zero-padded, sequencial. Próximo número = `(maior atual) + 1`. Atual mais alto: **0030** (`packages/db/migrations/0030_stockbridge_localidades_subestoque.sql`).
- `modulo` — `stockbridge`, `hedge`, `forecast`, `breakingpoint`, `atlas`. Use o módulo dominante da mudança.
- `descricao` — snake_case, descritivo. Ex: `idempotencia_omie`, `lote_codigo_sequence`, `localidades_subestoque`.

**Antes de criar**, rode:

```bash
ls packages/db/migrations/ | tail -5
```

para confirmar a numeração e evitar colisão.

## 2. Cabeçalho obrigatório

Toda migration começa com bloco de comentário explicando **antes/agora/porquê**, no estilo de [packages/db/migrations/0030_stockbridge_localidades_subestoque.sql](packages/db/migrations/0030_stockbridge_localidades_subestoque.sql) e [packages/db/migrations/0016_stockbridge_idempotencia_omie.sql](packages/db/migrations/0016_stockbridge_idempotencia_omie.sql):

```sql
-- Migration: NNNN — <título curto>
--
-- Antes: <estado anterior, problema observado>
-- Agora: <novo comportamento>
-- Porque: <motivação de negócio ou bug evitado>
--
-- Ver specs/<feature>/... (se aplicável)
```

Use seções separadas por `-- ── N. <título> ─────────`. Linguagem direta, sem encheção.

## 3. Toda nova tabela `stockbridge.*` exige trigger de auditoria

**Princípio IV (CLAUDE.md): auditoria é obrigatória.** Toda tabela em `stockbridge.*` precisa de trigger gravando em `shared.audit_log`. Padrão definido em [packages/db/migrations/0008_stockbridge_core.sql](packages/db/migrations/0008_stockbridge_core.sql) (linhas 221-328), com 8 triggers existentes:

```sql
CREATE OR REPLACE FUNCTION stockbridge.audit_<tabela>()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', '<tabela>', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_sb_<tabela>
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.<tabela>
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_<tabela>();
```

Tabelas que já têm trigger: `localidade`, `localidade_correlacao`, `lote`, `movimentacao`, `aprovacao`, `divergencia`, `fornecedor_exclusao`, `config_produto`.

Se você adicionar `stockbridge.<nova_tabela>` sem trigger, **a migration está incorreta**. Soft delete (`ativo=false`) substitui hard delete — não use `DELETE` nas tabelas auditadas em fluxo normal.

## 4. Schema Drizzle precisa ficar em sincronia

A fonte da verdade para tipagem TS é [packages/db/src/schemas/stockbridge.ts](packages/db/src/schemas/stockbridge.ts). Toda migration que altera DDL deve ter contrapartida no schema Drizzle, ou o TS sai de sync.

Fluxo recomendado:

1. Edite o schema TS primeiro (`packages/db/src/schemas/stockbridge.ts`).
2. Rode `pnpm --filter @atlas/db generate` para gerar a migration via drizzle-kit.
3. **Edite manualmente** a migration gerada para adicionar:
   - Cabeçalho de contexto (seção 2)
   - Triggers de auditoria, se for tabela nova (seção 3)
   - DML de backfill, se necessário
4. Aplicar com `pnpm --filter @atlas/db migrate`.

Config: [packages/db/drizzle.config.ts](packages/db/drizzle.config.ts) aponta `schema: ./src/schemas/*.ts` e `out: ./migrations`.

## 5. Migrations de backfill (DML em massa)

Para alterar dados existentes, siga o padrão de [packages/db/migrations/0030_stockbridge_localidades_subestoque.sql](packages/db/migrations/0030_stockbridge_localidades_subestoque.sql):

- `UPDATE` em todas as tabelas com FK pro valor mudado (movimentacao, aprovacao, reserva_saldo, etc).
- `INSERT ... ON CONFLICT DO NOTHING` para inserir idempotente.
- Comentários `--` antes de cada bloco explicando o que muda e por quê.
- **Não use** `DELETE` sem antes tratar registros dependentes — auditoria preserva histórico mas FKs podem quebrar.

## 6. Quando mexer em idempotência OMIE

Mudanças no fluxo de `cod_int_ajuste` (sufixos `acxe-trf`, `q2p-ent`, `acxe-faltando`) tocam em [packages/db/migrations/0016_stockbridge_idempotencia_omie.sql](packages/db/migrations/0016_stockbridge_idempotencia_omie.sql) e em `modules/stockbridge/src/types.ts` (constante `COD_INT_AJUSTE_SUFIXO`). Adicionar novo sufixo exige:

1. Adicionar em `COD_INT_AJUSTE_SUFIXO` no types.ts.
2. Adicionar no CHECK constraint de `stockbridge.movimentacao.status_omie` (se for novo estado).
3. Atualizar handler em [modules/stockbridge/src/services/operacoes-pendentes.service.ts](modules/stockbridge/src/services/operacoes-pendentes.service.ts).
4. Documentar no CLAUDE.md (seção StockBridge).

Sempre carregue a skill `omie-integration` em conjunto.

## 7. Checklist de revisão

Antes de commitar uma migration:

- [ ] Numeração contígua, sem buraco
- [ ] Cabeçalho com Antes/Agora/Porque
- [ ] Schema Drizzle atualizado
- [ ] Triggers de auditoria em tabelas novas
- [ ] Backfill cobre todas as tabelas com FK
- [ ] Sem hard delete em tabelas auditadas
- [ ] Testado localmente: `pnpm --filter @atlas/db migrate`

## Referências do projeto

- [packages/db/migrations/](packages/db/migrations/) — todas as 30 migrations
- [packages/db/migrations/0008_stockbridge_core.sql](packages/db/migrations/0008_stockbridge_core.sql) — schema base + 8 triggers
- [packages/db/migrations/0016_stockbridge_idempotencia_omie.sql](packages/db/migrations/0016_stockbridge_idempotencia_omie.sql) — padrão idempotência
- [packages/db/migrations/0030_stockbridge_localidades_subestoque.sql](packages/db/migrations/0030_stockbridge_localidades_subestoque.sql) — exemplo recente de backfill complexo
- [packages/db/src/schemas/stockbridge.ts](packages/db/src/schemas/stockbridge.ts) — schema Drizzle
- [packages/db/drizzle.config.ts](packages/db/drizzle.config.ts) — config drizzle-kit
