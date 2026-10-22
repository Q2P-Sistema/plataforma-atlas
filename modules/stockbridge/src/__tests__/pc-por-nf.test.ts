import { describe, it, expect, vi } from 'vitest';

// Feature 017 (ACXEGDP-437), 22/10/2026 — "PC por NF": o operador escolhe o pedido de compra UMA vez para
// a nota inteira (na NF 60199 seriam 3 confirmacoes do mesmo PC 306). montarPcsDaNf (pc-sugestao.service.ts)
// agrupa os PCs das listas de cada item (vinculo do OMIE elegivel > candidatos > outros do fornecedor) e
// atribui cada item da NF a um item do PC: gulosa, do item maior para o menor, com saldo restante por item
// de PC (duas linhas da NF podem cair no mesmo item do PC). Funcao pura: sem rede e sem banco.
//
// Duas camadas de teste:
//  A. montarPcsDaNf sobre ResultadoPcItem montados a mao (controle fino de cada lista);
//  B. o caso real da NF 60199, ponta a ponta: montarPcDoItem (PCs da cópia) -> montarPcsDaNf.

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getPool: () => ({ query: vi.fn() }),
  getConfig: () => ({}),
}));
vi.mock('@atlas/integration-omie', () => ({ consultarPedidoCompra: vi.fn() }));

import {
  montarPcsDaNf,
  montarPcDoItem,
  type ContextoPc,
  type ItemParaPcsDaNf,
  type ItemParaSugestao,
  type PcCandidato,
  type PcCopia,
  type PcDaNf,
  type PcDoItem,
  type ResultadoPcItem,
} from '../services/pc-sugestao.service.js';

const TOL = { qtd: 0.02, preco: 0.01 };

// ── Ids (do OMIE) e numeros legiveis ─────────────────────────────────────────

/** PC 306 da Zaraplast (matriz): 3 itens de PC. */
const PED_306 = 7974140306;
const IT_PEAD = 7974140311; // P1
const IT_PELBD = 7974140312; // P2
const IT_OUTRO = 7974140313; // P3
/** PC 310: outro pedido do fornecedor. */
const PED_310 = 7974140310;
const IT_310 = 7974140319;
/** PC 9 e PC 10: ordem numerica dos numeros legiveis ("9" antes de "10"). */
const PED_9 = 7974140009;
const IT_9 = 7974140091;
const PED_10 = 7974140010;
const IT_10 = 7974140101;

/** Candidato de um item de PC. Default: dentro da tolerancia, etapa 15, sem selo de outro cadastro. */
function cand(pedido: number, item: number, pcNumero: string, over: Partial<PcCandidato> = {}): PcCandidato {
  return {
    nCodPed: pedido,
    nCodItem: item,
    pcNumero,
    produtoDescricao: 'PEAD',
    qtdPedidaKg: 0,
    saldoKg: 10000,
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
  };
}

/** Resultado de um item com as listas dadas (possivel derivado das listas, salvo override). */
function res(
  listas: {
    vinculo?: PcCandidato;
    elegivel?: boolean;
    divergentes?: boolean;
    candidatos?: PcCandidato[];
    outros?: PcCandidato[];
    possivel?: boolean;
  } = {},
): ResultadoPcItem {
  const vinculoOmie = listas.vinculo ?? null;
  const elegivel = listas.elegivel ?? vinculoOmie != null;
  const pc: PcDoItem = {
    vinculoOmie,
    vinculoOmieElegivel: elegivel,
    alertaVinculoOmie: null,
    vinculosDivergentes: listas.divergentes ?? false,
    candidatos: listas.candidatos ?? [],
    outrosDoFornecedor: listas.outros ?? [],
    aguardandoAprovacao: [],
    unidadeIncompativel: [],
    preSelecionado: null,
    semPcMotivo: null,
    vinculadoNoOmie: null,
  };
  const possivel = listas.possivel ?? ((vinculoOmie != null && elegivel) || pc.candidatos.length > 0 || pc.outrosDoFornecedor.length > 0);
  return { pc, possivel, motivoSemPc: possivel ? null : 'sem_pc', situacao: possivel ? 'sugerido' : 'sem_pc' };
}

const item = (indice: number, quantidadeKg: number, resultado: ResultadoPcItem): ItemParaPcsDaNf => ({ indice, quantidadeKg, resultado });
const doPed = (r: { pcs: PcDaNf[] }, nCodPed: number): PcDaNf => r.pcs.find((p) => p.nCodPed === nCodPed)!;
const numeros = (r: { pcs: PcDaNf[] }): string[] => r.pcs.map((p) => p.pcNumero);

// ═══ A. montarPcsDaNf sobre resultados montados a mao ═════════════════════════

