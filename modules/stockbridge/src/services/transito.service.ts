import { eq, and, inArray } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { lote, localidade } from '@atlas/db';
import { ESTAGIOS_VISIVEIS_POR_PERFIL, type EstagioTransito, type Perfil } from '../types.js';

const logger = createLogger('stockbridge:transito');

export class TransicaoInvalidaError extends Error {
  constructor(public readonly atual: EstagioTransito | null, public readonly proximo: EstagioTransito) {
    super(
      `Transicao invalida: nao e permitido avancar de ${atual ?? 'sem estagio'} para ${proximo}. ` +
        'Sequencia valida: transito_intl → porto_dta → transito_interno → (recebimento).',
    );
    this.name = 'TransicaoInvalidaError';
  }
}

export class DadosEstagioFaltandoError extends Error {
  constructor(public readonly estagio: EstagioTransito, public readonly campos: string[]) {
    super(`Avancar para ${estagio} exige: ${campos.join(', ')}`);
    this.name = 'DadosEstagioFaltandoError';
  }
}

export class LoteNaoEncontradoError extends Error {
  constructor(public readonly id: string) {
    super(`Lote ${id} nao encontrado ou inativo`);
    this.name = 'LoteNaoEncontradoError';
  }
}

export interface LoteTransitoItem {
  id: string;
  codigo: string;
  produtoCodigoAcxe: number;
  fornecedorNome: string;
  paisOrigem: string | null;
  quantidadeFisicaKg: number;
  quantidadeFiscalKg: number;
  custoBrlKg: number | null;
  cnpj: string;
  estagioTransito: EstagioTransito;
  localidadeCodigo: string | null;
  di: string | null;
  dta: string | null;
  notaFiscal: string | null;
  dtPrevChegada: string | null;
  atrasado: boolean;
}

/**
 * Lista lotes em transito agrupados por estagio, respeitando visibilidade por perfil (FR-006).
 *   - operador:          transito_interno, reservado
 *   - gestor / diretor:  todos os 4 estagios
 *
 * Flag `atrasado` e true quando dt_prev_chegada < now() e lote ainda em transito.
 */
export async function listarPorEstagio(perfil: Perfil): Promise<Record<EstagioTransito, LoteTransitoItem[]>> {
  const db = getDb();
  const estagios = ESTAGIOS_VISIVEIS_POR_PERFIL[perfil];

  const rows = await db
    .select({
      id: lote.id,
      codigo: lote.codigo,
      produtoCodigoAcxe: lote.produtoCodigoAcxe,
      fornecedorNome: lote.fornecedorNome,
      paisOrigem: lote.paisOrigem,
      quantidadeFisicaKg: lote.quantidadeFisicaKg,
      quantidadeFiscalKg: lote.quantidadeFiscalKg,
      custoBrlKg: lote.custoBrlKg,
      cnpj: lote.cnpj,
      estagioTransito: lote.estagioTransito,
      di: lote.di,
      dta: lote.dta,
      notaFiscal: lote.notaFiscal,
      dtPrevChegada: lote.dtPrevChegada,
      localidadeCodigo: localidade.codigo,
    })
    .from(lote)
    .leftJoin(localidade, eq(localidade.id, lote.localidadeId))
    .where(and(eq(lote.ativo, true), inArray(lote.estagioTransito, [...estagios])));

  const hoje = new Date().toISOString().slice(0, 10);

  // Inicializa grupos (mesmo que perfil nao veja, retornamos vazio — frontend sabe lidar)
  const agrupado: Record<EstagioTransito, LoteTransitoItem[]> = {
    transito_intl: [],
    porto_dta: [],
    transito_interno: [],
    reservado: [],
  };

  for (const r of rows) {
    const estagio = r.estagioTransito as EstagioTransito | null;
    if (!estagio) continue;
    agrupado[estagio].push({
      id: r.id,
      codigo: r.codigo,
      produtoCodigoAcxe: Number(r.produtoCodigoAcxe),
      fornecedorNome: r.fornecedorNome,
      paisOrigem: r.paisOrigem,
      quantidadeFisicaKg: Number(r.quantidadeFisicaKg),
      quantidadeFiscalKg: Number(r.quantidadeFiscalKg),
      custoBrlKg: r.custoBrlKg != null ? Number(r.custoBrlKg) : null,
      cnpj: r.cnpj,
      estagioTransito: estagio,
      localidadeCodigo: r.localidadeCodigo ?? null,
      di: r.di,
      dta: r.dta,
      notaFiscal: r.notaFiscal,
      dtPrevChegada: r.dtPrevChegada,
      atrasado: r.dtPrevChegada != null && r.dtPrevChegada < hoje,
    });
  }

  return agrupado;
}

