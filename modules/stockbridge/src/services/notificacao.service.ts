import { sendEmail, createLogger, getConfig, getDb } from '@atlas/core';
import { users, userModules } from '@atlas/db';
import { eq, inArray, and, isNull } from 'drizzle-orm';

const logger = createLogger('stockbridge:notificacao');

const ADMIN_FALLBACK_EMAIL = 'admin@atlas.local';
const COMEX_FALLBACK_EMAIL = 'comex_acxe@acxe-polimeros.com.br';

function getAdminEmail(): string {
  const config = getConfig();
  return config.SEED_ADMIN_EMAIL ?? ADMIN_FALLBACK_EMAIL;
}

/** Caixa de Comex da ACXE — copiada em todo recebimento concluido com sucesso. */
function getComexEmail(): string {
  return getConfig().STOCKBRIDGE_COMEX_EMAIL ?? COMEX_FALLBACK_EMAIL;
}

/**
 * Resolve emails dos usuarios ATIVOS com perfil compativel + acesso ao modulo.
 *  - nivel='gestor':  gestor + diretor (diretor tambem ve pendencias de gestor)
 *  - nivel='diretor': so diretor
 *
 * Filtros aplicados:
 *  - users.status = 'active'
 *  - users.deleted_at IS NULL
 *  - users.role IN (...)
 *  - INNER JOIN atlas.user_modules WHERE module_key = 'stockbridge'
 *  - flag global MODULE_STOCKBRIDGE_ENABLED tambem deve estar true
 *
 * Cai no email do admin se nada for encontrado.
 */
export async function resolverEmailsAprovadores(nivel: 'gestor' | 'diretor'): Promise<string[]> {
  const config = getConfig();
  if (!config.MODULE_STOCKBRIDGE_ENABLED) {
    logger.warn({ nivel }, 'Modulo StockBridge desabilitado — nao envia notificacao');
    return [];
  }

  const db = getDb();
  // Cada nivel notifica apenas o proprio role (diretor *pode* aprovar tudo,
  // mas nao quer email de cada saida_descarte/quebra/amostra do dia a dia —
  // ele so e notificado quando a pendencia exige nivel='diretor' de fato).
  const roles: ('gestor' | 'diretor')[] = nivel === 'diretor' ? ['diretor'] : ['gestor'];
  try {
    const rows = await db
      .select({ email: users.email })
      .from(users)
      .innerJoin(userModules, eq(userModules.userId, users.id))
      .where(
        and(
          inArray(users.role, roles),
          eq(users.status, 'active'),
          isNull(users.deletedAt),
          eq(userModules.moduleKey, 'stockbridge'),
        ),
      );
    const emails = [...new Set(rows.map((r) => r.email).filter((e): e is string => !!e))];
    return emails.length > 0 ? emails : [getAdminEmail()];
  } catch (err) {
    logger.warn({ err, nivel }, 'Falha ao resolver emails de aprovadores — fallback admin');
    return [getAdminEmail()];
  }
}

/**
 * T039: notifica o admin quando uma NF de recebimento nao encontra correlato Q2P
 * para o produto ACXE. Replica a mensagem do legado PHP (research.md secao 10).
 */
export async function enviarAlertaProdutoSemCorrelato(args: {
  codigoProdutoAcxe: number;
  notaFiscal: string;
  descricaoProduto: string;
}): Promise<void> {
  const to = getAdminEmail();
  const subject = `StockBridge — Produto sem correlato Q2P (NF ${args.notaFiscal})`;
  const html = `
    <h2 style="color: #f0ad4e;">Acao Necessaria: Produto Nao Encontrado na Q2P</h2>
    <p>Durante o recebimento da <strong>NF ${args.notaFiscal}</strong> no StockBridge, foi identificado que o produto abaixo nao possui correlato cadastrado na Q2P (match por descricao textual).</p>
    <ul>
      <li><strong>Codigo ACXE:</strong> ${args.codigoProdutoAcxe}</li>
      <li><strong>Descricao ACXE:</strong> ${args.descricaoProduto}</li>
    </ul>
    <p>Acoes esperadas:</p>
    <ol>
      <li>Cadastrar o produto correspondente na Q2P com <strong>descricao EXATA</strong> do ACXE.</li>
      <li>Aguardar sync n8n (proximo ciclo).</li>
      <li>Tentar novamente o recebimento no StockBridge.</li>
    </ol>
    <p style="color:#888;font-size:11px;">Sistema Atlas — StockBridge</p>
  `;
  try {
    await sendEmail({ to, subject, html });
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar email de alerta produto sem correlato');
  }
}

