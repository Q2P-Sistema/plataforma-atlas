import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017 (ACXEGDP-437), research D21 — e-mail ao FISCAL quando o recebimento fiscal que o Atlas concluiu no OMIE
// aparece desfeito no portal e a entrada fisica da NF ja foi lancada no Atlas (a nota nao volta a fila). Um e-mail por
// destinatario de STOCKBRIDGE_FISCAL_EMAILS; corpo autossuficiente (sem botao); datas em horario de Brasilia; NF sem
// zeros a esquerda; PC so pelo numero legivel; NENHUM numero de 10+ digitos (chave de acesso, nIdReceb, nCodPed —
// ACXEGDP-313). Padrao do notificacao-nf-dispensada.test.ts.

const { sendEmailMock, loggerMock, configMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue(undefined),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  configMock: {
    APP_URL: 'https://atlas.local',
    STOCKBRIDGE_OPS_EMAIL: 'ops@q2p.local',
    STOCKBRIDGE_COMPRAS_EMAILS: ['compras@q2p.local'] as string[],
    STOCKBRIDGE_FISCAL_EMAILS: ['nfe@acxe-polimeros.com.br', 'mauricio@acxe-polimeros.com.br', 'gustavo.dreer@acxe-polimeros.com.br'] as string[],
  },
}));

vi.mock('@atlas/core', async () => ({
  ...(await import('./helpers/email-q2p.js')),
  createLogger: () => loggerMock,
  getConfig: () => configMock,
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }), execute: vi.fn() }),
  sendEmail: sendEmailMock,
}));
vi.mock('@atlas/db', () => ({ users: {}, userModules: {} }));

import { enviarAvisoFiscalRevertido, type ArgsAvisoFiscalRevertido } from '../services/notificacao.service.js';

// NF 19252 (Zaraplast): concluida pelo Atlas as 17:02 (Brasilia = 20:02Z), desfeita no portal as 17:13.
const base: ArgsAvisoFiscalRevertido = {
  empresa: 'q2p',
  notaFiscal: '19252',
  fornecedorNome: 'ZARAPLAST S/A',
  concluidoEm: '2026-10-25T20:02:01.437Z',
  desfeitoEm: '2026-10-25T20:13:36.000Z',
  entrada: { pendentes: 1, aprovadas: 0, aprovadaEm: null },
  pcs: ['308'],
};

const emails = () => sendEmailMock.mock.calls.map((c) => c[0] as { to: string; subject: string; html: string; text: string });
const FISCAL = ['nfe@acxe-polimeros.com.br', 'mauricio@acxe-polimeros.com.br', 'gustavo.dreer@acxe-polimeros.com.br'];

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(undefined);
  for (const f of Object.values(loggerMock)) f.mockClear();
  configMock.STOCKBRIDGE_FISCAL_EMAILS = [...FISCAL];
});

