import { getConfig, getPool, createLogger } from '@atlas/core';
import { tabelasNacional, type EmpresaNacional } from './empresa-nacional.js';

const logger = createLogger('stockbridge:fiscal-revertido');

/**
 * Feature 017 (ACXEGDP-437), research D21 — recebimento fiscal REVERTIDO no portal do OMIE.
 *
 * Caso real: NF 19252 (Zaraplast, 25/10/2026), concluida pelo Atlas as 17:02 e revertida no portal
 * as 17:13. O ledger seguia 'concluido', a nota de entrada seguia valida no espelho de NF (o espelho
 * nunca marca uma nota como excluida: 0 de 24.978 cabecalhos da Q2P) e a fila mostrava "fiscal ja
 * feito" — o clique do operador faria so o fisico e a NF ficaria parada na etapa 40.
 *
 * O SINAL compara horas de EVENTO do OMIE, nao horas de sincronizacao (o espelho de NF e todo
 * resincronizado de tempos em tempos, e as linhas do espelho de recebimentos de NF concluida no
 * portal ficam defasadas, com c_recebido 'N' e sem hora):
 *  - conclusao: o ledger concluido/ja_concluido/revertido (finalizado_em), a nota de entrada no espelho de
 *    NF (d_alt + h_alt) e o recebimento com c_recebido 'S' (d_alt + h_alt e d_rec + h_rec);
 *  - pendencia: o recebimento com c_recebido 'N' nao cancelado (d_alt + h_alt), com margem de
 *    MARGEM_REVERSAO_ESPELHO_MIN, e o marcador 'revertido' do ledger pela hora da REVERSAO
 *    (revertido_omie_em; na leitura ao vivo, revertido_em), sem margem;
 *  - revertido = a pendencia mais recente e posterior a conclusao mais recente.
 * Validado em PROD em 25/10/2026: marca so a 19252 entre 4.289 recebimentos da Q2P e 346 da ACXE.
 *
 * Este modulo e folha (so @atlas/core e empresa-nacional): a fila, o fiscal, o recebimento e a
 * varredura do cron usam o MESMO predicado.
 */

/** Margem do sinal pelo espelho: a hora da nota de entrada vem sem os segundos e o recebimento e alterado segundos antes do Concluir. */
export const MARGEM_REVERSAO_ESPELHO_MIN = 2;

/**
 * Espera minima depois da conclusao para a leitura ao vivo no clique poder declarar a reversao:
 * a ConsultarRecebimento com corpo identico em menos de ~1 min devolve cache (research D2 da 016),
 * e a resposta de antes do Concluir diria "nao recebido".
 */
export const ESPERA_LEITURA_AO_VIVO_SEG = 75;

export type OrigemReversao = 'espelho' | 'omie_ao_vivo';

/** Kill switch STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED (default ligada). */
export function fiscalRevertidoChaveLigada(): boolean {
  const cfg = getConfig() as { STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED?: boolean };
  return cfg.STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED !== false;
}

// ── Migration 0060 ──────────────────────────────────────────────────────────

/** Ausente: confere de novo depois deste prazo (a migration pode ser aplicada com a API no ar). */
const COLUNA_0060_RECHECAR_MS = 5 * 60 * 1000;
/** Erro ao conferir (banco instavel) vale pouco: a proxima chamada depois disto confere de novo. */
const COLUNA_0060_RECHECAR_APOS_ERRO_MS = 30 * 1000;
let coluna0060: { existe: boolean; em: number; validadeMs: number } | null = null;

/**
 * A migration 0060 foi aplicada (coluna recebimento_fiscal.revertido_em)? Sem ela o status 'revertido'
 * viola o CHECK do ledger: a D21 inteira fica desligada (comportamento de antes), com erro no log.
 */
