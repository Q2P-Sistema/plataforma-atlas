# Checklist de Validação — Módulo StockBridge

Roteiro de validação manual em camadas. Cada camada depende da anterior — não vale pular para testar saídas se os cadastros base não estão sãos.

**Como usar**: marque `- [x]` quando confirmar. Anote observações ou divergências em itálico abaixo do item.

**DB de teste**: `localhost:5436` (PG do dev).

**OMIE**: em dev rode com `OMIE_MODE=mock` para evitar bater na API real (exceto se quiser testar T051/T052 sandbox).

---

## Ordem de execução

```
Camada 0  →  Cadastros base (sem isso nada funciona)
Camada 1  →  Pipeline de entrada (Trânsito → Recebimento → Aprovação)
Camada 2  →  Visibilidade (Movimentações, Cockpit)
Camada 3  →  Saídas (Automática + Manual)
Camada 4  →  Visão executiva (Métricas + Fornecedores)
Camada 5  →  Incidentes (Operações pendentes — só com cenário forçado)
```

---

## Camada 0 — Cadastros base

Sem cadastros sãos, todos os fluxos abaixo falham. **Validar primeiro.**

### 1. Localidades + correlação ACXE↔Q2P ✅

- [x] Toda localidade ativa **física** tem correlação completa (ACXE **e** Q2P preenchidos)

```sql
SELECT l.codigo, l.nome, l.tipo, l.cnpj,
       lc.codigo_local_estoque_acxe, lc.codigo_local_estoque_q2p
FROM stockbridge.localidade l
LEFT JOIN stockbridge.localidade_correlacao lc ON lc.localidade_id = l.id
WHERE l.ativo = true
ORDER BY l.codigo;
```

**Critério (refinado)**: nenhuma localidade `proprio`, `tpl`, `porto_seco` com NULL em ACXE/Q2P. NULL em Q2P é aceitável para `virtual_ajuste` (estoque ACXE-only de retenção como VARREDURA), porém esse caso foi removido da base — estoques especiais ACXE vivem hardcoded em [estoques-especiais-acxe.ts](modules/stockbridge/src/services/estoques-especiais-acxe.ts).

_Resultado: 4 físicas (11.1, 12.1, 21.1, 31.1) com correlação completa. Linhas virtuais 10.0.3 VARREDURA e 90.0.2 TRANSITO removidas — não eram referenciadas pelo código (usado direto via constantes TS)._

- [x] Listagem da UI funciona (operador vê, gestor vê — sem edição)
- [x] Tipos válidos: `proprio`, `tpl`, `porto_seco`, `virtual_transito`, `virtual_ajuste`