describe('enviarAvisoFiscalRevertido — destinatarios e assunto', () => {
  it('1 e-mail por destinatario do fiscal (nunca compras nem ops), sem lista no To, mesmo assunto', async () => {
    expect(await enviarAvisoFiscalRevertido(base)).toBe('enviado');
    const enviados = emails();
    expect(enviados).toHaveLength(3);
    expect(new Set(enviados.map((e) => e.to))).toEqual(new Set(FISCAL));
    for (const e of enviados) {
      expect(e.to).not.toContain(',');
      expect(e.subject).toBe('[AÇÃO REQUERIDA] - Fiscal - Recebimento desfeito no OMIE - ZARAPLAST S/A - NF 19252');
    }
    expect(enviados.map((e) => e.to)).not.toContain('compras@q2p.local');
    expect(enviados.map((e) => e.to)).not.toContain('ops@q2p.local');
  });

  it('NF sem zeros a esquerda no assunto, no corpo e no card; so zeros e numero ausente (sem "NF 0")', async () => {
    await enviarAvisoFiscalRevertido({ ...base, notaFiscal: '000019252' });
    const { subject, html } = emails()[0]!;
    expect(subject).toBe('[AÇÃO REQUERIDA] - Fiscal - Recebimento desfeito no OMIE - ZARAPLAST S/A - NF 19252');
    expect(html).toContain('NF 19252 · ZARAPLAST S/A');
    expect(html).toContain('concluiu o recebimento fiscal da NF 19252');
    expect(html).not.toContain('000019252');
    sendEmailMock.mockClear();
    await enviarAvisoFiscalRevertido({ ...base, notaFiscal: '000' });
    expect(emails()[0]!.subject).toBe('[AÇÃO REQUERIDA] - Fiscal - Recebimento desfeito no OMIE - ZARAPLAST S/A');
    expect(emails()[0]!.html).toContain('O Atlas concluiu o recebimento fiscal da NF, mas');
  });

  it('fornecedor nulo ou vazio sai do assunto e vira "Fornecedor não identificado no OMIE" no corpo', async () => {
    await enviarAvisoFiscalRevertido({ ...base, fornecedorNome: null });
    await enviarAvisoFiscalRevertido({ ...base, fornecedorNome: '   ' });
    for (const e of emails()) {
      expect(e.subject).toBe('[AÇÃO REQUERIDA] - Fiscal - Recebimento desfeito no OMIE - NF 19252');
      expect(e.html).toContain('NF 19252 · Fornecedor não identificado no OMIE');
    }
  });

  it('empresa ACXE cita a ACXE no assunto, no corpo e no card; a Q2P nao fala de ACXE', async () => {
    await enviarAvisoFiscalRevertido({ ...base, empresa: 'acxe' });
    const a = emails()[0]!;
    expect(a.subject).toBe('[AÇÃO REQUERIDA] - Fiscal - Recebimento desfeito no OMIE - ZARAPLAST S/A - NF ACXE 19252');
    expect(a.html).toContain('desfeito no OMIE da ACXE</strong>');
    expect(a.html).toContain('NF ACXE 19252 · ZARAPLAST S/A');
    expect(a.html).toContain('no portal do OMIE da ACXE');
    sendEmailMock.mockClear();
    await enviarAvisoFiscalRevertido(base);
    const q = emails()[0]!;
    expect(q.subject).not.toContain('ACXE');
    expect(q.html).not.toContain('ACXE');
    expect(q.text).not.toContain('Empresa:');
  });
});

