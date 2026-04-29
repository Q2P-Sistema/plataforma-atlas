-- Migration: 020 StockBridge — nome completo das familias Atlas
--
-- Contexto:
-- A coluna familia_omie_atlas.familia_atlas guarda apenas o codigo curto (PE, PP,
-- PS, PET, ABS, ADITIVO, PIGMENTO). Pra UI exibir "PE (Polietileno)" sem hardcode
-- no frontend, adiciona coluna nome_completo na tabela e popula os valores
-- conhecidos.

ALTER TABLE stockbridge.familia_omie_atlas
    ADD COLUMN IF NOT EXISTS nome_completo text;

UPDATE stockbridge.familia_omie_atlas SET nome_completo = 'Polietileno'                              WHERE familia_atlas = 'PE';
UPDATE stockbridge.familia_omie_atlas SET nome_completo = 'Polipropileno'                            WHERE familia_atlas = 'PP';
UPDATE stockbridge.familia_omie_atlas SET nome_completo = 'Poliestireno'                             WHERE familia_atlas = 'PS';
UPDATE stockbridge.familia_omie_atlas SET nome_completo = 'Politereftalato de Etileno'               WHERE familia_atlas = 'PET';
UPDATE stockbridge.familia_omie_atlas SET nome_completo = 'Acrilonitrila Butadieno Estireno'         WHERE familia_atlas = 'ABS';
UPDATE stockbridge.familia_omie_atlas SET nome_completo = 'Aditivo'                                  WHERE familia_atlas = 'ADITIVO';
UPDATE stockbridge.familia_omie_atlas SET nome_completo = 'Pigmento'                                 WHERE familia_atlas = 'PIGMENTO';
UPDATE stockbridge.familia_omie_atlas SET nome_completo = 'Composto Terceirizado'                    WHERE familia_atlas = 'CPT';
UPDATE stockbridge.familia_omie_atlas SET nome_completo = 'Operacional'                              WHERE familia_atlas = 'OPERACIONAL';

COMMENT ON COLUMN stockbridge.familia_omie_atlas.nome_completo IS
  'Nome por extenso da familia Atlas (ex: "Polietileno" para PE). Usado na UI pra exibir "PE (Polietileno)".';
