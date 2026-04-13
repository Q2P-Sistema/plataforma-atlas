-- Migration: 003 Hedge Gaps Fase 2
-- Adds banco field to ndf_registro, seeds operational parameters

-- ── NDF banco field ───────────────────────────────────────
ALTER TABLE hedge.ndf_registro ADD COLUMN IF NOT EXISTS banco VARCHAR(100);
CREATE INDEX IF NOT EXISTS ndf_banco_idx ON hedge.ndf_registro (banco);

-- ── Config Motor — operational params seed ────────────────
INSERT INTO hedge.config_motor (chave, valor, descricao) VALUES
    ('faturamento_mensal', '25', 'Faturamento mensal base (R$M)'),
    ('pct_custo_importado', '70', 'Proporcao do custo em USD (%)'),
    ('transit_medio_dias', '80', 'Dias medios D0 ao desembarque'),
    ('giro_estoque_dias', '30', 'Dias medios de estoque no chao'),
    ('prazo_recebimento', '38', 'Dias medios NF saida ao pagamento'),
    ('margem_floor', '15', 'Alerta se margem cair abaixo (%)')
ON CONFLICT (chave) DO NOTHING;
