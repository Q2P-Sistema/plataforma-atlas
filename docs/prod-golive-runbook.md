# Runbook — Go-live do Atlas em PRODUÇÃO (atlas.q2p.com.br)

> Janela: **sexta-feira a definir (GMUD ACXEGDP-321), a partir das 17h30** (empresa
> parada no fim de semana). Release: **v1.1.12** (imagens `plasticosq2p/atlas-{api,web}:v1.1.12`).
>
> Histórico: as janelas de **24/07** (hotfix `0bfc3da`) e de **31/07** (entrada da baixa
> do pedido de compra Q2P, ACXEGDP-344) **não foram executadas** — nada foi aplicado em
> PROD. Conferido em 25/09/2026: PROD sem nenhum schema Atlas; `atlas.q2p.com.br` → 404.
> A operação seguiu no UAT, que por isso continua sendo a origem do estado.
>
> Origem do estado: banco UAT (`db.manager01.q2p.com.br:5437/acxe_q2p`) — o UAT roda
> **como produção** desde junho (OMIE real). Destino: banco PROD (`:5432/acxe_q2p`,
> espelho OMIE vivo, sem schemas Atlas até este go-live).

## Escopo da release (o que sobe além do que já existia em v1.1.9)

| Item | Jira | Impacto no deploy |
|---|---|---|
| Baixa do pedido de compra Q2P no OMIE após recebimento de importação (`AlteraPedCompra`), sem FIFO, registro de baixas (`stockbridge.baixa_pedido_q2p`), cron horário para quem aguarda vínculo | ACXEGDP-344 | migrations 0047–0051; env `STOCKBRIDGE_BAIXA_PEDIDO_Q2P_ENABLED`; cron `20 * * * *` |
| Recebimento nacional a partir da NF do fornecedor (fila do espelho, correlação fornecedor×item, baixa por recebimento externo) | ACXEGDP-328 | migration 0052; env `STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE` (obrigatória) |
| Remoção de códigos internos do OMIE das telas | ACXEGDP-313 | — |
| Flag de baixa passa a valer também no cron e no retry do painel; cron movido de `:10` para `:20` (carga da FUP pelo n8n é em `:13`) | GMUD 321 | v1.1.12 — permite religar o UAT sem escrever no OMIE |

## Resumo da estratégia

**Promoção de ambiente com transplante de estado** — não é deploy greenfield:

1. Promoção `uat`→`main` → tag `v1.1.12` → imagens de produção no Docker Hub.
2. Janela: freeze do UAT → backup manual do PROD → **52 migrations**
   (`scripts/apply-migrations-prod.sh`) → transplante dos 6 schemas Atlas
   (`scripts/copy-atlas-uat-to-prod.sh`, igualdade exata) → stack `atlas` no
   Portainer → smoke test só-leitura → switch n8n → UAT religado **com a baixa desligada**.
3. `public.*` de PROD é **intocável** (espelho vivo do n8n). Exceção controlada: a 0052
   roda `CREATE EXTENSION IF NOT EXISTS unaccent`, que **já existe em PROD** (1.1,
   conferido 25/09) → no-op.

## Pré-tarefas (semana da janela)

