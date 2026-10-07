# Runbook — UAT do Atlas (ambiente de testes standalone)

> O UAT (`uat-atlas.q2p.com.br`) rodou como produção de junho até o go-live de
> 04/10/2026 (GMUD ACXEGDP-321). Desde então é o **ambiente de testes** onde cada
> melhoria é validada antes de subir para o PROD (`atlas.q2p.com.br`). ACXEGDP-405.
> Última revisão: 2026-10-05.

## Como o UAT se isola da produção

| O quê | Como fica no UAT |
|---|---|
| OMIE | `OMIE_MODE=leitura`: consultas (NF, pedido, recebimento de NF-e, ajustes) vão ao OMIE **real**; as 4 escritas (`IncluirAjusteEstoque`, `AlteraPedCompra`, `AlterarRecebimento`, `ConcluirRecebimento`) são **simuladas** e nunca saem do container (ids `MOCK-*`, log `[OMIE SIMULADO]`) |
| E-mail | Todos vão para `EMAIL_DESVIO_PARA`, com assunto `[UAT] …` e os destinatários originais no topo; sem a variável, só log |
| Front | Faixa âmbar "Ambiente de testes" em todas as telas, inclusive o login |
| 2FA | Ligado: o UAT é público, lê dados reais e tem os usuários e senhas do PROD |
| n8n | Não chama o UAT (o workflow da FUP publica só no PROD desde o go-live) |
| Banco | `db.manager01.q2p.com.br:5437/acxe_q2p` — espelho OMIE em `public.*` + schemas Atlas |
| Imagens | `plasticosq2p/atlas-{api,web}:uat` (build no push da branch `uat`) |
| Stack | `uat-atlas - web e api.yaml` (Portainer, stack `uat-atlas`) |

### Por que não há como escrever no OMIE nem mandar e-mail a usuário real

O UAT tem as chaves OMIE de produção (precisa delas para ler) e a chave do
SendGrid. Travas independentes:

1. **Imagem**: o build `:uat` (`docker-build-uat.yml`) grava `ATLAS_ENV=uat` na
   própria imagem. Mesmo que alguém cole um YAML antigo (que pedia OMIE real), a
   API se recusa a subir.
2. **Configuração**: `ATLAS_ENV=uat` e `OMIE_MODE=leitura` também são valores
   literais no YAML (o env do Portainer não os sobrescreve). A API não sobe com
   `ATLAS_ENV=uat` + `OMIE_MODE=real`, nem com `leitura`/`mock` em
   `NODE_ENV=production` sem `ATLAS_ENV=uat`.
3. **Transporte**: fora do modo real, `callOmie` só envia os métodos da lista de
   leitura (`ConsultarNF`, `ListarAjusteEstoque`, `ConsultarPedCompra`,
   `ConsultarRecebimento`). Qualquer outro lança `OmieEscritaBloqueadaError` antes
   da rede, inclusive uma escrita nova que alguém crie no futuro.
4. **Chaves**: no modo leitura as chaves OMIE entram no container como
   `OMIE_LEITURA_*` e a do SendGrid como `SENDGRID_API_KEY_DESVIO`. O YAML não
   repassa `OMIE_ACXE_KEY`/`OMIE_Q2P_KEY`/`SENDGRID_API_KEY`. Uma imagem anterior à
   405 (que trataria "leitura" como "real") fica sem chave: não chama o OMIE nem
   manda e-mail.
5. **E-mail**: `sendEmail` manda tudo para `EMAIL_DESVIO_PARA`; sem ela, no UAT,
   não manda nada.

### Como os fluxos se comportam com escrita simulada

- Recebimento de importação, aprovação, saída manual: o ajuste "conclui" com
  `id_movest` `MOCK-MOVEST-*`. O saldo do OMIE não muda, então a posição de
  estoque lida do espelho também não muda.
- Baixa do pedido Q2P e recebimento fiscal: o documento escrito vira uma
  **sombra em memória**, montada a partir da leitura real que o fluxo acabou de
  fazer (sem consultar de novo), e dali em diante as consultas dele respondem pela
  sombra (o fiscal reconsulta o recebimento; o retry da baixa reconfere o saldo).
  **Reiniciar a API apaga a sombra**: o pedido volta ao saldo real e o recebimento
  volta à etapa 40 no OMIE (no Atlas, o ledger continua dizendo que foi concluído).
  Com a conferência da ACXEGDP-406 (até 10 min depois de uma baixa do Atlas, o saldo
  lido tem de ser o gravado), uma baixa no mesmo pedido logo após um reinício vira
  `falha` — retentável depois da janela.
