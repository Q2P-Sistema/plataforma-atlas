-- Migration: 0041 — Hedge: views vw_hedge_* no fluxo de migrations (MOD-23)
--
-- Contexto (ACXEGDP-269, auditoria ACXEGDP-238):
--   As 5 views do módulo hedge (vw_hedge_pagar_usd, vw_hedge_estoque,
--   vw_hedge_receber_usd, vw_hedge_importacoes, vw_hedge_resumo) só existiam em
--   modules/hedge/src/db/views/*.sql, aplicadas MANUALMENTE via apply-views.sql
--   (psql \i) — FORA do fluxo de migrations. Um banco recém-migrado (ex.: UAT após
--   apply-migrations-uat.sh, ou um ambiente novo) NÃO tinha as views, e o hedge
--   quebrava em runtime (posicao/motor/estoque leem public.vw_hedge_*).
--
--   Esta migration traz a criação das views para o fluxo versionado. Corpos são
--   cópia byte-exata dos .sql fonte; a fonte canônica segue em modules/hedge/src/
--   db/views/ (mantidos para dev/psql), mas a paridade agora é garantida por aqui.
--
-- Ordem de dependência (idêntica a apply-views.sql):
--   1. vw_hedge_pagar_usd    (sem deps de view)
--   2. vw_hedge_estoque      (sem deps de view)
--   3. vw_hedge_receber_usd  (sem deps de view)
--   4. vw_hedge_importacoes  (sem deps de view)
--   5. vw_hedge_resumo       (depende das 4 acima)
--
-- Todas usam CREATE OR REPLACE VIEW — idempotente, seguro reaplicar. Depende do
-- espelho OMIE em public.* já existir (garantido: sync roda antes das migrations).
-- =============================================================================


-- ===== vw_hedge_pagar_usd =====
-- =============================================================================
-- View: public.vw_hedge_pagar_usd
-- Descrição: Contas a pagar em USD da ACXE para fornecedores do exterior.
--            Filtra títulos em aberto (A VENCER / ATRASADO / VENCE HOJE),
--            apenas fornecedores com exterior='S' e categorias de importação
--            (2.01.* mercadoria, 2.10.* despesa de importação).
--            Converte BRL → USD pela PTAX mais recente (tbl_cotacaoDolar).
--            Descrição de categoria via JOIN em tbl_categorias_ACXE (sync OMIE).
--
-- Dependências de tabela:
--   tbl_contasPagar_ACXE
--   tbl_cadastroFornecedoresClientes_ACXE
--   tbl_pedidosComex
--   tbl_cotacaoDolar
--   tbl_categorias_ACXE
--
-- Usado em: vw_hedge_resumo (campos total_pagar_usd, total_pagar_brl)
-- Validado em: 2026-04-13  |  Doc: docs/validacao/02-vw_hedge_pagar_usd.md
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_hedge_pagar_usd AS

WITH ptax_atual AS (
  SELECT "cotacaoVenda" AS ptax
  FROM "tbl_cotacaoDolar"
  ORDER BY "dataCotacao" DESC
  LIMIT 1
),

-- Desdobra até 9 parcelas de cada pedido Comex para matching com títulos
parcelas_comex AS (
  SELECT cnumero, ncodfor, parcelas1_dvencto AS dvencto, parcelas1_nvalor AS nvalor, 1 AS nparcela
  FROM "tbl_pedidosComex" WHERE parcelas1_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas2_dvencto, parcelas2_nvalor, 2
  FROM "tbl_pedidosComex" WHERE parcelas2_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas3_dvencto, parcelas3_nvalor, 3
  FROM "tbl_pedidosComex" WHERE parcelas3_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas4_dvencto, parcelas4_nvalor, 4
  FROM "tbl_pedidosComex" WHERE parcelas4_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas5_dvencto, parcelas5_nvalor, 5
  FROM "tbl_pedidosComex" WHERE parcelas5_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas6_dvencto, parcelas6_nvalor, 6
  FROM "tbl_pedidosComex" WHERE parcelas6_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas7_dvencto, parcelas7_nvalor, 7
  FROM "tbl_pedidosComex" WHERE parcelas7_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas8_dvencto, parcelas8_nvalor, 8
  FROM "tbl_pedidosComex" WHERE parcelas8_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas9_dvencto, parcelas9_nvalor, 9
  FROM "tbl_pedidosComex" WHERE parcelas9_nvalor IS NOT NULL
),

-- Match título → pedido Comex por (fornecedor + data_vencimento + valor exato)
-- row_number garante 1 match por título quando há múltiplas parcelas compatíveis
match_pedido AS (
  SELECT
    cp.codigo_lancamento_omie,
    pc.cnumero AS pedido_comex,
    ROW_NUMBER() OVER (PARTITION BY cp.codigo_lancamento_omie ORDER BY pc.nparcela) AS rn
  FROM "tbl_contasPagar_ACXE" cp
  JOIN parcelas_comex pc
    ON  pc.ncodfor  = cp.codigo_cliente_fornecedor
    AND pc.dvencto  = cp.data_vencimento
    AND pc.nvalor   = cp.valor_documento
)

SELECT
  cp.codigo_lancamento_omie::text                          AS omie_id,
  cp.data_vencimento,
  cp.valor_documento                                       AS valor_brl,
  ROUND(cp.valor_documento / pa.ptax, 2)                  AS valor_usd,
  pa.ptax                                                  AS ptax_ref,
  fc.razao_social                                          AS fornecedor,
  cp.status_titulo,
  cp.codigo_categoria,
  COALESCE(cat.descricao::text, cp.codigo_categoria::text) AS descricao_categoria,
  CASE
    WHEN cp.codigo_categoria LIKE '2.01.%' THEN 'mercadoria'
    WHEN cp.codigo_categoria LIKE '2.10.%' THEN 'despesa_importacao'
    ELSE NULL
  END                                                      AS tipo,
  TO_CHAR(cp.data_vencimento, 'Mon/YY')                   AS bucket_mes,
  mp.pedido_comex,
  cp.codigo_cliente_fornecedor

FROM "tbl_contasPagar_ACXE" cp
JOIN "tbl_cadastroFornecedoresClientes_ACXE" fc
  ON fc.codigo_cliente_omie = cp.codigo_cliente_fornecedor
CROSS JOIN ptax_atual pa
LEFT JOIN match_pedido mp
  ON mp.codigo_lancamento_omie = cp.codigo_lancamento_omie AND mp.rn = 1
LEFT JOIN public."tbl_categorias_ACXE" cat
  ON cat.codigo = cp.codigo_categoria

WHERE cp.status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE')
  AND fc.exterior = 'S'
  AND (cp.codigo_categoria LIKE '2.01.%' OR cp.codigo_categoria LIKE '2.10.%');


-- ===== vw_hedge_estoque =====
-- =============================================================================
-- View: public.vw_hedge_estoque
-- Descrição: Posição de estoque físico de ACXE e Q2P, classificada por origem.
--            Locais são filtrados por whitelist hardcoded (CTEs acxe_locais e
--            q2p_locais) e classificados como importado_no_chao, em_transito
--            ou nacional.
--            Converte BRL → USD pelo custo médio (ncmc) / PTAX atual.
--
-- Dependências de tabela:
--   tbl_posicaoEstoque_ACXE
--   tbl_posicaoEstoque_Q2P
--   tbl_locaisEstoques_ACXE
--   tbl_locaisEstoques_Q2P
--   tbl_cotacaoDolar
--
-- Usado em: vw_hedge_resumo (est_importado_usd, est_importado_brl)
--           estoque.service.ts (tabela do dashboard, com filtro localidades_ativas)
-- Validado em: 2026-04-14  |  Doc: docs/validacao/03-vw_hedge_estoque.md
--
-- LOCAIS ACXE incluídos:
--   4498926061  SANTO ANDRÉ (IMPORTADO)   importado_no_chao
--   4498926337  SANTO ANDRÉ (IMPORTADO)   importado_no_chao  (posição física separada)
--   4776458297  ARMAZÉM EXTERNO           importado_no_chao
--   4004166399  EXTREMA                   importado_no_chao
--   4503767789  TRÂNSITO                  em_transito
--
-- LOCAIS Q2P incluídos:
--   8123584710  SANTO ANDRÉ (NACIONAL)    nacional
--   8123584481  SANTO ANDRÉ (NACIONAL)    nacional
--
-- LOCAIS Q2P excluídos intencionalmente (réplicas espelhadas do integrador OMIE):
--   8115873724, 8115873874  IMPORTADO — espelho de 4498926061/4498926337
--   8042180936              ARMAZÉM EXTERNO — espelho de 4776458297
--   7960459966              EXTREMA — espelho de 4004166399
--   8429029971              TRÂNSITO — espelho de 4503767789
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_hedge_estoque AS

WITH ptax_atual AS (
  SELECT "cotacaoVenda" AS ptax
  FROM "tbl_cotacaoDolar"
  ORDER BY "dataCotacao" DESC
  LIMIT 1
),

-- Whitelist de locais ACXE com classificação de origem
acxe_locais (codigo, origem) AS (
  VALUES
    ('4498926061', 'importado_no_chao'),
    ('4498926337', 'importado_no_chao'),
    ('4776458297', 'importado_no_chao'),
    ('4004166399', 'importado_no_chao'),
    ('4503767789', 'em_transito')
),

-- Whitelist de locais Q2P com classificação de origem
-- Locais Q2P "IMPORTADO" são réplicas espelhadas da ACXE — excluídos para evitar dupla contagem
q2p_locais (codigo, origem) AS (
  VALUES
    ('8123584710', 'nacional'),
    ('8123584481', 'nacional')
)

-- Estoque ACXE
SELECT
  'acxe'::text                               AS empresa,
  pe.ncodprod,
  pe.ccodigo                                 AS codigo_produto,
  pe.cdescricao                              AS descricao,
  pe.nsaldo                                  AS quantidade,
  pe.ncmc                                    AS custo_medio_brl,
  pe.nprecounitario                          AS preco_unitario,
  pe.codigo_local_estoque,
  le.descricao                               AS local_descricao,
  al.origem,
  pe.ddataposicao                            AS data_posicao,
  pe.ncmc * pe.nsaldo::numeric               AS valor_total_brl,
  ROUND(pe.ncmc * pe.nsaldo::numeric / pa.ptax, 2) AS valor_total_usd,
  pa.ptax                                    AS ptax_ref

FROM "tbl_posicaoEstoque_ACXE" pe
JOIN "tbl_locaisEstoques_ACXE" le ON le.codigo_local_estoque = pe.codigo_local_estoque
JOIN acxe_locais al              ON al.codigo = pe.codigo_local_estoque::text
CROSS JOIN ptax_atual pa
WHERE pe.nsaldo > 0

UNION ALL

-- Estoque Q2P (apenas locais nacionais; importados são réplicas da ACXE)
SELECT
  'q2p'::text                                AS empresa,
  pe.ncodprod,
  pe.ccodigo                                 AS codigo_produto,
  pe.cdescricao                              AS descricao,
  pe.nsaldo                                  AS quantidade,
  pe.ncmc                                    AS custo_medio_brl,
  pe.nprecounitario                          AS preco_unitario,
  pe.codigo_local_estoque,
  lq.descricao                               AS local_descricao,
  ql.origem,
  pe.ddataposicao                            AS data_posicao,
  pe.ncmc * pe.nsaldo::numeric               AS valor_total_brl,
  ROUND(pe.ncmc * pe.nsaldo::numeric / pa.ptax, 2) AS valor_total_usd,
  pa.ptax                                    AS ptax_ref

FROM "tbl_posicaoEstoque_Q2P" pe
JOIN "tbl_locaisEstoques_Q2P" lq ON lq.codigo_local_estoque = pe.codigo_local_estoque
JOIN q2p_locais ql               ON ql.codigo = pe.codigo_local_estoque::text
CROSS JOIN ptax_atual pa
WHERE pe.nsaldo > 0;


-- ===== vw_hedge_receber_usd =====
-- =============================================================================
-- View: public.vw_hedge_receber_usd
-- Descrição: Contas a receber em aberto da Q2P (matriz + filial), convertidas
--            para USD pela PTAX atual. Janela de 90 dias para trás (horizonte
--            máximo de decisão de hedge). Inclui apenas títulos ativos
--            (A VENCER, ATRASADO, VENCE HOJE).
--
-- Dependências de tabela:
--   tbl_contasReceber_Q2P
--   tbl_contasReceber_Q2P_Filial
--   tbl_cotacaoDolar
--
-- Tabelas existentes NÃO usadas (intencionalmente):
--   tbl_contasReceber_ACXE  — recebíveis ACXE são intercompany (Q2P deve à ACXE);
--                              incluir geraria dupla contagem
--
-- Usado em: vw_hedge_resumo (campo total_receber_usd)
-- Validado em: 2026-04-14  |  Doc: docs/validacao/04-vw_hedge_receber_usd.md
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_hedge_receber_usd AS

WITH ptax_atual AS (
  SELECT "cotacaoVenda" AS ptax
  FROM "tbl_cotacaoDolar"
  ORDER BY "dataCotacao" DESC
  LIMIT 1
)

-- Q2P Matriz
SELECT
  cr.codigo_lancamento_omie::text            AS omie_id,
  cr.data_vencimento,
  cr.valor_documento                         AS valor_brl,
  ROUND(cr.valor_documento / pa.ptax, 2)    AS valor_usd,
  cr.status_titulo,
  pa.ptax                                    AS ptax_ref,
  TO_CHAR(cr.data_vencimento, 'Mon/YY')     AS bucket_mes

FROM "tbl_contasReceber_Q2P" cr
CROSS JOIN ptax_atual pa

WHERE cr.status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE')
  AND cr.data_vencimento >= CURRENT_DATE - INTERVAL '90 days'

UNION ALL

-- Q2P Filial
SELECT
  cr.codigo_lancamento_omie::text            AS omie_id,
  cr.data_vencimento,
  cr.valor_documento                         AS valor_brl,
  ROUND(cr.valor_documento / pa.ptax, 2)    AS valor_usd,
  cr.status_titulo,
  pa.ptax                                    AS ptax_ref,
  TO_CHAR(cr.data_vencimento, 'Mon/YY')     AS bucket_mes

FROM "tbl_contasReceber_Q2P_Filial" cr
CROSS JOIN ptax_atual pa

WHERE cr.status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE')
  AND cr.data_vencimento >= CURRENT_DATE - INTERVAL '90 days';


-- ===== vw_hedge_importacoes =====
-- =============================================================================
-- View: public.vw_hedge_importacoes
-- Descrição: Pipeline de importações em andamento da ACXE, a partir da
--            planilha FUP Comex (tbl_dadosPlanilhaFUPComex).
--            Exclui processos já recebidos no galpão (recebido_na_acxe='true').
--            Deriva status_hedge por prioridade de datas: data_desembaraco
--            → eta → etd → aguardando_embarque.
--            Usa taxa_dolar da planilha (câmbio contratado), NÃO a PTAX.
--
-- Dependências de tabela:
--   tbl_dadosPlanilhaFUPComex   (planilha FUP manual — não é sync OMIE)
--
-- Usado em: vw_hedge_resumo (importacoes_pendentes_usd, importacoes_pendentes_qtd)
--           resumo filtra: status_hedge <> 'nacionalizado'
-- Validado em: 2026-04-14  |  Doc: docs/validacao/05-vw_hedge_importacoes.md
--
-- GAP CONHECIDO: processos com etapa='00 - CANCELADO' sem datas preenchidas
--   caem no ELSE como 'aguardando_embarque' e entram nos pendentes do resumo.
--   Correção sugerida: adicionar ao WHERE:
--     AND (etapa_global <> '00 - CANCELADO' OR etapa_global IS NULL)
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_hedge_importacoes AS

SELECT
  id,
  pedido_acxe_omie,
  etapa,
  etapa_global,
  numero_bl,
  numero_di,
  eta,
  etd,
  taxa_dolar,
  valor_total_usd,
  valor_total_reais,
  fornecedor,
  data_desembaraco,
  despachante,
  recebido_na_acxe,
  CASE
    WHEN data_desembaraco IS NOT NULL            THEN 'nacionalizado'
    WHEN eta IS NOT NULL AND eta <= CURRENT_DATE THEN 'em_porto'
    WHEN etd IS NOT NULL                         THEN 'em_transito'
    ELSE                                              'aguardando_embarque'
  END AS status_hedge

FROM "tbl_dadosPlanilhaFUPComex" fup

WHERE recebido_na_acxe <> 'true' OR recebido_na_acxe IS NULL;


-- ===== vw_hedge_resumo =====
-- =============================================================================
-- View: public.vw_hedge_resumo
-- Descrição: View mestre do módulo hedge. Agrega as 4 sub-views em 1 linha
--            única com todos os componentes de posição cambial e a fórmula
--            de exposição USD total.
--
-- Dependências de view (aplicar DEPOIS das sub-views):
--   vw_hedge_pagar_usd
--   vw_hedge_estoque
--   vw_hedge_receber_usd
--   vw_hedge_importacoes
--
-- Dependências de tabela:
--   tbl_cotacaoDolar   (PTAX direto — as sub-views já têm a própria CTE ptax_atual,
--                       mas esta view busca a PTAX independentemente para expor no resultado)
--
-- Usado em: posicao.service.ts → GET /api/v1/hedge/posicao → frontend KPI cards
-- Validado em: 2026-04-14  |  Doc: docs/validacao/06-vw_hedge_resumo.md
--
-- FÓRMULA CENTRAL:
--   exposicao_usd_total = total_pagar_usd
--                       + est_importado_usd × LEAST(total_pagar_brl / est_importado_brl, 1.0)
--
--   onde o fator LEAST(..., 1.0) representa a fração do estoque importado
--   ainda não paga, capped em 100% para evitar sobre-contagem.
--
-- CAMPOS INFORMACIONAIS (não entram na fórmula de exposição):
--   total_receber_usd      — processado no motor MV (posicao.service.ts)
--   importacoes_pendentes  — visibilidade do pipeline FUP; sem título OMIE ainda
--   est_transito_usd       — já incluso em total_pagar_usd (título existe antes da entrega)
--   est_nacional_usd       — sem exposição cambial
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_hedge_resumo AS

WITH ptax_atual AS (
  SELECT "cotacaoVenda" AS ptax
  FROM "tbl_cotacaoDolar"
  ORDER BY "dataCotacao" DESC
  LIMIT 1
),

pagar AS (
  SELECT
    SUM(valor_usd)                                                        AS total_pagar_usd,
    SUM(valor_brl)                                                        AS total_pagar_brl,
    SUM(CASE WHEN tipo = 'mercadoria'         THEN valor_usd ELSE 0 END) AS pagar_mercadoria_usd,
    SUM(CASE WHEN tipo = 'despesa_importacao' THEN valor_usd ELSE 0 END) AS pagar_despesa_usd,
    COUNT(*)                                                              AS pagar_qtd
  FROM vw_hedge_pagar_usd
),

estoque AS (
  SELECT
    SUM(valor_total_brl)                                                                  AS total_est_brl,
    SUM(valor_total_usd)                                                                  AS total_est_usd,
    SUM(CASE WHEN origem = 'importado_no_chao' THEN valor_total_brl ELSE 0 END)          AS est_importado_brl,
    SUM(CASE WHEN origem = 'importado_no_chao' THEN valor_total_usd ELSE 0 END)          AS est_importado_usd,
    SUM(CASE WHEN origem = 'em_transito'        THEN valor_total_brl ELSE 0 END)         AS est_transito_brl,
    SUM(CASE WHEN origem = 'em_transito'        THEN valor_total_usd ELSE 0 END)         AS est_transito_usd,
    SUM(CASE WHEN origem = 'nacional'           THEN valor_total_brl ELSE 0 END)         AS est_nacional_brl,
    SUM(CASE WHEN origem = 'nacional'           THEN valor_total_usd ELSE 0 END)         AS est_nacional_usd
  FROM vw_hedge_estoque
),

receber AS (
  SELECT
    SUM(valor_usd) AS total_receber_usd,
    SUM(valor_brl) AS total_receber_brl
  FROM vw_hedge_receber_usd
),

importacoes AS (
  SELECT
    SUM(valor_total_usd) FILTER (WHERE status_hedge <> 'nacionalizado') AS pendente_usd,
    COUNT(*)             FILTER (WHERE status_hedge <> 'nacionalizado') AS pendente_qtd
  FROM vw_hedge_importacoes
)

SELECT
  pa.ptax,

  -- Contas a pagar
  p.total_pagar_usd,
  p.total_pagar_brl,
  p.pagar_mercadoria_usd,
  p.pagar_despesa_usd,
  p.pagar_qtd,

  -- Estoque (todos os tipos)
  e.total_est_brl,
  e.total_est_usd,
  e.est_importado_brl,
  e.est_importado_usd,
  e.est_transito_brl,
  e.est_transito_usd,
  e.est_nacional_brl,
  e.est_nacional_usd,

  -- % do estoque importado ainda não pago (cap 100%)
  LEAST(
    ROUND(COALESCE(p.total_pagar_brl / NULLIF(e.est_importado_brl, 0) * 100, 0)),
    100
  ) AS pct_nao_pago,

  -- Valor USD do estoque importado sem pagamento correspondente
  ROUND(
    e.est_importado_usd * LEAST(COALESCE(p.total_pagar_brl / NULLIF(e.est_importado_brl, 0), 0), 1),
    2
  ) AS est_nao_pago_usd,

  -- Contas a receber (informacional — não entra na exposição)
  r.total_receber_usd,
  r.total_receber_brl,

  -- Pipeline FUP (informacional — não entra na exposição)
  i.pendente_usd AS importacoes_pendentes_usd,
  i.pendente_qtd AS importacoes_pendentes_qtd,

  -- EXPOSIÇÃO USD TOTAL = pagar + estoque_nao_pago
  ROUND(
    p.total_pagar_usd + e.est_importado_usd * LEAST(COALESCE(p.total_pagar_brl / NULLIF(e.est_importado_brl, 0), 0), 1),
    2
  ) AS exposicao_usd_total,

  CURRENT_TIMESTAMP AS calculado_em

FROM ptax_atual pa, pagar p, estoque e, receber r, importacoes i;

