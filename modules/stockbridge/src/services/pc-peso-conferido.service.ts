import { getPool, createLogger } from '@atlas/core';
import {
  AVISO_COMPRAS_DEDUP_HORAS,
  carregarContextoEntradaNacional,
  destinatariosAvisoCompras,
  enviarAvisoComprasExcedenteRejeitado,
  type LinhaExcedentePc,
} from './notificacao.service.js';
import { colunaKgRecebidoPcExiste } from './pc-sugestao.service.js';

/**
 * Baixa do pedido de compra pelo peso conferido (feature 017, research D20, ACXEGDP-437).
 *
 * Com STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO ligada, o fiscal pelo Atlas manda o peso conferido
 * acima da NF como quantidade recebida (itensAjustes.nQtdeRecebida), e o OMIE baixa o PC por
 * ele. O fiscal roda no clique do operador e a entrada de estoque so na aprovacao do gestor:
 * se o gestor REJEITAR a entrada, o PC ja foi baixado e a rejeicao nao desfaz isso no OMIE.
 * Este modulo avisa compras nesse caso — na hora da rejeicao e, se o e-mail nao sair, pela
 * varredura do cron (varrerExcedentesRejeitadosSemAviso).
 */

const logger = createLogger('stockbridge:pc-peso-conferido');

/** Diferenca minima (kg) entre o baixado no PC e a NF para contar como quantidade acima da nota. */
const EXCEDENTE_MIN_KG = 0.001;

/** Janela da varredura: rejeicoes dos ultimos N dias ainda sem aviso. */
export const VARREDURA_EXCEDENTE_DIAS = 7;
/** Rejeicoes tratadas por rodada da varredura (o aviso tem limite de envios simultaneos). */
export const VARREDURA_EXCEDENTE_LIMITE = 10;

/**
 * O gestor rejeitou a entrada (`entrada_manual` da fila de NF) de um item cujo PC foi baixado
 * acima da NF? Avisa compras (enviarAvisoComprasExcedenteRejeitado). As linhas vem do ledger
 * `recebimento_fiscal_pc`: as sequencias do item da movimentacao, com o vinculo `concluido` e
 * `kg_recebido_pc` acima de `qtd_nf_kg`. Independe da chave: o que vale e o que o OMIE baixou.
 * Sem a coluna da 0059 nao ha o que avisar. Best-effort: nunca lanca (quem chama nao espera).
 * `rejeitadaEm` (so a varredura passa): a deduplicacao do aviso usa a mesma janela da varredura.
 */
export async function avisarComprasSeRejeitouExcedente(args: {
  aprovacaoId: string;
  movimentacaoId: string;
  motivo: string;
  usuarioId: string | null;
  rejeitadaEm?: Date | string;
}): Promise<'enviado' | 'deduplicado' | 'falha' | 'sem_excedente'> {
  try {
    if (!(await colunaKgRecebidoPcExiste())) return 'sem_excedente';
    const r = await getPool().query<{
      empresa: 'q2p' | 'acxe';
      nf_chave_acesso: string;
      nota_fiscal: string | null;
      n_sequencia: number | string;
      pc_numero: string;
      qtd_nf_kg: number | string;
      kg_recebido_pc: number | string;
      fornecedor_nome: string | null;
    }>(
      `SELECT pc.empresa, m.nf_chave_acesso, m.nota_fiscal, pc.n_sequencia, pc.pc_numero,
              pc.qtd_nf_kg::float8 AS qtd_nf_kg, pc.kg_recebido_pc::float8 AS kg_recebido_pc,
              rf.fornecedor_nome
         FROM stockbridge.movimentacao m
         JOIN stockbridge.recebimento_fiscal_pc pc
           ON pc.nf_chave_acesso = m.nf_chave_acesso
          AND pc.n_sequencia = ANY(m.nf_item_sequencias)
         LEFT JOIN stockbridge.recebimento_fiscal rf ON rf.id = pc.recebimento_fiscal_id
        WHERE m.id = $1::uuid
          AND m.subtipo = 'compra_nacional'
          AND pc.status = 'concluido'
          AND pc.kg_recebido_pc > pc.qtd_nf_kg + $2
        ORDER BY pc.n_sequencia`,
      [args.movimentacaoId, EXCEDENTE_MIN_KG],
    );
    if (r.rows.length === 0) return 'sem_excedente';

    const primeira = r.rows[0]!;
    const linhas: LinhaExcedentePc[] = r.rows.map((x) => ({
      nSequencia: Number(x.n_sequencia),
      pcNumero: (x.pc_numero ?? '').trim(),
      qtdNfKg: Number(x.qtd_nf_kg),
      kgRecebidoPc: Number(x.kg_recebido_pc),
    }));
    const ctx = await carregarContextoEntradaNacional(args.aprovacaoId);
    const resultado = await enviarAvisoComprasExcedenteRejeitado({
      empresa: primeira.empresa,
      nfChaveAcesso: primeira.nf_chave_acesso,
      notaFiscal: ctx?.notaFiscal ?? (primeira.nota_fiscal ?? '').replace(/^0+/, ''),
      // a NF pode ainda nao estar no espelho de NF (fiscal recem-concluido): o nome gravado no ledger do fiscal
      fornecedorNome: ctx?.fornecedor ?? (primeira.fornecedor_nome?.trim() || null),
      itemDescricao: ctx?.itemNf ?? null,
      produto: ctx?.produto ?? null,
      motivoRejeicao: args.motivo,
      linhas,
      disparadoPor: args.usuarioId,
      coberturaDesde: args.rejeitadaEm,
    });
    logger.info(
      { aprovacaoId: args.aprovacaoId, movimentacaoId: args.movimentacaoId, linhas: linhas.length, resultado },
      'Entrada rejeitada com o PC baixado acima da nota — aviso a compras',
    );
    return resultado;
  } catch (err) {
    logger.error(
      { err, aprovacaoId: args.aprovacaoId, movimentacaoId: args.movimentacaoId },
      'Falha ao verificar a baixa do PC acima da nota na rejeição — compras não foi avisado',
    );
    return 'falha';
  }
}

