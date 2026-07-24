import { eq, sql, and, ne, desc, isNull } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { getDb, createLogger } from '@atlas/core';
import { movimentacao, lote, localidade, localidadeCorrelacao, aprovacao } from '@atlas/db';
import type { Perfil, StatusOmie, SubtipoMovimento } from '../types.js';
import { COD_INT_AJUSTE_SUFIXO, buildCodIntAjuste } from '../types.js';
import { incluirAjusteIdempotente } from './omie-idempotente.js';
import { calcularValorUnitarioQ2p, calcularValorUnitarioAcxe } from './recebimento.service.js';
import { formatarDataOmie } from './omie-shared.js';
import { resolverEstoqueDiferencaAcxe } from './estoques-especiais-acxe.js';
import {
  resolverCorrelacaoCompletaGalpao,
  resolverCodigosLocaisTroca,
  resolverCodigoProdutoOmie,
} from './omie-saida.service.js';
import { consultarValorUnitarioProduto } from './aprovacao.service.js';
import { resolverDescricaoProdutoAcxe } from './produto-descricao.js';

const logger = createLogger('stockbridge:operacoes-pendentes');

/**
 * ACXEGDP-313: rótulo legível de uma localidade para mensagens de erro ao
 * usuário — o UUID interno não identifica nada para o operador. Best-effort.
 */
async function labelLocalidade(db: ReturnType<typeof getDb>, localidadeId: string): Promise<string> {
  try {
    const [loc] = await db
      .select({ codigo: localidade.codigo, nome: localidade.nome })
      .from(localidade)
      .where(eq(localidade.id, localidadeId))
      .limit(1);
    return loc ? `${loc.codigo} — ${loc.nome}` : 'não identificada';
  } catch {
    return 'não identificada';
  }
}

/**
 * Limite de retentativas que o OPERADOR pode fazer no lado Q2P.
 * Tentativa 0 = inicial (durante processarRecebimento).
 * Tentativa 1 = primeira chamada via endpoint /retentar.
 * A partir de tentativa 2, somente gestor/diretor pode retentar.
 */
const LIMITE_TENTATIVAS_OPERADOR_Q2P = 2;

export class OperacaoPendenteNaoEncontradaError extends Error {
  constructor(public readonly id: string) {
    super(`Movimentação ${id} não encontrada ou já concluída`);
    this.name = 'OperacaoPendenteNaoEncontradaError';
  }
}

export class OperacaoNaoPendenteError extends Error {
  constructor(public readonly id: string, public readonly statusOmie: string) {
    super(`Movimentação ${id} está com status_omie='${statusOmie}' — não requer retry`);
    this.name = 'OperacaoNaoPendenteError';
  }
}

export class OperadorSemRetentativasError extends Error {
  constructor(public readonly id: string, public readonly tentativasFeitas: number) {
    super(
      `Operador já esgotou as ${tentativasFeitas} tentativas de retry. ` +
        'Acione um gestor/diretor para continuar.',
    );
    this.name = 'OperadorSemRetentativasError';
  }
}

export interface OperacaoPendenteItem {
  id: string;
  opId: string;
  notaFiscal: string;
  ladoPendente: 'q2p' | 'acxe-faltando';
  statusOmie: StatusOmie;
  tentativas: number;
  ultimoErro: { lado: string; mensagem: string; timestamp: string } | null;
  createdAt: string;
  lote: {
    id: string | null;
    codigo: string | null;
    fornecedorNome: string | null;
    produtoCodigoAcxe: number | null;
    quantidadeKg: number;
  };
}

/**
 * Lista todas as movimentacoes com OMIE pendente (status_omie != 'concluida' e != 'falha').
 * Ordenada por created_at desc — pendencias mais recentes no topo.
 *
 * STK-08 (ACXEGDP-288): movimentacoes de saida manual/retorno/recebimento
 * nacional nascem 'pendente_q2p' na SUBMISSAO, antes do gestor decidir — o
 * painel as listava como "pendencias OMIE" quando ainda eram aprovacoes em
 * aberto. O LEFT JOIN exclui movimentacoes com aprovacao PENDENTE linkada:
 * pendencia OMIE de verdade so existe depois da decisao do gestor. Movs do
 * fluxo de recebimento (aprovacao linkada por lote, nao por movimentacao_id)
 * nao tem match no join e seguem listadas normalmente.
 */
