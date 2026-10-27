import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CFOPS,
  CHAVE_ACXE,
  CHAVE_Q2P,
  CORTE_ACXE,
  CORTE_Q2P,
  OMIE,
  falhaTabelaAcxe,
  itemPc580,
  linhaDetalhe,
  linhaDetalheAcxe,
  localAtlas,
  novoBanco,
  pcVisto,
  produtoAcxe,
  responder,
  type Banco,
} from './helpers/banco-nacional-acxe.js';

// Feature 017, Historia 5 (ACXEGDP-437) — o DETALHE de uma NF nacional da ACXE.
//
// A chave de acesso e unica entre os espelhos, entao o detalhe consulta as empresas ativas e a linha diz de qual
// veio (`empresa`). Para a NF da ACXE: o produto NAO vem da memoria fornecedor x descricao (so Q2P) e sim do que o
// OMIE ja associou ao item e do produto do item do PC (catalogo da ACXE, com a marca `semCorrelatoQ2p`); o local de
// entrada vem do item do PC (resolvido no servidor para a localidade do Atlas — nunca o codigo OMIE de 10 digitos).
// A NF da Q2P continua como era: sem esses campos e com a memoria de correlacao.

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  config: {} as Record<string, unknown>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  sugerirProdutosEmLote: vi.fn(),
  registrarPcsVistosSeVencido: vi.fn(),
  lerPcsVistos: vi.fn(),
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params) }),
  getConfig: () => mocks.config,
}));
vi.mock('@atlas/integration-omie', () => ({ consultarPedidoCompra: vi.fn() }));
vi.mock('../services/correlacao-produto.service.js', () => ({ sugerirProdutosEmLote: (...a: unknown[]) => mocks.sugerirProdutosEmLote(...a) }));
vi.mock('../services/pc-visto.service.js', () => ({
  registrarPcsVistosSeVencido: (...a: unknown[]) => mocks.registrarPcsVistosSeVencido(...a),
  lerPcsVistos: (...a: unknown[]) => mocks.lerPcsVistos(...a),
}));

import { getDetalheNfNacional, montarDetalheNfNacional, NfNacionalNaoEncontradaError } from '../services/fila-nacional.service.js';
import { __resetEmpresaNacional } from '../services/empresa-nacional.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'fila-nacional-q2p');

interface Chamada {
  sql: string;
  params: unknown[];
}
const chamadas: Chamada[] = [];
let banco: Banco;

// D21 (fiscal revertido no OMIE): o kill switch fica DESLIGADO — este arquivo trava o SQL do detalhe das duas empresas SEM a
// D21 (o texto de antes, byte a byte, inclusive o golden da Q2P). Com a D21 ligada: fila-nacional-revertido.test.ts.
function configurar(opts: { acxe?: boolean } = {}): void {
  for (const k of Object.keys(mocks.config)) delete mocks.config[k];
  mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE = CORTE_Q2P;
  mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
  mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED = opts.acxe ?? true;
  mocks.config.STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED = false;
  mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE = CORTE_ACXE;
}

beforeEach(() => {
  banco = novoBanco();
  chamadas.length = 0;
  configurar();
  __resetEmpresaNacional();
  for (const f of Object.values(mocks.logger)) f.mockClear();
  mocks.sugerirProdutosEmLote.mockReset();
  mocks.sugerirProdutosEmLote.mockResolvedValue(new Map());
  mocks.registrarPcsVistosSeVencido.mockReset();
  mocks.registrarPcsVistosSeVencido.mockResolvedValue(undefined);
  mocks.lerPcsVistos.mockReset();
  mocks.lerPcsVistos.mockResolvedValue([]);
  mocks.poolQuery.mockReset();
  mocks.poolQuery.mockImplementation((sql: string, params?: unknown[]) => {
    chamadas.push({ sql, params: params ?? [] });
    return responder(banco, sql, params ?? []);
  });
});

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const sqlDetalhe = (): Chamada => {
  const c = chamadas.find((x) => x.sql.includes('WITH nf_unificada') && x.sql.includes('WHERE u.c_chave_nfe = $1'));
  if (!c) throw new Error('consulta do detalhe nao executada');
  return c;
};
const consultas = (trecho: string): Chamada[] => chamadas.filter((c) => c.sql.includes(trecho));
const consultaDeProdutos = () => consultas('FROM public."tbl_produtos_ACXE" a');
const consultaDeLocais = () => consultas('FROM stockbridge.localidade_correlacao lc');

