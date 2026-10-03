-- Migration: 0053 — StockBridge: recebimento fiscal da NF nacional pelo Atlas (ACXEGDP-395)
--
-- Antes: o recebimento FISCAL de uma NF de compra nacional era feito a mao, por
--   uma pessoa, na caixa "Recebimento de NF-e" do OMIE. Uma NF vinda da SEFAZ
--   ficava invisivel para o Atlas ate alguem conclui-la (so entao entra no
--   ListarNF e no espelho tbl_nf_header_Q2P). E quando a pessoa fazia o fisico
--   junto (vinculo de produto), o OMIE sobrescrevia a descricao do item e a NF
--   reaparecia na fila com risco de estoque em dobro (NF 6495, ACXEGDP-394).
-- Agora: o Atlas conclui o fiscal no OMIE (EDITAR -> IGNORAR -> Concluir, sem
--   movimentar estoque) no clique do operador, antes de gravar o recebimento
--   fisico. Esta migration cria a estrutura:
--   (1) espelho novo da caixa de recebimentos do OMIE — public."tbl_recebimentoNFe_Q2P"
--       + itens — ESCRITO SO PELO n8n (ListarRecebimentos), lido pela fila do
--       Atlas como fonte "fiscal pendente". DDL canonica aqui (IF NOT EXISTS: no
--       PROD, enquanto o Atlas nao roda migration, o n8n cria com a mesma DDL —
--       contrato em specs/016-recebimento-fiscal-nf/contracts/espelho-recebimentos-n8n.md);
--   (2) stockbridge.recebimento_fiscal — ledger de cada tentativa de concluir o
--       fiscal: lock (uma linha "viva" por NF), idempotencia e rastro de quem,
--       quando, resultado e erro OMIE (research D6);
--   (3) stockbridge.nf_dispensa — decisao do gestor de tirar da fila uma NF que
--       nunca sera recebida fisicamente (fiscal pendente ou ja feito), com motivo,
--       reversivel, sem nenhuma acao no OMIE (research D9);
--   (4) triggers de auditoria nas duas tabelas novas do Atlas (Principio IV).
-- Porque: NF que nao aparece ate alguem agir no portal, e descricao de item
--   poluida por recebimento fisico manual no OMIE. Nenhuma coluna de
--   movimentacao/aprovacao muda; linhas historicas nao sao tocadas.
--
-- Ver specs/016-recebimento-fiscal-nf/ (research D4, D5, D6, D9; data-model).

