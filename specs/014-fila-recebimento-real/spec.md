# Feature Specification: Fila de Recebimento em Modo Real + Correção de Granularidade Multi-Produto

**Feature Branch**: `014-fila-recebimento-real`
**Created**: 2026-07-16
**Status**: Draft
**Jira**: ACXEGDP-299 (subtarefa de ACXEGDP-267/238) — reescopada em 16/07 (STK-19a ficou fora; card passa a rastrear só o STK-19c)
**Input**: User description: "fila de recebimento de importação em modo real, reaproveitando nf_pedido_mapa/nf_pedido_filhote (já usadas por Pendências Fiscais) — só NFs mapeadas; corrigir também a checagem de 'recebida' para granularidade por produto nos consumidores existentes"

## Resumo

Hoje, quando o operador abre o recebimento de importação sem digitar o número de uma NF, o sistema devolve uma lista vazia — o comentário no código diz "aguardando wireup de sync n8n". Na prática, o sync **já existe**: as tabelas `stockbridge.nf_pedido_mapa`/`nf_pedido_filhote` (feature 011, aba "Pendências Fiscais") já mapeiam pedido de compra → NF mãe → NFs filhote, e já sabem — cruzando ao vivo com o espelho OMIE — quais filhotes foram emitidas e ainda não chegaram ao estoque. Esta feature reaproveita essas tabelas para dar ao operador uma fila real: uma lista das NFs filhote pendentes, sem precisar saber os números de cor.

No caminho dessa investigação, apareceu um problema mais sério. A checagem "esta NF foi recebida?" usada hoje por Pendências Fiscais, pelo Cockpit e pela auto-desativação do mapa é um `EXISTS` **por NF inteira** — nascida numa época em que toda NF de importação tinha exatamente 1 produto. A feature 013 (recebimento multi-produto, ACXEGDP-115) mudou essa premissa: agora uma NF pode ter N produtos, e o recebimento é **resumível** — pode ficar parcialmente concluído (2 de 3 produtos recebidos, por exemplo). Com a checagem antiga, basta 1 produto ter entrado para a NF **inteira** ser tratada como recebida: ela some do Cockpit e de Pendências Fiscais, e pode até desativar o mapa do pedido, mesmo com produtos ainda pendentes. A feature 013 já resolveu esse problema corretamente num lugar (`produtoDaNfJaRecebido`, usado na busca por NF específica) — mas não nos outros quatro lugares que precisam da mesma granularidade.

Esta feature entrega as duas coisas juntas: a fila real (valor novo para o operador) construída sobre uma checagem de "produto pendente" correta desde o início, e a correção dessa mesma checagem nos quatro lugares que hoje usam a versão grosseira (por NF).

## Clarifications

### Session 2026-07-16

- Q: A fila real deveria mostrar NFs sem mapa cadastrado (a seção "Importação sem mapa" que Pendências Fiscais já tem), ou só as mapeadas? → A: **Só as mapeadas.** A seção sem mapa fica fora de escopo — permanece exclusiva de Pendências Fiscais (papel gestor).
- Q: A checagem "NF recebida" (hoje por NF inteira) causa um bug de granularidade em 4 lugares (Cockpit Parte A e B, Pendências Fiscais, auto-desativação do mapa) desde a feature 013. Corrigir agora, junto com a fila, ou abrir como card separado? → A: **Corrigir tudo agora, no mesmo ciclo.** A fila nova e os 4 consumidores existentes passam a usar a mesma checagem por produto.

> **Escopo de empresa**: como o recebimento de importação é ACXE-only (STK-12/ACXEGDP-288), a fila não considera NFs Q2P.

> **Fronteira de leitura**: a listagem da fila **não** chama a API OMIE ao vivo — lê exclusivamente do espelho Postgres (`tbl_nf_header_ACXE`, `tbl_nf_itens_ACXE`, `stockbridge.nf_pedido_mapa/filhote`, `stockbridge.movimentacao/movimentacao_legado`), como toda leitura do Atlas (Princípio II). A chamada OMIE ao vivo (`consultarNF`) só acontece quando o operador confirma um item da fila — reaproveitando o fluxo de busca-por-NF que já existe e já faz essa chamada.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ver e agir sobre a fila de recebimento pendente (Priority: P1)

Como operador de recebimento, ao abrir a tela de recebimento de importação sem saber de cor quais NFs estão pendentes, quero ver uma lista das NFs filhote que já foram emitidas e ainda não foram recebidas, para escolher uma e recebê-la sem precisar consultar outra tela ou perguntar ao Comex o número.

