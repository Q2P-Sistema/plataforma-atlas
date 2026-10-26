import { getPool, createLogger } from '@atlas/core';
import { empresasNacionalAtivas, type EmpresaNacional } from './empresa-nacional.js';
import { fiscalRevertidoHabilitado, fiscalRevertidoSql, marcarLedgerRevertido } from './fiscal-revertido.js';
import { enviarAvisoFiscalRevertido, getFiscalEmails } from './notificacao.service.js';

/**
 * Varredura do cron :05/:35 do recebimento fiscal REVERTIDO no portal do OMIE (feature 017, research D21,
 * ACXEGDP-437). So Postgres (zero chamada ao OMIE), por empresa, em duas fases:
 *
 *  A) MARCAR — ledgers concluido/ja_concluido dos ultimos VARREDURA_FISCAL_REVERTIDO_MARCAR_DIAS dias em que o SINAL
 *     (fiscalRevertidoSql: o espelho mostra o recebimento pendente depois da conclusao) esta ligado viram
 *     'revertido' (marcarLedgerRevertido, que re-confere o sinal dentro do UPDATE). A fila usa o mesmo sinal direto
 *     no SQL; a marcacao tira do ledger e do saldo do PC o que a tentativa antiga ainda segurava, e e o que a fase B le.
 *  B) AVISAR — ledger 'revertido' sem aviso, dos ultimos VARREDURA_FISCAL_REVERTIDO_AVISAR_DIAS dias, AINDA revertido
 *     pelo sinal (sem conclusao mais nova: o Atlas refez o fiscal ou o fiscal reconcluiu no portal), com a entrada
 *     fisica da NF ATIVA no Atlas (a nota nao volta a fila: so o fiscal refaz o fiscal, no portal) e sem dispensa
 *     ativa (o e-mail de dispensa ja mandou o fiscal tratar a nota, e estornar e justamente reverter o recebimento)
 *     -> e-mail ao fiscal; entregue, grava aviso_fiscal_em. Falha de envio nao grava: tenta de novo na proxima rodada.
 *
 * A fase B independe de como a marcacao nasceu (varredura ou leitura ao vivo do clique). NUNCA lanca: a API nao tem
 * handler de unhandledRejection e o node-cron nao trata promessa solta. Gates: fiscalRevertidoHabilitado() (chave da
 * 016, kill switch e migration 0060); a Q2P sempre que habilitado e a ACXE so com recebimentoNacionalAcxeHabilitado().
 */

const logger = createLogger('stockbridge:fiscal-revertido-varredura');

/** Fase A: so ledgers concluidos nos ultimos N dias entram (nao varre nem marca o historico no primeiro deploy). */
export const VARREDURA_FISCAL_REVERTIDO_MARCAR_DIAS = 14;
/** Fase A: ledgers marcados por rodada (o resto fica para a proxima; a fila ja usa o sinal direto). */
export const VARREDURA_FISCAL_REVERTIDO_MARCAR_LIMITE = 50;
/** Fase B: reversoes dos ultimos N dias ainda sem aviso ao fiscal (contados de revertido_em). */
export const VARREDURA_FISCAL_REVERTIDO_AVISAR_DIAS = 7;
/** Fase B: avisos por rodada. */
export const VARREDURA_FISCAL_REVERTIDO_AVISAR_LIMITE = 10;

export interface VarreduraFiscalRevertido {
  /** ledgers marcados como revertido nesta rodada (fase A) */
  marcados: number;
  /** avisos ao fiscal entregues (fase B) */
  avisados: number;
  /** avisos que nao sairam ou deram erro — tentam de novo na proxima rodada (fase B) */
  falhas: number;
}

interface CandidatoAviso {
  ledger_id: string;
  nf_chave_acesso: string;
  nota_fiscal: string;
  fornecedor_nome: string | null;
  finalizado_em: Date | string | null;
  revertido_em: Date | string;
  revertido_omie_em: Date | string | null;
  /** 'S' = o OMIE ja estava recebido quando o Atlas olhou (ja_concluido: quem concluiu foi o fiscal, no portal) */
  recebido_antes: string | null;
}

