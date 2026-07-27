# Runbook — Go-live do Atlas em PRODUÇÃO (atlas.q2p.com.br)

> Janela: **sexta-feira 2026-07-31, a partir das 17h30** (empresa parada no fim de semana).
> A janela original de 24/07 **não foi executada** (hotfix ACXEGDP na tarde de sexta;
> operação seguiu no UAT) — replanejada para 31/07 com release **v1.1.9**, que inclui
> o hotfix `0bfc3da` (grava produto na movimentação criada via aprovação de divergência).
> Origem do estado: banco UAT (`db.manager01.q2p.com.br:5437/acxe_q2p`) — o UAT rodou
> **como produção** desde junho (OMIE real). Destino: banco PROD (`:5432/acxe_q2p`,
> espelho OMIE vivo, sem schemas Atlas até este go-live).
> Plano completo e decisões: ver PRs do go-live + Jira ACXEGDP-153/114.

## Resumo da estratégia

**Promoção de ambiente com transplante de estado** — não é deploy greenfield:

1. Correções pré-deploy mergeadas na `uat` e validadas (ACXEGDP-316, 176, 183).
2. Promoção `uat`→`main` → tag vX.Y.Z → imagens `plasticosq2p/atlas-{api,web}:vX.Y.Z`.
3. Janela: freeze do UAT → backup manual do PROD → 46 migrations
   (`scripts/apply-migrations-prod.sh`) → transplante dos 6 schemas Atlas
   (`scripts/copy-atlas-uat-to-prod.sh`, igualdade exata) → stack `atlas` no
   Portainer → smoke test só-leitura → switch n8n → religar UAT.
4. `public.*` de PROD é **intocável** (espelho vivo do n8n) — os scripts têm
   garantia estrutural disso.

## Pré-tarefas (quinta 23/07 e sexta de manhã)

| # | Tarefa | Quem | Status |
|---|---|---|---|
| P1 | DNS `atlas.q2p.com.br` → mesmo destino de `uat-atlas.q2p.com.br` | infra | ☑ 23/07 — já resolve p/ o ingress, TLS ok (Traefik responde 404 = sem router ativo) |
| P2 | Confirmar no Portainer a rede overlay que alcança o Postgres :5432 (a mesma da stack n8n) e ajustar `network_prod_swarm_public` + host do `DATABASE_URL` no stack/env | infra | ☐ |
| P3 | Confirmar no servidor que o cron destrutivo de sync está desativado (`sudo crontab -l`, `/etc/cron.d/`, `systemctl list-timers` — ver docs/uat-sync-autonomous-fix.md) | infra | ☐ |
| P4 | Preencher env da stack `atlas` no Portainer (template `deploy/portainer/atlas.env.example`; `SESSION_SECRET` NOVO; OMIE/SendGrid/`ATLAS_INTEGRATION_KEY` copiados do UAT) | infra | ☐ |
| P5 | Verificar env da instância n8n (`ATLAS_URL`, `ATLAS_INTEGRATION_KEY`) no Portainer | infra | ☐ |
| P6 | Ativação da **saída automática** (ver ⚠️ abaixo) | negócio | ☑ 23/07 — **ADIADA** (fora do escopo do go-live) |
| P7 | Enviar comunicação à equipe (texto abaixo) | gestão | ☐ |
| P8 | Anotar 2–3 NFs-testemunha já recebidas + 1 pendente (do UAT) p/ smoke test | exec | ☐ |
| P9 | `scripts/apply-migrations-prod.sh --precheck-only` (espelho OMIE ok em PROD) | exec | ☑ 23/07 — 16/16 tabelas presentes (via MCP) |
| P10 | Ferramentas: psql/pg_dump/pg_restore ≥ versão do servidor; ≥20 GB livres em `~/backups/atlas-golive/` | exec | ☐ |

### ⚠️ Saída automática — DECISÃO 23/07: fora do escopo do go-live

Constatado em 23/07: o workflow `stockbridge-saida-automatica.json` **não existe na
instância n8n** e **nunca rodou** — `stockbridge.movimentacao` no UAT só tem
`entrada_nf` (81) e `entrada_manual` (49), nenhuma `saida_automatica`. Ela não
escreve no ERP (só reflete NFs de saída no histórico do StockBridge + alerta de
débito cruzado), mas nunca teve execução real.

