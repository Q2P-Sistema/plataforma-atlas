-- ============================================================================
-- >>> JÁ APLICADO EM 18/09/2026 — ESTE ARQUIVO É REGISTRO, NÃO AÇÃO PENDENTE <<<
--
-- Resultado verificado após o COMMIT, no banco que roda como produção do
-- StockBridge:
--
--   NF      NF (kg)    Atlas (kg)    delta
--   66529   13.385     13.500        +115
--   66530   13.558     13.500         -58
--   66552   13.494     13.500          +6
--   66553   13.506     13.500          -6
--   66604   13.385     13.500        +115
--   66635   13.271     13.500        +229
--
--   Total das 6 NFs: 81.000,000 kg — idêntico ao de antes da correção.
--   Movimentações: 8, as mesmas. Nenhuma criada, nenhuma removida.
--   shared.audit_log: 3 registros UPDATE, um por reatribuição.
--
-- É seguro rodar de novo: os UPDATE têm guarda pela NF de origem, então não
-- casam mais nada, e as verificações continuam passando. Seria um no-op.
--
-- POR QUE FICA GUARDADO: enquanto o recebimento nacional for digitado à mão,
-- este erro volta a acontecer — lançar a carga do dia sob a NF anterior que
-- ficou aberta na tela. Este arquivo é o procedimento para o próximo caso.
-- A feature 015 ataca a causa: a NF passa a vir de uma fila, não da memória
-- do operador.
-- ============================================================================


-- ============================================================================
-- Correção de atribuição fiscal — ISOFORMA, julho/2026
--
-- O QUE ACONTECEU: três cargas foram lançadas sob a NF do dia anterior, que
-- ainda estava aberta na tela. Resultado: 3 NFs constam recebidas em dobro e
-- 3 NFs constam nunca recebidas.
--
--   66529 (13.385 kg) recebeu 27.000  |  66552 (13.494 kg) recebeu 0
--   66530 (13.558 kg) recebeu 27.000  |  66553 (13.506 kg) recebeu 0
--   66604 (13.385 kg) recebeu 27.000  |  66635 (13.271 kg) recebeu 0
--
--   Excesso: +40.672 kg     Falta: -40.271 kg     Diferença: 401 kg
--   (os 401 kg são a soma dos desvios normais de balança do período)
--
-- O ESTOQUE FÍSICO ESTÁ CORRETO. Este script NÃO toca em estoque, NÃO chama o
-- OMIE e NÃO cria nem remove movimentação. Ele apenas reatribui três linhas à
-- NF correta. A trigger de auditoria registra tudo em shared.audit_log.
--
-- Banco: o que roda como produção do StockBridge (UAT / acxe_q2p).
--
-- COMO RODAR: "Executar script" (Alt+X). Uma vez só, do começo ao fim.
--
--   NÃO há nada para descomentar. O COMMIT no final é executável.
--   A segurança está no bloco de VERIFICAÇÃO, que roda antes do COMMIT e
--   dispara exceção se qualquer coisa sair do esperado — e exceção dentro da
--   transação desfaz tudo automaticamente. Ou commita certo, ou não commita.
-- ============================================================================


-- ─── 0. LIMPA TRANSAÇÃO ÓRFÃ ────────────────────────────────────────────────
-- Se uma execução anterior deixou transação abortada aberta nesta conexão,
-- todo comando falha com 25P02 até ela ser encerrada. Fora de transação, esta
-- linha só emite um aviso e segue — é inofensiva.

ROLLBACK;


-- ─── 1. ANTES ────────────────────────────────────────────────────────────────
-- Registro do estado inicial, para a trilha.

WITH nfs AS (
  SELECT ltrim(h.n_nf,'0') AS nf, h.d_emi::date AS emissao, sum(i.q_com) AS kg_nf
  FROM public."tbl_nf_header_Q2P" h
  JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
  WHERE h.tp_nf = 0
    AND ltrim(h.n_nf,'0') IN ('66529','66530','66552','66553','66604','66635')
  GROUP BY 1,2
)
SELECT n.nf, n.emissao, n.kg_nf,
       COALESCE(sum(m.quantidade_kg), 0)          AS kg_atlas,
       count(m.id)                                AS movs,
       COALESCE(sum(m.quantidade_kg),0) - n.kg_nf AS delta
FROM nfs n
LEFT JOIN stockbridge.movimentacao m
       ON m.ativo AND m.subtipo = 'compra_nacional'
      AND ltrim(m.nota_fiscal,'0') = n.nf
GROUP BY 1,2,3
ORDER BY n.emissao, n.nf::bigint;


-- ─── 2. CORREÇÃO ─────────────────────────────────────────────────────────────

BEGIN;

-- 66529 -> 66552  (carga de 28/07, lançada em 29/07)
UPDATE stockbridge.movimentacao
   SET nota_fiscal = '66552',
       observacoes = COALESCE(observacoes, '')
                  || ' | CORRECAO 2026-09-18: reatribuida de NF 66529 para 66552'
                  || ' - carga lancada sob a NF do dia anterior. Estoque nao alterado.'
 WHERE id = '58553d03-15cc-404c-a92f-4888b68dda92'
   AND ltrim(nota_fiscal,'0') = '66529';

-- 66530 -> 66553  (carga de 28/07, lançada em 29/07)
UPDATE stockbridge.movimentacao
   SET nota_fiscal = '66553',
       observacoes = COALESCE(observacoes, '')
                  || ' | CORRECAO 2026-09-18: reatribuida de NF 66530 para 66553'
                  || ' - carga lancada sob a NF do dia anterior. Estoque nao alterado.'
 WHERE id = 'a120cc24-c44e-4d29-9d29-50670404931a'
   AND ltrim(nota_fiscal,'0') = '66530';

