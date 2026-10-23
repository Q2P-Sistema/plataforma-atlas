import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Feature 017 (ACXEGDP-437), T019 — sugestao de pedido de compra (PC) por item da NF nacional.
//
// Cobre pc-sugestao.service.ts sem rede e sem banco:
//  A. montarPcDoItem (pura): tolerancias, listas, ordenacao, pre-selecao, vinculo do OMIE e
//     "sem PC" (research D3, data-model §8);
//  B. saldoDisponivelCopiaKg: o que a copia ainda nao viu (concluidos) e as reservas (D3/D4);
//  C. pcSituacaoDaNf: pior caso da NF;
//  D. validarEscolhaPc: portao 1 e matriz de justificativa (data-model §4);
//  E. carregarContextoPc / sugerirPcPorItens: SQL e mapeamento com o pool mockado, como em
//     fila-nacional.test.ts.
// A releitura ao vivo e a reserva (relerEReservarPcs) ficam em pc-reserva.test.ts; a trava de unidade
// (STOCKBRIDGE_PC_UNIDADE_DIFERENTE) em pc-unidade.test.ts; o PC por NF (montarPcsDaNf) em pc-por-nf.test.ts;
// o SQL do cache de PCs vistos (0057) em pc-visto.test.ts.
//
// Mudancas do T033 (22/10/2026) refletidas aqui: o PC lancado em OUTRO cadastro da mesma raiz de CNPJ
// (filial x matriz, NF 60199 x PC 306) e OFERECIDO (selo outroCadastro + sufixo no motivo); o cache de PCs
// vistos entra no carregarContextoPc por import() dinamico, mockado neste arquivo (o pool conta so as
// consultas da copia, do cadastro e do ledger).
//
// Caso de referencia: Replas, fornecedor 1111, PC 304 (18.000 kg a R$ 11,30/kg, etapa 15) e um
// PC 302 identico — a NF 7813 de 21/10/2026. Os ids do OMIE sao so identificadores de selecao:
// nenhuma mensagem de tela pode traze-los (ACXEGDP-313).

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  consultarPedidoCompra: vi.fn(),
  config: {} as Record<string, unknown>,
  // cache de PCs vistos (0057): o carregarContextoPc o importa por import() dinamico
  registrarPcsVistosSeVencido: vi.fn(),
  lerPcsVistos: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params) }),
  getConfig: () => mocks.config,
}));

// O servico importa o cliente OMIE no carregamento do modulo (releitura ao vivo — pc-reserva.test.ts).
vi.mock('@atlas/integration-omie', () => ({
  consultarPedidoCompra: (...args: unknown[]) => mocks.consultarPedidoCompra(...args),
}));

// Cache de PCs vistos (feature 017, 0057): aqui e um dublê, para o pool mockado contar so as consultas da
// copia, do cadastro e do ledger. O SQL do proprio cache e testado em pc-visto.test.ts.
vi.mock('../services/pc-visto.service.js', () => ({
  registrarPcsVistosSeVencido: (...args: unknown[]) => mocks.registrarPcsVistosSeVencido(...args),
  lerPcsVistos: (...args: unknown[]) => mocks.lerPcsVistos(...args),
}));

import {
  montarPcDoItem,
  saldoDisponivelCopiaKg,
  pcSituacaoDaNf,
  validarEscolhaPc,
  carregarContextoPc,
  sugerirPcPorItens,
  fatorUnidadePc,
  toleranciasPc,
  exigePcHabilitado,
  PC_ESPELHO_VALOR_MAX_BRL,
  RESERVA_PC_VALIDADE_MIN,
  PcNaoEscolhidoError,
  PcNaoElegivelError,
  PcJustificativaObrigatoriaError,
  NfSemPcError,
  CopiaPcsDefasadaError,
  type ContextoPc,
  type EscolhaPc,
  type ItemParaSugestao,
  type PcCopia,
  type PcSituacaoItem,
  type ResultadoPcItem,
  type UsoPcAtlas,
  type VinculoLinhaOmie,
} from '../services/pc-sugestao.service.js';

beforeEach(() => {
  // a configuração mockada é compartilhada: cada teste começa nos padrões do serviço
  for (const k of Object.keys(mocks.config)) delete mocks.config[k];
  // cache de PCs vistos vazio por padrão (cada teste de cache declara o seu)
  mocks.registrarPcsVistosSeVencido.mockReset();
  mocks.registrarPcsVistosSeVencido.mockResolvedValue(undefined);
  mocks.lerPcsVistos.mockReset();
  mocks.lerPcsVistos.mockResolvedValue([]);
  for (const f of Object.values(mocks.logger)) f.mockClear();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FORNECEDOR = 1111;
const CHAVE_NF = '35261012345678000190550010000078131000078130';
const OUTRA_CHAVE = '35261012345678000190550010000099991000099990';
const TOL = { qtd: 0.02, preco: 0.01 };

/** 21/10/2026 18h (BRT) — instante de referencia dos testes. */
const AGORA = Date.UTC(2026, 9, 21, 21, 0, 0);
/** A copia de PCs foi sincronizada ha 5 minutos. */
const SYNC = AGORA - 5 * 60_000;

/** CNPJ (so digitos) do cadastro do fornecedor 1111. */
const CNPJ_REPLAS = '11111111000111';

const NCODPED_304 = 8516905979;
const NCODITEM_304 = 8516907022;
const NCODPED_302 = 8516905321;
const NCODITEM_302 = 8516906404;

/** Item de PC como a copia local o entrega: PC 304 da Replas (18.000 kg a R$ 11,30/kg, etapa 15). */
function pcCopia(over: Partial<PcCopia> = {}): PcCopia {
  return {
    nCodPed: NCODPED_304,
    nCodItem: NCODITEM_304,
    pcNumero: '304',
    etapa: '15',
    nCodFor: FORNECEDOR,
    produtoDescricao: 'PS CRISTAL B',
    qtdPedidaKg: 18000,
    saldoCopiaKg: 18000,
    precoKg: 11.3,
    unidade: 'KG',
    dtPrevisao: '2026-10-30',
    atualizadoEmMs: SYNC,
    pcEspelho: false,
    cnpjCadastro: CNPJ_REPLAS,
    raizCnpj: CNPJ_REPLAS.slice(0, 8),
    fonte: 'copia',
    ...over,
  };
}
const pc304 = (over: Partial<PcCopia> = {}): PcCopia => pcCopia(over);
/** PC 302 identico ao 304 (mesmo fornecedor, quantidade, preco e previsao) — o caso do empate. */
const pc302 = (over: Partial<PcCopia> = {}): PcCopia => pcCopia({ nCodPed: NCODPED_302, nCodItem: NCODITEM_302, pcNumero: '302', ...over });

const VINCULO_304: VinculoLinhaOmie = { nSequencia: 1, nIdPedido: NCODPED_304, nIdItPedido: NCODITEM_304 };
const VINCULO_302: VinculoLinhaOmie = { nSequencia: 2, nIdPedido: NCODPED_302, nIdItPedido: NCODITEM_302 };

function itemNf(over: Partial<ItemParaSugestao> = {}): ItemParaSugestao {
  return {
    indice: 0,
    descricao: 'SUCATA PLASTICO',
    quantidadeKg: 18000,
    unidadeNf: 'KG',
    fatorUnidadeNf: 1,
    precoNfKg: 11.3,
    precoItemKg: null,
    numeroPedidoNf: null,
    vinculos: [],
    sequencias: [1],
    kgPorSequencia: { 1: 18000 },
    ...over,
  };
}

const contexto = (pcs: PcCopia[], usos: UsoPcAtlas[] = [], raizPorFornecedor = new Map<number, string>()): ContextoPc => ({
  pcs,
  usos,
  agoraMs: AGORA,
  raizPorFornecedor,
});

function montar(item: ItemParaSugestao, pcs: PcCopia[], usos: UsoPcAtlas[] = [], fornecedor: number | null = FORNECEDOR): ResultadoPcItem {
  return montarPcDoItem(item, contexto(pcs, usos), fornecedor, CHAVE_NF, TOL);
}

/** Todo texto que a tela mostra para um item: nenhum pode carregar id de 10 digitos do OMIE (ACXEGDP-313). */
function textosDaTela(r: ResultadoPcItem): string[] {
  const todos = [r.pc.vinculoOmie, ...r.pc.candidatos, ...r.pc.outrosDoFornecedor, ...r.pc.aguardandoAprovacao, ...r.pc.unidadeIncompativel];
  return [r.pc.alertaVinculoOmie ?? '', r.pc.semPcMotivo ?? '', ...todos.map((c) => (c ? `${c.motivo} ${c.pcNumero}` : ''))];
}

// ═══ A. montarPcDoItem ═══════════════════════════════════════════════════════

describe('montarPcDoItem — tolerancia de quantidade (2%)', () => {
  it('18.360 kg para um saldo de 18.000 kg (exatamente 2%) entra em candidatos', () => {
    const r = montar(itemNf({ quantidadeKg: 18360 }), [pc304()]);
    expect(r.pc.candidatos.map((c) => c.nCodPed)).toEqual([NCODPED_304]);
    expect(r.pc.candidatos[0]!.dentroTolerancia).toBe(true);
    expect(r.pc.outrosDoFornecedor).toEqual([]);
    expect(r.possivel).toBe(true);
  });

  it('18.361 kg passa de 2%: vai para outrosDoFornecedor, com o motivo citando a quantidade', () => {
    const r = montar(itemNf({ quantidadeKg: 18361 }), [pc304()]);
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.outrosDoFornecedor.map((c) => c.nCodPed)).toEqual([NCODPED_304]);
    const outro = r.pc.outrosDoFornecedor[0]!;
    expect(outro.dentroTolerancia).toBe(false);
    expect(outro.motivo).toMatch(/quantidade/i);
    // há PC possível (escolha manual com justificativa), mas nada vem pré-selecionado
    expect(r.possivel).toBe(true);
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('escolha_necessaria');
  });

  it('quantidade menor que o saldo cabe (a tolerância é só para cima)', () => {
    const r = montar(itemNf({ quantidadeKg: 9000 }), [pc304()]);
    expect(r.pc.candidatos).toHaveLength(1);
    expect(r.pc.candidatos[0]!.dentroTolerancia).toBe(true);
  });
});

describe('montarPcDoItem — tolerancia de preco (1% sobre o preco do PC)', () => {
  it('NF a 11,413 (exatamente 1% acima do PC de 11,30) entra em candidatos', () => {
    const r = montar(itemNf({ precoNfKg: 11.413 }), [pc304()]);
    expect(r.pc.candidatos.map((c) => c.nCodPed)).toEqual([NCODPED_304]);
    expect(r.pc.outrosDoFornecedor).toEqual([]);
  });

  it('NF a 11,42 passa de 1%: vai para outros, com "Preço da NF …% acima do PC"', () => {
    const r = montar(itemNf({ precoNfKg: 11.42 }), [pc304()]);
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.outrosDoFornecedor).toHaveLength(1);
    expect(r.pc.outrosDoFornecedor[0]!.motivo).toMatch(/^Preço da NF \d+,\d% acima do PC$/);
    expect(r.pc.outrosDoFornecedor[0]!.dentroTolerancia).toBe(false);
  });

  it('a base do 1% é o preço do PC, não o da NF: 11,187 (1% abaixo do PC) entra; 11,186 não', () => {
    // Com a NF como base, 11,187 × 1% = 0,11187 < 0,113 e o PC sairia da tolerância.
    const dentro = montar(itemNf({ precoNfKg: 11.187 }), [pc304()]);
    expect(dentro.pc.candidatos).toHaveLength(1);

    const fora = montar(itemNf({ precoNfKg: 11.186 }), [pc304()]);
    expect(fora.pc.candidatos).toEqual([]);
    expect(fora.pc.outrosDoFornecedor[0]!.motivo).toMatch(/abaixo do PC/);
  });

  it('quantidade e preço fora ao mesmo tempo: o motivo lista os dois desvios', () => {
    const r = montar(itemNf({ quantidadeKg: 19000, precoNfKg: 12 }), [pc304()]);
    const motivo = r.pc.outrosDoFornecedor[0]!.motivo;
    expect(motivo).toMatch(/quantidade/i);
    expect(motivo).toMatch(/Preço da NF \d+,\d% acima do PC/);
  });

  it('preço da NF desconhecido (null): o PC nunca é candidato — vai para outros, "Preço não comparável"', () => {
    const r = montar(itemNf({ precoNfKg: null }), [pc304()]);
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.outrosDoFornecedor.map((c) => c.nCodPed)).toEqual([NCODPED_304]);
    expect(r.pc.outrosDoFornecedor[0]!.motivo).toBe('Preço não comparável');
    expect(r.pc.outrosDoFornecedor[0]!.dentroTolerancia).toBe(false);
    expect(r.possivel).toBe(true);
    expect(r.situacao).toBe('escolha_necessaria');
  });

  it('PC sem preço comparável (precoKg null) também nunca é candidato', () => {
    const r = montar(itemNf(), [pc304({ precoKg: null })]);
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.outrosDoFornecedor[0]!.motivo).toBe('Preço não comparável');
  });
});