export async function colunaRevertidoExiste(): Promise<boolean> {
  if (coluna0060 && (coluna0060.existe || Date.now() - coluna0060.em < coluna0060.validadeMs)) return coluna0060.existe;
  let existe = false;
  let validadeMs = COLUNA_0060_RECHECAR_MS;
  try {
    const r = await getPool().query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'stockbridge' AND table_name = 'recebimento_fiscal' AND column_name = 'revertido_em'
       ) AS ok`,
    );
    existe = r.rows[0]?.ok === true;
    if (!existe) logger.error('Coluna stockbridge.recebimento_fiscal.revertido_em ausente (migration 0060): o recebimento fiscal revertido no OMIE não é percebido');
  } catch (err) {
    validadeMs = COLUNA_0060_RECHECAR_APOS_ERRO_MS;
    logger.warn({ err: (err as Error).message }, 'Não foi possível conferir a coluna revertido_em (0060) — tratada como ausente por 30 s');
  }
  coluna0060 = { existe, em: Date.now(), validadeMs };
  return existe;
}
/** Para testes: esquece o que foi conferido sobre a coluna da 0060. */
export function __resetColunaRevertido(): void {
  coluna0060 = null;
}

/**
 * A D21 vale neste ambiente: chave da 016 (STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED — sem o fiscal pelo
 * Atlas nao ha como refaze-lo), kill switch e migration 0060.
 */
export async function fiscalRevertidoHabilitado(): Promise<boolean> {
  const cfg = getConfig() as { STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED?: boolean };
  if (cfg.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED !== true || !fiscalRevertidoChaveLigada()) return false;
  return colunaRevertidoExiste();
}

// ── Predicado (SQL) ─────────────────────────────────────────────────────────

/**
 * Hora de alteracao no OMIE (horario de Brasilia, como timestamptz) da linha `alias` de um espelho:
 * d_alt (date) + h_alt ('HH:MI[:SS]': varchar no espelho de recebimentos, time no de NF). Hora em
 * formato inesperado = NULL (sem evidencia), nunca erro de cast — um 22007 derrubaria a fila inteira.
 */
export function horaAlteracaoOmieSql(alias: string): string {
  return horaOmieSql(alias, 'd_alt', 'h_alt');
}

/** O mesmo de horaAlteracaoOmieSql para um par data + hora qualquer da linha (ex.: d_rec/h_rec, a hora em que o recebimento foi concluido). */
function horaOmieSql(alias: string, colData: string, colHora: string): string {
  return (
    `CASE WHEN ${alias}.${colData} IS NOT NULL AND ${alias}.${colHora}::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' ` +
    `THEN (${alias}.${colData}::date + ${alias}.${colHora}::text::time) AT TIME ZONE 'America/Sao_Paulo' END`
  );
}

/**
 * Instante da evidencia de conclusao do fiscal mais recente da NF `chaveExpr` (NULL = nunca concluido):
 * ledger concluido/ja_concluido, nota de entrada no espelho de NF (com ou sem deletada/cancelada: a
 * conclusao aconteceu) e recebimento com c_recebido 'S' — pela hora de alteracao e pela de recebimento
 * (d_rec/h_rec): concluir no portal nao mexe em d_alt (NF 67988: d_alt 09:19:05, d_rec 09:32:27), e d_rec
 * vem em todas as linhas 'S' (d_alt falta em 19 das 61 'S' da etapa 60 em PROD). O ledger 'revertido'
 * tambem conta: a conclusao dele aconteceu (finalizado_em) e so foi desfeita depois (o marcador e a
 * evidencia de pendencia). Sem isso, marcada a reversao e sem nota de entrada nem recebimento 'S' no
 * espelho (reversao antes do sync de NF), o sinal voltaria a falso com a NF ainda revertida. Uma conclusao
 * nova (o Atlas refez o fiscal, ou o fiscal reconcluiu no portal) e posterior ao marcador e desliga o sinal.
 */
