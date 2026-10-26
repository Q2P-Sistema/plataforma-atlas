import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017 (ACXEGDP-437), research D20 — aviso a COMPRAS quando o gestor rejeita a entrada de um item cujo
// pedido de compra ja foi baixado pelo peso conferido acima da nota (a rejeicao nao desfaz a baixa no OMIE).
// Mesma deduplicacao dos outros avisos a compras (stockbridge.nf_aviso_compras, NF + motivo + destinatario, 24 h),
// mais o item: as sequencias do e-mail precisam constar num aviso anterior. Motivo 'excedente_rejeitado' (0059). Sem codigo do OMIE no e-mail (ACXEGDP-313).

const { sendEmailMock, loggerMock, configMock, clientQuerySpy, releaseSpy, connectSpy } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue(undefined),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  configMock: {
    APP_URL: 'https://atlas.local',
    STOCKBRIDGE_OPS_EMAIL: 'ops@q2p.local',
    STOCKBRIDGE_COMPRAS_EMAILS: ['compras@q2p.local'] as string[],
  },
  clientQuerySpy: vi.fn(),
  releaseSpy: vi.fn(),
  connectSpy: vi.fn(),
}));

vi.mock('@atlas/core', async () => ({
  ...(await import('./helpers/email-q2p.js')),
  createLogger: () => loggerMock,
  getConfig: () => configMock,
  getDb: () => ({ execute: vi.fn() }),
  getPool: () => ({ connect: () => connectSpy() }),
  sendEmail: sendEmailMock,
}));
vi.mock('@atlas/db', () => ({ users: {}, userModules: {} }));

import { enviarAvisoComprasExcedenteRejeitado, type ArgsAvisoComprasExcedenteRejeitado } from '../services/notificacao.service.js';