export interface AvancarEstagioInput {
  loteId: string;
  proximoEstagio: EstagioTransito;
  di?: string;
  dta?: string;
  notaFiscal?: string;
  localidadeId?: string | null;
  dtPrevChegada?: string;
}

// Matriz de transicoes validas
// Chave: (atual | 'nenhum') => lista de estagios proximos permitidos
const TRANSICOES_VALIDAS: Record<string, EstagioTransito[]> = {
  nenhum: ['transito_intl', 'reservado'],
  transito_intl: ['porto_dta'],
  porto_dta: ['transito_interno'],
  transito_interno: [], // proximo passo e recebimento (outra rota)
  reservado: [],
};

export function transicaoEValida(
  atual: EstagioTransito | null,
  proximo: EstagioTransito,
): boolean {
  const chave = atual ?? 'nenhum';
  return TRANSICOES_VALIDAS[chave]?.includes(proximo) ?? false;
}

/**
 * Avanca um lote para o proximo estagio, validando:
 *   - transicao permitida pela matriz
 *   - porto_dta exige DI + DTA
 *   - transito_interno exige NF de transporte + localidade destino
 */
export async function avancarEstagio(input: AvancarEstagioInput): Promise<{ loteId: string; estagio: EstagioTransito }> {
  const db = getDb();

  const [loteAtual] = await db.select().from(lote).where(and(eq(lote.id, input.loteId), eq(lote.ativo, true))).limit(1);
  if (!loteAtual) {
    throw new LoteNaoEncontradoError(input.loteId);
  }

  if (!transicaoEValida(loteAtual.estagioTransito as EstagioTransito | null, input.proximoEstagio)) {
    throw new TransicaoInvalidaError(loteAtual.estagioTransito as EstagioTransito | null, input.proximoEstagio);
  }

  // Validacao de dados obrigatorios por estagio destino
  if (input.proximoEstagio === 'porto_dta') {
    const faltando: string[] = [];
    if (!input.di) faltando.push('DI');
    if (!input.dta) faltando.push('DTA');
    if (faltando.length > 0) throw new DadosEstagioFaltandoError('porto_dta', faltando);
  }
  if (input.proximoEstagio === 'transito_interno') {
    const faltando: string[] = [];
    if (!input.notaFiscal) faltando.push('notaFiscal (transporte)');
    if (!input.localidadeId) faltando.push('localidadeId (destino)');
    if (faltando.length > 0) throw new DadosEstagioFaltandoError('transito_interno', faltando);
  }

  const patch: Partial<typeof lote.$inferInsert> = {
    estagioTransito: input.proximoEstagio,
    status: 'transito',
    updatedAt: new Date(),
  };
  if (input.di) patch.di = input.di;
  if (input.dta) patch.dta = input.dta;
  if (input.notaFiscal) patch.notaFiscal = input.notaFiscal;
  if (input.localidadeId !== undefined) patch.localidadeId = input.localidadeId;
  if (input.dtPrevChegada) patch.dtPrevChegada = input.dtPrevChegada;

  await db.update(lote).set(patch).where(eq(lote.id, input.loteId));

  logger.info(
    { loteId: input.loteId, de: loteAtual.estagioTransito, para: input.proximoEstagio },
    'Lote avancou de estagio',
  );
  return { loteId: input.loteId, estagio: input.proximoEstagio };
}
