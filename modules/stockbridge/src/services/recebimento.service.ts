import { eq, and, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { getDb, createLogger } from '@atlas/core';
import { lote, movimentacao, aprovacao, localidade, localidadeCorrelacao } from '@atlas/db';
import {
  consultarNF,
  incluirAjusteEstoque,
  isMockMode,
  type ConsultarNFResponse,
} from '@atlas/integration-omie';
import { getCorrelacao, CorrelacaoNaoEncontradaError } from './correlacao.service.js';
import { converterParaKg } from './motor.service.js';
import {
  enviarAlertaProdutoSemCorrelato,
  enviarAlertaAprovacaoPendente,
} from './notificacao.service.js';
import type { SubtipoMovimento, UnidadeMedida } from '../types.js';

const logger = createLogger('stockbridge:recebimento');

export class NotaFiscalJaProcessadaError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`NF ${notaFiscal} ja foi processada — idempotencia impede reprocessamento.`);
    this.name = 'NotaFiscalJaProcessadaError';
  }
}

export class OmieAjusteError extends Error {
  constructor(public readonly lado: 'acxe' | 'q2p', public readonly originalError: unknown) {
    super(`Falha ao incluir ajuste de estoque no OMIE ${lado.toUpperCase()}: ${(originalError as Error).message ?? 'erro desconhecido'}`);
    this.name = 'OmieAjusteError';
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

    // Idempotencia: ja processada?
    const ja = await db
      .select({ id: movimentacao.id })
      .from(movimentacao)
      .where(
        and(
          eq(movimentacao.notaFiscal, params.nf),
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
    return processarRecebimentoComDivergencia({
      input,
      omieData,
      qtdNfKg,
      qtdFisicaKg,
      deltaKg,
      localidadeCodigoQ2p: corr.codigoLocalEstoqueQ2p,
      correlacao,
    });
  }

  // 6. Sem divergencia: chama OMIE dos dois lados antes de persistir
  // Fiel ao legado: ACXE = transferencia (origem trânsito da NF → destino escolhido),
  // Q2P = entrada inicial. Valor unitario diferente em cada lado.
  const { idACXE, idQ2P } = await executarAjusteOmieDual({
    codigoLocalEstoqueAcxeOrigem: omieData.codigoLocalEstoque,
    codigoLocalEstoqueAcxeDestino: corr.codigoLocalEstoqueAcxe,
    codigoLocalEstoqueQ2p: corr.codigoLocalEstoqueQ2p,
    codigoProdutoAcxe: correlacao.codigoProdutoAcxe,
    codigoProdutoQ2p: correlacao.codigoProdutoQ2p,
    quantidadeKg: qtdFisicaKg,
    valorUnitarioAcxe: omieData.vUnCom,
    valorUnitarioQ2p: calcularValorUnitarioQ2p(omieData.vNF, qtdNfKg),
    notaFiscal: input.nf,
    observacaoSufixo: 'sem divergencias',
  });

  // Persistir lote + movimentacao em uma transacao
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
        mvQ2p: 1,
        dtQ2p: new Date(),
        idMovestQ2p: idQ2P.idMovest,
        idAjusteQ2p: idQ2P.idAjuste,
        idUserQ2p: input.userId,
        observacoes: input.observacoes ?? null,
      })
      .returning();

    return { loteId: loteCriado!.id, loteCodigo: loteCriado!.codigo, movimentacaoId: movCriada!.id };
  });

  return {
    loteId: resultado.loteId,
    loteCodigo: resultado.loteCodigo,
    status: 'provisorio',
    movimentacaoId: resultado.movimentacaoId,
    omie: { acxe: idACXE, q2p: idQ2P },
  };
}

async function processarRecebimentoComDivergencia(args: {
  input: ProcessarRecebimentoInput;
  omieData: ConsultarNFResponse;
  qtdNfKg: number;
  qtdFisicaKg: number;
  deltaKg: number;
  localidadeCodigoQ2p: number;
  correlacao: Awaited<ReturnType<typeof getCorrelacao>>;
}): Promise<ProcessarRecebimentoResult> {
  const db = getDb();
  const { input, omieData, qtdNfKg, qtdFisicaKg, deltaKg, correlacao } = args;
  const tipoDivergencia: 'faltando' | 'varredura' = deltaKg < 0 ? 'faltando' : 'varredura';

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
}): Promise<{ idACXE: { idMovest: string; idAjuste: string }; idQ2P: { idMovest: string; idAjuste: string } }> {
  let idACXE: { idMovest: string; idAjuste: string };
  try {
    const acxeRes = await incluirAjusteEstoque('acxe', {
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
    });
    idACXE = { idMovest: acxeRes.idMovest, idAjuste: acxeRes.idAjuste };
  } catch (err) {
    throw new OmieAjusteError('acxe', err);
  }

  try {
    const q2pRes = await incluirAjusteEstoque('q2p', {
      codigoLocalEstoque: String(args.codigoLocalEstoqueQ2p),
      idProduto: args.codigoProdutoQ2p,
      dataAtual: formatarDataBR(new Date()),
      quantidade: args.quantidadeKg,
      observacao: `Recebimento NF ${args.notaFiscal} ${args.observacaoSufixo}`,
      origem: 'AJU',
      tipo: 'ENT',
      motivo: 'INI',
      valor: args.valorUnitarioQ2p,
    });
    return { idACXE, idQ2P: { idMovest: q2pRes.idMovest, idAjuste: q2pRes.idAjuste } };
  } catch (err) {
    logger.error(
      { nf: args.notaFiscal, idACXE, err },
      'ALERTA: ajuste ACXE sucesso mas Q2P falhou. Intervencao manual necessaria.',
    );
    throw new OmieAjusteError('q2p', err);
  }
}

/**
 * Calcula o valor unitario "total" usado nos ajustes Q2P (legado:
 * `$vUnCom_Total = ceil(($vNF / $qtd_recebida_api * 1.145) * 100) / 100`).
 * Equivale ao unitario USD/kg da NF acrescido de markup interno de 14,5%
 * (impostos/serviços) arredondado para cima a 2 casas.
 */
export function calcularValorUnitarioQ2p(vNF: number, qtdNfKg: number): number {
  if (!Number.isFinite(vNF) || !Number.isFinite(qtdNfKg) || qtdNfKg <= 0) return 0;
  return Math.ceil((vNF / qtdNfKg) * 1.145 * 100) / 100;
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
  // Simples: pega o maior sufixo numerico atual + 1. Bom o suficiente para 1 operador
  // por armazem; em alta concorrencia um sequence dedicado seria mais robusto.
  const [row] = await tx
    .select({
      max: sql<number>`COALESCE(MAX(CAST(SUBSTRING(codigo FROM ${prefixo.length + 1}) AS INTEGER)), 0)`,
    })
    .from(lote)
    .where(sql`${lote.codigo} LIKE ${prefixo + '%'}`);
  const proximo = (row?.max ?? 0) + 1;
  return `${prefixo}${String(proximo).padStart(3, '0')}`;
}