| # | Tarefa | Quem | Status |
|---|---|---|---|
| P0 | Liberar no firewall da DigitalOcean o IP atual de quem executa (acesso ao `db.manager01` :5432/:5437 é por IP) — testar `SELECT 1` nos dois bancos | exec | ☐ |
| P1 | DNS `atlas.q2p.com.br` → ingress com TLS | infra | ☑ 23/07 (Traefik 404 = sem router ativo) |
| P2 | Rede do Postgres :5432 = `network_swarm_public` (a mesma da stack n8n; já no stack). Falta: host interno do Postgres no `DATABASE_URL` (o mesmo da credencial Postgres do n8n) — conferir com `docker network inspect network_swarm_public` | infra | ◐ 25/09 rede definida |
| P3 | Confirmar que o cron destrutivo de sync está desativado (`sudo crontab -l`, `/etc/cron.d/`, `systemctl list-timers` — ver docs/uat-sync-autonomous-fix.md) | infra | ☐ |
| P4 | Preencher env da stack `atlas` (template `deploy/portainer/atlas.env.example`): `SESSION_SECRET` NOVO; OMIE/SendGrid/`ATLAS_INTEGRATION_KEY` copiados do UAT; **`STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE` e `STOCKBRIDGE_FISCAL_CUTOFF_DATE` com o MESMO valor do UAT** (ler no Portainer da `uat-atlas`) | infra | ☐ |
| P5 | Verificar env da instância n8n (`ATLAS_URL`, `ATLAS_INTEGRATION_KEY`) | infra | ☐ |
| P6 | Saída automática | negócio | ☑ 23/07 — **ADIADA** (ACXEGDP-322, fora do escopo) |
| P7 | Enviar comunicação à equipe (texto abaixo) | gestão | ☐ |
| P8 | Anotar NFs-testemunha no UAT: importação recebida (ex.: NF 5406, `sem_saldo`) + 1 importação pendente na fila; **nacional** recebida pela fila por NF + 1 nacional pendente | exec | ☐ |
| P9 | `scripts/apply-migrations-prod.sh --precheck-only` — 16/16 tabelas + objetos de runtime (inclui `tbl_nf_header_Q2P`, `tbl_nf_itens_Q2P`, `tbl_pedidosCompras_Q2P`) + `unaccent` | exec | ☐ (refazer na semana) |
| P10 | Ferramentas: psql/pg_dump/pg_restore ≥ 16 (servidor 16.14); ≥20 GB livres em `~/backups/atlas-golive/` | exec | ☐ |
| P11 | Promover `uat`→`main` com a correção da flag/cron → conferir tag `v1.1.12` e os manifests `atlas-api:v1.1.12` / `atlas-web:v1.1.12` no Docker Hub | exec | ☐ |
| P12 | Baixas de pedido abertas no UAT: `aguardando_vinculo`, `pendente`, `falha` = 0 no dia da janela (em 25/09: 0; 1 `sem_saldo` conhecido, NF 5406) — o que sobrar é transplantado e tratado em PROD | exec | ☐ |

## Janela de sexta — sequência

```bash
export PROD_USER=<user> PGPASSWORD_PROD='<senha>' PGPASSWORD_UAT='<senha>'
export BK=~/backups/atlas-golive && mkdir -p $BK
cd <repo> && git checkout v1.1.12
```

1. **[17:30] Freeze do UAT** — aviso no canal; n8n: desativar `ACXE - Exporta dados
   da Planilha FUP para BD e StockBridge - Rev 1.2`; Portainer: `uat-atlas_api` e
   `uat-atlas_web` → scale 0 (para também o cron horário de baixa do UAT).
2. **[17:35] Backup manual do PROD**:
   `pg_dump -h db.manager01.q2p.com.br -p 5432 -U $PROD_USER -d acxe_q2p -Fc -Z6 \
     -f "$BK/acxe_q2p_PROD_pre-atlas_$(date +%Y%m%d_%H%M).dump"` + sanity `pg_restore -l`.
3. **[paralelo] Backup dos schemas Atlas do UAT**:
   `pg_dump -h db.manager01.q2p.com.br -p 5437 -U postgres -d acxe_q2p \
     -n atlas -n stockbridge -n shared -n hedge -n forecast -n breakingpoint -Fc \
     -f "$BK/uat_atlas_schemas_$(date +%Y%m%d_%H%M).dump"`.
4. **[~18:15] Migrations (52)**: `scripts/apply-migrations-prod.sh` (confirmação dupla).
   Esperado na 0052: `WARNING: migration 0052: nenhum usuario diretor/gestor encontrado
   — seed de fornecedor_exclusao NAO aplicado` — **não abortar**: `atlas.users` ainda
   está vazia; as 2 exclusões (PLASTFIX, ACXE) chegam pelo transplante no passo 5.
5. **[~18:35] Transplante**: `scripts/copy-atlas-uat-to-prod.sh` — aceite: igualdade
   EXATA de contagens (o script falha sozinho se divergir). O relatório final lista
   também `baixa_pedido_q2p`, `correlacao_produto_fornecedor` e `fornecedor_exclusao`.