export function conclusaoFiscalEmSql(chaveExpr: string, empresa: EmpresaNacional): string {
  const t = tabelasNacional(empresa);
  return `GREATEST(
              (SELECT MAX(rfc.finalizado_em) FROM stockbridge.recebimento_fiscal rfc
                WHERE rfc.nf_chave_acesso = ${chaveExpr} AND rfc.status IN ('concluido', 'ja_concluido', 'revertido')),
              (SELECT MAX(${horaAlteracaoOmieSql('hnc')}) FROM public.${t.nfHeader} hnc
                WHERE hnc.c_chave_nfe = ${chaveExpr} AND hnc.tp_nf = 0),
              (SELECT MAX(GREATEST(${horaAlteracaoOmieSql('rrc')}, ${horaOmieSql('rrc', 'd_rec', 'h_rec')})) FROM public.${t.recebimento} rrc
                WHERE rrc.c_chave_nfe = ${chaveExpr} AND rrc.c_recebido = 'S'))`;
}

/** Hora da alteracao no OMIE que mostra o recebimento nao concluido (c_recebido 'N', nao cancelado), pelo espelho. */
export function pendenciaEspelhoEmSql(chaveExpr: string, empresa: EmpresaNacional): string {
  const t = tabelasNacional(empresa);
  return `(SELECT MAX(${horaAlteracaoOmieSql('rrp')}) FROM public.${t.recebimento} rrp
                WHERE rrp.c_chave_nfe = ${chaveExpr} AND rrp.c_recebido = 'N' AND COALESCE(rrp.c_cancelada, 'N') <> 'S')`;
}

/**
 * Ultimo marcador 'revertido' do ledger da NF, pela hora da REVERSAO: a do OMIE (revertido_omie_em) quando a marcacao
 * veio do espelho, e a da leitura ao vivo (revertido_em) quando veio do clique — nunca a hora em que a varredura ou a
 * abertura do detalhe so PERCEBEU a reversao (ate ~30 min depois): uma reconclusao no portal feita nesse meio-tempo
 * ficaria mais velha que o marcador e o sinal nunca mais desligaria (revisao da D21, achado de 3 revisores).
 */
export function marcadorRevertidoEmSql(chaveExpr: string): string {
  return `(SELECT MAX(COALESCE(rfr.revertido_omie_em, rfr.revertido_em)) FROM stockbridge.recebimento_fiscal rfr
                WHERE rfr.nf_chave_acesso = ${chaveExpr} AND rfr.status = 'revertido')`;
}

/**
 * O sinal (boolean, nunca NULL): o recebimento fiscal da NF `chaveExpr` foi concluido e depois revertido
 * no OMIE. Pendencia pelo espelho com margem de MARGEM_REVERSAO_ESPELHO_MIN; marcador do ledger estrito.
 * So emitir com a D21 habilitada (fiscalRevertidoHabilitado): o marcador le colunas da 0060.
 */
export function fiscalRevertidoSql(chaveExpr: string, empresa: EmpresaNacional): string {
  return `COALESCE(GREATEST(${pendenciaEspelhoEmSql(chaveExpr, empresa)} - interval '${MARGEM_REVERSAO_ESPELHO_MIN} minutes',
              ${marcadorRevertidoEmSql(chaveExpr)}) > ${conclusaoFiscalEmSql(chaveExpr, empresa)}, false)`;
}

/**
 * A hora do OMIE que a marcacao pelo espelho gravou no ledger, da reversao MAIS RECENTE (a linha que da o marcador do sinal);
 * NULL quando essa reversao so foi percebida pela leitura ao vivo do clique. Nunca a de uma reversao anterior: com duas
 * reversoes da NF (a primeira pelo espelho, a segunda pelo clique), o banner mostraria a hora da primeira (revisao da D21).
 */
export function reversaoOmieDoLedgerEmSql(chaveExpr: string): string {
  return `(SELECT rfo.revertido_omie_em FROM stockbridge.recebimento_fiscal rfo
                WHERE rfo.nf_chave_acesso = ${chaveExpr} AND rfo.status = 'revertido'
                ORDER BY COALESCE(rfo.revertido_omie_em, rfo.revertido_em) DESC, rfo.revertido_em DESC
                LIMIT 1)`;
}

