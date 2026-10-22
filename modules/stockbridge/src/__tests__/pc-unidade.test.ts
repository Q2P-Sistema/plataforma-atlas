import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Feature 017 (ACXEGDP-437), 22/10/2026 — TRAVA DE UNIDADE (STOCKBRIDGE_PC_UNIDADE_DIFERENTE).
//
// Na conclusao do recebimento o OMIE grava em nQtdeRec do PC a quantidade recebida do item NA UNIDADE DA
// NF, sem converter: a NF 60199 (toneladas) baixou o PC 306 (kg) com 8,25 / 13,75 / 5,5 em vez de 8.250 /
// 13.750 / 5.500 kg. Dois modos:
//   'bloquear' (padrao) — o PC em unidade diferente da NF NAO e oferecido (lista `unidadeIncompativel`), o
//       vinculo do OMIE nessa situacao fica inelegivel e a releitura ao vivo recusa;
//   'converter' — o PC e oferecido normalmente e o EDITAR do fiscal manda itensAjustes.nQtdeRecebida ja na
//       unidade do PC (a reserva devolve ReservaPc.nQtdeRecebida).
//
// Cobre, sem rede e sem banco: A. as funcoes de configuracao; B. montarPcDoItem nos dois modos; C. a sugestao
// por NF (sugerirPcPorItens le a chave); D. validarEscolhaPc; E. relerEReservarPcs (releitura ao vivo e
// nQtdeRecebida). O EDITAR (planejarAcoes/editarItem) e provado em recebimento-fiscal-pc.test.ts.

const mocks = vi.hoisted(() => ({
  consultarPedidoCompra: vi.fn(),
  connect: vi.fn(),
  poolQuery: vi.fn(),
  config: {} as Record<string, unknown>,
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getPool: () => ({ connect: () => mocks.connect(), query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params) }),
  getConfig: () => mocks.config,
}));
vi.mock('@atlas/integration-omie', () => ({
  consultarPedidoCompra: (...args: unknown[]) => mocks.consultarPedidoCompra(...args),
}));
// O cache de PCs vistos (0057) nao e assunto aqui: vazio.
vi.mock('../services/pc-visto.service.js', () => ({
  registrarPcsVistosSeVencido: vi.fn().mockResolvedValue(undefined),
  lerPcsVistos: vi.fn().mockResolvedValue([]),
}));

import {
  modoUnidadeDiferentePc,
  exigeMesmaUnidadePc,
  opcoesPc,
  rotuloUnidade,
  montarPcDoItem,
  sugerirPcPorItens,
  validarEscolhaPc,
  relerEReservarPcs,
  NfSemPcError,
  PcNaoElegivelError,
  PcVinculoInvalidoError,
  type ContextoPc,
  type EscolhaPc,
  type EscolhaPcValidada,
  type ItemParaSugestao,
  type PcCandidato,
  type PcCopia,
  type ResultadoPcItem,
  type VinculoLinhaOmie,
} from '../services/pc-sugestao.service.js';

const TOL = { qtd: 0.02, preco: 0.01 };
const CHAVE_NF = '35261061827663001302550010000601991000601990';
const AGORA = Date.UTC(2026, 9, 22, 18, 0, 0);
const FORNECEDOR = 3098999518;

const PED_306 = 7974140306;
const IT_306 = 7974140311;
const PED_307 = 7974140307;
const IT_307 = 7974140321;
const PED_310 = 7974140310;
const IT_310 = 7974140319;