/**
 * Feature 012 (FR-010): no recebimento, quando o cancelamento/emitente da NF não
 * pôde ser determinado a partir do retorno do OMIE, o sistema LIBERA o recebimento
 * (fail-open) e alerta o admin para revisão posterior. Espelha o padrão de
 * `enviarAlertaProdutoSemCorrelato` — fora de transação, não bloqueia, try/catch logado.
 */
export async function enviarAlertaNfIndeterminada(args: {
  nf: string;
  cnpj: 'acxe' | 'q2p';
  motivo: string;
}): Promise<void> {
  const to = getAdminEmail();
  const subject = `StockBridge — NF ${args.nf} recebida com dado indeterminado (${args.cnpj.toUpperCase()})`;
  const html = `
    <h2 style="color: #f0ad4e;">Revisao Necessaria: NF recebida sem validacao completa</h2>
    <p>O recebimento da <strong>NF ${args.nf}</strong> (${args.cnpj.toUpperCase()}) foi <strong>liberado</strong>, mas o sistema nao conseguiu determinar com seguranca um dos sinais da NF no OMIE.</p>
    <ul>
      <li><strong>Motivo:</strong> ${args.motivo}</li>
    </ul>
    <p>Acoes esperadas:</p>
    <ol>
      <li>Conferir no OMIE se a NF ${args.nf} esta valida e foi emitida pela empresa correta.</li>
      <li>Se houver irregularidade (cancelada ou emitente errado), estornar o recebimento no StockBridge.</li>
    </ol>
    <p style="color:#888;font-size:11px;">Sistema Atlas — StockBridge</p>
  `;
  try {
    await sendEmail({ to, subject, html });
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar email de alerta de NF indeterminada');
  }
}

/**
 * T077b: Notifica gestor+diretor quando uma NF de saida tem debito cruzado
 * (CNPJ emissor != CNPJ fisico). Regra do legado — requer atencao do setor contabil
 * para emitir NF de transferencia de regularizacao.
 */
export async function enviarAlertaDebitoCruzado(args: {
  notaFiscal: string;
  cnpjEmissor: 'acxe' | 'q2p';
  cnpjFisico: 'acxe' | 'q2p';
  quantidadeKg: number;
  movimentacaoId: string;
}): Promise<void> {
  const to = getAdminEmail();
  const subject = `StockBridge — ⚠ Debito cruzado (NF ${args.notaFiscal})`;
  const html = `
    <h2 style="color: #dc3545;">Debito Cruzado Detectado</h2>
    <p>Uma NF de saida gerou <strong>divergencia cruzada</strong> entre CNPJ emissor e CNPJ onde o estoque fisico esta.</p>
    <ul>
      <li><strong>NF:</strong> ${args.notaFiscal}</li>
      <li><strong>Emissor (faturou):</strong> ${args.cnpjEmissor.toUpperCase()}</li>
      <li><strong>Fisico (estoque real):</strong> ${args.cnpjFisico.toUpperCase()}</li>
      <li><strong>Quantidade:</strong> ${args.quantidadeKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg</li>
    </ul>
    <p><strong>Acao esperada:</strong> setor contabil deve emitir NF de transferencia
    ${args.cnpjFisico.toUpperCase()} -> ${args.cnpjEmissor.toUpperCase()} para regularizar a posicao fiscal.
    A divergencia sera fechada automaticamente quando a NF de regularizacao for processada.</p>
    <p style="color:#888;font-size:11px;">Sistema Atlas — StockBridge</p>
  `;
  try {
    await sendEmail({ to, subject, html });
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar email de debito cruzado');
  }
}

