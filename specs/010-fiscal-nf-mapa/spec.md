# Feature Specification: Posição Fiscal via Mapa NF Mãe/Filhote

**Feature Branch**: `010-fiscal-nf-mapa`  
**Created**: 2026-06-09  
**Status**: Draft  
**Jira**: ACXEGDP-159  
**Input**: User description: "Posição Fiscal via mapa NF mãe/filhote"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cockpit reflete importações realmente pendentes (Priority: P1)

O gestor de supply chain abre o cockpit do StockBridge e vê o card "Posição Fiscal". Hoje, esse número está permanentemente inflado: importações cujos containers já chegaram ao galpão continuam aparecendo como "pendentes" porque o sistema não consegue relacionar a nota fiscal de compra (NF mãe) com as notas de transporte dos containers (NF filhotes). O gestor não confia no número e ignora o card.

Com essa feature, o card passa a fechar corretamente: quando todos os containers de um pedido de importação chegaram, o volume correspondente sai da posição fiscal pendente.

**Why this priority**: Sem esse conserto, o card é inútil para tomada de decisão. A posição fiscal incorreta pode levar a compras desnecessárias ou atrasar alertas de falta real de estoque.

**Independent Test**: Inserir no sistema um pedido de importação com NF mãe + 2 NF filhotes. Confirmar recebimento dos 2 filhotes. Verificar que o volume do pedido some da posição fiscal pendente.

**Acceptance Scenarios**:

1. **Given** um pedido de importação com NF mãe e 2 NF filhotes cadastradas no mapa, **When** ambas as filhotes forem marcadas como recebidas pelo ERP, **Then** o card "Posição Fiscal" não deve mais incluir o volume desse pedido como pendente.

2. **Given** um pedido de importação com NF mãe e 2 NF filhotes, **When** apenas 1 filhote for recebida, **Then** o volume total do pedido DEVE continuar aparecendo como pendente (pedido incompleto).

3. **Given** um pedido de importação com apenas NF mãe (sem filhotes), **When** a NF mãe for marcada como recebida pelo ERP, **Then** o volume deve sair da posição fiscal pendente.

4. **Given** um pedido de importação sem mapa cadastrado, **When** o cockpit for carregado, **Then** esse pedido deve continuar aparecendo na posição fiscal com o comportamento atual (compatibilidade retroativa).

---

### User Story 2 - Gestor cadastra o mapa de NF mãe/filhote (Priority: P1)

O gestor de supply chain recebe da equipe de Comex uma planilha FUP com as colunas: Pedido, NF mãe e até 12 NF filhotes (uma por container). Ele precisa de um meio de enviar esses dados ao sistema para que a posição fiscal passe a ser calculada corretamente.

O envio deve ser automatizável (pode ser integrado ao workflow n8n da FUP) e também aceitar envio manual via API.

**Why this priority**: Sem ingestão de dados, a User Story 1 não tem como funcionar. O mapa é o dado central que alimenta todo o cálculo.

**Independent Test**: Enviar um array com 3 pedidos (mapa) via API. Verificar que os dados estão armazenados corretamente. Re-enviar os mesmos pedidos com informação alterada e confirmar que os dados foram atualizados sem duplicação.

**Acceptance Scenarios**:

1. **Given** um array com pedidos, cada um com NF mãe e lista de NF filhotes, **When** enviado ao sistema, **Then** o sistema deve armazenar os dados e confirmar quantos foram inseridos ou atualizados.

2. **Given** um pedido já cadastrado no mapa, **When** o mesmo pedido for enviado novamente com novas filhotes, **Then** o sistema deve atualizar os dados sem criar duplicatas.

3. **Given** um pedido com NF mãe mas sem filhotes, **When** enviado ao sistema, **Then** o sistema deve aceitar esse caso (pedido de apenas 1 container).

4. **Given** um pedido com mais de 12 NF filhotes, **When** tentativa de envio, **Then** o sistema deve rejeitar com mensagem de erro clara.

5. **Given** um gestor autenticado, **When** tenta enviar o mapa, **Then** o envio é aceito. **Given** um operador comum, **When** tenta enviar, **Then** o acesso é negado.