describe('enviarAvisoFiscalRevertido — corpo', () => {
  it('diz o que houve: o Atlas concluiu em X, aparece desfeito desde Y, a entrada ja foi lancada e os itens lancados nao voltam a fila', async () => {
    await enviarAvisoFiscalRevertido(base);
    const { html, text } = emails()[0]!;
    expect(html).toContain('Fiscal: recebimento desfeito no OMIE');
    expect(html).toContain('NF 19252 · ZARAPLAST S/A');
    expect(html).toContain('O Atlas concluiu o recebimento fiscal da NF 19252, mas ele aparece <strong>desfeito no OMIE</strong>.');
    // numa NF parcial o item rejeitado volta à fila: o texto fala dos itens lançados (2ª revisão da D21)
    expect(html).toContain('A entrada de estoque desta nota já foi lançada pelo Atlas: os itens lançados não voltam à fila de recebimento do StockBridge, e o recebimento fiscal precisa ser refeito no OMIE.');
    expect(html).not.toContain('a nota não volta à fila');
    // ACXEGDP-440: as datas e a situação da entrada vão na tabela de dados
    expect(text).toContain('Concluído pelo Atlas em: 25/10/2026 às 17:02');
    expect(text).toContain('Desfeito no OMIE desde: 25/10/2026 às 17:13');
    expect(text).toContain('Entrada de estoque no Atlas: Aguardando aprovação do gestor');
  });

  it('o que fazer: concluir de novo no portal conferindo "Não gerar movimento de estoque" (senao entra em dobro) e o vinculo com o PC', async () => {
    await enviarAvisoFiscalRevertido(base);
    const { html, text } = emails()[0]!;
    expect(html).toContain('>O que fazer</p>');
    expect(html).toContain('Quem age: <strong>Fiscal</strong>');
    expect(html).toContain('<strong>Não gerar movimento de estoque</strong>');
    // a ordem importa: concluir antes de conferir os itens lançaria o estoque em dobro (revisão da ACXEGDP-440)
    expect(text).toContain(
      '1. Abra o recebimento desta nota no portal do OMIE.\n' +
        '2. Em cada item, confira se Não gerar movimento de estoque está marcada: o estoque desta nota entra pela aprovação no Atlas, e sem essa opção ele entraria em dobro.\n' +
        '3. Em cada item, confira o vínculo com o pedido de compra PC 308.\n' +
        '4. Depois, conclua o recebimento.',
    );
    expect(text).toContain('Pedido de compra: PC 308');
  });

  it('sem botao de acao: o fiscal pode nao ter acesso ao Atlas, o corpo e autossuficiente (nenhum link)', async () => {
    await enviarAvisoFiscalRevertido(base);
    const { html } = emails()[0]!;
    expect(html).not.toContain('<a href');
    expect(html).not.toContain('http');
  });

  it('sem PC vinculado: sem a linha do card nem o item do vinculo; a conferencia do estoque fecha a lista', async () => {
    await enviarAvisoFiscalRevertido({ ...base, pcs: [] });
    const { html } = emails()[0]!;
    expect(html).not.toContain('Pedido de compra');
    expect(html).not.toContain('vínculo');
    expect(emails()[0]!.text).toContain('entraria em dobro.\n3. Depois, conclua o recebimento.');
  });

  it('varios PCs: lista legivel; repetidos saem uma vez', async () => {
    await enviarAvisoFiscalRevertido({ ...base, pcs: ['308', '309', '308'] });
    const { text } = emails()[0]!;
    expect(text).toContain('3. Em cada item, confira o vínculo com os pedidos de compra PC 308 e PC 309.\n4. Depois, conclua o recebimento.');
    expect(text).toContain('Pedido de compra: PC 308, PC 309');
  });

  it('valores dinamicos no corpo sao escapados (fornecedor com & e <)', async () => {
    await enviarAvisoFiscalRevertido({ ...base, fornecedorNome: 'A&B <LTDA>' });
    const { html } = emails()[0]!;
    expect(html).toContain('NF 19252 · A&amp;B &lt;LTDA&gt;');
    expect(html).not.toContain('<LTDA>');
  });
});

describe('enviarAvisoFiscalRevertido — situacao da entrada fisica', () => {
  it.each([
    ['aguardando o gestor', { pendentes: 2, aprovadas: 0, aprovadaEm: null }, 'aguardando aprovação do gestor'],
    ['aprovada, com a data da aprovacao', { pendentes: 0, aprovadas: 1, aprovadaEm: '2026-10-26T14:00:00.000Z' }, 'aprovada em 26/10/2026'],
    ['aprovada, data como Date', { pendentes: 0, aprovadas: 2, aprovadaEm: new Date('2026-10-26T14:00:00.000Z') }, 'aprovada em 26/10/2026'],
    ['aprovada sem data conhecida', { pendentes: 0, aprovadas: 1, aprovadaEm: null }, 'aprovada'],
    [
      'parte aprovada, parte aguardando',
      { pendentes: 1, aprovadas: 1, aprovadaEm: '2026-10-26T14:00:00.000Z' },
      'aprovada em 26/10/2026 para parte dos itens; os demais aguardam aprovação do gestor',
    ],
  ])('%s', async (_nome, entrada, texto) => {
    await enviarAvisoFiscalRevertido({ ...base, entrada });
    const { text } = emails()[0]!;
    expect(text).toContain(`Entrada de estoque no Atlas: ${texto.charAt(0).toUpperCase()}${texto.slice(1)}`);
  });

  it('sem nenhum item contado: nao inventa situacao', async () => {
    await enviarAvisoFiscalRevertido({ ...base, entrada: { pendentes: 0, aprovadas: 0, aprovadaEm: null } });
    const { html, text } = emails()[0]!;
    expect(html).toContain('A entrada de estoque desta nota já foi lançada pelo Atlas: os itens lançados');
    expect(text).toContain('Entrada de estoque no Atlas: Lançada');
  });
});