_Notas: `tpl` = 3PL (Third-Party Logistics, ex: ATN). UI mostra "3PL" como label. Sem CHECK constraint no DB — sincronização entre [types.ts:99](modules/stockbridge/src/types.ts#L99), [schemas/stockbridge.ts:29](packages/db/src/schemas/stockbridge.ts#L29) e [LocalidadesPage.tsx:4](apps/web/src/pages/stockbridge/gestor/LocalidadesPage.tsx#L4) é manual._

_UI vira read-only no commit `b8bb589` — botões "+ Nova / Editar / Desativar" removidos. Edição via API direta ainda permitida para gestor+ (uso administrativo)._

---

### 2. Correlação de produtos ACXE↔Q2P (match por descrição) ✅

- [x] Listar produtos sem correlato Q2P

```sql
SELECT a.codigo_produto AS cod_acxe, a.descricao,
       q.codigo_produto AS cod_q2p
FROM public."tbl_produtos_ACXE" a
LEFT JOIN public."tbl_produtos_Q2P" q ON a.descricao = q.descricao
WHERE (a.inativo IS NULL OR a.inativo <> 'S')
ORDER BY q.codigo_produto IS NULL DESC, a.descricao;
```

**Critério (refinado)**: produtos com `cod_q2p` NULL **e** com movimentação ACXE recente bloqueiam recebimento. NULL em legacy/stale ou ACXE-only (`CPT *`) é aceitável.

_Auditoria 2026-04-28:_
- _499 ACXE ativos · 308 sem correlato Q2P (62%) · só **19** com mov ACXE últimos 90 dias_
- _17 dos 19 são `CPT *` (ACXE-only, esperado)_
- _**Follow-ups (não bloqueiam validação)**:_
  - _`SUCATA DE PE` (4505583526) — existe Q2P como `SUCATA DE PE REC` (3033097699). Renomear ACXE OU criar Q2P "SUCATA DE PE"_
  - _`RECICLADO DE PEAD` (4464829204) — sem candidato óbvio. Decidir: criar Q2P ou aceitar como ACXE-only_

- [x] Tentar receber NF de produto sem correlato → resposta 409 `PRODUTO_SEM_CORRELATO` + email admin disparado

_Validado via teste de unidade ([recebimento.service.ts:235-249](modules/stockbridge/src/services/recebimento.service.ts#L235-L249)). Smoke E2E real fica como item de T056._

---

### 3. Indicadores por Produto ✅

Migrations 0017 → 0023 + commits `e139775`, `2c2adc5`, `80622c6`, `8de1059`, `c752cf3` resolveram este item por completo.

- [x] Cada produto ACXE ativo de família relevante tem linha em `stockbridge.config_produto`
- [x] Trigger `trg_auto_popular_config_produto` cria linha automaticamente para produto ACXE novo (consumo entra como NULL — backfill via refresh)
- [x] UI virou listagem **read-only** com nome "Indicadores por Produto" (sem botão Editar/PATCH); ordenação por consumo desc; coluna "Regra" mostra qual camada do fallback gerou o número
- [x] Audit log (`shared.audit_log`) ativo via triggers da 0008

```sql
-- Estado atual (esperado: ~195 plásticos, distribuídos entre 4 camadas)
SELECT
  COALESCE(camada_consumo, 'NULL (Sem dados)') AS camada,
  COUNT(*) AS qtd
FROM stockbridge.config_produto
GROUP BY 1 ORDER BY 1;

-- Mapping de família (com nome completo da 0020)
SELECT familia_atlas, nome_completo, COUNT(*) AS familias_omie, bool_and(incluir_em_metricas) AS todas_ativas
FROM stockbridge.familia_omie_atlas
GROUP BY familia_atlas, nome_completo ORDER BY familia_atlas;
```

**Critério (refinado)**:
- `config_produto` populada via trigger AFTER INSERT em `tbl_produtos_ACXE` e backfill — só produtos cuja família OMIE está em `stockbridge.familia_omie_atlas` com `incluir_em_metricas=true` (PE/PP/PS/PET/ABS/ADITIVO/PIGMENTO). Famílias `USO E CONSUMO`, `ATIVO IMOBILIZADO`, `STRETCH`, `INDUSTRIALIZADO`, `UNIFORMES`, `LOCAÇÃO` ficam **fora** por design.
- `consumo_medio_diario_kg` é calculado via função `stockbridge.calcular_consumo_medio_diario_kg(p_codigo_acxe)` que retorna `(consumo, camada)` aplicando fallback de **3 camadas**:
  - **`70/30`** — composição 70% × média últimos 90d + 30% × média do mesmo mês do ano anterior (preferida — captura sazonalidade quando há histórico anual).
  - **`90d`** — média dos últimos 90 dias (tendência recente, sem termo sazonal).
  - **`365d`** — média de 365 dias (fallback p/ produto com vendas antigas mas zero recente).
  - **`NULL`** — sem vendas em 365 dias em nenhuma fonte → UI mostra "Sem dados" (em vez do antigo default 100).
- A função soma **3 fontes** filtradas: Q2P matriz + ACXE-externo + Q2P_Filial (histórica). Match cross-empresa por descrição textual (códigos OMIE são aleatórios por empresa).
- Filtros aplicados em todas as fontes: `faturado='S'`, `cancelado<>'S'`, `devolvido<>'S'`, `devolvido_parcial<>'S'`, `denegado<>'S'`, `excluido_omie=false` (exceto Filial que ainda não tem essa coluna), e exclusão de **intercompany** por código de cliente:
  - ACXE: exclui clientes Q2P matriz (`4151024070`) e Filial (`4151026325`)
  - Q2P matriz: exclui clientes ACXE × 3 (`8429046131`, `3070534015`, `8429031700`) e Filial (`3105160549`)
  - Filial: exclui clientes ACXE (`4554041504`) e Q2P matriz (`4460161229`)
- Refresh automático: `stockbridge.refresh_consumo_medio_se_stale(ttl_minutes)` reaplica a função em todos os produtos quando `MAX(updated_at)` é mais antigo que o TTL (default 60min). Chamado pelo service no GET da listagem.

_Resultado (snapshot 2026-04-29 após coletas Q2P matriz + Filial)_:
- _195 produtos plásticos em `config_produto`_
- _Distribuição: 44 em `70/30`, 51 em `90d`, 23 em `365d`, 77 em `Sem dados`_
- _Validado com 4 produtos manualmente: HDB5502 (90d), CRP100 PRETO (90d, produto novo), HD6070UA (70/30), EM5333AAH (70/30 — caso "padrão ouro")_

---

## Camada 1 — Pipeline de entrada

### 4. Trânsito marítimo ✅

Migration 0024 + commit `e5f5a4b` viraram este item read-only espelho do FUP de Comex.

- [x] `GET /api/v1/stockbridge/transito` retorna lotes em status=`transito` (52 lotes ativos pós-0024)
- [x] Todos os perfis (operador, gestor, diretor) veem os 3 estágios (`transito_intl`, `porto_dta`, `transito_interno`) — RBAC aberto pq módulo é só visualização
- [x] Estágio `reservado` removido da UI (sem definição clara, sem populador) — segue no enum por compat
- [x] PATCH `/avancar` removido — pipeline e avanços de etapa são mantidos direto no FUP, não no Atlas
- [x] Função `stockbridge.refresh_lotes_em_transito_se_stale(ttl)` lê FUP × `tbl_pedidosCompras_ACXE` e UPSERT em `stockbridge.lote` (TTL 15min, soft-delete dos que sairam da janela)
- [x] Card mostra: PC do pedido, fornecedor, país, kg, R$/kg, etapa FUP, DI/protocolo, terminal/despachante, datas (ETD/ETA/Desemb/Liber/Armaz/Free time), data limite por estágio + flag atrasado

```sql
-- Sanidade pos-0024
SELECT estagio_transito, COUNT(*) AS lotes,
       ROUND(SUM(quantidade_fiscal_kg)/1000.0, 1) AS toneladas,
       COUNT(DISTINCT pedido_compra_acxe) AS pedidos
FROM stockbridge.lote
WHERE status = 'transito' AND ativo = true AND pedido_compra_acxe IS NOT NULL
GROUP BY estagio_transito
ORDER BY estagio_transito;
```

_Snapshot 2026-04-29: 33 lotes em `transito_intl` (~2.534 t), 10 em `porto_dta` (~716 t), 9 em `transito_interno` (~793 t), totalizando ~4.043 toneladas em trânsito visíveis no Cockpit/Métricas._

_Bug colateral descoberto e corrigido (commit `6d3ed1f`): `calcularExposicaoCambial`, `calcularCMP` e `getTabelaAnalitica` em metricas.service.ts tratavam `custo_brl_kg` como USD/ton, gerando valores 1000× errados. Antes da 0024 o estoque era praticamente vazio e o bug nem aparecia. Agora retornam BRL/kg honesto._

_Outro desacoplamento (mesmo commit): PTAX migrada de dynamic-import('@atlas/hedge') (que sempre falhava silenciosamente, caindo no fallback hardcode 5.0 — UI mostrava "BCB" mas era mentira) para `@atlas/integration-bcb` direto, com cache em memória de 30min._

---

### 5. Recebimento de NF ✅

_Validado manualmente pelo diretor antes da sessão de validação automatizada — fluxo cobre os cenários funcionais e a idempotência da migration 0016. Marcamos como completo sem reproduzir cada cenário individualmente. Cenários OMIE de erro (T051/T052) ficam pra teste de sandbox real, não dev._

#### Cenários funcionais

#### Cenários funcionais
- [x] **Sem divergência**: qtd recebida = qtd NF (tolerância ±1 kg) → lote vira `provisorio`, movimentação gravada com ambos lados OMIE
- [x] **Com divergência `faltando`**: qtd recebida < qtd NF → cria aprovação pendente nível gestor
- [x] **Com divergência `varredura`**: idem mas tipo diferente
- [x] **Tentar receber qtd > NF**: rejeitado com erro (legado também rejeita)
- [x] **Re-tentar mesma NF**: 409 `NF_JA_PROCESSADA`
- [x] **Operador sem armazém vinculado**: 403 (middleware `requireArmazemVinculado`)
- [x] **Produto sem correlato**: 409 + email admin

#### Cenários de erro OMIE
- [x] **ACXE-fail**: 502 com `userAction='retry'`, `stateClean=true`. Confirmar que `stockbridge.movimentacao` ficou vazio (nenhuma linha gravada)
- [x] **Q2P-fail após ACXE ok**: 502 com `userAction='retry_q2p'`, `stateClean=false`, `tentativasRestantes=1`. Confirmar movimentação gravada com `status_omie='pendente_q2p'`
- [x] Para forçar Q2P-fail em dev: editar [mock.ts:67-87](modules/stockbridge/src/stockbridge/mock.ts#L67-L87) para `mockIncluirAjusteEstoque` rejeitar quando `cnpj === 'q2p'` apenas na 1ª chamada

#### Verificação pós-recebimento
```sql
SELECT m.created_at, m.nota_fiscal, m.tipo_movimento, m.subtipo,
       m.quantidade_kg, m.status_omie, m.op_id,
       m.id_movest_acxe, m.id_movest_q2p,
       l.codigo AS lote, l.status AS lote_status
FROM stockbridge.movimentacao m
LEFT JOIN stockbridge.lote l ON l.id = m.lote_id
WHERE m.created_at > now() - interval '1 day'
ORDER BY m.created_at DESC;
```

**Critério**: caminho feliz tem ambos `id_movest_acxe` e `id_movest_q2p` preenchidos + `status_omie='concluida'`. Caso parcial: apenas ACXE preenchido + `status_omie='pendente_q2p'`.

---

### 6. Aprovações hierárquicas ✅

_Validado manualmente pelo diretor junto com o item 5 — RBAC, divergências, rejeição+re-submissão e cenários de idempotência OMIE durante aprovar() funcionando._

#### Cenários
- [x] Gestor lista pendências em `GET /aprovacoes` (vê só nível gestor)
- [x] Diretor lista em `GET /aprovacoes` (vê gestor + diretor)
- [x] Operador chama `GET /aprovacoes` → 403
- [x] Gestor aprova divergência `faltando` → OMIE chamado 3x (ACXE, Q2P, ACXE-faltando), movimentação gravada, lote vira `provisorio`
- [x] Gestor aprova divergência `varredura` → 3a chamada vai pra estoque ACXE_VARREDURA correto (Extrema vs não-Extrema)
- [x] Gestor rejeita com motivo → operador recebe email + lote vira `rejeitado`
- [x] Operador re-submete em `GET /aprovacoes/minhas-rejeicoes` → cria nova aprovação pendente, lote volta a `aguardando_aprovacao`
- [x] Gestor tenta aprovar pendência nível diretor (ex: comodato) → 403 `APROVACAO_NIVEL_INSUFICIENTE`
- [x] Diretor aprova pendência nível gestor (hierarquia funciona)
- [x] Aprovar pendência já aprovada/rejeitada → 409 `APROVACAO_STATUS_INVALIDO`

#### Cenários OMIE durante aprovação (US4 idempotência)
- [x] Q2P falha durante aprovar() → aprovação fica `aprovada` mesmo assim, response 200 com `pendenciaOmie={lado:'q2p',opId,movimentacaoId}`
- [x] `transferirDiferencaAcxe` falha → response 200 com `pendenciaOmie={lado:'acxe-faltando'}`

#### Verificação
```sql
SELECT a.id, a.tipo_aprovacao, a.precisa_nivel, a.status,
       a.quantidade_prevista_kg, a.quantidade_recebida_kg,
       a.tipo_divergencia, a.lancado_em, a.aprovado_em,
       l.codigo AS lote, l.status AS lote_status
FROM stockbridge.aprovacao a
JOIN stockbridge.lote l ON l.id = a.lote_id
ORDER BY a.lancado_em DESC LIMIT 30;
```

---

## Camada 2 — Visibilidade consolidada

### 7. Movimentações

- [ ] `GET /api/v1/stockbridge/movimentacoes` lista com filtros (NF, tipo, data, lote)
- [ ] Soft delete (`ativo=false`) some da listagem default mas continua em `?incluir_inativas=true`
- [ ] Toda operação das camadas 1+3+4 tem rastro aqui
- [ ] Filtrar por `status_omie != 'concluida'` mostra pendências (mesmo conteúdo de operações pendentes)

```sql
-- Sanidade: nenhuma movimentação ativa sem id_movest_acxe (todas devem ter pelo menos ACXE)
SELECT count(*) FILTER (WHERE id_movest_acxe IS NULL) AS sem_acxe,
       count(*) FILTER (WHERE id_movest_q2p IS NULL AND status_omie = 'concluida') AS q2p_null_mas_concluida_BUG,
       count(*) AS total
FROM stockbridge.movimentacao
WHERE ativo = true;
```

**Critério**: `q2p_null_mas_concluida_BUG = 0`. Se >0, é inconsistência grave (status diz concluída mas Q2P ID está vazio).

---

### 8. Cockpit de estoque

- [ ] `GET /api/v1/stockbridge/cockpit` retorna posição consolidada por produto (gestor+)
- [ ] Operador → 403
- [ ] Soma do cockpit bate com SQL direto:

```sql
SELECT produto_codigo_acxe,
       SUM(quantidade_fisica_kg) FILTER (WHERE status = 'provisorio')   AS provisorio_kg,
       SUM(quantidade_fisica_kg) FILTER (WHERE status = 'reconciliado') AS reconciliado_kg,
       SUM(quantidade_fisica_kg) FILTER (WHERE status = 'transito')     AS transito_kg
FROM stockbridge.lote
WHERE ativo = true
GROUP BY produto_codigo_acxe
ORDER BY produto_codigo_acxe;
```

- [ ] Filtros por localidade, CNPJ funcionam
- [ ] Sparklines/histórico (se houver) batem com `created_at` das movimentações

---

## Camada 3 — Saídas

### 9. Saída automática (webhook n8n)

- [ ] Workflow `stockbridge-saida-automatica.json` importado no n8n
- [ ] `ATLAS_INTEGRATION_KEY` configurada (server + n8n)
- [ ] `curl POST` direto ao endpoint com header `X-Atlas-Integration-Key` simula n8n:

```bash
curl -X POST http://localhost:3000/api/v1/stockbridge/saida-automatica \
  -H "Content-Type: application/json" \
  -H "X-Atlas-Integration-Key: $ATLAS_INTEGRATION_KEY" \
  -d '{"nf":"99999","cnpj":"q2p"}'
```

- [ ] NF nova → `idempotente=false`, baixa estoque ACXE+Q2P
- [ ] Mesma NF de novo → `idempotente=true`, sem nova chamada OMIE
- [ ] Sem header de integração → 401
- [ ] CNPJ inválido → 400

```sql
SELECT nota_fiscal, tipo_movimento, quantidade_kg,
       id_movest_acxe, id_movest_q2p, created_at
FROM stockbridge.movimentacao
WHERE tipo_movimento = 'saida_automatica' AND ativo = true
ORDER BY created_at DESC;
```

---

### 10. Saída manual

- [ ] Cada subtipo gera aprovação no nível correto:

| Subtipo | Nível esperado |
|---|---|
| `transf_intra_cnpj` | gestor |
| `comodato` | **diretor** |
| `amostra` | gestor |
| `descarte` | gestor |
| `quebra` | gestor |
| `inventario_menos` | gestor |
| `inventario_mais` | gestor |
| `entrada_manual` | gestor |

- [ ] Operador lança saída → cria pendência → gestor/diretor aprova → OMIE chamado
- [ ] Tentar lançar saída de produto inexistente → erro
- [ ] Tentar saída com qtd > saldo disponível → bloqueado (ou aprovação especial?)
- [ ] Verificar audit log da saída em `shared.audit_log`

---

## Camada 4 — Visão executiva

### 11. Métricas (diretor)

- [ ] `GET /api/v1/stockbridge/metricas` retorna KPIs (diretor only)
- [ ] Gestor → 403
- [ ] Métricas batem com agregação manual:
  - Consumo médio diário = saídas dos últimos N dias / N
  - Lead time real vs configurado em `config_produto`
  - Giro = saídas / estoque médio
  - Breakdown por `familia_categoria`
- [ ] Produtos com `incluir_em_metricas=false` excluídos
- [ ] Filtros por período funcionam

---

### 12. Fornecedores

- [ ] `GET /api/v1/stockbridge/fornecedores/exclusoes` lista exclusões ativas
- [ ] Excluir fornecedor → marca em `stockbridge.fornecedor_exclusao`, audit log gravado
- [ ] Reincluir fornecedor → atualiza `reincluido_em` + `reincluido_por`
- [ ] Fornecedor excluído some das listagens de NF/lote (UI)
- [ ] Histórico de exclusões/reinclusões preservado:

```sql
SELECT fornecedor_cnpj, fornecedor_nome, motivo,
       excluido_em, excluido_por, reincluido_em, reincluido_por
FROM stockbridge.fornecedor_exclusao
ORDER BY excluido_em DESC;
```

---

## Camada 5 — Incidentes (caso especial)

### 13. Operações pendentes (idempotência OMIE)

Só aparecem em **incidente real** ou **forçado em dev**.

#### Como forçar em dev
1. [ ] Editar [mock.ts](packages/integrations/omie/src/stockbridge/mock.ts) para `mockIncluirAjusteEstoque` jogar erro quando `cnpj === 'q2p'`
2. [ ] Fazer `POST /recebimento` → response 502 com `tentativasRestantes=1`, `movimentacaoId` no body
3. [ ] Email de pendência disparado pra admin (verificar inbox/log)
4. [ ] Como operador, `POST /operacoes-pendentes/:id/retentar` (mock ainda quebrado) → 502, `tentativasRestantes` decremena (na próxima vez vira 0 → 403 `OPERADOR_SEM_RETENTATIVAS`)
5. [ ] Restaurar mock para Q2P sucesso
6. [ ] Como operador, retentar de novo → 200, movimentação vira `status_omie='concluida'`

#### Cenários adicionais
- [ ] Como gestor, `GET /operacoes-pendentes` lista pendentes
- [ ] Operador chama `GET /operacoes-pendentes` → 403
- [ ] Gestor retenta sem limite (mesmo com `tentativas_q2p` alto)
- [ ] Gestor `POST /:id/marcar-falha` com motivo → status vira `falha`, sai do painel

#### Verificação
```sql
SELECT id, op_id, status_omie, tentativas_q2p, tentativas_acxe_faltando,
       ultimo_erro_omie, nota_fiscal,
       id_movest_acxe IS NOT NULL AS acxe_ok,
       id_movest_q2p IS NOT NULL  AS q2p_ok
FROM stockbridge.movimentacao
WHERE status_omie <> 'concluida' AND ativo = true
ORDER BY created_at DESC;
```

**Critério**: para `pendente_q2p` deve ter `acxe_ok=true, q2p_ok=false`. Para `pendente_acxe_faltando` ambos devem ser `true` (a falha foi na 3ª chamada ACXE-faltando, não no dual principal).

---

## Validação cruzada (após todas as camadas)

- [ ] **Audit log completo**: toda operação das camadas 1, 3, 4 tem entrada em `shared.audit_log`

```sql
SELECT operation, table_name, count(*)
FROM shared.audit_log
WHERE schema_name = 'stockbridge'
  AND created_at > now() - interval '1 day'
GROUP BY operation, table_name
ORDER BY count(*) DESC;
```

- [ ] **Sem órfãos**: nenhum lote sem movimentação correspondente (exceto trânsito ainda não recebido)

```sql
SELECT l.codigo, l.status, l.dt_entrada
FROM stockbridge.lote l
LEFT JOIN stockbridge.movimentacao m ON m.lote_id = l.id AND m.ativo = true
WHERE l.ativo = true AND l.status NOT IN ('transito', 'rejeitado')
  AND m.id IS NULL;
```

**Critério**: lista vazia. Se aparecer algo, é lote criado sem movimentação (bug ou estado intermediário).

- [ ] **Soma kg física vs fiscal**: divergências documentadas em `stockbridge.divergencia`

```sql
SELECT l.codigo, l.quantidade_fisica_kg, l.quantidade_fiscal_kg,
       l.quantidade_fisica_kg - l.quantidade_fiscal_kg AS delta,
       d.tipo AS divergencia_tipo, d.status AS divergencia_status
FROM stockbridge.lote l
LEFT JOIN stockbridge.divergencia d ON d.lote_id = l.id
WHERE l.ativo = true
  AND ABS(l.quantidade_fisica_kg - l.quantidade_fiscal_kg) > 1
ORDER BY ABS(l.quantidade_fisica_kg - l.quantidade_fiscal_kg) DESC;
```

**Critério**: para todo lote com delta > 1 kg, deve haver linha em `divergencia`.

---

## Sinal de pronto para produção

Quando **todas** estas condições baterem:

- [ ] Camadas 0-4 com checks verdes em ambiente UAT
- [ ] Camada 5 testada com cenário forçado (T056 do tasks-idempotencia-omie.md)
- [ ] T051 + T052 (sandbox OMIE real) executados e documentados em `research.md`
- [ ] 2 semanas de validação paralela com legado sem divergência nova (`paridade-criterios.md`)
- [ ] `MODULE_STOCKBRIDGE_ENABLED=true` em prod com flag staged

---

## Observações livres

_Use esta seção para anotar bugs encontrados, decisões tomadas durante a validação, ou itens que precisam de follow-up:_

- _(adicione conforme for testando)_
