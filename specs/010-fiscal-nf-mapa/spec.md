# Feature Specification: Posição Fiscal via Mapa NF Mãe/Filhote

**Feature Branch**: `010-fiscal-nf-mapa`  
**Created**: 2026-06-09  
**Updated**: 2026-06-16 — correções de cálculo (Fix 1/2/3) + aba "Pendências Fiscais"  
**Status**: Draft  
**Jira**: ACXEGDP-159 · ACXEGDP-183 (correções de cálculo + aba)  
**Input**: User description: "Posição Fiscal via mapa NF mãe/filhote"; emenda 2026-06-16: "especificar a nova aba de Pendências Fiscais do StockBridge e essas correções"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cockpit reflete importações realmente pendentes (Priority: P1)

O gestor de supply chain abre o cockpit do StockBridge e vê o card "Posição Fiscal". Hoje, esse número está permanentemente inflado: importações cujos containers já chegaram ao galpão continuam aparecendo como "pendentes" porque o sistema não consegue relacionar a nota fiscal de compra (NF mãe) com as notas de transporte dos containers (NF filhotes). O gestor não confia no número e ignora o card.

Com essa feature, o card passa a fechar corretamente: quando todos os containers de um pedido de importação chegaram, o volume correspondente sai da posição fiscal pendente.

**Why this priority**: Sem esse conserto, o card é inútil para tomada de decisão. A posição fiscal incorreta pode levar a compras desnecessárias ou atrasar alertas de falta real de estoque.

**Independent Test**: Inserir no sistema um pedido de importação com NF mãe + 2 NF filhotes. Confirmar recebimento dos 2 filhotes. Verificar que o volume do pedido some da posição fiscal pendente.

**Acceptance Scenarios**:

1. **Given** um pedido de importação com NF mãe e 2 NF filhotes cadastradas no mapa, **When** ambas as filhotes forem marcadas como recebidas pelo ERP, **Then** o card "Posição Fiscal" não deve mais incluir o volume desse pedido como pendente.

2. **Given** um pedido de importação com NF mãe e 2 NF filhotes, **When** apenas 1 filhote for recebida, **Then** apenas o **saldo ainda não recebido** (a quantidade das filhotes pendentes) DEVE continuar aparecendo como pendente — a quantidade da filhote já recebida sai da posição fiscal. *(Revisado 2026-06-16 — Fix 3; antes contava o pedido inteiro, o que duplicava com o estoque físico.)*

3. **Given** um pedido de importação sem mapa cadastrado, **When** o cockpit for carregado, **Then** esse pedido deve continuar aparecendo na posição fiscal com o comportamento atual (compatibilidade retroativa).

---

### User Story 2 - Gestor cadastra o mapa de NF mãe/filhote (Priority: P1)

O gestor de supply chain recebe da equipe de Comex uma planilha FUP com as colunas: Pedido, NF mãe e até 12 NF filhotes (uma por container). Ele precisa de um meio de enviar esses dados ao sistema para que a posição fiscal passe a ser calculada corretamente.

O envio deve ser automatizável (pode ser integrado ao workflow n8n da FUP) e também aceitar envio manual via API.

**Why this priority**: Sem ingestão de dados, a User Story 1 não tem como funcionar. O mapa é o dado central que alimenta todo o cálculo.

**Independent Test**: Enviar um array com 3 pedidos (mapa) via API. Verificar que os dados estão armazenados corretamente. Re-enviar os mesmos pedidos com informação alterada e confirmar que os dados foram atualizados sem duplicação.

**Acceptance Scenarios**:

1. **Given** um array com pedidos, cada um com NF mãe e lista de NF filhotes, **When** enviado ao sistema, **Then** o sistema deve armazenar os dados e confirmar quantos foram inseridos ou atualizados.

2. **Given** um pedido já cadastrado no mapa, **When** o mesmo pedido for enviado novamente com novas filhotes, **Then** o sistema deve atualizar os dados sem criar duplicatas.

3. **Given** um pedido de apenas 1 container (NF mãe + 1 NF filhote), **When** enviado ao sistema, **Then** o sistema deve aceitar e armazenar corretamente o mapa com a filhote correspondente.

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