describe('montarPcsDaNf — casos de borda', () => {
  it('sem itens: nenhum PC e nada pré-selecionado', () => {
    expect(montarPcsDaNf([], TOL)).toEqual({ pcs: [], preSelecionado: null });
  });

  it('só itens sem PC possível: nenhum PC (nada a agrupar) e nada pré-selecionado', () => {
    const r = montarPcsDaNf([item(0, 1000, res({ possivel: false }))], TOL);
    expect(r).toEqual({ pcs: [], preSelecionado: null });
  });

  it('um item, um candidato: o PC cobre todos, dentro da tolerância, e é pré-selecionado', () => {
    const r = montarPcsDaNf([item(0, 1000, res({ candidatos: [cand(PED_306, IT_PEAD, '306')] }))], TOL);
    expect(r.pcs).toHaveLength(1);
    expect(r.pcs[0]).toMatchObject({ nCodPed: PED_306, pcNumero: '306', cobreTodos: true, dentroTolerancia: true, vinculoOmie: false, justificativaNecessaria: false });
    expect(r.pcs[0]!.itens).toEqual([
      { indice: 0, nCodItem: IT_PEAD, produtoDescricao: 'PEAD', dentroTolerancia: true, motivo: 'Quantidade e preço compatíveis', origem: 'sugestao', justificativaNecessaria: false },
    ]);
    expect(r.preSelecionado).toBe(PED_306);
  });

  it('o vínculo do OMIE inelegível (espelho, unidade) não gera PC nem conta como opção', () => {
    const vinculo = cand(PED_306, IT_PEAD, '306');
    const r = montarPcsDaNf([item(0, 1000, res({ vinculo, elegivel: false, candidatos: [cand(PED_310, IT_310, '310')] }))], TOL);
    expect(numeros(r)).toEqual(['310']);
    expect(doPed(r, PED_310).vinculoOmie).toBe(false);
  });

  it('item possível só pelo vínculo do OMIE (sem candidatos): o PC do vínculo aparece, marcado vinculoOmie', () => {
    const r = montarPcsDaNf([item(0, 1000, res({ vinculo: cand(PED_306, IT_PEAD, '306') }))], TOL);
    expect(r.pcs[0]).toMatchObject({ pcNumero: '306', vinculoOmie: true, cobreTodos: true });
    expect(r.pcs[0]!.itens[0]!.origem).toBe('omie');
    expect(r.preSelecionado).toBe(PED_306);
  });
});

describe('montarPcsDaNf — PC que atende parte da nota, dois PCs e cobreTodos', () => {
  const item1 = (listas: Parameters<typeof res>[0]) => item(0, 1000, res(listas));
  const item2 = (listas: Parameters<typeof res>[0]) => item(1, 500, res(listas));

  it('PC que atende só o item 1 não cobre todos; o que atende os dois vem primeiro e é pré-selecionado', () => {
    const r = montarPcsDaNf(
      [
        item1({ candidatos: [cand(PED_310, IT_310, '310'), cand(PED_306, IT_PEAD, '306')] }),
        item2({ candidatos: [cand(PED_306, IT_PELBD, '306')] }),
      ],
      TOL,
    );
    expect(numeros(r)).toEqual(['306', '310']);
    expect(doPed(r, PED_306)).toMatchObject({ cobreTodos: true });
    expect(doPed(r, PED_310)).toMatchObject({ cobreTodos: false });
    expect(doPed(r, PED_310).itens.map((i) => i.indice)).toEqual([0]);
    expect(r.preSelecionado).toBe(PED_306);
  });

  it('dois PCs cobrem todos dentro da tolerância: ambos listados, NENHUM pré-selecionado (escolha do operador)', () => {
    const r = montarPcsDaNf(
      [
        item1({ candidatos: [cand(PED_306, IT_PEAD, '306'), cand(PED_310, IT_310, '310')] }),
        item2({ candidatos: [cand(PED_306, IT_PELBD, '306'), cand(PED_310, IT_310 + 1, '310')] }),
      ],
      TOL,
    );
    expect(r.pcs.filter((p) => p.cobreTodos)).toHaveLength(2);
    expect(r.preSelecionado).toBeNull();
  });

  it('cada PC atende um item e nenhum cobre todos: os dois ficam na lista e nada é pré-selecionado', () => {
    const r = montarPcsDaNf(
      [item1({ candidatos: [cand(PED_306, IT_PEAD, '306')] }), item2({ candidatos: [cand(PED_310, IT_310, '310')] })],
      TOL,
    );
    expect(r.pcs.map((p) => p.cobreTodos)).toEqual([false, false]);
    expect(r.preSelecionado).toBeNull();
  });

  it('um item sem PC possível: nenhum PC "cobre todos" — nem o que atende todos os outros —, e o item sem PC não entra em nenhuma atribuição', () => {
    const r = montarPcsDaNf(
      [item(0, 1000, res({ candidatos: [cand(PED_306, IT_PEAD, '306')] })), item(1, 500, res({ possivel: false }))],
      TOL,
    );
    expect(r.pcs).toHaveLength(1);
    expect(r.pcs[0]!.cobreTodos).toBe(false);
    expect(r.pcs[0]!.itens.map((i) => i.indice)).toEqual([0]);
    expect(r.preSelecionado).toBeNull();
  });

  it('as atribuições saem ordenadas pelo índice do item da NF, e não pela ordem de consumo (maior primeiro)', () => {
    const r = montarPcsDaNf(
      [
        item(0, 500, res({ candidatos: [cand(PED_306, IT_PELBD, '306', { saldoKg: 5000 })] })),
        item(1, 1000, res({ candidatos: [cand(PED_306, IT_PEAD, '306', { saldoKg: 5000 })] })),
        item(2, 750, res({ candidatos: [cand(PED_306, IT_OUTRO, '306', { saldoKg: 5000 })] })),
      ],
      TOL,
    );
    expect(doPed(r, PED_306).itens.map((i) => i.indice)).toEqual([0, 1, 2]);
  });
});

