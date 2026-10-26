// ===== Padrão de e-mail Q2P (ACXEGDP-436, proposta de corpo) =====
// Copiar IGUAL em todos os Monta_*: se mudar aqui, muda nos cerca de 30 nós. Sem require, sem import (Code node do n8n).
// Entrada (o): {
//   etiqueta: 'AÇÃO REQUERIDA' | 'INFORMATIVO'        (igual ao começo do assunto)
//   assunto, titulo, subtitulo                         (subtitulo = "Pedido 90601 · Cliente · R$ 10.000,00")
//   resumo: string | [string]                          (1 a 2 frases: o que aconteceu)
//   acao: { quem, passos: [string], nota }             (só AÇÃO REQUERIDA; passos em ordem, no máximo 4)
//   semAcao: string                                    (só INFORMATIVO; padrão "Nenhuma ação necessária.")
//   copia: string                                      (aviso a quem está em cópia: "Financeiro: nenhuma ação ...")
//   dados: [[rótulo, valor]]                           (linhas vazias saem sozinhas)
//   secoes: [{ titulo, itens | texto | tabela:{cab,linhas,alinhar}, lista:'num'|'check'|'', destaque:'erro'|'alerta'|'' }]
//             (alinhar: um por coluna, 'e' esquerda, 'd' direita, 'c' centro; padrão: 1ª coluna à esquerda e as outras à direita)
//   botao: { texto, url, nota }
//   tecnico: [[rótulo, valor]]                         (só nos e-mails do Gestor do Sistema Integrador)
//   ref: string                                        (referência curta para o suporte, em letra pequena)
//   duvidas: false                                     (tira a linha "Dúvidas: ..." quando o leitor é o próprio Gestor)
// }
// Texto: **negrito** vira <strong>; todo o resto é escapado. Nunca passe HTML.
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const rico = (v) => esc(v).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
const dinheiro = (n) => 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numPedido = (n) => String(n ?? '').trim().replace(/^0+(?=\d)/, '') || '?';
// Nome do cliente para o assunto: 1 linha, sem " - ", até 25 caracteres cortados em fim de palavra (por caractere, não por unidade UTF-16),
// sem conectivo solto no fim (E, DE, DA, DO, DAS, DOS) nem pontuação nas pontas. Sem nome, devolve ''.
const clienteAssunto = (nome) => {
  const limpa = (t) => t.replace(/^[\s,;:.\/&-]+|[\s,;:.\/&-]+$/g, '');
  let s = limpa(String(nome ?? '').replace(/\s+[-–—]\s+/g, ' ').replace(/\s+/g, ' '));
  const c = Array.from(s);
  if (c.length > 25) {
    const corte = c.slice(0, 26).join('');
    const i = corte.lastIndexOf(' ');
    s = limpa(i > 0 ? corte.slice(0, i) : c.slice(0, 25).join(''));
  }
  return s.replace(/(\s+(E|DE|DA|DO|DAS|DOS|e|de|da|do|das|dos))+$/, '');
};
function emailQ2P(o) {
  const acao = o.etiqueta === 'AÇÃO REQUERIDA';
  const faixa = acao ? '#9a3412' : '#1f2937';
  const chip = acao ? ['#fed7aa', '#7c2d12'] : ['#bfdbfe', '#1e3a8a'];
  const bloco = (pad, inner) => `<tr><td style="padding:${pad};">${inner}</td></tr>`;
  const caixa = (borda, fundo, inner) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid ${borda}; background-color:${fundo}; border-radius:8px;"><tr><td style="padding:16px 18px;">${inner}</td></tr></table>`;
  const lis = (itens, tag, cor) => `<${tag} style="margin:8px 0 0 0; padding:0 0 0 22px; font-size:14px; line-height:22px; color:${cor};">` + (itens || []).map((i) => `<li style="margin:0 0 6px 0;">${rico(i)}</li>`).join('') + `</${tag}>`;
  const par = (t) => `<p style="margin:0 0 10px 0; font-size:15px; line-height:24px; color:#1f2937;">${rico(t)}</p>`;
  const tabela2 = (linhas, estilo) => {
    const ok = (linhas || []).filter((l) => l && l[1] !== undefined && l[1] !== null && String(l[1]).trim() !== '');
    if (!ok.length) return '';
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e5e7eb; border-radius:8px; border-collapse:separate;${estilo || ''}">` +
      ok.map((l, i) => `<tr><td width="38%" valign="top" style="padding:9px 14px; background-color:#f9fafb; font-size:13px; line-height:20px; color:#6b7280;${i ? ' border-top:1px solid #eef0f3;' : ''}">${esc(l[0])}</td><td valign="top" style="padding:9px 14px; font-size:14px; line-height:20px; color:#111827;${i ? ' border-top:1px solid #eef0f3;' : ''}">${rico(l[1])}</td></tr>`).join('') + '</table>';
  };
  const resumo = [].concat(o.resumo || []);
  const pre = esc((o.preheader || resumo[0] || '').replace(/\*\*/g, ''));
  let c = '';
  c += bloco('24px 32px 8px 32px', resumo.map(par).join(''));
  if (acao && o.acao) {
    const a = o.acao;
    c += bloco('4px 32px 20px 32px', caixa('#fdba74', '#fff7ed',
      `<p style="margin:0; font-size:16px; line-height:22px; font-weight:bold; color:#9a3412;">O que fazer</p>` +
      (a.quem ? `<p style="margin:4px 0 0 0; font-size:13px; line-height:20px; color:#9a3412;">Quem age: <strong>${esc(a.quem)}</strong></p>` : '') +
      lis(a.passos, 'ol', '#7c2d12') +
      (a.nota ? `<p style="margin:10px 0 0 0; font-size:13px; line-height:20px; color:#7c2d12;">${rico(a.nota)}</p>` : '')));
  } else if (!acao) {
    c += bloco('4px 32px 20px 32px', caixa('#e5e7eb', '#f3f4f6', `<p style="margin:0; font-size:14px; line-height:22px; color:#374151;">${rico(o.semAcao || 'Nenhuma ação necessária.')}</p>`));
  }
  if (o.copia) c += bloco('0 32px 20px 32px', `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-left:4px solid #9ca3af; padding:4px 0 4px 14px; font-size:13px; line-height:20px; color:#4b5563;">${rico(o.copia)}</td></tr></table>`);
  const dados = tabela2(o.dados);
  if (dados) c += bloco('0 32px 20px 32px', dados);
  (o.secoes || []).forEach((s) => {
    const cor = s.destaque === 'erro' ? ['#fecaca', '#fef2f2', '#991b1b', '#7f1d1d'] : s.destaque === 'alerta' ? ['#fdba74', '#fff7ed', '#9a3412', '#7c2d12'] : ['#e5e7eb', '#ffffff', '#111827', '#374151'];
    let m = `<p style="margin:0; font-size:15px; line-height:22px; font-weight:bold; color:${cor[2]};">${esc(s.titulo)}</p>`;
    if (s.texto) m += `<p style="margin:8px 0 0 0; font-size:14px; line-height:22px; color:${cor[3]};">${rico(s.texto)}</p>`;
    if (s.itens && s.lista === 'check') m += `<ul style="margin:8px 0 0 0; padding:0; list-style:none; font-size:14px; line-height:22px; color:${cor[3]};">` + s.itens.map((i) => `<li style="margin:0 0 6px 0;">☐ ${rico(i)}</li>`).join('') + '</ul>';
    else if (s.itens) m += lis(s.itens, s.lista === 'num' ? 'ol' : 'ul', cor[3]);
    if (s.tabela) {
      const al = (i) => ({ e: 'left', d: 'right', c: 'center' }[(s.tabela.alinhar || [])[i]] || (i ? 'right' : 'left'));
      m += `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:10px; border:1px solid #e5e7eb; border-collapse:separate; border-radius:6px;"><tr>` +
        s.tabela.cab.map((h, i) => `<td valign="top" style="padding:8px 10px; background-color:#f3f4f6; font-size:12px; font-weight:bold; color:#4b5563; text-align:${al(i)};">${esc(h)}</td>`).join('') + '</tr>' +
        s.tabela.linhas.map((l) => '<tr>' + l.map((v, i) => `<td valign="top" style="padding:8px 10px; border-top:1px solid #eef0f3; font-size:13px; line-height:19px; color:#111827; text-align:${al(i)};">${rico(v)}</td>`).join('') + '</tr>').join('') + '</table>';
    }
    c += bloco('0 32px 20px 32px', caixa(cor[0], cor[1], m));
  });
  if (o.botao) {
    c += bloco('4px 32px 24px 32px', `<div style="text-align:center;"><a href="${esc(o.botao.url)}" style="display:inline-block; background-color:#1d4ed8; color:#ffffff; text-decoration:none; padding:14px 32px; border-radius:8px; font-size:15px; font-weight:bold;">${esc(o.botao.texto)}</a>` +
      (o.botao.nota ? `<p style="margin:12px 0 0 0; font-size:12px; line-height:18px; color:#6b7280;">${rico(o.botao.nota)}</p>` : '') + '</div>');
  }
  const tec = tabela2(o.tecnico, ' border-style:dashed;');
  if (tec) c += bloco('0 32px 20px 32px', `<p style="margin:0 0 6px 0; font-size:11px; letter-spacing:0.5px; text-transform:uppercase; color:#6b7280;">Detalhes técnicos (suporte)</p>${tec}`);
  const rodape = `<p style="margin:0; font-size:12px; line-height:18px; color:#6b7280;">Mensagem automática do Sistema Integrador Q2P.${o.duvidas === false ? '' : ' Dúvidas: fale com o Gestor do Sistema Integrador.'}</p>` +
    (o.ref ? `<p style="margin:6px 0 0 0; font-size:11px; line-height:16px; color:#9ca3af;">${esc(o.ref)}</p>` : '');
  return `<!DOCTYPE html>
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
              ${o.subtitulo ? `<p style="margin:6px 0 0 0; font-size:14px; line-height:22px; color:#e5e7eb;">${esc(o.subtitulo)}</p>` : ''}
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
}
