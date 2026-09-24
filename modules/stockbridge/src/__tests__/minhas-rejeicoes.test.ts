import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 015 (ACXEGDP-328) — `listarMinhasRejeicoes` para o recebimento nacional
// por NF. O caminho nacional nao tem lote nem produto ACXE, e a funcao so
// selecionava colunas de lote/ACXE: o card do operador imprimia o literal
// "NF · Q2P · 11.2" (sem numero de NF, sem fornecedor, sem item) e o fallback
// de nome montava "SKU <codigo>" — codigo OMIE na tela, proibido (ACXEGDP-313).
// Achado no 1o teste em UAT, 24/09/2026.

const executeSpy = vi.fn();

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => ({ execute: (q: unknown) => executeSpy(q) }),
  getPool: () => ({ query: vi.fn() }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildEmailLayout: (o: { titulo?: string }) => ({ html: String(o?.titulo ?? ''), text: '' }),
  escapeHtml: (v: unknown) => String(v ?? ''),
  emailDataList: () => '',
  emailActionBox: (h: string) => h,
}));

vi.mock('@atlas/db', () => ({
  aprovacao: {}, lote: {}, movimentacao: {}, localidadeCorrelacao: {}, users: {}, reservaSaldo: {},
}));

vi.mock('@atlas/integration-omie', () => ({
  incluirAjusteEstoque: vi.fn(), consultarNF: vi.fn(), isMockMode: () => true,
}));

vi.mock('../services/omie-saida.service.js', () => ({
  executarSaidaOmieDual: vi.fn(), executarTransferenciaIntraDual: vi.fn(),
  executarComodatoOmieDual: vi.fn(), executarRetornoComodatoOmieDual: vi.fn(),
  resolverCodigoProdutoOmie: vi.fn(),
}));

import { listarMinhasRejeicoes } from '../services/aprovacao.service.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Linha do recebimento nacional rejeitado: sem lote, sem produto ACXE. */
const linhaNacional = (over: Record<string, unknown> = {}) => ({
  id: 'apr-1',
  lote_id: null,
  tipo_aprovacao: 'entrada_manual',
  quantidade_recebida_kg: '8205.000',
  rejeicao_motivo: 'teste',
  lancado_em: '2026-09-24T18:07:59.982Z',
  aprovado_em: '2026-09-24T19:10:00.000Z',
  lote_codigo: null,
  lote_produto_codigo_acxe: null,
  lote_fornecedor_nome: null,
  aprov_produto_codigo_acxe: null,
  aprov_galpao: '11.2',
  aprov_empresa: 'q2p',
  produto_descricao: null, // catalogo ACXE nao tem — fluxo e Q2P
  nota_fiscal: '36537',
  nf_item_descricao: 'SUCATA PP COLORIDO',
  nf_fornecedor_nome: 'COM. DE PAPEIS SAO JUDAS TADEU LTDA - FILIAL 02',
  produto_descricao_q2p: 'SUCATA DE PP',
  ...over,
});

/** Linha de importacao: com lote, produto ACXE, sem NF nas colunas novas. */
const linhaImportacao = (over: Record<string, unknown> = {}) => ({
  id: 'apr-2',
  lote_id: 'lote-1',
  tipo_aprovacao: 'recebimento_divergencia',
  quantidade_recebida_kg: '24500.000',
  rejeicao_motivo: 'reconferir',
  lancado_em: '2026-09-20T10:00:00.000Z',
  aprovado_em: '2026-09-20T12:00:00.000Z',
  lote_codigo: 'LOTE-2026-001',
  lote_produto_codigo_acxe: '4888142208',
  lote_fornecedor_nome: 'FORNECEDOR IMPORTACAO LTDA',
  aprov_produto_codigo_acxe: null,
  aprov_galpao: null,
  aprov_empresa: null,
  produto_descricao: 'PP HOMO H301',
  nota_fiscal: null,
  nf_item_descricao: null,
  nf_fornecedor_nome: null,
  produto_descricao_q2p: null,
  ...over,
});

function comLinhas(rows: unknown[]) {
  executeSpy.mockResolvedValue({ rows });
}
/** SQL gerado (template drizzle) como texto, para provar as colunas lidas. */
function sqlGerado(): string {
  const q = executeSpy.mock.calls[0]![0] as { queryChunks?: unknown[] };
  return JSON.stringify(q.queryChunks ?? q);
}