describe('getDetalheNfNacional — SQL com as duas empresas', () => {
  it('olha as duas empresas (a chave de acesso e unica entre os espelhos): 4 blocos, cada um no espelho da propria empresa, e o corte da ACXE em $3', async () => {
    banco.detalhe = [linhaDetalheAcxe()];
    banco.copiaPcs.acxe = [itemPc580()];
    await getDetalheNfNacional(CHAVE_ACXE);
    const { sql, params } = sqlDetalhe();
    expect(params).toEqual([CHAVE_ACXE, CORTE_Q2P, CORTE_ACXE]);
    const b = sql.split('UNION ALL');
    expect(b).toHaveLength(4);
    for (const q of [b[0]!, b[1]!]) expect(q).not.toContain('_ACXE"');
    for (const a of [b[2]!, b[3]!]) expect(a).not.toContain('_Q2P"');
    expect(b[0]).toContain('h.d_emi >= $2::date');
    expect(b[2]).toContain('h.d_emi >= $3::date');
    expect(b[3]).toContain('r.d_emissao >= $3::date');
  });

  it('a linha devolve a empresa e o produto que o OMIE associou ao item; a exclusao de fornecedor casa a empresa da linha', async () => {
    banco.detalhe = [linhaDetalheAcxe()];
    banco.copiaPcs.acxe = [itemPc580()];
    await getDetalheNfNacional(CHAVE_ACXE);
    const n = norm(sqlDetalhe().sql);
    expect(n).toMatch(/u\.empresa AS empresa, u\.produto_omie::text AS produto_omie FROM nf_unificada u/);
    expect(n).toContain('NOT NOT EXISTS ( SELECT 1 FROM stockbridge.fornecedor_exclusao fe');
    expect(n).toContain('fe.fornecedor_cnpj = u.dest_cnpj_cpf AND fe.empresa = u.empresa');
    expect(n).toContain('AND m.empresa = u.empresa AND ltrim(m.nota_fiscal');
  });

  it('com a ACXE desligada, o detalhe consulta so a Q2P: o SQL e os parametros sao os de a62ea88', async () => {
    configurar({ acxe: false });
    banco.detalhe = [linhaDetalhe()];
    await getDetalheNfNacional(CHAVE_Q2P);
    const { sql, params } = sqlDetalhe();
    expect(sql.trimEnd()).toBe(readFileSync(join(GOLDEN, 'detalhe-fiscal-ligado.sql'), 'utf8').trimEnd());
    expect(params).toEqual(JSON.parse(readFileSync(join(GOLDEN, 'detalhe-fiscal-ligado.params.json'), 'utf8')));
    expect(sql).not.toContain('ACXE');
  });
});