beforeEach(() => {
  for (const k of Object.keys(mocks.config)) delete mocks.config[k];
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Item de PC da copia: PC 306, 13.750 kg a R$ 10,80/kg, etapa 15. `unidade` do PC no OMIE. */
function pc(over: Partial<PcCopia> = {}): PcCopia {
  return {
    nCodPed: PED_306,
    nCodItem: IT_306,
    pcNumero: '306',
    etapa: '15',
    nCodFor: FORNECEDOR,
    produtoDescricao: 'MC PEAD ES',
    qtdPedidaKg: 13750,
    saldoCopiaKg: 13750,
    precoKg: 10.8,
    unidade: 'KG',
    dtPrevisao: '2026-11-05',
    atualizadoEmMs: AGORA - 600_000,
    pcEspelho: false,
    cnpjCadastro: '61827663000130',
    raizCnpj: '61827663',
    fonte: 'copia',
    ...over,
  };
}

/** Item da NF 60199: 8.250 kg = 8,25 t, a NF em TONELADAS por padrao. */
function itemNf(over: Partial<ItemParaSugestao> = {}): ItemParaSugestao {
  return {
    indice: 0,
    descricao: 'MC PEBD LD',
    quantidadeKg: 8250,
    unidadeNf: 'TON',
    fatorUnidadeNf: 1000,
    precoNfKg: 10.8,
    precoItemKg: 10.8,
    numeroPedidoNf: null,
    vinculos: [],
    sequencias: [1],
    kgPorSequencia: { 1: 8250 },
    ...over,
  };
}
const NF_EM_KG: Partial<ItemParaSugestao> = { unidadeNf: 'KG', fatorUnidadeNf: 1 };

const VINCULO_306: VinculoLinhaOmie = { nSequencia: 1, nIdPedido: PED_306, nIdItPedido: IT_306 };

const ctx = (pcs: PcCopia[]): ContextoPc => ({ pcs, usos: [], agoraMs: AGORA, raizPorFornecedor: new Map([[FORNECEDOR, '61827663']]) });
const BLOQUEAR = { exigeMesmaUnidade: true };
const CONVERTER = { exigeMesmaUnidade: false };
const montar = (item: ItemParaSugestao, pcs: PcCopia[], opcoes?: { exigeMesmaUnidade: boolean }): ResultadoPcItem =>
  montarPcDoItem(item, ctx(pcs), FORNECEDOR, CHAVE_NF, TOL, opcoes);

// ═══ A. Configuracao ═════════════════════════════════════════════════════════

describe('STOCKBRIDGE_PC_UNIDADE_DIFERENTE — modoUnidadeDiferentePc / exigeMesmaUnidadePc / opcoesPc', () => {
  it('padrão (variável ausente): bloquear — o PC em unidade diferente não é oferecido', () => {
    expect(modoUnidadeDiferentePc()).toBe('bloquear');
    expect(exigeMesmaUnidadePc()).toBe(true);
    expect(opcoesPc()).toEqual({ exigeMesmaUnidade: true });
  });

  it("'converter' liga o modo de conversão: exigeMesmaUnidade passa a false", () => {
    mocks.config.STOCKBRIDGE_PC_UNIDADE_DIFERENTE = 'converter';
    expect(modoUnidadeDiferentePc()).toBe('converter');
    expect(exigeMesmaUnidadePc()).toBe(false);
    expect(opcoesPc()).toEqual({ exigeMesmaUnidade: false });
  });

  it.each(['bloquear', 'xpto', '', 'CONVERTER', null, undefined, 1])('valor %j que não é exatamente "converter" cai em bloquear (modo seguro)', (valor) => {
    mocks.config.STOCKBRIDGE_PC_UNIDADE_DIFERENTE = valor;
    expect(modoUnidadeDiferentePc()).toBe('bloquear');
    expect(exigeMesmaUnidadePc()).toBe(true);
  });
});

describe('rotuloUnidade', () => {
  it.each([
    ['KG', 'kg'],
    ['kg', 'kg'],
    [' KG ', 'kg'],
    ['T', 'toneladas'],
    ['TON', 'toneladas'],
    ['ton', 'toneladas'],
    ['TL', 'toneladas'],
    ['UN', 'UN'],
    ['saco', 'SACO'],
    ['', 'unidade desconhecida'],
    ['   ', 'unidade desconhecida'],
    [null, 'unidade desconhecida'],
    [undefined, 'unidade desconhecida'],
  ])('%j -> %s', (entrada, esperado) => {
    expect(rotuloUnidade(entrada as string | null | undefined)).toBe(esperado);
  });
});

// ═══ B. montarPcDoItem — modo bloquear ═══════════════════════════════════════

describe('montarPcDoItem — modo bloquear (padrão): PC em unidade diferente da NF não é oferecido', () => {
  it('NF em toneladas e PC em kg: o PC vai para unidadeIncompativel, com o motivo do exemplo 8,25 × 8.250, e nunca para candidatos/outros', () => {
    const r = montar(itemNf(), [pc()], BLOQUEAR);
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.outrosDoFornecedor).toEqual([]);
    expect(r.pc.aguardandoAprovacao).toEqual([]);
    expect(r.pc.unidadeIncompativel).toHaveLength(1);
    const c = r.pc.unidadeIncompativel[0]!;
    expect(c.pcNumero).toBe('306');
    expect(c.unidade).toBe('KG');
    expect(c.motivo).toBe('PC em kg e nota em toneladas: o OMIE baixaria o pedido com 8,25 em vez de 8.250 kg');
  });

  it('sem outro PC: possivel false, motivoSemPc "unidade_pc", semPcMotivo explicando e situacao sem_pc', () => {
    const r = montar(itemNf(), [pc()], BLOQUEAR);
    expect(r.possivel).toBe(false);
    expect(r.motivoSemPc).toBe('unidade_pc');
    expect(r.situacao).toBe('sem_pc');
    expect(r.pc.preSelecionado).toBeNull();
    expect(r.pc.semPcMotivo).toBe(
      'O PC 306 está em kg e a nota em toneladas: o OMIE baixaria o pedido na unidade da nota, sem converter. Peça à equipe de Compras um pedido na unidade da nota.',
    );
  });

  it('o padrão sem o 6º argumento é bloquear (assinatura antiga dos chamadores)', () => {
    const r = montarPcDoItem(itemNf(), ctx([pc()]), FORNECEDOR, CHAVE_NF, TOL);
    expect(r.motivoSemPc).toBe('unidade_pc');
  });

  it('PC em kg do mesmo fornecedor continua oferecido para a NF em kg (mesma unidade)', () => {
    const r = montar(itemNf(NF_EM_KG), [pc()], BLOQUEAR);
    expect(r.pc.unidadeIncompativel).toEqual([]);
    expect(r.pc.candidatos.map((c) => c.pcNumero)).toEqual(['306']);
    expect(r.possivel).toBe(true);
  });

  it('NF em toneladas e PC em toneladas: mesma unidade, candidato normal', () => {
    const r = montar(itemNf(), [pc({ unidade: 'TON' })], BLOQUEAR);
    expect(r.pc.unidadeIncompativel).toEqual([]);
    expect(r.pc.candidatos).toHaveLength(1);
  });

  it.each([
    ['TL', 'TON'],
    ['TON', 'T'],
    ['TL', 'T'],
  ])('a comparação é pelo fator, não pelo texto: NF em %s e PC em %s são a mesma unidade', (unidadeNf, unidadePc) => {
    const r = montar(itemNf({ unidadeNf }), [pc({ unidade: unidadePc })], BLOQUEAR);
    expect(r.pc.unidadeIncompativel).toEqual([]);
    expect(r.pc.candidatos).toHaveLength(1);
  });

  it('NF em kg e PC em toneladas também é unidade diferente (o sentido inverso)', () => {
    const r = montar(itemNf(NF_EM_KG), [pc({ unidade: 'TON' })], BLOQUEAR);
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.unidadeIncompativel.map((c) => c.pcNumero)).toEqual(['306']);
    expect(r.pc.unidadeIncompativel[0]!.motivo).toMatch(/^PC em toneladas e nota em kg: /);
    expect(r.pc.semPcMotivo).toContain('O PC 306 está em toneladas e a nota em kg');
  });

  it('sem fator da unidade da NF (fatorUnidadeNf null) não há como comparar: nenhuma trava, PC oferecido', () => {
    const r = montar(itemNf({ unidadeNf: '', fatorUnidadeNf: null }), [pc()], BLOQUEAR);
    expect(r.pc.unidadeIncompativel).toEqual([]);
    expect(r.pc.candidatos).toHaveLength(1);
  });

  it('PC de unidade não comparável (UN) segue fora de tudo: não é "unidade incompatível" (o pedido nem entra na sugestão)', () => {
    const r = montar(itemNf(), [pc({ unidade: 'UN', precoKg: null })], BLOQUEAR);
    expect(r.pc.unidadeIncompativel).toEqual([]);
    expect(r.pc.candidatos).toEqual([]);
    expect(r.motivoSemPc).toBe('sem_pc');
  });

  it('só PCs aprovados (etapa 15) com saldo contam: PC sem saldo ou fora da etapa 15 em unidade diferente não vira "unidade incompatível"', () => {
    const r = montar(itemNf(), [pc({ nCodItem: 1, saldoCopiaKg: 0 }), pc({ nCodItem: 2, etapa: '20' })], BLOQUEAR);
    expect(r.pc.unidadeIncompativel).toEqual([]);
    expect(r.motivoSemPc).toBe('sem_pc');
  });

  it('PC aguardando aprovação (etapa 10) em unidade diferente segue em "aguardando aprovação" (a unidade só trava o que seria selecionável)', () => {
    const r = montar(itemNf(), [pc({ etapa: '10' })], BLOQUEAR);
    expect(r.pc.aguardandoAprovacao.map((c) => c.pcNumero)).toEqual(['306']);
    expect(r.pc.unidadeIncompativel).toEqual([]);
    expect(r.motivoSemPc).toBe('pc_aguardando_aprovacao');
  });

  it('a unidade vale mesmo fora da tolerância: PC em kg com quantidade e preço fora continua "unidade incompatível" (não vai para "outros")', () => {
    const r = montar(itemNf({ quantidadeKg: 30000, kgPorSequencia: { 1: 30000 }, precoNfKg: 14 }), [pc()], BLOQUEAR);
    expect(r.pc.outrosDoFornecedor).toEqual([]);
    expect(r.pc.unidadeIncompativel).toHaveLength(1);
    expect(r.pc.unidadeIncompativel[0]!.dentroTolerancia).toBe(false);
  });

  it('PC-espelho (importação) em unidade diferente nunca aparece, nem em "unidade incompatível"', () => {
    const r = montar(itemNf(), [pc({ pcEspelho: true })], BLOQUEAR);
    expect(r.pc.unidadeIncompativel).toEqual([]);
    expect(r.motivoSemPc).toBe('sem_pc');
  });

  it('PC compatível convive com PC incompatível: só o compatível é candidato, o outro fica na lista de unidade; há PC possível e nada de motivoSemPc', () => {
    const r = montar(itemNf(), [pc({ unidade: 'TON', nCodPed: PED_307, nCodItem: IT_307, pcNumero: '307' }), pc()], BLOQUEAR);
    expect(r.pc.candidatos.map((c) => c.pcNumero)).toEqual(['307']);
    expect(r.pc.unidadeIncompativel.map((c) => c.pcNumero)).toEqual(['306']);
    expect(r.possivel).toBe(true);
    expect(r.motivoSemPc).toBeNull();
    expect(r.pc.semPcMotivo).toBeNull();
    expect(r.situacao).toBe('sugerido');
  });

  it('vários PCs em unidade diferente: texto no plural, numerados, sem repetir', () => {
    const r = montar(itemNf(), [pc(), pc({ nCodPed: PED_307, nCodItem: IT_307, pcNumero: '307' }), pc({ nCodItem: 99 })], BLOQUEAR);
    expect(r.pc.unidadeIncompativel.map((c) => c.pcNumero).sort()).toEqual(['306', '306', '307']);
    expect(r.pc.semPcMotivo).toBe(
      'Os PCs 306 e 307 estão em kg e a nota em toneladas: o OMIE baixaria o pedido na unidade da nota, sem converter. Peça à equipe de Compras um pedido na unidade da nota.',
    );
  });

  it('a lista de unidade incompatível segue a ordem D3 (número do pedido na NF, depois menor diferença de preço)', () => {
    const r = montar(
      itemNf({ numeroPedidoNf: '307' }),
      [pc(), pc({ nCodPed: PED_307, nCodItem: IT_307, pcNumero: '307', precoKg: 11 })],
      BLOQUEAR,
    );
    expect(r.pc.unidadeIncompativel.map((c) => c.pcNumero)).toEqual(['307', '306']);
  });

  it('PC em unidade diferente + PC em outro cadastro compatível: o de outro cadastro é oferecido, o outro fica na lista de unidade', () => {
    const matriz = 7974140605;
    const r = montar(itemNf(), [pc({ unidade: 'TON', nCodFor: matriz, nCodPed: PED_307, nCodItem: IT_307, pcNumero: '307', cnpjCadastro: '61827663000179' }), pc()], BLOQUEAR);
    expect(r.pc.candidatos.map((c) => [c.pcNumero, c.outroCadastro])).toEqual([['307', true]]);
    expect(r.pc.unidadeIncompativel.map((c) => [c.pcNumero, c.outroCadastro])).toEqual([['306', false]]);
  });

  it('nenhum texto (motivo, alerta, semPcMotivo) leva id do OMIE (ACXEGDP-313)', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_306] }), [pc(), pc({ nCodPed: PED_307, nCodItem: IT_307, pcNumero: '307' })], BLOQUEAR);
    const textos = [r.pc.alertaVinculoOmie ?? '', r.pc.semPcMotivo ?? '', ...r.pc.unidadeIncompativel.map((c) => c.motivo), r.pc.vinculoOmie?.motivo ?? ''];
    for (const t of textos) expect(t).not.toMatch(/\d{10}/);
  });

  // ── vínculo do OMIE em unidade diferente ──

  describe('vínculo do OMIE em PC de unidade diferente', () => {
    it('fica visível mas INELEGÍVEL, com o alerta pedindo pedido na unidade da nota ou o fiscal pelo portal; nada pré-selecionado', () => {
      const r = montar(itemNf({ vinculos: [VINCULO_306] }), [pc()], BLOQUEAR);
      expect(r.pc.vinculoOmie?.pcNumero).toBe('306');
      expect(r.pc.vinculoOmieElegivel).toBe(false);
      expect(r.pc.preSelecionado).toBeNull();
      expect(r.pc.alertaVinculoOmie).toBe(
        'O PC 306 vinculado no OMIE está em kg e a nota em toneladas: o OMIE baixaria o pedido na unidade da nota, sem converter. ' +
          'Peça à equipe de Compras um pedido na unidade da nota, ou ao fiscal para concluir pelo portal.',
      );
    });

    it('sem outro PC: motivoSemPc "unidade_pc" (e não vinculo_invalido), com o PC do vínculo no texto', () => {
      const r = montar(itemNf({ vinculos: [VINCULO_306] }), [pc()], BLOQUEAR);
      expect(r.possivel).toBe(false);
      expect(r.motivoSemPc).toBe('unidade_pc');
      expect(r.situacao).toBe('sem_pc');
      expect(r.pc.semPcMotivo).toContain('O PC 306 está em kg e a nota em toneladas');
      // o vínculo não é repetido na lista de unidade (ehVinculo)
      expect(r.pc.unidadeIncompativel).toEqual([]);
    });

    it('com outro PC compatível do fornecedor: há PC possível; o vínculo segue inelegível e nada vem pré-selecionado (escolha do operador)', () => {
      const r = montar(
        itemNf({ vinculos: [VINCULO_306] }),
        [pc(), pc({ unidade: 'TON', nCodPed: PED_307, nCodItem: IT_307, pcNumero: '307' })],
        BLOQUEAR,
      );
      expect(r.possivel).toBe(true);
      expect(r.pc.vinculoOmieElegivel).toBe(false);
      expect(r.pc.candidatos.map((c) => c.pcNumero)).toEqual(['307']);
      expect(r.pc.preSelecionado).toBeNull();
      expect(r.situacao).toBe('escolha_necessaria');
      expect(r.motivoSemPc).toBeNull();
    });

    it('com outro PC também em unidade diferente: o texto lista os dois (vínculo e lista de unidade), no plural', () => {
      const r = montar(itemNf({ vinculos: [VINCULO_306] }), [pc(), pc({ nCodPed: PED_307, nCodItem: IT_307, pcNumero: '307' })], BLOQUEAR);
      expect(r.motivoSemPc).toBe('unidade_pc');
      expect(r.pc.semPcMotivo).toContain('Os PCs 306 e 307 estão em kg e a nota em toneladas');
    });

    it('vínculo em unidade diferente + PC aguardando aprovação: a unidade tem precedência no motivo', () => {
      const r = montar(
        itemNf({ vinculos: [VINCULO_306] }),
        [pc(), pc({ etapa: '10', nCodPed: PED_307, nCodItem: IT_307, pcNumero: '307' })],
        BLOQUEAR,
      );
      expect(r.motivoSemPc).toBe('unidade_pc');
    });

    it('vínculo na MESMA unidade da NF: elegível e pré-selecionado, sem alerta de unidade', () => {
      const r = montar(itemNf({ ...NF_EM_KG, vinculos: [VINCULO_306] }), [pc()], BLOQUEAR);
      expect(r.pc.vinculoOmieElegivel).toBe(true);
      expect(r.pc.alertaVinculoOmie).toBeNull();
      expect(r.situacao).toBe('vinculado_omie');
    });

    it('vínculo para PC-espelho (mesma unidade da NF) + PC do fornecedor em unidade diferente: continua "vinculo_invalido"', () => {
      const r = montar(
        itemNf({ ...NF_EM_KG, vinculos: [VINCULO_306] }),
        [pc({ pcEspelho: true }), pc({ unidade: 'TON', nCodPed: PED_307, nCodItem: IT_307, pcNumero: '307' })],
        BLOQUEAR,
      );
      expect(r.pc.vinculoOmieElegivel).toBe(false);
      expect(r.pc.unidadeIncompativel.map((c) => c.pcNumero)).toEqual(['307']);
      expect(r.motivoSemPc).toBe('vinculo_invalido');
    });

    it('linhas vinculadas a PCs diferentes (divergência) + PCs em unidade diferente: continua "vinculo_invalido" (a divergência é decidida antes)', () => {
      const r = montar(
        itemNf({
          vinculos: [VINCULO_306, { nSequencia: 2, nIdPedido: PED_307, nIdItPedido: IT_307 }],
          sequencias: [1, 2],
          kgPorSequencia: { 1: 4000, 2: 4250 },
        }),
        [pc(), pc({ nCodPed: PED_307, nCodItem: IT_307, pcNumero: '307' }), pc({ nCodPed: PED_310, nCodItem: IT_310, pcNumero: '310' })],
        BLOQUEAR,
      );
      expect(r.pc.vinculosDivergentes).toBe(true);
      expect(r.possivel).toBe(false);
      expect(r.motivoSemPc).toBe('vinculo_invalido');
      // os três PCs em kg ficam na lista de unidade (nenhum é o "vínculo" quando as linhas divergem)
      expect(r.pc.unidadeIncompativel.map((c) => c.pcNumero).sort()).toEqual(['306', '307', '310']);
    });
  });
});