**Decisão do negócio (23/07): ADIAR.** O go-live sobe sem saída automática —
mesmo comportamento que o UAT teve desde junho (histórico interno só com
entradas). A ativação entra numa semana posterior, com teste dedicado
(tarefa de follow-up no Jira; fluxo de importação: docs/n8n-workflow-import.md).
**Na janela de sexta: NÃO importar nem ativar nada de saída automática.**

## Janela de sexta — sequência

```bash
export PROD_USER=<user> PGPASSWORD_PROD='<senha>' PGPASSWORD_UAT='<senha>'
export BK=~/backups/atlas-golive && mkdir -p $BK
cd <repo>
```

1. **[17:30] Freeze do UAT** — aviso no canal; n8n: desativar `ACXE - Exporta dados
   da Planilha FUP ... Rev 1.2`; Portainer: `uat-atlas_api` e `uat-atlas_web` → scale 0.
2. **[17:35] Backup manual do PROD** (backups automáticos quebrados — ACXEGDP-305/317/304):
   `pg_dump -h db.manager01.q2p.com.br -p 5432 -U $PROD_USER -d acxe_q2p -Fc -Z6 \
     -f "$BK/acxe_q2p_PROD_pre-atlas_$(date +%Y%m%d_%H%M).dump"` + sanity `pg_restore -l`.
3. **[paralelo] Backup dos schemas Atlas do UAT**:
   `pg_dump -h db.manager01.q2p.com.br -p 5437 -U postgres -d acxe_q2p \
     -n atlas -n stockbridge -n shared -n hedge -n forecast -n breakingpoint -Fc \
     -f "$BK/uat_atlas_schemas_$(date +%Y%m%d_%H%M).dump"`.
4. **[~18:15] Migrations**: `scripts/apply-migrations-prod.sh` (confirmação dupla).
5. **[~18:35] Transplante**: `scripts/copy-atlas-uat-to-prod.sh` — aceite: igualdade
   EXATA de contagens (o script falha sozinho se divergir).
6. **[~19:00] Validação anti-duplicidade** — mesmo SQL nos DOIS bancos, hashes idênticos:
   ```sql
   SELECT md5(string_agg(nota_fiscal||'|'||empresa||'|'||produto_codigo_acxe::text,
          ',' ORDER BY nota_fiscal, empresa, produto_codigo_acxe)), count(*)
   FROM stockbridge.movimentacao WHERE tipo_movimento='entrada_nf' AND ativo=true;
   ```
   ```sql
   SELECT md5(string_agg(nota_fiscal, ',' ORDER BY nota_fiscal)), count(*)
   FROM stockbridge.movimentacao_legado WHERE ativo=true;
   ```
7. **[~19:15] Deploy da stack `atlas`** no Portainer (`deploy/portainer/atlas.stack.yml`
   + env preenchido; `ATLAS_VERSION` = tag da release). Healthchecks verdes.
   **Atenção — stack legada**: já existiu uma stack `atlas` de produção (versão
   antiga da main: imagens `:latest`, rede `network_dev_swarm_public`, env de DEV
   com `SEED_ADMIN_*`). Em 23/07 ela não estava em execução (Traefik 404 no host).
   Se ela ainda existir no Portainer, **substituir o compose inteiro e LIMPAR o
   env antigo** — não herdar `SEED_ADMIN_*` nem `DATABASE_URL` de DEV, e remover
   a rede de DEV.
8. **[~19:30] Smoke test SÓ-LEITURA** (ninguém recebe/aprova/dá saída):
   - `curl -s https://atlas.q2p.com.br/api/v1/health` → healthy, 4 módulos enabled;
   - TLS Let's Encrypt emitido; login de usuário real do UAT funciona (senha atual);
   - gestor/diretor cai no setup de 2FA (esperado — `AUTH_2FA_ENABLED=true` + ACXEGDP-316);
   - Cockpit StockBridge com números na ordem de grandeza do UAT;
   - **Fila de recebimento: NF-testemunha recebida NÃO aparece; NF pendente aparece**;
   - Hedge/Forecast/BreakingPoint carregam; logs sem stack trace.
