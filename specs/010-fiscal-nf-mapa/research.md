# Research: Posição Fiscal via Mapa NF Mãe/Filhote

**Feature Branch**: `010-fiscal-nf-mapa`  
**Date**: 2026-06-10

## Decision 1: Estrutura de tabelas — normalizada vs. flat

**Decision**: Duas tabelas normalizadas (`nf_pedido_mapa` + `nf_pedido_filhote`)

**Rationale**: Filhotes variam de 1 a 12 por pedido. Colunas flat (`nf_filhote_1..12`) obrigariam LEFT JOIN com COALESCE em todos os lugares e dificultaria a query de "alguma filhote não recebida". Tabela separada permite `EXISTS (SELECT 1 ... WHERE mapa_id = X AND n_id_receb = 0)` limpo.

**Alternatives considered**: 12 colunas flat na tabela do mapa — rejeitado por SQL verboso e impossibilidade de índice eficiente.

---

## Decision 2: Fonte de quantidade no cockpit — `nqtde` vs. soma das filhotes

**Decision**: `tbl_pedidosCompras_ACXE.nqtde` como quantidade do pedido

**Rationale**: A NF mãe cobre o pedido completo — sua quantidade é a mesma que o pedido de compra. As filhotes somam o total da mãe (confirmado Comex 10/06/2026) mas podem ter sync delay. Usar `nqtde` do pedido é mais estável e é o mesmo campo usado pelo pipeline de trânsito FUP (coerência).

**Alternatives considered**: Somar `q_com` das NF filhotes — rejeitado por sync delay e por NFs filhotes poderem ainda não estar sincronizadas.

---

## Decision 3: Critério de "recebido" — `n_id_receb > 0` vs. movimentacao Atlas

**Decision**: `n_id_receb > 0` em `tbl_nf_header_ACXE` (OMIE via Postgres)

**Rationale**: Para pedidos com mapa, o recebimento é registrado pelo OMIE quando o material chega ao galpão físico — o ERP atualiza `n_id_receb`. Não depende de o operador ter criado movimentacao em Atlas. Isso é correto e simplifica o fluxo do operador. NF filhote não sincronizada (`n_id_nf IS NULL`) = ainda pendente (LEFT JOIN trata corretamente).

**Alternatives considered**: Checar `stockbridge.movimentacao` com subtipo='importacao' — rejeitado porque exige ação do operador E duplicaria o critério já usado pelo fallback CFOP.

---

## Decision 4: Auto-desativação do mapa — trigger vs. verificação no upsert

**Decision**: Verificação no `upsertNfPedidoMapa` service (TypeScript) e/ou job de reconciliação no cockpit

**Rationale**: Auto-desativação ocorre quando TODAS as filhotes têm `n_id_receb > 0` no OMIE. Isso é detectado mais naturalmente no serviço ao calcular a posição fiscal (cockpit já verifica a condição). Trigger PG precisaria de acesso a `public."tbl_nf_header_ACXE"` que é tabela OMIE — cruzar tabelas de schemas diferentes em trigger PG é tecnicamente possível mas contraria o princípio de clareza (Princípio II). Alternatively, pode-se adicionar um endpoint de reconciliação chamado pelo n8n periodicamente.

**Alternative chosen for v1**: A desativação automática é verificada no service ao executar upsert — após cada upsert, verifica se todas filhotes ativas têm `n_id_receb > 0` e, se sim, seta `mapa.ativo = false`. Simples e sem dependências extras.

---

## Decision 5: Ingestão do mapa — n8n empurra via HTTP vs. polling

**Decision**: n8n empurra via `POST /api/v1/stockbridge/admin/nf-pedido-mapa`

**Rationale**: Consistent com o padrão Atlas (Princípio III — n8n não escreve SQL direto; usa endpoints HTTP Atlas). O workflow FUP existente (`hP7OrMQEs2av8Lj7`) é estendido para ler a aba "NF ENTRADA" e chamar o endpoint. Re-usar o mesmo workflow garante que quando FUP é atualizada, o mapa NF também é atualizado no mesmo ciclo.

---

## Decision 6: NF mãe nunca recebida — implicação para spec

**Decision**: Remover toda referência a "desativação quando NF mãe é recebida"

**Rationale**: Confirmado pelo time Comex (10/06/2026) — NF mãe tem flag "não gera estoque" e é designada para `21.1 Extrema (IMPORTADO)`. Nunca recebe `n_id_receb > 0`. Todo pedido sempre tem ≥1 filhote. Portanto o critério de desativação depende exclusivamente das filhotes.