describe('getDetalheNfNacional — NF da ACXE', () => {
  beforeEach(() => {
    banco.detalhe = [linhaDetalheAcxe()];
    banco.copiaPcs.acxe = [itemPc580()];
    banco.produtos = [produtoAcxe()];
    banco.locais = [localAtlas()];
  });

  it('linha em "Ignorar" no recebimento da ACXE: itensIgnoradosNoOmie traz o item', async () => {
    banco.detalhe = [linhaDetalheAcxe({ c_ignorar_item: 'S' })];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d).toMatchObject({ empresa: 'acxe', fiscal: 'pendente' });
    expect(d.itensIgnoradosNoOmie).toEqual([{ indice: 0, descricao: 'PP PRETO Q35' }]);
  });

  it('empresa "acxe", fiscal pendente e o fornecedor da linha; a memoria fornecedor x descricao (so Q2P) NAO e consultada', async () => {
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d).toMatchObject({
      empresa: 'acxe',
      nfChaveAcesso: CHAVE_ACXE,
      notaFiscal: '937',
      fornecedorNome: 'SOLUTEC PLASTICOS LTDA',
      fiscal: 'pendente',
      dispensavel: true,
      copiaPcsDefasada: false,
    });
    // o CNPJ do fornecedor se repete nas duas empresas e o codigo memorizado e o da Q2P: nao contamina a ACXE
    expect(mocks.sugerirProdutosEmLote).not.toHaveBeenCalled();
  });

  it('produtosSugeridos = o produto que o OMIE associou ao item (catalogo da ACXE), com a marca de quem tem correspondente na Q2P', async () => {
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens[0]!.produtosSugeridos).toEqual([
      { codigo: OMIE.produtoPpPreto, descricao: 'PP PRETO Q35', vezesUsada: 0, semCorrelatoQ2p: false },
    ]);
    expect(d.itens[0]!.bloqueio).toBeNull();
    // uma consulta so, com o codigo do produto (o do item e o do PC sao o mesmo: sem repeticao)
    expect(consultaDeProdutos()).toHaveLength(1);
    expect(consultaDeProdutos()[0]!.params).toEqual([[OMIE.produtoPpPreto]]);
  });

  it('produto SEM gemeo ativo na Q2P sai com semCorrelatoQ2p=true (so pode entrar em estoque so da ACXE)', async () => {
    banco.produtos = [produtoAcxe({ codigo_q2p: null, descricao_q2p: null })];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens[0]!.produtosSugeridos).toEqual([
      { codigo: OMIE.produtoPpPreto, descricao: 'PP PRETO Q35', vezesUsada: 0, semCorrelatoQ2p: true },
    ]);
  });

  it('o produto do item do PC (ncodprod) tambem e sugerido, DEPOIS do que o OMIE associou ao item, sem repeticao', async () => {
    banco.detalhe = [linhaDetalheAcxe({ produto_omie: String(OMIE.produtoPoliestireno) })];
    banco.produtos = [
      produtoAcxe({ codigo_acxe: String(OMIE.produtoPoliestireno), descricao_acxe: 'PS POLIESTIRENO BRANCO', codigo_q2p: null, descricao_q2p: null }),
      produtoAcxe(),
    ];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens[0]!.produtosSugeridos.map((p) => [p.codigo, p.semCorrelatoQ2p])).toEqual([
      [OMIE.produtoPoliestireno, true],
      [OMIE.produtoPpPreto, false],
    ]);
    expect(consultaDeProdutos()[0]!.params).toEqual([[OMIE.produtoPoliestireno, OMIE.produtoPpPreto]]);
  });

  it('item ainda sem produto associado no OMIE, e sem PC possivel: nenhuma sugestao, bloqueio "sem_correlacao" e NENHUMA consulta de produtos', async () => {
    banco.detalhe = [linhaDetalheAcxe({ produto_omie: null })];
    banco.copiaPcs.acxe = [];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens[0]!.produtosSugeridos).toEqual([]);
    expect(d.itens[0]!.bloqueio).toBe('sem_correlacao');
    expect(consultaDeProdutos()).toHaveLength(0);
  });

  it('item sem produto no OMIE mas com PC: o produto do PC e sugerido e o bloqueio "sem_correlacao" cai', async () => {
    banco.detalhe = [linhaDetalheAcxe({ produto_omie: null })];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens[0]!.produtosSugeridos.map((p) => p.codigo)).toEqual([OMIE.produtoPpPreto]);
    expect(d.itens[0]!.bloqueio).toBeNull();
  });

  it('produto inativo ou fora do cadastro da ACXE nao e oferecido (o combobox tambem nao o lista)', async () => {
    banco.detalhe = [linhaDetalheAcxe({ produto_omie: '4500000001' })];
    banco.copiaPcs.acxe = [itemPc580({ ncodprod: '4500000002' })];
    banco.produtos = [
      produtoAcxe({ codigo_acxe: '4500000001', descricao_acxe: 'PRODUTO DESATIVADO', ativo_acxe: false }),
      // 4500000002 nem existe no cadastro
    ];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens[0]!.produtosSugeridos).toEqual([]);
    expect(d.itens[0]!.bloqueio).toBe('sem_correlacao');
  });

  it('o bloqueio de UNIDADE continua valendo mesmo com produto sugerido (so o "sem_correlacao" informativo cai)', async () => {
    banco.detalhe = [linhaDetalheAcxe({ u_com: 'CX' })];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens[0]!.produtosSugeridos).toHaveLength(1);
    expect(d.itens[0]!.bloqueio).toBe('unidade_nao_conversivel');
    expect(d.itens[0]!.quantidadeNfKg).toBeNull();
  });

  it('falha ao ler o catalogo de produtos: o detalhe abre mesmo assim, sem sugestao (o operador escolhe no combobox), e loga com a chave', async () => {
    banco.falhas.push({ quando: (sql) => sql.includes('tbl_produtos_ACXE'), erro: () => new Error('connection reset'), restantes: 1 });
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens[0]!.produtosSugeridos).toEqual([]);
    expect(d.itens[0]!.bloqueio).toBe('sem_correlacao');
    const aviso = mocks.logger.warn.mock.calls.find((c) => String(c[1]).includes('Produtos sugeridos da NF da ACXE indisponíveis'));
    expect(aviso![0]).toMatchObject({ chave: CHAVE_ACXE });
  });

  it('varias linhas de mesma descricao com produtos diferentes: todos sugeridos, na ordem das linhas, uma vez cada', async () => {
    banco.detalhe = [
      linhaDetalheAcxe({ n_cod_item: '1', n_seq: 1, q_com: 13000, valor_item: 62400 }),
      linhaDetalheAcxe({ n_cod_item: '2', n_seq: 2, q_com: 13000, valor_item: 62400, produto_omie: String(OMIE.produtoPoliestireno) }),
      linhaDetalheAcxe({ n_cod_item: '3', n_seq: 3, q_com: 0.001, valor_item: 0, produto_omie: String(OMIE.produtoPpPreto) }),
    ];
    banco.produtos = [produtoAcxe(), produtoAcxe({ codigo_acxe: String(OMIE.produtoPoliestireno), descricao_acxe: 'PS POLIESTIRENO BRANCO', codigo_q2p: null, descricao_q2p: null })];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens).toHaveLength(1);
    expect(d.itens[0]!.linhasAgregadas).toBe(3);
    expect(d.itens[0]!.produtosSugeridos.map((p) => p.codigo)).toEqual([OMIE.produtoPpPreto, OMIE.produtoPoliestireno]);
  });

  it('o resultado interno (usado pelo POST) traz o fornecedor do recebimento e o PC por item da ACXE', async () => {
    const { detalhe, interno } = await montarDetalheNfNacional(CHAVE_ACXE);
    expect(detalhe.empresa).toBe('acxe');
    expect(interno.fornecedorCodigo).toBe(OMIE.fornecedorSolutec);
    const item = interno.pcPorIndice.get(0)!;
    expect(item.resultado!.pc.candidatos.map((c) => c.pcNumero)).toEqual(['580']);
    expect(item.entrada.sequencias).toEqual([1]);
  });
});