6. **[~19:00] Validação anti-duplicidade** — mesmo SQL nos DOIS bancos, hashes idênticos:
   ```sql
   -- importação: idempotência OMIE do ajuste dual + estado da baixa do pedido
   SELECT md5(string_agg(nota_fiscal||'|'||empresa||'|'||produto_codigo_acxe::text
            ||'|'||coalesce(baixa_pedido_q2p,'-'),
          ',' ORDER BY nota_fiscal, empresa, produto_codigo_acxe)), count(*)
   FROM stockbridge.movimentacao WHERE tipo_movimento='entrada_nf' AND ativo=true;
   ```
   ```sql
   -- registro de baixas: AlteraPedCompra manda quantidade ABSOLUTA; sem ele, um retry desconta 2x
   SELECT md5(string_agg(coalesce(movimentacao_id::text,'-')||'|'||coalesce(ncodped::text,'-')
            ||'|'||status||'|'||quantidade_kg::text||'|'||coalesce(saldo_novo_kg::text,'-'),
          ',' ORDER BY id)), count(*)
   FROM stockbridge.baixa_pedido_q2p WHERE ativo=true;
   ```
   ```sql
   -- nacional por NF: idempotência do caminho novo (feature 015)
   SELECT md5(string_agg(nf_chave_acesso||'|'||nf_item_descricao_normalizada||'|'||produto_codigo_q2p::text,
          ',' ORDER BY nf_chave_acesso, nf_item_descricao_normalizada, produto_codigo_q2p)), count(*)
   FROM stockbridge.movimentacao
   WHERE subtipo='compra_nacional' AND ativo=true AND nf_chave_acesso IS NOT NULL;
   ```
   ```sql
   SELECT md5(string_agg(nota_fiscal, ',' ORDER BY nota_fiscal)), count(*)
   FROM stockbridge.movimentacao_legado WHERE ativo=true;   -- 870 em 25/09
   ```
7. **[~19:15] Deploy da stack `atlas`** no Portainer (`deploy/portainer/atlas.stack.yml`
   + env preenchido; `ATLAS_VERSION=v1.1.12`). Healthchecks verdes.
   **Atenção — stack legada**: já existiu uma stack `atlas` antiga (imagens `:latest`,
   rede `network_dev_swarm_public`, env de DEV com `SEED_ADMIN_*`). Se ainda existir no
   Portainer, **substituir o compose inteiro e LIMPAR o env antigo** — não herdar
   `SEED_ADMIN_*` nem `DATABASE_URL` de DEV, e remover a rede de DEV.
8. **[~19:30] Smoke test SÓ-LEITURA** (ninguém recebe/aprova/dá saída):
   - `curl -s https://atlas.q2p.com.br/api/v1/health` → healthy, 4 módulos enabled;
   - log da API: `Cron registrado: alerta-comodato-vencido` e
     `Cron registrado: baixa-pedido-aguardando-vinculo (20 * * * * BR)`;
   - TLS Let's Encrypt emitido; login de usuário real do UAT funciona (senha atual);
   - gestor/diretor cai no setup de 2FA (esperado — `AUTH_2FA_ENABLED=true`);
   - Cockpit StockBridge com números na ordem de grandeza do UAT;
   - **Fila de importação: NF-testemunha recebida NÃO aparece; NF pendente aparece**;
   - **Aba "Compra nacional"** carrega (sem 503 — senão falta a data de corte); NF
     nacional recebida NÃO aparece; a pendente aparece;
   - **Movimentações → coluna "Pedido Q2P"** preenchida; painel de baixas pendentes
     (`GET /api/v1/stockbridge/baixa-pedido/pendentes`) igual ao do UAT;
   - Hedge/Forecast/BreakingPoint carregam; logs sem stack trace.
9. **[~19:50] Switch n8n → PROD** (nesta ordem):
   a. Env da instância n8n: `ATLAS_URL=https://atlas.q2p.com.br` → redeploy;
   b. Workflow FUP Rev 1.2, nó `POST nf-pedido-mapa` (hoje em `uat-atlas`): URL →
      `https://atlas.q2p.com.br/api/v1/stockbridge/admin/nf-pedido-mapa` → reativar →
      executar uma vez → 200 ok;
   c. Saída automática: **nada a fazer** (adiada — P6);
   d. Garantir que NENHUM workflow aponta mais para `uat-atlas`.
10. **[~20:15] Teste controlado OMIE (opcional)** — negativo: re-receber NF-testemunha
    → bloqueio por idempotência. Positivo: 1 recebimento real pequeno → um único
    `cod_int_ajuste` nas duas empresas no OMIE + e-mails ok (+ baixa do pedido Q2P se
    for importação com vínculo). Daqui em diante: fix-forward.
11. **[~20:30] MCP `pg-acxe`** enxerga schemas Atlas (observabilidade do fim de semana).
12. **[~20:40] Religar UAT só para consulta**: no env da stack `uat-atlas`,
    **`STOCKBRIDGE_BAIXA_PEDIDO_Q2P_ENABLED=false`** → scale 1. Conferir no log:
    `Baixa de pedido Q2P desligada por configuração — reprocessamento não roda` na
    rodada `:20`. Sem nenhum apontamento n8n para o UAT. Se não der para mudar o env
    na janela, **manter o UAT em scale 0**.
