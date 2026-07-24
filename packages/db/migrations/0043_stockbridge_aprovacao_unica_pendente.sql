-- Migration: 0043 — StockBridge: no máximo UMA aprovação pendente por lote (STK-07, ACXEGDP-287)
--
-- Antes: resubmeter() só validava que a aprovação antiga estava 'rejeitada' e
--   inseria uma nova 'pendente' sem verificar se já existia outra. Duplo-clique /
--   retry de rede criava DUAS aprovações pendentes pro mesmo lote — cada uma,
--   quando aprovada, executava o dual OMIE de novo (opIds distintos → a proteção
--   1035 do OMIE não disparava → ajuste duplicado real no ERP).
-- Agora: UNIQUE INDEX parcial garante no máximo uma aprovação 'pendente' por
--   lote. O check de aplicação em resubmeter() dá a mensagem amigável; numa
--   corrida genuína (duas transações passam do check antes do commit) o índice
--   derruba a segunda no INSERT e o service traduz a violação para
--   ResubmissaoDuplicadaError (HTTP 409).
-- Porque: achado da auditoria ACXEGDP-238 (verificação adversarial). Junto com
--   o opId determinístico do mesmo PR, fecha as duas metades do STK-01/STK-07.
--
-- Aprovações de saída manual têm lote_id NULL — o predicado as ignora (NULLs
-- nunca colidem em UNIQUE), preservando N aprovações pendentes independentes
-- de saída manual, que é o comportamento correto.

-- ── 1. Índice único parcial ─────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS aprovacao_uq_lote_pendente
  ON stockbridge.aprovacao (lote_id)
  WHERE status = 'pendente' AND lote_id IS NOT NULL;

COMMENT ON INDEX stockbridge.aprovacao_uq_lote_pendente IS
  'STK-07 (ACXEGDP-287): um lote só pode ter UMA aprovação pendente. Impede re-submissão duplicada (duplo-clique) que geraria dual OMIE executado 2x na aprovação.';