describe('montarPcDoItem — quais PCs entram em cada lista', () => {
  it('PC na etapa 10 vai para aguardandoAprovacao e nunca para candidatos nem outros', () => {
    const r = montar(itemNf(), [pc304({ etapa: '10' }), pc302()]);
    expect(r.pc.aguardandoAprovacao.map((c) => c.nCodPed)).toEqual([NCODPED_304]);
    expect(r.pc.aguardandoAprovacao[0]!.motivo).toBe('Aguardando aprovação');
    expect(r.pc.candidatos.map((c) => c.nCodPed)).toEqual([NCODPED_302]);
    expect(r.pc.outrosDoFornecedor).toEqual([]);
    expect(r.pc.candidatos.some((c) => c.nCodPed === NCODPED_304)).toBe(false);
  });

  it('só PC na etapa 10: sem PC possível, motivo pc_aguardando_aprovacao e situacao aguardando_aprovacao', () => {
    const r = montar(itemNf(), [pc304({ etapa: '10' })]);
    expect(r.possivel).toBe(false);
    expect(r.motivoSemPc).toBe('pc_aguardando_aprovacao');
    expect(r.situacao).toBe('aguardando_aprovacao');
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.outrosDoFornecedor).toEqual([]);
    expect(r.pc.aguardandoAprovacao).toHaveLength(1);
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.pc.semPcMotivo).toContain('aguardando aprovação');
    expect(r.pc.semPcMotivo).toContain('PC 304');
  });

  it('vários PCs na etapa 10: o motivo lista todos, na ordem da sugestão', () => {
    const r = montar(itemNf(), [pc304({ etapa: '10' }), pc302({ etapa: '10' })]);
    expect(r.pc.aguardandoAprovacao.map((c) => c.pcNumero)).toEqual(['302', '304']);
    expect(r.pc.semPcMotivo).toMatch(/PC 302.*PC 304/);
    // PC aguardando sem saldo na cópia não aparece
    const semSaldo = montar(itemNf(), [pc304({ etapa: '10', saldoCopiaKg: 0 })]);
    expect(semSaldo.pc.aguardandoAprovacao).toEqual([]);
    expect(semSaldo.motivoSemPc).toBe('sem_pc');
  });

  it('PC-espelho (pcEspelho) nunca aparece em nenhuma lista — nem na etapa 15 nem na 10', () => {
    const espelho15 = pc304({ pcEspelho: true });
    const espelho10 = pc302({ pcEspelho: true, etapa: '10' });
    const r = montar(itemNf(), [espelho15, espelho10]);
    const todos = [...r.pc.candidatos, ...r.pc.outrosDoFornecedor, ...r.pc.aguardandoAprovacao];
    expect(todos).toEqual([]);
    expect(r.pc.vinculoOmie).toBeNull();
    expect(r.possivel).toBe(false);
    expect(r.motivoSemPc).toBe('sem_pc');
    expect(r.situacao).toBe('sem_pc');
  });

  it('PC-espelho convive com PC normal: só o normal aparece', () => {
    const r = montar(itemNf(), [pc304({ pcEspelho: true }), pc302()]);
    expect(r.pc.candidatos.map((c) => c.pcNumero)).toEqual(['302']);
  });

  it('ficam de fora: PC de outro fornecedor, etapa diferente de 10/15, PC sem saldo e unidade não comparável', () => {
    const r = montar(itemNf(), [
      pc304({ nCodFor: 2222 }), // outro fornecedor
      pc302({ etapa: '20' }), // etapa que não é 10 nem 15
      pcCopia({ nCodPed: 1, nCodItem: 11, pcNumero: '401', saldoCopiaKg: 0 }), // etapa 15 sem saldo
      pcCopia({ nCodPed: 2, nCodItem: 22, pcNumero: '402', unidade: 'UN', precoKg: null }), // unidade não comparável
    ]);
    const todos = [...r.pc.candidatos, ...r.pc.outrosDoFornecedor, ...r.pc.aguardandoAprovacao];
    expect(todos).toEqual([]);
    expect(r.possivel).toBe(false);
    expect(r.situacao).toBe('sem_pc');
  });

  it('o saldo do candidato desconta a reserva de OUTRA NF (e só ela)', () => {
    const reservaOutraNf: UsoPcAtlas = { nCodItemPed: NCODITEM_304, nfChaveAcesso: OUTRA_CHAVE, status: 'confirmado', qtdKg: 9000, emMs: AGORA - 60_000 };
    const reservaDestaNf: UsoPcAtlas = { nCodItemPed: NCODITEM_304, nfChaveAcesso: CHAVE_NF, status: 'confirmado', qtdKg: 9000, emMs: AGORA - 60_000 };

    // NF de 9.000 kg cabe no que sobrou
    const cabe = montar(itemNf({ quantidadeKg: 9000 }), [pc304()], [reservaOutraNf]);
    expect(cabe.pc.candidatos[0]!.saldoKg).toBe(9000);
    // NF de 18.000 kg não cabe mais: vai para outros
    const naoCabe = montar(itemNf({ quantidadeKg: 18000 }), [pc304()], [reservaOutraNf]);
    expect(naoCabe.pc.candidatos).toEqual([]);
    expect(naoCabe.pc.outrosDoFornecedor[0]!.saldoKg).toBe(9000);
    // a reserva da própria NF não pesa
    const propria = montar(itemNf({ quantidadeKg: 18000 }), [pc304()], [reservaDestaNf]);
    expect(propria.pc.candidatos[0]!.saldoKg).toBe(18000);
  });

  it('sem fornecedor (null) não há candidatos — só o vínculo do OMIE poderia valer', () => {
    const r = montar(itemNf(), [pc304()], [], null);
    expect(r.pc.candidatos).toEqual([]);
    expect(r.motivoSemPc).toBe('sem_pc');
    expect(r.situacao).toBe('sem_pc');
  });
});

describe('montarPcDoItem — ordenação e pré-seleção (research D3)', () => {
  it('empate 302/304: os dois em candidatos, sem pré-seleção e escolha_necessaria', () => {
    const r = montar(itemNf(), [pc304(), pc302()]);
    expect(r.pc.candidatos).toHaveLength(2);
    // empate total: desempata pelo nCodPed (302 antes do 304)
    expect(r.pc.candidatos.map((c) => c.pcNumero)).toEqual(['302', '304']);
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('escolha_necessaria');
    expect(r.possivel).toBe(true);
    expect(r.motivoSemPc).toBeNull();
    expect(r.pc.semPcMotivo).toBeNull();
  });

  it('número do pedido na NF (304): o 304 vem primeiro, casa o número, é pré-selecionado e a situação é sugerido', () => {
    const r = montar(itemNf({ numeroPedidoNf: '304' }), [pc302(), pc304()]);
    expect(r.pc.candidatos.map((c) => c.pcNumero)).toEqual(['304', '302']);
    expect(r.pc.candidatos[0]!.casaNumeroPedidoNf).toBe(true);
    expect(r.pc.candidatos[0]!.motivo).toBe('Número do pedido na NF');
    expect(r.pc.candidatos[1]!.casaNumeroPedidoNf).toBe(false);
    expect(r.pc.candidatos[1]!.motivo).toBe('Quantidade e preço compatíveis');
    expect(r.pc.preSelecionado).toEqual({ nCodPed: NCODPED_304, nCodItem: NCODITEM_304 });
    expect(r.situacao).toBe('sugerido');
  });

  it('o número do pedido casa ignorando zeros à esquerda ("0304" = "304"), mas não por prefixo ("30")', () => {
    const comZeros = montar(itemNf({ numeroPedidoNf: '0304' }), [pc302(), pc304()]);
    expect(comZeros.pc.candidatos[0]!.pcNumero).toBe('304');
    expect(comZeros.pc.candidatos[0]!.casaNumeroPedidoNf).toBe(true);

    const prefixo = montar(itemNf({ numeroPedidoNf: '30' }), [pc302(), pc304()]);
    expect(prefixo.pc.candidatos.some((c) => c.casaNumeroPedidoNf)).toBe(false);
    expect(prefixo.pc.preSelecionado).toBeNull();
  });

  it('dois itens do mesmo PC casando o número do pedido na NF: ambíguo, sem pré-seleção (desempata por nCodItem)', () => {
    const r = montar(itemNf({ numeroPedidoNf: '304' }), [pc304(), pc304({ nCodItem: NCODITEM_304 + 1 })]);
    expect(r.pc.candidatos.map((c) => c.nCodItem)).toEqual([NCODITEM_304, NCODITEM_304 + 1]);
    expect(r.pc.candidatos.every((c) => c.casaNumeroPedidoNf)).toBe(true);
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('escolha_necessaria');
  });

  it('número do pedido que não casa com nenhum PC não pré-seleciona nada', () => {
    const r = montar(itemNf({ numeroPedidoNf: '999' }), [pc302(), pc304()]);
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('escolha_necessaria');
  });

  it('candidato único sem número do pedido: aparece, sem pré-seleção, situacao sugerido', () => {
    const r = montar(itemNf(), [pc304()]);
    expect(r.pc.candidatos.map((c) => c.pcNumero)).toEqual(['304']);
    expect(r.pc.candidatos[0]!.casaNumeroPedidoNf).toBe(false);
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('sugerido');
    expect(r.possivel).toBe(true);
  });

  it('o número do pedido na NF ordena também a lista de "outros do fornecedor"', () => {
    const r = montar(itemNf({ quantidadeKg: 30000, numeroPedidoNf: '304' }), [pc302(), pc304()]);
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.outrosDoFornecedor.map((c) => c.pcNumero)).toEqual(['304', '302']);
    // fora da tolerância nunca é pré-selecionado, mesmo casando o número
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('escolha_necessaria');
  });

  it('sem número que decida, vem antes o PC com menor diferença de preço', () => {
    // 302 a R$ 11,35 (0,4% acima), 304 a R$ 11,30 (igual à NF): o 304 vem primeiro apesar do nCodPed maior.
    const r = montar(itemNf(), [pc302({ precoKg: 11.35 }), pc304()]);
    expect(r.pc.candidatos.map((c) => c.pcNumero)).toEqual(['304', '302']);
  });

  it('preço empatado: vem antes a previsão de entrega mais antiga (sem previsão por último)', () => {
    const antes = montar(itemNf(), [pc302({ dtPrevisao: '2026-10-30' }), pc304({ dtPrevisao: '2026-10-20' })]);
    expect(antes.pc.candidatos.map((c) => c.pcNumero)).toEqual(['304', '302']);

    const semData = montar(itemNf(), [pc302({ dtPrevisao: null }), pc304({ dtPrevisao: '2026-10-30' })]);
    expect(semData.pc.candidatos.map((c) => c.pcNumero)).toEqual(['304', '302']);
  });
});

