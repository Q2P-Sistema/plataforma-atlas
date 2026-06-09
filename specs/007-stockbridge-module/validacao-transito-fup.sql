-- ============================================================================
-- VALIDAÇÃO: Pipeline de Trânsito FUP-driven (5 estágios) — StockBridge
-- ============================================================================
-- Objetivo: Verificar, contra dados reais, que o pipeline de trânsito da
--           migration 0037 (função stockbridge.refresh_lotes_em_transito_se_stale)
--           classifica cada lote no estágio correto derivado do FUP de Comex.
--
-- POR QUE este script existe:
--   A regra de negócio (CASE etapa_global/etapa → estagio_transito) vive em
--   plpgsql (migration 0037) e NÃO é alcançada pelo vitest (que mocka o banco).
--   Este é o teste durável do pipeline — re-rodável após qualquer mudança nele,
--   e pluggável num smoke test de deploy. Espelha o padrão de
--   validacao-posicao-fiscal.sql.
--
-- Mapeamento esperado (migration 0037):
--   01 - Aguardando Booking                  → aguardando_embarque
--   02 - Em Águas                            → transito_intl
--   03 - Nacionalização, etapa 20/30/31      → no_porto         (sem NF)
--   03 - Nacionalização, etapa 21/22         → transito_local   (NF mãe emitida)
--   03 - Nacionalização, etapa 23 / 04 / 05  → NÃO rastreado    (OMIE assume saldo)
--
-- Execução:
--   psql "postgresql://user:pass@host:5432/acxe_q2p" -f validacao-transito-fup.sql
--
-- CRITÉRIO DE APROVAÇÃO: as 3 checagens abaixo devem retornar 0 em
--   divergem / fup_sem_etapa / fup_rastreaveis_sem_lote.
--
-- Última validação: 2026-06-09 — UAT 52/52, DEV 53/53, 0 divergências, 0 órfãos.
-- ============================================================================

\echo '================================================================'
\echo '1. FORWARD — todo lote em trânsito tem o estágio que o FUP manda?'
\echo '   (divergem deve ser 0; sem_etapa deve ser 0)'
\echo '================================================================'

WITH fup_derivado AS (
  SELECT
    l.id,
    l.codigo,
    l.pedido_compra_acxe,
    l.estagio_transito AS gravado,
    CASE
      WHEN fup.etapa_global = '01 - Aguardando Booking' THEN 'aguardando_embarque'
      WHEN fup.etapa_global = '02 - Em Águas'           THEN 'transito_intl'
      WHEN fup.etapa_global = '03 - Nacionalização'
           AND fup.etapa LIKE ANY(ARRAY['20%','30%','31%']) THEN 'no_porto'
      WHEN fup.etapa_global = '03 - Nacionalização'
           AND fup.etapa LIKE ANY(ARRAY['21%','22%'])        THEN 'transito_local'
    END AS esperado
  FROM stockbridge.lote l
  LEFT JOIN public."tbl_dadosPlanilhaFUPComex" fup
    ON fup.pedido_acxe_omie = l.pedido_compra_acxe
  WHERE l.status = 'transito' AND l.ativo
)
SELECT
  count(*)                                          AS total_pares_lote_fup,
  count(*) FILTER (WHERE gravado = esperado)        AS batem,
  count(*) FILTER (WHERE gravado <> esperado)       AS divergem,
  count(*) FILTER (WHERE esperado IS NULL)          AS fup_sem_etapa_rastreada
FROM fup_derivado;

\echo ''
\echo '   Detalhe das divergências (deve vir vazio):'
WITH fup_derivado AS (
  SELECT
    l.codigo,
    l.pedido_compra_acxe,
    l.estagio_transito AS gravado,
    CASE
      WHEN fup.etapa_global = '01 - Aguardando Booking' THEN 'aguardando_embarque'
      WHEN fup.etapa_global = '02 - Em Águas'           THEN 'transito_intl'
      WHEN fup.etapa_global = '03 - Nacionalização'
           AND fup.etapa LIKE ANY(ARRAY['20%','30%','31%']) THEN 'no_porto'
      WHEN fup.etapa_global = '03 - Nacionalização'
           AND fup.etapa LIKE ANY(ARRAY['21%','22%'])        THEN 'transito_local'
    END AS esperado,
    fup.etapa_global, fup.etapa
  FROM stockbridge.lote l
  LEFT JOIN public."tbl_dadosPlanilhaFUPComex" fup
    ON fup.pedido_acxe_omie = l.pedido_compra_acxe
  WHERE l.status = 'transito' AND l.ativo
)
SELECT codigo, pedido_compra_acxe, gravado, esperado, etapa_global, etapa
FROM fup_derivado
WHERE gravado IS DISTINCT FROM esperado
ORDER BY codigo;

\echo ''
\echo '================================================================'
\echo '2. REVERSO — todo pedido FUP rastreável virou lote? (órfãos = 0)'
\echo '   Pedidos com produto+qtde válidos, em etapa rastreada, sem lote ativo.'
\echo '================================================================'

SELECT count(*) AS fup_rastreaveis_sem_lote
FROM public."tbl_dadosPlanilhaFUPComex" fup
JOIN public."tbl_pedidosCompras_ACXE" pc ON pc.cnumero = fup.pedido_acxe_omie
WHERE pc.ncodprod IS NOT NULL AND pc.nqtde > 0
  AND (
    fup.etapa_global IN ('01 - Aguardando Booking', '02 - Em Águas')
    OR (fup.etapa_global = '03 - Nacionalização'
        AND fup.etapa LIKE ANY(ARRAY['20%','21%','22%','30%','31%']))
  )
  AND NOT EXISTS (
    SELECT 1 FROM stockbridge.lote l
    WHERE l.pedido_compra_acxe = fup.pedido_acxe_omie
      AND l.produto_codigo_acxe = pc.ncodprod
      AND l.status = 'transito' AND l.ativo
  );

\echo ''
\echo '================================================================'
\echo '3. DISTRIBUIÇÃO — lotes ativos por estágio (sanidade visual)'
\echo '================================================================'

SELECT estagio_transito, count(*) AS lotes,
       round(SUM(quantidade_fisica_kg)::numeric, 0) AS kg_total
FROM stockbridge.lote
WHERE status = 'transito' AND ativo
GROUP BY estagio_transito
ORDER BY 2 DESC;

\echo ''
\echo '================================================================'
\echo 'FIM — aprovação: seções 1 e 2 com divergem/sem_etapa/órfãos = 0.'
\echo '================================================================'
