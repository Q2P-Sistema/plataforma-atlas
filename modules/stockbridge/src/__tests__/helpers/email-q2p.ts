/**
 * Gerador dos e-mails no padrão Q2P (ACXEGDP-440), de verdade, para os mocks de '@atlas/core': o mock
 * troca o módulo inteiro, e sem estas funções o e-mail nem é montado. São puras (não leem config), então
 * os testes conferem o assunto e o corpo que vão de fato para o SendGrid.
 *
 * Uso: `vi.mock('@atlas/core', async () => ({ ...(await import('./helpers/email-q2p.js')), sendEmail: ... }))`.
 */
export {
  montarEmailQ2P,
  montarAssuntoQ2P,
  nomeAssunto,
  numeroSemZeros,
  dinheiroBrl,
  dataBrasilia,
  dataHoraBrasilia,
} from '../../../../../packages/core/src/email-q2p.js';
