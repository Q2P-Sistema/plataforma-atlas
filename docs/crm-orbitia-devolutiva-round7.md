# Status consolidado para o go-live — CRM Q2P · Atualização de 31/08

**31/08/2026 · Devolutiva à OrbitIA**

---

## Contexto

Este documento atualiza o relatório consolidado de 30/08 cruzando três coisas: os dois
documentos de vocês de 31/08 (Status da Entrega e Resumo de Implementações), a rodada de
testes que rodamos hoje **depois do deploy** — incluindo as duas ações que vocês pediram —
e uma **mudança de requisito nossa que retira o item mais pesado da lista** e responde a
definição D4.

Ele substitui o relatório de 30/08 como referência única do que está em aberto. A estrutura:

1. O que está confirmado corrigido (validado por nós, acumulado).
2. Conciliações nº 3 e nº 4 — rodadas hoje, com o resultado — e o que resta revalidar.
3. A mudança de requisito: endereço de entrega sai, venda triangular entra.
4. Venda triangular — diagnóstico completo e especificação (novo road block).
5. Demais achados novos da rodada de 31/08.
6. Itens do relatório de 30/08 que seguem em aberto.
7. Definições e ações pendentes do nosso lado (D1–D8, LUBIAN).
8. Tabela consolidada final.

---

## 1. Confirmado corrigido (validado por nós — não precisa de ação)

Aos nove itens já confirmados no relatório de 30/08 (número do pedido nas telas, histórico
de aprovações, produtos no histórico do cliente, previsão de faturamento × entrega, regra
dos 90 dias, meta global em kg, edição em etapa 10, exclusão de não sincronizado, frete e
volumes obrigatórios), somam-se hoje:

### 1.1 Campo "Nº Pedido do Cliente" — encerrado ✅

Repetimos hoje, **após o deploy**, o teste controlado de duas pontas que vocês pediram:
pedido criado no CRM com o campo preenchido (`TESTE-PO-003`), aprovado, sincronizado — e o
texto chegou corretamente no pedido do OMIE, conferido lá dentro. **Item 1 do Bloco 1
encerrado.** Registramos também que a distinção que vocês passaram a fazer entre
"corrigido" e "em produção" resolve exatamente o que aconteceu no teste de 30/08.

### 1.2 Vínculo mantido na reaprovação de pedido editado ✅ (com ressalva na seção 5.1)

Editamos um pedido já sincronizado e reaprovamos: a alteração foi aplicada **no mesmo
pedido do OMIE** — o vínculo se manteve, que era o comportamento correto. A ressalva sobre
os itens somados está na seção 5.1.

---

## 2. Conciliações nº 3 e nº 4 — rodadas em 31/08, após o deploy

Vocês declararam **resolvido em produção** os itens 2 (reserva descontada duas vezes),
4a (pedido "Aprovado" contando como realizado) e 7 (dias úteis em fonte única no backend),
além das duas correções que vocês mesmos encontraram (cadastro com código falso e deploy
sobrescrevendo metas). Pelo nosso critério, só movemos um item para "confirmado" após teste
nosso — então aceitamos a sugestão de vocês e **rodamos hoje mesmo as conciliações nº 3 e
nº 4** contra o que está no ar (referência: espelho do OMIE de 31/08; leitura da API do CRM
na sessão do gestor, em modo somente leitura).

### 2.1 Conciliação nº 3 (posição de estoque) — passou sem nenhuma diferença ✅

- **Totais**: físico 3.120.912 kg · reservado 202.604 kg · disponível 2.918.308 kg —
  idênticos à referência do OMIE no cenário "com galpões INATIVO", que é o estado atual
  esperado enquanto a definição D1 não sai. Diferença zero, sem arredondamento.
- **Item 2 — reserva descontada duas vezes: confirmado corrigido.** Todos os **27 produtos
  com reserva > 0** exibem disponível = físico − reservado; nenhum caso do desconto dobrado;
  físico e reservado batem produto a produto com o OMIE (nenhum ausente, nenhum extra),
  incluindo os disponíveis negativos e os zerados; e `saldo_kg` = `disponivel_kg` nos 27.
  **Item encerrado do nosso lado.**

### 2.2 Conciliação nº 4 (contas a receber) — retrato registrado

- **Drill-down por vendedor: praticamente exato.** 02/09 e 18/09 batem **ao centavo** com o
  OMIE (67 títulos / R$ 1.137.987,08 e 59 títulos / R$ 1.079.804,69); 08/09 fica a
  +R$ 1.084,13, com 51 títulos contra 50 — diferença compatível com horário de
  sincronização.
