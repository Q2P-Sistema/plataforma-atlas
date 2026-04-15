# Revisão Supervisória — Módulo Hedge
**Data:** 2026-04-14  
**Objetivo:** Validar lógicas de cálculo e identificar melhorias

---

## Tarefas Identificadas

### ~~T01~~ — PTAX visível — **IMPLEMENTADO**
- Card "PTAX Atual" redesenhado: valor grande colorido (verde=caiu, vermelho=subiu), variação % vs dia anterior, data ref + horário da última busca
- Mini gráfico de 15 dias abaixo do valor (usando `ptaxHistorico` real, não snapshots)
- Card "Câmbio PTAX" vazio/quebrado removido; seção charts row passou de 3 para 2 colunas
- `HedgeLayout` criado como wrapper compartilhado — badge PTAX (valor + var% + horário) aparece no header de todas as abas do módulo
- Backend: `fetchedAt` exposto no endpoint `/api/v1/hedge/ptax`

### T02 — Badge PTAX não aparece no TopBar — **PENDENTE (2ª tentativa falhou)**
**Problema:** O badge com valor do dólar não está visível no header superior das abas hedge.
**O que foi feito:** Adicionado `centerSlot` no `TopBar`, passado via `ShellLayout`, injetado `HedgePtaxBadge` no `App.tsx` quando rota começa com `/hedge`. Badge movido do `HedgeLayout` para o `TopBar`.
**Ainda não funciona:** Problema persiste após as correções. Requer investigação mais profunda — possível problema de renderização, CSS ou dados não carregando.
**Próximo passo:** Inspecionar o DOM/console do browser para entender se o componente está montando e se a query está retornando dados.

### T03 — Gráfico histórico PTAX vazio — **PENDENTE (2ª tentativa falhou)**
**Problema:** O mini gráfico de 15 dias no card PTAX não renderiza dados.
**O que foi feito:** Trocada fonte de `hedge.ptax_historico` para `tbl_cotacaoDolar` como fonte primária.
**Ainda não funciona:** Gráfico continua sem dados. Verificar se a query está chegando corretamente ao frontend e se o campo `historico` está sendo mapeado para `ptaxMiniData`.

### T04 — Card "Receita Projetada" exibindo BRL em vez de USD — **PENDENTE**
**Problema:** KPI card mostra `recebiveis_brl` (R$ 59.8M) com label "Receita BRL Projetada". Para o módulo de hedge o valor relevante é o USD.
**Dados confirmados no BD:**
- BRL total: R$ 59.9M (A VENCER + ATRASADO + VENCE HOJE, janela 90d)
- USD equivalente: $ 11.9M (convertido pela PTAX atual via `vw_hedge_receber_usd`)
**Correção:** trocar `kpis.recebiveis_brl` → `kpis.recebiveis_usd` no `PositionDashboard.tsx`, label "Receita USD Projetada", formato `$ 11.9M`.

### T05 — PTAX boletins intraday BCB — **EM IMPLEMENTAÇÃO**
**Problema:** Fonte atual (SGS-1) publica fechamento diário. Card exibe "Atualizado HH:MM" referente ao fetch do servidor, não ao boletim BCB. Frontend faz polling a cada 15min desnecessariamente.
**Solução:**
- Trocar `fetchPtaxAtual` para endpoint de boletins: `olinda.bcb.gov.br/.../CotacaoDolarDia`
- Retornar `dataHoraCotacao` do BCB como `fetchedAt` (timestamp real do boletim)
- Redis TTL: 1 hora (boletins saem ~3x/dia)
- Remover `refetchInterval` do frontend (sem polling)
- Label: "Boletim BCB HH:MM" em vez de "Atualizado HH:MM"

---

## Notas / Dúvidas Registradas

---

## Regra para próximas sessões

> Anotar no arquivo de tarefas antes de implementar. Não sair codando sem confirmação do supervisor.

