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
    // EML-21: remetente com nome amigável (alinha ao padrão dos workflows n8n).
    // O guard acima já estreitou SENDGRID_FROM_EMAIL para string.
    from: { email: config.SENDGRID_FROM_EMAIL, name: 'Plataforma Atlas' },
    subject: options.subject,
    html: options.html,
    text: options.text,
  });

  logger.info({ to: options.to, cc, subject: options.subject }, 'Email sent');
}

const ATLAS_ASSINATURA = 'E-mail automático gerado pela Plataforma Atlas · ACXE + Q2P';

/**
 * Cor do header por semântica — mesma paleta dos e-mails dos workflows n8n
 * (ACXEGDP-294), para que toda a comunicação da empresa tenha a mesma cara.
 */
export type EmailVariante = 'info' | 'sucesso' | 'erro' | 'alerta';

const VARIANTE_COR: Record<EmailVariante, string> = {
  info: '#1f2937',
  sucesso: '#065f46',
  erro: '#991b1b',
  alerta: '#9a3412',
};

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
  /**
   * Semântica do e-mail — define a cor do header (ACXEGDP-294). Default 'info'.
   * 'sucesso' verde · 'erro' vermelho · 'alerta' âmbar · 'info' neutro.
   */
  variante?: EmailVariante;
  /** Rótulo do botão de ação (CTA). Requer ctaUrl. */
  ctaLabel?: string;
  /** URL do botão de ação. */
  ctaUrl?: string;
  /** Versão texto puro; se ausente, é derivada do título + corpo. */
  textoAlternativo?: string;
}

/**
 * Card de dados chave→valor no padrão estético (#f9fafb, ACXEGDP-294). Substitui
 * `<ul><li>` cru. Rótulos e valores são escapados; itens com valor vazio/nulo
 * são omitidos (evita "Fornecedor: —" e cards vazios — EML-04/05).
 */
export function emailDataList(
  items: Array<{ label: string; valor: string | number | null | undefined }>,
): string {
  const rows = items
    .filter((i) => i.valor !== '' && i.valor !== null && i.valor !== undefined)
    .map(
      (i) =>
        `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top;white-space:nowrap;">${escapeHtml(i.label)}</td><td style="padding:6px 0 6px 20px;color:#111827;font-size:14px;font-weight:600;">${escapeHtml(i.valor)}</td></tr>`,
    )
    .join('');
  if (!rows) return '';
  return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 16px;margin:16px 0;"><table role="presentation" width="100%" style="border-collapse:collapse;"><tbody>${rows}</tbody></table></div>`;
}

/**
 * Caixa âmbar "Ação necessária" (ACXEGDP-294). `html` é conteúdo já montado
 * (pode conter <ol>/<li> ou texto) — o chamador escapa os valores dinâmicos.
 */
export function emailActionBox(html: string, titulo = 'Ação necessária'): string {
  return `<div style="background:#fffbeb;border:1px solid #fcd34d;border-left:4px solid #d97706;border-radius:8px;padding:14px 16px;margin:16px 0;"><div style="font-weight:700;color:#92400e;font-size:13px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:8px;">${escapeHtml(titulo)}</div><div style="color:#78350f;font-size:14px;line-height:1.6;">${html}</div></div>`;
}

/**
 * Container HTML padrão dos e-mails do Atlas (EML-06, ACXEGDP-250) alinhado ao
 * padrão estético dos workflows n8n (ACXEGDP-294): container 700px, header
 * colorido por semântica, corpo, CTA azul (#1d4ed8) e rodapé único. Retorna
 * { html, text } — a versão text/plain melhora entregabilidade (EML-15).
 */
export function buildEmailLayout(opts: EmailLayoutOptions): { html: string; text: string } {
  const headerCor = VARIANTE_COR[opts.variante ?? 'info'];
  const cta =
    opts.ctaLabel && opts.ctaUrl
      ? `<a href="${escapeHtml(opts.ctaUrl)}" style="display:inline-block;margin:8px 0 4px;padding:12px 24px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">${escapeHtml(opts.ctaLabel)}</a>`
      : '';

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f5f7;padding:24px;font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:700px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="background:${headerCor};padding:18px 28px;">
      <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:0.5px;">Atlas</span>
      <span style="color:rgba(255,255,255,0.7);font-size:13px;font-weight:500;"> · StockBridge</span>
    </div>
    <div style="padding:28px;color:#111827;">
      <h1 style="font-size:20px;margin:0 0 16px;color:#111827;">${escapeHtml(opts.titulo)}</h1>
      <div style="font-size:14px;line-height:1.6;color:#374151;">${opts.corpoHtml}</div>
      ${cta}
    </div>
    <div style="padding:16px 28px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;">${ATLAS_ASSINATURA}</div>
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