- **Coluna agregada "Receber": segue divergente, como vocês mesmos mapearam** (a correção
  depende de D2/D7). No período comparável (01 a 29/09): referência R$ 18.180.843,81 ×
  observado R$ 26.690.650,90 — **+R$ 8.509.807,09**. Três datas batem ao centavo (01, 09 e
  16/09); 22 divergem.
- **Dois padrões observados que podem ajudar na correção** (fatos, sem hipótese de causa):
  (a) datas não úteis vêm zeradas na coluna — 05, 06, 07, 13 e 26/09 têm títulos no OMIE e
  R$ 0,00 no CRM; (b) quase toda a diferença concentra-se em duas datas — 10/09
  (+R$ 4.495.594,86) e 20/09 (+R$ 4.245.460,67, um domingo sem nenhum título no OMIE).
  Excluindo apenas essas duas, o restante do mês fecha em ≈ −R$ 231 mil.
- **Limite de escopo**: a API devolve janela fixa de 30 dias (31/08 a 29/09), então 30/09
  não foi conferido — limite de janela, não divergência. Registramos também que a projeção
  diária não traz contagem de títulos (só o drill-down traz), o que limita a conferência de
  quantidade.

### 2.3 O que ainda vamos revalidar

- **Item 4a** ("Aprovado" no realizado): com um caso controlado (pedido aprovado não
  faturado × acumulado).
- **Item 7** (dias úteis): nas três telas na virada do mês — o cenário que expôs o problema.

Sobre as duas correções proativas: registramos o achado do código provisório positivo
(explica quatro dos sete erros de agosto) e o do deploy × metas — a resposta sobre o
reenvio do LUBIAN está na seção 7.

---

## 3. Mudança de requisito: endereço de entrega sai da lista

Definimos internamente a regra de negócio: **toda entrega em endereço diferente do
endereço cadastral do cliente será sempre uma venda triangular** — o destino da mercadoria
é a empresa de remessa, que já possui endereço próprio no cadastro.

Com isso:

- O campo de **endereço de entrega no pedido deixa de ser requisito** do CRM. Era o item 8
  do Bloco 1 — o que vocês apontaram como candidato natural a sair da primeira versão, pela
  dependência externa da estrutura no OMIE. A avaliação de vocês estava correta e a solução
  veio pelo lado do processo.
- A **definição D4 fica respondida**: não haverá bloco de endereço de entrega no envio.
- A contrapartida: a **venda triangular passa a ser indispensável** para a primeira versão —
  é o único caminho para entregas fora do endereço cadastral. E hoje ela não funciona,
  conforme a seção seguinte.

---

## 4. Venda triangular — diagnóstico completo (novo road block)

### 4.1 O que observamos

Fizemos um teste controlado hoje — pedido **#16381**, cliente BLOWTEC (faturado), empresa
de remessa ALFA, 1 kg × R$ 0,01, CFOP 5.102 — e revisamos todos os pedidos dos últimos
3 meses:

- **Nenhuma venda triangular criada pelo CRM sincronizou com o OMIE.** As 3 tentativas
  registradas falharam (#16366, #16367 e #16381 — todas triangulares), e nenhum dos 9
  pedidos que sincronizaram com sucesso era triangular. (Ressalva de escopo: os ~1.000
  pedidos "Faturado" importados do OMIE pela sincronização não entraram nessa varredura.)
- O erro devolvido pelo OMIE segue sempre o mesmo padrão. No nosso teste:

```
Falha ao sincronizar com o OMIE: ERROR: Pedido já cadastrado para o
Código de Integração [16381], Código [8498018926] e Número [19363] !
```

### 4.2 O que o erro indica

As duas pernas da operação (remessa e faturamento) são enviadas ao OMIE com o **mesmo
código de integração** (o id do pedido no CRM). A primeira chamada cria o pedido no OMIE; a
segunda é rejeitada como duplicata — cada pedido de venda no OMIE exige código de
integração próprio.

Consequências práticas observadas:

1. A operação termina com **uma perna criada no OMIE e a outra não**.
2. O CRM marca "Falha OMIE" com a **coluna OMIE vazia** — o pedido 19363 existia no OMIE,
   mas não aparecia no CRM.
3. O botão **"Reenviar" nunca funcionará** nesses casos: o código continua duplicado.
4. Um registro no CRM corresponde a **dois pedidos no OMIE** — o registro precisa guardar
   os dois números.

### 4.3 Como a perna criada nasceu no OMIE

Verificamos o pedido 19363 dentro do OMIE: nasceu com o **CFOP digitado no formulário
(5.102)**. Pela regra fiscal da operação, o CFOP do formulário vale para a perna de
**faturamento**; a perna de **remessa** deve sair com regras próprias, aplicadas pelo
sistema — não escolhidas pelo vendedor.

### 4.4 Especificação da perna de remessa

Estas regras vêm da esteira de validação que já processa hoje os pedidos criados
manualmente no OMIE — é o "documento de referência" que faltou no caso do endereço de
entrega, e aqui ele existe:

| Regra | Valor |
|---|---|
| CFOP de todos os itens | **5.924** |
| "Não gerar financeiro" | **S** em todos os itens |
| Impostos dos itens | **Zerados** — alíquota, **base e valor** (se base ou valor ficarem preenchidos, o OMIE recalcula o imposto) |
| CSTs | ICMS **41** · IPI **53** · PIS **07** · COFINS **07** |
| Composição | Um pedido nunca mistura itens de remessa com itens normais |

A perna de **faturamento** gera o financeiro e os impostos usuais, mas **não movimenta
estoque**: itens com `nao_movimentar_estoque = "S"` — o estoque físico sai pela remessa.
Sem essa flag, o estoque baixa duas vezes. (No par real 19211/19212, analisado em 01/09, a
perna de venda saiu com CFOP **5.123** — venda à ordem — não com o CFOP genérico do
formulário; e é a flag, não o CFOP, que identifica cada perna.)

**Formato combinado para o código de integração** (complemento de 01/09): `TRI-<idPar>-V`
na perna de venda e `TRI-<idPar>-R` na de remessa — mantém a unicidade exigida pelo OMIE,
pareia as pernas pelo mesmo `<idPar>` e torna a contraparte derivável.

Se o CRM criar as duas pernas com essas marcações e códigos de integração próprios, a
esteira existente (análise de crédito, validação fiscal) funciona **sem nenhuma mudança**.

### 4.5 Observações fiscais da NF nas duas pernas — requisito novo

Cada perna da triangular precisa sair com um **texto padrão no campo de observações da NF**
(dados adicionais do pedido de venda) — exigência da operação fiscal. São dois modelos, um
por perna, e o bloco com os dados da empresa deve ser **preenchido automaticamente com o
cadastro do cliente do PV par** (cada perna cita a empresa da outra, cruzado — confirmado
no par real 19211/19212: a venda ao cliente RWM cita a SOMMAPLAST, cliente da remessa, e
vice-versa), com razão social, endereço, CEP, município/UF, CNPJ e IE, sem digitação
manual.

**Pedido de VENDA (faturamento):**

> Mercadoria recebida para fins de industrialização, entregue na empresa {RAZÃO SOCIAL},
> endereço: {LOGRADOURO, Nº}, CEP {CEP}, município: {CIDADE}, UF: {UF}, CNPJ: {CNPJ},
> IE: {IE}, com nossa NF nº ______, série ____, data: __/__/____, na operação de Remessa
> por Ordem de Terceiros.
> (*) Emitida nos termos do art. 129, § 2º, em conjunto com o art. 406 do Decreto
> nº 45.490/00 (RICMS/SP), e do art. 415, inciso I, do RIPI/2002.

**Pedido de REMESSA** (redação corrigida em 01/09 — na remessa a mercadoria é entregue no
próprio destinatário do PV; a empresa citada é a faturada, por conta e ordem de quem a
remessa acontece):

> Mercadoria enviada para fins de industrialização **por conta e ordem da empresa**
> {RAZÃO SOCIAL}, endereço: {LOGRADOURO, Nº}, CEP {CEP}, município: {CIDADE}, UF: {UF},
> CNPJ: {CNPJ}, IE: {IE}, conforme nossa NF nº ______, série ____, data: __/__/____, na
> operação de Remessa por Ordem de Terceiros. — com o mesmo fecho legal.

O trecho "com nossa NF nº ______, série ____, data __/__/____" referencia a NF da outra
perna da operação, que só existe após a emissão — ele deve sair **em branco, exatamente
como no modelo**, para preenchimento manual pela nossa equipe após o faturamento. Não
automatizar essa parte.

### 4.6 Tela de Aprovações não identifica pedido triangular

Para o gestor que aprova, o pedido triangular aparece idêntico a um pedido comum — não há
indicação de que é triangular nem de quais empresas estão envolvidas (faturado × remessa).
O gestor precisa dessas duas informações para decidir a aprovação.

---

## 5. Demais achados novos da rodada de 31/08

### 5.1 Edição de sincronizado: itens somados em vez de substituídos — road block

No teste da seção 1.2 (1 kg → 2 kg), a reaprovação alterou o pedido certo no OMIE, mas ele
ficou com **as duas linhas do produto** (a de 1 kg e a de 2 kg) em vez de apenas a nova. Uma
edição de quantidade termina com o dobro de itens no pedido.

### 5.2 Editar/excluir: consulta da etapa ao vivo no OMIE — road block

A exclusão do pedido sincronizado foi bloqueada com a mensagem de que não foi possível
consultar a etapa (etapa "None") — o bloqueio de segurança funcionou, mas travou também o
caso legítimo. Sugestão de comportamento: antes de editar ou excluir, fazer uma **consulta
rápida ao OMIE** para ler a etapa real do pedido naquele momento — etapa 10 permite,
qualquer outra bloqueia. A etapa guardada no banco fica desatualizada e não serve para essa
decisão. (Converge com o mapeamento dinâmico de etapas combinado na reunião de 26/08, que
está no Bloco 2 — este caso é o pedaço dele que se tornou bloqueante.)

### 5.3 Tela "Logs de Erro" não recebe as falhas de envio ao OMIE — melhoria

A falha do pedido #16381 ocorreu e **não gerou registro na tela de Logs de Erro** — filtro
"OMIE — Pedido" e também "Todos": nenhum registro de 31/08. O erro só existe como tooltip
na tabela de pedidos. Converge com o que vocês encontraram na fila de envio (falha capturada
e respondida como sucesso, erro guardado só no registro do pedido) — vale garantir que a
correção em desenvolvimento alimente também essa tela. Adicionalmente, o **filtro de
período aparenta não funcionar**: com "Hoje" selecionado, continuam sendo exibidos
registros de 30/08 e 28/08.

### 5.4 Pedidos de teste — situação

No **OMIE**, já excluímos os dois pedidos gerados pelos testes (19357 e 19363). No **CRM**,
os pedidos **#16368** e **#16381** ficaram presos — a exclusão está bloqueada pelo item
5.2. Podem removê-los diretamente no banco.

---

## 6. Itens do relatório de 30/08 que seguem em aberto

Conforme o quadro de vocês, sem divergência da nossa parte:

| Item | Situação declarada por vocês | Nossa leitura |
|---|---|---|
| 3 · Galpões desativados na conta | Depende de D1; exclusão por código no curto prazo | De acordo com a solução em duas etapas (códigos agora, indicador próprio depois). D1 na seção 7 |
| 4b · Data de agrupamento do faturamento | Em desenvolvimento — campo novo | De acordo — é o que fecha a conciliação nº 1 |
| 5 · Coluna "Receber" inflada | Depende de D2 e D7 | Conciliação nº 4 rodada (seção 2.2): drill-down a R$ 1.084 do OMIE, coluna agregada +R$ 8,5M no mês, com dois padrões novos anotados. A correção proposta (apontar a coluna para os títulos, mesma fonte do drill-down) resolve |
| 6 · Fila de envio sem retry | Em desenvolvimento (histórico de tentativas, retry, alarme) | De acordo — o alarme de pendências é, como vocês disseram, a parte mais crítica |
| 9 · Clientes reais ocultos na carteira | Em desenvolvimento — tag Cliente decisiva | De acordo com a regra (recupera 69 de 74 cadastros, 99,7% dos pedidos). D8 na seção 7 |
| Bloco 2 · Melhorias | Após o go-live | De acordo, com um adendo: incluir a seção 5.3 (Logs de Erro) e registrar que o item 5.2 saiu do Bloco 2 e virou road block |

Sobre o local **SANTO ANDRÉ (NACIONAL)** com físico negativo que vocês apontaram:
**conferimos na origem — o negativo vem do próprio OMIE**, na posição do dia (31/08), e o
quadro é maior que o caso citado: 6 produtos com físico negativo nos locais SANTO ANDRÉ
(NACIONAL e IMPORTADO), somando −166.800 kg — o maior é PP PRETO Q35, com −86.925 kg. É
questão de dado operacional do nosso lado (movimentações a acertar no OMIE), que vamos
tratar internamente — **nenhuma ação do CRM é necessária**; ele apenas reflete a origem.
Obrigado pelo apontamento.

---

## 7. Definições e ações pendentes do nosso lado

| # | Pergunta de vocês | Status |
|---|---|---|
| D1 | TROCA e TRÂNSITO saem do cálculo de disponível? | **Em definição interna** — retornamos em breve |
| D2 | Reconferir os R$ 5,29M da coluna "Receber" | **Reconferido hoje (31/08):** a tabela legada segue divergente — em 08/09 exibe R$ 1.668.836 contra R$ 1.020.729 nos títulos a receber. Os valores mudam a cada sincronização, mas a incoerência permanece — o que reforça a correção de vocês: apontar a coluna para os títulos |
| D3 | Feriados: nacionais ou também estaduais/municipais? | **Em definição interna** |
| D4 | Estrutura do endereço de entrega no envio | **Respondida — seção 3:** o campo sai dos requisitos; entrega em endereço diverso será sempre venda triangular |
| D5 | Meta oficial: Global ou soma das individuais? | **Em definição interna** (envolve a diretoria) |
| D6 | Comissão/remuneração só sobre faturados? | **Em definição interna** (envolve o gestor comercial) |
| D7 | Coluna "Pagar": fonte atual ou sincronizar contas a pagar? | **Em definição interna** |
| D8 | Os 5 cadastros só-Fornecedor com venda recebem tag Cliente? | **Vamos verificar os 5 casos no OMIE** e retornamos; de acordo em não automatizar o "tem histórico" |
| Ação | Autorizar reenvio do cadastro LUBIAN (escrita real no OMIE) | **Autorizado** — podem executar o reenvio pela Carteira. Avisem quando concluído, que conferimos o cadastro no OMIE |
| Ação | Repetir o teste do PO | **Feita — seção 1.1, item encerrado** |

---

## 8. Tabela consolidada — todos os itens para o go-live

| # | Item | Status | Classificação |
|---|---|---|---|
| 1 | Nº Pedido do Cliente | **Encerrado** — validado por nós em 31/08 | — |
| 2 | Reserva descontada duas vezes | **Encerrado** — revalidado por nós na conciliação nº 3 (31/08) | — |
| 3 | Galpões desativados na conta | Aguarda D1 + exclusão por código | Road block |
| 4a | "Aprovado" contando como realizado | Resolvido em produção (vocês) — **revalidamos com caso controlado** | Road block |
| 4b | Data de agrupamento do faturamento | Em desenvolvimento | Road block |
| 5 | Coluna "Receber" inflada | Conciliação nº 4 rodada — segue divergente (+R$ 8,5M no mês); correção definida (fonte dos títulos) | Road block |
| 6 | Fila de envio: retry + alarme | Em desenvolvimento | Road block |
| 7 | Dias úteis em fonte única | Resolvido em produção (vocês) — **revalidamos na virada do mês** | Road block |
| 8 | Endereço de entrega | **Retirado dos requisitos** (seção 3) | — |
| 9 | Clientes reais ocultos na carteira | Em desenvolvimento (tag Cliente) | Road block |
| 10 | Triangular: código de integração próprio por perna (formato `TRI-<idPar>-V/-R`) + gravar os dois números OMIE | **Novo** — seção 4 | **Road block** |
| 11 | Triangular: regras da perna de remessa aplicadas pelo sistema | **Novo** — seção 4.4 | **Road block** |
| 12 | Aprovações: identificar pedido triangular e empresas | **Novo** — seção 4.6 | **Road block** |
| 13 | Edição de sincronizado: itens substituídos, não somados | **Novo** — seção 5.1 | **Road block** |
| 14 | Editar/excluir: consulta da etapa ao vivo no OMIE | **Novo** — seção 5.2 | **Road block** |
| 15 | Logs de Erro: receber falhas de envio + filtro de período | **Novo** — seção 5.3 | Melhoria |
| 16 | Triangular: textos de observação da NF nas duas pernas, com dados da empresa preenchidos automaticamente | **Novo** — seção 4.5 | **Road block** |
| — | Bloco 2 (melhorias de 30/08) | Após o go-live, sem mudança | Melhoria |

**Sequência**: a ordem proposta por vocês na §6 continua fazendo sentido para nós, com a
venda triangular entrando no lugar do endereço de entrega (e com urgência equivalente à do
item 9, pelo mesmo motivo: impede uma operação real de acontecer). As conciliações nº 3 e 4
já foram rodadas hoje, como sugerido (seção 2) — repetiremos a nº 4 depois que a coluna
"Receber" for apontada para a fonte dos títulos.

Qualquer dúvida sobre metodologia — como cada número foi recalculado, como os testes foram
isolados —, é só chamar.
