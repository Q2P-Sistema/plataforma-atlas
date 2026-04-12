<!--
=====================================================================
SYNC IMPACT REPORT — Atlas Constitution
=====================================================================
Version change: 0.0.0 (template vazio) → 1.0.0 (ratificação inicial)

Bump rationale:
  MAJOR (0 → 1) porque este é o primeiro estabelecimento formal da
  constituição do Atlas a partir do template SpecKit. Não há versão
  anterior para comparar incrementalmente. Toda decisão contida aqui
  é nova em relação ao estado anterior (arquivo era 100% placeholders).

Principles added:
  - I. Monólito Modular com Fronteiras Inegociáveis
  - II. OMIE é Fonte de Verdade, Atlas Lê do Postgres
  - III. Dinheiro Só em TypeScript
  - IV. Audit Log Append-Only via Trigger
  - V. Validação Paralela, Zero Big-Bang

Principles removed:
  - N/A (sem versão anterior)

Principles modified:
  - N/A (sem versão anterior)

Sections added:
  - Briefing do Projeto (contexto organizacional, escopo e estado dos ativos)
  - Core Principles (5 sub-seções)
  - Stack Técnica e Infra Obrigatórias
  - Fluxo de Desenvolvimento e Validação
  - Governance

Sections removed:
  - N/A

Templates consistency review:
  ✅ .specify/templates/spec-template.md — compatível sem mudanças.
     Os requisitos funcionais e critérios de sucesso continuam
     genéricos; os princípios do Atlas não restringem a forma da
     especificação, só exigem que as decisões de implementação
     documentadas no plan.md respeitem as regras.
  ✅ .specify/templates/tasks-template.md — compatível sem mudanças.
     Organização por user story + phases de setup/foundational/polish
     continua válida. As tarefas específicas do Atlas (migration,
     trigger de audit, feature flag de módulo) são expressadas no
     plano de cada feature.
  ✅ .specify/templates/agent-file-template.md — compatível sem
     mudanças. É um template de resumo auto-gerado.
  ✅ .specify/templates/plan-template.md — compatível sem mudanças.
     A seção "Constitution Check" do template tem o placeholder
     "[Gates determined based on constitution file]", que é
     semanticamente correto: quando /speckit.plan gera um plan.md de
     feature específica, esse placeholder é expandido para os gates
     concretos derivados desta constituição (os cinco princípios e
     seus "Gates de verificação"). Manter o template como está
     preserva compatibilidade com upstream SpecKit e permite que
     cada plan.md de feature referencie os gates do Atlas sem
     hardcoding no template.

Runtime guidance review:
  ✅ README.md — já lista os 7 ADRs e aponta pra TECH_STACK.md como
     constituição técnica longa. Compatível com este arquivo.
  ✅ TECH_STACK.md — é o documento complementar de detalhes técnicos
     (stack, segurança, deploy, IA etc). Esta constituição é a camada
     de princípios inegociáveis acima dele.
  ✅ docs/adr/0001–0007 — os sete ADRs existentes são consistentes com
     os cinco princípios estabelecidos aqui. Citados explicitamente.

Follow-up TODOs: nenhum item pendente. Todos os templates SpecKit
  dependentes estão alinhados com esta constituição sem edição. A
  próxima execução de /speckit.plan automaticamente derivará os
  gates de "Constitution Check" a partir dos cinco princípios e das
  regras da seção "Fluxo de Desenvolvimento e Validação" abaixo.

=====================================================================
-->

# Atlas Constitution

## Briefing do Projeto

O **Atlas** é a consolidação técnica da plataforma operacional interna das empresas **ACXE** e
**Q2P**, um grupo econômico brasileiro que atua em comércio exterior, importação, hedge cambial
USD/BRL e operação logística-fiscal. O projeto substitui um plano original de 7 microserviços
isolados por **um único monólito modular** em TypeScript, sobre o banco PostgreSQL já compartilhado
pelas duas empresas. A decisão de consolidar em monólito foi tomada por Flavio (executor técnico)
após análise crítica do plano anterior — banco compartilhado, equipe pequena e domínios
fortemente entrelaçados não justificavam o custo operacional de 7 serviços, e sintomas clássicos
de dor de microserviço (conflito de porta, `x-api-key` entre módulos na mesma VPS, polling OMIE
multiplicado) já estavam presentes antes da primeira linha ser escrita.

**Escopo funcional:** 7 módulos internos mais 1 CRM externo contratado.