/** Fase A: ledgers concluidos recentes com o sinal ligado. O predicado e o mesmo da fila (fiscalRevertidoSql). */
function sqlMarcar(empresa: EmpresaNacional): string {
  return `SELECT rf.id::text AS id, rf.nf_chave_acesso
            FROM stockbridge.recebimento_fiscal rf
           WHERE rf.empresa = $1
             AND rf.status IN ('concluido', 'ja_concluido')
             AND rf.finalizado_em > now() - make_interval(days => $2)
             AND ${fiscalRevertidoSql('rf.nf_chave_acesso', empresa)}
           ORDER BY rf.finalizado_em
           LIMIT $3`;
}

/**
 * Fase B: uma linha por NF (a reversao mais recente sem aviso). Entrada fisica ATIVA = movimentacao ativa de
 * compra_nacional com a chave, pendente de aprovacao ou aprovada; dispensa ativa = revertido_em IS NULL.
 */
function sqlCandidatosAviso(empresa: EmpresaNacional): string {
  return `SELECT c.*
            FROM (
              SELECT DISTINCT ON (rf.nf_chave_acesso)
                     rf.id::text AS ledger_id, rf.nf_chave_acesso, rf.nota_fiscal, rf.fornecedor_nome,
                     rf.finalizado_em, rf.revertido_em, rf.revertido_omie_em, rf.recebido_antes
                FROM stockbridge.recebimento_fiscal rf
               WHERE rf.empresa = $1
                 AND rf.status = 'revertido'
                 AND rf.aviso_fiscal_em IS NULL
                 AND rf.revertido_em > now() - make_interval(days => $2)
                 AND EXISTS (SELECT 1 FROM stockbridge.movimentacao m
                              WHERE m.nf_chave_acesso = rf.nf_chave_acesso AND m.subtipo = 'compra_nacional' AND m.ativo = true)
                 AND NOT EXISTS (SELECT 1 FROM stockbridge.nf_dispensa d
                                  WHERE d.nf_chave_acesso = rf.nf_chave_acesso AND d.revertido_em IS NULL)
                 -- AINDA revertido: o mesmo sinal da fila (o ledger revertido conta como a conclusao que foi desfeita)
                 AND ${fiscalRevertidoSql('rf.nf_chave_acesso', empresa)}
               ORDER BY rf.nf_chave_acesso, rf.revertido_em DESC
            ) c
           ORDER BY c.revertido_em
           LIMIT $3`;
}

/** Situacao da entrada fisica da NF no Atlas: itens aguardando o gestor e itens aprovados (para o texto do e-mail). */
const SQL_ENTRADA_FISICA = `SELECT COUNT(*) FILTER (WHERE a.status = 'pendente')::int AS pendentes,
                                   COUNT(*) FILTER (WHERE a.status = 'aprovada')::int AS aprovadas,
                                   MAX(a.aprovado_em) FILTER (WHERE a.status = 'aprovada') AS aprovada_em
                              FROM stockbridge.movimentacao m
                              LEFT JOIN stockbridge.aprovacao a ON a.movimentacao_id = m.id AND a.tipo_aprovacao = 'entrada_manual'
                             WHERE m.nf_chave_acesso = $1 AND m.subtipo = 'compra_nacional' AND m.ativo = true`;

/** PCs vinculados pela tentativa revertida (a marcacao leva os vinculos vivos para 'revertido'). So o numero legivel. */
const SQL_PCS_DA_TENTATIVA = `SELECT DISTINCT pc.pc_numero
                                FROM stockbridge.recebimento_fiscal_pc pc
                               WHERE pc.recebimento_fiscal_id = $1::uuid AND pc.status IN ('revertido', 'concluido')`;

