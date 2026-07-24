# Validação: Inconsistências NF Legado (MySQL) vs OMIE

> **Data**: 2026-06-09  
> **Context**: Posição fiscal usa histórico OMIE (`tbl_nf_header_*`), mas operações do legado estão em `stockbridge.movimentacao_legado`. Precisamos validar alinhamento.

---

## Problema

Quando migramos do MySQL legado para Atlas (2026-06-09 migration 0038):

1. **MySQL**: Histórico de ~866 linhas de recebimentos (`tb_movimentacao` → `stockbridge.movimentacao_legado`)
2. **OMIE**: NFs sincronizadas em `tbl_nf_header_*` com campo `n_id_receb` (0=não recebido, >0=recebido)
3. **Atlas**: Novos recebimentos vão para `stockbridge.movimentacao` com `subtipo='entrada_nf'`

**Risco**: Se uma NF foi marcada como recebida no MySQL legado MAS `n_id_receb` em OMIE permanece 0, ela vai:
- Contar como **Pendência Nacional** no cockpit (posição fiscal inflada)
- Criar divergência fictícia quando operador tentar receber de novo

---

## Queries de Validação

Execute estas queries **antes do cutover para PROD**:

### 1️⃣ **NFs "Zumbi": Recebidas no Legado mas Abertas em OMIE**

```sql
-- NFs que foram processadas no MySQL mas OMIE ainda acha que estão abertas
SELECT
  'ZUMBI: recebida no legado, aberta em OMIE' AS tipo_inconsistencia,
  h.n_nf,
  h.d_emi AS data_emissao,
  CURRENT_DATE - h.d_emi AS dias_aberta,
  ml.mv_acxe, ml.dt_acxe,
  ml.mv_q2p, ml.dt_q2p,
  ml.ativo AS legado_ativo,
  h.n_id_receb AS omie_receb_status
FROM public."tbl_nf_header_ACXE" h
INNER JOIN stockbridge.movimentacao_legado ml
  ON ml.nota_fiscal = h.n_nf
WHERE h.tp_nf = 0
  AND h.n_id_receb = 0  -- OMIE: aberta
  AND (ml.dt_acxe IS NOT NULL OR ml.dt_q2p IS NOT NULL)  -- Legado: recebida
  AND ml.ativo = true  -- ainda ativa no legado
  AND h.d_emi >= CURRENT_DATE - 180  -- últimos 180 dias
ORDER BY h.d_emi DESC;
```

**O que significa**: Essas NFs foram confirmadas no sistema antigo (MySQL) mas OMIE nunca foi atualizado. **Risco alto** para posição fiscal inflada.

**Ação**:
- Marcar como recebidas em OMIE (`n_id_receb > 0`) se realmente foram entregues
- Ou soft-deletar do legado se era erro

---

### 2️⃣ **NFs Muito Antigas com `n_id_receb = 0`**

```sql
-- NFs que estão abertas há MUITO tempo (fora do cutoff de 180 dias)
-- Indicam atraso extremo ou dados problemáticos
SELECT
  'ALERTA: NF muito antiga aberta' AS tipo_inconsistencia,
  h.n_nf,
  h.d_emi,
  CURRENT_DATE - h.d_emi AS dias_aberta,
  LEFT(i.cfop, 1) AS cfop_categoria,
  SUM(i.q_com)::numeric(15,2) AS kg_total,
  COUNT(*) AS qtd_itens,
  CASE
    WHEN CURRENT_DATE - h.d_emi > 180 THEN 'FORA DO CUTOFF 180d'
    WHEN CURRENT_DATE - h.d_emi > 120 THEN 'Muito antiga (>120d)'
    WHEN CURRENT_DATE - h.d_emi > 90 THEN 'Antiga (>90d)'
    ELSE 'Recente (<90d)'
  END AS classificacao
FROM public."tbl_nf_header_ACXE" h
JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
WHERE h.tp_nf = 0
  AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
  AND CURRENT_DATE - h.d_emi > 90
GROUP BY h.n_nf, h.d_emi, i.cfop
ORDER BY h.d_emi ASC;
```

**O que significa**: NFs que estão abertas há muito tempo (2024, 2025 cedo). Ou são atrasos reais de importação ou são "fantasmas" do legado.

**Ação**:
- Investigar cada uma: contactar fornecedor se realmente não chegou
- Ou marcar como recebida se já foi entregue (só OMIE não foi atualizado)
- NFs >180 dias NÃO contam na posição fiscal (cutoff), mas ainda assim aparecem como risco

---

### 3️⃣ **Importações Legado Não Reconciliadas em Atlas**

```sql
-- NFs de importação (CFOP 3.xxx) do legado que ainda não têm movimentacao em Atlas
SELECT
  'ALERTA: importação legado não reconciliada' AS tipo_inconsistencia,
  h.n_nf,
  h.d_emi,
  CURRENT_DATE - h.d_emi AS dias_aberta,
  SUM(i.q_com)::numeric(15,2) AS kg_total,
  COUNT(*) AS qtd_itens,
  ml.id AS legado_id,
  ml.dt_acxe,
  CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM stockbridge.movimentacao m
      WHERE m.ativo = true
        AND m.subtipo = 'importacao'
        AND m.nota_fiscal = h.n_nf
    ) THEN 'NÃO reconciliada em Atlas'
    ELSE 'Já em Atlas'
  END AS status_atlas
FROM public."tbl_nf_header_ACXE" h
JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
LEFT JOIN stockbridge.movimentacao_legado ml ON ml.nota_fiscal = h.n_nf
WHERE h.tp_nf = 0
  AND LEFT(i.cfop, 1) = '3'  -- importação
  AND h.d_emi >= CURRENT_DATE - 180
  AND NOT EXISTS (
    SELECT 1 FROM stockbridge.movimentacao m
    WHERE m.ativo = true
      AND m.subtipo = 'importacao'
      AND m.nota_fiscal = h.n_nf
  )
GROUP BY h.n_nf, h.d_emi, ml.id, ml.dt_acxe
ORDER BY h.d_emi DESC;
```

