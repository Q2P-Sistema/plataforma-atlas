import { getConfig, getPool, createLogger } from '@atlas/core';

const logger = createLogger('stockbridge:cfop-entrada');

/**
 * CFOP de entrada do recebimento FISCAL feito pelo Atlas (feature 017, research D23, 06/11/2026).
 *
 * Sem o Atlas mandar o CFOP, vale a sugestao do OMIE (itensAjustes.cCFOPEntrada do recebimento):
 * a NF 979 da ACXE (Solutec, fornecedor 6.101) concluiu com entrada 2.102 (comercializacao), mas a
 * ACXE compra para industrializacao (2.101) e o financeiro corrigiu a nota de entrada a mao.
 *
 * Regra (decisao do usuario, 06/11/2026):
 *  - o operador escolhe a FINALIDADE da compra, uma vez por NF (vale para todos os itens);
 *    obrigatoria quando o Atlas faz o fiscal, pre-selecionada pela empresa da NF
 *    (ACXE = industrializacao, Q2P = comercializacao);
 *  - industrializacao = final 101, comercializacao = final 102;
 *  - o 1o digito e o do CFOP SUGERIDO pelo OMIE (1 = mesmo estado, 2 = outro estado,
 *    3 = importacao): o Atlas so troca o final;
 *  - CFOP sugerido fora de x.101/x.102 (uso e consumo x.556, outros) ou ausente: o Atlas nao mexe.
 *
 * Vale so quando o Atlas faz o fiscal (chave da 016), com a chave propria
 * STOCKBRIDGE_FISCAL_CFOP_ENTRADA_ENABLED (default desligada) e a migration 0062 (colunas
 * finalidade_entrada e cfops_entrada do ledger `stockbridge.recebimento_fiscal`).
 */

export type FinalidadeEntrada = 'industrializacao' | 'comercializacao';

export const FINALIDADES_ENTRADA: readonly FinalidadeEntrada[] = Object.freeze([
  'industrializacao',
  'comercializacao',
] as const);

/** Final do CFOP de entrada de cada finalidade. */
const FINAL_CFOP: Readonly<Record<FinalidadeEntrada, '101' | '102'>> = Object.freeze({
  industrializacao: '101',
  comercializacao: '102',
});

/** CFOP no recorte que o Atlas troca: 1o digito 1, 2 ou 3 e final 101 ou 102, com ponto. */
const CFOP_TROCAVEL = /^([123])\.10[12]$/;

/** Finalidade pre-selecionada pela empresa da NF (ACXE compra para industrializar, Q2P para revender). */
export function finalidadeEntradaPadrao(empresa: 'q2p' | 'acxe' | null | undefined): FinalidadeEntrada {
  return empresa === 'acxe' ? 'industrializacao' : 'comercializacao';
}

/**
 * CFOP de entrada que o Atlas manda para a finalidade escolhida, a partir do CFOP sugerido pelo
 * OMIE. Devolve null quando o sugerido esta fora de x.101/x.102 ou ausente (o Atlas nao mexe).
 */
export function cfopEntradaParaFinalidade(
  cfopSugerido: string | null | undefined,
  finalidade: FinalidadeEntrada,
): string | null {
  if (typeof cfopSugerido !== 'string') return null;
  const m = CFOP_TROCAVEL.exec(cfopSugerido.trim());
  if (!m) return null;
  return `${m[1]}.${FINAL_CFOP[finalidade]}`;
}

/** Valida o valor vindo de fora (corpo do POST, ledger). */
export function ehFinalidadeEntrada(v: unknown): v is FinalidadeEntrada {
  return v === 'industrializacao' || v === 'comercializacao';
}