| Módulo | Responsabilidade |
|---|---|
| **Hedge Engine** | Motor de hedge cambial USD/BRL (Motor MV), buckets, NDFs, mark-to-market. |
| **StockBridge** | Controle físico de estoque — lotes, dual-CNPJ, fase "pescado", recebimento de mercadoria. |
| **Breaking Point** | Projeção de liquidez BRL em 26 semanas, FINIMP, antecipação de recebíveis. |
| **C-Level Dashboard** | Saúde financeira global — DRE, FX sensitivity, intercompany elimination. |
| **ComexInsight** | Rastreador marítimo, 14 fases de trânsito, dono das 3 localidades virtuais de carga. |
| **ComexFlow** | Gestão do ciclo de vida de importações, Kanban 14 fases. |
| **Forecast Planner** | Pedidos planejados, lead times, sazonalidade. |

O **CRM Q2P** é operado por outra empresa contratada e fica **fora** do monorepo — integração via
cliente HTTP dedicado em `integrations/crm/`, tratado como sistema externo com x-api-key, timeout,
retry, circuit breaker e fallback gracioso. É a **única** integração do Atlas onde essas garantias
se aplicam; entre módulos internos elas não existem.

**Estado dos ativos no momento da ratificação desta constituição (2026-04-11):**

- **Hedge Engine** existe como código JavaScript em desenvolvimento, incluindo backend Node.js,
  frontend HTML, especificação `.docx` e `migration_001.sql`. Foi validado **apenas contra dados
  mockados** em sessões anteriores de vibecoding; nunca processou dado real. Não está em produção.
- **StockBridge** é o **único ativo validado em produção** do projeto: corresponde ao sistema de
  recebimento que roda há **2+ anos** em PHP puro com frontend Bootstrap, hospedado em servidor
  Apache paralelo à infra Atlas. Esse código é o mais precioso do projeto porque carrega 2 anos de
  aprendizado implícito contra edge cases reais, e será portado para TypeScript como **segundo**
  módulo a migrar, sob regime de validação paralela até paridade 100%.
- **Os outros 5 módulos** (Breaking Point, C-Level, ComexInsight, ComexFlow, Forecast Planner)
  existem apenas como specs (`.docx`) ou esboços de frontend (`.jsx`) vindos de sessões de
  vibecoding do chefe — são greenfield a partir de documentação.

**Banco de dados:** PostgreSQL 16 com extensão `pgvector` no banco `dev_acxe_q2p_sanitizado`,
hospedado em VPS DigitalOcean separada. Contém **28 tabelas OMIE** (`tbl_*_ACXE` e `tbl_*_Q2P`) já
sincronizadas incrementalmente por um pipeline **n8n em produção**. O Atlas lê do banco, não da
API OMIE — ver Princípio II.

**Infra paralela já em uso pelo Flavio:**

- **DigitalOcean Docker Swarm** (1 VPS manager + 1 VPS database), gerenciado via Portainer.
- **n8n** na mesma infra, responsável por sync OMIE, backup snapshots, orquestração operacional e
  (no Atlas) agentes OCR e gateway de LLM. Workflows críticos são backupeados pro GitHub por um
  fluxo n8n existente.
- **Traefik** como reverse proxy com labels Docker.
- **Backblaze B2** como storage S3-compatible para documentos (não fica no disco do servidor).
- **Sendgrid API** para e-mail transacional (DigitalOcean bloqueia SMTP).
- **Apache** servindo o StockBridge PHP legado, em paralelo ao Atlas, até a versão portada
  alcançar paridade validada.

**Equipe:**

- **Flavio** é o executor técnico principal, trabalhando em modo vibecoding com assistente de IA.
  Ele é o único dev full-time dedicado ao Atlas e é a autoridade de arquitetura sobre o projeto.
- **Um colega com experiência em Laravel** atua como consultor esporádico em tempo parcial
  reduzido, útil para desbloqueios pontuais e revisão de decisões operacionais.
- **O chefe** (dono da empresa) atua como direção de produto, produzindo esboços "vibecodados" de
  features que o Flavio traduz em arquitetura real, e eventualmente editando workflows
  operacionais diretamente no n8n quando apropriado. Ele **não** toca no código TypeScript.

**Usuários finais do Atlas:** funcionários internos da ACXE e Q2P, com três perfis definidos:
`operador` (operação do dia a dia — recebimento, lançamentos, consultas), `gestor` (aprovações,
limites, relatórios departamentais) e `diretor` (visão consolidada, DRE, FX sensitivity, decisão
de tesouraria). Não há usuário externo, não há SaaS, não há monetização — o Atlas é ferramenta
interna corporativa.

