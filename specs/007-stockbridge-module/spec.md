# Feature Specification: StockBridge — Controle Fisico de Estoque

**Feature Branch**: `007-stockbridge-module`  
**Created**: 2026-04-16  
**Status**: Draft  
**Input**: Porte do sistema legado PHP de controle de estoque de materias-primas petroquimicas (PP, PE, PS) para a plataforma Atlas. Dual-CNPJ (Acxe + Q2P), integracao bidirecional com OMIE, recebimento com conferencia fisica e tratamento de divergencias, pipeline de transito maritimo em 4 estagios, 19 tipos de movimentacao, aprovacoes hierarquicas (Operador -> Gestor -> Diretor), metricas de giro e valor de estoque.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Recebimento de NF com Conferencia Fisica (Priority: P1)

O operador de armazem precisa confirmar a chegada fisica de mercadoria referenciada por uma Nota Fiscal ja registrada no OMIE. Ele consulta a fila de NFs pendentes (importacao, devolucao de cliente, compra nacional), seleciona uma NF, informa a quantidade recebida fisicamente e, se houver divergencia entre o declarado na NF e o recebido, registra o motivo. O sistema cria um lote com status "provisorio" (se confere) ou "aguardando aprovacao" (se diverge) e atualiza os saldos correspondentes nos dois CNPJs (Acxe e Q2P) via OMIE.

**Why this priority**: Este e o fluxo operacional diario mais critico — sem ele, a empresa nao consegue dar entrada de material no sistema. E o unico fluxo que o sistema PHP legado ja executa em producao.

**Independent Test**: Pode ser testado isoladamente inserindo uma NF no OMIE e verificando que o operador consegue confirmar a entrada, que o lote e criado com quantidade e status corretos, e que os ajustes de estoque refletem nos dois CNPJs.

**Acceptance Scenarios**:

1. **Given** uma NF de importacao existe no OMIE e nao foi processada, **When** o operador informa quantidade igual a da NF, **Then** um lote e criado com status "provisorio", saldo fisico e fiscal sao atualizados nos dois CNPJs, e a NF sai da fila de pendentes.
2. **Given** uma NF existe no OMIE, **When** o operador informa quantidade menor que a da NF e preenche o motivo, **Then** um lote e criado com status "aguardando aprovacao", a diferenca e registrada como divergencia, e o Gestor e notificado.
3. **Given** uma NF ja foi processada anteriormente, **When** o operador tenta processa-la novamente, **Then** o sistema bloqueia e exibe mensagem de que a NF ja foi conciliada.
4. **Given** o produto da NF ACXE nao possui correlato cadastrado na Q2P, **When** o operador tenta processar a NF, **Then** o sistema bloqueia, notifica o administrador, e orienta o cadastro do produto.

---

### User Story 2 - Cockpit de Estoque por Produto (Priority: P1)

O gestor de supply chain precisa ver o estado consolidado do estoque por produto (SKU), incluindo saldo fisico disponivel, saldo fiscal, quantidades em cada estagio de transito, lotes com divergencia, e a cobertura em dias com indicador de criticidade. A visao deve abranger todos os armazens e ambos os CNPJs.

**Why this priority**: Sem visibilidade do estoque, nao ha como tomar decisoes de compra, transferencia ou alerta de ruptura. E a tela mais acessada do sistema.

**Independent Test**: Pode ser testado com lotes de exemplo em diferentes estagios e localidades, verificando que os totalizadores, a cobertura e os indicadores de criticidade sao calculados corretamente.

**Acceptance Scenarios**:

1. **Given** existem lotes reconciliados em multiplas localidades, **When** o gestor acessa o cockpit, **Then** cada SKU mostra: saldo fisico total, saldo fiscal, quantidade em transito (por estagio), cobertura em dias, e badge de criticidade (critico / alerta / ok / excesso).
2. **Given** a cobertura de um SKU e inferior a 50% do lead time, **When** o cockpit e exibido, **Then** o SKU aparece com indicador "Critico" em vermelho.
3. **Given** existem lotes com divergencia entre fisico e fiscal, **When** o gestor clica no indicador de divergencias, **Then** o sistema exibe o detalhe agrupavel por familia, NCM ou status, com o delta total em toneladas.

---

### User Story 3 - Aprovacoes Hierarquicas (Priority: P2)