/**
 * Rastro por item gravado no ledger (`recebimento_fiscal.cfops_entrada`, migration 0062).
 * `cfopSugerido` e o CFOP lido ao vivo no planejamento (numa retomada pode ser o que o proprio Atlas
 * gravou antes); `cfopAlvo` null = fora do recorte (o Atlas nao mexe); `enviado` = o EDITAR planejado
 * desta tentativa leva o CFOP (so quando difere do lido). O rastro e gravado ANTES das chamadas ao OMIE:
 * `enviado` so vale como aplicado com o ledger `concluido` (numa falha, `passo_falha` diz ate onde foi).
 * `cfopAlvo` com `enviado=false` e sugerido igual = ja estava no alvo; diferente = nao aplicado (item ja
 * ignorado no OMIE, que nao recebe EDITAR).
 */
export interface CfopEntradaItemLedger {
  nSequencia: number;
  cfopSugerido: string | null;
  cfopAlvo: string | null;
  enviado: boolean;
}

/** Chave STOCKBRIDGE_FISCAL_CFOP_ENTRADA_ENABLED (default desligada). */
export function cfopEntradaChaveLigada(): boolean {
  const cfg = getConfig() as { STOCKBRIDGE_FISCAL_CFOP_ENTRADA_ENABLED?: boolean };
  return cfg.STOCKBRIDGE_FISCAL_CFOP_ENTRADA_ENABLED === true;
}

// ── Migration 0062 ──────────────────────────────────────────────────────────

/** Ausente: confere de novo depois deste prazo (a migration pode ser aplicada com a API no ar). */
const COLUNA_0062_RECHECAR_MS = 5 * 60 * 1000;
/** Erro ao conferir (banco instavel) vale pouco: a proxima chamada depois disto confere de novo. */
const COLUNA_0062_RECHECAR_APOS_ERRO_MS = 30 * 1000;
let coluna0062: { existe: boolean; em: number; validadeMs: number } | null = null;

/**
 * A migration 0062 foi aplicada (coluna recebimento_fiscal.finalidade_entrada)? Sem ela o CFOP de
 * entrada fica desligado (vale a sugestao do OMIE, comportamento de antes), com erro no log.
 */
export async function colunaFinalidadeEntradaExiste(): Promise<boolean> {
  if (coluna0062 && (coluna0062.existe || Date.now() - coluna0062.em < coluna0062.validadeMs)) return coluna0062.existe;
  let existe = false;
  let validadeMs = COLUNA_0062_RECHECAR_MS;
  try {
    const r = await getPool().query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'stockbridge' AND table_name = 'recebimento_fiscal' AND column_name = 'finalidade_entrada'
       ) AS ok`,
    );
    existe = r.rows[0]?.ok === true;
    if (!existe) {
      // ERROR so com a chave ligada (o recurso pedido nao funciona); desligada e so aviso — a listagem do ledger
      // tambem confere a coluna, e nao deve gerar alarme de um recurso que ninguem ligou (revisao 06/11/2026).
      const msg =
        'Coluna stockbridge.recebimento_fiscal.finalidade_entrada ausente (migration 0062): o CFOP de entrada do fiscal fica com a sugestão do OMIE';
      if (cfopEntradaChaveLigada()) logger.error(msg);
      else logger.warn(msg);
    }
  } catch (err) {
    validadeMs = COLUNA_0062_RECHECAR_APOS_ERRO_MS;
    logger.warn({ err: (err as Error).message }, 'Não foi possível conferir a coluna finalidade_entrada (0062) — tratada como ausente por 30 s');
  }
  coluna0062 = { existe, em: Date.now(), validadeMs };
  return existe;
}

/** Para testes: esquece o que foi conferido sobre a coluna da 0062. */
export function __resetColunaFinalidadeEntrada(): void {
  coluna0062 = null;
}

/**
 * O CFOP de entrada pela finalidade vale neste ambiente: chave da 016 (STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED —
 * sem o fiscal pelo Atlas nao ha EDITAR), chave propria e migration 0062.
 */
export async function cfopEntradaHabilitado(): Promise<boolean> {
  const cfg = getConfig() as { STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED?: boolean };
  if (cfg.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED !== true || !cfopEntradaChaveLigada()) return false;
  return colunaFinalidadeEntradaExiste();
}
