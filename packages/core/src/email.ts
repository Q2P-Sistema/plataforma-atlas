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

  if (!config.SENDGRID_API_KEY || !config.SENDGRID_FROM_EMAIL) {
    // Dev fallback: log instead of sending
    logger.info(
      { to: options.to, cc: options.cc, subject: options.subject },
      `[DEV EMAIL] Would send email to ${options.to}`,
    );
    logger.info({ html: options.html }, '[DEV EMAIL] Content');
    return;
  }

  const sgMail = await import('@sendgrid/mail');
  sgMail.default.setApiKey(config.SENDGRID_API_KEY);

  await sgMail.default.send({
    to: options.to,
    cc: options.cc,
    from: config.SENDGRID_FROM_EMAIL,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });

  logger.info({ to: options.to, cc: options.cc, subject: options.subject }, 'Email sent');
}

export function buildPasswordResetEmail(resetUrl: string): {
  subject: string;
  html: string;
  text: string;
} {
  return {
    subject: 'Atlas — Recuperacao de senha',
    html: `
      <div style="font-family: 'DM Sans', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h1 style="font-size: 24px; color: #1a1a2e; margin-bottom: 16px;">Atlas</h1>
        <p style="color: #1a1a2e; font-size: 14px; line-height: 1.6;">
          Voce solicitou a recuperacao de senha. Clique no link abaixo para definir uma nova senha:
        </p>
        <a href="${resetUrl}"
           style="display: inline-block; margin: 24px 0; padding: 12px 24px; background: #0077cc; color: #fff; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 500;">
          Redefinir senha
        </a>
        <p style="color: #6b7280; font-size: 12px;">
          Este link expira em 1 hora. Se voce nao solicitou a recuperacao, ignore este e-mail.
        </p>
        <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">
          Plataforma ACXE + Q2P
        </p>
      </div>
    `,
    text: `Atlas — Recuperacao de senha\n\nClique no link para redefinir sua senha: ${resetUrl}\n\nEste link expira em 1 hora.`,
  };
}
