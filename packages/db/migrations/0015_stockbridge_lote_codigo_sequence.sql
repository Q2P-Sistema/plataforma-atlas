-- Migration: 015 StockBridge — sequence dedicada para gerar codigo de lote (L001, L002, ...)
-- Bug observado: proximoCodigoLote usava `SELECT COALESCE(MAX(CAST(...)), 0) + 1` via Drizzle.
-- Em runtime o resultado vinha 0 mesmo com L001 ja existente — colisao com unique constraint
-- no INSERT (Key (codigo)=(L001) already exists). Causa exata na camada Drizzle nao identificada,
-- mas o padrao MAX+1 e race-condition-prone de qualquer forma.
--
-- Fix: sequence Postgres dedicada. nextval() e atomico, transacional-safe e nao depende de MAX.
-- Numeros podem "pular" se uma tx rollback (sequence ja consumiu o valor) — aceitavel para
-- codigos de auditoria; em troca, garantia de unicidade absoluta.
--
-- Inicializa a sequence no proximo valor APOS o maior codigo existente, para preservar a
-- continuidade da numeracao em ambientes que ja tem lotes.

DO $$
DECLARE
  proximo_lote integer;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(codigo FROM 2) AS INTEGER)), 0) + 1
    INTO proximo_lote
    FROM stockbridge.lote
   WHERE codigo ~ '^L[0-9]+$';

  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS stockbridge.lote_codigo_seq START WITH %s', proximo_lote);
END $$;

COMMENT ON SEQUENCE stockbridge.lote_codigo_seq IS
  'Gera o numero sequencial usado em codigo de lote (formato L###). Inicializada a partir do maior codigo existente no momento da migration. nextval() e atomico — substitui o antigo MAX+1 via Drizzle que tinha bug.';
