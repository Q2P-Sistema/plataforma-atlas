-- Migration: 0058 — StockBridge: compra nacional da ACXE no recebimento por NF (ACXEGDP-437, Historia 5)
--
-- Antes: o recebimento nacional por NF (features 015/016/017) so tratava a Q2P. A ACXE
--   recebe as compras nacionais dela pelo portal do OMIE, com estoque: de jul/2025 a
--   out/2026, 50 NFs no 20.0.7 PRODUCAO (Solutec PP PRETO Q35, Tritec, Replas, GGA e a
--   propria Q2P), 1 no 20.0.5 PROCESSO, 3 no 21.2 EXTREMA (NACIONAL). O primeiro PC
--   nacional da ACXE (PC 580, Solutec) foi lancado em 21/10/2026, apontando para o 20.0.7.
-- Agora: a NF nacional da ACXE entra na mesma fila (chave
--   STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED), com fiscal e vinculo de PC no OMIE
--   da ACXE. O operador escolhe o local (decisao do usuario em 22/10/2026, que substitui
--   o "sempre espelhado" da spec): local que tambem e da Q2P (11.1, 12.1, 21.1, 31.1)
--   -> entrada na ACXE e na Q2P pelo mesmo valor; local so da ACXE (20.0.7, 20.0.5,
--   21.2) -> entrada so na ACXE. O local do PC vem pre-selecionado. Esta migration:
--   (1) cria o espelho de recebimentos de NF-e da ACXE onde ele ainda nao existe (em
--       PROD ja existe, vazio; o n8n "ACXE - Exporta Recebimentos NF-e" o escreve);
--   (2) stockbridge.fornecedor_exclusao ganha empresa; a Q2P (matriz e filial) fica
--       excluida da fila da ACXE (intercompany: 12 NFs de STRETCH da Q2P no 20.0.7);
--   (3) cadastra os locais 20.0.5 PROCESSO e 20.0.7 PRODUCAO (tipo novo
--       'operacional', so com o codigo da ACXE): sem eles o local do PC 580 nao tem
--       correspondente no Atlas;
--   (4) indice de idempotencia da entrada nacional da ACXE (o da 0052 exige
--       produto_codigo_q2p, ausente na entrada so na ACXE), e o da 0052 passa a
--       valer so para a Q2P;
--   (5) pedido_compra_visto (0057) guarda produto e local do item do PC, para a
--       pre-selecao do local tambem quando o PC sai da lista de pendentes.
-- Porque: a mesma fila e o mesmo fiscal valem para a ACXE; a entrada no local de
--   producao segue o que a ACXE ja faz no portal, sem por materia-prima de producao
--   no estoque de venda da Q2P. Nenhuma linha existente muda de sentido: empresa das
--   exclusoes existentes = 'q2p'.
--
-- Aplicar ANTES da imagem, com o dono das tabelas (postgres em PROD), como a 0056:
--   PGOPTIONS='-c lock_timeout=5s' psql "$URL" -1 -q -v ON_ERROR_STOP=1 -f <este arquivo>
--
-- Ver specs/017-recebimento-nacional-com-pc/ (research D11 e D18; data-model §2, §6, §11, §12).

-- ── 1. Espelho de recebimentos de NF-e da ACXE (escritor: n8n) ─────────────────
-- Mesma DDL das tabelas da Q2P (0053 + colunas de pedido da 0056). Em PROD as duas
-- tabelas ja existem (criadas vazias em 21/10/2026): nada e feito la. So cria o que
-- falta, dentro de um bloco, para nao pedir lock nem posse de tabela existente.
DO $$
BEGIN
    IF to_regclass('public."tbl_recebimentoNFe_ACXE"') IS NULL THEN
        EXECUTE $ddl$
            CREATE TABLE public."tbl_recebimentoNFe_ACXE" (
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
            )
        $ddl$;
        EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "tbl_recebimentoNFe_ACXE_chave_idx" ON public."tbl_recebimentoNFe_ACXE" (c_chave_nfe)';
        EXECUTE 'CREATE INDEX IF NOT EXISTS "tbl_recebimentoNFe_ACXE_pendente_idx" ON public."tbl_recebimentoNFe_ACXE" (c_recebido, c_cancelada)';
        EXECUTE 'CREATE INDEX IF NOT EXISTS "tbl_recebimentoNFe_ACXE_emissao_idx" ON public."tbl_recebimentoNFe_ACXE" (d_emissao)';
        EXECUTE $ddl$
            COMMENT ON TABLE public."tbl_recebimentoNFe_ACXE" IS
              'Espelho OMIE ACXE da caixa Recebimento de NF-e (produtos/recebimentonfe/ListarRecebimentos). ESCRITO SO PELO n8n ("ACXE - Exporta Recebimentos NF-e"). Fonte "fiscal pendente" da fila de recebimento nacional para NF da ACXE (feature 017, Historia 5, ACXEGDP-437). DDL canonica em packages/db/migrations/0058.'
        $ddl$;
    ELSE
        RAISE NOTICE '0058: public."tbl_recebimentoNFe_ACXE" ja existe — nao alterada';
    END IF;

    IF to_regclass('public."tbl_recebimentoNFe_itens_ACXE"') IS NULL THEN
        EXECUTE $ddl$
            CREATE TABLE public."tbl_recebimentoNFe_itens_ACXE" (
              n_id_receb               BIGINT NOT NULL REFERENCES public."tbl_recebimentoNFe_ACXE"(n_id_receb) ON DELETE CASCADE,
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
              n_id_pedido              BIGINT,
              n_id_it_pedido           BIGINT,
              n_num_ped_compra         VARCHAR(15),
              c_num_it_ped_compra      INTEGER,
              PRIMARY KEY (n_id_receb, n_sequencia)
            )
        $ddl$;
        EXECUTE $ddl$
            COMMENT ON TABLE public."tbl_recebimentoNFe_itens_ACXE" IS
              'Itens do espelho de recebimentos de NF-e da ACXE (n8n, cExibirDetalhes=S). Vinculo do OMIE com o pedido de compra = n_id_pedido > 0 (ACXEGDP-437). DDL canonica em packages/db/migrations/0058.'
        $ddl$;
    ELSE
        RAISE NOTICE '0058: public."tbl_recebimentoNFe_itens_ACXE" ja existe — nao alterada';
    END IF;