const CHAVE = '35261068176072000128550010000679881752445982';
const base: ArgsAvisoComprasExcedenteRejeitado = {
  empresa: 'q2p',
  nfChaveAcesso: CHAVE,
  notaFiscal: '67988',
  fornecedorNome: 'ISOFORMA PLASTICOS INDUSTRIAIS LTDA',
  itemDescricao: 'PS AI A',
  produto: 'PS CRISTAL B',
  motivoRejeicao: 'Balança da portaria descalibrada; peso real igual ao da nota',
  linhas: [{ nSequencia: 1, pcNumero: '305', qtdNfKg: 13382, kgRecebidoPc: 13500 }],
  disparadoPor: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

let avisosPrevios: string[] = [];
const emails = () => sendEmailMock.mock.calls.map((c) => c[0] as { to: string; subject: string; html: string; text: string });
const insercoes = () => clientQuerySpy.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO stockbridge.nf_aviso_compras'));

beforeEach(() => {
  avisosPrevios = [];
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(undefined);
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
  releaseSpy.mockReset();
  clientQuerySpy.mockReset();
  clientQuerySpy.mockImplementation((sql: string) => {
    if (sql.includes('SELECT enviado_para FROM stockbridge.nf_aviso_compras')) {
      return Promise.resolve({ rows: avisosPrevios.map((enviado_para) => ({ enviado_para })) });
    }
    return Promise.resolve({ rows: [] });
  });
  connectSpy.mockReset();
  connectSpy.mockImplementation(() => Promise.resolve({ query: (sql: string, params?: unknown[]) => clientQuerySpy(sql, params), release: releaseSpy }));
  configMock.STOCKBRIDGE_COMPRAS_EMAILS = ['compras@q2p.local'];
});

describe('enviarAvisoComprasExcedenteRejeitado', () => {
  it('assunto e corpo contam o que aconteceu: PC baixado acima da nota e entrada rejeitada, com o motivo', async () => {
    expect(await enviarAvisoComprasExcedenteRejeitado(base)).toBe('enviado');
    const e = emails()[0]!;
    expect(e.to).toBe('compras@q2p.local');
    // ACXEGDP-440: fornecedor no assunto em até 25 caracteres, cortado em fim de palavra.
    expect(e.subject).toBe('[AÇÃO REQUERIDA] - Compras - Pedido baixado acima da nota - ISOFORMA PLASTICOS - NF 67988');
    expect(e.html).toContain('Compras: pedido baixado acima da nota');
    expect(e.html).toContain('NF 67988 · ISOFORMA PLASTICOS INDUSTRIAIS LTDA');
    expect(e.html).toContain('quantidade acima da nota');
    expect(e.html).toContain('rejeitou');
    expect(e.text).toContain('Item da NF: PS AI A');
    expect(e.text).toContain('Produto: PS CRISTAL B');
    expect(e.text).toContain('PC 305 | 13.382 kg | 13.500 kg | 118 kg');
    expect(e.html).toContain('Balança da portaria descalibrada');
    // tabela: na nota, baixado no pedido e a diferenca
    expect(e.html).toContain('13.382');
    expect(e.html).toContain('13.500');
    expect(e.html).toContain('118');
    // o que fazer: a rejeicao nao desfaz a baixa; conferir com o fiscal
    expect(e.html).toContain('não desfaz a baixa do pedido no OMIE');
    expect(e.html).toContain('fiscal');
    expect(e.html).toContain('href="https://atlas.local/stockbridge/fila"');
  });

  it('nenhum codigo do OMIE: numero de PC com cara de codigo interno (10+ digitos) vira "—"', async () => {
    await enviarAvisoComprasExcedenteRejeitado({ ...base, linhas: [{ nSequencia: 1, pcNumero: '8517543975', qtdNfKg: 13382, kgRecebidoPc: 13500 }] });
    const e = emails()[0]!;
    expect(e.html).not.toMatch(/\d{10}/);
    expect(e.subject).not.toMatch(/\d{10}/);
    expect(e.text).toContain('— | 13.382 kg | 13.500 kg | 118 kg');
  });

  it('registra no ledger de avisos com o motivo excedente_rejeitado, a trava por NF + motivo e as linhas', async () => {
    await enviarAvisoComprasExcedenteRejeitado(base);
    const trava = clientQuerySpy.mock.calls.find((c) => String(c[0]).includes('pg_advisory_xact_lock'))!;
    expect(trava[1]).toEqual([`sb:aviso-compras:${CHAVE}:excedente_rejeitado`]);
    const ins = insercoes();
    expect(ins).toHaveLength(1);
    const p = ins[0]![1] as unknown[];
    expect(p[4]).toBe('excedente_rejeitado');
    expect(JSON.parse(String(p[5]))).toEqual([
      { nSequencia: 1, descricao: 'PS AI A', qtdKg: 13500, precoUnit: null, pcNumero: '305', qtdNfKg: 13382 },
    ]);
    expect(p[6]).toBe('compras@q2p.local');
    expect(p[7]).toBe(base.disparadoPor);
  });

  it('dedupe de 24 h POR ITEM: so conta aviso anterior que ja tenha as sequencias deste (jsonb @>)', async () => {
    avisosPrevios = ['compras@q2p.local'];
    expect(await enviarAvisoComprasExcedenteRejeitado(base)).toBe('deduplicado');
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(insercoes()).toHaveLength(0);
    const leitura = clientQuerySpy.mock.calls.find((c) => String(c[0]).includes('SELECT enviado_para'))!;
    expect(String(leitura[0])).toContain('AND itens @> $4::jsonb');
    expect(leitura[1]).toEqual([CHAVE, 'excedente_rejeitado', 24, JSON.stringify([{ nSequencia: 1 }])]);
  });

  it('a janela da deduplicacao fica em agora no aviso da hora da rejeicao; na varredura ancora na hora da rejeicao (2a revisao, achado 4)', async () => {
    await enviarAvisoComprasExcedenteRejeitado(base);
    let leitura = clientQuerySpy.mock.calls.find((c) => String(c[0]).includes('SELECT enviado_para'))!;
    expect(String(leitura[0])).toContain('enviado_em > now() - make_interval(hours => $3) AND itens @> $4::jsonb');

    clientQuerySpy.mockClear();
    await enviarAvisoComprasExcedenteRejeitado({ ...base, coberturaDesde: new Date('2026-10-21T12:00:00Z') });
    leitura = clientQuerySpy.mock.calls.find((c) => String(c[0]).includes('SELECT enviado_para'))!;
    expect(String(leitura[0])).toContain('enviado_em > $5::timestamptz - make_interval(hours => $3) AND itens @> $4::jsonb');
    expect(leitura[1]).toEqual([CHAVE, 'excedente_rejeitado', 24, JSON.stringify([{ nSequencia: 1 }]), '2026-10-21T12:00:00.000Z']);

    // data invalida nao derruba o aviso: volta para agora
    clientQuerySpy.mockClear();
    await enviarAvisoComprasExcedenteRejeitado({ ...base, coberturaDesde: 'nao e data' });
    leitura = clientQuerySpy.mock.calls.find((c) => String(c[0]).includes('SELECT enviado_para'))!;
    expect(String(leitura[0])).toContain('enviado_em > now() - make_interval(hours => $3)');
    expect(leitura[1]).toHaveLength(4);
  });

  it('dois itens rejeitados: a cobertura leva as sequencias do e-mail (o aviso do item 1 nao segura o do item 2)', async () => {
    await enviarAvisoComprasExcedenteRejeitado({ ...base, linhas: [{ nSequencia: 2, pcNumero: '306', qtdNfKg: 5000, kgRecebidoPc: 5100 }] });
    const leitura = clientQuerySpy.mock.calls.find((c) => String(c[0]).includes('SELECT enviado_para'))!;
    expect((leitura[1] as unknown[])[3]).toBe(JSON.stringify([{ nSequencia: 2 }]));
  });

  it('sem STOCKBRIDGE_COMPRAS_EMAILS vai para o ops, com aviso no log', async () => {
    configMock.STOCKBRIDGE_COMPRAS_EMAILS = [];
    expect(await enviarAvisoComprasExcedenteRejeitado(base)).toBe('enviado');
    expect(emails().map((e) => e.to)).toEqual(['ops@q2p.local']);
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('vai para STOCKBRIDGE_OPS_EMAIL'));
  });

  it('falha no envio ou no banco: devolve falha e nunca lanca', async () => {
    sendEmailMock.mockRejectedValue(new Error('SendGrid fora'));
    expect(await enviarAvisoComprasExcedenteRejeitado(base)).toBe('falha');
    expect(insercoes()).toHaveLength(0);
    connectSpy.mockRejectedValue(new Error('pool esgotado'));
    await expect(enviarAvisoComprasExcedenteRejeitado(base)).resolves.toBe('falha');
  });
});
