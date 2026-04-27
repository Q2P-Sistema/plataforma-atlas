-- Migration: 016 StockBridge — Idempotencia OMIE (cod_int_ajuste) + estado parcial
-- Contexto: hoje executarAjusteOmieDual chama OMIE ACXE serial → Q2P serial.
-- Se Q2P falhar apos ACXE suceder, ACXE escreveu mas Q2P nao, e nada e gravado
-- no Atlas — estado orfao impossivel de retentar sem duplicar ACXE.
--
-- Solucao: usar campo `cod_int_ajuste` (60 chars) do endpoint OMIE
-- IncluirAjusteEstoque como chave de idempotencia derivada de op_id (uuid).
-- Antes de retentar, ListarAjusteEstoque filtra por cod_int_ajuste e detecta
-- duplicacao. Movimentacao parcial (ACXE ok, Q2P pendente) e persistida com
-- status_omie='pendente_q2p' para auditoria + retry posterior.
--
-- Ver specs/007-stockbridge-module/tasks-idempotencia-omie.md para plano.

ALTER TABLE stockbridge.movimentacao
    ADD COLUMN op_id uuid NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN status_omie text NOT NULL DEFAULT 'concluida'
        CHECK (status_omie IN ('concluida','pendente_q2p','pendente_acxe_faltando','falha')),
    ADD COLUMN tentativas_q2p smallint NOT NULL DEFAULT 0,
    ADD COLUMN tentativas_acxe_faltando smallint NOT NULL DEFAULT 0,
    ADD COLUMN ultimo_erro_omie jsonb;

CREATE INDEX idx_movimentacao_status_omie_pendente
    ON stockbridge.movimentacao (status_omie)
    WHERE status_omie <> 'concluida';

CREATE INDEX idx_movimentacao_op_id
    ON stockbridge.movimentacao (op_id);

COMMENT ON COLUMN stockbridge.movimentacao.op_id IS
  'UUID gerado por movimentacao. Enviado ao OMIE em cod_int_ajuste com sufixos: ${op_id}:acxe-trf, ${op_id}:q2p-ent, ${op_id}:acxe-faltando. Permite idempotencia em retry via ListarAjusteEstoque.';

COMMENT ON COLUMN stockbridge.movimentacao.status_omie IS
  'Estado da sincronizacao com OMIE. concluida=ambos lados ok (default). pendente_q2p=ACXE ok mas Q2P falhou. pendente_acxe_faltando=segunda chamada ACXE (transferirDiferenca) falhou. falha=marcado manualmente por admin como nao-recuperavel.';
