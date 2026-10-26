import {
  sendEmail,
  createLogger,
  getConfig,
  getDb,
  getPool,
  montarEmailQ2P,
  montarAssuntoQ2P,
  nomeAssunto,
  numeroSemZeros,
  dinheiroBrl,
  dataBrasilia,
  dataHoraBrasilia,
} from '@atlas/core';
import { fmtCnpj } from './cnpj.js';

export { fmtCnpj };
import { users, userModules } from '@atlas/db';
import { eq, inArray, and, isNull, sql } from 'drizzle-orm';
import { fmtQtdUnidade } from './motor.service.js';
import type { EmpresaNacional } from './empresa-nacional.js';

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

/**
 * Formata quantidade em kg no padrão pt-BR (ACXEGDP-176): inteiro sem casas
 * ("25 kg"), fração com vírgula ("25,5 kg"), milhar com ponto ("1.250 kg") —
 * delega ao fmtQtdUnidade do motor, formatação canônica do módulo.
 * Aceita também a string numérica que colunas NUMERIC do Postgres devolvem em
 * runtime ("25.000", com ponto decimal en-US): uma string atravessa o
 * toLocaleString sem conversão (String.prototype ignora o locale) e o e-mail
 * exibia "25.000 kg" — lido como vinte e cinco mil. O arredondamento antigo
 * (maximumFractionDigits: 0) também escondia frações reais (25,5 → "26 kg").
 * Exportado para os textos de e-mail montados fora deste arquivo (ex.: campo
 * "detalhes" do recebimento com divergência).
 */
export function fmtKg(kg: number | string): string {
  const n = typeof kg === 'number' ? kg : Number(kg);
  if (!Number.isFinite(n)) return '—';
  return fmtQtdUnidade(n, 'kg');
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
 * canônico (To) dos alertas ops; o admin entra em cópia oculta via alertaOpsCco().
 * Quem lê é o Gestor do Sistema Integrador (ACXEGDP-440).
 */
function getOpsEmail(): string {
  return getConfig().STOCKBRIDGE_OPS_EMAIL ?? ADMIN_FALLBACK_EMAIL;
}

/** Admin em cópia oculta dos alertas ops (Cc visível até a ACXEGDP-440), se configurado e diferente do To. */
function alertaOpsCco(to: string): string | undefined {
  const admin = getConfig().SEED_ADMIN_EMAIL;
  return admin && admin.toLowerCase() !== to.toLowerCase() ? admin : undefined;
}

/** Caixa de Comex da ACXE — copiada em todo recebimento concluido com sucesso. */
function getComexEmail(): string {
  return getConfig().STOCKBRIDGE_COMEX_EMAIL ?? COMEX_FALLBACK_EMAIL;
}

/** "Quem age" dos e-mails da caixa ops (ACXEGDP-440). */
const GESTOR_SI = 'Gestor do Sistema Integrador';

/**
 * A NF no assunto e no subtítulo (ACXEGDP-440): "NF 6842", ou "NF ACXE 6842" quando
 * a nota é da ACXE; sem zeros à esquerda. '' sem número.
 */
function rotuloNf(nf: string | null | undefined, empresa?: string | null): string {
  const n = numeroSemZeros(nf);
  // Número só de zeros é número ausente: "NF 0" não existe.
  if (!n || n === '0') return '';
  return empresa === 'acxe' ? `NF ACXE ${n}` : `NF ${n}`;
}

/** A NF dentro de uma frase: "NF 6842", ou só "NF" quando o número falta. */
function nfFrase(nf: string | null | undefined): string {
  return rotuloNf(nf) || 'NF';
}

/** Fornecedor no corpo do e-mail; sem nome, avisa que o OMIE não o identificou. */
function nomeFornecedor(nome: string | null | undefined): string {
  return nome && nome.trim() ? nome.trim() : 'Fornecedor não identificado no OMIE';
}

/** Partes não vazias do subtítulo, separadas por " · ". */
function subtitulo(...partes: Array<string | null | undefined>): string {
  return partes.map((p) => (p ?? '').trim()).filter(Boolean).join(' · ');
}

/** "1 item" / "3 itens". */
function contagem(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Divergência de recebimento com o nome da tela de conferência ("Varredura — material para inspeção").
 * Exportado para o detalhe que o recebimento monta no e-mail de aprovação.
 */
export function rotuloDivergencia(tipo: string | null | undefined): string {
  if (tipo === 'faltando') return 'Faltando';
  if (tipo === 'varredura') return 'Varredura (material para inspeção)';
  return 'Divergência';
}

/**
 * Destinatários do fiscal (feature 016, FR-026) — `STOCKBRIDGE_FISCAL_EMAILS`
 * (lista separada por vírgula; o schema de config já valida cada endereço).
 * Ausente ou vazia = lista padrão (NFe ACXE + Mauricio Yared + Gustavo Dreer): o
 * config trata string vazia como ausente, então não há como "desligar" o aviso
 * por env — para testar sem avisar o fiscal, aponte para a sua própria caixa.
 * Recebe os avisos de NF dispensada (e dispensa desfeita) e, desde a D21 da 017,
 * o de recebimento fiscal desfeito no OMIE com a entrada física já lançada
 * (enviarAvisoFiscalRevertido).
 */
export function getFiscalEmails(): string[] {
  const cfg = getConfig() as { STOCKBRIDGE_FISCAL_EMAILS?: string[] | string };
  const v = cfg.STOCKBRIDGE_FISCAL_EMAILS;
  if (Array.isArray(v)) return v.filter((e) => typeof e === 'string' && e.trim().length > 0);
  if (typeof v === 'string') return v.split(',').map((e) => e.trim()).filter(Boolean);
  return [];
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
  const nf = rotuloNf(args.notaFiscal);
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Recebimento', 'Produto não cadastrado na Q2P', nf);
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: 'Recebimento: produto não cadastrado na Q2P',
    subtitulo: subtitulo(nf, args.descricaoProduto),
    resumo: `O recebimento da ${nfFrase(args.notaFiscal)} está bloqueado: não há na Q2P um produto com a mesma descrição deste produto da ACXE.`,
    acao: {
      quem: GESTOR_SI,
      passos: [
        'Cadastre o produto na Q2P com a descrição exatamente igual à da ACXE.',
        'Espere a próxima sincronização do n8n trazer o cadastro para o Atlas.',
        'Tente o recebimento de novo na fila do StockBridge.',
      ],
    },
    // EML-11: link para a tela onde o recebimento é re-tentado após o cadastro.
    botao: { texto: 'Abrir a fila de recebimento', url: `${getConfig().APP_URL}/stockbridge/fila` },
    tecnico: [['Código do produto na ACXE (OMIE)', String(args.codigoProdutoAcxe)]],
    duvidas: false,
  });
  try {
    await sendEmail({ to, bcc: alertaOpsCco(to), subject, html, text });
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
  const to = getOpsEmail();
  const empresa = args.cnpj.toUpperCase();
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Recebimento', 'Conferir a nota no OMIE', rotuloNf(args.nf, args.cnpj));
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: 'Recebimento: conferir a nota no OMIE',
    subtitulo: subtitulo(rotuloNf(args.nf), empresa),
    resumo: `O recebimento da ${nfFrase(args.nf)} foi **liberado**, mas o Atlas não conseguiu confirmar no OMIE se a nota está cancelada ou se foi emitida pela empresa certa.`,
    acao: {
      quem: GESTOR_SI,
      passos: [
        `Confira no OMIE da ${empresa} se a ${nfFrase(args.nf)} está válida e foi emitida pela empresa certa.`,
        'Se ela estiver cancelada ou com o emitente errado, estorne o recebimento em Movimentações, no StockBridge.',
      ],
    },
    dados: [['Motivo', args.motivo]],
    // EML-11: movimentações é onde o gestor confere/estorna o recebimento.
    botao: { texto: 'Abrir Movimentações', url: `${getConfig().APP_URL}/stockbridge/movimentacoes` },
    duvidas: false,
  });
  try {
    await sendEmail({ to, bcc: alertaOpsCco(to), subject, html, text });
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
  const nf = rotuloNf(args.notaFiscal);
  const emissor = args.cnpjEmissor.toUpperCase();
  const fisico = args.cnpjFisico.toUpperCase();
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Estoque', 'Débito cruzado', nf);
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: 'Estoque: débito cruzado na saída',
    subtitulo: subtitulo(nf, fmtKg(args.quantidadeKg)),
    resumo: `A ${nfFrase(args.notaFiscal)} de saída foi faturada pela **${emissor}**, mas o estoque físico estava na **${fisico}**.`,
    acao: {
      quem: GESTOR_SI,
      passos: [`Peça ao setor contábil a NF de transferência da ${fisico} para a ${emissor}, para regularizar a posição fiscal.`],
      nota: 'A divergência fecha sozinha quando a NF de transferência for processada.',
    },
    // EML-11: a divergência fiscal aberta pelo débito cruzado vive nesta tela.
    botao: { texto: 'Abrir pendências fiscais', url: `${getConfig().APP_URL}/stockbridge/pendencias-fiscais` },
    duvidas: false,
  });
  try {
    await sendEmail({ to, bcc: alertaOpsCco(to), subject, html, text });
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
  // Identificador: "Lote L216", o galpão da saída ou o cliente do comodato — até 25 caracteres, como o nome no assunto.
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Aprovação', tipoLabel, nomeAssunto(args.loteCodigo));
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: `Aprovação: ${tipoLabel}`,
    subtitulo: subtitulo(args.loteCodigo, args.produto, fmtKg(args.quantidadeKg)),
    resumo: `Um lançamento de **${tipoLabel}** aguarda a sua aprovação no StockBridge${args.nivel === 'diretor' ? ' (nível diretor)' : ''}.`,
    acao: {
      // EML-03: nível humanizado — antes o enum cru ("gestor") vazava no assunto.
      quem: args.nivel === 'diretor' ? 'Diretor' : 'Gestor',
      passos: ['Abra Aprovações no StockBridge.', 'Confira o lançamento e aprove ou rejeite. Ao rejeitar, informe o motivo.'],
    },
    dados: [['Detalhes', args.detalhes ?? '']],
    botao: { texto: 'Abrir aprovações pendentes', url: linkPainel },
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
  const nf = rotuloNf(args.notaFiscal);
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Aprovação', 'Recebimento nacional', nf);
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: 'Aprovação: recebimento nacional',
    subtitulo: subtitulo(nf, contagem(n, 'item', 'itens')),
    resumo: `O recebimento nacional da ${nfFrase(args.notaFiscal)} tem **${contagem(n, 'item', 'itens')}** aguardando a sua aprovação.`,
    acao: {
      quem: args.nivel === 'diretor' ? 'Diretor' : 'Gestor',
      passos: ['Abra Aprovações no StockBridge.', `Confira ${n === 1 ? 'o item' : 'cada item'} e aprove ou rejeite. Ao rejeitar, informe o motivo.`],
    },
    dados: [['Detalhes', args.detalhes ?? '']],
    secoes: [
      {
        titulo: n === 1 ? 'Item' : 'Itens',
        tabela: {
          cab: ['Produto', 'Empresa', 'Local', 'Quantidade'],
          linhas: args.itens.map((it) => [it.produto, it.empresa.toUpperCase(), it.galpao, fmtKg(it.quantidadeKg)]),
          alinhar: ['e', 'e', 'e', 'd'],
        },
      },
    ],
    botao: { texto: 'Abrir aprovações pendentes', url: linkPainel },
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
 * Feature 016 (FR-026, ACXEGDP-395): aviso ao FISCAL quando o gestor dispensa uma
 * NF da fila de recebimento nacional. A dispensa não toca no OMIE — o que fica
 * pendente lá é do fiscal: com o recebimento fiscal ainda PENDENTE, a nota segue
 * na caixa "Recebimento de NF-e" aguardando manifestação/cancelamento; com o
 * fiscal já CONCLUÍDO, existe conta a pagar a estornar ou manter. Um e-mail por
 * destinatário (não vaza a lista no To). Sem código OMIE (ACXEGDP-313).
 */
export async function enviarAlertaNfDispensada(args: {
  notaFiscal: string;
  fornecedorNome: string | null;
  situacaoFiscalNaDispensa: 'pendente' | 'concluido';
  valorNfBrl: number;
  motivo: string;
  dispensadoPorNome: string | null;
  dispensadoEm?: string;
  /**
   * Feature 017 (T044): PC vinculado a cada item, quando houver — o fiscal fica
   * sabendo qual PC ficou com quantidade recebida no OMIE. Número vazio = vínculo
   * sem número conhecido (nunca id interno — ACXEGDP-313).
   */
  pcsPorItem?: Array<{ descricao: string; pcNumero: string }>;
  /**
   * Historia 5 (ACXEGDP-437): empresa da NF. 'acxe' cita a ACXE no assunto e no corpo (o fiscal da ACXE age no
   * OMIE dela); ausente ou 'q2p' = o texto de sempre.
   */
  empresa?: EmpresaNacional;
}): Promise<void> {
  const destinatarios = getFiscalEmails();
  if (destinatarios.length === 0) {
    logger.warn({ notaFiscal: args.notaFiscal }, 'STOCKBRIDGE_FISCAL_EMAILS vazio — fiscal não avisado da dispensa');
    return;
  }
  const fornecedor = nomeFornecedor(args.fornecedorNome);
  const nf = rotuloNf(args.notaFiscal, args.empresa);
  const daAcxe = args.empresa === 'acxe' ? ' da ACXE' : '';
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Fiscal', 'NF dispensada da fila', nomeAssunto(args.fornecedorNome), nf);
  const valor = dinheiroBrl(args.valorNfBrl);
  // O Atlas conhece a situação pelo espelho no momento da dispensa (pode estar
  // defasado em minutos) — o texto diz isso e pede a conferência no OMIE (ROT-9).
  const pendente = args.situacaoFiscalNaDispensa === 'pendente';
  // ACXEGDP-440: sem botão — o fiscal age no OMIE e nem todos têm usuário no Atlas.
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: 'Fiscal: NF dispensada da fila de recebimento',
    subtitulo: subtitulo(nf, fornecedor, valor),
    resumo: [
      `O gestor dispensou a ${nfFrase(args.notaFiscal)} da fila de recebimento${daAcxe} do StockBridge: o estoque dela não vai entrar pelo Atlas, e nada mudou no OMIE.`,
      pendente
        ? 'Na hora da dispensa, o recebimento fiscal ainda **não tinha sido concluído**: a nota segue em Recebimento de NF-e (etapa "Faturado pelo fornecedor"), sem conta a pagar gerada pelo recebimento.'
        : `O recebimento fiscal já tinha sido **concluído** no OMIE: existe conta a pagar de ${valor}.`,
    ],
    acao: {
      quem: 'Fiscal',
      passos: pendente
        ? [`Confira a nota no OMIE${daAcxe}.`, 'Dê o destino dela (manifestação, recusa ou cancelamento), conforme o acerto com o fornecedor.']
        : [`Estorne ou mantenha a conta a pagar no OMIE${daAcxe}, conforme o acerto com o fornecedor.`],
      // A cópia do OMIE pode estar horas atrás do portal: o texto não promete atraso de minutos.
      nota: pendente ? 'A situação acima é a que o Atlas tinha na hora da dispensa e pode ter mudado.' : '',
    },
    // A empresa vai no subtítulo ("NF ACXE 6842"), não nos dados.
    dados: [
      ['Motivo da dispensa', args.motivo],
      [
        'Pedido de compra vinculado',
        (args.pcsPorItem ?? [])
          .map((p) => `${p.descricao.trim()}: ${p.pcNumero ? `PC ${p.pcNumero}` : 'PC vinculado no OMIE'}`)
          .join('; '),
      ],
      ['Dispensada por', args.dispensadoPorNome ?? ''],
      ['Quando', dataHoraBrasilia(args.dispensadoEm || new Date())],
    ],
  });
  try {
    const results = await Promise.allSettled(destinatarios.map((to) => sendEmail({ to, subject, html, text })));
    const falhas = logFalhasEnvio(results, destinatarios, { notaFiscal: args.notaFiscal, tipo: 'nf_dispensada' });
    if (falhas < destinatarios.length) {
      logger.info({ notaFiscal: args.notaFiscal, enviados: destinatarios.length - falhas, falhas }, 'Aviso de NF dispensada enviado ao fiscal');
    }
  } catch (err) {
    logger.error({ err, notaFiscal: args.notaFiscal }, 'Falha ao enviar aviso de NF dispensada ao fiscal');
  }
}

