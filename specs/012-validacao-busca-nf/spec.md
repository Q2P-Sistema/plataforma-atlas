# Feature Specification: Validações na Busca de NF do Recebimento (cancelada + emitente ACXE)

**Feature Branch**: `012-validacao-busca-nf`  
**Created**: 2026-06-24  
**Status**: Draft  
**Jira**: ACXEGDP-204 e ACXEGDP-205 (subtarefas de ACXEGDP-114)  
**Input**: User description: "ACXEGDP-204 Filtrar NFs canceladas na busca por número (consultarNF)" + "ACXEGDP-205 Recebimento de importados: filtrar somente NFs EMITIDAS pela ACXE (evitar colisão de numeração com NF de entrada de outro fornecedor)"

## Resumo

No recebimento (importados e nacionais), o operador digita o número de uma nota fiscal e o sistema busca a NF correspondente para conferência e entrada de estoque. Hoje essa busca pode retornar a NF **errada** em dois casos:

1. **NF cancelada** — uma NF que foi cancelada continua sendo retornada normalmente, permitindo receber um documento sem validade fiscal (ACXEGDP-204).
2. **Colisão de numeração** — a numeração de NF não é única entre emitentes; o número digitado pode corresponder a uma NF de **entrada de outro fornecedor** em vez da NF **emitida pela ACXE**, fazendo o sistema trazer a nota errada (ACXEGDP-205).

Ambos os problemas vivem no **mesmo ponto**: o momento em que o sistema resolve "qual NF este número representa" durante o recebimento. Esta feature adiciona duas validações sobre o resultado dessa busca — **descartar NFs canceladas** e **considerar apenas NFs emitidas pela ACXE** — para que o operador só consiga receber o documento correto e válido.

> O sistema já reconhece NFs canceladas em outras telas (cockpit, pendências fiscais), mas esse reconhecimento **não é aplicado no momento do recebimento**. A validação de emitente hoje **não existe** no recebimento.

## Clarifications

### Session 2026-06-24

- Q: De onde obter a situação de cancelamento e o emitente da NF no recebimento? → A: Consultar o **OMIE ao vivo** (na própria consulta de NF que o recebimento já faz), refletindo o estado atual — sem depender do espelho sincronizado, que pode estar defasado.
- Q: Comportamento quando cancelamento/emitente não puder ser determinado (FR-010)? → A: **Fail-open com alerta** — liberar o recebimento e notificar o admin/gestor para revisão posterior; não bloquear a operação por falta de dado.
- Q: Abrangência do filtro "somente NF emitida pela ACXE"? → A: **Somente o contexto de recebimento ACXE**; o contexto Q2P permanece como hoje.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Bloquear recebimento de NF cancelada (Priority: P1) — ACXEGDP-204

Como operador de recebimento, ao digitar o número de uma NF que foi cancelada, o sistema não me deixa recebê-la e me informa que ela está cancelada — evitando entrada de estoque a partir de um documento fiscalmente inválido.

**Why this priority**: Receber uma NF cancelada gera lançamento de estoque indevido, divergência com o OMIE e retrabalho de estorno. Bloquear esse caso elimina a fonte do erro.

**Independent Test**: Digitar, na busca de recebimento, o número de uma NF conhecida como cancelada e confirmar que o sistema não a apresenta como recebível e exibe a mensagem de bloqueio.

**Acceptance Scenarios**:

1. **Given** uma NF cujo número existe mas está cancelada, **When** o operador digita esse número na busca de recebimento, **Then** o sistema não retorna a NF como item recebível e exibe mensagem informando que ela está cancelada.
2. **Given** uma NF cancelada, **When** o operador tenta concluir/confirmar o recebimento dessa NF, **Then** o sistema impede a conclusão e nenhum lote/movimentação/ajuste de estoque é criado.

---

### User Story 2 - Considerar somente NFs emitidas pela ACXE (Priority: P1) — ACXEGDP-205

Como operador de recebimento **no contexto ACXE**, ao digitar o número de uma NF, quero que o sistema traga apenas a NF **emitida pela ACXE**, e não uma NF de **entrada de outro fornecedor** que por acaso tenha o mesmo número — para eu não receber o documento errado.

> Abrangência: esta validação aplica-se ao **recebimento no contexto ACXE**, onde a colisão foi observada. O contexto Q2P permanece como hoje (ver Clarifications).

**Why this priority**: Quando a busca retorna a NF de outro fornecedor com numeração coincidente, o recebimento entra com produto/quantidade/custo errados, gerando estoque incorreto difícil de rastrear. Garantir a NF certa é pré-requisito de correção do recebimento.

**Independent Test**: Simular um número que existe tanto como NF emitida pela ACXE quanto como NF de entrada de outro fornecedor, buscar por esse número e confirmar que o sistema apresenta apenas a NF emitida pela ACXE.

**Acceptance Scenarios**:

1. **Given** um número de NF que corresponde a uma NF emitida pela ACXE, **When** o operador busca por esse número, **Then** o sistema apresenta essa NF da ACXE para recebimento.
2. **Given** um número que só existe como NF de entrada de outro fornecedor (nenhuma NF emitida pela ACXE com esse número), **When** o operador busca por esse número, **Then** o sistema não apresenta NF recebível e informa que não há NF emitida pela ACXE para aquele número.
3. **Given** um número que existe tanto como NF emitida pela ACXE quanto como NF de entrada de outro fornecedor, **When** o operador busca por esse número, **Then** o sistema apresenta apenas a NF emitida pela ACXE.

---

### User Story 3 - Não regredir o recebimento de NFs válidas e legítimas (Priority: P2)

Como operador de recebimento, ao digitar o número de uma NF válida (não cancelada) e legitimamente emitida pela ACXE, o recebimento continua funcionando exatamente como hoje.

**Why this priority**: Garante que as novas validações não introduzam falsos bloqueios que travariam a operação do dia a dia. É a rede de segurança contra regressão.

**Independent Test**: Digitar o número de uma NF válida e emitida pela ACXE e confirmar que ela aparece normalmente e o recebimento pode ser concluído.

**Acceptance Scenarios**:

1. **Given** uma NF válida, emitida pela ACXE e ainda não recebida, **When** o operador a busca pelo número, **Then** ela é apresentada normalmente para conferência e recebimento.
2. **Given** o conjunto de NFs hoje legitimamente recebíveis, **When** as novas validações são aplicadas, **Then** nenhuma delas deixa de ser recebível.

---

### User Story 4 - Comportamento quando o dado é indeterminado (Priority: P3)

Como operador, quando o sistema não consegue determinar com segurança a situação de cancelamento ou o emitente de uma NF, o recebimento não deve ser travado silenciosamente; o sistema segue o comportamento definido (ver FR-010) registrando o ocorrido.

**Why this priority**: Cobre o caso de borda em que a informação necessária está ausente. Importante para não bloquear operação legítima por falta de dado, mas não é o caminho feliz principal.

**Independent Test**: Simular uma NF cuja situação de cancelamento (ou emitente) não pôde ser determinada e confirmar que o sistema age conforme FR-010 e registra o evento.

**Acceptance Scenarios**:

1. **Given** uma NF cuja situação de cancelamento ou emitente não pôde ser determinada, **When** o operador a busca, **Then** o sistema libera o recebimento (fail-open), notifica o admin/gestor para revisão e registra a ocorrência para auditoria/diagnóstico.

---

### Edge Cases

- **NF cancelada após já ter sido recebida**: fora do escopo (recebimento já concluído é tratado pela idempotência/estorno existentes). O foco é o momento da busca/entrada.
- **NF inutilizada ou denegada** (não só "cancelada" no sentido estrito): tratadas como inválidas para recebimento, no mesmo critério usado hoje pelo cockpit/pendências.
- **Número de NF inexistente** (nem ACXE, nem terceiros): comportamento atual permanece (nada a receber).
- **NF emitida pela ACXE porém cancelada**: as duas validações se acumulam — identifica-se a NF da ACXE (US2) e, por estar cancelada, ela é bloqueada (US1).
- **Mais de uma NF emitida pela ACXE com o mesmo número**: situação não esperada para emitente único; se ocorrer, o sistema deve registrar/sinalizar em vez de escolher silenciosamente uma delas.

## Requirements *(mandatory)*

### Functional Requirements

**Cancelamento (ACXEGDP-204)**

- **FR-001**: O sistema MUST verificar a situação de cancelamento de uma NF — a partir da consulta ao OMIE feita **ao vivo** no momento do recebimento — antes de apresentá-la como recebível na busca por número.
- **FR-002**: O sistema MUST NOT retornar/apresentar como recebível uma NF identificada como cancelada, e MUST impedir a conclusão de um recebimento de NF cancelada sem criar lote, movimentação ou ajuste de estoque.
- **FR-003**: O critério de "cancelada" MUST abranger as situações fiscalmente inválidas equivalentes já reconhecidas pelo sistema (cancelada, inutilizada, denegada), mantendo consistência com cockpit/pendências fiscais.

**Emitente ACXE (ACXEGDP-205)**

- **FR-004**: O sistema MUST considerar, na busca por número **no recebimento de contexto ACXE**, apenas NFs **emitidas pela ACXE**, descartando NFs de **entrada de outros fornecedores** que tenham o mesmo número. No contexto Q2P, o comportamento permanece o atual.
- **FR-005**: Quando o número informado não corresponder a nenhuma NF emitida pela ACXE, o sistema MUST NOT apresentar NF recebível e MUST informar que não há NF emitida pela ACXE para aquele número.
- **FR-006**: Havendo colisão (mesmo número como NF emitida pela ACXE e como NF de entrada de terceiro), o sistema MUST selecionar a NF emitida pela ACXE.

**Transversais (aplicam-se a ambas)**

