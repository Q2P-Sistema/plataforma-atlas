-- Migration: 0055 — StockBridge: sequência do item da NF nacional na movimentação (ACXEGDP-412)
--
-- Antes: a movimentação do recebimento nacional por NF (feature 015/016) se
--   ligava ao item da NF só pela descrição normalizada (nf_item_descricao_normalizada).
--   Na NF 36624 (06/10/2026) o item estava pré-associado a um produto no OMIE e o
--   espelho de recebimentos trazia a descrição do PRODUTO ("SUCATA DE PP"); depois
--   do IGNORAR do recebimento fiscal os dois espelhos passaram a trazer a do XML
--   ("SUCATA DE PLASTICO - POS CONSUMO") e o item recebido voltou inteiro à fila.
-- Agora: a movimentação guarda também a(s) sequência(s) do item no recebimento de
--   NF-e do OMIE (nSequencia), que não muda com o fiscal. A checagem "já recebido"
--   e as somas da fila casam por descrição OU por sequência.
-- Porque: o OMIE não expõe a descrição original do XML no ListarRecebimentos
--   (só cDescricaoProduto), e o n_id_item do recebimento só existe depois que o
--   fiscal é concluído — a sequência é a única identidade estável do item no
--   momento do recebimento.
--
-- Array porque um item da fila agrega as linhas de mesma descrição (D18/D20).
-- NULL nas linhas anteriores, no formulário manual e com o recebimento fora do
-- espelho — essas continuam casando só pela descrição. Sem backfill: em
-- 07/10/2026 só a NF 36624 estava afetada e já foi corrigida pelo UPDATE pontual.
-- O trigger de auditoria da movimentação (0008) grava to_jsonb(NEW): a coluna
-- nova entra no audit_log sem mudança nele.

ALTER TABLE stockbridge.movimentacao
  ADD COLUMN IF NOT EXISTS nf_item_sequencias integer[];

COMMENT ON COLUMN stockbridge.movimentacao.nf_item_sequencias IS
  'Sequências (nSequencia) do item no recebimento de NF-e do OMIE — identidade do item que não muda com o fiscal (ACXEGDP-412). NULL = casa só pela descrição.';
