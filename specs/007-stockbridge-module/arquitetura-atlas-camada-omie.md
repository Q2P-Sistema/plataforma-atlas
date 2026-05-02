# Arquitetura — Atlas como camada sobre OMIE

> **Definida em 2026-05-02** durante a validação paralela do StockBridge.
> Documenta a visão de longo prazo: Atlas é a camada UX/lógica de negócio que o operador, gestor e diretor usam; OMIE permanece como ERP de back-office (estoque consolidado, NF, financeiro fiscal); Postgres é o espelho de leitura + estado próprio do Atlas.
>
> **Princípio guia:** "operador só tem o Atlas como ponto de contato".

---

## Camadas

```
┌─────────────────────────────────────────────────────────────┐
│                       UI (React)                            │
│   Operador │ Gestor │ Diretor                               │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                    Atlas (Express)                          │
│   Lógica de negócio │ Workflows │ Auditoria                 │
│                                                             │
│   Lê: PG (snapshot OMIE + estado Atlas)                     │
│   Escreve:                                                  │
│     - PG (estado Atlas: lote, aprovação, config, auditoria) │
│     - OMIE API (operações fiscais autorizadas)              │
└────────────┬───────────────────────────────┬────────────────┘
             │                               │
   ┌─────────▼───────┐               ┌───────▼────────┐
   │  Postgres       │◄──── n8n ─────│  OMIE (API)    │
   │                 │   (sync)      │                │
   │  schema atlas   │               │  Estoque       │
   │  schema shared  │               │  NF            │
   │  schema stock-  │               │  Financeiro    │
   │   bridge        │               │  Cadastros     │
   │  schema public  │               │                │
   │  (espelho OMIE) │               │                │
   └─────────────────┘               └────────────────┘
```

**Direções de dados:**

- **OMIE → PG (público)**: workflows n8n sincronizam tabelas (`tbl_produtos_*`, `tbl_pedidosVendas_*`, `tbl_NFsEmitidas_*`, `tbl_posicaoEstoque_*`, etc). Atlas **lê** essas tabelas livremente.
- **Atlas → PG (stockbridge/atlas)**: estado próprio do Atlas (lote, aprovação, config_produto, user_galpao, audit_log, etc).
- **Atlas → OMIE (API)**: operações fiscais (`IncluirAjusteEstoque`, `IncluirPedidoCompra`). Documentada como exceção autorizada ao Princípio II em `research.md`.

---

## Fontes de verdade por domínio

| Domínio | Fonte de verdade | Tabela/View | Observação |
|---|---|---|---|
| **Saldo físico** nos galpões (estoque consumível agora) | OMIE | `public.vw_posicaoEstoqueUnificadaFamilia` | Atualizado por sync periódico OMIE→PG |
| **Cadastro de produto** (descrição, NCM, família OMIE) | OMIE | `public.tbl_produtos_ACXE`, `tbl_produtos_Q2P`, `tbl_produtos_Q2P_Filial` | Match cross-empresa por descrição (códigos OMIE são por empresa) |
| **Movimento fiscal histórico** (NF, ajustes consolidados) | OMIE | `public.tbl_NFsEmitidas_*`, `tbl_movimentacaoEstoqueHistorico_*` | Atlas grava aqui via API quando faz operações |
| **Pedido de compra** (rastro fiscal das importações) | OMIE | `public.tbl_pedidosCompras_ACXE` | Source da ligação `pedido_acxe_omie` ↔ items |
| **Vendas faturadas** | OMIE | `public.tbl_pedidosVendas_*` + `_itens_*` | Usado por `calcular_consumo_medio_diario_kg` |
| **Lote em trânsito marítimo** | **Atlas** (OMIE não tem o conceito) | `stockbridge.lote` status='transito' | Populado pela função `refresh_lotes_em_transito_se_stale` lendo FUP de Comex |
| **Recebimento provisório** | **Atlas** (transitório) | `stockbridge.lote` status='provisorio' | Vive até OMIE consolidar (`movimentacao.status_omie='concluida'`); depois deixa de contar no Cockpit pra evitar dupla contagem |
| **Aprovação hierárquica** | **Atlas** | `stockbridge.aprovacao` | Workflow puro Atlas — OMIE não tem |
| **Divergência aberta** (faltando, varredura) | **Atlas** | `stockbridge.divergencia` | Atlas-only; quando aprovada vira ajuste OMIE |
| **Configuração de negócio** | **Atlas** | `stockbridge.config_produto`, `stockbridge.familia_omie_atlas`, `stockbridge.user_galpao`, `stockbridge.localidade`, `stockbridge.localidade_correlacao` | Camada de regras de negócio do StockBridge |
| **Indicadores derivados** | **Atlas** (calculados em SQL) | Funções `calcular_consumo_medio_diario_kg`, `refresh_consumo_medio_se_stale`, `refresh_lotes_em_transito_se_stale` | Lê OMIE, escreve em Atlas |
| **Auditoria detalhada** (quem/quando/por quê) | **Atlas** | `stockbridge.movimentacao` + `shared.audit_log` | Soft delete preserva histórico |
| **PTAX** (cotação dólar) | **BCB** (via `@atlas/integration-bcb`) | Cache 30min em memória do Atlas | Stockbridge não depende do módulo Hedge |