-- ── 1. Espelho — cabecalho dos recebimentos de NF-e (escritor: n8n) ──────────
CREATE TABLE IF NOT EXISTS public."tbl_recebimentoNFe_Q2P" (
  n_id_receb           BIGINT PRIMARY KEY,
  c_chave_nfe          VARCHAR(44) NOT NULL,
  c_numero_nfe         VARCHAR(20),
  c_serie_nfe          VARCHAR(5),
  c_modelo_nfe         VARCHAR(3),
  d_emissao            DATE,
  n_id_fornecedor      BIGINT,
  c_cnpj_cpf           VARCHAR(20),
  c_razao_social       VARCHAR(255),
  c_nome               VARCHAR(255),
  c_natureza_operacao  VARCHAR(60),
  n_valor_nfe          NUMERIC(14,2),
  c_etapa              VARCHAR(2),
  c_recebido           CHAR(1),
  c_cancelada          CHAR(1),
  c_faturado           CHAR(1),
  c_bloqueado          CHAR(1),
  c_devolvido          CHAR(1),
  d_inc DATE, h_inc VARCHAR(8),
  d_alt DATE, h_alt VARCHAR(8),
  d_rec DATE, h_rec VARCHAR(8), c_usuario_rec VARCHAR(30),
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "tbl_recebimentoNFe_Q2P_chave_idx" ON public."tbl_recebimentoNFe_Q2P" (c_chave_nfe);
CREATE INDEX IF NOT EXISTS "tbl_recebimentoNFe_Q2P_pendente_idx" ON public."tbl_recebimentoNFe_Q2P" (c_recebido, c_cancelada);
CREATE INDEX IF NOT EXISTS "tbl_recebimentoNFe_Q2P_emissao_idx" ON public."tbl_recebimentoNFe_Q2P" (d_emissao);

COMMENT ON TABLE public."tbl_recebimentoNFe_Q2P" IS
  'Espelho OMIE Q2P da caixa Recebimento de NF-e (produtos/recebimentonfe/ListarRecebimentos). ESCRITO SO PELO n8n ("Q2P - Exporta Recebimentos NF-e"). Fonte "fiscal pendente" (c_recebido=N) da fila de recebimento nacional do StockBridge (feature 016, ACXEGDP-395). DDL canonica em packages/db/migrations/0053.';

-- ── 2. Espelho — itens dos recebimentos (escritor: n8n) ──────────────────────
CREATE TABLE IF NOT EXISTS public."tbl_recebimentoNFe_itens_Q2P" (
  n_id_receb               BIGINT NOT NULL REFERENCES public."tbl_recebimentoNFe_Q2P"(n_id_receb) ON DELETE CASCADE,
  n_sequencia              INTEGER NOT NULL,
  c_descricao_produto      VARCHAR(500),
  c_codigo_produto         VARCHAR(60),
  c_ncm                    VARCHAR(10),
  c_cfop                   VARCHAR(10),
  c_cfop_entrada           VARCHAR(10),
  n_qtde_nfe               NUMERIC(14,4),
  c_unidade_nfe            VARCHAR(10),
  n_preco_unit             NUMERIC(18,6),
  v_total_item             NUMERIC(14,2),
  v_desconto               NUMERIC(14,2),
  c_ignorar_item           CHAR(1),
  c_associar_existente     CHAR(1),
  c_adicionar_novo         CHAR(1),
  n_id_item                BIGINT,
  n_id_produto             BIGINT,
  c_nao_gerar_mov_estoque  CHAR(1),
  c_nao_gerar_financeiro   CHAR(1),
  n_qtde_recebida          NUMERIC(14,4),
  codigo_local_estoque     BIGINT,
  synced_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (n_id_receb, n_sequencia)
);

COMMENT ON TABLE public."tbl_recebimentoNFe_itens_Q2P" IS
  'Itens do espelho de recebimentos de NF-e (itensRecebimento[]). ESCRITO SO PELO n8n. v_total_item = valor do item com tributos uma vez (equivale a v_prod do espelho de NF — research D7); c_cfop_entrada e o CFOP do recorte da fila (c_cfop e o do fornecedor).';

-- ── 3. Ledger do recebimento fiscal pelo Atlas ───────────────────────────────
-- Uma linha por TENTATIVA; uma linha "viva" por NF (indice unico parcial). O
-- INSERT em 'em_andamento' acontece ANTES da primeira chamada ao OMIE e e o lock
-- contra duplo clique; 'concluido'/'ja_concluido' fazem a fila marcar a NF como
-- "fiscal ja feito" antes de o espelho refletir. Falhas ficam como historico.
CREATE TABLE IF NOT EXISTS stockbridge.recebimento_fiscal (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nf_chave_acesso      VARCHAR(44)  NOT NULL,
    n_id_receb           BIGINT,
    nota_fiscal          VARCHAR(50)  NOT NULL,
    fornecedor_nome      VARCHAR(255),
    status               VARCHAR(20)  NOT NULL
                         CHECK (status IN ('em_andamento', 'concluido', 'ja_concluido', 'falha')),
    etapa_antes          VARCHAR(2),
    recebido_antes       CHAR(1),
    passo_falha          VARCHAR(20)
                         CHECK (passo_falha IS NULL OR passo_falha IN ('consultar', 'editar', 'ignorar', 'concluir', 'reconsultar')),
    erro_omie_codigo     VARCHAR(60),
    erro_omie_mensagem   TEXT,
    itens_total          INTEGER,
    confirmado_por       UUID         NOT NULL REFERENCES atlas.users(id),
    iniciado_em          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    finalizado_em        TIMESTAMPTZ,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE stockbridge.recebimento_fiscal IS
  'Feature 016 (ACXEGDP-395): ledger de cada tentativa do Atlas de concluir o recebimento FISCAL de uma NF nacional no OMIE (EDITAR -> IGNORAR -> ConcluirRecebimento). Linha em_andamento gravada ANTES da primeira chamada = lock; uma linha viva por NF. erro_omie_* e tecnico e nunca vai a UI.';

CREATE UNIQUE INDEX IF NOT EXISTS recebimento_fiscal_nf_viva_uq
    ON stockbridge.recebimento_fiscal (nf_chave_acesso)
    WHERE status IN ('em_andamento', 'concluido', 'ja_concluido');

CREATE INDEX IF NOT EXISTS recebimento_fiscal_status_idx
    ON stockbridge.recebimento_fiscal (status, iniciado_em DESC);

-- ── 4. Dispensa de NF pelo gestor ────────────────────────────────────────────
-- Tira da fila uma NF que nunca sera recebida fisicamente, com fiscal pendente
-- OU ja feito (decisao de 02/10/2026). Nao executa nada no OMIE; a situacao
-- fiscal e guardada para o gestor saber se ha conta a pagar a tratar. Reversao
-- = UPDATE em revertido_* (soft), nunca DELETE.
CREATE TABLE IF NOT EXISTS stockbridge.nf_dispensa (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nf_chave_acesso               VARCHAR(44)  NOT NULL,
    nota_fiscal                   VARCHAR(50)  NOT NULL,
    fornecedor_nome               VARCHAR(255),
    fornecedor_cnpj               VARCHAR(20),
    situacao_fiscal_na_dispensa   VARCHAR(10)  NOT NULL
                                  CHECK (situacao_fiscal_na_dispensa IN ('pendente', 'concluido')),
    motivo                        TEXT         NOT NULL,
    dispensado_por                UUID         NOT NULL REFERENCES atlas.users(id),
    dispensado_em                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
    revertido_por                 UUID                  REFERENCES atlas.users(id),
    revertido_em                  TIMESTAMPTZ,
    motivo_reversao               TEXT
);

COMMENT ON TABLE stockbridge.nf_dispensa IS
  'Feature 016 (ACXEGDP-395): NF nacional dispensada da fila pelo gestor (nunca sera recebida fisicamente), com motivo e situacao fiscal no momento. Sem acao no OMIE. Dispensa ativa = revertido_em IS NULL; reverter e UPDATE, nunca DELETE.';

CREATE UNIQUE INDEX IF NOT EXISTS nf_dispensa_ativa_uq
    ON stockbridge.nf_dispensa (nf_chave_acesso)
    WHERE revertido_em IS NULL;

CREATE INDEX IF NOT EXISTS nf_dispensa_lista_idx
    ON stockbridge.nf_dispensa (revertido_em, dispensado_em DESC);

-- ── 5. Triggers de auditoria (Principio IV — obrigatorias em toda tabela nova) ─
CREATE OR REPLACE FUNCTION stockbridge.audit_recebimento_fiscal()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'recebimento_fiscal', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_sb_recebimento_fiscal ON stockbridge.recebimento_fiscal;
CREATE TRIGGER trg_audit_sb_recebimento_fiscal
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.recebimento_fiscal
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_recebimento_fiscal();

CREATE OR REPLACE FUNCTION stockbridge.audit_nf_dispensa()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'nf_dispensa', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_sb_nf_dispensa ON stockbridge.nf_dispensa;
CREATE TRIGGER trg_audit_sb_nf_dispensa
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.nf_dispensa
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_nf_dispensa();
