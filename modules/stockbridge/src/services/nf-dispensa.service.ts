import { getPool, createLogger } from '@atlas/core';
import { getDetalheNfNacional, recebimentoFiscalHabilitado, itemNfPendente, type DetalheNfNacional, type SituacaoFiscal } from './fila-nacional.service.js';
import { enviarAlertaNfDispensada, enviarAlertaDispensaRevertida } from './notificacao.service.js';
import { LOCK_FISCAL_ORFAO_MIN } from './recebimento-fiscal.service.js';
import type { Perfil } from '../types.js';

const logger = createLogger('stockbridge:nf-dispensa');

/**
 * Dispensa de NF da fila de recebimento nacional pelo GESTOR (feature 016,
 * ACXEGDP-395, Historia 4 — FR-021..FR-026; clarificacao de 02/10/2026).
 *
 * Uma NF que nunca sera recebida (carga que nao veio, nota emitida errada,
 * devolucao combinada) ficaria presa na fila para sempre — com o fiscal pendente
 * OU ja feito. O gestor a dispensa com motivo; ela some para todos e pode voltar
 * (reversao auditavel). A dispensa NUNCA chama o OMIE e NUNCA move estoque
 * (research D9): cancelar, recusar ou estornar a NF e decisao do fiscal, que e
 * avisado por e-mail (FR-026) com a pendencia que fica no OMIE — recebimento na
 * caixa de NF-e aguardando manifestacao, ou conta a pagar a estornar/manter.
 *
 * Tabela `stockbridge.nf_dispensa` (migration 0053): uma dispensa ATIVA por chave
 * (indice parcial `nf_dispensa_ativa_uq` WHERE revertido_em IS NULL); trigger de
 * auditoria em shared.audit_log (Principio IV). Reversao = UPDATE revertido_*,
 * nunca DELETE.
 */

export class RecebimentoFiscalDesabilitadoError extends Error {
  constructor() {
    super('O recebimento fiscal pelo Atlas está desligado neste ambiente — a dispensa de NF não está disponível.');
    this.name = 'RecebimentoFiscalDesabilitadoError';
  }
}

export class DispensaNaoPermitidaError extends Error {
  constructor() {
    super('Só gestor ou diretor pode dispensar uma NF da fila ou desfazer uma dispensa.');
    this.name = 'DispensaNaoPermitidaError';
  }
}

/** Motivo vazio — mensagem propria da dispensa/reversao (antes reusava a da baixa externa — ROT-8). */
export class MotivoDispensaObrigatorioError extends Error {
  constructor(public readonly acao: 'dispensar' | 'reverter') {
    super(acao === 'dispensar' ? 'Informe o motivo da dispensa: por que esta nota não será recebida.' : 'Informe o motivo para desfazer a dispensa.');
    this.name = 'MotivoDispensaObrigatorioError';
  }
}

/** O recebimento (com o fiscal) desta NF esta em curso agora — dispensar no meio daria aviso errado ao fiscal (ROT-3). */
export class NfEmRecebimentoFiscalError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`A NF ${notaFiscal} está sendo recebida neste momento. Aguarde alguns segundos e recarregue a nota antes de dispensá-la.`);
    this.name = 'NfEmRecebimentoFiscalError';
  }
}

export class NfNaoDispensavelError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`A NF ${notaFiscal} já foi recebida no Atlas — não há o que dispensar.`);
    this.name = 'NfNaoDispensavelError';
  }
}

export class NfJaDispensadaError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`A NF ${notaFiscal} já está dispensada da fila. Para recebê-la, desfaça a dispensa em Aprovações.`);
    this.name = 'NfJaDispensadaError';
  }
}

export class DispensaNaoEncontradaError extends Error {
  constructor(public readonly id: string) {
    super('Dispensa não encontrada ou já desfeita.');
    this.name = 'DispensaNaoEncontradaError';
  }
}

function exigirGestor(perfil: Perfil): void {
  if (perfil !== 'gestor' && perfil !== 'diretor') throw new DispensaNaoPermitidaError();
}

function exigirFlag(): void {
  if (!recebimentoFiscalHabilitado()) throw new RecebimentoFiscalDesabilitadoError();
}

function violacaoDispensaAtiva(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const o = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (o.code === '23505' && o.constraint === 'nf_dispensa_ativa_uq') return true;
    e = o.cause;
  }
  return false;
}

// ── Dispensar ───────────────────────────────────────────────────────────────

export interface DispensarNfInput {
  nfChaveAcesso: string;
  motivo: string;
  userId: string;
  perfilUsuario: Perfil;
}

export interface DispensarNfResult {
  id: string;
  notaFiscal: string;
  fornecedorNome: string;
  situacaoFiscalNaDispensa: SituacaoFiscal;
  dispensadoEm: string;
}

interface DispensaAtivaRow {
  id: string;
  nota_fiscal: string;
}