- `backfill-baixa-pedido-q2p` com `--execute` recusa rodar fora do modo real; o
  dry-run e o `--consultar` funcionam no UAT.
- Limite de ritmo: o OMIE bloqueia por ~1 min a mesma consulta repetida com a
  mesma chave ("consumo redundante"). Como UAT e PROD usam a mesma chave, consultar
  no UAT a mesma NF que alguém acabou de consultar no PROD pode atrasar a chamada
  do PROD (as leituras do PROD esperam e tentam de novo). Evite testar no UAT a NF
  que está sendo recebida no PROD naquele momento.

---

## Fluxo de entrega

```
feature/* ──PR──▶ uat ──(imagem :uat)──▶ validação no UAT ──PR──▶ main ──(tag vX.Y.Z)──▶ PROD
```

1. PR da branch de trabalho para `uat`. O merge roda `ci.yml` e `docker-build-uat.yml`
   (publica `atlas-{api,web}:uat` e `:uat-<sha>`).
2. Migration nova: aplicar no UAT com `scripts/apply-migrations-uat.sh` antes do redeploy.
3. Redeploy da stack `uat-atlas` no Portainer (puxar a imagem nova) e conferir o health
   (abaixo).
4. Validar a mudança no UAT.
5. PR `uat` → `main`. O `release-tag.yml` cria a tag e o `docker-build.yml` publica as
   imagens versionadas (se o push na main não disparar a tag, rode o `release-tag.yml`
   por `workflow_dispatch`).
6. PROD: migrations com `scripts/apply-migrations-prod.sh`, `ATLAS_VERSION` nova no env da
   stack `atlas` e redeploy.

## Deploy e conferência do UAT

### Primeiro deploy da 405 (uma vez)

1. Aguardar a imagem `:uat` com a 405 (build verde no `docker-build-uat.yml`).
2. Portainer → stack `uat-atlas` → **Editor**: colar o `uat-atlas - web e api.yaml` do
   repositório inteiro. O YAML de lá estava defasado em relação ao Portainer, então não
   faça merge linha a linha.
3. Env da stack:
   - acrescentar `EMAIL_DESVIO_PARA=<caixa de testes>`;
   - **remover `AUTH_2FA_ENABLED=false`** (o YAML liga o 2FA por padrão; a linha do env
     venceria). Quem configurou o 2FA no PROD depois de 04/10 configura de novo no UAT
     (os bancos são independentes desde o transplante);
   - remover `OMIE_MODE` e as flags `STOCKBRIDGE_BAIXA_PEDIDO_Q2P_ENABLED=false` /
     `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=false` (deixam de valer ou devem voltar ao
     default `true` — as escritas agora são simuladas);
   - `OMIE_ACXE_KEY/SECRET`, `OMIE_Q2P_KEY/SECRET` e `SENDGRID_API_KEY` ficam com o nome
     de sempre: o YAML os repassa como `OMIE_LEITURA_*` e `SENDGRID_API_KEY_DESVIO`.
4. **Update the stack** com "Re-pull image" ligado e scale 1 (estava em 0 desde o go-live).
5. Conferir o health (próxima seção) **antes** de qualquer teste.

### Conferência após cada deploy

```bash
curl -fsS https://uat-atlas.q2p.com.br/api/v1/health | jq '.data.ambiente'
# esperado: { "nome": "uat", "omie_modo": "leitura", "email": "desviado" }
```

- Sem o bloco `ambiente` = imagem anterior à 405 → `scale 0` na stack e investigar.
- `email: "suprimido"` = `EMAIL_DESVIO_PARA` ausente (nenhum e-mail sai; só log).
- Abrir `https://uat-atlas.q2p.com.br` (Ctrl+Shift+R): a faixa âmbar "Ambiente de testes"
  aparece já no login.