/** Avalia o sinal para uma NF (adquirirLedger, leitura no clique). Erro de banco vai ao log e conta como "nao revertido". */
export async function nfComFiscalRevertido(nfChaveAcesso: string, empresa: EmpresaNacional): Promise<boolean> {
  try {
    const r = await getPool().query<{ revertido: boolean }>(`SELECT ${fiscalRevertidoSql('$1::text', empresa)} AS revertido`, [nfChaveAcesso]);
    return r.rows[0]?.revertido === true;
  } catch (err) {
    logger.error({ err, nfChaveAcesso }, 'Não foi possível avaliar se o recebimento fiscal foi revertido no OMIE');
    return false;
  }
}

// ── Ledger ──────────────────────────────────────────────────────────────────

/** Conclusao do fiscal registrada no ledger e ainda valendo (status concluido/ja_concluido: a linha viva da NF). */
export interface LedgerFiscalVigente {
  id: string;
  status: 'concluido' | 'ja_concluido';
  empresa: EmpresaNacional;
  nIdReceb: number | null;
  notaFiscal: string;
  fornecedorNome: string | null;
  /** ISO */
  finalizadoEm: string | null;
}

/** A linha viva concluida do ledger da NF, ou null (nunca concluida pelo Atlas, ou revertida). */
export async function ledgerFiscalVigente(nfChaveAcesso: string): Promise<LedgerFiscalVigente | null> {
  const r = await getPool().query<{
    id: string;
    status: 'concluido' | 'ja_concluido';
    empresa: string | null;
    n_id_receb: string | number | null;
    nota_fiscal: string;
    fornecedor_nome: string | null;
    finalizado_em: Date | string | null;
  }>(
    `SELECT id, status, empresa, n_id_receb, nota_fiscal, fornecedor_nome, finalizado_em
       FROM stockbridge.recebimento_fiscal
      WHERE nf_chave_acesso = $1 AND status IN ('concluido', 'ja_concluido')
      ORDER BY finalizado_em DESC NULLS LAST
      LIMIT 1`,
    [nfChaveAcesso],
  );
  const x = r.rows[0];
  if (!x) return null;
  const fim = x.finalizado_em == null ? null : new Date(x.finalizado_em);
  return {
    id: x.id,
    status: x.status,
    empresa: x.empresa === 'acxe' ? 'acxe' : 'q2p',
    // BIGINT volta string no driver
    nIdReceb: x.n_id_receb == null ? null : Number(x.n_id_receb),
    notaFiscal: x.nota_fiscal,
    fornecedorNome: x.fornecedor_nome,
    finalizadoEm: fim && !Number.isNaN(fim.getTime()) ? fim.toISOString() : null,
  };
}

/** A conclusao ja e velha o bastante para a leitura ao vivo nao cair no cache de antes do Concluir. */
export function leituraAoVivoPodeDeclararReversao(finalizadoEm: string | null, agora: Date = new Date()): boolean {
  if (!finalizadoEm) return true;
  const fim = new Date(finalizadoEm).getTime();
  return Number.isNaN(fim) || agora.getTime() - fim >= ESPERA_LEITURA_AO_VIVO_SEG * 1000;
}

export interface MarcacaoRevertido {
  id: string;
  nfChaveAcesso: string;
  notaFiscal: string;
}

/**
 * Marca como 'revertido' a conclusao do fiscal da NF e, na MESMA transacao, os vinculos com o PC dessa
 * tentativa (recebimento_fiscal_pc vivos -> 'revertido'): sem isso a reserva da nova tentativa do fiscal
 * violaria recebimento_fiscal_pc_item_vivo_uq e as linhas antigas seguiriam descontando o saldo do PC.
 *
 *  - origem 'espelho': re-confere o sinal DENTRO do UPDATE (uma conclusao mais nova — o Atlas refez o
 *    fiscal ou o fiscal reconcluiu no portal — desliga o sinal e nada e marcado) e grava a hora da
 *    alteracao no OMIE (revertido_omie_em, limitada a agora);
 *  - origem 'omie_ao_vivo': a leitura do clique e a prova; marca so a linha lida (`ledgerId`), se ela
 *    ainda for concluido/ja_concluido.
 * Idempotente: quem chega depois marca 0 linhas. Devolve as linhas marcadas.
 */
