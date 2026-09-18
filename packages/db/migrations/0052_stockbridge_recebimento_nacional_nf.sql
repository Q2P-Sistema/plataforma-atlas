-- Migration: 0052 — StockBridge: recebimento nacional a partir da NF do fornecedor (ACXEGDP-328)
--
-- Antes: o recebimento nacional era 100% digitado — numero da NF em texto livre
--   (nunca consultado), valor total, produto, quantidade, unidade e um "valor
--   unitario de referencia" que servia so de peso para rateio. Nada amarrava a
--   movimentacao ao documento fiscal: `nota_fiscal` guardava o que o operador
--   digitou, sem chave de acesso e sem a linha da NF de origem. Consequencias
--   medidas em PROD/UAT: ~32% dos recebimentos com peso diferente da NF sem
--   nenhum rastro; tres NFs da ISOFORMA lancadas em dobro (~40,7 t) porque a
--   carga do dia foi registrada sob a NF do dia anterior; e nenhuma barreira
--   de idempotencia no caminho nacional (o indice da 0046 cobre so entrada_nf
--   por produto_codigo_acxe, que e NULL em 100% das linhas nacionais).
-- Agora: a NF vem de uma fila alimentada pelo espelho Postgres. Esta migration
--   cria a estrutura que sustenta isso:
--   (1) tabela de correlacao (fornecedor, descricao do item) -> produtos Q2P,
--       1:N porque sucata entra como uma linha fiscal e e classificada por grau;
--   (2) em movimentacao: chave de acesso (identidade do documento — o NUMERO
--       colide entre fornecedores, 125 colisoes em 3.241 NFs), a descricao do
--       item de origem (97,5% dos itens nao tem codigo de produto, entao a
--       pendencia por item e por descricao) e quantidade da NF + divergencia;
--   (3) em aprovacao: identidade da NF e o tipo 'recebimento_externo' (baixa
--       de item que entrou fora do Atlas), com relaxamento do CHECK que exigia
--       lote ou produto — a baixa externa nao tem nenhum dos dois;
--   (4) indice unico de idempotencia do caminho nacional, por (chave, descricao
--       normalizada, produto) — a descricao entra para que duas linhas distintas
--       da NF classificadas no mesmo produto nao colidam e percam quantidade;
--   (5) extensao unaccent, usada pela normalizacao de descricao em SQL;
--   (6) seed das exclusoes de fornecedor decididas em 17/09/2026 (PLASTFIX e a
--       contraparte intercompany ACXE) — sem elas a fila nasce com 77% de NFs
--       fora do escopo.
-- Porque: erro de quantidade e de valor em NF de alto valor unitario, e
--   estoque lancado em duplicidade sem barreira. O caminho manual permanece
--   (NF fora do espelho) — nada aqui o altera. Linhas historicas ficam com as
--   colunas novas NULL e FORA do indice novo: a migration nao e bloqueada pelo
--   passivo de dados, e o passivo da ISOFORMA foi corrigido em separado.
--
-- Ver specs/015-recebimento-nacional-nf/ (research D11, D19, D20, D21, D22).

