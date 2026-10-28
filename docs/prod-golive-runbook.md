# Runbook — Go-live do Atlas em PRODUÇÃO (atlas.q2p.com.br)

> **Executado em domingo 04/10/2026, 19:11–21:40** (GMUD ACXEGDP-321), com a release
> **v1.1.14**. GMUD encerrada em 06/10/2026 com PIR (resultado, desvios e lições no card).
> Correção do 1º dia: v1.1.15 (ACXEGDP-406, baixa do pedido Q2P × cache do OMIE).
> Este documento fica como registro do plano executado e base para a próxima mudança
> com transplante de estado. Diferenças entre o plano e a execução (Redis em stack
> separada `redis_atlas`, sintaxe da imagem, host do banco, data de corte nacional) estão
> no PIR e já refletidas em `deploy/portainer/atlas.stack.yml` e `atlas.env.example`.
>
> Histórico: as janelas de **24/07** (hotfix `0bfc3da`) e de **31/07** (entrada da baixa
> do pedido de compra Q2P, ACXEGDP-344) **não foram executadas**; a operação seguiu no
> UAT até 04/10, por isso ele foi a origem do estado.
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
| Movimentações: recebimento nacional pela NF deixa de aparecer como "Entrada manual" (PR #108) | ACXEGDP-328 | v1.1.13 — só código, sem migration nem env |
| Recebimento fiscal da NF nacional pelo Atlas via API OMIE (`AlterarRecebimento` + `ConcluirRecebimento`), fila com duas fontes, dispensa de NF com aviso ao fiscal | ACXEGDP-395 (feature 016, PR #115) | migration 0053 (53 no total); envs `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` (default `false`), `STOCKBRIDGE_FISCAL_EMAILS` (vazio), `STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN` (120); espelho `tbl_recebimentoNFe_*` alimentado pelo n8n |

## Resumo da estratégia

**Promoção de ambiente com transplante de estado** — não é deploy greenfield:

1. Promoção `uat`→`main` → tag `v1.1.14` → imagens de produção no Docker Hub.
2. Janela: freeze do UAT → backup manual do PROD → **53 migrations**
   (`scripts/apply-migrations-prod.sh`) → transplante dos 6 schemas Atlas
   (`scripts/copy-atlas-uat-to-prod.sh`, igualdade exata) → stack `atlas` no
   Portainer → smoke test só-leitura → switch n8n → UAT religado **com a baixa desligada**.
3. `public.*` de PROD é **intocável** (espelho vivo do n8n). Exceções controladas: a 0052
   roda `CREATE EXTENSION IF NOT EXISTS unaccent`, que **já existe em PROD** (1.1,
   conferido 25/09) → no-op; a 0053 (feature 016) tem `CREATE TABLE IF NOT EXISTS` de
   `public."tbl_recebimentoNFe_Q2P"`/`_itens_Q2P` — no PROD essas tabelas são criadas
   **antes**, à mão (DBeaver), para o n8n gravar o espelho → no-op também. Conferir com
   `to_regclass` antes da janela; se não existirem, a 0053 as cria vazias e o n8n passa a gravar.

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
| P9 | `scripts/apply-migrations-prod.sh --precheck-only` — 16/16 tabelas + objetos de runtime (inclui `tbl_nf_header_Q2P`, `tbl_nf_itens_Q2P`, `tbl_pedidosCompras_Q2P`, `tbl_recebimentoNFe_Q2P` e `_itens_Q2P` — espelho do n8n, já existe em PROD desde 02/10) + `unaccent` | exec | ☐ (refazer na semana) |
| P10 | Ferramentas: psql/pg_dump/pg_restore ≥ 16 (servidor 16.14); ≥20 GB livres em `~/backups/atlas-golive/` | exec | ☐ |
| P11 | Promover `uat`→`main` → conferir tag `v1.1.14` e os manifests `atlas-api:v1.1.14` / `atlas-web:v1.1.14` no Docker Hub | exec | ☐ |
| P12 | Baixas de pedido abertas no UAT: `aguardando_vinculo`, `pendente`, `falha` = 0 no dia da janela (em 25/09: 0; 1 `sem_saldo` conhecido, NF 5406) — o que sobrar é transplantado e tratado em PROD | exec | ☐ |
| P13 | **Decisão GMUD — `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` em PROD**: default `false` no template. Ligar só depois de avisar o fiscal (Gustavo) que a compra nacional da Q2P deixa de ser concluída no portal. Se ligar na janela, avisar antes; se ligar depois, em dia útil com o fiscal presente | negócio | ☐ |
| P14 | **Decisão GMUD — `STOCKBRIDGE_FISCAL_EMAILS` em PROD**: vazio (padrão: NFe ACXE, Mauricio Yared, Gustavo Dreer). O valor de teste do UAT aponta para a caixa do Flavio e não vai para PROD | negócio | ☐ |
| P15 | **Decisão GMUD — `STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN` em PROD**: padrão 120 (n8n grava a cada 30 min). Conferir `STOCKBRIDGE_OPS_EMAIL`, que recebe o alerta de espelho defasado (cron `5,35`) | negócio | ☐ |
| P16 | Subir `max_connections` do UAT (hoje 20, 3 reservadas) antes da janela — o DBeaver já segurou 11 conexões e travou o `claude_ro` em 04/10 | exec | ☐ |
| P17 | Refazer a cópia PROD→UAT do espelho `tbl_recebimentoNFe_*` no dia (senão o UAT mostra fiscal defasado) | exec | ☐ |

## Janela de sexta — sequência

```bash
export PROD_USER=<user> PGPASSWORD_PROD='<senha>' PGPASSWORD_UAT='<senha>'
export BK=~/backups/atlas-golive && mkdir -p $BK
cd <repo> && git checkout v1.1.14
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
4. **[~18:15] Migrations (53)**: `scripts/apply-migrations-prod.sh` (confirmação dupla).
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
   + env preenchido; `ATLAS_VERSION=v1.1.14`). Healthchecks verdes.
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
    **`STOCKBRIDGE_BAIXA_PEDIDO_Q2P_ENABLED=false`** e **`STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=false`**
    → scale 1. Sem o segundo, o UAT segue concluindo recebimento fiscal no OMIE real e as
    duas instâncias passam a mexer nas mesmas NFs. Conferir no log:
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
DROP TRIGGER IF EXISTS trg_auto_popular_config_produto ON public."tbl_produtos_ACXE";
DROP TABLE IF EXISTS public."tb_movimentacao_q2p_legado";
-- NÃO remover a extensão unaccent: ela já existia em PROD antes do Atlas.
-- NÃO remover as views public.vw_hedge_*: já existiam em PROD antes do Atlas
-- (criadas à mão, dono claude_coder). As migrations 0006/0041 só as substituem
-- por definição idêntica, e nenhuma depende dos schemas Atlas.
-- Ensaiado em 04/10/2026 numa cópia do schema de PROD: as 53 migrations passam
-- (só o WARNING esperado da 0052) e esta reversão devolve o public a 116
-- tabelas / 48 views, como antes.
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

## Ativação da feature 017 — recebimento nacional com pedido de compra (ACXEGDP-437)

De 21/10/2026 a 22/10/2026 a chave `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` ficou `false` em PROD
(contenção). A receita da 016 (`EDITAR → IGNORAR → Concluir`) desfaz o vínculo do item com
o pedido de compra (PC) que compras lança no OMIE. A 017 conclui o fiscal mantendo ou
gravando o vínculo e só usa o `IGNORAR` em item sem PC.

**Estado em 22/10/2026**: os passos abaixo foram executados até a religação em PROD (passo 6). A 0056 foi aplicada, a imagem
v1.1.20 está no ar, o teste do vínculo novo (T033, NF 60199 da Zaraplast) foi aprovado e a chave
foi religada em PROD às ~14h50 (horário de Brasília). A rodada de ajustes do mesmo dia (PC por NF,
PC de outro cadastro, trava de unidade e cache de PCs vistos) tem os seus passos na subseção
"Rodada de ajustes de 22/10/2026", mais abaixo.

**Pré-requisitos já atendidos**

- Cópia de PCs na Rev 1.5 (`qPJFEIY1PQ2LDQG2`), no ar desde 21/10/2026.
- Espelho de recebimentos da Q2P gravando o vínculo (`CJWpHyJEXoHCGkOt` Rev 1.1, no ar desde
  21/10/2026 22:40). As 4 colunas de pedido foram aplicadas em PROD com o mesmo texto da 0056.
- Teste do `ASSOCIAR-PEDIDO` com NF real (T033): feito e aprovado em 22/10/2026, na NF 60199 da
  Zaraplast contra o PC 306, inclusive com PC de outro cadastro do mesmo fornecedor. Detalhes em
  `specs/017-recebimento-nacional-com-pc/research.md` (D2). Não testada: troca de um vínculo
  existente. A NF menor que o saldo do PC foi confirmada em 23/10/2026 (NF 67988 contra o PC 305):
  o OMIE aceita, e o PC fica "recebido parcialmente", com o saldo em aberto.

**Ordem** (não inverter os passos 1 e 3):

1. **Migration 0056** em PROD. É aditiva (`IF NOT EXISTS`, CHECK ampliado), então convive com a
   imagem atual. Precisa vir **antes** da imagem: a 017 lê as colunas de pedido do espelho na fila
   e grava `empresa` no ledger fiscal e as linhas de `recebimento_fiscal_pc`. Sem a 0056, onde o
   espelho não tem as 4 colunas (UAT sem a cópia do PROD) a fila responde
   `503 FILA_NACIONAL_NAO_CONFIGURADA`; em PROD (colunas já criadas) a fila abre, mas o fiscal com
   PC falha ao gravar o ledger e o PC vinculado pelo Atlas some do detalhe.

   O repo não usa o runner do drizzle-kit, e o `scripts/apply-migrations-prod.sh` reaplica tudo
   (e recusa banco que já tem schema Atlas): aplicar **só o arquivo da 0056**, com o `PROD_USER`
   da janela de go-live (o dono dos objetos: em 22/10/2026 as tabelas `stockbridge.*` e as do
   espelho `tbl_recebimentoNFe_*` são do usuário `postgres`, e a migration altera
   `stockbridge.recebimento_fiscal`, o que exige ser dono). Host e porta de PROD são os de
   sempre; o psql pede a senha:

   ```bash
   export PROD_USER=<usuario-prod>
   PGOPTIONS='-c lock_timeout=5s' psql -h db.manager01.q2p.com.br -p 5432 -U "$PROD_USER" -d acxe_q2p \
     -1 -q -v ON_ERROR_STOP=1 -f packages/db/migrations/0056_stockbridge_recebimento_nacional_pc.sql
   echo "exit=$?"
   ```

   - `-1` aplica tudo numa transação (ou tudo, ou nada). `ON_ERROR_STOP=1` faz o erro virar
     `exit 3`; sem ele o psql desfaz tudo e ainda sai com 0. `lock_timeout=5s` evita ficar preso
     atrás de uma transação longa.
   - **Esperado**: `exit=0` e nenhuma linha `ERROR`. `NOTICE` é normal: `trigger ... does not
     exist, skipping` na 1ª execução e, do bloco `DO` do começo da migration, `as 4 colunas de
     pedido do espelho ... já existem — tabela não alterada`. Em PROD as 4 colunas já existem
     (aplicadas em 21/10/2026, ver os pré-requisitos), então a migration **não altera** a tabela
     do espelho que a fila lê ao vivo; o `ALTER` só roda onde faltar coluna (ex.: UAT sem a
     cópia PROD→UAT).
   - **`exit=3` ou `ERROR: canceling statement due to lock timeout`**: nada foi aplicado. Achar
     quem segura o lock (`SELECT pid, state, xact_start, left(query, 80) FROM pg_stat_activity
     WHERE datname = 'acxe_q2p' AND xact_start IS NOT NULL ORDER BY xact_start;`), esperar a
     transação terminar (ou combinar o encerramento com o dono da sessão) e **repetir o mesmo
     comando**: a migration é idempotente. Outro `ERROR` (permissão, objeto ausente): corrigir a
     causa e repetir; não seguir para a imagem.
   - **Conferência obrigatória, logo depois e antes da imagem** (somente leitura):

     ```sql
     SELECT to_regclass('stockbridge.recebimento_fiscal_pc'),
            to_regclass('stockbridge.nf_aviso_compras'),
            (SELECT count(*) FROM information_schema.columns
              WHERE table_schema = 'stockbridge' AND table_name = 'recebimento_fiscal'
                AND column_name IN ('empresa', 'itens_vinculados')) AS colunas_ledger,
            (SELECT count(*) FROM pg_trigger
              WHERE tgname IN ('trg_audit_sb_recebimento_fiscal_pc', 'trg_audit_sb_nf_aviso_compras')
                AND NOT tgisinternal) AS triggers;
     ```

     Esperado: os dois `to_regclass` **não nulos**, `colunas_ledger = 2` e `triggers = 2`. Qualquer
     outro resultado: **não subir a imagem**; reaplicar a migration. E as 4 colunas de pedido do
     espelho (em PROD já eram 4 em 22/10/2026):
     `SELECT count(*) FROM pg_attribute WHERE attrelid = to_regclass('public."tbl_recebimentoNFe_itens_Q2P"') AND attname IN ('n_id_pedido', 'n_id_it_pedido', 'n_num_ped_compra', 'c_num_it_ped_compra') AND NOT attisdropped;`
     deve dar 4.
2. **Variáveis** no Portainer: o `atlas.stack.yml` já lista as cinco.
   - `STOCKBRIDGE_COMPRAS_EMAILS` deve ter os destinatários de compras, separados por
     **vírgula** (sem ponto e vírgula): valor inválido derruba a API no boot. Vazio, o aviso vai
     para o `STOCKBRIDGE_OPS_EMAIL`.
   - Os defaults das outras são `EXIGE_PC=true`, 2%/1% e cópia de PCs 120 min.
3. **Imagem com a 017** (nova `ATLAS_VERSION`), **com a chave da 016 ainda `false`**.
4. **Conferir**:
   - `GET /api/v1/stockbridge/health`: com a chave desligada, `pedidosCompraCopia.status` é
     `desligado`; depois de religar, `pedidosCompraCopiaIdadeMin` deve ficar abaixo de 120;
   - o detalhe de uma NF com fiscal já feito mostra, por item, o selo de PC vinculado no OMIE. O
     número só entra no texto ("PC 304 vinculado no OMIE") quando o PC ainda está na cópia de PCs
     ou foi vinculado pelo próprio Atlas; a NF 7813 mostra "PC vinculado no OMIE" **sem número**,
     porque o PC 304 já saiu da cópia (recebido por inteiro) e o fiscal dela foi feito pelo teste do
     n8n. Critério de aceite: a presença do selo, não o número;
   - NF concluída no portal sem "não movimentar estoque" aparece com "Estoque já lançado pelo
     OMIE" e não pode ser recebida.
5. **Teste do vínculo novo** (`ASSOCIAR-PEDIDO`) com uma NF real sem vínculo, com
   autorização, como foi feito na NF 7813 (tarefa T033). **Feito em 22/10/2026 (NF 60199)**;
   resultado na research D2 da 017. Registrar também na ACXEGDP-437.
6. **Religar** `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=true`: primeiro no UAT, depois em
   PROD, em dia útil e com o fiscal avisado. Acompanhar as primeiras NFs reais (SC-007).

**Atenção**: religar a chave com uma imagem anterior à 017 traz de volta o `IGNORAR`, que é o
problema original.

**Rodada de ajustes de 22/10/2026 (0057 + imagem seguinte à v1.1.20)**

A NF 60199 (Zaraplast × PC 306), a primeira recebida pelo Atlas com a chave religada, mostrou quatro
ajustes: o OMIE baixa o PC na unidade da NF sem converter, o PC some da lista de pendentes, o PC da
matriz serve à NF da filial e a escolha do PC por item é repetitiva. Eles estão no código desta
rodada (research D14 a D17) e **não estão na v1.1.20**.

- **Até a imagem desta rodada subir**, a trava de unidade não existe em PROD: NF em toneladas contra
  PC em kg baixa o PC com a quantidade na unidade da NF (8,25 em vez de 8.250 kg). A mitigação é
  operacional: conferir o `nQtdeRec` do PC depois da conclusão e, se estiver na unidade errada,
  corrigir pelo portal, como na NF 60199 (reverter o recebimento, editar a quantidade recebida de
  cada item para o valor na unidade do PC e concluir de novo). Com a D21 da 017 no ar (seção
  "Fiscal revertido no OMIE", no fim), o Atlas enxerga essa reversão: entre a reversão e a nova
  conclusão a NF aparece como fiscal pendente, com o selo "Fiscal revertido no OMIE", e o operador
  não deve dar entrada nessa janela (um clique faria o Atlas concluir o fiscal em paralelo à
  correção). A conclusão posterior do fiscal no portal reclassifica a NF como "fiscal já feito".

Ordem:

1. **Migration 0057** (cache de PCs vistos, `stockbridge.pedido_compra_visto`), **antes** da imagem.
   É aditiva: só cria uma tabela nova (`CREATE TABLE IF NOT EXISTS`, índices e trigger de
   auditoria), não altera nenhuma tabela existente e convive com a v1.1.20. Também é
   **best-effort**: sem a tabela nada deixa de funcionar (a sugestão registra um aviso e segue só
   com a cópia de PCs), mas o detalhe perde o PC que sai da lista de pendentes e o número do PC das
   NFs com fiscal já feito. Por isso vai antes. Mesmo comando da 0056, com o arquivo da 0057:

   ```bash
   export PROD_USER=<usuario-prod>
   PGOPTIONS='-c lock_timeout=5s' psql -h db.manager01.q2p.com.br -p 5432 -U "$PROD_USER" -d acxe_q2p \
     -1 -q -v ON_ERROR_STOP=1 -f packages/db/migrations/0057_stockbridge_pedido_compra_visto.sql
   echo "exit=$?"
   ```

   - **Esperado**: `exit=0` e nenhuma linha `ERROR`. `NOTICE: trigger ... does not exist, skipping`
     é normal na 1ª execução. Em caso de `exit=3` ou erro de lock, nada foi aplicado: repetir o
     mesmo comando (idempotente).
   - **Conferência obrigatória, antes da imagem** (somente leitura):

     ```sql
     SELECT to_regclass('stockbridge.pedido_compra_visto'),
            (SELECT count(*) FROM pg_trigger
              WHERE tgname = 'trg_audit_sb_pedido_compra_visto' AND NOT tgisinternal) AS triggers;
     ```

     Esperado: `to_regclass` **não nulo** e `triggers = 1`. Outro resultado: reaplicar a migration
     antes de subir a imagem.
2. **Variável nova** no Portainer: `STOCKBRIDGE_PC_UNIDADE_DIFERENTE`, já listada no
   `atlas.stack.yml` com default `bloquear`. Na rodada de 22/10 ficou `bloquear`: o campo
   `nQtdeRecebida` tinha sido validado no portal, ainda não pela API. O modo `converter` foi validado
   pela API em PROD em 25/10/2026 (tarefa T073, NF 19252 em toneladas contra o PC 308 em kg, com
   autorização) e ligado em PROD no mesmo dia (T074). O default do `atlas.stack.yml` continua
   `bloquear`: ao refazer a stack, manter `converter` na variável do Portainer.
3. **Imagem seguinte à v1.1.20** (nova `ATLAS_VERSION`), com a chave da 016 já `true`.
4. **Conferir**:
   - o cache se povoa sozinho (cron `5,35` ou ao abrir uma NF):
     `SELECT count(*), max(visto_em) FROM stockbridge.pedido_compra_visto WHERE empresa = 'q2p';`
     deve dar mais de zero em até 30 minutos;
   - o detalhe de uma NF com PC mostra o PC uma vez para a nota, com o número e o saldo;
   - NF em toneladas contra PC só em kg, no modo `bloquear`: o PC aparece não selecionável, com o
     motivo de unidade, e o POST responde `422 NF_SEM_PC`.

**Rollback**: voltar `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` para `false` na stack e atualizar a
stack. A chave é lida uma vez, na subida do processo, então o container é recriado: é um redeploy
rápido, sem trocar a imagem nem mexer em migration. Com a imagem da 017 e a chave `false`, as
dispensas e o bloqueio de estoque já lançado continuam valendo. A 0056 pode ficar, porque é
aditiva e convive também com a imagem anterior. Idem a 0057: voltar para a v1.1.20 deixa a tabela
do cache parada, sem efeito.

**UAT**:
- a 0056 vai por `psql -1 -f`, como a 0053: o comando do passo 1 com `-p 5437 -U postgres`, e a
  mesma conferência depois; a 0057 idem, com o arquivo dela e a conferência da rodada de 22/10;
- `STOCKBRIDGE_PC_UNIDADE_DIFERENTE`: no UAT (`OMIE_MODE=leitura`, escritas simuladas) o modo
  `converter` pode ser exercitado para conferir o `EDITAR` na sombra, mas isso não prova o
  comportamento do OMIE (o T073 foi feito em PROD em 25/10/2026);
- as colunas do espelho chegam pela cópia PROD→UAT ou pela própria 0056 (o bloco `DO` do começo
  da migration só as cria se faltar alguma);
- `STOCKBRIDGE_COPIA_PCS_MAX_MIN=1440`, porque a cópia de PCs também chega pela cópia PROD→UAT.
  Com um limite curto, o modo seguro recusaria toda NF com fiscal pendente.

## Ativação da Fase 2 da 017 — compra nacional da ACXE (ACXEGDP-437, História 5)

A imagem da Fase 2 pode subir com a chave da ACXE **desligada**: com
`STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED=false` a fila e a tela da Q2P ficam como estão (a
única mudança visível é a exclusão de fornecedor passar a valer por empresa). Ligar a chave é um
passo separado, depois do n8n da ACXE e de um teste controlado no OMIE da ACXE. Desenho e decisões em
`specs/017-recebimento-nacional-com-pc/research.md` (D18).

**Ordem**

1. **Migration 0058** em PROD, **antes** da imagem, só o arquivo, com o dono dos objetos (`postgres`),
   como a 0056:

   ```bash
   export PROD_USER=<usuario-prod>
   PGOPTIONS='-c lock_timeout=5s' psql -h db.manager01.q2p.com.br -p 5432 -U "$PROD_USER" -d acxe_q2p \
     -1 -q -v ON_ERROR_STOP=1 -f packages/db/migrations/0058_stockbridge_recebimento_nacional_acxe.sql
   echo "exit=$?"
   ```

   - Esperado: `exit=0`. `NOTICE` normais: as duas tabelas do espelho da ACXE "já existem — não
     alterada" (em PROD foram criadas vazias em 21/10/2026), `index ... does not exist, skipping` na
     1ª execução. Reaplicar é seguro.
   - O que muda: `fornecedor_exclusao.empresa` (as exclusões atuais ficam `q2p`; a Q2P matriz e filial
     entram como excluídas na fila da ACXE), o tipo `operacional` e os locais 20.0.5/20.0.7 (com a
     correlação só da ACXE), o índice de idempotência da ACXE, o índice da 0052 refeito só para a Q2P
     (lock de escrita em `stockbridge.movimentacao` durante o `CREATE INDEX`, segundos) e duas colunas
     em `pedido_compra_visto`.
   - **Sem a 0058, a imagem nova quebra a fila nacional da Q2P** (a consulta passa a filtrar
     `fornecedor_exclusao.empresa`). Não inverter.
   - Conferência (somente leitura):

     ```sql
     SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'stockbridge'
               AND table_name = 'fornecedor_exclusao' AND column_name = 'empresa') AS fe_empresa,
            (SELECT count(*) FROM stockbridge.fornecedor_exclusao
               WHERE empresa = 'acxe' AND reincluido_em IS NULL) AS q2p_excluida_na_acxe,   -- 2
            (SELECT count(*) FROM stockbridge.localidade WHERE codigo IN ('20.0.5','20.0.7')
               AND tipo = 'operacional') AS locais_operacionais,                          -- 2
            to_regclass('stockbridge.movimentacao_nf_nacional_acxe_idempotencia_idx') AS idx_acxe,
            (SELECT pg_get_indexdef('stockbridge.movimentacao_nf_nacional_idempotencia_idx'::regclass)
               LIKE '%empresa%') AS idx_0052_so_q2p,                                       -- true
            (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'stockbridge'
               AND table_name = 'pedido_compra_visto'
               AND column_name IN ('n_cod_prod','codigo_local_estoque')) AS cache_colunas;  -- 2
     ```

2. **Imagem nova** com as variáveis no YAML (já no `atlas.stack.yml`):
   `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED: ${…:-false}` e
   `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE: ${…:-}`. Conferir a fila e o detalhe da Q2P
   (Ctrl+Shift+R antes de reprovar qualquer item de tela).
3. **n8n "ACXE - Exporta Recebimentos NF-e"** (`xqgvUZ1X9P52EDbH`; **ativo desde 23/10/2026**, T052 feito): ativar, deixar rodar e
   conferir que `public."tbl_recebimentoNFe_ACXE"` traz os recebimentos **pendentes e os já recebidos**
   (o histórico é o que permite detectar NF recebida no portal com estoque). T052.
4. **Teste controlado em PROD** (T076), no modelo do T033, com a próxima NF da Solutec contra o PC 580:
   fiscal com o vínculo no OMIE da ACXE e, na aprovação, `ENT/INI` só na ACXE no 20.0.7; depois uma
   entrada num local que também é da Q2P (21.1), conferindo o mesmo valor nas duas empresas e a
   Conferência de Estoque. É a primeira escrita do Atlas no OMIE da ACXE por esse caminho.
   **Em 26/10/2026 a chave foi ligada antes deste passo**, por decisão do usuário: não havia NF da Solutec pendente, e o
   primeiro recebimento da ACXE passa a ser o teste, acompanhado.
5. **Ligar** (feito em 26/10/2026, com o corte em 26/10): `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE` com a data da ativação (NF da ACXE
   emitida antes dela nunca entra na fila; 13 NFs desde 11/09/2026 já foram recebidas no portal com
   estoque) e `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED=true`, com "Update the stack". A chave
   só vale com `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=true`. Conferir `GET /api/v1/stockbridge/health`:
   `recebimentoNfeEspelhoAcxe` e `pedidosCompraCopiaAcxe` deixam de ser `desligado`.
6. **Combinar com a equipe da ACXE** que a compra nacional passa a ser recebida pelo Atlas: NF
   concluída no portal com estoque aparece na fila como "estoque já lançado pelo OMIE" e fica
   bloqueada (o gestor dispensa).

**Desligar**: `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED=false` e "Update the stack": as NFs da
ACXE saem da fila; aprovações já criadas continuam aprovando normalmente.

## Baixa do PC pelo peso conferido (ACXEGDP-437, research D20) e correção da fila (D19)

Duas peças, em dois PRs. A correção da fila sobe primeiro, sozinha, e não depende de migration nem de variável.
O PR dela mexe em `fila-nacional.service.ts` e, na retomada de item 1:N, em `recebimento-nacional.service.ts`,
além dos testes, do golden da Q2P, da D19 e do `CLAUDE.md`:

- **Correção da fila (D19)**: sem migration e sem variável. A fila passa a considerar o item recebido quando o
  Atlas já atingiu a quantidade do XML ou a da nota de entrada. Resolve a NF 67988, que
  voltou à fila com 118 kg depois do ajuste da quantidade recebida no portal. Com a imagem nova, ela sai da
  fila sozinha. Na retomada de um item dividido em vários produtos (um falhou ou foi rejeitado), o lado da NF
  de cada produto refeito passa a ser o restante da fila.
- **Baixa pelo peso conferido (D20)**: atrás da chave `STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO`, **desligada** por
  padrão. Com a chave desligada, o Atlas não manda ao PC quantidade acima da NF e o recebimento segue como hoje.

**Ordem**

1. **Migration 0059** em PROD, **antes** da imagem que traz a D20, com o dono dos objetos (`postgres`):

   ```bash
   export PROD_USER=<usuario-prod>
   PGOPTIONS='-c lock_timeout=5s' psql -h db.manager01.q2p.com.br -p 5432 -U "$PROD_USER" -d acxe_q2p \
     -1 -q -v ON_ERROR_STOP=1 -f packages/db/migrations/0059_stockbridge_pc_peso_conferido.sql
   echo "exit=$?"
   ```

   - Esperado: `exit=0`. Reaplicar é seguro (`NOTICE ... already exists, skipping`).
   - O que muda: a coluna `stockbridge.recebimento_fiscal_pc.kg_recebido_pc` (nula, com CHECK `> 0`) e o
     motivo `excedente_rejeitado` no CHECK de `stockbridge.nf_aviso_compras`. As duas tabelas são pequenas.
   - Sem a 0059, a imagem nova sobe e o fiscal segue pela NF: o código confere a coluna, as reservas usam
     a quantidade da NF e a chave fica sem efeito, com erro no log ("Coluna ... kg_recebido_pc ausente").
     Mesmo assim, aplicar antes da imagem.
   - **UAT**: o mesmo arquivo, com `psql -1 -f` no banco do UAT (como a 0053), antes da imagem `:uat`.
   - Conferência (somente leitura):

     ```sql
     SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'stockbridge'
               AND table_name = 'recebimento_fiscal_pc' AND column_name = 'kg_recebido_pc') AS coluna,      -- 1
            (SELECT pg_get_constraintdef(oid) LIKE '%excedente_rejeitado%' FROM pg_constraint
               WHERE conname = 'nf_aviso_compras_motivo_check') AS motivo_novo;                              -- true
     ```

2. **Imagem nova** com `STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO: ${…:-false}` e
   `STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT: ${…:-10}` no YAML (já no `atlas.stack.yml`). Conferir a fila (a
   67988 sumiu), o detalhe de uma NF com PC e que o log não tem "kg_recebido_pc ausente".
3. **Primeiro uso acompanhado** (T085, com autorização): ligar a chave com "Update the stack" e conferir ao
   vivo a próxima NF recebida "a mais" (quickstart, cenário 11): `nQtdeRec` do PC = peso conferido (ou o
   saldo), `nQtdeNFe` da NF inalterada, um título e nenhum movimento de estoque pelo OMIE.

**Desligar**: `STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO=false` e "Update the stack". Os vínculos já concluídos
ficam como estão; o aviso a compras na rejeição continua valendo para eles (o cron :05/:35 manda o que
falhou). Uma NF cuja tentativa anterior mandou o peso conferido e não concluiu volta a mandar a da NF.

**Peso muito acima da nota**: excedente acima de `STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT` (padrão 10%) da NF
do item não vai ao PC (provável erro de digitação). O item segue pela NF e o log registra "acima do limite
relativo".

## Fiscal revertido no OMIE (ACXEGDP-437, research D21 da 017)

Em 25/10/2026 o usuário reverteu no portal do OMIE o recebimento fiscal que o Atlas tinha concluído
(NF 19252, Zaraplast × PC 308: concluída às 17:02, revertida às 17:13) e o Atlas seguiu mostrando a NF
como "fiscal já feito": o clique do operador teria feito só o físico, e a NF ficaria na etapa 40, sem
conta a pagar e sem baixa no PC. A D21 da 017 faz o Atlas perceber a reversão. A NF volta à fila como
"fiscal pendente", com o selo "Fiscal revertido no OMIE", e o clique conclui o fiscal de novo, com o PC
confirmado. Se a entrada física já foi lançada para todos os itens, a NF não volta à fila e o fiscal
recebe um e-mail para concluir de novo no portal (numa NF parcial, com a entrada de um item rejeitada
pelo gestor, o item sem entrada volta à fila como fiscal revertido, e o e-mail sai mesmo assim).
**O Atlas nunca reverte nada no OMIE.** Desenho e decisões em
`specs/017-recebimento-nacional-com-pc/research.md` (D21 da 017); passo a passo de teste no quickstart,
cenário 12.

Vale só com `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=true` (sem o fiscal pelo Atlas não há como refazê-lo)
e com a migration 0060 aplicada. A chave nova, `STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED`, vem **ligada** por
padrão (corrige um estado errado da fila) e é o kill switch.

**Ordem** (não inverter os passos 1 e 3)

1. **Migration 0060** em PROD, **antes** da imagem, com o dono dos objetos (`postgres`):

   ```bash
   export PROD_USER=<usuario-prod>
   PGOPTIONS='-c lock_timeout=5s' psql -h db.manager01.q2p.com.br -p 5432 -U "$PROD_USER" -d acxe_q2p \
     -1 -q -v ON_ERROR_STOP=1 -f packages/db/migrations/0060_stockbridge_fiscal_revertido.sql
   echo "exit=$?"
   ```

   - Esperado: `exit=0` e nenhuma linha `ERROR`. `NOTICE ... does not exist, skipping` (os
     `DROP CONSTRAINT IF EXISTS` da 1ª execução) é normal. Reaplicar é seguro.
   - O que muda: cinco colunas nulas em `stockbridge.recebimento_fiscal` (`revertido_em`,
     `revertido_origem`, `revertido_omie_em`, `revertido_por` e `aviso_fiscal_em`), os `CHECK`s de
     status do ledger e de `recebimento_fiscal_pc` refeitos para aceitar `revertido`, dois `CHECK`s
     novos no ledger (`recebimento_fiscal_revertido_origem_check`, os valores de `revertido_origem`; e
     `recebimento_fiscal_revertido_check`, status `revertido` exige `revertido_em` e
     `revertido_origem`) e o índice `recebimento_fiscal_chave_idx`.
     As duas tabelas são pequenas; o `DROP`/`ADD CONSTRAINT` vale um lock curto.
   - **Sem a 0060** a imagem sobe e funciona como antes da D21 da 017: o código confere a coluna
     `revertido_em` no `information_schema` e, ausente, desliga o tratamento inteiro, com `ERROR` no log
     ("Coluna stockbridge.recebimento_fiscal.revertido_em ausente (migration 0060)"), repetindo a
     conferência a cada 5 min. Aplicada a migration com a API no ar, o tratamento liga sozinho em até
     5 min, sem redeploy. Mesmo assim, aplicar antes da imagem.
   - **UAT**: o mesmo arquivo, com `psql -1 -f` no banco do UAT (`-p 5437 -U postgres`; não pelo
     `apply-migrations-uat.sh`), antes da imagem `:uat`.
   - Conferência (somente leitura):

     ```sql
     SELECT (SELECT count(*) FROM information_schema.columns
              WHERE table_schema = 'stockbridge' AND table_name = 'recebimento_fiscal'
                AND column_name IN ('revertido_em', 'revertido_origem', 'revertido_omie_em',
                                    'revertido_por', 'aviso_fiscal_em')) AS colunas_ledger,   -- 5
            (SELECT pg_get_constraintdef(oid) LIKE '%revertido%' FROM pg_constraint
              WHERE conname = 'recebimento_fiscal_status_check') AS status_ledger,            -- true
            (SELECT pg_get_constraintdef(oid) LIKE '%revertido%' FROM pg_constraint
              WHERE conname = 'recebimento_fiscal_pc_status_check') AS status_pc,             -- true
            (SELECT count(*) FROM pg_constraint
              WHERE conname IN ('recebimento_fiscal_revertido_origem_check',
                                'recebimento_fiscal_revertido_check')) AS checks_novos,       -- 2
            to_regclass('stockbridge.recebimento_fiscal_chave_idx') AS idx_chave;             -- não nulo
     ```

2. **Variáveis** no Portainer: `STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED` já está no `atlas.stack.yml`
   (default `true`); **deixar o default**. `STOCKBRIDGE_FISCAL_EMAILS` já existe (a lista dos avisos de
   dispensa; default NFe ACXE + Mauricio Yared + Gustavo Dreer) e passa a receber também o e-mail
   "Recebimento fiscal desfeito no OMIE": conferir os destinatários antes da imagem. No UAT a chave
   também está no YAML (`uat-atlas - web e api.yaml`); conferir lá `STOCKBRIDGE_FISCAL_EMAILS` e
   `EMAIL_DESVIO_PARA`.
3. **Imagem nova** (nova `ATLAS_VERSION`), com a chave da 016 já `true`.
4. **Conferir**:
   - uma NF revertida, se houver e ainda não foi recebida fisicamente, aparece na fila como "Fiscal
     pendente" com o selo "Fiscal revertido no OMIE" (a fila lê o sinal direto, sem esperar o cron), e o
     detalhe traz o aviso com a hora da reversão e o PC do vínculo do OMIE (na 19252, em 26/10/2026, o
     PC 308; ela foi concluída no portal em 27/10/2026);
   - o ledger, depois da primeira rodada do cron `5,35` (até 30 min), da primeira abertura da fila ou
     do detalhe da NF (a listagem e o detalhe também marcam a tentativa antiga, antes do selo e da
     sugestão de PC) ou do clique:

     ```sql
     SELECT nota_fiscal, status, revertido_origem, revertido_em, revertido_omie_em, aviso_fiscal_em
       FROM stockbridge.recebimento_fiscal WHERE status = 'revertido' ORDER BY revertido_em DESC LIMIT 20;
     ```

     Só devem aparecer NFs realmente revertidas (zero falso positivo: em 25/10/2026 o sinal marcava 1 de
     4.289 recebimentos da Q2P e 0 de 346 da ACXE);
   - o log do cron, `Varredura de recebimento fiscal revertido no OMIE`, com `marcados`, `avisados` e
     `falhas` (só sai linha quando algum é maior que zero), e nenhum erro "Coluna ... revertido_em
     ausente".
5. **Primeiro uso acompanhado** (T100, com autorização do usuário): refazer o fiscal da primeira NF
   revertida pelo Atlas escreve no OMIE de PROD. Clicar em "Concluir fiscal e dar entrada" e conferir ao vivo
   (workflow de leitura `4OnbxvfALn9OoXLH`): recebimento na etapa 60 com `cRecebido = S`, os itens ainda
   com "não movimentar estoque" e as quantidades em kg, `nQtdeRec` do PC da NF, um só título e
   nenhum movimento de estoque pelo OMIE; no ledger, o `revertido` antigo e um `concluido` novo.
   Registrar na research (D21 da 017) e na ACXEGDP-437.

**Desligar**: `STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED=false` e "Update the stack" (a chave é lida na subida
do processo: é um redeploy rápido, sem trocar a imagem nem mexer em migration). A fila, o detalhe e o
POST voltam ao comportamento de antes: o ledger `concluido` é final e a NF revertida segue como "fiscal
já feito". As linhas `revertido` já gravadas ficam como histórico, sem efeito.
`STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=false` também desliga o tratamento. A 0060 pode ficar (é aditiva) e
convive com a imagem anterior, que nunca grava `revertido`.

**Comunicar ao fiscal**: reverter no portal um recebimento que o Atlas concluiu faz a NF reaparecer no
StockBridge como "Fiscal revertido no OMIE". Quem reverte para corrigir a nota (reverter, editar,
concluir) deve concluir logo e **conferir, em cada item, "Não gerar movimento de estoque"** (o estoque
entra pela aprovação no Atlas; sem isso entraria em dobro e o Atlas bloquearia a entrada física) e o
vínculo com o pedido de compra. Se a entrada física da NF já foi lançada no Atlas, o fiscal recebe o
e-mail "Recebimento fiscal desfeito no OMIE" e refaz o recebimento no portal: o Atlas não refaz só o
fiscal de NF já recebida fisicamente. **Comunicar à operação**: a tela avisa "Se a reversão foi feita
para corrigir a nota no OMIE, fale com o fiscal antes"; não dar entrada nessa janela.

## Espelho de itens de NF por posição da linha (ACXEGDP-437, T102 da 017)

O OMIE dá o mesmo `nCodItem` às linhas da NF ligadas ao mesmo item de pedido de compra, e o espelho de
itens de NF guardava só a última delas. A parte do n8n foi feita em 27/10/2026: chave `(n_id_nf, n_item)`,
DDL das 3 tabelas e recarga completa da Q2P e da ACXE (PR #229 do backup-workflow-n8n). Esta parte é a do
Atlas. A fila e o detalhe da compra nacional passam a ligar cada linha da NF à sequência certa do
recebimento: as linhas do mesmo código, na ordem; e, quando o OMIE registra a NF de novo com ids novos, a
posição. A migration 0061 grava a
sequência do item nas entradas nacionais antigas (anteriores à ACXEGDP-412), que só casavam pela descrição.
Desenho em `specs/017-recebimento-nacional-com-pc/research.md`, pendência 8.

Sem variável nova. A ordem entre a 0061 e a imagem é indiferente: o código casa por descrição **ou**
sequência, e sem a coluna `n_item` (espelho sem o DDL) o SQL dá o resultado de antes.

1. **Migration 0061** em PROD (só dados), com o dono dos objetos (`postgres`):

   ```bash
   export PROD_USER=<usuario-prod>
   PGOPTIONS='-c lock_timeout=5s' psql -h db.manager01.q2p.com.br -p 5432 -U "$PROD_USER" -d acxe_q2p \
     -1 -q -v ON_ERROR_STOP=1 -f packages/db/migrations/0061_stockbridge_sequencia_item_entradas_antigas.sql
   echo "exit=$?"
   ```

   - Esperado: `exit=0` e `NOTICE: 0061: 39 entrada(s) nacional(is) da Q2P com a sequencia do item
     preenchida` (contagem de 28/10/2026; entradas novas já nascem com a sequência). Reaplicar é seguro
     (`0 entrada(s)`).
   - A trigger de auditoria de `stockbridge.movimentacao` grava cada linha alterada.
   - Conferência (somente leitura), esperado 0:

     ```sql
     SELECT count(*) FROM stockbridge.movimentacao
      WHERE subtipo = 'compra_nacional' AND empresa = 'q2p' AND nf_chave_acesso IS NOT NULL
        AND nf_item_sequencias IS NULL;
     ```

   - **UAT**: o mesmo arquivo, com `psql -1 -f` no banco do UAT. O UAT já tem o DDL do espelho (conferido
     em 27/10/2026); sem o espelho de recebimentos a 0061 avisa e não faz nada.
2. **Imagem nova** (nova `ATLAS_VERSION`).
3. **Conferir**: a fila de compra nacional não ganha NF já recebida. Em 28/10/2026, o SQL novo rodado em PROD
   (só leitura) mudava a sequência de só 4 das 385 linhas da janela: 60199, 60276, 60281 e 36624. Com a
   imagem nova e a 0061, a 36624 (recebida em 06/10 e devolvida) sai da fila; só uma das duas não basta.

**Desfazer**: voltar à imagem anterior. A 0061 pode ficar: a sequência é um dado a mais, que a imagem
anterior também usa.