/**
 * Notifica gestor quando uma nova aprovacao e criada (divergencia de recebimento,
 * entrada manual, etc.). Reutilizado por outras US.
 */
export async function enviarAlertaAprovacaoPendente(args: {
  aprovacaoId: string;
  tipoAprovacao: string;
  nivel: 'gestor' | 'diretor';
  loteCodigo: string;
  produto: string;
  quantidadeKg: number;
  detalhes?: string;
}): Promise<void> {
  const destinatarios = await resolverEmailsAprovadores(args.nivel);
  const config = getConfig();
  const linkPainel = `${config.APP_URL ?? ''}/stockbridge/aprovacoes`;
  const subject = `StockBridge — Aprovacao pendente (${args.nivel}) — ${args.tipoAprovacao}`;
  const html = `
    <h2 style="color: #D97706;">Nova pendencia de aprovacao</h2>
    <p><strong>Tipo:</strong> ${args.tipoAprovacao}</p>
    <p><strong>Item:</strong> ${args.loteCodigo} — ${args.produto} (${args.quantidadeKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg)</p>
    ${args.detalhes ? `<p><strong>Detalhes:</strong> ${args.detalhes}</p>` : ''}
    <p style="margin:16px 0;">
      <a href="${linkPainel}"
         style="display:inline-block;padding:10px 20px;background:#0077cc;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
        Abrir aprovacoes pendentes →
      </a>
    </p>
    <p style="color:#888;font-size:11px;">Sistema Atlas — StockBridge</p>
  `;
  try {
    // Envia 1 email por destinatario pra evitar vazar lista (To: ficaria visivel)
    await Promise.allSettled(destinatarios.map((to) => sendEmail({ to, subject, html })));
    logger.info({ aprovacaoId: args.aprovacaoId, destinatarios: destinatarios.length }, 'Alerta de aprovacao enviado');
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar email de aprovacao pendente');
  }
}

/**
 * Notifica admin/gestor quando OMIE deixa uma movimentacao em estado parcial
 * (status_omie='pendente_q2p' ou 'pendente_acxe_faltando'). Acao esperada:
 * acessar painel de operacoes pendentes e retentar.
 */
export async function enviarAlertaPendenciaOmie(args: {
  movimentacaoId: string;
  opId: string;
  notaFiscal: string;
  ladoPendente: 'q2p' | 'acxe-faltando';
  mensagemErro: string;
  tentativas: number;
}): Promise<void> {
  const to = getAdminEmail();
  const config = getConfig();
  const linkPainel = `${config.APP_URL}/stockbridge/operacoes-pendentes`;
  const ladoLabel = args.ladoPendente === 'q2p' ? 'OMIE Q2P' : 'OMIE ACXE (transferencia diferenca)';
  const subject = `StockBridge — ⚠ Pendencia OMIE (NF ${args.notaFiscal})`;
  const html = `
    <h2 style="color: #D97706;">Operacao OMIE pendente</h2>
    <p>O recebimento abaixo ficou em estado parcial — a chamada inicial sucedeu mas a continuacao falhou. Nada foi perdido; basta retentar.</p>
    <ul>
      <li><strong>NF:</strong> ${args.notaFiscal}</li>
      <li><strong>Lado pendente:</strong> ${ladoLabel}</li>
      <li><strong>Tentativas ja feitas:</strong> ${args.tentativas}</li>
      <li><strong>Erro reportado:</strong> ${args.mensagemErro}</li>
    </ul>
    <p style="margin:16px 0;">
      <a href="${linkPainel}"
         style="display:inline-block;padding:10px 20px;background:#0077cc;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
        Abrir painel de operacoes pendentes →
      </a>
    </p>
    <p style="color:#888;font-size:11px;">Movimentacao: ${args.movimentacaoId} · op_id: ${args.opId}</p>
    <p style="color:#888;font-size:11px;">Sistema Atlas — StockBridge</p>
  `;
  try {
    await sendEmail({ to, subject, html });
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar email de pendencia OMIE');
  }
}