### User Story 4 - Gestor investiga as pendências fiscais de importação em detalhe (Priority: P2)

O card "Posição Fiscal" do cockpit mostra apenas um número agregado. Quando esse número não bate com a expectativa do gestor (ex.: um pedido que ele sabe que já chegou ao galpão continua pendente), ele não tem como descobrir *qual* NF está em aberto nem *por quê*. Casos reais observados: containers recebidos fisicamente cujo recebimento nunca foi lançado em sistema nenhum (nem ERP, nem Atlas, nem legado), e importações sem mapa cadastrado.

Com essa feature, o gestor abre uma aba dedicada "Pendências Fiscais" (somente leitura, escopo importação) que detalha, por pedido/NF, o que **já foi recebido** e o que **não foi** — e por qual fonte o recebimento foi reconhecido. A aba destaca **inconsistências**: pedidos cujo material já saiu do trânsito (chegou) mas ainda têm NF em aberto — sinal de recebimento não lançado ou container extraviado. Também lista, em seção separada, as importações **sem mapa** (fallback CFOP 3.xxx) para o gestor validar se não são falsas pendências.

A aba também dá ao gestor a **dimensão de tempo**: (a) os pedidos **em exoneração** (NF mãe emitida, estágio de nacionalização no FUP), com a data de entrada nesse estágio e há quantos dias estão lá; e (b) para cada NF filhote pendente, **há quantos dias a NF foi emitida** (aguardando recebimento) — para o gestor distinguir uma pendência dentro do prazo razoável de uma que já está parada tempo demais (atraso/extravio).

**Why this priority**: P2 — não bloqueia o cálculo (US1), mas é o que torna o número *acionável*: sem a visão de detalhe, o gestor não consegue distinguir pendência legítima (material a caminho) de inconsistência operacional (recebido e não lançado). É a ferramenta de conciliação fiscal × físico.

**Independent Test**: Abrir a aba como gestor. Para um pedido com recebimento parcial, ver as filhotes recebidas (verde, com a fonte) e as pendentes (destacadas). Confirmar que um pedido que já saiu do trânsito mas tem filhote em aberto aparece com o alerta "chegou — NF aberta". Conferir a seção "importação sem mapa" listando as NFs CFOP 3.xxx sem reconciliação.

**Acceptance Scenarios**:

1. **Given** um pedido com mapa e recebimento parcial, **When** o gestor abre a aba, **Then** vê o pedido com a NF mãe, cada filhote (qtde, recebida sim/não, fonte do recebimento: ERP / movimentação Atlas / legado), o saldo pendente e o status agregado (recebida/parcial/pendente).

2. **Given** um pedido cujas filhotes já foram recebidas mas o material já não está em trânsito (chegou) enquanto alguma NF segue em aberto, **When** a aba é carregada, **Then** o pedido é sinalizado como **inconsistência** ("chegou — NF aberta") para investigação.

3. **Given** importações CFOP 3.xxx sem mapa cadastrado, **When** o gestor abre a aba, **Then** elas aparecem em uma seção "importação sem mapa" com NF, produto, quantidade, CFOP e data de emissão.

4. **Given** a aba aberta, **When** o gestor interage, **Then** ela é **somente leitura** — nenhuma ação de baixa/recebimento é feita na aba (correções seguem pelo fluxo de recebimento existente).

5. **Given** um operador comum, **When** tenta acessar a aba, **Then** o acesso é negado (gestor ou superior apenas).

6. **Given** pedidos com NF mãe emitida e em estágio de exoneração/nacionalização no FUP, **When** o gestor abre a aba, **Then** vê esses pedidos com NF mãe, quantidade, **data de entrada em exoneração** e **dias em exoneração** (hoje − data de entrada).

7. **Given** uma NF filhote emitida e ainda não recebida, **When** o gestor a inspeciona na aba, **Then** vê **há quantos dias a NF foi emitida** (aging), com um indicador visual de prazo (dentro do prazo / atenção / crítico) para apoiar a avaliação.

---

### Edge Cases