---

### User Story 3 - Gestor valida e audita o mapa cadastrado (Priority: P2)

Após enviar o mapa, o gestor precisa confirmar o que está armazenado: quais pedidos têm mapa, quantas filhotes por pedido, e se algum pedido está usando ainda a lógica de fallback (sem mapa).

**Why this priority**: Auditabilidade é requisito do módulo (Princípio IV). O gestor precisa saber quais pedidos já têm mapa correto vs. quais ainda usam a lógica antiga.

**Independent Test**: Após cadastrar 3 pedidos no mapa, consultar a listagem e verificar que os 3 aparecem com seus dados corretos.

**Acceptance Scenarios**:

1. **Given** pedidos cadastrados no mapa, **When** gestor consulta a listagem, **Then** deve ver todos os pedidos ativos com NF mãe, quantidade de filhotes e datas de importação.

2. **Given** alteração no mapa de um pedido, **When** gestor consulta o histórico de auditoria, **Then** deve ver o registro da mudança com data, usuário e valores anteriores/novos.

---

### Edge Cases

- O que acontece quando a NF mãe é informada mas não existe no ERP? O sistema deve aceitar o cadastro (NF pode ainda não ter sido sincronizada) mas a posição fiscal para esse pedido permanece como pendente até a NF aparecer.
- O que acontece quando uma NF filhote pertence a dois pedidos diferentes? O mapa deve impedir esse cadastro — uma NF filhote só pode pertencer a um pedido ativo.
- O que acontece quando o mapa é removido de um pedido (ativo=false)? O pedido volta ao comportamento de fallback (lógica CFOP 3.xxx).
- O que acontece quando o ERP demora para sincronizar o status de recebimento? A posição fiscal mostrará o pedido como pendente até a próxima sincronização — comportamento já existente e aceitável.
- Pedido com todas as filhotes recebidas mas NF mãe ainda aberta no ERP: como o critério é baseado nas filhotes (quando existem), o pedido deve sair corretamente da posição pendente e o mapa deve ser desativado automaticamente.
- Pedido sem filhotes (apenas NF mãe): a desativação automática ocorre quando a NF mãe for marcada como recebida pelo ERP.
- Após desativação automática do mapa, o pedido cai no comportamento de fallback (CFOP 3.xxx). Se nenhuma movimentação foi registrada em Atlas para esse pedido, a NF mãe pode reaparecer na posição fiscal via fallback — esse caso indica que o operador ainda precisa registrar o recebimento formal em Atlas.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema DEVE aceitar o cadastro de um mapa relacionando um pedido de importação a uma NF mãe e zero a 12 NF filhotes, mesmo que o pedido ainda não exista no ERP no momento do envio — sem rejeição nem aviso ao chamador.
- **FR-002**: O sistema DEVE aceitar atualizações idempotentes do mapa — enviar o mesmo pedido duas vezes não deve criar duplicatas.
- **FR-003**: O cálculo da "Posição Fiscal Pendente de Importação" no cockpit DEVE usar o mapa quando disponível: pedido pendente se NF mãe não recebida (sem filhotes) OU qualquer filhote não recebida (com filhotes).
- **FR-004**: Pedidos de importação sem mapa cadastrado DEVEM continuar sendo calculados pela lógica atual (CFOP 3.xxx / não reconciliado em Atlas) para garantir retrocompatibilidade durante a transição.
- **FR-005**: Somente usuários com perfil de gestor ou superior DEVEM poder cadastrar ou atualizar o mapa.
- **FR-006**: Todas as alterações no mapa DEVEM ser registradas em auditoria com data, usuário e valores anteriores/novos.
- **FR-007**: O sistema DEVE disponibilizar consulta do mapa cadastrado para validação.
- **FR-008**: O cockpit NÃO deve mudar sua interface visual — os mesmos campos de posição fiscal já existentes devem ser preservados.
- **FR-009**: Quando todas as NF filhotes de um pedido forem marcadas como recebidas pelo ERP, o sistema DEVE automaticamente desativar o mapa desse pedido (`ativo=false`).
- **FR-010**: Atualizações do mapa seguem a política de última escrita vence — qualquer envio válido sobrescreve o estado anterior do pedido, independentemente de quem enviou (n8n ou gestor). A trilha de auditoria preserva todas as versões.

