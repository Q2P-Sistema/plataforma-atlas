# Itens acumulados para a PRÓXIMA devolutiva à OrbitIA

Enviar após a conclusão dos nossos testes em andamento (reenvio #16381,
conciliações 1 e 5, caso controlado 4a, dias úteis na virada do mês).

## 1. Triangular — CST do ICMS da remessa: criar com 50 + benefício fiscal SP054020

Na homologação de 03/09, a esteira de validação **aprovou os 4 PVs**
(19393–19396), mas nas duas pernas de remessa aplicou **auto-correção**:
trocou o CST do ICMS de **41 (isenta)** para **50 (suspensão)** e
preencheu `codigo_beneficio_fiscal = "SP054020"` no item.

Pedido à OrbitIA: o CRM deve criar a perna de remessa já com
**CST ICMS 50 + codigo_beneficio_fiscal "SP054020"** (em vez de 41),
para não depender da auto-correção da esteira. Os demais CSTs seguem
como estão (IPI 53, PIS 07, COFINS 07, tudo zerado) — foram aceitos
sem correção.

Texto sugerido para o resumo:

> Na homologação da triangular, a validação aprovou os quatro pedidos —
> as duas pernas de venda sem nenhuma correção, e as duas de remessa
> com uma auto-correção aplicada pela esteira: o CST do ICMS deve ser
> **50 (suspensão)**, com o campo `codigo_beneficio_fiscal` preenchido
> com **"SP054020"** no item (nós tínhamos passado CST 41). Ajustem a
> criação da remessa para já sair assim; o restante (IPI 53, PIS/COFINS
> 07, impostos zerados) está correto e não muda.

## 2. "Fluxo de Caixa" vira "Recebimentos Previstos" — SEM Pagar e SEM Saldo (ROAD BLOCK, decisão de 03/09)

Rodamos a conciliação nº 5 em 03/09, como combinado na definição D7: a
coluna "Pagar" soma **R$ 972.738,77** contra **R$ 3.860.152,60** de
títulos a pagar em aberto no OMIE (25% do devido) — datas pesadas somem
(16/09: R$ 554.973 → 0; 02/10: R$ 444.447 → 4.500) — e a coluna
"Saldo" tem três quebras que receber−pagar não explica (até −R$ 4,3M).

**Decisão (Flavio, 03/09), que substitui a D7 e simplifica a
correção:** as colunas **"Pagar" e "Saldo" são REMOVIDAS** das duas
telas (Cockpit do gestor e Carteira do vendedor), e a seção passa a se
chamar **"Recebimentos Previstos"** — fica somente a projeção de
recebimentos, que já foi validada contra o OMIE. Não é mais necessário
sincronizar contas a pagar. Isso muda o que estava no relatório de
30/08 ("manter a coluna Pagar", como melhoria pós-go-live): agora é
remoção, e **antes do go-live** — a coluna que ficaria exibe 25% do
valor real, pior que não existir.

Texto sugerido para o resumo:

> Rodamos a conciliação de contas a pagar, como combinado: a coluna
> "Pagar" mostra R$ 972.738,77 contra R$ 3.860.152,60 de títulos em
> aberto no OMIE, e a coluna "Saldo" tem quebras de até R$ 4,3M que
> receber−pagar não explica (detalhes no anexo). Decidimos simplificar:
> *removam as colunas "Pagar" e "Saldo"* das duas telas e renomeiem a
> seção para *"Recebimentos Previstos"* — fica só a projeção de
> recebimentos, que já está batendo com o OMIE. Isso substitui a
> resposta anterior da D7 (não é mais preciso sincronizar contas a
> pagar) e o que pedimos em 30/08 sobre manter a coluna Pagar. Como a
> coluna atual mostra um quarto do valor real, pedimos essa remoção
> ainda antes do go-live.

## 3. Conciliação nº 1 (faturamento) — divergência de R$ 188.998,12 TOTALMENTE explicada, com duas correções a pedir

7 de 11 vendedores batem ao centavo. A diferença (CRM sempre MAIOR que
o OMIE) tem duas causas, ambas confirmadas pedido a pedido:

**(a) Totalizadores agrupam pela data de CRIAÇÃO, não de faturamento —
item 4b incompleto.** O campo `data_faturamento` existe e está populado
(entrega do Round 9), mas o realizado do mês ainda fecha pela data de
criação do pedido. Evidência: 6 pedidos criados em agosto e faturados
em 01/09 somam R$ 119.872,24 / 10.200 kg no agosto do CRM (#16440,
#16438, #16439, #16435, #16437, #16436 — OMIE 19361/19347/19373/
19245/19260/19275). O desvio é de mão única (o CRM adianta receita,
nunca atrasa) e é estrutural: 180 dos 459 pedidos de agosto têm as
duas datas diferentes — na maioria cai no mesmo mês e não aparece.
Pedido: os totalizadores de faturamento devem usar `data_faturamento`.

**(b) Pedido com NF cancelada (sem reemissão) segue no realizado —
R$ 69.125,88.** #16126 (PROTOK, R$ 15.177,75) e #16275 (NS PLASTIC,
R$ 53.948,13, OMIE 19314): marcados "faturado" no CRM sem data de
faturamento e sem NF-e — conferimos no OMIE: as NFs foram CANCELADAS
(a do 19314 em 28/08; pedido cancelado no OMIE). Quando há reemissão o
tratamento funciona (caso Ana Camila verificado); o cancelamento sem
reemissão precisa tirar o pedido do realizado e refletir o status.

Com (a) e (b) corrigidos, a conciliação nº 1 fecha em zero por
vendedor — critério de aceite atingível.

## 3b. Campo "Empresa de Remessa" parou de buscar — TRIANGULAR INOPERANTE (road block, regressão)