/** O aviso cobre a NF: marca todas as reversoes dela ainda sem aviso (uma NF revertida duas vezes nao avisa duas vezes). */
const SQL_MARCAR_AVISADO = `UPDATE stockbridge.recebimento_fiscal
                               SET aviso_fiscal_em = now(), updated_at = now()
                             WHERE nf_chave_acesso = $1 AND status = 'revertido' AND aviso_fiscal_em IS NULL`;

/** Erro do Postgres por tabela (42P01) ou coluna (42703) ausente, percorrendo `cause` — espelho ou migration ainda nao criados. */
function tabelaAusente(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const o = e as { code?: unknown; cause?: unknown };
    if (o.code === '42P01' || o.code === '42703') return true;
    e = o.cause;
  }
  return false;
}

function registrarErro(err: unknown, empresa: EmpresaNacional, fase: 'marcar' | 'avisar'): void {
  if (tabelaAusente(err)) {
    logger.warn(
      { err: (err as Error).message, empresa, fase },
      'Tabela ou coluna ausente na varredura de recebimento fiscal revertido no OMIE (espelho ou migration 0060 ainda não criados) — fase adiada',
    );
  } else {
    logger.error({ err, empresa, fase }, 'Falha na varredura de recebimento fiscal revertido no OMIE');
  }
}

/** Fase A: devolve quantos ledgers foram marcados. Uma NF que falha nao impede as outras. */
async function marcarRevertidos(empresa: EmpresaNacional): Promise<number> {
  const r = await getPool().query<{ id: string; nf_chave_acesso: string }>(sqlMarcar(empresa), [
    empresa,
    VARREDURA_FISCAL_REVERTIDO_MARCAR_DIAS,
    VARREDURA_FISCAL_REVERTIDO_MARCAR_LIMITE,
  ]);
  let marcados = 0;
  for (const x of r.rows) {
    try {
      const m = await marcarLedgerRevertido({ nfChaveAcesso: x.nf_chave_acesso, empresa, origem: 'espelho', ledgerId: x.id });
      marcados += m.length;
    } catch (err) {
      logger.error({ err, empresa, ledgerId: x.id }, 'Falha ao marcar o recebimento fiscal revertido no OMIE — tenta de novo na próxima rodada');
    }
  }
  return marcados;
}

/** Numero de PC em ordem natural ("9" antes de "10"). */
const porNumero = (a: string, b: string): number => a.localeCompare(b, 'pt-BR', { numeric: true });

