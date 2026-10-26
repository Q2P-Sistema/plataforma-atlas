/**
 * Gerador comum dos e-mails do Atlas (ACXEGDP-440): porta da `emailQ2P` dos fluxos do n8n (ACXEGDP-436,
 * `backup-workflow-n8n/specs/436-emails/corpo/emailQ2P.lib.js`). Mesma estrutura, mesmas cores e, para a mesma
 * entrada válida, o mesmo HTML byte a byte (teste de paridade em `__tests__/email-q2p.test.ts`). Cada e-mail só
 * informa o conteúdo; a ordem dos blocos é fixa: faixa (etiqueta, título, subtítulo) · resumo · "O que fazer"
 * (AÇÃO REQUERIDA) ou "Nenhuma ação necessária" (INFORMATIVO) · aviso a quem está em cópia · dados · seções ·
 * botão · detalhes técnicos · rodapé único.
 *
 * Texto: `**negrito**` vira <strong>; todo o resto é escapado. Nunca passe HTML.
 *
 * Diferenças da referência, só para entrada inválida (lá ela lança erro ou escreve "undefined"): valor ausente,
 * NaN, objeto ou função vira vazio; linha de dados vazia, item de lista vazio e lista vazia somem; célula de
 * tabela vazia vira "—"; botão sem texto ou sem endereço http(s) não é desenhado. Também devolve a versão em
 * texto puro, que o Atlas manda junto com o HTML.
 */

export type EtiquetaEmail = 'AÇÃO REQUERIDA' | 'INFORMATIVO';

/** Valor mostrado no e-mail. O que não for texto ou número finito vira vazio. */
export type TextoEmail = string | number | null | undefined;

export interface SecaoEmailQ2P {
  titulo: TextoEmail;
  texto?: TextoEmail;
  itens?: TextoEmail[];
  /** 'num' numerada, 'check' com ☐, '' ou ausente com marcador */
  lista?: 'num' | 'check' | '';
  /** `alinhar`: um por coluna, 'e' esquerda, 'd' direita, 'c' centro; padrão: 1ª coluna à esquerda e as outras à direita */
  tabela?: { cab: TextoEmail[]; linhas: TextoEmail[][]; alinhar?: Array<'e' | 'd' | 'c'> };
  destaque?: 'erro' | 'alerta' | '';
}

export interface EmailQ2POptions {
  /** igual ao começo do assunto */
  etiqueta: EtiquetaEmail;
  /** o assunto enviado (vai no <title>) */
  assunto: string;
  /** uma linha: "Tema: situação" */
  titulo: TextoEmail;
  /** a informação-chave: "NF 6842 · Fornecedor · R$ 10.000,00" */
  subtitulo?: TextoEmail;
  /** texto oculto da prévia na caixa de entrada; padrão: a 1ª frase do resumo */
  preheader?: TextoEmail;
  /** 1 a 2 frases: o que aconteceu */
  resumo?: TextoEmail | TextoEmail[];
  /** só AÇÃO REQUERIDA; passos em ordem, no máximo 4 */
  acao?: { quem?: TextoEmail; passos?: TextoEmail[]; nota?: TextoEmail };
  /** só INFORMATIVO; padrão "Nenhuma ação necessária." */
  semAcao?: TextoEmail;
  /** aviso a quem está em cópia visível: "**Em cópia (Comex):** nenhuma ação." */
  copia?: TextoEmail;
  /** [rótulo, valor]; linha com valor vazio sai sozinha */
  dados?: Array<[TextoEmail, TextoEmail]>;
  secoes?: SecaoEmailQ2P[];
  botao?: { texto: TextoEmail; url: TextoEmail; nota?: TextoEmail };
  /** só nos e-mails em que o Gestor do Sistema Integrador é o destinatário principal */
  tecnico?: Array<[TextoEmail, TextoEmail]>;
  /** referência curta para o suporte, em letra pequena no rodapé */
  ref?: TextoEmail;
  /** false tira a linha "Dúvidas: ..." quando o leitor é o próprio Gestor do Sistema Integrador */
  duvidas?: boolean;
}