O gestor (ou diretor, conforme o caso) precisa revisar e aprovar ou rejeitar movimentacoes que exigem autorizacao: entradas manuais sem NF, recebimentos com divergencia, saidas manuais (comodatos, amostras, descartes). O sistema apresenta as pendencias com contexto (quem lancou, quando, motivo, quantidades prevista vs. recebida) e permite acao de aprovar ou rejeitar.

**Why this priority**: Movimentacoes divergentes e manuais sao frequentes (o operador registra, mas alguem precisa validar). Sem aprovacao, lotes ficam travados e o saldo nao reflete a realidade.

**Independent Test**: Pode ser testado criando uma entrada manual como operador e verificando que o gestor ve a pendencia, consegue aprovar, e o lote muda para status "provisorio".

**Acceptance Scenarios**:

1. **Given** uma entrada com divergencia foi registrada pelo operador, **When** o gestor acessa o painel de aprovacoes, **Then** a pendencia aparece com: produto, quantidade prevista, quantidade recebida, diferenca, motivo, quem lancou e data.
2. **Given** uma pendencia de aprovacao, **When** o gestor clica "Aprovar", **Then** o lote muda para "provisorio" e o saldo fisico e atualizado.
3. **Given** uma pendencia de aprovacao, **When** o gestor clica "Rejeitar", **Then** o lote muda para "rejeitado" e o saldo nao e alterado.
4. **Given** um lote foi rejeitado, **When** o operador acessa o lote rejeitado, **Then** ele pode corrigir quantidade e/ou motivo e re-submeter para aprovacao, retornando o lote ao status "aguardando aprovacao".
5. **Given** uma saida do tipo comodato, **When** registrada, **Then** exige aprovacao de Diretor (nao de Gestor).

---

### User Story 4 - Pipeline de Transito Maritimo (Priority: P2)

O gestor e o diretor precisam acompanhar a jornada de importacoes em 4 estagios: transito internacional -> porto/DTA -> transito interno -> recebido. Cada estagio mostra dados diferentes (USD vs. BRL, DI/DTA quando aplicavel, NF de transporte). O operador so visualiza transito interno e reservado; transito internacional e porto sao visiveis apenas para gestor e diretor.

**Why this priority**: A visibilidade do pipeline de importacao e essencial para planejamento de caixa (exposicao cambial em USD) e antecipacao de chegadas.

**Independent Test**: Pode ser testado criando lotes em cada estagio de transito e verificando a visibilidade correta por perfil.

**Acceptance Scenarios**:

1. **Given** um lote esta em "transito internacional", **When** um operador acessa o sistema, **Then** ele nao ve esse lote. **When** um gestor acessa, **Then** ele ve o lote com valor em USD e sem DI/DTA.
2. **Given** um lote avanca para "porto/DTA", **When** o gestor visualiza, **Then** o numero de DI e DTA sao exibidos como campos obrigatorios.
3. **Given** um lote avanca para "transito interno", **When** qualquer perfil visualiza, **Then** o lote aparece com valor em BRL e numero da NF de transporte.
4. **Given** um lote em transito interno chega ao armazem, **When** o operador confirma o recebimento, **Then** o lote muda para status "provisorio" ou "aguardando aprovacao" conforme conferencia fisica.

---

### User Story 5 - Saidas Automaticas via OMIE (Priority: P2)

Quando o OMIE processa uma NF de saida (venda, remessa para beneficiamento, transferencia entre CNPJs, devolucao a fornecedor), o sistema deve debitar automaticamente o saldo fisico e fiscal sem intervencao do operador. O caso especial de "debito cruzado" — quando Q2P fatura mas o fisico esta em Acxe (ou vice-versa) — deve gerar debito no CNPJ correto para cada dimensao (fisico vs. fiscal) e registrar a divergencia cruzada para regularizacao fiscal posterior.

**Why this priority**: As saidas automaticas representam o maior volume de movimentacoes e garantem que o saldo reflete as vendas em tempo real.

**Independent Test**: Pode ser testado simulando eventos de NF de saida do OMIE e verificando que o saldo e debitado automaticamente sem acao do operador.

**Acceptance Scenarios**:

1. **Given** o OMIE processa uma NF de venda para cliente, **When** o evento e recebido pelo sistema, **Then** o saldo fisico e fiscal do produto/localidade sao reduzidos automaticamente e a movimentacao e registrada no log.
2. **Given** Q2P emite NF de venda mas o estoque fisico esta no armazem Acxe, **When** o evento e processado, **Then** o saldo fisico e debitado de Acxe, o saldo fiscal e debitado de Q2P, e uma divergencia cruzada e registrada com notificacao ao Gestor e Diretor.
3. **Given** uma divergencia cruzada existe, **When** o setor contabil emite NF de transferencia, **Then** o sistema regulariza a posicao fiscal e baixa a divergencia.

---

### User Story 6 - Saidas Manuais com Aprovacao (Priority: P3)

O operador precisa registrar saidas que nao tem NF correspondente no OMIE: transferencias intra-CNPJ (mesmo CNPJ, outro armazem), comodatos/emprestimos, amostras/brindes, descartes/perdas, quebras tecnicas, e ajustes de inventario negativos. Cada tipo tem regras especificas de impacto (fisico, fiscal, ou ambos) e nivel de aprovacao (gestor ou diretor).

**Why this priority**: Complementa as saidas automaticas. Sem isso, movimentacoes manuais nao sao rastreaveis e o saldo diverge da realidade.

**Independent Test**: Pode ser testado registrando cada tipo de saida manual e verificando que o impacto no saldo e a cadeia de aprovacao sao corretos.

**Acceptance Scenarios**:

1. **Given** o operador registra uma transferencia intra-CNPJ, **When** aprovada pelo gestor, **Then** o saldo e debitado da localidade origem e creditado na localidade destino, sem impacto fiscal.
2. **Given** o operador registra um comodato, **When** aprovado pelo diretor, **Then** o saldo fisico e reduzido temporariamente, o fiscal permanece inalterado, e o sistema permite registrar o retorno futuro.
3. **Given** o operador registra um descarte, **When** aprovado pelo gestor, **Then** o saldo fisico e reduzido definitivamente e uma divergencia fiscal e registrada para regularizacao.

---

### User Story 7 - Metricas e KPIs para Diretoria (Priority: P3)

O diretor precisa acessar uma visao analitica do estoque com: valor total em BRL, exposicao cambial em USD (material em transito internacional), evolucao do estoque nos ultimos 6 meses, tabela analitica por SKU com custo medio ponderado, cobertura, e divergencias. Tambem precisa gerenciar fornecedores (excluir/incluir da fila de compra nacional) e localidades (CRUD).

**Why this priority**: Visao estrategica que nao bloqueia operacao diaria, mas e essencial para governanca e tomada de decisao de compra.

**Independent Test**: Pode ser testado com dados historicos verificando que os calculos de valor, giro e CMP estao corretos e que a exclusao de fornecedores impacta a fila do operador.

**Acceptance Scenarios**:

1. **Given** existem lotes com custo em USD e taxa de cambio, **When** o diretor acessa metricas, **Then** o sistema exibe valor total em BRL, exposicao cambial em USD, e giro medio por familia.
2. **Given** o diretor exclui um fornecedor, **When** o operador acessa a fila de NFs, **Then** NFs de compra nacional desse fornecedor nao aparecem (importacao e devolucao continuam visiveis).
3. **Given** dados historicos de 6 meses existem, **When** o diretor acessa a evolucao, **Then** um grafico mostra volume por familia (PP, PE, PS) mes a mes.

---

### User Story 8 - Gestao de Localidades e Configuracao (Priority: P3)

O gestor/diretor precisa cadastrar e gerenciar localidades de armazenamento: armazens proprios (vinculados a CNPJ), 3PLs, e portos secos. Cada localidade tem nome, tipo, cidade, CNPJ vinculado, e status ativo/inativo. Localidades inativas nao aparecem nas opcoes de recebimento e transferencia.

**Why this priority**: Configuracao necessaria para o sistema funcionar, mas feita uma vez e raramente alterada.

**Independent Test**: Pode ser testado criando, editando e desativando localidades e verificando o impacto nos dropdowns de recebimento.

**Acceptance Scenarios**:

1. **Given** o gestor cadastra uma nova localidade tipo "3PL", **When** salva, **Then** a localidade aparece nas opcoes de destino de recebimento e transferencia.
2. **Given** o gestor desativa uma localidade, **When** o operador tenta fazer recebimento, **Then** a localidade desativada nao aparece nos dropdowns.

