import { randomUUID } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { getDb, createLogger } from '@atlas/core';
import { lote, movimentacao, aprovacao, localidade, localidadeCorrelacao } from '@atlas/db';
import {
  consultarNF,
  isMockMode,
  type ConsultarNFResponse,
} from '@atlas/integration-omie';
import { getCorrelacao, CorrelacaoNaoEncontradaError } from './correlacao.service.js';
import { converterParaKg, normalizarNumeroNf } from './motor.service.js';
import {
  enviarAlertaProdutoSemCorrelato,
  enviarAlertaAprovacaoPendente,
  enviarAlertaPendenciaOmie,
} from './notificacao.service.js';
import { incluirAjusteIdempotente } from './omie-idempotente.js';
import { COD_INT_AJUSTE_SUFIXO, buildCodIntAjuste } from '../types.js';
import type { SubtipoMovimento, UnidadeMedida } from '../types.js';

const logger = createLogger('stockbridge:recebimento');

export class NotaFiscalJaProcessadaError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`NF ${notaFiscal} ja foi processada — idempotencia impede reprocessamento.`);
    this.name = 'NotaFiscalJaProcessadaError';
  }
}

export interface OmieAjusteErrorContext {
  /** IDs OMIE do ajuste ACXE quando ACXE sucedeu mas Q2P falhou. */
  idACXE?: { idMovest: string; idAjuste: string };
  /** UUID da operacao (movimentacao.opId) — derivado em cod_int_ajuste. */
  opId?: string;
  /** ID da movimentacao parcial gravada (apenas em pendente_q2p / pendente_acxe_faltando). */
  movimentacaoId?: string;
  /** True quando o estado e recuperavel via retry (Q2P falhou apos ACXE ok). */
  recoverable?: boolean;
  /**
   * Quantas retentativas o ATOR atual ainda pode fazer (operador maximo 1 alem da
   * inicial; admin sem limite). Calculado pelo caller que conhece o role.
   */
  tentativasRestantes?: number;
}

export class OmieAjusteError extends Error {
  public readonly idACXE?: { idMovest: string; idAjuste: string };
  public readonly opId?: string;
  public readonly movimentacaoId?: string;
  public readonly recoverable?: boolean;
  public readonly tentativasRestantes?: number;

  constructor(
    public readonly lado: 'acxe' | 'q2p',
    public readonly originalError: unknown,
    context?: OmieAjusteErrorContext,
  ) {
    super(`Falha ao incluir ajuste de estoque no OMIE ${lado.toUpperCase()}: ${(originalError as Error).message ?? 'erro desconhecido'}`);
    this.name = 'OmieAjusteError';
    this.idACXE = context?.idACXE;
    this.opId = context?.opId;
    this.movimentacaoId = context?.movimentacaoId;
    this.recoverable = context?.recoverable;
    this.tentativasRestantes = context?.tentativasRestantes;
  }
}

export interface FilaItemOmie {
  nf: string;
  tipo: SubtipoMovimento;
  cnpj: 'acxe' | 'q2p';
  produto: { codigo: number; nome: string };
  qtdOriginal: number;
  unidade: UnidadeMedida;
  qtdKg: number;
  localidadeCodigo: string;
  dtEmissao: string;
  custoBrl: number;
}

/**
 * Consulta a fila de NFs pendentes para recebimento.
 * No MVP, suporta dois modos:
 *  - Busca por NF especifica (parametro `nf`): consulta OMIE diretamente (padrao legado)
 *  - Lista completa (sem `nf`): retorna dados sinteticos em mock; em producao vai
 *    depender de sync de NFe pelo n8n (a ser wireado em fase futura).
 */
