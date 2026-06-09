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
| **Lote em trânsito** (5 estágios) | **Atlas** (OMIE não tem o conceito) | `stockbridge.lote` status='transito' | 100% FUP-driven (migration 0037). `refresh_lotes_em_transito_se_stale` lê FUP × pedidosCompras. Ver seção "Pipeline de trânsito — 5 estágios" |
| **Recebimento provisório** | **Atlas** (transitório) | `stockbridge.lote` status='provisorio' | Vive até OMIE consolidar (`movimentacao.status_omie='concluida'`); depois deixa de contar no Cockpit pra evitar dupla contagem |
| **Aprovação hierárquica** | **Atlas** | `stockbridge.aprovacao` | Workflow puro Atlas — OMIE não tem |
| **Divergência aberta** (faltando, varredura) | **Atlas** | `stockbridge.divergencia` | Atlas-only; quando aprovada vira ajuste OMIE |
| **Configuração de negócio** | **Atlas** | `stockbridge.config_produto`, `stockbridge.familia_omie_atlas`, `stockbridge.user_galpao`, `stockbridge.localidade`, `stockbridge.localidade_correlacao` | Camada de regras de negócio do StockBridge |
| **Indicadores derivados** | **Atlas** (calculados em SQL) | Funções `calcular_consumo_medio_diario_kg`, `refresh_consumo_medio_se_stale`, `refresh_lotes_em_transito_se_stale` | Lê OMIE, escreve em Atlas |
| **Auditoria detalhada** (quem/quando/por quê) | **Atlas** | `stockbridge.movimentacao` + `shared.audit_log` | Soft delete preserva histórico |
| **PTAX** (cotação dólar) | **BCB** (via `@atlas/integration-bcb`) | Cache 30min em memória do Atlas | Stockbridge não depende do módulo Hedge |

---

## Pipeline de trânsito — 5 estágios FUP-driven (migration 0037, 2026-06-09)

> **Mudança de 2026-06-09 (card ACXEGDP-155):** o trânsito passou a ser **100% derivado do FUP de Comex**. O rastreamento anterior por NF (Parte 2 NF da migration 0036, que alimentava o estágio `porto_dta`) foi **removido** — a `tbl_nf_header_ACXE` mistura **NF mãe** (pedido/container inteiro) com **NFs filhote** (uma por caminhão, para o transporte), indistinguíveis na tabela, o que dobrava o volume (inflava ~7×: 6.617 t por NF vs 895 t reais por FUP). O FUP é a fonte de verdade operacional do Comex e já cobre todas as etapas de trânsito.

A função `refresh_lotes_em_transito_se_stale()` popula `stockbridge.lote` (status='transito') a partir de:

```sql
FROM public."tbl_dadosPlanilhaFUPComex" fup
JOIN public."tbl_pedidosCompras_ACXE" pc ON pc.cnumero = fup.pedido_acxe_omie
WHERE pc.ncodprod IS NOT NULL AND pc.nqtde > 0
```

- **Quantidade somada = `pc.nqtde`** (linha do pedido de compras), **não** o `volume_total_kg` do FUP. O FUP define só o **estágio** (via `etapa_global` + `etapa`) e o **custo** R$/kg (`valor_total_reais / volume_total_kg`).
- **Um lote por `(pedido, produto)`** — `codigo = 'F-{pedido}-{ncodprod}'`. O `ON CONFLICT (pedido_compra_acxe, produto_codigo_acxe) DO UPDATE` trata as transições de estágio sem duplicar.
- O cockpit soma `SUM(quantidade_fisica_kg) FILTER (WHERE estagio_transito = '<estágio>')` sobre `lote WHERE ativo AND status='transito'`.

Critério de cada estágio (CASE no refresh):

| Estágio (UI) | `estagio_transito` | Critério FUP | NF emitida? |
|---|---|---|---|
| Aguardando Embarque | `aguardando_embarque` | `etapa_global = '01 - Aguardando Booking'` | não |
| Em Águas | `transito_intl` | `etapa_global = '02 - Em Águas'` | não |
| No Porto | `no_porto` | `etapa_global = '03 - Nacionalização'` **E** `etapa LIKE ANY('20%','30%','31%')` | não |
| Em Trânsito Local | `transito_local` | `etapa_global = '03 - Nacionalização'` **E** `etapa LIKE ANY('21%','22%')` | sim (mãe) |
| Disponível | — (OMIE) | saldo físico OMIE — ver seção Cockpit abaixo | recebido |

Sub-etapas do `03 - Nacionalização`:

- **20** Registro DI · **30** Registro DTA/Remoção · **31** Porto Seco → `no_porto` (sem NF ainda)
- **21** Exoneração ICMS · **22** Recebimento no Galpão → `transito_local` (NF mãe emitida, a caminho do galpão)
- **23** Devolução Containers e `etapa_global` **04/05** → **não rastreados** (já entregue; OMIE tem o saldo físico)

