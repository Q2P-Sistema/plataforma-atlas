# CRM OrbitIA — Roteiro para a extensão do Claude no Chrome (Round 4)

Companion do "Relatório de Correções — CRM Q2P (Round 3)" da OrbitIA (10-11/07/2026).
Mesmo formato do Round 3: cada bloco é um **texto pronto para colar** na extensão do
Claude enquanto você está na aba do CRM. Cobre os **15 itens** que a OrbitIA alega ter
corrigido/implementado nesta rodada + as 2 funcionalidades novas (Logs de Erro, Motivo
da Perda). F47 e F27b **não entram** neste round — seguem pendentes de dados da ACXE.

## Como usar

1. Abra o CRM na aba e **cole o Preâmbulo uma vez** (define as regras).
2. Navegue até a tela do bloco, faça login do perfil indicado, e cole o bloco daquela tela.
3. Anote o resultado (PASS/FAIL/BLOQUEADO por finding) e me devolva em texto — vou
   registrando no Jira conforme for chegando.

## Convenções

- **⚠️ CONFIRMAR** = o bloco grava algo no OMIE de produção (pedido/cliente). A extensão
  para antes do botão final e pergunta. Só autorize com dados de teste, ciente de que é
  escrita real — e a verificação **no OMIE em si** é feita por mim, não pela extensão.
- **[perfil]** = com qual usuário estar logado (vendedor ou admin/gestor).
- Tenha à mão: **um cliente de teste**, **um produto com estoque**, e, para o bloco de
  F26, **um cliente INATIVO com agendamento** (crie um agendamento para um cliente
  inativo antes de rodar aquele bloco, se não houver um já existente).

---

## 0 · Preâmbulo — colar UMA vez

```
Você vai me ajudar a testar um sistema CRM (em português) na ABA ATUAL do navegador. Regras:

1. Para cada verificação que eu pedir, execute os passos e responda de forma curta:
   - PASS = funcionou como esperado (diga em 1 frase o que viu)
   - FAIL = não funcionou (diga o que viu de errado, com o texto/número exato)
   - BLOQUEADO = não consegui chegar ao ponto (diga o motivo)
   Sempre cite o código do item (ex.: F49) na resposta.

2. NUNCA crie, salve ou envie nada que grave em sistema externo (o ERP "OMIE") sem antes
   me perguntar e esperar minha confirmação explícita. Você PODE preencher formulários, mas
   quando eu marcar "PARE ANTES DE ENVIAR", pare antes do botão final e me pergunte.

3. Não invente dados de negócio (CNPJ, preço, cliente). Se um campo exigir um valor que eu
   não te dei, pare e me pergunte.

4. Anote valores exatos que aparecerem na tela: números, saldos, mensagens de erro,
   timestamps. Eles importam — principalmente neste round.

5. Trabalhe só na aba atual. Não abra outras abas nem mude de tela sem me avisar o que vai fazer.

Confirme que entendeu e aguarde o primeiro bloco.
```

---

## 1 · Carteira → Novo Prospecto — F49  ⚠️ CONFIRMAR  [vendedor]

```
Estamos na CARTEIRA. Abra "+ Novo Prospecto". Este bloco GRAVA no OMIE.

F49 — Passos:
1. Preencha um cliente de teste completo (Nome, Razão Social, CNPJ, telefone, e-mail,
   contato, Estado e Cidade).
2. Primeiro, tente avançar/salvar deixando só a CIDADE vazia (Estado preenchido).
   PASS (parte 1) se o sistema bloqueia e aponta Cidade como obrigatória.
3. Preencha a Cidade. PARE ANTES DE SALVAR e me pergunte (é escrita no OMIE). Aguarde
   minha confirmação.
4. Se eu confirmar: salve. Reporte a mensagem exata de resultado (sucesso / falha com
   texto do erro).
Esperado (PASS): Cidade é exigida independentemente do Estado, e o cliente sincroniza
sem erro. Reporte F49 (a validação de "chegou no OMIE" é feita por mim, no ERP).
```

---

## 2 · Fazer Pedido (vendedor) — F25 + preparar F38  [vendedor]

```
Estamos logados como VENDEDOR. Abra Carteira → um cliente com estoque disponível →
Atender → Fazer Pedido.

F25 — Deixe um campo obrigatório vazio (ex.: sem "Entrega prevista") e tente avançar.
PASS se aparece uma MENSAGEM explícita indicando qual campo falta (não só o botão
desabilitado) — igual ao que já acontece no Novo Pedido do admin (F35).

Depois, monte um pedido de teste COMPLETO (cliente de teste, 1 produto com estoque,
quantidade pequena, entrega preenchida) e deixe pronto para enviar, mas NÃO ENVIE
ainda neste bloco — me avise que terminou e aguarde o próximo bloco.
```

---