// ═══ B2. montarPcDoItem — modo converter ═════════════════════════════════════

describe('montarPcDoItem — modo converter: o PC em unidade diferente é oferecido normalmente', () => {
  it('NF em toneladas e PC em kg: candidato dentro da tolerância, nada em unidadeIncompativel', () => {
    const r = montar(itemNf(), [pc()], CONVERTER);
    expect(r.pc.unidadeIncompativel).toEqual([]);
    expect(r.pc.candidatos.map((c) => [c.pcNumero, c.unidade, c.dentroTolerancia])).toEqual([['306', 'KG', true]]);
    expect(r.possivel).toBe(true);
    expect(r.motivoSemPc).toBeNull();
    expect(r.situacao).toBe('sugerido');
  });

  it('a avaliação continua em kg: o PC em kg com saldo menor que a NF fica fora da tolerância (não "baixa" por conversão)', () => {
    const r = montar(itemNf(), [pc({ saldoCopiaKg: 5000 })], CONVERTER);
    expect(r.pc.candidatos).toEqual([]);
    expect(r.pc.outrosDoFornecedor.map((c) => c.pcNumero)).toEqual(['306']);
  });

  it('vínculo do OMIE em PC de unidade diferente: elegível, sem alerta de unidade e pré-selecionado', () => {
    const r = montar(itemNf({ vinculos: [VINCULO_306] }), [pc()], CONVERTER);
    expect(r.pc.vinculoOmieElegivel).toBe(true);
    expect(r.pc.alertaVinculoOmie).toBeNull();
    expect(r.pc.preSelecionado).toEqual({ nCodPed: PED_306, nCodItem: IT_306 });
    expect(r.situacao).toBe('vinculado_omie');
  });

  it('a lista de unidade incompatível fica sempre vazia, com ou sem vínculo', () => {
    const r = montar(itemNf(), [pc(), pc({ nCodPed: PED_307, nCodItem: IT_307, pcNumero: '307', unidade: 'TON' })], CONVERTER);
    expect(r.pc.unidadeIncompativel).toEqual([]);
    expect(r.pc.candidatos).toHaveLength(2);
  });
});

