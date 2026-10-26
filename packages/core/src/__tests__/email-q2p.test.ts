import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  montarEmailQ2P,
  montarAssuntoQ2P,
  nomeAssunto,
  numeroSemZeros,
  dinheiroBrl,
  dataBrasilia,
  dataHoraBrasilia,
  type EmailQ2POptions,
} from '../email-q2p.js';

// ACXEGDP-440: o gerador do Atlas tem de produzir o mesmo HTML da `emailQ2P` dos fluxos do n8n (ACXEGDP-436).
// `fixtures/emailQ2P.lib.js` é a cópia exata de backup-workflow-n8n/specs/436-emails/corpo/emailQ2P.lib.js
// (sha256 f9f777a4d7aec9040cfdd2ba0626e77ac6ce25970432b495953f0e6899a98da0, commit e1604a8). Se a referência
// mudar, copie de novo e ajuste o gerador até a paridade voltar.
const lib = readFileSync(new URL('./fixtures/emailQ2P.lib.js', import.meta.url), 'utf8');
const referencia = new Function(`${lib}\nreturn { emailQ2P, clienteAssunto };`)() as {
  emailQ2P: (o: unknown) => string;
  clienteAssunto: (nome: unknown) => string;
};

// Dados fictícios (pedido 90601, CLIENTE EXEMPLO LTDA): os 6 protótipos aprovados na 436 (corpo/proto/gera_proto.js)
// e um e-mail do Atlas que usa todos os blocos.
const SUB = 'Pedido 90601 · CLIENTE EXEMPLO LTDA · R$ 10.000,00';
const PROTOTIPOS: Record<string, EmailQ2POptions> = {
  A08: {
    assunto: '[AÇÃO REQUERIDA] - Venda à vista - Decisão do Financeiro - CLIENTE EXEMPLO LTDA - Pedido 90601',
    etiqueta: 'AÇÃO REQUERIDA', titulo: 'Venda à vista: decisão do Financeiro', subtitulo: SUB,
    resumo: 'O pedido 90601 é **à vista** e aguarda a sua decisão: liberar para **Faturar** ou devolver para a etapa **Pedido de Venda**.',
    acao: { quem: 'Financeiro', passos: [
      'Confirme que o comprovante de depósito do cliente chegou ao Financeiro (o vendedor o encaminha).',
      'Confira se a entrada aparece no extrato bancário e em qual banco o dinheiro caiu.',
      'Clique em **Abrir formulário de decisão**, escolha Aprovar ou Rejeitar e informe o banco.'] },
    dados: [['Vendedor', 'VENDEDOR EXEMPLO (vendedor@exemplo.com.br)']],
    botao: { texto: 'Abrir formulário de decisão', url: 'https://exemplo.com.br/form-waiting/000000?signature=exemplo', nota: 'O link só pode ser usado uma vez.' },
    ref: 'Referência: pendência 990601',
  },
  A01: {
    assunto: '[AÇÃO REQUERIDA] - Crédito recusado - Limite insuficiente e título vencido - Pedido 90601',
    etiqueta: 'AÇÃO REQUERIDA', titulo: 'Crédito recusado: limite insuficiente e título vencido', subtitulo: SUB,
    resumo: ['O pedido 90601 foi recusado na análise de crédito e **não pode ser faturado**.',
      'Se ele aparecer em Separar Estoque, não é engano: a separação pode começar, mas o faturamento só é liberado depois que o crédito for resolvido e o pedido passar de novo pela Validação Sistema.'],
    acao: { quem: 'Gestor de vendas', passos: [
      'Para liberar o crédito mesmo assim, escreva **#LIBERACREDITO** no fim das observações do pedido, depois da última anotação do sistema.',
      'Se não for liberar, combine com o vendedor e o Financeiro a solução.'],
      nota: 'Não leve o pedido direto para Faturar: ele volta sozinho para a Validação Sistema.' },
    dados: [['Limite total aprovado', 'R$ 10.000,00'], ['Títulos vencidos', '1 (R$ 2.000,00), o mais antigo desde 01/10/2026']],
    secoes: [{ titulo: 'Motivos da recusa', destaque: 'erro', itens: [
      'Limite insuficiente: disponível R$ 4.000,00 na Seguradora.',
      'Cliente com 1 título vencido no Contas a Receber (R$ 2.000,00; o mais antigo venceu em 01/10/2026).'] }],
  },
  A20: {
    assunto: '[AÇÃO REQUERIDA] - Faturar - Faturado sem aprovação válida - Pedido 90601',
    etiqueta: 'AÇÃO REQUERIDA', titulo: 'Pedido faturado sem aprovação válida', subtitulo: SUB,
    resumo: 'A nota fiscal do pedido 90601 já foi emitida, mas o pedido não tinha a aprovação válida da Validação Sistema.',
    acao: { quem: 'Financeiro', passos: ['Confira a nota fiscal, o título a receber e o boleto deste pedido.'],
      nota: 'O pedido só deve ser alterado na etapa Pedido de Venda.' },
    dados: [['Levado para Faturar por', 'não identificado, em 23/10/2026 às 18:55'], ['Motivo', 'crédito reprovado sem liberação']],
    secoes: [{ titulo: 'Por que isso é um problema', texto: 'Todo pedido precisa da aprovação da Validação Sistema antes de Faturar.' }],
  },
  A23: {
    assunto: '[AÇÃO REQUERIDA] - Validação - Pedido parado - Pedido 90601',
    etiqueta: 'AÇÃO REQUERIDA', titulo: 'Pedido parado na Validação Sistema', subtitulo: SUB,
    resumo: 'O pedido 90601 está na Validação Sistema sem andamento: não foi aprovado nem devolvido para correção.',
    acao: { quem: 'Gestor do Sistema Integrador', passos: [
      'Ler a última anotação nas observações do pedido para ver até onde a validação chegou.',
      'Conferir a execução da validação deste pedido no n8n (referência abaixo) e corrigir a causa.'] },
    copia: '**Em cópia (Financeiro):** nenhuma ação. Não mexa no pedido: o Gestor do Sistema Integrador vai resolver.',
    dados: [['Parado desde', '20/10/2026 às 09:40'], ['Reenvios automáticos', '2 vezes (às 10:10 e às 10:55)']],
    secoes: [{ titulo: 'O que o sistema ainda faz', texto: 'Este aviso sai uma vez por pedido.' }],
    tecnico: [['Fluxo', 'Q2P Matriz - Varredura da Validação Sistema'], ['Execução', '8000000000']],
    duvidas: false,
  },
  A10: {
    assunto: '[INFORMATIVO] - Venda à vista - Aprovada - Pedido 90601',
    etiqueta: 'INFORMATIVO', titulo: 'Venda à vista aprovada', subtitulo: SUB,
    resumo: 'O Financeiro confirmou o depósito e **aprovou** o pedido 90601. Ele está liberado para **Faturar**.',
    semAcao: 'Nenhuma ação necessária. O sistema segue com o faturamento.',
    dados: [['Banco do depósito', 'Bradesco']],
  },
  A25: {
    assunto: '[INFORMATIVO] - Banco do dia - Sugerido para 26/10/2026 - Banco Exemplo A',
    etiqueta: 'INFORMATIVO', titulo: 'Banco do dia: sugestão para 26/10/2026', subtitulo: 'Sugerido: Banco Exemplo A',
    resumo: 'O sistema sugere o **Banco Exemplo A** para faturar, no próximo dia útil (26/10/2026).',
    semAcao: '**Se você concorda, não precisa fazer nada:** o sistema segue com este banco.',
    dados: [['Limite total', 'R$ 1.000.000,00'], ['Budget (limite − bruto + antecipado)', 'R$ 600.000,00']],
    secoes: [{ titulo: 'Demais bancos ativos', tabela: { cab: ['Banco', 'Limite', 'Budget'], linhas: [['Banco Exemplo B', 'R$ 500.000,00', 'R$ 200.000,00']] } }],
    botao: { texto: 'Alterar sugestão', url: 'https://exemplo.com.br/form-waiting/000001?signature=exemplo', nota: 'O link vale até 26/10/2026 às 09:00.' },
  },
  ATLAS_COMPLETO: {
    assunto: '[AÇÃO REQUERIDA] - Compras - NF sem pedido de compra - FORNECEDOR EXEMPLO LTDA - NF 6842',
    etiqueta: 'AÇÃO REQUERIDA', titulo: 'Compras: NF sem pedido de compra', subtitulo: 'NF 6842 · FORNECEDOR EXEMPLO LTDA · R$ 10.000,00',
    preheader: 'A NF 6842 está parada na fila do StockBridge.',
    resumo: ['O recebimento da NF 6842 está **bloqueado**.', 'Há item sem pedido de compra aprovado no OMIE.'],
    acao: { quem: 'Compras', passos: ['Lance o pedido de compra no OMIE.', 'Aprove o pedido.'], nota: 'A NF fica na fila até o pedido existir.' },
    copia: '**Em cópia (Comex):** nenhuma ação.',
    dados: [['Empresa', 'Q2P'], ['Vazio', ''], ['Nulo', null], ['Zero', 0]],
    secoes: [
      { titulo: 'Itens da nota', tabela: { cab: ['Item', 'Quantidade', 'Preço'], linhas: [['SUCATA DE PP', '1.250 kg', 'R$ 2,50/kg'], ['SUCATA DE PE', '500 kg', '—']], alinhar: ['e', 'd', 'c'] } },
      { titulo: 'Conferir', lista: 'check', itens: ['Unidade do pedido', 'Fornecedor do pedido'] },
      { titulo: 'Passos do fiscal', lista: 'num', itens: ['Um', 'Dois'], destaque: 'alerta' },
      { titulo: 'Motivos', itens: ['Sem pedido'], texto: 'Detalhe **importante**.', destaque: 'erro' },
    ],
    botao: { texto: 'Abrir a fila', url: 'https://atlas.exemplo.com.br/stockbridge/fila?a=1&b=2', nota: 'Só para quem usa o Atlas.' },
    tecnico: [['Chave de acesso', '35261000000000000000550010000068421000000000']],
    ref: 'Referência: aviso 1a2b3c4d',
  },
};