describe('montarPcsDaNf — atribuição gulosa (item maior primeiro, saldo restante por item do PC)', () => {
  it('duas linhas da NF no MESMO item do PC (NF 60199, itens 3 e 4 → PELBD 07/21): cabem somadas, ambas dentro da tolerância', () => {
    const r = montarPcsDaNf(
      [
        item(0, 8250, res({ candidatos: [cand(PED_306, IT_PELBD, '306', { saldoKg: 11000 })] })),
        item(1, 2750, res({ candidatos: [cand(PED_306, IT_PELBD, '306', { saldoKg: 11000 })] })),
      ],
      TOL,
    );
    const pc = doPed(r, PED_306);
    expect(pc.itens.map((i) => [i.indice, i.nCodItem, i.dentroTolerancia])).toEqual([[0, IT_PELBD, true], [1, IT_PELBD, true]]);
    expect(pc.dentroTolerancia).toBe(true);
    expect(pc.justificativaNecessaria).toBe(false);
    expect(r.preSelecionado).toBe(PED_306);
  });

  it('a soma passa do saldo: a linha que não cabe continua apontada para o mesmo item do PC, mas fora da tolerância e com justificativa', () => {
    // saldo 11.000: a linha de 8.250 consome primeiro (resta 2.750); a de 3.000 passa de 2.750 × 1,02 = 2.805
    const r = montarPcsDaNf(
      [
        item(0, 8250, res({ candidatos: [cand(PED_306, IT_PELBD, '306', { saldoKg: 11000 })] })),
        item(1, 3000, res({ candidatos: [cand(PED_306, IT_PELBD, '306', { saldoKg: 11000 })] })),
      ],
      TOL,
    );
    const pc = doPed(r, PED_306);
    expect(pc.itens.find((i) => i.indice === 0)).toMatchObject({ nCodItem: IT_PELBD, dentroTolerancia: true, justificativaNecessaria: false });
    expect(pc.itens.find((i) => i.indice === 1)).toMatchObject({ nCodItem: IT_PELBD, dentroTolerancia: false, justificativaNecessaria: true });
    expect(pc.cobreTodos).toBe(true);
    expect(pc.dentroTolerancia).toBe(false);
    expect(pc.justificativaNecessaria).toBe(true);
    expect(r.preSelecionado).toBeNull(); // cobre todos, mas exige justificativa
  });

  it('a tolerância de quantidade vale sobre o saldo RESTANTE: 2.805 kg cabem em 2.750 (2%), 2.806 não', () => {
    const monta = (qtd2: number) =>
      montarPcsDaNf(
        [
          item(0, 8250, res({ candidatos: [cand(PED_306, IT_PELBD, '306', { saldoKg: 11000 })] })),
          item(1, qtd2, res({ candidatos: [cand(PED_306, IT_PELBD, '306', { saldoKg: 11000 })] })),
        ],
        TOL,
      );
    expect(doPed(monta(2750.5), PED_306).itens.find((i) => i.indice === 1)!.dentroTolerancia).toBe(true);
    expect(doPed(monta(2806), PED_306).itens.find((i) => i.indice === 1)!.dentroTolerancia).toBe(false);
  });

  it('o item MAIOR consome primeiro, qualquer que seja a ordem da lista: o menor cai no outro item do PC que ainda cabe', () => {
    // O PC tem P1 (13.750 kg) e P2 (5.000 kg). A linha pequena (2.750, índice 0) lista P1 antes de P2; a grande
    // (13.750, índice 1) só cabe em P1. Se a pequena consumisse primeiro, ocuparia P1 e a grande ficaria fora.
    const r = montarPcsDaNf(
      [
        item(0, 2750, res({ candidatos: [cand(PED_306, IT_PEAD, '306', { saldoKg: 13750 }), cand(PED_306, IT_OUTRO, '306', { saldoKg: 5000 })] })),
        item(1, 13750, res({ candidatos: [cand(PED_306, IT_PEAD, '306', { saldoKg: 13750 })] })),
      ],
      TOL,
    );
    const pc = doPed(r, PED_306);
    expect(pc.itens.find((i) => i.indice === 1)).toMatchObject({ nCodItem: IT_PEAD, dentroTolerancia: true });
    expect(pc.itens.find((i) => i.indice === 0)).toMatchObject({ nCodItem: IT_OUTRO, dentroTolerancia: true });
    expect(pc.dentroTolerancia).toBe(true);
  });

  it('empate de quantidade: o item de menor índice consome primeiro', () => {
    // um único item de PC com saldo para UMA das duas linhas de 5.000 kg
    const lista = () => res({ candidatos: [cand(PED_306, IT_PEAD, '306', { saldoKg: 5000 })] });
    const r = montarPcsDaNf([item(1, 5000, lista()), item(0, 5000, lista())], TOL);
    const pc = doPed(r, PED_306);
    expect(pc.itens.find((i) => i.indice === 0)!.dentroTolerancia).toBe(true);
    expect(pc.itens.find((i) => i.indice === 1)!.dentroTolerancia).toBe(false);
  });

  it('o saldo restante é por item do PC, não por PC: dois itens de PC distintos atendem duas linhas grandes', () => {
    const r = montarPcsDaNf(
      [
        item(0, 9000, res({ candidatos: [cand(PED_306, IT_PEAD, '306', { saldoKg: 9000 }), cand(PED_306, IT_PELBD, '306', { saldoKg: 9000 })] })),
        item(1, 9000, res({ candidatos: [cand(PED_306, IT_PEAD, '306', { saldoKg: 9000 }), cand(PED_306, IT_PELBD, '306', { saldoKg: 9000 })] })),
      ],
      TOL,
    );
    const pc = doPed(r, PED_306);
    expect(pc.itens.map((i) => i.nCodItem).sort()).toEqual([IT_PEAD, IT_PELBD]);
    expect(pc.itens.every((i) => i.dentroTolerancia)).toBe(true);
  });

  it('nenhuma opção cabe: o item fica na primeira opção, fora da tolerância e com justificativa (o POST decide com o saldo vivo)', () => {
    const r = montarPcsDaNf([item(0, 20000, res({ candidatos: [cand(PED_306, IT_PEAD, '306', { saldoKg: 10000, dentroTolerancia: true })] }))], TOL);
    expect(doPed(r, PED_306).itens[0]).toMatchObject({ nCodItem: IT_PEAD, dentroTolerancia: false, justificativaNecessaria: true });
    expect(r.preSelecionado).toBeNull();
  });

  it('a 1ª opção que não cabe cede lugar à 2ª que cabe (mesmo PC), mesmo vindo de "outros do fornecedor" (manual → justificativa)', () => {
    const r = montarPcsDaNf(
      [
        item(
          0,
          5000,
          res({
            candidatos: [cand(PED_306, IT_PEAD, '306', { saldoKg: 1000 })],
            outros: [cand(PED_306, IT_PELBD, '306', { saldoKg: 6000, dentroTolerancia: false, motivo: 'Preço da NF 3,0% acima do PC' })],
          }),
        ),
      ],
      TOL,
    );
    expect(doPed(r, PED_306).itens[0]).toMatchObject({ nCodItem: IT_PELBD, origem: 'manual', dentroTolerancia: false, justificativaNecessaria: true });
  });

  it('dentro de um PC o item usa a primeira opção na ordem do próprio item: vínculo do OMIE, depois candidatos, depois outros', () => {
    const r = montarPcsDaNf(
      [
        item(
          0,
          1000,
          res({
            vinculo: cand(PED_306, IT_OUTRO, '306'),
            candidatos: [cand(PED_306, IT_PEAD, '306')],
            outros: [cand(PED_306, IT_PELBD, '306', { dentroTolerancia: false })],
          }),
        ),
      ],
      TOL,
    );
    expect(doPed(r, PED_306).itens[0]).toMatchObject({ nCodItem: IT_OUTRO, origem: 'omie' });
  });
});

