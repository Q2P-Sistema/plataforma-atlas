import { getPool, createLogger } from '@atlas/core';
import {
  consultarRecebimentoNfe,
  alterarRecebimentoNfeItens,
  concluirRecebimentoNfe,
  type RecebimentoNfeConsultado,
} from '@atlas/integration-omie';
import { FORNECEDOR_NAO_IDENTIFICADO } from './fila-nacional.service.js';

const logger = createLogger('stockbridge:recebimento-fiscal');

/**
 * Recebimento FISCAL da NF nacional pelo Atlas (feature 016, ACXEGDP-395).
 *
 * Conclui no OMIE o recebimento de uma NF que chegou da SEFAZ e esta parada na
 * caixa "Recebimento de NF-e" (etapa 40), SEM movimentar estoque — o estoque
 * continua sendo lancado pelo recebimento fisico do Atlas (ajuste na aprovacao
 * do gestor). Reproduz exatamente o "Ignorar" da tela (testado em producao na
 * NF 6842, 02/10/2026 — research D1):
 *
 *   1. ConsultarRecebimento (por cChaveNfe)  — ja concluido? -> ja_concluido
 *   2. AlterarRecebimento  cAcao=EDITAR  + itensAjustes {cNaoGerarMovEstoque:S, cNaoGerarFinanceiro:N}
 *   3. AlterarRecebimento  cAcao=IGNORAR (sem ajustes — juntar da erro 151)
 *   4. ConcluirRecebimento cEtapa=60
 *
 * Lock, idempotencia e rastro vivem no LEDGER `stockbridge.recebimento_fiscal`
 * (research D6): a linha `em_andamento` e gravada ANTES da primeira chamada ao
 * OMIE e e unica por NF (indice parcial) — duplo clique perde no INSERT. Nao se
 * confia numa segunda consulta ao OMIE para isso porque `ConsultarRecebimento`
 * com corpo identico em < ~1 min devolve resposta antiga (cache — research D2);
 * por isso a RECONSULTA apos falha usa o OUTRO corpo (nIdReceb).
 *
 * Nada aqui grava movimentacao/aprovacao: quem chama (recebimento-nacional)
 * so segue para a escrita fisica depois que esta funcao retorna (FR-008/FR-012).
 */

export type StatusFiscalLedger = 'em_andamento' | 'concluido' | 'ja_concluido' | 'falha';
export type PassoFiscal = 'consultar' | 'editar' | 'ignorar' | 'concluir' | 'reconsultar';

/** Tempo apos o qual uma linha `em_andamento` e considerada orfa (processo morreu) e pode ser retomada. */
export const LOCK_FISCAL_ORFAO_MIN = 5;

const CNPJ_FISCAL = 'q2p' as const;

// ── Erros (mensagens em pt-BR, com NF + fornecedor, sem codigo OMIE — ACXEGDP-313) ──

function rotuloNf(notaFiscal: string, fornecedorNome: string | null): string {
  const f = fornecedorNome && fornecedorNome.trim() ? fornecedorNome.trim() : FORNECEDOR_NAO_IDENTIFICADO;
  return `NF ${notaFiscal} (${f})`;
}

export class RecebimentoFiscalError extends Error {
  constructor(
    public readonly passo: PassoFiscal,
    public readonly notaFiscal: string,
    public readonly fornecedorNome: string | null,
    options?: { cause?: unknown },
  ) {
    super(
      `Não foi possível concluir o recebimento fiscal da ${rotuloNf(notaFiscal, fornecedorNome)} no OMIE. ` +
        'Nada foi registrado — tente novamente em instantes. Se persistir, avise o fiscal.',
      options,
    );
    this.name = 'RecebimentoFiscalError';
  }
}

export class RecebimentoFiscalEmAndamentoError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`O recebimento fiscal da NF ${notaFiscal} já está sendo concluído. Aguarde alguns segundos e recarregue a nota.`);
    this.name = 'RecebimentoFiscalEmAndamentoError';
  }
}

export class RecebimentoFiscalSemFornecedorError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`A NF ${notaFiscal} está sem fornecedor cadastrado no OMIE. Peça ao fiscal para cadastrar o fornecedor e tente de novo.`);
    this.name = 'RecebimentoFiscalSemFornecedorError';
  }
}

export class RecebimentoFiscalNfCanceladaError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`A NF ${notaFiscal} consta como cancelada no OMIE e não pode ter o recebimento fiscal concluído.`);
    this.name = 'RecebimentoFiscalNfCanceladaError';
  }
}

