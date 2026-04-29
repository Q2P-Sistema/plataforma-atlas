# Handoff: Refatorar workflows "Full Sync" de Pedidos de Vendas

> **Origem:** descoberto em 2026-04-29 durante validação manual do StockBridge.
> A tabela `tbl_pedidosVendas_itens_ACXE` apareceu vazia, e a investigação
> revelou que os workflows abaixo se chamam "Full Sync" mas só fazem
> reconciliação de exclusões em headers — não baixam dados detalhados.
>
> Este documento é um prompt self-contained para outro agente executar a
> refatoração sem precisar do contexto da conversa original.

## Workflows alvo (n8n)

- ID `YKeP5epCTGHlyIoQ` — `ACXE - Sincroniza Pedidos de Vendas (Full Sync) - Rev 1.0`
- ID `N34ZrCeMKSPmdbGA` — `Q2P - Sincroniza Pedidos de Vendas (Full Sync) - Rev 1.0`

n8n hospedado em `10.0.0.170:5434/n8n_queue` (acesso via MCP `pg-n8n` ou UI do n8n).

## Estado atual

Ambos seguem o mesmo padrão (4 nodes Postgres):

1. `*_Truncate_Staging` — TRUNCATE em `tbl_staging_pedidosVendas_*` + `tbl_staging_pedidosVendas_itens_*`
2. `*_Insere_Staging_Cabecalhos` — INSERT na staging (vindos de `ListarPedidos` da OMIE, paginado)
3. `*_Insere_Staging_Itens` — INSERT na staging itens (só `codigo_pedido` + `codigo_item`, 2 colunas)
4. `*_Reconcilia_Exclusoes` — UPDATE em `tbl_pedidosVendas_*.excluido_omie` comparando staging vs final

A staging itens tem **apenas 2 colunas** (`codigo_pedido`, `codigo_item`) — não traz quantidade, produto, NCM. Quem popula esses detalhes é OUTRO workflow:

- `T54XxoczJwYIYpnM` — `ACXE - Exporta Dados de Pedidos de Vendas - Rev 1.0`
- `1QD4MorQzQzRjT7j` — `Q2P - Exporta Dados de Pedidos de Vendas - Rev 1.1`

Esses são incrementais (`data_ultima_execucao - 2 dias`) e chamam `ConsultarPedido` por pedido. **NÃO MEXER nesses dois — funcionam.**

## Problemas a resolver

1. **Nome enganoso.** "Full Sync" sugere sincronização completa de dados. Não é.
2. **Custo.** Hoje pagina o histórico inteiro da OMIE (desde ~2021) só pra reconciliar exclusões. Pedidos faturados antigos raramente são apagados — limitar a últimos 6 meses corta 70-90% do tempo de execução.

## Mudanças

### 1. Renomear

| Antes | Depois |
|---|---|
| `ACXE - Sincroniza Pedidos de Vendas (Full Sync) - Rev 1.0` | `ACXE - Reconcilia Exclusões de Pedidos (últimos 6m) - Rev 2.0` |
| `Q2P - Sincroniza Pedidos de Vendas (Full Sync) - Rev 1.0`  | `Q2P - Reconcilia Exclusões de Pedidos (últimos 6m) - Rev 2.0` |

### 2. Limitar janela na chamada OMIE

Nos nodes HTTP Request que chamam `ListarPedidos`, adicionar filtros:

- `filtrar_por_data_de` = `today - 6 months` (formato `DD/MM/YYYY`)
- `filtrar_por_data_ate` = `today` (formato `DD/MM/YYYY`)

> Verificar nome exato dos parâmetros na doc OMIE — pode ser `dDtFaturamentoDe` ou similar. Os nodes Code anteriores ao HTTP request devem montar esses params.

Tornar a janela parametrizável via env var do n8n (`RECONCILIACAO_JANELA_MESES=6`).

### 3. Filtrar `Reconcilia_Exclusoes` na mesma janela

Hoje a query marca como excluído QUALQUER pedido local que não está na staging. Se a staging só tem 6m, todos os pedidos > 6m seriam erroneamente marcados.

Adicionar filtro `AND t.dfat > now() - interval '6 months'` nos dois UPDATEs:

```sql
-- 1) Marca como excluido_omie=TRUE pedidos da janela que sumiram
UPDATE "tbl_pedidosVendas_ACXE" t
SET excluido_omie = TRUE,
    data_excluido_omie = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE NOT EXISTS (
    SELECT 1 FROM "tbl_staging_pedidosVendas_ACXE" s
    WHERE s.codigo_pedido = t.codigo_pedido
)
  AND t.excluido_omie = FALSE
  AND t.dfat > now() - interval '6 months';   -- novo

-- 2) Reset — pedidos da janela que reapareceram no OMIE
UPDATE "tbl_pedidosVendas_ACXE" t
SET excluido_omie = FALSE,
    data_excluido_omie = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE EXISTS (
    SELECT 1 FROM "tbl_staging_pedidosVendas_ACXE" s
    WHERE s.codigo_pedido = t.codigo_pedido
)
  AND t.excluido_omie = TRUE
  AND t.dfat > now() - interval '6 months';   -- novo
```

Mesma alteração na versão Q2P (trocar nomes das tabelas).

### 4. Sticky note de design no topo de cada workflow

Sticky note grande no topo:

> **Escopo:** este workflow APENAS reconcilia EXCLUSÕES de pedidos dos últimos 6 meses, comparando o que o OMIE retorna agora vs o banco local.
>
> **NÃO baixa dados detalhados** (quantidade, NCM, valores, impostos). Detalhes vêm de:
>
> - `ACXE - Exporta Dados de Pedidos de Vendas` (T54XxoczJwYIYpnM)
> - `Q2P - Exporta Dados de Pedidos de Vendas` (1QD4MorQzQzRjT7j)
>
> ambos incrementais por `data_ultima_execucao - 2 dias`.
>
> **Se precisar repopular `tbl_pedidosVendas_itens_*`** (ex.: tabela ficou vazia), insira nova linha em `tbl_controlePedidoVendas_*` com data antiga e rode "Exporta Dados" manualmente.

### 5. (Opcional, recomendado) Gap detection

Após o `Reconcilia_Exclusoes`, adicionar node Postgres que checa headers sem itens:

```sql
SELECT COUNT(*) AS pedidos_sem_itens
FROM "tbl_pedidosVendas_ACXE" h
LEFT JOIN "tbl_pedidosVendas_itens_ACXE" i ON i.codigo_pedido = h.codigo_pedido
WHERE i.codigo_pedido IS NULL
  AND h.excluido_omie = FALSE
  AND h.dfat > now() - interval '6 months';
```

Se `> 0`, disparar alerta (Slack/email — usar o canal de notificações que o projeto já tem; se não tiver, deixar como TODO no sticky e seguir).

## NÃO fazer

- NÃO mexer nos workflows "Exporta Dados" (`T54XxoczJwYIYpnM`, `1QD4MorQzQzRjT7j`).
- NÃO remover as tabelas staging — ainda são necessárias.
- NÃO alterar schema das tabelas finais (`tbl_pedidosVendas_*` / `tbl_pedidosVendas_itens_*`) — outros módulos (StockBridge) dependem.
- NÃO trocar `Schedule Trigger` por `Webhook` ou vice-versa — manter o trigger atual.

## Validação pós-mudança

1. Rodar manualmente o workflow renomeado uma vez.
2. `SELECT COUNT(*), MIN(dfat) FROM tbl_staging_pedidosVendas_ACXE` — MIN deve estar dentro dos últimos 6m.
3. `SELECT COUNT(*) FROM tbl_pedidosVendas_ACXE WHERE excluido_omie = TRUE AND dfat < now() - interval '6 months'` — deve permanecer igual ao valor antes da mudança (não corrompemos status de pedidos antigos).
4. Comparar tempo de execução com a Rev 1.0 (ver `execution_entity` histórico). Esperado: 70-90% mais rápido.
5. Repetir tudo no Q2P.

## Entrega

- Versionar como Rev 2.0 dos workflows (não sobrescrever Rev 1.0 — exportar Rev 1.0 como JSON em backup primeiro, em caso de rollback rápido).
- Se o projeto versiona workflows n8n no repositório (`workflows/` ou similar), exportar JSON da Rev 2.0 e commitar.
- Reportar de volta com: tempo antes/depois, quantidade de pedidos na janela 6m, e qualquer mudança extra que tenha precisado fazer.