describe('montarEmailQ2P — paridade com a emailQ2P do n8n (ACXEGDP-436)', () => {
  for (const [id, o] of Object.entries(PROTOTIPOS)) {
    it(`${id}: mesmo HTML byte a byte`, () => {
      expect(montarEmailQ2P(o).html).toBe(referencia.emailQ2P(o));
    });
  }

  it('INFORMATIVO sem semAcao usa o texto padrão, como a referência', () => {
    const o: EmailQ2POptions = { etiqueta: 'INFORMATIVO', assunto: '[INFORMATIVO] - Recebimento - Concluído - NF 6842', titulo: 'Recebimento concluído', resumo: 'Entrou no estoque.' };
    const { html } = montarEmailQ2P(o);
    expect(html).toBe(referencia.emailQ2P(o));
    expect(html).toContain('Nenhuma ação necessária.');
  });

  it('nomeAssunto corta igual à clienteAssunto', () => {
    const nomes = [
      'CLIENTE EXEMPLO LTDA',
      'FORNECEDOR EXEMPLO LTDA',
      'ZARAPLAST INDÚSTRIA E COMÉRCIO DE EMBALAGENS LTDA',
      'ACME - FILIAL SÃO PAULO',
      '  , Empresa & Cia /  ',
      'Ação Química do Brasil e Distribuição',
      'A'.repeat(40),
      'Café ☕ Fornecedor de Grãos Especiais LTDA',
      'POLÍMEROS DO SUL E DO NORTE DE',
      '',
    ];
    for (const n of nomes) expect(nomeAssunto(n), n).toBe(referencia.clienteAssunto(n));
    expect(nomeAssunto(null)).toBe('');
  });
});