- O que acontece quando a NF mãe é informada mas não existe no ERP? O sistema deve aceitar o cadastro (NF pode ainda não ter sido sincronizada) mas a posição fiscal para esse pedido permanece como pendente até a NF aparecer.
- O que acontece quando uma NF filhote pertence a dois pedidos diferentes? O mapa deve impedir esse cadastro — uma NF filhote só pode pertencer a um pedido ativo.
- O que acontece quando o mapa é removido de um pedido (ativo=false)? O pedido volta ao comportamento de fallback (lógica CFOP 3.xxx).
- O que acontece quando o ERP demora para sincronizar o status de recebimento? A posição fiscal mostrará o pedido como pendente até a próxima sincronização — comportamento já existente e aceitável.
- Pedido com todas as filhotes recebidas mas NF mãe ainda aberta no ERP: como o critério é baseado exclusivamente nas filhotes, o pedido sai corretamente da posição pendente e o mapa é desativado automaticamente.
- Após desativação automática do mapa, suas NFs (mãe e filhotes) **continuam excluídas** do fallback — FR-012/Fix 4 exclui mãe e filhote de **qualquer** mapa (ativo ou inativo). A NF mãe (que nunca recebe `n_id_receb`) **não** reaparece como falsa pendência. *(Antes do Fix 4, a mãe de mapa desativado vazava no fallback — em escala chegou a ~298 t de falsa pendência no UAT em 2026-06-16; corrigido.)*
- **Filhote recebida no legado MySQL com `n_id_receb` nunca preenchido no ERP**: como o ERP nunca foi atualizado, o critério baseado só em `n_id_receb` a trataria como pendente para sempre. A filhote é reconhecida como recebida também via `movimentacao` ou `movimentacao_legado` (Fix 1).
- **Filhote tem CFOP 3.xxx e cairia também no fallback (Parte B)**: o material seria contado duas vezes (no pedido via mapa + na NF via fallback). O fallback exclui NFs que sejam mãe **ou** filhote de mapa ativo (Fix 2).
- **Recebimento físico não lançado / container extraviado**: filhote chegou ao galpão mas o recebimento não foi registrado em fonte nenhuma (ERP `n_id_receb=0`, sem `movimentacao`, sem `movimentacao_legado`). O cálculo corretamente a mantém como pendente; a aba "Pendências Fiscais" sinaliza como **inconsistência** quando o pedido já não está em trânsito (chegou, mas NF em aberto). A correção é operacional (lançar o recebimento) — não é ajuste de cálculo.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema DEVE aceitar o cadastro de um mapa relacionando um pedido de importação a uma NF mãe e zero a 12 NF filhotes, mesmo que o pedido ainda não exista no ERP no momento do envio — sem rejeição nem aviso ao chamador.
- **FR-002**: O sistema DEVE aceitar atualizações idempotentes do mapa — enviar o mesmo pedido duas vezes não deve criar duplicatas.
- **FR-003**: O cálculo da "Posição Fiscal Pendente de Importação" no cockpit DEVE usar o mapa quando disponível e contar o **saldo ainda não recebido** do pedido: `pendente (por produto) = quantidade do pedido − Σ(quantidade das filhotes já recebidas daquele produto)`, com piso em zero. Filhotes ainda não cadastradas, ou cadastradas mas sem NF emitida, mantêm o volume correspondente como pendente; pedido sem filhote cadastrada conta a quantidade cheia. *(Revisado 2026-06-16 — Fix 3; antes contava o pedido inteiro enquanto houvesse qualquer filhote pendente, o que duplicava com o estoque físico já recebido.)*
- **FR-004**: Pedidos de importação sem mapa cadastrado DEVEM continuar sendo calculados pela lógica atual (CFOP 3.xxx / não reconciliado em Atlas) para garantir retrocompatibilidade durante a transição.
- **FR-005**: Somente usuários com perfil de gestor ou superior DEVEM poder cadastrar ou atualizar o mapa.
- **FR-006**: Todas as alterações no mapa DEVEM ser registradas em auditoria com data, usuário e valores anteriores/novos.
- **FR-007**: O sistema DEVE disponibilizar consulta do mapa cadastrado para validação.
- **FR-008**: O **card** de Posição Fiscal do cockpit NÃO deve mudar — os mesmos campos já existentes são preservados. A visão de detalhe é entregue em uma **aba separada** ("Pendências Fiscais", ver FR-014+), sem alterar o card.
- **FR-009**: Quando todas as NF filhotes de um pedido forem marcadas como recebidas pelo ERP, o sistema DEVE automaticamente desativar o mapa desse pedido (`ativo=false`).
- **FR-010**: Atualizações do mapa seguem a política de última escrita vence — qualquer envio válido sobrescreve o estado anterior do pedido, independentemente de quem enviou (n8n ou gestor). A trilha de auditoria preserva todas as versões.