## 3 · Enviar pedido + aprovação — F38  ⚠️ CONFIRMAR  [vendedor → depois gestor]

```
Continuação do pedido montado no bloco anterior. Este bloco GRAVA no OMIE.

F38 — Passos:
1. PARE ANTES DE ENVIAR e me pergunte. Aguarde confirmação.
2. Se eu confirmar: envie o pedido (deve ficar "Pendente/aguardando aprovação").
3. Troque para o login de GESTOR (eu aviso quando trocar) e vá em Aprovações.
4. ANTES de abrir a tela de Aprovações, observe o MENU: há algum badge/contador
   indicando pendência? Reporte isso primeiro (relacionado ao F52, bloco 8).
5. Aprove o pedido. Reporte a mensagem exata que aparece (sucesso / falha OMIE).
6. Vá em Gestão → Pedidos → localize esse pedido → coluna OMIE. Reporte:
   (a) aparece o badge "⚠ Falha OMIE" se a sincronização falhou?
   (b) o status geral do pedido está consistente com o resultado (não fica
       "Aprovado" escondendo uma falha)?
Observação: a confirmação de que o pedido chegou (ou não) ao OMIE de verdade é feita
por MIM no ERP — você só reporta o que o CRM mostrou. Reporte F38.
```

---

## 4 · Gestão → Pedidos — F53  [admin/gestor]

```
Estamos em GESTÃO → PEDIDOS, coluna OMIE.

F53 — Observe a coluna OMIE para pedidos em diferentes status:
- Um pedido "Pendente" ou "Aprovado" (ainda não sincronizado): NÃO deve mostrar
  nenhum número/badge de OMIE (ou deve mostrar claramente que não foi enviado).
- Um pedido "Enviado ao OMIE" ou "Faturado": deve mostrar o número do OMIE.
PASS se o número só aparece nos status corretos (sem número "fantasma" em pedido
que falhou). Reporte F53.
```

---

## 5 · Novo Pedido (admin) — Origem "Pedido da Gestão" — F46 + F54  ⚠️ CONFIRMAR  [admin/gestor]

```
Estamos em GESTÃO → NOVO PEDIDO → Origem "Pedido da Gestão". Este bloco GRAVA no OMIE.

F54 — No seletor "Selecionar Cliente" (e também em "Empresa de Remessa", se existir),
comece a DIGITAR um nome. PASS se a lista filtra conforme você digita (não é mais
um <select> nativo com todas as opções de uma vez).

F46 — Monte um pedido de teste completo com essa origem.
1. PARE ANTES DE ENVIAR AO OMIE e me pergunte. Aguarde confirmação.
2. Se eu confirmar: envie. Reporte a mensagem exata e o código HTTP se conseguir ver
   no painel de rede (F12 → Network).
Esperado (PASS): NÃO deve mais aparecer o erro "Usuário não tem perfil de vendedor" —
o pedido deve ser criado usando um vendedor de sistema dedicado a essa origem.
Reporte F46 (a confirmação "chegou no OMIE" é feita por mim, no ERP).
```

---

## 6 · Agenda — cliente inativo — F26  [vendedor]

```
Estamos na AGENDA (perfil vendedor). Precisa de um cliente INATIVO com agendamento —
se não houver, agende um compromisso para um cliente inativo antes de continuar.

F26 — Clique no nome desse cliente agendado (inativo).
PASS se abre DIRETO o atendimento daquele cliente (não uma lista genérica da Carteira
sem destaque). Reporte F26.
```

---

## 7 · Remuneração — F31  [vendedor: Danilo, ou outro com regra cadastrada]

```
Logado como o vendedor que tem regra de comissão cadastrada (ex.: Danilo, família
PEBD CONV C/D — Base R$ 0,0380/kg). Abra "Minha Remuneração" → Detalhe por Família.

F31 — Observe a família com regra cadastrada e vendas no período.
PASS se "Comissão Base" (e % Comissão) NÃO é mais R$ 0 — deve refletir o cálculo
(ex.: para Danilo/PEBD, ~0,0380 × volume em kg). Reporte o valor exato mostrado e se
bate com a fórmula. Reporte F31.
```

---

## 8 · Menu Aprovações — F52  [admin/gestor]

```
Se ainda houver algum pedido "aguardando aprovação" pendente (ex.: reaproveitando o
do bloco 3, se ainda não foi processado, ou criando um novo):

F52 — Olhe o item "Aprovações" no MENU lateral, sem clicar ainda.
PASS se aparece um badge/contador indicando a quantidade de pendências, visível sem
precisar entrar na tela. Reporte F52.
```

---

## 9 · Configurações → Metas — F50 + F51  [admin/gestor]

