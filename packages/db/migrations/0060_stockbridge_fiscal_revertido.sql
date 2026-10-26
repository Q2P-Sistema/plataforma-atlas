-- Migration: 0060 — recebimento fiscal revertido no OMIE (feature 017, ACXEGDP-437)
--
-- Antes: 'concluido' e 'ja_concluido' eram finais no ledger stockbridge.recebimento_fiscal. Se o
--        recebimento fosse revertido no portal do OMIE depois, o Atlas nao percebia: a fila
--        mostrava a NF como "fiscal ja feito" e o clique do operador fazia so o fisico, deixando a
--        NF parada na etapa 40 do OMIE, sem conta a pagar e sem baixa no PC (NF 19252, 25/10/2026:
--        concluida pelo Atlas as 17:02 e revertida no portal as 17:13).
-- Agora: o Atlas reconhece a reversao (espelho de recebimentos alterado depois da conclusao, ou
--        leitura ao vivo no clique do recebimento) e marca a tentativa como 'revertido'; a NF volta
--        a fila como "fiscal pendente" e o fiscal e concluido de novo no proximo recebimento. Esta
--        migration:
--          (1) recebimento_fiscal: status 'revertido' e o rastro da reversao — revertido_em (quando
--              o Atlas percebeu), revertido_origem ('espelho' | 'omie_ao_vivo'), revertido_omie_em
--              (hora da alteracao no OMIE, quando o espelho a traz), revertido_por (quem clicou,
--              na leitura ao vivo) e aviso_fiscal_em (e-mail ao fiscal quando a entrada fisica ja
--              estava lancada e a NF nao volta a fila); indice por chave de acesso;
--          (2) recebimento_fiscal_pc: status 'revertido'. Os vinculos da tentativa revertida saem
--              do indice unico de item vivo — senao a reserva da nova tentativa do fiscal violaria
--              recebimento_fiscal_pc_item_vivo_uq (0056) — e deixam de contar no saldo do PC (a
--              reversao devolve o saldo no OMIE: PC 308 voltou a 0 recebido).
-- Porque: decisao de 25/10/2026 (D21 da 017).
--
-- Aditiva e idempotente. Aplicar ANTES da imagem: sem a coluna revertido_em o codigo novo confere o
-- information_schema e segue sem a D21 (comportamento de antes, com erro no log). Os indices de NF
-- viva (recebimento_fiscal_nf_viva_uq, 0053) e de item vivo (recebimento_fiscal_pc_item_vivo_uq,
-- 0056) nao mudam: listam os status vivos, e 'revertido' fica de fora sozinho. As duas tabelas ja
-- tem trigger de auditoria (0053, 0056), que grava as colunas novas via to_jsonb.
-- Ver specs/017-recebimento-nacional-com-pc/research.md, D21.

-- ── 1. Ledger do fiscal: status e rastro da reversao ────────────────────────

ALTER TABLE stockbridge.recebimento_fiscal
  ADD COLUMN IF NOT EXISTS revertido_em      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revertido_origem  VARCHAR(14),
  ADD COLUMN IF NOT EXISTS revertido_omie_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revertido_por     UUID REFERENCES atlas.users(id),
  ADD COLUMN IF NOT EXISTS aviso_fiscal_em   TIMESTAMPTZ;

ALTER TABLE stockbridge.recebimento_fiscal DROP CONSTRAINT IF EXISTS recebimento_fiscal_status_check;
ALTER TABLE stockbridge.recebimento_fiscal
  ADD CONSTRAINT recebimento_fiscal_status_check
  CHECK (status IN ('em_andamento', 'concluido', 'ja_concluido', 'falha', 'revertido'));

ALTER TABLE stockbridge.recebimento_fiscal DROP CONSTRAINT IF EXISTS recebimento_fiscal_revertido_origem_check;
ALTER TABLE stockbridge.recebimento_fiscal
  ADD CONSTRAINT recebimento_fiscal_revertido_origem_check
  CHECK (revertido_origem IS NULL OR revertido_origem IN ('espelho', 'omie_ao_vivo'));

ALTER TABLE stockbridge.recebimento_fiscal DROP CONSTRAINT IF EXISTS recebimento_fiscal_revertido_check;
ALTER TABLE stockbridge.recebimento_fiscal
  ADD CONSTRAINT recebimento_fiscal_revertido_check
  CHECK (status <> 'revertido' OR (revertido_em IS NOT NULL AND revertido_origem IS NOT NULL));

-- O sinal de reversao procura, por chave, a ultima conclusao e o ultimo marcador 'revertido'; o
-- indice parcial de NF viva so cobre os status vivos.
CREATE INDEX IF NOT EXISTS recebimento_fiscal_chave_idx
    ON stockbridge.recebimento_fiscal (nf_chave_acesso, status);

COMMENT ON COLUMN stockbridge.recebimento_fiscal.revertido_em IS
  'Quando o Atlas percebeu que o recebimento concluido foi revertido no OMIE (status revertido). Feature 017, research D21.';
COMMENT ON COLUMN stockbridge.recebimento_fiscal.revertido_origem IS
  'Como a reversao foi percebida: espelho (espelho de recebimentos alterado depois da conclusao, varredura do cron ou nova tentativa do fiscal) ou omie_ao_vivo (leitura do recebimento no clique do recebimento fisico).';
COMMENT ON COLUMN stockbridge.recebimento_fiscal.revertido_omie_em IS
  'Hora da alteracao do recebimento no OMIE que mostrou a reversao (d_alt + h_alt do espelho, horario de Brasilia), quando conhecida. E o marcador que o sinal de reversao le na origem espelho (COALESCE(revertido_omie_em, revertido_em)): a hora da reversao, nunca a hora em que o Atlas a percebeu.';
COMMENT ON COLUMN stockbridge.recebimento_fiscal.revertido_por IS
  'Usuario cujo clique levou a leitura ao vivo que percebeu a reversao (NULL quando foi pelo espelho).';
COMMENT ON COLUMN stockbridge.recebimento_fiscal.aviso_fiscal_em IS
  'Quando o fiscal foi avisado por e-mail de que a reversao precisa ser refeita no portal: so quando a entrada fisica da NF ja estava lancada no Atlas (a NF nao volta a fila).';

COMMENT ON TABLE stockbridge.recebimento_fiscal IS
  'Feature 016 (ACXEGDP-395): ledger de cada tentativa do Atlas de concluir o recebimento FISCAL de uma NF nacional no OMIE. Linha em_andamento gravada ANTES da primeira chamada = lock; uma linha viva por NF. Feature 017 (0060, research D21): concluido/ja_concluido viram revertido quando o recebimento e revertido no OMIE depois; a NF volta a fila como fiscal pendente. erro_omie_* e tecnico e nunca vai a UI.';

-- ── 2. Vinculos com o PC da tentativa revertida ──────────────────────────────

ALTER TABLE stockbridge.recebimento_fiscal_pc DROP CONSTRAINT IF EXISTS recebimento_fiscal_pc_status_check;
ALTER TABLE stockbridge.recebimento_fiscal_pc
  ADD CONSTRAINT recebimento_fiscal_pc_status_check
  CHECK (status IN ('confirmado', 'associado', 'concluido', 'falha', 'revertido'));

COMMENT ON COLUMN stockbridge.recebimento_fiscal_pc.status IS
  'confirmado (reserva de saldo) -> associado -> concluido | falha. revertido (0060, research D21 da 017): o recebimento foi revertido no OMIE depois de concluido; a linha sai do indice de item vivo e do saldo do PC, e a nova tentativa do fiscal grava linhas novas.';