**Why this priority**: É o núcleo da feature — sem isso, o operador continua dependente de descobrir números de NF por fora do sistema. Entrega valor sozinha: mesmo sem a correção de granularidade (US2), já elimina a lista vazia de hoje.

**Independent Test**: Abrir a tela de recebimento sem digitar NF; confirmar que aparece uma lista de NFs filhote pendentes (mapeadas, emitidas, não recebidas); clicar num item; confirmar que a busca por aquela NF é carregada automaticamente, levando ao fluxo de conferência já existente.

**Acceptance Scenarios**:

1. **Given** existem NFs filhote mapeadas, emitidas e não recebidas, **When** o operador abre a tela de recebimento de importação sem digitar nenhum número, **Then** o sistema exibe essas NFs numa lista, ordenada da mais antiga para a mais recente (a que está esperando há mais tempo aparece primeiro).
2. **Given** a fila exibida, **When** o operador clica num item da lista, **Then** o sistema carrega automaticamente a busca daquela NF (mesmo resultado de digitar o número e buscar manualmente).
3. **Given** uma NF filhote sem nenhum produto pendente (totalmente recebida), **When** a fila é montada, **Then** essa NF não aparece na lista.
4. **Given** nenhuma NF filhote mapeada está pendente no momento, **When** o operador abre a tela sem digitar NF, **Then** o sistema mostra uma mensagem de "fila vazia" (não a antiga tela pedindo para digitar um número).

---

### User Story 2 - Cockpit e Pendências Fiscais não subestimam recebimento parcial (Priority: P2)

Como gestor, ao consultar o Cockpit ou a aba Pendências Fiscais, quero que uma NF de importação com múltiplos produtos, da qual só parte foi recebida, continue aparecendo como pendente (pelos produtos que faltam) — para não achar que o pedido já foi resolvido quando na verdade falta receber uma parte dele.

**Why this priority**: É uma correção de correção — hoje esses números já podem estar sutilmente errados sempre que um recebimento multi-produto ficar parcial (cenário que só passou a existir com a feature 013). P2 porque, ao contrário da US1, não é um pedido de negócio novo — é preservar a confiabilidade do que já existe, mas depende da mesma peça técnica que a US1 introduz.

**Independent Test**: Simular uma NF filhote com 3 produtos onde 2 foram recebidos e 1 está pendente; confirmar que o Cockpit continua contando o produto pendente como pendente (não zera a NF); confirmar que Pendências Fiscais mostra essa filhote como parcialmente recebida, não como recebida; confirmar que o mapa do pedido permanece ativo enquanto esse produto não for recebido.

**Acceptance Scenarios**:

1. **Given** uma NF filhote com 3 produtos, 2 recebidos e 1 pendente, **When** o Cockpit calcula a posição fiscal/trânsito recebido, **Then** o produto pendente continua contando como pendente (a NF não é tratada como 100% recebida).
2. **Given** a mesma NF, **When** a aba Pendências Fiscais lista os filhotes do pedido, **Then** essa filhote aparece com status parcial, não como recebida — identificando qual produto falta.
3. **Given** a mesma NF é a única pendência restante de um pedido, **When** o processo de atualização do mapa (upsert) roda novamente, **Then** o mapa do pedido permanece ativo (não é desativado enquanto o produto pendente não for recebido).
4. **Given** uma NF filhote de produto único (comportamento anterior à feature 013), **When** qualquer uma das telas acima processa essa NF, **Then** o resultado é idêntico ao de hoje (a correção não muda nada para o caso de item único).

---

### User Story 3 - A fila mostra só o que é acionável (Priority: P3)

Como operador, não quero ver na fila de recebimento NFs que eu não deveria (ou não conseguiria) receber agora — como a NF mãe (que nunca é recebida diretamente) ou uma NF cancelada — para não perder tempo clicando em algo que não vai funcionar.

**Why this priority**: Refinamento de qualidade sobre a US1 — evita ruído e cliques que terminam em erro, mas a fila já funciona (com esse ruído) sem esta story.

**Independent Test**: Ter um mapa cuja NF mãe e cujas filhotes incluam uma cancelada e uma ainda não sincronizada no OMIE; confirmar que a fila mostra somente as filhotes válidas, emitidas e pendentes — sem a mãe, sem a cancelada, sem a não sincronizada.

**Acceptance Scenarios**:

1. **Given** um pedido mapeado, **When** a fila é montada, **Then** a NF mãe daquele pedido nunca aparece na lista (só filhotes).
2. **Given** uma NF filhote cancelada no OMIE, **When** a fila é montada, **Then** essa filhote não aparece.
3. **Given** uma NF filhote que ainda não foi sincronizada do OMIE para o espelho Postgres (sem `n_id_nf`), **When** a fila é montada, **Then** essa filhote não aparece (o operador não pode agir sobre uma NF que a busca ainda não vai encontrar).

