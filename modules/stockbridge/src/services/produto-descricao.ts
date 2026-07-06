import { sql } from 'drizzle-orm';

type Executor = {
  execute: (q: ReturnType<typeof sql>) => Promise<{ rows: Array<{ descricao?: string | null }> }>;
};

/**
 * Resolve a descrição real de um produto ACXE pelo código (EML-04/05, ACXEGDP-252).
 *
 * As tabelas `stockbridge.lote`/`movimentacao` guardam apenas `produto_codigo_acxe`
 * — a descrição vive em `public."tbl_produtos_ACXE"` (OMIE sincronizado). Sem esta
 * resolução, os e-mails mostravam o número do SKU cru (ou o fornecedor) no lugar
 * do nome do produto. Fallback "SKU nnn" quando o código não existe no cadastro.
 */
export async function resolverDescricaoProdutoAcxe(
  db: Executor,
  codigoAcxe: number,
): Promise<string> {
  try {
    const res = await db.execute(
      sql`SELECT descricao FROM public."tbl_produtos_ACXE" WHERE codigo_produto = ${codigoAcxe}::bigint LIMIT 1`,
    );
    const descricao = res.rows[0]?.descricao;
    return descricao && descricao.trim() ? descricao : `SKU ${codigoAcxe}`;
  } catch {
    return `SKU ${codigoAcxe}`;
  }
}
