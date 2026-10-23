import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — e-mails da entrada nacional da ACXE:
//  - o contexto do e-mail ao operador le fornecedor e produto da ACXE (antes: so tbl_nf_header_Q2P e
//    tbl_produtos_Q2P, entao o e-mail da ACXE saia sem fornecedor e, no estoque so da ACXE, sem produto) e
//    diz onde a entrada foi lancada ("ACXE + Q2P" | "ACXE");
//  - o aviso de dispensa cita a ACXE quando a NF e dela; para a Q2P o texto e o de sempre.

const { sendEmailMock, loggerMock, executeMock, configMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue(undefined),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  executeMock: vi.fn(),
  configMock: {
    APP_URL: 'https://atlas.local',
    STOCKBRIDGE_FISCAL_EMAILS: ['nfe@acxe-polimeros.com.br'] as string[],
  },
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => loggerMock,
  getConfig: () => configMock,
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ email: 'operador@q2p.local' }]) }) }) }),
    execute: executeMock,
  }),
  sendEmail: sendEmailMock,
  buildEmailLayout: (o: { corpoHtml?: string; ctaUrl?: string }) => ({ html: `${o?.corpoHtml ?? ''}||URL:${o?.ctaUrl ?? ''}`, text: '' }),
  escapeHtml: (v: unknown) => String(v ?? ''),
  emailActionBox: (html: string) => html,
  emailDataList: (linhas: Array<{ label: string; valor: string | number | null | undefined }>) =>
    linhas.filter((l) => l.valor !== '' && l.valor != null).map((l) => `[${l.label}: ${l.valor}]`).join(''),
}));
vi.mock('@atlas/db', () => ({ users: {}, userModules: {} }));

import {
  carregarContextoEntradaNacional,
  enviarNotificacaoAprovacaoOperador,
  enviarAlertaNfDispensada,
} from '../services/notificacao.service.js';

const linhaAcxe = (over: Record<string, unknown> = {}) => ({
  por_nf: true,
  nota_fiscal: '937',
  fornecedor: 'SOLUTEC PLASTICOS LTDA',
  item_nf: 'PP PRETO Q35',
  produto: 'PP PRETO Q35',
  quantidade_kg: '26000.000',
  local: 'EXTREMA',
  empresa: 'acxe',
  tem_produto_q2p: true,
  ...over,
});

const ultimoEmail = () => sendEmailMock.mock.calls.at(-1)![0] as { subject: string; html: string };
const textoSql = (): string => {
  const q = executeMock.mock.calls[0]![0] as { queryChunks?: unknown[] };
  return JSON.stringify(q.queryChunks ?? q);
};

beforeEach(() => {
  sendEmailMock.mockClear();
  executeMock.mockReset();
});

describe('carregarContextoEntradaNacional — ACXE', () => {
  it('a consulta junta o espelho de NF e o cadastro de produtos da ACXE (alem dos da Q2P) e le a empresa', async () => {
    executeMock.mockResolvedValue({ rows: [linhaAcxe()] });
    await carregarContextoEntradaNacional('ap-1');
    const sql = textoSql();
    expect(sql).toContain('tbl_nf_header_Q2P');
    expect(sql).toContain('tbl_nf_header_ACXE');
    expect(sql).toContain('tbl_produtos_Q2P');
    expect(sql).toContain('tbl_produtos_ACXE');
    expect(sql).toContain('COALESCE(f.dest_razao, fa.dest_razao) AS fornecedor');
    expect(sql).toContain('a.empresa AS empresa');
    expect(sql).toContain('a.produto_codigo_acxe');
  });

  it('estoque que entra nas duas empresas: "ACXE + Q2P"; so na ACXE: "ACXE"', async () => {
    executeMock.mockResolvedValue({ rows: [linhaAcxe()] });
    expect((await carregarContextoEntradaNacional('ap-1'))!.entradaEm).toBe('ACXE + Q2P');
    executeMock.mockResolvedValue({ rows: [linhaAcxe({ tem_produto_q2p: false, local: 'PRODUÇÃO' })] });
    expect((await carregarContextoEntradaNacional('ap-1'))!.entradaEm).toBe('ACXE');
  });

  it('nas duas empresas com a perna da Q2P pendente (falhou na aprovacao): o e-mail diz que a Q2P esta pendente', async () => {
    executeMock.mockResolvedValue({ rows: [linhaAcxe({ q2p_pendente: true })] });
    expect((await carregarContextoEntradaNacional('ap-1'))!.entradaEm).toBe('ACXE + Q2P (lançamento na Q2P pendente)');
    expect(textoSql()).toContain("(m.status_omie = 'pendente_q2p' AND m.mv_acxe = 1) AS q2p_pendente");
  });

  it('Q2P (ou linha sem empresa, formato anterior): entradaEm nulo — o e-mail e o de sempre', async () => {
    executeMock.mockResolvedValue({ rows: [linhaAcxe({ empresa: 'q2p', tem_produto_q2p: true })] });
    expect((await carregarContextoEntradaNacional('ap-1'))!.entradaEm).toBeNull();
    const { empresa: _e, tem_produto_q2p: _t, ...semColunas } = linhaAcxe();
    executeMock.mockResolvedValue({ rows: [semColunas] });
    expect((await carregarContextoEntradaNacional('ap-1'))!.entradaEm).toBeNull();
  });

  it('formulario manual da ACXE (sem chave de acesso): so "ACXE", mesmo com produto da Q2P', async () => {
    executeMock.mockResolvedValue({ rows: [linhaAcxe({ por_nf: false, tem_produto_q2p: true })] });
    expect((await carregarContextoEntradaNacional('ap-1'))!.entradaEm).toBe('ACXE');
  });
});

