# CRM OrbitIA — Devolutiva da Validação (Round 3)

**Data:** 07/07/2026
**Referência:** "Relatório de Correções — CRM Q2P (Round 2)" enviado pela OrbitIA
**Contato:** Flavio Endo — flavio.endo@acxe-polimeros.com.br

---

## 1. Contexto

Após o recebimento do relatório de correções, os 47 pontos de teste foram percorridos um a um no sistema, em 07/07/2026. Este documento registra, de forma factual, para cada item: o **critério** verificado e o **comportamento observado**, com a evidência coletada.

O objetivo é permitir a reconciliação item a item. Onde o relatório de correções descreve um comportamento, o texto abaixo indica o que foi observado na validação.

---

## 2. Resumo

Dos **47 itens** validados:

- **39** atenderam ao critério;
- **7** não atenderam ao critério (seção 3);
- **2** dependem de dados a serem fornecidos pela ACXE (seção 5).

Além disso, **8 pontos novos** foram observados durante a validação — não constavam da lista original de findings (seção 4).

A lista completa dos 39 itens que atenderam está no Anexo A.

---

## 3. Itens que não atenderam ao critério (7)

### 3.1. Escrita para o OMIE

Três itens envolvem a criação de registros no OMIE. Em todos, a verificação foi feita **diretamente no OMIE**, além da tela do CRM.

---

**F49 — Cadastro de Cliente → OMIE**

- **Critério:** um cliente cadastrado no CRM sincroniza para o OMIE e fica utilizável.
- **Observado:**
  - O cliente é gravado no CRM (`POST /api/clientes/` → 201 Created; ex.: id 2333, "Cliente Teste QA2 Ltda").
  - Verificado no OMIE: o cliente **não foi criado** no OMIE. Na 1ª tentativa (sem endereço), o CRM exibiu: *"Cliente salvo, mas houve falha na sincronização com o OMIE: ERROR: É obrigatório o preenchimento do endereço (Estado)."*
  - Todos os campos apontados no Round 2 (telefone, e-mail, contato) existem no formulário.
  - Ponto secundário: o cliente criado não aparece na busca da Carteira do vendedor. Verificou-se que ele **existe e é selecionável** em Novo Pedido; a ausência na Carteira decorre de o cliente não ter "vendedor responsável" atribuído (não é falha de persistência).

---

**F38 — Pedido (fluxo do vendedor) → OMIE**