describe('getDetalheNfNacional — de onde vem o produto sugerido pelo PC (NF da ACXE)', () => {
  beforeEach(() => {
    banco.produtos = [produtoAcxe()];
    banco.locais = [localAtlas()];
  });
  const vinculo = { n_id_pedido: String(OMIE.pedido580), n_id_it_pedido: String(OMIE.itemPedido580) };

  it('vinculo do OMIE elegivel: o produto do item do PC vinculado e sugerido mesmo fora da tolerancia de preco (o vinculo e do OMIE, a justificativa vem depois)', async () => {
    banco.detalhe = [linhaDetalheAcxe({ produto_omie: null, ...vinculo })];
    banco.copiaPcs.acxe = [itemPc580({ nvalunit: 5.2 })]; // 8% acima do preco do PC: fora da tolerancia, nao pre-selecionado
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    const pc = d.itens[0]!.pc!;
    expect(pc.vinculoOmie).toMatchObject({ pcNumero: '580', dentroTolerancia: false });
    expect(pc.vinculoOmieElegivel).toBe(true);
    expect(pc.preSelecionado).toBeNull();
    expect(d.itens[0]!.produtosSugeridos.map((p) => p.codigo)).toEqual([OMIE.produtoPpPreto]);
  });

  it('PC em unidade diferente da NF (nao selecionavel): nao sugere produto, nem local por tabela — o item segue sem sugestao', async () => {
    banco.detalhe = [linhaDetalheAcxe({ produto_omie: null })];
    banco.copiaPcs.acxe = [itemPc580({ cunidade: 'TON', nqtde: 26, nvalunit: 4800 })];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    const pc = d.itens[0]!.pc!;
    expect(pc.candidatos).toEqual([]);
    expect(pc.unidadeIncompativel.map((c) => c.pcNumero)).toEqual(['580']);
    expect(d.itens[0]!.produtosSugeridos).toEqual([]);
    expect(d.itens[0]!.bloqueio).toBe('sem_correlacao');
  });

  it('dois PCs compativeis e nenhum pre-selecionado: o produto do PC NAO e adivinhado (so o que o OMIE associou ao item)', async () => {
    banco.detalhe = [linhaDetalheAcxe({ produto_omie: null })];
    banco.copiaPcs.acxe = [
      itemPc580(),
      itemPc580({ ncodped: String(OMIE.pedido580 + 20), ncoditem: String(OMIE.itemPedido580 + 20), cnumero: '581', ncodprod: String(OMIE.produtoPoliestireno) }),
    ];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens[0]!.pc!.candidatos.map((c) => c.pcNumero).sort()).toEqual(['580', '581']);
    expect(d.itens[0]!.pc!.preSelecionado).toBeNull();
    expect(d.pcsDaNf.preSelecionado).toBeNull();
    expect(d.itens[0]!.produtosSugeridos).toEqual([]);
  });

  it('PC pre-selecionado pelo numero que o fornecedor informou na NF (xPed): o produto dele e sugerido', async () => {
    banco.detalhe = [linhaDetalheAcxe({ produto_omie: null, n_num_ped_compra: '581' })];
    banco.copiaPcs.acxe = [
      itemPc580(),
      itemPc580({ ncodped: String(OMIE.pedido580 + 20), ncoditem: String(OMIE.itemPedido580 + 20), cnumero: '581', ncodprod: String(OMIE.produtoPoliestireno) }),
    ];
    banco.produtos = [produtoAcxe({ codigo_acxe: String(OMIE.produtoPoliestireno), descricao_acxe: 'PS POLIESTIRENO BRANCO', codigo_q2p: null, descricao_q2p: null })];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens[0]!.pc!.preSelecionado).not.toBeNull();
    expect(d.itens[0]!.produtosSugeridos.map((p) => [p.codigo, p.semCorrelatoQ2p])).toEqual([[OMIE.produtoPoliestireno, true]]);
  });

  it('a lista de produtos nunca repete um codigo, venha de onde vier', async () => {
    banco.detalhe = [linhaDetalheAcxe({ ...vinculo })]; // item com produto, vinculado ao PC que tem o MESMO produto
    banco.copiaPcs.acxe = [itemPc580()];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    const codigos = d.itens[0]!.produtosSugeridos.map((p) => p.codigo);
    expect(codigos).toEqual([OMIE.produtoPpPreto]);
    expect(new Set(codigos).size).toBe(codigos.length);
  });
});

