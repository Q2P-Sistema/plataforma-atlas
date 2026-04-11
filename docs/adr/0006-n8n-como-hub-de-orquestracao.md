# ADR-0006: n8n como hub de orquestração e gateway de LLM

**Status:** Aceito
**Data:** 2026-04-11

## Contexto

O Flavio já opera n8n em produção na mesma infra do Atlas, com workflows ativos há tempo suficiente pra ter sido validado contra problemas reais. O sync OMIE → Postgres é feito hoje inteiramente por n8n (ETL agendado, escrevendo nas 28 tabelas `tbl_*_ACXE/Q2P` do schema `public`). Snapshots horários do banco também são orquestrados por n8n. Workflows críticos são backupeados automaticamente pro GitHub por um fluxo n8n existente.

Surgiram três novas necessidades que poderiam ser implementadas em TypeScript dentro do Atlas ou em n8n:

1. **Pipeline de OCR do módulo comex** — upload de PDF → extração estruturada via LLM → persistência no domínio.
2. **Roteamento de notificações** — Telegram, WhatsApp, e-mail e audit log por severidade/tipo de evento.
3. **Integração com LLMs em geral** — classificação semântica, resumos automáticos pro C-Level, preenchimento automático de formulários.

Implementar essas coisas em TypeScript significa código novo pra manter, testar, deployar. Implementar em n8n aproveita infra existente, é visual, permite o chefe editar sem pedir deploy, e mantém workflows versionados via o fluxo de backup já existente.

## Decisão

**n8n é o hub de orquestração, ETL, integrações externas e gateway de LLM do Atlas. O código TypeScript em `apps/api` e `modules/*` continua sendo a fonte de verdade do domínio, responsável por lógica de negócio, transações e cálculos.**

### Responsabilidades do n8n

- **ETL OMIE → Postgres** (sync incremental por `dDtAlt`, já em produção — mantém).
- **Pipeline de OCR comex**: Atlas faz upload do PDF pra Backblaze B2 e emite evento "documento.novo" num endpoint interno; n8n escuta, dispara um agente OCR com LLM, posta o resultado estruturado de volta num endpoint do Atlas que persiste.
- **Gateway único de LLM**: toda chamada de LLM do Atlas vai via webhook n8n. Atlas manda `{task, context, data}`; n8n decide qual provider usar (Claude, OpenAI, Gemini), aplica o prompt correto e retorna resultado estruturado. Trocar de provider é mudança de um nó no n8n, zero deploy do Atlas.
- **Roteamento de notificações**: Atlas emite evento de alerta; n8n decide canal (Telegram, WhatsApp via Z-API, e-mail via Sendgrid, audit log) baseado em severidade, tipo e janela temporal.
- **Webhooks externos**: CRM Q2P e quaisquer outros sistemas terceiros notificam n8n primeiro; n8n normaliza e posta pro Atlas via endpoint interno.
- **Cron jobs**: toda tarefa agendada (sync, mark-to-market diário, resumos periódicos, backup) fica em n8n. **Não usar `node-cron` dentro do Atlas.**
- **Automações operacionais leves** que o chefe ou operadores queiram ajustar sem pedir deploy.

### Não-responsabilidades do n8n

- **Cálculo financeiro**: Motor MV, mark-to-market, buckets, NDFs, PTAX → TypeScript sempre. Bug aqui vaza dinheiro.
- **Escrita transacional em tabelas de domínio** (lotes, movimentos, títulos USD, bucket_mensal) → TypeScript com `BEGIN/COMMIT`.
- **Lógica dual-CNPJ StockBridge**.
- **Validação de regras de negócio** (FK, constraints, invariantes de domínio).
- **Qualquer operação que toque dinheiro calculado.**
- **LISTEN/NOTIFY cross-módulo** — fica dentro do processo `apps/api` (ADR-0004). n8n consome via HTTP webhook quando precisa reagir a um evento interno.
- **Queries síncronas que a UI espera** — latência do n8n é alta demais para caminho do usuário. UI chama Atlas, Atlas lê BD direto.
- **Transações multi-tabela**.