/**
 * Resolve o email do usuario operador pelo id. Retorna null se nao encontrado
 * ou sem email — caller deve tratar fallback.
 */
export async function resolverEmailOperador(userId: string): Promise<string | null> {
  try {
    const db = getDb();
    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.email ?? null;
  } catch (err) {
    logger.warn({ err: (err as Error).message, userId }, 'Falha ao resolver email do operador');
    return null;
  }
}

/**
 * Notifica o operador que lancou a pendencia quando o gestor/diretor rejeita.
 * Inclui o motivo textual para o operador corrigir antes de re-submeter.
 */
export async function enviarNotificacaoRejeicaoOperador(args: {
  operadorUserId: string;
  aprovacaoId: string;
  loteId: string;
  motivo: string;
  /**
   * Define qual pagina o link do email aponta:
   *  - 'recebimento': /stockbridge/recebimento#rejeicao=<id> (re-submeter divergencia)
   *  - 'saida_manual': /stockbridge/saida-manual#rejeicao=<id> (re-lancar saida)
   */
  fluxo: 'recebimento' | 'saida_manual';
  tipoAprovacao: string;
}): Promise<void> {
  const to = await resolverEmailOperador(args.operadorUserId);
  if (!to) {
    logger.warn({ args }, 'Operador sem email cadastrado — notificacao de rejeicao nao enviada');
    return;
  }
  const subject = `StockBridge — Seu lancamento foi rejeitado`;
  const config = getConfig();
  const paginaPath = args.fluxo === 'recebimento' ? '/stockbridge/recebimento' : '/stockbridge/saida-manual';
  const paginaLabel = args.fluxo === 'recebimento' ? 'Recebimento' : 'Saída Manual';
  const acaoLabel = args.fluxo === 'recebimento' ? 'Re-submeter agora' : 'Lançar novamente';
  const link = `${config.APP_URL}${paginaPath}#rejeicao=${args.aprovacaoId}`;
  const html = `
    <h2 style="color: #dc3545;">Lancamento Rejeitado</h2>
    <p>O gestor/diretor rejeitou um lancamento (${args.tipoAprovacao}) que voce fez no StockBridge.</p>
    <p><strong>Motivo informado:</strong></p>
    <blockquote style="border-left:3px solid #dc3545;padding-left:12px;color:#555;margin:8px 0;">
      "${args.motivo}"
    </blockquote>
    <p>Corrija os dados e ${args.fluxo === 'recebimento' ? 're-submeta para nova aprovacao' : 'lance novamente'}:</p>
    <p style="margin:16px 0;">
      <a href="${link}"
         style="display:inline-block;padding:10px 20px;background:#0077cc;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
        ${acaoLabel} →
      </a>
    </p>
    <p style="color:#888;font-size:11px;">Ou abra a tela de ${paginaLabel} no StockBridge e procure pela secao "Lancamentos rejeitados".</p>
    <p style="color:#888;font-size:11px;">Aprovacao id: ${args.aprovacaoId}</p>
    <p style="color:#888;font-size:11px;">Sistema Atlas — StockBridge</p>
  `;
  try {
    await sendEmail({ to, cc: config.STOCKBRIDGE_ADMIN_CC_EMAIL || undefined, subject, html });
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar email de rejeicao ao operador');
  }
}

/**
 * Notifica o operador que lancou a pendencia quando o gestor/diretor aprova.
 * Principalmente util para recebimento com divergencia — confirma que o ajuste
 * no OMIE foi feito e o saldo ja esta refletido.
 */