describe('montarPcDoItem — vínculo do OMIE (FR-000)', () => {
  it('vínculo válido (dentro da tolerância): preenchido, elegível, pré-selecionado, vinculado_omie e o 304 fora de candidatos', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304], numeroPedidoNf: '304' }), [pc304(), pc302()]);
    expect(r.pc.vinculoOmie).toMatchObject({
      nCodPed: NCODPED_304,
      nCodItem: NCODITEM_304,
      pcNumero: '304',
      etapa: '15',
      dentroTolerancia: true,
      casaNumeroPedidoNf: true,
      semDadosLocais: false,
      motivo: 'Vínculo do OMIE',
    });
    expect(r.pc.vinculoOmieElegivel).toBe(true);
    expect(r.pc.alertaVinculoOmie).toBeNull();
    expect(r.pc.vinculosDivergentes).toBe(false);
    expect(r.pc.candidatos.every((c) => c.semDadosLocais === false)).toBe(true);
    expect(r.pc.preSelecionado).toEqual({ nCodPed: NCODPED_304, nCodItem: NCODITEM_304 });
    expect(r.situacao).toBe('vinculado_omie');
    expect(r.possivel).toBe(true);
    // o PC do vínculo não se repete em nenhuma lista; o 302 segue como alternativa
    const listas = [...r.pc.candidatos, ...r.pc.outrosDoFornecedor, ...r.pc.aguardandoAprovacao];
    expect(listas.some((c) => c.nCodPed === NCODPED_304)).toBe(false);
    expect(r.pc.candidatos.map((c) => c.pcNumero)).toEqual(['302']);
  });

  it('duas sequências vinculadas ao MESMO item de PC não são divergência', () => {
    const r = montar(
      itemNf({ vinculos: [VINCULO_304, { ...VINCULO_304, nSequencia: 2 }], sequencias: [1, 2], kgPorSequencia: { 1: 9000, 2: 9000 } }),
      [pc304()],
    );
    expect(r.pc.vinculoOmie?.pcNumero).toBe('304');
    expect(r.pc.alertaVinculoOmie).toBeNull();
    expect(r.situacao).toBe('vinculado_omie');
  });

  it('vínculo sem item de PC (nIdItPedido nulo) casa pelo pedido', () => {
    const r = montar(itemNf({ vinculos: [{ nSequencia: 1, nIdPedido: NCODPED_304, nIdItPedido: null }] }), [pc304()]);
    expect(r.pc.vinculoOmie).toMatchObject({ nCodPed: NCODPED_304, nCodItem: NCODITEM_304 });
    expect(r.pc.vinculoOmieElegivel).toBe(true);
  });

  it('vínculo cujo PC não tem saldo na cópia: alerta, fora da tolerância, sem pré-seleção, possível e escolha_necessaria', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304] }), [pc304({ saldoCopiaKg: 0 })]);
    expect(r.pc.vinculoOmie).not.toBeNull();
    expect(r.pc.vinculoOmie!.dentroTolerancia).toBe(false);
    expect(r.pc.vinculoOmie!.saldoKg).toBe(0);
    expect(r.pc.vinculoOmieElegivel).toBe(true);
    expect(r.pc.alertaVinculoOmie).not.toBeNull();
    expect(r.pc.alertaVinculoOmie).toContain('fora da tolerância');
    expect(r.pc.alertaVinculoOmie).toContain('justificativa');
    expect(r.pc.alertaVinculoOmie).toMatch(/sem saldo/i);
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.possivel).toBe(true);
    expect(r.situacao).toBe('escolha_necessaria');
    expect(r.motivoSemPc).toBeNull();
  });

  // Regressão: minusculaInicial() baixava a 1ª letra de TODO desvio, e o alerta do vínculo sem saldo saía como
  // "PC 304 fora da tolerância: pC sem saldo." (o desvio de saldo zero começa por uma sigla). Corrigido no serviço
  // durante a escrita desta suíte; o teste fica para impedir a volta.
  it('o alerta de vínculo sem saldo preserva a sigla: "…: PC sem saldo", nunca "pC sem saldo"', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304] }), [pc304({ saldoCopiaKg: 0 })]);
    expect(r.pc.alertaVinculoOmie).not.toContain('pC sem saldo');
    expect(r.pc.alertaVinculoOmie).toContain('PC sem saldo');
  });

  it('vínculo cujo preço está fora da tolerância: alerta cita o preço e não pré-seleciona', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304], precoNfKg: 12 }), [pc304()]);
    expect(r.pc.vinculoOmie!.dentroTolerancia).toBe(false);
    expect(r.pc.alertaVinculoOmie).toMatch(/preço da NF \d+,\d% acima do PC/);
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('escolha_necessaria');
  });

  it('vínculo para PC na etapa 10 da cópia: alerta de aprovação, elegível, sem pré-seleção', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304] }), [pc304({ etapa: '10' })]);
    expect(r.pc.vinculoOmieElegivel).toBe(true);
    expect(r.pc.alertaVinculoOmie).toContain('aguardando aprovação');
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('escolha_necessaria');
  });

  it('vínculo para PC em outra etapa (20) da cópia: alerta de "não consta como aprovado"', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304] }), [pc304({ etapa: '20' })]);
    expect(r.pc.alertaVinculoOmie).toMatch(/aprovad/);
    expect(r.pc.alertaVinculoOmie).not.toContain('aguardando'); // não é o caso da etapa 10
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('escolha_necessaria');
  });

  it('sequências com vínculos divergentes (seq 1 → 304, seq 2 → 302): sem vinculoOmie, alerta de divergência e escolha_necessaria', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304, VINCULO_302], sequencias: [1, 2], kgPorSequencia: { 1: 9000, 2: 9000 } }), [pc304(), pc302()]);
    expect(r.pc.vinculoOmie).toBeNull();
    expect(r.pc.vinculoOmieElegivel).toBe(false);
    expect(r.pc.alertaVinculoOmie).toMatch(/diferentes/);
    // a tela trata qualquer escolha como troca do vínculo (justificativa) — data-model §8
    expect(r.pc.vinculosDivergentes).toBe(true);
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('escolha_necessaria');
    // os dois PCs seguem oferecidos para o operador escolher um só
    expect(r.pc.candidatos.map((c) => c.pcNumero).sort()).toEqual(['302', '304']);
    expect(r.possivel).toBe(true);
  });

  it('com vínculos divergentes nem o número do pedido na NF pré-seleciona', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304, VINCULO_302], sequencias: [1, 2], numeroPedidoNf: '304' }), [pc304()]);
    expect(r.pc.candidatos.map((c) => c.pcNumero)).toEqual(['304']);
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('escolha_necessaria');
  });

  it('vínculo para PC-espelho sem outro PC: inelegível e motivoSemPc vinculo_invalido', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304] }), [pc304({ pcEspelho: true })]);
    expect(r.pc.vinculoOmie).not.toBeNull();
    expect(r.pc.vinculoOmieElegivel).toBe(false);
    expect(r.pc.alertaVinculoOmie).toMatch(/espelho/);
    expect(r.possivel).toBe(false);
    expect(r.motivoSemPc).toBe('vinculo_invalido');
    expect(r.pc.semPcMotivo).toContain('não pode ser usado');
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('sem_pc');
  });

  it('vínculo para PC-espelho tem prioridade sobre PC aguardando aprovação no motivo', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304] }), [pc304({ pcEspelho: true }), pc302({ etapa: '10' })]);
    expect(r.motivoSemPc).toBe('vinculo_invalido');
    expect(r.situacao).toBe('sem_pc');
  });

  it('vínculo para PC-espelho com outro PC do fornecedor: há PC possível, mas nada pré-selecionado', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304] }), [pc304({ pcEspelho: true }), pc302()]);
    expect(r.pc.vinculoOmieElegivel).toBe(false);
    expect(r.possivel).toBe(true);
    expect(r.motivoSemPc).toBeNull();
    expect(r.pc.candidatos.map((c) => c.pcNumero)).toEqual(['302']);
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('escolha_necessaria');
  });

  it('vínculo para PC fora da cópia: alerta "não está na lista local", elegível e fora da tolerância', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304], numeroPedidoNf: '304' }), []);
    expect(r.pc.alertaVinculoOmie).toContain('não está na lista local');
    expect(r.pc.vinculoOmieElegivel).toBe(true);
    expect(r.pc.vinculoOmie).toMatchObject({
      nCodPed: NCODPED_304,
      nCodItem: NCODITEM_304,
      // sem a cópia não há número confiável: o número do pedido na NF (xPed) é do fornecedor,
      // não do vínculo — por isso não vira o número do PC, mesmo coincidindo aqui
      pcNumero: '',
      casaNumeroPedidoNf: false,
      etapa: '',
      saldoKg: 0,
      dentroTolerancia: false,
      // produto, saldo e preço desconhecidos: a tela mostra "Não comparado"
      semDadosLocais: true,
    });
    expect(r.pc.vinculosDivergentes).toBe(false);
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.possivel).toBe(true);
    expect(r.situacao).toBe('escolha_necessaria');
  });

  it('vínculo para PC fora da cópia e sem item de PC (nIdItPedido nulo) não é elegível', () => {
    const r = montar(itemNf({ vinculos: [{ nSequencia: 1, nIdPedido: NCODPED_304, nIdItPedido: null }] }), []);
    expect(r.pc.vinculoOmieElegivel).toBe(false);
    expect(r.possivel).toBe(false);
    expect(r.motivoSemPc).toBe('vinculo_invalido');
  });
});

describe('montarPcDoItem — sem PC possível', () => {
  it('fornecedor sem PC: semPcMotivo preenchido, motivoSemPc sem_pc, possivel false e situacao sem_pc', () => {
    const r = montar(itemNf(), [pc304({ nCodFor: 2222 })]);
    expect(r.possivel).toBe(false);
    expect(r.motivoSemPc).toBe('sem_pc');
    expect(r.situacao).toBe('sem_pc');
    expect(r.pc.semPcMotivo).toMatch(/não tem pedido de compra aprovado/);
    expect(r.pc.vinculoOmie).toBeNull();
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.outrosDoFornecedor).toEqual([]);
    expect(r.pc.aguardandoAprovacao).toEqual([]);
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.pc.vinculadoNoOmie).toBeNull();
  });

  it('cópia vazia: sem_pc', () => {
    const r = montar(itemNf(), []);
    expect(r.motivoSemPc).toBe('sem_pc');
    expect(r.situacao).toBe('sem_pc');
  });

  it('quantidadeKg null (unidade não conversível): motivoSemPc unidade e nenhuma lista, mesmo com PC disponível', () => {
    const r = montar(itemNf({ quantidadeKg: null, precoNfKg: null }), [pc304()]);
    expect(r.possivel).toBe(false);
    expect(r.motivoSemPc).toBe('unidade');
    expect(r.situacao).toBe('sem_pc');
    expect(r.pc.semPcMotivo).toContain('unidade');
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.outrosDoFornecedor).toEqual([]);
    expect(r.pc.vinculoOmie).toBeNull();
  });
});

describe('montarPcDoItem — nenhum texto da tela leva id do OMIE (ACXEGDP-313)', () => {
  it('alertas, motivos e semPcMotivo não têm sequência de 10 dígitos', () => {
    const cenarios: ResultadoPcItem[] = [
      montar(itemNf({ vinculos: [VINCULO_304], numeroPedidoNf: '304' }), []),
      montar(itemNf({ vinculos: [VINCULO_304] }), [pc304({ saldoCopiaKg: 0 })]),
      montar(itemNf({ vinculos: [VINCULO_304] }), [pc304({ etapa: '10' })]),
      montar(itemNf({ vinculos: [VINCULO_304] }), [pc304({ pcEspelho: true })]),
      montar(itemNf({ vinculos: [VINCULO_304, VINCULO_302], sequencias: [1, 2] }), [pc304(), pc302()]),
      montar(itemNf({ quantidadeKg: 30000, precoNfKg: 12 }), [pc304(), pc302()]),
      montar(itemNf(), [pc304({ etapa: '10' })]),
      montar(itemNf(), []),
      montar(itemNf({ quantidadeKg: null }), [pc304()]),
    ];
    for (const r of cenarios) for (const t of textosDaTela(r)) expect(t).not.toMatch(/\d{10}/);
  });
});

// ═══ B. saldoDisponivelCopiaKg ═══════════════════════════════════════════════

describe('saldoDisponivelCopiaKg (research D3/D4)', () => {
  const pc = pc304({ saldoCopiaKg: 18000, atualizadoEmMs: SYNC });
  const uso = (over: Partial<UsoPcAtlas>): UsoPcAtlas => ({
    nCodItemPed: NCODITEM_304,
    nfChaveAcesso: OUTRA_CHAVE,
    status: 'concluido',
    qtdKg: 9000,
    emMs: SYNC + 1000,
    ...over,
  });

  it('sem usos do Atlas é o saldo da própria cópia', () => {
    expect(saldoDisponivelCopiaKg(pc, contexto([pc]), CHAVE_NF)).toBe(18000);
  });

  it('vínculo concluído DEPOIS do sync da linha desconta (a cópia ainda não o viu)', () => {
    expect(saldoDisponivelCopiaKg(pc, contexto([pc], [uso({ status: 'concluido', emMs: SYNC + 1 })]), CHAVE_NF)).toBe(9000);
  });

  it('vínculo concluído ANTES do sync não desconta (a cópia já o contou em nqtderec)', () => {
    expect(saldoDisponivelCopiaKg(pc, contexto([pc], [uso({ status: 'concluido', emMs: SYNC - 1 })]), CHAVE_NF)).toBe(18000);
  });

  it('vínculo concluído no mesmo instante do sync não desconta (só vale o que veio "depois de")', () => {
    expect(saldoDisponivelCopiaKg(pc, contexto([pc], [uso({ status: 'concluido', emMs: SYNC })]), CHAVE_NF)).toBe(18000);
  });

  it('concluído de NF diferente ou da mesma NF desconta do mesmo jeito (o ledger concluído já foi ao OMIE)', () => {
    expect(saldoDisponivelCopiaKg(pc, contexto([pc], [uso({ nfChaveAcesso: CHAVE_NF })]), CHAVE_NF)).toBe(9000);
  });

  it.each(['confirmado', 'associado'] as const)('reserva (%s) de OUTRA NF desconta', (status) => {
    expect(saldoDisponivelCopiaKg(pc, contexto([pc], [uso({ status, emMs: AGORA - 60_000 })]), CHAVE_NF)).toBe(9000);
  });

  it.each(['confirmado', 'associado'] as const)('reserva (%s) da MESMA NF não desconta', (status) => {
    expect(saldoDisponivelCopiaKg(pc, contexto([pc], [uso({ status, nfChaveAcesso: CHAVE_NF, emMs: AGORA - 60_000 })]), CHAVE_NF)).toBe(18000);
  });

  it('uso de outro item de PC não desconta', () => {
    expect(saldoDisponivelCopiaKg(pc, contexto([pc], [uso({ nCodItemPed: NCODITEM_302, status: 'confirmado' })]), CHAVE_NF)).toBe(18000);
  });

  it('os usos somam: concluído 6.000 + reserva 4.000 = 10.000 kg a menos', () => {
    const usos = [uso({ status: 'concluido', qtdKg: 6000 }), uso({ status: 'confirmado', qtdKg: 4000, emMs: AGORA - 1000 })];
    expect(saldoDisponivelCopiaKg(pc, contexto([pc], usos), CHAVE_NF)).toBe(8000);
  });

  it('nunca fica negativo', () => {
    expect(saldoDisponivelCopiaKg(pc, contexto([pc], [uso({ qtdKg: 50000 })]), CHAVE_NF)).toBe(0);
  });

  it('a defasagem é por linha: a mesma data de uso desconta numa linha antiga e não numa recém-sincronizada', () => {
    const antiga = pc304({ atualizadoEmMs: SYNC - 3_600_000 });
    const nova = pc304({ atualizadoEmMs: SYNC + 3_600_000 });
    const u = uso({ emMs: SYNC });
    expect(saldoDisponivelCopiaKg(antiga, contexto([antiga], [u]), CHAVE_NF)).toBe(9000);
    expect(saldoDisponivelCopiaKg(nova, contexto([nova], [u]), CHAVE_NF)).toBe(18000);
  });
});

// ═══ C. pcSituacaoDaNf ═══════════════════════════════════════════════════════

describe('pcSituacaoDaNf — pior caso entre os itens (data-model §8)', () => {
  const ORDEM: PcSituacaoItem[] = ['sem_pc', 'aguardando_aprovacao', 'escolha_necessaria', 'sugerido', 'vinculado_omie'];

  it('lista vazia: nao_aplicavel', () => {
    expect(pcSituacaoDaNf([])).toBe('nao_aplicavel');
  });

  it.each(ORDEM)('um item só (%s) devolve ele mesmo', (s) => {
    expect(pcSituacaoDaNf([s])).toBe(s);
    expect(pcSituacaoDaNf([s, s, s])).toBe(s);
  });

  it('a ordem de gravidade é sem_pc > aguardando_aprovacao > escolha_necessaria > sugerido > vinculado_omie', () => {
    for (let i = 0; i < ORDEM.length; i++) {
      for (let j = i + 1; j < ORDEM.length; j++) {
        // o mais grave (i) vence, qualquer que seja a ordem em que os itens chegam
        expect(pcSituacaoDaNf([ORDEM[i]!, ORDEM[j]!])).toBe(ORDEM[i]);
        expect(pcSituacaoDaNf([ORDEM[j]!, ORDEM[i]!])).toBe(ORDEM[i]);
      }
    }
  });

  it('com vários itens, um único sem_pc basta para a NF inteira ser sem_pc', () => {
    expect(pcSituacaoDaNf(['vinculado_omie', 'sugerido', 'vinculado_omie', 'sem_pc', 'escolha_necessaria'])).toBe('sem_pc');
    expect(pcSituacaoDaNf(['vinculado_omie', 'sugerido', 'vinculado_omie'])).toBe('sugerido');
  });
});

// ═══ D. validarEscolhaPc (portao 1) ══════════════════════════════════════════