**O que significa**: Importações que o MySQL legado processou, mas quando operador migrou pro Atlas, essas NFs não foram criadas em `stockbridge.movimentacao`. Elas **contam como Pendência Importação** na posição fiscal (inflando o número).

**Ação**:
- Para cada NF legado recebida: criar `movimentacao` correspondente em Atlas
- Usar o script pós-cutover de reconciliação (ver abaixo)

---

### 4️⃣ **Soft-deletadas no Legado mas Abertas em OMIE**

```sql
-- NFs que foram marcadas como ativo=false no legado (canceladas/desfeitas)
-- mas ainda estão abertas em OMIE
SELECT
  'ALERTA: soft-deletada legado, aberta OMIE' AS tipo_inconsistencia,
  h.n_nf,
  h.d_emi,
  ml.ativo AS legado_ativo,
  h.n_id_receb AS omie_status,
  SUM(i.q_com)::numeric(15,2) AS kg_total
FROM public."tbl_nf_header_ACXE" h
JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
INNER JOIN stockbridge.movimentacao_legado ml ON ml.nota_fiscal = h.n_nf
WHERE h.tp_nf = 0
  AND h.n_id_receb = 0  -- OMIE: aberta
  AND ml.ativo = false  -- Legado: foi desfeita
  AND h.d_emi >= CURRENT_DATE - 180
GROUP BY h.n_nf, h.d_emi, ml.ativo, h.n_id_receb
ORDER BY h.d_emi DESC;
```

**O que significa**: Operação foi cancelada no legado, mas OMIE não foi informado. Pode ser "teimosia" do OMIE ou erro de sincronização.

**Ação**: Comunicar com gestor — se foi cancelado, marcar em OMIE ou investigar por que OMIE não recebeu aviso.

---

## Resumo da Validação

| Query | Qtd esperada | Qtd aceitável | Qtd alarme |
|---|---|---|---|
| Zumbis (receb. legado, aberta OMIE) | ≤5 | ≤10 | >10 |
| NFs muito antigas (>90d abertas) | ≤20 | ≤50 | >50 |
| Importações não reconciliadas | ≤10 | ≤20 | >20 |
| Soft-deletadas mas abertas OMIE | 0 | ≤5 | >5 |

---

## Procedimento Pré-Cutover

**Checklist antes do cutover para PROD:**

- [ ] 1. Executar as 4 queries acima em UAT
- [ ] 2. Se houver "Zumbis": marcar como recebidas em OMIE ou investigar
- [ ] 3. Se houver importações não reconciliadas: rodar script de reconciliação (abaixo)
- [ ] 4. Se houver soft-deletadas abertas: comunicar ao gestor, resolver manualmente
- [ ] 5. Re-validar posição fiscal (deve ser significativamente menor)
- [ ] 6. Aprovar cutover

---

## Script Pós-Cutover: Reconciliação Importações Legado

Quando operador migra para Atlas, rodar este script para reconciliar importações do legado:

```sql
-- Script: reconciliar importações legado em Atlas
-- Cria movimentacao em Atlas para cada importação legado processada
-- Idempotente: re-rodar não duplica (usa ON CONFLICT)

BEGIN;

INSERT INTO stockbridge.movimentacao (
  lote_id,
  produto_codigo_acxe,
  tipo_movimento,
  subtipo,
  quantidade_kg,
  nota_fiscal,
  status_omie,
  criado_em,
  usuario_id
)
SELECT
  NULL as lote_id,  -- importação legado não tem lote Atlas
  i.n_cod_prod as produto_codigo_acxe,
  'entrada_nf' as tipo_movimento,
  'importacao' as subtipo,
  i.q_com as quantidade_kg,
  h.n_nf as nota_fiscal,
  'concluida' as status_omie,  -- já foi processada no legado
  ml.dt_acxe as criado_em,  -- data do legado
  NULL as usuario_id  -- legado não tem usuario
FROM public."tbl_nf_header_ACXE" h
JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
INNER JOIN stockbridge.movimentacao_legado ml ON ml.nota_fiscal = h.n_nf
WHERE h.tp_nf = 0
  AND LEFT(i.cfop, 1) = '3'
  AND ml.dt_acxe IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM stockbridge.movimentacao m
    WHERE m.nota_fiscal = h.n_nf
      AND m.subtipo = 'importacao'
      AND m.ativo = true
  )
ON CONFLICT (nota_fiscal, subtipo) WHERE subtipo = 'importacao'
DO NOTHING;

COMMIT;
```

**Idempotência**: Tem constraint UNIQUE em `(nota_fiscal, subtipo)` para importações. Re-rodar não duplica.

---

## Impacto na Posição Fiscal

Antes da reconciliação:
```
Pendência Importação = 22.156 t  (inclui importações legado + novas)
```

Depois da reconciliação:
```
Pendência Importação = X t  (só importações realmente pendentes)
```

O número **deve cair significativamente** — a queda reflete as importações do legado que já foram recebidas.

---

## Referências

- [Migration 0038 — movimentacao_legado](../../packages/db/migrations/0038_stockbridge_movimentacao_legado.sql)
- [Validação Posição Fiscal](./validacao-posicao-fiscal.sql)
- [Pesquisa: Migração MySQL→PG](./research.md) — seção 6