describe('montarPcsDaNf — vínculo do OMIE, tolerância e justificativa', () => {
  it('vínculo do OMIE que cobre todos sem justificativa vence outro PC que também cobre todos dentro da tolerância', () => {
    const r = montarPcsDaNf(
      [
        item(0, 1000, res({ vinculo: cand(PED_306, IT_PEAD, '306'), candidatos: [cand(PED_310, IT_310, '310')] })),
        item(1, 500, res({ candidatos: [cand(PED_306, IT_PELBD, '306'), cand(PED_310, IT_310 + 1, '310')] })),
      ],
      TOL,
    );
    expect(doPed(r, PED_306)).toMatchObject({ vinculoOmie: true, cobreTodos: true, justificativaNecessaria: false });
    expect(doPed(r, PED_310)).toMatchObject({ vinculoOmie: false, cobreTodos: true });
    expect(r.preSelecionado).toBe(PED_306);
  });

  it('vínculo do OMIE só num item: o outro item do mesmo PC entra como sugestão, sem justificativa', () => {
    const r = montarPcsDaNf(
      [
        item(0, 1000, res({ vinculo: cand(PED_306, IT_PEAD, '306') })),
        item(1, 500, res({ candidatos: [cand(PED_306, IT_PELBD, '306')] })),
      ],
      TOL,
    );
    expect(doPed(r, PED_306).itens.map((i) => i.origem)).toEqual(['omie', 'sugestao']);
    expect(doPed(r, PED_306).justificativaNecessaria).toBe(false);
    expect(r.preSelecionado).toBe(PED_306);
  });

  it('vínculo do OMIE fora da tolerância (alerta): o PC exige justificativa e NÃO é pré-selecionado', () => {
    const r = montarPcsDaNf([item(0, 1000, res({ vinculo: cand(PED_306, IT_PEAD, '306', { dentroTolerancia: false }) }))], TOL);
    expect(r.pcs[0]).toMatchObject({ vinculoOmie: true, cobreTodos: true, dentroTolerancia: false, justificativaNecessaria: true });
    expect(r.preSelecionado).toBeNull();
  });

  it('vínculo do OMIE sem dados locais (PC fora da cópia e do cache): "não comparado" — fora da tolerância e com justificativa', () => {
    const vinculo = cand(PED_306, IT_PEAD, '', { semDadosLocais: true, dentroTolerancia: false, saldoKg: 0, motivo: 'Vínculo do OMIE' });
    const r = montarPcsDaNf([item(0, 1000, res({ vinculo }))], TOL);
    expect(r.pcs[0]!.itens[0]).toMatchObject({ dentroTolerancia: false, justificativaNecessaria: true });
    expect(r.preSelecionado).toBeNull();
  });

  it('TROCA do vínculo: escolher outro PC quando o item está vinculado a um PC elegível exige justificativa mesmo dentro da tolerância, e o PC trocado não é pré-selecionado', () => {
    const r = montarPcsDaNf(
      [item(0, 1000, res({ vinculo: cand(PED_306, IT_PEAD, '306'), candidatos: [cand(PED_310, IT_310, '310')] }))],
      TOL,
    );
    expect(doPed(r, PED_306)).toMatchObject({ justificativaNecessaria: false, vinculoOmie: true });
    expect(doPed(r, PED_310).itens[0]).toMatchObject({ dentroTolerancia: true, justificativaNecessaria: true });
    expect(doPed(r, PED_310)).toMatchObject({ dentroTolerancia: true, justificativaNecessaria: true });
    expect(r.preSelecionado).toBe(PED_306);
  });

  it('troca de vínculo também quando o vínculo é do MESMO PC mas de outro item de PC', () => {
    // item vinculado ao P1 do 306; a atribuição do 306 cai no P2 (P1 sem saldo) → é troca de item de PC
    const r = montarPcsDaNf(
      [
        item(
          0,
          5000,
          res({ vinculo: cand(PED_306, IT_PEAD, '306', { saldoKg: 1000, dentroTolerancia: false }), candidatos: [cand(PED_306, IT_PELBD, '306', { saldoKg: 6000 })] }),
        ),
      ],
      TOL,
    );
    const a = doPed(r, PED_306).itens[0]!;
    // o vínculo vem primeiro na lista do item, mas não cabe (5.000 > 1.000 × 1,02): vai para o P2
    expect(a.nCodItem).toBe(IT_PELBD);
    expect(a.justificativaNecessaria).toBe(true);
  });

  it('linhas vinculadas a PCs diferentes (vinculosDivergentes): QUALQUER PC escolhido exige justificativa, mesmo dentro da tolerância', () => {
    const r = montarPcsDaNf([item(0, 1000, res({ divergentes: true, candidatos: [cand(PED_306, IT_PEAD, '306')] }))], TOL);
    expect(r.pcs[0]).toMatchObject({ dentroTolerancia: true, justificativaNecessaria: true, cobreTodos: true });
    expect(r.preSelecionado).toBeNull();
  });

  it('"outros do fornecedor" (escolha manual) nunca está dentro da tolerância e sempre pede justificativa', () => {
    const r = montarPcsDaNf([item(0, 1000, res({ outros: [cand(PED_306, IT_PEAD, '306', { dentroTolerancia: false, motivo: 'Quantidade 5,6% acima do saldo' })] }))], TOL);
    expect(r.pcs[0]!.itens[0]).toMatchObject({ origem: 'manual', dentroTolerancia: false, justificativaNecessaria: true, motivo: 'Quantidade 5,6% acima do saldo' });
    expect(r.pcs[0]).toMatchObject({ dentroTolerancia: false, justificativaNecessaria: true });
    expect(r.preSelecionado).toBeNull();
  });

  it('o ÚNICO PC que cobre todos dentro da tolerância é pré-selecionado mesmo havendo PC parcial', () => {
    const r = montarPcsDaNf(
      [
        item(0, 1000, res({ candidatos: [cand(PED_306, IT_PEAD, '306'), cand(PED_310, IT_310, '310')] })),
        item(1, 500, res({ candidatos: [cand(PED_306, IT_PELBD, '306')] })),
      ],
      TOL,
    );
    expect(r.preSelecionado).toBe(PED_306);
  });

  it('um PC que cobre todos mas fora da tolerância não é pré-selecionado; se outro cobre todos limpo, este é', () => {
    const r = montarPcsDaNf(
      [
        item(0, 1000, res({ candidatos: [cand(PED_310, IT_310, '310')], outros: [cand(PED_306, IT_PEAD, '306', { dentroTolerancia: false })] })),
      ],
      TOL,
    );
    expect(doPed(r, PED_306).cobreTodos).toBe(true);
    expect(doPed(r, PED_306).dentroTolerancia).toBe(false);
    expect(r.preSelecionado).toBe(PED_310);
  });

  it('vínculo do OMIE que cobre todos MAS exige justificativa não é pré-selecionado; o outro PC limpo também não (trocar o vínculo exige justificativa)', () => {
    const r = montarPcsDaNf(
      [
        item(0, 1000, res({ vinculo: cand(PED_306, IT_PEAD, '306', { dentroTolerancia: false }), candidatos: [cand(PED_310, IT_310, '310')] })),
      ],
      TOL,
    );
    expect(doPed(r, PED_306)).toMatchObject({ vinculoOmie: true, justificativaNecessaria: true });
    expect(doPed(r, PED_310)).toMatchObject({ vinculoOmie: false, dentroTolerancia: true, justificativaNecessaria: true });
    expect(r.preSelecionado).toBeNull();
  });

  it('sem vínculo do OMIE, o PC limpo que cobre todos assume mesmo havendo outro PC que cobre todos fora da tolerância', () => {
    const r = montarPcsDaNf(
      [item(0, 1000, res({ candidatos: [cand(PED_310, IT_310, '310')], outros: [cand(PED_306, IT_PEAD, '306', { dentroTolerancia: false })] }))],
      TOL,
    );
    expect(r.preSelecionado).toBe(PED_310);
  });
});