async function dispensaAtiva(chave: string): Promise<DispensaAtivaRow | null> {
  const r = await getPool().query<DispensaAtivaRow>(
    `SELECT id, nota_fiscal FROM stockbridge.nf_dispensa WHERE nf_chave_acesso = $1 AND revertido_em IS NULL LIMIT 1`,
    [chave],
  );
  return r.rows[0] ?? null;
}

/**
 * Dispensa a NF: exige gestor+, flag ligada, motivo e AO MENOS UM item pendente
 * (NF toda recebida nao tem o que dispensar — FR-024). Qualquer situacao fiscal
 * (pendente ou ja feito) e aceita e gravada em `situacao_fiscal_na_dispensa`.
 */
export async function dispensarNf(input: DispensarNfInput): Promise<DispensarNfResult> {
  exigirFlag();
  exigirGestor(input.perfilUsuario);
  const motivo = input.motivo?.trim() ?? '';
  if (motivo.length === 0) throw new MotivoDispensaObrigatorioError('dispensar');

  // Antes do detalhe: a NF ja dispensada nao aparece no detalhe (que lancaria
  // NfNacionalDispensadaError); aqui a resposta certa e 409.
  const ativa = await dispensaAtiva(input.nfChaveAcesso);
  if (ativa) throw new NfJaDispensadaError(ativa.nota_fiscal);

  // Recebimento com o fiscal em curso (ledger em_andamento RECENTE): espera terminar.
  // Linha orfa (processo morreu, mais velha que o limite do lock) nao bloqueia a
  // dispensa — senao a unica saida seria receber a NF, o contrario do que o gestor quer.
  const emCurso = await getPool().query<{ nota_fiscal: string }>(
    `SELECT nota_fiscal FROM stockbridge.recebimento_fiscal
      WHERE nf_chave_acesso = $1 AND status = 'em_andamento'
        AND iniciado_em > now() - make_interval(mins => $2)
      LIMIT 1`,
    [input.nfChaveAcesso, LOCK_FISCAL_ORFAO_MIN],
  );
  if (emCurso.rows[0]) throw new NfEmRecebimentoFiscalError(emCurso.rows[0].nota_fiscal);

  const detalhe: DetalheNfNacional = await getDetalheNfNacional(input.nfChaveAcesso);
  if (!detalhe.itens.some(itemNfPendente)) throw new NfNaoDispensavelError(detalhe.notaFiscal);

  const pool = getPool();
  let id: string;
  let dispensadoEm: string;
  try {
    const ins = await pool.query<{ id: string; dispensado_em: string }>(
      `INSERT INTO stockbridge.nf_dispensa
         (nf_chave_acesso, nota_fiscal, fornecedor_nome, fornecedor_cnpj, situacao_fiscal_na_dispensa, motivo, dispensado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, dispensado_em::text AS dispensado_em`,
      [
        detalhe.nfChaveAcesso,
        detalhe.notaFiscal,
        detalhe.fornecedorNome,
        detalhe.fornecedorCnpj || null,
        detalhe.fiscal,
        motivo,
        input.userId,
      ],
    );
    id = ins.rows[0]!.id;
    dispensadoEm = new Date(ins.rows[0]!.dispensado_em).toISOString();
  } catch (err) {
    // Corrida entre dois gestores: o indice parcial decide.
    if (violacaoDispensaAtiva(err)) throw new NfJaDispensadaError(detalhe.notaFiscal);
    throw err;
  }

  logger.info(
    { id, nf: detalhe.notaFiscal, chave: detalhe.nfChaveAcesso, situacaoFiscal: detalhe.fiscal, userId: input.userId },
    'NF dispensada da fila de recebimento nacional',
  );

  // FR-026: aviso ao fiscal — best-effort, nunca desfaz a dispensa.
  void (async () => {
    const nome = await nomeUsuario(input.userId);
    await enviarAlertaNfDispensada({
      notaFiscal: detalhe.notaFiscal,
      fornecedorNome: detalhe.fornecedorNome,
      situacaoFiscalNaDispensa: detalhe.fiscal,
      valorNfBrl: detalhe.valorNotaBrl,
      motivo,
      dispensadoPorNome: nome,
      dispensadoEm,
    });
  })().catch((err) => logger.error({ err, nf: detalhe.notaFiscal }, 'Falha ao avisar o fiscal da dispensa (a dispensa foi gravada)'));

  return { id, notaFiscal: detalhe.notaFiscal, fornecedorNome: detalhe.fornecedorNome, situacaoFiscalNaDispensa: detalhe.fiscal, dispensadoEm };
}

async function nomeUsuario(userId: string): Promise<string | null> {
  try {
    const r = await getPool().query<{ name: string | null }>(`SELECT name FROM atlas.users WHERE id = $1 LIMIT 1`, [userId]);
    return r.rows[0]?.name ?? null;
  } catch (err) {
    logger.warn({ err: (err as Error).message, userId }, 'Nome do gestor indisponível para o e-mail de dispensa');
    return null;
  }
}

// ── Listar ──────────────────────────────────────────────────────────────────

