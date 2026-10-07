import { getPool, createLogger } from '@atlas/core';
import { produtoPendenteSql } from './fiscal-recebida-sql.js';

const logger = createLogger('stockbridge:nf-pedido-mapa');

export interface NfPedidoMapaInput {
  pedido: string;
  nf_mae: string;
  nf_filhotes: string[];
}

/**
 * Contagem da carga, por pedido. `inseridos + atualizados + inalterados` = pedidos
 * processados. `reabertos` e `concluidos` contam mudança de situação do mapa
 * (`ativo`) e se sobrepõem às três primeiras.
 */
export interface UpsertResult {
  /** Pedido que ainda não tinha mapa — linha nova. */
  inseridos: number;
  /** NF mãe ou filhotes mudaram — a MESMA linha é atualizada. */
  atualizados: number;
  /** Mesma NF mãe e mesmas filhotes — o conteúdo não é regravado. */
  inalterados: number;
  /** Mapa concluído que voltou a ter produto pendente (ex.: filhote nova na FUP). */
  reabertos: number;
  /** Mapa que fechou nesta carga (todas as filhotes recebidas). */
  concluidos: number;
}

export interface NfPedidoMapaRow {
  id: string;
  pedido_acxe_omie: string;
  nf_mae: string;
  ativo: boolean;
  importado_em: string;
  updated_at: string;
  total_filhotes: string | number;
}

interface FilhoteMapa {
  nf: string;
  /** Coluna da FUP (NF Filhote 1..12). */
  posicao: number;
}

/** Filhotes como o mapa as guarda: posição = coluna da FUP; coluna vazia é pulada. */
function filhotesDoPayload(nfFilhotes: string[]): FilhoteMapa[] {
  const out: FilhoteMapa[] = [];
  nfFilhotes.forEach((nf, i) => {
    if (nf) out.push({ nf, posicao: i + 1 });
  });
  return out;
}

function mesmasFilhotes(a: FilhoteMapa[], b: FilhoteMapa[]): boolean {
  return a.length === b.length && a.every((f, i) => f.nf === b[i]?.nf && f.posicao === b[i]?.posicao);
}

/**
 * Upsert idempotente do mapeamento NF mãe/filhotes — no máximo UM mapa por pedido (ACXEGDP-409)
 * (índice único `nf_pedido_mapa_pedido_uq`, migration 0054).
 *
 * O n8n reenvia a aba inteira da FUP de hora em hora, inclusive pedidos já
 * concluídos. Por pedido:
 *   1. Sem mapa → INSERT do mapa e das filhotes.
 *   2. Com mapa (ativo ou concluído) → compara NF mãe e filhotes ativas:
 *      - iguais: o conteúdo não é regravado;
 *      - diferentes: a MESMA linha recebe a NF mãe, as filhotes anteriores são
 *        desativadas (soft delete) e as novas inseridas com posição 1-N.
 *   3. A situação do mapa é reavaliada em toda carga e só é gravada se mudar:
 *      fecha (ativo = false) quando todas as filhotes foram recebidas e REABRE
 *      quando um mapa concluído volta a ter produto pendente — filhote nova na
 *      FUP, ou recebimento desfeito (movimentação desativada na rejeição).
 *
 * Até a migration 0054 o upsert era um ON CONFLICT no índice parcial
 * `WHERE ativo = true`: pedido concluído não dava conflito e virava um mapa NOVO
 * a cada carga (30,8 mil mapas para 70 pedidos em PROD, 06/10/2026).
 *
 * Não valida o pedido contra tbl_pedidosCompras_ACXE no momento do INSERT:
 * pedido inexistente no ERP é aceito silenciosamente (FR-001).
 */