**Regras imutáveis herdadas do ecossistema** (reforçadas pelos princípios abaixo):

1. ERP OMIE é fonte de verdade para NFs, contas a pagar, contas a receber e cadastros. Status é
   sempre reflexo do OMIE, nunca setado manualmente.
2. Sync OMIE → Postgres é incremental por `dDtAlt`. Full-refresh em produção é proibido.
3. Audit log é append-only.
4. Fallback gracioso só vale para integrações externas (OMIE, BCB, CRM, Sendgrid, Backblaze, LLM),
   nunca entre módulos internos.
5. Tema visual claro é padrão em todos os módulos, exceto ComexFlow, que usa tema escuro por ser
   interface operacional intensiva.

**Complementaridade entre documentos do Atlas:**

- Esta **Constitution** (o arquivo que você está lendo) é a camada de **princípios inegociáveis**
  — os 5 artigos que orientam toda decisão técnica. É curta, densa e normativa.
- **[TECH_STACK.md](../../TECH_STACK.md)** é o documento técnico complementar detalhado, cobrindo
  15 seções e ~900 linhas de decisões de segunda ordem (versões, libs, segurança, deploy, i18n, IA,
  cultura). É a "constituição técnica longa" onde os princípios viram escolhas concretas.
- **[ADRs em `docs/adr/`](../../docs/adr/)** são o histórico narrativo de cada decisão
  arquitetural, com contexto, opções consideradas, consequências e alternativas rejeitadas. Cada
  ADR é datado e numerado; a constituição e o TECH_STACK.md referenciam ADRs quando apropriado.
- **[README.md](../../README.md)** é o ponto de entrada navegacional do repositório, que lista os
  ADRs, aponta para o TECH_STACK.md e orienta o leitor sobre como encontrar o resto.

Com esse contexto estabelecido, seguem os cinco princípios centrais do Atlas. Cada um é
normativo (usa MUST/DEVE para gates), traz a razão pela qual existe, e se conecta a ADRs onde
apropriado.

## Core Principles

### I. Monólito Modular com Fronteiras Inegociáveis

O Atlas é **um** monólito modular em TypeScript organizado em monorepo pnpm + Turborepo. Cada
módulo de domínio em `modules/*` expõe sua superfície pública exclusivamente através de um arquivo
`index.ts`. Importar caminhos internos de outro módulo (`modules/X/src/internal/*`) é **proibido**
e bloqueado em CI por `eslint-plugin-boundaries`. Dados cruzam módulos apenas por views publicadas
no schema Postgres `shared`; tabelas privadas vivem em schemas próprios (`hedge`, `stockbridge`,
`comex`, etc.) e nunca são lidas diretamente por outro módulo. Migrations são centralizadas em
`packages/db/migrations/`.

**Por quê:** sem fronteiras mecanicamente enforçadas, "monólito modular" vira "monólito
espaguete" em três meses. As fronteiras são o único mecanismo que permite extrair um módulo no
futuro sem cirurgia. Ver [ADR-0001](../../docs/adr/0001-monolito-modular.md) e
[ADR-0002](../../docs/adr/0002-postgres-views-compartilhadas.md).

**Gates de verificação:**

- Toda PR **DEVE** passar lint com `eslint-plugin-boundaries` sem violações.
- Toda adição de query cross-módulo **DEVE** usar view no schema `shared`; consulta direta a
  tabela privada de outro módulo é violação.
- Toda nova tabela **DEVE** nascer num schema de módulo (`hedge.*`, `stockbridge.*`, etc.), nunca
  em `public` (exceção: tabelas OMIE sincronizadas, que permanecem em `public`).

### II. OMIE é Fonte de Verdade, Atlas Lê do Postgres

O ERP OMIE é a fonte de verdade única para NFs, contas a pagar, contas a receber, cadastros e
posições de estoque. **Nenhum caminho no Atlas seta status de documento OMIE manualmente.** O sync
OMIE → Postgres é responsabilidade exclusiva do n8n (já em produção), incremental por `dDtAlt`,
full-refresh proibido em prod. Queries de leitura do Atlas vão sempre no Postgres local, nunca na
API OMIE. A API OMIE só é chamada diretamente pelo Atlas em duas situações documentadas: (1) dado
fresquíssimo e de volume pequeno que não pode aguardar o próximo ciclo de sync, (2) escrita no
ERP — hoje, exclusivamente a emissão de NF de entrada feita pelo StockBridge após escolha de
armazém.