/**
 * Motivo do aviso a compras (feature 017, research D6) — CHECK de stockbridge.nf_aviso_compras.
 * 'excedente_rejeitado' (0059, research D20): entrada rejeitada pelo gestor depois de o PC ser
 * baixado pelo peso conferido acima da NF.
 */
export type MotivoAvisoCompras = 'sem_pc' | 'pc_aguardando_aprovacao' | 'recebida_sem_vinculo' | 'excedente_rejeitado';

/**
 * Janela de deduplicacao do aviso a compras: um por NF, motivo e DESTINATARIO a
 * cada 24 h (D6). Quem ja recebeu nao recebe de novo; quem falhou segue pendente.
 */
export const AVISO_COMPRAS_DEDUP_HORAS = 24;

/**
 * Espera maxima pela trava do aviso (outro envio da mesma NF e motivo em curso)
 * antes de desistir com 'falha': um envio travado no SendGrid nao pode prender
 * conexoes do pool de quem chega depois.
 */
const AVISO_COMPRAS_LOCK_TIMEOUT = '10s';

/**
 * Trava de unidade (22/10/2026): os PCs do fornecedor estao em unidade diferente da
 * NF (ex.: NF em toneladas, PC em kg). O OMIE baixaria o pedido na unidade da nota,
 * sem converter; a orientacao a compras e lancar o pedido na unidade da nota.
 * `pcs` sao numeros legiveis (nunca o codigo interno do OMIE); `itens` sao as
 * descricoes dos itens da NF afetados.
 */
export interface UnidadeIncompativelAviso {
  unidadeNf: string;
  pcs: string[];
  itens: string[];
}

export interface ArgsAvisoComprasNfSemPc {
  empresa: 'q2p' | 'acxe';
  nfChaveAcesso: string;
  notaFiscal: string;
  fornecedorNome: string | null;
  /**
   * `qtdKg` null = unidade que o Atlas nao converte para kg; nesse caso `quantidadeTexto` traz a
   * quantidade nativa da NF ("40 UN") e o e-mail nunca mostra "0 kg" (achado fila-v04).
   */
  itens: Array<{ nSequencia: number | null; descricao: string; qtdKg: number | null; precoUnit: number | null; quantidadeTexto?: string | null }>;
  /** numeros dos PCs do fornecedor aguardando aprovacao (FR-002b), se houver */
  pcsAguardandoAprovacao: string[];
  motivo: MotivoAvisoCompras;
  disparadoPor: string | null;
  /** PCs do fornecedor em unidade diferente da NF (trava de unidade); omitido ou null = nao se aplica */
  unidadeIncompativel?: UnidadeIncompativelAviso | null;
}


/** "a", "a e b", "a, b e c". */
function listaPtBr(itens: string[]): string {
  if (itens.length <= 1) return itens.join('');
  return `${itens.slice(0, -1).join(', ')} e ${itens[itens.length - 1]}`;
}

/** "kg" / "toneladas" — mesma leitura da sugestao (sem importar o modulo, para nao criar ciclo). */
function rotuloUnidadeAviso(unidade: string | null | undefined): string {
  const u = (unidade ?? '').trim().toUpperCase();
  if (u === 'KG') return 'kg';
  if (u === 'T' || u === 'TON' || u === 'TL') return 'toneladas';
  return u || 'unidade desconhecida';
}

/**
 * Texto do quadro "Pedido em unidade diferente da nota" (trava de unidade). So o
 * numero legivel do PC aparece — numero vazio ou com cara de codigo interno do OMIE
 * (10+ digitos) vira "um pedido de compra" (ACXEGDP-313). O que fazer vai na caixa
 * de ação do e-mail.
 */
function textoUnidadeIncompativel(u: UnidadeIncompativelAviso): string {
  const pcs = u.pcs.map((p) => String(p ?? '').trim()).filter((p) => p && !/^\d{10,}$/.test(p));
  const quais = pcs.length === 0 ? 'o pedido de compra deste fornecedor' : pcs.length === 1 ? `o PC ${pcs[0]}` : `os PCs ${listaPtBr(pcs)}`;
  const itens = u.itens.map((i) => String(i ?? '').trim()).filter(Boolean);
  const paraItens = itens.length > 0 ? ` para ${itens.length === 1 ? 'o item' : 'os itens'} ${listaPtBr(itens.map((i) => `"${i}"`))}` : '';
  return (
    `A nota está em ${rotuloUnidadeAviso(u.unidadeNf)} e ${quais} está em outra unidade${paraItens}. ` +
    'Na conclusão do recebimento o OMIE grava no pedido a quantidade recebida na unidade da nota, sem converter ' +
    '(uma NF de 8,25 toneladas baixaria um pedido em kg com 8,25, não 8.250).'
  );
}

/**
 * Destinatarios do aviso a compras: STOCKBRIDGE_COMPRAS_EMAILS (sem repeticao, sem
 * diferenciar caixa); vazio, a caixa do ops (`viaOps`) — o aviso nunca se perde.
 */
export function destinatariosAvisoCompras(): { destinatarios: string[]; viaOps: boolean } {
  const bruto: unknown = getConfig().STOCKBRIDGE_COMPRAS_EMAILS;
  const lista: unknown[] = Array.isArray(bruto) ? bruto : typeof bruto === 'string' ? bruto.split(',') : [];
  const unicos = new Map<string, string>();
  for (const item of lista) {
    const endereco = typeof item === 'string' ? item.trim() : '';
    if (endereco && !unicos.has(endereco.toLowerCase())) unicos.set(endereco.toLowerCase(), endereco);
  }
  if (unicos.size > 0) return { destinatarios: Array.from(unicos.values()), viaOps: false };
  return { destinatarios: [getOpsEmail()], viaOps: true };
}