const RODAPE = 'Mensagem automática do Sistema Integrador Q2P.';
const RODAPE_DUVIDAS = ' Dúvidas: fale com o Gestor do Sistema Integrador.';

function textoDe(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'bigint') return String(v);
  return '';
}

const esc = (v: unknown): string =>
  textoDe(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const rico = (v: unknown): string => esc(v).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
const semNegrito = (v: unknown): string => textoDe(v).replace(/\*\*(.+?)\*\*/g, '$1');

function naoVazios(itens: unknown): TextoEmail[] {
  return (Array.isArray(itens) ? itens : []).filter((i): i is TextoEmail => textoDe(i).trim() !== '');
}

function linhasDados(linhas: unknown): Array<[TextoEmail, TextoEmail]> {
  return (Array.isArray(linhas) ? linhas : []).filter(
    (l): l is [TextoEmail, TextoEmail] => Array.isArray(l) && textoDe(l[1]).trim() !== '',
  );
}

const ALINHAMENTO = { e: 'left', d: 'right', c: 'center' } as const;

/** O e-mail em HTML e em texto puro. Nunca lança por campo ausente. */
export function montarEmailQ2P(o: EmailQ2POptions): { html: string; text: string } {
  const acao = o.etiqueta === 'AÇÃO REQUERIDA';
  const faixa = acao ? '#9a3412' : '#1f2937';
  const chip = acao ? ['#fed7aa', '#7c2d12'] : ['#bfdbfe', '#1e3a8a'];
  const bloco = (pad: string, inner: string) => `<tr><td style="padding:${pad};">${inner}</td></tr>`;
  const caixa = (borda: string, fundo: string, inner: string) =>
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid ${borda}; background-color:${fundo}; border-radius:8px;"><tr><td style="padding:16px 18px;">${inner}</td></tr></table>`;
  const lis = (itens: unknown, tag: 'ol' | 'ul', cor: string) => {
    const ok = naoVazios(itens);
    if (!ok.length) return '';
    return `<${tag} style="margin:8px 0 0 0; padding:0 0 0 22px; font-size:14px; line-height:22px; color:${cor};">` +
      ok.map((i) => `<li style="margin:0 0 6px 0;">${rico(i)}</li>`).join('') + `</${tag}>`;
  };
  const par = (t: TextoEmail) => `<p style="margin:0 0 10px 0; font-size:15px; line-height:24px; color:#1f2937;">${rico(t)}</p>`;
  const tabela2 = (linhas: unknown, estilo = '') => {
    const ok = linhasDados(linhas);
    if (!ok.length) return '';
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e5e7eb; border-radius:8px; border-collapse:separate;${estilo}">` +
      ok.map((l, i) => `<tr><td width="38%" valign="top" style="padding:9px 14px; background-color:#f9fafb; font-size:13px; line-height:20px; color:#6b7280;${i ? ' border-top:1px solid #eef0f3;' : ''}">${esc(l[0])}</td><td valign="top" style="padding:9px 14px; font-size:14px; line-height:20px; color:#111827;${i ? ' border-top:1px solid #eef0f3;' : ''}">${rico(l[1])}</td></tr>`).join('') + '</table>';
  };

  const resumo = naoVazios(Array.isArray(o.resumo) ? o.resumo : [o.resumo]);
  const pre = esc((textoDe(o.preheader) || textoDe(resumo[0])).replace(/\*\*/g, ''));
  const secoes = (Array.isArray(o.secoes) ? o.secoes : []).filter((s): s is SecaoEmailQ2P => !!s && typeof s === 'object');
  const botaoTexto = textoDe(o.botao?.texto);
  const botaoUrl = textoDe(o.botao?.url).trim();
  const temBotao = botaoTexto.trim() !== '' && /^https?:\/\//i.test(botaoUrl);

  let c = '';
  c += bloco('24px 32px 8px 32px', resumo.map(par).join(''));
  if (acao && o.acao) {
    const a = o.acao;
    c += bloco('4px 32px 20px 32px', caixa('#fdba74', '#fff7ed',
      `<p style="margin:0; font-size:16px; line-height:22px; font-weight:bold; color:#9a3412;">O que fazer</p>` +
      (textoDe(a.quem) ? `<p style="margin:4px 0 0 0; font-size:13px; line-height:20px; color:#9a3412;">Quem age: <strong>${esc(a.quem)}</strong></p>` : '') +
      lis(a.passos, 'ol', '#7c2d12') +
      (textoDe(a.nota) ? `<p style="margin:10px 0 0 0; font-size:13px; line-height:20px; color:#7c2d12;">${rico(a.nota)}</p>` : '')));
  } else if (!acao) {
    c += bloco('4px 32px 20px 32px', caixa('#e5e7eb', '#f3f4f6', `<p style="margin:0; font-size:14px; line-height:22px; color:#374151;">${rico(textoDe(o.semAcao) || 'Nenhuma ação necessária.')}</p>`));
  }
  if (textoDe(o.copia)) c += bloco('0 32px 20px 32px', `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-left:4px solid #9ca3af; padding:4px 0 4px 14px; font-size:13px; line-height:20px; color:#4b5563;">${rico(o.copia)}</td></tr></table>`);
  const dados = tabela2(o.dados);
  if (dados) c += bloco('0 32px 20px 32px', dados);
  secoes.forEach((s) => {
    const cor = s.destaque === 'erro' ? ['#fecaca', '#fef2f2', '#991b1b', '#7f1d1d'] : s.destaque === 'alerta' ? ['#fdba74', '#fff7ed', '#9a3412', '#7c2d12'] : ['#e5e7eb', '#ffffff', '#111827', '#374151'];
    let m = `<p style="margin:0; font-size:15px; line-height:22px; font-weight:bold; color:${cor[2]};">${esc(s.titulo)}</p>`;
    if (textoDe(s.texto)) m += `<p style="margin:8px 0 0 0; font-size:14px; line-height:22px; color:${cor[3]};">${rico(s.texto)}</p>`;
    const itens = naoVazios(s.itens);
    if (itens.length && s.lista === 'check') m += `<ul style="margin:8px 0 0 0; padding:0; list-style:none; font-size:14px; line-height:22px; color:${cor[3]};">` + itens.map((i) => `<li style="margin:0 0 6px 0;">☐ ${rico(i)}</li>`).join('') + '</ul>';
    else if (itens.length) m += lis(itens, s.lista === 'num' ? 'ol' : 'ul', cor[3] ?? '');
    if (s.tabela) {
      const alinhar: unknown[] = Array.isArray(s.tabela.alinhar) ? s.tabela.alinhar : [];
      const al = (i: number) => {
        const a = alinhar[i];
        return a === 'e' || a === 'd' || a === 'c' ? ALINHAMENTO[a] : i ? 'right' : 'left';
      };
      const cab: unknown[] = Array.isArray(s.tabela.cab) ? s.tabela.cab : [];
      const linhas: unknown[] = Array.isArray(s.tabela.linhas) ? s.tabela.linhas : [];
      m += `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:10px; border:1px solid #e5e7eb; border-collapse:separate; border-radius:6px;"><tr>` +
        cab.map((h, i) => `<td valign="top" style="padding:8px 10px; background-color:#f3f4f6; font-size:12px; font-weight:bold; color:#4b5563; text-align:${al(i)};">${esc(h)}</td>`).join('') + '</tr>' +
        linhas.map((l) => '<tr>' + (Array.isArray(l) ? l : []).map((v: unknown, i: number) => `<td valign="top" style="padding:8px 10px; border-top:1px solid #eef0f3; font-size:13px; line-height:19px; color:#111827; text-align:${al(i)};">${textoDe(v).trim() ? rico(v) : '—'}</td>`).join('') + '</tr>').join('') + '</table>';
    }
    c += bloco('0 32px 20px 32px', caixa(cor[0] ?? '', cor[1] ?? '', m));
  });
  if (temBotao) {
    c += bloco('4px 32px 24px 32px', `<div style="text-align:center;"><a href="${esc(botaoUrl)}" style="display:inline-block; background-color:#1d4ed8; color:#ffffff; text-decoration:none; padding:14px 32px; border-radius:8px; font-size:15px; font-weight:bold;">${esc(botaoTexto)}</a>` +
      (textoDe(o.botao?.nota) ? `<p style="margin:12px 0 0 0; font-size:12px; line-height:18px; color:#6b7280;">${rico(o.botao?.nota)}</p>` : '') + '</div>');
  }
  const tec = tabela2(o.tecnico, ' border-style:dashed;');
  if (tec) c += bloco('0 32px 20px 32px', `<p style="margin:0 0 6px 0; font-size:11px; letter-spacing:0.5px; text-transform:uppercase; color:#6b7280;">Detalhes técnicos (suporte)</p>${tec}`);
  const rodape = `<p style="margin:0; font-size:12px; line-height:18px; color:#6b7280;">${RODAPE}${o.duvidas === false ? '' : RODAPE_DUVIDAS}</p>` +
    (textoDe(o.ref) ? `<p style="margin:6px 0 0 0; font-size:11px; line-height:16px; color:#9ca3af;">${esc(o.ref)}</p>` : '');
  const subtitulo = textoDe(o.subtitulo);
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(o.assunto)}</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f6f8; font-family:Arial, Helvetica, sans-serif; color:#333333;">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; font-size:1px; line-height:1px; color:#f4f6f8; mso-hide:all;">${pre}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f6f8; margin:0; padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="700" cellspacing="0" cellpadding="0" border="0" style="max-width:700px; width:100%; background-color:#ffffff; border:1px solid #e5e7eb; border-radius:10px; overflow:hidden;">
          <tr>
            <td style="background-color:${faixa}; padding:22px 32px 24px 32px;">
              <span style="display:inline-block; background-color:${chip[0]}; color:${chip[1]}; font-size:12px; line-height:16px; font-weight:bold; letter-spacing:1px; padding:4px 10px; border-radius:4px;">${esc(o.etiqueta)}</span>
              <h1 style="margin:12px 0 0 0; font-size:22px; line-height:30px; color:#ffffff; font-weight:bold;">${esc(o.titulo)}</h1>
              ${subtitulo ? `<p style="margin:6px 0 0 0; font-size:14px; line-height:22px; color:#e5e7eb;">${esc(subtitulo)}</p>` : ''}
            </td>
          </tr>
          ${c}
          <tr>
            <td style="background-color:#f3f4f6; padding:16px 32px; text-align:center;">${rodape}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  // Versão em texto puro: os mesmos blocos, na mesma ordem.
  const blocos: string[] = [];
  const add = (...linhas: string[]) => {
    const ok = linhas.map((l) => l.trim()).filter(Boolean);
    if (ok.length) blocos.push(ok.join('\n'));
  };
  add(`[${semNegrito(o.etiqueta)}] ${semNegrito(o.titulo)}`, semNegrito(o.subtitulo));
  add(...resumo.map(semNegrito));
  if (acao && o.acao) {
    const quem = semNegrito(o.acao.quem);
    add('O que fazer', quem ? `Quem age: ${quem}` : '', ...naoVazios(o.acao.passos).map((p, i) => `${i + 1}. ${semNegrito(p)}`), semNegrito(o.acao.nota));
  } else if (!acao) {
    add(semNegrito(o.semAcao) || 'Nenhuma ação necessária.');
  }
  add(semNegrito(o.copia));
  add(...linhasDados(o.dados).map(([r, v]) => `${semNegrito(r)}: ${semNegrito(v)}`));
  for (const s of secoes) {
    const itens = naoVazios(s.itens).map((it, i) => `${s.lista === 'num' ? `${i + 1}.` : s.lista === 'check' ? '☐' : '-'} ${semNegrito(it)}`);
    const tabela = s.tabela
      ? [
          (Array.isArray(s.tabela.cab) ? s.tabela.cab : []).map(semNegrito).join(' | '),
          ...(Array.isArray(s.tabela.linhas) ? s.tabela.linhas : []).map((l) =>
            (Array.isArray(l) ? l : []).map((v: unknown) => semNegrito(v).trim() || '—').join(' | '),
          ),
        ]
      : [];
    add(semNegrito(s.titulo), semNegrito(s.texto), ...itens, ...tabela);
  }
  if (temBotao) add(`${semNegrito(botaoTexto)}: ${botaoUrl}`, semNegrito(o.botao?.nota));
  const tecnico = linhasDados(o.tecnico);
  if (tecnico.length) add('Detalhes técnicos (suporte)', ...tecnico.map(([r, v]) => `${semNegrito(r)}: ${semNegrito(v)}`));
  add(`${RODAPE}${o.duvidas === false ? '' : RODAPE_DUVIDAS}`, semNegrito(o.ref));

  return { html, text: blocos.join('\n\n') };
}

