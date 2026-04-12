# Feature Specification: Atlas Infraestrutura Base

**Feature Branch**: `001-atlas-infra-base`
**Created**: 2026-04-12
**Status**: Draft
**Input**: Setup completo da infraestrutura compartilhada da plataforma Atlas antes de migrar qualquer módulo de domínio. Inclui autenticação, design system, banco de dados, deploy pipeline, health checks, feature flags de módulo e shell visual com navegação dos 7 módulos.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Desenvolvedor sobe o Atlas pela primeira vez (Priority: P1)

Flavio (executor técnico) clona o repositório, roda um único comando e tem o Atlas inteiro funcionando no seu computador local — banco de dados, cache, backend e frontend — sem configuração manual além de copiar um arquivo de exemplo de variáveis. Ele acessa o endereço local no navegador e vê a tela de login do Atlas.

**Why this priority**: Sem ambiente de desenvolvimento funcional, nenhum módulo pode ser construído. É o pré-requisito de tudo.

**Independent Test**: Clonar o repo numa máquina limpa, seguir as instruções do README (≤5 passos), rodar o comando de setup e verificar que a tela de login aparece no navegador.

**Acceptance Scenarios**:

1. **Given** um computador com Docker instalado e o repo clonado, **When** o desenvolvedor copia o arquivo de exemplo de variáveis e roda o comando de setup, **Then** todos os serviços (banco, cache, backend, frontend) sobem sem erro e o terminal mostra URLs de acesso.
2. **Given** os serviços rodando localmente, **When** o desenvolvedor acessa a URL do frontend no navegador, **Then** a tela de login do Atlas é exibida com campos de e-mail e senha.
3. **Given** os serviços rodando, **When** o desenvolvedor acessa a URL de saúde do backend, **Then** o sistema retorna status de cada dependência (banco, cache, hub de orquestração) com indicação verde/vermelho.

---

### User Story 2 — Operador faz login e vê o painel com os módulos (Priority: P1)

Um operador interno da empresa abre o Atlas no navegador, informa suas credenciais (e-mail + senha), e após autenticação bem-sucedida vê o painel principal com uma barra lateral listando os 7 módulos do sistema. Os módulos que ainda não foram implementados aparecem desabilitados visualmente (cinza, sem link). O módulo habilitado (nesta fase, nenhum módulo de domínio — apenas a casca) mostra uma página de "em breve".

**Why this priority**: Autenticação e navegação são a base que toda feature futura usa. Sem login, nenhum módulo pode restringir acesso por perfil.

**Independent Test**: Criar um usuário de teste, fazer login, verificar que a sidebar aparece com os 7 módulos, que clicar num módulo desabilitado não navega, e que o logout funciona.

**Acceptance Scenarios**:

1. **Given** um usuário cadastrado com perfil "operador", **When** ele informa e-mail e senha corretos na tela de login, **Then** o sistema autentica, redireciona pro painel principal e exibe o nome do usuário no topo.
2. **Given** um usuário autenticado no painel, **When** ele olha a barra lateral, **Then** vê 7 itens de módulo (Hedge, StockBridge, Breaking Point, C-Level, ComexInsight, ComexFlow, Forecast) com indicação visual de quais estão ativos e quais estão desabilitados.
3. **Given** um usuário autenticado, **When** ele clica num módulo desabilitado, **Then** o sistema mostra uma mensagem "módulo em implementação" sem navegar.
4. **Given** um usuário autenticado, **When** ele clica em "Sair", **Then** a sessão é encerrada e ele é redirecionado pra tela de login.
5. **Given** um usuário que informa credenciais erradas, **When** ele tenta fazer login, **Then** o sistema mostra mensagem de erro genérica ("credenciais inválidas") sem revelar se o e-mail existe ou não.

---

### User Story 3 — Gestor faz login com segunda confirmação de identidade (Priority: P2)

Um gestor ou diretor da empresa faz login normalmente (e-mail + senha) e, antes de acessar o painel, precisa informar um código de 6 dígitos gerado pelo seu aplicativo autenticador (Google Authenticator, 1Password, etc). Essa segunda camada é obrigatória para gestores e diretores; operadores fazem login apenas com e-mail e senha.

**Why this priority**: Sistema que toca dinheiro (hedge cambial, estoque, NFs) precisa de camada extra de segurança para perfis com poder de aprovação.

**Independent Test**: Criar um usuário gestor com 2FA configurado, fazer login com e-mail+senha, verificar que o sistema pede o código TOTP, informar código correto e verificar acesso ao painel.

**Acceptance Scenarios**:

1. **Given** um gestor com 2FA ativo, **When** ele informa e-mail e senha corretos, **Then** o sistema apresenta tela de "código de verificação" antes de liberar o painel.
2. **Given** a tela de código, **When** o gestor informa código TOTP válido, **Then** é redirecionado ao painel com acesso completo ao seu perfil.
3. **Given** a tela de código, **When** o gestor informa código errado 3 vezes seguidas, **Then** o sistema bloqueia a tentativa por 5 minutos e registra o evento.
4. **Given** um operador (sem 2FA obrigatório), **When** ele faz login com e-mail e senha, **Then** vai direto ao painel sem pedir código extra.
5. **Given** um gestor que nunca configurou 2FA, **When** ele faz login pela primeira vez, **Then** o sistema o direciona pra configuração obrigatória do autenticador antes de acessar qualquer funcionalidade.

---

### User Story 4 — Administrador gerencia usuários e perfis (Priority: P2)

O diretor ou um administrador designado acessa a área de configuração do Atlas e pode criar novos usuários, atribuir perfis (operador, gestor, diretor), desativar contas e resetar senhas. Cada ação fica registrada no histórico de auditoria.

**Why this priority**: Sem gestão de usuários, novos colaboradores não conseguem acessar o sistema e a saída de colaboradores fica como risco de segurança.

**Independent Test**: Criar um usuário via painel de admin, verificar que ele aparece na lista, fazer login com as credenciais dele, mudar o perfil, verificar que as permissões mudam, desativar a conta, verificar que o login é bloqueado.

**Acceptance Scenarios**:

1. **Given** um diretor autenticado, **When** ele acessa a área de gestão de usuários, **Then** vê a lista de todos os usuários com nome, e-mail, perfil, status (ativo/inativo) e data do último acesso.
2. **Given** o formulário de novo usuário, **When** o diretor preenche nome, e-mail e seleciona o perfil, **Then** o sistema cria o usuário, gera uma senha temporária e exibe instruções para o primeiro acesso.
3. **Given** um usuário existente, **When** o diretor muda o perfil de "operador" para "gestor", **Then** o sistema exige que o usuário configure 2FA no próximo login.
4. **Given** um usuário existente, **When** o diretor desativa a conta, **Then** qualquer sessão ativa daquele usuário é encerrada imediatamente e tentativas de login retornam "conta desativada".
5. **Given** qualquer ação de gestão de usuários (criação, alteração de perfil, desativação, reset de senha), **When** a ação é executada, **Then** um registro imutável é gravado no histórico de auditoria com quem fez, o que mudou, e quando.

---

### User Story 5 — Atlas é publicado no servidor de produção (Priority: P3)

Flavio faz merge de código na branch principal. Um processo automatizado constrói as imagens dos serviços (backend e frontend), publica no registro de imagens, e atualiza o servidor de produção automaticamente. O Atlas fica acessível pelo domínio configurado, com certificado HTTPS gerenciado pelo proxy reverso. Flavio pode verificar que tudo subiu consultando a página de saúde.

**Why this priority**: Sem pipeline de deploy, o código fica preso no computador local. Pipeline validado antes de importar módulos de domínio evita surpresas com infra.

**Independent Test**: Fazer merge de uma mudança trivial na branch principal, verificar que o pipeline completa sem erro, acessar o domínio de produção e ver a tela de login funcionando.

**Acceptance Scenarios**:

1. **Given** uma mudança merged na branch principal, **When** o pipeline de integração contínua dispara, **Then** executa verificação de tipos, lint, testes e build de imagens sem erro.
2. **Given** build concluído com sucesso, **When** as imagens são publicadas, **Then** o servidor de produção atualiza os serviços automaticamente em menos de 5 minutos.
3. **Given** o Atlas em produção, **When** um usuário acessa o domínio configurado, **Then** o navegador mostra a tela de login com HTTPS válido (cadeado verde).
4. **Given** o Atlas em produção, **When** Flavio acessa a página de saúde, **Then** vê o status de cada dependência (banco, cache, hub de orquestração) e a versão atual do sistema.
5. **Given** um deploy que quebra o Atlas em produção, **When** Flavio executa o comando de rollback, **Then** o sistema volta à versão anterior em menos de 1 minuto.

---

### User Story 6 — Atlas é publicado em ambiente de testes antes da produção (Priority: P3)

Antes de ir pra produção, o Atlas pode ser publicado num ambiente de testes (staging) que roda no mesmo servidor mas isolado da produção — banco de dados separado, endereço diferente. Flavio testa funcionalidades novas nesse ambiente sem risco de afetar os usuários reais.

**Why this priority**: Staging é a última rede de segurança antes de produção. Módulos como StockBridge (porte de sistema PHP em produção há 2 anos) precisam de validação em staging antes de substituir o legado.

