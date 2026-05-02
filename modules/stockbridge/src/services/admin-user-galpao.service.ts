import { getPool, createLogger } from '@atlas/core';

const logger = createLogger('stockbridge:admin-user-galpao');

export interface UserComGalpoes {
  userId: string;
  nome: string;
  email: string;
  role: 'operador' | 'gestor' | 'diretor';
  status: string;
  galpoes: string[];
}

/**
 * Lista todos os usuarios com seus galpoes vinculados via stockbridge.user_galpao.
 * Inclui usuarios sem nenhum galpao (galpoes = []).
 */
export async function listarUsuariosComGalpoes(): Promise<UserComGalpoes[]> {
  const pool = getPool();
  const res = await pool
    .query(
      `
      SELECT u.id, u.name, u.email, u.role, u.status,
             COALESCE(
               array_agg(ug.galpao ORDER BY ug.galpao) FILTER (WHERE ug.galpao IS NOT NULL),
               ARRAY[]::text[]
             ) AS galpoes
      FROM atlas.users u
      LEFT JOIN stockbridge.user_galpao ug ON ug.user_id = u.id
      WHERE u.status <> 'deleted'
      GROUP BY u.id, u.name, u.email, u.role, u.status
      ORDER BY u.name
      `,
    )
    .catch((err) => {
      logger.warn({ err: err.message }, 'Query listarUsuariosComGalpoes falhou');
      return { rows: [] };
    });

  return (res.rows as Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    status: string;
    galpoes: string[];
  }>).map((r) => ({
    userId: r.id,
    nome: r.name,
    email: r.email,
    role: r.role as 'operador' | 'gestor' | 'diretor',
    status: r.status,
    galpoes: r.galpoes ?? [],
  }));
}

/**
 * Substitui completamente os galpoes vinculados a um usuario.
 * DELETE all + INSERT new dentro de uma transacao.
 */
export async function setGalpoesDoUsuario(userId: string, galpoes: string[]): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM stockbridge.user_galpao WHERE user_id = $1', [userId]);
    if (galpoes.length > 0) {
      const values = galpoes.map((_, i) => `($1, $${i + 2})`).join(', ');
      await client.query(
        `INSERT INTO stockbridge.user_galpao (user_id, galpao) VALUES ${values}`,
        [userId, ...galpoes],
      );
    }
    await client.query('COMMIT');
    logger.info({ userId, galpoes }, 'Galpoes do usuario atualizados');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lista os galpoes fisicos distintos cadastrados em stockbridge.localidade
 * (preenchidos pela migration 0025 a partir do prefixo do codigo).
 */
export async function listarGalpoesDisponiveis(): Promise<Array<{ galpao: string; localidades: string[] }>> {
  const pool = getPool();
  const res = await pool
    .query(
      `
      SELECT galpao, array_agg(codigo || ' — ' || nome ORDER BY codigo) AS localidades
      FROM stockbridge.localidade
      WHERE galpao IS NOT NULL AND ativo = true
      GROUP BY galpao
      ORDER BY galpao
      `,
    )
    .catch(() => ({ rows: [] }));

  return (res.rows as Array<{ galpao: string; localidades: string[] }>).map((r) => ({
    galpao: r.galpao,
    localidades: r.localidades,
  }));
}
