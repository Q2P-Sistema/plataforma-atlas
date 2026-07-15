# CRM OrbitIA — Roteiro para a extensão do Claude no Chrome (Round 1 → 2)

Companion do checklist de validação. Aqui cada bloco é um **texto pronto para colar** na
extensão do Claude enquanto você está na aba do CRM. Organizado **por tela**: você navega/loga,
cola o bloco daquela tela, e a extensão roda as verificações e responde **PASS / FAIL / BLOQUEADO**
por finding.

## Como usar

1. Abra o CRM na aba e **cole o Preâmbulo uma vez** (define as regras).
2. Navegue até a tela do bloco, faça o login do perfil indicado (**a extensão não troca de login sozinha**), e cole o bloco daquela tela.
3. Anote o resultado no checklist web. No fim, "Copiar resumo" e me manda.

## Convenções

- **⚠️ CONFIRMAR** = o bloco grava algo no OMIE de produção (pedido/cliente). A extensão é instruída a **parar antes do botão final** e te perguntar. Só autorize com dados de teste e ciente de que é escrita real.
- **[perfil]** = com qual usuário estar logado (vendedor ou admin/gestor).
- Tenha à mão para os testes de pedido: **um cliente real de teste**, **um produto com estoque** (ex.: `PEAD EM5333AAH`) e uma **quantidade pequena**.

---

## 0 · Preâmbulo — colar UMA vez

```
Você vai me ajudar a testar um sistema CRM (em português) na ABA ATUAL do navegador. Regras:

1. Para cada verificação que eu pedir, execute os passos e responda de forma curta:
   - PASS = funcionou como esperado (diga em 1 frase o que viu)
   - FAIL = não funcionou (diga o que viu de errado, com o texto/número exato)
   - BLOQUEADO = não consegui chegar ao ponto (diga o motivo)
   Sempre cite o código do item (ex.: F24) na resposta.

2. NUNCA crie, salve ou envie nada que grave em sistema externo (o ERP "OMIE") sem antes
   me perguntar e esperar minha confirmação explícita. Você PODE preencher formulários, mas
   quando eu marcar "PARE ANTES DE ENVIAR", pare antes do botão final e me pergunte.

3. Não invente dados de negócio (CNPJ, preço, cliente). Se um campo exigir um valor que eu
   não te dei, pare e me pergunte.

4. Anote valores exatos que aparecerem na tela: números, saldos, mensagens de erro. Eles importam.

5. Trabalhe só na aba atual. Não abra outras abas nem mude de tela sem me avisar o que vai fazer.

Confirme que entendeu e aguarde o primeiro bloco.
```

---

## 1 · Tela de Login — F13  [qualquer perfil]

```
Estamos na tela de LOGIN do CRM.
F13 — Recuperação de senha:
1. Localize um link/opção "Esqueci minha senha". Se não existir, responda FAIL (F13).
2. Se existir, abra e informe um e-mail QUALQUER (pode ser um inexistente, ex.: naoexiste@teste.com) e envie.
3. Observe a mensagem de retorno.
Esperado (PASS): existe o fluxo e a mensagem NÃO revela se o e-mail existe ou não na base
(ex.: "se o e-mail estiver cadastrado, enviaremos o link"). Reporte F13.
```

---

## 2 · Metas — F1, F2, F3, F4, F15  [admin/gestor]

```
Estamos na tela de METAS (perfil gestor).
Faça e reporte cada item separadamente:

F1 — Na seleção de vendedor para ajustar meta, confirme que os vendedores (inclusive recém-cadastrados) aparecem. PASS se a lista traz os vendedores.
F2 — Trave uma meta e procure a ação para DESTRAVAR. PASS se dá para destravar (existe a ação inversa).
F3 — Olhe o valor de volume da meta. PASS se está sem casas decimais excessivas (não algo como 1,2500).
F4 — Se houver alternância de unidade, troque para kg. PASS se converte para kg.
F15 — Procure um campo para definir a META GLOBAL DA EMPRESA (top-down), separada da soma das
     metas individuais; e no Cockpit, veja se mostra quanto as metas individuais cobrem da global.
     PASS se dá para definir a meta global e a cobertura aparece.

Não salve alterações permanentes: se precisar editar para testar, me avise antes.
```

---

## 3 · Configurações → Metas — F47  [admin/gestor]

```
Estamos em CONFIGURAÇÕES → METAS.
F47 — Procure um botão "Duplicar metas de [mês anterior]" (ou equivalente).
Passos: selecione um mês novo e use a duplicação; observe se ele copia as metas do mês anterior.
Esperado (PASS): o botão existe e copia as metas do mês anterior para o mês selecionado, sem
sobrescrever as que já existirem. NÃO confirme a duplicação de forma definitiva se for alterar
dados reais — pare e me pergunte antes de salvar. Reporte F47.
```

