# 🏄‍♂️ Atlas — Constituição Técnica

> **Projeto:** Atlas — Plataforma ACXE+Q2P
> **Status:** Constituição ativa
> **Data:** 2026-04-11
> **Base:** adaptado do template [SpecKit Vibe Coder](https://github.com/promovaweb/vibe-tech-stack-checklist) para o contexto do Atlas.

Este documento é a **lei técnica** do Atlas. Toda decisão de arquitetura, sugestão de código, revisão de PR e proposta de feature deve respeitar o que está escrito aqui. Contradizer uma decisão documentada exige abrir discussão explícita e atualizar o documento — não é opção tácita.

As decisões aqui são complementadas pelos **Architecture Decision Records** em [docs/adr/](docs/adr/). Quando uma pergunta da constituição tem um ADR correspondente, o ADR é a fonte de verdade detalhada e o campo `💡 Motivo` cita a referência.

---

## 1. A Planta da Casa (Arquitetura e Organização)

### Qual linguagem, framework e bibliotecas o time vai usar?

- **Stack padronizada** (linguagem + framework + libs principais definidos).

> 💡 Motivo: Stack unificada garante previsibilidade em code review, onboarding e vibecoding com assistente de IA. Ver [ADR-0001](docs/adr/0001-monolito-modular.md).

**Stack definida:**
- **Linguagem:** TypeScript (strict mode, ES2022, bundler resolution)
- **Runtime:** Node.js 20 LTS
- **Framework backend:** Express
- **Framework frontend:** React 18 + Vite
- **Banco de dados:** PostgreSQL 16 com extensão `pgvector`
- **Cache / rate limit:** Redis 8
- **Reverse proxy:** Traefik
- **Orquestração:** Docker Swarm (via Portainer), 1 VPS manager + 1 VPS database na DigitalOcean
- **Monorepo:** pnpm workspaces + Turborepo
- **Query builder / migrations:** Drizzle + Drizzle Kit (schema type-safe sem ORM pesado)
- **Design system:** shadcn/ui + Tailwind CSS
- **Estado cliente:** Zustand (client state) + TanStack Query (server state)
- **Testes:** Vitest + Supertest
- **Logs:** Pino (estruturado JSON) → Loki → Grafana (self-hosted no Swarm)
- **Validação de schema (runtime):** Zod
- **E-mail transacional:** Sendgrid API (SMTP é bloqueado pela DigitalOcean)
- **Storage de arquivos:** Backblaze B2 via S3-compatible SDK (`@aws-sdk/client-s3` com endpoint customizado)
- **Hub de orquestração:** n8n (ver [ADR-0006](docs/adr/0006-n8n-como-hub-de-orquestracao.md))

### Onde escrevemos as regras pesadas do app?

- **Service Layer** — arquivos separados só pra regra de negócio, dentro de cada módulo em `modules/*/src/services/`.

> 💡 Motivo: Rotas (`modules/*/src/routes/`) ficam finas e só fazem binding HTTP → service. Services concentram regra de domínio, são testáveis isoladamente e podem ser chamados por outros módulos via `index.ts` público.

### Como agrupamos nossos arquivos e pastas?

- **Por Assunto / Feature** (modules por domínio: hedge, stockbridge, breakingpoint, clevel, comexinsight, comexflow, forecast).

> 💡 Motivo: O Atlas é monólito modular — cada módulo é um domínio com suas regras, rotas, serviços e tabelas privadas. A estrutura física do repositório reflete a arquitetura. Ver [ADR-0001](docs/adr/0001-monolito-modular.md).

### Textos e Status "Mágicos" (ex: "PAGO", "PENDENTE")

- **Enums / Constantes** (TypeScript `const` objects ou Zod enums em `packages/core/src/enums/`).

> 💡 Motivo: Status duplicados como string em vários lugares são a receita clássica pra bug de digitação silencioso em sistema financeiro. Zod enums dão validação runtime de graça.

### Como nomeamos as coisas no código?

- **Padronizado**: código e identificadores em **inglês**, `camelCase` em TypeScript (variáveis, funções), `PascalCase` em tipos e componentes React, `SCREAMING_SNAKE_CASE` em constantes de módulo. **SQL em `snake_case`** (tabelas, colunas, índices) seguindo convenção Postgres.

> 💡 Motivo: Inglês pro código facilita uso de libs e ferramentas internacionais; snake_case em SQL evita `"quotedIdentifiers"` no Postgres e conversão acontece na camada do query builder.

### Como lidamos com ferramentas de terceiros (ex: OMIE, BCB, Backblaze, Sendgrid)?

- **Tradutor (Interfaces)**: cada integração externa vive em `packages/integrations/<provider>/` ou `integrations/crm/` com interface abstrata e implementação concreta.

> 💡 Motivo: Trocar provider (ex: Sendgrid por SES) vira edição em um pacote só, não em 20 arquivos. Testes usam implementações fake injetadas no mesmo contrato.

### O sistema tem planos com limites de uso (ex: Free, Pro, Enterprise)?

- **Sem limites**. Sistema corporativo interno.

> 💡 Motivo: Atlas é plataforma operacional interna da ACXE+Q2P; não há monetização, não há tiers, não há cliente externo pagando. Usuários são funcionários internos com roles (operador/gestor/diretor).

### O sistema precisa emitir Nota Fiscal ou boleto?

- **Não emite diretamente**. OMIE é a fonte de verdade fiscal.

> 💡 Motivo: Regra imutável do ecossistema — "ERP OMIE é fonte de verdade pra NFs e contas, nada de status manual". A única exceção é o StockBridge, que **solicita** emissão de NF entrada ao OMIE via API depois de escolher armazém; o Atlas nunca gera a NF localmente. Ver [ADR-0007](docs/adr/0007-omie-le-do-bd.md).

### Como organizamos os repositórios do projeto?

- **Monorepo** — front, back, packages compartilhados e docs convivem no mesmo repositório, gerenciado por pnpm workspaces + Turborepo.

> 💡 Motivo: Permite mudanças atômicas entre módulos, compartilhamento de tipos TS entre backend e frontend, pipeline CI único. Ver [ADR-0001](docs/adr/0001-monolito-modular.md).

---

## 2. O Baú do Tesouro (Banco de Dados)

### Qual o tipo de banco de dados principal do projeto?

- **Banco Relacional (SQL)** — PostgreSQL 16 com extensão `pgvector`.

> 💡 Motivo: Dados financeiros estruturados exigem ACID, FKs e queries analíticas complexas (dashboards, agregações, intercompany elimination). Postgres já está em produção com 28 tabelas OMIE sincronizadas. pgvector está disponível pra quando precisar embeddings (sinônimos de produto, busca semântica).

**Banco escolhido:** `PostgreSQL 16 + pgvector` (instância DigitalOcean, banco `dev_acxe_q2p_sanitizado`).

### Quando o usuário clica em "Excluir Conta"?

- **Soft Delete** — coluna `deleted_at timestamptz NULL` em todas as tabelas de domínio; queries normais filtram `deleted_at IS NULL`.

> 💡 Motivo: Sistema financeiro não pode perder histórico silenciosamente. Snapshots, posições, lotes e títulos têm valor contábil mesmo "excluídos". Hard delete só via script administrativo explícito, em casos como expurgo pós-prazo de retenção.

### Quem é o segurança da porta dos dados?

- **O Banco também (Constraints)** — CHECK constraints, NOT NULL, tipos específicos (`numeric(15,2)` pra valor, `timestamptz` pra data), FKs com `ON DELETE RESTRICT` em relações críticas.

> 💡 Motivo: Bug no código TS é possível e vai acontecer; banco bem constrainado vira rede de segurança final. Preço negativo, data inválida, FK órfã — tudo rejeitado pelo Postgres antes de virar dado ruim.

### Como guardamos dados muito variados (ex: categorias OMIE, configurações)?

- **JSONB** — coluna `jsonb` com validação Zod no código TS e CHECK constraints de estrutura mínima no Postgres onde fizer sentido.

> 💡 Motivo: Campo `categorias` em `tbl_contasPagar_ACXE` já é JSONB nativo do OMIE (array de `{cCodCateg, nValorCateg, cDescCateg}`). Configurações de plataforma e parâmetros dinâmicos por módulo também vivem bem em JSONB. Pra buscas, usar índices `GIN`.

### Listas muito grandes (ex: histórico de movimentos do StockBridge, títulos USD do Hedge)

- **Cursor (keyset pagination)** pra listas grandes (histórico, audit log, movimentos).
- **Offset** pra listas curtas e paginadas por UI tradicional (cadastros, menus).

> 💡 Motivo: Cursor é ultra rápido mesmo com milhões de linhas e não sofre de "salto de página" quando o dataset muda entre requests. Offset é mais simples e serve pra sub-1000 registros. Cada tela escolhe a técnica apropriada.

### E se a gente precisar adicionar tabelas novas?

- **Migrations** obrigatórias versionadas em `packages/db/migrations/` via Drizzle Kit.

> 💡 Motivo: Migrations são a única forma de garantir que dev, staging e prod estejam em sincronia. Qualquer alteração de schema passa por arquivo de migration, commit, PR review, e aplicação automatizada em deploy. Ver [ADR-0002](docs/adr/0002-postgres-views-compartilhadas.md).

### Onde fazemos as contas (ex: "Exposição USD total por localidade")?

- **No Banco (SQL)** — agregações via views no schema `shared` ou queries com `SUM/GROUP BY` direto no Postgres.

> 💡 Motivo: Agregado financeiro pesado em JavaScript é lento e consome memória à toa. Postgres foi feito pra isso. Views em `shared` consolidam cross-módulo como contrato público ([ADR-0002](docs/adr/0002-postgres-views-compartilhadas.md)).

### Precisamos saber quem mudou o quê e quando?

- **Audit Log append-only** — triggers PL/pgSQL em todas as tabelas de domínio crítico gravam em `shared.audit_log`. Impossível de contornar mesmo via `psql` direto.

> 💡 Motivo: Regra imutável do ecossistema + requisito legal pra sistema financeiro + defesa contra alteração acidental ou maliciosa. Trigger no banco garante que toda mutação fica registrada, independente do caminho (API, script, psql).

### O sistema atende uma empresa ou várias ao mesmo tempo?

- **Single-tenant** (consolidando ACXE + Q2P como um único grupo econômico).

> 💡 Motivo: Atlas é interno e opera sobre um único banco. Dual-CNPJ (Acxe + Q2P) é regra de domínio do StockBridge, não multi-tenancy real — as duas empresas fazem parte do mesmo grupo e compartilham estoque físico com regras específicas de fiscalização cruzada.

### As tabelas foram normalizadas ou ficamos com dados repetidos?

- **Normalizado (3NF)** como padrão. Desnormalização pontual justificada por performance, com nota explícita no código ou na migration.

> 💡 Motivo: 3NF é o default sensato pra dados transacionais. Desnormalizar antes de ter dado concreto de performance é premature optimization. Quando o snapshot do Hedge ou uma projeção do C-Level precisar de denormalização, faz-se via materialized view, não duplicando dados no modelo transacional.

### Como as tabelas se "conversam" no banco?

- **Foreign Keys de verdade** — todas as relações usam FK constraints com `ON DELETE RESTRICT` por padrão; `ON DELETE CASCADE` só quando explicitamente fizer sentido (ex: itens filhos de um aggregate root).

> 💡 Motivo: Banco vira guardião de integridade referencial. Impossível ter `movimento` sem `lote`, `titulo_usd` sem `fornecedor`, `bucket_mensal` sem `posicao_snapshot`.

### Escrevemos SQL na mão ou usamos um "Tradutor" (ORM)?

- **Query builder type-safe sem ORM pesado** — Drizzle. SQL fica legível e explícito; tipos vêm do schema TS.

> 💡 Motivo: ORM pesado (Prisma, TypeORM) esconde query ruim e abstrai demais — perigoso em sistema financeiro onde o plano de execução importa. SQL puro é verboso e perde tipos. Drizzle é o meio-termo: schema TS gera tipos, mas a query continua visual e próxima do SQL real.

### Qual ORM, query builder e ferramenta de migration o time vai adotar?

- **Ferramenta padrão definida** e migrations obrigatórias no repositório.

> 💡 Motivo: Padronização elimina ambiguidade e facilita vibecoding com Claude.

**Ferramentas definidas:**
- **Query builder:** Drizzle ORM (modo query builder, não modo ORM cheio)
- **Migration tool:** Drizzle Kit (schema declarativo TS gera SQL de migration)
- **Runtime SQL:** `pg` (postgres-js também é opção futura)

### Quais colunas têm índice no banco?

- **Índices nas colunas certas** — toda coluna usada em `WHERE`, `ORDER BY`, `JOIN` frequente, e toda FK ganha índice. Análise via `EXPLAIN ANALYZE` antes de indexar em dúvida.

> 💡 Motivo: Financeiro tem muita query por período + fornecedor + status. Sem índice, query de dashboards fica insuportável em 6 meses de dados.

### E se duas operações no banco precisam acontecer juntas ou não acontecem?

- **Dentro de uma Transaction** — fluxos financeiros, criação de lote + movimento, emissão de NF + atualização de posição, tudo em `BEGIN/COMMIT`. `ROLLBACK` automático em erro.

> 💡 Motivo: Obrigatório em qualquer fluxo de domínio. Lote sem movimento é corrupção; título USD sem marcação de câmbio é dinheiro perdido. O Drizzle suporta transação nativa, usar sempre que tocar mais de uma tabela.

---

## 3. A Velocidade da Luz (Performance e Filas)

### Tarefas que demoram (sync OMIE, mark-to-market diário, geração de relatório)

- **Fila de Background** — toda tarefa assíncrona orquestrada por **n8n** (workflows agendados e disparados por webhook).

> 💡 Motivo: n8n já está em produção orquestrando ETL OMIE e backup. Ver [ADR-0006](docs/adr/0006-n8n-como-hub-de-orquestracao.md). Atlas não usa `node-cron` nem queue library — se precisar async, é n8n.

### O App bombou na Home! Como aliviar?

- **Cache / Redis** — respostas de dashboard e agregações pesadas são cacheadas com TTL curto (ex: 5 min para posição Hedge, 1 hora pra cotação PTAX). Invalidação por evento LISTEN/NOTIFY quando há mudança upstream.

> 💡 Motivo: Dashboards do C-Level e Hedge são consultados muitas vezes por sessão; recalcular a cada request sobrecarrega Postgres à toa. Redis 8 é bola pra frente e já estava previsto na stack.

### Problema do N+1 (Consultas repetidas no banco)

- **Eager loading** — joins explícitos em SQL via Drizzle. Cross-módulo via views do `shared`.

> 💡 Motivo: SQL puro força explicitar o join. Código tipo `for (item of items) { item.relacionado = query(...) }` é proibido em code review.

### Tamanho dos arquivos enviados pelos usuários (documentos comex, NFs digitalizadas)

- **Limite de upload por tipo + validação de content-type + storage externo**. Uploads vão direto pra Backblaze B2 (S3-compatible), nunca ao disco do servidor. Compressão ou processamento (OCR) acontece no pipeline n8n, não síncrono.

> 💡 Motivo: Volume baixo previsto, mas o princípio é o mesmo: disco do Swarm não armazena binário de usuário. Backblaze B2 é mais barato que S3 e tem API compatível — mesmo SDK funciona. Ver seções 9 e 15.

### Se a API externa (OMIE, BCB, Backblaze, Sendgrid) cair?

- **Fallback gracioso** para integrações externas. Dados do OMIE lidos do Postgres (ADR-0007) continuam disponíveis mesmo com API OMIE down. PTAX usa último valor cacheado. Pipeline de OCR degrada para "extração manual" se LLM estiver indisponível.

> 💡 Motivo: Regra imutável — fallback gracioso vale para **integrações externas**, nunca entre módulos internos (que são chamadas de função in-process). Ver [ADR-0003](docs/adr/0003-crm-externo.md).

### O usuário afobado (Clica 10x no botão)

- **Debounce / Rate Limit** — botões importantes desabilitam no primeiro clique (controle de estado React) + rate limit no servidor por IP/usuário via `express-rate-limit` + Redis store.

> 💡 Motivo: Defesa em camadas. Front previne boa parte; backend é a defesa final contra scripts e afobados sofisticados.

### Como o usuário encontra conteúdo dentro do app?

- **Filtros via SQL `ILIKE` + índices GIN (trigram)** no começo. Se precisar busca semântica ou por similaridade (ex: sinônimos de produto no StockBridge), usar **pgvector** com embeddings via n8n → LLM.

> 💡 Motivo: 95% das buscas do Atlas são filtros exatos ou textuais simples (filtrar títulos por fornecedor, período, status). `ILIKE` + `pg_trgm` resolve. Busca semântica fica como upgrade opcional quando aparecer dor real.

---

## 4. Os Seguranças da Balada (Segurança)

### Como o app lembra quem fez Login?

- **Cookies httpOnly + Secure + SameSite=Lax** com CSRF token para ações mutativas.

> 💡 Motivo: Atlas é só web (sem mobile), e cookies httpOnly são blindados contra XSS (JavaScript não lê). Mais seguro que JWT em localStorage, que vaza pra qualquer script injetado.

### Onde guardamos as Chaves Secretas (Senha do Banco, API Keys, Sendgrid, Anthropic)?

- **Cofre invisível (`.env`)** em dev; **Docker Secrets do Swarm** em staging e produção.

> 💡 Motivo: `.env` nunca vai pro git (`.env` está no `.gitignore`). Em prod, Docker Secrets do Swarm evita que chaves apareçam em `ps`, logs ou `docker inspect`. Portainer gerencia sem precisar subir HashiCorp Vault.

### Como as chaves secretas chegam ao servidor de produção?

- **Docker Secrets gerenciados via Portainer.** Flavio (ou quem tiver acesso admin) cadastra a secret uma vez; o container consome via montagem em `/run/secrets/<name>`. Nenhuma chave fica em variável de ambiente visível.

> 💡 Motivo: Simples, blindado contra vazamento em logs/dashboards, sem infra extra além do que o Swarm já oferece. Rotação manual por enquanto (volume baixo de rotações); se virar rotina, adicionar automação via n8n.

### Como guardamos a senha do usuário?

- **Hash criptográfico** com **argon2id** (preferência) ou bcrypt como fallback.

> 💡 Motivo: argon2id é o padrão moderno recomendado pela OWASP. Senha em texto puro é ilegal (LGPD) e imoral. Reset por link expirável.

### Controle de Acesso (Quem pode aprovar uma NDF?)

- **Roles (operador / gestor / diretor) + Policies pontuais** para casos que dependem do recurso específico.

> 💡 Motivo: 90% dos casos são cobertos por role checking (`requireRole('gestor')`). Policies entram quando a regra envolve o recurso em si, ex: "só gestor pode aprovar NDF acima de USD 500k" ou "diretor vê DRE consolidado; gestor vê só a empresa dele".

### Defesa contra formulários fantasmas (CSRF / CORS)

- **CORS restrito ao domínio do frontend** + **CSRF tokens** em mutações via middleware (`csurf` ou similar moderno). Cookies com `SameSite=Lax` já cobrem boa parte.

> 💡 Motivo: Defesa em camadas. CORS bloqueia chamadas cross-origin de browsers, CSRF token protege contra submissão forjada mesmo de origem esperada.

### O cara que muda o ID da URL (IDOR)

- **Checagem de identidade em toda rota mutativa e toda leitura sensível** — middleware valida `user.role + user.empresa_id` contra o recurso antes de retornar/alterar. Logs de tentativa de acesso indevido vão pro audit log.

> 💡 Motivo: Sistema B2B interno, mas tem usuários com escopos diferentes (operador da Acxe não pode ver dados financeiros da Q2P). Validação de ownership é mandatória.

### O usuário entra com credenciais próprias ou login social?

- **Credenciais próprias** gerenciadas dentro do Atlas. Sem OAuth social, sem SSO corporativo (por enquanto).

> 💡 Motivo: Mesmo modelo do sistema de recebimento PHP atual. Usuários são funcionários internos; SSO corporativo pode ser adicionado depois se a empresa adotar Google Workspace/M365 e pedir integração.

### O usuário fica logado para sempre?

- **Expiração automática** — sessão expira após 8 horas de inatividade ou 24 horas absolutas, o que vier primeiro. Refresh silencioso durante sessão ativa.

> 💡 Motivo: Financeiro pede sessão curta. 8h de inatividade cobre jornada de trabalho; 24h absolutas impede sessão "zumbi" esquecida.

### O app vai exigir uma segunda confirmação de identidade (2FA)?

- **2FA obrigatório para roles `gestor` e `diretor`; opcional para `operador`** — via TOTP (Google Authenticator, 1Password, etc.).

> 💡 Motivo: Quem aprova NDF, vê DRE consolidado ou mexe em limite de banco precisa da camada extra. Operador de StockBridge movimentando lote pode começar sem 2FA e ativar depois.

### O que acontece se alguém tentar adivinhar a senha errada mil vezes?

- **Rate limiting no login + bloqueio temporário** — 5 tentativas falhas em 10 minutos bloqueiam o usuário por 30 minutos; bloqueio por IP após N tentativas em múltiplas contas.

> 💡 Motivo: Proteção básica obrigatória, `express-rate-limit` + store Redis resolve. Bloqueio temporário (não permanente) pra não transformar força bruta em DoS do próprio usuário legítimo.

### Como o usuário recupera a conta se esquecer a senha?

- **Link com expiração por e-mail** — token de uso único, expira em 30 minutos, invalidado após uso, enviado via Sendgrid.

> 💡 Motivo: Padrão seguro e esperado. Token de 30 min reduz janela de ataque se o e-mail for comprometido.

---

## 5. A Cara do App (Comunicação Front e Back)

### O usuário vai acessar pelo celular, computador ou pelos dois?

- **Só Web (responsiva)**. Layout adapta até tablet; celular é uso secundário.

> 💡 Motivo: Atlas é ferramenta de escritório, usada principalmente em desktops dos escritórios da ACXE e Q2P. Uso mobile é eventual (diretor checando resumo na rua). Tailwind + shadcn/ui dão responsividade de graça.

### O App é uma página que se monta no navegador ou no servidor?

- **SPA (Single-Page Application)** — React + Vite, build estático servido por nginx:alpine atrás do Traefik.

> 💡 Motivo: Sistema interno, zero necessidade de SEO, experiência de app moderna. SSR adicionaria complexidade (Next.js) sem benefício real.

### O que o back-end devolve quando tudo dá certo?

- **Envelope Padrão** — toda resposta tem forma `{ data: T, error: null, meta?: {...} }`. Erros vêm com `{ data: null, error: { code, message, fields? }, meta?: {...} }`.

> 💡 Motivo: Front faz um parser único. Campo `meta` carrega paginação (`nextCursor`, `total`) ou warnings não-fatais.

### O que o back-end devolve quando dá ERRO (ex: CPF inválido)?

- **Mapa de Erros estruturado** — `error.fields` é um objeto `{ fieldName: "mensagem human-readable" }` para erros de validação. `error.code` é um enum de tipos de erro (`VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `CONFLICT`, etc.).

> 💡 Motivo: Front pinta o campo errado em vermelho e mostra mensagem específica; sem parsing de string.

### O Front-end pede uma busca com 3 filtros. Como ele manda isso?

- **Query string GET** — `?status=aberto&fornecedor=123&periodo=2026-01..2026-03`. Links ficam compartilháveis.

> 💡 Motivo: Filtros de listagem em GET permitem salvar bookmark, compartilhar link com colega, cache HTTP. POST com body só para buscas que incluem dados sensíveis ou muito grandes (raro no Atlas).

### Se precisarmos mudar muito o App no futuro? (Versionamento)

- **Prefixo `/v1/` em todas as rotas desde o início** — `/api/v1/hedge/titulos`, `/api/v1/stockbridge/lotes`, etc.

> 💡 Motivo: Custo zero agora, seguro barato pra quando precisar evoluir contrato sem quebrar integrações.

### Como o Back avisa o Front das rotas que existem?

- **Documentação Automática via OpenAPI / Swagger** — gerada a partir dos schemas Zod das rotas. UI Swagger exposta em `/api/docs` (acessível só em dev e staging, ou atrás de autenticação em prod).

> 💡 Motivo: Schema Zod vira contrato executável + documentação + validação runtime. `zod-to-openapi` ou similar gera o spec sem duplicar esforço.

### De onde vêm os botões, modais e tabelas do app?

- **shadcn/ui + Tailwind CSS** — componentes copiados pro `packages/ui/` e customizados no próprio repo.

> 💡 Motivo: shadcn não é lib instalada via npm, é código copiado pra dentro do repositório. Você controla cada componente, customiza livremente, sem travar em API de biblioteca externa. Tailwind dá velocidade sem código CSS espaguete.

### Qual o estilo de comunicação entre front-end e back-end?

- **REST** — recursos em URLs próprias, verbos HTTP semânticos.

> 💡 Motivo: REST é o padrão interoperável, funciona com qualquer cliente futuro (scripts, n8n, integração externa), documentação limpa via OpenAPI. tRPC foi considerado e rejeitado por amarrar demais o front ao back e dificultar uso por clientes não-TS (n8n, Postman, integrações terceiros).

### Como o front-end gerencia o estado global da aplicação?

- **Zustand** para client state (usuário logado, tema, UI state) + **TanStack Query** para server state (caches de dados vindos do backend, invalidação, refetch).

> 💡 Motivo: Separação clara entre "estado que o app controla" e "estado que o servidor controla". TanStack Query elimina 80% do boilerplate de fetch. Zustand é leve (2kb) e sem ceremônia tipo Redux.

---

## 6. Quando a Casa Cai (Erros, Logs e Alertas)

### A tela quebrou (Erro 500). O que o usuário enxerga?

- **Mensagem amigável + Trace ID** — tela genérica "Algo deu errado, contate o suporte com o código XYZ123". Trace ID é gerado por request e gravado no log estruturado.

> 💡 Motivo: Não expor stacktrace em produção (vaza infra). Trace ID permite achar o erro exato no Loki sem obrigar o usuário a descrever o bug.

### Onde a gente anota (Log) os erros do sistema?

- **Pino estruturado (JSON) → Loki → Grafana** self-hosted no próprio Swarm.

> 💡 Motivo: Pino é o logger Node mais rápido e tem JSON nativo. Loki + Grafana são free, rodam no mesmo Swarm, dão busca e dashboards decentes. Zero custo mensal vs Sentry/Datadog pagos. Sentry pode ser adicionado depois se o volume justificar.

### Como a gente sabe que o site caiu (Ficou Fora do Ar)?

- **Healthcheck + monitor externo**. Atlas expõe `GET /api/health` retornando status do processo, banco, Redis, **n8n** e integrações críticas. Monitor externo (UptimeRobot, Better Stack, ou n8n workflow dedicado na própria VPS) bate a cada 60s e alerta Telegram/WhatsApp em falha.

> 💡 Motivo: Healthcheck interno é fácil; monitor externo é o que importa, porque se o Atlas caiu inteiro, ele não consegue avisar a si mesmo. Monitor pode ser um workflow n8n em paralelo que chama `/api/health` e roteia alerta.

### Conseguimos rastrear o tempo de resposta de cada rota e o que aconteceu em cada requisição?

- **Logs estruturados por request (Pino + middleware de timing)** — cada request tem seu Trace ID, tempo total, tempo em banco, tempo em chamadas externas. APM distribuído (OpenTelemetry) **adiado** para quando houver dor real.

> 💡 Motivo: Pro volume e complexidade atuais, logs estruturados já respondem 90% das perguntas de performance. Subir OpenTelemetry + Tempo/Jaeger é complexidade prematura.

### O que a gente NÃO PODE botar nos Logs?

- **Filtro de Segredos (Sanitize)** — middleware Pino redacta automaticamente campos sensíveis: `password`, `senha`, `token`, `secret`, `authorization`, `cpf`, `cnpj`, `cookie`, `set-cookie`, `api_key`, `x-api-key`.

> 💡 Motivo: Conformidade com LGPD + senso comum. Log vaza pra lugares inesperados (backup, Loki, screenshot de alerta). Redaction automático impede que senha ou CPF entre no log por descuido.

---

## 7. Trabalho em Equipe (Git e Deploy)

### Como a gente junta o código da galera?

- **GitHub Flow** — `main` é sempre deployável; features saem em branches; merge via **Pull Request** com review obrigatório (mesmo que seja auto-review do Flavio em modo vibecoding com Claude, o PR fica registrado).

> 💡 Motivo: PR é a trilha de auditoria mesmo em equipe de um. GitHub mantém histórico de mudanças, revisão, comentários.

### Mensagens de Salvar o código (Commits)

- **Conventional Commits** — `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`, com escopo opcional `feat(hedge): ...`.

> 💡 Motivo: Histórico legível, changelog gerável automaticamente, semântica clara. Vibecoding fica mais previsível quando o padrão é rígido.

### Como o código sai do PC e vai pro Servidor (Deploy)?

- **CI/CD via GitHub Actions → Docker Hub → Portainer/Swarm** — PR aprovado e merged em `main` dispara pipeline: lint + typecheck + test + build de imagens Docker → push pra Docker Hub → Portainer atualiza a stack via API.

> 💡 Motivo: Fluxo já em uso pelo Flavio em outros projetos, zero reinvenção. GitHub Actions é free pra repo privado até 2000 min/mês, suficiente pra este escopo.

### O que a gente faz se o deploy quebrar produção?

- **Rollback documentado via Docker Swarm** — `docker service update --rollback <service>` reverte para a imagem anterior em segundos. Portainer tem botão de rollback visual.

> 💡 Motivo: Swarm mantém histórico de revisões por service, rollback é nativo. Não precisa pipeline customizado de rollback — é uma chamada de API ou um clique no Portainer.

### Quando uma tarefa (Card) está "Pronta" (Definition of Done)?

- **Em staging rodando, lint + typecheck + testes passando, PR aprovado**. Promoção pra prod é passo explícito manual (merge de uma PR de promoção, ou botão no Portainer).

> 💡 Motivo: Staging como última validação antes de prod. Testes automatizados verificam corretude de código; staging verifica corretude de comportamento.

### Os ambientes de teste e produção são separados?

- **Dev local (docker-compose) + Staging (stack paralela no mesmo Swarm) + Produção (stack principal no Swarm)**.

> 💡 Motivo: Staging como stack separada no mesmo Swarm (`atlas-staging-*`) isola por rede Docker, compartilha recursos (sem precisar VPS extra), aponta pra um banco de staging separado. Dev local é docker-compose com Postgres e Redis em containers para loop rápido de desenvolvimento.

### Se o banco explodir hoje, quando voltamos ao ar?

- **Backup em camadas**:
  - **(a) DigitalOcean gerenciado** — backup diário do servidor inteiro + snapshots horários orquestrados via n8n, retenção de 4 horas pros snapshots horários e 3 dias para 2 snapshots diários.
  - **(b) `pg_dump` horário via n8n → Backblaze B2**, retenção 7 dias.

> 💡 Motivo: Camada (a) recupera o servidor inteiro incluindo configs e volumes; camada (b) recupera só dados do Postgres, mais barato e mais rápido pra restaurar em caso de corrupção lógica (vs falha de hardware). Duas estratégias cobrem failure modes diferentes.

---

## 8. Testes e Garantia da Vibe (Qualidade)

### Qual a nossa regra de Testes Automatizados?

- **Caminho Feliz + fluxos críticos financeiros** — Vitest + Supertest cobrem: login, cálculo Motor MV Hedge, criação de lote StockBridge, dual-CNPJ, emissão de NF entrada, audit log trigger. Cobertura objetivo: 70% dos módulos, 90%+ nos services críticos.

> 💡 Motivo: 100% de cobertura é mito caro; 70% bem escolhido pega 95% dos bugs. O foco é nos fluxos onde bug = dinheiro perdido.

### Code Review (Revisão pelo Amigo)

- **PR obrigatório com review** — mesmo em modo vibecoding solo, o PR é registrado; em features grandes, o colega Laravel-expert pode ser chamado pra review pontual.

> 💡 Motivo: PR obriga o autor a reler o próprio código com olho crítico. Esse segundo olhar (mesmo que seja você mesmo 10 minutos depois) pega bug.

### Formatador de Código (Linting)

- **ESLint + Prettier + `eslint-plugin-boundaries`** — rodando no save (IDE) e no CI como bloqueio de merge.

> 💡 Motivo: `eslint-plugin-boundaries` é o enforcement da arquitetura modular. Sem ele, a regra "módulos só via index.ts público" vira convenção frágil.

### Testar integrações perigosas (OMIE, Sendgrid, LLM, Backblaze)

- **Mocks em testes unitários + sandbox quando disponível**. OMIE tem ambiente de homologação usável em staging. Sendgrid tem sandbox pra não disparar e-mail real. LLM chamado via n8n pode ser mockado com resposta canônica. Backblaze tem bucket `test` separado.

> 💡 Motivo: Testes unitários devem rodar offline e determinísticos. Teste de integração com sandbox roda em CI/staging, não em cada commit.

### O app precisa funcionar para pessoas com deficiência?

- **WCAG AA básico** — contraste suficiente, navegação por teclado, labels ARIA em campos, foco visível, texto escalável.

> 💡 Motivo: Lei Brasileira de Inclusão (LBI) aplica a sistemas corporativos. Feito desde o início, custa quase zero (shadcn/ui já entrega a11y básica de graça). Feito depois, custa refactor visual inteiro.

### Como ativamos e desativamos features sem precisar de um novo deploy?

- **Feature flags via `.env`** — habilitam ou desabilitam módulos inteiros no `apps/api` (Hedge on, StockBridge on, BreakingPoint off, etc). Flags operacionais mais finas (ex: "ativar resumo LLM no dashboard C-Level") também em `.env` ou no n8n quando forem roteamento.

> 💡 Motivo: "Deploy incremental de módulos" é exatamente isso. Ver [ADR-0005](docs/adr/0005-deploy-opcao-a-single-app.md). Flags mais sofisticadas (canário, percentual de usuários) são complexidade prematura.

---

## 9. Nuvem, Arquivos e Infra (Infraestrutura)

### Onde a gente salva os arquivos (documentos comex, NFs digitalizadas, comprovantes)?

- **Backblaze B2** (S3-compatible) — uploads vão direto pra B2 via SDK S3, nunca ao disco do servidor. Volume previsto é baixo (documentos comex, baixa frequência).

> 💡 Motivo: Backblaze é 4x mais barato que AWS S3, API 100% compatível. O mesmo SDK (`@aws-sdk/client-s3` com endpoint customizado) funciona. Disco do Swarm fica livre pra logs e volumes do Postgres. Se um dia quiser migrar pra S3 real ou MinIO self-hosted, é mudança de endpoint — zero refactor.

### Como o projeto roda no computador de um desenvolvedor novo?

- **Docker Compose** — `docker-compose up -d` sobe Postgres + Redis + um container de dev do Atlas apontando pro código local montado como volume.

> 💡 Motivo: Um comando e o ambiente sobe idêntico em qualquer máquina. Versões fixas, sem "funciona na minha máquina".

### A grande divisão: Como organizamos o projeto todo?

- **Monólito Modular** — todo código em um repositório, dois containers em produção (`apps/api` + `apps/web`), módulos isolados por fronteiras TS mas rodando no mesmo processo.

> 💡 Motivo: Ver [ADR-0001](docs/adr/0001-monolito-modular.md) e [ADR-0005](docs/adr/0005-deploy-opcao-a-single-app.md).

### O app precisa funcionar sem internet?

- **Não** — requer conexão.

> 💡 Motivo: Atlas depende de OMIE, BCB, Sendgrid, Backblaze e LLM externos. Offline first é complexidade não justificada para sistema corporativo interno usado em escritório com internet estável.

### Quem cuida de atualizar as bibliotecas e corrigir vulnerabilidades?

- **Dependabot** no GitHub + revisão humana dos PRs.

> 💡 Motivo: Dependabot cobre 90% do trabalho de atualização. PRs automáticos passam pelo mesmo pipeline CI (lint, test, typecheck) antes de merge.

### Como entregamos os arquivos estáticos (JS, CSS, imagens) aos usuários?

- **Direto do servidor (Traefik + nginx:alpine)** — sem CDN por enquanto.

> 💡 Motivo: Sistema interno, poucos usuários simultâneos, todos no mesmo país. CDN é overkill pra esse volume. Quando tiver 500+ usuários simultâneos ou usuários em outras geografias, Cloudflare grátis resolve em 10 minutos.

---

## 10. Tempo Real e Rotinas (Cron & Real-time)

### Atualizações em tempo real (ex: Hedge detectou novo título USD)

- **Server-Sent Events (SSE)** do backend para o shell React quando for preciso push ao usuário (notificações in-app, alertas, atualização ao vivo de dashboard). Para eventos **entre módulos dentro do mesmo processo**, **Postgres LISTEN/NOTIFY** ([ADR-0004](docs/adr/0004-listen-notify-bus.md)).

> 💡 Motivo: SSE é simples em Express, unidirecional (que é o que precisa: servidor notifica cliente), passa por proxies e firewalls sem dor. WebSocket seria overkill para o caso de uso. LISTEN/NOTIFY é a decisão interna pra cross-módulo.

### Avisos de Terceiros (ex: CRM Q2P, OMIE, webhook externo)

- **Campainha Automática (Webhooks) recebidos pelo n8n** — todo webhook externo cai primeiro no n8n, que normaliza e repassa pro Atlas via endpoint interno documentado.

> 💡 Motivo: n8n tem conectores prontos pra webhook, valida payload, faz retry, loga. Atlas só implementa o endpoint que o n8n chama. Ver [ADR-0006](docs/adr/0006-n8n-como-hub-de-orquestracao.md).

### Tarefas que rodam sozinhas (sync OMIE, mark-to-market, relatórios periódicos)

- **n8n cron workflows** — nada de `node-cron` dentro do Atlas.

> 💡 Motivo: Cron em n8n é visual, editável sem deploy, com histórico de execução. Sync OMIE já roda assim hoje. Mark-to-market e resumos diários seguem o mesmo padrão.

---

## 11. Dados, Métricas e Conhecimento (Cultura)

### Histórico de ações (cliques, visualizações de tela)

- **Sem ferramenta externa** no começo. Eventos de uso relevantes gravados em tabela `shared.usage_events` quando necessário.

> 💡 Motivo: Sistema B2B interno, uso mensurado por outros meios (quem faz o que vai no audit log). Mixpanel/Datadog pagos não fazem sentido nesse contexto.

### Defesa contra "Robôs e Raspadores" (Scraping)

- **Rate limit básico** + autenticação obrigatória em todas as rotas. Atlas não tem API pública.

> 💡 Motivo: Sistema interno atrás de login. Scraping é risco baixíssimo. Rate limit já resolvido em §4.

### A Regra do Escoteiro (Refatoração)

- **Melhoria contínua** — código antigo funcionando fica quieto; quando for mexer, melhora um pouco.

> 💡 Motivo: Rescrita total é o inimigo. Especialmente no porte do StockBridge PHP → TS, a tentação de "já que estou mexendo, vou refatorar tudo" vai aparecer — resista. Porte é porte; refactor é depois.

### O "Fator Ônibus" (Se alguém for atropelado, o projeto morre?)

- **README de Respeito** + ADRs versionados + Constituição técnica (este documento).

> 💡 Motivo: [README.md](README.md) explica a estrutura. ADRs em [docs/adr/](docs/adr/) preservam o porquê de cada decisão arquitetural. Este documento é a lei em uso. Juntos, permitem a um novo dev entrar e entender o sistema em uma tarde.

### O app coleta dados de rastreio ou analytics?

- **Sem banner LGPD** (uso B2B interno, usuários internos assinam termo no onboarding). Política de retenção documentada.

> 💡 Motivo: LGPD aplica a dados de pessoas físicas; no Atlas os usuários são colaboradores com consentimento contratual. Sem rastreamento de visitante anônimo, sem captura de terceiros. Retenção dos dados de domínio segue regra fiscal/contábil (5-7 anos).

---

## 12. Internacionalização e Localização

### O app vai suportar múltiplos idiomas?

- **Só português** (PT-BR), mas com estrutura de i18n desde o início — strings em `packages/ui/src/i18n/pt-BR.ts`, não hardcoded em componentes.

> 💡 Motivo: Operação é 100% Brasil. Mas estruturar i18n desde o início custa quase nada; caçar texto hardcoded depois custa muito. Inglês pode entrar depois sem refactor.

### Como exibimos datas, moedas e fuso horário?

- **Padrão definido**: **UTC no banco**, conversão pra `America/Sao_Paulo` na camada de apresentação. Formato de moeda e número via `Intl.NumberFormat`. Datas via **Day.js** com plugin `timezone`.

> 💡 Motivo: UTC no banco é lei (evita bugs de horário de verão, comparações erradas, merge cross-timezone). Day.js é leve, tem timezone nativo via plugin, e é imutável (sem surpresas tipo `moment`).

---

## 13. Comunicação com o Usuário (Notificações e E-mail)

### Como o app envia e-mails transacionais (confirmações, alertas, senhas)?

- **Sendgrid API** — DigitalOcean bloqueia SMTP, então uso é via API HTTP (`@sendgrid/mail`).

> 💡 Motivo: Sendgrid é o provedor que o Flavio já usa, com reputação de entrega estabelecida. API HTTP funciona mesmo com porta SMTP bloqueada. Para alertas, senhas e confirmações.

### E-mails de marketing e e-mails transacionais: mesmo servidor?

- **Só transacional** — Atlas não envia marketing.

> 💡 Motivo: Sistema interno B2B não tem comunicação de marketing. Se um dia tiver newsletter interna, vira um domínio/subdomain separado pra não contaminar reputação.

### Como avisamos o usuário quando ele não está com o app aberto?

- **Múltiplos canais roteados via n8n**: Telegram, WhatsApp (via Z-API ou similar), e-mail (Sendgrid) e **sempre** grava em audit log.

> 💡 Motivo: Atlas emite evento "alerta.*" com severidade e metadados; n8n decide o canal por regra operacional (ex: "severidade=alta manda Telegram; noturno manda WhatsApp; semanal resume em e-mail"). Mudar regra é 30 segundos no n8n, sem deploy. Ver [ADR-0006](docs/adr/0006-n8n-como-hub-de-orquestracao.md).

---

## 14. Pagamentos e Recorrência

**Inaplicável.** O Atlas **não processa pagamentos**. Não há gateway, não há cartão, não há PIX, não há cobrança recorrente, não há chargeback, não há sandbox de pagamento.

OMIE é fonte de verdade fiscal e financeira do ecossistema — contas a pagar e a receber são geradas, atualizadas e liquidadas lá. O Atlas **lê** (via Postgres sincronizado pelo n8n) e **calcula** (Motor MV, mark-to-market, projeção de liquidez, intercompany elim), mas **não movimenta dinheiro**.

Se algum dia o Atlas precisar processar pagamento direto (raro — provavelmente seria módulo novo tipo "portal do fornecedor"), esta seção vira aplicável e precisa ser revisitada com um ADR específico.

Regras relacionadas:
- [ADR-0003](docs/adr/0003-crm-externo.md) — CRM Q2P como integração externa
- [ADR-0007](docs/adr/0007-omie-le-do-bd.md) — OMIE é fonte de verdade, Atlas lê do BD
- Regra imutável 1 do ecossistema (OMIE como fonte de verdade pra NFs e contas)

---

## 15. Inteligência Artificial e LLMs

### Qual modelo e provedor de IA vamos usar?

- **API de provedor externo abstraída via n8n** — Atlas chama webhook do n8n, n8n decide qual provider usar. **Default inicial: Claude** (via Anthropic API). Providers alternativos (OpenAI, Gemini) podem ser adicionados como nós de fallback no mesmo workflow n8n sem deploy do Atlas.

> 💡 Motivo: Trocar provider, adicionar fallback, ajustar parâmetros (temperature, max_tokens) vira config no n8n em vez de código. Atlas não precisa saber qual LLM respondeu. Ver [ADR-0006](docs/adr/0006-n8n-como-hub-de-orquestracao.md).

### Onde ficam os prompts do sistema?

- **Dentro dos workflows n8n**, versionados no GitHub via fluxo de backup existente.

> 💡 Motivo: Prompts mudam bem mais frequentemente que código. Mantê-los no n8n permite iterar sem deploy do Atlas. Backup automático pro GitHub preserva histórico e rollback.

### Como controlamos os custos de tokens?

- **Rate limit no endpoint do Atlas que chama o n8n** + dashboards nativos do provider (Anthropic Console) + alerta via n8n quando custo mensal passar de limiar configurado.

> 💡 Motivo: Rate limit do lado Atlas garante que um loop de bug não gere milhares de chamadas. Dashboard nativo da Anthropic é suficiente pra monitoramento mensal. Se o volume crescer, migra pra Helicone ou similar.

### O que pode e o que não pode ir no contexto enviado à IA?

- **Política de sanitização** — antes de enviar pro n8n → LLM, o Atlas substitui dados pessoais identificáveis (CPF, CNPJ, nome de pessoa física) por tokens (`[CPF_1]`, `[PESSOA_A]`) quando a tarefa não exige o dado real. Dados comerciais sensíveis (valores, fornecedores) vão se o prompt depender deles. Opt-out de treinamento via config na Anthropic API (Claude já não treina em API calls por padrão).

> 💡 Motivo: LGPD + pragmatismo. OCR de NF precisa do CNPJ pra funcionar; resumo de dashboard não precisa. Decidir caso a caso e documentar.

### O que o sistema faz quando a API da IA está lenta ou indisponível?

- **Fallback gracioso** — features com LLM são tratadas como **enhancement, não bloqueio**. OCR de documento comex que falha no LLM vira "extração manual" (usuário preenche o formulário à mão). Resumo automático do C-Level que falha mostra "(resumo indisponível)" e o dashboard continua funcionando com os dados brutos.

> 💡 Motivo: LLM é complemento, nunca core. Atlas nunca trava esperando LLM responder. Timeout + retry + fallback ficam dentro do n8n; Atlas só vê "resposta estruturada OK" ou "timeout, tenta modo manual".

---

## Apêndice A — Decisões específicas do Atlas não cobertas pelo template

Estas são decisões centrais da arquitetura Atlas que o template SpecKit genérico não pergunta, mas que fazem parte da constituição.

### A.1 — Fronteiras entre módulos

Módulos em `modules/*` só se importam uns aos outros via o `index.ts` público de cada módulo. Importar de `modules/X/src/internal/*` a partir de `modules/Y` é proibido e bloqueado por `eslint-plugin-boundaries`. Quando um módulo precisa expor capacidade para outro, a capacidade é adicionada ao `index.ts` público. Ver [eslint.config.js](eslint.config.js) e [ADR-0001](docs/adr/0001-monolito-modular.md).

### A.2 — Views em schema `shared` como contrato cross-módulo

Módulos leem dados uns dos outros **apenas via views publicadas em `shared`**. Tabelas privadas de cada módulo vivem em schemas próprios (`hedge.*`, `stockbridge.*`, `comex.*`, etc.). Nunca ler tabelas cruas de outro módulo. As views são parte do contrato público, versionadas junto com as migrations. Ver [ADR-0002](docs/adr/0002-postgres-views-compartilhadas.md).

### A.3 — Postgres LISTEN/NOTIFY como bus cross-módulo interno

Eventos entre módulos dentro do mesmo processo `apps/api` usam Postgres LISTEN/NOTIFY. Emitido no `COMMIT` da transação — garante consistência transacional. Módulos reconciliam estado na inicialização para compensar eventos perdidos em restart. Ver [ADR-0004](docs/adr/0004-listen-notify-bus.md).

### A.4 — Feature flags habilitam módulos inteiros

Feature flags no `.env` do `apps/api` controlam quais módulos estão registrados no boot. "Deploy incremental do StockBridge" significa: código já está no binário, basta ligar a flag e redeploy. Um módulo desabilitado não registra rotas, não escuta eventos, não aparece no menu do shell React. Ver [ADR-0005](docs/adr/0005-deploy-opcao-a-single-app.md).

### A.5 — n8n como hub de orquestração, ETL e gateway LLM

n8n roda na mesma infra do Atlas e é responsável por: sync OMIE → Postgres (existente), pipeline OCR comex, todas as chamadas LLM, roteamento de notificações, webhooks externos, cron jobs. Atlas mantém lógica de negócio, cálculos financeiros, transações e é fonte de verdade dos dados. Ver [ADR-0006](docs/adr/0006-n8n-como-hub-de-orquestracao.md).

### A.6 — OMIE é lido do Postgres, não da API

Atlas não faz polling de OMIE. Queries de leitura vão no Postgres (sincronizado pelo n8n). API OMIE é chamada diretamente apenas em dois casos: (1) quando um dado fresquíssimo e pequeno é realmente necessário em tempo real, e (2) quando o Atlas precisa **escrever** no OMIE — hoje apenas o StockBridge emitindo NF de entrada. Ver [ADR-0007](docs/adr/0007-omie-le-do-bd.md).

### A.7 — Identidade visual unificada via `packages/ui`

O shell React é um só (`apps/web`), carrega as rotas de todos os módulos habilitados, e usa os componentes compartilhados de `packages/ui`. Cada módulo pode ter variações de tema dentro dos componentes, mas não pode importar biblioteca de componentes própria. Tema claro é padrão; ComexFlow usa tema escuro por ser interface operacional.

### A.8 — Ordem de migração dos módulos legados

**Hedge → StockBridge → Breaking Point → ComexInsight → ComexFlow → Forecast → C-Level.** Hedge vai primeiro porque é o mais maduro em desenvolvimento (JS → TS é refactor, não rescrita) e serve de cobaia pras fronteiras. StockBridge vai segundo porque é porte PHP → TS + Bootstrap → React e precisa do pipeline validado antes. C-Level vai por último porque depende de todos os outros estarem estáveis.

### A.9 — Validação em paralelo pros sistemas legados

Os sistemas legados (`sistema_hedge` em dev, `recebimento` PHP em produção) **continuam rodando** enquanto a versão Atlas é desenvolvida. Zero big-bang. Quando a versão Atlas de um módulo estiver pronta, roda em paralelo com o legado, compara outputs, e só desliga o legado quando a paridade for 100%. Apache do sistema de recebimento aposenta quando o StockBridge Atlas estiver validado.

---

## Apêndice B — Decisões abertas (ainda a decidir)

Estas são questões de negócio herdadas do plano original do chefe que ainda não foram resolvidas e não bloqueiam o início do desenvolvimento, mas precisam de decisão antes de módulos específicos entrarem em produção:

- **D2** — estrutura real do JSONB `categorias` em `tbl_contasPagar_ACXE`. Assumido como `{cCodCateg, nValorCateg, cDescCateg}` baseado em dumps; confirmar com query real antes de codar Hedge.
- **D3** — integração DI/Siscomex para `custo_usd` dos lotes. DI não está no dump OMIE. Afeta ComexInsight e StockBridge.
- **D4** — limite de tolerância para quebra técnica sem aprovação no StockBridge.
- **D6** — ordem de prioridade no débito cruzado dual-CNPJ quando múltiplos CNPJs têm físico disponível.
- **D7** — integração AIS (Marine Traffic) para ComexInsight. Fase 2.

---

## Apêndice C — Este documento é vivo

Qualquer decisão técnica que contradiga o que está aqui escrito exige:

1. Abrir discussão explícita (PR comentado, conversa registrada).
2. Atualizar a seção afetada deste documento.
3. Criar ou atualizar ADR em [docs/adr/](docs/adr/) se for decisão arquitetural.
4. Commit da atualização desta constituição junto com o código que implementa a nova decisão.

**O que NÃO é aceitável:** contradizer silenciosamente este documento com código novo. Se aconteceu sem querer, reverter ou atualizar a constituição. O documento é lei, mas lei pode ser emendada — só não pode ser ignorada.

---

**Histórico de atualizações:**
- **2026-04-11** — Versão inicial. Reescrita a partir do template SpecKit para contexto Atlas, incorporando decisões das conversas iniciais de alinhamento arquitetural e os ADRs 0001-0007.
