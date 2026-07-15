import { eq, and } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { getDb, createLogger } from '@atlas/core';
import { movimentacao, divergencia, localidadeCorrelacao, localidade } from '@atlas/db';
import { converterParaKg } from './motor.service.js';
import { enviarAlertaDebitoCruzado } from './notificacao.service.js';
import type { SubtipoMovimento, TipoMovimento, UnidadeMedida } from '../types.js';

const logger = createLogger('stockbridge:saida-automatica');

export type TipoOmieSaida =
  | 'venda'
  | 'remessa_beneficiamento'
  | 'transf_cnpj'
  | 'devolucao_fornecedor';

const TIPO_OMIE_PARA_SUBTIPO: Record<TipoOmieSaida, SubtipoMovimento> = {
  venda: 'venda',
  remessa_beneficiamento: 'remessa_beneficiamento',
  transf_cnpj: 'transf_cnpj',
  devolucao_fornecedor: 'devolucao_fornecedor',
};

/**
 * Converte a data de emissao do OMIE (dd/MM/aaaa, ex.: "25/03/2026") para Date local.
 * `new Date("25/03/2026")` retornaria Invalid Date para dia>12, ou trocaria dia/mes
 * silenciosamente para dia<=12 (STK-04, ACXEGDP-284) — por isso o parse e explicito.
 */
function parseDataEmissaoOmie(raw: string): Date {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!m) throw new Error(`Data de emissão inválida (esperado dd/MM/aaaa): ${raw}`);
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const ano = Number(m[3]);
  const d = new Date(ano, mes - 1, dia);
  // Date normaliza overflow (ex.: 31/02 vira 03/03); rejeitamos para nao gravar data errada.
  if (d.getFullYear() !== ano || d.getMonth() !== mes - 1 || d.getDate() !== dia) {
    throw new Error(`Data de emissão inválida: ${raw}`);
  }
  return d;
}

export interface ProcessarSaidaInput {
  nf: string;
  tipoOmie: TipoOmieSaida;
  cnpjEmissor: 'acxe' | 'q2p';
  produtoCodigo: number;
  quantidadeOriginal: number;
  unidade: UnidadeMedida;
  localidadeOrigemCodigo: number; // Codigo OMIE do local de estoque (ACXE ou Q2P)
  dtEmissao: string;
  idMovestOmie: string;
  idAjusteOmie?: string;
}

export interface ProcessarSaidaResult {
  movimentacaoId: string;
  subtipo: SubtipoMovimento;
  debitoCruzado: boolean;
  divergenciaId?: string;
  idempotente: boolean;
}

/**
 * Processa uma NF de saida do OMIE (venda, remessa, transf, devolucao a fornecedor)
 * chamada via polling n8n. Executa:
 *   1. Idempotencia por nota_fiscal + tipo_movimento=saida_automatica
 *   2. Identificacao de debito cruzado (emissor CNPJ != CNPJ fisico)
 *   3. Persistencia de movimentacao (e divergencia cruzada se aplicavel)
 *   4. Notificacao gestor+diretor em debito cruzado
 *
 * Importante: esta funcao NAO chama OMIE — apenas reflete a NF ja existente no
 * OMIE no modelo interno do StockBridge. Principio III preservado (todo calculo em TS).
 */