**Por quê:** duplicar dado financeiro entre Atlas e OMIE gera divergência silenciosa, e divergência
em dinheiro é prejuízo. Ler do Postgres dá latência baixa, elimina dependência online com OMIE no
caminho do usuário, centraliza rate-limit no n8n e torna o Atlas resiliente a indisponibilidade do
ERP. Ver [ADR-0007](../../docs/adr/0007-omie-le-do-bd.md).

**Gates de verificação:**

- Toda query de leitura **DEVE** consultar o Postgres, nunca a API OMIE.
- Toda exceção (chamada direta à API OMIE) **DEVE** estar documentada em ADR ou comentário no
  service explicando por que não pode esperar o sync.
- Monitoramento **DEVE** alertar se `MAX(dDtAlt)` das tabelas críticas ficar defasado além de um
  limiar operacional definido.

### III. Dinheiro Só em TypeScript

Cálculo financeiro, escrita transacional em tabelas de domínio, validação de regras de negócio,
lógica dual-CNPJ do StockBridge e qualquer operação que toque dinheiro calculado vivem
**exclusivamente em código TypeScript** dentro de `modules/*` ou `packages/*`, com testes
automatizados cobrindo o fluxo. n8n pode orquestrar, integrar com sistemas externos, rotear
notificações, gerenciar pipeline de OCR e servir como gateway único de LLM — mas **não** calcula
dinheiro, **não** escreve em tabelas financeiras com SQL solto e **não** hospeda regra de domínio.
Transações multi-tabela acontecem dentro do processo `apps/api`, não em workflows.

**Por quê:** workflows n8n não são testáveis por unidade, não rodam em `BEGIN/COMMIT` nativo, não
versionam bem mudanças críticas e escondem lógica em JSON que não aparece em code review. Um bug
de cálculo em câmbio ou posição vaza dinheiro sem deixar rastro. A regra precisa ser absoluta
porque a tentação de "resolver rápido no n8n" vai aparecer. Ver
[ADR-0006](../../docs/adr/0006-n8n-como-hub-de-orquestracao.md).

**Gates de verificação:**

- Nenhum workflow n8n **PODE** executar SQL que escreve em tabelas de domínio financeiro. Escrita
  via HTTP em endpoints internos do Atlas com validação TS é o único caminho.
- Cálculo de Motor MV, PTAX, mark-to-market, buckets, NDFs, projeção de liquidez, DRE, intercompany
  elimination **DEVE** ter implementação em TS coberta por Vitest.
- Code review **DEVE** rejeitar PR que delega cálculo financeiro a n8n, mesmo "temporariamente".

### IV. Audit Log Append-Only via Trigger

Todas as mutações (INSERT, UPDATE, DELETE lógico) em tabelas de domínio crítico do Atlas são
gravadas em `shared.audit_log` por triggers PL/pgSQL disparados dentro da mesma transação que
executou a mutação. A tabela `shared.audit_log` é **append-only** — não aceita UPDATE nem DELETE,
impedido por privilégios Postgres e reforçado por trigger de rejeição. O caminho da trigger é
impossível de contornar, mesmo executando SQL direto via `psql` ou via qualquer worker n8n.

**Por quê:** sistema financeiro sem trilha de auditoria não é confiável, não é legal e não tem
defesa contra erro honesto ou alteração maliciosa. Trigger é o único mecanismo que garante que
auditoria acontece independente de quem ou o que escreveu — código TS, script operacional, migração
mal feita, `psql` manual. Validação no código TS é insuficiente porque é contornável.

**Gates de verificação:**

- Toda nova tabela de domínio crítico **DEVE** vir acompanhada da trigger de audit log na mesma
  migration.
- Revisão de migration **DEVE** confirmar que a trigger existe e cobre os três eventos (INSERT,
  UPDATE, DELETE).
- Testes de integração **DEVEM** incluir ao menos um caso que verifica gravação no audit log após
  operação de domínio.
- Privilégios no Postgres **DEVEM** garantir que o role da aplicação não tem permissão de UPDATE
  ou DELETE em `shared.audit_log`.

### V. Validação Paralela, Zero Big-Bang

Módulos que substituem sistemas legados em produção (hoje: StockBridge porta o sistema de
recebimento PHP em Apache; Hedge absorve o código JS em desenvolvimento atualmente mock-validado)
**NÃO** podem ir a produção substituindo o legado de uma vez. O legado segue rodando em paralelo
até que a versão Atlas do módulo produza outputs idênticos ao legado em um período de observação
operacional acordado. Só depois dessa paridade validada com dados reais é que o legado é desligado.