```
Estamos em CONFIGURAÇÕES → METAS.

F50 — Defina uma Meta Global e depois ZERE-A (= 0).
PASS se a tela mostra a mensagem de "sem meta global definida" (ou equivalente) —
NÃO deve mais aparecer "cobertura: Infinity%". Reporte F50.

F51 — Localize a ação de duplicar metas do mês anterior e acione-a (sem confirmar
a sobrescrita de nada real — só observe o fluxo).
PASS se aparece uma confirmação ANTES de sobrescrever, e essa sobrescrita se limita
às metas destravadas. Reporte F51.
```

---

## 10 · Gestão → Cockpit — F15  [admin/gestor]

```
Estamos no COCKPIT (Gestão). Confirme que há uma Meta Global cadastrada (senão,
cadastre uma de teste ou me avise).

F15 — Localize o bloco "Meta R$" (ou equivalente).
PASS se, ao lado da meta, aparece o PERCENTUAL DE COBERTURA das metas individuais
sobre a meta global — não mais só na tela de Configurações. Reporte F15.
```

---

## 11 · Estoque — F55  [admin/gestor]

```
Estamos na aba ESTOQUE. Busque um código específico de produto (ex.: PP-146).

F55 — Observe o cabeçalho da família na lista filtrada.
PASS se o TOTAL em kg exibido no cabeçalho corresponde ao(s) produto(s) que
efetivamente aparecem na lista filtrada — não mais o total da família inteira.
Reporte o número exato exibido. Reporte F55.
```

---

## 12 · Menu lateral (Vendedor) — Meus Pedidos — F56  [vendedor]

```
Logado como VENDEDOR, procure no menu lateral uma opção "Meus Pedidos" (ou nome
equivalente).

F56 — Abra essa tela. PASS se lista um histórico consolidado dos pedidos do próprio
vendedor (não só pedidos vistos por cliente individual). Reporte o que aparece
(quantidade de pedidos, colunas mostradas). Reporte F56.
```

---

## 13 · Menu lateral (Gestão) — Central de Logs de Erro — novo  [admin/gestor]

```
Procure no menu lateral (perfil Gestão) um item com ícone de alerta (⚠), algo como
"Logs de Erro".

Novo — Abra a tela. Reporte:
1. Existem as categorias/abas: Aplicação, Sincronização, OMIE-Pedido, OMIE-Cliente
   (ou nomes equivalentes)?
2. Os erros que geramos nos blocos anteriores (F38, F46 se falharam) aparecem
   registrados aqui, com mensagem e timestamp?
Reporte como "Logs de Erro" (não tem F-número — é funcionalidade nova).
```

---

## 14 · Painel Diretor → Ajuste de Preço — F44 (recheck) + Motivo da Perda  [admin/gestor]

```
Estamos no PAINEL DIRETOR → Ajuste de Preço.

F44 (recheck) — Abra a tela. A OrbitIA diz que populou os "Motivos de Perda"
(Preço, Estoque, Concorrência, Crédito, Outro) via migration, o que deveria
desbloquear sugestões aqui.
PASS se agora aparecem SUGESTÕES de ajuste (antes só aparecia "Nenhuma sugestão").
Se ainda não houver sugestões, reporte BLOQUEADO e descreva a mensagem exata.

Também: se encontrar, em qualquer tela de atendimento/pedido, um campo "Motivo da
Perda", confirme que o dropdown lista as 5 opções (Preço, Estoque, Concorrência,
Crédito, Outro). Reporte como "Motivo da Perda".
```

---

## 15 · Financeiro / Inadimplência — F57 (com timestamp)  [admin/gestor ou vendedor]

```
Estamos em FINANCEIRO (ou Carteira, onde aparece classificação de inadimplência).

F57 — Procure um cliente com boleto vencendo HOJE.
1. Anote a HORA EXATA (hh:mm) em que você está fazendo o teste.
2. Reporte se esse cliente aparece classificado como "inadimplente" no MESMO dia
   do vencimento (deveria só classificar a partir de amanhã, D+1).
3. Se reproduzir o problema, TIRE UM PRINT da tela (nome do cliente, data do
   boleto, classificação exibida, e o relógio/data do sistema se visível).
A OrbitIA contesta este item (diz que é possível artefato de cache de 5 min na
virada do dia) — por isso o timestamp e o print são importantes desta vez.
Reporte F57 com data/hora exata.
```

---

## O que a extensão NÃO resolve (fica com você)

- **Confirmar no OMIE** que pedido/cliente realmente entraram (F38/F46/F49) — é
  escrita em produção; a verdade está no ERP, não na tela do CRM.
- **F38, parte (b)** — mesmo com o badge correto, o pedido só deve chegar de fato ao
  OMIE depois que a OrbitIA aplicar o `codigo_categoria=1.01.03` (resposta enviada
  em 13/07/2026). Se ainda falhar com a mesma mensagem de `codigo_categoria`, é sinal
  de que o fix não foi aplicado — não uma regressão nova.
- **F47 e F27b** — não fazem parte deste round; seguem aguardando dados/cenário da ACXE.