// ── Contrato ────────────────────────────────────────────────────────────────

export interface ConcluirRecebimentoFiscalInput {
  nfChaveAcesso: string;
  /** do espelho; se nulo, vem da ConsultarRecebimento */
  nIdReceb: number | null;
  notaFiscal: string;
  fornecedorNome: string | null;
  userId: string;
}

export interface ConcluirRecebimentoFiscalResult {
  status: 'concluido' | 'ja_concluido';
  concluidoEm: string;
  ledgerId: string;
  /** itens da NF enviados em EDITAR/IGNORAR (0 em ja_concluido sem escrita) */
  itensTotal: number;
}

// ── Ledger (raw SQL via getPool — espelha o padrao da fila; facil de mockar) ──

type Ledger = { id: string };

interface LinhaViva {
  id: string;
  status: StatusFiscalLedger;
  iniciado_em: string;
  finalizado_em: string | null;
}

function violacaoLedgerViva(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const o = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (o.code === '23505' && o.constraint === 'recebimento_fiscal_nf_viva_uq') return true;
    e = o.cause;
  }
  return false;
}

/**
 * Adquire o lock: INSERT `em_andamento`. Se ja existe linha viva para a chave:
 *  - `concluido`/`ja_concluido` -> devolve `jaConcluido` (nenhuma chamada OMIE);
 *  - `em_andamento` recente     -> RecebimentoFiscalEmAndamentoError (duplo clique);
 *  - `em_andamento` orfa        -> retoma a linha (UPDATE atomico).
 */