describe('getDetalheNfNacional — local de entrada do PC (NF da ACXE)', () => {
  beforeEach(() => {
    banco.detalhe = [linhaDetalheAcxe()];
    banco.copiaPcs.acxe = [itemPc580()];
    banco.produtos = [produtoAcxe()];
    banco.locais = [localAtlas()];
  });

  it('o candidato leva localidadeId e "20.0.7 · PRODUÇÃO", resolvidos no servidor a partir do local do item do PC; o codigo do OMIE so e chave da consulta', async () => {
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    const c = d.itens[0]!.pc!.candidatos[0]!;
    expect(c).toMatchObject({ pcNumero: '580', localidadeId: '5b1a1c2e-7d1f-4d0e-9a53-0a7c6e0b2007', localDescricao: '20.0.7 · PRODUÇÃO' });
    expect(consultaDeLocais()).toHaveLength(1);
    expect(consultaDeLocais()[0]!.params).toEqual([[OMIE.local2007]]);
    // ACXEGDP-313: nenhum texto da tela leva o codigo de 10 digitos
    expect(c.localDescricao).not.toMatch(/\d{10}/);
    expect(JSON.stringify(c.motivo)).not.toMatch(/\d{10}/);
  });

  it('o PC por NF leva o mesmo local do item do PC atribuido a cada item da nota', async () => {
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.pcsDaNf.pcs).toHaveLength(1);
    expect(d.pcsDaNf.pcs[0]!.pcNumero).toBe('580');
    expect(d.pcsDaNf.pcs[0]!.itens).toHaveLength(1);
    expect(d.pcsDaNf.pcs[0]!.itens[0]).toMatchObject({ indice: 0, localidadeId: '5b1a1c2e-7d1f-4d0e-9a53-0a7c6e0b2007', localDescricao: '20.0.7 · PRODUÇÃO' });
  });

  it('PC sem local, ou com local que nao e destino (virtual/inativo/fora do Atlas), fica com localidadeId e localDescricao nulos', async () => {
    banco.copiaPcs.acxe = [itemPc580({ codigo_local_estoque: null })];
    let d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens[0]!.pc!.candidatos[0]).toMatchObject({ localidadeId: null, localDescricao: null });
    expect(d.pcsDaNf.pcs[0]!.itens[0]).toMatchObject({ localidadeId: null, localDescricao: null });
    // sem local no PC nem se consulta a correlacao
    expect(consultaDeLocais()).toHaveLength(0);

    banco.copiaPcs.acxe = [itemPc580({ codigo_local_estoque: '4503767789' })]; // 90.0.2 TRANSITO: a correlacao de destinos nao o devolve
    d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens[0]!.pc!.candidatos[0]).toMatchObject({ localidadeId: null, localDescricao: null });
  });

  it('falha ao resolver os locais: os candidatos seguem sem local (o operador escolhe o estoque) e o aviso e logado', async () => {
    banco.falhas.push({ quando: (sql) => sql.includes('localidade_correlacao'), erro: () => new Error('deadlock detected'), restantes: 1 });
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens[0]!.pc!.candidatos[0]).toMatchObject({ pcNumero: '580', localidadeId: null, localDescricao: null });
    expect(mocks.logger.warn.mock.calls.some((c) => String(c[1]).includes('Locais dos pedidos de compra indisponíveis'))).toBe(true);
  });

  it('PC que saiu da lista de pendentes (cache de PCs vistos) mantem o local e o produto, e o numero continua legivel', async () => {
    banco.copiaPcs.acxe = []; // o OMIE tirou o PC 580 da lista entre a associacao e a conclusao
    mocks.lerPcsVistos.mockResolvedValue([pcVisto()]);
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    const c = d.itens[0]!.pc!.candidatos[0]!;
    expect(c).toMatchObject({ pcNumero: '580', dadosEmCache: true, localidadeId: '5b1a1c2e-7d1f-4d0e-9a53-0a7c6e0b2007', localDescricao: '20.0.7 · PRODUÇÃO' });
    expect(d.itens[0]!.produtosSugeridos.map((p) => p.codigo)).toEqual([OMIE.produtoPpPreto]);
    expect(mocks.lerPcsVistos).toHaveBeenCalledWith('acxe', expect.objectContaining({ fornecedores: [OMIE.fornecedorSolutec] }));
    expect(mocks.registrarPcsVistosSeVencido).toHaveBeenCalledWith('acxe', expect.any(Number));
  });
});

