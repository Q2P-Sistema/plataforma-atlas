# Runbook — Subir o Atlas em UAT (ensaio de produção)

> Objetivo: subir o Atlas no ambiente UAT (`uat-atlas.q2p.com.br`) simulando produção,
> com **StockBridge + Forecast + Hedge + BreakingPoint** habilitados e **OMIE em modo real**.
> Última revisão: 2026-06-08.

## Decisões deste ensaio

| Item | Decisão |
|---|---|
| Módulos habilitados | StockBridge, Forecast, Hedge, BreakingPoint |
| OMIE | **real** (grava no ERP OMIE de verdade — ACXE + Q2P) |
| Banco UAT | reaproveitar `db.manager01.q2p.com.br:5437/acxe_q2p` (já tem espelho OMIE em `public.*`) |
| Imagens | `plasticosq2p/atlas-{api,web}:uat` (build automático no push da branch `uat`) |
| Stack | `uat-atlas - web e api.yaml` (Portainer) |

## ⚠️ Porta de segurança — OMIE real

`OMIE_MODE=real` faz toda **aprovação/saída no UAT gravar ajuste de estoque e pedido de
compra no OMIE de produção** (não há OMIE de teste separado). Sequência recomendada:

1. Suba o UAT primeiro com `OMIE_MODE=mock` e valide UI/login/navegação (smoke test).
2. Só então flipe `OMIE_MODE=real` no env do Portainer e redeploye.
3. Combine uma janela com quem opera o OMIE; ajustes ficam idempotentes por `cod_int_ajuste`,
   mas são lançamentos reais.

---

## Passo a passo

### 0. Pré-checagens (local)
- [ ] `git status` limpo; você está na `dev` com os 11 commits à frente da `uat`.
- [ ] Secrets do GitHub Actions presentes: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`
      (usados por `.github/workflows/docker-build-uat.yml`).
- [ ] Acesso ao Portainer (stack `uat-atlas`) e ao Postgres UAT (`:5437`).
- [ ] DNS `uat-atlas.q2p.com.br` → manager do swarm (Traefik resolve TLS via Let's Encrypt).

### 1. Sincronizar código para a branch `uat`
```bash
git checkout uat && git pull
git merge --no-ff dev            # traz os 11 commits da dev
git push origin uat              # dispara CI + build das imagens :uat
```
O push em `uat` roda `ci.yml` (lint/typecheck/test) e `docker-build-uat.yml`
(builda e publica `atlas-api:uat` e `atlas-web:uat`). Aguarde os dois jobs verdes.

### 2. Preparar o banco UAT
A ordem importa: **o sync apaga tudo** (DROP+CREATE+restore). Faça sync ANTES das migrations.

```bash
# 2a. (opcional, p/ dados frescos) espelho OMIE de prod -> UAT
export PROD_USER=<seu-usuario-prod>
scripts/sync-acxe-prod-to-uat.sh        # confirma com 'y'; pede as senhas

# 2b. aplicar as 36 migrations Atlas (cria stockbridge.*, shared.*, hedge.*, ...)
scripts/apply-migrations-uat.sh         # confirma com 'y'; pede a senha do UAT
```
Validação rápida (read-only) — devem aparecer os schemas Atlas:
```sql
SELECT nspname FROM pg_namespace
WHERE nspname IN ('shared','stockbridge','hedge','forecast','breakingpoint') ORDER BY 1;
```

### 3. Configurar env da stack no Portainer
Use `deploy/portainer/atlas-uat.env.example` como base. Preencha no campo
"Environment variables" da stack `uat-atlas`:
- `DATABASE_URL` → Postgres UAT (`:5437/acxe_q2p`) acessível de dentro do swarm.
- `REDIS_URL`, `SESSION_SECRET` (novo, **não** reuse o de prod).
- `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (admin inicial).
- `APP_URL=https://uat-atlas.q2p.com.br`.
- `SENDGRID_API_KEY` / `SENDGRID_FROM_EMAIL` (senão e-mails só em log).
- **OMIE_MODE=mock** (por enquanto) + `OMIE_*_KEY/SECRET` das duas empresas.
- `ATLAS_INTEGRATION_KEY` (>=16 chars) se for testar saídas automáticas via n8n.
- Flags: os 4 módulos já vêm `true` por default na stack; pode confirmar no env.

> A API só **boota** com `DATABASE_URL`, `REDIS_URL` e `SESSION_SECRET` válidos
> (Zod em `packages/core/src/config.ts`). O resto é opcional, mas o StockBridge
> em OMIE real exige as credenciais OMIE — sem elas, as operações estouram.

### 4. Deploy da stack
- No Portainer, atualize/deploye a stack `uat-atlas` apontando para `*:uat`.
- A API **não roda migrations no boot** (só `seedAdmin()` se a tabela `users` estiver vazia).
  Por isso o passo 2b é obrigatório antes daqui.

### 5. Smoke test (mock)
```bash
curl -fsS https://uat-atlas.q2p.com.br/api/v1/health      # 200
```
- [ ] Abrir `https://uat-atlas.q2p.com.br`, logar com o admin semeado.
- [ ] Trocar a senha do admin.
- [ ] Navegar StockBridge / Forecast / Hedge / BreakingPoint — telas carregam.
- [ ] Cockpit StockBridge lê saldo de `public.vw_posicaoEstoqueUnificadaFamilia`.

### 6. Flipar para OMIE real (ensaio fiel)
- [ ] No Portainer, set `OMIE_MODE=real` e confirme as 4 credenciais OMIE.
- [ ] Redeploy da stack.
- [ ] Teste controlado de uma operação ponta-a-ponta (recebimento/aprovação) e confira
      no OMIE que o ajuste foi lançado com `cod_int_ajuste` esperado.
- [ ] Se houver `status_omie='pendente_q2p'`, validar painel
      `GET /api/v1/stockbridge/operacoes-pendentes` + retentativa idempotente.

### 7. Validação paralela com o legado (Princípio V — StockBridge)
Roda só leitura nos dois bancos (PG Atlas + MySQL legado):
```bash
# precisa de DATABASE_URL (UAT) + MYSQL_Q2P_HOST/PORT/USER/PASS/DB no ambiente
pnpm --filter @atlas/stockbridge exec tsx src/scripts/validar-paridade.ts --dias 7 --verbose
```
Objetivo: 2 semanas de paridade com o legado PHP antes de cogitar produção.

---

## Rollback
- **App**: no Portainer, voltar a stack para a tag anterior `atlas-{api,web}:uat-<SHA>`.
- **OMIE**: set `OMIE_MODE=mock` e redeploy para parar escritas reais imediatamente.
- **Banco**: re-rodar `sync-acxe-prod-to-uat.sh` reseta o UAT ao espelho de prod
  (apaga schemas Atlas; reaplicar migrations depois).

## Notas de arquitetura
- Atlas **escreve** em `stockbridge.*` e **lê** o espelho OMIE em `public.*` no MESMO banco.
- O espelho `public.*` do UAT é um snapshot do prod (via sync). Com OMIE real, as escritas
  vão para o OMIE de prod, mas as leituras de saldo vêm do snapshot — re-sincronize o
  espelho quando precisar de saldo atualizado.
- Migrations: SQL puro em `packages/db/migrations/`, aplicadas em ordem por
  `scripts/apply-migrations-uat.sh` (não há `meta/_journal.json`, então `drizzle-kit migrate`
  não é o caminho).
