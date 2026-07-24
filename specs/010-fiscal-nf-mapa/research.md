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

---

## Amendment 2026-06-16 — decisões das correções + aba (ACXEGDP-183)

### Decision 7: "Filhote recebida" — fonte única vs. três fontes — **SUPERA a Decision 3**

**Decision**: recebida = `n_id_receb > 0` **OU** presença em `stockbridge.movimentacao` (subtipo='importacao') **OU** em `stockbridge.movimentacao_legado`. *(Fix 1)*

**Rationale**: A Decision 3 (só `n_id_receb`) assumia que todo recebimento reflete no ERP. Falso para o histórico: filhotes recebidas no legado MySQL nunca tiveram `n_id_receb` preenchido no OMIE — ficavam pendentes para sempre. Medido em UAT: das 97 filhotes ativas, 0 tinham `n_id_receb>0`; 68 estavam em movimentacao/legado. A definição DEVE ser idêntica em cockpit, aba e auto-desativação (FR-013).

**Alternatives**: manter só `n_id_receb` (rejeitado — inflava a posição fiscal permanentemente).

### Decision 8: Recebimento parcial — pedido inteiro vs. saldo — **SUPERA parte da Decision 2**

**Decision**: pendência da Parte A = `GREATEST(pc.nqtde − Σ q_com das filhotes já recebidas, 0)`, por (pedido, produto). *(Fix 3)*

**Rationale**: A Decision 2 usava `nqtde` inteiro do pedido como quantidade — correto enquanto nada foi recebido, mas em recebimento parcial conta também as filhotes já recebidas (que já entraram no físico) → quase-dupla-contagem com o estoque. As filhotes são NFs com `q_com` conhecido, então o saldo é exato. Pedido sem filhote mantém `nqtde` cheio.

**Alternatives**: somar `q_com` das filhotes pendentes (rejeitado — filhote pendente pode não ter NF emitida, sem `q_com`); manter pedido inteiro (rejeitado — dupla contagem).

### Decision 9: Anti dupla contagem A+B no fallback — **Fix 2**

**Decision**: o fallback CFOP 3.xxx (Parte B) exclui NFs que sejam **mãe OU filhote** de mapa ativo (antes só excluía a mãe).

**Rationale**: filhote tem CFOP 3 e caía no fallback; como o pedido já é contado na Parte A, o mesmo volume contava 2×. Medido em UAT: 670.750 kg (25 filhotes) de dupla contagem.

**Extensão (Fix 4, 2026-06-16)**: a exclusão passou de "mapa **ativo**" para "**qualquer** mapa (ativo ou inativo)". Quando um mapa é desativado (pedido totalmente recebido), sua NF mãe (CFOP 3, que nunca recebe `n_id_receb` e não entra em movimentacao/legado) deixava de ser excluída e **vazava** no fallback como falsa pendência. O sync PROD→UAT de 2026-06-16 desativou 240 mapas e expôs isso: ~298 t de falsa pendência. Princípio: o fallback é só para importações **sem mapa** — uma NF que pertence a qualquer mapa nunca deve cair nele.

### Decision 10: Sinal de inconsistência "chegou — NF aberta" — **FR-015**

**Decision**: sinaliza pedidos com ≥1 filhote de **NF emitida** (liberada p/ transporte) ainda não recebida **e** que não estão mais em trânsito no FUP.

**Rationale**: pega o extravio (embarcou e sumiu) sem falso-positivo de pedido recém-mapeado (que ainda não emitiu filhotes, logo sem lote no FUP por ser recente, não por ter chegado). Critério "por NF emitida" é mais preciso que "recebido>0" (não pega só parcial) e que "qualquer saldo" (evita falso-positivo).

### Decision 11: Dimensão temporal (exoneração + aging) — **FR-019..021**

**Decision**: data de entrada em exoneração = **emissão da NF mãe** (NF mãe emitida ⟺ foi para exoneração de ICMS, confirmado 2026-06-15); dias em exoneração = hoje − essa data. Aging da filhote = hoje − `d_emi` da NF filhote. Faixas (dentro do prazo/atenção/crítico) configuráveis, default alinhado ao `config_produto.lead_time_dias`; dias sempre exibidos.

**Rationale**: tudo derivável de `d_emi` das NFs já no Postgres — sem nova fonte/coluna. Se a FUP expuser uma data de estágio dedicada, ela substitui o proxy da NF mãe.

### Decision 12: Base de convergência (SC-002) — reformulada

**Decision**: convergência ≤5% contra `transito_local + saldo de filhotes pendentes de pedidos em recebimento + importações sem mapa` (não contra o "Trânsito para Galpão" puro).

**Rationale**: a pendência fiscal legitimamente excede o `transito_local` (fiscal vê filhote-a-filhote; FUP vê o pedido). O alvo antigo reprovaria mesmo com cálculo correto.

### Decision 13: Recebimento manual não lançado (reconciliação) — 2026-06-17

**Decision**: NFs recebidas fisicamente / manual no OMIE mas nunca lançadas em sistema (n_id_receb=0, ausentes de movimentacao/legado/MySQL) são reconciliadas inserindo direto em `stockbridge.movimentacao_legado`, marcadas `id_movest_*='MANUAL-ACXEGDP-183'`. **Não** receber via Atlas.

**Rationale**: receber via Atlas dispararia escrita no OMIE (`IncluirAjusteEstoque`) → duplicaria o recebimento manual já feito lá. A tabela de legado é só referência de leitura do cálculo — inserir nela reconhece o recebimento sem tocar no OMIE. Caso aplicado: 4 filhotes dos pedidos 455/485 (100.500 kg). Reversível pelo marcador.

### Decision 14: Fonte da `movimentacao_legado` em PROD — copiar da UAT (MySQL desativado)

**Decision**: no go-live, popular `stockbridge.movimentacao_legado` em prod **copiando da UAT** (não recriar do MySQL).

**Rationale**: o **MySQL legado foi desativado** — "recriar do MySQL" deixou de existir. A `movimentacao_legado` da UAT é a única cópia sobrevivente (auditada limpa: 866 one-shot + 4 manuais marcadas). O espelho vivo `tb_movimentacao_q2p_legado` nunca será populado (sem fonte) → fonte permanente é a tabela congelada; `migrate-from-mysql.ts` fica obsoleto. **Supera** a recomendação anterior (recriar do MySQL), que assumia o MySQL ativo.