async function adquirirLedger(
  input: ConcluirRecebimentoFiscalInput,
): Promise<{ ledger: Ledger; jaConcluido: { concluidoEm: string } | null }> {
  const pool = getPool();
  try {
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO stockbridge.recebimento_fiscal
         (nf_chave_acesso, n_id_receb, nota_fiscal, fornecedor_nome, status, confirmado_por)
       VALUES ($1, $2, $3, $4, 'em_andamento', $5)
       RETURNING id`,
      [input.nfChaveAcesso, input.nIdReceb, input.notaFiscal, input.fornecedorNome, input.userId],
    );
    return { ledger: { id: ins.rows[0]!.id }, jaConcluido: null };
  } catch (err) {
    if (!violacaoLedgerViva(err)) throw err;
  }

  const viva = await pool.query<LinhaViva>(
    `SELECT id, status, iniciado_em::text AS iniciado_em, finalizado_em::text AS finalizado_em
       FROM stockbridge.recebimento_fiscal
      WHERE nf_chave_acesso = $1 AND status IN ('em_andamento', 'concluido', 'ja_concluido')
      LIMIT 1`,
    [input.nfChaveAcesso],
  );
  const linha = viva.rows[0];
  if (!linha) {
    // A linha viva sumiu entre o INSERT e o SELECT (outra transacao fechou em
    // 'falha'): tentar de novo uma vez.
    return adquirirLedger(input);
  }
  if (linha.status === 'concluido' || linha.status === 'ja_concluido') {
    return {
      ledger: { id: linha.id },
      jaConcluido: { concluidoEm: linha.finalizado_em ? new Date(linha.finalizado_em).toISOString() : new Date().toISOString() },
    };
  }
  // em_andamento: orfa (processo morreu) -> retoma; recente -> alguem esta concluindo agora.
  const retomada = await pool.query<{ id: string }>(
    `UPDATE stockbridge.recebimento_fiscal
        SET confirmado_por = $2, iniciado_em = now(), updated_at = now(),
            n_id_receb = COALESCE($3, n_id_receb)
      WHERE id = $1 AND status = 'em_andamento'
        AND iniciado_em < now() - make_interval(mins => $4)
      RETURNING id`,
    [linha.id, input.userId, input.nIdReceb, LOCK_FISCAL_ORFAO_MIN],
  );
  if (retomada.rows.length === 0) throw new RecebimentoFiscalEmAndamentoError(input.notaFiscal);
  logger.warn({ ledgerId: linha.id, nf: input.notaFiscal, iniciadoEm: linha.iniciado_em }, 'Lock fiscal órfão retomado');
  return { ledger: { id: linha.id }, jaConcluido: null };
}

interface FecharLedgerArgs {
  status: Exclude<StatusFiscalLedger, 'em_andamento'>;
  nIdReceb?: number | null;
  etapaAntes?: string | null;
  recebidoAntes?: string | null;
  itensTotal?: number | null;
  passoFalha?: PassoFiscal | null;
  erroOmieCodigo?: string | null;
  erroOmieMensagem?: string | null;
}

async function fecharLedger(ledgerId: string, a: FecharLedgerArgs): Promise<string> {
  const pool = getPool();
  const r = await pool.query<{ finalizado_em: string }>(
    `UPDATE stockbridge.recebimento_fiscal
        SET status = $2,
            n_id_receb = COALESCE($3, n_id_receb),
            etapa_antes = COALESCE($4, etapa_antes),
            recebido_antes = COALESCE($5, recebido_antes),
            itens_total = COALESCE($6, itens_total),
            passo_falha = $7,
            erro_omie_codigo = $8,
            erro_omie_mensagem = $9,
            finalizado_em = now(),
            updated_at = now()
      WHERE id = $1
      RETURNING finalizado_em::text AS finalizado_em`,
    [
      ledgerId,
      a.status,
      a.nIdReceb ?? null,
      a.etapaAntes ?? null,
      a.recebidoAntes ?? null,
      a.itensTotal ?? null,
      a.passoFalha ?? null,
      a.erroOmieCodigo ?? null,
      a.erroOmieMensagem ? a.erroOmieMensagem.slice(0, 4000) : null,
    ],
  );
  const fim = r.rows[0]?.finalizado_em;
  return fim ? new Date(fim).toISOString() : new Date().toISOString();
}

// ── OMIE ────────────────────────────────────────────────────────────────────

/** Extrai codigo/mensagem de um OmieApiError (ou qualquer erro) sem depender de instanceof. */
function extrairErroOmie(err: unknown): { codigo: string | null; mensagem: string } {
  const e = (err ?? {}) as { omieCode?: unknown; message?: unknown };
  return {
    codigo: typeof e.omieCode === 'string' ? e.omieCode : null,
    mensagem: typeof e.message === 'string' ? e.message : String(err),
  };
}

// Research pendencia 3: o faultstring do OMIE para "fornecedor nao cadastrado"
// ainda nao foi observado; a deteccao principal e pela consulta (nIdFornecedor
// nulo). Este regex e a rede secundaria, a calibrar com a primeira ocorrencia real.
const RE_SEM_FORNECEDOR = /fornecedor[^.!]*(n[aã]o (cadastrad|informad|encontrad|identificad)|inv[aá]lid|inexist)/i;

function ajustesEditar(rec: RecebimentoNfeConsultado) {
  return rec.itens.map((it) => ({
    nSequencia: it.nSequencia,
    cAcao: 'EDITAR' as const,
    itensAjustes: { cNaoGerarMovEstoque: 'S' as const, cNaoGerarFinanceiro: 'N' as const },
  }));
}

function ignorarTodos(rec: RecebimentoNfeConsultado) {
  return rec.itens.map((it) => ({ nSequencia: it.nSequencia, cAcao: 'IGNORAR' as const }));
}

/**
 * Conclui o recebimento fiscal de UMA NF (todos os itens, de uma vez — FR-010).
 *
 * Desfechos:
 *  - `concluido`     — as tres escritas passaram; ledger `concluido`.
 *  - `ja_concluido`  — o OMIE ja mostrava cRecebido='S' (alguem concluiu no portal,
 *                      ou um clique anterior deu timeout mas gravou); nada escrito.
 * Falhas lancam (ledger `falha` com passo + erro OMIE):
 *  - RecebimentoFiscalEmAndamentoError  — outra confirmacao em curso (lock).
 *  - RecebimentoFiscalSemFornecedorError — NF sem fornecedor cadastrado no OMIE.
 *  - RecebimentoFiscalNfCanceladaError   — NF cancelada no OMIE.
 *  - RecebimentoFiscalError              — fault/timeout em EDITAR/IGNORAR/Concluir
 *                                          e a reconsulta nao mostrou concluido.
 */
export async function concluirRecebimentoFiscal(input: ConcluirRecebimentoFiscalInput): Promise<ConcluirRecebimentoFiscalResult> {
  const { ledger, jaConcluido } = await adquirirLedger(input);
  if (jaConcluido) {
    logger.info({ ledgerId: ledger.id, nf: input.notaFiscal }, 'Fiscal já concluído pelo Atlas (ledger) — nenhuma chamada OMIE');
    return { status: 'ja_concluido', concluidoEm: jaConcluido.concluidoEm, ledgerId: ledger.id, itensTotal: 0 };
  }

  let passo: PassoFiscal = 'consultar';
  let nIdReceb: number | null = input.nIdReceb;
  let rec: RecebimentoNfeConsultado | null = null;

  try {
    // 1. Consulta por CHAVE (corpo A). Se der certo, a reconsulta usa nIdReceb (corpo B) — D2.
    rec = await consultarRecebimentoNfe(CNPJ_FISCAL, { cChaveNfe: input.nfChaveAcesso });
    nIdReceb = rec.nIdReceb;

    if (rec.cRecebido === 'S') {
      const concluidoEm = await fecharLedger(ledger.id, {
        status: 'ja_concluido',
        nIdReceb,
        etapaAntes: rec.cEtapa,
        recebidoAntes: rec.cRecebido,
        itensTotal: rec.itens.length,
      });
      logger.info({ ledgerId: ledger.id, nf: input.notaFiscal, nIdReceb }, 'Fiscal já estava concluído no OMIE — nada escrito');
      return { status: 'ja_concluido', concluidoEm, ledgerId: ledger.id, itensTotal: 0 };
    }
    if (rec.cCancelada === 'S') {
      await fecharLedger(ledger.id, {
        status: 'falha', nIdReceb, etapaAntes: rec.cEtapa, recebidoAntes: rec.cRecebido,
        passoFalha: 'consultar', erroOmieCodigo: null, erroOmieMensagem: 'NF cancelada no OMIE (cCancelada=S)',
      });
      throw new RecebimentoFiscalNfCanceladaError(input.notaFiscal);
    }
    if (rec.nIdFornecedor == null) {
      await fecharLedger(ledger.id, {
        status: 'falha', nIdReceb, etapaAntes: rec.cEtapa, recebidoAntes: rec.cRecebido,
        passoFalha: 'consultar', erroOmieCodigo: null, erroOmieMensagem: 'Recebimento sem fornecedor cadastrado (nIdFornecedor nulo)',
      });
      throw new RecebimentoFiscalSemFornecedorError(input.notaFiscal);
    }
    if (rec.itens.length === 0) {
      await fecharLedger(ledger.id, {
        status: 'falha', nIdReceb, etapaAntes: rec.cEtapa, recebidoAntes: rec.cRecebido,
        passoFalha: 'consultar', erroOmieCodigo: null, erroOmieMensagem: 'Recebimento sem itens na ConsultarRecebimento',
      });
      throw new RecebimentoFiscalError('consultar', input.notaFiscal, input.fornecedorNome);
    }

    // 2–4. As tres escritas, na ordem — SEM retry (STK-23).
    passo = 'editar';
    await alterarRecebimentoNfeItens(CNPJ_FISCAL, { nIdReceb, itens: ajustesEditar(rec) });
    passo = 'ignorar';
    await alterarRecebimentoNfeItens(CNPJ_FISCAL, { nIdReceb, itens: ignorarTodos(rec) });
    passo = 'concluir';
    await concluirRecebimentoNfe(CNPJ_FISCAL, { nIdReceb, cEtapa: '60' });

    const concluidoEm = await fecharLedger(ledger.id, {
      status: 'concluido',
      nIdReceb,
      etapaAntes: rec.cEtapa,
      recebidoAntes: rec.cRecebido,
      itensTotal: rec.itens.length,
    });
    logger.info({ ledgerId: ledger.id, nf: input.notaFiscal, nIdReceb, itens: rec.itens.length }, 'Recebimento fiscal concluído no OMIE pelo Atlas');
    return { status: 'concluido', concluidoEm, ledgerId: ledger.id, itensTotal: rec.itens.length };
  } catch (err) {
    // Erros de dominio ja fecharam o ledger acima.
    if (
      err instanceof RecebimentoFiscalSemFornecedorError ||
      err instanceof RecebimentoFiscalNfCanceladaError ||
      err instanceof RecebimentoFiscalError
    ) {
      throw err;
    }

    const omie = extrairErroOmie(err);

    // Reconsulta com o OUTRO corpo (nIdReceb) para furar o cache de ~1 min (D2/D3):
    // um timeout em Concluir pode ter gravado; um fault em EDITAR pode ser "ja concluido".
    if (passo !== 'consultar' && nIdReceb != null) {
      try {
        const re = await consultarRecebimentoNfe(CNPJ_FISCAL, { nIdReceb });
        if (re.cRecebido === 'S') {
          const concluidoEm = await fecharLedger(ledger.id, {
            status: 'ja_concluido',
            nIdReceb,
            etapaAntes: rec?.cEtapa ?? null,
            recebidoAntes: rec?.cRecebido ?? null,
            itensTotal: re.itens.length,
            erroOmieCodigo: omie.codigo,
            erroOmieMensagem: `[${passo}] ${omie.mensagem} — reconsulta mostrou cRecebido=S`,
          });
          logger.warn({ ledgerId: ledger.id, nf: input.notaFiscal, passo, omie }, 'Fault no fiscal, mas a reconsulta mostra concluído — tratado como ja_concluido');
          return { status: 'ja_concluido', concluidoEm, ledgerId: ledger.id, itensTotal: 0 };
        }
      } catch (err2) {
        logger.warn({ err: (err2 as Error).message, nf: input.notaFiscal }, 'Reconsulta após falha do fiscal também falhou');
      }
    }

    const semFornecedor = RE_SEM_FORNECEDOR.test(omie.mensagem);
    await fecharLedger(ledger.id, {
      status: 'falha',
      nIdReceb,
      etapaAntes: rec?.cEtapa ?? null,
      recebidoAntes: rec?.cRecebido ?? null,
      itensTotal: rec?.itens.length ?? null,
      passoFalha: passo,
      erroOmieCodigo: omie.codigo,
      erroOmieMensagem: omie.mensagem,
    });
    logger.error({ err, ledgerId: ledger.id, nf: input.notaFiscal, chave: input.nfChaveAcesso, passo, omieCodigo: omie.codigo }, 'Falha ao concluir recebimento fiscal no OMIE');
    if (semFornecedor) throw new RecebimentoFiscalSemFornecedorError(input.notaFiscal);
    throw new RecebimentoFiscalError(passo, input.notaFiscal, input.fornecedorNome, { cause: err });
  }
}

// ── Rastreabilidade (contrato §7) ───────────────────────────────────────────

export interface LedgerFiscalItem {
  id: string;
  nfChaveAcesso: string;
  notaFiscal: string;
  fornecedorNome: string | null;
  status: StatusFiscalLedger;
  passoFalha: PassoFiscal | null;
  itensTotal: number | null;
  confirmadoPor: { id: string; nome: string | null };
  iniciadoEm: string;
  finalizadoEm: string | null;
}

/** Lista o ledger para o gestor — SEM erro_omie_* (fica no banco e no log; ACXEGDP-313). */
export async function listarLedgerFiscal(params: { status?: StatusFiscalLedger | null; limit?: number } = {}): Promise<LedgerFiscalItem[]> {
  const pool = getPool();
  const limit = Math.min(200, Math.max(1, params.limit ?? 100));
  const args: unknown[] = [limit];
  let filtro = '';
  if (params.status) {
    args.push(params.status);
    filtro = `WHERE rf.status = $${args.length}`;
  }
  const r = await pool.query<{
    id: string; nf_chave_acesso: string; nota_fiscal: string; fornecedor_nome: string | null; status: StatusFiscalLedger;
    passo_falha: PassoFiscal | null; itens_total: number | null; confirmado_por: string; confirmado_por_nome: string | null;
    iniciado_em: string; finalizado_em: string | null;
  }>(
    `SELECT rf.id, rf.nf_chave_acesso, rf.nota_fiscal, rf.fornecedor_nome, rf.status, rf.passo_falha, rf.itens_total,
            rf.confirmado_por, u.name AS confirmado_por_nome,
            rf.iniciado_em::text AS iniciado_em, rf.finalizado_em::text AS finalizado_em
       FROM stockbridge.recebimento_fiscal rf
       LEFT JOIN atlas.users u ON u.id = rf.confirmado_por
       ${filtro}
      ORDER BY rf.iniciado_em DESC
      LIMIT $1`,
    args,
  );
  return r.rows.map((x) => ({
    id: x.id,
    nfChaveAcesso: x.nf_chave_acesso,
    notaFiscal: x.nota_fiscal,
    fornecedorNome: x.fornecedor_nome,
    status: x.status,
    passoFalha: x.passo_falha,
    itensTotal: x.itens_total != null ? Number(x.itens_total) : null,
    confirmadoPor: { id: x.confirmado_por, nome: x.confirmado_por_nome },
    iniciadoEm: new Date(x.iniciado_em).toISOString(),
    finalizadoEm: x.finalizado_em ? new Date(x.finalizado_em).toISOString() : null,
  }));
}