### Key Entities

- **Mapa de Pedido**: Relacionamento entre um pedido de importação, sua NF mãe e zero a 12 NF filhotes. Um pedido tem no máximo um mapa ativo por vez. Ciclo de vida: criado pelo gestor ou n8n → ativo enquanto alguma filhote ainda não foi recebida → desativado automaticamente quando todas as filhotes forem recebidas pelo ERP.
- **NF Mãe**: Nota fiscal que cobre o pedido de importação completo. Emitida quando a Declaração de Importação (DI) é registrada. Nunca é marcada como recebida pelo ERP quando há containers múltiplos — o recebimento é registrado apenas nas filhotes.
- **NF Filhote**: Nota fiscal emitida por container/caminhão de transporte. É a que o ERP marca como recebida quando o material chega ao galpão físico. Um pedido pode ter de 0 a 12 filhotes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Para pedidos cadastrados no mapa com todos os containers recebidos, o volume correspondente não aparece mais na posição fiscal pendente de importação — taxa de acerto de 100%.
- **SC-002**: O número da posição fiscal pendente de importação deve convergir com o número de "Trânsito para Galpão" à medida que o mapa é populado com os pedidos em trânsito — diferença esperada ≤ 5% após mapa completo.
- **SC-003**: O cadastro de um lote de pedidos (até 50 pedidos no mesmo envio) deve ser confirmado em menos de 5 segundos.
- **SC-004**: Zero duplicação de dados após re-envio do mesmo mapa — idempotência verificável pela contagem de registros antes e depois.
- **SC-005**: Histórico de auditoria completo para 100% das alterações no mapa — rastreabilidade total.

## Assumptions

- A fonte de dados do mapa é a planilha FUP de Comex, que já tem as colunas Pedido / NF mãe / NF filhote 1..12. O operador ou sistema n8n extrairá esses dados e os enviará via API.
- O número do pedido no mapa corresponde ao mesmo código que o ERP usa como referência de compra (número do pedido OMIE/ACXE).
- Um pedido de importação tem no máximo 12 containers — limite observado na planilha FUP atual. Pedidos com mais containers são considerados fora do escopo desta versão.
- A visibilidade do mapa (leitura) é restrita ao mesmo perfil que pode cadastrar (gestor+). Operadores não precisam ver ou interagir com o mapa.
- A sincronização do status de recebimento das NF filhotes é de responsabilidade do ERP (OMIE) — o sistema só lê esse status, não o modifica.
- NFs filhotes de diferentes pedidos são distintas — uma mesma NF filhote não pode aparecer em dois pedidos ativos diferentes.
- O mapa pode ser populado gradualmente; pedidos sem mapa continuam funcionando com a lógica anterior até que seu mapa seja inserido.
- O volume esperado é de menos de 200 pedidos ativos simultâneos no mapa. Paginação na consulta de validação é opcional para esta escala.
- O pedido informado no mapa pode ainda não existir no ERP no momento do cadastro (FUP é atualizado antes do OMIE sincronizar). O sistema aceita o cadastro silenciosamente; o cockpit ignora o volume desse pedido até que ele apareça no ERP.

## Clarifications

### Session 2026-06-09

- Q: Quando o número do pedido enviado no mapa não existe ainda no ERP, o sistema deve aceitar ou rejeitar? → A: Aceitar silenciosamente — o mapa fica armazenado, o cockpit ignora o volume até o pedido aparecer no ERP.
- Q: O que deve disparar a desativação de um mapa de pedido? → A: Automaticamente quando todas as NF filhotes forem marcadas como recebidas pelo ERP (pedido sem filhotes: quando NF mãe for recebida).
- Q: Quando n8n e gestor enviam dados conflitantes para o mesmo pedido, qual prevalece? → A: Última escrita vence — qualquer chamada sobrescreve o estado anterior, independente da origem.
- Q: Quantos pedidos de importação ativos existem simultaneamente em um momento típico? → A: Menos de 200 pedidos ativos.
