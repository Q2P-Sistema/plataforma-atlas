import { sendEmail, createLogger, getConfig, getDb, buildEmailLayout, escapeHtml } from '@atlas/core';
import { users, userModules } from '@atlas/db';
import { eq, inArray, and, isNull } from 'drizzle-orm';

const logger = createLogger('stockbridge:notificacao');

const ADMIN_FALLBACK_EMAIL = 'admin@atlas.local';
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

/** Linha de item chave→valor; o valor dinâmico é escapado (EML-07). */
function li(label: string, valor: string | number): string {
  return `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(valor)}</li>`;
}

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
  const to = getAdminEmail();
  const subject = `StockBridge — Produto sem correlato Q2P (NF ${args.notaFiscal})`;
  const corpoHtml = `
    <p>Durante o recebimento da <strong>NF ${escapeHtml(args.notaFiscal)}</strong>, o produto abaixo não possui correlato cadastrado na Q2P (correspondência por descrição textual).</p>
    <ul>
      ${li('Código ACXE', args.codigoProdutoAcxe)}
      ${li('Descrição ACXE', args.descricaoProduto)}
    </ul>
    <p><strong>Ações esperadas:</strong></p>
    <ol>
      <li>Cadastrar o produto correspondente na Q2P com a <strong>descrição exata</strong> do ACXE.</li>
      <li>Aguardar a sincronização (próximo ciclo do n8n).</li>
      <li>Tentar novamente o recebimento no StockBridge.</li>
    </ol>
  `;
  const { html, text } = buildEmailLayout({
    titulo: 'Ação necessária: produto não encontrado na Q2P',
    corpoHtml,
  });
  try {
    await sendEmail({ to, subject, html, text });
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
  const corpoHtml = `
    <p>O recebimento da <strong>NF ${escapeHtml(args.nf)}</strong> (${args.cnpj.toUpperCase()}) foi <strong>liberado</strong>, mas o sistema não conseguiu determinar com segurança um dos sinais da NF no OMIE.</p>
    <ul>${li('Motivo', args.motivo)}</ul>
    <p><strong>Ações esperadas:</strong></p>
    <ol>
      <li>Conferir no OMIE se a NF ${escapeHtml(args.nf)} está válida e foi emitida pela empresa correta.</li>
      <li>Se houver irregularidade (cancelada ou emitente errado), estornar o recebimento no StockBridge.</li>
    </ol>
  `;
  const { html, text } = buildEmailLayout({
    titulo: 'Revisão necessária: NF recebida sem validação completa',
    corpoHtml,
  });
  try {
    await sendEmail({ to, subject, html, text });
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
  const subject = `StockBridge — Débito cruzado (NF ${args.notaFiscal})`;
  const corpoHtml = `
    <p>Uma NF de saída gerou <strong>divergência cruzada</strong> entre o CNPJ emissor e o CNPJ onde está o estoque físico.</p>
    <ul>
      ${li('NF', args.notaFiscal)}
      ${li('Emissor (faturou)', args.cnpjEmissor.toUpperCase())}
      ${li('Físico (estoque real)', args.cnpjFisico.toUpperCase())}
      ${li('Quantidade', fmtKg(args.quantidadeKg))}
    </ul>
    <p><strong>Ação esperada:</strong> o setor contábil deve emitir a NF de transferência
    ${args.cnpjFisico.toUpperCase()} → ${args.cnpjEmissor.toUpperCase()} para regularizar a posição fiscal.
    A divergência será fechada automaticamente quando a NF de regularização for processada.</p>
  `;
  const { html, text } = buildEmailLayout({ titulo: 'Débito cruzado detectado', corpoHtml });
  try {
    await sendEmail({ to, subject, html, text });
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
    <p><strong>Tipo:</strong> ${escapeHtml(tipoLabel)}</p>
    <p><strong>Item:</strong> ${escapeHtml(args.loteCodigo)} — ${escapeHtml(args.produto)} (${fmtKg(args.quantidadeKg)})</p>
    ${args.detalhes ? `<p><strong>Detalhes:</strong> ${escapeHtml(args.detalhes)}</p>` : ''}
  `;
  const { html, text } = buildEmailLayout({
    titulo: 'Nova pendência de aprovação',
    corpoHtml,
    ctaLabel: 'Abrir aprovações pendentes',
    ctaUrl: linkPainel,
  });
  try {
    // Envia 1 email por destinatario pra evitar vazar lista (To: ficaria visivel)
    const results = await Promise.allSettled(destinatarios.map((to) => sendEmail({ to, subject, html, text })));
    const falhas = results.filter((r) => r.status === 'rejected').length;
    if (falhas > 0) logger.error({ aprovacaoId: args.aprovacaoId, falhas }, 'Falha ao enviar parte dos emails de aprovacao pendente');
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
  const ladoLabel = args.ladoPendente === 'q2p' ? 'OMIE Q2P' : 'OMIE ACXE (transferência da diferença)';
  const subject = `StockBridge — Pendência OMIE (NF ${args.notaFiscal})`;
  const corpoHtml = `
    <p>O recebimento abaixo ficou em estado parcial — a chamada inicial teve sucesso, mas a continuação falhou. Nada foi perdido; basta retentar.</p>
    <ul>
      ${li('NF', args.notaFiscal)}
      ${li('Lado pendente', ladoLabel)}
      ${li('Tentativas já feitas', args.tentativas)}
      ${li('Erro reportado', args.mensagemErro)}
    </ul>
    <p style="color:#6b7280;font-size:12px;margin-top:16px;">Movimentação: ${escapeHtml(args.movimentacaoId)} · op_id: ${escapeHtml(args.opId)}</p>
  `;
  const { html, text } = buildEmailLayout({
    titulo: 'Operação OMIE pendente',
    corpoHtml,
    ctaLabel: 'Abrir painel de operações pendentes',
    ctaUrl: linkPainel,
  });
  try {
    await sendEmail({ to, subject, html, text });
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
  const { html, text } = buildEmailLayout({ titulo: 'Lançamento rejeitado', corpoHtml, ctaLabel: acaoLabel, ctaUrl: link });
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
  const { html, text } = buildEmailLayout({ titulo: 'Lançamento aprovado', corpoHtml });
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
  const subject = `StockBridge — Recebimento concluído (NF ${args.notaFiscal})`;
  const corpoHtml = `
    <p>O recebimento da <strong>NF ${escapeHtml(args.notaFiscal)}</strong> foi registrado no StockBridge sem divergências. O ajuste de estoque já foi aplicado no OMIE (ACXE + Q2P).</p>
    <ul>
      ${li('Lote', args.loteCodigo)}
      ${li('Produto', args.produto)}
      ${li('Quantidade recebida', fmtKg(args.quantidadeKg))}
      ${li('Fornecedor', args.fornecedor ?? '—')}
      ${li('Local de destino', args.localidade)}
    </ul>
  `;
  const { html, text } = buildEmailLayout({ titulo: 'Recebimento concluído', corpoHtml });
  try {
    const results = await Promise.allSettled(destinatarios.map((to) => sendEmail({ to, subject, html, text })));
    const falhas = results.filter((r) => r.status === 'rejected').length;
    if (falhas > 0) logger.error({ notaFiscal: args.notaFiscal, falhas }, 'Falha ao enviar parte das confirmacoes de recebimento');
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
  const linkPainel = `${config.APP_URL}/stockbridge/comodato-retorno`;
  const fmtDataBr = (d: string) => {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : d;
  };
  const tagFase = args.fase === 'escalada' ? '[Escalado] ' : '';
  const subject = `StockBridge — ${tagFase}Comodato vencido há ${args.diasVencido}d (${args.cliente ?? 'sem cliente'})`;
  const escalada = args.fase === 'escalada'
    ? '<p style="color:#b91c1c;"><strong>Esta notificação foi escalada para a diretoria por ultrapassar 15 dias de atraso.</strong> As notificações seguem ocorrendo a cada 15 dias enquanto o comodato permanecer em aberto.</p>'
    : '';
  const corpoHtml = `
    <p>O comodato abaixo passou da data prevista de retorno e segue em aberto há <strong>${args.diasVencido} dia${args.diasVencido === 1 ? '' : 's'}</strong>.</p>
    <ul>
      ${li('Cliente', args.cliente ?? 'sem cliente informado')}
      ${li('Produto', `${args.produtoDescricao} (SKU ${args.produtoCodigoAcxe})`)}
      ${li('Quantidade', fmtKg(args.quantidadeKg))}
      ${li('Galpão de origem', args.galpaoOrigem)}
      ${li('Saída em', fmtDataBr(args.dtSaida))}
      ${li('Retorno previsto', fmtDataBr(args.dtPrevistaRetorno))}
    </ul>
    ${escalada}
    <p style="color:#6b7280;font-size:12px;margin-top:16px;">Movimentação: ${escapeHtml(args.movimentacaoId)}</p>
  `;
  const { html, text } = buildEmailLayout({
    titulo: 'Comodato vencido — ação necessária',
    corpoHtml,
    ctaLabel: 'Abrir Retorno de Comodato',
    ctaUrl: linkPainel,
  });
  try {
    const results = await Promise.allSettled(args.destinatarios.map((to) => sendEmail({ to, subject, html, text })));
    const falhas = results.filter((r) => r.status === 'rejected').length;
    if (falhas > 0) logger.error({ movimentacaoId: args.movimentacaoId, falhas }, 'Falha ao enviar parte dos alertas de comodato');
    logger.info(
      { movimentacaoId: args.movimentacaoId, diasVencido: args.diasVencido, destinatarios: args.destinatarios.length, fase: args.fase },
      'Alerta de comodato vencido enviado',
    );
  } catch (err) {
    logger.error({ err, movimentacaoId: args.movimentacaoId }, 'Falha ao enviar alerta comodato vencido');
  }
}