// ═══ C. sugerirPcPorItens lê a chave ═════════════════════════════════════════

describe('sugerirPcPorItens — usa STOCKBRIDGE_PC_UNIDADE_DIFERENTE', () => {
  beforeEach(() => {
    mocks.poolQuery.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AGORA);
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes('tbl_pedidosCompras_')) {
        return Promise.resolve({
          rows: [
            {
              ncodped: String(PED_306), ncoditem: String(IT_306), cnumero: '306', cetapa: '15', ncodfor: String(FORNECEDOR),
              nqtde: 13750, nqtderec: 0, nvalunit: 10.8, cunidade: 'KG', ddtprevisao: '2026-11-05', cdescricao: 'MC PEAD ES', cproduto: null,
              atualizado_ms: AGORA - 600_000, valor_total_pc: 148500, fornecedor_acxe: false, cnpj_cadastro: '61827663000130',
            },
          ],
        });
      }
      if (sql.includes('AS codigo')) return Promise.resolve({ rows: [{ codigo: String(FORNECEDOR), cnpj: '61827663000130' }] });
      return Promise.resolve({ rows: [] });
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('padrão (bloquear): NF em toneladas com PC só em kg -> unidade_pc', async () => {
    const mapa = await sugerirPcPorItens('q2p', FORNECEDOR, CHAVE_NF, [itemNf()]);
    expect(mapa.get(0)!.motivoSemPc).toBe('unidade_pc');
    expect(mapa.get(0)!.pc.unidadeIncompativel.map((c) => c.pcNumero)).toEqual(['306']);
  });

  it("'converter': o mesmo PC é candidato", async () => {
    mocks.config.STOCKBRIDGE_PC_UNIDADE_DIFERENTE = 'converter';
    const mapa = await sugerirPcPorItens('q2p', FORNECEDOR, CHAVE_NF, [itemNf()]);
    expect(mapa.get(0)!.possivel).toBe(true);
    expect(mapa.get(0)!.pc.candidatos.map((c) => c.pcNumero)).toEqual(['306']);
    expect(mapa.get(0)!.pc.unidadeIncompativel).toEqual([]);
  });
});