export async function getFilaOmie(params: {
  nf?: string;
  cnpj?: 'acxe' | 'q2p';
  armazemId?: string | null;
}): Promise<FilaItemOmie[]> {
  const db = getDb();

  // Caso 1: busca direta por NF + CNPJ (fluxo principal, herdado do legado)
  if (params.nf && params.cnpj) {
    const numero = Number(params.nf);
    if (!Number.isFinite(numero) || numero <= 0) {
      return [];
    }
    const nfNormalizada = normalizarNumeroNf(params.nf);

    // Idempotencia: ja processada?
    // OMIE retorna nNF zero-padded (ex: "00000300") e e nesse formato que gravamos.
    // Operador tipicamente digita "300" — normalizamos antes de comparar.
    const ja = await db
      .select({ id: movimentacao.id })
      .from(movimentacao)
      .where(
        and(
          eq(movimentacao.notaFiscal, nfNormalizada),
          eq(movimentacao.tipoMovimento, 'entrada_nf'),
          eq(movimentacao.ativo, true),
        ),
      )
      .limit(1);
    if (ja.length > 0) {
      return [];
    }

    const omieData = await consultarNF(params.cnpj, numero);
    const unidadeNormalizada = normalizarUnidade(omieData.uCom);
    const qtdKg = Number(new Decimal(converterParaKg(omieData.qCom, unidadeNormalizada)).toFixed(3));
    const tipo = inferirSubtipoEntrada(omieData);

    return [
      {
        nf: String(omieData.nNF),
        tipo,
        cnpj: params.cnpj,
        produto: { codigo: omieData.nCodProd, nome: omieData.xProd },
        qtdOriginal: omieData.qCom,
        unidade: unidadeNormalizada,
        qtdKg,
        localidadeCodigo: omieData.codigoLocalEstoque,
        dtEmissao: omieData.dEmi,
        custoBrl: omieData.vUnCom,
      },
    ];
  }

  // Caso 2: lista — mock retorna amostra em dev; prod retorna vazio com TODO
  if (isMockMode()) {
    const mocks: Array<Omit<FilaItemOmie, 'qtdKg'>> = [
      {
        nf: 'IMP-2026-0301',
        tipo: 'importacao',
        cnpj: 'acxe',
        produto: { codigo: 90_000_301, nome: 'PP RAFIA (mock)' },
        qtdOriginal: 980,
        unidade: 'saco',
        localidadeCodigo: '4498926337',
        dtEmissao: '10/03/2026',
        custoBrl: 1175,
      },
      {
        nf: 'IMP-2026-0302',
        tipo: 'importacao',
        cnpj: 'q2p',
        produto: { codigo: 90_000_302, nome: 'PS (mock)' },
        qtdOriginal: 18_000,
        unidade: 'kg',
        localidadeCodigo: '8115873874',
        dtEmissao: '12/03/2026',
        custoBrl: 1490,
      },
    ];
    return mocks.map((m) => ({ ...m, qtdKg: converterParaKg(m.qtdOriginal, m.unidade) }));
  }

  // TODO(phase-3.5): em producao, listar NFs pendentes lendo do sync OMIE do n8n
  logger.info({ armazemId: params.armazemId }, 'Fila OMIE em modo real: aguardando wireup de sync n8n');
  return [];
}

export interface ProcessarRecebimentoInput {
  nf: string;
  cnpj: 'acxe' | 'q2p';
  quantidadeInput: number;
  unidadeInput: UnidadeMedida;
  localidadeId: string;
  observacoes?: string;
  /** Operador escolhe (Faltando|Varredura) quando ha divergencia. Obrigatorio se houver delta. */
  tipoDivergencia?: 'faltando' | 'varredura';
  userId: string;
}

export interface ProcessarRecebimentoResult {
  loteId: string;
  loteCodigo: string;
  status: 'provisorio' | 'aguardando_aprovacao';
  movimentacaoId?: string;
  aprovacaoId?: string;
  deltaKg?: number;
  tipoDivergencia?: 'faltando' | 'varredura';
  omie?: {
    acxe: { idMovest: string; idAjuste: string };
    q2p: { idMovest: string; idAjuste: string };
  };
}