/** Monta o detalhe com montarPcDoItem e valida a escolha contra ele — o que o portao 1 faz. */
function escolher(item: ItemParaSugestao, pcs: PcCopia[], escolha: EscolhaPc | null | undefined, usos: UsoPcAtlas[] = []) {
  return validarEscolhaPc({
    notaFiscal: '7813',
    fornecedorNome: 'REPLAS INDUSTRIA DE PLASTICOS LTDA',
    itemDescricao: item.descricao,
    indice: item.indice,
    sequencias: item.sequencias,
    vinculos: item.vinculos,
    resultado: montar(item, pcs, usos),
    escolha,
    quantidadeKg: item.quantidadeKg ?? 0,
    precoNfKg: item.precoNfKg,
    kgPorSequencia: item.kgPorSequencia,
    unidadeNf: item.unidadeNf,
    fatorUnidadeNf: item.fatorUnidadeNf,
  });
}

const escolhaDo304 = (extra: Partial<EscolhaPc> = {}): EscolhaPc => ({ n_cod_ped: NCODPED_304, n_cod_item: NCODITEM_304, ...extra });
const escolhaDo302 = (extra: Partial<EscolhaPc> = {}): EscolhaPc => ({ n_cod_ped: NCODPED_302, n_cod_item: NCODITEM_302, ...extra });

function erroDe(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('a função deveria ter lançado');
}

describe('validarEscolhaPc — escolha ausente', () => {
  it('sem escolha e com PC possível: PcNaoEscolhidoError (nos dois formatos de "ausente")', () => {
    for (const ausente of [null, undefined]) {
      const err = erroDe(() => escolher(itemNf(), [pc304()], ausente));
      expect(err).toBeInstanceOf(PcNaoEscolhidoError);
      expect(err.message).toContain('7813');
      expect(err.message).toContain('SUCATA PLASTICO');
    }
  });

  it('sem escolha e sem PC possível: devolve null (a regra de NF sem PC é do chamador)', () => {
    expect(escolher(itemNf(), [], null)).toBeNull();
    expect(escolher(itemNf(), [pc304({ etapa: '10' })], undefined)).toBeNull();
    expect(escolher(itemNf({ quantidadeKg: null }), [pc304()], null)).toBeNull();
  });

  it('sem escolha, com vínculo do OMIE elegível: também exige escolha', () => {
    const err = erroDe(() => escolher(itemNf({ vinculos: [VINCULO_304] }), [pc304()], null));
    expect(err).toBeInstanceOf(PcNaoEscolhidoError);
  });
});

describe('validarEscolhaPc — PC que não pode ser escolhido', () => {
  it('PC aguardando aprovação: PcNaoElegivelError "aguardando aprovação" citando o PC', () => {
    const err = erroDe(() => escolher(itemNf(), [pc304({ etapa: '10' }), pc302()], escolhaDo304()));
    expect(err).toBeInstanceOf(PcNaoElegivelError);
    expect(err.message).toContain('aguardando aprovação');
    expect(err.message).toContain('PC 304');
    expect(err.message).toContain('7813');
  });

  it('PC desconhecido (fora das listas): PcNaoElegivelError sem citar número de PC', () => {
    const err = erroDe(() => escolher(itemNf(), [pc304()], { n_cod_ped: 999, n_cod_item: 998 }));
    expect(err).toBeInstanceOf(PcNaoElegivelError);
    expect(err.message).toContain('O pedido de compra escolhido');
    expect(err.message).toMatch(/não é um pedido aprovado/);
  });

  it('PC de outro fornecedor, PC-espelho e PC sem saldo também são recusados', () => {
    expect(erroDe(() => escolher(itemNf(), [pc304(), pc302({ nCodFor: 2222 })], escolhaDo302()))).toBeInstanceOf(PcNaoElegivelError);
    expect(erroDe(() => escolher(itemNf(), [pc304(), pc302({ pcEspelho: true })], escolhaDo302()))).toBeInstanceOf(PcNaoElegivelError);
    expect(erroDe(() => escolher(itemNf(), [pc304(), pc302({ saldoCopiaKg: 0 })], escolhaDo302()))).toBeInstanceOf(PcNaoElegivelError);
  });

  it('vínculo do OMIE inelegível (PC-espelho) escolhido: PcNaoElegivelError', () => {
    const err = erroDe(() => escolher(itemNf({ vinculos: [VINCULO_304] }), [pc304({ pcEspelho: true }), pc302()], escolhaDo304()));
    expect(err).toBeInstanceOf(PcNaoElegivelError);
    expect(err.message).toMatch(/vinculado no OMIE não pode ser usado/);
  });

  it('só o par (n_cod_ped, n_cod_item) conta: pedido certo com item errado é recusado', () => {
    const err = erroDe(() => escolher(itemNf(), [pc304()], { n_cod_ped: NCODPED_304, n_cod_item: NCODITEM_302 }));
    expect(err).toBeInstanceOf(PcNaoElegivelError);
  });
});

describe('validarEscolhaPc — escolha válida e justificativa (matriz do data-model §4)', () => {
  it('candidato dentro da tolerância sem justificativa: ok, origem sugestao, dentroTolerancia true', () => {
    const v = escolher(itemNf(), [pc304(), pc302()], escolhaDo304())!;
    expect(v.origem).toBe('sugestao');
    expect(v.dentroTolerancia).toBe(true);
    expect(v.justificativa).toBeNull();
    expect(v.nCodPedOmieAnterior).toBeNull();
    expect(v.nCodItemPedOmieAnterior).toBeNull();
    expect(v.candidato).toMatchObject({ nCodPed: NCODPED_304, nCodItem: NCODITEM_304, pcNumero: '304' });
  });

  it('devolve o item pronto para gravar: identificação, quantidade, preço e kg por sequência', () => {
    const item = itemNf({ indice: 3, sequencias: [4, 5], kgPorSequencia: { 4: 12000, 5: 6000 } });
    const v = escolher(item, [pc304()], escolhaDo304({ n_cod_item_omie_visto: NCODITEM_304 }))!;
    expect(v).toMatchObject({
      indice: 3,
      sequencias: [4, 5],
      qtdNfKg: 18000,
      precoNfKg: 11.3,
      kgPorSequencia: { 4: 12000, 5: 6000 },
      itemDescricao: 'SUCATA PLASTICO',
      nCodItemOmieVisto: NCODITEM_304,
    });
  });

  it('sem n_cod_item_omie_visto o vínculo visto pela tela é null', () => {
    expect(escolher(itemNf(), [pc304()], escolhaDo304())!.nCodItemOmieVisto).toBeNull();
    expect(escolher(itemNf(), [pc304()], escolhaDo304({ n_cod_item_omie_visto: null }))!.nCodItemOmieVisto).toBeNull();
  });

  it('o retrato "oferecidos" tem vínculo do OMIE, candidatos e outros — e nunca os aguardando aprovação', () => {
    const v = escolher(
      itemNf({ vinculos: [VINCULO_304] }),
      [pc304(), pc302(), pcCopia({ nCodPed: 3, nCodItem: 33, pcNumero: '305', saldoCopiaKg: 5000 }), pcCopia({ nCodPed: 4, nCodItem: 44, pcNumero: '306', etapa: '10' })],
      escolhaDo304(),
    )!;
    expect(v.oferecidos.map((o) => o.pcNumero)).toEqual(['304', '302', '305']);
    expect(v.oferecidos[0]).toMatchObject({ nCodPed: NCODPED_304, nCodItem: NCODITEM_304, motivo: 'Vínculo do OMIE', dentroTolerancia: true });
    expect(v.oferecidos[0]).toHaveProperty('saldoKg');
    expect(v.oferecidos[0]).toHaveProperty('precoUnit');
  });

  it('outro do fornecedor (fora da tolerância) sem justificativa: PcJustificativaObrigatoriaError', () => {
    const err = erroDe(() => escolher(itemNf({ quantidadeKg: 19000 }), [pc304()], escolhaDo304()));
    expect(err).toBeInstanceOf(PcJustificativaObrigatoriaError);
    expect(err.message).toContain('PC 304');
    expect(err.message).toContain('7813');
    expect(err.message).toMatch(/quantidade \d+,\d% acima do saldo/);
  });

  it('outro do fornecedor com justificativa: ok, origem manual e dentroTolerancia false', () => {
    const v = escolher(itemNf({ quantidadeKg: 19000 }), [pc304()], escolhaDo304({ justificativa: '  Comprador autorizou o excedente  ' }))!;
    expect(v.origem).toBe('manual');
    expect(v.dentroTolerancia).toBe(false);
    expect(v.justificativa).toBe('Comprador autorizou o excedente');
    expect(v.nCodPedOmieAnterior).toBeNull();
  });

  it('preço da NF desconhecido: o PC só pode ser escolhido como manual, com justificativa', () => {
    const item = itemNf({ precoNfKg: null });
    expect(erroDe(() => escolher(item, [pc304()], escolhaDo304()))).toBeInstanceOf(PcJustificativaObrigatoriaError);
    const v = escolher(item, [pc304()], escolhaDo304({ justificativa: 'Preço conferido com compras' }))!;
    expect(v.origem).toBe('manual');
    expect(v.precoNfKg).toBe(0);
  });

  it('vínculo do OMIE fora da tolerância sem justificativa: PcJustificativaObrigatoriaError', () => {
    const err = erroDe(() => escolher(itemNf({ vinculos: [VINCULO_304], quantidadeKg: 19000 }), [pc304()], escolhaDo304()));
    expect(err).toBeInstanceOf(PcJustificativaObrigatoriaError);
    expect(err.message).toMatch(/fora da tolerância/);
  });

  it('vínculo do OMIE fora da tolerância com justificativa: ok, origem omie', () => {
    const v = escolher(itemNf({ vinculos: [VINCULO_304], quantidadeKg: 19000 }), [pc304()], escolhaDo304({ justificativa: 'Excedente combinado' }))!;
    expect(v.origem).toBe('omie');
    expect(v.dentroTolerancia).toBe(false);
    expect(v.justificativa).toBe('Excedente combinado');
    expect(v.nCodPedOmieAnterior).toBeNull(); // manter o vínculo não é troca
  });

  it('vínculo do OMIE dentro da tolerância mantido: ok sem justificativa, origem omie', () => {
    const v = escolher(itemNf({ vinculos: [VINCULO_304] }), [pc304(), pc302()], escolhaDo304())!;
    expect(v.origem).toBe('omie');
    expect(v.dentroTolerancia).toBe(true);
    expect(v.justificativa).toBeNull();
    expect(v.nCodPedOmieAnterior).toBeNull();
    expect(v.nCodItemPedOmieAnterior).toBeNull();
  });

  it('vínculo fora da cópia mantido: exige justificativa (não dá para afirmar a tolerância) e vira origem omie', () => {
    const item = itemNf({ vinculos: [VINCULO_304], numeroPedidoNf: '304' });
    expect(erroDe(() => escolher(item, [], escolhaDo304()))).toBeInstanceOf(PcJustificativaObrigatoriaError);
    const v = escolher(item, [], escolhaDo304({ justificativa: 'PC recebido por inteiro no OMIE' }))!;
    expect(v.origem).toBe('omie');
    expect(v.dentroTolerancia).toBe(false);
  });

  it('troca do vínculo do OMIE por um candidato: exige justificativa e preenche o vínculo anterior', () => {
    const item = itemNf({ vinculos: [VINCULO_304] });
    const err = erroDe(() => escolher(item, [pc304(), pc302()], escolhaDo302()));
    expect(err).toBeInstanceOf(PcJustificativaObrigatoriaError);
    expect(err.message).toMatch(/troca/);
    expect(err.message).toContain('PC 302');

    const v = escolher(item, [pc304(), pc302()], escolhaDo302({ justificativa: 'Compras pediu o 302' }))!;
    expect(v.origem).toBe('sugestao');
    expect(v.dentroTolerancia).toBe(true); // o candidato está na tolerância; a justificativa vem da troca
    expect(v.candidato.pcNumero).toBe('302');
    expect(v.nCodPedOmieAnterior).toBe(NCODPED_304);
    expect(v.nCodItemPedOmieAnterior).toBe(NCODITEM_304);
    expect(v.justificativa).toBe('Compras pediu o 302');
  });

  it('troca por "outro do fornecedor" também registra o vínculo anterior', () => {
    const v = escolher(
      itemNf({ vinculos: [VINCULO_304], quantidadeKg: 19000 }),
      [pc304(), pc302()],
      escolhaDo302({ justificativa: 'Preferência de compras' }),
    )!;
    expect(v.origem).toBe('manual');
    expect(v.nCodPedOmieAnterior).toBe(NCODPED_304);
    expect(v.nCodItemPedOmieAnterior).toBe(NCODITEM_304);
  });

  it('justificativa só de espaços conta como ausente quando é obrigatória', () => {
    const err = erroDe(() => escolher(itemNf({ quantidadeKg: 19000 }), [pc304()], escolhaDo304({ justificativa: '    \t  ' })));
    expect(err).toBeInstanceOf(PcJustificativaObrigatoriaError);
  });

  it('justificativa só de espaços quando não é obrigatória: vira null', () => {
    const v = escolher(itemNf(), [pc304(), pc302()], escolhaDo304({ justificativa: '   ' }))!;
    expect(v.justificativa).toBeNull();
  });

  it('justificativa longa é cortada em 500 caracteres', () => {
    const v = escolher(itemNf({ quantidadeKg: 19000 }), [pc304()], escolhaDo304({ justificativa: 'x'.repeat(800) }))!;
    expect(v.justificativa).toHaveLength(500);
  });

  it('justificativa dada sem necessidade é guardada (aparada)', () => {
    const v = escolher(itemNf(), [pc304(), pc302()], escolhaDo304({ justificativa: ' ok ' }))!;
    expect(v.justificativa).toBe('ok');
  });
});

