# Fix: job autônomo de sync UAT é destrutivo (DROP SCHEMA public CASCADE)

> Contexto: ACXEGDP-181. Data do achado: 2026-06-16.
> Há **duas cópias** do script de sync no ambiente:
> - **Repo (correta, não-destrutiva):** `scripts/sync-omie-public-prod-to-uat.sh`
> - **Servidor (`/root/scripts/sync-omie-public-prod-to-uat.sh`):** criada pelo agente Anti-Gravity, roda 2x/dia via cron. **É destrutiva.**

## O que a versão do servidor faz de errado

Trecho do script de `/root`:

```sql
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
...
-- (passo 5) GRANT ... TO claude_ro;  -- frequentemente NÃO executa
```

Três problemas:

1. **`DROP SCHEMA public CASCADE`** apaga, a cada execução:
   - objetos que o Atlas criou em `public`: `tb_movimentacao_q2p_legado` (migration 0036) e o trigger `trg_auto_popular_config_produto` (0017);
   - **por CASCADE**, todas as views em outros schemas que dependem de tabelas `public` — ex.: `shared.vw_sb_correlacao_produto`, `shared.vw_sb_fornecedor_ativo` (migration 0009).
2. **Restore full schema+data do PROD** sobrescreve `public` inteiro — não preserva nada do Atlas que vive em `public`.
3. **`set -e` + `pg_restore` retornando ≠0** (sempre há warnings): o script **aborta antes do passo 5**, então os grants do `claude_ro` nunca são reaplicados → o MCP read-only perde acesso a `public.*`.

> ⚠️ Isso é **incompatível** com a arquitetura "Atlas sobre OMIE": o Atlas tem objetos próprios em `public` e outros schemas dependem de tabelas de `public`. Nenhum sync pode dropar/recriar o schema `public`.

## Decisão: desativar o job autônomo e fazer sync manual

A atualização do BD UAT passa a ser **manual**, rodada do laptop (que tem o repo e acesso ao UAT), usando `scripts/sync-omie-public-prod-to-uat.sh` (não-destrutivo).

---

## Parte A — Agente no servidor: DESATIVAR o job (urgente)

O agente Anti-Gravity (no servidor) deve:

1. **Remover/desativar o agendamento** que roda `/root/scripts/sync-omie-public-prod-to-uat.sh` 2x/dia:
   ```bash
   sudo crontab -l                 # localizar a linha do sync
   sudo crontab -e                 # comentar/remover a linha
   # se for cron de sistema: checar /etc/cron.d/, /etc/crontab
   # se for systemd timer: sudo systemctl disable --now <nome>.timer
   ```
2. **Neutralizar o script destrutivo** para não ser executado por engano:
   ```bash
   sudo mv /root/scripts/sync-omie-public-prod-to-uat.sh \
           /root/scripts/sync-omie-public-prod-to-uat.sh.DESATIVADO
   ```
3. Confirmar que **não há mais nenhum job** disparando `DROP SCHEMA public`.

> O agente **não precisa** rodar o reparo nem syncs futuros — isso é feito do laptop (Parte B e C).

---

## Parte B — Reparo único do dano já causado (rodar do laptop)

O `DROP SCHEMA public CASCADE` já apagou objetos Atlas. Confirmado ausentes em 16/06:
`public.tb_movimentacao_q2p_legado`, trigger `trg_auto_popular_config_produto`,
`shared.vw_sb_correlacao_produto`, `shared.vw_sb_fornecedor_ativo`.
(A função `stockbridge.auto_popular_config_produto()` **sobreviveu** — está em `stockbridge`, não foi dropada.)

### Opção 1 — SQL cirúrgico (baixo risco, recria os objetos confirmados)

Rodar contra o UAT (`db.manager01.q2p.com.br:5437/acxe_q2p`, user `postgres`):

```sql
-- 1) Tabela do legado MySQL (migration 0036) — recria VAZIA (dados: ver passo 4 abaixo)
CREATE TABLE IF NOT EXISTS public."tb_movimentacao_q2p_legado" (
  nota_fiscal      integer PRIMARY KEY,
  mv_acxe          smallint,
  dt_acxe          timestamptz,
  id_movest_acxe   text,
  id_ajuste_acxe   text,
  id_user_acxe     integer,
  mv_q2p           smallint,
  dt_q2p           timestamptz,
  id_movest_q2p    text,
  id_ajuste_q2p    text,
  id_user_q2p      integer,
  ativo            smallint,
  synced_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public."tb_movimentacao_q2p_legado" IS
  'Espelho da tabela db_q2p.tb_movimentacao do MySQL legado (PHP). Usada como fonte de "NF recebida" durante validação paralela do StockBridge. Critério: mv_acxe=1 AND mv_q2p=1 AND ativo=1.';
CREATE INDEX IF NOT EXISTS tb_movimentacao_q2p_legado_recebida_idx
  ON public."tb_movimentacao_q2p_legado" (nota_fiscal)
  WHERE mv_acxe = 1 AND mv_q2p = 1 AND ativo = 1;

-- 2) Trigger de auto-popular config_produto (migration 0017). A função já existe.
DROP TRIGGER IF EXISTS trg_auto_popular_config_produto ON public."tbl_produtos_ACXE";
CREATE TRIGGER trg_auto_popular_config_produto
    AFTER INSERT ON public."tbl_produtos_ACXE"
    FOR EACH ROW
    EXECUTE FUNCTION stockbridge.auto_popular_config_produto();

-- 3) View de correlação ACXE↔Q2P (migration 0009)
CREATE OR REPLACE VIEW shared.vw_sb_correlacao_produto AS
SELECT
    a.codigo_produto AS codigo_produto_acxe,
    q.codigo_produto AS codigo_produto_q2p,
    a.descricao,
    a.codigo_familia AS codigo_familia_acxe,
    q.codigo_familia AS codigo_familia_q2p
FROM public."tbl_produtos_ACXE" a
INNER JOIN public."tbl_produtos_Q2P" q ON a.descricao = q.descricao
WHERE (a.inativo IS NULL OR a.inativo <> 'S')
  AND (q.inativo IS NULL OR q.inativo <> 'S');

-- 4) View de fornecedor ativo (migration 0009)
CREATE OR REPLACE VIEW shared.vw_sb_fornecedor_ativo AS
SELECT f.*
FROM public."tbl_cadastroFornecedoresClientes_ACXE" f
LEFT JOIN stockbridge.fornecedor_exclusao e
    ON e.fornecedor_cnpj = f.cnpj_cpf
   AND e.reincluido_em IS NULL
WHERE e.id IS NULL;
```