// ═══ D. NfSemPcError — motivo unidade_pc ═════════════════════════════════════

describe('NfSemPcError — item cujo PC está em unidade diferente da nota (unidade_pc)', () => {
  it('só itens unidade_pc: orienta Compras a lançar o pedido na unidade da nota; a NF fica na fila até o ajuste', () => {
    const e = new NfSemPcError('60199', 'Zaraplast S/A', [{ descricao: 'MC PEBD LD ', motivo: 'unidade_pc' }]);
    expect(e.message).toBe(
      'A NF 60199 (Zaraplast S/A) tem item cujo pedido de compra está em unidade diferente da nota (MC PEBD LD): o OMIE baixaria o pedido na unidade da nota, sem converter. A equipe de Compras foi avisada para lançar o pedido na unidade da nota; a NF fica na fila até o ajuste.',
    );
  });

  it('vários itens unidade_pc: plural em itens e pedidos', () => {
    const e = new NfSemPcError('60199', null, [
      { descricao: 'MC PEBD LD', motivo: 'unidade_pc' },
      { descricao: 'MC PEAD ES', motivo: 'unidade_pc' },
    ]);
    expect(e.message).toBe(
      'A NF 60199 tem itens cujos pedidos de compra estão em unidade diferente da nota (MC PEBD LD, MC PEAD ES): o OMIE baixaria o pedido na unidade da nota, sem converter. A equipe de Compras foi avisada para lançar o pedido na unidade da nota; a NF fica na fila até o ajuste.',
    );
  });

  it('com item sem PC nenhum: as duas orientações, a de "sem PC" primeiro e a de unidade como complemento', () => {
    const e = new NfSemPcError('60199', null, [
      { descricao: 'TAMPA', motivo: 'sem_pc' },
      { descricao: 'MC PEBD LD', motivo: 'unidade_pc' },
    ]);
    expect(e.message).toContain('tem item sem pedido de compra no OMIE (TAMPA). A equipe de Compras foi avisada.');
    expect(e.message).toContain('Para MC PEBD LD, o pedido de compra do fornecedor está em unidade diferente da nota');
    expect(e.message).toContain('A equipe de Compras foi avisada para lançar o pedido na unidade da nota.');
    expect(e.message).not.toContain('a NF fica na fila até o ajuste.');
  });

  it('com item de unidade não convertida (Atlas não recebe): as três orientações em ordem', () => {
    const e = new NfSemPcError('60199', null, [
      { descricao: 'TAMPA', motivo: 'unidade' },
      { descricao: 'MC PEBD LD', motivo: 'unidade_pc' },
    ]);
    // unidade_pc sozinho com 'unidade': a parte de unidade_pc usa a forma completa e a de "unidade" abre com "Além disso"
    expect(e.message).toContain('tem item cujo pedido de compra está em unidade diferente da nota (MC PEBD LD)');
    expect(e.message).toContain('Além disso, o item TAMPA não pode ser recebido pelo Atlas');
    expect(e.message).not.toMatch(/\d{10}/);
  });

  it('pc_aguardando_aprovacao + unidade_pc: a aprovação vem primeiro e a unidade como complemento', () => {
    const e = new NfSemPcError('60199', null, [
      { descricao: 'TAMPA', motivo: 'pc_aguardando_aprovacao' },
      { descricao: 'MC PEBD LD', motivo: 'unidade_pc' },
    ]);
    expect(e.message.indexOf('aguardando aprovação')).toBeLessThan(e.message.indexOf('unidade diferente da nota'));
  });
});

// ═══ E. validarEscolhaPc ═════════════════════════════════════════════════════

function escolher(item: ItemParaSugestao, pcs: PcCopia[], escolha: EscolhaPc | null, opcoes = BLOQUEAR, extra: Partial<Parameters<typeof validarEscolhaPc>[0]> = {}) {
  return validarEscolhaPc({
    notaFiscal: '60199',
    fornecedorNome: 'Zaraplast S/A',
    itemDescricao: item.descricao,
    indice: item.indice,
    sequencias: item.sequencias,
    vinculos: item.vinculos,
    resultado: montar(item, pcs, opcoes),
    escolha,
    quantidadeKg: item.quantidadeKg ?? 0,
    precoNfKg: item.precoNfKg,
    kgPorSequencia: item.kgPorSequencia,
    unidadeNf: item.unidadeNf,
    fatorUnidadeNf: item.fatorUnidadeNf,
    ...extra,
  });
}
const escolhaDo306: EscolhaPc = { n_cod_ped: PED_306, n_cod_item: IT_306 };
function erroDe(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('a função deveria ter lançado');
}

