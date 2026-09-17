# Status consolidado para o go-live — CRM Q2P

**30/08/2026 · Relatório de devolutiva à OrbitIA**

---

## Contexto

Este documento consolida tudo que temos em aberto para a primeira versão do CRM em produção.
Reúne duas frentes: as pendências da fase de uso real (vendedores e gestor comercial usando o
sistema desde 22/07) e uma validação do módulo Gestor (12 telas).

**Método.** Os números exibidos nas telas foram recalculados de forma independente e cruzados
com as respostas das APIs internas. Onde foi possível, também conferimos contra os dados do
próprio OMIE. Alguns pontos foram testados com experimento controlado — criando o mesmo
pedido duas vezes, variando um único campo.

**Nota importante:** antes deste envio, revalidamos os pontos que reportamos anteriormente e
que vocês deram como corrigidos. **Oito itens foram confirmados resolvidos** — estão na tabela
abaixo, e o restante do documento traz apenas o que ainda está de pé em 30/08.

**Prazo:** nosso objetivo é a primeira versão em produção no início da próxima semana. Por
isso, os itens estão separados em dois blocos:

- **Bloco 1 — Road block:** precisa estar corrigido antes de produção.
- **Bloco 2 — Melhorias:** importantes, mas não impedem o go-live.

---

## O que confirmamos corrigido (não precisa de ação)

Revalidado em 29–30/08, com o resultado observado:

| Item | Como confirmamos |
|---|---|
| Número do pedido nas telas | "Meus Pedidos" e aba Histórico do cliente mostram o número curto; varredura em 6 telas não achou nenhum código de 10 dígitos |
| Histórico de aprovações | Populado, 5 registros — todos os que existem na base |
| Produtos no histórico do cliente | Cada pedido lista todos os produtos; verificado com pedidos de 1, 2 e 3 itens |
| Previsão de Faturamento × Entrega | Round-trip fechado: as duas datas chegaram corretas e distintas no OMIE (09/09 e 06/09) |
| Regra dos 90 dias na carteira | Removida — clientes com 1.600+ dias sem compra aparecem normalmente |
| Meta Global de volume (kg) | Campo criado; o Cockpit está coerente com a meta configurada (54,4% batendo exato) |
| Edição em etapa 10 / bloqueio em faturado | Edição livre no pedido em aberto; pedido faturado bloqueia com mensagem clara |
| Exclusão de pedido não sincronizado | Exercida na prática: pedidos de teste presos na fila e um pedido lançado com produto errado foram excluídos pelo gestor em 29–30/08 |
| Modalidade de Frete e Espécie de Volumes | Obrigatórios, com bloqueio efetivo do envio |

---

## Bloco 1 — Road block (necessário para o go-live)

### 1. Campo "Nº Pedido do Cliente" quebra a sincronização do pedido inteiro

**Reproduzido hoje (30/08), com teste controlado de duas pontas.** Criamos o mesmo pedido
duas vezes — mesmo cliente real, mesmo produto, mesmo valor, mesmas datas — variando apenas o
campo "Nº Pedido do Cliente":

| Teste | Nº Pedido do Cliente | Resultado |
|---|---|---|
| Pedido #16284 | preenchido | **falhou na sincronização** |
| Teste de controle | vazio | **sincronizou, pedido criado no OMIE** |

Erro retornado pela API do OMIE, gravado no pedido:

```
ERROR: Tag [NUMERO_PEDIDO] não faz parte da estrutura do tipo complexo [informacoes_adicionais]!
```

Como a única variável foi o campo PO, a causa está isolada: é o mapeamento dessa tag no
payload, sem nenhum fator concorrente (cliente, produto, alçada ou datas).

**Por que é road block:** o campo foi criado justamente porque a equipe comercial precisa
dele. Do jeito que está, qualquer pedido que o use morre na integração — e o vendedor só
descobre depois da aprovação.

**Pedido:** corrigir o nome da tag enviada em `informacoes_adicionais`.

### 2. Reserva de estoque descontada duas vezes no cálculo de "Disponível"

Verificado em 30/08: dos **26 produtos com Reservado maior que zero, os 26 estão errados** —
nenhum acerta. A relação `disponivel = fisico − 2 × reservado` vale em 100% dos casos:

| Produto | Físico | Reservado | Disponível exibido | Correto |
|---|---|---|---|---|
| PEAD-101 EM5333AAH | 619.325 | 6.000 | 607.325 | 613.325 |
| PEAD-123 H5604F | 14.275 | 11.000 | −7.725 | 3.275 |
| PEAD-013 E924 | 27.500 | 27.500 | −27.500 | 0 |
| PEBD-012 FD0274 | 82.300 | 750 | 80.800 | 81.550 |

Confirmamos também pelo lado do OMIE: o campo `nsaldo` de lá segue exatamente
`fisico − reservado`, e sua soma dá 2.849.911 kg — precisamente o valor que calculamos como
disponível correto.

**O que simplifica a correção:** o payload da API do CRM **já traz o campo `saldo_kg` com o
valor certo** (para o PEAD-101, `saldo_kg = 613.325`). O número correto já está na resposta;
apenas o `disponivel_kg` faz a subtração dobrada.

**Por que é road block:** desde o primeiro dia, o vendedor vê menos estoque do que existe —
242.501 kg escondidos no agregado. Em produtos onde físico = reservado, o disponível aparece
como negativo do reservado, e a família chega a ser marcada como "Estoque CRÍTICO" tendo
material disponível.

### 3. Estoque de galpões desativados entra na conta

Os totais que o CRM exibe — físico 3.092.412 kg, reservado 242.501 kg — batem exatamente com
a soma do OMIE **incluindo os galpões marcados como "INATIVO"**:

| Cenário (dados do OMIE) | Físico | Reservado |
|---|---|---|
| Todos os locais | **3.092.412** | **242.501** |
| Excluindo locais "INATIVO" | 2.983.802 | 162.126 |

São **108.610 kg de estoque físico e 80.375 kg de reservado** vindos de galpões desativados
(INATIVO 01 e INATIVO 03, cujas posições estão congeladas desde nov/2024–jan/2025), contados
como se fossem vendáveis.

Isso também explica saldos negativos que apareciam sem justificativa: PP H 70 (−13.750 kg) e
PS AI A (−13.500 kg), por exemplo, estão os dois dentro do INATIVO 01.

**Pedido:** excluir da agregação os locais de estoque desativados.

### 4. Pedidos com status "Aprovado" contam como venda realizada

Confirmado por experimento: excluir um pedido aprovado — nunca faturado, nunca enviado ao
OMIE — reduziu o volume e a receita "realizada" do vendedor na exata proporção do pedido.

**Requisito do cliente:** o acumulado de receita e volume, por vendedor e da equipe, deve
considerar somente pedidos com status **Faturado**.

**Por que é road block:** os números de faturamento ficariam errados desde o primeiro dia,
comprometendo a confiança no sistema logo na largada.

### 5. Coluna "Receber" do fluxo de caixa exibe valor inflado

Comparando com os títulos a receber do próprio OMIE (status "A vencer") nas datas onde
detectamos divergência:

| Data | OMIE (real) | CRM · coluna "Receber" | CRM · drill-down por vendedor |
|---|---|---|---|
| 02/09 | R$ 1.137.987 (67 títulos) | R$ 1.277.361 | R$ 1.138.000 |
| 08/09 | R$ 1.006.364 (49 títulos) | **R$ 5.295.556** | R$ 1.005.000 |
| 18/09 | R$ 1.079.805 (59 títulos) | **R$ 5.296.836** | R$ 1.080.000 |

**O drill-down por vendedor da própria tela bate com o OMIE** — o dado correto já está no
sistema; o erro está na agregação da coluna. Nos dois dias afetados o valor exibido é cerca
de cinco vezes o real, o que faz o card de total superestimar a entrada de caixa em ~41%.

Testamos e descartamos a hipótese de soma das duas empresas: a base ACXE tem R$ 369.772 em
18/09 e nada em 08/09 — longe do excesso de ~R$ 4,2M. O mecanismo exato fica para vocês
investigarem; o que trazemos é o valor correto e a evidência de onde ele já existe.

### 6. Fila de envio CRM→OMIE não reprocessa pendências

**Nota de correção:** uma leitura inicial nossa concluiu que o worker de envio estava parado
há 7 dias. Essa conclusão foi revista e **não se sustenta** — o fluxo normal de vendas entra
pelo OMIE e é importado pelo CRM; o canal de envio serve apenas aos pedidos criados dentro do
CRM, e não há evidência de serviço parado.