describe('getDetalheNfNacional — copia de PCs defasada, por empresa', () => {
  it('copia da ACXE velha: copiaPcsDefasada, nenhum PC lido da copia (modo seguro) — o produto ainda vem do item', async () => {
    banco.detalhe = [linhaDetalheAcxe()];
    banco.copiaPcs.acxe = [itemPc580()];
    banco.produtos = [produtoAcxe()];
    banco.idadeCopia.acxe = 500;
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.copiaPcsDefasada).toBe(true);
    expect(d.itens[0]!.pc!.candidatos).toEqual([]);
    expect(d.itens[0]!.pc!.semPcMotivo).toBeNull();
    expect(d.pcsDaNf.pcs).toEqual([]);
    expect(chamadas.some((c) => c.sql.includes('tbl_pedidosCompras_ACXE" pc'))).toBe(false);
    expect(d.itens[0]!.produtosSugeridos.map((p) => p.codigo)).toEqual([OMIE.produtoPpPreto]);
    // a idade conferida e a da copia da ACXE
    const idades = consultas('MAX(data_atualizacao)');
    expect(idades).toHaveLength(1);
    expect(idades[0]!.sql).toContain('"tbl_pedidosCompras_ACXE"');
  });

  it('copia da ACXE velha NAO afeta o detalhe de uma NF da Q2P (cada empresa tem a sua copia e o seu limite)', async () => {
    banco.idadeCopia.acxe = 500;
    banco.detalhe = [linhaDetalhe({ empresa: 'q2p', produto_omie: null })];
    const d = await getDetalheNfNacional(CHAVE_Q2P);
    expect(d.copiaPcsDefasada).toBe(false);
    const idades = consultas('MAX(data_atualizacao)');
    expect(idades.map((c) => c.sql.includes('"tbl_pedidosCompras_Q2P"'))).toEqual([true]);
  });

  it('copia da Q2P velha NAO afeta o detalhe de uma NF da ACXE', async () => {
    banco.idadeCopia.q2p = 500;
    banco.detalhe = [linhaDetalheAcxe()];
    banco.copiaPcs.acxe = [itemPc580()];
    banco.produtos = [produtoAcxe()];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.copiaPcsDefasada).toBe(false);
    expect(d.itens[0]!.pc!.candidatos).toHaveLength(1);
  });
});

describe('getDetalheNfNacional — NF da Q2P com a ACXE habilitada: como era', () => {
  beforeEach(() => {
    banco.detalhe = [linhaDetalhe({ empresa: 'q2p', produto_omie: null })];
    banco.copiaPcs.q2p = [
      {
        ncodped: '8516905979',
        ncoditem: '8516907022',
        cnumero: '304',
        cetapa: '15',
        ncodfor: '1111',
        nqtde: 18000,
        nqtderec: 0,
        nvalunit: 11.3,
        cunidade: 'KG',
        ddtprevisao: '2026-10-30',
        cdescricao: 'SUCATA PLASTICO',
        cproduto: 'SUCATA',
        atualizado_ms: Date.now() - 5 * 60_000,
        valor_total_pc: 203400,
        fornecedor_acxe: false,
        cnpj_cadastro: '14555032000753',
        ncodprod: '3100000777',
        // a copia real da Q2P tem o local do item do PC, mas ele so serve para a NF da ACXE
        codigo_local_estoque: '8115873874',
      },
    ];
  });

  it('a memoria fornecedor x descricao continua sendo a fonte das sugestoes de produto, sem a marca semCorrelatoQ2p', async () => {
    mocks.sugerirProdutosEmLote.mockResolvedValue(new Map([['SUCATA PLASTICO', [{ codigo: 3100000001, descricao: 'SUCATA DE POLIPROPILENO', vezesUsada: 4 }]]]));
    const d = await getDetalheNfNacional(CHAVE_Q2P);
    expect(d.empresa).toBe('q2p');
    expect(mocks.sugerirProdutosEmLote).toHaveBeenCalledWith('14.555.032/0007-53', ['SUCATA PLASTICO']);
    expect(d.itens[0]!.produtosSugeridos).toEqual([{ codigo: 3100000001, descricao: 'SUCATA DE POLIPROPILENO', vezesUsada: 4 }]);
    expect(d.itens[0]!.produtosSugeridos[0]).not.toHaveProperty('semCorrelatoQ2p');
    expect(d.itens[0]!.bloqueio).toBeNull();
    // o catalogo da ACXE nao e consultado
    expect(consultaDeProdutos()).toHaveLength(0);
  });

  it('sem sugestao memorizada, o item segue "sem_correlacao" (informativo) — o produto do PC da Q2P nao vira sugestao', async () => {
    const d = await getDetalheNfNacional(CHAVE_Q2P);
    expect(d.itens[0]!.produtosSugeridos).toEqual([]);
    expect(d.itens[0]!.bloqueio).toBe('sem_correlacao');
  });

  it('os candidatos de PC e o PC por NF NAO levam local (localidadeId/localDescricao nulos), e a correlacao de locais nem e consultada', async () => {
    const d = await getDetalheNfNacional(CHAVE_Q2P);
    const c = d.itens[0]!.pc!.candidatos[0]!;
    expect(c.pcNumero).toBe('304');
    expect(c.localidadeId).toBeNull();
    expect(c.localDescricao).toBeNull();
    expect(d.pcsDaNf.pcs[0]!.itens[0]).toMatchObject({ localidadeId: null, localDescricao: null });
    expect(consultaDeLocais()).toHaveLength(0);
  });
});