**Independent Test**: Fazer deploy no staging, acessar o endereço de staging, verificar que funciona e que os dados são independentes de produção.

**Acceptance Scenarios**:

1. **Given** uma versão nova do Atlas, **When** Flavio faz deploy no staging, **Then** o sistema sobe no endereço de staging com banco de dados isolado (sem dados de produção).
2. **Given** o Atlas rodando em staging e em produção simultaneamente, **When** Flavio faz uma operação no staging (ex: criar usuário), **Then** essa operação não afeta a produção.
3. **Given** o staging validado, **When** Flavio decide promover pra produção, **Then** a promoção é uma ação explícita (não automática), registrada.

---

### User Story 7 — Habilitação incremental de módulos (Priority: P2)

Conforme cada módulo de domínio fica pronto (começando pelo Hedge Engine), Flavio habilita o módulo no Atlas sem precisar republicar o sistema inteiro. O módulo habilitado aparece ativo na barra lateral, suas rotas ficam acessíveis e seus dados visíveis. Módulos desabilitados continuam invisíveis e inacessíveis.

**Why this priority**: A migração é incremental (Hedge primeiro, depois StockBridge, etc). O Atlas precisa suportar módulos ligando um a um sem afetar os que já estão rodando.

**Independent Test**: Com o Atlas rodando e nenhum módulo habilitado, habilitar o Hedge via configuração, refazer o deploy, verificar que Hedge aparece ativo na sidebar e que os outros continuam desabilitados.

**Acceptance Scenarios**:

1. **Given** o Atlas com todos os módulos desabilitados, **When** Flavio habilita o módulo Hedge na configuração do servidor, **Then** após redeploy a sidebar mostra Hedge como ativo (com link) e os outros 6 como desabilitados.
2. **Given** o módulo Hedge habilitado, **When** um usuário clica em "Hedge" na sidebar, **Then** é direcionado pra página do Hedge Engine (ou placeholder se o conteúdo ainda não existe).
3. **Given** o módulo StockBridge desabilitado, **When** alguém tenta acessar diretamente a URL do StockBridge no navegador, **Then** o sistema retorna "módulo não disponível" em vez de erro técnico.
4. **Given** dois módulos habilitados (Hedge + StockBridge), **When** Flavio desabilita o StockBridge e refaz deploy, **Then** apenas o Hedge continua visível e funcional, sem afetar nada.

---

### Edge Cases

