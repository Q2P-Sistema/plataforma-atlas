import { getPool, createLogger } from '@atlas/core';
import { raizCnpj } from './cnpj.js';
import { fatorUnidadePc, tabelaCadastro, tabelaPcs, PC_ESPELHO_VALOR_MAX_BRL, type EmpresaPc, type PcCopia } from './pc-sugestao.service.js';
import { CNPJ_ACXE_NUMERICO } from '../types.js';

const logger = createLogger('stockbridge:pc-visto');

/**
 * Cache de pedidos de compra vistos pelo Atlas — feature 017, migration 0057.
 *
 * A copia local de PCs (`tbl_pedidosCompras_<empresa>`, n8n Rev 1.5) e a lista de
 * PCs PENDENTES do OMIE. O OMIE tira dessa lista o PC que ja tem item associado a um
 * recebimento de NF-e, ANTES de o recebimento ser concluido: o PC 306 da Zaraplast
 * sumiu da copia entre a associacao (13h) e a conclusao (15h) de 22/10/2026 e voltou
 * depois, como recebido parcial. Nessa janela o detalhe da NF mostrava "Vínculo do
 * OMIE" sem numero, sem saldo e exigindo justificativa; e os demais itens da mesma
 * NF ficavam sem candidato (NF_SEM_PC), com o PC existindo e com saldo.
 *
 * `stockbridge.pedido_compra_visto` guarda a ultima versao de cada item de PC que
 * passou pela copia (chave: empresa + item do PC). E alimentada por `registrarPcsVistos`
 * — no cron :05/:35 e, no maximo uma vez a cada 5 min por processo, ao carregar o
 * contexto da sugestao. So linhas que MUDARAM sao gravadas (o trigger de auditoria
 * registra o historico do PC, nao ruido a cada sync). Leitura: `lerPcsVistos`, so dos
 * PCs que a copia nao trouxe.
 *
 * Historia 5 (ACXEGDP-437, migration 0058): o cache tambem guarda o produto (`n_cod_prod`)
 * e o local (`codigo_local_estoque`) do item do PC — a NF da ACXE pre-seleciona o produto
 * e o local de entrada pelo PC mesmo quando ele saiu da lista de pendentes. Na copia o local
 * e varchar: so entra se for numerico.
 */

export interface PcVisto extends Omit<PcCopia, 'fonte'> {
  vistoEmMs: number;
}

/** Intervalo minimo entre duas gravacoes oportunistas (ao abrir uma NF) no mesmo processo. */
export const REGISTRO_OPORTUNISTA_MIN_MS = 5 * 60 * 1000;

/**
 * Validade do cache como fonte de CANDIDATOS: o PC que saiu da lista por recebimento
 * total no portal, cancelamento ou exclusao ficaria aqui com o ultimo saldo visto; a
 * releitura ao vivo o recusaria no POST (409), mas a tela o ofereceria e ate o
 * pre-selecionaria. A janela que o cache resolve (item associado a um recebimento
 * aberto) dura horas ou dias. PC apontado por um vinculo do OMIE entra sempre.
 */
export const CACHE_PC_VALIDADE_DIAS = 7;
const ultimoRegistroMs = new Map<EmpresaPc, number>();

/**
 * Grava na tabela de vistos o que esta na copia agora (upsert por empresa + item do
 * PC), so onde algo mudou. Devolve quantas linhas foram gravadas. Nunca lanca.
 */