Teste de 03/09 (pedido de gestão, Venda Triangular marcada): o campo
"Empresa de Remessa" **não dispara requisição nenhuma** ao digitar —
nem "ALFA", nem termos genéricos. Não é cadastro (a ALFA está ativa,
com IE, e `GET /api/clientes/?search=ALFA` responde na hora) nem
paginação. O campo de cliente, mesmo componente e placeholder, busca
normalmente; o de remessa não. "Enviar ao OMIE" fica desabilitado —
**nenhuma venda triangular pode ser lançada pela interface** desde
algum dos deploys recentes (em 31/08 o campo funcionava — os pedidos
#16366/#16367/#16381 foram criados por ele). Nada foi gravado no
teste. Consequência extra: a cota da API OMIE segue sem prova nova
(última evidência de envio: 01/09).

## 4. Tela de monitoramento do gestor — clientes 90+ dias sem compra, PRÉ-go-live (requisito novo, 03/09, versão final)

**A regra de ocultar da carteira NÃO volta** (versão final após
alinhamento Flavio×Rogério, 03/09 à noite) — o cliente permanece
sempre visível para o vendedor atribuído no cadastro. O que entra é
só uma tela de monitoramento:

1. **Tela do gestor** (só visualização): clientes sem compra há 90+
   dias — cliente, **vendedor atual do cadastro**, data da última
   compra, dias sem compra.
2. **Ação manual no OMIE**: o gestor troca o vendedor no cadastro do
   cliente; quando a sincronização refletir, o cliente some da
   carteira do vendedor A e aparece na do B — pelo fluxo normal de
   atribuição, sem lógica nova de carteira.
3. O cliente **sai da lista quando voltar a comprar**; sem qualquer
   lógica de prazo/reatribuição.

Para a OrbitIA é uma listagem com filtro — esforço mínimo. (A versão
completa — saída automática da carteira, reatribuição dentro do CRM
com write-back e relatório de contexto — fica para a fase 2, já
especificada internamente.)

## 5. Confirmar o expurgo dos pedidos #16368/#16381

O #16381 devolve 404 e a numeração pula — presumimos que foi a limpeza
por script que autorizamos. Pedir confirmação formal (e se o expurgo
cobriu também o #16368), para constar no registro do go-live.

## 6. Achados do teste de perdas/feedback de preço (04/09) — classificação pendente do Flavio

- **#44 (proposta: mandatório)** — Volume da perda: campo rotulado "(t)"
  grava o número cru como `volume_kg` (1 t → 1 kg gravado). Corrompe o
  histórico desde já (caso real: OROPLAST com volume_kg 1500 digitado
  como toneladas). Corrigir a conversão + avaliar saneamento do legado.
- ~~#45~~ **REFUTADO (04/09)** — a "troca de sessão" foi ação do
  próprio Flavio durante o teste, não comportamento do sistema. Errata
  enviada à OrbitIA junto do relatório (que a lista como defeito 03).
- **#46 (proposta: mandatório leve)** — Dispersão de Preços, KPI do
  topo: "PEAD-101 −111900.0%" contra 111,1% na tabela — sinal
  invertido e escala 1000× no card.
- **#43 (pacote, classificação a decidir)** — Feedback de preço do
  concorrente: campo existe mas (a) some com Motivo="Concorrência";
  (b) é stepper não digitável (15 cliques até R$ 8,00); (c) inicia em
  R$ 15,80 fixo sem relação com o produto; (d) não há campo de nome do
  concorrente (vendedores já escrevem preço em texto livre); (e) o
  valor gravado não chega a NENHUM agregado do gestor — nem à
  Dispersão de Preços, onde seria comparável à nossa faixa. O ciclo
  "vendedor registra → gestor analisa" não fecha.
- **Follow-up do item 3 (Recebimentos Previstos)** — a Carteira do
  vendedor ficou sem Pagar/Saldo (ok), mas manteve o nome "Fluxo de
  Caixa da Carteira" e janela de 90 dias; o renome valia para as duas
  telas.
- Menores: card de perdas com janelas diferentes ("2 no mês" × "15"),
  "Gap potencial" = gap da meta (já registrado em 30/08).
- Limpeza: atendimento #79 / perda #19 (ALFA). O pedido #16479 FICA —
  é o veículo do reenvio que valida o #42.

## 7. PRÓXIMA VERSÃO (melhoria) — Consulta de cliente existente: "já tem cadastro? quem atende?"

Requisito do Flavio (04/09), para a próxima rodada de melhorias:

Hoje, no OMIE, é possível consultar se um cliente já tem cadastro e se
já é atendido por algum vendedor. O CRM precisa oferecer essa mesma
consulta — antes de prospectar ou cadastrar, o usuário verifica se o
cliente (por nome/CNPJ) já existe na base e **qual vendedor o atende
hoje**.

Contexto que conversa com itens já registrados: o bloqueio de CNPJ
duplicado (Round 10) impede o cadastro em dobro, mas não responde "de
quem é este cliente" — a consulta evita conflito de carteira e
retrabalho antes mesmo da tentativa de cadastro. Relaciona-se também
com o cadastro leve de prospecto (roadmap) e com o dropdown que não
diferencia cadastros duplicados. Definir na especificação: quem pode
consultar (vendedor vê o dono da carteira de cliente que não é seu?)
e o que é exibido (só "existe + vendedor responsável" ou a ficha).

## 8. Achado #50 (11/09, mandatório) — pedido EXCLUÍDO no OMIE segue "Enviado ao OMIE" no CRM

Os PVs 19467/19468 (par do #16479) foram excluídos do OMIE há dias e o
#16479 continua "Enviado ao OMIE" no CRM, apontando para números que
não existem. A correção do Round 9 cobre pedido **cancelado** (muda de
etapa); a **exclusão** faz o pedido sumir da API — e a sincronização
não trata a consulta vazia como sinal. Como exclusão manual no OMIE é
prática corrente, o pedido "Enviado" com números mortos engana
vendedor e gestor. Pedido: quando a consulta do PV vinculado retornar
inexistente, refletir no CRM (ex.: status "Excluído no OMIE") + alerta
nos Logs, como já é feito para cancelamento unilateral da remessa.

## 9. Reteste REPROVADO (11/09) — reset da Empresa de Remessa ao trocar a origem

O Round 12 §2.1 declarou corrigido ("no mesmo commit do item 1"), mas
no reteste de 11/09 a Empresa de Remessa **continua sem ser limpa** ao
alternar a origem do pedido (Pedido da Gestão ↔ Em nome de um
Vendedor) — o Cliente Faturado é zerado, a remessa permanece. Repetir
a correção e indicar em qual tela/fluxo foi aplicada (pode ter saído
só em uma das duas).

## 10. Requisito #51 (11/09, mandatório) — pedido em alçada de Diretor deve aparecer para o gestor, desabilitado

Confirmamos que a alçada do Diretor funciona (pedido abaixo do mínimo
sobe para aprovação de Diretor). Mas o pedido **não aparece na tela do
gestor** — só na do Diretor. O gestor fica cego para um pedido da
própria equipe: não sabe que existe, não explica ao vendedor por que
está parado, e perde o sinal gerencial mais relevante (alguém
negociando abaixo do mínimo).

Pedido: o pedido aparece na fila do gestor com o nível exigido
("Aguardando aprovação do Diretor") e o botão de aprovar
**desabilitado** — visibilidade sem alçada. É o mesmo padrão que o
sistema já aplica no preço mínimo, onde o gestor vê o valor e não
edita.

## (adicionar aqui os próximos itens conforme surgirem)