beforeEach(() => {
  executeSpy.mockReset();
});

describe('listarMinhasRejeicoes — recebimento nacional por NF (feature 015)', () => {
  it('devolve NF, item, fornecedor e produto — o card nao depende mais de lote', async () => {
    comLinhas([linhaNacional()]);
    const [r] = await listarMinhasRejeicoes(USER);
    expect(r).toMatchObject({
      id: 'apr-1',
      loteId: null,
      loteCodigo: null,
      notaFiscal: '36537',
      nfItemDescricao: 'SUCATA PP COLORIDO',
      fornecedorNome: 'COM. DE PAPEIS SAO JUDAS TADEU LTDA - FILIAL 02',
      produtoDescricao: 'SUCATA DE PP',
      quantidadeRecebidaKg: 8205,
      galpao: '11.2',
      empresa: 'q2p',
      motivoRejeicao: 'teste',
    });
    expect(r!.rejeitadoEm).toBe('2026-09-24T19:10:00.000Z');
  });

  it('produto vem do catalogo Q2P quando o ACXE e nulo (fluxo nacional e single-empresa)', async () => {
    comLinhas([linhaNacional({ produto_descricao: null, produto_descricao_q2p: 'PS CRISTAL A' })]);
    const [r] = await listarMinhasRejeicoes(USER);
    expect(r!.produtoDescricao).toBe('PS CRISTAL A');
    expect(r!.fornecedor).toBe('PS CRISTAL A');
  });

  it('NUNCA monta "SKU <codigo>": sem nome no catalogo, cai na descricao do item da NF (ACXEGDP-313)', async () => {
    comLinhas([linhaNacional({ produto_descricao: null, produto_descricao_q2p: null })]);
    const [r] = await listarMinhasRejeicoes(USER);
    expect(r!.fornecedor).toBe('SUCATA PP COLORIDO');
    expect(r!.fornecedor).not.toMatch(/SKU/);
    expect(r!.produtoCodigoAcxe).toBe(0); // sem produto ACXE no fluxo nacional
  });

  it('sem nome e sem item: texto neutro, nunca um numero de produto', async () => {
    comLinhas([linhaNacional({ produto_descricao: null, produto_descricao_q2p: null, nf_item_descricao: null })]);
    const [r] = await listarMinhasRejeicoes(USER);
    expect(r!.fornecedor).toBe('Produto não identificado');
    expect(r!.fornecedor).not.toMatch(/\d{6,}/);
  });

  it('a query le as colunas da NF, o catalogo Q2P e o fornecedor do espelho pela chave', async () => {
    comLinhas([]);
    await listarMinhasRejeicoes(USER);
    const sql = sqlGerado();
    expect(sql).toContain('a.nota_fiscal');
    expect(sql).toContain('a.nf_item_descricao');
    expect(sql).toContain('tbl_produtos_Q2P');
    expect(sql).toContain('a.produto_codigo_q2p');
    expect(sql).toContain('dest_razao');
    expect(sql).toContain('a.nf_chave_acesso');
    // subquery escalar com LIMIT 1, nao JOIN: duplicata no espelho nao pode
    // multiplicar a linha da rejeicao
    expect(sql).toMatch(/SELECT h\.dest_razao/);
    expect(sql).toContain('LIMIT 1');
  });
});

describe('listarMinhasRejeicoes — importacao com lote nao regride', () => {
  it('mantem lote, fornecedor do lote e produto ACXE; campos de NF ficam nulos', async () => {
    comLinhas([linhaImportacao()]);
    const [r] = await listarMinhasRejeicoes(USER);
    expect(r).toMatchObject({
      loteId: 'lote-1',
      loteCodigo: 'LOTE-2026-001',
      fornecedor: 'FORNECEDOR IMPORTACAO LTDA',
      produtoCodigoAcxe: 4888142208,
      produtoDescricao: 'PP HOMO H301',
      notaFiscal: null,
      nfItemDescricao: null,
      fornecedorNome: null,
    });
  });

  it('as duas origens convivem na mesma lista', async () => {
    comLinhas([linhaNacional(), linhaImportacao()]);
    const rs = await listarMinhasRejeicoes(USER);
    expect(rs).toHaveLength(2);
    expect(rs[0]!.notaFiscal).toBe('36537');
    expect(rs[1]!.loteCodigo).toBe('LOTE-2026-001');
  });
});