O que de fato identificamos: pedidos aprovados que falham ou nunca chegam a tentar o envio
ficam parados indefinidamente, sem retry — havia pendências de meses anteriores, algumas sem
nenhuma tentativa registrada. Um reenvio manual disparado por nós retornou sucesso (HTTP 200)
mas não gerou nenhum efeito observável em ~15 minutos: sem envio, sem novo erro, sem log.

**Por que é road block:** um pedido real pode ficar parado sem ninguém perceber — já
aconteceu com um pedido de R$ 12,6 mil, parado 15 dias.

**Pedido:** confirmar por que o reenvio manual não processa e por que pendências não sofrem
retry automático.

### 7. Contagem de dias úteis restantes diverge entre três telas

Em 30/08 (domingo, restando apenas a segunda-feira 31/08):

| Tela | Dias úteis restantes |
|---|---|
| Cockpit do Gestor | 0 |
| Análises | 1 (correto) |
| Dashboard do Vendedor | 2 (observado na sessão da vendedora, na mesma manhã) |

**Causa aparente** (por inspeção do código do front-end — a confirmar por vocês): cada tela
calcula por conta própria no navegador, com data-base diferente — o Cockpit parte do mês
selecionado, enquanto Análises e Dashboard partem da data de hoje. Não encontramos um campo
de dias úteis vindo da API, então parecem ser três implementações independentes.

Duas consequências: no Cockpit, os indicadores "necessário/dia" e "ritmo necessário" caem
para +R$ 0 e +0 kg/dia por divisão por zero, mesmo havendo gap real de milhões — e o texto de
alerta fica sem sentido. E, como cada tela projeta o fechamento do mês com seu próprio
divisor, o mesmo vendedor tem projeções diferentes conforme quem consulta.

**Por que é road block:** é um dos números mais visíveis do sistema, no topo da tela principal
do gestor.

**Pedido:** unificar a contagem (idealmente calculando no backend, uma vez) e proteger a
divisão para não exibir "+R$ 0" quando há gap em aberto. Vale verificar também o tratamento
de feriados, que não conseguimos avaliar.

### 8. Endereço de entrega no pedido

O campo não existe hoje na tela de Pedido de Venda — nem como opcional. Precisamos dele para
o go-live, já que a entrega nem sempre vai para o endereço de cadastro do cliente.

**Ressalva de escopo:** temos consciência de que este é o item mais pesado da lista — é
criação de campo novo e mapeamento para o OMIE, não apenas tornar obrigatório algo existente.
Se o prazo apertar, é o ponto onde faz mais sentido conversarmos sobre alternativas.

---

## Bloco 2 — Melhorias (não bloqueiam o go-live)

**Coluna de estoque Físico não existe.** A tela Disponibilidade mostra Reservado e Disponível,
sem o Físico — o que torna impossível conferir a conta pela própria tela. Notamos que foi
adicionada uma coluna "Saldo", mas ela repete o valor do Disponível em vez de mostrar o
`saldo_kg` correto que a API já fornece.

**Data da posição de estoque não é exibida.** A tela se apresenta como "dados em tempo real"
mas não mostra a data da posição. Conferimos no OMIE: os galpões ativos estão com posição do
próprio dia (30/08), então o estoque em si não está defasado — e registramos que uma suspeita
anterior nossa, de que a maioria das posições estaria desatualizada, foi verificada e
descartada nesse nível. **Uma ressalva que sobrou:** o campo `data_posicao` que a API do CRM
devolve traz datas de 2024 até para produtos com estoque atual em galpões ativos — a data
parece vir de um registro antigo, não da posição vigente. Ao exibir a data na tela, vale
corrigir também a origem desse campo.

**Mapeamento dinâmico das etapas do OMIE.** Ficou combinado na reunião de 26/08 usar a API de
etapas do OMIE, para o CRM saber a etapa real do pedido. Hoje o CRM não expõe essa informação
— o gestor só descobre que o pedido avançou ao tentar salvar e receber o erro. O
comportamento de segurança funciona (não deixa editar pedido faturado), por isso não é
bloqueante, mas o combinado não foi implementado.