export async function listarPendentes(): Promise<OperacaoPendenteItem[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: movimentacao.id,
      opId: movimentacao.opId,
      notaFiscal: movimentacao.notaFiscal,
      statusOmie: movimentacao.statusOmie,
      tentativasQ2p: movimentacao.tentativasQ2p,
      tentativasAcxeFaltando: movimentacao.tentativasAcxeFaltando,
      ultimoErroOmie: movimentacao.ultimoErroOmie,
      quantidadeKg: movimentacao.quantidadeKg,
      createdAt: movimentacao.createdAt,
      loteId: movimentacao.loteId,
      loteCodigo: lote.codigo,
      fornecedorNome: lote.fornecedorNome,
      produtoCodigoAcxe: lote.produtoCodigoAcxe,
    })
    .from(movimentacao)
    .leftJoin(lote, eq(lote.id, movimentacao.loteId))
    .leftJoin(
      aprovacao,
      and(eq(aprovacao.movimentacaoId, movimentacao.id), eq(aprovacao.status, 'pendente')),
    )
    .where(
      and(
        ne(movimentacao.statusOmie, 'concluida'),
        ne(movimentacao.statusOmie, 'falha'),
        eq(movimentacao.ativo, true),
        isNull(aprovacao.id),
      ),
    )
    .orderBy(sql`${movimentacao.createdAt} DESC`);

  return rows.map((r) => {
    const ladoPendente: 'q2p' | 'acxe-faltando' =
      r.statusOmie === 'pendente_q2p' ? 'q2p' : 'acxe-faltando';
    const tentativas =
      ladoPendente === 'q2p' ? r.tentativasQ2p : r.tentativasAcxeFaltando;
    const ultimoErroRaw = r.ultimoErroOmie as
      | { lado?: string; mensagem?: string; timestamp?: string }
      | null;
    return {
      id: r.id,
      opId: r.opId,
      notaFiscal: r.notaFiscal,
      ladoPendente,
      statusOmie: r.statusOmie as StatusOmie,
      tentativas,
      ultimoErro: ultimoErroRaw
        ? {
            lado: ultimoErroRaw.lado ?? 'desconhecido',
            mensagem: ultimoErroRaw.mensagem ?? '',
            timestamp: ultimoErroRaw.timestamp ?? '',
          }
        : null,
      createdAt: r.createdAt.toISOString(),
      lote: {
        id: r.loteId,
        codigo: r.loteCodigo,
        fornecedorNome: r.fornecedorNome,
        produtoCodigoAcxe: r.produtoCodigoAcxe,
        quantidadeKg: Number(r.quantidadeKg),
      },
    };
  });
}

export interface MarcarFalhaInput {
  movimentacaoId: string;
  motivo: string;
  ator: { userId: string; role: Perfil };
}

/**
 * Marca uma movimentacao pendente como falha definitiva (nao-recuperavel).
 * Apenas gestor/diretor pode fazer. Status_omie='falha' tira o item do painel
 * de pendencias mas mantem o registro para auditoria.
 */