/**
 * Varredura do cron (revisao da D20, achado 2b): o aviso da rejeicao sai uma vez, sem esperar, e
 * pode falhar (SendGrid fora, limite de envios simultaneos, um destinatario so). Aqui, a cada rodada,
 * as rejeicoes dos ultimos VARREDURA_EXCEDENTE_DIAS dias cuja movimentacao tem item com o PC baixado
 * acima da nota e com algum destinatario ATUAL de compras ainda sem aviso daquela sequencia — enviado
 * depois da rejeicao ou ate AVISO_COMPRAS_DEDUP_HORAS antes dela, a mesma janela da deduplicacao do
 * aviso — sao avisadas de novo. Aviso de rejeicao antiga do mesmo item nao cobre a nova. O envio
 * deduplica com a mesma janela (ancorada na hora da rejeicao, 2a revisao) e manda so a quem falta.
 * Destinatario que o SendGrid recusa sempre e tentado a cada rodada ate a rejeicao sair da janela de
 * VARREDURA_EXCEDENTE_DIAS dias. Nunca lanca; devolve quantas tentou.
 */
export async function varrerExcedentesRejeitadosSemAviso(): Promise<number> {
  try {
    if (!(await colunaKgRecebidoPcExiste())) return 0;
    const destinatarios = destinatariosAvisoCompras().destinatarios.map((d) => d.trim().toLowerCase());
    if (destinatarios.length === 0) return 0;
    const r = await getPool().query<{
      aprovacao_id: string;
      movimentacao_id: string;
      rejeicao_motivo: string | null;
      aprovado_por: string | null;
      aprovado_em: Date | string;
    }>(
      `SELECT DISTINCT ON (m.id) a.id::text AS aprovacao_id, m.id::text AS movimentacao_id, a.rejeicao_motivo, a.aprovado_por::text AS aprovado_por,
              a.aprovado_em
         FROM stockbridge.aprovacao a
         JOIN stockbridge.movimentacao m ON m.id = a.movimentacao_id
         JOIN stockbridge.recebimento_fiscal_pc pc
           ON pc.nf_chave_acesso = m.nf_chave_acesso
          AND pc.n_sequencia = ANY(m.nf_item_sequencias)
          AND pc.status = 'concluido'
          AND pc.kg_recebido_pc > pc.qtd_nf_kg + $1
        WHERE a.tipo_aprovacao = 'entrada_manual'
          AND a.status = 'rejeitada'
          AND a.aprovado_em > now() - make_interval(days => $2)
          AND m.subtipo = 'compra_nacional'
          AND m.ativo = false
          AND EXISTS (
                SELECT 1 FROM unnest($5::text[]) AS dest(email)
                 WHERE NOT EXISTS (
                       SELECT 1 FROM stockbridge.nf_aviso_compras av
                        WHERE av.nf_chave_acesso = m.nf_chave_acesso
                          AND av.motivo = 'excedente_rejeitado'
                          AND av.itens @> jsonb_build_array(jsonb_build_object('nSequencia', pc.n_sequencia))
                          AND av.enviado_em > a.aprovado_em - make_interval(hours => $4)
                          AND dest.email = ANY (SELECT lower(btrim(x)) FROM unnest(string_to_array(av.enviado_para, ',')) AS x)))
        ORDER BY m.id, a.aprovado_em DESC
        LIMIT $3`,
      [EXCEDENTE_MIN_KG, VARREDURA_EXCEDENTE_DIAS, VARREDURA_EXCEDENTE_LIMITE, AVISO_COMPRAS_DEDUP_HORAS, destinatarios],
    );
    for (const x of r.rows) {
      const resultado = await avisarComprasSeRejeitouExcedente({
        aprovacaoId: x.aprovacao_id,
        movimentacaoId: x.movimentacao_id,
        motivo: (x.rejeicao_motivo ?? '').trim() || 'Motivo não registrado',
        usuarioId: x.aprovado_por,
        rejeitadaEm: x.aprovado_em,
      });
      logger.info({ aprovacaoId: x.aprovacao_id, movimentacaoId: x.movimentacao_id, resultado }, 'Varredura: aviso a compras de entrada rejeitada com o PC baixado acima da nota');
    }
    return r.rows.length;
  } catch (err) {
    logger.error({ err }, 'Falha na varredura de entradas rejeitadas com o PC baixado acima da nota');
    return 0;
  }
}