- O que acontece se o banco de dados está fora do ar quando o Atlas inicia? O sistema deve reportar status degradado na página de saúde mas não travar o processo de inicialização.
- O que acontece se o hub de orquestração (n8n) está indisponível? O Atlas deve continuar funcionando para operações síncronas (login, navegação, consultas). Features que dependem do hub (sync OMIE, alertas, OCR) degradam graciosamente com mensagem ao usuário.
- O que acontece se um usuário tenta acessar um recurso que pertence a outro perfil? O sistema deve retornar "acesso não autorizado" e registrar a tentativa no histórico de auditoria.
- O que acontece se 5 tentativas de login falham em sequência? O sistema bloqueia aquele IP/conta por tempo configurável.
- O que acontece se o certificado HTTPS expira? O proxy reverso deve renovar automaticamente (Let's Encrypt via Traefik).
- O que acontece com sessões ativas quando um deploy atualiza o backend? As sessões devem sobreviver ao redeploy (cookie-based, não em memória do processo).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema DEVE permitir que usuários façam login com e-mail e senha e acessem funcionalidades de acordo com seu perfil.
- **FR-002**: O sistema DEVE exigir segunda confirmação de identidade (código TOTP de aplicativo autenticador) para perfis gestor e diretor.
- **FR-003**: O sistema DEVE permitir que diretores criem, editem, desativem e reativem contas de usuários, e atribuam perfis (operador, gestor, diretor).
- **FR-004**: O sistema DEVE suportar habilitação e desabilitação individual de cada um dos 7 módulos de domínio, controlável por configuração do servidor sem alteração de código.
- **FR-005**: O sistema DEVE exibir uma barra lateral de navegação com os 7 módulos, diferenciando visualmente quais estão habilitados e quais não estão.
- **FR-006**: O sistema DEVE registrar toda mutação em dados de domínio num histórico de auditoria imutável (append-only), incluindo quem fez, o que mudou e quando.
- **FR-007**: O sistema DEVE expor uma página de saúde que reporta o status de cada dependência (banco de dados, cache, hub de orquestração) e a versão do sistema.
- **FR-008**: O sistema DEVE rodar em ambiente local de desenvolvimento com um único comando, após a cópia de um arquivo de variáveis de exemplo.
- **FR-009**: O sistema DEVE ser publicável em produção via pipeline automatizado (commit na branch principal → build → publicação de imagens → atualização do servidor).
- **FR-010**: O sistema DEVE suportar um ambiente de testes (staging) isolado da produção, com banco de dados separado, no mesmo servidor.
- **FR-011**: O sistema DEVE permitir rollback para a versão anterior em produção em menos de 1 minuto.
- **FR-012**: O sistema DEVE expirar sessões após 8 horas de inatividade ou 24 horas absolutas.
- **FR-013**: O sistema DEVE bloquear tentativas de login após 5 falhas consecutivas por 30 minutos.
- **FR-014**: O sistema DEVE permitir que o usuário resete sua senha via link por e-mail com expiração de 30 minutos.
- **FR-015**: O sistema DEVE manter uma identidade visual unificada (paleta de cores, tipografia, componentes) consistente em todos os módulos habilitados, usando tema claro como padrão.
- **FR-016**: O sistema DEVE ser responsivo, adaptando layout para telas de desktop e tablet.
- **FR-017**: O sistema DEVE proteger todas as rotas contra acesso não autenticado e não autorizado, verificando perfil do usuário contra as permissões requeridas.
- **FR-018**: O sistema DEVE garantir que dados sensíveis (senhas, tokens, chaves de integração) nunca apareçam em logs ou mensagens de erro.

### Key Entities

- **Usuário**: Representa um colaborador interno da empresa que acessa o Atlas. Atributos: nome, e-mail, senha (hash), perfil (operador/gestor/diretor), status (ativo/inativo), configuração 2FA, data do último acesso.
- **Sessão**: Representa uma sessão autenticada. Atributos: usuário associado, momento de criação, momento de expiração, IP de origem.
- **Módulo**: Representa um dos 7 módulos de domínio do Atlas. Atributos: identificador, nome de exibição, status (habilitado/desabilitado), ícone, rota base.
- **Registro de Auditoria**: Entrada imutável no histórico de auditoria. Atributos: timestamp, usuário, tipo de operação, entidade afetada, valores antes/depois, IP de origem.
- **Perfil**: Define o nível de acesso de um usuário. Valores: operador (operação básica), gestor (aprovações + relatórios departamentais), diretor (visão consolidada + gestão de usuários). Perfis superiores herdam permissões dos inferiores.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Um desenvolvedor novo consegue clonar o repositório e ter o Atlas rodando localmente em menos de 10 minutos, seguindo no máximo 5 passos documentados.
- **SC-002**: O ciclo completo de deploy (merge → build → publicação → atualização do servidor) completa em menos de 10 minutos.
- **SC-003**: A tela de login carrega em menos de 2 segundos em conexão doméstica brasileira.
- **SC-004**: O painel principal com sidebar dos 7 módulos carrega em menos de 1 segundo após login.
- **SC-005**: 100% das mutações em dados de domínio geram registro de auditoria verificável.
- **SC-006**: Rollback em produção restaura a versão anterior em menos de 1 minuto.
- **SC-007**: O sistema de feature flags permite habilitar/desabilitar qualquer módulo em menos de 2 minutos (tempo de edição de config + redeploy).
- **SC-008**: O ambiente de staging é criável e destruível sem afetar produção, em menos de 5 minutos.
- **SC-009**: Zero segredos (senhas, API keys, tokens) aparecem em logs, respostas de erro ou código-fonte commitado.
- **SC-010**: Usuários com perfil "operador" não conseguem acessar funcionalidades exclusivas de "gestor" ou "diretor" em nenhuma circunstância.

## Assumptions

- Os usuários são colaboradores internos das empresas ACXE e Q2P, com acesso a internet estável e navegadores modernos (Chrome, Firefox, Edge últimas 2 versões).
- O suporte a mobile é secundário (uso ocasional por diretores checando resumos); a experiência principal é em desktop.
- O servidor de produção já existe e está operacional (DigitalOcean Docker Swarm com Traefik), então esta spec não cobre provisionamento de infraestrutura do zero.
- O banco de dados Postgres com as 28 tabelas OMIE já sincronizadas pelo n8n está acessível no ambiente de produção.
- O hub de orquestração (n8n) já está em operação no mesmo servidor e não faz parte do escopo de setup desta spec.
- Os 7 módulos de domínio serão implementados como specs separadas (002-hedge-engine em diante); esta spec cobre apenas a casca que os receberá.
- Não há necessidade de app mobile nativo; o Atlas é exclusivamente web.
- Nenhuma funcionalidade de domínio (cálculos financeiros, hedge, estoque, comex) faz parte desta spec — apenas a infraestrutura que permite que esses domínios sejam plugados depois.