describe('montarPcsDaNf — ordem da lista de PCs da nota', () => {
  it('1º cobre todos: um PC que cobre todos vem antes de um que atende mais itens mas não cobre', () => {
    // 4 itens, um sem PC → ninguém cobre. Usa 3 itens com PC possível: A cobre os 3; B só 2, mas B tem o vínculo do OMIE
    const r = montarPcsDaNf(
      [
        item(0, 1000, res({ vinculo: cand(PED_310, IT_310, '310'), candidatos: [cand(PED_306, IT_PEAD, '306')] })),
        item(1, 900, res({ candidatos: [cand(PED_310, IT_310 + 1, '310'), cand(PED_306, IT_PELBD, '306')] })),
        item(2, 800, res({ candidatos: [cand(PED_306, IT_OUTRO, '306')] })),
      ],
      TOL,
    );
    expect(numeros(r)).toEqual(['306', '310']);
    expect(doPed(r, PED_306).cobreTodos).toBe(true);
    expect(doPed(r, PED_310).cobreTodos).toBe(false);
    expect(doPed(r, PED_310).vinculoOmie).toBe(true);
  });

  it('2º vínculo do OMIE: entre PCs parciais, o que tem o vínculo vem antes (mesmo atendendo menos itens)', () => {
    const r = montarPcsDaNf(
      [
        item(0, 1000, res({ vinculo: cand(PED_310, IT_310, '310'), candidatos: [cand(PED_306, IT_PEAD, '306')] })),
        item(1, 900, res({ candidatos: [cand(PED_306, IT_PELBD, '306')] })),
        item(2, 800, res({ possivel: false })),
      ],
      TOL,
    );
    expect(numeros(r)).toEqual(['310', '306']);
  });

  it('3º quem atende mais itens', () => {
    const r = montarPcsDaNf(
      [
        item(0, 1000, res({ candidatos: [cand(PED_310, IT_310, '310'), cand(PED_306, IT_PEAD, '306')] })),
        item(1, 900, res({ candidatos: [cand(PED_306, IT_PELBD, '306')] })),
        item(2, 800, res({ possivel: false })),
      ],
      TOL,
    );
    expect(numeros(r)).toEqual(['306', '310']);
  });

  it('4º dentro da tolerância antes de fora (mesma quantidade de itens)', () => {
    const r = montarPcsDaNf(
      [
        item(0, 1000, res({ candidatos: [cand(PED_310, IT_310, '310')], outros: [cand(PED_9, IT_9, '9', { dentroTolerancia: false })] })),
        item(1, 900, res({ possivel: false })),
      ],
      TOL,
    );
    expect(numeros(r)).toEqual(['310', '9']);
  });

  it('5º número do PC em ordem NUMÉRICA ("9" antes de "10" e de "306")', () => {
    const r = montarPcsDaNf(
      [
        item(0, 1000, res({ candidatos: [cand(PED_306, IT_PEAD, '306'), cand(PED_10, IT_10, '10'), cand(PED_9, IT_9, '9')] })),
        item(1, 900, res({ possivel: false })),
      ],
      TOL,
    );
    expect(numeros(r)).toEqual(['9', '10', '306']);
  });

  it('6º empate total (mesmo número legível, ex.: vazio): desempata pelo nCodPed', () => {
    const r = montarPcsDaNf(
      [item(0, 1000, res({ candidatos: [cand(PED_310, IT_310, ''), cand(PED_306, IT_PEAD, '')] })), item(1, 900, res({ possivel: false }))],
      TOL,
    );
    expect(r.pcs.map((p) => p.nCodPed)).toEqual([PED_306, PED_310]);
  });
});

