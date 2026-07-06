import { sql } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import {
  enviarDigestComodatosVencidos,
  resolverEmailOperador,
  resolverEmailsAprovadores,
  type ComodatoVencidoDigestItem,
} from './notificacao.service.js';

const logger = createLogger('stockbridge:cron-comodato');

type ComodatoVencidoRow = {
  movimentacao_id: string;
  produto_codigo_acxe: string;
  produto_descricao: string | null;
  galpao_origem: string;
  cliente: string | null;
  quantidade_kg: string;
  dt_saida: string;
  dt_prevista_retorno: string;
  criado_por: string | null;
  dias_vencido: string;
} & Record<string, unknown>;

/**
 * Decide se um comodato com diasVencido dias passados do prazo deve receber
 * notificacao hoje. Regra acordada com o usuario (2026-05-07):
 *   - D+1   → operador + gestor (notificacao inicial)
 *   - D+15  → escalada para operador + gestor + diretor
 *   - D+30, D+45, D+60, ... → segue notificando a cada 15 dias com diretor incluido
 */
function decidirNotificacaoComodato(diasVencido: number): {
  notificar: boolean;
  fase: 'inicial' | 'escalada';
  incluiDiretor: boolean;
} {
  if (diasVencido === 1) {
    return { notificar: true, fase: 'inicial', incluiDiretor: false };
  }
  // A partir do D+15, notifica a cada 15 dias (15, 30, 45, ...).
  if (diasVencido >= 15 && diasVencido % 15 === 0) {
    return { notificar: true, fase: 'escalada', incluiDiretor: true };
  }
  return { notificar: false, fase: 'inicial', incluiDiretor: false };
}

/**
 * Lista comodatos abertos vencidos e devolve o numero de dias vencidos por
 * linha. Mesma definicao de "comodato em aberto" usada em listarComodatosAbertos
 * — saida_manual + comodato + status_omie='concluida' + sem retorno registrado.
 */
async function listarComodatosVencidos(): Promise<ComodatoVencidoRow[]> {
  const db = getDb();
  const result = await db.execute<ComodatoVencidoRow>(sql`
    SELECT
      m.id::text                                             AS movimentacao_id,
      m.produto_codigo_acxe::text                            AS produto_codigo_acxe,
      p.descricao                                            AS produto_descricao,
      m.galpao                                               AS galpao_origem,
      NULLIF(regexp_replace(m.observacoes, '.*Cliente: ([^|]+).*', '\\1'), m.observacoes) AS cliente,
      ABS(m.quantidade_kg)::text                             AS quantidade_kg,
      m.created_at::text                                     AS dt_saida,
      m.dt_prevista_retorno::text                            AS dt_prevista_retorno,
      m.criado_por::text                                     AS criado_por,
      (CURRENT_DATE - m.dt_prevista_retorno)::text           AS dias_vencido
    FROM stockbridge.movimentacao m
    LEFT JOIN public."tbl_produtos_ACXE" p ON p.codigo_produto = m.produto_codigo_acxe
    WHERE m.subtipo = 'comodato'
      AND m.tipo_movimento = 'saida_manual'
      AND m.status_omie = 'concluida'
      AND m.ativo = true
      AND m.dt_prevista_retorno IS NOT NULL
      AND m.dt_prevista_retorno < CURRENT_DATE
      AND NOT EXISTS (
        SELECT 1 FROM stockbridge.movimentacao r
        WHERE r.movimentacao_origem_id = m.id
          AND r.subtipo = 'retorno_comodato'
          AND r.ativo = true
      )
    ORDER BY m.dt_prevista_retorno ASC
  `);
  return result.rows;
}

/**
 * Roda 1x por dia (cron). Para cada comodato vencido, decide se hoje cai num
 * dia de notificacao (D+1, D+15, D+30, ...) e dispara email pra escala
 * apropriada. Idempotente — se o comodato continuar aberto, ele sera notificado
 * de novo no proximo D+15. Se for retornado hoje, sai da lista no proximo run.
 */
export async function processarAlertasComodatoVencido(): Promise<{
  total: number;
  notificados: number;
}> {
  const inicio = Date.now();
  let notificados = 0;
  let total = 0;
  try {
    const comodatos = await listarComodatosVencidos();
    total = comodatos.length;

    // EML-13: agrupa por destinatário. Antes cada comodato virava 1 e-mail por
    // destinatário — um gestor com 10 comodatos vencidos no mesmo dia de escala
    // recebia 10 e-mails. Agora cada destinatário recebe 1 digest com todos os
    // comodatos que lhe cabem.
    const porDestinatario = new Map<string, ComodatoVencidoDigestItem[]>();

    for (const c of comodatos) {
      const dias = Number(c.dias_vencido);
      const decisao = decidirNotificacaoComodato(dias);
      if (!decisao.notificar) continue;

      // Resolve destinatarios: operador (criadoPor) + gestores [+ diretores]
      const destinatariosSet = new Set<string>();

      if (c.criado_por) {
        const opEmail = await resolverEmailOperador(c.criado_por);
        if (opEmail) destinatariosSet.add(opEmail);
      }
      const gestores = await resolverEmailsAprovadores('gestor');
      for (const e of gestores) destinatariosSet.add(e);
      if (decisao.incluiDiretor) {
        const diretores = await resolverEmailsAprovadores('diretor');
        for (const e of diretores) destinatariosSet.add(e);
      }

      if (destinatariosSet.size === 0) {
        logger.warn({ movimentacaoId: c.movimentacao_id, dias }, 'Comodato vencido sem destinatários resolviveis');
        continue;
      }

      const item: ComodatoVencidoDigestItem = {
        movimentacaoId: c.movimentacao_id,
        cliente: c.cliente,
        produtoCodigoAcxe: Number(c.produto_codigo_acxe),
        produtoDescricao: c.produto_descricao ?? `SKU ${c.produto_codigo_acxe}`,
        quantidadeKg: Number(c.quantidade_kg),
        galpaoOrigem: c.galpao_origem,
        dtSaida: c.dt_saida,
        dtPrevistaRetorno: c.dt_prevista_retorno,
        diasVencido: dias,
        fase: decisao.fase,
      };
      for (const email of destinatariosSet) {
        const lista = porDestinatario.get(email);
        if (lista) lista.push(item);
        else porDestinatario.set(email, [item]);
      }
      notificados += 1; // conta comodatos notificados (não e-mails)
    }

    // 1 digest por destinatário
    await Promise.allSettled(
      Array.from(porDestinatario.entries()).map(([to, lista]) =>
        enviarDigestComodatosVencidos({ to, comodatos: lista }),
      ),
    );

    logger.info(
      { total, notificados, destinatarios: porDestinatario.size, elapsedMs: Date.now() - inicio },
      'Cron de alerta comodato vencido executado',
    );
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Falha geral no cron de alerta comodato vencido');
  }
  return { total, notificados };
}