/** Assunto e corpo do aviso a compras — o mesmo e-mail vai a todos os destinatarios pendentes. */
function montarEmailAvisoCompras(args: ArgsAvisoComprasNfSemPc): { subject: string; html: string; text: string } {
  const config = getConfig();
  const unidade = args.unidadeIncompativel ?? null;
  const fornecedor = nomeFornecedor(args.fornecedorNome);
  // Compras precisa saber em qual OMIE agir: a NF da ACXE vem como "NF ACXE 6842" e os passos dizem "no OMIE da ACXE".
  const nf = rotuloNf(args.notaFiscal, args.empresa);
  const daAcxe = args.empresa === 'acxe' ? ' da ACXE' : '';
  const semVinculo = args.motivo === 'recebida_sem_vinculo';
  const aguardando = args.motivo === 'pc_aguardando_aprovacao';
  const situacao = semVinculo
    ? 'Recebida sem pedido de compra'
    : aguardando
      ? 'Pedido aguardando aprovação'
      : unidade
        ? 'Pedido em unidade diferente'
        : 'NF sem pedido de compra';
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Compras', situacao, nomeAssunto(args.fornecedorNome), nf);
  const resumo = semVinculo
    ? `A ${nfFrase(args.notaFiscal)} foi recebida pelo StockBridge com item **sem pedido de compra** no OMIE${daAcxe}: o recebimento fiscal foi concluído sem vínculo com pedido nesse item.`
    : aguardando
      ? `O recebimento da ${nfFrase(args.notaFiscal)} está **bloqueado**: o pedido de compra do item ainda está **aguardando aprovação** no OMIE${daAcxe}.`
      : unidade
        ? `O recebimento da ${nfFrase(args.notaFiscal)} está **bloqueado**: o pedido de compra deste fornecedor está numa unidade diferente da nota.`
        : `O recebimento da ${nfFrase(args.notaFiscal)} está **bloqueado**: há item **sem pedido de compra** aprovado e com saldo no OMIE${daAcxe}.`;
  const acao = semVinculo
    ? { passos: [`Se havia pedido de compra para este item, combine com o fiscal o ajuste do pedido no OMIE${daAcxe}: o recebimento não foi contado nele.`] }
    : aguardando
      ? {
          passos: [`Aprove o pedido de compra no OMIE${daAcxe}.`],
          nota: 'A NF fica na fila do StockBridge e pode ser recebida assim que o pedido estiver aprovado e a lista de pedidos do Atlas for atualizada.',
        }
      : unidade
        ? { passos: [`Lance (ou ajuste) o pedido de compra no OMIE${daAcxe} na mesma unidade da nota.`], nota: 'A NF fica na fila do StockBridge até o pedido estar na unidade certa.' }
        : { passos: [`Lance e aprove no OMIE${daAcxe} o pedido de compra deste item para este fornecedor.`], nota: 'A NF fica na fila do StockBridge até o pedido existir.' };
  const fmtPreco = (v: number | null) =>
    v == null ? '—' : `${v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4 })}/kg`;
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: semVinculo
      ? 'Compras: NF recebida sem pedido de compra'
      : aguardando
        ? 'Compras: pedido de compra aguardando aprovação'
        : unidade
          ? 'Compras: pedido em unidade diferente da nota'
          : 'Compras: NF sem pedido de compra',
    subtitulo: subtitulo(nf, fornecedor),
    resumo,
    acao: { quem: 'Compras', ...acao },
    dados: [
      // A NF da ACXE já diz a empresa no subtítulo.
      ['Empresa', args.empresa === 'acxe' ? '' : 'Q2P'],
      ['Pedido aguardando aprovação no OMIE', args.pcsAguardandoAprovacao.map((n) => `PC ${n}`).join(', ')],
    ],
    secoes: [
      // Trava de unidade: sem este quadro compras lancaria um PC novo em kg e o problema se repetiria.
      ...(unidade ? [{ titulo: 'Pedido em unidade diferente da nota', texto: textoUnidadeIncompativel(unidade), destaque: 'alerta' as const }] : []),
      {
        titulo: args.itens.length === 1 ? 'Item da nota' : 'Itens da nota',
        tabela: {
          cab: ['Item da NF', 'Quantidade', 'Preço unitário'],
          linhas: args.itens.map((it) => [
            it.descricao.trim(),
            it.qtdKg != null ? fmtKg(it.qtdKg) : (it.quantidadeTexto ?? '').trim() || '—',
            fmtPreco(it.precoUnit),
          ]),
          alinhar: ['e', 'd', 'd'],
        },
      },
    ],
    // Compras usa o Atlas (decisão 6 da ACXEGDP-440): o botão leva à fila, onde a NF espera o pedido. A NF
    // recebida sem vínculo já saiu da fila: sem botão.
    botao: semVinculo ? undefined : { texto: 'Abrir a fila do StockBridge', url: `${config.APP_URL}/stockbridge/fila` },
  });
  return { subject, html, text };
}

/**
 * Feature 017 (ACXEGDP-437, research D6, FR-020): avisa COMPRAS que uma NF nacional
 * tem item sem pedido de compra (PC) possivel no OMIE — bloqueada (`sem_pc`,
 * `pc_aguardando_aprovacao`) ou recebida sem vinculo (`recebida_sem_vinculo`).
 *
 * Deduplicado por NF, motivo e DESTINATARIO em stockbridge.nf_aviso_compras (24 h).
 * Numa transacao com trava consultiva por (NF, motivo): le quem ja foi avisado, envia
 * so aos pendentes e grava SO os enderecos entregues. Duas chamadas simultaneas nao
 * duplicam o e-mail (a segunda espera a trava e ve a linha da primeira) e quem falhou
 * numa falha parcial recebe na proxima tentativa. Falha total: nada e gravado
 * ('falha') e a proxima tentativa reenvia. Se o envio der certo e o COMMIT falhar, a
 * proxima tentativa tambem reenvia — um e-mail enviado nao se desfaz.
 *
 * Destino: STOCKBRIDGE_COMPRAS_EMAILS; vazio, STOCKBRIDGE_OPS_EMAIL com aviso no log.
 * `unidadeIncompativel`: os PCs do fornecedor estao em unidade diferente da NF — o
 * e-mail diz isso e manda lancar o pedido na unidade da nota (trava de unidade).
 * Sem codigo OMIE (ACXEGDP-313). Best-effort: nunca lanca — quem chama nao espera
 * (o recebimento nao depende do e-mail).
 */
/**
 * Avisos a compras em envio ao mesmo tempo no processo. Cada um segura uma conexao do pool
 * (trava + envio, ate o limite do SendGrid); acima disto o aviso devolve 'falha' na hora, sem
 * tocar no pool, e a proxima tentativa reenvia — um SendGrid pendurado nunca toma o pool da API
 * (achado infra-r04).
 */
export const AVISO_COMPRAS_MAX_SIMULTANEOS = 3;
let avisosComprasEmEnvio = 0;

export async function enviarAvisoComprasNfSemPc(args: ArgsAvisoComprasNfSemPc): Promise<'enviado' | 'deduplicado' | 'falha'> {
  if (avisosComprasEmEnvio >= AVISO_COMPRAS_MAX_SIMULTANEOS) {
    logger.warn(
      { notaFiscal: args.notaFiscal, motivo: args.motivo, emEnvio: avisosComprasEmEnvio },
      'Aviso a compras não enviado agora: limite de envios simultâneos — a próxima tentativa reenvia',
    );
    return 'falha';
  }
  avisosComprasEmEnvio++;
  try {
    return await enviarAvisoComprasNfSemPcSemLimite(args);
  } finally {
    avisosComprasEmEnvio--;
  }
}

async function enviarAvisoComprasNfSemPcSemLimite(args: ArgsAvisoComprasNfSemPc): Promise<'enviado' | 'deduplicado' | 'falha'> {
  return enviarAvisoComprasDeduplicado(
    {
      empresa: args.empresa,
      nfChaveAcesso: args.nfChaveAcesso,
      notaFiscal: args.notaFiscal,
      fornecedorNome: args.fornecedorNome,
      motivo: args.motivo,
      itens: args.itens,
      disparadoPor: args.disparadoPor,
    },
    () => montarEmailAvisoCompras(args),
    { assunto: 'NF sem PC', tipo: 'aviso_compras_nf_sem_pc' },
  );
}

/** O que vai para stockbridge.nf_aviso_compras (e para a trava) em qualquer aviso a compras. */
interface DadosAvisoCompras {
  empresa: 'q2p' | 'acxe';
  nfChaveAcesso: string;
  notaFiscal: string;
  fornecedorNome: string | null;
  motivo: MotivoAvisoCompras;
  itens: unknown[];
  disparadoPor: string | null;
  /**
   * Deduplicacao por item (revisao da D20, achado 2a): so contam os avisos anteriores cujo `itens`
   * CONTEM estes elementos (jsonb @>), ex. [{nSequencia: 2}]. Ausente = qualquer aviso da NF e motivo.
   */
  cobertura?: unknown[];
  /**
   * Ancora da janela da deduplicacao (2a revisao da D20, achado 4): contam os avisos enviados depois de
   * `coberturaDesde` menos AVISO_COMPRAS_DEDUP_HORAS. Ausente = agora. A varredura do cron passa a hora da
   * rejeicao, a mesma ancora que ela usa para achar quem falta; com `now()`, passado um dia, quem ja tinha
   * sido avisado daquela rejeicao receberia de novo junto com o destinatario que faltava.
   */
  coberturaDesde?: Date | string;
}

/**
 * Miolo de todo aviso a compras (research D6): numa transacao com trava consultiva por
 * (NF, motivo), le quem ja foi avisado nas ultimas 24 h (ou desde 24 h antes de `coberturaDesde`),
 * envia so aos pendentes e grava SO
 * os enderecos entregues. Nunca lanca. `rotulo.assunto` entra nas mensagens de log e
 * `rotulo.tipo` no log de falha de envio.
 */