/** Fase B: avisa o fiscal de cada NF candidata. Devolve entregues e falhas (as falhas voltam na proxima rodada). */
async function avisarFiscal(empresa: EmpresaNacional): Promise<{ avisados: number; falhas: number }> {
  const pool = getPool();
  const candidatos = await pool.query<CandidatoAviso>(sqlCandidatosAviso(empresa), [
    empresa,
    VARREDURA_FISCAL_REVERTIDO_AVISAR_DIAS,
    VARREDURA_FISCAL_REVERTIDO_AVISAR_LIMITE,
  ]);
  if (candidatos.rows.length === 0) return { avisados: 0, falhas: 0 };
  if (getFiscalEmails().length === 0) {
    // sem destinatario nada e marcado: quando a lista voltar, o aviso sai (dentro da janela de dias)
    logger.warn(
      { empresa, candidatos: candidatos.rows.length },
      'STOCKBRIDGE_FISCAL_EMAILS vazio — fiscal não avisado do recebimento fiscal desfeito no OMIE (nada foi marcado)',
    );
    return { avisados: 0, falhas: 0 };
  }

  let avisados = 0;
  let falhas = 0;
  for (const x of candidatos.rows) {
    try {
      const entrada = await pool.query<{ pendentes: number | string | null; aprovadas: number | string | null; aprovada_em: Date | string | null }>(
        SQL_ENTRADA_FISICA,
        [x.nf_chave_acesso],
      );
      const pcs = await pool.query<{ pc_numero: string | null }>(SQL_PCS_DA_TENTATIVA, [x.ledger_id]);
      const e = entrada.rows[0];
      const resultado = await enviarAvisoFiscalRevertido({
        empresa,
        // sem zeros a esquerda; o aviso nunca recebe a chave de acesso nem outro codigo do OMIE (ACXEGDP-313)
        notaFiscal: (x.nota_fiscal ?? '').trim().replace(/^0+(?=\d)/, ''),
        fornecedorNome: x.fornecedor_nome,
        concluidoEm: x.finalizado_em,
        // ja_concluido (o fiscal concluiu no portal e o Atlas so viu): o e-mail nao diz "o Atlas concluiu"
        ...(x.recebido_antes === 'S' ? { concluidoForaDoAtlas: true } : {}),
        desfeitoEm: x.revertido_omie_em ?? x.revertido_em,
        entrada: { pendentes: Number(e?.pendentes ?? 0), aprovadas: Number(e?.aprovadas ?? 0), aprovadaEm: e?.aprovada_em ?? null },
        pcs: Array.from(new Set(pcs.rows.map((p) => (p.pc_numero ?? '').trim()).filter(Boolean))).sort(porNumero),
      });
      const ctx = { empresa, ledgerId: x.ledger_id, notaFiscal: x.nota_fiscal, resultado };
      if (resultado !== 'enviado') {
        falhas++;
        logger.warn(ctx, 'Varredura: aviso ao fiscal de recebimento fiscal desfeito no OMIE não saiu — tenta de novo na próxima rodada');
        continue;
      }
      avisados++;
      logger.info(ctx, 'Varredura: aviso ao fiscal de recebimento fiscal desfeito no OMIE');
      try {
        await pool.query(SQL_MARCAR_AVISADO, [x.nf_chave_acesso]);
      } catch (err) {
        logger.error(
          { err, empresa, ledgerId: x.ledger_id },
          'Aviso ao fiscal entregue, mas aviso_fiscal_em não foi gravado — o aviso será reenviado na próxima rodada',
        );
      }
    } catch (err) {
      falhas++;
      logger.error({ err, empresa, ledgerId: x.ledger_id }, 'Falha ao avisar o fiscal do recebimento fiscal desfeito no OMIE — tenta de novo na próxima rodada');
    }
  }
  return { avisados, falhas };
}

async function varrerEmpresa(empresa: EmpresaNacional): Promise<VarreduraFiscalRevertido> {
  const r: VarreduraFiscalRevertido = { marcados: 0, avisados: 0, falhas: 0 };
  try {
    r.marcados = await marcarRevertidos(empresa);
  } catch (err) {
    registrarErro(err, empresa, 'marcar');
  }
  try {
    const a = await avisarFiscal(empresa);
    r.avisados = a.avisados;
    r.falhas = a.falhas;
  } catch (err) {
    registrarErro(err, empresa, 'avisar');
  }
  return r;
}

/**
 * Uma rodada da varredura (cron :05/:35), Q2P e, com a compra nacional da ACXE habilitada, ACXE. Sem a D21 habilitada
 * (chave da 016, kill switch, migration 0060) nao faz nenhuma consulta. Nunca lanca; devolve os contadores.
 */
export async function varrerFiscaisRevertidos(): Promise<VarreduraFiscalRevertido> {
  const total: VarreduraFiscalRevertido = { marcados: 0, avisados: 0, falhas: 0 };
  try {
    if (!(await fiscalRevertidoHabilitado())) return total;
    for (const empresa of empresasNacionalAtivas()) {
      const r = await varrerEmpresa(empresa);
      total.marcados += r.marcados;
      total.avisados += r.avisados;
      total.falhas += r.falhas;
    }
    if (total.marcados > 0 || total.avisados > 0 || total.falhas > 0) {
      logger.info(total, 'Varredura de recebimento fiscal revertido no OMIE');
    }
  } catch (err) {
    logger.error({ err }, 'Falha na varredura de recebimento fiscal revertido no OMIE');
  }
  return total;
}
