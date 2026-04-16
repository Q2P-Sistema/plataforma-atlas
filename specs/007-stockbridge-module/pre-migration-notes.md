# StockBridge — Pre-Migration Notes

**Executado em**: 2026-04-16 durante Phase 2 (Foundational)

## T007b — Infraestrutura de audit log

**Verificado**:
- `shared.audit_log` ja existe em `packages/db/migrations/0001_atlas_infra_base.sql` (linhas 57-68)
- `shared.prevent_audit_mutation()` + trigger de imutabilidade ja existem (linhas 130-140)
- **Nao existe** uma funcao generica `shared.audit_log_trigger(table_name text)` — o padrao do projeto e **funcao de audit dedicada por tabela** no schema do proprio modulo (ver `hedge.audit_ndf_registro()`, `breakingpoint.audit_bp_params()`).

**Acao tomada**:
- Migration 0008_stockbridge_core.sql criou 8 funcoes de audit dedicadas (`stockbridge.audit_localidade()`, `stockbridge.audit_lote()`, etc.), seguindo o padrao hedge/breakingpoint.
- Nao foi necessario criar infraestrutura adicional.
- `data-model.md` referencia `shared.audit_log_trigger()` como padrao — deve ser lido como "padrao de audit por tabela apontando pra `shared.audit_log`", nao como funcao unica.

## T023a — Coluna `armazem_id` em `atlas.users`

**Verificado**:
- `atlas.users` em `packages/db/migrations/0001_atlas_infra_base.sql` (linhas 14-31) **nao tem** coluna `armazem_id`
- Colunas existentes: id, name, email, password_hash, role, status, totp_secret, totp_enabled, password_reset_token, password_reset_expires, last_login_at, failed_login_attempts, locked_until, created_at, updated_at, deleted_at

**Acao tomada**:
- Criada migration 0010_stockbridge_armazem_users.sql com `ALTER TABLE atlas.users ADD COLUMN IF NOT EXISTS armazem_id UUID REFERENCES stockbridge.localidade(id) ON DELETE SET NULL`
- Migration idempotente: `ADD COLUMN IF NOT EXISTS` permite reexecucao sem erro.
- FK com `ON DELETE SET NULL`: se uma localidade for apagada, o usuario vinculado fica sem armazem (sera bloqueado pelo middleware `requireArmazemVinculado`) — nao corrompe sessao ativa.
- Drizzle schema (`packages/db/src/schemas/atlas.ts`) precisa ser atualizado em task futura para refletir o novo campo.

## Observacao adicional — `shared.users` vs `atlas.users`

O `data-model.md` original referenciava `shared.users` em varias tabelas stockbridge. **Correcao**: a tabela real e `atlas.users` (migration 0001). Todas as FKs nas migrations 0008 e 0010 e no Drizzle schema de stockbridge ja apontam corretamente para `atlas.users(id)`. O `data-model.md` deve ser atualizado em PR separado para refletir isso.