---

## Cockpit & Métricas — regras de consolidação

Cockpit e Métricas devem mostrar uma **visão consolidada** que combina OMIE (saldo real) com camadas Atlas (estado intermediário). Vale ler como uma "soma de buckets" por SKU:

```
SALDO TOTAL POR SKU =
    SALDO_FISICO_OMIE              (vw_posicaoEstoqueUnificadaFamilia, sufixos .1/.2 com regra anti-duplicação espelhado)
  + SALDO_TRANSITO_ATLAS           (stockbridge.lote status='transito' agrupado por estágio)
  + SALDO_PENDENTE_ATLAS           (stockbridge.lote status='provisorio' COM movimentacao status_omie != 'concluida')

EXPOSIÇÃO CAMBIAL (USD) =
    Σ (lote em transito_intl) × custo_brl_kg ÷ PTAX
```

**Regra crítica anti-dupla-contagem:**

Quando o operador faz **Recebimento de NF** no Atlas:
1. Atlas chama `IncluirAjusteEstoque` no OMIE (ACXE + Q2P)
2. Atlas grava `stockbridge.lote` status='provisorio' + `stockbridge.movimentacao` com `status_omie='concluida'` (caso feliz)
3. **OMIE → PG sync** atualiza `tbl_posicaoEstoque_*` com o novo saldo
4. **A partir desse ponto**, esse mesmo volume aparece em DUAS fontes:
   - `vw_posicaoEstoqueUnificadaFamilia` (OMIE consolidou)
   - `stockbridge.lote` status='provisorio' (Atlas ainda mantém o registro)

Pra evitar somar 2x, o Cockpit aplica a regra:

> Lote em status='provisorio' só conta como "pendente Atlas" se `EXISTS (movimentacao WHERE lote_id = X AND status_omie != 'concluida')`. Caso contrário, o saldo já está no OMIE e o lote serve apenas como histórico/auditoria — não conta no agregado.

Quando o lote é "reconciliado fiscalmente" (próximo step no workflow original), ele muda pra status='reconciliado' e definitivamente sai do agregado de pendentes.

---

## Visão Atlas-only do operador

Operador acessa apenas estas telas (todas no Atlas):

| Tela | O que mostra | Fonte |
|---|---|---|
| **Meu Estoque** | Saldo físico no galpão vinculado | OMIE |
| **Recebimento** | Fila de NFs aguardando conferência | Atlas (workflow) |
| **Trânsito** | Importações em rota (visibilidade) | Atlas (FUP) |
| **Saída Manual** | Lançar saída pra cliente fora do fluxo automático | Atlas (workflow) |
| **Indicadores por Produto** | Lead time, consumo médio, regra do cálculo | Atlas (config + função) |

Operador **nunca** acessa OMIE direto. Toda escrita fiscal passa pelo Atlas, que orquestra a chamada à API OMIE.

---

## Migração gradual

Não é cutover único — é convivência:

- **Fase atual (validação paralela)**: legado PHP roda em paralelo com Atlas. Operador opera no PHP; Atlas só observa. Cockpit/Métricas precisam mostrar OMIE+Atlas pra diretor comparar paridade.
- **Fase próxima (cutover)**: operador migra pro Atlas. Recebimentos passam a nascer no Atlas, escrever no OMIE via API. `stockbridge.lote` cresce em volume.
- **Pós-cutover**: legado PHP é desligado. Atlas continua sendo só uma camada — `stockbridge.lote` mantém o histórico de operações + estado intermediário (provisórios, aprovações). OMIE continua como source of truth fiscal.

**O que NÃO muda na arquitetura:**

- OMIE permanece como ERP — Atlas não pretende substituí-lo.
- Postgres permanece como espelho de leitura do OMIE — Atlas não pretende ser write-master de produtos/clientes/financeiro.
- Sync OMIE→PG continua via n8n (workflows fora do Atlas).

---

## Riscos a monitorar

1. **Sincronização atrasada OMIE→PG** — se o sync n8n para, `vw_posicaoEstoqueUnificadaFamilia` fica stale e cockpit mostra saldo desatualizado. Mitigação: alerta se `MAX(updated_at)` > N minutos.

2. **Dupla contagem provisorio + OMIE consolidado** — se a regra de filtro `status_omie != 'concluida'` falhar, mesmo SKU é contado 2x. Mitigação: teste de unidade na função de consolidação + sanidade no checklist de validação.

3. **Lote em trânsito que nunca vira recebimento** — se o operador esquece de receber e a planilha FUP marca como recebido, o lote fica "preso" em `transito_interno` no Atlas. Mitigação: o `refresh_lotes_em_transito_se_stale` faz soft-delete dos lotes que saíram da janela ativa do FUP (`etapa_global` em `02 - Em Águas` ou `03 - Nacionalização`).

4. **Falha parcial OMIE durante recebimento** (ACXE OK + Q2P falha) — já coberto pela idempotência da migration 0016. `stockbridge.movimentacao.status_omie='pendente_q2p'` permite retry sem duplicar ajuste.

5. **Operador sem galpão vinculado** — bloqueia acesso ao Meu Estoque (403). Diretor precisa atribuir via `/stockbridge/admin/user-galpao` (UI da migration 0025).

---

## Convenções de design pra futuras features

Ao adicionar nova feature ao StockBridge, decidir em qual camada vive:

- **Vive em OMIE?** Então leia direto do PG sincronizado (`public.*`). Não duplique no schema `stockbridge`.
- **É estado intermediário/workflow Atlas?** Então grave em `stockbridge.*` e referencie OMIE por código (não por FK física, já que cross-schema).
- **É indicador derivado?** Função PL/pgSQL em `stockbridge.*` que lê OMIE+Atlas e materializa o resultado. Padrão TTL via `refresh_*_se_stale(ttl_minutes)` chamado pelo service no GET (igual `refresh_consumo_medio_se_stale`, `refresh_lotes_em_transito_se_stale`).
- **É escrita fiscal?** Vai pro OMIE via API + grava `stockbridge.movimentacao` pra auditoria + atualiza estado Atlas (lote/aprovação/etc). Use a abstração de idempotência do `omie-idempotente.ts`.

---

## Próximos passos pra alinhar o módulo a essa arquitetura

1. ✅ **Trânsito**: já lê FUP→lote. (Migration 0024)
2. ✅ **Meu Estoque**: já lê OMIE direto. (Migration 0025)
3. ✅ **Indicadores por Produto**: já lê OMIE+Atlas via função 0017→0023.
4. ⏳ **Cockpit**: refatorar pra consumir saldo OMIE como base + camadas Atlas (provisório + trânsito) com regra anti-dupla-contagem.
5. ⏳ **Métricas**: idem — valor de estoque = OMIE × custo médio; exposição cambial já está em Atlas (lote em trânsito).
6. ⏳ **View consolidada**: criar `shared.vw_sb_saldo_consolidado` que materializa as regras acima (uma única fonte pro Cockpit/Métricas consumirem).
