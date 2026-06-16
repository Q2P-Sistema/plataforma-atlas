import { getPool, createLogger } from '@atlas/core';
import { recebidaViaMovimentacaoSql, recebidaViaLegadoSql } from './fiscal-recebida-sql.js';

const logger = createLogger('stockbridge:nf-pedido-mapa');

export interface NfPedidoMapaInput {
  pedido: string;
  nf_mae: string;
  nf_filhotes: string[];
}

export interface UpsertResult {
  inseridos: number;
  atualizados: number;
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

/**
 * Upsert idempotente do mapeamento NF mãe/filhotes.
 *
 * Por pedido:
 *   1. INSERT em nf_pedido_mapa ON CONFLICT (pedido_acxe_omie) WHERE ativo = true
 *      → atualiza nf_mae + updated_at se já existe
 *   2. Soft-delete das filhotes anteriores (ativo = false)
 *   3. INSERT das novas filhotes com posição 1-N
 *   4. Verifica auto-desativação (se todas as filhotes já foram recebidas —
 *      n_id_receb > 0 no OMIE OU presença em movimentacao/movimentacao_legado)
 *
 * Não valida o pedido contra tbl_pedidosCompras_ACXE no momento do INSERT:
 * pedido inexistente no ERP é aceito silenciosamente (FR-001).
 */
export async function upsertNfPedidoMapa(items: NfPedidoMapaInput[]): Promise<UpsertResult> {
  const pool = getPool();
  const client = await pool.connect();
  let inseridos = 0;
  let atualizados = 0;

  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

    for (const item of items) {
      const { pedido, nf_mae, nf_filhotes } = item;

      // Upsert do mapa pai
      const upsertResult = await client.query<{ id: string; was_insert: boolean }>(
        `INSERT INTO stockbridge.nf_pedido_mapa (pedido_acxe_omie, nf_mae)
         VALUES ($1, $2)
         ON CONFLICT (pedido_acxe_omie) WHERE ativo = true
         DO UPDATE SET nf_mae = EXCLUDED.nf_mae, updated_at = now()
         RETURNING id,
           (xmax = 0) AS was_insert`,
        [pedido, nf_mae],
      );

      const row = upsertResult.rows[0];
      if (!row) continue;

      const mapaId = row.id;

      if (row.was_insert) {
        inseridos++;
      } else {
        atualizados++;
      }

      // Soft-delete das filhotes antigas deste pedido
      await client.query(
        `UPDATE stockbridge.nf_pedido_filhote
         SET ativo = false
         WHERE mapa_id = $1 AND ativo = true`,
        [mapaId],
      );

      // Inserir novas filhotes
      for (let i = 0; i < nf_filhotes.length; i++) {
        const nfFilhote = nf_filhotes[i];
        if (!nfFilhote) continue;
        await client.query(
          `INSERT INTO stockbridge.nf_pedido_filhote (mapa_id, nf_filhote, posicao)
           VALUES ($1, $2, $3)`,
          [mapaId, nfFilhote, i + 1],
        );
      }

      // Auto-desativação: se todas as filhotes ativas já foram recebidas, fechar
      // o mapa (mapa.ativo = false). "Recebida" = n_id_receb > 0 no OMIE OU
      // registrada em movimentacao/movimentacao_legado (ACXEGDP-183) — NFs antigas
      // recebidas no legado nunca tiveram n_id_receb preenchido no OMIE.
      // Nota: entre execuções do n8n o cockpit permanece correto (lido ao vivo).
      if (nf_filhotes.length > 0) {
        const pendResult = await client.query<{ pendente: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM stockbridge.nf_pedido_filhote f
             LEFT JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote, 8, '0')
             WHERE f.mapa_id = $1
               AND f.ativo = true
               AND (h.n_id_nf IS NULL OR h.n_id_receb = 0 OR h.n_id_receb IS NULL)
               AND NOT ${recebidaViaMovimentacaoSql("LPAD(f.nf_filhote, 8, '0')")}
               AND NOT ${recebidaViaLegadoSql("LPAD(f.nf_filhote, 8, '0')")}
           ) AS pendente`,
          [mapaId],
        );
        const pendente = pendResult.rows[0]?.pendente ?? true;
        if (!pendente) {
          await client.query(
            `UPDATE stockbridge.nf_pedido_mapa
             SET ativo = false, updated_at = now()
             WHERE id = $1`,
            [mapaId],
          );
          logger.info({ mapaId }, 'mapa auto-desativado: todas as filhotes recebidas');
        }
      }
    }

    await client.query('COMMIT');
    logger.info({ inseridos, atualizados }, 'upsertNfPedidoMapa concluído');
    return { inseridos, atualizados };
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