- Logs da API (Portainer → serviço `uat-atlas_uat-atlas_api`): a linha `Atlas API started`
  traz `ambiente`, `omieModo` e `email`; toda escrita simulada gera `[OMIE SIMULADO]`.

### Parar o UAT

Portainer → serviço da API → **scale 0** (o web pode ficar no ar). É o estado seguro
quando não há teste em andamento.

---

## Dados de base

| Dado | Como atualizar | Pendente (fase 2 da 405) |
|---|---|---|
| Espelho OMIE `public.*` | `scripts/sync-omie-public-prod-to-uat.sh` (só `public.*`; preserva os schemas Atlas). Rodar 1×/dia. **Nunca rode duas cópias ao mesmo tempo**: a segunda deixa `pg_restore` órfão e trava o `TRUNCATE` | Agendar com trava e alerta |
| Estado Atlas (lotes, movimentações, aprovações, baixas, mapa NF→pedido, `atlas.users`, auditoria) | `scripts/refresh-atlas-prod-to-uat.sh`, **sob demanda** — antes de uma rodada de testes. Apaga o que foi testado no UAT | — |
| Mapa NF→pedido (`stockbridge.nf_pedido_mapa`) | Vem no refresh do estado Atlas; entre dois refreshes fica parado (o n8n publica só no PROD) | 2º POST no workflow da FUP com `continueOnFail`, se fizer falta |

As senhas não precisam ir na linha de comando: sem `PGPASSWORD_PROD`/`PGPASSWORD_UAT`
no ambiente, os scripts pedem as duas sem eco.

```bash
cd /home/primebot/Documentos/Github/q2p/plataforma-atlas

# espelho OMIE PROD -> UAT, diário (não toca nos schemas Atlas)
PROD_USER=postgres ./scripts/sync-omie-public-prod-to-uat.sh

# estado Atlas PROD -> UAT, sob demanda — primeiro só as checagens:
PROD_USER=postgres DRY_RUN=1 ./scripts/refresh-atlas-prod-to-uat.sh
PROD_USER=postgres ./scripts/refresh-atlas-prod-to-uat.sh
```

O refresh do estado Atlas:

- lê o PROD com sessão somente leitura e se recusa a rodar se origem e destino forem o
  mesmo banco;
- aborta se o PROD tiver tabela ou coluna que o UAT não tem (aplique as migrations no
  UAT antes); avisa se o UAT tiver tabela a mais (migration em teste — fica vazia);
- faz backup data-only do estado Atlas do UAT antes de apagar (`BACKUP_UAT=0` pula) e,
  no fim, pergunta se apaga o dump do PROD (padrão sim) e o backup (padrão não — é o
  que desfaz o refresh);
- não copia `atlas.sessions` (todos fazem login de novo) e zera tokens de reset de
  senha e bloqueios por tentativa; senhas e 2FA ficam iguais aos do PROD;
- valida contando cada tabela no PROD antes e depois do dump (o PROD segue operando):
  tabela que não mudou tem de bater exato;
- recalcula o trânsito da FUP no UAT no fim — por isso `stockbridge.lote` e
  `shared.audit_log` podem sair com alguns registros a mais que o PROD (lote de
  trânsito novo que o PROD ainda não recalculou). Não é divergência.

Recomendado: API do UAT em scale 0 durante o refresh (o script avisa se encontrar
conexões abertas) e religada depois — zera também a sombra do OMIE em memória.

Antes de qualquer operação de banco, teste `SELECT 1` nos dois bancos: o acesso ao
`db.manager01` é liberado por IP no firewall da DigitalOcean.

---

## Notas

- A API não roda migrations no boot (só `seedAdmin()` com `users` vazia). Migrations são
  SQL puro em `packages/db/migrations/`, aplicadas em ordem por
  `scripts/apply-migrations-uat.sh` (não há `meta/_journal.json`; `drizzle-kit migrate`
  não é o caminho).
- `scripts/sync-acxe-prod-to-uat.sh` (cópia do banco inteiro) **apaga os schemas Atlas**.
  Para o dia a dia use `sync-omie-public-prod-to-uat.sh`.
- O Postgres do UAT roda com `max_connections=20`. Um DBeaver aberto segura várias
  conexões e já travou o `claude_ro` (04/10). Feche o DBeaver ao terminar.