describe('validarEscolhaPc — trava de unidade', () => {
  it('escolher um PC da lista de unidade incompatível: PcNaoElegivelError "está em kg e a nota em toneladas", citando o PC e sem id do OMIE', () => {
    const err = erroDe(() => escolher(itemNf(), [pc()], escolhaDo306));
    expect(err).toBeInstanceOf(PcNaoElegivelError);
    expect(err.message).toBe(
      'O PC 306 não pode ser vinculado ao item MC PEBD LD da NF 60199: está em kg e a nota em toneladas (o OMIE baixaria o pedido na unidade da nota).',
    );
    expect(err.message).not.toMatch(/\d{10}/);
  });

  it('o mesmo PC no modo converter é uma escolha válida (origem sugestão, sem justificativa)', () => {
    const v = escolher(itemNf(), [pc()], escolhaDo306, CONVERTER)!;
    expect(v.origem).toBe('sugestao');
    expect(v.justificativa).toBeNull();
    expect(v.candidato.pcNumero).toBe('306');
  });

  it('escolher o vínculo do OMIE inelegível por unidade: PcNaoElegivelError "o pedido vinculado no OMIE não pode ser usado aqui"', () => {
    const err = erroDe(() => escolher(itemNf({ vinculos: [VINCULO_306] }), [pc()], escolhaDo306));
    expect(err).toBeInstanceOf(PcNaoElegivelError);
    expect(err.message).toContain('o pedido vinculado no OMIE não pode ser usado aqui');
  });

  it('a escolha validada carrega a unidade da NF e o fator, para a releitura ao vivo recusar ou converter', () => {
    const v = escolher(itemNf(), [pc()], escolhaDo306, CONVERTER)!;
    expect(v.unidadeNf).toBe('TON');
    expect(v.fatorUnidadeNf).toBe(1000);
  });

  it('chamador que não informa a unidade da NF: unidadeNf "" e fatorUnidadeNf null (sem trava na releitura)', () => {
    const v = escolher(itemNf(NF_EM_KG), [pc()], escolhaDo306, BLOQUEAR, { unidadeNf: undefined, fatorUnidadeNf: undefined })!;
    expect(v.unidadeNf).toBe('');
    expect(v.fatorUnidadeNf).toBeNull();
  });

  it('chamador que não informa a unidade da NF recusa a escolha de PC incompatível citando "unidade desconhecida"', () => {
    const err = erroDe(() => escolher(itemNf(), [pc()], escolhaDo306, BLOQUEAR, { unidadeNf: undefined }));
    expect(err).toBeInstanceOf(PcNaoElegivelError);
    expect(err.message).toContain('está em kg e a nota em unidade desconhecida');
  });

  it('o retrato "oferecidos" não leva o PC em unidade incompatível (só vínculo do OMIE, candidatos e outros)', () => {
    const v = escolher(
      itemNf(),
      [pc({ unidade: 'TON', nCodPed: PED_307, nCodItem: IT_307, pcNumero: '307' }), pc()],
      { n_cod_ped: PED_307, n_cod_item: IT_307 },
    )!;
    expect(v.oferecidos.map((o) => o.pcNumero)).toEqual(['307']);
  });

  it('item sem PC possível por causa da unidade e sem escolha: devolve null (a regra de NF sem PC é do chamador)', () => {
    expect(escolher(itemNf(), [pc()], null)).toBeNull();
  });

  it('item com PC de unidade diferente E outro PC compatível, sem escolha: PcNaoEscolhidoError', () => {
    expect(() =>
      escolher(itemNf(), [pc(), pc({ unidade: 'TON', nCodPed: PED_307, nCodItem: IT_307, pcNumero: '307' })], null),
    ).toThrow(/Escolha o pedido de compra/);
  });
});

// ═══ F. relerEReservarPcs — releitura ao vivo ════════════════════════════════

interface ItemPedidoDuble {
  nCodItem: number;
  cUnidade: string | null;
  nQtde: number;
  nQtdeRec: number | null;
  nValUnit: number | null;
}

/** PC 306 como o ConsultarPedCompra o devolve: o item `IT_306` em `cUnidade`, com `nQtde`/`nQtdeRec` NESSA unidade. */
const pedidoOmie = (cUnidade: string, nQtde: number, nQtdeRec = 0, over: Record<string, unknown> = {}) => ({
  nCodPed: PED_306,
  cNumero: '306',
  cEtapa: '15',
  nCodFor: FORNECEDOR,
  produtos: [{ nCodItem: IT_306, cUnidade, nQtde, nQtdeRec, nValUnit: 10.8 } satisfies ItemPedidoDuble],
  ...over,
});

const candidato306 = (over: Partial<PcCandidato> = {}): PcCandidato => ({
  nCodPed: PED_306,
  nCodItem: IT_306,
  pcNumero: '306',
  produtoDescricao: 'MC PEAD ES',
  qtdPedidaKg: 13750,
  saldoKg: 13750,
  precoUnit: 10.8,
  precoNfKgComparado: 10.8,
  dtPrevisao: null,
  etapa: '15',
  dentroTolerancia: true,
  casaNumeroPedidoNf: false,
  semDadosLocais: false,
  motivo: 'Quantidade e preço compatíveis',
  outroCadastro: false,
  cnpjCadastro: '',
  dadosEmCache: false,
  unidade: 'KG',
  ...over,
});

/** Escolha validada de um item da NF 60199 (por padrão 8.250 kg numa sequência, NF em toneladas). */
function escolhaValidada(over: Partial<EscolhaPcValidada> = {}): EscolhaPcValidada {
  const c = over.candidato ?? candidato306();
  return {
    indice: 0,
    sequencias: [1],
    origem: 'sugestao',
    candidato: c,
    dentroTolerancia: true,
    justificativa: null,
    nCodPedOmieAnterior: null,
    nCodItemPedOmieAnterior: null,
    nCodItemOmieVisto: null,
    vinculosDivergentes: false,
    vinculosPorSequencia: {},
    oferecidos: [],
    qtdNfKg: 8250,
    precoNfKg: 10.8,
    kgPorSequencia: { 1: 8250 },
    itemDescricao: 'MC PEBD LD',
    unidadeNf: 'TON',
    fatorUnidadeNf: 1000,
    ...over,
  };
}

