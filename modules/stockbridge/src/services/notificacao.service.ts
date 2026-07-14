import { sendEmail, createLogger, getConfig, getDb, buildEmailLayout, escapeHtml, emailDataList, emailActionBox } from '@atlas/core';
import { users, userModules } from '@atlas/db';
import { eq, inArray, and, isNull } from 'drizzle-orm';

const logger = createLogger('stockbridge:notificacao');

// Fallback ENTREGÁVEL (EML-08) — antes era 'admin@atlas.local', não-entregável,
// então o alerta simplesmente sumia. Só usado se as envs não estiverem setadas.
const ADMIN_FALLBACK_EMAIL = 'flavio.endo@acxe-polimeros.com.br';
const COMEX_FALLBACK_EMAIL = 'comex_acxe@acxe-polimeros.com.br';

/**
 * Rótulos legíveis dos tipos de aprovação — evita expor o enum snake_case cru
 * ao usuário no assunto/corpo do e-mail (EML-03, ACXEGDP-252). Espelha os labels
 * usados na tela de aprovações (AprovacoesPage).
 */
const TIPO_APROVACAO_LABEL: Record<string, string> = {
  recebimento_divergencia: 'Recebimento com divergência',
  entrada_manual: 'Entrada manual',
  entrada_nacional: 'Entrada nacional',
  compra_nacional: 'Compra nacional',
  saida_transf_intra: 'Transferência intra-CNPJ',
  transf_intra_cnpj: 'Transferência intra-CNPJ',
  saida_comodato: 'Comodato',
  saida_amostra: 'Amostra/Brinde',
  saida_descarte: 'Descarte/Perda',
  saida_quebra: 'Quebra técnica',
  saida_troca: 'Troca',
  ajuste_inventario: 'Ajuste de inventário',
  retorno_comodato: 'Retorno de comodato',
};

function labelTipoAprovacao(tipo: string | null | undefined): string {
  if (!tipo) return '—';
  return TIPO_APROVACAO_LABEL[tipo] ?? tipo.replace(/_/g, ' ');
}

/** Formata quantidade em kg no padrão pt-BR (sem casas decimais). */
function fmtKg(kg: number): string {
  return `${kg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg`;
}

/**
 * EML-10: inspeciona o resultado de um Promise.allSettled de envios e loga UM
 * error por destinatário que falhou (com o motivo), em vez de só contar. Retorna
 * o número de falhas — o caller usa pra decidir se ainda houve algum sucesso
 * antes de logar o info (evita "enviado com sucesso" quando 100% falhou).
 */
function logFalhasEnvio(
  results: PromiseSettledResult<unknown>[],
  destinatarios: string[],
  ctx: Record<string, unknown>,
): number {
  let falhas = 0;
  results.forEach((r, i) => {
    if (r.status !== 'rejected') return;
    falhas += 1;
    const reason = r.reason as Error | undefined;
    logger.error({ ...ctx, to: destinatarios[i], motivo: reason?.message ?? String(r.reason) }, 'Falha ao enviar e-mail para destinatário');
  });
  return falhas;
}

function getAdminEmail(): string {
  const config = getConfig();
  return config.SEED_ADMIN_EMAIL ?? ADMIN_FALLBACK_EMAIL;
}

/**
 * Caixa operacional dos alertas de exceção do StockBridge (EML-08). Destino
 * canônico (To) dos 4 alertas ops; o admin entra em CC via alertaOpsCc().
 */
function getOpsEmail(): string {
  return getConfig().STOCKBRIDGE_OPS_EMAIL ?? ADMIN_FALLBACK_EMAIL;
}

/** Admin em CC dos alertas ops, se configurado e diferente do To. */
function alertaOpsCc(to: string): string | undefined {
  const admin = getConfig().SEED_ADMIN_EMAIL;
  return admin && admin.toLowerCase() !== to.toLowerCase() ? admin : undefined;
}

/** Caixa de Comex da ACXE — copiada em todo recebimento concluido com sucesso. */
function getComexEmail(): string {
  return getConfig().STOCKBRIDGE_COMEX_EMAIL ?? COMEX_FALLBACK_EMAIL;
}