export async function marcarComoFalhaDefinitiva(input: MarcarFalhaInput): Promise<{ id: string }> {
  if (input.ator.role === 'operador') {
    throw new OperadorSemRetentativasError(input.movimentacaoId, -1);
  }
  if (!input.motivo || input.motivo.trim().length === 0) {
    throw new Error('Motivo obrigatório para marcar operação como falha');
  }
  const db = getDb();
  const [mov] = await db
    .select()
    .from(movimentacao)
    .where(eq(movimentacao.id, input.movimentacaoId))
    .limit(1);
  if (!mov) throw new OperacaoPendenteNaoEncontradaError(input.movimentacaoId);
  if (mov.statusOmie === 'concluida' || mov.statusOmie === 'falha') {
    throw new OperacaoNaoPendenteError(input.movimentacaoId, mov.statusOmie);
  }

  // STK-08 (ACXEGDP-288): movimentacoes com aprovacao ainda PENDENTE nao sao
  // pendencias OMIE (nada foi chamado) — marcar 'falha' nelas esconderia uma
  // aprovacao em aberto do fluxo do gestor. Rejeitar a aprovacao e o caminho.
  const [aprPendente] = await db
    .select({ id: aprovacao.id })
    .from(aprovacao)
    .where(and(eq(aprovacao.movimentacaoId, mov.id), eq(aprovacao.status, 'pendente')))
    .limit(1);
  if (aprPendente) {
    throw new Error(
      `Movimentação ${mov.id} ainda aguarda decisão do gestor (aprovação ${aprPendente.id} pendente) — rejeite a aprovação em vez de marcar falha OMIE`,
    );
  }

  await db
    .update(movimentacao)
    .set({
      statusOmie: 'falha',
      ultimoErroOmie: {
        lado: 'manual',
        mensagem: `Marcado como falha por ${input.ator.role}: ${input.motivo}`,
        timestamp: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(eq(movimentacao.id, input.movimentacaoId));

  logger.info(
    { movimentacaoId: input.movimentacaoId, ator: input.ator, motivo: input.motivo },
    'Movimentação marcada como falha definitiva',
  );

  return { id: input.movimentacaoId };
}

export interface RetentarInput {
  movimentacaoId: string;
  ator: { userId: string; role: Perfil };
}

export interface RetentarResult {
  movimentacaoId: string;
  statusOmie: 'concluida' | 'pendente_q2p' | 'pendente_acxe_faltando' | 'falha';
  jaExistiaNoOmie?: boolean;
  tentativasQ2p: number;
}

/**
 * Retenta o lado pendente de uma movimentacao.
 * - Operador: maximo de LIMITE_TENTATIVAS_OPERADOR_Q2P tentativas no Q2P; bloqueado em pendente_acxe_faltando.
 * - Gestor/diretor: sem limite de tentativas, ambos os lados.
 *
 * Usa cod_int_ajuste para garantir idempotencia: se a chamada anterior chegou a
 * persistir no OMIE (mas a resposta HTTP se perdeu), ListarAjusteEstoque detecta
 * e a movimentacao e marcada como concluida sem nova inclusao.
 */
export async function retentarOperacaoPendente(input: RetentarInput): Promise<RetentarResult> {
  const db = getDb();

  const [mov] = await db
    .select()
    .from(movimentacao)
    .where(eq(movimentacao.id, input.movimentacaoId))
    .limit(1);
  if (!mov) throw new OperacaoPendenteNaoEncontradaError(input.movimentacaoId);
  if (mov.statusOmie === 'concluida') {
    throw new OperacaoNaoPendenteError(input.movimentacaoId, mov.statusOmie);
  }
  if (mov.statusOmie === 'falha') {
    throw new OperacaoNaoPendenteError(input.movimentacaoId, mov.statusOmie);
  }

  // RBAC: operador so pode retentar Q2P, e ate o limite definido.
  // pendente_acxe_faltando e admin-only (operador NAO tem permissao mesmo na 1a tentativa).
  if (input.ator.role === 'operador') {
    if (mov.statusOmie !== 'pendente_q2p') {
      throw new OperadorSemRetentativasError(input.movimentacaoId, mov.tentativasAcxeFaltando ?? -1);
    }
    if (mov.tentativasQ2p >= LIMITE_TENTATIVAS_OPERADOR_Q2P) {
      throw new OperadorSemRetentativasError(input.movimentacaoId, mov.tentativasQ2p);
    }
  }

  if (mov.statusOmie === 'pendente_q2p') {
    return retentarQ2p({ mov, ator: input.ator });
  }
  if (mov.statusOmie === 'pendente_acxe_faltando') {
    // Operador foi bloqueado acima (so gestor/diretor); aqui ja sabemos que e admin.
    return retentarAcxeFaltando({ mov, ator: input.ator });
  }
  throw new OperacaoNaoPendenteError(input.movimentacaoId, mov.statusOmie);
}

interface MovimentacaoRow {
  id: string;
  opId: string;
  loteId: string | null;
  notaFiscal: string;
  quantidadeKg: string;
  tentativasQ2p: number;
  idMovestAcxe: string | null;
  idAjusteAcxe: string | null;
  // Campos de saida manual sem lote (migration 0026/0031) — usados pelo retry
  // de saida manual (STK-03, ACXEGDP-283).
  subtipo: string | null;
  produtoCodigoAcxe: number | null;
  galpao: string | null;
  galpaoDestino: string | null;
  custoUnitarioBrl: string | null;
  // Retorno de comodato (STK-03b): par baixa/entrada linkado pela origem.
  tipoMovimento: string;
  movimentacaoOrigemId: string | null;
}

async function retentarQ2p(args: {
  mov: MovimentacaoRow;
  ator: RetentarInput['ator'];
}): Promise<RetentarResult> {
  const db = getDb();
  if (!args.mov.loteId) {
    // STK-03 (ACXEGDP-283): movimentacoes de saida manual/comodato nao tem lote —
    // antes este guard lancava incondicionalmente e a pendencia Q2P ficava
    // irrecuperavel (ACXE debitado, Q2P nao, sem caminho automatico).
    return retentarQ2pSaidaManual(args);
  }
  const [loteRow] = await db.select().from(lote).where(eq(lote.id, args.mov.loteId)).limit(1);
  if (!loteRow) throw new Error(`Lote ${args.mov.loteId} não encontrado`);
  if (!loteRow.localidadeId) {
    throw new Error(`Lote ${loteRow.codigo} sem localidade — não é possível retentar Q2P`);
  }
  const [corr] = await db
    .select()
    .from(localidadeCorrelacao)
    .where(eq(localidadeCorrelacao.localidadeId, loteRow.localidadeId))
    .limit(1);
  if (!corr?.codigoLocalEstoqueQ2p) {
    throw new Error(
      `Local de estoque ${await labelLocalidade(db, loteRow.localidadeId)} sem correlato Q2P (lote ${loteRow.codigo})`,
    );
  }
  if (!loteRow.produtoCodigoQ2p) {
    throw new Error(`Lote ${loteRow.codigo} sem produtoCodigoQ2p`);
  }
  if (!loteRow.valorTotalNfBrl || !loteRow.quantidadeFiscalKg) {
    throw new Error(
      `Lote ${loteRow.codigo} sem dados de NF persistidos — não é possível calcular valor unitario Q2P`,
    );
  }

  const qtdKg = Number(args.mov.quantidadeKg);
  const qtdNfKg = Number(loteRow.quantidadeFiscalKg);
  const vNF = Number(loteRow.valorTotalNfBrl);
  const valorUnitQ2p = calcularValorUnitarioQ2p(vNF, qtdNfKg);

  try {
    const res = await incluirAjusteIdempotente(
      'q2p',
      buildCodIntAjuste(args.mov.opId, COD_INT_AJUSTE_SUFIXO.q2pEnt),
      {
        codigoLocalEstoque: String(corr.codigoLocalEstoqueQ2p),
        idProduto: Number(loteRow.produtoCodigoQ2p),
        dataAtual: formatarDataOmie(),
        quantidade: new Decimal(qtdKg).toNumber(),
        observacao: `Retry Q2P NF ${args.mov.notaFiscal} (op ${args.mov.opId})`,
        origem: 'AJU',
        tipo: 'ENT',
        motivo: 'INI',
        valor: valorUnitQ2p,
      },
      { verificarAntes: true },
    );

    // Sucesso: atualiza movimentacao para concluida com IDs Q2P
    await db
      .update(movimentacao)
      .set({
        idMovestQ2p: res.idMovest,
        idAjusteQ2p: res.idAjuste,
        mvQ2p: 1,
        dtQ2p: new Date(),
        idUserQ2p: args.ator.userId,
        statusOmie: 'concluida',
        ultimoErroOmie: null,
        updatedAt: new Date(),
      })
      .where(eq(movimentacao.id, args.mov.id));

    logger.info(
      {
        movimentacaoId: args.mov.id,
        opId: args.mov.opId,
        ator: args.ator,
        jaExistia: res.jaExistia,
      },
      'Operação pendente Q2P concluída via retry',
    );

    return {
      movimentacaoId: args.mov.id,
      statusOmie: 'concluida',
      jaExistiaNoOmie: res.jaExistia,
      tentativasQ2p: args.mov.tentativasQ2p,
    };
  } catch (err) {
    const novasTentativas = args.mov.tentativasQ2p + 1;
    await db
      .update(movimentacao)
      .set({
        tentativasQ2p: novasTentativas,
        ultimoErroOmie: {
          lado: 'q2p',
          mensagem: (err as Error)?.message ?? 'erro desconhecido',
          timestamp: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(movimentacao.id, args.mov.id));

    logger.warn(
      {
        movimentacaoId: args.mov.id,
        opId: args.mov.opId,
        tentativasQ2p: novasTentativas,
        ator: args.ator,
        err,
      },
      'Retry Q2P falhou — incrementando tentativas',
    );
    throw err;
  }
}

/** Mapa subtipo → parametros da chamada Q2P original em omie-saida.service.ts. */
interface RetrySaidaManualSpec {
  codInt: string;
  tipo: 'SAI' | 'TRF';
  motivo: 'PER' | 'INV' | 'TRF';
  /** Codigo OMIE do local destino (apenas TRF). */
  codigoLocalEstoqueDestino?: string;
}

/**
 * Retry do lado Q2P para movimentacoes de SAIDA MANUAL (sem lote) — STK-03
 * (ACXEGDP-283). Reconstroi a chamada OMIE a partir do que a aprovacao original
 * persistiu na movimentacao (subtipo, galpao, produto, custo_unitario_brl) e a
 * executa com verificarAntes=true: se a chamada anterior chegou a persistir no
 * OMIE (falha so na resposta), ListarAjusteEstoque detecta pelo cod_int_ajuste
 * e nada e duplicado.
 *
 * Os cod_int_ajuste vem de COD_INT_AJUSTE_SUFIXO — a MESMA constante usada na
 * chamada original (omie-saida.service.ts), garantindo match byte a byte.
 *
 * retorno_comodato fica de fora deste dispatch (2 pernas Q2P independentes +
 * 2 movimentacoes) — tratado em follow-up dedicado (STK-03b).
 */
async function retentarQ2pSaidaManual(args: {
  mov: MovimentacaoRow;
  ator: RetentarInput['ator'];
}): Promise<RetentarResult> {
  const db = getDb();
  const { mov } = args;

  if (mov.subtipo === 'retorno_comodato') {
    // STK-03b: 2 pernas Q2P independentes (baixa TROCA + entrada destino) em
    // 2 movimentacoes distintas — fluxo dedicado.
    return retentarQ2pRetornoComodato(args);
  }
  if (!mov.produtoCodigoAcxe || !mov.galpao) {
    throw new Error(
      `Movimentação ${mov.id} sem produto/galpão persistidos — não é possível reconstruir a chamada Q2P`,
    );
  }

  // GUARDA DE APROVACAO: movimentacoes de saida manual nascem 'pendente_q2p' na
  // SUBMISSAO (saida-manual.service), antes do gestor decidir. Sem este check, o
  // retry executaria o ajuste OMIE de uma operacao nao aprovada (ou rejeitada),
  // contornando o fluxo de aprovacao inteiro. Retry so vale pos-aprovacao.
  const [aprAprovada] = await db
    .select({ id: aprovacao.id })
    .from(aprovacao)
    .where(and(eq(aprovacao.movimentacaoId, mov.id), eq(aprovacao.status, 'aprovada')))
    .limit(1);
  if (!aprAprovada) {
    throw new Error(
      `Movimentação ${mov.id} ainda não tem aprovação concluída — a pendência Q2P só é retentável depois que o gestor aprovar a saída`,
    );
  }

  const correlacao = await resolverCorrelacaoCompletaGalpao(mov.galpao);
  if (!correlacao.q2p) {
    throw new Error(`Galpão ${mov.galpao} sem correlato Q2P — não é possível retentar`);
  }

  let spec: RetrySaidaManualSpec;
  switch (mov.subtipo as SubtipoMovimento | null) {
    case 'amostra':
    case 'descarte':
    case 'quebra':
      spec = {
        codInt: buildCodIntAjuste(mov.opId, COD_INT_AJUSTE_SUFIXO.saidaPerQ2p),
        tipo: 'SAI',
        motivo: 'PER',
      };
      break;
    case 'inventario_menos':
      spec = {
        codInt: buildCodIntAjuste(mov.opId, COD_INT_AJUSTE_SUFIXO.saidaInvQ2p),
        tipo: 'SAI',
        motivo: 'INV',
      };
      break;
    case 'transf_intra_cnpj': {
      if (!mov.galpaoDestino) {
        throw new Error(`Movimentação ${mov.id} de transf_intra_cnpj sem galpão destino`);
      }
      const corrDestino = await resolverCorrelacaoCompletaGalpao(mov.galpaoDestino);
      if (!corrDestino.q2p) {
        throw new Error(`Galpão destino ${mov.galpaoDestino} sem correlato Q2P`);
      }
      spec = {
        codInt: buildCodIntAjuste(mov.opId, COD_INT_AJUSTE_SUFIXO.trfIntraQ2p),
        tipo: 'TRF',
        motivo: 'TRF',
        codigoLocalEstoqueDestino: String(corrDestino.q2p),
      };
      break;
    }
    case 'comodato': {
      const troca = await resolverCodigosLocaisTroca();
      if (!troca.q2p) {
        throw new Error('Localidade TROCA (90.0.1) sem correlato Q2P — não é possível retentar comodato');
      }
      spec = {
        codInt: buildCodIntAjuste(mov.opId, COD_INT_AJUSTE_SUFIXO.comodatoTrfQ2p),
        tipo: 'TRF',
        motivo: 'TRF',
        codigoLocalEstoqueDestino: String(troca.q2p),
      };
      break;
    }
    default:
      throw new Error(
        `Subtipo '${mov.subtipo ?? '(nulo)'}' não suportado no retry de saída manual (movimentação ${mov.id})`,
      );
  }

  // Valor unitario: o MESMO da chamada ACXE original (persistido na aprovacao,
  // STK-03). Recalcular do preco vivo gravaria custo diferente entre as empresas.
  // Fallback pro preco vivo cobre apenas movimentacoes aprovadas antes da
  // persistencia existir (degradacao documentada).
  let valorUnitario = mov.custoUnitarioBrl != null ? Number(mov.custoUnitarioBrl) : 0;
  if (valorUnitario <= 0) {
    logger.warn(
      { movimentacaoId: mov.id, subtipo: mov.subtipo },
      'custo_unitario_brl ausente na movimentação — usando preço vivo como fallback (pode divergir do lado ACXE)',
    );
    valorUnitario = await consultarValorUnitarioProduto(Number(mov.produtoCodigoAcxe), mov.galpao, 'q2p');
  }
  if (valorUnitario <= 0) {
    throw new Error(
      `Sem valor unitário disponível para o retry (produto ${mov.produtoCodigoAcxe}, galpão ${mov.galpao}) — OMIE rejeita ajuste com valor 0`,
    );
  }

  const idProdutoQ2p = await resolverCodigoProdutoOmie(Number(mov.produtoCodigoAcxe), 'q2p');
  const quantidade = Number(new Decimal(Math.abs(Number(mov.quantidadeKg))).toFixed(3));

  try {
    const res = await incluirAjusteIdempotente(
      'q2p',
      spec.codInt,
      {
        codigoLocalEstoque: String(correlacao.q2p),
        ...(spec.codigoLocalEstoqueDestino
          ? { codigoLocalEstoqueDestino: spec.codigoLocalEstoqueDestino }
          : {}),
        idProduto: idProdutoQ2p,
        dataAtual: formatarDataOmie(),
        quantidade,
        observacao: `Retry Q2P saída manual ${mov.subtipo} (op ${mov.opId})`.slice(0, 240),
        origem: 'AJU',
        tipo: spec.tipo,
        motivo: spec.motivo,
        valor: Number(new Decimal(valorUnitario).toFixed(2)),
      },
      { verificarAntes: true },
    );

    await db
      .update(movimentacao)
      .set({
        idMovestQ2p: res.idMovest,
        idAjusteQ2p: res.idAjuste,
        // Saida manual: mesmo sinal que aprovarSaidaManual grava no lado Q2P
        mvQ2p: -1,
        dtQ2p: new Date(),
        idUserQ2p: args.ator.userId,
        statusOmie: 'concluida',
        ultimoErroOmie: null,
        updatedAt: new Date(),
      })
      .where(eq(movimentacao.id, mov.id));

    logger.info(
      {
        movimentacaoId: mov.id,
        opId: mov.opId,
        subtipo: mov.subtipo,
        ator: args.ator,
        jaExistia: res.jaExistia,
      },
      'Pendência Q2P de saída manual concluída via retry',
    );

    return {
      movimentacaoId: mov.id,
      statusOmie: 'concluida',
      jaExistiaNoOmie: res.jaExistia,
      tentativasQ2p: mov.tentativasQ2p,
    };
  } catch (err) {
    const novasTentativas = mov.tentativasQ2p + 1;
    await db
      .update(movimentacao)
      .set({
        tentativasQ2p: novasTentativas,
        ultimoErroOmie: {
          lado: 'q2p',
          mensagem: (err as Error)?.message ?? 'erro desconhecido',
          timestamp: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(movimentacao.id, mov.id));

    logger.warn(
      {
        movimentacaoId: mov.id,
        opId: mov.opId,
        subtipo: mov.subtipo,
        tentativasQ2p: novasTentativas,
        ator: args.ator,
        err,
      },
      'Retry Q2P de saída manual falhou — incrementando tentativas',
    );
    throw err;
  }
}

/**
 * Retry Q2P do RETORNO DE COMODATO (STK-03b, ACXEGDP-283) — estruturalmente
 * diferente das outras saidas manuais: sao DUAS movimentacoes (baixa do TROCA,
 * tipo 'ajuste', e entrada no destino, tipo 'entrada_manual') pareadas por
 * movimentacao_origem_id, e DUAS pernas Q2P com cod_int_ajuste proprios
 * (ret-baixa-q2p, ret-entrada-q2p) derivados do opId DA ENTRADA (o mesmo usado
 * por executarRetornoComodatoOmieDual na aprovacao).
 *
 * A falha original pode ter sido ENTRE as pernas (baixa Q2P ok, entrada Q2P
 * nao) — por isso cada perna e verificada independentemente via
 * incluirAjusteIdempotente(verificarAntes=true) e so roda para a movimentacao
 * que ainda esta pendente_q2p. Clicar em qualquer uma das duas resolve a
 * operacao inteira; a outra some do painel junto.
 */
async function retentarQ2pRetornoComodato(args: {
  mov: MovimentacaoRow;
  ator: RetentarInput['ator'];
}): Promise<RetentarResult> {
  const db = getDb();
  const { mov } = args;

  if (!mov.movimentacaoOrigemId) {
    throw new Error(`Movimentação ${mov.id} de retorno_comodato sem movimentacao_origem_id`);
  }

  // Localiza o PAR baixa/entrada a partir da origem (o clique pode ter vindo
  // de qualquer uma das duas linhas).
  const par = await db
    .select()
    .from(movimentacao)
    .where(
      and(
        eq(movimentacao.movimentacaoOrigemId, mov.movimentacaoOrigemId),
        eq(movimentacao.subtipo, 'retorno_comodato'),
        eq(movimentacao.ativo, true),
      ),
    );
  const baixa = par.find((m) => m.tipoMovimento === 'ajuste');
  const entrada = par.find((m) => m.tipoMovimento === 'entrada_manual');
  if (!baixa || !entrada) {
    throw new Error(
      `Par baixa/entrada do retorno de comodato incompleto para origem ${mov.movimentacaoOrigemId} (baixa=${baixa?.id ?? 'ausente'}, entrada=${entrada?.id ?? 'ausente'})`,
    );
  }

  // GUARDA DE APROVACAO (mesma do fluxo geral): as duas movimentacoes nascem
  // pendente_q2p na submissao; retry so vale depois que o gestor aprovou.
  // A aprovacao do retorno e linkada a ENTRADA.
  const [aprAprovada] = await db
    .select({ id: aprovacao.id })
    .from(aprovacao)
    .where(and(eq(aprovacao.movimentacaoId, entrada.id), eq(aprovacao.status, 'aprovada')))
    .limit(1);
  if (!aprAprovada) {
    throw new Error(
      `Retorno de comodato ${mov.movimentacaoOrigemId} ainda não tem aprovação concluída — a pendência Q2P só é retentável depois que o gestor aprovar`,
    );
  }

  if (!baixa.produtoCodigoAcxe || !entrada.produtoCodigoAcxe || !entrada.galpao) {
    throw new Error(
      `Retorno de comodato ${mov.movimentacaoOrigemId} sem produto/galpão persistidos — não é possível reconstruir as chamadas Q2P`,
    );
  }

  // Todas as pernas do retorno usam o opId da ENTRADA (aprovarSaidaManual passa
  // mov.opId de ap.movimentacaoId — a entrada — para executarRetornoComodatoOmieDual).
  const opId = entrada.opId;

  const troca = await resolverCodigosLocaisTroca();
  if (!troca.q2p) {
    throw new Error('Localidade TROCA (90.0.1) sem correlato Q2P — não é possível retentar retorno de comodato');
  }
  const corrDestino = await resolverCorrelacaoCompletaGalpao(entrada.galpao);
  if (!corrDestino.q2p) {
    throw new Error(`Galpão destino ${entrada.galpao} sem correlato Q2P — não é possível retentar`);
  }

  const resolverValor = async (registro: typeof baixa, rotulo: string): Promise<number> => {
    const persistido = registro.custoUnitarioBrl != null ? Number(registro.custoUnitarioBrl) : 0;
    if (persistido > 0) return persistido;
    logger.warn(
      { movimentacaoId: registro.id, rotulo },
      'custo_unitario_brl ausente no retorno de comodato — usando preço vivo como fallback',
    );
    const vivo = await consultarValorUnitarioProduto(
      Number(registro.produtoCodigoAcxe),
      entrada.galpao ?? '',
      'q2p',
    );
    if (vivo <= 0) {
      const produtoLabel = await resolverDescricaoProdutoAcxe(db, Number(registro.produtoCodigoAcxe));
      throw new Error(
        `Sem valor unitário disponível para a perna '${rotulo}' do retorno (produto ${produtoLabel}) — OMIE rejeita ajuste com valor 0`,
      );
    }
    return vivo;
  };

  const executarPerna = async (
    registro: typeof baixa,
    perna: 'baixa' | 'entrada',
  ): Promise<{ jaExistia: boolean }> => {
    const sufixo = perna === 'baixa' ? COD_INT_AJUSTE_SUFIXO.retBaixaQ2p : COD_INT_AJUSTE_SUFIXO.retEntradaQ2p;
    const codInt = buildCodIntAjuste(opId, sufixo);
    const valor = Number(new Decimal(await resolverValor(registro, perna)).toFixed(2));
    const quantidade = Number(new Decimal(Math.abs(Number(registro.quantidadeKg))).toFixed(3));
    const idProdutoQ2p = await resolverCodigoProdutoOmie(Number(registro.produtoCodigoAcxe), 'q2p');

    try {
      const res = await incluirAjusteIdempotente(
        'q2p',
        codInt,
        {
          codigoLocalEstoque: perna === 'baixa' ? String(troca.q2p) : String(corrDestino.q2p),
          idProduto: idProdutoQ2p,
          dataAtual: formatarDataOmie(),
          quantidade,
          observacao: `Retry Q2P retorno comodato — ${perna} (op ${opId})`.slice(0, 240),
          origem: 'AJU',
          // Espelha executarRetornoComodatoOmieDual: baixa=SAI/INV, entrada=ENT/INV
          tipo: perna === 'baixa' ? 'SAI' : 'ENT',
          motivo: 'INV',
          valor,
        },
        { verificarAntes: true },
      );

      await db
        .update(movimentacao)
        .set({
          idMovestQ2p: res.idMovest,
          idAjusteQ2p: res.idAjuste,
          mvQ2p: perna === 'baixa' ? -1 : 1,
          dtQ2p: new Date(),
          idUserQ2p: args.ator.userId,
          statusOmie: 'concluida',
          ultimoErroOmie: null,
          updatedAt: new Date(),
        })
        .where(eq(movimentacao.id, registro.id));

      logger.info(
        { movimentacaoId: registro.id, opId, perna, jaExistia: res.jaExistia, ator: args.ator },
        'Perna Q2P do retorno de comodato concluída via retry',
      );
      return { jaExistia: res.jaExistia };
    } catch (err) {
      const novasTentativas = (registro.tentativasQ2p ?? 0) + 1;
      await db
        .update(movimentacao)
        .set({
          tentativasQ2p: novasTentativas,
          ultimoErroOmie: {
            lado: 'q2p',
            mensagem: (err as Error)?.message ?? 'erro desconhecido',
            timestamp: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(movimentacao.id, registro.id));
      logger.warn(
        { movimentacaoId: registro.id, opId, perna, tentativasQ2p: novasTentativas, err },
        'Perna Q2P do retorno de comodato falhou no retry — incrementando tentativas',
      );
      throw err;
    }
  };

  // Executa apenas as pernas ainda pendentes — a falha original pode ter sido
  // entre a baixa e a entrada, e um retry anterior pode ja ter resolvido uma.
  let algumaJaExistia = false;
  if (baixa.statusOmie === 'pendente_q2p') {
    const r = await executarPerna(baixa, 'baixa');
    algumaJaExistia = algumaJaExistia || r.jaExistia;
  }
  if (entrada.statusOmie === 'pendente_q2p') {
    const r = await executarPerna(entrada, 'entrada');
    algumaJaExistia = algumaJaExistia || r.jaExistia;
  }

  return {
    movimentacaoId: mov.id,
    statusOmie: 'concluida',
    jaExistiaNoOmie: algumaJaExistia,
    tentativasQ2p: mov.tentativasQ2p,
  };
}

async function retentarAcxeFaltando(args: {
  mov: { id: string; opId: string; loteId: string | null; quantidadeKg: string; tentativasAcxeFaltando: number };
  ator: RetentarInput['ator'];
}): Promise<RetentarResult> {
  const db = getDb();
  if (!args.mov.loteId) {
    throw new Error(`Movimentação ${args.mov.id} sem loteId — não é possível retentar`);
  }
  const [loteRow] = await db.select().from(lote).where(eq(lote.id, args.mov.loteId)).limit(1);
  if (!loteRow) throw new Error(`Lote ${args.mov.loteId} não encontrado`);
  if (
    !loteRow.codigoLocalEstoqueOrigemAcxe ||
    !loteRow.notaFiscal ||
    !loteRow.valorTotalNfBrl ||
    !loteRow.localidadeId
  ) {
    throw new Error(`Lote ${loteRow.codigo} sem dados da NF persistidos para retry ACXE-faltando`);
  }
  const [corr] = await db
    .select()
    .from(localidadeCorrelacao)
    .where(eq(localidadeCorrelacao.localidadeId, loteRow.localidadeId))
    .limit(1);
  if (!corr?.codigoLocalEstoqueAcxe) {
    throw new Error(
      `Local de estoque ${await labelLocalidade(db, loteRow.localidadeId)} sem correlato ACXE (lote ${loteRow.codigo})`,
    );
  }

  // Recupera tipoDivergencia da aprovacao mais recente do lote (status 'aprovada').
  const [apr] = await db
    .select()
    .from(aprovacao)
    .where(and(eq(aprovacao.loteId, args.mov.loteId), eq(aprovacao.status, 'aprovada')))
    .orderBy(desc(aprovacao.aprovadoEm))
    .limit(1);
  if (!apr || !apr.tipoDivergencia || (apr.tipoDivergencia !== 'faltando' && apr.tipoDivergencia !== 'varredura')) {
    throw new Error(
      `Aprovação do lote ${loteRow.codigo} não indica tipoDivergencia faltando/varredura — não é possível retentar`,
    );
  }

  const qtdAprovadaKg = Number(args.mov.quantidadeKg);
  const qtdNfKg = Number(loteRow.quantidadeFiscalKg);
  const qtdDiferencaKg = Number(new Decimal(qtdNfKg).minus(qtdAprovadaKg).toFixed(3));
  if (qtdDiferencaKg <= 0) {
    throw new Error(`Lote ${loteRow.codigo} sem diferença a transferir`);
  }
  const vNF = Number(loteRow.valorTotalNfBrl);
  const valorUnitAcxe = calcularValorUnitarioAcxe(vNF, qtdNfKg);
  const codigoLocalEstoqueDiferenca = resolverEstoqueDiferencaAcxe({
    tipoDivergencia: apr.tipoDivergencia,
    codigoLocalEstoqueDestinoAcxe: corr.codigoLocalEstoqueAcxe,
  });

  try {
    const res = await incluirAjusteIdempotente(
      'acxe',
      buildCodIntAjuste(args.mov.opId, COD_INT_AJUSTE_SUFIXO.acxeFaltando),
      {
        codigoLocalEstoque: loteRow.codigoLocalEstoqueOrigemAcxe,
        codigoLocalEstoqueDestino: codigoLocalEstoqueDiferenca,
        idProduto: Number(loteRow.produtoCodigoAcxe),
        dataAtual: formatarDataOmie(),
        quantidade: qtdDiferencaKg,
        observacao: `Retry ACXE-faltando NF ${loteRow.notaFiscal} (op ${args.mov.opId}, ${apr.tipoDivergencia})`,
        origem: 'AJU',
        tipo: 'TRF',
        motivo: 'TRF',
        valor: valorUnitAcxe,
      },
      { verificarAntes: true },
    );

    await db
      .update(movimentacao)
      .set({
        statusOmie: 'concluida',
        ultimoErroOmie: null,
        updatedAt: new Date(),
      })
      .where(eq(movimentacao.id, args.mov.id));

    logger.info(
      {
        movimentacaoId: args.mov.id,
        opId: args.mov.opId,
        ator: args.ator,
        idAjusteFaltando: res.idAjuste,
        jaExistia: res.jaExistia,
        qtdDiferencaKg,
        tipoDivergencia: apr.tipoDivergencia,
      },
      'Operação pendente acxe-faltando concluída via retry',
    );

    return {
      movimentacaoId: args.mov.id,
      statusOmie: 'concluida',
      jaExistiaNoOmie: res.jaExistia,
      tentativasQ2p: 0,
    };
  } catch (err) {
    const novasTentativas = args.mov.tentativasAcxeFaltando + 1;
    await db
      .update(movimentacao)
      .set({
        tentativasAcxeFaltando: novasTentativas,
        ultimoErroOmie: {
          lado: 'acxe-faltando',
          mensagem: (err as Error)?.message ?? 'erro desconhecido',
          timestamp: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(movimentacao.id, args.mov.id));

    logger.warn(
      {
        movimentacaoId: args.mov.id,
        opId: args.mov.opId,
        tentativasAcxeFaltando: novasTentativas,
        ator: args.ator,
        err,
      },
      'Retry ACXE-faltando falhou — incrementando tentativas',
    );
    throw err;
  }
}