---

## 4 · Cadastro de Cliente — parte segura — F6, F7, F30  [vendedor]

```
Estamos no CADASTRO DE CLIENTE (perfil vendedor). NÃO salve o cliente neste bloco.
Preencha campos apenas para observar o comportamento.

F6 — Verifique se existe um campo "Limite de Crédito" visível para o vendedor.
     PASS se o campo NÃO aparece para o perfil vendedor.
F30 — O formulário tem abas (Dados Básicos, Entrega, Contatos, Comercial). Navegue entre elas
     deixando um campo obrigatório vazio. PASS se há indicador de progresso ("Passo X de 4"),
     aviso visual na aba com pendência e/ou resumo do que falta.
F7 — Na aba Contatos: (1) tente adicionar um contato só com o NOME, sem e-mail e sem telefone;
     (2) depois de adicionar um contato, procure a opção de EDITÁ-LO.
     PASS se (1) o sistema exige ao menos e-mail OU telefone E (2) o contato pode ser editado
     após criado. Se qualquer um dos dois falhar, reporte FAIL (F7) dizendo qual.
```

---

## 5 · Cadastro de Cliente — sincronização OMIE — F49  ⚠️ CONFIRMAR  [vendedor/admin]

```
Estamos no CADASTRO DE CLIENTE. Este bloco GRAVA no OMIE.

F49 — Passos:
1. Preencha um cliente de teste com Nome, Razão Social, CNPJ, e também telefone, e-mail e contato
   (confirme que esses campos existem — se não existirem, já é FAIL parcial de F49).
2. PARE ANTES DE SALVAR e me pergunte se pode salvar (é escrita no OMIE). Aguarde eu confirmar.
3. Se eu confirmar: salve. Depois vá em buscar clientes e procure esse cliente recém-criado.
4. Reporte: (a) apareceu na busca? (b) a mensagem de sucesso é honesta (não é "sucesso" com o
   cliente sumindo)? Se der erro do OMIE, copie a MENSAGEM EXATA.
Esperado (PASS): cliente sincroniza, aparece na busca e fica utilizável; se o OMIE recusar,
aparece o motivo claro (sem cadastro "fantasma"). Reporte F49.
```

---

## 6 · Carteira — abrir cliente + Financeiro — F8, F20  [vendedor]

```
Estamos na CARTEIRA (perfil vendedor).

F8 — Clique em um cliente para abrir o detalhe. PASS se abre normalmente (sem erro 500 / AxiosError).
F20 — No detalhe do cliente, seção Financeiro: procure um título cujo vencimento seja HOJE.
     PASS se um título que vence hoje NÃO está marcado como "atrasado" (só a partir de amanhã, D+1).
     Se não houver título vencendo hoje, reporte BLOQUEADO (F20) e siga.
```

---

## 7 · Fazer Pedido (Carteira → Atender) — montagem, SEM enviar — F10, F18, F19, F21, F22, F33, F17, F12, F25  [vendedor]

```
Estamos logados como VENDEDOR. Abra Carteira → um cliente → Atender → Fazer Pedido.
NÃO ENVIE o pedido neste bloco (só montar e observar).

F10 — Confirme que existe a opção de fazer/abrir pedido para o vendedor. PASS se existe.
F17 — Observe o "Limite Disponível" do cliente. PASS se parece calculado/dinâmico (não um valor fixo genérico).
F19 — No campo de quantidade, digite um valor fracionado, ex.: 750,5. PASS se aceita fracionado e
     trabalha em kg (não em toneladas).
F18 — Na lista de produtos, veja se cada produto mostra o SALDO disponível. PASS se mostra saldo.
F21 — Escolha o tipo "Imediato" e depois "Futuro". PASS se "Imediato" mostra só produtos com estoque
     > 0 e "Futuro" mostra o catálogo inteiro.
F22 — A lista deve carregar o catálogo completo (não parar em ~50 itens). Busque o produto
     "PEAD EM5333AAH". PASS se ele aparece.
F33 — No campo de busca de produto, busque por um código (ex.: PP-146) e por parte da descrição.
     PASS se filtra por código E por descrição (não só pelos botões de família).
F12 — Adicione um produto e olhe o PREÇO por kg pré-preenchido. PASS se vem o preço de lista do
     produto (não R$ 0,01) e o total = quantidade(kg) × preço/kg fecha certo.
F25 — Deixe um obrigatório vazio (ex.: sem produto ou sem cliente) e tente avançar/enviar.
     PASS se aparece mensagem clara listando o que falta e NÃO deixa enviar.

Reporte cada F separadamente. Ao terminar, NÃO envie o pedido — me avise que terminou.
```

---

## 8 · Fazer Pedido — ENVIO real ao OMIE — F23, F38  ⚠️ CONFIRMAR  [vendedor]