describe('validarEscolhaPc — mensagens sem id do OMIE (ACXEGDP-313)', () => {
  it('nenhuma mensagem de erro leva sequência de 10 dígitos e todas citam a NF e o item', () => {
    const erros: Error[] = [
      erroDe(() => escolher(itemNf(), [pc304()], null)),
      erroDe(() => escolher(itemNf(), [pc304({ etapa: '10' }), pc302()], escolhaDo304())),
      erroDe(() => escolher(itemNf(), [pc304()], { n_cod_ped: 8516905999, n_cod_item: 8516907999 })),
      erroDe(() => escolher(itemNf({ quantidadeKg: 19000 }), [pc304()], escolhaDo304())),
      erroDe(() => escolher(itemNf({ vinculos: [VINCULO_304], quantidadeKg: 19000 }), [pc304()], escolhaDo304())),
      erroDe(() => escolher(itemNf({ vinculos: [VINCULO_304] }), [pc304(), pc302()], escolhaDo302())),
      erroDe(() => escolher(itemNf({ vinculos: [VINCULO_304] }), [pc304({ pcEspelho: true }), pc302()], escolhaDo304())),
      // vínculo fora da cópia, sem número do pedido na NF: o PC aparece como "(sem número)", nunca como id
      erroDe(() => escolher(itemNf({ vinculos: [VINCULO_304] }), [], escolhaDo304())),
    ];
    for (const e of erros) {
      expect(e.message).not.toMatch(/\d{10}/);
      expect(e.message).toContain('7813');
      expect(e.message).toContain('SUCATA PLASTICO');
    }
    expect(erros[erros.length - 1]!.message).toContain('(sem número)');
  });
});

// ═══ Mensagens das demais classes de erro do portao 1 ═══════════════════════

describe('NfSemPcError e CopiaPcsDefasadaError — texto para o operador', () => {
  it('NF sem PC: cita a NF, o fornecedor e os itens, e avisa que compras foi avisado', () => {
    const e = new NfSemPcError('7813', 'REPLAS', [{ descricao: 'SUCATA PLASTICO ', motivo: 'sem_pc' }]);
    expect(e.message).toContain('NF 7813 (REPLAS)');
    expect(e.message).toContain('SUCATA PLASTICO');
    expect(e.message).toContain('sem pedido de compra');
    expect(e.message).toMatch(/Compras.* avisad[oa]/);
  });

  it('só PC aguardando aprovação: a NF fica na fila até a aprovação', () => {
    const e = new NfSemPcError('7813', null, [{ descricao: 'SUCATA', motivo: 'pc_aguardando_aprovacao' }]);
    expect(e.message).toContain('aguardando aprovação');
    expect(e.message).toContain('NF 7813');
    expect(e.message).not.toContain('NF 7813 ('); // sem fornecedor, sem o parêntese do nome
  });

  it('vínculo inválido tem prioridade sobre os outros motivos', () => {
    const e = new NfSemPcError('7813', 'REPLAS', [
      { descricao: 'A', motivo: 'sem_pc' },
      { descricao: 'B', motivo: 'vinculo_invalido' },
    ]);
    expect(e.message).toContain('não pode ser usado');
    expect(e.message).toContain('A, B');
  });

  it('cópia de PCs defasada: nada foi registrado', () => {
    const e = new CopiaPcsDefasadaError();
    expect(e.name).toBe('CopiaPcsDefasadaError');
    expect(e.message).toContain('Nada foi registrado');
  });
});

// ═══ Configuracao ════════════════════════════════════════════════════════════

describe('fatorUnidadePc / toleranciasPc / exigePcHabilitado', () => {
  it('fatorUnidadePc: KG = 1; T, TON e TL = 1000; outra unidade = null (sem diferenciar caixa nem espaços)', () => {
    expect(fatorUnidadePc('KG')).toBe(1);
    expect(fatorUnidadePc(' kg ')).toBe(1);
    expect(fatorUnidadePc('T')).toBe(1000);
    expect(fatorUnidadePc('ton')).toBe(1000);
    expect(fatorUnidadePc('TL')).toBe(1000);
    expect(fatorUnidadePc('UN')).toBeNull();
    expect(fatorUnidadePc('')).toBeNull();
    expect(fatorUnidadePc(null)).toBeNull();
    expect(fatorUnidadePc(undefined)).toBeNull();
  });

  it('toleranciasPc: padrão de 2% (quantidade) e 1% (preço) sem configuração', () => {
    expect(toleranciasPc()).toEqual({ qtd: 0.02, preco: 0.01 });
  });

  it('toleranciasPc: lê a configuração em % (0 é válido; valor inválido volta ao padrão)', () => {
    mocks.config.STOCKBRIDGE_PC_TOLERANCIA_QTD_PCT = 5;
    mocks.config.STOCKBRIDGE_PC_TOLERANCIA_PRECO_PCT = 0;
    expect(toleranciasPc()).toEqual({ qtd: 0.05, preco: 0 });

    mocks.config.STOCKBRIDGE_PC_TOLERANCIA_QTD_PCT = -3;
    mocks.config.STOCKBRIDGE_PC_TOLERANCIA_PRECO_PCT = 'abc';
    expect(toleranciasPc()).toEqual({ qtd: 0.02, preco: 0.01 });
  });

  it('exigePcHabilitado: padrão true; só false desliga', () => {
    expect(exigePcHabilitado()).toBe(true);
    mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = false;
    expect(exigePcHabilitado()).toBe(false);
    mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = true;
    expect(exigePcHabilitado()).toBe(true);
  });

  it('constantes da regra: reserva vale 15 min e PC-espelho é abaixo de R$ 200', () => {
    expect(RESERVA_PC_VALIDADE_MIN).toBe(15);
    expect(PC_ESPELHO_VALOR_MAX_BRL).toBe(200);
  });
});

// ═══ E. carregarContextoPc / sugerirPcPorItens (pool mockado) ════════════════

interface LinhaPcBanco {
  ncodped: string;
  ncoditem: string;
  cnumero: string | null;
  cetapa: string | null;
  ncodfor: string | null;
  nqtde: number | string | null;
  nqtderec: number | string | null;
  nvalunit: number | string | null;
  cunidade: string | null;
  ddtprevisao: string | null;
  cdescricao: string | null;
  cproduto: string | null;
  atualizado_ms: number | string | null;
  valor_total_pc: number | string | null;
  fornecedor_acxe: boolean | null;
  cnpj_cadastro: string | null;
}

/** Linha da cópia como o Postgres a devolve: ids em texto (bigint), números do float8. */
function linhaPc(over: Partial<LinhaPcBanco> = {}): LinhaPcBanco {
  return {
    ncodped: String(NCODPED_304),
    ncoditem: String(NCODITEM_304),
    cnumero: '304',
    cetapa: '15',
    ncodfor: String(FORNECEDOR),
    nqtde: 18000,
    nqtderec: 0,
    nvalunit: 11.3,
    cunidade: 'KG',
    ddtprevisao: '2026-10-30',
    cdescricao: 'PS CRISTAL B',
    cproduto: 'PS-CRISTAL-B',
    atualizado_ms: SYNC,
    valor_total_pc: 203400,
    fornecedor_acxe: false,
    cnpj_cadastro: CNPJ_REPLAS,
    ...over,
  };
}

interface LinhaUsoBanco {
  n_cod_item_ped: string;
  nf_chave_acesso: string;
  status: 'confirmado' | 'associado' | 'concluido';
  qtd_nf_kg: number | string;
  em_ms: number | string;
}

/** Responde a raiz do CNPJ do fornecedor (cadastro), a consulta da cópia (tbl_pedidosCompras_*) e a dos usos do ledger. */
function bancoComPcs(pcs: LinhaPcBanco[], usos: LinhaUsoBanco[] = [], cadastro: Array<{ codigo: string; cnpj: string | null }> = []): void {
  mocks.poolQuery.mockImplementation((sql: string) => {
    if (sql.includes('tbl_pedidosCompras_')) return Promise.resolve({ rows: pcs });
    if (sql.includes('AS codigo') && sql.includes('tbl_cadastroFornecedoresClientes_')) return Promise.resolve({ rows: cadastro });
    if (sql.includes('stockbridge.recebimento_fiscal_pc')) return Promise.resolve({ rows: usos });
    return Promise.reject(new Error(`SQL inesperado: ${sql.slice(0, 80)}`));
  });
}

const sqlNormalizado = (i: number): string => String(mocks.poolQuery.mock.calls[i]![0]).replace(/\s+/g, ' ').trim();
/** Chamada do pool cuja SQL contém o trecho (a ordem das consultas não é contrato). */
const chamada = (trecho: string) => mocks.poolQuery.mock.calls.find((c) => String(c[0]).includes(trecho))!;
const sqlDe = (trecho: string): string => String(chamada(trecho)[0]).replace(/\s+/g, ' ').trim();