---

### Edge Cases

- O que acontece quando o OMIE esta indisponivel durante uma tentativa de recebimento? O sistema deve exibir erro claro e nao registrar movimentacao parcial.
- O que acontece quando a quantidade fisica recebida e maior que a da NF? O sistema deve tratar como divergencia (sobra), nao apenas falta.
- O que acontece com lotes em transito quando a data prevista de chegada e ultrapassada? O sistema deve exibir alerta visual (atrasado).
- O que acontece quando um produto e descontinuado mas ainda ha lotes em estoque? O produto permanece visivel enquanto houver saldo > 0.
- O que acontece com uma transferencia entre CNPJs (Acxe -> Q2P) se o produto correlato nao existe na Q2P? O sistema bloqueia e notifica o admin, similar ao recebimento.
- O que acontece quando dois operadores tentam processar a mesma NF simultaneamente? O sistema deve garantir idempotencia — apenas o primeiro processamento e aceito.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema DEVE consultar NFs de entrada (importacao, devolucao, compra nacional, retorno remessa/comodato) pendentes de conciliacao nos dois CNPJs (Acxe e Q2P) via integracao com OMIE.
- **FR-002**: O sistema DEVE permitir ao operador confirmar a quantidade fisica recebida, comparar com a quantidade da NF, e registrar divergencias com motivo obrigatorio.
- **FR-003**: O sistema DEVE criar lotes com rastreabilidade completa: produto, fornecedor, origem, quantidade fisica, quantidade fiscal, custo USD, status, estagio de transito, localidade, CNPJ, data de entrada, NF vinculada.
- **FR-004**: O sistema DEVE calcular e exibir saldo por produto: fisico disponivel, fiscal registrado, provisorio, em cada estagio de transito (intl, porto/DTA, interno).
- **FR-005**: O sistema DEVE calcular cobertura de estoque em dias (saldo fisico / consumo medio diario) e classificar criticidade: critico (<50% LT), alerta (<120% LT), ok, excesso (>400% LT).
- **FR-006**: O sistema DEVE suportar 4 estagios de transito com visibilidade diferenciada por perfil (intl e porto: gestor+diretor; interno e reservado: todos).
- **FR-007**: O sistema DEVE processar saidas automaticas via polling periodico (n8n) das NFs de saida do OMIE (venda, remessa beneficiamento, transf. entre CNPJs, devolucao a fornecedor) sem intervencao do operador.
- **FR-008**: O sistema DEVE tratar debito cruzado — quando o CNPJ faturador difere do CNPJ que detem o estoque fisico — debitando cada dimensao (fisica e fiscal) no CNPJ correto e registrando divergencia cruzada.
- **FR-009**: O sistema DEVE implementar cadeia de aprovacao hierarquica: operador -> gestor -> diretor, com nivel de aprovacao configuravel por tipo de movimentacao.
- **FR-010**: O sistema DEVE suportar 19 tipos de movimentacao (7 entradas + 12 saidas), cada um com regras especificas de impacto fisico, impacto fiscal, e nivel de aprovacao.
- **FR-011**: O sistema DEVE suportar unidades de medida com conversao automatica para toneladas: t, kg, saco (25 kg), big bag (1 t).
- **FR-012**: O sistema DEVE manter correlacao de produtos entre os dois CNPJs (ACXE <-> Q2P) via match da descricao textual dos produtos (mantendo mecanismo do legado), bloqueando operacoes quando o correlato nao existe e notificando o administrador.
- **FR-013**: O sistema DEVE manter registro de movimentacoes (log) consultavel com paginacao, incluindo: tipo, quantidade, data, referencia (NF), status, e usuario responsavel. Exclusoes de movimentacao DEVEM ser soft delete (marcar `ativo=0`), preservando o registro para auditoria.
- **FR-014**: O sistema DEVE permitir ao gestor/diretor gerenciar localidades (CRUD) com tipos: proprio, 3PL, porto seco — vinculando opcionalmente a um CNPJ.
- **FR-015**: O sistema DEVE permitir ao diretor excluir/incluir fornecedores da fila de conciliacao de compra nacional (sem afetar importacao e devolucao).
- **FR-016**: O sistema DEVE calcular e exibir metricas: valor total do estoque (BRL), exposicao cambial (USD em transito intl), evolucao 6 meses, CMP por SKU, taxa de divergencia.
- **FR-017**: O sistema DEVE garantir idempotencia no processamento de NFs — uma NF ja processada nao pode ser reprocessada.
- **FR-018**: O sistema DEVE emitir notificacoes (via mecanismo da plataforma) para: divergencias no recebimento, produto sem correlato, debito cruzado, e pendencias de aprovacao.
- **FR-019**: O sistema DEVE suportar 3 perfis de acesso com visibilidade progressiva: Operador (vinculado a um armazem fixo atribuido pelo admin, so ve lotes e NFs daquela localidade), Gestor (todos armazens + fiscal + transito intl/porto), Diretor (tudo + metricas + fornecedores + usuarios).

