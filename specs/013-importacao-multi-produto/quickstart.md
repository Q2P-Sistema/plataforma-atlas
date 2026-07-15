# Quickstart — Validação do Recebimento Multi-Item de Importação

**Feature**: 013-importacao-multi-produto | **Date**: 2026-07-15

Como exercitar a feature em dev (mock), em teste automatizado e em UAT/PROD (OMIE real). Segue a disciplina do StockBridge: **dev é sanitizado e OMIE defasado**, então paridade de valores confirma-se contra PROD/UAT (Princípio V).

---

## 1. Dev local (OMIE_MODE=mock)

```bash
export OMIE_MODE=mock          # fixtures sintéticas, não bate na API OMIE
pnpm --filter @atlas/api dev
pnpm --filter @atlas/web dev
```

Adicionar em `packages/integrations/omie/src/stockbridge/mock.ts` fixtures de NF **multi-item**: uma NF com 3 produtos (todos com correlato), uma com 1 produto sem correlato, uma com um produto divergente. `mockConsultarNF` passa a devolver `itens[]`.

**Fluxo manual (US1 — happy path):**
1. Recebimento de importação → buscar a NF mock de 3 produtos.
2. A tela lista **3 itens** (produto/valor read-only, qtd física e localidade editáveis) — não bloqueia.
3. Manter as quantidades = NF; confirmar.
4. Esperado: 3 entradas `provisorio`, cada uma com OMIE ACXE+Q2P; resumo "3 recebidos". Conferir no mock (`ajustesRegistrados`) que há 6 ajustes (3 ACXE-trf + 3 Q2P-ent) com `cod_int_ajuste` distintos por produto.

**US2 — divergência por item:** na mesma NF, baixar a qtd física de 1 item (ex.: −320 kg) mantendo os outros 2. Confirmar informando motivo + faltando/varredura no item divergente. Esperado: 2 itens `provisorio`, 1 `aguardando_aprovacao`; **um** e-mail ao gestor listando o item pendente. Aprovar o item → OMIE dual + transferência da diferença ao estoque especial; os outros 2 intactos.

**US3 — tudo-ou-nada:** buscar a NF mock com 1 produto sem correlato. Confirmar. Esperado: `409 PRODUTO_SEM_CORRELATO` nomeando o produto pela descrição; **zero** ajustes no mock; nenhum lote criado.

**Resumível:** simular falha de Q2P num item (fixture de erro). Confirmar NF de 3 → 2 `provisorio` + 1 `pendente_q2p`. Re-`POST` da mesma NF → só o item pendente é reprocessado; os 2 concluídos não duplicam.

---

## 2. Testes automatizados (Vitest)

```bash
pnpm --filter @atlas/stockbridge test
pnpm --filter @atlas/integrations-omie test
pnpm --filter @atlas/stockbridge exec tsc --noEmit
```

Cobrir:
- **Rateio** (função pura): 3 itens com valores distintos → `Σ valorItem = vNF` exato; N=1 → `valorItem = vNF` (invariância vs. `calcularValorUnitarioAcxe/Q2p` atuais).
- **`consultarNF`**: mapeia `raw.det[]` (N) → `itens[]`; não lança em `det.length>1`.
- **Portão 1 (tudo-ou-nada)**: 1 de 3 sem correlato → nenhuma escrita; erro nomeia o produto.
- **Portão 2 (best-effort)**: Q2P falha em 1 item → outros concluem; item vira `pendente_q2p`.
- **Idempotência por produto**: 2º produto da mesma NF **não** viola o índice; re-processar NF parcial completa só os faltantes; mesmo produto duas vezes → 2ª colide (409).
- **Divergência por item**: item divergente → `aprovacao`; itens exatos → provisório; notificação consolidada (1 e-mail).
- **Regressão N=1**: a suíte single-item existente passa sem alteração de comportamento.
- **Supertest** das rotas: `POST /recebimento` com `itens[]` (201 com outcomes); 409/422 do Portão 1.

---

## 3. UAT / PROD (OMIE real)

Pré-condição: `OMIE_MODE=real` + credenciais ACXE/Q2P; migration `0046` aplicada (via DBeaver, como as 0042–0045).

1. Escolher uma NF de importação **multi-produto real** (ex., das identificadas: NF 5336 = PEBD 101 + PEBD 323; NF 5288 = três PEBDs). Confirmar que os produtos têm correlato Q2P (senão cai no tudo-ou-nada — cadastrar antes).
2. Receber pela plataforma; conferir no OMIE que **cada** produto entrou em ACXE (transferência) e Q2P (entrada) com quantidade e valor da sua linha.
3. **Paridade de valor**: `Σ` dos valores lançados = total da NF; custo/kg de cada produto coerente com a linha (não inflado). Comparar com o que o processo manual teria feito.
4. **Idempotência**: repetir a busca/recebimento da mesma NF → bloqueado, sem duplicar OMIE.

> **Rollback**: a feature é destrava-e-itera; se algo sair errado numa NF, os itens já lançados ficam como `entrada_nf` normais (auditados, soft-delete disponível). Reverter a migration 0046 (voltar ao índice 0044) só é possível se não houver NF multi-item já recebida (senão o índice antigo violaria) — por isso validar em UAT antes de PROD.