describe('montarPcsDaNf — metadados do PC (número, selo de outro cadastro, cache)', () => {
  it('o número do PC vem da primeira opção que o tem, mesmo que a 1ª (ex.: vínculo fora da cópia) venha em branco', () => {
    const r = montarPcsDaNf(
      [
        item(0, 1000, res({ vinculo: cand(PED_306, IT_PEAD, '', { semDadosLocais: true, dentroTolerancia: false }) })),
        item(1, 500, res({ candidatos: [cand(PED_306, IT_PELBD, '306')] })),
      ],
      TOL,
    );
    expect(r.pcs[0]!.pcNumero).toBe('306');
  });

  it('selo de outro cadastro, CNPJ do cadastro e "dados do cache" vêm da primeira opção vista do PC', () => {
    const r = montarPcsDaNf(
      [item(0, 1000, res({ candidatos: [cand(PED_306, IT_PEAD, '306', { outroCadastro: true, cnpjCadastro: '61827663000179', dadosEmCache: true })] }))],
      TOL,
    );
    expect(r.pcs[0]).toMatchObject({ outroCadastro: true, cnpjCadastro: '61827663000179', dadosEmCache: true });
  });

  it('PC do próprio cadastro: outroCadastro false, sem CNPJ e sem cache', () => {
    const r = montarPcsDaNf([item(0, 1000, res({ candidatos: [cand(PED_306, IT_PEAD, '306')] }))], TOL);
    expect(r.pcs[0]).toMatchObject({ outroCadastro: false, cnpjCadastro: '', dadosEmCache: false });
  });

  it('vinculoOmie do PC é marcado quando QUALQUER item o tem como vínculo do OMIE elegível', () => {
    const r = montarPcsDaNf(
      [
        item(0, 1000, res({ candidatos: [cand(PED_306, IT_PEAD, '306')] })),
        item(1, 500, res({ vinculo: cand(PED_306, IT_PELBD, '306') })),
      ],
      TOL,
    );
    expect(r.pcs[0]!.vinculoOmie).toBe(true);
  });
});

describe('montarPcsDaNf — nenhum texto da tela leva id do OMIE (ACXEGDP-313)', () => {
  it('pcNumero, produtoDescricao e motivo das atribuições não têm sequência de 10 dígitos', () => {
    const r = montarPcsDaNf(
      [
        item(0, 1000, res({ candidatos: [cand(PED_306, IT_PEAD, '306', { motivo: 'Número do pedido na NF · em outro cadastro do fornecedor (CNPJ 61.827.663/0001-79)' })] })),
        item(1, 500, res({ outros: [cand(PED_310, IT_310, '310', { dentroTolerancia: false, motivo: 'Quantidade 5,6% acima do saldo' })] })),
      ],
      TOL,
    );
    for (const pc of r.pcs) {
      expect(pc.pcNumero).not.toMatch(/\d{10}/);
      for (const i of pc.itens) {
        expect(i.produtoDescricao).not.toMatch(/\d{10}/);
        expect(i.motivo).not.toMatch(/\d{10}/);
      }
    }
  });
});

// ═══ B. NF 60199, ponta a ponta (montarPcDoItem -> montarPcsDaNf) ═════════════

