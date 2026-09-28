# Achados do primeiro uso real — CRM Q2P · Rodada 17

**23/09/2026 (atualizado em 24/09/2026) · Devolutiva à OrbitIA**

---

## Contexto

Este documento reúne o que apareceu nos dias 22 e 23/09, com o time de vendas usando o CRM
na Q2P. Cada item traz o comportamento observado, o critério esperado e a evidência. Os
números seguem a numeração de achados das devolutivas anteriores: #43(e), #47 e #2 são itens
que já tinham sido registrados, e do #67 em diante são novos.

**Classificação:** *Mandatório* = impede o uso normal da função. *Melhoria* = pode aguardar a
próxima rodada.

**Prazo:** o item #47 é para a **versão desta semana**. Para os demais Mandatórios,
pedimos a previsão de correção.

**Evidência do OMIE:** o vendedor de cada cliente no OMIE (item #83) vem de consulta feita em
23/09 no espelho da base do OMIE (cadastro de clientes e de vendedores da Q2P).

## Resumo

| # | Assunto | Classificação |
| --- | --- | --- |
| #83 | Clientes de outros vendedores na Carteira | Mandatório |
| #89 | Carteira: cliente novo não aparece até existir uma venda; telas do gestor para clientes sem dono e sem venda em 90 dias | Mandatório |
| #47 | Busca "quem atende este cliente?" (só nome do cliente e do vendedor) | Mandatório, versão desta semana |
| #74 | Crédito disponível diferente do OMIE | Mandatório |
| #79 | Busca de cliente em Novo Pedido apaga o texto digitado | Mandatório |
| #80 | Preço do concorrente não aceita valor abaixo do nosso mínimo | Mandatório |
| #84 | Data do próximo contato não respeitada nem exibida | Mandatório |
| #85 | Histórico completo dos contatos do vendedor | Mandatório |
| #86 | Agenda | Mandatório |
| #87 | Ajuste de Preço: relatos sem sugestão, sem cliente e valor | Mandatório |
| #88 | Ajuste de Preço: editar a sugestão antes de aprovar | Mandatório |
| #43(e) | Gestor sem acesso ao detalhe das perdas e aos preços dos concorrentes | Mandatório |
| #73 | Nome do contato comercial não aparece na ficha do cliente | Mandatório |
| #68 | Gestor sem acesso a cadastrar e editar cliente | Mandatório |
| — | 13 itens de melhoria (seção 2) | Melhoria |

---

## 1. Mandatórios

### #83 — Clientes de outros vendedores aparecem na Carteira

**Observado:** clientes que pertencem a um vendedor no OMIE aparecem na Carteira de outro
vendedor no CRM.

| Cliente | CNPJ | Vendedor no OMIE | Aparece na Carteira de |
| --- | --- | --- | --- |
| KITOPLASTIC | 10.628.798/0001-74 | Cleber Silva | Rodrigo |
| CHANDAL | 54.274.113/0003-76 | Fábio | Rodrigo |
| ZAP | 59.118.547/0001-39 | Eduardo | Cleber |
| MANHATTAN (e MANHATTAN 2) | 59.688.432/0001-80 e /0002-60 | Rodrigo | Cleber |

**Critério:** a Carteira de cada vendedor lista os clientes cujo vendedor no cadastro do OMIE
é ele. Confirmado que o problema é na tela Carteira, e não na busca do Novo Pedido.

**Pedido:** comparar, para todos os clientes, o vendedor gravado no CRM com o vendedor do
OMIE, indicar a causa da divergência (vínculo do usuário, sincronização ou filtro da
Carteira) e corrigir.

### #89 — Carteira: regra de composição e telas do gestor para clientes sem dono e sem venda

**Observado:**

1. O CRM só exibe o cliente na Carteira do vendedor depois que existe ao menos uma venda em
   nome desse cliente com o vendedor vinculado. Exemplo: CHARLIE (CNPJ 64.887.482/0001-26),
   cadastrado no OMIE com o vendedor Leonardo, não aparece para o Leonardo.
2. Em 21/09 havia 467 clientes sem vendedor no cadastro. Eles não aparecem na Carteira de
   ninguém e o gestor não tem uma lista deles.
3. O gestor não tem uma tela com o cadastro de todos os clientes.
4. Clientes sem compra há mais de 90 dias ficam na Carteira do vendedor (comportamento a
   manter) e o gestor não tem uma lista deles.

**Critério:**

1. **Carteira:** o cliente aparece na Carteira do vendedor vinculado no cadastro do OMIE assim
   que o vínculo existe, com ou sem venda anterior.
2. **Menu "Clientes" para gestor e diretor**, com três telas:
   - **Cadastro de todos os clientes:** consulta e edição.
   - **Clientes sem dono:** lista dos clientes sem vendedor, com opção de o gestor definir o
     vendedor.
   - **Clientes sem venda nos últimos 90 dias:** lista para o gestor avaliar os motivos da
     não venda e decidir se mantém ou altera o vendedor. O cliente **continua na Carteira do
     vendedor** enquanto isso. Para avaliar os motivos, o gestor precisa ver o histórico de
     contatos e as perdas registradas no período (ver #85 e #43(e)).
3. **Gravação no OMIE:** a troca de vendedor feita pelo gestor é gravada também no cadastro do
   cliente no OMIE. Se ficar só no CRM, a sincronização seguinte desfaz a alteração.
4. **Fora do escopo:** a saída automática do cliente da Carteira do vendedor por tempo sem
   compra. O cliente não deve ficar sem vendedor por regra do sistema.

**Relação com o #83:** no #83 há clientes na Carteira de quem não é o vendedor do cadastro; aqui
há cliente fora da Carteira de quem é. Pode indicar que a Carteira não é montada a partir do
vendedor do cadastro.

**Pedido:** informar a regra atual de composição da Carteira e ajustá-la para usar o vendedor do
cadastro do OMIE; enviar a estimativa das três telas do menu Clientes.

### #47 — Busca "este cliente já é atendido? por quem?" (versão desta semana)

**Necessidade:** o vendedor precisa saber se um cliente já é atendido por outro vendedor
antes de fazer o primeiro contato. A lista completa de clientes da empresa continua
**bloqueada** para o vendedor.

**Critério:** uma busca na base inteira que devolve ao vendedor **somente**:

- o nome do cliente; e
- o nome do vendedor que já o atende.

**Não pode devolver:** telefone, e-mail, contato, endereço, CNPJ, limite de crédito,
histórico, pedidos nem qualquer outro dado cadastral. Sem listagem navegável e sem
exportação. O objetivo é que o vendedor não consiga extrair informação que permita levar a
carteira da empresa.

**Requisitos de segurança:**

1. O filtro deve ser feito **no backend**: a resposta da API não pode conter os demais
   campos. Nossa validação será pela resposta da API, e não só pela tela.
2. Busca por termo informado, com mínimo de caracteres. Termo vazio ou curinga não pode
   listar a base.
3. Limite de resultados por consulta e limite de frequência por usuário, para impedir
   varredura da base por consultas sucessivas.
4. Registro de auditoria de quem consultou o quê.

### #74 — Crédito disponível diferente do OMIE

**Observado:** cliente PISANI.

| | Valor |
| --- | --- |
| Limite de crédito total (OMIE) | R$ 5.000.000,00 |
| Recebíveis em aberto | R$ 144.808,13 |
| Disponível esperado (limite menos recebíveis) | R$ 4.855.191,87 |
| Disponível exibido no CRM | R$ 1.855.192,00 |

A diferença é de aproximadamente R$ 3.000.000,00. Segundo o Flavio, esse valor coincide com o
limite de crédito do banco Modde. Isso é uma hipótese nossa, ainda não confirmada.
O cliente AZZU apresenta o mesmo comportamento (valores exatos não registrados nesta
rodada). O valor exibido pelo OMIE é o correto.

**Critério:** o crédito disponível no CRM é igual ao do OMIE.

**Pedido:** informar de onde o CRM extrai o limite de crédito e os recebíveis em aberto, e
qual a fórmula do "disponível". Corrigir o cálculo.

### #79 — Busca de cliente em Novo Pedido apaga o texto digitado

**Observado:** em Novo Pedido, no campo de busca do cliente, cerca de 3 segundos depois de
começar a digitar o campo é reiniciado: o texto é apagado, o filtro da lista some e a tela
volta ao estado inicial.

**Critério:** o texto digitado permanece no campo e o filtro da lista se mantém até o
usuário escolher um cliente.

### #80 — Preço do concorrente não aceita valor abaixo do nosso mínimo

**Onde:** registro de perda (motivo Preço), campo "Preço do concorrente".

**Observado:** o combo oferece apenas valores entre o nosso preço de lista e o nosso mínimo;
a última opção é o próprio mínimo. Não é possível registrar um valor menor.

**Critério:** o vendedor consegue registrar o valor real praticado pelo concorrente,
inclusive abaixo do nosso mínimo. Esse é o cenário em que a venda costuma ser perdida.

### #84 — Data do próximo contato não é respeitada nem exibida

**Observado:**

1. ALFATERM e ALPHAQUALY: depois de registrar o atendimento com a data do próximo contato
   na semana seguinte, os clientes passam a aparecer como **atrasados**.
2. A data do próximo contato **não aparece** em nenhuma tela depois de registrada.
3. AMERICAN PLAST: atendimento registrado com data do próximo contato; na listagem o
   cliente aparece como **"sem data"**.

**Critério:** a data do próximo contato informada no atendimento é gravada, exibida e usada
para definir se o contato está em dia, atrasado ou sem data.

### #85 — Histórico completo dos contatos do vendedor

**Necessidade:** o vendedor precisa ter acesso completo ao histórico dos contatos que ele
fez com os clientes: cada contato, o que foi conversado, o motivo, o resultado (vendeu ou
não vendeu), o preço do concorrente informado e a data do próximo contato.

**Relação:** depende do #84 (data do próximo contato) e tem ponto em comum com o #43(e).

### #86 — Agenda (`/agenda`)

Este comportamento já constava na especificação: F32 (visões dia, semana e mês, com badges
nos dias agendados) na Rodada 2, e também F9 e F36. No relatório da Rodada 3, F9, F32 e F36
constam como atendidos. Na Agenda de hoje:

1. **Não há calendário.** O critério é um calendário com os clientes agendados por dia,
   semana e mês, para o vendedor organizar o dia.
2. **O botão "Agendar" agenda para o dia seguinte.** Não sabemos qual é o critério dessa
   data. O critério esperado é abrir um calendário para o vendedor escolher a data.
3. **"Novo acompanhamento"** permite escolher dia e horário, mas o agendamento **não
   aparece** na Agenda.
4. **Não há busca por nome do cliente** na Agenda. O critério é buscar por cliente e a
   Agenda mostrar somente aquele cliente.
5. **Registrar o atendimento direto da Agenda:** o vendedor clica no cliente e registra o
   atendimento sem sair da tela.
6. **Posição no menu:** a Agenda deve ser o **segundo item** do menu. É a tela onde o
   vendedor passa a maior parte do dia: vê quem ligar, liga, registra o contato (o que
   aconteceu, vendeu ou não vendeu, motivos) e passa para o próximo.

**Pedido:** informar se os agendamentos são gravados e por que os pontos 1 e 3 não aparecem,
em conjunto com o #84.

### #87 — Ajuste de Preço: relatos sem sugestão, sem cliente e valor

**Onde:** `/gestor/sugestoes-preco`, após "Recalcular hoje".

**Observado:** o painel "15 produto(s)/família(s) com relatos, mas sem sugestão gerada"
mostra uma linha por item apenas com o motivo (por exemplo, "1 de 1 relato(s) descartado(s)
(preço abaixo do mínimo R$10,80)" ou "1 de 3 relatos mínimos necessários"). Não mostra os
clientes nem os valores informados. Na sugestão pendente do PEAD, ao expandir, aparecem
cliente, produto, preço do concorrente e data.

**Critério:** para cada item do painel, o gestor vê os clientes e os valores informados,
inclusive os relatos descartados e os que não atingiram o mínimo de relatos.

### #88 — Ajuste de Preço: editar a sugestão antes de aprovar

**Observado:** na aba Pendentes, a sugestão (por exemplo, PEAD: lista atual R$ 12,375/kg,
ajuste −R$ 2,295/kg, novo preço R$ 10,08/kg) oferece apenas Aprovar e Rejeitar.

**Critério:** o gestor edita o valor sugerido antes de aprovar.

**A definir com vocês:** se a edição altera só o novo preço ou também o ajuste, e se a
sugestão editada fica identificada como editada no registro de auditoria.

### #43(e) — Gestor sem acesso ao detalhe das perdas e aos preços dos concorrentes

Item aberto em 04/09 e reconfirmado em 11/09.

**Observado:** o gestor não vê os detalhes do motivo das perdas (o que foi conversado, produto,
observações) nem os preços dos concorrentes informados pelos vendedores. O card de perdas
recentes mostra apenas cliente e volume.

**Critério:** o gestor vê o detalhe de cada perda e o preço do concorrente. É com esses
preços que ele decide o preço de lista e o mínimo da Q2P. O dado deve chegar às telas de
análise (perdas por motivo, dispersão de preços) e ao histórico do cliente.

**Relação:** o #80 limita o preço registrado ao nosso mínimo, o que também afeta esse dado.

### #73 — Nome do contato comercial não aparece na ficha do cliente

**Observado:** nos detalhes do cliente 9.GPLASTIC o nome do contato comercial (Marcelo) não
aparece.

**Critério:** o nome do contato comercial cadastrado no OMIE é exibido nos detalhes do cliente.

### #68 — Gestor sem acesso a cadastrar e editar cliente

**Observado:** o perfil Gestor não tem acesso a cadastrar novo cliente nem a editar clientes
já cadastrados.

**Critério:** o gestor cadastra clientes novos e edita clientes existentes. A consulta e a
edição ficam na tela de cadastro de todos os clientes do menu Clientes (#89); o cadastro de
cliente novo é o complemento pedido neste item.

**Relação:** enquanto o #77 e o #78 (seção 2) não forem tratados, salvar um cliente gera erro de
sincronização com o OMIE, também para o gestor.

---

## 2. Melhorias

| # | Assunto | Descrição |
| --- | --- | --- |
| — | Impressão/PDF do PV | O vendedor gera um PDF do pedido formalizado para enviar ao cliente, como hoje é feito pelo OMIE. Item já combinado desde 07/08; pedimos priorização. |
| #67 | Cockpit: total de vendas | O total de vendas do vendedor deve somar o faturado (etapa 50) e o que está nas etapas anteriores ainda não faturadas, incluindo a etapa 10. Não sabemos se hoje soma as duas partes. |
| #2 | Cadastro leve de prospecto | Cadastro de prospecto separado de cliente, com o mínimo de dados (cliente exige CNPJ e demais dados). O atendimento e o registro dos contatos iniciais precisam poder ser feitos antes do cadastro completo, e o prospecto vira cliente depois, sem perder o histórico. |
| #69 | Trocar a própria senha | Opção de trocar a senha com o usuário já logado. O fluxo "Esqueci a senha" já funciona. |
| #70 | Alternar Gestor/Vendedor no menu | Uma conta só, com o modo Vendedor em uma seção separada do menu do gestor. O Diretor liga ou desliga essa opção por gestor. Substitui o esquema atual de dois logins. |
| #71 | Ver a senha digitada | Opção de mostrar e ocultar a senha no campo. |
| #72 | Versão para celular | Versão do CRM para uso no celular. Formato (responsivo, aplicativo ou versão simplificada) a definir. |
| #75 | Gestor vê os contatos dos vendedores | O gestor consegue ver os contatos feitos, os contatos atrasados e os clientes sem agenda de contato. Depende do #84 e do #86. |
| #76 | Usuários: inativos em outra aba | Na tela de Usuários (Gestor e Diretor), os inativos ficam em uma aba separada. |
| #77 | Campo "E-mail Fiscal (NF-e)" | O cadastro de cliente tem esse campo, que não existe no OMIE, e o envio ao OMIE falha. |
| #78 | Salvar cliente sem alterar dados | Ao salvar sem alterar nada, aparece "Cliente atualizado com sucesso!" e em seguida: "Cliente atualizado, mas houve falha ao sincronizar com o OMIE: ERROR: Cliente nao cadastrado para o Código de Integração [401] !". |
| #81 | Novo Pedido: data-base das parcelas | As datas das parcelas são calculadas a partir da data de faturamento. O critério é usar a data prevista de entrega. |
| #82 | Novo Pedido: editar as parcelas | Antes de enviar ao OMIE, o vendedor edita as datas das parcelas. Motivo: alguns clientes só permitem faturamento às quintas-feiras e outros têm dias fixos do mês em que não podem ter boleto de fornecedor (por exemplo, dias 05 e 20). |

---

## 3. Perguntas para vocês

1. **#83 e #89:** qual é a regra que define quais clientes aparecem na Carteira de cada
   vendedor? Qual é a causa da divergência entre o vendedor do CRM e o do OMIE, e quantos
   clientes estão nessa situação?
2. **#74:** de onde vêm o limite de crédito e os recebíveis, e qual é a fórmula do disponível?
3. **#86 e #84:** os agendamentos e a data do próximo contato são gravados? Qual é o critério
   do botão "Agendar" para definir o dia seguinte?
4. **#47:** confirmação do prazo da versão desta semana e do desenho de segurança descrito
   acima.