/**
 * Processa um recebimento de NF com conferencia fisica.
 * Fluxo transacional:
 *   1. Valida idempotencia (NF ja processada?)
 *   2. Consulta NF no OMIE do CNPJ emissor
 *   3. Resolve correlacao ACXE↔Q2P (lanca erro + notifica admin se nao existe)
 *   4. Calcula divergencia: confere → provisorio; nao confere → aguardando_aprovacao
 *   5. Se confere: chama OMIE ACXE + OMIE Q2P (ambos sucesso → commit)
 *   6. Persiste lote + movimentacao com ambos os lados OU aprovacao pendente
 */
export async function processarRecebimento(
  input: ProcessarRecebimentoInput,
): Promise<ProcessarRecebimentoResult> {
  const db = getDb();
  // Normaliza para o formato OMIE (zero-padded 8 digitos para NFs numericas).
  // Sem isso, operador digitando "300" enquanto OMIE retorna "00000300" passa
  // pela checagem de idempotencia mesmo com o registro ja gravado no DB.
  // Reescreve input.nf para que toda a logica downstream (insert, OMIE,
  // notificacao) use a forma canonica.
  input = { ...input, nf: normalizarNumeroNf(input.nf) };

  // 1. Idempotencia
  const ja = await db
    .select({ id: movimentacao.id })
    .from(movimentacao)
    .where(
      and(
        eq(movimentacao.notaFiscal, input.nf),
        eq(movimentacao.tipoMovimento, 'entrada_nf'),
        eq(movimentacao.ativo, true),
      ),
    )
    .limit(1);
  if (ja.length > 0) {
    throw new NotaFiscalJaProcessadaError(input.nf);
  }

  // 2. Consulta NF no OMIE (lado do CNPJ emissor)
  const omieData = await consultarNF(input.cnpj, Number(input.nf) || 0);
  const qtdNfKg = Number(new Decimal(converterParaKg(omieData.qCom, normalizarUnidade(omieData.uCom))).toFixed(3));
  const qtdFisicaKg = Number(new Decimal(converterParaKg(input.quantidadeInput, input.unidadeInput)).toFixed(3));
  const deltaKg = Number(new Decimal(qtdFisicaKg).minus(qtdNfKg).toFixed(3));
  // Tolerancia de 1 kg (antes era 0.01 t = 10 kg — aperto agora que a unidade e maior).
  const temDivergencia = Math.abs(deltaKg) > 1;

  // 3. Localidade destino (da requisicao)
  const [loc] = await db
    .select()
    .from(localidade)
    .where(and(eq(localidade.id, input.localidadeId), eq(localidade.ativo, true)))
    .limit(1);
  if (!loc) {
    throw new Error(`Localidade ${input.localidadeId} nao encontrada ou inativa`);
  }

  const [corr] = await db
    .select()
    .from(localidadeCorrelacao)
    .where(eq(localidadeCorrelacao.localidadeId, input.localidadeId))
    .limit(1);
  if (!corr || !corr.codigoLocalEstoqueAcxe || !corr.codigoLocalEstoqueQ2p) {
    throw new Error(
      `Localidade ${loc.codigo} nao tem correlacao ACXE↔Q2P completa. Configure em stockbridge.localidade_correlacao.`,
    );
  }

  // 4. Correlacao de produto ACXE↔Q2P (match textual de descricao)
  let correlacao;
  try {
    correlacao = await getCorrelacao(omieData.nCodProd, corr.codigoLocalEstoqueAcxe);
  } catch (err) {
    if (err instanceof CorrelacaoNaoEncontradaError) {
      await enviarAlertaProdutoSemCorrelato({
        codigoProdutoAcxe: err.codigoProdutoAcxe,
        notaFiscal: input.nf,
        descricaoProduto: omieData.xProd,
      });
    }
    throw err;
  }

  // 5. Se tem divergencia: fluxo de aprovacao (nao toca OMIE ainda)
  if (temDivergencia) {
    if (!input.observacoes || input.observacoes.trim().length === 0) {
      throw new Error('Motivo da divergencia e obrigatorio');
    }
    if (!input.tipoDivergencia) {
      throw new Error('Tipo de divergencia (faltando/varredura) e obrigatorio quando ha delta');
    }
    // Fiel ao legado (NotaFiscalController.php:307): so aceita "recebido < NF".
    // Excedente nao e tratado — operador deveria registrar a entrada normal e
    // depois lancar uma entrada manual da diferenca.
    if (deltaKg > 0) {
      throw new Error('Quantidade recebida nao pode ser maior que a quantidade da NF');
    }
    return processarRecebimentoComDivergencia({
      input,
      omieData,
      qtdNfKg,
      qtdFisicaKg,
      deltaKg,
      tipoDivergencia: input.tipoDivergencia,
      localidadeCodigoQ2p: corr.codigoLocalEstoqueQ2p,
      correlacao,
    });
  }

  // 6. Sem divergencia: chama OMIE dos dois lados antes de persistir
  // Fiel ao legado: ACXE = transferencia (origem trânsito da NF → destino escolhido),
  // Q2P = entrada inicial. Valor unitario diferente em cada lado.
  // opId identifica esta operacao em ambos os lados via cod_int_ajuste — habilita
  // retry idempotente em caso de falha na 2a chamada (vide US2).
  const opId = randomUUID();
  let idACXE: { idMovest: string; idAjuste: string };
  let idQ2P: { idMovest: string; idAjuste: string } | null = null;
  let pendenciaQ2P: { erro: OmieAjusteError } | null = null;
  try {
    const dualRes = await executarAjusteOmieDual({
      opId,
      codigoLocalEstoqueAcxeOrigem: omieData.codigoLocalEstoque,
      codigoLocalEstoqueAcxeDestino: corr.codigoLocalEstoqueAcxe,
      codigoLocalEstoqueQ2p: corr.codigoLocalEstoqueQ2p,
      codigoProdutoAcxe: correlacao.codigoProdutoAcxe,
      codigoProdutoQ2p: correlacao.codigoProdutoQ2p,
      quantidadeKg: qtdFisicaKg,
      valorUnitarioAcxe: calcularValorUnitarioAcxe(omieData.vNF, qtdNfKg),
      valorUnitarioQ2p: calcularValorUnitarioQ2p(omieData.vNF, qtdNfKg),
      notaFiscal: input.nf,
      observacaoSufixo: 'sem divergencias',
    });
    idACXE = dualRes.idACXE;
    idQ2P = dualRes.idQ2P;
  } catch (err) {
    // ACXE falha: nada foi escrito em lugar nenhum, propaga e operador retenta limpo.
    if (err instanceof OmieAjusteError && err.lado === 'acxe') {
      throw err;
    }
    // Q2P falha apos ACXE ok: temos idACXE no erro, persistiremos movimentacao parcial.
    if (err instanceof OmieAjusteError && err.lado === 'q2p' && err.idACXE) {
      idACXE = err.idACXE;
      pendenciaQ2P = { erro: err };
    } else {
      throw err;
    }
  }

  // Persistir lote + movimentacao em uma transacao (pode ser completa ou parcial)
  const resultado = await db.transaction(async (tx) => {
    const codigo = await proximoCodigoLote(tx, 'L');
    const [loteCriado] = await tx
      .insert(lote)
      .values({
        codigo,
        produtoCodigoAcxe: correlacao.codigoProdutoAcxe,
        produtoCodigoQ2p: correlacao.codigoProdutoQ2p,
        fornecedorNome: omieData.cRazao,
        quantidadeFisicaKg: String(qtdFisicaKg),
        quantidadeFiscalKg: String(qtdNfKg),
        custoBrlKg: omieData.vUnCom > 0 ? String(omieData.vUnCom) : null,
        valorTotalNfBrl: omieData.vNF > 0 ? String(omieData.vNF) : null,
        codigoLocalEstoqueOrigemAcxe: omieData.codigoLocalEstoque,
        status: 'provisorio',
        estagioTransito: null,
        localidadeId: input.localidadeId,
        cnpj: input.cnpj === 'acxe' ? 'Acxe Matriz' : 'Q2P Matriz',
        notaFiscal: input.nf,
        manual: false,
        dtEntrada: new Date().toISOString().slice(0, 10),
      })
      .returning();

    const [movCriada] = await tx
      .insert(movimentacao)
      .values({
        notaFiscal: input.nf,
        tipoMovimento: 'entrada_nf',
        subtipo: inferirSubtipoEntrada(omieData),
        loteId: loteCriado!.id,
        quantidadeKg: String(qtdFisicaKg),
        mvAcxe: 1,
        dtAcxe: new Date(),
        idMovestAcxe: idACXE.idMovest,
        idAjusteAcxe: idACXE.idAjuste,
        idUserAcxe: input.userId,
        mvQ2p: pendenciaQ2P ? null : 1,
        dtQ2p: pendenciaQ2P ? null : new Date(),
        idMovestQ2p: idQ2P?.idMovest ?? null,
        idAjusteQ2p: idQ2P?.idAjuste ?? null,
        idUserQ2p: pendenciaQ2P ? null : input.userId,
        observacoes: input.observacoes ?? null,
        opId,
        statusOmie: pendenciaQ2P ? 'pendente_q2p' : 'concluida',
        tentativasQ2p: pendenciaQ2P ? 1 : 0,
        ultimoErroOmie: pendenciaQ2P
          ? {
              lado: 'q2p',
              mensagem: (pendenciaQ2P.erro.originalError as Error)?.message ?? 'erro desconhecido',
              timestamp: new Date().toISOString(),
            }
          : null,
      })
      .returning();

    return { loteId: loteCriado!.id, loteCodigo: loteCriado!.codigo, movimentacaoId: movCriada!.id };
  });

  // Se pendente, lanca erro enriquecido para a rota retornar 502 estruturado.
  // O operador tem 1 retentativa via endpoint /operacoes-pendentes/:id/retentar.
  if (pendenciaQ2P) {
    // Notifica admin/gestor fora do caminho critico (fire-and-forget)
    void enviarAlertaPendenciaOmie({
      movimentacaoId: resultado.movimentacaoId,
      opId,
      notaFiscal: input.nf,
      ladoPendente: 'q2p',
      mensagemErro: (pendenciaQ2P.erro.originalError as Error)?.message ?? 'erro desconhecido',
      tentativas: 1,
    });
    throw new OmieAjusteError('q2p', pendenciaQ2P.erro.originalError, {
      idACXE,
      opId,
      movimentacaoId: resultado.movimentacaoId,
      recoverable: true,
      tentativasRestantes: 1,
    });
  }

  return {
    loteId: resultado.loteId,
    loteCodigo: resultado.loteCodigo,
    status: 'provisorio',
    movimentacaoId: resultado.movimentacaoId,
    omie: { acxe: idACXE, q2p: idQ2P! },
  };
}