export interface DispensaItem {
  id: string;
  nfChaveAcesso: string;
  notaFiscal: string;
  fornecedorNome: string | null;
  fornecedorCnpj: string | null;
  situacaoFiscalNaDispensa: SituacaoFiscal;
  motivo: string;
  dispensadoPor: { id: string; nome: string | null };
  dispensadoEm: string;
  revertidoPor: { id: string; nome: string | null } | null;
  revertidoEm: string | null;
  motivoReversao: string | null;
}

export async function listarDispensas(params: { incluirRevertidas?: boolean; limit?: number } = {}): Promise<DispensaItem[]> {
  const limit = Math.min(500, Math.max(1, params.limit ?? 200));
  const r = await getPool().query<{
    id: string; nf_chave_acesso: string; nota_fiscal: string; fornecedor_nome: string | null; fornecedor_cnpj: string | null;
    situacao_fiscal_na_dispensa: SituacaoFiscal; motivo: string; dispensado_por: string; dispensado_por_nome: string | null; dispensado_em: string;
    revertido_por: string | null; revertido_por_nome: string | null; revertido_em: string | null; motivo_reversao: string | null;
  }>(
    `SELECT d.id, d.nf_chave_acesso, d.nota_fiscal, d.fornecedor_nome, d.fornecedor_cnpj, d.situacao_fiscal_na_dispensa, d.motivo,
            d.dispensado_por, u1.name AS dispensado_por_nome, d.dispensado_em::text AS dispensado_em,
            d.revertido_por, u2.name AS revertido_por_nome, d.revertido_em::text AS revertido_em, d.motivo_reversao
       FROM stockbridge.nf_dispensa d
       LEFT JOIN atlas.users u1 ON u1.id = d.dispensado_por
       LEFT JOIN atlas.users u2 ON u2.id = d.revertido_por
      ${params.incluirRevertidas ? '' : 'WHERE d.revertido_em IS NULL'}
      ORDER BY d.dispensado_em DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows.map((x) => ({
    id: x.id,
    nfChaveAcesso: x.nf_chave_acesso,
    notaFiscal: x.nota_fiscal,
    fornecedorNome: x.fornecedor_nome,
    fornecedorCnpj: x.fornecedor_cnpj,
    situacaoFiscalNaDispensa: x.situacao_fiscal_na_dispensa,
    motivo: x.motivo,
    dispensadoPor: { id: x.dispensado_por, nome: x.dispensado_por_nome },
    dispensadoEm: new Date(x.dispensado_em).toISOString(),
    revertidoPor: x.revertido_por ? { id: x.revertido_por, nome: x.revertido_por_nome } : null,
    revertidoEm: x.revertido_em ? new Date(x.revertido_em).toISOString() : null,
    motivoReversao: x.motivo_reversao,
  }));
}

// ── Reverter ────────────────────────────────────────────────────────────────

export interface ReverterDispensaInput {
  id: string;
  motivo: string;
  userId: string;
  perfilUsuario: Perfil;
}

/** Desfaz a dispensa (FR-025): a NF volta a fila na situacao fiscal em que estiver. Nunca DELETE. */
export async function reverterDispensa(input: ReverterDispensaInput): Promise<{ id: string; notaFiscal: string }> {
  exigirFlag();
  exigirGestor(input.perfilUsuario);
  const motivo = input.motivo?.trim() ?? '';
  if (motivo.length === 0) throw new MotivoDispensaObrigatorioError('reverter');

  const r = await getPool().query<{ id: string; nota_fiscal: string; fornecedor_nome: string | null; situacao_fiscal_na_dispensa: SituacaoFiscal; revertido_em: string }>(
    `UPDATE stockbridge.nf_dispensa
        SET revertido_por = $2, revertido_em = now(), motivo_reversao = $3
      WHERE id = $1 AND revertido_em IS NULL
      RETURNING id, nota_fiscal, fornecedor_nome, situacao_fiscal_na_dispensa, revertido_em::text AS revertido_em`,
    [input.id, input.userId, motivo],
  );
  const row = r.rows[0];
  if (!row) throw new DispensaNaoEncontradaError(input.id);
  logger.info({ id: row.id, nf: row.nota_fiscal, userId: input.userId }, 'Dispensa de NF revertida — a NF volta à fila');

  // O fiscal foi avisado da dispensa e pode ter agido no OMIE — avisar que voltou (ROT-4). Best-effort.
  void (async () => {
    const nome = await nomeUsuario(input.userId);
    await enviarAlertaDispensaRevertida({
      notaFiscal: row.nota_fiscal,
      fornecedorNome: row.fornecedor_nome,
      situacaoFiscalNaDispensa: row.situacao_fiscal_na_dispensa,
      motivoReversao: motivo,
      revertidoPorNome: nome,
      revertidoEm: new Date(row.revertido_em).toISOString(),
    });
  })().catch((err) => logger.error({ err, nf: row.nota_fiscal }, 'Falha ao avisar o fiscal da reversão da dispensa (a reversão foi gravada)'));

  return { id: row.id, notaFiscal: row.nota_fiscal };
}