type Chamada = { sql: string; params: unknown[] };
let chamadas: Chamada[] = [];
let seqId = 0;
const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const client = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = norm(sql);
    chamadas.push({ sql: s, params });
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK' || s.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (s.startsWith('UPDATE stockbridge.recebimento_fiscal_pc')) return { rows: [], rowCount: 0 };
    if (s.includes('AS segundos')) return { rows: [] };
    if (s.includes('SUM(qtd_nf_kg)')) return { rows: [{ kg: reservasDeOutrasNfs }] };
    if (s.startsWith('INSERT INTO stockbridge.recebimento_fiscal_pc')) return { rows: [{ id: `reserva-${++seqId}` }] };
    throw new Error(`SQL inesperado no dublê do client: ${s.slice(0, 120)}`);
  }),
  release: vi.fn(),
};
let reservasDeOutrasNfs = 0;
const tiposChamados = (): string[] => chamadas.map((c) => c.sql.split(' ')[0]!);
const inserts = (): Chamada[] => chamadas.filter((c) => c.sql.startsWith('INSERT INTO stockbridge.recebimento_fiscal_pc'));

const ARGS_BASE = { empresa: 'q2p' as const, ledgerId: 'ledger-1', nfChaveAcesso: CHAVE_NF, notaFiscal: '60199', fornecedorCodigo: FORNECEDOR, userId: 'user-1' };
const reservar = (escolhas: EscolhaPcValidada[], over: Partial<Parameters<typeof relerEReservarPcs>[0]> = {}) =>
  relerEReservarPcs({ ...ARGS_BASE, escolhas, ...over });
async function falha(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('a chamada deveria ter rejeitado');
}

describe('relerEReservarPcs — trava de unidade na releitura ao vivo', () => {
  beforeEach(() => {
    chamadas = [];
    seqId = 0;
    reservasDeOutrasNfs = 0;
    client.query.mockClear();
    client.release.mockClear();
    mocks.connect.mockReset();
    mocks.connect.mockResolvedValue(client);
    mocks.poolQuery.mockReset();
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    mocks.consultarPedidoCompra.mockReset();
    mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie('KG', 13750));
  });

  describe("modo bloquear (padrão)", () => {
    it('PC em kg e NF em toneladas: PcVinculoInvalidoError "está em kg e a nota em toneladas — o OMIE baixaria o pedido na unidade da nota, sem converter"; ROLLBACK, sem INSERT', async () => {
      const err = await falha(reservar([escolhaValidada()]));
      expect(err).toBeInstanceOf(PcVinculoInvalidoError);
      expect(err.message).toBe(
        'O PC 306 não pode ser vinculado à NF 60199: está em kg e a nota em toneladas — o OMIE baixaria o pedido na unidade da nota, sem converter. Escolha outro PC.',
      );
      expect((err as PcVinculoInvalidoError).pc).toEqual({ nCodPed: PED_306, nCodItem: IT_306 });
      expect(err.message).not.toMatch(/\d{10}/);
      expect(tiposChamados()).toContain('ROLLBACK');
      expect(tiposChamados()).not.toContain('INSERT');
      expect(tiposChamados()).not.toContain('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('vale também para o vínculo que o próprio OMIE fez (origem omie, vínculo vivo): concluir com ele baixaria o PC errado do mesmo jeito', async () => {
      const e = escolhaValidada({ origem: 'omie' });
      const err = await falha(reservar([e], { vinculosVivos: { 1: { nIdPedido: PED_306, nIdItPedido: IT_306 } } }));
      expect(err).toBeInstanceOf(PcVinculoInvalidoError);
      expect(err.message).toContain('está em kg e a nota em toneladas');
    });

    it('NF em kg e PC em toneladas também recusa, com os rótulos trocados', async () => {
      mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie('TON', 13.75));
      const err = await falha(reservar([escolhaValidada({ unidadeNf: 'KG', fatorUnidadeNf: 1 })]));
      expect(err.message).toContain('está em toneladas e a nota em kg');
    });

    it('mesma unidade (PC em kg e NF em kg): passa, grava a reserva e nQtdeRecebida é null (nada a converter)', async () => {
      const r = await reservar([escolhaValidada({ unidadeNf: 'KG', fatorUnidadeNf: 1 })]);
      expect(r).toHaveLength(1);
      expect(r[0]!.nQtdeRecebida).toBeNull();
      expect(tiposChamados()).toContain('COMMIT');
    });

    it('mesma unidade em grafias diferentes (NF em TL, PC em TON): o que vale é o fator', async () => {
      mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie('TON', 13.75));
      const r = await reservar([escolhaValidada({ unidadeNf: 'TL', fatorUnidadeNf: 1000 })]);
      expect(r).toHaveLength(1);
      expect(r[0]!.nQtdeRecebida).toBeNull();
    });

    it('chamador que não informa a unidade da NF (fatorUnidadeNf null ou ausente): sem trava na releitura', async () => {
      expect(await reservar([escolhaValidada({ fatorUnidadeNf: null, unidadeNf: '' })])).toHaveLength(1);
      expect(await reservar([escolhaValidada({ fatorUnidadeNf: undefined as unknown as null })])).toHaveLength(1);
    });

    it('a trava vem antes do saldo: PC em unidade diferente e sem saldo é recusado pela UNIDADE, não por "não tem saldo disponível"', async () => {
      mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie('KG', 13750, 13750));
      const err = await falha(reservar([escolhaValidada()]));
      expect(err.message).toContain('está em kg e a nota em toneladas');
      expect(err.message).not.toContain('saldo');
    });

    it('a trava vem depois da checagem de etapa e de fornecedor: PC fora da etapa 15 é recusado pela etapa', async () => {
      mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie('KG', 13750, 0, { cEtapa: '10' }));
      const err = await falha(reservar([escolhaValidada()]));
      expect(err.message).toContain('aguardando aprovação');
    });

    it('com duas escolhas no mesmo item de PC e uma delas em unidade diferente da NF: recusa (cita a unidade da escolha que diverge)', async () => {
      const kg = escolhaValidada({ indice: 0, unidadeNf: 'KG', fatorUnidadeNf: 1 });
      const ton = escolhaValidada({ indice: 1, sequencias: [2], kgPorSequencia: { 2: 1000 }, qtdNfKg: 1000 });
      const err = await falha(reservar([kg, ton]));
      expect(err).toBeInstanceOf(PcVinculoInvalidoError);
      expect(err.message).toContain('está em kg e a nota em toneladas');
    });
  });

  describe("modo converter (STOCKBRIDGE_PC_UNIDADE_DIFERENTE='converter')", () => {
    beforeEach(() => {
      mocks.config.STOCKBRIDGE_PC_UNIDADE_DIFERENTE = 'converter';
    });

    it('PC em kg e NF em toneladas: passa, e a reserva devolve a quantidade da linha NA UNIDADE DO PC (8.250 kg -> 8250)', async () => {
      const r = await reservar([escolhaValidada()]);
      expect(r).toHaveLength(1);
      expect(r[0]!.nQtdeRecebida).toBe(8250);
      expect(tiposChamados()).toContain('COMMIT');
    });

    it('PC em toneladas e NF em kg: 8.250 kg -> 8,25', async () => {
      mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie('TON', 13.75));
      const r = await reservar([escolhaValidada({ unidadeNf: 'KG', fatorUnidadeNf: 1 })]);
      expect(r[0]!.nQtdeRecebida).toBe(8.25);
    });

    it('uma quantidade por SEQUÊNCIA: kg de cada linha convertidos separadamente (5.000 + 3.250 kg em PC de kg)', async () => {
      const r = await reservar([escolhaValidada({ sequencias: [1, 2], kgPorSequencia: { 1: 5000, 2: 3250 } })]);
      expect(r.map((x) => [x.nSequencia, x.nQtdeRecebida])).toEqual([[1, 5000], [2, 3250]]);
    });

    it('arredonda em 6 casas: 1.234,5678901 kg em PC de toneladas -> 1,234568', async () => {
      mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie('TON', 13.75));
      const r = await reservar([escolhaValidada({ unidadeNf: 'KG', fatorUnidadeNf: 1, qtdNfKg: 1234.5678901, kgPorSequencia: { 1: 1234.5678901 } })]);
      expect(r[0]!.nQtdeRecebida).toBe(1.234568);
    });

    it('sequência sem kg informado: 0 (nunca NaN)', async () => {
      const r = await reservar([escolhaValidada({ sequencias: [1, 7], kgPorSequencia: { 1: 8250 } })]);
      expect(r.map((x) => x.nQtdeRecebida)).toEqual([8250, 0]);
    });

    it('mesma unidade no modo converter: nQtdeRecebida continua null (o EDITAR não manda o campo)', async () => {
      const r = await reservar([escolhaValidada({ unidadeNf: 'KG', fatorUnidadeNf: 1 })]);
      expect(r[0]!.nQtdeRecebida).toBeNull();
    });

    it('sem fatorUnidadeNf (chamador antigo): null — não há como saber se a unidade difere', async () => {
      const r = await reservar([escolhaValidada({ fatorUnidadeNf: null, unidadeNf: '' })]);
      expect(r[0]!.nQtdeRecebida).toBeNull();
    });

    it('é por escolha: duas linhas no mesmo item de PC, uma da NF em toneladas e outra em kg, saem com e sem conversão', async () => {
      const ton = escolhaValidada({ indice: 0, sequencias: [1], kgPorSequencia: { 1: 8250 }, qtdNfKg: 8250 });
      const kg = escolhaValidada({ indice: 1, sequencias: [2], kgPorSequencia: { 2: 1000 }, qtdNfKg: 1000, unidadeNf: 'KG', fatorUnidadeNf: 1 });
      const r = await reservar([ton, kg]);
      expect(r.map((x) => [x.nSequencia, x.nQtdeRecebida])).toEqual([[1, 8250], [2, null]]);
    });

    it('o vínculo do OMIE em PC de unidade diferente também passa (e converte)', async () => {
      const r = await reservar([escolhaValidada({ origem: 'omie' })], { vinculosVivos: { 1: { nIdPedido: PED_306, nIdItPedido: IT_306 } } });
      expect(r[0]!.nQtdeRecebida).toBe(8250);
    });

    it('o ledger grava kg e saldo em kg (a conversão é só da quantidade que o EDITAR manda)', async () => {
      mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie('TON', 13.75, 2.75));
      await reservar([escolhaValidada({ unidadeNf: 'KG', fatorUnidadeNf: 1 })]);
      const p = inserts()[0]!.params;
      expect(p[13]).toBe('8250.000'); // qtd_nf_kg
      expect(p[15]).toBe('11000.000'); // saldo_pc_kg_lido: (13,75 − 2,75) t em kg
    });

    it('as demais recusas continuam: etapa, fornecedor, saldo vivo', async () => {
      mocks.consultarPedidoCompra.mockResolvedValue(pedidoOmie('KG', 13750, 13750));
      const err = await falha(reservar([escolhaValidada()]));
      expect(err.message).toContain('não tem saldo disponível');
    });
  });

  it("valor inválido na chave cai em bloquear também na releitura", async () => {
    mocks.config.STOCKBRIDGE_PC_UNIDADE_DIFERENTE = 'talvez';
    const err = await falha(reservar([escolhaValidada()]));
    expect(err).toBeInstanceOf(PcVinculoInvalidoError);
  });
});

