# Fase 2 — Rotação de clientes inativos (regra dos 90 dias)

**Oficializada em 03/09/2026 pelo Flavio, após alinhamento interno com a gestão comercial.**
Substitui a intenção registrada anteriormente ("cliente 90+ dias visível a todos os
vendedores") — a regra correta é rotação via gestor, descrita abaixo.

**Escopo em duas etapas (decisão de 03/09, mais tarde):** uma **versão simplificada entra
antes do go-live** — a regra de saída volta a valer + tela do gestor só de visualização +
troca de vendedor feita manualmente no OMIE (o relógio zera pela troca de vendedor
observada via sincronização); está no backlog da devolutiva (item 4). Este documento
descreve a **versão completa da fase 2**: reatribuição dentro do CRM com write-back no
OMIE e relatório de contexto.

---

## A regra

1. **Saída automática da carteira.** Cliente sem compra há **mais de 90 dias** sai
   automaticamente da carteira do vendedor. Racional: o vendedor teve 90 dias para cuidar
   do cliente; não cuidou, a decisão sobe para o gestor. A saída acontece sempre — a
   avaliação de justiça (havia material para vender?) é feita pelo gestor na decisão, não
   na regra de saída.

   **Contagem do prazo (ajuste de 03/09):** os 90 dias contam a partir do evento mais
   recente entre **a última compra** e **a última reatribuição pelo gestor**. Sem isso, o
   cliente reatribuído voltaria imediatamente à fila (segue sem compra há 90+ dias) — a
   reatribuição zera o relógio e dá ao novo vendedor os seus próprios 90 dias. Vale
   também quando o gestor devolve o cliente **ao mesmo** vendedor: a devolução é uma
   reatribuição e reinicia a contagem.

2. **Fila do gestor.** O cliente retirado vai para uma área do gestor comercial — clientes
   **sem vendedor ativo**. Nova tela (gestor+): lista desses clientes; ao clicar em um,
   o gestor **reatribui** — para outro vendedor ou de volta ao mesmo. Ao salvar:
   - o cliente sai da lista;
   - passa a aparecer imediatamente na carteira do vendedor escolhido.

3. **Write-back no OMIE.** A troca de vendedor deve ser gravada também no **cadastro do
   cliente no OMIE** (campo de vendedor) — não pode ficar só no CRM, senão a próxima
   sincronização desfaz ou diverge.

4. **Relatório de contexto (avaliar viabilidade).** Para o gestor decidir entre devolver
   ao mesmo vendedor ou rodar, um relatório do período dos 90 dias respondendo "por que
   não vendemos para este cliente?" — em especial:
   - **Havia material disponível** das famílias que o cliente compra? (Se havia e não
     vendemos: responsabilidade do vendedor → rodar. Se não havia: não é justo penalizar
     → devolver.)
   - Follow-ups/atendimentos registrados no CRM no período.

   Apoio técnico Q2P: o espelho do OMIE tem histórico de posição de estoque por
   produto/família — a lógica "famílias compradas pelo cliente × disponibilidade no
   período" pode ser fornecida por nós quando a OrbitIA especificar.

## Pontos a definir na especificação (com a OrbitIA, quando a fase 2 abrir)

- Gatilho: job diário avaliando `max(data da última compra, data da última reatribuição)`
  (fontes: pedidos faturados + histórico de rotações). Exige guardar a data de cada
  reatribuição — mais um motivo para o histórico de rotações abaixo.
- O que o vendedor vê quando perde o cliente (notificação? some silenciosamente?).
- Interação com a trava de exclusão/edição e com a regra da tag Cliente.
- Como representar "sem vendedor ativo" no OMIE durante o limbo (mantém o vendedor
  antigo no cadastro até a reatribuição, ou usa um vendedor-casa?).
- Histórico/auditoria das rotações (quem rodou, quando, de quem para quem).