async function processarRecebimentoComDivergencia(args: {
  input: ProcessarRecebimentoInput;
  omieData: ConsultarNFResponse;
  qtdNfKg: number;
  qtdFisicaKg: number;
  deltaKg: number;
  tipoDivergencia: 'faltando' | 'varredura';
  localidadeCodigoQ2p: number;
  correlacao: Awaited<ReturnType<typeof getCorrelacao>>;
}): Promise<ProcessarRecebimentoResult> {
  const db = getDb();
  const { input, omieData, qtdNfKg, qtdFisicaKg, deltaKg, tipoDivergencia, correlacao } = args;

  const resultado = await db.transaction(async (tx) => {
    const codigo = await proximoCodigoLote(tx, 'L');
    const [loteCriado] = await tx
      .insert(lote)
      .values({
        codigo,
        produtoCodigoAcxe: correlacao.codigoProdutoAcxe,
        produtoCodigoQ2p: correlacao.codigoProdutoQ2p,
        fornecedorNome: omieData.cRazao,
        quantidadeFisicaKg: String(qtdFisicaKg),
        quantidadeFiscalKg: String(qtdNfKg),
        custoBrlKg: omieData.vUnCom > 0 ? String(omieData.vUnCom) : null,
        valorTotalNfBrl: omieData.vNF > 0 ? String(omieData.vNF) : null,
        codigoLocalEstoqueOrigemAcxe: omieData.codigoLocalEstoque,
        status: 'aguardando_aprovacao',
        localidadeId: input.localidadeId,
        cnpj: input.cnpj === 'acxe' ? 'Acxe Matriz' : 'Q2P Matriz',
        notaFiscal: input.nf,
        manual: false,
        dtEntrada: new Date().toISOString().slice(0, 10),
      })
      .returning();

    const [aprovCriada] = await tx
      .insert(aprovacao)
      .values({
        loteId: loteCriado!.id,
        precisaNivel: 'gestor',
        tipoAprovacao: 'recebimento_divergencia',
        quantidadePrevistaKg: String(qtdNfKg),
        quantidadeRecebidaKg: String(qtdFisicaKg),
        tipoDivergencia,
        observacoes: input.observacoes ?? null,
        lancadoPor: input.userId,
      })
      .returning();

    return { loteId: loteCriado!.id, loteCodigo: loteCriado!.codigo, aprovacaoId: aprovCriada!.id };
  });

  // T062: notificar gestor sobre nova pendencia (fora da transacao — email nao bloqueia)
  await enviarAlertaAprovacaoPendente({
    aprovacaoId: resultado.aprovacaoId,
    tipoAprovacao: 'recebimento_divergencia',
    nivel: 'gestor',
    loteCodigo: resultado.loteCodigo,
    produto: correlacao.descricao,
    quantidadeKg: qtdFisicaKg,
    detalhes: `Divergencia ${tipoDivergencia} de ${Math.abs(deltaKg).toFixed(3)} kg — ${input.observacoes ?? ''}`,
  });

  return {
    loteId: resultado.loteId,
    loteCodigo: resultado.loteCodigo,
    status: 'aguardando_aprovacao',
    aprovacaoId: resultado.aprovacaoId,
    deltaKg,
    tipoDivergencia,
  };
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Executa o par de ajustes OMIE (ACXE transferencia + Q2P entrada) usado tanto em
 * recebimento sem divergencia quanto em aprovacao de divergencia. Se ACXE sucesso
 * mas Q2P falhar, dispara ALERTA no log (ajuste ACXE ficou "no ar" no ERP — requer
 * intervencao manual). Nao toca no BD — o caller decide como persistir.
 *
 * Fiel ao legado PHP (NotaFiscalService::transfereEstoqueSemDivergenciaService +
 * Q2PRecebimentoIncluirAjusteEstoqueSemDivergenciaService):
 *  - ACXE: transferencia (TRF/TRF) do estoque em transito (origem) para o destino
 *    escolhido pelo usuario, com valor unitario = vUnCom da NF.
 *  - Q2P: entrada inicial (ENT/INI) no local correlato, com valor unitario "total"
 *    = ceil((vNF / qtdNfKg) * 1.145 * 100) / 100 (markup interno de 14.5%).
 */
export async function executarAjusteOmieDual(args: {
  opId: string;
  codigoLocalEstoqueAcxeOrigem: string;
  codigoLocalEstoqueAcxeDestino: number;
  codigoLocalEstoqueQ2p: number;
  codigoProdutoAcxe: number;
  codigoProdutoQ2p: number;
  quantidadeKg: number;
  valorUnitarioAcxe: number;
  valorUnitarioQ2p: number;
  notaFiscal: string;
  observacaoSufixo: string;
  /** Em retry de operacao pendente, true para evitar duplicacao via ListarAjusteEstoque. */
  verificarAntes?: boolean;
}): Promise<{ idACXE: { idMovest: string; idAjuste: string }; idQ2P: { idMovest: string; idAjuste: string } }> {
  const verificarAntes = args.verificarAntes ?? false;
  let idACXE: { idMovest: string; idAjuste: string };
  try {
    const acxeRes = await incluirAjusteIdempotente(
      'acxe',
      buildCodIntAjuste(args.opId, COD_INT_AJUSTE_SUFIXO.acxeTrf),
      {
        codigoLocalEstoque: args.codigoLocalEstoqueAcxeOrigem,
        codigoLocalEstoqueDestino: String(args.codigoLocalEstoqueAcxeDestino),
        idProduto: args.codigoProdutoAcxe,
        dataAtual: formatarDataBR(new Date()),
        quantidade: args.quantidadeKg,
        observacao: `Recebimento NF ${args.notaFiscal} ${args.observacaoSufixo}`,
        origem: 'AJU',
        tipo: 'TRF',
        motivo: 'TRF',
        valor: args.valorUnitarioAcxe,
      },
      { verificarAntes },
    );
    idACXE = { idMovest: acxeRes.idMovest, idAjuste: acxeRes.idAjuste };
  } catch (err) {
    throw new OmieAjusteError('acxe', err);
  }

  try {
    const q2pRes = await incluirAjusteIdempotente(
      'q2p',
      buildCodIntAjuste(args.opId, COD_INT_AJUSTE_SUFIXO.q2pEnt),
      {
        codigoLocalEstoque: String(args.codigoLocalEstoqueQ2p),
        idProduto: args.codigoProdutoQ2p,
        dataAtual: formatarDataBR(new Date()),
        quantidade: args.quantidadeKg,
        observacao: `Recebimento NF ${args.notaFiscal} ${args.observacaoSufixo}`,
        origem: 'AJU',
        tipo: 'ENT',
        motivo: 'INI',
        valor: args.valorUnitarioQ2p,
      },
      { verificarAntes },
    );
    return { idACXE, idQ2P: { idMovest: q2pRes.idMovest, idAjuste: q2pRes.idAjuste } };
  } catch (err) {
    logger.error(
      { nf: args.notaFiscal, opId: args.opId, idACXE, err },
      'ALERTA: ajuste ACXE sucesso mas Q2P falhou. Persistira movimentacao parcial.',
    );
    throw new OmieAjusteError('q2p', err, {
      idACXE,
      opId: args.opId,
      recoverable: true,
    });
  }
}

/**
 * Transfere a quantidade DIVERGENTE (qtd_NF - qtd_recebida) do estoque de origem
 * (Extrema, normalmente) para um estoque especial ACXE de retencao — Faltando
 * (material sumiu) ou Varredura (material para inspecao).
 *
 * Fiel ao legado (NotaFiscalService linhas 198-272 e 383-460): segunda chamada ACXE
 * apos a transferencia principal para o galpao destino. Usa o mesmo valor unitario
 * com tributos embutidos (vNF/qtdNfKg). OMIE em TRF/TRF descarta o valor e usa
 * custo medio do origem — campo e informativo no log.
 */
export async function transferirDiferencaAcxe(args: {
  opId: string;
  codigoLocalEstoqueOrigem: string;
  codigoLocalEstoqueDiferenca: string; // resolvido por resolverEstoqueDiferencaAcxe()
  codigoProdutoAcxe: number;
  quantidadeKg: number; // diferenca positiva (qtd faltante)
  valorUnitarioAcxe: number;
  notaFiscal: string;
  observacaoSufixo: string;
  verificarAntes?: boolean;
}): Promise<{ idMovest: string; idAjuste: string }> {
  try {
    const res = await incluirAjusteIdempotente(
      'acxe',
      buildCodIntAjuste(args.opId, COD_INT_AJUSTE_SUFIXO.acxeFaltando),
      {
        codigoLocalEstoque: args.codigoLocalEstoqueOrigem,
        codigoLocalEstoqueDestino: args.codigoLocalEstoqueDiferenca,
        idProduto: args.codigoProdutoAcxe,
        dataAtual: formatarDataBR(new Date()),
        quantidade: args.quantidadeKg,
        observacao: `Recebimento NF ${args.notaFiscal} ${args.observacaoSufixo}`,
        origem: 'AJU',
        tipo: 'TRF',
        motivo: 'TRF',
        valor: args.valorUnitarioAcxe,
      },
      { verificarAntes: args.verificarAntes ?? false },
    );
    return { idMovest: res.idMovest, idAjuste: res.idAjuste };
  } catch (err) {
    throw new OmieAjusteError('acxe', err);
  }
}

/**
 * Calcula o valor unitario "total" usado nos ajustes Q2P (legado:
 * `$vUnCom_Total = ceil(($vNF / $qtd_recebida_api * 1.145) * 100) / 100`).
 * Equivale ao unitario BRL/kg da NF acrescido de markup interno de 14,5%
 * (impostos/serviços) arredondado para cima a 2 casas.
 */
export function calcularValorUnitarioQ2p(vNF: number, qtdNfKg: number): number {
  if (!Number.isFinite(vNF) || !Number.isFinite(qtdNfKg) || qtdNfKg <= 0) return 0;
  return Math.ceil((vNF / qtdNfKg) * 1.145 * 100) / 100;
}

/**
 * Calcula o valor unitario com tributos embutidos (vNF/qCom) usado no ajuste ACXE.
 * Correção sobre o legado: legado enviava `vUnCom` (valor base, sem tributos).
 * Agora enviamos `vNF/qtdNfKg` arredondado a 2 casas — auditoria mais fiel,
 * mesmo que OMIE em TRF/TRF acabe usando custo médio do estoque de origem.
 */
export function calcularValorUnitarioAcxe(vNF: number, qtdNfKg: number): number {
  if (!Number.isFinite(vNF) || !Number.isFinite(qtdNfKg) || qtdNfKg <= 0) return 0;
  return Math.round((vNF / qtdNfKg) * 100) / 100;
}

function formatarDataBR(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export function normalizarUnidade(raw: string): UnidadeMedida {
  const u = raw.trim().toLowerCase();
  if (u === 't' || u === 'ton' || u === 'tonelada') return 't';
  if (u === 'kg' || u === 'quilo') return 'kg';
  if (u.includes('saco')) return 'saco';
  if (u.includes('big')) return 'bigbag';
  // Default para kg (mais seguro para granel importado)
  return 'kg';
}

function inferirSubtipoEntrada(omie: ConsultarNFResponse): SubtipoMovimento {
  // OMIE nao retorna tipo de NF estruturado — heuristica pelo numero/origem.
  // No MVP, qualquer NF que caia na fila e tratada como importacao; refinar quando
  // a fila real for wireada e trouxer o tipo explicito.
  if (/^IMP[-/]/.test(String(omie.nNF))) return 'importacao';
  if (/^DEV[-/]/.test(String(omie.nNF))) return 'devolucao_cliente';
  if (/^CN[-/]/.test(String(omie.nNF))) return 'compra_nacional';
  return 'importacao';
}

async function proximoCodigoLote(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  prefixo: 'L' | 'T',
): Promise<string> {
  // Usa sequence Postgres dedicada (migration 0015). nextval() e atomico, sem race,
  // sem depender de MAX+1 — o anterior tinha bug (row.max retornando 0 mesmo com L001
  // existente) e ainda era vulneravel a colisao em concorrencia.
  // Numeros "pulam" em caso de rollback de tx — aceitavel para codigo de auditoria.
  const result = await tx.execute<{ next_val: string }>(
    sql`SELECT nextval('stockbridge.lote_codigo_seq')::text AS next_val`,
  );
  const proximo = Number(result.rows[0]?.next_val ?? '1');
  return `${prefixo}${String(proximo).padStart(3, '0')}`;
}
