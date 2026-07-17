# Quickstart — Validação da Fila Real + Correção de Granularidade

**Feature**: 014-fila-recebimento-real | **Date**: 2026-07-16

## 1. Dev local (OMIE_MODE=mock)

A fila real depende de dado em `stockbridge.nf_pedido_mapa`/`nf_pedido_filhote` — em dev, popular manualmente (essas tabelas não têm fixture de mock, são sempre lidas do Postgres real, mesmo com OMIE mockado):

```sql
INSERT INTO stockbridge.nf_pedido_mapa (pedido_acxe_omie, nf_mae) VALUES ('99999', '00009999');
INSERT INTO stockbridge.nf_pedido_filhote (mapa_id, nf_filhote, posicao)
  SELECT id, '00009998', 1 FROM stockbridge.nf_pedido_mapa WHERE pedido_acxe_omie='99999';
```

Precisa também de uma linha correspondente em `tbl_nf_header_ACXE`/`tbl_nf_itens_ACXE` (espelho) para a NF filhote aparecer como emitida — em dev sanitizado, usar uma NF real já existente no espelho.

**Fluxo manual**:
1. Abrir o recebimento de importação **sem** digitar NF.
2. Esperado: lista de NFs filhote pendentes (não mais "Informe um número de NF").
3. Clicar num item → busca daquela NF dispara automaticamente → segue o fluxo normal (feature 013).
4. Receber parcialmente uma NF de 2 produtos (1 produto só) → reabrir a tela sem NF → a mesma NF **continua** na fila, com `produtosPendentes: 1` (não `2`) — prova de que a granularidade por produto está correta.

## 2. Testes automatizados (Vitest)

```bash
pnpm --filter @atlas/stockbridge test
pnpm --filter @atlas/stockbridge exec tsc --noEmit
```

Cobrir:
- **`produtoPendenteSql`/`recebidaViaMovimentacaoSql` com filtro de produto**: produto com movimentação ativa daquele produto específico → não pendente; produto sem movimentação (mesmo com outro produto da mesma NF recebido) → pendente.
- **Regressão single-item**: para NF de 1 produto, resultado idêntico ao comportamento anterior em todos os 5 pontos (Cockpit ×3, Cockpit Executivo, Pendências Fiscais ×2, auto-desativação do mapa).
- **Fila**: NF mãe nunca aparece; cancelada/não sincronizada nunca aparecem; NF com produto parcialmente recebido aparece com a contagem correta; ordenação por emissão mais antiga.
- **Cockpit/Cockpit Executivo**: NF multi-produto parcial não subtrai o produto pendente do trânsito local (Parte A); não some da lista sem-mapa (Parte B).
- **Pendências Fiscais**: filhote parcial aparece como parcial, não como recebida.
- **Auto-desativação do mapa**: mapa com produto pendente permanece ativo mesmo que a NF (por outro sinal) pareça resolvida.

## 3. UAT (dados reais)

1. No momento da investigação (16/07), havia **15 filhotes mapeadas pendentes** em UAT — confirmar que a fila real reproduz esse número (ou o número atual, se já tiver mudado) ao abrir a tela sem NF.
2. Escolher uma NF filhote real da lista, receber pela tela (fluxo já validado na feature 013).
3. Reabrir a tela sem NF → confirmar que a NF recebida **saiu** da fila.
4. Conferir Cockpit e Pendências Fiscais antes/depois de um recebimento parcial real (se surgir um caso) — os números não devem contar o produto pendente como recebido.