### Regra prática

> Operação idempotente + orquestração + I/O com sistemas externos + LLM → n8n.
>
> Calcula dinheiro, escreve estado de domínio, precisa de transação, testável por regra → TypeScript.

## Consequências

- **Menos código TS pra escrever e manter.** Pipeline OCR, ETL OMIE, roteamento de alerta, chamadas LLM, cron — tudo isso sai do escopo do Atlas. O TS fica concentrado em lógica de negócio e camada HTTP.
- **Swap de provider LLM é trivial.** Trocar Claude por Gemini, adicionar fallback entre providers, versionar prompts — tudo acontece dentro do workflow n8n sem deploy do Atlas.
- **O chefe pode editar workflows operacionais** sem tocar no código-fonte. Respeita o estilo de "vibecoding" dele onde apropriado, sem comprometer o núcleo TS.
- **Ponto único de falha n8n**: se o n8n cair, OCR para, alertas param, sync OMIE para. Mitigações: (1) monitoramento do n8n via healthcheck no `/api/health` do Atlas; (2) backup de workflows no GitHub permite recovery rápido; (3) o Atlas em si continua funcionando pra operação síncrona (UI, queries, comandos do usuário) mesmo sem n8n.
- **Fronteira tem que ser respeitada.** A tentação de "resolver no n8n porque é mais rápido" em lógica de domínio vai aparecer. A regra prática acima é lei — se aparecer n8n calculando câmbio ou criando lote no banco via SQL solto, apaga e reescreve em TS imediatamente.

## Disciplinas obrigatórias

1. **Contratos HTTP documentados.** Toda comunicação Atlas ↔ n8n é via endpoints HTTP com schema OpenAPI. n8n nunca escreve direto no Postgres com SQL solto. n8n nunca bypassa o código de validação do Atlas.

2. **Versionamento de workflows críticos.** Workflows que tocam fluxo de negócio ou integração financeira (sync OMIE, pipeline OCR, roteamento de alerta, gateway LLM) ficam versionados no GitHub via o fluxo de backup existente do Flavio. Workflows puramente operacionais que o chefe edita livremente podem ficar fora do git.

3. **Healthcheck do n8n.** O endpoint `/api/health` do Atlas inclui uma verificação de que o n8n está vivo e respondendo. Se o n8n estiver down, a resposta reporta `{n8n: "unhealthy"}` e qualquer monitor externo vai gritar.

4. **Testes do lado Atlas cobrem os endpoints que o n8n chama.** O workflow n8n não é testável por unidade, mas o endpoint interno `/api/internal/omie/sync-delta`, `/api/internal/documentos/ocr-result`, etc., são testáveis com Vitest + Supertest. Isso garante que se o workflow estragar, o Atlas rejeita input inválido em vez de corromper estado.

5. **Monitoramento de execução.** Workflows que falham em produção emitem alerta no mesmo canal de notificação do Atlas (via o próprio roteador n8n — meta, mas funciona). Execuções com erro ficam registradas no audit log do Atlas sempre que afetam dados de domínio.

## Alternativas rejeitadas

- **Fazer tudo em TypeScript dentro do Atlas.** Dobraria o código a escrever, dobraria a superfície de bug, centralizaria orquestração num processo já responsável por lógica de domínio. Sem benefício real em troca.
- **Implementar um service bus próprio** (ex: BullMQ + workers). Possível, mas reinventa o que o n8n já faz, adiciona Redis dependency mais pesada e exige escrever UI de observabilidade. Ganho: testabilidade maior dos workflows. Custo: muito código novo. Não vale pro volume atual.
- **Colocar lógica de domínio dentro de workflows n8n** (ex: calcular mark-to-market do Hedge num workflow). Rejeitado de antemão: workflows n8n não são testáveis por unidade, não rodam em transação, não versionam bem, e esconder cálculo de câmbio num JSON é receita de bug silencioso em dinheiro.
