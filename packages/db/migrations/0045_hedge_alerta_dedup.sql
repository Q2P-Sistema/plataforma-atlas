-- Migration: 0045 — Hedge: dedupe de alertas abertos + índice único parcial (MOD-05, ACXEGDP-276)
--
-- Antes: gerarAlertas inseria alerta incondicionalmente a cada cache-miss de
--   GET /posicao (TTL 300s, e SEMPRE com Redis indisponível) para todo bucket
--   com gap > 0 — sem UNIQUE em (bucket_id, tipo) e sem checagem de alerta
--   aberto. Gap persistente = dezenas de linhas idênticas; a listagem
--   (limit 50) virava só duplicatas. Verificado no UAT vivo em 2026-07-15:
--   16 alertas abertos para apenas 4 pares (bucket_id, tipo) distintos.
-- Agora: (1) duplicatas existentes são RESOLVIDAS, mantendo-se o alerta aberto
--   MAIS ANTIGO por par — preserva o "desde quando" do gap; nada é deletado;
--   (2) índice único parcial garante no máximo 1 alerta ABERTO por
--   (bucket_id, tipo). O serviço passa a fazer INSERT ... ON CONFLICT DO
--   UPDATE (atualiza severidade/mensagem) + auto-resolve quando o gap fecha.
-- Porque: achado da auditoria ACXEGDP-238 (verificação adversarial, confiança
--   alta). Contraparte no código: modules/hedge/src/services/alerta.service.ts.

-- ── 1. Dedupe: resolve duplicatas, mantendo o aberto mais antigo por par ─────
UPDATE hedge.alerta a
SET resolvido = true,
    resolvido_at = NOW()
WHERE a.resolvido = false
  AND EXISTS (
    SELECT 1
    FROM hedge.alerta b
    WHERE b.bucket_id IS NOT DISTINCT FROM a.bucket_id
      AND b.tipo = a.tipo
      AND b.resolvido = false
      AND (b.created_at < a.created_at
           OR (b.created_at = a.created_at AND b.id < a.id))
  );

-- ── 2. Índice único parcial: 1 alerta aberto por (bucket_id, tipo) ───────────
-- NULLs em bucket_id não colidem entre si (NULLS DISTINCT, default do PG) —
-- alertas sem bucket seguem livres; os de gap_cobertura sempre têm bucket_id.
CREATE UNIQUE INDEX alerta_uq_bucket_tipo_aberto
    ON hedge.alerta (bucket_id, tipo)
    WHERE resolvido = false;

COMMENT ON INDEX hedge.alerta_uq_bucket_tipo_aberto IS
  'MOD-05 (ACXEGDP-276): no máximo 1 alerta ABERTO por bucket+tipo. gerarAlertas usa ON CONFLICT DO UPDATE e auto-resolve quando o gap fecha.';
