import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017 (ACXEGDP-437, research D6), T035/T036 — aviso a COMPRAS sobre NF
// nacional com item sem pedido de compra (PC). Deduplicado em
// stockbridge.nf_aviso_compras por NF, motivo e DESTINATARIO (24 h), numa
// transacao com trava consultiva por (NF, motivo) — revisao pos-017, infra-02 e
// infra-05; destino STOCKBRIDGE_COMPRAS_EMAILS, ou STOCKBRIDGE_OPS_EMAIL quando
// vazio; sem codigo OMIE. Quadro "PC em outro cadastro" (sugestao-01).

const { sendEmailMock, loggerMock, configMock, clientQuerySpy, releaseSpy, connectSpy } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue(undefined),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  configMock: {
    APP_URL: 'https://atlas.local',
    STOCKBRIDGE_OPS_EMAIL: 'ops@q2p.local',
    STOCKBRIDGE_COMPRAS_EMAILS: ['compras@q2p.local', 'comprador@q2p.local'] as string[],
  },
  clientQuerySpy: vi.fn(),
  releaseSpy: vi.fn(),
  connectSpy: vi.fn(),
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => loggerMock,
  getConfig: () => configMock,
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }), execute: vi.fn() }),
  getPool: () => ({ connect: () => connectSpy() }),
  sendEmail: sendEmailMock,
  buildEmailLayout: (o: { titulo?: string; variante?: string; corpoHtml?: string; ctaUrl?: string }) => ({
    html: `[${o?.variante ?? ''}:${o?.titulo ?? ''}]${o?.corpoHtml ?? ''}||URL:${o?.ctaUrl ?? ''}`,
    text: '',
  }),
  escapeHtml: (v: unknown) => String(v ?? ''),
  emailActionBox: (html: string, titulo?: string) => `[${titulo ?? 'Ação necessária'}]${html}`,
  emailDataList: (linhas: Array<{ label: string; valor: string | number | null | undefined }>) =>
    linhas.filter((l) => l.valor !== '' && l.valor != null).map((l) => `[${l.label}: ${l.valor}]`).join(''),
}));
vi.mock('@atlas/db', () => ({ users: {}, userModules: {} }));

import { enviarAvisoComprasNfSemPc, fmtCnpj, AVISO_COMPRAS_DEDUP_HORAS, AVISO_COMPRAS_MAX_SIMULTANEOS } from '../services/notificacao.service.js';

const CHAVE = '35261011111111000111550010000078131000078131';
const base = {
  empresa: 'q2p' as const,
  nfChaveAcesso: CHAVE,
  notaFiscal: '7813',
  fornecedorNome: 'REPLAS COMERCIAL LTDA',
  itens: [{ nSequencia: 1, descricao: 'SUCATA PLASTICO', qtdKg: 18000, precoUnit: 11.3 }],
  pcsAguardandoAprovacao: [] as string[],
  motivo: 'sem_pc' as const,
  disparadoPor: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

// enviado_para de cada linha de aviso (NF + motivo) gravada nas ultimas 24 h.
let avisosPrevios: string[] = [];
const emails = () => sendEmailMock.mock.calls.map((c) => c[0] as { to: string; subject: string; html: string });
const comandos = () => clientQuerySpy.mock.calls.map((c) => String(c[0]));
const posicao = (trecho: string) => clientQuerySpy.mock.calls.findIndex((c) => String(c[0]).includes(trecho));
const ordemChamada = (trecho: string) => clientQuerySpy.mock.invocationCallOrder[posicao(trecho)]!;
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
  configMock.STOCKBRIDGE_COMPRAS_EMAILS = ['compras@q2p.local', 'comprador@q2p.local'];
});

