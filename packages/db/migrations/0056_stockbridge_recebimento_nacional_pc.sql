-- Migration: 0056 — StockBridge: recebimento nacional com pedido de compra (ACXEGDP-437)
--
-- Antes: o recebimento fiscal da NF nacional pelo Atlas (feature 016) concluía
--   o recebimento no OMIE com EDITAR -> IGNORAR -> Concluir. Desde 19/10/2026
--   compras lança pedido de compra (PC) no OMIE para a compra nacional, e o
--   IGNORAR desfaz o vínculo do item com o PC: o PC fica aberto e o recebimento
--   não conta para ele (NFs 7736 e 67913). O fiscal pelo Atlas foi desligado em
--   PROD em 21/10/2026 (contenção).
-- Agora: o operador confirma o PC de cada item e o Atlas conclui o fiscal com o
--   item vinculado ao PC e sem movimentar estoque ([ASSOCIAR-PEDIDO ->] EDITAR
--   -> Concluir; nunca IGNORAR em item com PC). Esta migration cria a estrutura:
--   (1) colunas de pedido no espelho de itens de recebimento (escritas pelo n8n):
--       de onde vêm o "vínculo do OMIE" e a detecção de estoque lançado pelo portal;
--   (2) stockbridge.recebimento_fiscal ganha empresa, itens_vinculados e os passos
--       'associar' e 'consultar_pc' no CHECK de passo_falha;
--   (3) stockbridge.recebimento_fiscal_pc — vínculo item da NF -> item de PC, uma
--       linha por item e por tentativa; as linhas confirmado/associado são a
--       reserva de saldo do PC enquanto o fiscal está em curso (research D4/D5);
--   (4) stockbridge.nf_aviso_compras — aviso a compras sobre NF sem PC,
--       deduplicado por NF, motivo e destinatário (research D6);
--   (5) triggers de auditoria nas duas tabelas novas (Princípio IV).
-- Porque: concluir o fiscal sem o vínculo deixa o PC aberto e a conta a pagar sem
--   o pedido; ignorar o item apaga o vínculo que compras lançou. Linhas
--   históricas não são tocadas (empresa das linhas existentes = 'q2p').
--
-- A função stockbridge.refresh_lotes_em_transito_se_stale (0037) NÃO muda nesta
-- feature (research D10, decisão de 21/10/2026).
--
-- Ver specs/017-recebimento-nacional-com-pc/ (research D4, D5, D6, D9; data-model §1, §3–§5).

-- ── 1. Espelho de itens de recebimento: vínculo com o pedido de compra (escritor: n8n) ──
-- Mesmo texto de contracts/espelhos-n8n.md §1: o n8n pode aplicar antes. Em PROD as 4
-- colunas já existem (aplicadas em 21/10/2026). ALTER TABLE ... ADD COLUMN IF NOT
-- EXISTS, mesmo sem efeito, pede ACCESS EXCLUSIVE na tabela (e exige ser dono dela): se
-- houver leitor em transação aberta, o ALTER espera e toda leitura nova da tabela que a
-- fila lê ao vivo entra na fila atrás dele. Por isso o ALTER e os COMMENTs só rodam
-- quando falta alguma das 4 colunas (ambiente novo, ex.: UAT sem a cópia PROD->UAT). Sem
-- a tabela do espelho, nada é feito (a 0053 a cria; as colunas vêm depois, do n8n ou
-- desta migration reaplicada).
DO $$
DECLARE
    v_rel        regclass := to_regclass('public."tbl_recebimentoNFe_itens_Q2P"');
    v_presentes  integer;
BEGIN
    IF v_rel IS NULL THEN
        RAISE NOTICE '0056: public."tbl_recebimentoNFe_itens_Q2P" não existe neste banco — colunas de pedido do espelho não criadas';
        RETURN;
    END IF;

    SELECT count(*) INTO v_presentes
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = v_rel
       AND a.attname IN ('n_id_pedido', 'n_id_it_pedido', 'n_num_ped_compra', 'c_num_it_ped_compra')
       AND a.attnum > 0
       AND NOT a.attisdropped;

    IF v_presentes = 4 THEN
        RAISE NOTICE '0056: as 4 colunas de pedido do espelho de itens de recebimento já existem — tabela não alterada';
        RETURN;
    END IF;

    EXECUTE $ddl$
        ALTER TABLE public."tbl_recebimentoNFe_itens_Q2P"
          ADD COLUMN IF NOT EXISTS n_id_pedido bigint,
          ADD COLUMN IF NOT EXISTS n_id_it_pedido bigint,
          ADD COLUMN IF NOT EXISTS n_num_ped_compra varchar(15),
          ADD COLUMN IF NOT EXISTS c_num_it_ped_compra integer
    $ddl$;

    EXECUTE $ddl$
        COMMENT ON COLUMN public."tbl_recebimentoNFe_itens_Q2P".n_id_pedido IS
          'itensCabec.nIdPedido: pedido de compra vinculado ao item (NULL = sem vínculo; o OMIE devolve 0). Vínculo do OMIE = n_id_pedido > 0 (ACXEGDP-437).'
    $ddl$;
    EXECUTE $ddl$
        COMMENT ON COLUMN public."tbl_recebimentoNFe_itens_Q2P".n_id_it_pedido IS
          'itensCabec.nIdItPedido, só quando há n_id_pedido: sem vínculo o OMIE repete o nIdItem neste campo (NF 7736), então o n8n grava NULL.'
    $ddl$;
    EXECUTE $ddl$
        COMMENT ON COLUMN public."tbl_recebimentoNFe_itens_Q2P".n_num_ped_compra IS
          'itensInfoAdic.nNumPedCompra: número do pedido de compra informado na NF.'
    $ddl$;
    EXECUTE $ddl$
        COMMENT ON COLUMN public."tbl_recebimentoNFe_itens_Q2P".c_num_it_ped_compra IS
          'itensInfoAdic.cNumItPedCompra: item do pedido de compra informado na NF.'
    $ddl$;