export async function upsertNfPedidoMapa(items: NfPedidoMapaInput[]): Promise<UpsertResult> {
  const pool = getPool();
  const client = await pool.connect();
  const result: UpsertResult = { inseridos: 0, atualizados: 0, inalterados: 0, reabertos: 0, concluidos: 0 };

  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

    for (const item of items) {
      const { pedido, nf_mae } = item;
      const filhotes = filhotesDoPayload(item.nf_filhotes);

      // Mesma ordem da limpeza da migration 0054: se ainda houver duplicatas
      // antigas (código novo antes da migration), vale a ativa ou, sem ativa,
      // a mais recente.
      const atualRes = await client.query<{ id: string; nf_mae: string; ativo: boolean }>(
        `SELECT id, nf_mae, ativo
         FROM stockbridge.nf_pedido_mapa
         WHERE pedido_acxe_omie = $1
         ORDER BY ativo DESC, importado_em DESC, updated_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [pedido],
      );
      const atual = atualRes.rows[0];

      let mapaId: string;
      let ativo: boolean;
      let trocarFilhotes: boolean;

      if (!atual) {
        const insertResult = await client.query<{ id: string }>(
          `INSERT INTO stockbridge.nf_pedido_mapa (pedido_acxe_omie, nf_mae)
           VALUES ($1, $2)
           RETURNING id`,
          [pedido, nf_mae],
        );
        const novo = insertResult.rows[0];
        if (!novo) continue;
        mapaId = novo.id;
        ativo = true;
        trocarFilhotes = true;
        result.inseridos++;
      } else {
        mapaId = atual.id;
        ativo = atual.ativo;
        const filhotesResult = await client.query<{ nf_filhote: string; posicao: number }>(
          `SELECT nf_filhote, posicao
           FROM stockbridge.nf_pedido_filhote
           WHERE mapa_id = $1 AND ativo = true
           ORDER BY posicao, nf_filhote`,
          [mapaId],
        );
        const filhotesAtuais = filhotesResult.rows.map((r) => ({ nf: r.nf_filhote, posicao: Number(r.posicao) }));
        trocarFilhotes = !mesmasFilhotes(filhotesAtuais, filhotes);

        if (atual.nf_mae === nf_mae && !trocarFilhotes) {
          result.inalterados++;
        } else {
          await client.query(
            `UPDATE stockbridge.nf_pedido_mapa
             SET nf_mae = $2, updated_at = now()
             WHERE id = $1`,
            [mapaId, nf_mae],
          );
          result.atualizados++;
        }
      }

      if (trocarFilhotes) {
        // Soft-delete das filhotes anteriores deste pedido
        await client.query(
          `UPDATE stockbridge.nf_pedido_filhote
           SET ativo = false
           WHERE mapa_id = $1 AND ativo = true`,
          [mapaId],
        );

        for (const f of filhotes) {
          await client.query(
            `INSERT INTO stockbridge.nf_pedido_filhote (mapa_id, nf_filhote, posicao)
             VALUES ($1, $2, $3)`,
            [mapaId, f.nf, f.posicao],
          );
        }
      }

      // Situação do mapa: fechado (ativo = false) quando todas as filhotes ativas
      // já foram recebidas. "Recebida" = n_id_receb > 0 no OMIE OU registrada em
      // movimentacao/movimentacao_legado (ACXEGDP-183) — NFs antigas recebidas no
      // legado nunca tiveram n_id_receb preenchido no OMIE.
      // Feature 014: granularidade por PRODUTO no caminho Atlas — uma filhote
      // multi-produto parcialmente recebida (feature 013) mantém o mapa ATIVO
      // enquanto qualquer produto estiver pendente (antes, 1 produto recebido
      // bastava para a filhote "resolver" e o mapa fechar cedo demais).
      // Filhote sem header sincronizado (h.n_id_nf NULL → itens NULL) conta como
      // pendente, como antes. Pedido sem filhote nunca fecha.
      // Nota: entre execuções do n8n o cockpit permanece correto (lido ao vivo).
      let pendente = true;
      if (filhotes.length > 0) {
        const pendResult = await client.query<{ pendente: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM stockbridge.nf_pedido_filhote f
             LEFT JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote, 8, '0')
             LEFT JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
             WHERE f.mapa_id = $1
               AND f.ativo = true
               AND (
                 h.n_id_nf IS NULL
                 OR ${produtoPendenteSql({
                   nfExpr: "LPAD(f.nf_filhote, 8, '0')",
                   produtoExpr: 'i.n_cod_prod',
                   nIdRecebExpr: 'h.n_id_receb',
                 })}
               )
           ) AS pendente`,
          [mapaId],
        );
        pendente = pendResult.rows[0]?.pendente ?? true;
      }

      if (ativo && !pendente) {
        await client.query(
          `UPDATE stockbridge.nf_pedido_mapa
           SET ativo = false, updated_at = now()
           WHERE id = $1`,
          [mapaId],
        );
        result.concluidos++;
        logger.info({ mapaId, pedido }, 'mapa auto-desativado: todas as filhotes recebidas');
      } else if (!ativo && pendente) {
        await client.query(
          `UPDATE stockbridge.nf_pedido_mapa
           SET ativo = true, updated_at = now()
           WHERE id = $1`,
          [mapaId],
        );
        result.reabertos++;
        logger.info({ mapaId, pedido }, 'mapa reaberto: há filhote pendente');
      }
    }

    await client.query('COMMIT');
    logger.info(result, 'upsertNfPedidoMapa concluído');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'upsertNfPedidoMapa falhou — rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lista todos os mapas ativos com contagem de filhotes.
 * Usado pelo endpoint GET /admin/nf-pedido-mapa para validação (gestor+).
 */
export async function listNfPedidoMapa(): Promise<NfPedidoMapaRow[]> {
  const pool = getPool();
  const result = await pool.query<NfPedidoMapaRow>(
    `SELECT
       mapa.id,
       mapa.pedido_acxe_omie,
       mapa.nf_mae,
       mapa.ativo,
       mapa.importado_em,
       mapa.updated_at,
       COUNT(f.id) AS total_filhotes
     FROM stockbridge.nf_pedido_mapa mapa
     LEFT JOIN stockbridge.nf_pedido_filhote f
       ON f.mapa_id = mapa.id AND f.ativo = true
     WHERE mapa.ativo = true
     GROUP BY mapa.id
     ORDER BY mapa.importado_em DESC`,
  );

  return result.rows.map((row) => ({
    ...row,
    total_filhotes: Number(row.total_filhotes),
  }));
}