#### Correções de cálculo (2026-06-16 — ACXEGDP-183)

- **FR-011**: Para o cálculo de pendência (FR-003) e para a auto-desativação do mapa (FR-009), uma NF filhote é considerada **recebida** quando o ERP a marca (`n_id_receb > 0`) **OU** consta em `movimentacao` (recebimento de importação no Atlas) **OU** em `movimentacao_legado` (histórico migrado do MySQL). Justificativa: NFs antigas recebidas no legado nunca tiveram `n_id_receb` preenchido no ERP. *(Fix 1.)*
- **FR-012**: O cálculo de fallback para importações **sem mapa** (CFOP 3.xxx) DEVE excluir NFs que sejam **NF mãe ou NF filhote** de **qualquer** mapa — ativo **ou** inativo. Mapa ativo → pedido já contado na Parte A (evita dupla contagem A+B, *Fix 2*); mapa inativo → pedido já totalmente recebido, e a NF mãe (que nunca recebe `n_id_receb`) vazaria como **falsa pendência** se só excluíssemos mapas ativos (*Fix 4*).
- **FR-013**: A definição de "recebida" (FR-011) DEVE ser idêntica em todos os pontos que a consomem (cálculo do cockpit, aba de pendências e auto-desativação) para evitar divergência de resultado.

#### Aba "Pendências Fiscais" (2026-06-16 — US4)

- **FR-014**: O sistema DEVE oferecer uma aba "Pendências Fiscais" (somente leitura, escopo importação, perfil gestor ou superior) que liste, por pedido com mapa: NF mãe, filhotes (quantidade, recebida sim/não, fonte do recebimento — ERP / `movimentacao` / `movimentacao_legado`), saldo pendente e status agregado (recebida / parcial / pendente).
- **FR-015**: A aba DEVE sinalizar como **inconsistência** ("chegou — NF aberta") os pedidos que tenham ao menos uma filhote com **NF emitida** (liberada para transporte) ainda **não recebida** e que **não estão mais em trânsito** no FUP — indício de recebimento não lançado ou container extraviado. O critério por NF emitida evita falso-positivo em pedidos recém-mapeados que ainda não emitiram filhotes (sem lote no FUP por serem recentes, não por terem chegado).
- **FR-016**: A aba DEVE listar, em seção própria, as importações **sem mapa** (fallback CFOP 3.xxx não reconciliado), com NF, produto, quantidade, CFOP e data de emissão.
- **FR-017**: A aba é **somente leitura** — não executa baixa, recebimento ou qualquer mutação; correções seguem pelo fluxo de recebimento existente.
- **FR-018**: Por padrão a aba respeita o mesmo recorte de `incluir_em_metricas` do cockpit; um controle DEVE permitir exibir também produtos fora de métrica, para não esconder inconsistências.

##### Dimensão temporal (aging) da aba

- **FR-019**: A aba DEVE exibir os pedidos **em exoneração** (NF mãe emitida, estágio de nacionalização/exoneração no FUP) com: pedido, NF mãe, quantidade, **data de entrada em exoneração** e **dias em exoneração** (data atual − data de entrada). A data de entrada usa a **emissão da NF mãe** como referência (NF mãe emitida = pedido foi para exoneração de ICMS); se a FUP expuser uma data de estágio dedicada, ela prevalece.
- **FR-020**: Para cada **NF filhote pendente** (emitida e não recebida), a aba DEVE exibir os **dias desde a emissão** da NF (data atual − data de emissão) — o tempo que a filhote está aguardando recebimento.
- **FR-021**: A aba DEVE destacar visualmente o envelhecimento (aging) por faixas — **dentro do prazo / atenção / crítico** — usando um limite configurável; o número de dias é **sempre** exibido para julgamento humano (o objetivo é dar a informação para o gestor avaliar, não bloquear automaticamente).

