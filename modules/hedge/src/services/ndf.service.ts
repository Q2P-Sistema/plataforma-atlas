import Decimal from 'decimal.js';
import { eq, and, type SQL } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { ndfRegistro, bucketMensal, type NdfRegistro, type NewNdfRegistro } from '@atlas/db';
import { fetchPtaxAtual } from '@atlas/integration-bcb';

const logger = createLogger('hedge:ndf');

// Valid state transitions
const VALID_TRANSITIONS: Record<string, string[]> = {
  pendente: ['ativo', 'cancelado'],
  ativo: ['liquidado', 'cancelado'],
  liquidado: [],
  cancelado: [],
};

export class NdfError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NdfError';
  }
}

interface CriarNdfParams {
  tipo: 'ndf' | 'trava' | 'acc';
  notional_usd: number;
  taxa_ndf: number;
  prazo_dias: number;
  data_vencimento: string;
  empresa: 'acxe' | 'q2p';
  observacao?: string;
}

export async function criarNdf(params: CriarNdfParams): Promise<NdfRegistro> {
  const db = getDb();
  const ptax = await fetchPtaxAtual();

  const notional = new Decimal(params.notional_usd);
  const taxaNdf = new Decimal(params.taxa_ndf);
  const ptaxSpot = new Decimal(ptax.venda);

  // custo_brl = notional * (taxa_ndf - ptax_spot)
  const custoBrl = notional.times(taxaNdf.minus(ptaxSpot));

  // Find bucket for the vencimento month
  const vencDate = new Date(params.data_vencimento);
  const bucketMes = `${vencDate.getFullYear()}-${String(vencDate.getMonth() + 1).padStart(2, '0')}-01`;

  const [bucket] = await db
    .select({ id: bucketMensal.id })
    .from(bucketMensal)
    .where(
      and(
        eq(bucketMensal.mesRef, bucketMes),
        eq(bucketMensal.empresa, params.empresa),
      ),
    )
    .limit(1);

  const hoje = new Date().toISOString().split('T')[0]!;

  const [created] = await db
    .insert(ndfRegistro)
    .values({
      tipo: params.tipo,
      notionalUsd: notional.toFixed(2),
      taxaNdf: taxaNdf.toFixed(4),
      ptaxContratacao: ptaxSpot.toFixed(4),
      prazoDias: params.prazo_dias,
      dataContratacao: hoje,
      dataVencimento: params.data_vencimento,
      custoBrl: custoBrl.toFixed(2),
      status: 'pendente',
      bucketId: bucket?.id ?? null,
      empresa: params.empresa,
      observacao: params.observacao ?? null,
    })
    .returning();

  logger.info(
    { id: created!.id, notional: params.notional_usd, taxa: params.taxa_ndf },
    'NDF criado',
  );

  return created!;
}

export async function ativarNdf(id: string): Promise<NdfRegistro> {
  return transicionar(id, 'ativo');
}

export async function liquidarNdf(
  id: string,
  ptaxLiquidacao: number,
): Promise<NdfRegistro> {
  const db = getDb();

  const [ndf] = await db
    .select()
    .from(ndfRegistro)
    .where(eq(ndfRegistro.id, id))
    .limit(1);

  if (!ndf) throw new NdfError('NOT_FOUND', 'NDF nao encontrado');
  if (!VALID_TRANSITIONS[ndf.status]?.includes('liquidado')) {
    throw new NdfError('INVALID_TRANSITION', `Nao pode liquidar NDF com status ${ndf.status}`);
  }

  const notional = new Decimal(ndf.notionalUsd);
  const taxaNdf = new Decimal(ndf.taxaNdf);
  const ptaxLiq = new Decimal(ptaxLiquidacao);

  // resultado_brl = notional * (taxa_ndf - ptax_liquidacao)
  const resultadoBrl = notional.times(taxaNdf.minus(ptaxLiq));

  const [updated] = await db
    .update(ndfRegistro)
    .set({
      status: 'liquidado',
      ptaxLiquidacao: ptaxLiq.toFixed(4),
      resultadoBrl: resultadoBrl.toFixed(2),
    })
    .where(eq(ndfRegistro.id, id))
    .returning();

  logger.info(
    { id, resultado: resultadoBrl.toNumber(), ptaxLiquidacao },
    'NDF liquidado',
  );

  return updated!;
}

export async function cancelarNdf(id: string): Promise<NdfRegistro> {
  return transicionar(id, 'cancelado');
}

async function transicionar(
  id: string,
  novoStatus: 'ativo' | 'liquidado' | 'cancelado',
): Promise<NdfRegistro> {
  const db = getDb();

  const [ndf] = await db
    .select()
    .from(ndfRegistro)
    .where(eq(ndfRegistro.id, id))
    .limit(1);

  if (!ndf) throw new NdfError('NOT_FOUND', 'NDF nao encontrado');

  if (!VALID_TRANSITIONS[ndf.status]?.includes(novoStatus)) {
    throw new NdfError(
      'INVALID_TRANSITION',
      `Transicao ${ndf.status} → ${novoStatus} nao permitida`,
    );
  }

  const [updated] = await db
    .update(ndfRegistro)
    .set({ status: novoStatus })
    .where(eq(ndfRegistro.id, id))
    .returning();

  logger.info({ id, from: ndf.status, to: novoStatus }, 'NDF transicionado');

  return updated!;
}

interface ListarFiltros {
  status?: string;
  empresa?: string;
  limit?: number;
  offset?: number;
}

export async function listarNdfs(filtros: ListarFiltros = {}) {
  const db = getDb();
  const conditions: SQL[] = [];

  if (filtros.status) {
    conditions.push(eq(ndfRegistro.status, filtros.status as any));
  }
  if (filtros.empresa) {
    conditions.push(eq(ndfRegistro.empresa, filtros.empresa));
  }

  const limit = Math.min(filtros.limit ?? 50, 200);
  const offset = filtros.offset ?? 0;

  const rows = await db
    .select()
    .from(ndfRegistro)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(ndfRegistro.dataVencimento)
    .limit(limit)
    .offset(offset);

  return rows;
}