```
Continuação do Fazer Pedido (VENDEDOR). Este bloco GRAVA no OMIE.

F23 / F38 — Passos:
1. Monte um pedido de teste completo (cliente de teste, 1 produto com estoque, quantidade pequena).
2. Verifique que a DATA DE ENTREGA é exigida (tente concluir sem ela). Reporte F23 (parte entrega).
3. PARE ANTES DE ENVIAR AO OMIE e me pergunte. Aguarde minha confirmação.
4. Se eu confirmar: envie. Anote a mensagem exata que aparece e se mostra uma tela de resultado
   (aprovado / aguardando aprovação / falha). Reporte F23 (parte confirmação).
5. Depois, na aba "Histórico" do atendimento daquele cliente, confirme se o pedido feito aparece
   listado. Reporte F23 (parte histórico).
Observação sobre F38: a validação de "chegou mesmo no OMIE" será feita por MIM no OMIE — você só
reporta o que o CRM mostrou (mensagem/telas). Não afirme que chegou ao OMIE só pela tela do CRM.
```

---

## 9 · Novo Pedido (admin) — montagem — F24, F35  [admin/gestor]

```
Estamos logados como ADMIN/GESTOR. Abra o menu NOVO PEDIDO. NÃO ENVIE neste bloco.

F24 — (a) O seletor/combo de CLIENTE deve abrir e permitir escolher, sem exigir antes selecionar um
     vendedor. PASS se o combo funciona. (b) Busque o produto "PEAD EM5333AAH". PASS se aparece.
F35 — Monte o pedido deixando "Entrega Prevista" (campo com asterisco) VAZIO e tente enviar.
     PASS se o campo fica destacado (ex.: vermelho) como motivo do bloqueio e NÃO deixa enviar.
Reporte F24 e F35. Ao final, não envie — me avise.
```

---

## 10 · Novo Pedido (admin) — ENVIO real ao OMIE — F46  ⚠️ CONFIRMAR  [admin/gestor]

```
Continuação do Novo Pedido (ADMIN). Este bloco GRAVA no OMIE.

F46 — Passos:
1. Monte um pedido de teste completo.
2. PARE ANTES DE ENVIAR AO OMIE e me pergunte. Aguarde confirmação.
3. Se eu confirmar: envie. Copie a mensagem exata e descreva a tela de resultado.
A validação de "chegou no OMIE" é feita por mim no OMIE — você só reporta o que o CRM mostrou.
Reporte F46.
```

---

## 11 · Agenda — F9, F26, F32, F36  [vendedor]

```
Estamos na AGENDA (perfil vendedor).

F9 — (a) Edite um agendamento já criado (PASS se é editável). (b) Clique num cliente agendado e veja
     se abre os dados dele. (c) Use "Novo Acompanhamento" e veja se vai para a tela correta (não para a Carteira genérica).
F26 — Ao clicar no nome de um cliente agendado, PASS se abre DIRETO o atendimento daquele cliente
     (não a lista inteira da Carteira).
F32 — Procure alternância de visões Dia / Semana / Mês. PASS se existem, e a de Mês mostra os
     compromissos por dia.
F36 — Em "Novo Acompanhamento", clique "Agendar" SEM preencher Cliente/Data. PASS se mostra erro
     ("Cliente e Data são obrigatórios") e destaca os campos vazios.
Reporte cada item. Não crie agendamentos definitivos sem me perguntar.
```

---

## 12 · Pedidos (admin) — F11, F14  [admin/gestor]

```
Estamos na lista de PEDIDOS (perfil admin).

F11 — Escolha um pedido e compare o NÚMERO exibido com o número no OMIE (eu confirmo o do OMIE se
     você me disser o número do CRM). Teste também o filtro por STATUS (além de "Faturado").
     PASS se o número é coerente e o filtro funciona em mais de um status. Verifique também se o
     campo redundante de "parcelas" foi removido.
F14 — Clique no cabeçalho de uma coluna da tabela para ordenar. PASS se um clique ordena crescente
     e outro inverte para decrescente. (Vale para qualquer tabela do sistema.)
```

---

## 13 · Estoque — F27a, F37, F27b  [admin/gestor]

```
Estamos na aba ESTOQUE.

F27a — Veja o indicador "chegando em até 7 dias". PASS se filtra realmente pela data de chegada
      (valor plausível para 7 dias), não a soma de tudo que está a caminho.
F37 — Busque um código específico (ex.: PP-146). PASS se mostra SÓ aquele produto (não expande a
     família inteira). Buscar pelo nome da família deve continuar mostrando a família.
F27b — Anote o TOTAL de estoque exibido (número exato em kg). NÃO julgue se está certo — isso eu
      reconcilio contra o relatório de referência. Só me devolva o número que apareceu.
```

---

