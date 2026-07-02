import { getConfig } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('email');

interface EmailOptions {
  to: string;
  cc?: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(options: EmailOptions): Promise<void> {
  const config = getConfig();

  // SendGrid retorna 400 se o mesmo endereco aparece em `to` e `cc` da mesma
  // personalizacao. Acontece quando STOCKBRIDGE_ADMIN_CC_EMAIL e o mesmo do
  // operador alvo (caso comum no inicio do roll-out, onde o admin atua como
  // operador tambem). Filtra antes de enviar.
  const toLower = options.to.toLowerCase();
  const ccList = options.cc ? (Array.isArray(options.cc) ? options.cc : [options.cc]) : [];
  const ccFiltered = ccList.filter((c) => c.toLowerCase() !== toLower);
  const cc = ccFiltered.length > 0 ? ccFiltered : undefined;

  if (!config.SENDGRID_API_KEY || !config.SENDGRID_FROM_EMAIL) {
    // Dev fallback: log instead of sending
    logger.info(
      { to: options.to, cc, subject: options.subject },
      `[DEV EMAIL] Would send email to ${options.to}`,
    );
    logger.info({ html: options.html }, '[DEV EMAIL] Content');
    return;
  }

  const sgMail = await import('@sendgrid/mail');
  sgMail.default.setApiKey(config.SENDGRID_API_KEY);

  await sgMail.default.send({
    to: options.to,
    cc,
    from: config.SENDGRID_FROM_EMAIL,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });

  logger.info({ to: options.to, cc, subject: options.subject }, 'Email sent');
}

const ATLAS_ASSINATURA = 'Plataforma Atlas — ACXE + Q2P';

/**
 * Escapa texto dinâmico (nome de produto, motivo do operador, mensagem de erro
 * do OMIE) antes de interpolar no HTML de um e-mail. Sem isso, um valor com
 * `<`, `&` ou tags quebra o layout ou injeta HTML arbitrário (EML-07, ACXEGDP-251).
 */
export function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EmailLayoutOptions {
  /** Título exibido no topo do corpo (texto puro — será escapado). */
  titulo: string;
  /**
   * HTML já montado do corpo (parágrafos, listas, tabelas de dados). Todo valor
   * dinâmico embutido aqui deve passar por escapeHtml() antes.
   */
  corpoHtml: string;
  /** Rótulo do botão de ação (CTA). Requer ctaUrl. */
  ctaLabel?: string;
  /** URL do botão de ação. */
  ctaUrl?: string;
  /** Versão texto puro; se ausente, é derivada do título + corpo. */
  textoAlternativo?: string;
}

/**
 * Container HTML padrão dos e-mails do Atlas (EML-06, ACXEGDP-250): header
 * "Atlas", corpo, botão de CTA opcional e rodapé/assinatura únicos. Retorna
 * { html, text } — a versão text/plain melhora entregabilidade e clientes sem
 * HTML (EML-15). Base reutilizável para migrar os templates do StockBridge.
 */
export function buildEmailLayout(opts: EmailLayoutOptions): { html: string; text: string } {
  const cta =
    opts.ctaLabel && opts.ctaUrl
      ? `<a href="${escapeHtml(opts.ctaUrl)}" style="display:inline-block;margin:24px 0;padding:12px 24px;background:#0077cc;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">${escapeHtml(opts.ctaLabel)}</a>`
      : '';

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f5f7;padding:24px;font-family:'DM Sans',Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="background:#1a1a2e;padding:20px 28px;">
      <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">Atlas</span>
    </div>
    <div style="padding:28px;color:#1a1a2e;">
      <h1 style="font-size:20px;margin:0 0 16px;color:#1a1a2e;">${escapeHtml(opts.titulo)}</h1>
      <div style="font-size:14px;line-height:1.6;color:#1a1a2e;">${opts.corpoHtml}</div>
      ${cta}
    </div>
    <div style="padding:16px 28px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;">${ATLAS_ASSINATURA}</div>
  </div>
</body>
</html>`;

  const text = opts.textoAlternativo ?? derivarTexto(opts);
  return { html, text };
}

/** Deriva uma versão text/plain legível a partir do corpo HTML. */
function derivarTexto(opts: EmailLayoutOptions): string {
  const corpo = opts.corpoHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const cta = opts.ctaLabel && opts.ctaUrl ? `\n\n${opts.ctaLabel}: ${opts.ctaUrl}` : '';
  return `${opts.titulo}\n\n${corpo}${cta}\n\n${ATLAS_ASSINATURA}`;
}

export function buildPasswordResetEmail(resetUrl: string): {
  subject: string;
  html: string;
  text: string;
} {
  const { html, text } = buildEmailLayout({
    titulo: 'Recuperação de senha',
    corpoHtml: `
      <p>Você solicitou a recuperação de senha da Plataforma Atlas. Clique no botão abaixo para definir uma nova senha:</p>
      <p style="color:#6b7280;font-size:12px;margin-top:24px;">Este link expira em 1 hora. Se você não solicitou a recuperação, ignore este e-mail.</p>
    `,
    ctaLabel: 'Redefinir senha',
    ctaUrl: resetUrl,
  });
  return { subject: 'Atlas — Recuperação de senha', html, text };
}