/**
 * Resolve emails dos usuarios ATIVOS com perfil compativel + acesso ao modulo.
 *  - nivel='gestor':  so gestor (diretor *pode* aprovar tudo, mas nao quer email
 *    de cada saida do dia a dia — so e notificado quando a pendencia exige
 *    nivel='diretor' de fato).
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
  const to = getOpsEmail();
  const subject = `StockBridge — Produto sem correlato Q2P (NF ${args.notaFiscal})`;
  const corpoHtml = `
    <p>Durante o recebimento da <strong>NF ${escapeHtml(args.notaFiscal)}</strong>, o produto abaixo não possui correlato cadastrado na Q2P (correspondência por descrição textual).</p>
    ${emailDataList([
      { label: 'Código ACXE', valor: args.codigoProdutoAcxe },
      { label: 'Descrição ACXE', valor: args.descricaoProduto },
    ])}
    ${emailActionBox(`
      <ol style="margin:0;padding-left:18px;">
        <li>Cadastrar o produto correspondente na Q2P com a <strong>descrição exata</strong> do ACXE.</li>
        <li>Aguardar a sincronização (próximo ciclo do n8n).</li>
        <li>Tentar novamente o recebimento no StockBridge.</li>
      </ol>`)}
  `;
  const { html, text } = buildEmailLayout({
    titulo: 'Produto não encontrado na Q2P',
    variante: 'alerta',
    corpoHtml,
  });
  try {
    await sendEmail({ to, cc: alertaOpsCc(to), subject, html, text });
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
/**
 * STK-10 (ACXEGDP-289): NF multi-item rejeitada no recebimento — o modelo
 * suporta 1 produto por NF. O admin decide como processar (manual no OMIE ou
 * desdobrar a NF).
 */
export async function enviarAlertaNfMultiItem(args: {
  nf: string;
  cnpj: 'acxe' | 'q2p';
  totalItens: number;
}): Promise<void> {
  const to = getOpsEmail();
  const subject = `StockBridge — NF ${args.nf} com ${args.totalItens} itens bloqueada no recebimento (${args.cnpj.toUpperCase()})`;
  const corpoHtml = `
    <p>O recebimento da <strong>NF ${escapeHtml(args.nf)}</strong> (${args.cnpj.toUpperCase()}) foi <strong>bloqueado</strong>: a NF tem <strong>${args.totalItens} itens</strong> de produto e o StockBridge suporta apenas NF de item único.</p>
    ${emailDataList([
      { label: 'NF', valor: args.nf },
      { label: 'Itens', valor: String(args.totalItens) },
    ])}
    ${emailActionBox(`
      <ol style="margin:0;padding-left:18px;">
        <li>Conferir a NF ${escapeHtml(args.nf)} no OMIE.</li>
        <li>Processar a entrada manualmente no OMIE ou desdobrar a NF por item.</li>
      </ol>`)}
  `;
  const { html, text } = buildEmailLayout({
    titulo: 'NF multi-item bloqueada no recebimento',
    variante: 'alerta',
    corpoHtml,
  });
  try {
    await sendEmail({ to, cc: alertaOpsCc(to), subject, html, text });
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar email de alerta de NF multi-item');
  }
}