END
$$;

-- ── 2. Ledger do fiscal: empresa, itens vinculados e passos novos ────────────
ALTER TABLE stockbridge.recebimento_fiscal
  ADD COLUMN IF NOT EXISTS empresa VARCHAR(4) NOT NULL DEFAULT 'q2p',
  ADD COLUMN IF NOT EXISTS itens_vinculados INTEGER;

ALTER TABLE stockbridge.recebimento_fiscal DROP CONSTRAINT IF EXISTS recebimento_fiscal_empresa_check;
ALTER TABLE stockbridge.recebimento_fiscal
  ADD CONSTRAINT recebimento_fiscal_empresa_check CHECK (empresa IN ('q2p', 'acxe'));

-- 'consultar_pc' = releitura ao vivo do PC escolhido (ConsultarPedCompra), sem escrita;
-- 'associar'     = AlterarRecebimento ASSOCIAR-PEDIDO (escrita).
ALTER TABLE stockbridge.recebimento_fiscal DROP CONSTRAINT IF EXISTS recebimento_fiscal_passo_falha_check;
ALTER TABLE stockbridge.recebimento_fiscal
  ADD CONSTRAINT recebimento_fiscal_passo_falha_check CHECK (
    passo_falha IS NULL
    OR passo_falha IN ('consultar', 'consultar_pc', 'associar', 'editar', 'ignorar', 'concluir', 'reconsultar')
  );

COMMENT ON COLUMN stockbridge.recebimento_fiscal.itens_vinculados IS
  'Itens que terminaram vinculados a pedido de compra (feature 017). NULL = fiscal sem vínculo (receita da 016).';

-- ── 3. Vínculo item da NF -> item de PC (uma linha por item e por tentativa) ──
-- confirmado -> associado -> concluido | falha. O vínculo do OMIE mantido vai de
-- confirmado direto a associado, sem chamada. As linhas confirmado/associado de
-- outra NF, iniciadas há menos de 15 min, são reserva de saldo do item de PC.
CREATE TABLE IF NOT EXISTS stockbridge.recebimento_fiscal_pc (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recebimento_fiscal_id         UUID          NOT NULL REFERENCES stockbridge.recebimento_fiscal(id),
    empresa                       VARCHAR(4)    NOT NULL DEFAULT 'q2p' CHECK (empresa IN ('q2p', 'acxe')),
    nf_chave_acesso               VARCHAR(44)   NOT NULL,
    n_sequencia                   INTEGER       NOT NULL,
    origem                        VARCHAR(10)   NOT NULL CHECK (origem IN ('omie', 'sugestao', 'manual')),
    n_cod_ped                     BIGINT        NOT NULL,
    n_cod_item_ped                BIGINT        NOT NULL,
    pc_numero                     VARCHAR(50)   NOT NULL,
    n_cod_ped_omie_anterior       BIGINT,
    n_cod_item_ped_omie_anterior  BIGINT,
    dentro_tolerancia             BOOLEAN       NOT NULL,
    justificativa                 TEXT,
    candidatos                    JSONB         NOT NULL DEFAULT '[]'::jsonb,
    qtd_nf_kg                     NUMERIC(14,3) NOT NULL,
    preco_nf                      NUMERIC(14,6) NOT NULL,
    saldo_pc_kg_lido              NUMERIC(14,3),
    preco_pc_lido                 NUMERIC(14,6),
    etapa_pc_lida                 VARCHAR(2),
    status                        VARCHAR(12)   NOT NULL
                                  CHECK (status IN ('confirmado', 'associado', 'concluido', 'falha')),
    erro_omie_codigo              VARCHAR(60),
    erro_omie_mensagem            TEXT,
    confirmado_por                UUID          NOT NULL REFERENCES atlas.users(id),
    confirmado_em                 TIMESTAMPTZ   NOT NULL DEFAULT now(),
    concluido_em                  TIMESTAMPTZ,
    created_at                    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at                    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    -- Justificativa obrigatória (FR-007, matriz do data-model §4): PC fora da
    -- tolerância de qualquer origem, escolha manual e troca do vínculo do OMIE.
    CONSTRAINT recebimento_fiscal_pc_justificativa_check CHECK (
        (dentro_tolerancia AND origem <> 'manual' AND n_cod_ped_omie_anterior IS NULL)
        OR (justificativa IS NOT NULL AND length(btrim(justificativa)) > 0)
    )
);

