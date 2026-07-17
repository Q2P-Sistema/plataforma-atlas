# Contrato — Fila de Recebimento em Modo Real

**Feature**: 014-fila-recebimento-real | **Date**: 2026-07-16

Um endpoint muda de comportamento (`GET /fila` sem `nf`, hoje sempre vazio em modo real); nenhum endpoint novo é criado — a mudança é dentro da rota existente. Auth: `requireOperador` + `requireArmazemVinculado` (igual à busca por NF, sem exigir papel gestor).

---

## `GET /api/v1/stockbridge/fila` (sem `nf`)

**Query** (inalterada): `{ nf?: string, cnpj?: 'acxe'|'q2p' }` — quando `nf` **não** é informado, este é o caminho da fila real (antes: sempre `[]` em modo real; mock: 2 itens sintéticos fixos).

**Mudança**: devolve a lista de NFs filhote mapeadas, emitidas, com produto pendente — ordenada por data de emissão mais antiga primeiro.

**Resposta `200`**:
```jsonc
{ "data": [
    { "nfFilhote": "5390", "pedidoAcxeOmie": "12345",
      "produtosTotal": 1, "produtosPendentes": 1,
      "quantidadePendenteKg": 25500, "dtEmissao": "2026-07-16", "diasDesdeEmissao": 0 },
    { "nfFilhote": "5378", "pedidoAcxeOmie": "12340",
      "produtosTotal": 2, "produtosPendentes": 1,
      "quantidadePendenteKg": 10200, "dtEmissao": "2026-07-10", "diasDesdeEmissao": 6 }
  ], "error": null }
```
- Segundo exemplo: NF de 2 produtos onde 1 já foi recebido (`produtosPendentes: 1` de `produtosTotal: 2`) — o comportamento resumível da feature 013 refletido na fila.

**Fila vazia** (nenhuma pendência mapeada no momento): `200 { "data": [], "error": null }` — o frontend distingue esse caso (mensagem "fila vazia") do estado anterior a qualquer busca (que não existe mais para este caminho — a fila sempre carrega ao abrir a tela).

**Exclusões aplicadas na query** (não aparecem, nunca geram erro — são filtradas silenciosamente):
- NF mãe de qualquer mapa.
- Filhote cancelada/deletada no OMIE (mesmo critério de `nfValidaSql`, já usado por Pendências Fiscais).
- Filhote ainda não sincronizada no OMIE (`n_id_nf IS NULL`).
- Filhote com todos os produtos já recebidos.

**Erros**: nenhum novo — os mapeamentos existentes de `GET /fila` (`IMPORTACAO_APENAS_ACXE`, etc.) continuam valendo para o caminho com `nf`; o caminho sem `nf` só pode falhar com `500 FILA_FAIL` genérico (erro de banco), como hoje.

---

## Notas de compatibilidade

- **Busca por NF (com `nf`)**: inalterada — segue a feature 013 (multi-item, idempotência por produto, dois portões).
- **`ConferenciaModal`**: inalterado — a fila não interage com ele diretamente; o clique num item preenche o campo de busca e reaproveita o fluxo existente.
- **Modo mock**: os 2 itens sintéticos atuais (`IMP-2026-0301`/`0302`) continuam existindo para dev sem banco populado — a fila real é um caminho adicional, condicionado a `isMockMode()` como hoje.