- **FR-007**: O sistema MUST exibir ao operador uma mensagem clara identificando o motivo do bloqueio (NF cancelada **ou** não emitida pela ACXE).
- **FR-008**: As validações MUST se aplicar de forma consistente tanto na busca/listagem da NF quanto na confirmação do recebimento, sem janela em que uma NF inválida passe por um caminho e seja barrada apenas no outro.
- **FR-009**: O sistema MUST registrar (log/auditoria) as tentativas de recebimento bloqueadas por NF cancelada ou por NF não emitida pela ACXE, para acompanhamento.
- **FR-010**: Quando a situação de cancelamento ou o emitente NÃO puderem ser determinados (ex.: o OMIE não retornou a informação esperada), o sistema MUST **liberar** o recebimento (fail-open), MUST **notificar o admin/gestor** para revisão posterior e MUST registrar o evento. Não deve bloquear a operação por falta de dado.
- **FR-011**: As validações de cancelamento e de emitente MUST se basear na **consulta ao OMIE feita ao vivo** durante o recebimento, refletindo o estado atual da NF, sem depender de dados sincronizados que possam estar defasados.

### Key Entities *(include if feature involves data)*

- **Nota Fiscal (recebimento)**: documento que o operador busca por número para dar entrada de estoque. Atributos relevantes para esta feature: **situação fiscal** (válida vs. cancelada/inutilizada/denegada) e **emitente / tipo de operação** (emitida pela ACXE vs. NF de entrada de terceiro). A feature introduz o consumo desses atributos na decisão de recebimento.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% das NFs canceladas (conforme o estado atual no OMIE no momento do recebimento) deixam de ser apresentadas como recebíveis na busca por número.
- **SC-002**: 100% dos casos de colisão de numeração passam a retornar a NF emitida pela ACXE (nenhuma NF de entrada de terceiro é apresentada como recebível).
- **SC-003**: 0 recebimentos novos criados a partir de NF cancelada **ou** de NF não emitida pela ACXE após a implantação.
- **SC-004**: 100% das NFs hoje legitimamente recebíveis (válidas e emitidas pela ACXE) continuam recebíveis depois (nenhum falso bloqueio em operação normal).
- **SC-005**: Em toda tentativa bloqueada, o operador vê uma mensagem que identifica claramente o motivo (cancelamento ou emitente) — verificável em teste de aceitação.
- **SC-006**: Tentativas bloqueadas ficam rastreáveis (registro/auditoria), permitindo auditar quantas ocorreram, por motivo, em um período.
- **SC-007**: 100% dos casos indeterminados (cancelamento/emitente não determinável) liberam o recebimento e geram alerta ao admin/gestor — nenhum caso indeterminado fica sem notificação.

## Assumptions

- **Escopo do recebimento**: a busca por número de NF é o mesmo caminho usado para importados e nacionais. A validação de **cancelamento** aplica-se a todo o recebimento por número; a validação de **emitente** restringe-se ao contexto ACXE (ver bullet abaixo). A motivação original veio do recebimento internacional.
- **Filtro de emitente restrito ao contexto ACXE** (decisão em Clarifications): a regra "considerar apenas NFs emitidas pela ACXE, descartando NFs de entrada de terceiros" aplica-se ao recebimento de contexto ACXE, onde a colisão foi observada. O contexto Q2P permanece como hoje.
- **Critério de cancelamento**: reutiliza a mesma definição já adotada pelo sistema para NFs fiscalmente inválidas (cancelada/inutilizada/denegada). Existe trabalho relacionado que já marca essa situação nas NFs sincronizadas (ACXEGDP-184), mas a verificação no recebimento usa a consulta ao OMIE ao vivo (FR-011).
- **Disponibilidade do dado** (decisão em Clarifications): situação de cancelamento e emitente são lidos da **consulta ao OMIE feita ao vivo** no momento do recebimento, refletindo o estado atual da NF. Quando a informação não vier do OMIE, aplica-se FR-010 (fail-open com alerta ao admin/gestor).
- **Sem alteração de NFs já recebidas**: a feature atua no momento da busca/entrada; NFs já recebidas anteriormente não são reprocessadas.
- **Mensageria**: as mensagens ao operador seguem o padrão de mensagens de bloqueio já existentes no recebimento (mesma localização/idioma pt-BR).

## Dependencies & Related Work

- **ACXEGDP-184** (concluída): detecção/marcação de NFs canceladas no sync de NF (ACXE, Q2P, Q2P Filial) — referência para o **critério de cancelamento** (mesmos sinais dCan/dInut/cDeneg). A verificação no recebimento, porém, lê esses sinais da consulta ao OMIE ao vivo (FR-011), não do espelho.
- **ACXEGDP-204 + ACXEGDP-205**: ambas implementadas por esta feature unificada (mesmo ponto de código). Uma branch/PR fecha as duas.
- **ACXEGDP-115** (irmã): recebimento de NF com mais de 1 produto. Independente desta feature.