### Key Entities

- **Produto (SKU)**: Materia-prima petroquimica. Atributos: codigo OMIE, nome, familia (PP/PE/PS), NCM, lead time em dias, consumo medio diario em toneladas. Vinculado a um par de codigos (ACXE + Q2P).
- **Lote**: Unidade rastreavel de estoque. Atributos: produto, fornecedor, pais de origem, quantidade fisica, quantidade fiscal, custo USD, status (reconciliado/divergencia/transito/provisorio/aguardando aprovacao/rejeitado), estagio de transito, localidade, CNPJ, data de entrada, NF vinculada, flag manual, dados de aprovacao.
- **Localidade**: Local de armazenamento. Atributos: nome, tipo (proprio/3PL/porto seco), cidade, CNPJ vinculado, status ativo/inativo.
- **Movimentacao**: Registro pareado de uma operacao sobre um lote (uma linha por NF com ambos os lados CNPJ). Atributos: nota_fiscal (chave logica), tipo (19 possiveis), quantidade, **lado ACXE** (mv_acxe, dt_acxe, id_movest_acxe, id_ajuste_acxe, id_user_acxe), **lado Q2P** (mv_q2p, dt_q2p, id_movest_q2p, id_ajuste_q2p, id_user_q2p), flag ativo (soft delete). Impactos fisico/fiscal, nivel de aprovacao, status e observacoes sao derivados do tipo e do estado do lote vinculado.
- **Divergencia**: Diferenca entre saldo fisico e fiscal de um lote. Atributos: lote, quantidade prevista, quantidade recebida, delta, tipo (faltando/varredura/cruzada), status (aberta/aprovada/rejeitada/regularizada), data.
- **Fornecedor**: Fornecedor de materia-prima. Atributos: nome, pais, CNPJ/ID fiscal, status (ativo/excluido do app).
- **Correlacao de Produto**: Mapeamento entre codigo do produto na ACXE e codigo na Q2P, com localidades de estoque padrao para cada CNPJ.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: O operador consegue confirmar o recebimento de uma NF em menos de 2 minutos (busca NF + informa quantidade + confirma).
- **SC-002**: O cockpit de estoque exibe saldos, cobertura e criticidade de todos os SKUs em menos de 3 segundos.
- **SC-003**: 100% das NFs de saida processadas no OMIE resultam em debito automatico no saldo do sistema sem intervencao manual.
- **SC-004**: Divergencias entre fisico e fiscal sao rastreaveis do momento da deteccao ate a regularizacao, com historico completo.
- **SC-005**: O gestor consegue aprovar ou rejeitar uma pendencia em menos de 30 segundos (visualizar contexto + acao).
- **SC-006**: O pipeline de transito reflete a posicao atualizada de todas as importacoes em andamento, com visibilidade correta por perfil.
- **SC-007**: O diretor tem visibilidade do valor total do estoque e exposicao cambial atualizada em tempo real.
- **SC-008**: Nenhuma NF e processada em duplicidade, independente de tentativas simultaneas.
- **SC-009**: Todas as 19 movimentacoes documentadas sao suportadas com regras corretas de impacto e aprovacao.
- **SC-010**: Todas as funcionalidades do sistema PHP legado sao replicadas no Atlas com paridade de outputs. O cutover ocorre apos 2 semanas de validacao paralela sem divergencia, em conformidade com o Principio V da constituicao (Validacao Paralela, Zero Big-Bang).

## Clarifications

### Session 2026-04-16