END
$$;

-- ── 2. fornecedor_exclusao: empresa ────────────────────────────────────────────
-- A exclusao passa a valer por empresa: as linhas existentes (PLASTFIX e a propria
-- ACXE, fora da fila da Q2P) ficam 'q2p'. O indice unico parcial passa a incluir a
-- empresa, para o mesmo CNPJ poder ser excluido nas duas.
ALTER TABLE stockbridge.fornecedor_exclusao
    ADD COLUMN IF NOT EXISTS empresa VARCHAR(4) NOT NULL DEFAULT 'q2p';

ALTER TABLE stockbridge.fornecedor_exclusao DROP CONSTRAINT IF EXISTS fornecedor_exclusao_empresa_check;
ALTER TABLE stockbridge.fornecedor_exclusao
    ADD CONSTRAINT fornecedor_exclusao_empresa_check CHECK (empresa IN ('q2p', 'acxe'));

DROP INDEX IF EXISTS stockbridge.fornecedor_exclusao_ativa_idx;
CREATE UNIQUE INDEX IF NOT EXISTS fornecedor_exclusao_ativa_idx
    ON stockbridge.fornecedor_exclusao (empresa, fornecedor_cnpj)
    WHERE reincluido_em IS NULL;

COMMENT ON COLUMN stockbridge.fornecedor_exclusao.empresa IS
  'Empresa cuja fila de recebimento nacional exclui o fornecedor (q2p | acxe). Feature 017, Historia 5 (0058).';

-- Seed: a Q2P (matriz e filial, com mascara como no cadastro da ACXE) fora da fila
-- da ACXE — NF da Q2P para a ACXE e intercompany. excluido_por e NOT NULL: o
-- diretor mais antigo ativo, senao o gestor mais antigo (mesmo criterio da 0052).
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
        RAISE WARNING 'migration 0058: nenhum usuario diretor/gestor encontrado — exclusao da Q2P na fila da ACXE NAO aplicada. Excluir 27.019.059/0001-88 e 27.019.059/0002-69 (empresa ACXE) pela tela apos criar usuarios.';
        RETURN;
    END IF;

    INSERT INTO stockbridge.fornecedor_exclusao (empresa, fornecedor_cnpj, fornecedor_nome, motivo, excluido_por)
    SELECT 'acxe', v.cnpj, v.nome, v.motivo, v_user
      FROM (VALUES
        ('27.019.059/0001-88', 'Q2P COMERCIO ATACADISTA DE PLASTICOS E SUAS OBRAS LTDA',
         'Contraparte intercompany (Q2P matriz) — NF da Q2P para a ACXE fora da fila de compra nacional da ACXE (ACXEGDP-437)'),
        ('27.019.059/0002-69', 'Q2P COMERCIO ATACADISTA DE PLASTICOS E SUAS OBRAS LTDA',
         'Contraparte intercompany (Q2P filial) — NF da Q2P para a ACXE fora da fila de compra nacional da ACXE (ACXEGDP-437)')
      ) AS v(cnpj, nome, motivo)
    ON CONFLICT (empresa, fornecedor_cnpj) WHERE reincluido_em IS NULL DO NOTHING;
END
$seed$;

-- ── 3. Locais operacionais da ACXE: 20.0.5 PROCESSO e 20.0.7 PRODUCAO ───────────
-- Tipo novo 'operacional': entra so como destino do recebimento nacional da ACXE.
-- galpao e cnpj ficam NULL (como o 21.2): assim os locais ficam fora do Meu Estoque,
-- do destino de transferencia da saida manual e da tela de galpoes por usuario, e a
-- resolucao das saidas (tipo = 'proprio') os recusa. Correlacao so com o codigo do
-- local no OMIE da ACXE (nao existem na Q2P).
ALTER TABLE stockbridge.localidade DROP CONSTRAINT IF EXISTS localidade_tipo_check;
ALTER TABLE stockbridge.localidade
    ADD CONSTRAINT localidade_tipo_check
    CHECK (tipo IN ('proprio', 'tpl', 'porto_seco', 'virtual_transito', 'virtual_ajuste', 'operacional'));