export async function enviarAlertaNfIndeterminada(args: {
  nf: string;
  cnpj: 'acxe' | 'q2p';
  motivo: string;
}): Promise<void> {
  const to = getOpsEmail();
  const subject = `StockBridge — NF ${args.nf} recebida com dado indeterminado (${args.cnpj.toUpperCase()})`;
  const corpoHtml = `
    <p>O recebimento da <strong>NF ${escapeHtml(args.nf)}</strong> (${args.cnpj.toUpperCase()}) foi <strong>liberado</strong>, mas o sistema não conseguiu determinar com segurança um dos sinais da NF no OMIE.</p>
    ${emailDataList([{ label: 'Motivo', valor: args.motivo }])}
    ${emailActionBox(`
      <ol style="margin:0;padding-left:18px;">
        <li>Conferir no OMIE se a NF ${escapeHtml(args.nf)} está válida e foi emitida pela empresa correta.</li>
        <li>Se houver irregularidade (cancelada ou emitente errado), estornar o recebimento no StockBridge.</li>
      </ol>`)}
  `;
  const { html, text } = buildEmailLayout({
    titulo: 'NF recebida sem validação completa',
    variante: 'alerta',
    corpoHtml,
  });
  try {
    await sendEmail({ to, cc: alertaOpsCc(to), subject, html, text });
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
  const to = getOpsEmail();
  const subject = `StockBridge — Débito cruzado (NF ${args.notaFiscal})`;
  const corpoHtml = `
    <p>Uma NF de saída gerou <strong>divergência cruzada</strong> entre o CNPJ emissor e o CNPJ onde está o estoque físico.</p>
    ${emailDataList([
      { label: 'NF', valor: args.notaFiscal },
      { label: 'Emissor (faturou)', valor: args.cnpjEmissor.toUpperCase() },
      { label: 'Físico (estoque real)', valor: args.cnpjFisico.toUpperCase() },
      { label: 'Quantidade', valor: fmtKg(args.quantidadeKg) },
    ])}
    ${emailActionBox(
      `O setor contábil deve emitir a NF de transferência <strong>${args.cnpjFisico.toUpperCase()} → ${args.cnpjEmissor.toUpperCase()}</strong> para regularizar a posição fiscal. A divergência será fechada automaticamente quando a NF de regularização for processada.`,
    )}
  `;
  const { html, text } = buildEmailLayout({ titulo: 'Débito cruzado detectado', variante: 'alerta', corpoHtml });
  try {
    await sendEmail({ to, cc: alertaOpsCc(to), subject, html, text });
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
  const linkPainel = `${config.APP_URL}/stockbridge/aprovacoes`;
  const tipoLabel = labelTipoAprovacao(args.tipoAprovacao);
  const subject = `StockBridge — Aprovação pendente (${args.nivel}) — ${tipoLabel}`;
  const corpoHtml = `
    <p>Uma nova pendência aguarda sua aprovação no StockBridge.</p>
    ${emailDataList([
      { label: 'Tipo', valor: tipoLabel },
      { label: 'Item', valor: `${args.loteCodigo} — ${args.produto}` },
      { label: 'Quantidade', valor: fmtKg(args.quantidadeKg) },
      { label: 'Detalhes', valor: args.detalhes ?? '' },
    ])}
  `;
  const { html, text } = buildEmailLayout({
    titulo: 'Nova pendência de aprovação',
    variante: 'info',
    corpoHtml,
    ctaLabel: 'Abrir aprovações pendentes',
    ctaUrl: linkPainel,
  });
  try {
    // Envia 1 email por destinatario pra evitar vazar lista (To: ficaria visivel)
    const results = await Promise.allSettled(destinatarios.map((to) => sendEmail({ to, subject, html, text })));
    const falhas = logFalhasEnvio(results, destinatarios, { aprovacaoId: args.aprovacaoId });
    if (falhas < destinatarios.length) {
      logger.info({ aprovacaoId: args.aprovacaoId, enviados: destinatarios.length - falhas, falhas }, 'Alerta de aprovacao enviado');
    }
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar email de aprovacao pendente');
  }
}

/**
 * EML-09: digest de aprovação pendente para um recebimento nacional inteiro.
 * Antes, o recebimento disparava enviarAlertaAprovacaoPendente() por item — N
 * itens × M gestores = N×M e-mails para a MESMA NF. Aqui os itens vão numa única
 * tabela e cada gestor recebe 1 e-mail por NF.
 */
export async function enviarAlertaRecebimentoNacionalLote(args: {
  notaFiscal: string;
  nivel: 'gestor' | 'diretor';
  itens: Array<{ produto: string; empresa: string; galpao: string; quantidadeKg: number }>;
  detalhes?: string;
}): Promise<void> {
  if (args.itens.length === 0) return;
  const destinatarios = await resolverEmailsAprovadores(args.nivel);
  if (destinatarios.length === 0) return;
  const config = getConfig();
  const linkPainel = `${config.APP_URL}/stockbridge/aprovacoes`;
  const n = args.itens.length;
  const plural = n === 1 ? 'item' : 'itens';
  const subject = `StockBridge — Recebimento nacional NF ${args.notaFiscal}: ${n} ${plural} aguardando aprovação`;
  const linhas = args.itens
    .map(
      (it) => `<tr>
        <td style="padding:6px 12px 6px 0;font-size:13px;color:#111827;">${escapeHtml(it.produto)}</td>
        <td style="padding:6px 12px;font-size:13px;color:#6b7280;white-space:nowrap;">${escapeHtml(it.empresa.toUpperCase())} · ${escapeHtml(it.galpao)}</td>
        <td style="padding:6px 0 6px 12px;font-size:13px;color:#111827;font-weight:600;text-align:right;white-space:nowrap;">${fmtKg(it.quantidadeKg)}</td>
      </tr>`,
    )
    .join('');
  const corpoHtml = `
    <p>O recebimento nacional da <strong>NF ${escapeHtml(args.notaFiscal)}</strong> tem <strong>${n} ${plural}</strong> aguardando aprovação.</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 16px;margin:16px 0;">
      <table role="presentation" width="100%" style="border-collapse:collapse;">
        <thead><tr>
          <th style="text-align:left;padding:4px 12px 8px 0;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#9ca3af;">Produto</th>
          <th style="text-align:left;padding:4px 12px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#9ca3af;">Empresa · Galpão</th>
          <th style="text-align:right;padding:4px 0 8px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#9ca3af;">Quantidade</th>
        </tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>
    ${args.detalhes ? `<p style="color:#6b7280;font-size:13px;">${escapeHtml(args.detalhes)}</p>` : ''}
  `;
  const { html, text } = buildEmailLayout({
    titulo: 'Recebimento nacional aguardando aprovação',
    variante: 'info',
    corpoHtml,
    ctaLabel: 'Abrir aprovações pendentes',
    ctaUrl: linkPainel,
  });
  try {
    const results = await Promise.allSettled(destinatarios.map((to) => sendEmail({ to, subject, html, text })));
    const falhas = logFalhasEnvio(results, destinatarios, { notaFiscal: args.notaFiscal });
    if (falhas < destinatarios.length) {
      logger.info({ notaFiscal: args.notaFiscal, itens: n, enviados: destinatarios.length - falhas, falhas }, 'Digest de recebimento nacional enviado');
    }
  } catch (err) {
    logger.error({ err, notaFiscal: args.notaFiscal }, 'Falha ao enviar digest de recebimento nacional');
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
  const to = getOpsEmail();
  const config = getConfig();
  const linkPainel = `${config.APP_URL}/stockbridge/operacoes-pendentes`;
  const ladoLabel = args.ladoPendente === 'q2p' ? 'OMIE Q2P' : 'OMIE ACXE (transferência da diferença)';
  const subject = `StockBridge — Pendência OMIE (NF ${args.notaFiscal})`;
  const corpoHtml = `
    <p>O recebimento abaixo ficou em estado parcial — a chamada inicial teve sucesso, mas a continuação falhou. Nada foi perdido; basta retentar.</p>
    ${emailDataList([
      { label: 'NF', valor: args.notaFiscal },
      { label: 'Lado pendente', valor: ladoLabel },
      { label: 'Tentativas já feitas', valor: args.tentativas },
      { label: 'Erro reportado', valor: args.mensagemErro },
    ])}
    <p style="color:#9ca3af;font-size:12px;margin-top:16px;">Detalhes técnicos — Movimentação: ${escapeHtml(args.movimentacaoId)} · op_id: ${escapeHtml(args.opId)}</p>
  `;
  const { html, text } = buildEmailLayout({
    titulo: 'Operação OMIE pendente',
    variante: 'erro',
    corpoHtml,
    ctaLabel: 'Abrir painel de operações pendentes',
    ctaUrl: linkPainel,
  });
  try {
    await sendEmail({ to, cc: alertaOpsCc(to), subject, html, text });
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
  const subject = `StockBridge — Seu lançamento foi rejeitado`;
  const config = getConfig();
  const paginaPath = args.fluxo === 'recebimento' ? '/stockbridge/recebimento' : '/stockbridge/saida-manual';
  const paginaLabel = args.fluxo === 'recebimento' ? 'Recebimento' : 'Saída Manual';
  const acaoLabel = args.fluxo === 'recebimento' ? 'Reenviar agora' : 'Lançar novamente';
  const link = `${config.APP_URL}${paginaPath}#rejeicao=${args.aprovacaoId}`;
  const tipoLabel = labelTipoAprovacao(args.tipoAprovacao);
  const corpoHtml = `
    <p>O gestor/diretor rejeitou um lançamento (${escapeHtml(tipoLabel)}) que você fez no StockBridge.</p>
    <p><strong>Motivo informado:</strong></p>
    <blockquote style="border-left:3px solid #dc2626;padding-left:12px;color:#555;margin:8px 0;">${escapeHtml(args.motivo)}</blockquote>
    <p>Corrija os dados e ${args.fluxo === 'recebimento' ? 'reenvie para nova aprovação' : 'lance novamente'}:</p>
    <p style="color:#6b7280;font-size:12px;margin-top:16px;">Você também pode abrir a tela de ${escapeHtml(paginaLabel)} no StockBridge e procurar pela seção "Lançamentos rejeitados". · Aprovação: ${escapeHtml(args.aprovacaoId)}</p>
  `;
  const { html, text } = buildEmailLayout({ titulo: 'Lançamento rejeitado', variante: 'erro', corpoHtml, ctaLabel: acaoLabel, ctaUrl: link });
  try {
    await sendEmail({ to, cc: config.STOCKBRIDGE_ADMIN_CC_EMAIL || undefined, subject, html, text });
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
  const subject = `StockBridge — Seu lançamento foi aprovado`;
  const tipoLabel = labelTipoAprovacao(args.tipoAprovacao);
  const extraDivergencia =
    args.tipoAprovacao === 'recebimento_divergencia'
      ? '<p>O ajuste foi registrado automaticamente no OMIE (ACXE + Q2P) com a quantidade aprovada.</p>'
      : '';
  const corpoHtml = `
    <p>Um lançamento que você fez no StockBridge foi aprovado pelo gestor/diretor.</p>
    <p><strong>Tipo:</strong> ${escapeHtml(tipoLabel)}</p>
    ${extraDivergencia}
    <p style="color:#6b7280;font-size:12px;margin-top:16px;">Aprovação: ${escapeHtml(args.aprovacaoId)} · Lote: ${escapeHtml(args.loteId)}</p>
  `;
  const { html, text } = buildEmailLayout({ titulo: 'Lançamento aprovado', variante: 'sucesso', corpoHtml });
  try {
    const ccList = [
      ...new Set(
        [getConfig().STOCKBRIDGE_ADMIN_CC_EMAIL, args.incluirComex ? getComexEmail() : null].filter(
          (e): e is string => !!e,
        ),
      ),
    ];
    await sendEmail({ to, cc: ccList.length > 0 ? ccList : undefined, subject, html, text });
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
  // EML-14: confirmação de recebimento LIMPO vai só para o operador que lançou +
  // caixa do Comex. Antes notificava TODOS os gestores a cada NF limpa (ruído —
  // os gestores acompanham pelo Cockpit/aprovações).
  const emailOperador = await resolverEmailOperador(args.operadorUserId);
  const destinatarios = [
    ...new Set([emailOperador, getComexEmail()].filter((e): e is string => !!e)),
  ];
  if (destinatarios.length === 0) {
    logger.warn({ notaFiscal: args.notaFiscal }, 'Nenhum destinatario para confirmacao de recebimento');
    return;
  }
  const subject = `StockBridge — Recebimento concluído (NF ${args.notaFiscal})`;
  const corpoHtml = `
    <p>O recebimento da <strong>NF ${escapeHtml(args.notaFiscal)}</strong> foi registrado no StockBridge sem divergências. O ajuste de estoque já foi aplicado no OMIE (ACXE + Q2P).</p>
    ${emailDataList([
      { label: 'Lote', valor: args.loteCodigo },
      { label: 'Produto', valor: args.produto },
      { label: 'Quantidade recebida', valor: fmtKg(args.quantidadeKg) },
      { label: 'Fornecedor', valor: args.fornecedor ?? '' },
      { label: 'Local de destino', valor: args.localidade },
    ])}
  `;
  const { html, text } = buildEmailLayout({ titulo: 'Recebimento concluído', variante: 'sucesso', corpoHtml });
  try {
    const results = await Promise.allSettled(destinatarios.map((to) => sendEmail({ to, subject, html, text })));
    const falhas = logFalhasEnvio(results, destinatarios, { notaFiscal: args.notaFiscal });
    if (falhas < destinatarios.length) {
      logger.info(
        { notaFiscal: args.notaFiscal, enviados: destinatarios.length - falhas, falhas },
        'Confirmacao de recebimento concluido enviada',
      );
    }
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar confirmacao de recebimento concluido');
  }
}

/** Item de um digest de comodatos vencidos (EML-13) — um por comodato em aberto. */
export interface ComodatoVencidoDigestItem {
  movimentacaoId: string;
  cliente: string | null;
  produtoCodigoAcxe: number;
  produtoDescricao: string;
  quantidadeKg: number;
  galpaoOrigem: string;
  dtSaida: string;
  dtPrevistaRetorno: string;
  diasVencido: number;
  /** 'inicial' (D+1) ou 'escalada' (D>=15). */
  fase: 'inicial' | 'escalada';
}

/**
 * EML-13: digest diário de comodatos vencidos por destinatário. Antes o cron
 * disparava 1 e-mail por comodato — um gestor com 10 comodatos vencidos no mesmo
 * dia de escala (D+15) recebia 10 e-mails. Aqui cada destinatário recebe 1
 * e-mail com todos os comodatos em que ele é notificado.
 */
export async function enviarDigestComodatosVencidos(args: {
  to: string;
  comodatos: ComodatoVencidoDigestItem[];
}): Promise<void> {
  if (args.comodatos.length === 0) return;
  const config = getConfig();
  const linkPainel = `${config.APP_URL}/stockbridge/comodato-retorno`;
  const fmtDataBr = (d: string) => {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : d;
  };
  const n = args.comodatos.length;
  const temEscalada = args.comodatos.some((c) => c.fase === 'escalada');
  const plural = n === 1 ? 'comodato vencido' : 'comodatos vencidos';
  const subject = `StockBridge — ${temEscalada ? '[Escalado] ' : ''}${n} ${plural} aguardando retorno`;
  const cards = [...args.comodatos]
    .sort((a, b) => b.diasVencido - a.diasVencido)
    .map(
      (c) => `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:10px 0;">
        <div style="font-size:14px;font-weight:600;color:#111827;">${escapeHtml(c.cliente ?? 'sem cliente informado')} · vencido há ${c.diasVencido} dia${c.diasVencido === 1 ? '' : 's'}${c.fase === 'escalada' ? ' <span style="color:#9a3412;font-weight:600;">(escalado)</span>' : ''}</div>
        <div style="font-size:13px;color:#374151;margin-top:4px;">${escapeHtml(c.produtoDescricao)} (SKU ${escapeHtml(c.produtoCodigoAcxe)}) — ${fmtKg(c.quantidadeKg)}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px;">Galpão ${escapeHtml(c.galpaoOrigem)} · saída ${fmtDataBr(c.dtSaida)} · retorno previsto ${fmtDataBr(c.dtPrevistaRetorno)}</div>
      </div>`,
    )
    .join('');
  const corpoHtml = `
    <p>Você tem <strong>${n} ${plural}</strong> em aberto além da data prevista de retorno.</p>
    ${cards}
    ${
      temEscalada
        ? emailActionBox(
            'Um ou mais comodatos estão vencidos há mais de 15 dias e foram escalados para a diretoria. As notificações se repetem a cada 15 dias enquanto seguirem em aberto.',
            'Escalado — atraso acima de 15 dias',
          )
        : ''
    }
  `;
  const { html, text } = buildEmailLayout({
    titulo: n === 1 ? 'Comodato vencido — ação necessária' : 'Comodatos vencidos — ação necessária',
    variante: 'alerta',
    corpoHtml,
    ctaLabel: 'Abrir Retorno de Comodato',
    ctaUrl: linkPainel,
  });
  try {
    await sendEmail({ to: args.to, subject, html, text });
    logger.info({ to: args.to, comodatos: n, escalada: temEscalada }, 'Digest de comodatos vencidos enviado');
  } catch (err) {
    logger.error({ err, to: args.to }, 'Falha ao enviar digest de comodatos vencidos');
  }
}