describe('e-mail de aprovacao ao operador — ACXE', () => {
  it('traz fornecedor, produto, local (nome) e onde a entrada foi lancada', async () => {
    executeMock.mockResolvedValue({ rows: [linhaAcxe({ local: 'PRODUÇÃO', tem_produto_q2p: false })] });
    await enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'ap-1', tipoAprovacao: 'entrada_manual' });
    const { subject, html } = ultimoEmail();
    expect(subject).toBe('StockBridge — Recebimento aprovado — NF 937 (SOLUTEC PLASTICOS LTDA)');
    expect(html).toContain('[Fornecedor: SOLUTEC PLASTICOS LTDA]');
    expect(html).toContain('[Produto: PP PRETO Q35]');
    expect(html).toContain('[Local: PRODUÇÃO]');
    expect(html).toContain('[Empresas da entrada: ACXE]');
  });

  it('Q2P: nenhuma linha "Empresas da entrada" (o e-mail nao muda)', async () => {
    executeMock.mockResolvedValue({ rows: [linhaAcxe({ empresa: 'q2p', fornecedor: 'REPLAS COMERCIAL LTDA' })] });
    await enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'ap-1', tipoAprovacao: 'entrada_manual' });
    expect(ultimoEmail().html).not.toContain('Empresas da entrada');
  });
});

describe('aviso de dispensa ao fiscal — empresa', () => {
  const base = {
    notaFiscal: '937',
    fornecedorNome: 'SOLUTEC PLASTICOS LTDA',
    situacaoFiscalNaDispensa: 'pendente' as const,
    valorNfBrl: 124800,
    motivo: 'Fornecedor vai cancelar a nota',
    dispensadoPorNome: 'Gestor',
    dispensadoEm: '2026-10-22T13:00:00.000Z',
  };

  it('NF da ACXE: o assunto e o corpo citam a ACXE e ha a linha Empresa', async () => {
    await enviarAlertaNfDispensada({ ...base, empresa: 'acxe' });
    const { subject, html } = ultimoEmail();
    expect(subject).toBe('StockBridge — NF 937 (SOLUTEC PLASTICOS LTDA) dispensada da fila da ACXE');
    expect(html).toContain('fila de recebimento nacional da ACXE do StockBridge');
    expect(html).toContain('[Empresa: ACXE]');
  });

  it('NF da Q2P ou sem empresa: o texto de sempre (sem citar empresa)', async () => {
    await enviarAlertaNfDispensada({ ...base });
    await enviarAlertaNfDispensada({ ...base, empresa: 'q2p' });
    for (const c of sendEmailMock.mock.calls) {
      const { subject, html } = c[0] as { subject: string; html: string };
      expect(subject).toBe('StockBridge — NF 937 (SOLUTEC PLASTICOS LTDA) dispensada da fila');
      expect(html).toContain('da fila de recebimento nacional do StockBridge');
      expect(html).not.toContain('[Empresa:');
    }
  });
});
