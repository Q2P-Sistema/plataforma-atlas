import { sendEmail, createLogger, getConfig, getDb } from '@atlas/core';
import { users } from '@atlas/db';
import { eq } from 'drizzle-orm';

const logger = createLogger('stockbridge:notificacao');

const ADMIN_FALLBACK_EMAIL = 'admin@atlas.local';

function getAdminEmail(): string {
  const config = getConfig();
  return config.SEED_ADMIN_EMAIL ?? ADMIN_FALLBACK_EMAIL;
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
  const to = getAdminEmail(); // v1: envia ao admin; refinar com lista de gestores/diretores depois
  const subject = `StockBridge — Aprovacao pendente (${args.nivel}) — ${args.tipoAprovacao}`;
  const html = `
    <h2 style="color: #D97706;">Nova pendencia de aprovacao</h2>
    <p><strong>Tipo:</strong> ${args.tipoAprovacao}</p>
    <p><strong>Lote:</strong> ${args.loteCodigo} — ${args.produto} (${args.quantidadeKg.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kg)</p>
    ${args.detalhes ? `<p><strong>Detalhes:</strong> ${args.detalhes}</p>` : ''}
    <p>Acesse o painel de aprovacoes no StockBridge para revisar.</p>
    <p style="color:#888;font-size:11px;">Sistema Atlas — StockBridge</p>
  `;
  try {
    await sendEmail({ to, subject, html });
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
async function resolverEmailOperador(userId: string): Promise<string | null> {
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
}): Promise<void> {
  const to = await resolverEmailOperador(args.operadorUserId);
  if (!to) {
    logger.warn({ args }, 'Operador sem email cadastrado — notificacao de rejeicao nao enviada');
    return;
  }
  const subject = `StockBridge — Seu lancamento foi rejeitado`;
  const config = getConfig();
  const linkResubmeter = `${config.APP_URL}/stockbridge/recebimento#rejeicao=${args.aprovacaoId}`;
  const html = `
    <h2 style="color: #dc3545;">Lancamento Rejeitado</h2>
    <p>O gestor/diretor rejeitou um lancamento que voce fez no StockBridge.</p>
    <p><strong>Motivo informado:</strong></p>
    <blockquote style="border-left:3px solid #dc3545;padding-left:12px;color:#555;margin:8px 0;">
      "${args.motivo}"
    </blockquote>
    <p>Corrija os dados e re-submeta para nova aprovacao:</p>
    <p style="margin:16px 0;">
      <a href="${linkResubmeter}"
         style="display:inline-block;padding:10px 20px;background:#0077cc;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
        Re-submeter agora →
      </a>
    </p>
    <p style="color:#888;font-size:11px;">Ou abra a tela de Recebimento no StockBridge e procure pela secao "Lancamentos rejeitados".</p>
    <p style="color:#888;font-size:11px;">Aprovacao id: ${args.aprovacaoId} · Lote: ${args.loteId}</p>
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
    const cc = getConfig().STOCKBRIDGE_ADMIN_CC_EMAIL;
    await sendEmail({ to, cc: cc || undefined, subject, html });
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar email de aprovacao ao operador');
  }
}