### Key Entities

- **Mapa de Pedido**: Relacionamento entre um pedido de importação, sua NF mãe e zero a 12 NF filhotes. Um pedido tem no máximo um mapa ativo por vez. Ciclo de vida: criado pelo gestor ou n8n → ativo enquanto alguma filhote ainda não foi recebida → desativado automaticamente quando todas as filhotes forem recebidas pelo ERP. Como a NF mãe nunca é recebida (flag não gera estoque), a desativação depende exclusivamente do status das filhotes.
- **NF Mãe**: Nota fiscal que cobre o pedido de importação completo. Emitida quando a Declaração de Importação (DI) é registrada. Designada para o estoque `21.1 Extrema (IMPORTADO)` no ERP com flag **não gera estoque** — nunca é marcada como recebida (`n_id_receb` permanece `0`) independentemente do número de containers. O recebimento é registrado exclusivamente nas filhotes.
- **NF Filhote**: Nota fiscal emitida por container/caminhão de transporte, designada para o estoque `90.0.2 TRANSITO` com flag **gera estoque**. É a que o ERP marca como recebida quando o material chega ao galpão físico (`n_id_receb > 0`). Todo pedido tem sempre no mínimo 1 filhote — mesmo pedidos de apenas 1 container (confirmado Comex 10/06/2026). Um pedido pode ter de 1 a 12 filhotes.
- **Pendência Fiscal de Importação (visão derivada)**: Não é uma tabela — é a visão calculada exibida no card do cockpit e detalhada na aba "Pendências Fiscais". Composta por (a) saldo por pedido com mapa (FR-003) e (b) importações sem mapa (fallback CFOP 3.xxx). Para cada filhote: quantidade, se recebida e a fonte do recebimento. Inclui atributos **temporais** derivados: data de entrada em exoneração (= emissão da NF mãe) e dias em exoneração; e, por filhote pendente, dias desde a emissão da NF (aging). Derivada de `nf_pedido_mapa`, `nf_pedido_filhote`, `tbl_nf_header_ACXE`/`tbl_nf_itens_ACXE` (incl. `d_emi`), `movimentacao`, `movimentacao_legado` e `lote` (estágio de trânsito, usado para o sinal de inconsistência "chegou — NF aberta").

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Para pedidos cadastrados no mapa com todos os containers recebidos, o volume correspondente não aparece mais na posição fiscal pendente de importação — taxa de acerto de 100%.
- **SC-002**: O número da posição fiscal pendente de importação deve convergir com a base `Trânsito para Galpão (transito_local) + saldo de filhotes pendentes de pedidos já em recebimento + importações sem mapa` — diferença esperada ≤ 5% contra **essa base** após o mapa completo. *(Reformulado 2026-06-16 — o "Trânsito para Galpão" puro não captura o saldo de pedidos em recebimento nem importações sem mapa, que são pendência fiscal legítima.)*
- **SC-003**: O cadastro de um lote de pedidos (até 50 pedidos no mesmo envio) deve ser confirmado em menos de 5 segundos.
- **SC-004**: Zero duplicação de dados após re-envio do mesmo mapa — idempotência verificável pela contagem de registros antes e depois.
- **SC-005**: Histórico de auditoria completo para 100% das alterações no mapa — rastreabilidade total.
- **SC-006**: Após o Fix 3, recebimento parcial reduz a pendência proporcionalmente — o volume de filhotes já recebidas não permanece na posição fiscal (sem dupla contagem com o estoque físico).
- **SC-007**: Na aba "Pendências Fiscais", 100% das pendências de importação são rastreáveis até a NF e classificadas (pendente legítima / sem mapa / inconsistência "chegou — NF aberta"), permitindo ao gestor identificar recebimentos não lançados ou containers extraviados.
- **SC-008**: A aba expõe, para 100% dos pedidos em exoneração e das filhotes pendentes, há quantos dias estão no estágio / aguardando recebimento — permitindo ao gestor priorizar os casos mais antigos e distinguir atraso de prazo razoável.

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
- Todo pedido de importação tem sempre no mínimo 1 NF filhote — mesmo pedidos com apenas 1 container (confirmado pelo time Comex em 10/06/2026). A implementação não precisa tratar o caso "pedido sem filhote".
- A **data de entrada em exoneração** usa a emissão da NF mãe como proxy (NF mãe emitida = pedido foi para exoneração de ICMS — confirmado Comex 2026-06-15). Se a FUP passar a expor uma data de estágio dedicada, ela substitui o proxy.
- As **faixas de aging** (dentro do prazo / atenção / crítico) usam um limite configurável; valor inicial alinhado ao lead time do produto (`config_produto.lead_time_dias`) ou a um default sensato. O número de dias é sempre exibido, independentemente das faixas.