describe('montarEmailQ2P — estrutura', () => {
  const acao: EmailQ2POptions = {
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: '[AÇÃO REQUERIDA] - Fiscal - Recebimento desfeito no OMIE - NF 6842',
    titulo: 'Fiscal: recebimento desfeito no OMIE',
    resumo: ['O recebimento da NF 6842 aparece **desfeito** no OMIE.', 'Segunda frase.'],
    acao: { quem: 'Fiscal', passos: ['Abra a nota no OMIE.', 'Conclua o recebimento de novo.'], nota: 'Sem movimentar estoque.' },
  };

  it('AÇÃO REQUERIDA: faixa laranja, "O que fazer" e "Quem age"', () => {
    const { html } = montarEmailQ2P(acao);
    expect(html).toContain('background-color:#9a3412; padding:22px 32px 24px 32px;');
    expect(html).toContain('>O que fazer</p>');
    expect(html).toContain('Quem age: <strong>Fiscal</strong>');
    expect(html).not.toContain('Nenhuma ação necessária.');
  });

  it('INFORMATIVO: faixa azul-escura, sem "O que fazer", com a faixa cinza', () => {
    const { html } = montarEmailQ2P({ ...acao, etiqueta: 'INFORMATIVO', acao: undefined, semAcao: 'Nenhuma ação necessária. O estoque já entrou.' });
    expect(html).toContain('background-color:#1f2937; padding:22px 32px 24px 32px;');
    expect(html).not.toContain('O que fazer');
    expect(html).toContain('Nenhuma ação necessária. O estoque já entrou.');
  });

  it('<title> é o assunto e a prévia oculta é a 1ª frase do resumo, sem os marcadores de negrito', () => {
    const { html } = montarEmailQ2P(acao);
    expect(html).toContain(`<title>${acao.assunto}</title>`);
    expect(html).toMatch(/mso-hide:all;">O recebimento da NF 6842 aparece desfeito no OMIE\.<\/div>/);
    expect(html).toContain('width="700"');
  });

  it('rodapé único; duvidas:false tira a linha de dúvidas', () => {
    expect(montarEmailQ2P(acao).html).toContain('Mensagem automática do Sistema Integrador Q2P. Dúvidas: fale com o Gestor do Sistema Integrador.');
    const gestor = montarEmailQ2P({ ...acao, duvidas: false }).html;
    expect(gestor).toContain('Mensagem automática do Sistema Integrador Q2P.</p>');
    expect(gestor).not.toContain('Dúvidas:');
  });

  it('detalhes técnicos só aparecem quando informados', () => {
    expect(montarEmailQ2P(acao).html).not.toContain('Detalhes técnicos');
    expect(montarEmailQ2P({ ...acao, tecnico: [['Execução', '123']] }).html).toContain('Detalhes técnicos (suporte)');
  });

  it('linha de dados vazia some; célula de tabela vazia vira "—"', () => {
    const { html } = montarEmailQ2P({
      ...acao,
      dados: [['Rótulo vazio', ''], ['Rótulo nulo', null], ['Rótulo NaN', Number.NaN], ['Rótulo cheio', 'valor']],
      secoes: [{ titulo: 'Itens', tabela: { cab: ['A', 'B'], linhas: [['x', null], ['', 'y']] } }],
    });
    expect(html).not.toContain('Rótulo vazio');
    expect(html).not.toContain('Rótulo nulo');
    expect(html).not.toContain('Rótulo NaN');
    expect(html).toContain('Rótulo cheio');
    expect(html.match(/text-align:(left|right);">—<\/td>/g)).toHaveLength(2);
  });

  it('botão só com texto e endereço http(s); o endereço é escapado', () => {
    const ok = montarEmailQ2P({ ...acao, botao: { texto: 'Abrir', url: 'https://atlas.exemplo.com.br/x?a=1&b=2' } }).html;
    expect(ok).toContain('href="https://atlas.exemplo.com.br/x?a=1&amp;b=2"');
    for (const url of ['javascript:alert(1)', '', null, '/stockbridge/fila']) {
      expect(montarEmailQ2P({ ...acao, botao: { texto: 'Abrir', url } }).html, String(url)).not.toContain('<a href');
    }
    expect(montarEmailQ2P({ ...acao, botao: { texto: '', url: 'https://x.com.br' } }).html).not.toContain('<a href');
  });
});

describe('montarEmailQ2P — entradas difíceis', () => {
  const RUINS: unknown[] = [undefined, null, Number.NaN, Infinity, -Infinity, {}, [], () => 1, Symbol('x'), true, ''];
  const VAZAMENTO = /undefined|\bnull\b|NaN|\[object|Infinity|=>|Symbol\(|\btrue\b/;
  const base: EmailQ2POptions = {
    etiqueta: 'AÇÃO REQUERIDA',
    assunto: '[AÇÃO REQUERIDA] - Recebimento - Teste - NF 6842',
    titulo: 'Título',
    resumo: 'Resumo.',
    acao: { quem: 'Gestor', passos: ['Passo.'] },
  };
  const variantes = (v: unknown): Array<Record<string, unknown>> => [
    { etiqueta: v }, { assunto: v }, { titulo: v }, { subtitulo: v }, { preheader: v }, { resumo: v }, { resumo: [v, 'ok'] },
    { acao: v }, { acao: { quem: v, passos: v, nota: v } }, { acao: { quem: 'X', passos: [v, 'ok'] } },
    { semAcao: v, etiqueta: 'INFORMATIVO' }, { copia: v }, { dados: v }, { dados: [v, [v, v], ['Rótulo', v], [v, 'valor']] },
    { secoes: v }, { secoes: [v] },
    { secoes: [{ titulo: v, texto: v, itens: v, lista: v, destaque: v, tabela: v }] },
    { secoes: [{ titulo: 'T', itens: [v, 'ok'], lista: 'check', tabela: { cab: v, linhas: v, alinhar: v } }] },
    { secoes: [{ titulo: 'T', tabela: { cab: [v, 'B'], linhas: [v, [v, 'b'], [{}, []]], alinhar: [v, 'toString'] } }] },
    { botao: v }, { botao: { texto: v, url: v, nota: v } }, { botao: { texto: 'Abrir', url: 'https://x.com.br', nota: v } },
    { tecnico: v }, { tecnico: [[v, v], ['Execução', v]] }, { ref: v }, { duvidas: v },
  ];

  it('nunca lança e nunca deixa vazar valor vazio no HTML ou no texto', () => {
    for (const v of RUINS) {
      for (const extra of variantes(v)) {
        const o = { ...base, ...extra } as unknown as EmailQ2POptions;
        let saida: { html: string; text: string } | undefined;
        expect(() => { saida = montarEmailQ2P(o); }, `${String(typeof v)} em ${Object.keys(extra).join(',')}`).not.toThrow();
        expect(saida!.html, Object.keys(extra).join(',')).not.toMatch(VAZAMENTO);
        expect(saida!.text, Object.keys(extra).join(',')).not.toMatch(VAZAMENTO);
      }
    }
  });

  it('escapa HTML e aspas; só **negrito** vira <strong>', () => {
    const perigoso = `<script>alert("x")</script> & 'aspas'`;
    const { html, text } = montarEmailQ2P({ ...base, titulo: perigoso, resumo: `Antes **<i>forte</i>** depois`, dados: [['Fornecedor', perigoso]] });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;aspas&#39;');
    expect(html).toContain('Antes <strong>&lt;i&gt;forte&lt;/i&gt;</strong> depois');
    expect(text).toContain('Antes <i>forte</i> depois');
    expect(text).not.toContain('**');
  });

  it('texto de 400 caracteres e acentos passam inteiros', () => {
    const longo = 'Ação já é útil, ônibus e maçã. '.repeat(13).slice(0, 400);
    expect(Array.from(longo)).toHaveLength(400);
    const { html, text } = montarEmailQ2P({ ...base, resumo: longo, dados: [['Observação', longo]] });
    expect(html).toContain(longo);
    expect(text).toContain(longo);
  });
});

describe('montarEmailQ2P — versão em texto puro', () => {
  it('traz os blocos na ordem, com os passos numerados, o link e o rodapé', () => {
    const { text } = montarEmailQ2P(PROTOTIPOS.ATLAS_COMPLETO!);
    const ordem = [
      '[AÇÃO REQUERIDA] Compras: NF sem pedido de compra',
      'NF 6842 · FORNECEDOR EXEMPLO LTDA · R$ 10.000,00',
      'O recebimento da NF 6842 está bloqueado.',
      'O que fazer\nQuem age: Compras\n1. Lance o pedido de compra no OMIE.\n2. Aprove o pedido.\nA NF fica na fila até o pedido existir.',
      'Em cópia (Comex): nenhuma ação.',
      'Empresa: Q2P\nZero: 0',
      'Itens da nota\nItem | Quantidade | Preço\nSUCATA DE PP | 1.250 kg | R$ 2,50/kg',
      'Conferir\n☐ Unidade do pedido',
      'Passos do fiscal\n1. Um\n2. Dois',
      'Abrir a fila: https://atlas.exemplo.com.br/stockbridge/fila?a=1&b=2\nSó para quem usa o Atlas.',
      'Detalhes técnicos (suporte)\nChave de acesso: 3526',
      'Mensagem automática do Sistema Integrador Q2P. Dúvidas: fale com o Gestor do Sistema Integrador.\nReferência: aviso 1a2b3c4d',
    ];
    let desde = 0;
    for (const trecho of ordem) {
      const i = text.indexOf(trecho, desde);
      expect(i, trecho).toBeGreaterThanOrEqual(desde);
      desde = i + trecho.length;
    }
    expect(text).not.toMatch(/<|\*\*/);
  });
});

describe('assunto e formatos', () => {
  it('montarAssuntoQ2P junta as partes com " - " e tira as vazias', () => {
    expect(montarAssuntoQ2P('AÇÃO REQUERIDA', 'Fiscal', 'NF dispensada da fila', nomeAssunto('FORNECEDOR EXEMPLO LTDA'), 'NF 6842'))
      .toBe('[AÇÃO REQUERIDA] - Fiscal - NF dispensada da fila - FORNECEDOR EXEMPLO LTDA - NF 6842');
    expect(montarAssuntoQ2P('INFORMATIVO', 'Recebimento', ' Concluído\n', null, '', 'NF 6842'))
      .toBe('[INFORMATIVO] - Recebimento - Concluído - NF 6842');
  });

  it('numeroSemZeros', () => {
    expect(numeroSemZeros('0000090601')).toBe('90601');
    expect(numeroSemZeros(' 0042 ')).toBe('42');
    expect(numeroSemZeros('000')).toBe('0');
    expect(numeroSemZeros(90601)).toBe('90601');
    expect(numeroSemZeros(null)).toBe('');
  });

  it('dinheiroBrl', () => {
    expect(dinheiroBrl(10000)).toBe('R$ 10.000,00');
    expect(dinheiroBrl('1234.5')).toBe('R$ 1.234,50');
    expect(dinheiroBrl(0)).toBe('R$ 0,00');
    for (const v of [null, undefined, Number.NaN, '', 'abc']) expect(dinheiroBrl(v)).toBe('');
  });

  it('datas no horário de Brasília, inclusive de madrugada em UTC', () => {
    const madrugadaUtc = new Date('2026-10-26T02:30:00Z'); // 25/10 às 23:30 em Brasília
    expect(dataBrasilia(madrugadaUtc)).toBe('25/10/2026');
    expect(dataHoraBrasilia(madrugadaUtc)).toBe('25/10/2026 às 23:30');
    expect(dataHoraBrasilia('2026-10-25T20:13:00.000Z')).toBe('25/10/2026 às 17:13');
    // timestamptz::text do Postgres, com o fuso da sessão ("…-03"): fim do dia em Brasília continua no mesmo dia
    expect(dataBrasilia('2026-10-01 23:59:59.123-03')).toBe('01/10/2026');
    expect(dataHoraBrasilia('2026-10-01 14:23:45-03')).toBe('01/10/2026 às 14:23');
    // coluna DATE: sem conversão de fuso (meia-noite UTC seria o dia 24 em Brasília)
    expect(dataBrasilia('2026-10-25')).toBe('25/10/2026');
    expect(dataHoraBrasilia('2026-10-25')).toBe('25/10/2026');
    for (const v of [null, undefined, '', 'abc']) {
      expect(dataBrasilia(v)).toBe('');
      expect(dataHoraBrasilia(v)).toBe('');
    }
  });
});