async function enviarAvisoComprasDeduplicado(
  dados: DadosAvisoCompras,
  montar: () => { subject: string; html: string; text: string },
  rotulo: { assunto: string; tipo: string },
): Promise<'enviado' | 'deduplicado' | 'falha'> {
  const ctx = { notaFiscal: dados.notaFiscal, motivo: dados.motivo };
  try {
    const { destinatarios, viaOps } = destinatariosAvisoCompras();
    const client = await getPool().connect();
    let descartarConexao = false;
    const rollback = async (): Promise<void> => {
      try {
        await client.query('ROLLBACK');
      } catch (err) {
        // Estado da transacao desconhecido: a trava poderia ficar presa nesta conexao.
        // Descartar (release(true)) em vez de devolver ao pool encerra a sessao e solta a trava.
        descartarConexao = true;
        logger.warn({ err, ...ctx }, 'ROLLBACK do aviso a compras falhou — conexão descartada');
      }
    };
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '${AVISO_COMPRAS_LOCK_TIMEOUT}'`);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`sb:aviso-compras:${dados.nfChaveAcesso}:${dados.motivo}`]);

      // Quem ja foi avisado nas ultimas 24 h, ou desde 24 h antes de `coberturaDesde` (enviado_para guarda a
      // lista separada por ', ').
      const params: unknown[] = [dados.nfChaveAcesso, dados.motivo, AVISO_COMPRAS_DEDUP_HORAS];
      let filtroItens = '';
      if (dados.cobertura) {
        params.push(JSON.stringify(dados.cobertura));
        filtroItens = ` AND itens @> $${params.length}::jsonb`;
      }
      let ancora = 'now()';
      const desde = dados.coberturaDesde != null ? new Date(dados.coberturaDesde) : null;
      if (desde && !Number.isNaN(desde.getTime())) {
        params.push(desde.toISOString());
        ancora = `$${params.length}::timestamptz`;
      }
      const previos = await client.query<{ enviado_para: string | null }>(
        `SELECT enviado_para FROM stockbridge.nf_aviso_compras
          WHERE nf_chave_acesso = $1 AND motivo = $2 AND enviado_em > ${ancora} - make_interval(hours => $3)${filtroItens}`,
        params,
      );
      const jaAvisados = new Set<string>();
      for (const linha of previos.rows) {
        for (const endereco of (linha.enviado_para ?? '').split(',')) {
          const normalizado = endereco.trim().toLowerCase();
          if (normalizado) jaAvisados.add(normalizado);
        }
      }
      const pendentes = destinatarios.filter((d) => !jaAvisados.has(d.toLowerCase()));
      if (pendentes.length === 0) {
        await rollback();
        logger.info(ctx, 'Aviso a compras já enviado a todos os destinatários na janela da deduplicação — não reenviado');
        return 'deduplicado';
      }
      if (viaOps) logger.warn({ notaFiscal: dados.notaFiscal }, `STOCKBRIDGE_COMPRAS_EMAILS vazio — aviso de ${rotulo.assunto} vai para STOCKBRIDGE_OPS_EMAIL`);

      const { subject, html, text } = montar();
      const results = await Promise.allSettled(pendentes.map((to) => sendEmail({ to, subject, html, text })));
      const falhas = logFalhasEnvio(results, pendentes, { notaFiscal: dados.notaFiscal, tipo: rotulo.tipo });
      const entregues = pendentes.filter((_, i) => results[i]?.status === 'fulfilled');
      if (entregues.length === 0) {
        await rollback();
        logger.warn(ctx, 'Aviso a compras não entregue a nenhum destinatário — nada registrado, a próxima tentativa reenvia');
        return 'falha';
      }
      await client.query(
        `INSERT INTO stockbridge.nf_aviso_compras
           (empresa, nf_chave_acesso, nota_fiscal, fornecedor_nome, motivo, itens, enviado_para, disparado_por)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [
          dados.empresa, dados.nfChaveAcesso, dados.notaFiscal, dados.fornecedorNome, dados.motivo,
          JSON.stringify(dados.itens), entregues.join(', '), dados.disparadoPor,
        ],
      );
      await client.query('COMMIT');
      logger.info({ ...ctx, enviados: entregues.length, falhas }, `Aviso a compras de ${rotulo.assunto} enviado`);
      return 'enviado';
    } catch (err) {
      await rollback();
      throw err;
    } finally {
      client.release(descartarConexao);
    }
  } catch (err) {
    logger.error({ err, ...ctx }, `Falha no aviso a compras de ${rotulo.assunto}`);
    return 'falha';
  }
}

// ── Entrada rejeitada depois da baixa do PC pelo peso conferido (research D20) ──

/** Linha do PC baixado pelo peso conferido acima da NF, para o aviso a compras. */
export interface LinhaExcedentePc {
  nSequencia: number;
  /** numero legivel do PC (nunca o codigo interno do OMIE) */
  pcNumero: string;
  qtdNfKg: number;
  /** kg declarados como recebidos no PC (o peso conferido, com teto no saldo) */
  kgRecebidoPc: number;
}

export interface ArgsAvisoComprasExcedenteRejeitado {
  empresa: 'q2p' | 'acxe';
  nfChaveAcesso: string;
  notaFiscal: string;
  fornecedorNome: string | null;
  itemDescricao: string | null;
  produto: string | null;
  motivoRejeicao: string;
  linhas: LinhaExcedentePc[];
  disparadoPor: string | null;
  /** hora da rejeicao, quando o aviso sai pela varredura do cron: ancora da deduplicacao (DadosAvisoCompras.coberturaDesde) */
  coberturaDesde?: Date | string;
}

function montarEmailExcedenteRejeitado(args: ArgsAvisoComprasExcedenteRejeitado): { subject: string; html: string; text: string } {
  const config = getConfig();
  const fornecedor = nomeFornecedor(args.fornecedorNome);
  const nf = rotuloNf(args.notaFiscal, args.empresa);
  const daAcxe = args.empresa === 'acxe' ? ' da ACXE' : '';
  // So o numero legivel do PC; vazio ou com cara de codigo interno do OMIE (10+ digitos) vira "—" (ACXEGDP-313).
  const numeroPc = (n: string) => {
    const v = String(n ?? '').trim();
    return v && !/^\d{10,}$/.test(v) ? `PC ${v}` : '—';
  };
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Compras', 'Pedido baixado acima da nota', nomeAssunto(args.fornecedorNome), nf);
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: 'Compras: pedido baixado acima da nota',
    subtitulo: subtitulo(nf, fornecedor),
    resumo: [
      `No recebimento da ${nfFrase(args.notaFiscal)}, o pedido de compra foi baixado com **quantidade acima da nota**, e depois o gestor **rejeitou** a entrada desse item no estoque.`,
      `A rejeição no StockBridge não desfaz a baixa do pedido no OMIE${daAcxe}.`,
    ],
    acao: {
      quem: 'Compras',
      passos: [
        'Confira com o fiscal a quantidade recebida deste pedido.',
        `Se a quantidade acima da nota não se confirmar, ajuste o recebimento no OMIE${daAcxe} para a quantidade certa.`,
      ],
      nota: 'A nota volta à fila do StockBridge para o recebimento físico ser refeito.',
    },
    dados: [
      // A NF da ACXE já diz a empresa no subtítulo.
      ['Empresa', args.empresa === 'acxe' ? '' : 'Q2P'],
      ['Item da NF', (args.itemDescricao ?? '').trim()],
      ['Produto', (args.produto ?? '').trim()],
      ['Motivo da rejeição', args.motivoRejeicao],
    ],
    secoes: [
      {
        titulo: 'Quantidades',
        tabela: {
          cab: ['Pedido', 'Na nota', 'Baixado no pedido', 'Acima da nota'],
          linhas: args.linhas.map((l) => [numeroPc(l.pcNumero), fmtKg(l.qtdNfKg), fmtKg(l.kgRecebidoPc), fmtKg(l.kgRecebidoPc - l.qtdNfKg)]),
          alinhar: ['e', 'd', 'd', 'd'],
        },
      },
    ],
    // Compras usa o Atlas (decisão 6 da ACXEGDP-440).
    botao: { texto: 'Abrir a fila do StockBridge', url: `${config.APP_URL}/stockbridge/fila` },
  });
  return { subject, html, text };
}

/**
 * Research D20 (ACXEGDP-437): avisa COMPRAS que o gestor rejeitou a entrada de um item da NF
 * cujo pedido de compra ja foi baixado acima da nota (peso conferido) — a rejeicao nao desfaz
 * a baixa no OMIE. Deduplicado por NF, motivo, destinatario E itens (as sequencias do e-mail
 * precisam estar num aviso anterior das ultimas 24 h — na varredura, enviado a partir de 24 h antes
 * da rejeicao): rejeitar dois produtos do mesmo item gera um so e-mail; rejeitar outro item da NF
 * gera outro. Sem codigo OMIE. Nunca lanca.
 */
export async function enviarAvisoComprasExcedenteRejeitado(
  args: ArgsAvisoComprasExcedenteRejeitado,
): Promise<'enviado' | 'deduplicado' | 'falha'> {
  if (avisosComprasEmEnvio >= AVISO_COMPRAS_MAX_SIMULTANEOS) {
    logger.warn(
      { notaFiscal: args.notaFiscal, motivo: 'excedente_rejeitado', emEnvio: avisosComprasEmEnvio },
      'Aviso a compras não enviado agora: limite de envios simultâneos',
    );
    return 'falha';
  }
  avisosComprasEmEnvio++;
  try {
    return await enviarAvisoComprasDeduplicado(
      {
        empresa: args.empresa,
        nfChaveAcesso: args.nfChaveAcesso,
        notaFiscal: args.notaFiscal,
        fornecedorNome: args.fornecedorNome,
        motivo: 'excedente_rejeitado',
        itens: args.linhas.map((l) => ({
          nSequencia: l.nSequencia,
          descricao: (args.itemDescricao ?? '').trim(),
          qtdKg: l.kgRecebidoPc,
          precoUnit: null,
          pcNumero: l.pcNumero,
          qtdNfKg: l.qtdNfKg,
        })),
        disparadoPor: args.disparadoPor,
        cobertura: args.linhas.map((l) => ({ nSequencia: l.nSequencia })),
        coberturaDesde: args.coberturaDesde,
      },
      () => montarEmailExcedenteRejeitado(args),
      { assunto: 'entrada rejeitada com PC baixado acima da nota', tipo: 'aviso_compras_excedente_rejeitado' },
    );
  } finally {
    avisosComprasEmEnvio--;
  }
}

/**
 * Feature 016 (revisão pré-UAT, ROT-6): o espelho de recebimentos de NF-e (fonte
 * "fiscal pendente" da fila nacional) está sem atualização além do limite, vazio
 * ou inacessível. Vai para STOCKBRIDGE_OPS_EMAIL — quem cuida do n8n e da cópia.
 * Devolve true se o sendEmail resolveu e false se falhou (nunca lanca): o job do cron
 * so passa a suprimir o reaviso depois de uma entrega (infra-03).
 * Historia 5 (ACXEGDP-437): `empresa` ('q2p' por padrao — o texto de sempre) troca o espelho
 * citado e o workflow do n8n a verificar ("ACXE - Exporta Recebimentos NF-e").
 */
