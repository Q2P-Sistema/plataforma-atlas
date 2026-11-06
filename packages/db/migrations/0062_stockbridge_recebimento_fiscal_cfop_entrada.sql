-- Migration: 0062 — CFOP de entrada do recebimento fiscal pela finalidade da compra (feature 017, ACXEGDP-437)
--
-- Antes: o fiscal pelo Atlas (receita da 016/017: [ASSOCIAR-PEDIDO ->] EDITAR com itensAjustes ->
--        [IGNORAR] -> Concluir) nao mandava o CFOP de entrada; valia a sugestao do OMIE
--        (itensAjustes.cCFOPEntrada do ConsultarRecebimento). Na NF 979 da ACXE (Solutec, fornecedor
--        6.101, PC 581, 03/11/2026) a sugestao foi 2.102 (comercializacao), mas a ACXE compra para
--        industrializacao (2.101): o financeiro corrigiu a nota de entrada a mao em 06/11/2026.
-- Agora: o operador escolhe a FINALIDADE da compra uma vez por NF (industrializacao = final 101,
--        comercializacao = final 102; pre-selecionada pela empresa da NF) e o Atlas manda o CFOP de
--        entrada correspondente no EDITAR do item quando ele difere do lido, trocando so o final do CFOP
--        sugerido pelo OMIE (o 1o digito — 1 mesmo estado, 2 outro estado, 3 importacao — e o do sugerido;
--        CFOP fora de x.101/x.102, como uso e consumo x.556, o Atlas nao mexe). Esta migration grava a
--        escolha no ledger stockbridge.recebimento_fiscal (auditoria):
--          (1) finalidade_entrada: a finalidade escolhida pelo operador (NULL = o Atlas nao aplicou
--              CFOP nesta tentativa: chave desligada, tentativa anterior a 0062 ou NF sem fiscal pelo
--              Atlas, como o fiscal ja concluido no OMIE). Com o recurso ligado e gravada mesmo que
--              nenhum item tenha CFOP a trocar (todos os cfopAlvo nulos);
--          (2) cfops_entrada: rastro por item, jsonb array de objetos camelCase
--              {nSequencia, cfopSugerido, cfopAlvo, enviado} (cfopAlvo null = item fora do recorte
--              x.101/x.102, nada foi trocado). Exige finalidade_entrada preenchida. Gravado ANTES das
--              chamadas ao OMIE: enviado = o EDITAR planejado leva o CFOP, e so vale como aplicado com
--              status 'concluido' (numa falha, passo_falha diz ate onde a receita foi).
-- Porque: decisao de 06/11/2026 (D23 da 017). O OMIE nunca recebeu cCFOPEntrada pela API: a chave
--        STOCKBRIDGE_FISCAL_CFOP_ENTRADA_ENABLED nasce DESLIGADA e o primeiro uso e acompanhado.
--
-- Aditiva e idempotente, sem backfill (tentativas anteriores ficam com NULL). Aplicar ANTES da imagem:
-- sem a coluna finalidade_entrada o codigo novo confere o information_schema e segue com a sugestao
-- do OMIE (comportamento de antes), com erro no log (aviso, se a chave estiver desligada); o fiscal nao quebra. A tabela ja tem trigger de
-- auditoria (0053), que grava as colunas novas via to_jsonb — nada a mudar nela.
-- Ver specs/017-recebimento-nacional-com-pc/research.md, D23.

-- ── 1. Ledger do fiscal: finalidade e CFOP por item ──────────────────────────

ALTER TABLE stockbridge.recebimento_fiscal
  ADD COLUMN IF NOT EXISTS finalidade_entrada VARCHAR(20),
  ADD COLUMN IF NOT EXISTS cfops_entrada      JSONB;

ALTER TABLE stockbridge.recebimento_fiscal DROP CONSTRAINT IF EXISTS recebimento_fiscal_finalidade_entrada_check;
ALTER TABLE stockbridge.recebimento_fiscal
  ADD CONSTRAINT recebimento_fiscal_finalidade_entrada_check
  CHECK (finalidade_entrada IS NULL OR finalidade_entrada IN ('industrializacao', 'comercializacao'));

ALTER TABLE stockbridge.recebimento_fiscal DROP CONSTRAINT IF EXISTS recebimento_fiscal_cfops_entrada_check;
ALTER TABLE stockbridge.recebimento_fiscal
  ADD CONSTRAINT recebimento_fiscal_cfops_entrada_check
  CHECK (cfops_entrada IS NULL OR (jsonb_typeof(cfops_entrada) = 'array' AND finalidade_entrada IS NOT NULL));

COMMENT ON COLUMN stockbridge.recebimento_fiscal.finalidade_entrada IS
  'Finalidade da compra escolhida pelo operador para o CFOP de entrada do fiscal feito pelo Atlas: industrializacao (final 101) ou comercializacao (final 102); vale para todos os itens da NF. NULL = o Atlas nao aplicou CFOP nesta tentativa (chave STOCKBRIDGE_FISCAL_CFOP_ENTRADA_ENABLED desligada, tentativa anterior a esta migration ou fiscal ja concluido no OMIE). Feature 017, research D23.';
COMMENT ON COLUMN stockbridge.recebimento_fiscal.cfops_entrada IS
  'Rastro por item do CFOP de entrada, jsonb array: [{"nSequencia":1,"cfopSugerido":"2.102","cfopAlvo":"2.101","enviado":true}]. cfopSugerido = CFOP lido ao vivo no planejamento (numa retomada pode ser o que o proprio Atlas gravou antes); cfopAlvo null = item fora do recorte x.101/x.102 (uso e consumo x.556, outros: o Atlas nao mexe); enviado = o EDITAR planejado desta tentativa leva o CFOP (so quando difere do lido; gravado antes das chamadas ao OMIE, vale como aplicado so com status concluido); cfopAlvo com enviado=false = ja estava no alvo (sugerido igual) ou nao aplicado (item ja ignorado no OMIE). Exige finalidade_entrada. Feature 017, research D23.';