**Tela "Editar Metas" (Análises) não salva.** O botão dispara `PUT /api/metas/{id}/` e recebe
HTTP 400, sem exibir erro na interface — a linha aparenta salvar e o valor volta ao original
ao recarregar. A mesma operação por Configurações → Metas funciona (`PATCH`, HTTP 200), o que
usamos como contorno. Pedido: corrigir o verbo e, principalmente, exibir erro quando a
gravação falhar.

**Duas telas de manutenção de metas com somas divergentes.** Análises e Configurações mantêm
metas em paralelo e podem divergir, inclusive por contas de sistema (usadas para integração
via API) recebendo meta de venda como se fossem vendedores. Pedido: consolidar numa única
tela.

**Percentual de meta com base inconsistente.** Os cartões de Performance mostram meta e
realizado em kg, mas o percentual vem do faturamento em R$ — e a API já devolve o campo
correto (`pct_volume`, ao lado de `pct_meta`). Pior: telas diferentes escolhem bases
diferentes sob o mesmo rótulo "% da meta" (o ranking do vendedor usa volume, a Performance do
gestor usa R$), então o mesmo vendedor aparece com dois desempenhos conforme a tela.

**"Gap potencial" das perdas usa a variável errada.** O Cockpit exibe um valor idêntico ao gap
da meta da equipe, não ao valor das perdas. Em Análises o mesmo bloco mostra unidade errada
(t em vez de kg) e contagem diferente da do Cockpit.

**Dashboard e Carteira do vendedor contam clientes por critérios diferentes.** O dashboard
reporta 190 clientes e a Carteira lista 171 — a diferença é consistente, mas não conseguimos
determinar qual critério o dashboard aplica a mais (detalhes na seção "Ponto em aberto", no
fim do documento).

**Desativar conta não remove o vendedor dos painéis.** Desativamos duas contas em 29/08 e
ambas continuaram listadas no ranking de Performance e na edição de metas. O comportamento
sugere que os painéis leem o cadastro de vendedores sincronizado, e não o status da conta —
fica para vocês confirmarem a implementação. **Requisito do cliente:** vendedores com conta
inativa não devem aparecer em nenhum relatório ou painel do gestor.

**Aprovador não é gravado nas recusas.** No histórico de aprovações, a coluna Aprovador vem
vazia nos registros recusados e preenchida nos aprovados — não fica registrado quem recusou.
É uma lacuna de auditoria.

**Coluna "Detalhe" do histórico de aprovações não mostra o produto**, embora a API já devolva
os itens do pedido.

**Volume sem formatação no histórico do cliente** — sai como "1000.0000kg" em vez de
"1.000 kg", destoando do resto do sistema.

**Wizard do vendedor: banner e botão discordam no passo 1.** O banner cobre campos que só
existem no passo 2, e o botão "Avançar" habilita mesmo com o banner ainda listando
pendências. O bloqueio real acontece corretamente no passo 2, mas o texto confunde.

**Dropdown de cliente não diferencia cadastros duplicados.** Quando há mais de um cadastro com
o mesmo nome, as opções aparecem idênticas — sem CNPJ, código ou tooltip. Pedido: exibir um
identificador junto do nome.

**Sincronização não sinaliza clientes cujo cadastro deixou de existir no OMIE.** Cadastros
apontando para códigos que não existem mais continuam ativos e selecionáveis, e qualquer
pedido para eles falha na sincronização sem aviso prévio ao vendedor.

**Instabilidade recorrente de conexão com o banco** entre 20 e 28/08 (timeouts, falha de DNS,
conexões encerradas), com vários dos eventos de madrugada. O painel mostra "0 erros na última
hora", o que esconde o padrão recorrente — sugerimos um indicador de 24h/7 dias.

**Vendedor duplicado no cadastro.** O mesmo vendedor existe com dois registros — um de origem
OMIE, outro manual — e o log do sync registra uma violação de chave única de `usuario_id` na
véspera da criação do duplicado. A relação exata entre os dois eventos fica para vocês
confirmarem.

**Seções de "Fluxo de Caixa" — renomear e reestruturar.** Requisito do cliente, para quando
entrar em desenvolvimento:

1. Renomear para **"Recebimentos Previstos"** nas duas telas (Cockpit e Carteira do vendedor).
2. No Cockpit: manter a coluna "Pagar"; drill-down apenas por data → cliente, sem o nível
   intermediário de vendedor; consolidar títulos do mesmo cliente numa única linha (hoje o
   mesmo cliente aparece em linhas separadas no mesmo dia); incluir busca por cliente.
