import { getAmbiente, getConfig, type Ambiente, type Env } from './config.js';
import { montarAssuntoQ2P, montarEmailQ2P } from './email-q2p.js';
import { createLogger } from './logger.js';

const logger = createLogger('email');

/** Tempo maximo de uma chamada ao SendGrid; estouro = envio nao entregue (quem chama trata como falha). */
export const SENDGRID_TIMEOUT_MS = 20_000;

export interface EmailOptions {
  to: string;
  cc?: string | string[];
  /**
   * Cópia oculta (ACXEGDP-440): quem acompanha sem ser o assunto dele, como o Gestor do Sistema
   * Integrador onde antes ia em cópia fixa.
   */
  bcc?: string | string[];
  subject: string;
  html: string;
  text?: string;
}

/**
 * Para onde vão os e-mails desta instância — exposto no health/ambiente para
 * conferir o deploy (ACXEGDP-405).
 */
export type ModoEmail = 'normal' | 'log' | 'desviado' | 'suprimido';

export function getModoEmail(config: Env = getConfig()): ModoEmail {
  if (!config.EMAIL_DESVIO_PARA && getAmbiente(config) === 'uat') return 'suprimido';
  if (!chaveSendgrid(config) || !config.SENDGRID_FROM_EMAIL) return 'log';
  return config.EMAIL_DESVIO_PARA ? 'desviado' : 'normal';
}

function chaveSendgrid(config: Env): string | undefined {
  return config.EMAIL_DESVIO_PARA
    ? (config.SENDGRID_API_KEY_DESVIO ?? config.SENDGRID_API_KEY)
    : config.SENDGRID_API_KEY;
}

/** Endereços sem espaços sobrando, sem vazios e sem repetição (sem diferenciar maiúsculas). */
function listaEnderecos(valor: string | string[] | undefined): string[] {
  const unicos = new Map<string, string>();
  for (const item of Array.isArray(valor) ? valor : valor ? [valor] : []) {
    const endereco = typeof item === 'string' ? item.trim() : '';
    if (endereco && !unicos.has(endereco.toLowerCase())) unicos.set(endereco.toLowerCase(), endereco);
  }
  return Array.from(unicos.values());
}

/**
 * Para, Cc e Cco como o SendGrid aceita: ele retorna 400 se o mesmo endereço
 * aparece duas vezes entre `to`, `cc` e `bcc` da mesma personalização. Acontece
 * quando STOCKBRIDGE_ADMIN_CC_EMAIL é o mesmo do operador alvo (caso comum no
 * início do roll-out, onde o admin atua como operador também). Vale o campo mais
 * visível: quem está em Para sai do Cc e do Cco; quem está em Cc sai do Cco.
 */
function destinatarios(options: EmailOptions): { to: string; cc: string[]; bcc: string[] } {
  const to = options.to.trim();
  const cc = listaEnderecos(options.cc).filter((c) => c.toLowerCase() !== to.toLowerCase());
  const visiveis = new Set([to, ...cc].map((e) => e.toLowerCase()));
  const bcc = listaEnderecos(options.bcc).filter((b) => !visiveis.has(b.toLowerCase()));
  return { to, cc, bcc };
}

/**
 * Reescreve o e-mail para a caixa de desvio: assunto com o ambiente e uma faixa
 * no topo dizendo para quem ele iria. O CC e o CCO originais não são enviados.
 */
export function desviarEmail(options: EmailOptions, para: string, ambiente: Ambiente): EmailOptions {
  const { to, cc, bcc } = destinatarios(options);
  const rotulo = ambiente.toUpperCase();
  const aviso = `E-mail de teste (${rotulo}). Iria para ${to}${cc.length > 0 ? `, com cópia para ${cc.join(', ')}` : ''}${bcc.length > 0 ? `, com cópia oculta para ${bcc.join(', ')}` : ''}.`;
  const avisoHtml = `<div style="background:#fef3c7;border-bottom:1px solid #f59e0b;color:#78350f;font:13px Arial,Helvetica,sans-serif;padding:10px 16px;">${escapeHtml(aviso)}</div>`;
  const html = /<body[^>]*>/i.test(options.html)
    ? options.html.replace(/<body[^>]*>/i, (tag) => tag + avisoHtml)
    : avisoHtml + options.html;
  return {
    to: para,
    subject: `[${rotulo}] ${options.subject}`,
    html,
    text: options.text !== undefined ? `${aviso}\n\n${options.text}` : undefined,
  };
}

export async function sendEmail(original: EmailOptions): Promise<void> {
  const config = getConfig();
  const modo = getModoEmail(config);

  // ACXEGDP-405: fora de produção nenhum e-mail chega a usuário real.
  if (modo === 'suprimido') {
    logger.info(
      { to: original.to, cc: original.cc, bcc: original.bcc, subject: original.subject },
      '[UAT] E-mail não enviado — defina EMAIL_DESVIO_PARA para recebê-lo numa caixa de testes',
    );
    return;
  }
  const options = config.EMAIL_DESVIO_PARA
    ? desviarEmail(original, config.EMAIL_DESVIO_PARA, getAmbiente(config))
    : original;

  const { to, cc: ccLista, bcc: bccLista } = destinatarios(options);
  const cc = ccLista.length > 0 ? ccLista : undefined;
  const bcc = bccLista.length > 0 ? bccLista : undefined;

  const apiKey = chaveSendgrid(config);
  if (!apiKey || !config.SENDGRID_FROM_EMAIL) {
    // Dev fallback: log instead of sending
    logger.info(
      { to, cc, bcc, subject: options.subject },
      `[DEV EMAIL] Would send email to ${to}`,
    );
    logger.info({ html: options.html }, '[DEV EMAIL] Content');
    return;
  }

  const sgMail = await import('@sendgrid/mail');
  sgMail.default.setApiKey(apiKey);
  // Sem limite, o axios do @sendgrid espera para sempre um socket meio-aberto — e quem chama
  // pode estar segurando conexao/trava do banco (aviso a compras da 017, achado infra-v01).
  sgMail.default.setTimeout(SENDGRID_TIMEOUT_MS);

  await sgMail.default.send({
    to,
    cc,
    bcc,
    // ACXEGDP-440: o mesmo remetente dos fluxos do n8n (EML-21 usava "Plataforma Atlas").
    // O guard acima já estreitou SENDGRID_FROM_EMAIL para string.
    from: { email: config.SENDGRID_FROM_EMAIL, name: 'Sistema Integrador Q2P' },
    subject: options.subject,
    html: options.html,
    text: options.text,
  });

  logger.info({ to, cc, bcc, subject: options.subject }, 'Email sent');
}

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

/**
 * Recuperação de senha (E22 da ACXEGDP-440). O link vale 1 hora (RESET_TOKEN_TTL_MS em auth.routes) e
 * só pode ser usado uma vez (o token é apagado na troca).
 */
export function buildPasswordResetEmail(resetUrl: string): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Acesso', 'Redefinir a senha', 'Atlas');
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: 'Redefinição de senha do Atlas',
    // Quem pede a troca pode não ser o dono do e-mail: o texto não afirma que foi ele.
    resumo: 'Foi pedida a redefinição da senha do seu usuário no Atlas.',
    acao: {
      quem: 'Você',
      passos: ['Clique em **Redefinir senha** e escolha a nova senha.'],
      nota: 'Se você não pediu a troca, ignore este e-mail: a senha atual continua valendo.',
    },
    botao: { texto: 'Redefinir senha', url: resetUrl, nota: 'O link vale por 1 hora e só pode ser usado uma vez.' },
  });
  return { subject, html, text };
}