describe('enviarAvisoFiscalRevertido — horario de Brasilia', () => {
  it('converte de UTC (UTC-3): 20:02Z = 17:02; antes das 3h UTC ainda e o dia anterior; meia-noite e 00:00 (nunca 24)', async () => {
    await enviarAvisoFiscalRevertido({ ...base, concluidoEm: '2026-10-26T02:30:00.000Z', desfeitoEm: '2026-10-26T03:00:00.000Z' });
    const { html, text } = emails()[0]!;
    expect(text).toContain('Concluído pelo Atlas em: 25/10/2026 às 23:30');
    expect(text).toContain('Desfeito no OMIE desde: 26/10/2026 às 00:00');
    expect(html).not.toMatch(/às 24:/);
  });

  it('a data da aprovacao tambem e de Brasilia (02:00Z de 27/10 ainda e 26/10)', async () => {
    await enviarAvisoFiscalRevertido({ ...base, entrada: { pendentes: 0, aprovadas: 1, aprovadaEm: '2026-10-27T02:00:00.000Z' } });
    expect(emails()[0]!.text).toContain('Entrada de estoque no Atlas: Aprovada em 26/10/2026');
  });

  it('hora ausente ou invalida: a frase sai sem a data, sem "Invalid Date"', async () => {
    await enviarAvisoFiscalRevertido({ ...base, concluidoEm: null, desfeitoEm: 'lixo' });
    const { html, text } = emails()[0]!;
    expect(html).toContain('O Atlas concluiu o recebimento fiscal da NF 19252, mas ele aparece <strong>desfeito no OMIE</strong>.');
    expect(html).not.toContain('Invalid');
    expect(text).not.toContain('Concluído pelo Atlas em');
    expect(text).not.toContain('Desfeito no OMIE desde');
  });
});

describe('enviarAvisoFiscalRevertido — sem codigo OMIE (ACXEGDP-313)', () => {
  it('nenhuma sequencia de 10+ digitos no assunto, no HTML nem no texto, mesmo com PC de 10+ digitos', async () => {
    await enviarAvisoFiscalRevertido({ ...base, notaFiscal: '000019252', pcs: ['308', '8518467850', '  ', '4294967296', '12345678901234'] });
    for (const e of emails()) {
      expect(e.subject).not.toMatch(/\d{10}/);
      expect(e.html).not.toMatch(/\d{10}/);
      expect(e.text).not.toMatch(/\d{10}/);
    }
    // so o PC legivel sobrou
    expect(emails()[0]!.text).toContain('Pedido de compra: PC 308');
    expect(emails()[0]!.text).toContain('o pedido de compra PC 308');
  });

  it('nem com a chave de acesso, o nIdReceb e o nCodPed enfiados nos argumentos o e-mail os mostra: so le os campos que usa', async () => {
    const comCodigos = {
      ...base,
      nfChaveAcesso: '31261061827663002031550010000192521253216947',
      nIdReceb: 8518467850,
      nCodPed: 8518524342,
    } as unknown as ArgsAvisoFiscalRevertido;
    expect(await enviarAvisoFiscalRevertido(comCodigos)).toBe('enviado');
    for (const e of emails()) {
      for (const parte of [e.subject, e.html, e.text]) {
        expect(parte).not.toContain('31261061827663002031550010000192521253216947');
        expect(parte).not.toContain('8518467850');
        expect(parte).not.toContain('8518524342');
        expect(parte).not.toMatch(/\d{10}/);
      }
    }
  });

  it('fiscal concluido no portal e so visto pelo Atlas (ja_concluido): o e-mail nao diz que o Atlas concluiu', async () => {
    await enviarAvisoFiscalRevertido({ ...base, concluidoForaDoAtlas: true });
    const { html, text } = emails()[0]!;
    expect(html).not.toContain('O Atlas concluiu');
    expect(html).toContain('O recebimento fiscal da NF 19252 estava concluído no OMIE quando o Atlas o conferiu, mas agora ele aparece <strong>desfeito</strong>.');
    expect(text).toContain('Visto concluído pelo Atlas em: 25/10/2026 às 17:02');
    expect(text).not.toContain('Concluído pelo Atlas em:');
    // o padrao (concluido pelo Atlas) segue igual
    sendEmailMock.mockClear();
    await enviarAvisoFiscalRevertido(base);
    expect(emails()[0]!.html).toContain('O Atlas concluiu o recebimento fiscal');
  });

  it('so PCs com cara de codigo do OMIE: some a linha do card e o item do vinculo', async () => {
    await enviarAvisoFiscalRevertido({ ...base, pcs: ['8518467850'] });
    const { html } = emails()[0]!;
    expect(html).not.toContain('Pedido de compra');
    expect(html).not.toContain('vínculo');
  });
});

