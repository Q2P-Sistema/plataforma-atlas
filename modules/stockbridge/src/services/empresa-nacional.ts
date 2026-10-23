import { getConfig, createLogger } from '@atlas/core';

/**
 * Empresa da NF no recebimento nacional (feature 017, Historia 5 — ACXEGDP-437).
 *
 * A NF de compra nacional chega ao OMIE de UMA empresa: a da Q2P (Historias 1 a 4)
 * ou a da ACXE (Historia 5). A empresa vem sempre da NF (espelho), nunca do corpo do
 * POST. Este modulo concentra o que depende dela e nao pertence a fila nem ao POST:
 * nomes das tabelas espelho (OMIE -> Postgres, escritas pelo n8n) e a chave da ACXE.
 * Nao importa nenhum service do modulo, para nao criar ciclo.
 */

const logger = createLogger('stockbridge:empresa-nacional');

export type EmpresaNacional = 'q2p' | 'acxe';

export const EMPRESAS_NACIONAL: readonly EmpresaNacional[] = ['q2p', 'acxe'];

/** Rotulo para mensagens ao operador e e-mails ("Q2P", "ACXE"). */
export const ROTULO_EMPRESA: Record<EmpresaNacional, string> = { q2p: 'Q2P', acxe: 'ACXE' };

/**
 * Nomes das tabelas espelho da empresa, ja entre aspas (o sufixo e maiusculo).
 * Enum fechado: seguro para interpolar em SQL como `public.${t.nfHeader}`.
 */
export function tabelasNacional(empresa: EmpresaNacional) {
  const s = empresa === 'acxe' ? 'ACXE' : 'Q2P';
  return {
    nfHeader: `"tbl_nf_header_${s}"`,
    nfItens: `"tbl_nf_itens_${s}"`,
    recebimento: `"tbl_recebimentoNFe_${s}"`,
    recebimentoItens: `"tbl_recebimentoNFe_itens_${s}"`,
    produtos: `"tbl_produtos_${s}"`,
    pedidosCompras: `"tbl_pedidosCompras_${s}"`,
    cadastro: `"tbl_cadastroFornecedoresClientes_${s}"`,
  } as const;
}

/** So a variavel STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED (sem as dependencias). */
export function recebimentoNacionalAcxeFlag(): boolean {
  const cfg = getConfig() as { STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED?: boolean };
  return cfg.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED === true;
}

/**
 * Corte da ACXE (YYYY-MM-DD) ou null quando ausente ou invalido. Alem do formato, exige data de calendario
 * (2026-02-30 passa no regex do config e derrubaria a consulta no Postgres com 22008): invalida conta como
 * ausente e a ACXE fica de fora (log), sem tocar a fila da Q2P.
 */
export function dataCorteAcxe(): string | null {
  const cfg = getConfig() as { STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE?: string };
  const v = cfg.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE;
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

/** Intervalo minimo entre dois avisos de configuracao incompleta no log. */
const AVISO_CONFIG_MIN_MS = 10 * 60 * 1000;
let ultimoAvisoConfigMs = 0;

/**
 * A ACXE entra na fila nacional? Exige as tres coisas:
 *  - STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED;
 *  - a chave do fiscal pelo Atlas (016): sem ela a ACXE so teria NF "fiscal ja feito",
 *    que a equipe da ACXE conclui no portal COM estoque;
 *  - o corte proprio da ACXE (dataCorteAcxe): sem ele entrariam as NFs ja recebidas
 *    no portal.
 * Chave ligada sem as outras duas: a ACXE fica de fora e o log avisa (a fila da Q2P
 * segue normal).
 */
export function recebimentoNacionalAcxeHabilitado(): boolean {
  if (!recebimentoNacionalAcxeFlag()) return false;
  const cfg = getConfig() as { STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED?: boolean };
  const fiscal = cfg.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED === true;
  const corte = dataCorteAcxe();
  if (fiscal && corte) return true;
  const agora = Date.now();
  if (agora - ultimoAvisoConfigMs >= AVISO_CONFIG_MIN_MS) {
    ultimoAvisoConfigMs = agora;
    logger.error(
      { fiscalPeloAtlas: fiscal, corteAcxe: corte },
      'STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED ligada sem STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=true ou sem STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE (YYYY-MM-DD) — NFs da ACXE fora da fila nacional',
    );
  }
  return false;
}

/** Empresas cuja NF entra na fila nacional agora (a Q2P sempre). */
export function empresasNacionalAtivas(): EmpresaNacional[] {
  return recebimentoNacionalAcxeHabilitado() ? ['q2p', 'acxe'] : ['q2p'];
}

/** Para testes: zera o controle de aviso do log. */
export function __resetEmpresaNacional(): void {
  ultimoAvisoConfigMs = 0;
}