**Disponível** continua vindo do OMIE (CTE `fisico_omie` em `cockpit.service.ts`): soma de `tbl_posicaoEstoque_ACXE/_Q2P` no `MAX(ddataposicao)` por empresa, restrita à whitelist de galpões físicos (`11.1/11.2/12.1/12.2/21.1/21.2/31.1`), com `COALESCE(MAX FILTER Q2P, MAX FILTER ACXE)` por `(produto, galpão)` pra não dobrar o estoque espelhado.

**Gotcha de schema:** `estagio_transito` é `varchar(30)` mas tem CHECK `lote_estagio_transito_check`. Adicionar um estágio novo exige `ALTER TABLE ... DROP/ADD CONSTRAINT` (a 0037 faz isso) — senão o INSERT falha com erro `23514`. `porto_dta` permanece no CHECK como valor **legado** (linhas históricas soft-deletadas ainda o carregam).

**Ressalva tela × banco:** a soma crua de `stockbridge.lote` pode ser **maior** que a esteira do cockpit, porque o `WHERE` final do cockpit filtra `incluir_em_metricas = true` em `familia_omie_atlas` **e** `config_produto`. Produtos fora de métricas não somam na esteira.

---

## Posição Fiscal — rastreamento de gap fiscal vs físico

> **Documentado em 2026-06-09** após validação detalhada do cálculo de posição fiscal no cockpit.

**Objetivo:** Rastrear a divergência entre o que OMIE registrou **fiscalmente** (NF emitida) versus o que está **fisicamente confirmado** no galpão. Isso identifica "buracos" — material que foi faturado mas ainda não chegou/não foi recebido.

**Fórmula por SKU:**

```
POSIÇÃO FISCAL (kg) = Saldo Físico (OMIE) + Pendência Nacional + Pendência Importação
```

### 1. Saldo Físico (OMIE)

**Fonte:** `tbl_posicaoEstoque_ACXE` + `tbl_posicaoEstoque_Q2P` sincronizadas do OMIE

**Cálculo** (linhas 145-199 em `cockpit.service.ts`):
- Pega o snapshot **mais recente** por empresa (`MAX(ddataposicao)`)
- Filtra **apenas galpões físicos operacionais**: `11.1, 11.2, 12.1, 12.2, 21.1, 21.2, 31.1`
- **Anti-dupla-contagem**: Se um produto existe em ACXE E Q2P no **mesmo galpão**, prioriza Q2P (`COALESCE(MAX FILTER Q2P, MAX FILTER ACXE)`)
- Soma de todos os saldos consolidados

**Exemplo:**
- Produto 1234 em 11.1: Q2P=500 kg, ACXE=500 kg → conta só Q2P=500 kg
- Produto 1234 em 12.1: ACXE=300 kg (sem Q2P) → conta ACXE=300 kg
- **Total físico**: 800 kg

### 2. Pendência Nacional

**Fonte:** `tbl_nf_header_ACXE/_Q2P/_Q2P_Filial` + `tbl_nf_itens_*` sincronizadas do OMIE

**Critério** (linhas 248-291 em `cockpit.service.ts`):
- **Tipo NF**: `tp_nf = 0` (entrada)
- **CFOP**: `LEFT(cfop, 1) IN ('1','2')` — compras nacionais (CFOP 1.xxx) e devoluções (2.xxx)
- **Estado de recebimento**: `n_id_receb = 0 OR n_id_receb IS NULL` — OMIE ainda não marcou como "recebido fisicamente"
- **Cutoff temporal**: `d_emi >= CURRENT_DATE - 180` — últimos 180 dias (ignora histórico legado PHP)
- **Correlação multi-empresa**: Q2P correlaciona com ACXE via `JOIN ... WHERE descricao = descricao` para padronizar código de produto

**Cenário real:**
- NF-2026-005678 de Compra Nacional, 50 kg, emitida há 5 dias
- Motorista ainda não entrou no galpão: `n_id_receb = 0` em OMIE
- **Aparece em Pendência Nacional**: +50 kg (existe no papel, não na prateleira ainda)

### 3. Pendência Importação

**Fonte:** `tbl_nf_header_ACXE` + `tbl_nf_itens_ACXE` (CFOP 3.xxx — só ACXE tem importação)

**Critério** (linhas 293-309 em `cockpit.service.ts`):
- **Tipo NF**: `tp_nf = 0` (entrada)
- **CFOP**: `LEFT(cfop, 1) = '3'` — importação (CFOP 3.xxx)
- **Cutoff temporal**: `d_emi >= CURRENT_DATE - 180`
- **NÃO reconciliada em Atlas**: `NOT EXISTS (SELECT ... FROM stockbridge.movimentacao WHERE subtipo = 'importacao' AND nota_fiscal = h.n_nf)`