describe('carregarContextoPc', () => {
  beforeEach(() => {
    mocks.poolQuery.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AGORA);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sem fornecedor nem vínculo (ou só ids inválidos) não consulta o banco', async () => {
    const vazio = await carregarContextoPc('q2p', { fornecedores: [], nCodPedsVinculo: [] });
    expect(vazio).toEqual({ pcs: [], usos: [], agoraMs: AGORA, raizPorFornecedor: new Map() });
    const invalidos = await carregarContextoPc('q2p', { fornecedores: [0, -1, Number.NaN], nCodPedsVinculo: [0, Number.POSITIVE_INFINITY] });
    expect(invalidos.pcs).toEqual([]);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
    // nem o cache de PCs vistos (0057) e consultado
    expect(mocks.lerPcsVistos).not.toHaveBeenCalled();
    expect(mocks.registrarPcsVistosSeVencido).not.toHaveBeenCalled();
  });

  it('o SQL da cópia filtra por fornecedor OU pedido de vínculo OU outro cadastro da mesma raiz, e passa a CNPJ da ACXE (sem máscara) como $3', async () => {
    bancoComPcs([], [], [{ codigo: String(FORNECEDOR), cnpj: CNPJ_REPLAS }]);
    await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [NCODPED_304] });
    // raiz do CNPJ do fornecedor + cópia (sem PCs, sem a consulta do ledger)
    expect(mocks.poolQuery).toHaveBeenCalledTimes(2);
    const sql = sqlDe('tbl_pedidosCompras_');
    expect(sql).toContain('pc.ncodfor = ANY($1::bigint[]) OR pc.ncodped = ANY($2::bigint[])');
    expect(sql).toContain('OR pc.ncodfor IN (');
    expect(sql).toContain("left(regexp_replace(c2.cnpj_cpf, '\\D', '', 'g'), 8) = ANY($4::text[])");
    expect(sql).toMatch(/regexp_replace\(COALESCE\(cad\.cnpj_cpf, ''\), '\\D', '', 'g'\) = \$3/);
    expect(chamada('tbl_pedidosCompras_')[1]).toEqual([[FORNECEDOR], [NCODPED_304], '42672052000154', ['11111111']]);
    expect(chamada('AS codigo')[1]).toEqual([[FORNECEDOR]]);
  });

  it('raiz do fornecedor: só CNPJ de 14 dígitos (CPF ou vazio não têm raiz) e entra em raizPorFornecedor', async () => {
    bancoComPcs([], [], [
      { codigo: String(FORNECEDOR), cnpj: CNPJ_REPLAS },
      { codigo: '2222', cnpj: '12345678901' },
      { codigo: '3333', cnpj: '' },
    ]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR, 2222, 3333], nCodPedsVinculo: [] });
    expect(ctx.raizPorFornecedor).toEqual(new Map([[FORNECEDOR, '11111111']]));
    expect(chamada('tbl_pedidosCompras_')[1]![3]).toEqual(['11111111']);
  });

  it('cada PC traz o CNPJ do próprio cadastro e a raiz (CPF ou sem cadastro: raiz nula)', async () => {
    bancoComPcs([
      linhaPc({ cnpj_cadastro: '61827663000179' }),
      linhaPc({ ncoditem: '2', cnpj_cadastro: '12345678901' }),
      linhaPc({ ncoditem: '3', cnpj_cadastro: null }),
    ]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs.map((p) => [p.cnpjCadastro, p.raizCnpj])).toEqual([
      ['61827663000179', '61827663'],
      ['12345678901', null],
      ['', null],
    ]);
  });

  it('ids repetidos ou inválidos são limpos antes da consulta', async () => {
    bancoComPcs([]);
    await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR, FORNECEDOR, 0, Number.NaN], nCodPedsVinculo: [NCODPED_304, NCODPED_304, -5] });
    expect(chamada('tbl_pedidosCompras_')[1]).toEqual([[FORNECEDOR], [NCODPED_304], '42672052000154', []]);
    expect(chamada('AS codigo')[1]).toEqual([[FORNECEDOR]]);
  });

  it('só vínculo (sem fornecedor) também consulta, com $1 e as raízes vazios — sem a consulta do cadastro', async () => {
    bancoComPcs([]);
    await carregarContextoPc('q2p', { fornecedores: [], nCodPedsVinculo: [NCODPED_304] });
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    expect(mocks.poolQuery.mock.calls[0]![1]).toEqual([[], [NCODPED_304], '42672052000154', []]);
  });

  it.each([
    ['q2p', 'tbl_pedidosCompras_Q2P', 'tbl_cadastroFornecedoresClientes_Q2P'],
    ['acxe', 'tbl_pedidosCompras_ACXE', 'tbl_cadastroFornecedoresClientes_ACXE'],
  ] as const)('empresa %s lê a cópia e o cadastro da própria empresa', async (empresa, tabelaPc, tabelaCadastro) => {
    bancoComPcs([]);
    await carregarContextoPc(empresa, { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    const sql = sqlDe('tbl_pedidosCompras_');
    expect(sql).toContain(`public."${tabelaPc}" pc`);
    expect(sql).toContain(`public."${tabelaCadastro}" c`);
    expect(sqlDe('AS codigo')).toContain(`public."${tabelaCadastro}" c`);
  });

  it('unidade KG: quantidades e preço ficam como vieram', async () => {
    bancoComPcs([linhaPc({ nqtde: 18000, nqtderec: 4500, nvalunit: 11.3, cunidade: 'KG' })]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs).toHaveLength(1);
    expect(ctx.pcs[0]).toMatchObject({
      nCodPed: NCODPED_304,
      nCodItem: NCODITEM_304,
      pcNumero: '304',
      etapa: '15',
      nCodFor: FORNECEDOR,
      produtoDescricao: 'PS CRISTAL B',
      qtdPedidaKg: 18000,
      saldoCopiaKg: 13500,
      precoKg: 11.3,
      unidade: 'KG',
      dtPrevisao: '2026-10-30',
      atualizadoEmMs: SYNC,
      pcEspelho: false,
    });
  });

  it.each(['T', 'TON', 'ton', 'TL'])('unidade %s: multiplica a quantidade por 1000 e divide o preço por 1000', async (unidade) => {
    bancoComPcs([linhaPc({ nqtde: 18, nqtderec: 4.5, nvalunit: 11300, cunidade: unidade })]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs[0]!.qtdPedidaKg).toBe(18000);
    expect(ctx.pcs[0]!.saldoCopiaKg).toBe(13500);
    expect(ctx.pcs[0]!.precoKg).toBeCloseTo(11.3, 10);
    expect(ctx.pcs[0]!.unidade).toBe(unidade.toUpperCase());
  });

  it('unidade UN (não comparável): precoKg null e quantidades zeradas', async () => {
    bancoComPcs([linhaPc({ nqtde: 500, nqtderec: 0, nvalunit: 40, cunidade: 'UN' })]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs[0]).toMatchObject({ precoKg: null, qtdPedidaKg: 0, saldoCopiaKg: 0, unidade: 'UN' });
  });

  it('saldo nunca negativo (recebido acima do pedido) e nqtderec nulo conta como zero', async () => {
    bancoComPcs([
      linhaPc({ nqtde: 1000, nqtderec: 1200 }),
      linhaPc({ ncoditem: String(NCODITEM_302), nqtde: 1000, nqtderec: null }),
    ]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs[0]!.saldoCopiaKg).toBe(0);
    expect(ctx.pcs[1]!.saldoCopiaKg).toBe(1000);
  });

  it('campos nulos viram vazios: número, etapa, descrição (cai no código do produto) e previsão', async () => {
    bancoComPcs([linhaPc({ cnumero: null, cetapa: null, cdescricao: null, cproduto: ' PS-CRISTAL-B ', ddtprevisao: null, ncodfor: null, atualizado_ms: null })]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs[0]).toMatchObject({ pcNumero: '', etapa: '', produtoDescricao: 'PS-CRISTAL-B', dtPrevisao: null, nCodFor: 0, atualizadoEmMs: 0 });
  });

  it('a previsão é cortada na data (10 caracteres)', async () => {
    bancoComPcs([linhaPc({ ddtprevisao: '2026-10-30 00:00:00' })]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs[0]!.dtPrevisao).toBe('2026-10-30');
  });

  it('pcEspelho só com fornecedor ACXE e valor total do PC abaixo de R$ 200', async () => {
    const base = { ncodfor: '9' };
    bancoComPcs([
      linhaPc({ ...base, ncoditem: '1', fornecedor_acxe: true, valor_total_pc: 150 }), // espelho
      linhaPc({ ...base, ncoditem: '2', fornecedor_acxe: true, valor_total_pc: 199.99 }), // espelho (< 200)
      linhaPc({ ...base, ncoditem: '3', fornecedor_acxe: true, valor_total_pc: 200 }), // 200 não é < 200
      linhaPc({ ...base, ncoditem: '4', fornecedor_acxe: true, valor_total_pc: 203400 }), // PC real da ACXE
      linhaPc({ ...base, ncoditem: '5', fornecedor_acxe: false, valor_total_pc: 50 }), // fornecedor comum, valor baixo
      linhaPc({ ...base, ncoditem: '6', fornecedor_acxe: null, valor_total_pc: 50 }), // fornecedor sem cadastro
    ]);
    // o PC-espelho da importacao so existe na copia da Q2P (Historia 5: na da ACXE o fornecedor nunca e a propria ACXE)
    const ctx = await carregarContextoPc('q2p', { fornecedores: [9], nCodPedsVinculo: [] });
    expect(ctx.pcs.map((p) => p.pcEspelho)).toEqual([true, true, false, false, false, false]);
  });

  it('PC sem linhas na cópia: não faz a consulta dos usos do Atlas', async () => {
    bancoComPcs([]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(mocks.poolQuery.mock.calls.some((c) => String(c[0]).includes('stockbridge.recebimento_fiscal_pc'))).toBe(false);
    expect(ctx).toEqual({ pcs: [], usos: [], agoraMs: AGORA, raizPorFornecedor: new Map() });
  });

  it('com PCs faz a segunda consulta (ledger) por empresa e itens de PC, e mapeia concluídos e reservas', async () => {
    bancoComPcs(
      [
        linhaPc({ atualizado_ms: SYNC }),
        linhaPc({ ncodped: String(NCODPED_302), ncoditem: String(NCODITEM_302), cnumero: '302', atualizado_ms: SYNC - 60_000 }),
      ],
      [
        { n_cod_item_ped: String(NCODITEM_304), nf_chave_acesso: OUTRA_CHAVE, status: 'concluido', qtd_nf_kg: '9000.000', em_ms: SYNC + 60_000 },
        { n_cod_item_ped: String(NCODITEM_302), nf_chave_acesso: CHAVE_NF, status: 'confirmado', qtd_nf_kg: 4000, em_ms: AGORA - 120_000 },
        { n_cod_item_ped: String(NCODITEM_302), nf_chave_acesso: OUTRA_CHAVE, status: 'associado', qtd_nf_kg: 1500.5, em_ms: String(AGORA - 30_000) },
      ],
    );
    const ctx = await carregarContextoPc('acxe', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });

    expect(mocks.poolQuery).toHaveBeenCalledTimes(3);
    const sqlUsos = sqlDe('stockbridge.recebimento_fiscal_pc');
    expect(sqlUsos).toContain('FROM stockbridge.recebimento_fiscal_pc');
    expect(sqlUsos).toContain("status = 'concluido' AND concluido_em > to_timestamp($3::float8 / 1000)");
    expect(sqlUsos).toContain("status IN ('confirmado', 'associado') AND confirmado_em > now() - make_interval(mins => $4)");
    // $1 empresa, $2 itens de PC lidos, $3 sync MAIS ANTIGO entre os PCs, $4 validade da reserva
    expect(chamada('stockbridge.recebimento_fiscal_pc')[1]).toEqual(['acxe', [NCODITEM_304, NCODITEM_302], SYNC - 60_000, RESERVA_PC_VALIDADE_MIN]);

    expect(ctx.usos).toEqual([
      { nCodItemPed: NCODITEM_304, nfChaveAcesso: OUTRA_CHAVE, status: 'concluido', qtdKg: 9000, emMs: SYNC + 60_000 },
      { nCodItemPed: NCODITEM_302, nfChaveAcesso: CHAVE_NF, status: 'confirmado', qtdKg: 4000, emMs: AGORA - 120_000 },
      { nCodItemPed: NCODITEM_302, nfChaveAcesso: OUTRA_CHAVE, status: 'associado', qtdKg: 1500.5, emMs: AGORA - 30_000 },
    ]);
  });

  it('o contexto carregado alimenta o saldo: cópia 18.000 − concluído depois do sync 9.000 − reserva de outra NF 4.000', async () => {
    bancoComPcs(
      [linhaPc({ atualizado_ms: SYNC })],
      [
        { n_cod_item_ped: String(NCODITEM_304), nf_chave_acesso: OUTRA_CHAVE, status: 'concluido', qtd_nf_kg: 9000, em_ms: SYNC + 1 },
        { n_cod_item_ped: String(NCODITEM_304), nf_chave_acesso: OUTRA_CHAVE, status: 'confirmado', qtd_nf_kg: 4000, em_ms: AGORA - 1000 },
        { n_cod_item_ped: String(NCODITEM_304), nf_chave_acesso: CHAVE_NF, status: 'confirmado', qtd_nf_kg: 7000, em_ms: AGORA - 1000 },
      ],
    );
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(saldoDisponivelCopiaKg(ctx.pcs[0]!, ctx, CHAVE_NF)).toBe(5000);
  });

  it('sem sync conhecido (atualizado_ms 0), o corte dos concluídos é o instante atual', async () => {
    bancoComPcs([linhaPc({ atualizado_ms: 0 })]);
    await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(chamada('stockbridge.recebimento_fiscal_pc')[1]).toEqual(['q2p', [NCODITEM_304], AGORA, RESERVA_PC_VALIDADE_MIN]);
  });
});

/** Item de PC do cache (stockbridge.pedido_compra_visto) como `lerPcsVistos` o devolve: PcCopia sem `fonte` + vistoEmMs. */
function pcVisto(over: Partial<PcCopia> & { vistoEmMs?: number } = {}) {
  const { fonte: _fonte, ...base } = pcCopia({ nCodPed: 7000000306, nCodItem: 7000000999, pcNumero: '306', ...over });
  return { ...base, vistoEmMs: over.vistoEmMs ?? over.atualizadoEmMs ?? SYNC };
}

describe('carregarContextoPc — cache de PCs vistos (0057; PC que o OMIE tirou da lista de pendentes)', () => {
  beforeEach(() => {
    mocks.poolQuery.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AGORA);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('PC só no cache entra com fonte "cache", com os dados da última vez em que foi visto; o da cópia fica "copia"', async () => {
    bancoComPcs([linhaPc()]);
    mocks.lerPcsVistos.mockResolvedValue([pcVisto({ saldoCopiaKg: 8250, atualizadoEmMs: SYNC - 3_600_000 })]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs.map((p) => [p.pcNumero, p.fonte])).toEqual([['304', 'copia'], ['306', 'cache']]);
    expect(ctx.pcs[1]).toMatchObject({ nCodPed: 7000000306, nCodItem: 7000000999, saldoCopiaKg: 8250, atualizadoEmMs: SYNC - 3_600_000, etapa: '15' });
  });

  it('não duplica: o item que a cópia já trouxe vence o do cache (mesmo nCodItem), mesmo com dados diferentes', async () => {
    bancoComPcs([linhaPc({ nqtde: 18000, nqtderec: 0 })]);
    mocks.lerPcsVistos.mockResolvedValue([pcVisto({ nCodPed: NCODPED_304, nCodItem: NCODITEM_304, pcNumero: '304', saldoCopiaKg: 1 })]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs).toHaveLength(1);
    expect(ctx.pcs[0]).toMatchObject({ fonte: 'copia', saldoCopiaKg: 18000 });
  });

  it('o cache é lido DEPOIS da cópia, pedindo os fornecedores, as raízes de CNPJ e os pedidos de vínculo; registra antes de ler', async () => {
    bancoComPcs([], [], [{ codigo: String(FORNECEDOR), cnpj: CNPJ_REPLAS }]);
    await carregarContextoPc('acxe', { fornecedores: [FORNECEDOR, FORNECEDOR], nCodPedsVinculo: [NCODPED_304, NCODPED_304, 0] });
    expect(mocks.registrarPcsVistosSeVencido).toHaveBeenCalledTimes(1);
    expect(mocks.registrarPcsVistosSeVencido).toHaveBeenCalledWith('acxe', AGORA);
    expect(mocks.lerPcsVistos).toHaveBeenCalledTimes(1);
    expect(mocks.lerPcsVistos).toHaveBeenCalledWith('acxe', { fornecedores: [FORNECEDOR], raizes: ['11111111'], nCodPeds: [NCODPED_304] });
    const idxCopia = mocks.poolQuery.mock.calls.findIndex((c) => String(c[0]).includes('tbl_pedidosCompras_'));
    expect(mocks.poolQuery.mock.invocationCallOrder[idxCopia]!).toBeLessThan(mocks.registrarPcsVistosSeVencido.mock.invocationCallOrder[0]!);
    expect(mocks.registrarPcsVistosSeVencido.mock.invocationCallOrder[0]!).toBeLessThan(mocks.lerPcsVistos.mock.invocationCallOrder[0]!);
  });

  it('só vínculo (sem fornecedor): o cache é consultado pelo pedido, sem raízes', async () => {
    bancoComPcs([]);
    await carregarContextoPc('q2p', { fornecedores: [], nCodPedsVinculo: [NCODPED_304] });
    expect(mocks.lerPcsVistos).toHaveBeenCalledWith('q2p', { fornecedores: [], raizes: [], nCodPeds: [NCODPED_304] });
  });

  it('o PC do cache entra na consulta do ledger (usos) e no corte: PC 306 só no cache, copia vazia', async () => {
    bancoComPcs([], [{ n_cod_item_ped: '7000000999', nf_chave_acesso: OUTRA_CHAVE, status: 'concluido', qtd_nf_kg: 5000, em_ms: SYNC + 1 }]);
    mocks.lerPcsVistos.mockResolvedValue([pcVisto({ vistoEmMs: SYNC - 120_000, atualizadoEmMs: SYNC - 120_000 })]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(chamada('stockbridge.recebimento_fiscal_pc')[1]).toEqual(['q2p', [7000000999], SYNC - 120_000, RESERVA_PC_VALIDADE_MIN]);
    expect(ctx.usos).toHaveLength(1);
    // o saldo disponivel do item do cache desconta o concluido depois do "visto"
    expect(saldoDisponivelCopiaKg(ctx.pcs[0]!, ctx, CHAVE_NF)).toBe(13000);
  });

  it('cache indisponível (a leitura falha): segue só com a cópia, com aviso no log — a sugestão não cai', async () => {
    bancoComPcs([linhaPc()]);
    mocks.lerPcsVistos.mockRejectedValue(new Error('relation "stockbridge.pedido_compra_visto" does not exist'));
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs.map((p) => p.fonte)).toEqual(['copia']);
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(String(mocks.logger.warn.mock.calls[0]![1])).toContain('Cache de pedidos de compra indisponível');
  });

  it('registrar o cache falhar (a promessa rejeita) também não derruba o contexto', async () => {
    bancoComPcs([linhaPc()]);
    mocks.registrarPcsVistosSeVencido.mockRejectedValue(new Error('timeout'));
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs).toHaveLength(1);
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(mocks.lerPcsVistos).not.toHaveBeenCalled();
  });

  it('o cache vazio não muda o contexto (nem o número de consultas ao banco)', async () => {
    bancoComPcs([linhaPc()]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs).toHaveLength(1);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('sugerirPcPorItens: o PC 306 só no cache vira candidato com dadosEmCache true (NF 60199 × PC 306)', async () => {
    bancoComPcs([]);
    mocks.lerPcsVistos.mockResolvedValue([pcVisto({ saldoCopiaKg: 18000 })]);
    const mapa = await sugerirPcPorItens('q2p', FORNECEDOR, CHAVE_NF, [itemNf()]);
    const r = mapa.get(0)!;
    expect(r.possivel).toBe(true);
    expect(r.pc.candidatos.map((c) => [c.pcNumero, c.dadosEmCache])).toEqual([['306', true]]);
  });
});

describe('montarPcDoItem — PC vindo do cache de PCs vistos (0057)', () => {
  const doCache = (over: Partial<PcCopia> = {}) => pcCopia({ fonte: 'cache', pcNumero: '306', ...over });

  it('candidato do cache: dadosEmCache true; o da cópia, false', () => {
    const r = montar(itemNf(), [doCache(), pc302()]);
    expect(r.pc.candidatos.map((c) => [c.pcNumero, c.dadosEmCache])).toEqual([['302', false], ['306', true]]);
  });

  it('vínculo do OMIE em PC só no cache: elegível, avaliado normalmente e pré-selecionado, com o alerta "saiu da lista"', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304] }), [doCache()]);
    expect(r.pc.vinculoOmie?.pcNumero).toBe('306');
    expect(r.pc.vinculoOmie?.semDadosLocais).toBe(false);
    expect(r.pc.vinculoOmie?.dadosEmCache).toBe(true);
    expect(r.pc.vinculoOmie?.saldoKg).toBe(18000);
    expect(r.pc.vinculoOmieElegivel).toBe(true);
    expect(r.pc.alertaVinculoOmie).toBe(
      'O PC 306 saiu da lista de pedidos pendentes do OMIE; os dados mostrados são da última sincronização em que apareceu. A confirmação confere o saldo ao vivo.',
    );
    expect(r.pc.preSelecionado).toEqual({ nCodPed: NCODPED_304, nCodItem: NCODITEM_304 });
    expect(r.situacao).toBe('vinculado_omie');
  });

  it('vínculo do OMIE em PC da cópia: sem o alerta "saiu da lista"', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304] }), [pc304()]);
    expect(r.pc.vinculoOmie?.dadosEmCache).toBe(false);
    expect(r.pc.alertaVinculoOmie).toBeNull();
  });

  it('vínculo em PC do cache fora da tolerância: os dois alertas, justificativa na escolha e nada pré-selecionado', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304], quantidadeKg: 19000, kgPorSequencia: { 1: 19000 } }), [doCache()]);
    expect(r.pc.alertaVinculoOmie).toContain('saiu da lista de pedidos pendentes');
    expect(r.pc.alertaVinculoOmie).toContain('fora da tolerância');
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('escolha_necessaria');
  });

  it('vínculo cujo PC não está nem na cópia nem no cache: segue sem dados locais (a releitura ao vivo decide)', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_304] }), []);
    expect(r.pc.vinculoOmie?.semDadosLocais).toBe(true);
    expect(r.pc.vinculoOmie?.pcNumero).toBe('');
    expect(r.pc.alertaVinculoOmie).toContain('não está na lista local de pedidos');
  });

  it('PC do cache na etapa 10 vai para "aguardando aprovação" (sem ser selecionável), com dadosEmCache', () => {
    const r = montar(itemNf(), [doCache({ etapa: '10' })]);
    expect(r.pc.aguardandoAprovacao.map((c) => [c.pcNumero, c.dadosEmCache])).toEqual([['306', true]]);
    expect(r.motivoSemPc).toBe('pc_aguardando_aprovacao');
  });

  it('divergência de linhas cita o número do PC que só está no cache', () => {
    const item = itemNf({ vinculos: [VINCULO_304, VINCULO_302], sequencias: [1, 2], kgPorSequencia: { 1: 9000, 2: 9000 } });
    const r = montar(item, [pc304(), pc302({ fonte: 'cache' })]);
    expect(r.pc.alertaVinculoOmie).toContain('PCs 304 e 302');
  });
});