- **Critério:** um pedido criado e aprovado chega ao OMIE.
- **Observado:**
  - Pedido criado (`POST /api/pedidos/` → 201), status "Pendente" → após aprovação do gestor, "Aprovado" (#6204).
  - Na aprovação, o CRM exibiu: *"Falha no envio ao OMIE: ERROR: O preenchimento da tag [codigo_categoria] é obrigatório!"*
  - Verificado no OMIE: o pedido **não foi criado**.
  - O pedido permanece com status "Aprovado" no CRM apesar da falha de sincronização.

---

**F46 — Novo Pedido (fluxo do admin/gestor) → OMIE**

- **Critério:** um pedido criado pelo admin chega ao OMIE.
- **Observado:**
  - Com a origem "Pedido da Gestão" (descrita na tela como "Sem vínculo com vendedor. Lançado diretamente pelo gestor."), ao clicar "Enviar ao OMIE": `POST /api/pedidos/` → **400 Bad Request**, mensagem `{"vendedor":"Usuário não tem perfil de vendedor."}`.
  - O pedido **não foi criado** no CRM (e, portanto, não chegou ao OMIE).
  - Observação: a regra que exige perfil de vendedor foi acionada mesmo na origem "Pedido da Gestão".

---

**F31 — Cálculo de comissão**

- **Critério:** com uma regra de comissão cadastrada, a comissão exibida reflete as vendas da família/vendedor.
- **Observado:**
  - O cadastro de regra de comissão funciona (formulário abre e salva; o sistema impede duplicidade vendedor+família). Isso corresponde ao previsto para F39/F45.
  - Para o vendedor Danilo, há regra cadastrada na família PEBD CONV C/D: Base R$ 0,0380/kg; Bônus Volume R$ 10,00; Fator Margem 1,00%.
  - No "Detalhe por Família", a família PEBD CONV C/D apresenta: Volume vendido 3,4 t; Valor Total R$ 44.248; **% Comissão = 0,00%**; **Comissão Base = R$ 0**.
  - Cálculo esperado pelo critério: 0,0380 × 3.400 kg ≈ **R$ 129,20**.
  - O item 2.4 do relatório de correções indica que o motor de comissão calcularia corretamente uma vez cadastrada a regra. Na validação, com a regra cadastrada e vendas correspondentes, a comissão base exibida permanece R$ 0.

---

### 3.2. Demais itens

**F15 — Meta global no Cockpit**

- **Critério:** o Cockpit exibe o percentual de cobertura das metas individuais sobre a meta global.
- **Observado:** o campo de meta global existe; ao defini-la, o Cockpit passa a usá-la como alvo (gap recalculado). O percentual de cobertura das metas individuais aparece **apenas na tela de Configurações**, não no Cockpit.

---

**F26 — Cliente agendado na Agenda**

- **Critério:** clicar no cliente agendado abre o atendimento daquele cliente.
- **Observado:** o clique leva a `/carteira?cliente=649` (lista de Carteira), sem abrir o atendimento do cliente nem destacá-lo. O item 4.3 do relatório descreve "abre diretamente o atendimento daquele cliente na Carteira".

---

**F25 — Indicação de campo obrigatório no "Fazer Pedido" (vendedor)**

- **Critério:** ao tentar enviar com campo obrigatório vazio, o sistema indica qual campo falta.
- **Observado:** no fluxo "Fazer Pedido" (vendedor), o botão de avançar fica desabilitado, mas não há mensagem nem destaque indicando o campo faltante. No fluxo "Novo Pedido" (admin), o mesmo cenário exibe a mensagem "Para enviar, preencha: Entrega prevista" e destaca o campo (ver F35, que atendeu ao critério). A indicação existe em um fluxo e não no outro.

---

## 4. Pontos novos observados (8)

Itens identificados durante a validação, que não constavam da lista F1–F49.

| Código | Área | Tipo | Descrição |
|---|---|---|---|
| F50 | Metas | Bug | Ao definir a Meta Global e depois zerá-la (= 0), a tela de Configurações passa a exibir "cobertura: Infinity%" em vez da mensagem de "sem meta global definida". |
| F51 | Config → Metas | Sugestão | A duplicação de metas do mês anterior poderia confirmar antes de sobrescrever e sobrescrever apenas as metas destravadas. |
| F52 | Aprovações / Pedidos | Sugestão | Um pedido em "aguardando aprovação" não gera alerta/contador no menu para o aprovador; a pendência só é vista ao abrir a tela. |
| F53 | Pedidos / OMIE | Bug | Nenhum número exibido no CRM corresponde ao número da tela do OMIE ("#6204" é interno do CRM; "OMIE #8465889303" é um ID interno de banco). Um "OMIE #" é exibido para um pedido que falhou ao sincronizar. |
| F54 | Novo Pedido | Sugestão | O seletor de cliente é um `<select>` nativo com 501 opções carregadas de uma vez, sem busca/autocomplete por texto (diferente do campo de produto). |
| F55 | Estoque | Bug | Ao filtrar a busca para um único produto (PP-146), o cabeçalho da família exibe "1 produto" mas com o total em kg da família inteira (390.348 kg) em vez do total do produto listado (290.523 kg). |
| F56 | Pedidos (vendedor) | A confirmar | Logado como vendedor, não há acesso a uma lista/histórico consolidado dos próprios pedidos de venda (os pedidos são vistos apenas por cliente). Confirmar se é intencional. |
| F57 | Financeiro / Inadimplência | Bug | Clientes com boletos vencendo no próprio dia (07/07) são classificados como inadimplentes. A regra D+1 foi aplicada ao selo do título individual (F20), mas não à classificação de inadimplência do cliente. |

---

## 5. Itens que dependem de dados da ACXE (2)

**F47 — Duplicação de metas do mês anterior**

- Observado: a duplicação **não sobrescreve** metas já existentes ("0 meta(s) duplicada(s), N já existia(m)"). Não foi possível validar a **cópia efetiva** de metas porque não havia um mês de destino sem metas. A ACXE testará contra um mês de destino vazio; caso o resultado seja "0 duplicada(s)" também nesse cenário, o ponto retorna à OrbitIA.

**F27b — Total de estoque**

- Observado: "TOTAL EM ESTOQUE" = 1.903.864 kg (valor capturado, não avaliado). A reconciliação da divergência de saldo depende do relatório de referência da ACXE. O total varia ao longo do tempo (2.183.664 kg → 2.128.064 kg → 1.903.864 kg em diferentes datas), portanto a comparação deve ser feita no mesmo instante.

---

## 6. Ponto de design (sem ação solicitada)

**F24 — Seleção de cliente no Novo Pedido**

- Na origem "Em nome de um Vendedor", o cliente fica selecionável após a escolha do "Vendedor Responsável" (o combo então lista a carteira desse vendedor). Na origem "Pedido da Gestão", o combo lista todos os clientes. Esse comportamento corresponde ao descrito no item 2.3 do relatório de correções e foi **aceito** pela ACXE. Sem ação solicitada.

---

## Anexo A — Itens que atenderam ao critério (39)

F1, F2, F3, F4, F6, F7, F8, F9, F10, F11, F12, F13, F14, F16, F17, F18, F19, F20, F21, F22, F23, F24, F27a (indicador "chegando em 7 dias"), F29, F30, F32, F33, F34, F35, F36, F37, F39, F40, F41, F42, F43, F44, F45, F48.

---

*Documento gerado em 07/07/2026.*