export async function enviarAlertaEspelhoRecebimentosDefasado(
  args: {
    status: 'degraded' | 'sem_dados' | 'indisponivel';
    idadeMin: number | null;
    limiteMin: number;
  },
  empresa: EmpresaNacional = 'q2p',
): Promise<boolean> {
  const to = getOpsEmail();
  const config = getConfig();
  const da = empresa === 'acxe' ? ' da ACXE' : '';
  const workflow = empresa === 'acxe' ? 'ACXE - Exporta Recebimentos NF-e' : 'Q2P - Exporta Recebimentos NF-e';
  const estado = args.status === 'sem_dados' ? 'vazio' : args.status === 'indisponivel' ? 'sem leitura' : 'parado';
  const minutos = Math.round(args.idadeMin ?? 0);
  const situacao =
    args.status === 'sem_dados'
      ? `O espelho de recebimentos de NF-e${da} está vazio.`
      : args.status === 'indisponivel'
        ? `O espelho de recebimentos de NF-e${da} não pôde ser lido (tabela ausente ou erro de banco).`
        : `O espelho de recebimentos de NF-e${da} não é atualizado há ${minutos} minutos (limite: ${args.limiteMin} minutos).`;
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Infra', `Espelho de recebimentos ${estado}`, empresa === 'acxe' ? 'ACXE' : 'Q2P');
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: `Infra: espelho de recebimentos de NF-e ${estado}`,
    subtitulo: subtitulo(empresa === 'acxe' ? 'ACXE' : 'Q2P', args.status === 'degraded' ? `sem atualização há ${minutos} min` : ''),
    resumo: [
      situacao,
      `Enquanto isso, notas de compra nacional${da} que chegaram da SEFAZ com o recebimento fiscal pendente podem não aparecer na fila de recebimento do StockBridge.`,
    ],
    acao: {
      quem: GESTOR_SI,
      passos: [
        `Confira no n8n o fluxo "${workflow}": se está ativo e se as últimas execuções terminaram sem erro.`,
        'No UAT, confira também a cópia do espelho de produção para o UAT.',
      ],
    },
    botao: { texto: 'Abrir a fila de recebimento', url: `${config.APP_URL}/stockbridge/fila` },
    duvidas: false,
  });
  try {
    await sendEmail({ to, subject, html, text });
    logger.info({ empresa, status: args.status, idadeMin: args.idadeMin }, 'Alerta de espelho de recebimentos defasado enviado');
    return true;
  } catch (err) {
    logger.error({ err, empresa }, 'Falha ao enviar alerta de espelho de recebimentos defasado');
    return false;
  }
}

/**
 * Feature 017 (ACXEGDP-437, research D13, FR-030): a cópia local de pedidos de
 * compra (tbl_pedidosCompras_Q2P) passou do limite, ficou vazia ou não pôde ser
 * lida. Enquanto durar, o recebimento de NF nacional com fiscal pendente fica em
 * modo seguro (503 COPIA_PCS_DEFASADA) — por isso o aviso vai ao ops.
 * Devolve true se o sendEmail resolveu e false se falhou (nunca lanca): o job do cron
 * so passa a suprimir o reaviso depois de uma entrega (infra-03).
 * Historia 5 (ACXEGDP-437): `empresa` ('q2p' por padrao — o texto de sempre) cita a copia da
 * ACXE; o workflow do n8n e o mesmo para as duas empresas.
 */
export async function enviarAlertaCopiaPcsDefasada(
  args: {
    status: 'degraded' | 'sem_dados' | 'indisponivel';
    idadeMin: number | null;
    limiteMin: number;
  },
  empresa: EmpresaNacional = 'q2p',
): Promise<boolean> {
  const to = getOpsEmail();
  const config = getConfig();
  const da = empresa === 'acxe' ? ' da ACXE' : '';
  const estado = args.status === 'sem_dados' ? 'vazia' : args.status === 'indisponivel' ? 'sem leitura' : 'parada';
  const minutos = Math.round(args.idadeMin ?? 0);
  const situacao =
    args.status === 'sem_dados'
      ? `A cópia local de pedidos de compra${da} está vazia.`
      : args.status === 'indisponivel'
        ? `A cópia local de pedidos de compra${da} não pôde ser lida (tabela ausente ou erro de banco).`
        : `A cópia local de pedidos de compra${da} não é atualizada há ${minutos} minutos (limite: ${args.limiteMin} minutos).`;
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Infra', `Cópia de pedidos de compra ${estado}`, empresa === 'acxe' ? 'ACXE' : 'Q2P');
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: `Infra: cópia de pedidos de compra ${estado}`,
    subtitulo: subtitulo(empresa === 'acxe' ? 'ACXE' : 'Q2P', args.status === 'degraded' ? `sem atualização há ${minutos} min` : ''),
    resumo: [
      situacao,
      `Enquanto isso, o recebimento de notas de compra nacional${da} com o recebimento fiscal pendente fica bloqueado no StockBridge, porque a sugestão do pedido de compra de cada item depende dessa cópia.`,
    ],
    acao: {
      quem: GESTOR_SI,
      passos: [
        'Confira no n8n o fluxo "ACXE e Q2P - Espelho de Pedidos de Compra (Materiais a chegar)": se está ativo e se as últimas execuções terminaram sem erro.',
        'No UAT, confira também a cópia de produção para o UAT.',
      ],
      nota: 'Notas com o recebimento fiscal já feito seguem normalmente.',
    },
    botao: { texto: 'Abrir a fila de recebimento', url: `${config.APP_URL}/stockbridge/fila` },
    duvidas: false,
  });
  try {
    await sendEmail({ to, subject, html, text });
    logger.info({ empresa, status: args.status, idadeMin: args.idadeMin }, 'Alerta de cópia de pedidos de compra defasada enviado');
    return true;
  } catch (err) {
    logger.error({ err, empresa }, 'Falha ao enviar alerta de cópia de pedidos de compra defasada');
    return false;
  }
}

/**
 * Feature 016 (revisão pré-UAT, ROT-4): a dispensa foi DESFEITA pelo gestor. O
 * fiscal foi avisado da dispensa e pode ter agido no OMIE (recusa, cancelamento,
 * estorno) — avisa que a nota voltou à fila e será recebida pelo Atlas.
 */
export async function enviarAlertaDispensaRevertida(args: {
  notaFiscal: string;
  fornecedorNome: string | null;
  situacaoFiscalNaDispensa: 'pendente' | 'concluido';
  motivoReversao: string;
  revertidoPorNome: string | null;
  revertidoEm?: string;
}): Promise<void> {
  const destinatarios = getFiscalEmails();
  if (destinatarios.length === 0) {
    logger.warn({ notaFiscal: args.notaFiscal }, 'STOCKBRIDGE_FISCAL_EMAILS vazio — fiscal não avisado da reversão da dispensa');
    return;
  }
  const nf = rotuloNf(args.notaFiscal);
  const subject = montarAssuntoQ2P('INFORMATIVO', 'Fiscal', 'Dispensa desfeita', nomeAssunto(args.fornecedorNome), nf);
  // ACXEGDP-440: sem botão — o fiscal age no OMIE e nem todos têm usuário no Atlas.
  const { html, text } = montarEmailQ2P({
    etiqueta: 'INFORMATIVO',
    assunto: subject,
    titulo: 'Fiscal: dispensa de NF desfeita',
    subtitulo: subtitulo(nf, nomeFornecedor(args.fornecedorNome)),
    resumo: `O gestor desfez a dispensa da ${nfFrase(args.notaFiscal)}: a nota voltou à fila de recebimento do StockBridge e será recebida pelo Atlas${args.situacaoFiscalNaDispensa === 'pendente' ? ', que também vai concluir o recebimento fiscal no OMIE' : ''}.`,
    semAcao:
      'Nenhuma ação necessária, a não ser que você já tenha agido no OMIE por causa do aviso de dispensa (recusa, cancelamento ou estorno). Nesse caso, avise o gestor antes de a nota ser recebida.',
    dados: [
      ['Motivo da reversão', args.motivoReversao],
      ['Desfeita por', args.revertidoPorNome ?? ''],
      ['Quando', dataHoraBrasilia(args.revertidoEm || new Date())],
    ],
  });
  try {
    const results = await Promise.allSettled(destinatarios.map((to) => sendEmail({ to, subject, html, text })));
    const falhas = logFalhasEnvio(results, destinatarios, { notaFiscal: args.notaFiscal, tipo: 'nf_dispensa_revertida' });
    if (falhas < destinatarios.length) {
      logger.info({ notaFiscal: args.notaFiscal, enviados: destinatarios.length - falhas, falhas }, 'Aviso de dispensa desfeita enviado ao fiscal');
    }
  } catch (err) {
    logger.error({ err, notaFiscal: args.notaFiscal }, 'Falha ao enviar aviso de dispensa desfeita ao fiscal');
  }
}

/**
 * Feature 017, research D21 (ACXEGDP-437): a entrada fisica da NF ja lancada no Atlas, para o aviso ao fiscal.
 * `pendentes` = itens aguardando a aprovacao do gestor; `aprovadas` = itens aprovados (`aprovadaEm` = a mais recente).
 */
export interface EntradaFisicaAvisoFiscal {
  pendentes: number;
  aprovadas: number;
  aprovadaEm: Date | string | null;
}

export interface ArgsAvisoFiscalRevertido {
  /** empresa da NF: 'acxe' cita a ACXE no assunto e no corpo (o fiscal da ACXE age no OMIE dela) */
  empresa: EmpresaNacional;
  /** numero da NF (zeros a esquerda saem aqui tambem) */
  notaFiscal: string;
  fornecedorNome: string | null;
  /** quando o Atlas concluiu o fiscal (finalizado_em do ledger) — ou, com `concluidoForaDoAtlas`, quando o Atlas o viu concluido */
  concluidoEm: Date | string | null;
  /**
   * O fiscal ja estava concluido no OMIE quando o Atlas olhou (ledger ja_concluido, recebido_antes 'S': quem concluiu foi o fiscal,
   * no portal). O texto nao diz "o Atlas concluiu" nesse caso. Ausente = concluido pelo Atlas.
   */
  concluidoForaDoAtlas?: boolean;
  /** desde quando aparece desfeito no OMIE: a hora da alteracao la, ou a da deteccao pelo Atlas */
  desfeitoEm: Date | string | null;
  entrada: EntradaFisicaAvisoFiscal;
  /** numeros dos PCs vinculados ao recebimento — so o numero legivel (o que parece codigo do OMIE sai) */
  pcs: string[];
}

/** "aguardando aprovação do gestor" | "aprovada em 26/10/2026" | os dois (parte dos itens aprovada); '' sem nenhum item contado. */
function textoEntradaFisica(e: EntradaFisicaAvisoFiscal): string {
  const dataAprovada = dataBrasilia(e.aprovadaEm);
  const aprovada = e.aprovadas > 0 ? `aprovada${dataAprovada ? ` em ${dataAprovada}` : ''}` : '';
  if (e.pendentes > 0 && e.aprovadas > 0) return `${aprovada} para parte dos itens; os demais aguardam aprovação do gestor`;
  if (e.pendentes > 0) return 'aguardando aprovação do gestor';
  return aprovada;
}

/**
 * Feature 017, research D21 (ACXEGDP-437): o recebimento fiscal que o Atlas concluiu no OMIE aparece DESFEITO no
 * portal e a entrada fisica da NF ja foi lancada no Atlas — os itens lancados nao voltam a fila (numa NF parcial o
 * item rejeitado volta) e o fiscal precisa ser refeito no portal. O e-mail diz o que fazer: concluir de novo no
 * portal SEM movimentar estoque (o estoque entra pela aprovacao do gestor; sem isso entraria em dobro) e
 * conferindo o vinculo com o pedido de compra. Corpo autossuficiente (o fiscal pode nao ter acesso ao Atlas, por
 * isso sem botao de acao) e sem codigo OMIE: a funcao nem recebe chave de acesso, nIdReceb ou nCodPed, e o PC sai
 * so pelo numero legivel (ACXEGDP-313). Um e-mail por destinatario (nao vaza a lista no To). Devolve 'enviado' se
 * AO MENOS UM destinatario recebeu — o job grava aviso_fiscal_em e nao repete: um endereco que o SendGrid recusa
 * sempre nao pode reenviar aos outros a cada rodada — e 'falha' se nenhum recebeu ou a lista esta vazia (o job
 * tenta de novo na proxima rodada). Nunca lanca.
 */