COMMENT ON TABLE stockbridge.recebimento_fiscal_pc IS
  'Feature 017 (ACXEGDP-437): vínculo de cada item da NF nacional ao item de pedido de compra confirmado pelo operador, uma linha por item e por tentativa do fiscal (filha de recebimento_fiscal). confirmado/associado = reserva de saldo do PC enquanto o fiscal está em curso. erro_omie_* é técnico e nunca vai à UI.';

-- Um vínculo vivo por item da NF (FR-015).
CREATE UNIQUE INDEX IF NOT EXISTS recebimento_fiscal_pc_item_vivo_uq
    ON stockbridge.recebimento_fiscal_pc (nf_chave_acesso, n_sequencia)
    WHERE status IN ('confirmado', 'associado', 'concluido');

-- Regra "PC recém-usado" (75 s) e desconto, na cópia local, dos vínculos
-- concluídos depois de data_atualizacao (research D3/D4).
CREATE INDEX IF NOT EXISTS recebimento_fiscal_pc_item_pc_concluido_idx
    ON stockbridge.recebimento_fiscal_pc (n_cod_item_ped, concluido_em);

-- Reservas em andamento por item de PC (research D4).
CREATE INDEX IF NOT EXISTS recebimento_fiscal_pc_reserva_idx
    ON stockbridge.recebimento_fiscal_pc (n_cod_item_ped)
    WHERE status IN ('confirmado', 'associado');

CREATE INDEX IF NOT EXISTS recebimento_fiscal_pc_ledger_idx
    ON stockbridge.recebimento_fiscal_pc (recebimento_fiscal_id);

-- ── 4. Aviso a compras sobre NF sem PC (deduplicado) ─────────────────────────
-- No máximo um aviso por (NF, motivo, destinatário) a cada 24 h: quem falhou fica
-- pendente e pode gerar nova linha para o mesmo par; a deduplicação é feita pelo
-- serviço consultando esta tabela antes de enviar.
CREATE TABLE IF NOT EXISTS stockbridge.nf_aviso_compras (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa           VARCHAR(4)    NOT NULL DEFAULT 'q2p' CHECK (empresa IN ('q2p', 'acxe')),
    nf_chave_acesso   VARCHAR(44)   NOT NULL,
    nota_fiscal       VARCHAR(50),
    fornecedor_nome   VARCHAR(255),
    motivo            VARCHAR(30)   NOT NULL
                      CHECK (motivo IN ('sem_pc', 'pc_aguardando_aprovacao', 'recebida_sem_vinculo')),
    itens             JSONB         NOT NULL,
    enviado_para      TEXT          NOT NULL,
    enviado_em        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    disparado_por     UUID          REFERENCES atlas.users(id)
);

COMMENT ON TABLE stockbridge.nf_aviso_compras IS
  'Feature 017 (ACXEGDP-437): avisos enviados a compras sobre NF nacional com item sem pedido de compra (bloqueada, só com PC aguardando aprovação ou recebida sem vínculo). Deduplicação: um por NF, motivo e destinatário a cada 24 h (enviado_para guarda só os destinatários entregues; quem falhou recebe na próxima tentativa).';

CREATE INDEX IF NOT EXISTS nf_aviso_compras_dedup_idx
    ON stockbridge.nf_aviso_compras (nf_chave_acesso, motivo, enviado_em);

-- ── 5. Triggers de auditoria (Princípio IV — obrigatórias em toda tabela nova) ─
CREATE OR REPLACE FUNCTION stockbridge.audit_recebimento_fiscal_pc()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'recebimento_fiscal_pc', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_sb_recebimento_fiscal_pc ON stockbridge.recebimento_fiscal_pc;
CREATE TRIGGER trg_audit_sb_recebimento_fiscal_pc
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.recebimento_fiscal_pc
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_recebimento_fiscal_pc();

CREATE OR REPLACE FUNCTION stockbridge.audit_nf_aviso_compras()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'nf_aviso_compras', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_sb_nf_aviso_compras ON stockbridge.nf_aviso_compras;
CREATE TRIGGER trg_audit_sb_nf_aviso_compras
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.nf_aviso_compras
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_nf_aviso_compras();