-- ── 1. Extensao unaccent ─────────────────────────────────────────────────────
-- A normalizacao de descricao (caixa alta, espacos colapsados, sem acento) roda
-- em SQL na query da fila, para casar o espelho com o que esta gravado. A
-- extensao esta DISPONIVEL nos bancos mas nao criada — sem ela a query falha e
-- o degrade da fila devolve lista vazia em silencio.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ── 2. Tabela de correlacao fornecedor x descricao -> produto ────────────────
CREATE TABLE IF NOT EXISTS stockbridge.correlacao_produto_fornecedor (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fornecedor_cnpj        VARCHAR(50)  NOT NULL,
    fornecedor_nome        VARCHAR(255) NOT NULL,
    descricao_nf           VARCHAR(500) NOT NULL,
    descricao_normalizada  VARCHAR(500) NOT NULL,
    produto_codigo_q2p     BIGINT       NOT NULL,
    produto_descricao      VARCHAR(255) NOT NULL,
    vezes_usada            INTEGER      NOT NULL DEFAULT 0,
    ultima_vez_usada_em    TIMESTAMPTZ,
    criado_por             UUID         NOT NULL REFERENCES atlas.users(id),
    atualizado_por         UUID                  REFERENCES atlas.users(id),
    ativo                  BOOLEAN      NOT NULL DEFAULT true,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE stockbridge.correlacao_produto_fornecedor IS
  'Feature 015 (ACXEGDP-328): memoria do De->Para entre a descricao livre do item da NF do fornecedor e os produtos do catalogo Q2P. 1:N por descricao (sucata classificada por grau). Correcao = UPDATE ou ativo=false, nunca DELETE.';

-- Um par (fornecedor, descricao) aponta para N produtos; cada produto uma vez
-- por par enquanto ativo. A chave inclui o produto justamente por ser 1:N.
CREATE UNIQUE INDEX IF NOT EXISTS correlacao_produto_fornecedor_ativa_idx
    ON stockbridge.correlacao_produto_fornecedor (fornecedor_cnpj, descricao_normalizada, produto_codigo_q2p)
    WHERE ativo = true;

CREATE INDEX IF NOT EXISTS correlacao_produto_fornecedor_lookup_idx
    ON stockbridge.correlacao_produto_fornecedor (fornecedor_cnpj, descricao_normalizada);

-- ── 3. Trigger de auditoria (Principio IV — obrigatoria em toda tabela nova) ─
CREATE OR REPLACE FUNCTION stockbridge.audit_correlacao_produto_fornecedor()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'correlacao_produto_fornecedor', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_sb_correlacao_produto_fornecedor ON stockbridge.correlacao_produto_fornecedor;
CREATE TRIGGER trg_audit_sb_correlacao_produto_fornecedor
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.correlacao_produto_fornecedor
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_correlacao_produto_fornecedor();

-- ── 4. movimentacao: identidade da NF, linha de origem, quantidade da NF ─────
ALTER TABLE stockbridge.movimentacao
    ADD COLUMN IF NOT EXISTS nf_chave_acesso               VARCHAR(44),
    ADD COLUMN IF NOT EXISTS nf_item_descricao             VARCHAR(500),
    ADD COLUMN IF NOT EXISTS nf_item_descricao_normalizada VARCHAR(500),
    ADD COLUMN IF NOT EXISTS quantidade_nf_kg              NUMERIC(12,3),
    ADD COLUMN IF NOT EXISTS quantidade_divergencia_kg     NUMERIC(12,3);

COMMENT ON COLUMN stockbridge.movimentacao.nf_chave_acesso IS
  'Chave de acesso NF-e (44 dig) do documento de origem. Identidade do documento: o numero colide entre fornecedores. NULL no historico e no formulario manual (NF fora do espelho).';
COMMENT ON COLUMN stockbridge.movimentacao.nf_item_descricao IS
  'Descricao do item da NF (x_prod) que originou esta movimentacao, como veio.';
COMMENT ON COLUMN stockbridge.movimentacao.nf_item_descricao_normalizada IS
  'A mesma, normalizada (trim, espacos colapsados, caixa alta, sem acento). Participa da chave de idempotencia e da pendencia por item.';
COMMENT ON COLUMN stockbridge.movimentacao.quantidade_nf_kg IS
  'Parcela da quantidade DECLARADA na NF atribuida a esta movimentacao (proporcional ao peso em item distribuido). quantidade_kg = conferida na balanca.';
COMMENT ON COLUMN stockbridge.movimentacao.quantidade_divergencia_kg IS
  'quantidade_kg - quantidade_nf_kg. Positiva = recebemos mais que a NF (aceito no nacional, com motivo e aprovacao).';

-- Idempotencia do caminho nacional. Componentes forcados por evidencia:
--  - nf_chave_acesso (nao nota_fiscal): o numero colide entre fornecedores;
--  - nf_item_descricao_normalizada: duas linhas da mesma NF no mesmo produto
--    sao recebimentos distintos e ambos somam;
--  - produto_codigo_q2p (nao _acxe): o nacional e single-empresa, _acxe e NULL;
--  - subtipo (nao tipo_movimento): entrada_manual cobre outros subtipos.
-- Linhas sem chave ficam fora — a migration nao e bloqueada por historico.
CREATE UNIQUE INDEX IF NOT EXISTS movimentacao_nf_nacional_idempotencia_idx
    ON stockbridge.movimentacao (nf_chave_acesso, nf_item_descricao_normalizada, produto_codigo_q2p)
    WHERE subtipo = 'compra_nacional'
      AND ativo = true
      AND nf_chave_acesso IS NOT NULL
      AND produto_codigo_q2p IS NOT NULL;

COMMENT ON INDEX stockbridge.movimentacao_nf_nacional_idempotencia_idx IS
  'Idempotencia do recebimento nacional por NF (feature 015): uma linha da NF pode gerar N movimentacoes (uma por produto classificado), mas nunca duas do mesmo produto para a mesma linha. Soft-deleted (ativo=false) liberam reprocessamento.';

-- ── 5. aprovacao: identidade da NF + tipo recebimento_externo ───────────────
ALTER TABLE stockbridge.aprovacao
    ADD COLUMN IF NOT EXISTS nf_chave_acesso   VARCHAR(44),
    ADD COLUMN IF NOT EXISTS nota_fiscal       VARCHAR(50),
    ADD COLUMN IF NOT EXISTS nf_item_descricao VARCHAR(500);

COMMENT ON COLUMN stockbridge.aprovacao.nf_chave_acesso IS
  'Feature 015: identidade da NF. Obrigatoria em recebimento_externo (unica identidade que essa aprovacao tem); informativa nas demais.';

-- O CHECK enumera os tipos — sem estender, 'recebimento_externo' e rejeitado.
ALTER TABLE stockbridge.aprovacao
    DROP CONSTRAINT IF EXISTS aprovacao_tipo_aprovacao_check;
ALTER TABLE stockbridge.aprovacao
    ADD CONSTRAINT aprovacao_tipo_aprovacao_check CHECK (
        tipo_aprovacao IN (
            'recebimento_divergencia', 'entrada_manual', 'saida_transf_intra',
            'saida_comodato', 'saida_amostra', 'saida_descarte', 'saida_quebra',
            'ajuste_inventario', 'retorno_comodato',
            'recebimento_externo'
        )
    );

-- aprovacao_chk_lote_ou_sku exigia lote OU (produto + galpao + empresa). Uma
-- baixa externa nao tem lote, nao tem produto (o item da fila so tem descricao)
-- e nao tem galpao — todo INSERT falharia com 23514. O ramo novo nao afrouxa a
-- regra: troca "identifica um item de estoque" por "identifica um documento
-- fiscal", que e a identidade que essa aprovacao de fato carrega.
ALTER TABLE stockbridge.aprovacao
    DROP CONSTRAINT IF EXISTS aprovacao_chk_lote_ou_sku;
ALTER TABLE stockbridge.aprovacao
    ADD CONSTRAINT aprovacao_chk_lote_ou_sku CHECK (
           lote_id IS NOT NULL
        OR (produto_codigo_acxe IS NOT NULL AND galpao IS NOT NULL AND empresa IS NOT NULL)
        OR (produto_codigo_q2p  IS NOT NULL AND galpao IS NOT NULL AND empresa IS NOT NULL)
        OR (tipo_aprovacao = 'recebimento_externo' AND nf_chave_acesso IS NOT NULL)
    );

-- ── 6. Seed: exclusoes de fornecedor decididas em 17/09/2026 ────────────────
-- E DADO, nao constante no codigo: decisao de negocio reversivel pela tela do
-- diretor (reincluir), com motivo e autor. excluido_por e NOT NULL -> elege o
-- diretor mais antigo ativo, senao o gestor mais antigo. Banco sem usuario
-- (instalacao virgem): avisa e segue, sem quebrar a migration — a verificacao
-- da T007 confere as duas linhas no ambiente real.
DO $seed$
DECLARE
    v_user UUID;
BEGIN
    SELECT u.id INTO v_user
      FROM atlas.users u
     WHERE u.deleted_at IS NULL AND u.role IN ('diretor', 'gestor')
     ORDER BY CASE u.role WHEN 'diretor' THEN 0 ELSE 1 END, u.created_at
     LIMIT 1;

    IF v_user IS NULL THEN
        RAISE WARNING 'migration 0052: nenhum usuario diretor/gestor encontrado — seed de fornecedor_exclusao NAO aplicado. Excluir PLASTFIX e ACXE pela tela apos criar usuarios.';
        RETURN;
    END IF;

    INSERT INTO stockbridge.fornecedor_exclusao (fornecedor_cnpj, fornecedor_nome, motivo, excluido_por)
    SELECT v.cnpj, v.nome, v.motivo, v_user
      FROM (VALUES
        ('29.654.678/0001-70', 'PLASTFIX COMERCIAL LTDA',
         'Fora do escopo da fila de recebimento nacional nesta fase — ACXEGDP-328, decisao de 17/09/2026'),
        ('42.672.052/0001-54', 'ACXE IMPORTACAO, EXPORTACAO , INDUSTRIA E COMERCIO DE POLIMEROS LTDA',
         'Contraparte intercompany — ja coberta pelo fluxo dual de recebimento de importacao (ACXEGDP-328)')
      ) AS v(cnpj, nome, motivo)
    -- fornecedor_exclusao_ativa_idx e parcial (WHERE reincluido_em IS NULL):
    -- o ON CONFLICT precisa repetir o predicado para casar com ele.
    ON CONFLICT (fornecedor_cnpj) WHERE reincluido_em IS NULL DO NOTHING;
END
$seed$;