**Por quê:** sistema que toca dinheiro não aceita "big-bang replacement" sem perder a casa. O
único modo seguro de substituir código validado em produção (especialmente StockBridge, com 2+
anos rodando) é rodar o novo em paralelo, comparar, e só cortar quando bater. Aplicar a mesma
disciplina ao Hedge mesmo que ele não esteja em produção hoje, porque na hora de ir, a lógica
financeira precisa de validação contra dados reais pela primeira vez.

**Gates de verificação:**

- Todo módulo que substitui legado **DEVE** ter plano de validação paralela documentado antes de
  ser deployado em staging — critérios de paridade, duração, métricas comparadas.
- Promoção de staging → produção de um módulo que substitui legado **DEVE** ser decisão explícita
  registrada, não consequência automática de merge em main.
- Durante a validação paralela, divergências encontradas **DEVEM** ser investigadas e resolvidas
  no Atlas antes do desligamento do legado (a menos que explicitamente aceitas como correção de
  bug histórico do legado, documentada em ADR).

## Stack Técnica e Infra Obrigatórias

Esta seção define as escolhas de stack que são **obrigatórias** para o Atlas e não podem ser
contornadas sem amendment formal desta constituição. Os detalhes de versionamento, libs
específicas, configurações e decisões de segunda ordem vivem em [TECH_STACK.md](../../TECH_STACK.md).

- **Linguagem e runtime:** TypeScript strict + Node.js 20 LTS. Nenhum módulo pode ser escrito em
  outra linguagem sem amendment.
- **Banco:** PostgreSQL 16 com extensão `pgvector`. Extensões adicionais precisam ser aprovadas
  via ADR.
- **Cache:** Redis 8.
- **Bus cross-módulo interno:** Postgres `LISTEN/NOTIFY` dentro do processo `apps/api`
  ([ADR-0004](../../docs/adr/0004-listen-notify-bus.md)). Nenhum module bus paralelo é permitido.
- **Orquestração, ETL e gateway LLM:** n8n na mesma infra, seguindo a regra do Princípio III e o
  [ADR-0006](../../docs/adr/0006-n8n-como-hub-de-orquestracao.md).
- **Frontend:** React 18 + Vite + shadcn/ui + Tailwind. Um único `apps/web` que serve todos os
  módulos habilitados. Sem framework alternativo.
- **Design system:** `packages/ui` compartilhado; módulos não importam biblioteca de componentes
  própria.
- **Reverse proxy:** Traefik no Docker Swarm, 1 VPS manager + 1 VPS database na DigitalOcean.
- **Deploy:** Docker Swarm via Portainer + stack yaml. Dois containers em prod (`apps/api` + `apps/web`).
  Módulos habilitados por feature flag em `.env` ([ADR-0005](../../docs/adr/0005-deploy-opcao-a-single-app.md)).
- **CI/CD:** GitHub Actions → Docker Hub → Portainer/Swarm. Nenhum deploy manual de imagem em prod.
- **Storage de arquivos:** Backblaze B2 (S3-compatible) via SDK S3. Disco do Swarm não armazena
  binário de usuário.
- **E-mail transacional:** Sendgrid API (SMTP bloqueado pela DigitalOcean).
- **Integrações externas nomeadas:** OMIE (via n8n sync + cliente de escrita de exceção), BCB
  (PTAX), CRM Q2P ([ADR-0003](../../docs/adr/0003-crm-externo.md)), Sendgrid, Backblaze, provedor
  LLM via n8n.
- **Autenticação:** credenciais próprias gerenciadas dentro do Atlas, argon2id para hash, cookies
  httpOnly+Secure+SameSite=Lax + CSRF, 2FA obrigatório para `gestor` e `diretor`.
- **Observabilidade:** Pino estruturado → Loki → Grafana self-hosted no Swarm. APM/tracing distribuído
  adiado até haver dor concreta.

Qualquer substituição, adição ou remoção de item nesta lista exige ADR + amendment desta
constituição (minor ou major conforme impacto).

## Fluxo de Desenvolvimento e Validação

Esta seção define como o trabalho chega ao código sem violar os princípios acima.

- **Pull Request obrigatório para toda mudança em `main`.** Mesmo em modo solo vibecoding, o PR
  é a trilha de auditoria. Commit direto em `main` é proibido.