9. **[~19:50] Switch n8n → PROD** (nesta ordem):
   a. Env da instância n8n: `ATLAS_URL=https://atlas.q2p.com.br` → redeploy;
   b. Nó `POST nf-pedido-mapa` (workflow FUP Rev 1.2): URL →
      `https://atlas.q2p.com.br/api/v1/stockbridge/admin/nf-pedido-mapa` → reativar → 200 ok;
   c. Saída automática: **nada a fazer** (adiada — decisão P6);
   d. Garantir que NENHUM workflow aponta mais para `uat-atlas` (caminho único de
      duplicidade OMIE).
10. **[~20:15] Teste controlado OMIE (opcional)** — negativo: re-receber NF-testemunha
    → bloqueio por idempotência. Positivo: 1 recebimento real pequeno → um único
    `cod_int_ajuste` nas duas empresas no OMIE + e-mails ok. Daqui em diante: fix-forward.
11. **[~20:30] MCP `pg-acxe`** enxerga schemas Atlas (observabilidade do fim de semana).
12. **[~20:40] Religar UAT** (scale 1) — sem nenhum apontamento n8n; UAT é só consulta.
13. **[~20:50] Encerramento** — snapshot dia-zero dos schemas Atlas de PROD para `$BK`.

## Fim de semana + segunda (go/no-go)

- **Sáb/dom 2×/dia**: `/health`; `docker service ps` sem restarts; execuções n8n verdes.
- **Domingo pós-05:00** (FullSync NF semanal), no PROD:
  ```sql
  SELECT to_regclass('public.vw_hedge_resumo') IS NOT NULL AS vw_ok,
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_auto_popular_config_produto') AS trigger_ok;
  ```
- Frescor do espelho: `SELECT max(synced_at) FROM public."tbl_nf_header_ACXE";` acompanha o relógio.
- Uso indevido do UAT: `SELECT max(created_at) FROM shared.audit_log;` **no UAT** não
  avança além de sexta 17h30 (exceto logins de consulta).
- **Segunda**: cron comodato 08:00 (e-mails); primeiro recebimento real acompanhado;
  setup 2FA dos gestores/diretores; fila sem NF ressuscitada. (Saídas de NF não
  aparecem no histórico do Atlas — esperado, saída automática adiada.)
- **GO** = health contínuo + zero restarts + sem duplicata OMIE + logins/2FA ok +
  primeiro recebimento ok. **NO-GO** (decidir cedo): congelar PROD, repontar n8n ao UAT,
  religar operação no UAT, reconciliar o que foi criado em PROD.

## Rollback por fase

| Fase | Ação |
|---|---|
| Migrations falhou | Corrigir e retomar, OU reversão total (SQL abaixo). Sem meio-estado (psql -1). |
| Transplante falhou | Re-rodar o script (re-trunca), OU reversão total + migrations + transplante. UAT intacto. |
| Stack falhou | Corrigir env/remover stack. Volume Redis = só sessões, descartável. |
| Pós-switch n8n | Repontar `ATLAS_URL` e nó FUP para o UAT; despublicar saída de PROD; religar UAT. |
| Pós-escrita OMIE real | **Sem restore.** Ajuste contrário manual (dual) + `ativo=false`. NUNCA restaurar o backup de sexta (apagaria o avanço do espelho do n8n). Fix-forward. |

Reversão total dos objetos Atlas em PROD (não toca dados OMIE):

```sql
DROP SCHEMA IF EXISTS atlas, stockbridge, shared, hedge, forecast, breakingpoint CASCADE;
DROP VIEW IF EXISTS public.vw_hedge_receber_usd, public.vw_hedge_pagar_usd,
  public.vw_hedge_estoque, public.vw_hedge_importacoes, public.vw_hedge_resumo;
DROP TRIGGER IF EXISTS trg_auto_popular_config_produto ON public."tbl_produtos_ACXE";
DROP TABLE IF EXISTS public."tb_movimentacao_q2p_legado";
```

## Comunicação à equipe (enviar quinta)

> **Sexta 24/07, a partir das 17h30**: janela de implantação do Atlas em produção.
> A partir de segunda-feira, a plataforma oficial passa a ser **https://atlas.q2p.com.br**
> (mesmos logins e senhas de hoje; será pedido novo login no primeiro acesso).
> O endereço uat-atlas.q2p.com.br **não deve mais ser usado para operar**
> (recebimentos, aprovações, saídas) a partir de sexta 17h30 — operações feitas lá
> não terão validade e podem gerar lançamento duplicado no ERP.
> Gestores e diretores: no primeiro acesso será solicitada a configuração do
> segundo fator de autenticação (2FA).