export async function enviarNotificacaoAprovacaoOperador(args: {
  operadorUserId: string;
  aprovacaoId: string;
  tipoAprovacao: string;
  loteId: string;
  /**
   * True quando se trata de um recebimento divergente concluido com SUCESSO (gestor
   * aprovou + ambos os lados OMIE ok). Nesse caso a caixa de Comex entra em copia —
   * o estoque efetivamente entrou. Nao usar em saidas nem quando ha pendencia OMIE.
   */
  incluirComex?: boolean;
}): Promise<void> {
  const to = await resolverEmailOperador(args.operadorUserId);
  if (!to) {
    logger.warn({ args }, 'Operador sem email cadastrado — notificacao de aprovacao nao enviada');
    return;
  }
  const subject = `StockBridge — Seu lancamento foi aprovado`;
  const extraDivergencia =
    args.tipoAprovacao === 'recebimento_divergencia'
      ? '<p>O ajuste foi registrado automaticamente na OMIE (ACXE + Q2P) com a quantidade aprovada.</p>'
      : '';
  const html = `
    <h2 style="color: #198754;">Lancamento Aprovado</h2>
    <p>Um lancamento que voce fez no StockBridge foi aprovado pelo gestor/diretor.</p>
    <p><strong>Tipo:</strong> ${args.tipoAprovacao}</p>
    ${extraDivergencia}
    <p style="color:#888;font-size:11px;">Aprovacao id: ${args.aprovacaoId} · Lote: ${args.loteId}</p>
    <p style="color:#888;font-size:11px;">Sistema Atlas — StockBridge</p>
  `;
  try {
    const ccList = [
      ...new Set(
        [getConfig().STOCKBRIDGE_ADMIN_CC_EMAIL, args.incluirComex ? getComexEmail() : null].filter(
          (e): e is string => !!e,
        ),
      ),
    ];
    await sendEmail({ to, cc: ccList.length > 0 ? ccList : undefined, subject, html });
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar email de aprovacao ao operador');
  }
}

/**
 * Notifica que um recebimento de NF foi concluido com SUCESSO e sem divergencia
 * (ambos os lados OMIE ok, lote provisorio gravado). Destinatarios: operador que
 * lancou + gestores do modulo + caixa de Comex da ACXE. Um email por destinatario
 * (evita vazar a lista no campo To). Caso haja divergencia ou pendencia OMIE, este
 * email NAO e disparado — esses fluxos tem notificacoes proprias.
 */
export async function enviarNotificacaoRecebimentoConcluido(args: {
  operadorUserId: string;
  loteCodigo: string;
  notaFiscal: string;
  produto: string;
  quantidadeKg: number;
  fornecedor: string | null;
  localidade: string;
}): Promise<void> {
  const [emailOperador, gestores] = await Promise.all([
    resolverEmailOperador(args.operadorUserId),
    resolverEmailsAprovadores('gestor'),
  ]);
  const destinatarios = [
    ...new Set([emailOperador, ...gestores, getComexEmail()].filter((e): e is string => !!e)),
  ];
  if (destinatarios.length === 0) {
    logger.warn({ notaFiscal: args.notaFiscal }, 'Nenhum destinatario para confirmacao de recebimento');
    return;
  }
  const subject = `StockBridge — Recebimento concluido (NF ${args.notaFiscal})`;
  const html = `
    <h2 style="color: #198754;">Recebimento concluido</h2>
    <p>O recebimento da <strong>NF ${args.notaFiscal}</strong> foi registrado no StockBridge sem divergencias. O ajuste de estoque ja foi aplicado na OMIE (ACXE + Q2P).</p>
    <ul>
      <li><strong>Lote:</strong> ${args.loteCodigo}</li>
      <li><strong>Produto:</strong> ${args.produto}</li>
      <li><strong>Quantidade recebida:</strong> ${args.quantidadeKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg</li>
      <li><strong>Fornecedor:</strong> ${args.fornecedor ?? '—'}</li>
      <li><strong>Local de destino:</strong> ${args.localidade}</li>
    </ul>
    <p style="color:#888;font-size:11px;">Sistema Atlas — StockBridge</p>
  `;
  try {
    await Promise.allSettled(destinatarios.map((to) => sendEmail({ to, subject, html })));
    logger.info(
      { notaFiscal: args.notaFiscal, destinatarios: destinatarios.length },
      'Confirmacao de recebimento concluido enviada',
    );
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar confirmacao de recebimento concluido');
  }
}