/**
 * Assunto no padrão da ACXEGDP-436: "[ETIQUETA] - Tema - Situação - Identificador". Parte vazia sai junto com o
 * separador; espaços e quebras de linha de cada parte viram um espaço só.
 */
export function montarAssuntoQ2P(etiqueta: EtiquetaEmail, ...partes: TextoEmail[]): string {
  const limpas = partes.map((p) => textoDe(p).replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [`[${etiqueta}]`, ...limpas].join(' - ');
}

/**
 * Nome (fornecedor, cliente) para o assunto: 1 linha, sem " - ", até 25 caracteres cortados em fim de palavra
 * (por caractere, não por unidade UTF-16), sem conectivo solto no fim (E, DE, DA, DO, DAS, DOS) nem pontuação nas
 * pontas. Sem nome, devolve ''. Porta da `clienteAssunto` da referência.
 */
export function nomeAssunto(nome: TextoEmail): string {
  const limpa = (t: string) => t.replace(/^[\s,;:./&-]+|[\s,;:./&-]+$/g, '');
  let s = limpa(textoDe(nome).replace(/\s+[-–—]\s+/g, ' ').replace(/\s+/g, ' '));
  const c = Array.from(s);
  if (c.length > 25) {
    const corte = c.slice(0, 26).join('');
    const i = corte.lastIndexOf(' ');
    s = limpa(i > 0 ? corte.slice(0, i) : c.slice(0, 25).join(''));
  }
  return s.replace(/(\s+(E|DE|DA|DO|DAS|DOS|e|de|da|do|das|dos))+$/, '');
}

/** Número de documento (NF, pedido) sem zeros à esquerda: "0000090601" → "90601". '' para valor ausente. */
export function numeroSemZeros(v: TextoEmail): string {
  return textoDe(v).trim().replace(/^0+(?=\d)/, '');
}

/** "R$ 10.000,00". Aceita a string numérica do Postgres ("10000.00"). '' para valor ausente ou inválido. */
export function dinheiroBrl(v: TextoEmail): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return '';
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const FORMATO_BRASILIA = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const SO_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Dia, mês, ano, hora e minuto no horário de Brasília, independente do fuso do servidor; null para data inválida. */
function partesBrasilia(v: Date | string | number | null | undefined): Map<string, string> | null {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return new Map(FORMATO_BRASILIA.formatToParts(d).map((p): [string, string] => [p.type, p.value]));
}

/**
 * "25/10/2026" no horário de Brasília. Data sem hora ("2026-10-25", coluna DATE) sai como está: convertê-la
 * para Date a leria como meia-noite UTC, que em Brasília ainda é o dia anterior. '' para valor ausente ou inválido.
 * Coluna DATE (ou timestamp sem fuso) deve chegar como TEXTO (`::text` na consulta): o node-pg a entrega como Date
 * na meia-noite do fuso do servidor (UTC no contêiner), e aí ela sairia com um dia a menos.
 */
export function dataBrasilia(v: Date | string | number | null | undefined): string {
  const soData = typeof v === 'string' ? SO_DATA.exec(v.trim()) : null;
  if (soData) return `${soData[3]}/${soData[2]}/${soData[1]}`;
  const p = partesBrasilia(v);
  return p ? `${p.get('day')}/${p.get('month')}/${p.get('year')}` : '';
}

/** "25/10/2026 às 17:13" no horário de Brasília (data sem hora sai só com o dia). '' para valor ausente ou inválido. */
export function dataHoraBrasilia(v: Date | string | number | null | undefined): string {
  if (typeof v === 'string' && SO_DATA.test(v.trim())) return dataBrasilia(v);
  const p = partesBrasilia(v);
  return p ? `${p.get('day')}/${p.get('month')}/${p.get('year')} às ${p.get('hour')}:${p.get('minute')}` : '';
}