---

### Edge Cases

- **Mapa "zumbi"** (pedido com `ativo=true` sem nenhuma pendência real, por falta de reenvio do n8n — limitação pré-existente da feature 011): como a fila sempre cruza ao vivo com o espelho, um mapa zumbi simplesmente não contribui itens à fila (nenhum produto pendente é encontrado) — não é um erro novo, é o comportamento correto dado o dado de entrada.
- **Granularidade das fontes de "recebido" não é uniforme** (achado da investigação, 16/07): das três fontes que determinam se um produto foi recebido, só uma tem granularidade de produto de verdade:
  - `stockbridge.movimentacao` (recebimento feito pelo Atlas, incluindo todo recebimento multi-produto — só existe desde a feature 013) — tem coluna de produto; a correção desta feature torna essa checagem precisa por produto.
  - `stockbridge.movimentacao_legado` (histórico migrado do sistema PHP, congelado desde a migração única) — **não tem** coluna de produto; é dado histórico de uma época em que o sistema só recebia 1 produto por NF, então uma linha aqui representa uma NF inteira, sem como saber qual produto especificamente. Como o legado nunca vai receber novas linhas (a migração foi única), essa limitação não piora — mas também não é corrigível retroativamente com os dados existentes.
  - `n_id_receb` do OMIE (o flag de recebimento formal do próprio ERP) — é um campo de **cabeçalho da NF**, não por item; o modelo de dados do OMIE não expõe recebimento por produto para o Atlas consumir.
  Portanto: a correção de granularidade desta feature é **completa para o caminho Atlas** (o único capaz de multi-produto) e **honesta sobre a limitação** dos outros dois caminhos (histórico e OMIE nativo), que continuam avaliando a NF inteira — impacto prático baixo, porque um match por legado ou por `n_id_receb` normalmente significa que a NF inteira já passou por um processo de recebimento formal (não um recebimento parcial do Atlas em andamento).
- **Filhote com todos os produtos recebidos, mas por fontes diferentes** (um produto via Atlas, outro via legado): conta como totalmente recebida — a checagem por produto olha para qualquer fonte válida.
- **Dois pedidos diferentes apontando, por erro de cadastro no Comex, para a mesma NF filhote**: fora de escopo desta feature — a integridade do mapa é responsabilidade do processo de upsert (feature 011); esta feature consome o mapa como está.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema MUST, quando o operador consulta a fila de recebimento sem informar um número de NF, listar as NFs filhote mapeadas (via `nf_pedido_mapa`/`nf_pedido_filhote` ativos) que têm pelo menos um produto ainda não recebido.
- **FR-002**: A checagem "produto recebido" MUST considerar cada produto da NF individualmente para os recebimentos feitos pelo Atlas (`stockbridge.movimentacao`, que inclui todo recebimento multi-produto) — cruzando os itens reais da NF (espelho OMIE) com os registros de movimentação daquele produto especificamente, em vez de um EXISTS único por NF inteira. Os dois sinais que já são inerentemente por NF (histórico migrado do legado, flag `n_id_receb` do próprio OMIE) permanecem por NF — ver Edge Cases.
- **FR-003**: A fila MUST excluir a NF mãe de qualquer pedido (nunca aparece como item recebível).
- **FR-004**: A fila MUST excluir NFs filhote canceladas ou deletadas no OMIE.
- **FR-005**: A fila MUST excluir NFs filhote ainda não sincronizadas do OMIE para o espelho Postgres.
- **FR-006**: A fila MUST ordenar os itens da data de emissão mais antiga para a mais recente.
- **FR-007**: Cada item da fila MUST indicar quando a NF está parcialmente recebida (quantos produtos já entraram vs. o total da NF), refletindo o comportamento resumível já existente no recebimento (feature 013).
- **FR-008**: Ao selecionar um item da fila, o sistema MUST carregar a busca por aquela NF através do mesmo caminho já usado quando o operador digita o número manualmente — sem duplicar lógica de busca/conferência.
- **FR-009**: A consulta da fila MUST ser acessível ao papel operador (não pode exigir papel gestor).
- **FR-010**: A listagem da fila MUST ler exclusivamente do espelho Postgres — nenhuma chamada nova à API OMIE ao vivo é introduzida por ela.
- **FR-011**: O cálculo do Cockpit que determina volume recebido/pendente de trânsito de filhotes (Parte A) MUST considerar cada produto individualmente, sem subestimar a quantidade pendente de uma NF parcialmente recebida.
- **FR-012**: O cálculo do Cockpit para importações sem mapa (Parte B, fallback) MUST considerar cada produto individualmente pelo mesmo critério.
- **FR-013**: A aba Pendências Fiscais MUST classificar uma filhote com produtos parcialmente recebidos como pendência parcial, não como recebida, identificando o(s) produto(s) que falta(m).
- **FR-014**: A auto-desativação do mapa de pedido (no processo de upsert do mapa) MUST manter o mapa ativo enquanto qualquer produto de qualquer filhote associada estiver pendente — não pode desativar com base em NF inteira "aparentemente" recebida.
- **FR-015**: Para NF filhote de produto único (o caso mais comum, anterior à feature 013), o comportamento de todas as telas acima MUST permanecer idêntico ao de hoje — a correção de granularidade não muda nada quando não há ambiguidade a resolver.