export async function enviarAvisoFiscalRevertido(args: ArgsAvisoFiscalRevertido): Promise<'enviado' | 'falha'> {
  let nf = '';
  try {
    nf = numeroSemZeros(args.notaFiscal);
    const destinatarios = getFiscalEmails();
    if (destinatarios.length === 0) {
      logger.warn({ notaFiscal: nf }, 'STOCKBRIDGE_FISCAL_EMAILS vazio — fiscal não avisado do recebimento fiscal desfeito no OMIE');
      return 'falha';
    }
    const daAcxe = args.empresa === 'acxe' ? ' da ACXE' : '';
    const rotulo = rotuloNf(nf, args.empresa);
    const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Fiscal', 'Recebimento desfeito no OMIE', nomeAssunto(args.fornecedorNome), rotulo);
    const situacao = textoEntradaFisica(args.entrada);
    // So o numero legivel do PC; vazio ou com cara de codigo interno do OMIE (10+ digitos) fica de fora (ACXEGDP-313).
    const pcs = Array.from(new Set((args.pcs ?? []).map((p) => String(p ?? '').trim()).filter((p) => p && !/^\d{10,}$/.test(p))));
    const textoPc = pcs.length === 1 ? `o pedido de compra PC ${pcs[0]}` : `os pedidos de compra ${listaPtBr(pcs.map((p) => `PC ${p}`))}`;
    const foraDoAtlas = args.concluidoForaDoAtlas === true;
    const { html, text } = montarEmailQ2P({
      etiqueta: 'AÇÃO REQUERIDA',
      assunto: subject,
      titulo: 'Fiscal: recebimento desfeito no OMIE',
      subtitulo: subtitulo(rotulo, nomeFornecedor(args.fornecedorNome)),
      resumo: [
        foraDoAtlas
          ? `O recebimento fiscal da ${nfFrase(nf)} estava concluído no OMIE${daAcxe} quando o Atlas o conferiu, mas agora ele aparece **desfeito**.`
          : `O Atlas concluiu o recebimento fiscal da ${nfFrase(nf)}, mas ele aparece **desfeito no OMIE${daAcxe}**.`,
        // Numa NF parcial o item rejeitado volta à fila: o texto fala dos itens lançados (2ª revisão da D21, commit c525107).
        'A entrada de estoque desta nota já foi lançada pelo Atlas: os itens lançados não voltam à fila de recebimento do StockBridge, e o recebimento fiscal precisa ser refeito no OMIE.',
      ],
      acao: {
        quem: 'Fiscal',
        // A ordem importa: concluir antes de conferir os itens lançaria o estoque em dobro. A reversão no portal
        // mantém os ajustes do item, por isso "confira" e não "marque".
        passos: [
          `Abra o recebimento desta nota no portal do OMIE${daAcxe}.`,
          'Em cada item, confira se **Não gerar movimento de estoque** está marcada: o estoque desta nota entra pela aprovação no Atlas, e sem essa opção ele entraria em dobro.',
          ...(pcs.length > 0 ? [`Em cada item, confira o vínculo com ${textoPc}.`] : []),
          'Depois, conclua o recebimento.',
        ],
      },
      // A empresa vai no subtítulo ("NF ACXE 6842"), não nos dados.
      dados: [
        [foraDoAtlas ? 'Visto concluído pelo Atlas em' : 'Concluído pelo Atlas em', dataHoraBrasilia(args.concluidoEm)],
        ['Desfeito no OMIE desde', dataHoraBrasilia(args.desfeitoEm)],
        ['Entrada de estoque no Atlas', situacao ? situacao.charAt(0).toUpperCase() + situacao.slice(1) : 'Lançada'],
        ['Pedido de compra', pcs.map((p) => `PC ${p}`).join(', ')],
      ],
    });
    const results = await Promise.allSettled(destinatarios.map((to) => sendEmail({ to, subject, html, text })));
    const falhas = logFalhasEnvio(results, destinatarios, { notaFiscal: nf, tipo: 'fiscal_revertido' });
    if (falhas >= destinatarios.length) return 'falha';
    logger.info({ notaFiscal: nf, empresa: args.empresa, enviados: destinatarios.length - falhas, falhas }, 'Aviso de recebimento fiscal desfeito no OMIE enviado ao fiscal');
    return 'enviado';
  } catch (err) {
    logger.error({ err, notaFiscal: nf }, 'Falha ao enviar aviso de recebimento fiscal desfeito no OMIE ao fiscal');
    return 'falha';
  }
}

/**
 * Feature 013 (FR-015): digest de divergências de uma NF de IMPORTAÇÃO multi-item.
 * Espelha o EML-09 do nacional — quando 2+ produtos da mesma NF divergem, cada
 * gestor recebe UM e-mail com a tabela dos itens, em vez de um alerta por item.
 * (Com 1 item divergente, o caller usa enviarAlertaAprovacaoPendente — paridade
 * com o comportamento single-item.)
 */
export async function enviarAlertaAprovacaoPendenteImportacaoLote(args: {
  notaFiscal: string;
  nivel: 'gestor' | 'diretor';
  itens: Array<{
    produto: string;
    quantidadeKg: number;
    deltaKg: number;
    tipoDivergencia: 'faltando' | 'varredura';
  }>;
}): Promise<void> {
  if (args.itens.length === 0) return;
  const destinatarios = await resolverEmailsAprovadores(args.nivel);
  if (destinatarios.length === 0) return;
  const config = getConfig();
  const linkPainel = `${config.APP_URL}/stockbridge/aprovacoes`;
  const n = args.itens.length;
  const nf = rotuloNf(args.notaFiscal);
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Aprovação', 'Divergência no recebimento', nf);
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: 'Aprovação: divergência no recebimento',
    subtitulo: subtitulo(nf, contagem(n, 'item', 'itens')),
    resumo: [
      `O recebimento de importação da ${nfFrase(args.notaFiscal)} tem **${contagem(n, 'item', 'itens')}** com peso diferente da nota aguardando a sua aprovação.`,
      // Restritiva: a nota pode só ter itens divergentes, ou ter item que falhou no OMIE.
      'Os itens desta nota que conferiram já entraram no estoque.',
    ],
    acao: {
      quem: args.nivel === 'diretor' ? 'Diretor' : 'Gestor',
      passos: ['Abra Aprovações no StockBridge.', 'Confira cada item e aprove ou rejeite. Ao rejeitar, informe o motivo.'],
    },
    secoes: [
      {
        titulo: 'Itens com divergência',
        tabela: {
          cab: ['Produto', 'Divergência', 'Recebido'],
          linhas: args.itens.map((it) => [
            it.produto,
            `${rotuloDivergencia(it.tipoDivergencia)}: ${fmtKg(Math.abs(it.deltaKg))} a menos`,
            fmtKg(it.quantidadeKg),
          ]),
          alinhar: ['e', 'e', 'd'],
        },
      },
    ],
    botao: { texto: 'Abrir aprovações pendentes', url: linkPainel },
  });
  try {
    const results = await Promise.allSettled(destinatarios.map((to) => sendEmail({ to, subject, html, text })));
    const falhas = logFalhasEnvio(results, destinatarios, { notaFiscal: args.notaFiscal });
    if (falhas < destinatarios.length) {
      logger.info({ notaFiscal: args.notaFiscal, itens: n, enviados: destinatarios.length - falhas, falhas }, 'Digest de divergencias de importacao enviado');
    }
  } catch (err) {
    logger.error({ err, notaFiscal: args.notaFiscal }, 'Falha ao enviar digest de divergencias de importacao');
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
  // EML-11: as pendências OMIE aparecem em Movimentações — a rota
  // /stockbridge/operacoes-pendentes não existe no SPA (link caía no redirect /).
  const linkPainel = `${config.APP_URL}/stockbridge/movimentacoes`;
  const ladoLabel = args.ladoPendente === 'q2p' ? 'o lançamento na Q2P' : 'a transferência da diferença na ACXE';
  const nf = rotuloNf(args.notaFiscal);
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Recebimento', 'Lançamento no OMIE pendente', nf);
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: 'Recebimento: lançamento no OMIE pendente',
    subtitulo: subtitulo(nf, `falta ${ladoLabel}`),
    resumo: [
      `O recebimento da ${nfFrase(args.notaFiscal)} ficou pela metade: o primeiro lançamento no OMIE deu certo, mas o seguinte falhou.`,
      'Nada se perdeu: basta tentar de novo.',
    ],
    acao: {
      quem: GESTOR_SI,
      passos: ['Abra Movimentações no StockBridge.', `Tente de novo o lançamento pendente da ${nfFrase(args.notaFiscal)}.`],
    },
    dados: [
      ['Tentativas já feitas', args.tentativas],
      // "Erro", não "Erro do OMIE": a mensagem já costuma começar por "OMIE".
      ['Erro', args.mensagemErro],
    ],
    botao: { texto: 'Abrir Movimentações', url: linkPainel },
    tecnico: [
      ['Movimentação', args.movimentacaoId],
      ['op_id', args.opId],
    ],
    duvidas: false,
  });
  try {
    await sendEmail({ to, bcc: alertaOpsCco(to), subject, html, text });
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar email de pendencia OMIE');
  }
}

/**
 * ACXEGDP-344: alerta ops quando a baixa do pedido de compra Q2P nao fechou —
 * 'falha' (OMIE falhou; retentavel pelo painel) ou 'sem_saldo' (descontou o
 * que havia mas sobrou quantidade sem pedido aberto — o mesmo aviso que o
 * legado mandava: "restou X para descontar sem estoque associado").
 * Sem codigos OMIE no corpo (ACXEGDP-313): produto por descricao, pedido pelo
 * numero, NF.
 */
export async function enviarAlertaBaixaPedidoQ2p(args: {
  movimentacaoId: string;
  notaFiscal: string;
  produtoDescricao: string;
  quantidadeKg: number;
  motivo: 'falha' | 'sem_saldo';
  mensagemErro?: string;
  restanteKg?: number;
  pedidos: Array<{ numero: string; saldoAnteriorKg: number; saldoNovoKg: number }>;
}): Promise<void> {
  const to = getOpsEmail();
  const config = getConfig();
  const linkPainel = `${config.APP_URL}/stockbridge/movimentacoes`;
  const ehFalha = args.motivo === 'falha';
  const nf = rotuloNf(args.notaFiscal);
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Pedido de compra Q2P', ehFalha ? 'Baixa não feita' : 'Saldo insuficiente', nf);
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: ehFalha ? 'Pedido de compra Q2P: baixa não feita' : 'Pedido de compra Q2P: saldo insuficiente',
    subtitulo: subtitulo(nf, args.produtoDescricao, fmtKg(args.quantidadeKg)),
    resumo: ehFalha
      ? [
          'A quantidade recebida entrou no estoque, mas a baixa no pedido de compra da Q2P no OMIE não foi concluída.',
          'Basta tentar outra vez: os pedidos já descontados não são descontados duas vezes.',
        ]
      : 'A quantidade recebida entrou no estoque, mas não havia pedido de compra da Q2P em aberto com saldo para descontar tudo.',
    acao: {
      quem: GESTOR_SI,
      passos: ehFalha
        ? ['Abra Movimentações no StockBridge.', 'Tente de novo a baixa do pedido na linha desta NF.']
        : ['Confira o pedido de compra no OMIE (ou o cadastro do produto).', 'Depois, tente de novo a baixa em Movimentações, no StockBridge.'],
    },
    dados: [
      [ehFalha ? 'Ainda por descontar' : 'Sem pedido para descontar', args.restanteKg != null && args.restanteKg > 0 ? fmtKg(args.restanteKg) : ''],
      ['Erro', args.mensagemErro ?? ''],
    ],
    secoes:
      args.pedidos.length > 0
        ? [
            {
              titulo: 'Pedidos descontados nesta baixa',
              tabela: {
                cab: ['Pedido', 'Saldo antes', 'Saldo depois'],
                linhas: args.pedidos.map((p) => [`Pedido ${p.numero}`, fmtKg(p.saldoAnteriorKg), fmtKg(p.saldoNovoKg)]),
                alinhar: ['e', 'd', 'd'],
              },
            },
          ]
        : [],
    botao: { texto: 'Abrir Movimentações', url: linkPainel },
    tecnico: [['Movimentação', args.movimentacaoId]],
    duvidas: false,
  });
  try {
    await sendEmail({ to, bcc: alertaOpsCco(to), subject, html, text });
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar email de baixa de pedido Q2P');
  }
}