// Mensagem da trava nos dois sentidos: o exemplo diz o que o OMIE gravaria (a quantidade na unidade da NF, sem converter)
// e o que deveria gravar, os dois expressos na unidade do PC — com a NF em kg e o PC em toneladas, o efeito e o inverso
// do da NF 60199 (8.250 toneladas no PC em vez de 8,25).
describe('motivo da trava expressa as duas quantidades na unidade do PC', () => {
  it('NF em kg e PC em toneladas: "com 8.250 em vez de 8,25 toneladas"', () => {
    const r = montar(itemNf(NF_EM_KG), [pc({ unidade: 'TON', qtdPedidaKg: 13750, saldoCopiaKg: 13750 })], BLOQUEAR);
    expect(r.pc.unidadeIncompativel[0]!.motivo).toBe('PC em toneladas e nota em kg: o OMIE baixaria o pedido com 8.250 em vez de 8,25 toneladas');
  });

  it('NF em toneladas e PC em kg (NF 60199): "com 8,25 em vez de 8.250 kg"', () => {
    const r = montar(itemNf(), [pc()], BLOQUEAR);
    expect(r.pc.unidadeIncompativel[0]!.motivo).toBe('PC em kg e nota em toneladas: o OMIE baixaria o pedido com 8,25 em vez de 8.250 kg');
  });

  it('PC em unidade que o Atlas não converte (UN): sem exemplo numérico', () => {
    const r = montar(itemNf(), [pc({ unidade: 'UN' })], BLOQUEAR);
    const c = r.pc.unidadeIncompativel[0];
    if (c) expect(c.motivo).toBe('PC em UN e nota em toneladas');
  });
});
