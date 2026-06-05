import { getConfig } from '../config.js';
import { sendEmail } from '../email.js';

const recipient = process.argv[2];

async function main() {
  const config = getConfig();
  const to = recipient ?? config.SEED_ADMIN_EMAIL;

  if (!to) {
    console.error('Informe o destinatario: pnpm test:email <email> (ou defina SEED_ADMIN_EMAIL no .env)');
    process.exit(1);
  }

  const hasCreds = Boolean(config.SENDGRID_API_KEY && config.SENDGRID_FROM_EMAIL);
  const maskedKey = config.SENDGRID_API_KEY
    ? `${config.SENDGRID_API_KEY.slice(0, 6)}…${config.SENDGRID_API_KEY.slice(-4)}`
    : '(ausente)';

  console.log('─── Atlas — Teste SendGrid ───');
  console.log(`NODE_ENV:            ${config.NODE_ENV}`);
  console.log(`SENDGRID_API_KEY:    ${maskedKey}`);
  console.log(`SENDGRID_FROM_EMAIL: ${config.SENDGRID_FROM_EMAIL ?? '(ausente)'}`);
  console.log(`Destinatario:        ${to}`);
  console.log('');

  if (!hasCreds) {
    console.warn('⚠  SENDGRID_API_KEY/SENDGRID_FROM_EMAIL nao estao setadas no .env.');
    console.warn('   O wrapper cai no fallback de dev e vai apenas LOGAR no console.');
    console.warn('   Para enviar de verdade, descomente as linhas em .env e rode novamente.\n');
  }

  const subject = `Atlas — teste de envio (${new Date().toISOString()})`;
  const html = `
    <div style="font-family: sans-serif; max-width: 480px;">
      <h2 style="color: #0077cc;">SendGrid funcionando ✔</h2>
      <p>Se voce esta lendo este e-mail, a integracao SendGrid do Atlas esta configurada corretamente.</p>
      <p style="color:#6b7280;font-size:12px;">Enviado por <code>packages/core/src/scripts/test-email.ts</code> em ${new Date().toLocaleString('pt-BR')}.</p>
    </div>
  `;
  const text = `SendGrid funcionando. Enviado por test-email.ts em ${new Date().toISOString()}.`;

  try {
    await sendEmail({ to, subject, html, text });
    console.log(hasCreds ? '✔ Enviado. Confira a caixa de entrada.' : '✔ Logado no console (modo dev).');
    process.exit(0);
  } catch (err) {
    console.error('✖ Falha ao enviar:');
    console.error(err);
    process.exit(1);
  }
}

main();
