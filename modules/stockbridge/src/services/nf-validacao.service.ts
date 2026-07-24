import { getPool, createLogger } from '@atlas/core';
import { CNPJ_ACXE_NUMERICO } from '../types.js';

const logger = createLogger('stockbridge:nf-validacao');

/**
 * Validação da NF no recebimento (feature 012 — ACXEGDP-204 + 205).
 *
 * **Fonte de verdade: a tabela sincronizada `public."tbl_nf_header_*"`** (Princípio II
 * — Atlas lê do Postgres), NÃO a resposta ao vivo de `consultarNF`. A v1 parseava
 * `dCan/dInut/cDeneg` do retorno ao vivo e dava falso-positivo de cancelamento, além de
 * usar `tpNF` (errado: NF de importação é entrada/`tp_nf=0`). O sync (ACXEGDP-184) já
 * resolve o `cancelada` corretamente, e a chave NFe carrega o CNPJ do emitente.
 *
 * Regras:
 *  - cancelada (no flag autoritativo) → bloqueada (ACXEGDP-204)
 *  - contexto ACXE: número existe SÓ com emitente terceiro (não ACXE) → bloqueada
 *    (ACXEGDP-205); resolve colisão de numeração escolhendo a NF emitida pela ACXE
 *  - número não encontrado no espelho → indeterminada → fail-open + alerta (FR-010)
 *  - contexto Q2P: aplica só o cancelamento (filtro de emitente não se aplica)
 */

export type MotivoBloqueio = 'cancelada' | 'nao_emitida_acxe';
export type MotivoIndeterminado = 'nao_encontrada_no_espelho';

export type ResultadoValidacaoNf =
  | { status: 'ok' }
  | { status: 'bloqueada'; motivo: MotivoBloqueio }
  | { status: 'indeterminada'; motivo: MotivoIndeterminado };

export interface ContextoValidacao {
  cnpj: 'acxe' | 'q2p';
}

/** Uma linha da `tbl_nf_header_*` relevante para a decisão. */
export interface NfHeaderRow {
  cancelada: boolean;
  /** Emitente da NF é a ACXE (CNPJ da chave === CNPJ_ACXE_NUMERICO). */
  emitenteAcxe: boolean;
}

/**
 * Núcleo PURO da decisão (sem I/O) — coberto por Vitest. Recebe as linhas do espelho
 * para o número da NF e o contexto, e devolve o veredito.
 */
export function decidirValidacaoNf(rows: NfHeaderRow[], contexto: ContextoValidacao): ResultadoValidacaoNf {
  if (contexto.cnpj === 'acxe') {
    const acxe = rows.filter((r) => r.emitenteAcxe);
    if (acxe.some((r) => !r.cancelada)) return { status: 'ok' };
    if (acxe.some((r) => r.cancelada)) return { status: 'bloqueada', motivo: 'cancelada' };
    // Nenhuma linha da ACXE para esse número: ou só existe de terceiro (colisão), ou nada.
    if (rows.length > 0) return { status: 'bloqueada', motivo: 'nao_emitida_acxe' };
    return { status: 'indeterminada', motivo: 'nao_encontrada_no_espelho' };
  }

  // Contexto Q2P: sem filtro de emitente — só cancelamento.
  if (rows.some((r) => !r.cancelada)) return { status: 'ok' };
  if (rows.some((r) => r.cancelada)) return { status: 'bloqueada', motivo: 'cancelada' };
  return { status: 'indeterminada', motivo: 'nao_encontrada_no_espelho' };
}

/**
 * Busca as linhas do espelho `tbl_nf_header_*` para o número da NF (casa por valor
 * numérico, ignorando o zero-padding) e marca quais são emitidas pela ACXE.
 * Em qualquer erro (coluna/tabela ausente em algum ambiente), devolve `null` →
 * o caller trata como indeterminado (fail-open). Não lança.
 */
export async function buscarRowsNfHeader(
  numero: number,
  cnpj: 'acxe' | 'q2p',
): Promise<NfHeaderRow[] | null> {
  if (!Number.isFinite(numero) || numero <= 0) return [];
  const tabela = cnpj === 'acxe' ? 'tbl_nf_header_ACXE' : 'tbl_nf_header_Q2P';
  try {
    const r = await getPool().query(
      `SELECT COALESCE(cancelada, false) AS cancelada,
              (substring(c_chave_nfe FROM 7 FOR 14) = $2) AS emitente_acxe
       FROM public."${tabela}"
       WHERE regexp_replace(COALESCE(n_nf,''), '[^0-9]', '', 'g') ~ '^[0-9]+$'
         AND regexp_replace(n_nf, '[^0-9]', '', 'g')::bigint = $1`,
      [numero, CNPJ_ACXE_NUMERICO],
    );
    return (r.rows as Array<{ cancelada: boolean; emitente_acxe: boolean }>).map((row) => ({
      cancelada: row.cancelada === true,
      emitenteAcxe: row.emitente_acxe === true,
    }));
  } catch (err) {
    logger.warn({ err, numero, cnpj }, 'Falha ao consultar tbl_nf_header — validação fica indeterminada (fail-open)');
    return null;
  }
}

/**
 * Validação completa (I/O + decisão). Retorna o veredito; se o espelho não pôde ser
 * lido, devolve indeterminada (fail-open).
 */
export async function validarNfRecebivel(
  numero: number,
  contexto: ContextoValidacao,
): Promise<ResultadoValidacaoNf> {
  const rows = await buscarRowsNfHeader(numero, contexto.cnpj);
  if (rows === null) return { status: 'indeterminada', motivo: 'nao_encontrada_no_espelho' };
  return decidirValidacaoNf(rows, contexto);
}