describe('getDetalheNfNacional — fiscal ja feito: numero do PC vinculado, por empresa', () => {
  it('NF da ACXE: a copia e o cache sao os da ACXE e o ledger so conta o que a ACXE vinculou', async () => {
    banco.detalhe = [linhaDetalheAcxe({ fiscal_pendente: false, n_id_pedido: String(OMIE.pedido580), n_id_it_pedido: String(OMIE.itemPedido580) })];
    banco.produtos = [produtoAcxe()];
    banco.numerosPcs = [{ ncodped: String(OMIE.pedido580), numero: '580', prio: 1 }];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.fiscal).toBe('concluido');
    expect(d.itens[0]!.pc).toMatchObject({ vinculadoNoOmie: { pcNumero: '580' } });
    const q = norm(consultas('ORDER BY 3')[0]!.sql);
    expect(q).toContain('FROM public."tbl_pedidosCompras_ACXE" WHERE ncodped = ANY($1::bigint[])');
    expect(q).not.toContain('tbl_pedidosCompras_Q2P');
    expect(q).toContain("FROM stockbridge.recebimento_fiscal_pc WHERE n_cod_ped = ANY($1::bigint[]) AND status = 'concluido' AND empresa = 'acxe' GROUP BY n_cod_ped");
    expect(q).toContain("FROM stockbridge.pedido_compra_visto WHERE empresa = 'acxe' AND n_cod_ped = ANY($1::bigint[])");
    expect(consultas('ORDER BY 3')[0]!.params).toEqual([[OMIE.pedido580]]);
  });

  it('NF da Q2P: o mesmo texto de sempre (ledger sem filtro de empresa, cache da Q2P)', async () => {
    banco.detalhe = [linhaDetalhe({ empresa: 'q2p', produto_omie: null, fiscal_pendente: false, n_id_pedido: '8516905979', n_id_it_pedido: '8516907022' })];
    banco.numerosPcs = [{ ncodped: '8516905979', numero: '304', prio: 1 }];
    const d = await getDetalheNfNacional(CHAVE_Q2P);
    expect(d.itens[0]!.pc).toMatchObject({ vinculadoNoOmie: { pcNumero: '304' } });
    const q = norm(consultas('ORDER BY 3')[0]!.sql);
    expect(q).toContain('FROM public."tbl_pedidosCompras_Q2P" WHERE ncodped = ANY($1::bigint[])');
    expect(q).toContain("AND status = 'concluido' GROUP BY n_cod_ped");
    expect(q).not.toContain("AND empresa = 'acxe'");
    expect(q).toContain("FROM stockbridge.pedido_compra_visto WHERE empresa = 'q2p' AND");
  });

  it('NF da ACXE com fiscal ja feito: produtos sugeridos tambem vem do item (nao so do PC)', async () => {
    banco.detalhe = [linhaDetalheAcxe({ fiscal_pendente: false })];
    banco.produtos = [produtoAcxe()];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.itens[0]!.produtosSugeridos.map((p) => p.codigo)).toEqual([OMIE.produtoPpPreto]);
    expect(d.copiaPcsDefasada).toBe(false);
  });

  it('NF da ACXE concluida fora do Atlas COM movimento de estoque (hábito do portal): estoqueLancadoPeloOmie bloqueia o recebimento', async () => {
    banco.detalhe = [linhaDetalheAcxe({ fiscal_pendente: false, receb_recebido: 'S', c_ignorar_item: 'N', c_nao_gerar_mov_estoque: 'N' })];
    banco.produtos = [produtoAcxe()];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.estoqueLancadoPeloOmie).toBe(true);
  });

  it('o mesmo recebimento concluido com "nao movimentar estoque" nao bloqueia', async () => {
    banco.detalhe = [linhaDetalheAcxe({ fiscal_pendente: false, receb_recebido: 'S', c_ignorar_item: 'N', c_nao_gerar_mov_estoque: 'S' })];
    banco.produtos = [produtoAcxe()];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d.estoqueLancadoPeloOmie).toBe(false);
  });
});