3. Na Carteira do vendedor: mover para aba própria, **exibir o nome do cliente em cada linha**
   (hoje o endpoint não devolve essa informação — exige mudança de backend) e incluir busca.
   Corrigir também o rótulo do período: diz "Próximos 90 dias" mas a lista inclui títulos
   vencidos há até ~10 meses, e o cabeçalho mostra "A receber" e "Vencido" como se fossem
   valores separados, quando o vencido já está incluído no a receber.

Pendência à parte: a série de saldo acumulado do Cockpit começa em um valor negativo sem
explicação de origem na tela.

**Cockpit e Dashboard do Vendedor — reorganizar em abas.** Hoje o Cockpit empilha 7 blocos de
natureza diferente numa página só, sem hierarquia de leitura; o Dashboard do Vendedor tem 6, e
o único bloco acionável fica no fim da página. Proposta para uma próxima versão: a primeira
aba dá a visão macro e as demais respondem às perguntas que ela levanta.

| Cockpit — aba | Pergunta | Conteúdo |
|---|---|---|
| 1 · Visão Geral | Como estamos este mês? | Projeção vs meta, gap, ritmo, dias úteis, semáforo de risco |
| 2 · Equipe | Quem está entregando? | Performance individual, cobertura, comissão, inadimplência |
| 3 · Perdas e Preço | Por que não estamos vendendo? | Perdas por motivo, dispersão de preços, aprovações |
| 4 · Carteira e Risco | Quem cobrar, quem posso perder? | Recebimentos Previstos, inadimplentes, cancelamento |

| Dashboard do Vendedor — aba | Pergunta | Conteúdo |
|---|---|---|
| 1 · Meu mês | Como estou indo? | Meta × realizado, gap, ritmo, comissão prevista |
| 2 · Minha carteira | Quem devo atender? | Clientes, semáforo de inatividade, crédito |
| 3 · Recebimentos Previstos | Quem devo cobrar? | Títulos por vencimento com nome do cliente e busca |
| 4 · Meus pedidos | O que travou? | Pendentes de aprovação, recusados, motivos de perda |

Um ganho esperado: hoje o Cockpit e a tela Análises mostram os mesmos blocos com números
diferentes entre si — a proposta substitui duas telas concorrentes por uma só.

**Dashboard do Vendedor — tabela de clientes.** A coluna "Potencial" reproduz o limite de
crédito (os cartões "Potencial total" e "Crédito ativo" são o mesmo número com nomes
diferentes), o que pode levar o vendedor a priorizar quem tem crédito alto em vez de quem tem
chance de comprar. A coluna "Estoque disponível" mostra o total da empresa em toda linha, não
o das famílias que aquele cliente compra. A tabela "Volume e Margem por Família" está
essencialmente vazia. O pódio do ranking mistura "top 3" com "sua posição" e confunde kg com
toneladas. E o cartão de conversão mostrou "0 vendas" para uma vendedora com R$ 1,49M vendidos no mês.

**Acesso à NF-e emitida pelo CRM.** Muitos clientes pedem que o vendedor envie a nota após o
faturamento, o que hoje exige acessar o OMIE. Como a ideia é que o vendedor use só o CRM,
pedimos avaliar essa integração. Sem urgência.

**Outros ajustes de interface:** dois conceitos diferentes de "gap" na mesma tela sob o mesmo
termo; severidade de risco de cancelamento inconsistente entre telas para o mesmo cliente;
textos com "R$" duplicado; contradição entre indicador de estoque a caminho zerado e subtítulo
que fala em dezenas de famílias; funil de conversão zerado para quase todos os vendedores;
preço de lista/mínimo por família aparecendo vazio (esclarecer se vive só no nível de produto,
já que as alçadas de aprovação dependem dessa referência); e a diferença de totais entre a
tela Pedidos e o Cockpit, que acreditamos decorrer do mesmo critério de status do item 4 do
Bloco 1.

**Cadastro leve de prospecto — reforço de prioridade para o próximo ciclo.** O item já está no
roadmap de vocês (resposta de 07/08); aproveitamos para registrar o motivo concreto, além do
fluxo: na prospecção o CNPJ ainda não existe — e, no fechamento, o cliente com frequência
fatura por um CNPJ diferente do que se imaginava. Com a ficha completa obrigatória desde o
início, o vendedor ou não cadastra o prospect, ou cadastra com um CNPJ provisório — gerando
cadastro errado ou duplicado que acaba indo para o OMIE. Ou seja: além de experiência de uso,
é risco de sujeira na base.