/**
 * ACXEGDP-344 (política sem FIFO): NFs de importação recebidas há mais de N
 * dias e ainda sem vínculo NF→pedido na planilha FUP — a baixa do pedido Q2P
 * fica parada até a Comex preencher as filhotes no FUP. Um e-mail por dia.
 * ACXEGDP-440 (decisão 7): vai para a Comex, que age, com o Gestor do Sistema
 * Integrador em cópia oculta (antes ia só para a caixa ops). Sem botão: a Comex
 * age na FUP e não tem usuário no Atlas.
 */
export async function enviarDigestBaixasAguardandoVinculo(args: {
  itens: Array<{ notaFiscal: string; dias: number }>;
  diasLimite: number;
}): Promise<void> {
  if (args.itens.length === 0) return;
  const to = getComexEmail();
  const ops = getOpsEmail();
  const bcc = [ops, alertaOpsCco(ops)].filter((e): e is string => !!e);
  const n = args.itens.length;
  const umaSo = n === 1 ? args.itens[0] : undefined;
  const subject = montarAssuntoQ2P(
    'AÇÃO REQUERIDA',
    'Pedido de compra Q2P',
    umaSo ? 'NF sem vínculo na FUP' : 'NFs sem vínculo na FUP',
    umaSo ? rotuloNf(umaSo.notaFiscal) : `${n} NFs`,
  );
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: umaSo ? 'Pedido de compra Q2P: NF sem vínculo na FUP' : 'Pedido de compra Q2P: NFs sem vínculo na FUP',
    subtitulo: umaSo ? subtitulo(rotuloNf(umaSo.notaFiscal), `recebida há ${contagem(umaSo.dias, 'dia', 'dias')}`) : `${n} NFs`,
    resumo: [
      `${umaSo ? `A ${nfFrase(umaSo.notaFiscal)} foi recebida` : 'As NFs abaixo foram recebidas'} há mais de ${args.diasLimite} dias, mas a FUP ainda não diz a qual pedido ${umaSo ? 'ela pertence' : 'elas pertencem'}.`,
      'Sem esse vínculo, o Atlas não faz a baixa no pedido de compra da Q2P: ele não escolhe pedido por ordem de data.',
    ],
    acao: {
      quem: 'Comex',
      passos: [`Preencha na FUP ${umaSo ? 'a NF filhote' : 'as NFs filhotes'} no pedido correspondente.`],
      nota: 'A baixa acontece sozinha na hora seguinte.',
    },
    // Uma NF só: o subtítulo já diz qual é e há quanto tempo.
    secoes: umaSo
      ? []
      : [
          {
            titulo: 'NFs sem vínculo',
            tabela: {
              cab: ['NF', 'Recebida há'],
              linhas: args.itens.map((i) => [rotuloNf(i.notaFiscal), contagem(i.dias, 'dia', 'dias')]),
              alinhar: ['e', 'd'],
            },
          },
        ],
  });
  try {
    await sendEmail({ to, bcc, subject, html, text });
  } catch (err) {
    logger.error({ err, args }, 'Falha ao enviar digest de baixas aguardando vínculo');
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
 * ACXEGDP-396: contexto de negócio de uma entrada nacional (`tipo_aprovacao =
 * 'entrada_manual'`) para os e-mails ao operador — antes eles diziam só "Entrada
 * manual" e não identificavam NF, produto nem quantidade.
 *  - `porNf = true`: recebimento pela fila de NF (feature 015), que grava o mesmo
 *    tipo do lançamento à mão e se diferencia pela chave da NF. Tem fornecedor
 *    e item da NF.
 *  - `porNf = false`: formulário manual. A NF é o número digitado (gravado na
 *    movimentação); não há fornecedor nem item.
 * `null` para outros tipos (inclusive a baixa por recebimento externo) e em
 * falha de leitura: o e-mail cai no texto genérico, nunca deixa de sair.
 */
export interface ContextoEntradaNacional {
  porNf: boolean;
  notaFiscal: string | null;
  fornecedor: string | null;
  itemNf: string | null;
  produto: string | null;
  quantidadeKg: string | null;
  local: string | null;
  /**
   * Historia 5 (ACXEGDP-437): em que empresas a entrada e lancada — "ACXE + Q2P" (compra nacional da ACXE em estoque
   * que tambem e da Q2P; com "(lançamento na Q2P pendente)" quando a perna da Q2P falhou na aprovacao) ou "ACXE".
   * null na Q2P: o e-mail segue como sempre.
   */
  entradaEm: string | null;
}

export async function carregarContextoEntradaNacional(aprovacaoId: string): Promise<ContextoEntradaNacional | null> {
  try {
    const res = await getDb().execute<{
      por_nf: boolean;
      nota_fiscal: string | null;
      fornecedor: string | null;
      item_nf: string | null;
      produto: string | null;
      quantidade_kg: string | null;
      local: string | null;
      empresa?: string | null;
      tem_produto_q2p?: boolean | null;
      q2p_pendente?: boolean | null;
    }>(sql`
      SELECT (a.nf_chave_acesso IS NOT NULL) AS por_nf,
             COALESCE(a.nota_fiscal, m.nota_fiscal) AS nota_fiscal,
             COALESCE(f.dest_razao, fa.dest_razao) AS fornecedor,
             a.nf_item_descricao AS item_nf,
             COALESCE(p.descricao, pa.descricao) AS produto,
             COALESCE(a.quantidade_recebida_kg, a.quantidade_prevista_kg)::text AS quantidade_kg,
             COALESCE(l.nome, a.galpao) AS local,
             a.empresa AS empresa,
             (a.produto_codigo_q2p IS NOT NULL) AS tem_produto_q2p,
             (m.status_omie = 'pendente_q2p' AND m.mv_acxe = 1) AS q2p_pendente
      FROM stockbridge.aprovacao a
      LEFT JOIN stockbridge.movimentacao m ON m.id = a.movimentacao_id
      LEFT JOIN public."tbl_produtos_Q2P" p ON p.codigo_produto = a.produto_codigo_q2p
      LEFT JOIN public."tbl_produtos_ACXE" pa ON pa.codigo_produto = a.produto_codigo_acxe
      LEFT JOIN stockbridge.localidade l ON l.codigo = a.galpao
      LEFT JOIN LATERAL (
        SELECT h.dest_razao FROM public."tbl_nf_header_Q2P" h
        WHERE h.c_chave_nfe = a.nf_chave_acesso
        LIMIT 1
      ) f ON true
      -- Historia 5: a chave de acesso e unica entre os espelhos — a NF da ACXE esta no espelho da ACXE.
      LEFT JOIN LATERAL (
        SELECT h.dest_razao FROM public."tbl_nf_header_ACXE" h
        WHERE h.c_chave_nfe = a.nf_chave_acesso
        LIMIT 1
      ) fa ON true
      WHERE a.id = ${aprovacaoId}::uuid
        AND a.tipo_aprovacao = 'entrada_manual'
    `);
    const r = res.rows[0];
    if (!r) return null;
    return {
      porNf: r.por_nf === true,
      notaFiscal: r.nota_fiscal,
      fornecedor: r.fornecedor,
      itemNf: r.item_nf,
      produto: r.produto,
      quantidadeKg: r.quantidade_kg,
      local: r.local,
      // Entrada nas duas empresas = compra nacional da ACXE por NF com o produto da Q2P gravado (ver entrada-nacional-espelhada.ts).
      // Perna da Q2P que falhou na aprovacao (ACXE lancada, Q2P pendente de retentativa): o e-mail diz.
      entradaEm:
        r.empresa === 'acxe'
          ? r.por_nf === true && r.tem_produto_q2p === true
            ? r.q2p_pendente === true
              ? 'ACXE + Q2P (lançamento na Q2P pendente)'
              : 'ACXE + Q2P'
            : 'ACXE'
          : null,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message, aprovacaoId }, 'Falha ao carregar contexto da entrada nacional para o e-mail');
    return null;
  }
}

function tipoEntradaLabel(ctx: ContextoEntradaNacional): string {
  return ctx.porNf ? 'Recebimento nacional (NF)' : 'Recebimento nacional (manual)';
}

/**
 * Tema do assunto do e-mail ao operador (ACXEGDP-440): o manual leva "manual" logo no
 * tema (o fim de assuntos longos é cortado na caixa de entrada). '' quando não há
 * número de NF — o caller usa o genérico, com o tipo do lançamento.
 */
function temaEntrada(ctx: ContextoEntradaNacional | null): string {
  if (!ctx || !numeroSemZeros(ctx.notaFiscal)) return '';
  return ctx.porNf ? 'Recebimento' : 'Recebimento manual';
}

