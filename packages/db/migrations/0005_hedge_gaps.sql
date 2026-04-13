-- 0005_hedge_gaps.sql
-- Seeds for operational parameters in hedge.config_motor (GAP-14)
-- No DDL changes — config_motor table already exists from 0002_hedge_engine.sql

INSERT INTO hedge.config_motor (chave, valor, descricao)
VALUES
  ('desvio_padrao_brl', '3.76', 'Desvio padrao mensal BRL/USD em pontos percentuais'),
  ('custo_financiamento_pct', '5.5', 'Custo de financiamento anual (% a.a.)'),
  ('prazo_recebimento', '38', 'Prazo medio de recebimento em dias'),
  ('transit_medio_dias', '80', 'Tempo medio de transito maritimo em dias'),
  ('giro_estoque_dias', '30', 'Giro medio de estoque importado em dias')
ON CONFLICT (chave) DO NOTHING;