INSERT INTO stockbridge.localidade (codigo, nome, tipo, ativo)
VALUES
    ('20.0.5', 'PROCESSO', 'operacional', true),
    ('20.0.7', 'PRODUÇÃO', 'operacional', true)
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO stockbridge.localidade_correlacao (localidade_id, codigo_local_estoque_acxe)
SELECT l.id, v.codigo_acxe
  FROM stockbridge.localidade l
  JOIN (VALUES ('20.0.5', 4530985781::bigint), ('20.0.7', 4553940398::bigint)) AS v(codigo, codigo_acxe)
    ON v.codigo = l.codigo
ON CONFLICT DO NOTHING;

-- ── 4. Idempotencia da entrada nacional da ACXE ────────────────────────────────
-- A movimentacao da NF da ACXE grava produto_codigo_acxe (e produto_codigo_q2p so
-- quando o local tambem e da Q2P). O indice da 0052 (produto_codigo_q2p IS NOT NULL)
-- nao protege a entrada so na ACXE: este protege as duas, pela linha da NF e pelo
-- produto da ACXE. Mesmo predicado de soft delete: ativo=false libera reprocessar.
CREATE UNIQUE INDEX IF NOT EXISTS movimentacao_nf_nacional_acxe_idempotencia_idx
    ON stockbridge.movimentacao (nf_chave_acesso, nf_item_descricao_normalizada, produto_codigo_acxe)
    WHERE subtipo = 'compra_nacional'
      AND ativo = true
      AND empresa = 'acxe'
      AND nf_chave_acesso IS NOT NULL
      AND produto_codigo_acxe IS NOT NULL;

COMMENT ON INDEX stockbridge.movimentacao_nf_nacional_acxe_idempotencia_idx IS
  'Idempotencia do recebimento nacional por NF da ACXE (feature 017, Historia 5): nunca duas movimentacoes do mesmo produto da ACXE para a mesma linha da NF. Soft-deleted (ativo=false) liberam reprocessamento.';

-- O indice da 0052 passa a valer so para a Q2P. A linha da ACXE que entra nas duas
-- empresas leva produto_codigo_q2p (o correspondente na Q2P); sob o indice antigo,
-- dois produtos DIFERENTES da ACXE com o mesmo correspondente, gravados em envios
-- separados da mesma linha da NF, colidiriam e o segundo seria dado como "ja
-- recebido", perdendo o peso em silencio. A ACXE fica com o indice acima (por
-- produto da ACXE). Todas as linhas atuais do indice sao da Q2P: nada muda para elas.
DROP INDEX IF EXISTS stockbridge.movimentacao_nf_nacional_idempotencia_idx;
CREATE UNIQUE INDEX IF NOT EXISTS movimentacao_nf_nacional_idempotencia_idx
    ON stockbridge.movimentacao (nf_chave_acesso, nf_item_descricao_normalizada, produto_codigo_q2p)
    WHERE subtipo = 'compra_nacional'
      AND ativo = true
      AND empresa = 'q2p'
      AND nf_chave_acesso IS NOT NULL
      AND produto_codigo_q2p IS NOT NULL;

COMMENT ON INDEX stockbridge.movimentacao_nf_nacional_idempotencia_idx IS
  'Idempotencia do recebimento nacional por NF da Q2P (feature 015; so a Q2P desde a 0058): uma linha da NF pode gerar N movimentacoes (uma por produto classificado), mas nunca duas do mesmo produto para a mesma linha. Soft-deleted (ativo=false) liberam reprocessamento.';

-- ── 5. Cache de PCs vistos: produto e local do item do PC ──────────────────────
-- Para pre-selecionar o local da entrada tambem quando o PC sai da lista de
-- pendentes (o caso que a 0057 resolve para numero e saldo). A primeira rodada do
-- registro grava as duas colunas em todas as linhas (uma mudanca por linha na
-- auditoria, uma vez so).
ALTER TABLE stockbridge.pedido_compra_visto
    ADD COLUMN IF NOT EXISTS n_cod_prod BIGINT,
    ADD COLUMN IF NOT EXISTS codigo_local_estoque BIGINT;

COMMENT ON COLUMN stockbridge.pedido_compra_visto.n_cod_prod IS
  'ncodprod do item do PC (produto no OMIE da empresa) — sugestao de produto da entrada (0058).';
COMMENT ON COLUMN stockbridge.pedido_compra_visto.codigo_local_estoque IS
  'codigo_local_estoque do item do PC (local no OMIE da empresa) — pre-selecao do local da entrada (0058).';
