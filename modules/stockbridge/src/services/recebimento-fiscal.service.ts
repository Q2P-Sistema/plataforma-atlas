import { getPool, createLogger } from '@atlas/core';
import {
  consultarRecebimentoNfe,
  alterarRecebimentoNfeItens,
  concluirRecebimentoNfe,
  type RecebimentoNfeConsultado,
  type ItemRecebimentoNfe,
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
 * Revisao pre-UAT (02/10/2026):
 *  - fornecedor nao cadastrado chega do OMIE como `nIdFornecedor: 0` (normalizado
 *    para null no parser) e/ou sem CNPJ — recusa ANTES de qualquer escrita;
 *  - so conclui a partir da etapa 40 e nunca recebimento bloqueado/devolvido;
 *  - o indice parcial solta o lock numa `falha`: uma nova tentativa da mesma NF
 *    espera ESPERA_APOS_FALHA_SEG depois de uma falha com escrita, para a 1a
 *    consulta nao cair no cache de ~1 min (leria o estado de antes do EDITAR);
 *  - passos ja feitos (lidos na consulta) sao pulados: EDITAR so em item nao
 *    ignorado e sem os ajustes; IGNORAR so em item nao ignorado;
 *  - o fechamento do ledger confere o dono do lock (`iniciado_em` como token):
 *    uma requisicao que perdeu o lock para a retomada nunca sobrescreve o desfecho.
 *
 * Nada aqui grava movimentacao/aprovacao: quem chama (recebimento-nacional)
 * so segue para a escrita fisica depois que esta funcao retorna (FR-008/FR-012).
 */

export type StatusFiscalLedger = 'em_andamento' | 'concluido' | 'ja_concluido' | 'falha';
export type PassoFiscal = 'consultar' | 'editar' | 'ignorar' | 'concluir' | 'reconsultar';

/**
 * Tempo apos o qual uma linha `em_andamento` e considerada orfa (processo morreu)
 * e pode ser retomada. Bem acima do pior caso de uma requisicao viva: a consulta
 * tem retry (ate ~2 min na trava de consumo redundante) e cada escrita tem timeout
 * de 30 s (revisao pre-UAT, FISC-3).
 */
export const LOCK_FISCAL_ORFAO_MIN = 15;

/** Espera minima entre uma falha COM escrita no OMIE e a proxima tentativa da mesma NF (cache de ~1 min). */
export const ESPERA_APOS_FALHA_SEG = 70;

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
        'Nada foi registrado no estoque — tente novamente em 1 minuto. Se persistir, avise o fiscal.',
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

export class RecebimentoFiscalAguardeError extends Error {
  constructor(public readonly notaFiscal: string, public readonly segundos: number) {
    super(
      `A tentativa anterior do recebimento fiscal da NF ${notaFiscal} falhou há instantes. ` +
        `Aguarde cerca de ${segundos} segundos e tente de novo — o OMIE leva até 1 minuto para mostrar a última alteração.`,
    );
    this.name = 'RecebimentoFiscalAguardeError';
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

export type MotivoEtapaInesperada = 'etapa' | 'bloqueado' | 'devolvido';

export class RecebimentoFiscalEtapaInesperadaError extends Error {
  constructor(public readonly notaFiscal: string, public readonly motivo: MotivoEtapaInesperada) {
    super(
      motivo === 'bloqueado'
        ? `O recebimento da NF ${notaFiscal} está bloqueado no OMIE. Peça ao fiscal para liberar ou concluir o recebimento no OMIE.`
        : motivo === 'devolvido'
          ? `A NF ${notaFiscal} consta como devolvida no OMIE e não pode ter o recebimento fiscal concluído pelo Atlas. Fale com o fiscal.`
          : `O recebimento da NF ${notaFiscal} não está na etapa "Faturado pelo fornecedor" no OMIE, a única em que o Atlas conclui o fiscal. Peça ao fiscal para concluir o recebimento no OMIE.`,
    );
    this.name = 'RecebimentoFiscalEtapaInesperadaError';
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
  /** itens do recebimento no OMIE (0 em ja_concluido sem escrita) */
  itensTotal: number;
}

// ── Ledger (raw SQL via getPool — espelha o padrao da fila; facil de mockar) ──

/** `token` = `iniciado_em` da posse atual do lock (texto devolvido pelo Postgres, precisao de microssegundo). */
type Ledger = { id: string; token: string };

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
 * Adquire o lock: INSERT `em_andamento`. Antes, a espera apos uma falha com
 * escrita (cache do OMIE). Se ja existe linha viva para a chave:
 *  - `concluido`/`ja_concluido` -> devolve `jaConcluido` (nenhuma chamada OMIE);
 *  - `em_andamento` recente     -> RecebimentoFiscalEmAndamentoError (duplo clique);
 *  - `em_andamento` orfa        -> retoma a linha (UPDATE atomico, novo token).
 */
async function adquirirLedger(
  input: ConcluirRecebimentoFiscalInput,
  tentativa = 0,
): Promise<{ ledger: Ledger; jaConcluido: { concluidoEm: string } | null }> {
  const pool = getPool();

  if (tentativa === 0) {
    const recente = await pool.query<{ segundos: number | string }>(
      `SELECT CEIL(EXTRACT(EPOCH FROM (finalizado_em + make_interval(secs => $2) - now())))::int AS segundos
         FROM stockbridge.recebimento_fiscal
        WHERE nf_chave_acesso = $1 AND status = 'falha'
          AND passo_falha IN ('editar', 'ignorar', 'concluir')
          AND finalizado_em > now() - make_interval(secs => $2)
        ORDER BY finalizado_em DESC
        LIMIT 1`,
      [input.nfChaveAcesso, ESPERA_APOS_FALHA_SEG],
    );
    const espera = recente.rows[0];
    if (espera) throw new RecebimentoFiscalAguardeError(input.notaFiscal, Math.max(1, Number(espera.segundos)));
  }

  try {
    const ins = await pool.query<{ id: string; token: string }>(
      `INSERT INTO stockbridge.recebimento_fiscal
         (nf_chave_acesso, n_id_receb, nota_fiscal, fornecedor_nome, status, confirmado_por)
       VALUES ($1, $2, $3, $4, 'em_andamento', $5)
       RETURNING id, iniciado_em::text AS token`,
      [input.nfChaveAcesso, input.nIdReceb, input.notaFiscal, input.fornecedorNome, input.userId],
    );
    return { ledger: { id: ins.rows[0]!.id, token: ins.rows[0]!.token }, jaConcluido: null };
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
    // A linha viva sumiu entre o INSERT e o SELECT (outra requisicao fechou em
    // 'falha'): tentar de novo uma vez so.
    if (tentativa >= 1) throw new RecebimentoFiscalEmAndamentoError(input.notaFiscal);
    return adquirirLedger(input, tentativa + 1);
  }
  if (linha.status === 'concluido' || linha.status === 'ja_concluido') {
    return {
      ledger: { id: linha.id, token: linha.iniciado_em },
      jaConcluido: { concluidoEm: linha.finalizado_em ? new Date(linha.finalizado_em).toISOString() : new Date().toISOString() },
    };
  }
  // em_andamento: orfa (processo morreu) -> retoma com novo token; recente -> alguem esta concluindo agora.
  const retomada = await pool.query<{ id: string; token: string }>(
    `UPDATE stockbridge.recebimento_fiscal
        SET confirmado_por = $2, iniciado_em = clock_timestamp(), updated_at = now(),
            n_id_receb = COALESCE($3, n_id_receb)
      WHERE id = $1 AND status = 'em_andamento'
        AND iniciado_em < now() - make_interval(mins => $4)
      RETURNING id, iniciado_em::text AS token`,
    [linha.id, input.userId, input.nIdReceb, LOCK_FISCAL_ORFAO_MIN],
  );
  if (retomada.rows.length === 0) throw new RecebimentoFiscalEmAndamentoError(input.notaFiscal);
  logger.warn({ ledgerId: linha.id, nf: input.notaFiscal, iniciadoEm: linha.iniciado_em }, 'Lock fiscal órfão retomado');
  return { ledger: { id: linha.id, token: retomada.rows[0]!.token }, jaConcluido: null };
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

/**
 * Fecha a linha SO se esta requisicao ainda e dona do lock (status em_andamento
 * e mesmo `iniciado_em`). Devolve o `finalizado_em` ou null se perdeu o lock —
 * nesse caso quem retomou e que grava o desfecho.
 */
async function fecharLedger(ledger: Ledger, a: FecharLedgerArgs): Promise<string | null> {
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
      WHERE id = $1 AND status = 'em_andamento' AND iniciado_em = $10::timestamptz
      RETURNING finalizado_em::text AS finalizado_em`,
    [
      ledger.id,
      a.status,
      a.nIdReceb ?? null,
      a.etapaAntes ?? null,
      a.recebidoAntes ?? null,
      a.itensTotal ?? null,
      a.passoFalha ?? null,
      a.erroOmieCodigo ?? null,
      a.erroOmieMensagem ? a.erroOmieMensagem.slice(0, 4000) : null,
      ledger.token,
    ],
  );
  const fim = r.rows[0]?.finalizado_em;
  if (!fim) {
    logger.warn({ ledgerId: ledger.id, desfecho: a.status }, 'Lock fiscal perdido para uma retomada — desfecho desta requisição não gravado no ledger');
    return null;
  }
  return new Date(fim).toISOString();
}

/** fecharLedger que nunca lanca: erro de banco aqui nao pode esconder o desfecho/erro do OMIE (FISC-6). */
async function fecharLedgerSeguro(ledger: Ledger, a: FecharLedgerArgs): Promise<string | null> {
  try {
    return await fecharLedger(ledger, a);
  } catch (err) {
    logger.error({ err, ledgerId: ledger.id, desfecho: a.status }, 'Não foi possível gravar o desfecho no ledger fiscal — a linha fica em_andamento até expirar');
    return null;
  }
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
// 0/nulo ou sem CNPJ). Este regex e a rede secundaria, a calibrar com a primeira
// ocorrencia real.
const RE_SEM_FORNECEDOR = /fornecedor[^.!]*(n[aã]o (cadastrad|informad|encontrad|identificad)|inv[aá]lid|inexist)/i;

const ajustesJaAplicados = (it: ItemRecebimentoNfe) => it.cNaoGerarMovEstoque === 'S' && it.cNaoGerarFinanceiro === 'N';
const ignorado = (it: ItemRecebimentoNfe) => it.cIgnorarItem === 'S';

/** EDITAR so em item ainda nao ignorado e sem os ajustes (EDITAR em item ja ignorado nunca foi testado no OMIE real). */
function itensParaEditar(rec: RecebimentoNfeConsultado) {
  return rec.itens
    .filter((it) => !ignorado(it) && !ajustesJaAplicados(it))
    .map((it) => ({
      nSequencia: it.nSequencia,
      cAcao: 'EDITAR' as const,
      itensAjustes: { cNaoGerarMovEstoque: 'S' as const, cNaoGerarFinanceiro: 'N' as const },
    }));
}

function itensParaIgnorar(rec: RecebimentoNfeConsultado) {
  return rec.itens.filter((it) => !ignorado(it)).map((it) => ({ nSequencia: it.nSequencia, cAcao: 'IGNORAR' as const }));
}

/** Recusas decididas so com a consulta — sempre ANTES de qualquer escrita no OMIE. */
function recusaAntesDeEscrever(rec: RecebimentoNfeConsultado, input: ConcluirRecebimentoFiscalInput): { erro: Error; motivo: string } | null {
  if (rec.cCancelada === 'S') return { erro: new RecebimentoFiscalNfCanceladaError(input.notaFiscal), motivo: 'NF cancelada no OMIE (cCancelada=S)' };
  if (!rec.nIdFornecedor || !rec.cCNPJ_CPF) {
    return { erro: new RecebimentoFiscalSemFornecedorError(input.notaFiscal), motivo: `Recebimento sem fornecedor cadastrado (nIdFornecedor=${rec.nIdFornecedor ?? 'nulo'}, CNPJ ${rec.cCNPJ_CPF ? 'presente' : 'ausente'})` };
  }
  if (rec.cDevolvido === 'S') return { erro: new RecebimentoFiscalEtapaInesperadaError(input.notaFiscal, 'devolvido'), motivo: 'Recebimento devolvido (cDevolvido=S)' };
  if (rec.cBloqueado === 'S') return { erro: new RecebimentoFiscalEtapaInesperadaError(input.notaFiscal, 'bloqueado'), motivo: 'Recebimento bloqueado (cBloqueado=S)' };
  if (rec.cEtapa !== '40') {
    return { erro: new RecebimentoFiscalEtapaInesperadaError(input.notaFiscal, 'etapa'), motivo: `Etapa ${rec.cEtapa || '(vazia)'} — a receita só foi validada a partir da etapa 40` };
  }
  if (rec.itens.length === 0) {
    return { erro: new RecebimentoFiscalError('consultar', input.notaFiscal, input.fornecedorNome), motivo: 'Recebimento sem itens na ConsultarRecebimento' };
  }
  return null;
}

function erroDeDominio(err: unknown): boolean {
  return (
    err instanceof RecebimentoFiscalSemFornecedorError ||
    err instanceof RecebimentoFiscalNfCanceladaError ||
    err instanceof RecebimentoFiscalEtapaInesperadaError ||
    err instanceof RecebimentoFiscalError
  );
}

/**
 * Conclui o recebimento fiscal de UMA NF (todos os itens, de uma vez — FR-010).
 *
 * Desfechos:
 *  - `concluido`     — as escritas necessarias passaram; ledger `concluido`.
 *  - `ja_concluido`  — o OMIE ja mostrava cRecebido='S' (alguem concluiu no portal,
 *                      ou um clique anterior deu timeout mas gravou); nada escrito.
 * Falhas lancam (ledger `falha` com passo + erro OMIE):
 *  - RecebimentoFiscalAguardeError        — falha com escrita ha menos de 70 s (cache).
 *  - RecebimentoFiscalEmAndamentoError    — outra confirmacao em curso (lock).
 *  - RecebimentoFiscalSemFornecedorError  — NF sem fornecedor cadastrado no OMIE.
 *  - RecebimentoFiscalNfCanceladaError    — NF cancelada no OMIE.
 *  - RecebimentoFiscalEtapaInesperadaError — fora da etapa 40, bloqueado ou devolvido.
 *  - RecebimentoFiscalError               — fault/timeout em EDITAR/IGNORAR/Concluir
 *                                           e a reconsulta nao mostrou concluido.
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
    // 1. Consulta por CHAVE (corpo A). A reconsulta apos falha usa nIdReceb (corpo B) — D2.
    rec = await consultarRecebimentoNfe(CNPJ_FISCAL, { cChaveNfe: input.nfChaveAcesso });
    nIdReceb = rec.nIdReceb;

    if (rec.cRecebido === 'S') {
      const concluidoEm = await fecharLedger(ledger, {
        status: 'ja_concluido',
        nIdReceb,
        etapaAntes: rec.cEtapa,
        recebidoAntes: rec.cRecebido,
        itensTotal: rec.itens.length,
      });
      logger.info({ ledgerId: ledger.id, nf: input.notaFiscal, nIdReceb }, 'Fiscal já estava concluído no OMIE — nada escrito');
      return { status: 'ja_concluido', concluidoEm: concluidoEm ?? new Date().toISOString(), ledgerId: ledger.id, itensTotal: 0 };
    }

    const recusa = recusaAntesDeEscrever(rec, input);
    if (recusa) {
      await fecharLedgerSeguro(ledger, {
        status: 'falha', nIdReceb, etapaAntes: rec.cEtapa, recebidoAntes: rec.cRecebido, itensTotal: rec.itens.length,
        passoFalha: 'consultar', erroOmieCodigo: null, erroOmieMensagem: recusa.motivo,
      });
      logger.warn({ ledgerId: ledger.id, nf: input.notaFiscal, nIdReceb, motivo: recusa.motivo }, 'Recebimento fiscal recusado antes de escrever no OMIE');
      throw recusa.erro;
    }

    // 2–4. Escritas, na ordem, so do que falta — SEM retry (STK-23).
    const editar = itensParaEditar(rec);
    const ignorar = itensParaIgnorar(rec);
    if (editar.length > 0) {
      passo = 'editar';
      await alterarRecebimentoNfeItens(CNPJ_FISCAL, { nIdReceb, itens: editar });
    }
    if (ignorar.length > 0) {
      passo = 'ignorar';
      await alterarRecebimentoNfeItens(CNPJ_FISCAL, { nIdReceb, itens: ignorar });
    }
    passo = 'concluir';
    await concluirRecebimentoNfe(CNPJ_FISCAL, { nIdReceb, cEtapa: '60' });

    const concluidoEm = await fecharLedgerSeguro(ledger, {
      status: 'concluido',
      nIdReceb,
      etapaAntes: rec.cEtapa,
      recebidoAntes: rec.cRecebido,
      itensTotal: rec.itens.length,
    });
    logger.info(
      { ledgerId: ledger.id, nf: input.notaFiscal, nIdReceb, itens: rec.itens.length, editados: editar.length, ignorados: ignorar.length },
      'Recebimento fiscal concluído no OMIE pelo Atlas',
    );
    return { status: 'concluido', concluidoEm: concluidoEm ?? new Date().toISOString(), ledgerId: ledger.id, itensTotal: rec.itens.length };
  } catch (err) {
    // Erros de dominio ja fecharam o ledger acima.
    if (erroDeDominio(err)) throw err;

    // O erro do OMIE vai para o log ANTES de qualquer escrita no ledger: se o
    // banco falhar agora, o faultstring nao se perde (FISC-6).
    const omie = extrairErroOmie(err);
    logger.error(
      { err, ledgerId: ledger.id, nf: input.notaFiscal, chave: input.nfChaveAcesso, passo, omieCodigo: omie.codigo },
      'Falha ao concluir recebimento fiscal no OMIE',
    );

    // Reconsulta com o OUTRO corpo (nIdReceb) para furar o cache de ~1 min (D2/D3):
    // um timeout em Concluir pode ter gravado; um fault em EDITAR pode ser "ja concluido".
    let reconsultaConcluido = false;
    let itensReconsulta = 0;
    if (passo !== 'consultar' && nIdReceb != null) {
      try {
        const re = await consultarRecebimentoNfe(CNPJ_FISCAL, { nIdReceb });
        reconsultaConcluido = re.cRecebido === 'S';
        itensReconsulta = re.itens.length;
      } catch (err2) {
        logger.warn({ err: (err2 as Error).message, nf: input.notaFiscal }, 'Reconsulta após falha do fiscal também falhou');
      }
    }

    if (reconsultaConcluido) {
      const concluidoEm = await fecharLedgerSeguro(ledger, {
        status: 'ja_concluido',
        nIdReceb,
        etapaAntes: rec?.cEtapa ?? null,
        recebidoAntes: rec?.cRecebido ?? null,
        itensTotal: itensReconsulta,
        erroOmieCodigo: omie.codigo,
        erroOmieMensagem: `[${passo}] ${omie.mensagem} — reconsulta mostrou cRecebido=S`,
      });
      logger.warn({ ledgerId: ledger.id, nf: input.notaFiscal, passo }, 'Fault no fiscal, mas a reconsulta mostra concluído — tratado como ja_concluido');
      return { status: 'ja_concluido', concluidoEm: concluidoEm ?? new Date().toISOString(), ledgerId: ledger.id, itensTotal: 0 };
    }

    await fecharLedgerSeguro(ledger, {
      status: 'falha',
      nIdReceb,
      etapaAntes: rec?.cEtapa ?? null,
      recebidoAntes: rec?.cRecebido ?? null,
      itensTotal: rec?.itens.length ?? null,
      passoFalha: passo,
      erroOmieCodigo: omie.codigo,
      erroOmieMensagem: omie.mensagem,
    });
    if (RE_SEM_FORNECEDOR.test(omie.mensagem)) throw new RecebimentoFiscalSemFornecedorError(input.notaFiscal);
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