-- 66604 -> 66635  (carga de 31/07, lançada em 03/08)
UPDATE stockbridge.movimentacao
   SET nota_fiscal = '66635',
       observacoes = COALESCE(observacoes, '')
                  || ' | CORRECAO 2026-09-18: reatribuida de NF 66604 para 66635'
                  || ' - carga lancada sob a NF do dia anterior. Estoque nao alterado.'
 WHERE id = '21ea5b99-23ff-49f0-b449-9198b32a0b9c'
   AND ltrim(nota_fiscal,'0') = '66604';


-- ─── 3. VERIFICAÇÃO AUTOMÁTICA ───────────────────────────────────────────────
-- Qualquer falha aqui aborta a transação e desfaz os UPDATEs sozinha.

DO $verifica$
DECLARE
  v_total       numeric;
  v_delta_max   numeric;
  v_reatribuidas int;
BEGIN
  -- (a) O estoque NÃO pode ter se movido: o total das 6 NFs tem que continuar 81.000 kg.
  SELECT COALESCE(sum(quantidade_kg), 0) INTO v_total
    FROM stockbridge.movimentacao
   WHERE ativo AND subtipo = 'compra_nacional'
     AND ltrim(nota_fiscal,'0') IN ('66529','66530','66552','66553','66604','66635');

  IF v_total IS DISTINCT FROM 81000.000 THEN
    RAISE EXCEPTION 'ABORTADO: o total das 6 NFs mudou. Esperado 81000.000, obtido %. Nenhuma alteracao foi aplicada.', v_total;
  END IF;

  -- (b) As 3 linhas têm que estar nas NFs de destino.
  SELECT count(*) INTO v_reatribuidas
    FROM stockbridge.movimentacao
   WHERE id IN ('58553d03-15cc-404c-a92f-4888b68dda92',
                'a120cc24-c44e-4d29-9d29-50670404931a',
                '21ea5b99-23ff-49f0-b449-9198b32a0b9c')
     AND ltrim(nota_fiscal,'0') IN ('66552','66553','66635');

  IF v_reatribuidas <> 3 THEN
    RAISE EXCEPTION 'ABORTADO: esperadas 3 reatribuicoes, encontradas %. Talvez a correcao ja tenha sido aplicada antes, ou os dados mudaram. Nenhuma alteracao foi aplicada.', v_reatribuidas;
  END IF;

  -- (c) Nenhuma das 6 NFs pode continuar com diferença grande (o caso ~13.500).
  SELECT max(abs(d.delta)) INTO v_delta_max
    FROM (
      SELECT COALESCE(sum(m.quantidade_kg),0) - n.kg_nf AS delta
        FROM (SELECT ltrim(h.n_nf,'0') AS nf, sum(i.q_com) AS kg_nf
                FROM public."tbl_nf_header_Q2P" h
                JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
               WHERE h.tp_nf = 0
                 AND ltrim(h.n_nf,'0') IN ('66529','66530','66552','66553','66604','66635')
               GROUP BY 1) n
   LEFT JOIN stockbridge.movimentacao m
          ON m.ativo AND m.subtipo = 'compra_nacional'
         AND ltrim(m.nota_fiscal,'0') = n.nf
       GROUP BY n.nf, n.kg_nf
    ) d;

  IF v_delta_max > 1000 THEN
    RAISE EXCEPTION 'ABORTADO: ainda ha NF com diferenca de % kg (esperado no maximo ~229, tolerancia de balanca). Nenhuma alteracao foi aplicada.', v_delta_max;
  END IF;

  RAISE NOTICE 'VERIFICACAO OK — total %, 3 linhas reatribuidas, maior diferenca % kg. Commitando.', v_total, v_delta_max;
END
$verifica$;


COMMIT;


-- ─── 4. DEPOIS (já commitado) ────────────────────────────────────────────────
-- Esperado: as 6 NFs com diferença de dezenas de kg — tolerância de balança.

WITH nfs AS (
  SELECT ltrim(h.n_nf,'0') AS nf, h.d_emi::date AS emissao, sum(i.q_com) AS kg_nf
  FROM public."tbl_nf_header_Q2P" h
  JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
  WHERE h.tp_nf = 0
    AND ltrim(h.n_nf,'0') IN ('66529','66530','66552','66553','66604','66635')
  GROUP BY 1,2
)
SELECT n.nf, n.emissao, n.kg_nf,
       COALESCE(sum(m.quantidade_kg), 0)          AS kg_atlas,
       count(m.id)                                AS movs,
       COALESCE(sum(m.quantidade_kg),0) - n.kg_nf AS delta
FROM nfs n
LEFT JOIN stockbridge.movimentacao m
       ON m.ativo AND m.subtipo = 'compra_nacional'
      AND ltrim(m.nota_fiscal,'0') = n.nf
GROUP BY 1,2,3
ORDER BY n.emissao, n.nf::bigint;


-- ─── 5. TRILHA DE AUDITORIA ──────────────────────────────────────────────────
-- Esperado: 3 registros UPDATE com nf_antes -> nf_depois.
-- (a coluna de tempo em shared.audit_log chama-se "ts", não "created_at")

SELECT operation,
       record_id,
       old_values->>'nota_fiscal' AS nf_antes,
       new_values->>'nota_fiscal' AS nf_depois,
       ts
FROM shared.audit_log
WHERE schema_name = 'stockbridge' AND table_name = 'movimentacao'
  AND record_id IN ('58553d03-15cc-404c-a92f-4888b68dda92',
                    'a120cc24-c44e-4d29-9d29-50670404931a',
                    '21ea5b99-23ff-49f0-b449-9198b32a0b9c')
  AND ts >= CURRENT_DATE
ORDER BY ts DESC;