export async function registrarPcsVistos(empresa: EmpresaPc): Promise<number> {
  try {
    const r = await getPool().query<{ n: string }>(
      `WITH itens AS (
         -- uma linha por item: a copia e reescrita pelo n8n e uma repeticao de ncoditem derrubaria o
         -- ON CONFLICT inteiro (SQLSTATE 21000) e entraria duas vezes no valor total do pedido
         SELECT DISTINCT ON (pc.ncoditem) pc.*
           FROM public.${tabelaPcs(empresa)} pc
          WHERE pc.ncodped IS NOT NULL AND pc.ncoditem IS NOT NULL
          ORDER BY pc.ncoditem, pc.data_atualizacao DESC NULLS LAST
       ),
       copia AS (
         SELECT pc.ncodped, pc.ncoditem, btrim(COALESCE(pc.cnumero, '')) AS pc_numero, pc.ncodfor,
                btrim(COALESCE(pc.cdescricao, pc.cproduto, '')) AS produto_descricao,
                upper(btrim(COALESCE(pc.cunidade, ''))) AS unidade,
                pc.nqtde::numeric(14,3) AS qtde, COALESCE(pc.nqtderec, 0)::numeric(14,3) AS qtde_rec,
                pc.nvalunit::numeric(14,6) AS preco_unit, btrim(COALESCE(pc.cetapa, '')) AS etapa,
                pc.ddtprevisao::date AS dt_previsao,
                pc.ncodprod::bigint AS n_cod_prod,
                CASE WHEN btrim(COALESCE(pc.codigo_local_estoque, '')) ~ '^[0-9]{1,18}$' THEN btrim(pc.codigo_local_estoque)::bigint END AS codigo_local_estoque,
                SUM(COALESCE(pc.nvaltot, pc.nqtde * pc.nvalunit, 0)) OVER (PARTITION BY pc.ncodped)::numeric(14,2) AS valor_total_pc
           FROM itens pc
       ),
       gravado AS (
         INSERT INTO stockbridge.pedido_compra_visto
           (empresa, n_cod_ped, n_cod_item, pc_numero, n_cod_for, produto_descricao, unidade, qtde, qtde_rec, preco_unit, etapa, dt_previsao, valor_total_pc, n_cod_prod, codigo_local_estoque, visto_em)
         SELECT $1, c.ncodped, c.ncoditem, c.pc_numero, c.ncodfor, c.produto_descricao, c.unidade, c.qtde, c.qtde_rec, c.preco_unit, c.etapa, c.dt_previsao, c.valor_total_pc, c.n_cod_prod, c.codigo_local_estoque, now()
           FROM copia c
         ON CONFLICT (empresa, n_cod_item) DO UPDATE
           SET n_cod_ped = EXCLUDED.n_cod_ped, pc_numero = EXCLUDED.pc_numero, n_cod_for = EXCLUDED.n_cod_for,
               produto_descricao = EXCLUDED.produto_descricao, unidade = EXCLUDED.unidade, qtde = EXCLUDED.qtde,
               qtde_rec = EXCLUDED.qtde_rec, preco_unit = EXCLUDED.preco_unit, etapa = EXCLUDED.etapa,
               dt_previsao = EXCLUDED.dt_previsao, valor_total_pc = EXCLUDED.valor_total_pc,
               n_cod_prod = EXCLUDED.n_cod_prod, codigo_local_estoque = EXCLUDED.codigo_local_estoque,
               visto_em = EXCLUDED.visto_em, updated_at = now()
           WHERE (pedido_compra_visto.n_cod_ped, pedido_compra_visto.pc_numero, pedido_compra_visto.n_cod_for,
                  pedido_compra_visto.produto_descricao, pedido_compra_visto.unidade, pedido_compra_visto.qtde,
                  pedido_compra_visto.qtde_rec, pedido_compra_visto.preco_unit, pedido_compra_visto.etapa,
                  pedido_compra_visto.dt_previsao, pedido_compra_visto.valor_total_pc,
                  pedido_compra_visto.n_cod_prod, pedido_compra_visto.codigo_local_estoque)
                 IS DISTINCT FROM
                 (EXCLUDED.n_cod_ped, EXCLUDED.pc_numero, EXCLUDED.n_cod_for, EXCLUDED.produto_descricao, EXCLUDED.unidade,
                  EXCLUDED.qtde, EXCLUDED.qtde_rec, EXCLUDED.preco_unit, EXCLUDED.etapa, EXCLUDED.dt_previsao, EXCLUDED.valor_total_pc,
                  EXCLUDED.n_cod_prod, EXCLUDED.codigo_local_estoque)
         RETURNING 1
       )
       SELECT count(*)::text AS n FROM gravado`,
      [empresa],
    );
    const n = Number(r.rows[0]?.n ?? 0);
    ultimoRegistroMs.set(empresa, Date.now());
    if (n > 0) logger.info({ empresa, linhas: n }, 'Cache de pedidos de compra atualizado');
    return n;
  } catch (err) {
    logger.warn({ err: (err as Error).message, empresa }, 'Não foi possível atualizar o cache de pedidos de compra');
    return 0;
  }
}