> ⚠️ A lista cirúrgica cobre os objetos **confirmados**. Se o cockpit/uma query reclamar de outra view ausente depois, é porque o CASCADE derrubou mais alguma — nesse caso use a Opção 2.

### Opção 2 — Reparo completo (recria TUDO, idempotente)

Do laptop, re-aplica todas as migrations Atlas (recria todas as views/triggers/tabelas que o CASCADE derrubou):

```bash
export PGPASSWORD_UAT='<senha-uat>'
scripts/apply-migrations-uat.sh        # confirma com 'y'
```

> Recria também o legado vazio e os grants do `claude_ro`. Use se quiser garantia de completude. Caveat: re-roda todas as migrations; se alguma não for idempotente e falhar, o script para — corrija e rode de novo (NÃO rode o `sync-acxe-prod-to-uat.sh` de reset, que apaga os dados do StockBridge).

### DADOS do legado — NÃO precisa repor (esclarecimento importante)

Há **duas** tabelas de legado distintas, e é fácil confundir:

| tabela | migration | populada por | status pós-dano |
|---|---|---|---|
| `stockbridge.movimentacao_legado` | 0038 | `migrate-from-mysql.ts` | **intacta, 866 linhas** (stockbridge não foi dropado) |
| `public.tb_movimentacao_q2p_legado` | 0036 | `sync-vendas-prod-to-dev.sh` step 5 (mysqldump→\copy) | recriada **vazia** |

**A que importa é a `stockbridge.movimentacao_legado` — e ela está intacta.** É ela que `cockpit.service.ts`, `nf-pedido-mapa.service.ts` e `recebimento.service.ts` leem como fonte de "NF recebida via legado" (a auto-desativação de filhotes). 

**`public.tb_movimentacao_q2p_legado` é vestigial:** nenhum serviço a lê, e a função de trânsito que a usava (migration 0036) foi substituída pela 0037 (trânsito 100% FUP). Deixá-la vazia é **inofensivo**.

> ⚠️ **NÃO** rode `migrate-from-mysql.ts` para "repor" a tabela vazia — esse script escreve em `stockbridge.movimentacao_legado` (já cheia), não na `public`. Se algum dia quiser popular a `public` por completude, é o `sync-vendas-prod-to-dev.sh` step 5 (precisa de acesso ao MySQL legado) — mas é cosmético.

### Reaplicar grants do claude_ro em public (se ainda não feito)

```sql
GRANT USAGE ON SCHEMA public TO claude_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO claude_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO claude_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON SEQUENCES TO claude_ro;
```

---

## Parte C — Daqui pra frente: sync manual (do laptop)

Quando quiser atualizar o espelho OMIE do UAT, rode o script **do repo** (não-destrutivo: data-only + triagem de drift + grants/default-acl + refresh dos caches do cockpit):

```bash
export PROD_USER=<seu-usuario-prod>
export PGPASSWORD_PROD='<senha-prod>'
export PGPASSWORD_UAT='<senha-uat>'
scripts/sync-omie-public-prod-to-uat.sh        # confirma com 'y'
```

Preserva `stockbridge.*`, `shared.*`, `hedge.*`, `forecast.*`, `breakingpoint.*`, `crm.*` e `public.tb_movimentacao_q2p_legado`.

---

## Anexo — se um dia quiser reautomatizar com segurança

NÃO reative o script de `/root`. Em vez disso, agende o script do repo, que já tem modo não-interativo:

```bash
PROD_HOST=127.0.0.1 PROD_PORT=5432 \
UAT_HOST=127.0.0.1  UAT_PORT=5437 \
PROD_USER=postgres \
PGPASSWORD_PROD='<senha>' PGPASSWORD_UAT='<senha>' \
ASSUME_YES=1 \
bash /caminho/para/sync-omie-public-prod-to-uat.sh
```

Regras inegociáveis para qualquer sync de UAT:
- **NUNCA** `DROP SCHEMA public` nem `DROP DATABASE`.
- Esvaziar `public.*` com **TRUNCATE** (comando único, por causa das FKs), **excluindo** `tb_movimentacao_q2p_legado`.
- Restore **data-only** (`pg_dump --schema=public --data-only` → `pg_restore --data-only --disable-triggers`).
- Grants fora de bloco `set -e` que possa abortar; usar `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO claude_ro`.
- Nunca tocar em `stockbridge.*`, `shared.*`, `hedge.*`, `forecast.*`, `breakingpoint.*`, `crm.*`.
- Manter **uma fonte única** (o script versionado do repo), não cópias divergentes.