describe('sugerirPcPorItens', () => {
  beforeEach(() => {
    mocks.poolQuery.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AGORA);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('carrega a cópia uma vez (fornecedor da NF + pedidos dos vínculos) e devolve o resultado por índice do item', async () => {
    bancoComPcs([linhaPc(), linhaPc({ ncodped: String(NCODPED_302), ncoditem: String(NCODITEM_302), cnumero: '302' })]);
    const itens = [
      itemNf({ indice: 0, vinculos: [VINCULO_304] }),
      itemNf({ indice: 2, descricao: 'OUTRO ITEM', quantidadeKg: 30000 }),
      itemNf({ indice: 5, descricao: 'SEM UNIDADE', quantidadeKg: null }),
    ];
    const mapa = await sugerirPcPorItens('q2p', FORNECEDOR, CHAVE_NF, itens);

    expect(mocks.poolQuery.mock.calls.filter((c) => String(c[0]).includes('tbl_pedidosCompras_'))).toHaveLength(1);
    expect(chamada('tbl_pedidosCompras_')[1]).toEqual([[FORNECEDOR], [NCODPED_304], '42672052000154', []]);

    expect([...mapa.keys()]).toEqual([0, 2, 5]);
    expect(mapa.get(0)!.situacao).toBe('vinculado_omie');
    expect(mapa.get(2)!.pc.outrosDoFornecedor.map((c) => c.pcNumero)).toEqual(['302', '304']);
    expect(mapa.get(5)!.motivoSemPc).toBe('unidade');
  });

  it('fornecedor desconhecido (null): consulta só pelos vínculos e nenhum candidato aparece', async () => {
    bancoComPcs([linhaPc()]);
    const mapa = await sugerirPcPorItens('q2p', null, CHAVE_NF, [itemNf({ vinculos: [VINCULO_304] })]);
    expect(mocks.poolQuery.mock.calls[0]![1]).toEqual([[], [NCODPED_304], '42672052000154', []]);
    expect(mapa.get(0)!.pc.vinculoOmie?.pcNumero).toBe('304');
    expect(mapa.get(0)!.pc.candidatos).toEqual([]);
  });

  it('usa as tolerâncias da configuração', async () => {
    bancoComPcs([linhaPc()]);
    const padrao = await sugerirPcPorItens('q2p', FORNECEDOR, CHAVE_NF, [itemNf({ quantidadeKg: 19000 })]);
    expect(padrao.get(0)!.pc.candidatos).toEqual([]); // 5,6% acima não cabe nos 2% padrão

    mocks.config.STOCKBRIDGE_PC_TOLERANCIA_QTD_PCT = 10;
    const configurada = await sugerirPcPorItens('q2p', FORNECEDOR, CHAVE_NF, [itemNf({ quantidadeKg: 19000 })]);
    expect(configurada.get(0)!.pc.candidatos).toHaveLength(1); // cabe em 10%
  });
});

// ═══ F. Correcoes da revisao adversarial de 22/10/2026 ═════════════════════════

describe('montarPcDoItem — duas bases de preço (research D3 revisto; NF 60199 × PC 306)', () => {
  // PC 306 da Zaraplast lançado com o preço COM IPI: R$ 10,80/kg. Na NF, o comercial do PEAD ES é
  // R$ 10,50848/kg (2,7% abaixo) e o valor do item (com IPI) R$ 10,850006/kg (0,46% acima).
  const pc306 = (over: Partial<PcCopia> = {}) => pcCopia({ pcNumero: '306', precoKg: 10.8, qtdPedidaKg: 13750, saldoCopiaKg: 13750, ...over });
  const peadEs = (over: Partial<ItemParaSugestao> = {}) =>
    itemNf({ descricao: 'MC PEAD ES', quantidadeKg: 13750, precoNfKg: 10.50848, precoItemKg: 10.850006, kgPorSequencia: { 1: 13750 }, ...over });

  it('vale a base mais próxima do PC: o valor do item casa dentro de 1% e o PC vira candidato', () => {
    const r = montar(peadEs(), [pc306()]);
    expect(r.pc.candidatos.map((c) => c.pcNumero)).toEqual(['306']);
    expect(r.pc.candidatos[0]!.precoNfKgComparado).toBeCloseTo(10.850006, 6);
    expect(r.pc.outrosDoFornecedor).toEqual([]);
    expect(r.situacao).toBe('sugerido');
  });

  it('só a base comercial (sem valor do item): o mesmo PC fica fora, com o desvio da base comercial', () => {
    const r = montar(peadEs({ precoItemKg: null }), [pc306()]);
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.outrosDoFornecedor[0]!.motivo).toBe('Preço da NF 2,7% abaixo do PC');
    expect(r.pc.outrosDoFornecedor[0]!.precoNfKgComparado).toBeCloseTo(10.50848, 6);
  });

  it('fornecedor sem IPI (as duas bases iguais): resultado idêntico ao de antes', () => {
    const r = montar(itemNf({ precoItemKg: 11.3 }), [pc304()]);
    expect(r.pc.candidatos.map((c) => c.pcNumero)).toEqual(['304']);
    expect(r.pc.candidatos[0]!.precoNfKgComparado).toBe(11.3);
  });

  it('fora nas duas bases: o desvio cita a base mais próxima', () => {
    // PC a 10,00: comercial 10,50848 (+5,1%), valor do item 10,850006 (+8,5%)
    const r = montar(peadEs(), [pc306({ precoKg: 10 })]);
    expect(r.pc.outrosDoFornecedor[0]!.motivo).toBe('Preço da NF 5,1% acima do PC');
  });

  it('o vínculo do OMIE também usa a base mais próxima: sem alerta de preço e pré-selecionado', () => {
    const r = montar(peadEs({ vinculos: [VINCULO_304] }), [pc306()]);
    expect(r.pc.alertaVinculoOmie).toBeNull();
    expect(r.situacao).toBe('vinculado_omie');
  });

  it('a escolha validada grava o preço da base comparada (preco_nf)', () => {
    const it = peadEs();
    const v = validarEscolhaPc({
      notaFiscal: '60199', fornecedorNome: 'Zaraplast S/A', itemDescricao: it.descricao, indice: 0, sequencias: [1], vinculos: [],
      resultado: montar(it, [pc306()]), escolha: escolhaDo304(), quantidadeKg: 13750, precoNfKg: it.precoNfKg, kgPorSequencia: it.kgPorSequencia,
    })!;
    expect(v.precoNfKg).toBeCloseTo(10.850006, 6);
    expect(v.dentroTolerancia).toBe(true);
  });
});