describe('enviarAvisoComprasNfSemPc', () => {
  it('envia um e-mail por destinatario de compras e registra o aviso DEPOIS de enviar, na transacao com trava', async () => {
    expect(await enviarAvisoComprasNfSemPc(base)).toBe('enviado');
    expect(emails().map((e) => e.to)).toEqual(['compras@q2p.local', 'comprador@q2p.local']);
    expect(emails()[0]!.subject).toBe('StockBridge — NF 7813 de REPLAS COMERCIAL LTDA sem pedido de compra no OMIE');
    const ins = insercoes();
    expect(ins).toHaveLength(1);
    expect(ins[0]![1]).toEqual(['q2p', CHAVE, '7813', 'REPLAS COMERCIAL LTDA', 'sem_pc', JSON.stringify(base.itens), 'compras@q2p.local, comprador@q2p.local', base.disparadoPor]);
    // trava por (NF, motivo) na propria transacao
    const trava = clientQuerySpy.mock.calls[posicao('pg_advisory_xact_lock')]!;
    expect(String(trava[0])).toContain('hashtextextended($1, 0)');
    expect(trava[1]).toEqual([`sb:aviso-compras:${CHAVE}:sem_pc`]);
    // ordem: BEGIN -> trava -> leitura de quem ja foi avisado -> envio -> INSERT -> COMMIT
    expect(comandos()[0]).toBe('BEGIN');
    expect(comandos().at(-1)).toBe('COMMIT');
    const iEnvio = sendEmailMock.mock.invocationCallOrder[0]!;
    expect(ordemChamada('BEGIN')).toBeLessThan(ordemChamada('pg_advisory_xact_lock'));
    expect(ordemChamada('pg_advisory_xact_lock')).toBeLessThan(ordemChamada('SELECT enviado_para'));
    expect(ordemChamada('SELECT enviado_para')).toBeLessThan(iEnvio);
    expect(iEnvio).toBeLessThan(ordemChamada('INSERT INTO stockbridge.nf_aviso_compras'));
    expect(ordemChamada('INSERT INTO stockbridge.nf_aviso_compras')).toBeLessThan(ordemChamada('COMMIT'));
    expect(comandos()).not.toContain('ROLLBACK');
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith(false);
  });

  it('deduplica: todos os destinatarios ja avisados nas ultimas 24 h -> nao reenvia nem registra, ROLLBACK', async () => {
    avisosPrevios = ['compras@q2p.local, comprador@q2p.local'];
    expect(await enviarAvisoComprasNfSemPc(base)).toBe('deduplicado');
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(insercoes()).toHaveLength(0);
    expect(comandos()).toContain('ROLLBACK');
    expect(comandos()).not.toContain('COMMIT');
    const leitura = clientQuerySpy.mock.calls[posicao('SELECT enviado_para')]!;
    expect(String(leitura[0])).toContain('nf_chave_acesso = $1 AND motivo = $2');
    expect(leitura[1]).toEqual([CHAVE, 'sem_pc', AVISO_COMPRAS_DEDUP_HORAS]);
    expect(AVISO_COMPRAS_DEDUP_HORAS).toBe(24);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('deduplica sem diferenciar caixa e juntando varias linhas da janela', async () => {
    avisosPrevios = ['COMPRAS@Q2P.LOCAL', ' comprador@q2p.local '];
    expect(await enviarAvisoComprasNfSemPc(base)).toBe('deduplicado');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('deduplicacao parcial: so o destinatario ainda nao avisado recebe, e so ele entra no registro novo', async () => {
    avisosPrevios = ['compras@q2p.local'];
    expect(await enviarAvisoComprasNfSemPc(base)).toBe('enviado');
    expect(emails().map((e) => e.to)).toEqual(['comprador@q2p.local']);
    const ins = insercoes();
    expect(ins).toHaveLength(1);
    expect(ins[0]![1]![6]).toBe('comprador@q2p.local');
  });

  it('falha parcial: grava so o entregue, loga o endereco que falhou e ele continua pendente para a proxima tentativa', async () => {
    sendEmailMock.mockImplementation(({ to }: { to: string }) =>
      to === 'comprador@q2p.local' ? Promise.reject(new Error('SendGrid 429')) : Promise.resolve(),
    );
    expect(await enviarAvisoComprasNfSemPc(base)).toBe('enviado');
    expect(insercoes()[0]![1]![6]).toBe('compras@q2p.local');
    const logado = loggerMock.error.mock.calls.find((c) => (c[0] as { to?: string }).to === 'comprador@q2p.local');
    expect(logado).toBeDefined();
    expect(comandos().at(-1)).toBe('COMMIT');

    // proxima tentativa: o entregue consta no registro, so o que falhou recebe
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue(undefined);
    clientQuerySpy.mockClear();
    avisosPrevios = ['compras@q2p.local'];
    expect(await enviarAvisoComprasNfSemPc(base)).toBe('enviado');
    expect(emails().map((e) => e.to)).toEqual(['comprador@q2p.local']);
    expect(insercoes()[0]![1]![6]).toBe('comprador@q2p.local');
  });

  it('falha em todos os envios: devolve falha e nao registra (ROLLBACK; a proxima tentativa reenvia)', async () => {
    sendEmailMock.mockRejectedValue(new Error('SendGrid 500'));
    expect(await enviarAvisoComprasNfSemPc(base)).toBe('falha');
    expect(insercoes()).toHaveLength(0);
    expect(comandos()).toContain('ROLLBACK');
    expect(comandos()).not.toContain('COMMIT');
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('STOCKBRIDGE_COMPRAS_EMAILS vazio: vai para STOCKBRIDGE_OPS_EMAIL, com aviso no log', async () => {
    configMock.STOCKBRIDGE_COMPRAS_EMAILS = [];
    expect(await enviarAvisoComprasNfSemPc(base)).toBe('enviado');
    expect(emails().map((e) => e.to)).toEqual(['ops@q2p.local']);
    expect(loggerMock.warn).toHaveBeenCalled();
    expect(insercoes()[0]![1]![6]).toBe('ops@q2p.local');
  });

  it('endereco repetido na configuracao (mesmo com caixa diferente) recebe um unico e-mail', async () => {
    configMock.STOCKBRIDGE_COMPRAS_EMAILS = ['compras@q2p.local', 'Compras@Q2P.local', ' compras@q2p.local '];
    expect(await enviarAvisoComprasNfSemPc(base)).toBe('enviado');
    expect(emails().map((e) => e.to)).toEqual(['compras@q2p.local']);
  });

  it('PC aguardando aprovacao: assunto e corpo dizem isso e citam o numero do PC; nenhum codigo OMIE', async () => {
    await enviarAvisoComprasNfSemPc({ ...base, motivo: 'pc_aguardando_aprovacao', pcsAguardandoAprovacao: ['305'] });
    const e = emails()[0]!;
    expect(e.subject).toContain('aguardando aprovação');
    expect(e.html).toContain('PC 305');
    expect(e.html).toContain('SUCATA PLASTICO');
    expect(e.html).not.toMatch(/\d{10}/);
    // a trava e o registro seguem o motivo
    expect(clientQuerySpy.mock.calls[posicao('pg_advisory_xact_lock')]![1]).toEqual([`sb:aviso-compras:${CHAVE}:pc_aguardando_aprovacao`]);
  });

  it('recebida sem vinculo: assunto proprio e orientacao para ajustar o PC com o fiscal', async () => {
    await enviarAvisoComprasNfSemPc({ ...base, motivo: 'recebida_sem_vinculo' });
    const e = emails()[0]!;
    expect(e.subject).toBe('StockBridge — NF 7813 de REPLAS COMERCIAL LTDA recebida sem pedido de compra no OMIE');
    expect(e.html).toContain('fiscal');
  });
});

describe('enviarAvisoComprasNfSemPc — erros de banco (best-effort: nunca lanca)', () => {
  it('nao conseguir conexao: devolve falha e nao envia nada', async () => {
    connectSpy.mockRejectedValue(new Error('connection refused'));
    await expect(enviarAvisoComprasNfSemPc(base)).resolves.toBe('falha');
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('erro na trava (ex.: lock timeout de outro envio em curso): falha, ROLLBACK, conexao liberada, nada enviado', async () => {
    clientQuerySpy.mockImplementation((sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return Promise.reject(new Error('canceling statement due to lock timeout'));
      return Promise.resolve({ rows: [] });
    });
    await expect(enviarAvisoComprasNfSemPc(base)).resolves.toBe('falha');
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(comandos()).toContain('ROLLBACK');
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith(false);
  });

  it('erro na leitura de quem ja foi avisado: falha sem enviar', async () => {
    clientQuerySpy.mockImplementation((sql: string) => {
      if (sql.includes('SELECT enviado_para')) return Promise.reject(new Error('connection reset'));
      return Promise.resolve({ rows: [] });
    });
    await expect(enviarAvisoComprasNfSemPc(base)).resolves.toBe('falha');
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(comandos()).toContain('ROLLBACK');
  });

  it('erro no INSERT depois do envio: falha, ROLLBACK e conexao liberada (a proxima tentativa reenvia)', async () => {
    clientQuerySpy.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO stockbridge.nf_aviso_compras')) return Promise.reject(new Error('deadlock detected'));
      return Promise.resolve({ rows: [] });
    });
    await expect(enviarAvisoComprasNfSemPc(base)).resolves.toBe('falha');
    expect(comandos()).toContain('ROLLBACK');
    expect(comandos()).not.toContain('COMMIT');
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('ROLLBACK que tambem falha: a conexao e descartada (release(true)) para nao devolver ao pool uma trava presa', async () => {
    clientQuerySpy.mockImplementation((sql: string) => {
      if (sql.includes('SELECT enviado_para')) return Promise.reject(new Error('connection reset'));
      if (sql === 'ROLLBACK') return Promise.reject(new Error('connection terminated'));
      return Promise.resolve({ rows: [] });
    });
    await expect(enviarAvisoComprasNfSemPc(base)).resolves.toBe('falha');
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith(true);
  });
});

describe('enviarAvisoComprasNfSemPc — corrida entre chamadas simultaneas (infra-02)', () => {
  it('duas chamadas ao mesmo tempo para a mesma NF e motivo: so uma envia, a outra ve o registro e deduplica', async () => {
    // Banco de brinquedo: a trava consultiva serializa as transacoes e o INSERT so aparece apos o COMMIT.
    const gravadas: string[] = [];
    let cauda: Promise<void> = Promise.resolve();
    connectSpy.mockImplementation(() => {
      let soltar: (() => void) | null = null;
      let pendente: string | null = null;
      return Promise.resolve({
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('pg_advisory_xact_lock')) {
            const anterior = cauda;
            cauda = new Promise<void>((resolve) => {
              soltar = resolve;
            });
            await anterior;
            return { rows: [] };
          }
          if (sql.includes('SELECT enviado_para')) return { rows: gravadas.map((enviado_para) => ({ enviado_para })) };
          if (sql.includes('INSERT INTO stockbridge.nf_aviso_compras')) {
            pendente = String((params as unknown[])[6]);
            return { rows: [] };
          }
          if (sql === 'COMMIT') {
            if (pendente != null) gravadas.push(pendente);
            soltar?.();
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') {
            soltar?.();
            return { rows: [] };
          }
          return { rows: [] };
        },
        release: releaseSpy,
      });
    });
    // latencia do provedor de e-mail: e nela que a corrida acontecia
    sendEmailMock.mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

    const resultados = await Promise.all([enviarAvisoComprasNfSemPc(base), enviarAvisoComprasNfSemPc(base)]);
    expect([...resultados].sort()).toEqual(['deduplicado', 'enviado']);
    expect(emails().map((e) => e.to)).toEqual(['compras@q2p.local', 'comprador@q2p.local']);
    expect(gravadas).toEqual(['compras@q2p.local, comprador@q2p.local']);
    expect(releaseSpy).toHaveBeenCalledTimes(2);
  });
});

// Revisao pos-017, sugestao-01: o PC do fornecedor pode estar lancado em OUTRO cadastro
// do OMIE (matriz x filial). O aviso nao pode mandar compras lancar um PC novo.
describe('enviarAvisoComprasNfSemPc — PC lancado em outro cadastro do fornecedor (sugestao-01)', () => {
  const outro = { itemDescricao: 'SUCATA PLASTICO', pcNumero: '306', cnpjCadastroPc: '61827663000179' };
  const CNPJ_NF = '61827663001302';

  it('sem_pc: o quadro cita o PC, o CNPJ dos dois cadastros e o item, e o "O que fazer" nao manda lancar PC novo', async () => {
    expect(await enviarAvisoComprasNfSemPc({ ...base, pcsOutroCadastro: [outro], cnpjNf: CNPJ_NF })).toBe('enviado');
    const html = emails()[0]!.html;
    expect(html).toContain('[Pedido de compra em outro cadastro do OMIE]');
    expect(html).toContain(
      'Há pedido de compra deste fornecedor lançado em OUTRO cadastro do OMIE: PC 306 (CNPJ 61.827.663/0001-79) para o item "SUCATA PLASTICO". ' +
        'A nota é do cadastro 61.827.663/0013-02. ' +
        'Ajuste o fornecedor do pedido para o cadastro da nota (ou peça ao fiscal para concluir o recebimento no OMIE) em vez de lançar um pedido novo.',
    );
    expect(html).toContain('Siga a orientação acima e não lance pedido de compra novo para estes itens.');
    expect(html).not.toContain('Lance e aprove no OMIE');
    // nenhum codigo OMIE nem CNPJ cru (so mascarado)
    expect(html).not.toMatch(/\d{10}/);
  });

  it('so parte dos itens tem PC em outro cadastro: o "O que fazer" manda lancar PC apenas para os demais (nomeados)', async () => {
    const itens = [
      { nSequencia: 1, descricao: 'SUCATA PLÁSTICO', qtdKg: 18000, precoUnit: 11.3 },
      { nSequencia: 2, descricao: 'SUCATA PP', qtdKg: 5000, precoUnit: 9 },
    ];
    await enviarAvisoComprasNfSemPc({ ...base, itens, pcsOutroCadastro: [{ ...outro, itemDescricao: 'sucata  plastico' }], cnpjNf: CNPJ_NF });
    const html = emails()[0]!.html;
    expect(html).toContain('Para os itens com pedido em outro cadastro, siga a orientação acima e não lance pedido novo.');
    expect(html).toContain('Para o item "SUCATA PP", lance e aprove no OMIE o pedido de compra deste fornecedor.');
    expect(html).not.toContain('Para o item "SUCATA PLÁSTICO"');
  });

  it('varios itens no mesmo PC saem agrupados; PCs diferentes vao para o plural', async () => {
    const itens = [
      { nSequencia: 1, descricao: 'MC PEBD LD', qtdKg: 8250, precoUnit: 10.8 },
      { nSequencia: 2, descricao: 'MC PEAD ES', qtdKg: 13750, precoUnit: 10.8 },
      { nSequencia: 3, descricao: 'PEBDL-16', qtdKg: 2750, precoUnit: 9.9 },
    ];
    await enviarAvisoComprasNfSemPc({
      ...base,
      itens,
      cnpjNf: CNPJ_NF,
      pcsOutroCadastro: [
        { itemDescricao: 'MC PEBD LD', pcNumero: '306', cnpjCadastroPc: '61827663000179' },
        { itemDescricao: 'MC PEAD ES', pcNumero: '306', cnpjCadastroPc: '61827663000179' },
        { itemDescricao: 'PEBDL-16', pcNumero: '307', cnpjCadastroPc: '61827663000926' },
      ],
    });
    const html = emails()[0]!.html;
    expect(html).toContain('Há pedidos de compra deste fornecedor lançados em OUTRO cadastro do OMIE: ');
    expect(html).toContain('PC 306 (CNPJ 61.827.663/0001-79) para os itens "MC PEBD LD" e "MC PEAD ES"');
    expect(html).toContain('PC 307 (CNPJ 61.827.663/0009-26) para o item "PEBDL-16"');
    expect(html).toContain('Ajuste o fornecedor dos pedidos para o cadastro da nota');
    expect(html).toContain('em vez de lançar pedidos novos.');
  });

  it('sem o CNPJ da nota, a frase do cadastro da nota some; o resto do quadro fica', async () => {
    await enviarAvisoComprasNfSemPc({ ...base, pcsOutroCadastro: [outro], cnpjNf: null });
    const html = emails()[0]!.html;
    expect(html).not.toContain('A nota é do cadastro');
    expect(html).toContain('PC 306 (CNPJ 61.827.663/0001-79) para o item "SUCATA PLASTICO".');
    expect(html).toContain('Ajuste o fornecedor do pedido para o cadastro da nota');
  });

  it('numero de PC vazio ou com cara de codigo interno do OMIE nunca aparece', async () => {
    await enviarAvisoComprasNfSemPc({
      ...base,
      cnpjNf: CNPJ_NF,
      pcsOutroCadastro: [{ ...outro, pcNumero: '8517884280' }],
    });
    const html = emails()[0]!.html;
    expect(html).toContain('um pedido de compra (CNPJ 61.827.663/0001-79) para o item "SUCATA PLASTICO"');
    expect(html).not.toMatch(/\d{10}/);
    expect(html).not.toContain('PC 8517884280');
  });

  it('pcsOutroCadastro vazio ou ausente: o e-mail e o de sempre (sem quadro, "O que fazer" padrao)', async () => {
    await enviarAvisoComprasNfSemPc({ ...base, pcsOutroCadastro: [], cnpjNf: CNPJ_NF });
    const html = emails()[0]!.html;
    expect(html).not.toContain('outro cadastro');
    expect(html).toContain('Lance e aprove no OMIE o pedido de compra deste item para este fornecedor. A NF fica na fila do StockBridge até o PC existir.');
  });

  it('PC aguardando aprovacao com PC em outro cadastro: o quadro aparece e o "O que fazer" continua o do motivo', async () => {
    await enviarAvisoComprasNfSemPc({
      ...base,
      motivo: 'pc_aguardando_aprovacao',
      pcsAguardandoAprovacao: ['305'],
      pcsOutroCadastro: [outro],
      cnpjNf: CNPJ_NF,
    });
    const html = emails()[0]!.html;
    expect(html).toContain('[Pedido de compra em outro cadastro do OMIE]');
    expect(html).toContain('Aprove o pedido de compra no OMIE.');
    expect(html).toContain('PC 305');
  });
});

describe('fmtCnpj', () => {
  it('mascara CNPJ (14 digitos) e CPF (11), aceita valor ja mascarado e devolve vazio para o resto', () => {
    expect(fmtCnpj('61827663000179')).toBe('61.827.663/0001-79');
    expect(fmtCnpj('61.827.663/0013-02')).toBe('61.827.663/0013-02');
    expect(fmtCnpj('12345678901')).toBe('123.456.789-01');
    expect(fmtCnpj('8517884280')).toBe('');
    expect(fmtCnpj('')).toBe('');
    expect(fmtCnpj(null)).toBe('');
    expect(fmtCnpj(undefined)).toBe('');
  });
});

describe('item que o Atlas não converte para kg (achado fila-v04)', () => {
  it('mostra a quantidade nativa da NF ("40 UN"), nunca "0 kg"', async () => {
    await enviarAvisoComprasNfSemPc({
      ...base,
      motivo: 'recebida_sem_vinculo',
      itens: [{ nSequencia: 2, descricao: 'TAMPA', qtdKg: null, precoUnit: null, quantidadeTexto: '40 UN' }],
    });
    const html = emails()[0]!.html;
    expect(html).toContain('40 UN');
    expect(html).not.toContain('0 kg');
  });
});

describe('limite de avisos simultâneos (achado infra-r04)', () => {
  it('com 3 envios pendurados, o 4º devolve falha na hora, sem pegar conexão do pool; depois que um termina, volta a enviar', async () => {
    expect(AVISO_COMPRAS_MAX_SIMULTANEOS).toBe(3);
    const pendentes: Array<() => void> = [];
    sendEmailMock.mockImplementation(() => new Promise<void>((resolve) => pendentes.push(resolve)));
    const chave = (n: number) => CHAVE.slice(0, -1) + String(n);
    const emCurso = [1, 2, 3].map((n) => enviarAvisoComprasNfSemPc({ ...base, nfChaveAcesso: chave(n) }));
    await vi.waitFor(() => expect(pendentes.length).toBeGreaterThanOrEqual(3));
    const conexoesAntes = connectSpy.mock.calls.length;
    expect(await enviarAvisoComprasNfSemPc({ ...base, nfChaveAcesso: chave(4) })).toBe('falha');
    expect(connectSpy.mock.calls.length).toBe(conexoesAntes);
    for (const r of pendentes.splice(0)) r();
    await Promise.all(emCurso);
    sendEmailMock.mockResolvedValue(undefined);
    expect(await enviarAvisoComprasNfSemPc({ ...base, nfChaveAcesso: chave(5) })).toBe('enviado');
  });
});