**Por que dois critérios diferentes?**
- **Nacional**: OMIE tem um campo (`n_id_receb`) que indica se foi recebido fisicamente → simples verificação
- **Importação**: OMIE **não tem indicador** de "recebido". Atlas controla via `stockbridge.movimentacao` com `subtipo='importacao'` + match de NF — quando operador confirma recebimento, ele grava uma movimentação com a NF, e essa NF some da pendência

**Cenário real:**
- NF-2026-IMP-9876 de Importação da China, 100 kg
- Atlas ainda não criou `movimentacao` pra essa importação (operador não confirmou recebimento)
- **Aparece em Pendência Importação**: +100 kg (registro fiscal existe, reconciliação Atlas ainda não)

### Agregação

Na função `getResumoFromSkus()` (linhas 435-490):

```javascript
totalFiscalKg = SUM(
    fisicaKg                      // Saldo físico por SKU
  + fiscalPendenteNacionalKg      // Pendências nacionais
  + fiscalPendenteImportacaoKg    // Pendências importação
)
```

**Exemplo numérico completo (Produto 1234 — Açúcar):**

| Categoria | Kg | Origem |
|---|---|---|
| Físico confirmado no galpão | 1.000 | `tbl_posicaoEstoque_ACXE[11.1]` sincronizado hoje |
| Pendência Nacional | 500 | NF-2026-005678 Compra (n_id_receb=0, CFOP 1.xxx, d_emi=2026-06-01) |
| Pendência Importação | 300 | NF-2026-IMP-9876 China (CFOP 3.xxx, não em movimentacao) |
| **POSIÇÃO FISCAL TOTAL** | **1.800** | Soma dos 3 acima |

**Interpretação:**
- OMIE registrou 1.800 kg de Açúcar (fiscal)
- Galpão só confirma 1.000 kg (físico)
- **Gap = 800 kg** (pedidos a chegar)

Se esses 800 kg não chegar ou se houver divergência no recebimento, o Atlas **gerará uma divergência automática** (tipo `fiscal_pendente`) ao consolidar o recebimento.

### Regra do cutoff (180 dias)

A variável de ambiente `STOCKBRIDGE_FISCAL_CUTOFF_DATE` controla qual é a data mínima de emissão considerada. Default: 180 dias atrás.

**Por quê?** O legado PHP operou sem controle granular de NF pendente. Ignorar NFs antigas previne:
- Dupla contagem: NFs do legado que já foram resolvidas fisicamente (não aparecem mais em OMIE como `n_id_receb=0`)
- Números fantasmas: histórico inflado de pendências "zumbis" que nunca foram entregas

### Impacto no Cockpit

O card "Posição Fiscal" no cockpit mostra:
- **Número principal**: `totalFiscalKg` (físico + pendências)
- **Breakdown** (se houver pendências): `"+ X kg pendentes (Y kg nac · Z kg imp)"`

Se `totalFiscalKg > totalFisicoKg`, significa que há NFs de entrada que ainda não foram recebidas — isso é **normal** durante o período entre emissão e entrega. O diretor/gestor monitora esse gap pra garantir que as mercadorias chegam conforme o prazo esperado.

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

3. **Lote em trânsito que nunca vira recebimento** — quando o pedido avança no FUP além dos estágios rastreados, o lote precisa sumir do trânsito. Mitigação: o `refresh_lotes_em_transito_se_stale` faz soft-delete dos lotes cujo pedido saiu dos estágios rastreados — mantém ativos apenas `etapa_global` `01`/`02`, ou `03` nas etapas `20/21/22/30/31`. Pedidos em `03`/etapa `23` ou `etapa_global` `04`/`05` são soft-deletados, pois já estão entregues e o OMIE assume o saldo físico (Disponível).

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

1. ✅ **Trânsito**: lê FUP→lote, 5 estágios FUP-driven. (Migration 0024 → 0036 → **0037**; ver seção "Pipeline de trânsito — 5 estágios")
2. ✅ **Meu Estoque**: já lê OMIE direto. (Migration 0025)
3. ✅ **Indicadores por Produto**: já lê OMIE+Atlas via função 0017→0023.
4. ⏳ **Cockpit**: refatorar pra consumir saldo OMIE como base + camadas Atlas (provisório + trânsito) com regra anti-dupla-contagem.
5. ⏳ **Métricas**: idem — valor de estoque = OMIE × custo médio; exposição cambial já está em Atlas (lote em trânsito).
6. ⏳ **View consolidada**: criar `shared.vw_sb_saldo_consolidado` que materializa as regras acima (uma única fonte pro Cockpit/Métricas consumirem).