## 14 · Configurações → Comissão + Minha Remuneração — F39/F45, F31  [admin/gestor]

```
Estamos em CONFIGURAÇÕES → COMISSÃO.

F39/F45 — (a) Procure um botão "+ Nova Configuração/Comissão" e abra o formulário (vendedor, família,
     R$/kg, bônus). PASS se o formulário abre e permite salvar. (b) Tente cadastrar uma regra
     DUPLICADA (mesmo vendedor + família). PASS se o sistema impede a duplicidade.
     PARE ANTES DE SALVAR regras reais e me pergunte — os valores de negócio são definidos por nós.
F31 — Depois, abra "Minha Remuneração" do vendedor Danilo (R$ 1,69M / 112,3%). Se já houver regras
     cadastradas, PASS se a comissão base/bônus deixou de ser R$ 0 e reflete as vendas. Se a tabela
     ainda estiver vazia, reporte BLOQUEADO (F31 depende das regras cadastradas).
```

---

## 15 · Configurações → Usuários — F16  [admin/gestor]

```
Estamos em CONFIGURAÇÕES → USUÁRIOS.
F16 — Tente iniciar a criação de um novo usuário. PASS se só permite perfis ADMINISTRATIVOS
(gestor/diretor/admin) e NÃO permite criar um "vendedor" manualmente (vendedor deve vir só da
sincronização com o OMIE). NÃO finalize a criação de nenhum usuário — só observe as opções e me
reporte. Reporte F16.
```

---

## 16 · Configurações → Capacidade — F48  [admin/gestor]

```
Estamos em CONFIGURAÇÕES → CAPACIDADE.
F48 — Abra a tela. PASS se o campo de capacidade diária (kg) já mostra o VALOR ATUAL cadastrado
(pré-preenchido), pronto para editar. FAIL se aparece vazio mesmo havendo valor salvo.
Não salve alterações. Reporte F48.
```

---

## 17 · Painel Diretor: Cockpit / Performance / Ajuste de Preço — F40, F41, F42, F43, F44  [admin/gestor]

```
Estamos no PAINEL DIRETOR.

F40 (Cockpit) — Selecione um MÊS JÁ ENCERRADO com meta não batida. PASS se mostra um resumo de
     fechamento ("Meta de [mês] não atingida: faltaram R$X / Y kg") em vez do alerta de urgência
     com "0 dias úteis".
F41 (Cockpit) — Troque o mês no seletor algumas vezes rapidamente. PASS se o título/subtítulo muda
     JUNTO com os dados (sem mostrar o mês antigo por 1-2s).
F42 (Performance) — Clique no card de um vendedor. PASS se leva direto à tela de Pedidos já filtrada
     por aquele vendedor.
F43 (Cockpit/Performance) — Procure um "vendedor" chamado "Enviado via API". PASS se ele NÃO entra
     mais nas somas de meta/realizado da equipe.
F44 (Ajuste de Preço) — Abra a tela. Esperado: segue sem sugestões porque falta o dado de "motivo de
     perda" (é adoção, não bug). PASS = confirma que a tela não trava/quebra; apenas não há sugestões.
```

---

## 18 · Registrar Atendimento — F29  [vendedor]

```
Abra o modal de ATENDIMENTO → aba Registrar (perfil vendedor).
F29 — Preencha e clique em "Registrar Atendimento". PASS se aparece uma confirmação de sucesso
(toast/mensagem) e/ou o modal fecha indicando conclusão. FAIL se "nada acontece" visualmente.
Se registrar algo definitivo for um problema, use dados de teste ou me pergunte antes. Reporte F29.
```

---

## 19 · Geral / UI — F34  [qualquer perfil]

```
Em qualquer tela com alternância de tema e de unidade (ex.: Dashboard/Metas):
F34 — Ative o tema ESCURO, troque kg/toneladas, e depois clique no tema CLARO.
PASS se cada clique troca o tema DIRETO (claro ↔ escuro), sem um estado intermediário que pareça
"travado" (exigindo clique extra). Reporte F34.
```

---

## Round 1 — reconfirmação rápida (não regrediram)

Os itens do Round 1 já foram testados nos blocos acima: **F1–F4** (bloco 2), **F6** (bloco 4),
**F8** (bloco 6), **F9** (bloco 11), **F10** (bloco 7), **F11** (bloco 12). Se algum falhar,
é regressão — marque no checklist.

---

## O que a extensão NÃO resolve (fica com você)

- **Confirmar no OMIE** que pedido/cliente realmente entraram (F38/F46/F49) — é escrita em produção e a verdade está no ERP, não na tela do CRM.
- **F27b** — a discrepância de ~600 mil kg depende do nosso relatório de referência; a extensão só coleta o número exibido.
- **Julgamentos de negócio** — se o valor de comissão calculado está correto, se a meta global bate, etc.