## Clarifications

### Session 2026-06-09

- Q: Quando o número do pedido enviado no mapa não existe ainda no ERP, o sistema deve aceitar ou rejeitar? → A: Aceitar silenciosamente — o mapa fica armazenado, o cockpit ignora o volume até o pedido aparecer no ERP.
- Q: O que deve disparar a desativação de um mapa de pedido? → A: Automaticamente quando todas as NF filhotes forem marcadas como recebidas pelo ERP (`n_id_receb > 0`). Como todo pedido tem sempre ≥1 filhote, a desativação depende exclusivamente das filhotes — nunca da NF mãe.
- Q: Quando n8n e gestor enviam dados conflitantes para o mesmo pedido, qual prevalece? → A: Última escrita vence — qualquer chamada sobrescreve o estado anterior, independente da origem.
- Q: Quantos pedidos de importação ativos existem simultaneamente em um momento típico? → A: Menos de 200 pedidos ativos.

### Session 2026-06-16

- Q: Em recebimento parcial (algumas filhotes recebidas), a pendência conta o pedido inteiro ou só o saldo? → A: O **saldo** (`pedido − Σ filhotes já recebidas`, por produto). Revisa US1 Cenário 2 e FR-003. [Fix 3]
- Q: O que conta como "filhote recebida" no cálculo? → A: `n_id_receb > 0` (ERP) **OU** presença em `movimentacao` (importação) **OU** em `movimentacao_legado`. NFs antigas recebidas no legado nunca tiveram `n_id_receb`. [Fix 1, FR-011]
- Q: Como evitar dupla contagem quando uma filhote (CFOP 3.xxx) também cai no fallback sem-mapa? → A: O fallback exclui NFs que sejam **mãe ou filhote** de mapa ativo. [Fix 2, FR-012]
- Q: Qual o escopo e a natureza da nova aba "Pendências Fiscais"? → A: **Só importação**, **somente leitura** (diagnóstico); a correção (lançar recebimento) segue pelo fluxo existente. [US4]
- Q: O que significam, no fluxo de comex, a emissão da NF mãe e da NF filhote? → A: NF mãe emitida = pedido foi para **exoneração de ICMS**; NF filhote emitida = **liberado para transporte** (porto → galpão). [input do negócio, 2026-06-15]
- Q: Como definir o sinal "chegou — NF aberta" (inconsistência) na aba? → A: Por **NF emitida** — filhote com NF emitida (liberada p/ transporte) ainda não recebida e pedido fora do trânsito no FUP. Pega extravio sem falso-positivo de pedido recém-mapeado. [FR-015]
- Q: SC-002 — convergência ≤5% contra o quê, dado que a pendência legitimamente excede o "Trânsito para Galpão" puro? → A: Contra a base `transito_local + saldo de filhotes pendentes (pedidos em recebimento) + importações sem mapa`. [SC-002]
- Q: Que dimensão de tempo a aba deve mostrar? → A: (a) pedidos **em exoneração** com data de entrada (= emissão da NF mãe) e dias em exoneração; (b) por filhote pendente, **dias desde a emissão** (aging) com faixas de prazo configuráveis. O número de dias é sempre exibido para julgamento humano. [FR-019..021]