/**
 * Alerta de comodato vencido. Disparado pelo cron diario apenas nos dias de
 * notificacao definidos pela escala (D+1, D+15, D+30, D+45, ...).
 * Caller decide os destinatarios — D+1 vai pro operador+gestor; D>=15 escala
 * incluindo diretor.
 */
export async function enviarAlertaComodatoVencido(args: {
  movimentacaoId: string;
  destinatarios: string[];
  cliente: string | null;
  produtoCodigoAcxe: number;
  produtoDescricao: string;
  quantidadeKg: number;
  galpaoOrigem: string;
  dtSaida: string;
  dtPrevistaRetorno: string;
  diasVencido: number;
  /** 'inicial' (D+1) ou 'escalada' (D>=15) — muda o tom do email. */
  fase: 'inicial' | 'escalada';
}): Promise<void> {
  if (args.destinatarios.length === 0) {
    logger.warn({ movimentacaoId: args.movimentacaoId }, 'Nenhum destinatario pro alerta de comodato vencido');
    return;
  }
  const config = getConfig();
  const linkPainel = `${config.APP_URL ?? ''}/stockbridge/comodato-retorno`;
  const fmtDataBr = (d: string) => {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : d;
  };
  const tagFase = args.fase === 'escalada' ? '⚠ ESCALADO' : '⚠';
  const subject = `StockBridge — ${tagFase} Comodato vencido há ${args.diasVencido}d (${args.cliente ?? 'cliente s/n'})`;
  const corHeader = args.fase === 'escalada' ? '#b91c1c' : '#D97706';
  const html = `
    <h2 style="color: ${corHeader};">Comodato vencido — acao necessaria</h2>
    <p>O comodato abaixo passou da data prevista de retorno e segue em aberto há <strong>${args.diasVencido} dia${args.diasVencido === 1 ? '' : 's'}</strong>.</p>
    <ul>
      <li><strong>Cliente:</strong> ${args.cliente ?? '— sem cliente registrado —'}</li>
      <li><strong>Produto:</strong> ${args.produtoDescricao} (SKU ${args.produtoCodigoAcxe})</li>
      <li><strong>Quantidade:</strong> ${args.quantidadeKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg</li>
      <li><strong>Galpão de origem:</strong> ${args.galpaoOrigem}</li>
      <li><strong>Saída em:</strong> ${fmtDataBr(args.dtSaida)}</li>
      <li><strong>Retorno previsto:</strong> ${fmtDataBr(args.dtPrevistaRetorno)}</li>
    </ul>
    <p style="margin:16px 0;">
      <a href="${linkPainel}"
         style="display:inline-block;padding:10px 20px;background:#0077cc;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
        Abrir Retorno de Comodato →
      </a>
    </p>
    ${args.fase === 'escalada' ? '<p style="color:#b91c1c;"><strong>Esta notificacao foi escalada para a diretoria por ultrapassar 15 dias de atraso.</strong> Notificacoes seguem ocorrendo a cada 15 dias enquanto o comodato permanecer em aberto.</p>' : ''}
    <p style="color:#888;font-size:11px;">Movimentacao: ${args.movimentacaoId}</p>
    <p style="color:#888;font-size:11px;">Sistema Atlas — StockBridge</p>
  `;
  try {
    await Promise.allSettled(args.destinatarios.map((to) => sendEmail({ to, subject, html })));
    logger.info(
      { movimentacaoId: args.movimentacaoId, diasVencido: args.diasVencido, destinatarios: args.destinatarios.length, fase: args.fase },
      'Alerta de comodato vencido enviado',
    );
  } catch (err) {
    logger.error({ err, movimentacaoId: args.movimentacaoId }, 'Falha ao enviar alerta comodato vencido');
  }
}

