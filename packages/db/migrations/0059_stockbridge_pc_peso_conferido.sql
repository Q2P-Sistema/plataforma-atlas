-- Migration: 0059 — baixa do pedido de compra pelo peso conferido (feature 017, ACXEGDP-437)
--
-- Antes: o fiscal pelo Atlas so mandava itensAjustes.nQtdeRecebida com o PC em unidade
--        diferente da NF (modo 'converter'). Sem ela o OMIE baixa o PC pela quantidade da NF.
--        Na NF 67988 (Isoforma x PC 305, 23/10/2026) a balanca marcou 13.500 kg contra 13.382
--        da NF: o PC ficou "recebido parcialmente", com 118 kg em aberto, ate o fiscal corrigir
--        a quantidade recebida no portal.
-- Agora: com STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO ligada, o peso conferido acima da NF vai como
--        quantidade recebida, com teto no saldo do PC. Esta migration:
--          (1) stockbridge.recebimento_fiscal_pc.kg_recebido_pc: kg que o item baixou no PC
--              quando a quantidade recebida nao e a da NF (NULL = sem quantidade definida, vale
--              a da NF). As reservas entre NFs e o saldo da sugestao passam a contar por ela;
--          (2) stockbridge.nf_aviso_compras aceita o motivo 'excedente_rejeitado': aviso a
--              compras quando o gestor rejeita a entrada de um item cujo PC ja foi baixado pelo
--              peso conferido (a rejeicao nao desfaz a baixa no OMIE).
-- Porque: o pedido de compra deve ser baixado pelo que entrou de fato (decisao de 23/10/2026).
--
-- Aditiva e idempotente. Aplicar ANTES da imagem: sem a coluna o codigo novo confere o
-- information_schema e segue pela NF (a baixa pelo peso conferido fica sem efeito, com erro no
-- log; o fiscal nao quebra), mas o registro do que o OMIE baixou so existe com ela. As duas
-- tabelas ja tem trigger de auditoria (0056).
-- Ver specs/017-recebimento-nacional-com-pc/research.md, D20.

-- ── 1. Quantidade recebida no PC ─────────────────────────────────────────────

ALTER TABLE stockbridge.recebimento_fiscal_pc
  ADD COLUMN IF NOT EXISTS kg_recebido_pc NUMERIC(14, 3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'recebimento_fiscal_pc_kg_recebido_check'
       AND conrelid = 'stockbridge.recebimento_fiscal_pc'::regclass
  ) THEN
    ALTER TABLE stockbridge.recebimento_fiscal_pc
      ADD CONSTRAINT recebimento_fiscal_pc_kg_recebido_check CHECK (kg_recebido_pc IS NULL OR kg_recebido_pc > 0);
  END IF;
END $$;

COMMENT ON COLUMN stockbridge.recebimento_fiscal_pc.kg_recebido_pc IS
  'kg que o item baixou no PC quando a quantidade recebida nao e a da NF: o que o Atlas mandou em itensAjustes.nQtdeRecebida (em kg: PC em unidade diferente da NF no modo converter, peso conferido acima da NF, ou a da NF de volta na retomada) ou o que o OMIE mostrou ao concluir (fiscal ja concluido, quando difere da NF em mais de 1 g). NULL = sem quantidade definida (vale a da NF, qtd_nf_kg). Feature 017, research D20.';

-- ── 2. Aviso a compras: entrada rejeitada depois da baixa pelo peso conferido ──

ALTER TABLE stockbridge.nf_aviso_compras DROP CONSTRAINT IF EXISTS nf_aviso_compras_motivo_check;
ALTER TABLE stockbridge.nf_aviso_compras
  ADD CONSTRAINT nf_aviso_compras_motivo_check
  CHECK (motivo IN ('sem_pc', 'pc_aguardando_aprovacao', 'recebida_sem_vinculo', 'excedente_rejeitado'));

COMMENT ON TABLE stockbridge.nf_aviso_compras IS
  'Feature 017 (ACXEGDP-437): avisos enviados a compras sobre NF nacional: item sem pedido de compra (bloqueada, só com PC aguardando aprovação ou recebida sem vínculo) e entrada rejeitada pelo gestor depois de o PC ser baixado pelo peso conferido (excedente_rejeitado, 0059). Deduplicação: um por NF, motivo e destinatário a cada 24 h; no motivo excedente_rejeitado, também por item (as sequências do aviso precisam constar no aviso anterior). enviado_para guarda só os destinatários entregues; quem falhou recebe na próxima tentativa.';
