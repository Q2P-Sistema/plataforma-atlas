# ADR-0007: Atlas lê OMIE do Postgres, não da API

**Status:** Aceito
**Data:** 2026-04-11

## Contexto

O OMIE tem uma API REST paginada para leitura e escrita dos objetos do ERP (produtos, contas a pagar, contas a receber, cadastros, posição de estoque, locais, categorias). Essa API tem rate limit por app-key, latência não-trivial e um contrato com alguns quirks (campos JSONB para categorias, ausência do campo "moeda" em contas a pagar, etc.).

**Hoje, o n8n já faz o sync incremental OMIE → Postgres em produção**, escrevendo nas 28 tabelas `tbl_*_ACXE` e `tbl_*_Q2P` do schema `public` do banco `dev_acxe_q2p_sanitizado`. O sync é incremental por `dDtAlt` (último momento de alteração registrado no OMIE), roda em intervalos regulares, e mantém o Postgres razoavelmente em dia com o OMIE.

Na hora de desenhar como os módulos do Atlas acessam dados OMIE, existem dois caminhos:

1. **Atlas chama a API OMIE diretamente** para cada necessidade de dados. Cliente centralizado em `packages/integrations/omie/`, cada módulo importa e chama.
2. **Atlas lê do Postgres** (que o n8n mantém sincronizado) e só chama OMIE diretamente em casos excepcionais (escrita ou leitura crítica em tempo real).

## Decisão

**Atlas lê dados OMIE principalmente do Postgres.** As 28 tabelas sincronizadas pelo n8n são a fonte operacional para todas as queries de leitura do Atlas. A API OMIE só é chamada diretamente em dois casos:

1. **Quando o Atlas precisa de um dado fresquíssimo e pequeno** que não pode esperar o próximo ciclo de sync do n8n. Exemplo: uma confirmação em tempo real de saldo de conta corrente durante um processo crítico. Caso raro, uso pontual, nunca em query de listagem.

2. **Quando o Atlas precisa escrever no OMIE.** O caso conhecido é o **StockBridge emitindo NF de entrada** após escolher armazém e receber fisicamente a mercadoria. Esse é um fluxo de domínio interno do Atlas que precisa refletir no ERP como verdade fiscal.

**Todas as queries de listagem, dashboards, agregações, joins entre domínios e projeções do schema `shared` leem exclusivamente do Postgres, nunca da API OMIE.**

## Consequências

- **`packages/integrations/omie/` fica com escopo reduzido.** Em vez de ser "cliente OMIE completo de leitura e escrita", vira principalmente:
  - Cliente de escrita pontual (emissão de NF entrada, eventualmente outras operações do StockBridge).
  - Cliente de leitura de emergência (para os casos raros do item 1).
  - Bibliotecas utilitárias compartilhadas (tratamento de campos JSONB de categorias, parser de `dDtAlt`, conversão de tipos OMIE → TS).
  - **Nada de polling, sync schedule ou pipeline ETL.** Essa responsabilidade é 100% do n8n.

- **Módulos do Atlas nunca importam diretamente de `packages/integrations/omie/` pra fazer uma query de leitura.** Se um módulo precisa ler "contas a pagar abertas", a query vai no Postgres, nas tabelas sincronizadas ou em views do `shared`. Se um módulo precisa ler "exatamente o saldo atual dessa conta corrente neste milissegundo", aí sim pode pedir o cliente OMIE — mas isso é exceção, não regra, e deve ser justificada em code review.

- **Queries ficam rápidas e previsíveis.** Zero latência de API externa, zero preocupação com rate limit OMIE no caminho do usuário, zero fallback gracioso necessário no caminho de leitura (porque não há dependência externa no caminho).

- **Rate limit OMIE fica centralizado no n8n.** O n8n é o único lugar que pagina a API OMIE, então é o único lugar que precisa respeitar rate limit. Isso elimina uma classe inteira de bugs distribuídos ("o módulo A pagou o rate limit e o módulo B quebrou").

- **Atlas continua funcionando mesmo se o OMIE estiver temporariamente fora.** Como leituras vêm do Postgres, o máximo que acontece é os dados ficarem "defasados" pelo tempo do último sync. Dashboards mostram o último snapshot válido. Só o StockBridge pode precisar degradar a funcionalidade de "emitir NF entrada" se o OMIE estiver indisponível — e essa é uma degradação aceitável.

- **Sync OMIE → Postgres é agora uma dependência operacional crítica.** Se o n8n falhar no sync, o Atlas começa a mostrar dados defasados silenciosamente. Mitigação: um monitor dedicado verifica o `MAX(dDtAlt)` das tabelas críticas e compara com o horário atual; se defasagem passar de N minutos, dispara alerta.

## Implicações para outros ADRs

- **ADR-0002 (Postgres via views)**: as views do schema `shared` podem projetar tanto sobre tabelas privadas de módulo (hedge, stockbridge, etc.) quanto sobre tabelas OMIE em `public`. Isso é explicitamente permitido. As views consolidam dados do OMIE (sincronizados pelo n8n) com dados calculados pelos módulos.

- **ADR-0006 (n8n como hub)**: o sync OMIE é a responsabilidade n8n mais crítica hoje. Já estava implícito, este ADR torna explícito que o Atlas depende disso.

## Alternativas rejeitadas

- **Atlas com cliente OMIE pleno (leitura + escrita), n8n só pra backup.** Rejeitado: duplicaria o trabalho do n8n, sobrecarregaria o rate limit OMIE, adicionaria latência no caminho do usuário, e reinventaria um pipeline de ETL que já existe e funciona.

- **Abandonar o sync n8n e fazer o Atlas polar OMIE direto.** Rejeitado: "não quebrar o que está funcionando" + a regra prática do ADR-0006 ("orquestração e ETL na borda → n8n").

- **Atlas lê tudo via API OMIE em tempo real**, sem sincronizar no Postgres. Rejeitado por latência, rate limit e acoplamento com disponibilidade externa. O Postgres local é infinitamente mais rápido e confiável.