describe('enviarAvisoFiscalRevertido — entrega', () => {
  it('lista de destinatarios vazia: nenhum envio, warn e "falha" (o job nao marca o aviso)', async () => {
    configMock.STOCKBRIDGE_FISCAL_EMAILS = [];
    expect(await enviarAvisoFiscalRevertido(base)).toBe('falha');
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalled();
    expect(String(loggerMock.warn.mock.calls[0]![1])).toContain('STOCKBRIDGE_FISCAL_EMAILS vazio');
  });

  it('falha em um destinatario: os demais seguem, devolve "enviado" e o erro e logado (endereco recusado nao reenvia aos outros)', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));
    expect(await enviarAvisoFiscalRevertido(base)).toBe('enviado');
    expect(sendEmailMock).toHaveBeenCalledTimes(3);
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith(expect.objectContaining({ enviados: 2, falhas: 1 }), expect.stringContaining('enviado ao fiscal'));
  });

  it('falha em todos os destinatarios: "falha" (tenta de novo na proxima rodada), nao lanca', async () => {
    sendEmailMock.mockRejectedValue(new Error('SendGrid fora'));
    await expect(enviarAvisoFiscalRevertido(base)).resolves.toBe('falha');
    expect(sendEmailMock).toHaveBeenCalledTimes(3);
    expect(loggerMock.error).toHaveBeenCalledTimes(3);
    expect(loggerMock.info).not.toHaveBeenCalled();
  });

  it('erro inesperado na montagem ou no envio: "falha" e log, nunca excecao', async () => {
    sendEmailMock.mockImplementation(() => {
      throw new Error('boom sincrono');
    });
    await expect(enviarAvisoFiscalRevertido(base)).resolves.toBe('falha');
    await expect(enviarAvisoFiscalRevertido({ ...base, entrada: undefined as never })).resolves.toBe('falha');
    await expect(enviarAvisoFiscalRevertido(undefined as never)).resolves.toBe('falha');
    expect(loggerMock.error).toHaveBeenCalled();
  });

  it('um unico destinatario configurado: 1 e-mail; string separada por virgula tambem e aceita', async () => {
    (configMock as { STOCKBRIDGE_FISCAL_EMAILS: unknown }).STOCKBRIDGE_FISCAL_EMAILS = ' a@x.com , b@x.com ,, ';
    expect(await enviarAvisoFiscalRevertido(base)).toBe('enviado');
    expect(emails().map((e) => e.to)).toEqual(['a@x.com', 'b@x.com']);
  });
});