export async function processarSaidaAutomatica(
  input: ProcessarSaidaInput,
): Promise<ProcessarSaidaResult> {
  const db = getDb();

  // 1. Idempotencia — STK-09 (ACXEGDP-288): por NF + EMPRESA emissora. Sem a
  // empresa na chave, a saida da 2ª empresa com o mesmo numero de NF era
  // engolida como {idempotente:true} devolvendo o movimentacaoId da OUTRA
  // empresa (perda silenciosa).
  const [existente] = await db
    .select({ id: movimentacao.id })
    .from(movimentacao)
    .where(
      and(
        eq(movimentacao.notaFiscal, input.nf),
        eq(movimentacao.tipoMovimento, 'saida_automatica'),
        eq(movimentacao.empresa, input.cnpjEmissor),
        eq(movimentacao.ativo, true),
      ),
    )
    .limit(1);
  if (existente) {
    logger.info({ nf: input.nf, empresa: input.cnpjEmissor }, 'Saída automática já processada — idempotente');
    return {
      movimentacaoId: existente.id,
      subtipo: TIPO_OMIE_PARA_SUBTIPO[input.tipoOmie],
      debitoCruzado: false,
      idempotente: true,
    };
  }

  // 2. Localidade fisica origem (pelo codigo OMIE da chave correspondente ao CNPJ emissor)
  //    Se o emissor for Q2P mas o estoque estiver em localidade ACXE, e debito cruzado.
  const origemInfo = await resolverLocalidadeFisica(input.cnpjEmissor, input.localidadeOrigemCodigo);
  const cnpjFisico = origemInfo?.cnpjLocalidade ?? null;
  const quantidadeKg = Number(
    new Decimal(converterParaKg(input.quantidadeOriginal, input.unidade)).toFixed(3),
  );

  const debitoCruzado = cnpjFisico !== null && cnpjFisico !== input.cnpjEmissor;
  const tipoMov: TipoMovimento = debitoCruzado ? 'debito_cruzado' : 'saida_automatica';
  const subtipo: SubtipoMovimento = debitoCruzado ? 'debito_cruzado' : TIPO_OMIE_PARA_SUBTIPO[input.tipoOmie];

  const dtEmissaoDate = parseDataEmissaoOmie(input.dtEmissao);

  // 3. Persiste movimentacao (lado correspondente ao CNPJ emissor preenchido)
  const resultado = await db.transaction(async (tx) => {
    const [movCriada] = await tx
      .insert(movimentacao)
      .values({
        notaFiscal: input.nf,
        tipoMovimento: tipoMov,
        subtipo,
        // STK-09: empresa emissora participa da chave de idempotencia
        empresa: input.cnpjEmissor,
        quantidadeKg: String(-Math.abs(quantidadeKg)), // saida = negativo
        mvAcxe: input.cnpjEmissor === 'acxe' ? 1 : null,
        dtAcxe: input.cnpjEmissor === 'acxe' ? dtEmissaoDate : null,
        idMovestAcxe: input.cnpjEmissor === 'acxe' ? input.idMovestOmie : null,
        idAjusteAcxe: input.cnpjEmissor === 'acxe' ? input.idAjusteOmie ?? null : null,
        mvQ2p: input.cnpjEmissor === 'q2p' ? 1 : null,
        dtQ2p: input.cnpjEmissor === 'q2p' ? dtEmissaoDate : null,
        idMovestQ2p: input.cnpjEmissor === 'q2p' ? input.idMovestOmie : null,
        idAjusteQ2p: input.cnpjEmissor === 'q2p' ? input.idAjusteOmie ?? null : null,
        observacoes: debitoCruzado
          ? `Débito cruzado: NF emitida por ${input.cnpjEmissor.toUpperCase()} mas estoque físico em ${cnpjFisico!.toUpperCase()}`
          : null,
      })
      .returning();

    let divergenciaId: string | undefined;
    if (debitoCruzado) {
      const [divCriada] = await tx
        .insert(divergencia)
        .values({
          movimentacaoId: movCriada!.id,
          tipo: 'cruzada',
          quantidadeDeltaKg: String(quantidadeKg),
          status: 'aberta',
          observacoes: `Emissor: ${input.cnpjEmissor}; físico: ${cnpjFisico} — aguarda NF de transferência de regularização`,
        })
        .returning();
      divergenciaId = divCriada!.id;
    }

    return { movimentacaoId: movCriada!.id, divergenciaId };
  });

  // 4. Notificacao fora da transacao (email nao bloqueia)
  if (debitoCruzado) {
    void enviarAlertaDebitoCruzado({
      notaFiscal: input.nf,
      cnpjEmissor: input.cnpjEmissor,
      cnpjFisico: cnpjFisico!,
      quantidadeKg,
      movimentacaoId: resultado.movimentacaoId,
    });
  }

  logger.info(
    { nf: input.nf, tipoMov, subtipo, debitoCruzado, movimentacaoId: resultado.movimentacaoId },
    'Saída automática processada',
  );

  return {
    movimentacaoId: resultado.movimentacaoId,
    subtipo,
    debitoCruzado,
    divergenciaId: resultado.divergenciaId,
    idempotente: false,
  };
}

interface LocalidadeFisicaInfo {
  localidadeId: string;
  cnpjLocalidade: 'acxe' | 'q2p';
}

/**
 * Resolve de qual CNPJ fisicamente e aquele local de estoque, cruzando o codigo OMIE
 * com a tabela de correlacao.
 *
 * Estrategia:
 *   - se cnpjEmissor='acxe': o `codigo` esperado bate em codigo_local_estoque_acxe
 *   - se cnpjEmissor='q2p':  bate em codigo_local_estoque_q2p
 *   - retornamos o CNPJ da localidade correlata (pode ser igual ao emissor — caso normal —
 *     ou diferente — caso debito cruzado)
 */
async function resolverLocalidadeFisica(
  cnpjEmissor: 'acxe' | 'q2p',
  codigoOmieOrigem: number,
): Promise<LocalidadeFisicaInfo | null> {
  const db = getDb();
  const col = cnpjEmissor === 'acxe'
    ? localidadeCorrelacao.codigoLocalEstoqueAcxe
    : localidadeCorrelacao.codigoLocalEstoqueQ2p;

  const [row] = await db
    .select({
      localidadeId: localidadeCorrelacao.localidadeId,
      cnpj: localidade.cnpj,
    })
    .from(localidadeCorrelacao)
    .innerJoin(localidade, eq(localidade.id, localidadeCorrelacao.localidadeId))
    .where(eq(col, codigoOmieOrigem))
    .limit(1);

  if (!row || !row.cnpj) return null;
  const cnpjNormalizado = row.cnpj.toLowerCase().includes('acxe') ? 'acxe' : 'q2p';
  return { localidadeId: row.localidadeId, cnpjLocalidade: cnpjNormalizado };
}

// STK-13 (ACXEGDP-290): regularizarFiscal foi REMOVIDA — era codigo morto (zero
// chamadores) com uma armadilha latente: o UPDATE marcava TODAS as divergencias
// cruzadas abertas como 'regularizada', sem filtrar produto/NF/quantidade,
// apesar do docstring prometer "para o mesmo produto". Quando o fluxo de
// regularizacao fiscal por NF de transferencia (tipoOmie=transf_cnpj) virar
// feature, reimplementar COM filtro por divergencia especifica — historico no
// git e no card ACXEGDP-290.

/**
 * Helper exposto para testes: dado o emissor e o CNPJ fisico, retorna se e debito cruzado.
 */
export function detectarDebitoCruzado(
  cnpjEmissor: 'acxe' | 'q2p',
  cnpjFisico: 'acxe' | 'q2p' | null,
): boolean {
  if (cnpjFisico === null) return false;
  return cnpjEmissor !== cnpjFisico;
}