export async function marcarLedgerRevertido(args: {
  nfChaveAcesso: string;
  empresa: EmpresaNacional;
  origem: OrigemReversao;
  /** obrigatorio na leitura ao vivo; no espelho, restringe a uma linha (opcional) */
  ledgerId?: string | null;
  /** quem clicou (leitura ao vivo) */
  userId?: string | null;
}): Promise<MarcacaoRevertido[]> {
  if (args.origem === 'omie_ao_vivo' && !args.ledgerId) throw new Error('marcarLedgerRevertido: a leitura ao vivo marca uma linha do ledger (ledgerId)');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const params: unknown[] = [args.nfChaveAcesso, args.origem, args.userId ?? null];
    let filtro = '';
    let omieEm = 'NULL';
    if (args.ledgerId) {
      params.push(args.ledgerId);
      filtro += ` AND rf.id = $${params.length}`;
    }
    if (args.origem === 'espelho') {
      filtro += ` AND ${fiscalRevertidoSql('rf.nf_chave_acesso', args.empresa)}`;
      // LEAST ignora NULL: sem hora no espelho a coluna fica NULL, nunca "agora"
      const p = pendenciaEspelhoEmSql('rf.nf_chave_acesso', args.empresa);
      omieEm = `CASE WHEN ${p} IS NULL THEN NULL ELSE LEAST(${p}, now()) END`;
    }
    const r = await client.query<{ id: string; nf_chave_acesso: string; nota_fiscal: string }>(
      `UPDATE stockbridge.recebimento_fiscal rf
          SET status = 'revertido', revertido_em = now(), revertido_origem = $2, revertido_por = $3,
              revertido_omie_em = ${omieEm}, updated_at = now()
        WHERE rf.nf_chave_acesso = $1 AND rf.status IN ('concluido', 'ja_concluido')${filtro}
        RETURNING rf.id, rf.nf_chave_acesso, rf.nota_fiscal`,
      params,
    );
    const ids = r.rows.map((x) => x.id);
    if (ids.length > 0) {
      await client.query(
        `UPDATE stockbridge.recebimento_fiscal_pc
            SET status = 'revertido', updated_at = now()
          WHERE recebimento_fiscal_id = ANY($1::uuid[]) AND status IN ('confirmado', 'associado', 'concluido')`,
        [ids],
      );
    }
    await client.query('COMMIT');
    if (ids.length > 0) {
      logger.warn(
        { nfChaveAcesso: args.nfChaveAcesso, origem: args.origem, ledgerIds: ids, nf: r.rows[0]?.nota_fiscal },
        'Recebimento fiscal revertido no OMIE depois de concluído — ledger marcado como revertido',
      );
    }
    return r.rows.map((x) => ({ id: x.id, nfChaveAcesso: x.nf_chave_acesso, notaFiscal: x.nota_fiscal }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Erro do clique ──────────────────────────────────────────────────────────

/**
 * 409 RECEBIMENTO_FISCAL_REVERTIDO: a leitura ao vivo do clique mostrou o recebimento revertido no OMIE
 * depois de concluido. O ledger ja foi marcado: recarregada, a nota volta como fiscal pendente e o
 * proximo clique conclui o fiscal de novo (com o PC confirmado pelo operador). Nada foi gravado.
 */
export class RecebimentoFiscalRevertidoError extends Error {
  constructor(public readonly notaFiscal: string, public readonly fornecedorNome: string | null) {
    // Sem "recarregue": a tela ja recarrega a nota sozinha ao receber este 409 (ERROS_QUE_RECARREGAM_NOTA). Sem "fale com o
    // fiscal": o aviso da nota recarregada ja o diz (revisao da tela: a frase aparecia duas vezes).
    super(
      `O recebimento fiscal da NF ${notaFiscal}${fornecedorNome ? ` (${fornecedorNome})` : ''} foi desfeito no OMIE depois de concluído. ` +
        'A nota voltou para fiscal pendente: confira o pedido de compra e dê entrada de novo, e o Atlas conclui o fiscal junto.',
    );
    this.name = 'RecebimentoFiscalRevertidoError';
  }
}