- Q: Como o StockBridge recebe eventos de saida do OMIE (venda, remessa, etc.) para debito automatico? → A: Polling periodico via n8n — job que consulta NFs de saida a cada X minutos, seguindo o padrao ja adotado no modulo Hedge.
- Q: Operador e vinculado a um armazem fixo ou pode escolher? → A: Fixo — admin atribui armazem ao operador, operador nao pode trocar.
- Q: Como sera a transicao de dados do sistema legado MySQL? → A: Migracao parcial. Apenas as tabelas nativas do sistema legado PHP precisam migrar: `tb_movimentacao` (log de recebimento), `tb_estoque_local_acxe`, `tb_estoque_local_q2p`, `tb_converteCodigoLocalEstoque`, `tb_tp_divergencia`, `tb_tp_status_movimento`. Produtos, fornecedores e clientes ja existem no PostgreSQL via sync n8n (copia do PG foi feita para o MySQL pelo dev legado — nao migrar de volta). Historico de metricas derivado dos dados combinados no PG.
- Q: Lote rejeitado pelo gestor pode ser re-submetido pelo operador? → A: Sim, re-submetivel — operador pode corrigir quantidade/motivo e re-submeter para aprovacao.
- Q: De onde vem o historico para metricas de evolucao 6 meses no dia do go-live? → A: Parte dos dados ja esta no PostgreSQL (tabelas copiadas do PG para MySQL pelo dev legado). Apenas as tabelas de log de recebimento precisam migrar do MySQL (simples). Historico de metricas sera derivado dos dados ja existentes no PG + logs migrados.
- Q: Como sera feita a correlacao de produto ACXE↔Q2P? → A: Manter o mecanismo legado — match por texto da descricao (`tb_produtos_ACXE.descricao = tb_produtos_Q2P.descricao`). Nao criar tabela explicita de correlacao na v1.
- Q: Exclusao de movimentacao e hard delete ou soft delete? → A: Soft delete — preservar rastro de auditoria (quem/quando/por que). Preservar a funcionalidade atual do legado (botao "remover" continua no UI), mas marcar `ativo=0` em vez de DELETE fisico.
- Q: Uma NF gera um registro de movimentacao unico (com lados ACXE+Q2P) ou dois registros separados? → A: Manter modelo legado — uma linha por NF com ambos os lados (mv_acxe/dt_acxe/id_movest_acxe + mv_q2p/dt_q2p/id_movest_q2p). O sistema dispara entrada em cada CNPJ e o par fica consolidado numa unica linha.

## Assumptions

- O OMIE continua sendo o ERP fonte de verdade para NFs e dados fiscais. A integracao segue o padrao de API REST ja utilizado pelo sistema legado.
- Os 3 CNPJs (Acxe Matriz, Q2P Matriz, Q2P Filial) e suas chaves de API OMIE permanecem como estao.
- Os 6 produtos iniciais (PP Inj, PP Sopro, PP Rafia, PEAD, PEBD, PS) representam o catalogo atual, mas o sistema deve suportar adicao de novos produtos.
- As stored procedures MySQL do sistema legado serao portadas para o esquema PostgreSQL do Atlas, nao reutilizadas diretamente.
- A migracao do legado sera parcial: parte das tabelas ja existem no PostgreSQL (foram copiadas do PG para MySQL pelo dev legado, portanto a fonte original e o PG). Apenas as tabelas de log de recebimento do sistema PHP precisam ser migradas do MySQL — sao simples e de baixo volume. Historico para metricas sera recalculado a partir dos dados combinados.
- O mecanismo de autenticacao e autorizacao sera o ja existente na plataforma Atlas (spec 001), nao o JWT+cookie do sistema PHP legado.
- Notificacoes serao entregues via mecanismo padrao da plataforma (a definir — email, in-app, ou ambos), substituindo o SendGrid direto.
- O consumo medio diario por produto sera configuravel via interface, nao hardcoded.
- A taxa de cambio USD/BRL para calculo de valor de estoque seguira o mesmo padrao de PTAX ja implementado no modulo Hedge (cache Redis 15min).
- O modulo ComexFlow (quando implementado futuramente) sera o responsavel por gerenciar o avanco de estagios de transito. Ate la, o StockBridge tera interface propria para avanco manual de estagio.