### Key Entities *(include if feature involves data)*

- **Item da fila de recebimento**: uma NF filhote mapeada, emitida, não totalmente recebida — carrega o número da NF, o pedido associado, quantos produtos tem no total e quantos já foram recebidos, a quantidade pendente, e há quanto tempo foi emitida.
- **Produto pendente** *(conceito compartilhado, não uma tabela nova)*: o cruzamento, por produto, entre os itens reais de uma NF (espelho OMIE) e os registros de recebimento daquele produto especificamente — substitui, nos consumidores existentes, o sinal grosseiro "NF tem alguma movimentação".

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: O operador encontra e inicia o recebimento de qualquer NF filhote mapeada pendente sem precisar descobrir o número por fora do sistema — validável pela lista não-vazia sempre que houver pendência real (confirmado ao vivo em UAT: 15 filhotes pendentes no momento da investigação).
- **SC-002**: Uma NF multi-produto com recebimento parcial nunca é contada como 100% recebida em nenhuma das quatro telas afetadas (fila, Cockpit Parte A, Cockpit Parte B, Pendências Fiscais) até que todos os seus produtos estejam de fato recebidos.
- **SC-003**: O mapa de um pedido nunca é desativado automaticamente enquanto houver produto pendente em qualquer uma de suas filhotes.
- **SC-004**: A listagem da fila não introduz nenhuma chamada OMIE ao vivo adicional — a única chamada OMIE do fluxo continua sendo a busca por NF específica, disparada só quando o operador escolhe um item.
- **SC-005**: Para NFs de produto único, os números exibidos em Cockpit e Pendências Fiscais antes e depois desta correção são idênticos (zero regressão no caso comum).

## Assumptions

- **Escopo "só mapeadas"**: a fila do operador não inclui a seção "importação sem mapa" que Pendências Fiscais já tem — essa seção permanece exclusiva da tela gestor. Se o Comex atrasar o cadastro do mapa de um pedido novo, essa NF não aparece na fila do operador até o mapa existir (decisão de escopo, não bug).
- **"Produto pendente" reaproveita a definição de `produtoDaNfJaRecebido`** (feature 013): produto sem `entrada_nf` ativa para aquele `produto_codigo_acxe` e sem lote aberto (`aguardando_aprovacao`/`provisorio`) daquele produto.
- **Mapa zumbi é limitação aceita, não corrigida aqui**: o endpoint de reconciliação ativa (`/admin/nf-pedido-mapa/reconciliar`) mencionado como possibilidade futura na feature 011 não é criado nesta feature — a fila convive com mapas zumbis simplesmente não extraindo itens deles (comportamento correto por construção, não workaround).
- **Sem migration**: nenhuma tabela nova. A correção de granularidade e a fila são só queries novas/ajustadas sobre tabelas existentes (`nf_pedido_mapa`, `nf_pedido_filhote`, `tbl_nf_header_ACXE`, `tbl_nf_itens_ACXE`, `stockbridge.movimentacao`, `stockbridge.movimentacao_legado`).

## Dependencies & Out of Scope

**Depende de**:
- `stockbridge.nf_pedido_mapa`/`nf_pedido_filhote` mantidas atualizadas pelo workflow n8n externo ao Atlas (feature 011) — a fila fica "cega" para pedidos cujo mapa ainda não foi cadastrado.
- Feature 013 (recebimento multi-produto, ACXEGDP-115) — a noção de "produto pendente" e o comportamento resumível que esta feature reaproveita.

**Fora de escopo**:
- Seção "sem mapa" na fila do operador (decisão de escopo, 16/07).
- Endpoint de reconciliação ativa do mapa zumbi.
- STK-19a (`alterarPedidoCompra`) — removido deste card em 16/07, segue no sistema legado.
- Qualquer mudança no fluxo de busca-por-NF/conferência já existente (feature 013) além de ser reaproveitado como está.
