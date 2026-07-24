# Quickstart & Validação de Paridade — Conferência de Estoque

## Pré-requisitos

- `MODULE_STOCKBRIDGE_ENABLED=true` no `.env`.
- Banco com `public."tbl_posicaoEstoque_ACXE"/"_Q2P"` sincronizadas (n8n) e migration `0040` aplicada (cria `stockbridge.conferencia_local_map` + seed das 23 linhas).

## Subir

```bash
pnpm --filter @atlas/db migrate          # aplica 0040
pnpm --filter @atlas/stockbridge test    # Vitest da engine
pnpm dev                                  # apps/api + apps/web
```

Acesse como **gestor/diretor** → StockBridge → **Conferência de Estoque** (`/stockbridge/conferencia`). O badge vermelho aparece no menu com a contagem de itens ≠ OK.

## Smoke test dos endpoints

```bash
# contagem (badge)
curl -s --cookie "$COOKIE" -H "x-csrf-token: $CSRF" \
  http://localhost:3000/api/v1/stockbridge/conferencia/contagem | jq

# lista só problemas
curl -s --cookie "$COOKIE" -H "x-csrf-token: $CSRF" \
  "http://localhost:3000/api/v1/stockbridge/conferencia?status=problemas" | jq '.data.resumo'
```

## Validação de paridade vs planilha (SC-003 — Princípio V)

Objetivo: a classificação `Status Geral` do Atlas deve bater **100%** com a planilha para a mesma posição.

1. **Mesma data**: a planilha usa `dDataPosicao` por empresa; confirme que o Atlas usa o mesmo `MAX(ddataposicao)` (hoje `2026-06-22` para ambas).
2. **Contagem agregada**: a aba `Comparativo` da planilha tinha hoje **6.096 linhas** e **27 problemas** (12 Divergente, 11 Negativo, 4 Divergente e Negativo). O endpoint deve devolver `resumo.totalProblemas == 27` e a mesma quebra em `porStatus` (atenção: a planilha rotula como `Negativo` o caso `ESPELHADO` com `Diferença=0` e ambos negativos — a engine TS já faz isso).
3. **Spot-check de unidade (D8)**: pegue 1 linha conhecida (ex. `11.1` / `PEBD 100`) e compare `saldoAcxeKg`/`saldoQ2pKg` com a célula da planilha. Se a magnitude bater, `fisico` está em Kg como esperado.
4. **Linha a linha (opcional, forte)**: exportar `GET /conferencia` e a aba `Comparativo` para CSV e dar `diff` por `(codigoEstoque, produto)` no campo `statusGeral`. Zero divergência = paridade.
5. **Órfãos**: confirmar que locais fora do mapa De→Para não aparecem (ex. códigos operacionais 10.x/20.x que não estão nas 23 linhas).

> Só após paridade confirmada o usuário para de abrir a planilha (SC-001).

## Casos de borda a verificar manualmente

- **Sync atrasado**: simular `MAX(ddataposicao)` ACXE ≠ Q2P → `defasagemEntreEmpresas=true` e aviso na tela (FR-015).
- **Produto só num lado** → lado ausente = 0; se `ESPELHADO` e `Diferença≠0` → `Divergente`.
- **Blacklist** → produtos `CONS_`/`PRD00001`/`SUC-`/`STRETCH` ausentes da lista.
- **Badge zera** → numa posição sem problemas, badge some.