describe('montarPcDoItem — PC em outro cadastro do mesmo fornecedor (filial × matriz, NF 60199 × PC 306)', () => {
  // T033 (22/10/2026): o ASSOCIAR-PEDIDO entre cadastros da mesma raiz de CNPJ foi aceito pelo OMIE —
  // o PC lançado na matriz agora é OFERECIDO para a NF da filial, com selo (outroCadastro) e sufixo no motivo.
  const FILIAL = 3098999518;
  const MATRIZ = 7974140605;
  const raizZaraplast = new Map([[FILIAL, '61827663']]);
  const pcMatriz = (over: Partial<PcCopia> = {}) =>
    pcCopia({ nCodFor: MATRIZ, pcNumero: '306', cnpjCadastro: '61827663000179', raizCnpj: '61827663', ...over });
  const montarFilial = (pcs: PcCopia[], item = itemNf()) => montarPcDoItem(item, contexto(pcs, [], raizZaraplast), FILIAL, CHAVE_NF, TOL);
  const SUFIXO = 'em outro cadastro do fornecedor (CNPJ 61.827.663/0001-79)';

  it('é OFERECIDO: candidato com o selo outroCadastro, o CNPJ do cadastro do PC e o sufixo no motivo', () => {
    const r = montarFilial([pcMatriz()]);
    expect(r.possivel).toBe(true);
    expect(r.motivoSemPc).toBeNull();
    expect(r.pc.semPcMotivo).toBeNull();
    expect(r.pc.candidatos).toHaveLength(1);
    const c = r.pc.candidatos[0]!;
    expect(c.pcNumero).toBe('306');
    expect(c.outroCadastro).toBe(true);
    expect(c.cnpjCadastro).toBe('61827663000179');
    expect(c.dentroTolerancia).toBe(true);
    expect(c.motivo).toBe(`Quantidade e preço compatíveis · ${SUFIXO}`);
    expect(r.situacao).toBe('sugerido');
  });

  it('PC do próprio cadastro da nota: outroCadastro false e motivo sem sufixo', () => {
    const r = montarFilial([pcCopia({ nCodFor: FILIAL })]);
    expect(r.pc.candidatos[0]!.outroCadastro).toBe(false);
    expect(r.pc.candidatos[0]!.motivo).toBe('Quantidade e preço compatíveis');
  });

  it('fora da tolerância: vai para "outros do fornecedor" e o motivo (os desvios) leva o sufixo', () => {
    const r = montarFilial([pcMatriz()], itemNf({ quantidadeKg: 19000, kgPorSequencia: { 1: 19000 } }));
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.outrosDoFornecedor).toHaveLength(1);
    expect(r.pc.outrosDoFornecedor[0]!.outroCadastro).toBe(true);
    expect(r.pc.outrosDoFornecedor[0]!.motivo).toBe(`Quantidade 5,6% acima do saldo · ${SUFIXO}`);
    expect(r.situacao).toBe('escolha_necessaria');
  });

  it('número do pedido da NF casando com o PC da matriz: "Número do pedido na NF · …" e pré-seleção', () => {
    const r = montarFilial([pcMatriz()], itemNf({ numeroPedidoNf: '306' }));
    expect(r.pc.candidatos[0]!.casaNumeroPedidoNf).toBe(true);
    expect(r.pc.candidatos[0]!.motivo).toBe(`Número do pedido na NF · ${SUFIXO}`);
    expect(r.pc.preSelecionado).toEqual({ nCodPed: pcMatriz().nCodPed, nCodItem: pcMatriz().nCodItem });
  });

  it('cadastro do PC sem CNPJ legível: o sufixo perde o "(CNPJ …)" mas o selo fica', () => {
    const r = montarFilial([pcMatriz({ cnpjCadastro: '' })]);
    expect(r.pc.candidatos[0]!.outroCadastro).toBe(true);
    expect(r.pc.candidatos[0]!.motivo).toBe('Quantidade e preço compatíveis · em outro cadastro do fornecedor');
  });

  it('PC aguardando aprovação em outro cadastro também entra (visível, não selecionável) com o selo', () => {
    const r = montarFilial([pcMatriz({ etapa: '10' })]);
    expect(r.possivel).toBe(false);
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.aguardandoAprovacao.map((c) => [c.pcNumero, c.outroCadastro])).toEqual([['306', true]]);
    expect(r.motivoSemPc).toBe('pc_aguardando_aprovacao');
  });

  it('ficam de fora: outra raiz, sem saldo, fora das etapas 10/15, PC-espelho e unidade não comparável', () => {
    const r = montarFilial([
      pcMatriz({ raizCnpj: '99999999' }),
      pcMatriz({ nCodItem: 2, saldoCopiaKg: 0 }),
      pcMatriz({ nCodItem: 3, etapa: '20' }),
      pcMatriz({ nCodItem: 4, pcEspelho: true }),
      pcMatriz({ nCodItem: 5, unidade: 'UN', precoKg: null }),
    ]);
    expect(r.possivel).toBe(false);
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.outrosDoFornecedor).toEqual([]);
    expect(r.pc.aguardandoAprovacao).toEqual([]);
    expect(r.motivoSemPc).toBe('sem_pc');
    expect(r.pc.semPcMotivo).toBe('O fornecedor não tem pedido de compra aprovado com saldo para este item.');
  });

  it('com PC no próprio cadastro e na matriz: os dois são candidatos, cada um com o seu selo, na ordem D3', () => {
    // mesmo preço e previsão: desempata pelo nCodPed (o da matriz tem nCodPed 555 < 8516905979)
    const r = montarFilial([pcCopia({ nCodFor: FILIAL }), pcMatriz({ nCodPed: 555, nCodItem: 556 })]);
    expect(r.pc.candidatos.map((c) => [c.pcNumero, c.outroCadastro])).toEqual([['306', true], ['304', false]]);
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.situacao).toBe('escolha_necessaria');
  });

  it('sem a raiz do fornecedor da NF (CPF ou fornecedor desconhecido) o PC de outro cadastro NÃO é oferecido', () => {
    const r = montarPcDoItem(itemNf(), contexto([pcMatriz()]), FILIAL, CHAVE_NF, TOL);
    expect(r.possivel).toBe(false);
    expect(r.pc.candidatos).toEqual([]);
    expect(montarPcDoItem(itemNf(), contexto([pcMatriz()], [], raizZaraplast), null, CHAVE_NF, TOL).possivel).toBe(false);
  });

  it('PC de outro cadastro sem raiz (cadastro de CPF ou sem CNPJ) não é oferecido, mesmo com a raiz da NF conhecida', () => {
    const r = montarFilial([pcMatriz({ raizCnpj: null, cnpjCadastro: '12345678901' })]);
    expect(r.possivel).toBe(false);
  });

  it('o PC de outro cadastro respeita o saldo e as reservas, como qualquer candidato', () => {
    const uso: UsoPcAtlas = { nCodItemPed: NCODITEM_304, nfChaveAcesso: OUTRA_CHAVE, status: 'confirmado', qtdKg: 18000, emMs: AGORA - 1000 };
    const r = montarPcDoItem(itemNf(), contexto([pcMatriz()], [uso], raizZaraplast), FILIAL, CHAVE_NF, TOL);
    expect(r.possivel).toBe(false); // reserva de outra NF zera o saldo do item de PC
  });

  it('o vínculo do OMIE que aponta o PC da matriz leva o selo, é elegível e pré-selecionado', () => {
    const r = montarFilial([pcMatriz()], itemNf({ vinculos: [VINCULO_304] }));
    expect(r.pc.vinculoOmie?.outroCadastro).toBe(true);
    expect(r.pc.vinculoOmie?.cnpjCadastro).toBe('61827663000179');
    expect(r.pc.vinculoOmieElegivel).toBe(true);
    expect(r.situacao).toBe('vinculado_omie');
  });

  it('o texto não leva id do OMIE (ACXEGDP-313)', () => {
    const r = montarFilial([pcMatriz(), pcMatriz({ nCodPed: 123, nCodItem: 124, pcNumero: '310', etapa: '10' })]);
    for (const t of textosDaTela(r)) expect(t).not.toMatch(/\d{10}/);
  });

  it('a escolha do PC da matriz é aceita (origem sugestão), sem justificativa, e entra no retrato oferecido', () => {
    const item = itemNf();
    const v = validarEscolhaPc({
      notaFiscal: '60199', fornecedorNome: 'Zaraplast S/A', itemDescricao: item.descricao, indice: 0, sequencias: [1], vinculos: [],
      resultado: montarFilial([pcMatriz()], item), escolha: escolhaDo304(), quantidadeKg: 18000, precoNfKg: item.precoNfKg,
      kgPorSequencia: item.kgPorSequencia, unidadeNf: 'KG', fatorUnidadeNf: 1,
    })!;
    expect(v.origem).toBe('sugestao');
    expect(v.candidato.outroCadastro).toBe(true);
    expect(v.justificativa).toBeNull();
    expect(v.oferecidos.map((o) => o.pcNumero)).toEqual(['306']);
  });
});

describe('montarPcDoItem — linhas ligadas a PCs diferentes (vinculosDivergentes)', () => {
  const item = () => itemNf({ vinculos: [VINCULO_304, VINCULO_302], sequencias: [1, 2], kgPorSequencia: { 1: 9000, 2: 9000 } });

  it('o alerta cita os PCs quando todos estão na cópia', () => {
    expect(montar(item(), [pc304(), pc302()]).pc.alertaVinculoOmie).toBe(
      'As linhas deste item estão vinculadas a pedidos de compra diferentes no OMIE (PCs 304 e 302). Escolha um pedido para o item inteiro.',
    );
  });

  it('com um PC fora da cópia, o alerta não cita números', () => {
    expect(montar(item(), [pc304()]).pc.alertaVinculoOmie).toBe(
      'As linhas deste item estão vinculadas a pedidos de compra diferentes no OMIE. Escolha um pedido para o item inteiro.',
    );
  });

  it('sem PC possível: vinculo_invalido (recusa nos dois modos — FR-011a), nunca sem_pc', () => {
    const r = montar(item(), []);
    expect(r.possivel).toBe(false);
    expect(r.motivoSemPc).toBe('vinculo_invalido');
    expect(r.situacao).toBe('sem_pc');
    expect(r.pc.semPcMotivo).toBe(
      'Os pedidos vinculados no OMIE às linhas deste item não podem ser usados e o fornecedor não tem outro pedido de compra aprovado com saldo.',
    );
  });

  it('vinculo_invalido tem precedência sobre PC aguardando aprovação', () => {
    expect(montar(item(), [pc304({ etapa: '10' })]).motivoSemPc).toBe('vinculo_invalido');
  });

  it('a escolha validada carrega a divergência e o vínculo lido de cada linha (base do 409 e "anterior" por linha)', () => {
    const v = escolher(item(), [pc304(), pc302()], escolhaDo304({ justificativa: 'Um pedido só para o item' }))!;
    expect(v.vinculosDivergentes).toBe(true);
    expect(v.vinculosPorSequencia).toEqual({
      1: { nIdPedido: NCODPED_304, nIdItPedido: NCODITEM_304 },
      2: { nIdPedido: NCODPED_302, nIdItPedido: NCODITEM_302 },
    });
    expect(v.nCodItemOmieVisto).toBeNull();
  });

  it('item sem divergência: vinculosDivergentes false e o retrato só com as linhas vinculadas', () => {
    const v = escolher(itemNf({ vinculos: [VINCULO_304], sequencias: [1, 2], kgPorSequencia: { 1: 9000, 2: 9000 } }), [pc304()], escolhaDo304())!;
    expect(v.vinculosDivergentes).toBe(false);
    expect(v.vinculosPorSequencia).toEqual({ 1: { nIdPedido: NCODPED_304, nIdItPedido: NCODITEM_304 } });
  });
});

describe('NfSemPcError — item que o Atlas não recebe (unidade) e sem PC no OMIE', () => {
  it('só itens de unidade: orienta o fiscal e não diz que compras foi avisada', () => {
    const e = new NfSemPcError('60199', 'Zaraplast S/A', [{ descricao: 'TAMPA ', motivo: 'unidade' }]);
    expect(e.message).toBe(
      'A NF 60199 (Zaraplast S/A) tem item que o Atlas não recebe (unidade não convertida para kg) e sem pedido de compra vinculado no OMIE (TAMPA). Peça ao fiscal para corrigir a unidade ou concluir o recebimento desta NF no OMIE, vinculando o pedido.',
    );
    expect(e.message).not.toContain('Compras');
  });

  it('com item sem PC e item de unidade: as duas orientações, a de compras primeiro', () => {
    const e = new NfSemPcError('60199', null, [
      { descricao: 'MC PEAD ES', motivo: 'sem_pc' },
      { descricao: 'TAMPA', motivo: 'unidade' },
      { descricao: 'ROTULO', motivo: 'unidade' },
    ]);
    expect(e.message).toContain('tem item sem pedido de compra no OMIE (MC PEAD ES). A equipe de Compras foi avisada.');
    expect(e.message).toContain('Além disso, os itens TAMPA, ROTULO não podem ser recebidos pelo Atlas (unidade não convertida para kg) e não têm pedido de compra vinculado no OMIE');
  });
});

describe('montarPcDoItem — vínculo PARCIAL a PC de outro cadastro (achado fiscal-r01, revisto após o T033)', () => {
  // Antes do T033 o vínculo parcial a PC de outro cadastro era inelegível (o Atlas não sabia se o
  // ASSOCIAR-PEDIDO entre cadastros funcionava). O OMIE aceitou em 22/10/2026: o vínculo segue elegível e
  // o Atlas associa a linha que falta ao mesmo PC.
  const FILIAL = 3098999518;
  const MATRIZ = 7974140605;
  const pcMatriz = (over: Partial<PcCopia> = {}) => pcCopia({ nCodFor: MATRIZ, pcNumero: '302', cnpjCadastro: '61827663000179', raizCnpj: '61827663', ...over });
  const item2Linhas = (vinculos: VinculoLinhaOmie[]) =>
    itemNf({ sequencias: [1, 2], kgPorSequencia: { 1: 9000, 2: 9000 }, vinculos });
  const VINC_1 = { nSequencia: 1, nIdPedido: NCODPED_304, nIdItPedido: NCODITEM_304 };
  const VINC_2 = { nSequencia: 2, nIdPedido: NCODPED_304, nIdItPedido: NCODITEM_304 };
  const montarFilial = (item: ItemParaSugestao, pcs: PcCopia[]) =>
    montarPcDoItem(item, contexto(pcs, [], new Map([[FILIAL, '61827663']])), FILIAL, CHAVE_NF, TOL);

  it('só uma das linhas ligada ao PC da matriz: o vínculo segue ELEGÍVEL, com o selo de outro cadastro e pré-selecionado', () => {
    const r = montarFilial(item2Linhas([VINC_1]), [pcMatriz()]);
    expect(r.pc.vinculoOmie?.pcNumero).toBe('302');
    expect(r.pc.vinculoOmie?.outroCadastro).toBe(true);
    expect(r.pc.vinculoOmieElegivel).toBe(true);
    expect(r.pc.preSelecionado).toEqual({ nCodPed: NCODPED_304, nCodItem: NCODITEM_304 });
    expect(r.pc.alertaVinculoOmie).toBeNull();
    expect(r.possivel).toBe(true);
    expect(r.motivoSemPc).toBeNull();
    expect(r.situacao).toBe('vinculado_omie');
  });

  it('as duas linhas ligadas ao PC da matriz: segue elegível (o OMIE já aceitou o vínculo inteiro)', () => {
    const r = montarFilial(item2Linhas([VINC_1, VINC_2]), [pcMatriz()]);
    expect(r.pc.vinculoOmieElegivel).toBe(true);
    expect(r.situacao).toBe('vinculado_omie');
  });

  it('vínculo parcial a PC do PRÓPRIO cadastro da nota: segue elegível (o Atlas associa a linha que falta)', () => {
    const r = montarFilial(item2Linhas([VINC_1]), [pcCopia({ nCodFor: FILIAL })]);
    expect(r.pc.vinculoOmieElegivel).toBe(true);
    expect(r.pc.vinculoOmie?.outroCadastro).toBe(false);
  });

  it('PC da cópia sem fornecedor (ncodfor nulo -> 0): não marca nada', () => {
    const r = montarFilial(item2Linhas([VINC_1]), [pcMatriz({ nCodFor: 0 })]);
    expect(r.pc.vinculoOmieElegivel).toBe(true);
    expect(r.pc.vinculoOmie?.outroCadastro).toBe(false);
  });

  it('com outro PC possível do cadastro da nota: o vínculo continua elegível e o outro vira candidato (o operador pode trocar)', () => {
    const r = montarFilial(item2Linhas([VINC_1]), [pcMatriz(), pcCopia({ nCodFor: FILIAL, nCodPed: 555, nCodItem: 556, pcNumero: '310' })]);
    expect(r.pc.vinculoOmieElegivel).toBe(true);
    expect(r.possivel).toBe(true);
    expect(r.pc.candidatos.map((c) => c.pcNumero)).toEqual(['310']);
    expect(r.pc.preSelecionado).toEqual({ nCodPed: NCODPED_304, nCodItem: NCODITEM_304 });
  });

  it('manter o vínculo parcial a PC de outro cadastro não exige justificativa (dentro da tolerância, sem troca)', () => {
    const item = item2Linhas([VINC_1]);
    const v = validarEscolhaPc({
      notaFiscal: '60199', fornecedorNome: 'Zaraplast S/A', itemDescricao: item.descricao, indice: 0, sequencias: [1, 2],
      vinculos: item.vinculos, resultado: montarFilial(item, [pcMatriz()]), escolha: escolhaDo304(), quantidadeKg: 18000,
      precoNfKg: item.precoNfKg, kgPorSequencia: item.kgPorSequencia, unidadeNf: 'KG', fatorUnidadeNf: 1,
    })!;
    expect(v.origem).toBe('omie');
    expect(v.justificativa).toBeNull();
    expect(v.nCodPedOmieAnterior).toBeNull();
  });
});