- **Conventional Commits** (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:` com escopo
  opcional por módulo).
- **Lint, typecheck, testes e build de imagens Docker** rodam em GitHub Actions como gate de
  merge. PR vermelho não entra em `main`.
- **`eslint-plugin-boundaries` é gate bloqueante**, não warning. Violação de fronteira de módulo
  **DEVE** impedir merge.
- **Testes automatizados com Vitest + Supertest** cobrem fluxos financeiros críticos (Motor MV,
  dual-CNPJ, emissão de NF entrada, triggers de audit log). Meta: 70% do código total, 90%+ nos
  services financeiros.
- **Architecture Decision Records** (`docs/adr/`) são criados para toda decisão arquitetural com
  impacto cross-módulo, cross-infra ou que contradiga tentação inicial. ADRs são numerados,
  datados, e referenciados nesta constituição quando apropriado.
- **TECH_STACK.md** é o documento complementar detalhado. Quando uma decisão técnica é tomada (ou
  revisada), TECH_STACK.md é atualizado no mesmo PR que implementa a decisão.
- **Ambientes:** dev local via docker-compose; staging como stack paralela no mesmo Swarm (prefixo
  `atlas-staging-*`); produção como stack principal. Promoção staging → produção é merge ou
  botão explícito, não automação escondida.
- **Feature flags no `.env`** habilitam ou desabilitam módulos inteiros; módulo desabilitado não
  registra rotas, não escuta eventos e não aparece no menu do shell.
- **Backup Postgres em camadas:** (a) DigitalOcean gerenciado (backup diário + snapshots horários
  via n8n, retenção 4h/3d), (b) `pg_dump` horário via n8n para Backblaze B2, retenção 7 dias.
- **Healthcheck do n8n** está incluído no `/api/health` do Atlas. Se n8n cair, Atlas sinaliza
  `unhealthy` e monitor externo alerta.
- **Legados em paralelo** (Princípio V) continuam rodando até paridade validada com dados reais.

## Governance

Esta constituição tem precedência sobre qualquer outra prática, convenção tácita ou preferência
pessoal que contradiga seu conteúdo. Ela não é imutável — é emendável — mas o processo de
alteração é deliberado.

**Processo de amendment:**

1. Alteração proposta **DEVE** ser apresentada em PR dedicado que edita
   `.specify/memory/constitution.md` e o `TECH_STACK.md` em sincronia quando afetar stack
   obrigatória.
2. O PR **DEVE** incluir motivação explícita (por que a regra atual está errada ou insuficiente),
   plano de migração (como o código existente será trazido para conformidade, ou justificativa
   para grandfathering), e impacto nos ADRs existentes.
3. Quando a alteração cria, remove ou redefine um princípio, um ADR novo **DEVE** ser escrito em
   `docs/adr/` e referenciado na seção afetada.
4. O Sync Impact Report no topo deste arquivo **DEVE** ser atualizado para refletir a mudança.

**Versionamento semântico desta constituição:**

- **MAJOR** — princípio removido ou redefinido de forma incompatível com código pré-existente; ou
  política de governance alterada de forma significativa.
- **MINOR** — princípio novo adicionado, seção materialmente expandida, ou gates de verificação
  fortalecidos.
- **PATCH** — clarificação, correção de redação, link corrigido, ajuste de wording que não altera
  substância normativa.

**Compliance review:**

- Todo Pull Request **DEVE** ser revisado contra os cinco princípios centrais antes do merge. O
  `/speckit.plan` de toda feature **DEVE** incluir uma seção "Constitution Check" que explicitamente
  confirma conformidade com cada princípio aplicável. Violações exigem justificativa em seção
  "Complexity Tracking" do plan.
- Violação descoberta após merge **DEVE** ser tratada como bug P1: revert, ADR explicando a
  violação e a correção, re-merge.
- A cada seis meses, ou quando grande quantidade de código novo for adicionada, uma revisão
  informal da constituição é recomendada para identificar regras obsoletas ou lacunas novas.

**Documentos relacionados:**

- [TECH_STACK.md](../../TECH_STACK.md) — constituição técnica detalhada (stack, segurança, deploy,
  IA, i18n, testes, cultura), complementar a este arquivo.
- [README.md](../../README.md) — ponto de entrada do repositório, lista os ADRs e aponta para esta
  constituição.
- [docs/adr/](../../docs/adr/) — histórico de decisões arquiteturais.

**Version**: 1.0.0 | **Ratified**: 2026-04-11 | **Last Amended**: 2026-04-11