describe('getDetalheNfNacional — espelho da ACXE ausente nao derruba a Q2P', () => {
  it('NF da Q2P continua abrindo: repete a consulta so com a Q2P (o SQL de sempre) e avisa que a ACXE esta fora', async () => {
    banco.falhas.push(falhaTabelaAcxe());
    banco.detalhe = [linhaDetalhe()];
    const d = await getDetalheNfNacional(CHAVE_Q2P);
    expect(d.empresa).toBe('q2p');
    const tentativas = chamadas.filter((c) => c.sql.includes('WITH nf_unificada') && c.sql.includes('WHERE u.c_chave_nfe = $1'));
    expect(tentativas).toHaveLength(2);
    expect(tentativas[0]!.sql).toContain('_ACXE"');
    expect(tentativas[1]!.sql.trimEnd()).toBe(readFileSync(join(GOLDEN, 'detalhe-fiscal-ligado.sql'), 'utf8').trimEnd());
    expect(tentativas[1]!.params).toEqual([CHAVE_Q2P, CORTE_Q2P]);
    expect(mocks.logger.error.mock.calls.some((c) => String(c[1]).includes('Consulta da ACXE falhou') && (c[0] as { onde: string }).onde === 'detalhe')).toBe(true);
  });

  it('NF da ACXE nessa situacao: nao encontrada (a ACXE esta fora), nunca um detalhe da empresa errada', async () => {
    banco.falhas.push(falhaTabelaAcxe());
    banco.detalhe = []; // a Q2P nao conhece a chave da ACXE
    await expect(getDetalheNfNacional(CHAVE_ACXE)).rejects.toBeInstanceOf(NfNacionalNaoEncontradaError);
  });

  it('tabela da Q2P ausente continua sendo erro visivel (FilaNacionalIncompletaError), nao fallback', async () => {
    banco.falhas.push({
      quando: (sql) => sql.includes('WITH nf_unificada'),
      erro: () => Object.assign(new Error('relation "stockbridge.recebimento_fiscal" does not exist'), { code: '42P01' }),
      restantes: 99,
    });
    await expect(getDetalheNfNacional(CHAVE_Q2P)).rejects.toThrow(/configuração incompleta/);
    expect(chamadas.filter((c) => c.sql.includes('WITH nf_unificada'))).toHaveLength(2);
  });
});

describe('getDetalheNfNacional — recorte e regras comuns valem para a NF da ACXE', () => {
  it('chave inexistente nas duas empresas: nao encontrada', async () => {
    banco.detalhe = [];
    await expect(getDetalheNfNacional(CHAVE_ACXE)).rejects.toBeInstanceOf(NfNacionalNaoEncontradaError);
  });

  it('chave que nao tem 44 digitos nem chega ao banco', async () => {
    await expect(getDetalheNfNacional('123')).rejects.toBeInstanceOf(NfNacionalNaoEncontradaError);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('NF da ACXE com fornecedor excluido (a contraparte intercompany da Q2P) e recusada como a da Q2P', async () => {
    banco.detalhe = [linhaDetalheAcxe({ fornecedor_nome: 'Q2P COMERCIO ATACADISTA', fornecedor_excluido: true })];
    await expect(getDetalheNfNacional(CHAVE_ACXE)).rejects.toThrow(/fora do escopo da fila de recebimento nacional/);
  });

  it('NF da ACXE com dispensa ativa explica a dispensa (a dispensa e por chave de acesso)', async () => {
    banco.detalhe = [linhaDetalheAcxe()];
    banco.dispensa = [{ dispensado_em: '2026-10-22 16:09:23-03' }];
    await expect(getDetalheNfNacional(CHAVE_ACXE)).rejects.toThrow(/foi dispensada da fila pelo gestor/);
  });

  it('CFOP fora do recorte nas linhas da ACXE: conta como fora do recorte; nenhum item elegivel = erro explicativo', async () => {
    banco.detalhe = [linhaDetalheAcxe({ cfop: '1.556' })];
    await expect(getDetalheNfNacional(CHAVE_ACXE)).rejects.toThrow(/nenhum item dela é compra de mercadoria/);
    expect(CFOPS).toContain('1.101');
  });
});

// Defeito achado pelos testes da Fase 2 e corrigido — o mesmo da fila (ver fila-nacional-acxe.test.ts): com a ACXE desligada o
// detalhe consulta so a Q2P e o `fornecedor_excluido` dele nao filtrava a empresa da exclusao; uma exclusao de empresa 'acxe'
// faria o detalhe de uma NF da Q2P responder FORNECEDOR_EXCLUIDO. Agora filtra `fe.empresa = 'q2p'` (golden regenerado).
describe('fornecedor_excluido do detalhe so da Q2P filtra a empresa da exclusao', () => {
  it('ACXE desligada: o NOT EXISTS de fornecedor_exclusao filtra a empresa', async () => {
    configurar({ acxe: false });
    banco.detalhe = [linhaDetalhe()];
    await getDetalheNfNacional(CHAVE_Q2P);
    expect(norm(sqlDetalhe().sql)).toMatch(/fe\.empresa = (u\.empresa|'q2p')/);
  });
});