**Backlog já acordado (sem mudança):** data sheet nos materiais e exportação/impressão do
pedido formalizado para envio ao cliente seguem no roadmap futuro, como combinado.

---

## Ponto em aberto do nosso lado

**Meta Global da equipe.** O Cockpit usa a Meta Global cadastrada; a tela Análises usa a soma
das metas individuais — e os dois números não coincidem, gerando gaps diferentes em cada tela.
Qual é a meta oficial é decisão que ainda estamos fechando internamente. Assim que definirmos,
avisamos. Nesse meio tempo, pedimos que as duas telas passem a usar uma única fonte para a
meta da equipe, e que o percentual de cobertura seja sempre calculado sobre essa mesma fonte.

**Clientes que não aparecem na carteira do vendedor.** Observamos uma diferença consistente
entre duas telas do mesmo vendedor: o dashboard conta 190 clientes e a carteira lista 171.
Verificando os 171 retornados pela API, todos vêm com `inativo: false` — e clientes sem compra
há mais de 1.600 dias aparecem normalmente, então não é filtro por recência de compra.

Um exemplo concreto: PLÁSTICOS JUREMA tem histórico de pedidos com essa vendedora, mas não
aparece na busca da carteira nem no seletor de cliente do Novo Pedido. No OMIE, esse cadastro
está com `bloqueado = N` e `bloquear_faturamento = N`.

**O que não conseguimos determinar:** se esses 19 cadastros estão de fato com o flag `inativo`
ligado no CRM (o login de vendedor não expõe nenhum endpoint que devolva inativos, então não
foi possível observar o flag diretamente), nem se a origem seria uma marcação no OMIE.

Ajudaria muito se puderem nos dizer: **o que faz um cliente sair da listagem da carteira do
vendedor?** Se for o flag de inativo, o que o aciona — ação manual, importação do OMIE, ou
alguma rotina automática? Com essa informação conseguimos investigar do nosso lado se é
questão de dado ou de comportamento do sistema.

---

## Sobre a "divergência nos painéis de vendas"

Vocês haviam pedido detalhamento sobre uma divergência que reportamos antes sem precisão —
qual tela, qual métrica, qual período, qual referência. **Este relatório é a resposta a esse
pedido.** Os pontos concretos estão nos blocos acima: a coluna "Receber" do fluxo de caixa, a
contagem de dias úteis divergente entre três telas, o percentual de meta calculado sobre bases
diferentes conforme a tela, e a diferença de totais entre a tela Pedidos e o Cockpit.

Consideramos esse pedido de esclarecimento atendido.

---

## Roteiro de conciliação sugerido — para depois do go-live

| # | Conciliação | Fonte CRM | Fonte OMIE | Critério de aceite |
|---|---|---|---|---|
| 1 | Faturamento do mês (R$ e kg) | Pedidos status Faturado | NF-e emitidas no período | Diferença = 0 por dia e por vendedor |
| 2 | Pedido a pedido | Nº OMIE em Pedidos | Pedido de venda correspondente | 100% dos Faturados com par no OMIE |
| 3 | Posição de estoque | Disponibilidade por produto | Posição de estoque no mesmo corte | Diferença = 0 |
| 4 | Contas a receber (30 dias) | Recebimentos Previstos | Títulos a receber por vencimento | Totais por data iguais |
| 5 | Contas a pagar (30 dias) | Fluxo de caixa · Pagar | Títulos a pagar por vencimento | Totais por data iguais |
| 6 | Inadimplência / limite de crédito | Performance | Títulos vencidos + limites | Mesmos clientes, mesmos valores |
| 7 | Cadastros | Usuários + filtros de Pedidos | Cadastros OMIE | Contagens iguais, zero duplicados |
| 8 | Comissões | Cockpit · Comissão | Recálculo sobre NFs | Diferença menor que R$ 1 por vendedor |

---

Qualquer dúvida sobre metodologia — como cada número foi recalculado, quais endpoints foram
consultados, como os testes foram isolados —, é só chamar. Temos o detalhe de cada
verificação disponível.