/** `registrarPcsVistos` no maximo uma vez a cada 5 min por processo (chamada ao abrir uma NF). */
export async function registrarPcsVistosSeVencido(empresa: EmpresaPc, agoraMs: number = Date.now()): Promise<void> {
  const ultimo = ultimoRegistroMs.get(empresa) ?? 0;
  if (agoraMs - ultimo < REGISTRO_OPORTUNISTA_MIN_MS) return;
  ultimoRegistroMs.set(empresa, agoraMs);
  await registrarPcsVistos(empresa);
}

/** Id do OMIE em texto (bigint) -> number; vazio, nao numerico ou <= 0 = undefined (ausente). */
function idOmieValido(v: string | null | undefined): number | undefined {
  if (v == null || !/^\d{1,18}$/.test(v.trim())) return undefined;
  const n = Number(v.trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * PCs do cache para os fornecedores, raizes de CNPJ e pedidos informados — na forma da
 * copia (`PcCopia` sem `fonte`), com `atualizadoEmMs` = visto_em. Quem chama descarta
 * os que a copia trouxe. Lanca em falha de banco (o chamador trata como "sem cache").
 */
export async function lerPcsVistos(
  empresa: EmpresaPc,
  params: { fornecedores: number[]; raizes: string[]; nCodPeds: number[] },
): Promise<PcVisto[]> {
  const fornecedores = params.fornecedores.filter((n) => Number.isFinite(n) && n > 0);
  const raizes = params.raizes.filter((r) => /^\d{8}$/.test(r));
  const peds = params.nCodPeds.filter((n) => Number.isFinite(n) && n > 0);
  if (fornecedores.length === 0 && raizes.length === 0 && peds.length === 0) return [];
  const r = await getPool().query<{
    n_cod_ped: string;
    n_cod_item: string;
    pc_numero: string;
    n_cod_for: string | null;
    produto_descricao: string | null;
    unidade: string | null;
    qtde: string | null;
    qtde_rec: string | null;
    preco_unit: string | null;
    etapa: string | null;
    dt_previsao: string | null;
    valor_total_pc: string | null;
    visto_ms: number | string | null;
    cnpj_cadastro: string | null;
    n_cod_prod?: string | null;
    codigo_local_estoque?: string | null;
  }>(
    `SELECT v.n_cod_ped::text, v.n_cod_item::text, v.pc_numero, v.n_cod_for::text, v.produto_descricao, v.unidade,
            v.qtde::text, v.qtde_rec::text, v.preco_unit::text, v.etapa, v.dt_previsao::text, v.valor_total_pc::text,
            v.n_cod_prod::text, v.codigo_local_estoque::text,
            (EXTRACT(EPOCH FROM v.visto_em) * 1000)::float8 AS visto_ms,
            regexp_replace(COALESCE(cad.cnpj_cpf, ''), '\\D', '', 'g') AS cnpj_cadastro
       FROM stockbridge.pedido_compra_visto v
       LEFT JOIN LATERAL (
         SELECT c.cnpj_cpf FROM public.${tabelaCadastro(empresa)} c WHERE c.codigo_cliente_omie = v.n_cod_for LIMIT 1
       ) cad ON true
      WHERE v.empresa = $1
        AND (
              v.n_cod_ped = ANY($3::bigint[])
           OR (v.visto_em > now() - make_interval(days => $5)
               AND (v.n_cod_for = ANY($2::bigint[])
                    OR (length(regexp_replace(COALESCE(cad.cnpj_cpf, ''), '\\D', '', 'g')) = 14
                        AND left(regexp_replace(cad.cnpj_cpf, '\\D', '', 'g'), 8) = ANY($4::text[]))))
        )`,
    [empresa, fornecedores, peds, raizes, CACHE_PC_VALIDADE_DIAS],
  );
  const out: PcVisto[] = [];
  for (const x of r.rows) {
    const fator = fatorUnidadePc(x.unidade);
    const nqtde = Number(x.qtde ?? 0);
    const nqtderec = Number(x.qtde_rec ?? 0);
    const nvalunit = x.preco_unit == null ? null : Number(x.preco_unit);
    const valorTotal = Number(x.valor_total_pc ?? 0);
    const cnpj = x.cnpj_cadastro ?? '';
    const nCodProd = idOmieValido(x.n_cod_prod);
    const codigoLocalEstoque = idOmieValido(x.codigo_local_estoque);
    out.push({
      nCodPed: Number(x.n_cod_ped),
      nCodItem: Number(x.n_cod_item),
      pcNumero: (x.pc_numero ?? '').trim(),
      etapa: (x.etapa ?? '').trim(),
      nCodFor: Number(x.n_cod_for ?? 0),
      produtoDescricao: (x.produto_descricao ?? '').trim(),
      qtdPedidaKg: fator != null ? nqtde * fator : 0,
      saldoCopiaKg: fator != null ? Math.max(0, (nqtde - nqtderec) * fator) : 0,
      precoKg: fator != null && nvalunit != null && Number.isFinite(nvalunit) ? nvalunit / fator : null,
      unidade: (x.unidade ?? '').trim().toUpperCase(),
      dtPrevisao: x.dt_previsao ? String(x.dt_previsao).slice(0, 10) : null,
      atualizadoEmMs: Number(x.visto_ms ?? 0),
      // PC-espelho da importacao so existe na copia da Q2P (mesma regra de carregarContextoPc)
      pcEspelho: empresa === 'q2p' && cnpj === CNPJ_ACXE_NUMERICO && valorTotal < PC_ESPELHO_VALOR_MAX_BRL,
      cnpjCadastro: cnpj,
      raizCnpj: raizCnpj(cnpj),
      vistoEmMs: Number(x.visto_ms ?? 0),
      ...(nCodProd !== undefined ? { nCodProd } : {}),
      ...(codigoLocalEstoque !== undefined ? { codigoLocalEstoque } : {}),
    });
  }
  return out;
}

/** Numero legivel dos PCs pedidos, pelo cache (best-effort; lanca em falha de banco). */
export async function numerosPcsVistos(empresa: EmpresaPc, nCodPeds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const peds = nCodPeds.filter((n) => Number.isFinite(n) && n > 0);
  if (peds.length === 0) return out;
  const r = await getPool().query<{ n_cod_ped: string; pc_numero: string | null }>(
    `SELECT n_cod_ped::text, MIN(NULLIF(btrim(pc_numero), '')) AS pc_numero
       FROM stockbridge.pedido_compra_visto WHERE empresa = $1 AND n_cod_ped = ANY($2::bigint[]) GROUP BY n_cod_ped`,
    [empresa, peds],
  );
  for (const x of r.rows) if (x.pc_numero) out.set(Number(x.n_cod_ped), x.pc_numero);
  return out;
}

/** Somente testes. */
export function __resetRegistroPcsVistos(): void {
  ultimoRegistroMs.clear();
}