13. **[~20:50] Encerramento** — snapshot dia-zero dos schemas Atlas de PROD para `$BK`.

## Fim de semana + segunda (go/no-go)

- **Sáb/dom 2×/dia**: `/health`; `docker service ps` sem restarts; execuções n8n verdes.
- **Domingo pós-05:00** (FullSync NF semanal), no PROD:
  ```sql
  SELECT to_regclass('public.vw_hedge_resumo') IS NOT NULL AS vw_ok,
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_auto_popular_config_produto') AS trigger_ok;
  ```
- Frescor do espelho: `SELECT max(synced_at) FROM public."tbl_nf_header_ACXE";` e
  `..."tbl_nf_header_Q2P"` acompanham o relógio.
- Registro de baixas em PROD não ganha linha sem recebimento real (o cron só reprocessa
  pendências): `SELECT max(created_at) FROM stockbridge.baixa_pedido_q2p;`.
- Uso indevido do UAT: `SELECT max(created_at) FROM shared.audit_log;` **no UAT** não
  avança além de sexta 17h30 (exceto logins de consulta).
- **Segunda**: cron comodato 08:00 (e-mails); digest "aguardando vínculo > 3 dias" à
  Comex na rodada 08:20 (só se houver); primeiro recebimento real de importação e de
  nacional acompanhados; setup 2FA dos gestores/diretores; fila sem NF ressuscitada.
- **GO** = health contínuo + zero restarts + sem duplicata OMIE (ajuste e pedido) +
  logins/2FA ok + primeiro recebimento ok. **NO-GO** (decidir cedo): congelar PROD,
  repontar n8n ao UAT, religar operação no UAT (voltar a flag de baixa para `true`),
  reconciliar o que foi criado em PROD.

## Rollback por fase

| Fase | Ação |
|---|---|
| Migrations falhou | Corrigir e retomar, OU reversão total (SQL abaixo). Sem meio-estado (psql -1). |
| Transplante falhou | Re-rodar o script (re-trunca), OU reversão total + migrations + transplante. UAT intacto. |
| Stack falhou | Corrigir env/remover stack. Volume Redis = só sessões, descartável. |
| Pós-switch n8n | Repontar `ATLAS_URL` e nó FUP para o UAT; religar UAT com a flag de baixa `true`. |
| Pós-escrita OMIE real | **Sem restore.** Ajuste contrário manual (dual) + `ativo=false`; baixa de pedido indevida → `backfill-baixa-pedido-q2p --desfazer <nf> --motivo` (com `DATABASE_URL` de PROD). NUNCA restaurar o backup de sexta (apagaria o avanço do espelho do n8n). Fix-forward. |

Reversão total dos objetos Atlas em PROD (não toca dados OMIE):

```sql
DROP SCHEMA IF EXISTS atlas, stockbridge, shared, hedge, forecast, breakingpoint CASCADE;
DROP VIEW IF EXISTS public.vw_hedge_receber_usd, public.vw_hedge_pagar_usd,
  public.vw_hedge_estoque, public.vw_hedge_importacoes, public.vw_hedge_resumo;
DROP TRIGGER IF EXISTS trg_auto_popular_config_produto ON public."tbl_produtos_ACXE";
DROP TABLE IF EXISTS public."tb_movimentacao_q2p_legado";
-- NÃO remover a extensão unaccent: ela já existia em PROD antes do Atlas.
```

## Pós-go-live

- Aposentar `scripts/sync-omie-public-prod-to-uat.sh` (o UAT deixa de operar).
- `backfill-baixa-pedido-q2p` (`--consultar`, `--desfazer`, `--encerrar`) passa a rodar com o
  `DATABASE_URL` de PROD.
- Ativação da saída automática: ACXEGDP-322.

## Comunicação à equipe (enviar na véspera)

> **Sexta-feira DD/MM, a partir das 17h30**: janela de implantação do Atlas em produção.
> A partir de segunda-feira, a plataforma oficial passa a ser **https://atlas.q2p.com.br**
> (mesmos logins e senhas de hoje; será pedido novo login no primeiro acesso).
> O endereço uat-atlas.q2p.com.br **não deve mais ser usado para operar**
> (recebimentos de importação e nacionais, aprovações, saídas) a partir de sexta 17h30 —
> operações feitas lá não terão validade e podem gerar lançamento duplicado no ERP.
> Gestores e diretores: no primeiro acesso será solicitada a configuração do
> segundo fator de autenticação (2FA).