describe('NF 60199 × PC 306 (Zaraplast): 3 itens agregados, PC da matriz com 3 itens de PC e duas linhas no mesmo item', () => {
  const FILIAL = 3098999518;
  const MATRIZ = 7974140605;
  const CHAVE = '35261061827663001302550010000601991000601990';
  const AGORA = Date.UTC(2026, 9, 22, 18, 0, 0);

  const itemPc = (nCodItem: number, descricao: string, saldoKg: number, over: Partial<PcCopia> = {}): PcCopia => ({
    nCodPed: PED_306,
    nCodItem,
    pcNumero: '306',
    etapa: '15',
    nCodFor: MATRIZ,
    produtoDescricao: descricao,
    qtdPedidaKg: saldoKg,
    saldoCopiaKg: saldoKg,
    precoKg: 10.8,
    unidade: 'KG',
    dtPrevisao: '2026-11-05',
    atualizadoEmMs: AGORA - 600_000,
    pcEspelho: false,
    cnpjCadastro: '61827663000179',
    raizCnpj: '61827663',
    fonte: 'copia',
    ...over,
  });
  /** PC 306: PEAD ES 13.750 kg, PELBD 07/21 11.000 kg (as duas linhas pequenas da NF) e um terceiro item de 5.000 kg. */
  const pc306 = (over: Partial<PcCopia> = {}): PcCopia[] => [
    itemPc(IT_PEAD, 'MC PEAD ES', 13750, over),
    itemPc(IT_PELBD, 'PELBD 07/21', 11000, over),
    itemPc(IT_OUTRO, 'PEBD LD', 5000, over),
  ];
  const ctx = (pcs: PcCopia[]): ContextoPc => ({ pcs, usos: [], agoraMs: AGORA, raizPorFornecedor: new Map([[FILIAL, '61827663']]) });

  const nfItem = (indice: number, descricao: string, kg: number, over: Partial<ItemParaSugestao> = {}): ItemParaSugestao => ({
    indice,
    descricao,
    quantidadeKg: kg,
    unidadeNf: 'KG',
    fatorUnidadeNf: 1,
    precoNfKg: 10.8,
    precoItemKg: 10.8,
    numeroPedidoNf: null,
    vinculos: [],
    sequencias: [indice + 1],
    kgPorSequencia: { [indice + 1]: kg },
    ...over,
  });
  /** A NF: PEAD ES 13.750, PEBD LD 8.250 e PEBDL-16 2.750 kg — os dois últimos cabem juntos no PELBD 07/21 (11.000). */
  const itensNf = (): ItemParaSugestao[] => [nfItem(0, 'MC PEAD ES', 13750), nfItem(1, 'MC PEBD LD', 8250), nfItem(2, 'PEBDL-16', 2750)];

  function pcsDaNota(pcs: PcCopia[], itens: ItemParaSugestao[] = itensNf(), opcoes?: { exigeMesmaUnidade: boolean }) {
    const c = ctx(pcs);
    const entrada: ItemParaPcsDaNf[] = itens.map((it) => ({
      indice: it.indice,
      quantidadeKg: it.quantidadeKg!,
      resultado: montarPcDoItem(it, c, FILIAL, CHAVE, TOL, opcoes),
    }));
    return montarPcsDaNf(entrada, TOL);
  }

  it('o PC 306 cobre todos: PEAD → item PEAD; PEBD LD e PEBDL-16 → o MESMO item PELBD 07/21; tudo dentro da tolerância e pré-selecionado', () => {
    const r = pcsDaNota(pc306());
    expect(r.pcs).toHaveLength(1);
    const pc = r.pcs[0]!;
    expect(pc).toMatchObject({ nCodPed: PED_306, pcNumero: '306', cobreTodos: true, dentroTolerancia: true, justificativaNecessaria: false, vinculoOmie: false });
    expect(pc.itens.map((i) => [i.indice, i.nCodItem])).toEqual([[0, IT_PEAD], [1, IT_PELBD], [2, IT_PELBD]]);
    expect(pc.itens.every((i) => i.dentroTolerancia && !i.justificativaNecessaria && i.origem === 'sugestao')).toBe(true);
    expect(r.preSelecionado).toBe(PED_306);
  });

  it('o PC é da matriz: leva o selo de outro cadastro e o CNPJ, e o motivo de cada atribuição o sufixo', () => {
    const pc = pcsDaNota(pc306()).pcs[0]!;
    expect(pc.outroCadastro).toBe(true);
    expect(pc.cnpjCadastro).toBe('61827663000179');
    for (const i of pc.itens) expect(i.motivo).toBe('Quantidade e preço compatíveis · em outro cadastro do fornecedor (CNPJ 61.827.663/0001-79)');
  });

  it('um segundo PC do fornecedor (310, só 5.000 kg) entra como escolha manual para os 3 itens, fora da tolerância; vem depois do 306 e não tira a pré-seleção', () => {
    const pc310: PcCopia = { ...itemPc(IT_310, 'PEBDL-16', 5000), nCodPed: PED_310, pcNumero: '310' };
    const r = pcsDaNota([...pc306(), pc310]);
    expect(numeros(r)).toEqual(['306', '310']);
    expect(doPed(r, PED_310)).toMatchObject({ cobreTodos: true, dentroTolerancia: false, justificativaNecessaria: true });
    // As linhas de 13.750 e 8.250 kg não cabem nos 5.000 do PC 310 (manual). Mesmo assim a atribuição consome o
    // saldo do item de PC (até zerar): a de 2.750 kg, que sozinha seria candidata (sugestão), fica sem saldo
    // restante — a ordem "maior primeiro" trata o item de PC como já comprometido com as maiores.
    expect(doPed(r, PED_310).itens.find((i) => i.indice === 0)).toMatchObject({ origem: 'manual', dentroTolerancia: false });
    expect(doPed(r, PED_310).itens.find((i) => i.indice === 2)).toMatchObject({ origem: 'sugestao', dentroTolerancia: false });
    expect(r.preSelecionado).toBe(PED_306);
  });

  it('um segundo PC que cobre todos dentro da tolerância (310 com saldo para tudo): os dois cobrem e NADA é pré-selecionado', () => {
    const pc310 = [
      { ...itemPc(IT_310, 'PEAD ES', 13750), nCodPed: PED_310, pcNumero: '310' },
      { ...itemPc(IT_310 + 1, 'PELBD', 11000), nCodPed: PED_310, pcNumero: '310' },
    ];
    const r = pcsDaNota([...pc306(), ...pc310]);
    expect(r.pcs.filter((p) => p.cobreTodos && p.dentroTolerancia).map((p) => p.pcNumero)).toEqual(['306', '310']);
    expect(r.preSelecionado).toBeNull();
  });

  it('o PC 306 sem o terceiro item de PC: o mesmo resultado (as duas linhas pequenas continuam no PELBD)', () => {
    const r = pcsDaNota(pc306().slice(0, 2));
    expect(r.pcs[0]!.itens.map((i) => i.nCodItem)).toEqual([IT_PEAD, IT_PELBD, IT_PELBD]);
    expect(r.preSelecionado).toBe(PED_306);
  });

  it('o saldo do PELBD (6.000 kg) não cobre a linha de 8.250 kg: ela fica fora da tolerância, e o PC passa a exigir justificativa e perde a pré-seleção', () => {
    // PELBD 6.000: a linha de 8.250 não cabe (6.000 × 1,02 = 6.120) e o PC a lista só em "outros" (fora da tolerância
    // para ela); o item de PC de 5.000 também não. O resultado exige justificativa.
    const pcs = [itemPc(IT_PEAD, 'MC PEAD ES', 13750), itemPc(IT_PELBD, 'PELBD 07/21', 6000), itemPc(IT_OUTRO, 'PEBD LD', 5000)];
    const r = pcsDaNota(pcs);
    const pc = doPed(r, PED_306);
    expect(pc.cobreTodos).toBe(true);
    const peb = pc.itens.find((i) => i.indice === 1)!;
    expect(peb.dentroTolerancia).toBe(false);
    expect(peb.justificativaNecessaria).toBe(true);
    expect(pc.justificativaNecessaria).toBe(true);
    expect(r.preSelecionado).toBeNull();
  });

  it('um item grande demais para qualquer item do PC (30.000 kg): entra como escolha manual com justificativa e a nota não vem pré-selecionada', () => {
    const itens = [...itensNf(), nfItem(3, 'TAMPA', 30000)];
    const r = pcsDaNota(pc306(), itens);
    // o 4º item (30.000 kg) não cabe em nenhum item de PC: vai para "outros" do fornecedor (possível), então o PC o cobre fora da tolerância
    expect(r.pcs[0]!.cobreTodos).toBe(true);
    const pc = doPed(r, PED_306);
    expect(pc.itens.find((i) => i.indice === 3)).toMatchObject({ origem: 'manual', dentroTolerancia: false, justificativaNecessaria: true });
    expect(r.preSelecionado).toBeNull();
  });

  it('vínculo do OMIE no PC 306 em todas as linhas (item de PC certo): o PC é o vínculo do OMIE e continua pré-selecionado', () => {
    const itens = [
      nfItem(0, 'MC PEAD ES', 13750, { vinculos: [{ nSequencia: 1, nIdPedido: PED_306, nIdItPedido: IT_PEAD }] }),
      nfItem(1, 'MC PEBD LD', 8250, { vinculos: [{ nSequencia: 2, nIdPedido: PED_306, nIdItPedido: IT_PELBD }] }),
      nfItem(2, 'PEBDL-16', 2750, { vinculos: [{ nSequencia: 3, nIdPedido: PED_306, nIdItPedido: IT_PELBD }] }),
    ];
    const r = pcsDaNota(pc306(), itens);
    expect(r.pcs[0]).toMatchObject({ pcNumero: '306', vinculoOmie: true, cobreTodos: true, justificativaNecessaria: false });
    expect(r.pcs[0]!.itens.map((i) => i.origem)).toEqual(['omie', 'omie', 'omie']);
    expect(r.preSelecionado).toBe(PED_306);
  });

  it('janela do PC 306 (fora da lista de pendentes): os dados vêm do cache e o PC leva dadosEmCache', () => {
    const r = pcsDaNota(pc306({ fonte: 'cache' }));
    expect(r.pcs[0]!.dadosEmCache).toBe(true);
    expect(r.preSelecionado).toBe(PED_306);
  });

  describe('NF em toneladas e PC em kg (a trava de unidade)', () => {
    const itensTon = () => itensNf().map((it) => ({ ...it, unidadeNf: 'TON', fatorUnidadeNf: 1000 }));

    it('modo "bloquear" (padrão): nenhum PC é oferecido — o PC em kg fica na lista de unidade incompatível', () => {
      const r = pcsDaNota(pc306(), itensTon());
      expect(r).toEqual({ pcs: [], preSelecionado: null });
    });

    it('modo "converter": o PC em kg é oferecido normalmente e cobre todos', () => {
      const r = pcsDaNota(pc306(), itensTon(), { exigeMesmaUnidade: false });
      expect(r.pcs).toHaveLength(1);
      expect(r.pcs[0]).toMatchObject({ pcNumero: '306', cobreTodos: true, dentroTolerancia: true });
      expect(r.preSelecionado).toBe(PED_306);
    });
  });
});