/** Dados da entrada nacional; a NF e o fornecedor vão no subtítulo. Linha vazia some (o manual não tem item). */
function dadosEntrada(ctx: ContextoEntradaNacional): Array<[string, string]> {
  return [
    ['Item da NF', ctx.itemNf ?? ''],
    ['Produto', ctx.produto ?? ''],
    ['Quantidade', ctx.quantidadeKg != null ? fmtKg(ctx.quantidadeKg) : ''],
    ['Local', ctx.local ?? ''],
    ['Empresas da entrada', ctx.entradaEm ?? ''],
  ];
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
  const config = getConfig();
  // EML-11: a tela de recebimento é /stockbridge/fila — o link antigo
  // (/stockbridge/recebimento) não existe no SPA e caía no redirect para /.
  const paginaPath = args.fluxo === 'recebimento' ? '/stockbridge/fila' : '/stockbridge/saida-manual';
  const paginaLabel = args.fluxo === 'recebimento' ? 'Fila de Recebimento' : 'Saída Manual';
  const acaoLabel = args.fluxo === 'recebimento' ? 'Reenviar agora' : 'Lançar novamente';
  const link = `${config.APP_URL}${paginaPath}#rejeicao=${args.aprovacaoId}`;
  const ctx = await carregarContextoEntradaNacional(args.aprovacaoId);
  const tipoLabel = ctx ? tipoEntradaLabel(ctx) : labelTipoAprovacao(args.tipoAprovacao);
  const nf = ctx ? rotuloNf(ctx.notaFiscal) : '';
  const tema = temaEntrada(ctx);
  // EML-12: o operador identifica de qual lançamento se trata sem abrir o e-mail. O manual
  // fica só com "Rejeitado" para caber nos 76 caracteres do padrão (ACXEGDP-436).
  const subject = tema
    ? montarAssuntoQ2P('AÇÃO REQUERIDA', tema, ctx?.porNf ? 'Rejeitado, corrigir e reenviar' : 'Rejeitado', nf)
    : montarAssuntoQ2P('AÇÃO REQUERIDA', 'Lançamento', 'Rejeitado', tipoLabel);
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: `Lançamento rejeitado: ${tipoLabel}`,
    subtitulo: ctx ? subtitulo(nf, ctx.fornecedor) : '',
    resumo: `O lançamento de **${tipoLabel}** que você fez no StockBridge foi **rejeitado** na aprovação.`,
    acao: {
      quem: 'Quem fez o lançamento',
      passos: [
        'Leia o motivo da rejeição, abaixo.',
        args.fluxo === 'recebimento' ? 'Corrija os dados e reenvie para nova aprovação.' : 'Corrija os dados e lance de novo.',
      ],
      nota: `O lançamento também aparece na seção **Lançamentos rejeitados** da tela ${paginaLabel}.`,
    },
    dados: ctx ? dadosEntrada(ctx) : [],
    secoes: [{ titulo: 'Motivo da rejeição', texto: args.motivo, destaque: 'erro' }],
    botao: { texto: acaoLabel, url: link },
    ref: `Referência: aprovação ${args.aprovacaoId.slice(0, 8)}`,
  });
  try {
    // ACXEGDP-440: o admin acompanha em cópia oculta (era Cc visível).
    await sendEmail({ to, bcc: config.STOCKBRIDGE_ADMIN_CC_EMAIL || undefined, subject, html, text });
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
  /** Apenas referência técnica de rodapé — alguns fluxos passam id de movimentação. */
  loteId?: string;
  /**
   * True quando se trata de um recebimento divergente concluido com SUCESSO (gestor
   * aprovou + ambos os lados OMIE ok). Nesse caso a caixa de Comex entra em copia —
   * o estoque efetivamente entrou. Nao usar em saidas nem quando ha pendencia OMIE.
   */
  incluirComex?: boolean;
  /**
   * ACXEGDP-440: parte do lançamento no OMIE ficou pendente (pendente_q2p ou pendente_acxe_faltando) — o e-mail diz
   * isso em vez de afirmar que o ajuste entrou nas duas empresas. O Gestor do Sistema Integrador recebe o alerta.
   */
  pendenciaOmie?: boolean;
}): Promise<void> {
  const to = await resolverEmailOperador(args.operadorUserId);
  if (!to) {
    logger.warn({ args }, 'Operador sem email cadastrado — notificacao de aprovacao nao enviada');
    return;
  }
  const ctx = await carregarContextoEntradaNacional(args.aprovacaoId);
  const tipoLabel = ctx ? tipoEntradaLabel(ctx) : labelTipoAprovacao(args.tipoAprovacao);
  const nf = ctx ? rotuloNf(ctx.notaFiscal) : '';
  const tema = temaEntrada(ctx);
  // EML-12: tipo humanizado no assunto.
  const subject = tema
    ? montarAssuntoQ2P('INFORMATIVO', tema, 'Aprovado', nf)
    : montarAssuntoQ2P('INFORMATIVO', 'Lançamento', 'Aprovado', tipoLabel);
  const comex = args.incluirComex ? getComexEmail() : null;
  const { html, text } = montarEmailQ2P({
    etiqueta: 'INFORMATIVO',
    assunto: subject,
    titulo: `Lançamento aprovado: ${tipoLabel}`,
    subtitulo: ctx ? subtitulo(nf, ctx.fornecedor) : '',
    resumo: [
      `O lançamento de **${tipoLabel}** que você fez no StockBridge foi **aprovado**.`,
      ...(args.tipoAprovacao === 'recebimento_divergencia'
        ? [
            args.pendenciaOmie
              ? 'Parte do lançamento no OMIE ficou pendente: o Gestor do Sistema Integrador vai concluir.'
              : 'O ajuste foi lançado no OMIE (ACXE e Q2P) com a quantidade aprovada.',
          ]
        : []),
    ],
    copia: comex ? '**Em cópia (Comex):** nenhuma ação. O estoque deste recebimento já entrou.' : '',
    dados: ctx ? dadosEntrada(ctx) : [],
    ref: `Referência: aprovação ${args.aprovacaoId.slice(0, 8)}`,
  });
  try {
    // ACXEGDP-440: a Comex acompanha em cópia visível (o estoque entrou); o admin, em cópia oculta (era Cc visível).
    await sendEmail({ to, cc: comex ?? undefined, bcc: getConfig().STOCKBRIDGE_ADMIN_CC_EMAIL || undefined, subject, html, text });
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
  const nf = rotuloNf(args.notaFiscal);
  const subject = montarAssuntoQ2P('INFORMATIVO', 'Recebimento', 'Concluído', nf);
  const { html, text } = montarEmailQ2P({
    etiqueta: 'INFORMATIVO',
    assunto: subject,
    titulo: 'Recebimento concluído',
    subtitulo: subtitulo(nf, args.fornecedor),
    resumo: `O recebimento da ${nfFrase(args.notaFiscal)} foi registrado no StockBridge sem divergência. O estoque já entrou no OMIE (ACXE e Q2P).`,
    dados: [
      ['Produto', args.produto],
      ['Quantidade recebida', fmtKg(args.quantidadeKg)],
      ['Local de destino', args.localidade],
      ['Lote', args.loteCodigo],
    ],
  });
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

/**
 * Feature 013: confirmação de recebimento de NF multi-item concluído — um e-mail
 * com a tabela dos produtos que entraram (ACXE + Q2P), em vez de um por lote.
 * Mesmos destinatários do single-item (EML-14): operador que lançou + Comex.
 */
export async function enviarNotificacaoRecebimentoConcluidoLote(args: {
  operadorUserId: string;
  notaFiscal: string;
  fornecedor: string | null;
  itens: Array<{ loteCodigo: string; produto: string; quantidadeKg: number; localidade: string }>;
}): Promise<void> {
  if (args.itens.length === 0) return;
  const emailOperador = await resolverEmailOperador(args.operadorUserId);
  const destinatarios = [
    ...new Set([emailOperador, getComexEmail()].filter((e): e is string => !!e)),
  ];
  if (destinatarios.length === 0) {
    logger.warn({ notaFiscal: args.notaFiscal }, 'Nenhum destinatario para confirmacao de recebimento');
    return;
  }
  const n = args.itens.length;
  const nf = rotuloNf(args.notaFiscal);
  const subject = montarAssuntoQ2P('INFORMATIVO', 'Recebimento', 'Concluído', nf);
  const { html, text } = montarEmailQ2P({
    etiqueta: 'INFORMATIVO',
    assunto: subject,
    titulo: 'Recebimento concluído',
    subtitulo: subtitulo(nf, args.fornecedor, contagem(n, 'produto', 'produtos')),
    resumo: `O recebimento da ${nfFrase(args.notaFiscal)} foi registrado no StockBridge. O estoque ${n === 1 ? 'do produto abaixo' : `dos ${n} produtos abaixo`} já entrou no OMIE (ACXE e Q2P).`,
    secoes: [
      {
        titulo: n === 1 ? 'Produto' : 'Produtos',
        tabela: {
          cab: ['Produto', 'Lote', 'Local', 'Quantidade'],
          linhas: args.itens.map((it) => [it.produto, it.loteCodigo, it.localidade, fmtKg(it.quantidadeKg)]),
          alinhar: ['e', 'e', 'e', 'd'],
        },
      },
    ],
  });
  try {
    const results = await Promise.allSettled(destinatarios.map((to) => sendEmail({ to, subject, html, text })));
    const falhas = logFalhasEnvio(results, destinatarios, { notaFiscal: args.notaFiscal });
    if (falhas < destinatarios.length) {
      logger.info(
        { notaFiscal: args.notaFiscal, itens: n, enviados: destinatarios.length - falhas, falhas },
        'Confirmacao de recebimento multi-item enviada',
      );
    }
  } catch (err) {
    logger.error({ err, notaFiscal: args.notaFiscal }, 'Falha ao enviar confirmacao de recebimento multi-item');
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
  const n = args.comodatos.length;
  const temEscalada = args.comodatos.some((c) => c.fase === 'escalada');
  const quantos = contagem(n, 'comodato', 'comodatos');
  const subject = montarAssuntoQ2P('AÇÃO REQUERIDA', 'Comodato', temEscalada ? 'Vencido há mais de 15 dias' : 'Retorno vencido', quantos);
  const { html, text } = montarEmailQ2P({
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: subject,
    titulo: n === 1 ? 'Comodato: retorno vencido' : 'Comodatos: retorno vencido',
    subtitulo: `${quantos} em aberto`,
    resumo: [
      `Você tem ${quantos} com a data prevista de retorno vencida.`,
      ...(temEscalada
        ? [`${n === 1 ? 'Ele está vencido' : 'Pelo menos um deles está vencido'} há mais de 15 dias: o aviso foi escalado para a diretoria.`]
        : []),
    ],
    acao: {
      quem: 'Quem fez a saída e o gestor',
      passos: [
        'Confira com o cliente a devolução do material.',
        'Quando o material voltar, registre o retorno em **Retorno de Comodato**, no StockBridge.',
      ],
      nota: temEscalada ? 'O aviso se repete a cada 15 dias enquanto o comodato seguir em aberto.' : '',
    },
    secoes: [
      {
        titulo: n === 1 ? 'Comodato vencido' : 'Comodatos vencidos',
        tabela: {
          cab: ['Cliente', 'Produto', 'Quantidade', 'Saída', 'Retorno previsto', 'Vencido há'],
          linhas: [...args.comodatos]
            .sort((a, b) => b.diasVencido - a.diasVencido)
            .map((c) => [
              c.cliente ?? 'Sem cliente informado',
              `${c.produtoDescricao} (galpão ${c.galpaoOrigem})`,
              fmtKg(c.quantidadeKg),
              dataBrasilia(c.dtSaida),
              dataBrasilia(c.dtPrevistaRetorno),
              `${contagem(c.diasVencido, 'dia', 'dias')}${c.fase === 'escalada' ? ' (escalado)' : ''}`,
            ]),
          alinhar: ['e', 'e', 'd', 'c', 'c', 'd'],
        },
      },
    ],
    botao: { texto: 'Abrir Retorno de Comodato', url: linkPainel },
  });
  try {
    await sendEmail({ to: args.to, subject, html, text });
    logger.info({ to: args.to, comodatos: n, escalada: temEscalada }, 'Digest de comodatos vencidos enviado');
  } catch (err) {
    logger.error({ err, to: args.to }, 'Falha ao enviar digest de comodatos vencidos');
  }
}
