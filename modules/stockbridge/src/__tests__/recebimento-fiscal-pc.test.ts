import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ItemRecebimentoEditar } from '@atlas/integration-omie';

// Feature 017 (ACXEGDP-437) — recebimento FISCAL com pedido de compra (PC): T031 e T041 (parte do fiscal).
//
// concluirRecebimentoFiscal com `vinculos` (escolhas de PC validadas no portao 1) e
// `sequenciasSemVinculo`. OMIE, ledger e relerEReservarPcs sao mockados: o que importa aqui
// e a ORDEM, os payloads, as transicoes das linhas de stockbridge.recebimento_fiscal_pc, as
// recusas ANTES de escrever e o bloqueio de estoque ja lancado pelo OMIE (research D1, D2, D4,
// D7; contrato recebimento-nacional-pc.md §3).
//
// ORDEM (revisao adversarial, achado fiscal-02): trava do ledger -> ConsultarRecebimento por
// chave -> [cRecebido S: D7 (EstoqueJaLancadoPeloOmieError) ou ja_concluido, SEM reler nem
// reservar o PC] -> recusas decididas so com a consulta (cancelada, sem fornecedor, etapa...) ->
// VINCULO_OMIE_MUDOU -> releitura/reserva do PC (passo consultar_pc) -> ASSOCIAR-PEDIDO ->
// EDITAR -> IGNORAR -> Concluir. A NF ja concluida (no portal, ou por um Concluir cuja resposta
// se perdeu) nao pode exigir saldo de um PC que ela mesma ja consumiu.
//
// ja_concluido na PRIMEIRA consulta (achados fiscal-02/03): nada e relido nem reservado; as reservas
// vivas de uma tentativa anterior morta (ledger orfao) sao fechadas e a escolha do operador vai
// direto ao estado final em stockbridge.recebimento_fiscal_pc — concluido (vinculo vivo = escolhido,
// com o instante da conclusao NO OMIE) ou falha. `vinculos` do resultado = as escolhas cujo vinculo
// vivo e o escolhido. So a RECONSULTA apos uma falha com escrita fecha as reservas por UPDATE.
//
// Vinculos divergentes (achado fiscal-01): item com linhas ligadas a PCs diferentes — a base do
// VINCULO_OMIE_MUDOU e, por sequencia, o vinculo que o servidor leu no portao 1
// (`vinculosPorSequencia`), nao um unico "visto" (`nCodItemOmieVisto`).
//
// A mensagem do RecebimentoFiscalError cita o PC (achado fiscal-04, FR-014): o numero lido ao
// vivo (reserva) ou, se a falha veio antes da reserva, o da escolha.
//
// A releitura em si (saldo ao vivo sem descontar vinculos concluidos, reserva entre NFs, regra dos
// 75 s, etapa 10) pertence a relerEReservarPcs (pc-sugestao.service) e NAO e exercitada aqui: ela e
// um spy que mantem as classes de erro REAIS do modulo (PcVinculoInvalidoError, PcRecemUsadoAguardeError).
// O harness do ledger e o de recebimento-fiscal.test.ts (016).
//
// Cenarios (ids do pedido de trabalho): 1 ordem; 2 vinculo do OMIE mantido; 3 IGNORAR nunca em
// item com PC; 4 NF mista; 5 VINCULO_OMIE_MUDOU; 6 releitura recusada; 7 fault no ASSOCIAR;
// 8 nova tentativa apos associar; 9 e 11 estoque ja lancado; 10 ja_concluido com PC;
// 12 transicoes; 13 ledger ja concluido; 14 lock orfao e duplo clique; 15 empresa;
// 16 vinculos divergentes (fiscal-01); 17 recusas sem releitura do PC (fiscal-02);
// 18 mensagem do erro cita o PC (fiscal-04).

const { loggerMock, relerSpy } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  relerSpy: vi.fn(),
}));
const poolQuerySpy = vi.fn();
const consultarSpy = vi.fn();
const alterarSpy = vi.fn();
const concluirSpy = vi.fn();

vi.mock('@atlas/core', () => ({
  createLogger: () => loggerMock,
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  getConfig: () => ({ STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: true }),
}));

vi.mock('@atlas/integration-omie', () => ({
  consultarRecebimentoNfe: (...a: unknown[]) => consultarSpy(...a),
  alterarRecebimentoNfeItens: (...a: unknown[]) => alterarSpy(...a),
  concluirRecebimentoNfe: (...a: unknown[]) => concluirSpy(...a),
  // o pc-sugestao importa o cliente no carregamento; so e chamado dentro de relerEReservarPcs (spy abaixo)
  consultarPedidoCompra: vi.fn(),
}));

vi.mock('../services/correlacao-produto.service.js', () => ({
  sugerirProdutosEmLote: vi.fn().mockResolvedValue(new Map()),
}));

// Classes de erro REAIS (PcVinculoInvalidoError, PcRecemUsadoAguardeError): so a releitura vira spy.
vi.mock('../services/pc-sugestao.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/pc-sugestao.service.js')>('../services/pc-sugestao.service.js');
  return { ...real, relerEReservarPcs: (...a: unknown[]) => relerSpy(...a) };
});

import {
  concluirRecebimentoFiscal,
  estoqueLancadoNoRecebimento,
  segundosAteNovaTentativa,
  PASSOS_COM_ESCRITA,
  ESPERA_APOS_FALHA_SEG,
  RecebimentoFiscalError,
  RecebimentoFiscalEmAndamentoError,
  RecebimentoFiscalAguardeError,
  RecebimentoFiscalNfCanceladaError,
  RecebimentoFiscalSemFornecedorError,
  RecebimentoFiscalEtapaInesperadaError,
  VinculoOmieMudouError,
  instanteConclusaoOmie,
} from '../services/recebimento-fiscal.service.js';
import { EstoqueJaLancadoPeloOmieError } from '../services/fila-nacional.service.js';
import {
  PcVinculoInvalidoError,
  PcRecemUsadoAguardeError,
  type EscolhaPcValidada,
  type PcCandidato,
  type ReservaPc,
} from '../services/pc-sugestao.service.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const CHAVE = '35261014555032000753550010000078131827355174';
const N_ID_RECEB = 8517007421;
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN = '2026-10-22 10:00:00.123456-03';
const FORNECEDOR = 'REPLAS COMERCIAL LTDA';
const FORNECEDOR_COD = 8498397152;

interface PcRef {
  nCodPed: number;
  nCodItem: number;
  numero: string;
}
/** PC 304 da Replas (NF 7813): nCodPed / nCodItem reais da sonda de 21/10/2026. */
const PC304: PcRef = { nCodPed: 8516905979, nCodItem: 8516907022, numero: '304' };
const PC302: PcRef = { nCodPed: 8516900302, nCodItem: 8516900303, numero: '302' };
const PC305: PcRef = { nCodPed: 8516900305, nCodItem: 8516900306, numero: '305' };

/** Item do recebimento (ConsultarRecebimento). Default: 18.000 kg, SEM vinculo e SEM os ajustes. */
const itemRec = (nSequencia: number, over: Record<string, unknown> = {}) => ({
  nSequencia,
  cDescricaoProduto: 'SUCATA PLASTICO',
  cCodigoProduto: 'SUCPLA',
  cNCM: '3915.90.00',
  cCFOP: '5.102',
  cCFOPEntrada: '1.102',
  nQtdeNFe: 18000,
  cUnidadeNfe: 'KG',
  nPrecoUnit: 11.3,
  vTotalItem: 203400,
  cIgnorarItem: 'N',
  cAssociarExistente: 'N',
  cAdicionarNovo: 'S',
  nIdItem: 0,
  nIdProduto: 0,
  nIdPedido: null,
  nIdItPedido: null,
  nNumPedCompra: null,
  cNumItPedCompra: null,
  cNaoGerarMovEstoque: 'N',
  cNaoGerarFinanceiro: 'N',
  ...over,
});

/** Campos do item ja vinculado ao PC no OMIE (vinculo VIVO). */
const vinculadoA = (pc: PcRef) => ({
  cAssociarExistente: 'S',
  nIdPedido: pc.nCodPed,
  nIdItPedido: pc.nCodItem,
  nNumPedCompra: pc.numero,
  cNumItPedCompra: 1,
});
/** Ajustes ja aplicados pelo EDITAR (receita da 016/017). */
const comAjustes = { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' };

const recebimento = (over: Record<string, unknown> = {}) => ({
  nIdReceb: N_ID_RECEB,
  cChaveNFe: CHAVE,
  cNumeroNFe: '000007813',
  cEtapa: '40',
  dEmissaoNFe: '20/10/2026',
  nIdFornecedor: FORNECEDOR_COD,
  cCNPJ_CPF: '14.555.032/0007-53',
  cRazaoSocial: FORNECEDOR,
  nValorNFe: 203400,
  cRecebido: 'N',
  cCancelada: 'N',
  cBloqueado: 'N',
  cDevolvido: 'N',
  cUsuarioRec: null,
  dRec: null,
  hRec: null,
  itens: [itemRec(1)],
  ...over,
});

const candidato = (pc: PcRef, over: Partial<PcCandidato> = {}): PcCandidato => ({
  nCodPed: pc.nCodPed,
  nCodItem: pc.nCodItem,
  pcNumero: pc.numero,
  produtoDescricao: 'PS CRISTAL B',
  qtdPedidaKg: 18000,
  saldoKg: 18000,
  precoUnit: 11.3,
  precoNfKgComparado: 11.3,
  dtPrevisao: '2026-10-20',
  etapa: '15',
  dentroTolerancia: true,
  casaNumeroPedidoNf: true,
  semDadosLocais: false,
  motivo: 'Dentro da tolerância',
  ...over,
});

/**
 * Escolha validada no portao 1 para o item agregado de indice 0 (sequencia 1, 18.000 kg).
 * Default: item SEM vinculo no OMIE e NAO divergente (`vinculosDivergentes: false`,
 * `vinculosPorSequencia: {}`). Quando o teste simula vinculo visto/lido no portao, ele preenche
 * `nCodItemOmieVisto` e `vinculosPorSequencia` (veja `lidoNoPortao`).
 */
const escolha = (pc: PcRef = PC304, over: Partial<EscolhaPcValidada> = {}): EscolhaPcValidada => ({
  indice: 0,
  sequencias: [1],
  origem: 'sugestao',
  candidato: candidato(pc),
  dentroTolerancia: true,
  justificativa: null,
  nCodPedOmieAnterior: null,
  nCodItemPedOmieAnterior: null,
  nCodItemOmieVisto: null,
  vinculosDivergentes: false,
  vinculosPorSequencia: {},
  oferecidos: [],
  qtdNfKg: 18000,
  precoNfKg: 11.3,
  kgPorSequencia: { 1: 18000 },
  itemDescricao: 'SUCATA PLASTICO',
  ...over,
});

/** `vinculosPorSequencia`: o vinculo que o servidor leu no portao 1 para cada par [sequencia, PC]. */
const lidoNoPortao = (...pares: Array<[number, PcRef]>): EscolhaPcValidada['vinculosPorSequencia'] =>
  Object.fromEntries(pares.map(([seq, pc]) => [seq, { nIdPedido: pc.nCodPed, nIdItPedido: pc.nCodItem }]));

/**
 * Escolha de `pc` para o item de 1 sequencia (NAO divergente) que a tela viu ligado a `visto` no
 * OMIE (`null` = sem vinculo): preenche o "visto" e o que o portao 1 leu, coerentes entre si.
 */
const escolhaVendo = (pc: PcRef, visto: PcRef | null, over: Partial<EscolhaPcValidada> = {}): EscolhaPcValidada =>
  escolha(pc, { nCodItemOmieVisto: visto?.nCodItem ?? null, vinculosPorSequencia: visto ? lidoNoPortao([1, visto]) : {}, ...over });

/**
 * Item de 9.000 kg com 2 sequencias (1 e 2), cada uma ligada a um PC diferente no OMIE — o caso
 * de vinculos divergentes (achado fiscal-01). `escolhaDivergente` o escolhe para `pc` com os
 * vinculos lidos no portao 1 (seq 1 no PC 304, seq 2 no PC 302), sem "visto" unico (a tela nao
 * tem um) e com a justificativa que a troca exige; o "anterior" e a 1a linha ligada a outro PC,
 * como em validarEscolhaPc.
 */
const itensDivergentes = (seq1: PcRef, seq2: PcRef) => [
  itemRec(1, { ...vinculadoA(seq1), nQtdeNFe: 9000 }),
  itemRec(2, { ...vinculadoA(seq2), nQtdeNFe: 9000 }),
];
const escolhaDivergente = (pc: PcRef, over: Partial<EscolhaPcValidada> = {}): EscolhaPcValidada => {
  const lidos = lidoNoPortao([1, PC304], [2, PC302]);
  const anterior = Object.values(lidos).find((v) => !(v.nIdPedido === pc.nCodPed && v.nIdItPedido === pc.nCodItem));
  return escolha(pc, {
    sequencias: [1, 2],
    kgPorSequencia: { 1: 9000, 2: 9000 },
    vinculosDivergentes: true,
    vinculosPorSequencia: lidos,
    nCodItemOmieVisto: null,
    nCodPedOmieAnterior: anterior?.nIdPedido ?? null,
    nCodItemPedOmieAnterior: anterior?.nIdItPedido ?? null,
    justificativa: 'Compras pediu o PC escolhido para o item inteiro',
    ...over,
  });
};

/**
 * Recebimento ja concluido (cRecebido S, etapa 60) — pelo portal, ou por um Concluir do Atlas cuja
 * resposta se perdeu. SEM estoque: os itens nao ignorados trazem "nao movimentar estoque" (S).
 */
const concluidoSemEstoque = (itens: Array<Record<string, unknown>>) => ({ cRecebido: 'S', cEtapa: '60', cUsuarioRec: 'gustavo', itens });
/** ... COM estoque (D7): o portal concluiu o item 1 (no PC 304) sem "nao movimentar estoque". */
const concluidoComEstoque = (itensOver: Record<string, unknown> = {}) =>
  concluidoSemEstoque([itemRec(1, { ...vinculadoA(PC304), cNaoGerarMovEstoque: 'N', ...itensOver })]);

/** O que o relerEReservarPcs real devolveria: uma reserva por sequencia de cada escolha. */
const reservasDe = (escolhas: EscolhaPcValidada[]): ReservaPc[] =>
  escolhas.flatMap((e) =>
    e.sequencias.map((seq) => ({
      id: `reserva-${seq}`,
      nSequencia: seq,
      indice: e.indice,
      nCodPed: e.candidato.nCodPed,
      nCodItemPed: e.candidato.nCodItem,
      pcNumero: e.candidato.pcNumero,
      origem: e.origem,
    })),
  );

const input = (over: Partial<Parameters<typeof concluirRecebimentoFiscal>[0]> = {}) => ({
  nfChaveAcesso: CHAVE,
  nIdReceb: N_ID_RECEB,
  notaFiscal: '7813',
  fornecedorNome: FORNECEDOR,
  userId: USER,
  fornecedorCodigo: FORNECEDOR_COD,
  ...over,
});

// ── Harness do ledger (espelha o de recebimento-fiscal.test.ts) ──────────────

/** Linha do tempo do que aconteceu (ledger, PC e OMIE), para provar a ordem. */
let ordem: string[] = [];
/** Params de cada UPDATE de fechamento do ledger (11 posicoes: $1..$11). */
let fechamentos: unknown[][] = [];
interface Marcacao {
  ledgerId: string;
  de: string[];
  para: string;
  codigo: string | null;
  mensagem: string | null;
}
/**
 * UPDATEs em bloco das linhas de recebimento_fiscal_pc de um ledger (marcarVinculos). Toda recusa e toda
 * falha emitem um — mesmo antes da reserva, quando ele nao atinge nenhuma linha (idempotente).
 */
let marcacoes: Marcacao[] = [];
/**
 * UPDATEs por reserva no ja_concluido da RECONSULTA apos falha com escrita (fecharVinculosJaConcluido).
 * Na PRIMEIRA consulta nao ha nenhum: nada foi reservado (achado fiscal-03).
 */
let reservasFechadas: Array<{ id: string; para: string }> = [];
/** SQL que o harness nao conhece: o afterEach exige lista vazia (nada passa despercebido). */
let sqlNaoReconhecido: string[] = [];
let insertFalha: unknown = null;
let linhaViva: Record<string, unknown> | null = null;
let retomadaOk = false;
let esperaSegundos: number | null = null;
let vinculosLedgerRows: Record<string, unknown>[] = [];
let vinculosLedgerLanca = false;
let marcarLanca = false;
let reservaFechaLanca = false;
/**
 * UPDATE que fecha as reservas vivas de tentativas anteriores da NF (qualquer ledger — achado fiscal-v01):
 * no ja_concluido da 1a consulta e, sem escolha de PC, antes das escritas (com escolha, quem fecha e o
 * relerEReservarPcs, mockado aqui). Registra a chave da NF.
 */
let orfasFechadas: string[] = [];
/** INSERTs em estado final no ja_concluido da 1a consulta (registrarVinculosJaConcluido): params $1..$19. */
let registros: unknown[][] = [];
let registroLanca = false;
/** Linha registrada como objeto legivel (posicoes do INSERT de registrarVinculosJaConcluido). */
const registro = (p: unknown[]) => ({
  ledgerId: p[0], nSequencia: p[3], origem: p[4], nCodPed: p[5], nCodItem: p[6], pcNumero: p[7], anteriorPed: p[8], anteriorItem: p[9],
  dentroTolerancia: p[10], justificativa: p[11], qtdKg: p[13], status: p[15], erro: p[16], concluidoEm: p[18],
});

function responder(sql: string, params: unknown[] = []) {
  // A tabela filha vem PRIMEIRO: 'UPDATE stockbridge.recebimento_fiscal' e prefixo de '..._pc'.
  if (sql.includes('stockbridge.recebimento_fiscal_pc')) {
    if (/^\s*SELECT/.test(sql)) {
      ordem.push('pc:ler-concluidos');
      if (vinculosLedgerLanca) throw new Error('connection terminated');
      return { rows: vinculosLedgerRows };
    }
    if (sql.includes('status = ANY($2::text[])')) {
      const [ledgerId, de, para, codigo, mensagem] = params as [string, string[], string, string | null, string | null];
      ordem.push(`pc:${para}`);
      marcacoes.push({ ledgerId, de, para, codigo, mensagem });
      if (marcarLanca) throw new Error('connection terminated');
      return { rows: [] };
    }
    if (sql.includes('WHERE id = $1 AND status IN')) {
      const [id, para] = params as [string, string];
      ordem.push(`pc:reserva-${para}`);
      reservasFechadas.push({ id, para });
      if (reservaFechaLanca) throw new Error('connection terminated');
      return { rows: [] };
    }
    if (sql.includes('WHERE nf_chave_acesso = $1 AND empresa = $2 AND status IN')) {
      ordem.push('pc:fechar-orfas');
      orfasFechadas.push(String(params[0]));
      return { rows: [] };
    }
    if (/^\s*INSERT INTO stockbridge.recebimento_fiscal_pc/.test(sql)) {
      ordem.push(`pc:registrar-${String(params[15])}`);
      registros.push(params);
      if (registroLanca) throw new Error('connection terminated');
      return { rows: [] };
    }
    sqlNaoReconhecido.push(sql);
    return { rows: [] };
  }
  if (sql.includes("status = 'falha'") && sql.includes('make_interval(secs')) {
    ordem.push('ledger:espera?');
    return { rows: esperaSegundos != null ? [{ segundos: esperaSegundos }] : [] };
  }
  if (sql.includes('INSERT INTO stockbridge.recebimento_fiscal')) {
    ordem.push('ledger:insert');
    if (insertFalha) {
      const e = insertFalha;
      insertFalha = null;
      throw e;
    }
    return { rows: [{ id: 'ledger-1', token: TOKEN }] };
  }
  if (sql.includes('SELECT id, status, iniciado_em')) return { rows: linhaViva ? [linhaViva] : [] };
  if (sql.includes('make_interval(mins')) {
    ordem.push('ledger:retomar');
    return { rows: retomadaOk ? [{ id: String(linhaViva?.id ?? 'ledger-0'), token: 'TOKEN-RETOMADA' }] : [] };
  }
  if (sql.includes('UPDATE stockbridge.recebimento_fiscal') && sql.includes('SET status = $2')) {
    ordem.push(`ledger:${String(params[1])}`);
    fechamentos.push(params);
    return { rows: [{ finalizado_em: '2026-10-22 10:00:00+00' }] };
  }
  sqlNaoReconhecido.push(sql);
  return { rows: [] };
}

/** ordem sem a consulta de espera (que roda em toda aquisicao) */
const ordemSemEspera = () => ordem.filter((o) => o !== 'ledger:espera?');

type RefConsulta = { cChaveNfe?: string; nIdReceb?: number };
interface ChamadaAlterar {
  nIdReceb: number;
  itens: ItemRecebimentoEditar[];
}

/** ConsultarRecebimento: registra se foi a consulta (por chave) ou a reconsulta (por nIdReceb). */
const consulta = (over: Record<string, unknown> = {}) => async (_empresa: string, ref: RefConsulta) => {
  ordem.push(ref.nIdReceb != null ? 'omie:reconsultar' : 'omie:consultar');
  return recebimento(over);
};
/** So a PROXIMA ConsultarRecebimento devolve `over`. */
const consultaUnica = (over: Record<string, unknown>) => consultarSpy.mockImplementationOnce(consulta(over));
/** A PROXIMA releitura do PC lanca `err` (registrada na linha do tempo, como a implementacao padrao). */
const relerFalhaCom = (err: unknown) =>
  relerSpy.mockImplementationOnce(async () => {
    ordem.push('pc:reler');
    throw err;
  });

const alterarOk = async (_empresa: string, i: ChamadaAlterar) => {
  ordem.push(`omie:${i.itens[0]!.cAcao.toLowerCase()}`);
  return { nIdReceb: i.nIdReceb, cCodStatus: '0', cDescStatus: 'ok' };
};
const concluirOk = async (_empresa: string, i: { nIdReceb: number }) => {
  ordem.push('omie:concluir');
  return { nIdReceb: i.nIdReceb, cCodStatus: '0', cDescStatus: 'Recebimento concluído com sucesso!' };
};

const fault = (code: string, message: string) => Object.assign(new Error(message), { omieCode: code });
const violacaoLedgerViva = () => Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'recebimento_fiscal_nf_viva_uq' });

const chamadasAlterar = (): ChamadaAlterar[] => alterarSpy.mock.calls.map((c) => c[1] as ChamadaAlterar);
/** nSequencia de todos os itens enviados com a acao, em todas as chamadas de AlterarRecebimento. */
const seqsDaAcao = (acao: string): number[] => chamadasAlterar().flatMap((c) => c.itens.filter((i) => i.cAcao === acao).map((i) => i.nSequencia));
/** Acoes DISTINTAS de cada chamada (uma por chamada: itensAjustes so vale com EDITAR — erro 151). */
const acoesPorChamada = (): string[][] => chamadasAlterar().map((c) => Array.from(new Set(c.itens.map((i) => i.cAcao))));
const sqlDe = (trecho: string): string[] => poolQuerySpy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes(trecho));
const inserts = (): string[] => poolQuerySpy.mock.calls.map((c) => String(c[0])).filter((s) => /^\s*INSERT/i.test(s));
/** Todo SQL (UPDATE, INSERT, SELECT) emitido contra stockbridge.recebimento_fiscal_pc. */
const sqlDoPc = (): string[] => sqlDe('stockbridge.recebimento_fiscal_pc');
/** Roda a chamada e devolve o erro lancado (o teste falha se ela nao lancar). */
const erroDe = async (chamada: Promise<unknown>): Promise<Error> => {
  try {
    await chamada;
  } catch (e) {
    return e as Error;
  }
  throw new Error('a chamada deveria ter lançado');
};
/** ConsultarRecebimento que falha (OMIE fora do ar), registrada na linha do tempo como a consulta por chave. */
const consultaFalha = (err: unknown) => async (_empresa: string, ref: RefConsulta) => {
  ordem.push(ref.nIdReceb != null ? 'omie:reconsultar' : 'omie:consultar');
  throw err;
};

beforeEach(() => {
  ordem = [];
  fechamentos = [];
  marcacoes = [];
  reservasFechadas = [];
  sqlNaoReconhecido = [];
  insertFalha = null;
  linhaViva = null;
  retomadaOk = false;
  esperaSegundos = null;
  vinculosLedgerRows = [];
  vinculosLedgerLanca = false;
  marcarLanca = false;
  reservaFechaLanca = false;
  orfasFechadas = [];
  registros = [];
  registroLanca = false;
  for (const f of Object.values(loggerMock)) f.mockClear();
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation(async (sql: string, params?: unknown[]) => responder(sql, params));
  relerSpy.mockReset();
  relerSpy.mockImplementation(async (a: { escolhas: EscolhaPcValidada[] }) => {
    ordem.push('pc:reler');
    return reservasDe(a.escolhas);
  });
  consultarSpy.mockReset();
  consultarSpy.mockImplementation(consulta());
  alterarSpy.mockReset();
  alterarSpy.mockImplementation(alterarOk);
  concluirSpy.mockReset();
  concluirSpy.mockImplementation(concluirOk);
});

afterEach(() => {
  expect(sqlNaoReconhecido).toEqual([]);
});

// ── Cenarios 1 e 12 — item sem vinculo, escolha da sugestao ──────────────────

describe('concluirRecebimentoFiscal com PC — item sem vínculo, escolha da sugestão (cenários 1 e 12)', () => {
  it('ordem: trava do ledger -> ConsultarRecebimento -> releitura do PC -> ASSOCIAR-PEDIDO -> EDITAR -> Concluir; nenhum IGNORAR', async () => {
    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(ordemSemEspera()).toEqual([
      'ledger:insert',
      'omie:consultar',
      'pc:reler',
      'omie:associar-pedido',
      'pc:associado',
      'omie:editar',
      'omie:concluir',
      'ledger:concluido',
      'pc:concluido',
    ]);
    expect(seqsDaAcao('IGNORAR')).toEqual([]);
    expect(acoesPorChamada()).toEqual([['ASSOCIAR-PEDIDO'], ['EDITAR']]);
    expect(r).toMatchObject({ status: 'concluido', ledgerId: 'ledger-1', itensTotal: 1, semVinculo: [] });
    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' }]);
  });

  it('ASSOCIAR-PEDIDO leva o PC escolhido e nenhum itensAjustes; EDITAR leva os ajustes; Concluir na etapa 60', async () => {
    await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    const [associar, editar, outras] = chamadasAlterar();
    expect(outras).toBeUndefined();
    expect(associar).toEqual({
      nIdReceb: N_ID_RECEB,
      itens: [{ nSequencia: 1, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: PC304.nCodPed, nIdItPedidoExistente: PC304.nCodItem }],
    });
    expect(associar!.itens[0]).not.toHaveProperty('itensAjustes'); // itensAjustes so com EDITAR (erro 151)
    expect(editar).toEqual({
      nIdReceb: N_ID_RECEB,
      itens: [{ nSequencia: 1, cAcao: 'EDITAR', itensAjustes: { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' } }],
    });
    expect(consultarSpy).toHaveBeenCalledTimes(1);
    expect(consultarSpy).toHaveBeenCalledWith('q2p', { cChaveNfe: CHAVE });
    expect(alterarSpy.mock.calls.every((c) => c[0] === 'q2p')).toBe(true);
    expect(concluirSpy).toHaveBeenCalledTimes(1);
    expect(concluirSpy).toHaveBeenCalledWith('q2p', { nIdReceb: N_ID_RECEB, cEtapa: '60' });
  });

  it('relerEReservarPcs recebe empresa, id do ledger, chave, NF, fornecedor, usuário e as escolhas (depois da trava e da consulta, antes de qualquer escrita)', async () => {
    const e = escolha(PC304);
    await concluirRecebimentoFiscal(input({ vinculos: [e] }));

    expect(relerSpy).toHaveBeenCalledTimes(1);
    expect(relerSpy).toHaveBeenCalledWith({
      empresa: 'q2p',
      ledgerId: 'ledger-1',
      nfChaveAcesso: CHAVE,
      notaFiscal: '7813',
      fornecedorCodigo: FORNECEDOR_COD,
      userId: USER,
      escolhas: [e],
      // achado sugestao-v01: o vinculo VIVO de cada sequencia, lido na ConsultarRecebimento desta tentativa
      vinculosVivos: { 1: null },
    });
    // achado fiscal-02: a consulta por chave vem ANTES da releitura; a releitura, antes de toda escrita
    expect(consultarSpy.mock.invocationCallOrder[0]!).toBeLessThan(relerSpy.mock.invocationCallOrder[0]!);
    expect(relerSpy.mock.invocationCallOrder[0]!).toBeLessThan(alterarSpy.mock.invocationCallOrder[0]!);
    expect(relerSpy.mock.invocationCallOrder[0]!).toBeLessThan(concluirSpy.mock.invocationCallOrder[0]!);
  });

  it('fornecedorCodigo omitido chega como null à releitura do PC', async () => {
    await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)], fornecedorCodigo: undefined }));
    expect(relerSpy.mock.calls[0]![0]).toMatchObject({ fornecedorCodigo: null });
  });

  it('transições das linhas de vínculo: associado (de confirmado) depois do ASSOCIAR e antes do EDITAR; concluido depois do Concluir', async () => {
    await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(marcacoes).toEqual([
      { ledgerId: 'ledger-1', de: ['confirmado'], para: 'associado', codigo: null, mensagem: null },
      { ledgerId: 'ledger-1', de: ['confirmado', 'associado'], para: 'concluido', codigo: null, mensagem: null },
    ]);
    const pos = (x: string) => ordem.indexOf(x);
    expect(pos('omie:associar-pedido')).toBeLessThan(pos('pc:associado'));
    expect(pos('pc:associado')).toBeLessThan(pos('omie:editar'));
    expect(pos('omie:concluir')).toBeLessThan(pos('pc:concluido'));
  });

  it('fechamento do ledger leva itens_vinculados (11º parâmetro) = nº de itens que terminaram vinculados; token do lock no 10º', async () => {
    consultaUnica({ itens: [itemRec(1), itemRec(2)] });
    const e1 = escolha(PC304, { indice: 0, sequencias: [1] });
    const e2 = escolha(PC302, { indice: 1, sequencias: [2], kgPorSequencia: { 2: 18000 } });

    const r = await concluirRecebimentoFiscal(input({ vinculos: [e1, e2] }));

    expect(r.status).toBe('concluido');
    expect(fechamentos).toHaveLength(1);
    expect(fechamentos[0]).toHaveLength(11);
    expect(fechamentos[0]!.slice(0, 7)).toEqual(['ledger-1', 'concluido', N_ID_RECEB, '40', 'N', 2, null]);
    expect(fechamentos[0]![9]).toBe(TOKEN);
    expect(fechamentos[0]![10]).toBe(2);
    expect(r.vinculos.map((v) => [v.nSequencia, v.pcNumero])).toEqual([[1, '304'], [2, '302']]);
  });

  it('item agregado por descrição (2 sequências): ASSOCIAR-PEDIDO em cada sequência, na mesma chamada; uma reserva e um vínculo por sequência', async () => {
    consultaUnica({ itens: [itemRec(1, { nQtdeNFe: 9000 }), itemRec(3, { nQtdeNFe: 9000 })] });
    const e = escolha(PC304, { sequencias: [1, 3], kgPorSequencia: { 1: 9000, 3: 9000 } });

    const r = await concluirRecebimentoFiscal(input({ vinculos: [e] }));

    const [associar, editar] = chamadasAlterar();
    expect(associar!.itens).toEqual([
      { nSequencia: 1, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: PC304.nCodPed, nIdItPedidoExistente: PC304.nCodItem },
      { nSequencia: 3, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: PC304.nCodPed, nIdItPedidoExistente: PC304.nCodItem },
    ]);
    expect(editar!.itens.map((i) => i.nSequencia)).toEqual([1, 3]);
    expect(r.vinculos.map((v) => v.nSequencia)).toEqual([1, 3]);
    expect(fechamentos[0]![10]).toBe(2);
  });

  it('sem escolhas (vinculos omitido): a receita da 016 segue intacta — nenhuma releitura de PC, nenhuma linha de vínculo, itens_vinculados nulo', async () => {
    const r = await concluirRecebimentoFiscal(input());

    expect(relerSpy).not.toHaveBeenCalled();
    expect(marcacoes).toEqual([]);
    // achado fiscal-v01: sem escolha de PC, so fecha as reservas que sobraram de uma tentativa anterior da NF
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'pc:fechar-orfas', 'omie:editar', 'omie:ignorar', 'omie:concluir', 'ledger:concluido']);
    expect(orfasFechadas).toEqual([CHAVE]);
    expect(fechamentos[0]![10]).toBeNull();
    expect(r.vinculos).toEqual([]);
    expect(r.semVinculo).toEqual([]);
  });

  it('a releitura recebe o vínculo VIVO de cada sequência (base da isenção de fornecedor do vínculo do OMIE — achado sugestao-v01)', async () => {
    consultaUnica({ itens: [itemRec(1, { ...vinculadoA(PC304), ...comAjustes }), itemRec(2)] });
    await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { origem: 'omie', sequencias: [1, 2], kgPorSequencia: { 1: 9000, 2: 9000 } })] }));
    expect(relerSpy.mock.calls[0]![0]).toMatchObject({
      vinculosVivos: { 1: { nIdPedido: PC304.nCodPed, nIdItPedido: PC304.nCodItem }, 2: null },
    });
  });

  it('o resultado identifica o PC pelo número legível, nunca por código do OMIE (ACXEGDP-313)', async () => {
    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));
    expect(JSON.stringify(r.vinculos)).not.toMatch(/\d{9,}/);
    expect(r.vinculos[0]!.pcNumero).toBe('304');
  });
});

// ── Cenario 2 — vinculo do OMIE mantido ──────────────────────────────────────

describe('concluirRecebimentoFiscal com PC — vínculo do OMIE mantido (cenário 2)', () => {
  // a tela viu (e o portao 1 leu) o item ligado ao PC 304
  const escolhaOmie = () => escolha(PC304, { origem: 'omie', nCodItemOmieVisto: PC304.nCodItem, vinculosPorSequencia: lidoNoPortao([1, PC304]) });

  it('vivo = escolhido, sem os ajustes: sem ASSOCIAR-PEDIDO; só EDITAR e Concluir (a linha vai a associado direto)', async () => {
    consultaUnica({ itens: [itemRec(1, vinculadoA(PC304))] });

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolhaOmie()] }));

    expect(ordemSemEspera()).toEqual([
      'ledger:insert',
      'omie:consultar',
      'pc:reler',
      'pc:associado',
      'omie:editar',
      'omie:concluir',
      'ledger:concluido',
      'pc:concluido',
    ]);
    expect(seqsDaAcao('ASSOCIAR-PEDIDO')).toEqual([]);
    expect(seqsDaAcao('IGNORAR')).toEqual([]);
    expect(seqsDaAcao('EDITAR')).toEqual([1]);
    expect(r.status).toBe('concluido');
    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'omie', status: 'concluido' }]);
    expect(fechamentos[0]![10]).toBe(1);
  });

  it('vivo = escolhido, com os ajustes já aplicados: só Concluir (nenhum AlterarRecebimento)', async () => {
    consultaUnica({ itens: [itemRec(1, { ...vinculadoA(PC304), ...comAjustes })] });

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolhaOmie()] }));

    expect(alterarSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual([
      'ledger:insert',
      'omie:consultar',
      'pc:reler',
      'pc:associado',
      'omie:concluir',
      'ledger:concluido',
      'pc:concluido',
    ]);
    expect(concluirSpy).toHaveBeenCalledWith('q2p', { nIdReceb: N_ID_RECEB, cEtapa: '60' });
    expect(r.status).toBe('concluido');
    expect(r.vinculos).toHaveLength(1);
  });

  it('não movimentar estoque já em S, mas o financeiro desligado (cNaoGerarFinanceiro S): EDITAR corrige — a conta a pagar precisa ser gerada', async () => {
    consultaUnica({ itens: [itemRec(1, { ...vinculadoA(PC304), cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'S' })] });

    await concluirRecebimentoFiscal(input({ vinculos: [escolhaOmie()] }));

    expect(seqsDaAcao('EDITAR')).toEqual([1]);
    expect(chamadasAlterar()[0]!.itens[0]).toMatchObject({ itensAjustes: { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' } });
    expect(seqsDaAcao('ASSOCIAR-PEDIDO')).toEqual([]);
  });
});

// ── Cenarios 3 e 4 — IGNORAR nunca em item com PC; NF mista ─────────────────

describe('concluirRecebimentoFiscal com PC — IGNORAR nunca em item com PC (cenários 3 e 4)', () => {
  it('3 itens: seq 1 com escolha, seq 2 sem escolha mas com vínculo vivo (fora do recorte), seq 3 sem vínculo; o IGNORAR leva só a seq 3', async () => {
    consultaUnica({ itens: [itemRec(1), itemRec(2, vinculadoA(PC302)), itemRec(3)] });

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { sequencias: [1] })] }));

    expect(r.status).toBe('concluido');
    expect(seqsDaAcao('ASSOCIAR-PEDIDO')).toEqual([1]);
    expect(seqsDaAcao('EDITAR')).toEqual([1, 2, 3]); // a seq 2 so recebe EDITAR (mantem o vinculo)
    expect(seqsDaAcao('IGNORAR')).toEqual([3]);
    expect(acoesPorChamada()).toEqual([['ASSOCIAR-PEDIDO'], ['EDITAR'], ['IGNORAR']]);
    const ignorar = chamadasAlterar()[2]!;
    expect(ignorar.itens).toEqual([{ nSequencia: 3, cAcao: 'IGNORAR' }]);
    expect(ignorar.itens[0]).not.toHaveProperty('itensAjustes');
    // seq 1 (escolha) e seq 2 (vinculo mantido) terminam vinculadas
    expect(fechamentos[0]![10]).toBe(2);
    expect(r.vinculos).toContainEqual({ nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' });
    // a seq 3 nao foi marcada como "receber sem vinculo": nao entra em semVinculo
    expect(r.semVinculo).toEqual([]);
  });

  it.each([
    ['escolha sem vínculo vivo', () => [itemRec(1)], () => escolha(PC304)],
    ['escolha igual ao vínculo vivo (sem os ajustes)', () => [itemRec(1, vinculadoA(PC304))], () => escolhaVendo(PC304, PC304, { origem: 'omie' })],
    ['escolha igual ao vínculo vivo (ajustes já aplicados)', () => [itemRec(1, { ...vinculadoA(PC304), ...comAjustes })], () => escolhaVendo(PC304, PC304, { origem: 'omie' })],
    [
      'troca explícita: vivo 302 (visto 302), escolhido 304',
      () => [itemRec(1, vinculadoA(PC302))],
      () => escolhaVendo(PC304, PC302, { nCodPedOmieAnterior: PC302.nCodPed, nCodItemPedOmieAnterior: PC302.nCodItem, justificativa: 'Compras pediu o 304' }),
    ],
  ])('IGNORAR nunca na sequência com PC — %s', async (_nome, itens, esc) => {
    consultaUnica({ itens: itens() });
    const r = await concluirRecebimentoFiscal(input({ vinculos: [esc()] }));
    expect(r.status).toBe('concluido');
    expect(seqsDaAcao('IGNORAR')).toEqual([]);
    expect(ordem).not.toContain('omie:ignorar');
  });

  it('troca explícita (vivo = visto = 302, escolhido 304): NÃO é conflito; ASSOCIAR-PEDIDO ao novo PC, depois EDITAR — o vínculo é trocado, nunca desfeito', async () => {
    consultaUnica({ itens: [itemRec(1, vinculadoA(PC302))] });
    const troca = escolhaVendo(PC304, PC302, {
      nCodPedOmieAnterior: PC302.nCodPed,
      nCodItemPedOmieAnterior: PC302.nCodItem,
      justificativa: 'Compras pediu o 304',
    });

    const r = await concluirRecebimentoFiscal(input({ vinculos: [troca] }));

    expect(r.status).toBe('concluido');
    expect(acoesPorChamada()).toEqual([['ASSOCIAR-PEDIDO'], ['EDITAR']]);
    expect(chamadasAlterar()[0]!.itens).toEqual([
      { nSequencia: 1, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: PC304.nCodPed, nIdItPedidoExistente: PC304.nCodItem },
    ]);
    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' }]);
  });

  it('item com vínculo vivo e sem escolha, já com os ajustes: nem EDITAR nem IGNORAR (só a seq com PC escolhido mexe no OMIE)', async () => {
    consultaUnica({ itens: [itemRec(1, { ...vinculadoA(PC304), ...comAjustes }), itemRec(2, { ...vinculadoA(PC302), ...comAjustes })] });
    await concluirRecebimentoFiscal(input({ vinculos: [escolhaVendo(PC304, PC304, { origem: 'omie' })] }));
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).toHaveBeenCalledTimes(1);
  });

  it('NF mista no modo "receber sem vínculo": seq 1 com escolha, seq 2 em sequenciasSemVinculo; semVinculo [2] e o IGNORAR só da seq 2', async () => {
    consultaUnica({ itens: [itemRec(1), itemRec(2)] });

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { sequencias: [1] })], sequenciasSemVinculo: [2] }));

    expect(r.status).toBe('concluido');
    expect(r.semVinculo).toEqual([2]);
    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' }]);
    expect(seqsDaAcao('ASSOCIAR-PEDIDO')).toEqual([1]);
    expect(seqsDaAcao('EDITAR')).toEqual([1, 2]);
    expect(seqsDaAcao('IGNORAR')).toEqual([2]);
    expect(acoesPorChamada()).toEqual([['ASSOCIAR-PEDIDO'], ['EDITAR'], ['IGNORAR']]);
    // so a seq 1 terminou vinculada ao PC
    expect(fechamentos[0]![10]).toBe(1);
    expect(ordemSemEspera()).toEqual([
      'ledger:insert',
      'omie:consultar',
      'pc:reler',
      'omie:associar-pedido',
      'pc:associado',
      'omie:editar',
      'omie:ignorar',
      'omie:concluir',
      'ledger:concluido',
      'pc:concluido',
    ]);
  });

  it('NF só com itens sem PC (modo "receber sem vínculo", nenhuma escolha): receita da 016 para todos — nenhuma releitura de PC', async () => {
    consultaUnica({ itens: [itemRec(1), itemRec(2)] });
    const r = await concluirRecebimentoFiscal(input({ sequenciasSemVinculo: [1, 2] }));
    expect(relerSpy).not.toHaveBeenCalled();
    expect(seqsDaAcao('IGNORAR')).toEqual([1, 2]);
    expect(r.semVinculo).toEqual([1, 2]);
    expect(r.vinculos).toEqual([]);
    expect(fechamentos[0]![10]).toBeNull();
  });
});

// ── Cenario 5 — VINCULO_OMIE_MUDOU ──────────────────────────────────────────

describe('concluirRecebimentoFiscal com PC — VINCULO_OMIE_MUDOU (cenário 5)', () => {
  it('vivo 302, visto 304, escolhido 304: VinculoOmieMudouError, nenhuma escrita no OMIE, ledger em falha (consultar), SEM releitura nem reserva do PC', async () => {
    consultaUnica({ itens: [itemRec(1, vinculadoA(PC302))] });

    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input({ vinculos: [escolhaVendo(PC304, PC304)] }));
    } catch (e) {
      erro = e;
    }

    expect(erro).toBeInstanceOf(VinculoOmieMudouError);
    const e = erro as VinculoOmieMudouError;
    expect(e.message).toContain('NF 7813');
    expect(e.message).toContain('SUCATA PLASTICO');
    expect(e.message).toContain('Recarregue a nota');
    expect(e.message).not.toMatch(/\d{9,}/); // sem codigos do OMIE (ACXEGDP-313)
    // nenhuma escrita; e como e erro de dominio, nem reconsulta
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(consultarSpy).toHaveBeenCalledTimes(1);
    // achado fiscal-02: a recusa vem da consulta, ANTES da releitura — nada foi reservado
    expect(relerSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'ledger:falha', 'pc:falha']);
    expect(fechamentos[0]!.slice(1, 9)).toEqual(['falha', N_ID_RECEB, '40', 'N', 1, 'consultar', null, expect.stringContaining('Vínculo mudou no OMIE')]);
    // o UPDATE em bloco das linhas confirmado/associado ainda sai (idempotente: 0 linhas, nada foi reservado)
    expect(marcacoes).toEqual([
      { ledgerId: 'ledger-1', de: ['confirmado', 'associado'], para: 'falha', codigo: null, mensagem: expect.stringContaining('Vínculo mudou no OMIE') },
    ]);
    // o motivo tecnico (so no ledger) traz o que mudou
    expect(String(fechamentos[0]![8])).toContain('vínculo vivo');
  });

  it('vivo = escolhido mas diferente do visto: NÃO é conflito (alguém já associou o PC escolhido); segue sem ASSOCIAR', async () => {
    consultaUnica({ itens: [itemRec(1, vinculadoA(PC304))] });

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolhaVendo(PC304, PC302)] }));

    expect(r.status).toBe('concluido');
    expect(seqsDaAcao('ASSOCIAR-PEDIDO')).toEqual([]);
    expect(seqsDaAcao('EDITAR')).toEqual([1]);
  });

  it('tela sem vínculo (visto nulo) e vivo = escolhido (tentativa anterior associou): NÃO é conflito', async () => {
    consultaUnica({ itens: [itemRec(1, vinculadoA(PC304))] });
    // a tela carregou antes do ASSOCIAR (visto nulo); o portao 1, ja no POST, leu o 304
    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { nCodItemOmieVisto: null, vinculosPorSequencia: lidoNoPortao([1, PC304]) })] }));
    expect(r.status).toBe('concluido');
    expect(seqsDaAcao('ASSOCIAR-PEDIDO')).toEqual([]);
  });

  it('vivo ausente com visto 304 (vínculo removido no OMIE): NÃO é conflito; segue para o ASSOCIAR-PEDIDO', async () => {
    consultaUnica({ itens: [itemRec(1)] });

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolhaVendo(PC304, PC304)] }));

    expect(r.status).toBe('concluido');
    expect(seqsDaAcao('ASSOCIAR-PEDIDO')).toEqual([1]);
    expect(acoesPorChamada()).toEqual([['ASSOCIAR-PEDIDO'], ['EDITAR']]);
  });

  it('tela sem vínculo (visto nulo), mas o OMIE ganhou o vínculo 302 e o operador escolheu 304: conflito, sem releitura do PC', async () => {
    consultaUnica({ itens: [itemRec(1, vinculadoA(PC302))] });
    await expect(concluirRecebimentoFiscal(input({ vinculos: [escolhaVendo(PC304, null)] }))).rejects.toBeInstanceOf(VinculoOmieMudouError);
    expect(relerSpy).not.toHaveBeenCalled();
    expect(alterarSpy).not.toHaveBeenCalled();
  });

  it('sequência em sequenciasSemVinculo que ganhou vínculo vivo: conflito, sem escrita', async () => {
    consultaUnica({ itens: [itemRec(1), itemRec(2, { ...vinculadoA(PC302), cDescricaoProduto: 'SUCATA DE PEAD' })] });

    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { sequencias: [1] })], sequenciasSemVinculo: [2] }));
    } catch (e) {
      erro = e;
    }

    expect(erro).toBeInstanceOf(VinculoOmieMudouError);
    expect((erro as Error).message).toContain('SUCATA DE PEAD'); // descricao do item que ganhou o vinculo
    expect(relerSpy).not.toHaveBeenCalled(); // a recusa vem antes da releitura do PC
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(fechamentos[0]![1]).toBe('falha');
    expect(fechamentos[0]![6]).toBe('consultar');
    expect(String(fechamentos[0]![8])).toContain('ganhou vínculo');
    expect(marcacoes.map((m) => m.para)).toEqual(['falha']);
  });

  it('só sequenciasSemVinculo (nenhuma escolha) com vínculo vivo no OMIE: conflito, e sem releitura de PC', async () => {
    consultaUnica({ itens: [itemRec(1, vinculadoA(PC302))] });
    await expect(concluirRecebimentoFiscal(input({ sequenciasSemVinculo: [1] }))).rejects.toBeInstanceOf(VinculoOmieMudouError);
    expect(relerSpy).not.toHaveBeenCalled();
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(fechamentos[0]![6]).toBe('consultar');
  });

  it('item escolhido ausente do recebimento, ou já ignorado no OMIE: conflito (o vínculo não pode mais ser mantido nem gravado)', async () => {
    consultaUnica({ itens: [itemRec(2)] }); // a seq 1 escolhida nao existe mais
    await expect(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { sequencias: [1] })] }))).rejects.toBeInstanceOf(VinculoOmieMudouError);
    expect(String(fechamentos[0]![8])).toContain('ausente');

    fechamentos = [];
    consultaUnica({ itens: [itemRec(1, { cIgnorarItem: 'S' })] });
    await expect(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }))).rejects.toBeInstanceOf(VinculoOmieMudouError);
    expect(String(fechamentos[0]![8])).toContain('ignorar');
    expect(relerSpy).not.toHaveBeenCalled(); // nenhum dos dois conflitos chegou a reler o PC
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
  });
});

// ── Cenario 16 — vinculos divergentes (achado fiscal-01) ─────────────────────

describe('concluirRecebimentoFiscal com PC — vínculos divergentes (cenário 16, achado fiscal-01)', () => {
  // Item de 2 sequencias ligadas a PCs diferentes no OMIE (seq 1 -> 304, seq 2 -> 302): a tela nao
  // tem um "visto" unico para mandar, entao a base do VINCULO_OMIE_MUDOU de cada sequencia e o
  // vinculo que o servidor leu no portao 1 (`vinculosPorSequencia`) — a escolha troca TODAS as
  // linhas pelo PC escolhido (FR-002c/FR-007), sem 409.

  it('escolha PC 304 com as linhas como o portão leu (1 -> 304, 2 -> 302): NÃO é conflito; ASSOCIAR-PEDIDO só da seq 2 (para o 304), EDITAR das duas, Concluir', async () => {
    consultaUnica({ itens: itensDivergentes(PC304, PC302) });

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolhaDivergente(PC304)] }));

    expect(r.status).toBe('concluido');
    expect(acoesPorChamada()).toEqual([['ASSOCIAR-PEDIDO'], ['EDITAR']]);
    expect(chamadasAlterar()[0]).toEqual({
      nIdReceb: N_ID_RECEB,
      itens: [{ nSequencia: 2, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: PC304.nCodPed, nIdItPedidoExistente: PC304.nCodItem }],
    });
    expect(seqsDaAcao('EDITAR')).toEqual([1, 2]);
    expect(seqsDaAcao('IGNORAR')).toEqual([]);
    expect(concluirSpy).toHaveBeenCalledTimes(1);
    expect(concluirSpy).toHaveBeenCalledWith('q2p', { nIdReceb: N_ID_RECEB, cEtapa: '60' });
    expect(ordemSemEspera()).toEqual([
      'ledger:insert',
      'omie:consultar',
      'pc:reler',
      'omie:associar-pedido',
      'pc:associado',
      'omie:editar',
      'omie:concluir',
      'ledger:concluido',
      'pc:concluido',
    ]);
    // as duas linhas terminam no 304: uma reserva e um vinculo por sequencia
    expect(r.vinculos).toEqual([
      { nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' },
      { nSequencia: 2, pcNumero: '304', origem: 'sugestao', status: 'concluido' },
    ]);
    expect(fechamentos[0]![10]).toBe(2);
  });

  it('escolha de um TERCEIRO PC (305) com as linhas como o portão leu: NÃO é conflito; ASSOCIAR-PEDIDO das duas sequências para o 305', async () => {
    consultaUnica({ itens: itensDivergentes(PC304, PC302) });

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolhaDivergente(PC305)] }));

    expect(r.status).toBe('concluido');
    expect(chamadasAlterar()[0]!.itens).toEqual([
      { nSequencia: 1, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: PC305.nCodPed, nIdItPedidoExistente: PC305.nCodItem },
      { nSequencia: 2, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: PC305.nCodPed, nIdItPedidoExistente: PC305.nCodItem },
    ]);
    expect(acoesPorChamada()).toEqual([['ASSOCIAR-PEDIDO'], ['EDITAR']]);
    expect(seqsDaAcao('EDITAR')).toEqual([1, 2]);
    expect(seqsDaAcao('IGNORAR')).toEqual([]);
    expect(r.vinculos.map((v) => [v.nSequencia, v.pcNumero])).toEqual([[1, '305'], [2, '305']]);
  });

  it('seq 2 viva num TERCEIRO PC (305), diferente do lido no portão (302) e do escolhido (304): VinculoOmieMudouError, sem releitura nem escrita', async () => {
    consultaUnica({ itens: itensDivergentes(PC304, PC305) });

    const erro = await erroDe(concluirRecebimentoFiscal(input({ vinculos: [escolhaDivergente(PC304)] })));

    expect(erro).toBeInstanceOf(VinculoOmieMudouError);
    expect(erro.message).toContain('NF 7813');
    expect(erro.message).toContain('SUCATA PLASTICO');
    expect(erro.message).not.toMatch(/\d{9,}/); // sem codigos do OMIE (ACXEGDP-313)
    expect(relerSpy).not.toHaveBeenCalled();
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'ledger:falha', 'pc:falha']);
    expect(fechamentos[0]!.slice(1, 7)).toEqual(['falha', N_ID_RECEB, '40', 'N', 2, 'consultar']);
    // o motivo tecnico (so no ledger) diz que a base e o lido no portao, por sequencia
    expect(String(fechamentos[0]![8])).toContain('sequência 2');
    expect(String(fechamentos[0]![8])).toContain(`lido no portão ${PC302.nCodItem}`);
  });

  it('as linhas trocaram de PC depois do portão (seq 1: 304 -> 302, seq 2: 302 -> 304): conflito — a base é POR sequência, não "algum PC lido"', async () => {
    consultaUnica({ itens: itensDivergentes(PC302, PC304) });

    await expect(concluirRecebimentoFiscal(input({ vinculos: [escolhaDivergente(PC304)] }))).rejects.toBeInstanceOf(VinculoOmieMudouError);

    expect(String(fechamentos[0]![8])).toContain('sequência 1');
    expect(String(fechamentos[0]![8])).toContain(`lido no portão ${PC304.nCodItem}`);
    expect(relerSpy).not.toHaveBeenCalled();
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
  });

  it('o caso antigo continua valendo: o MESMO recebimento com escolha NÃO divergente (visto nulo) é conflito — a seq 2 viva no 302 não é o visto nem o escolhido', async () => {
    consultaUnica({ itens: itensDivergentes(PC304, PC302) });

    await expect(
      concluirRecebimentoFiscal(input({ vinculos: [escolhaDivergente(PC304, { vinculosDivergentes: false })] })),
    ).rejects.toBeInstanceOf(VinculoOmieMudouError);

    expect(String(fechamentos[0]![8])).toContain('sequência 2');
    expect(String(fechamentos[0]![8])).toContain('visto nenhum');
    expect(relerSpy).not.toHaveBeenCalled();
    expect(alterarSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['um "visto" qualquer (305) não gera conflito', PC305, lidoNoPortao([1, PC304], [2, PC302]), false],
    ['um "visto" igual ao vivo da seq 2 (302) não esconde o conflito (o portão leu o 305 na seq 2)', PC302, lidoNoPortao([1, PC304], [2, PC305]), true],
  ])('com vinculosDivergentes o nCodItemOmieVisto é ignorado: %s', async (_nome, visto, lidos, conflito) => {
    consultaUnica({ itens: itensDivergentes(PC304, PC302) });
    const esc = escolhaDivergente(PC304, { nCodItemOmieVisto: visto.nCodItem, vinculosPorSequencia: lidos });

    if (conflito) {
      await expect(concluirRecebimentoFiscal(input({ vinculos: [esc] }))).rejects.toBeInstanceOf(VinculoOmieMudouError);
      expect(alterarSpy).not.toHaveBeenCalled();
    } else {
      const r = await concluirRecebimentoFiscal(input({ vinculos: [esc] }));
      expect(r.status).toBe('concluido');
      expect(seqsDaAcao('ASSOCIAR-PEDIDO')).toEqual([2]);
    }
  });

  it('seq sem vínculo no portão (ausente em vinculosPorSequencia) que ganhou um vínculo: conflito se não for o escolhido (mesmo com um "visto" igual ao vivo); sem conflito (nem ASSOCIAR) se for', async () => {
    const lidos = lidoNoPortao([1, PC304]); // a seq 2 estava sem vinculo quando o portao leu

    // a seq 2 ganhou o 302; o "visto" (302) e ignorado com vinculosDivergentes: a base da seq 2 e "nenhum"
    consultaUnica({ itens: itensDivergentes(PC304, PC302) });
    await expect(
      concluirRecebimentoFiscal(input({ vinculos: [escolhaDivergente(PC304, { vinculosPorSequencia: lidos, nCodItemOmieVisto: PC302.nCodItem })] })),
    ).rejects.toBeInstanceOf(VinculoOmieMudouError);
    expect(String(fechamentos[0]![8])).toContain('lido no portão nenhum');
    expect(alterarSpy).not.toHaveBeenCalled();

    consultaUnica({ itens: itensDivergentes(PC304, PC304) }); // a seq 2 ganhou o proprio 304 (alguem associou)
    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolhaDivergente(PC304, { vinculosPorSequencia: lidos })] }));
    expect(r.status).toBe('concluido');
    expect(seqsDaAcao('ASSOCIAR-PEDIDO')).toEqual([]);
    expect(seqsDaAcao('EDITAR')).toEqual([1, 2]);
  });
});

// ── Cenario 17 — recusas da consulta nao releem nem reservam o PC (achado fiscal-02) ──

describe('concluirRecebimentoFiscal com PC — recusas decididas só com a consulta (cenário 17, achado fiscal-02)', () => {
  it.each([
    ['NF cancelada no OMIE', { cCancelada: 'S' }, RecebimentoFiscalNfCanceladaError, 'cancelada', 'cCancelada=S'],
    ['fornecedor não cadastrado (nIdFornecedor 0, normalizado para nulo)', { nIdFornecedor: null }, RecebimentoFiscalSemFornecedorError, 'sem fornecedor cadastrado', 'sem fornecedor cadastrado'],
    ['fornecedor sem CNPJ', { cCNPJ_CPF: '' }, RecebimentoFiscalSemFornecedorError, 'sem fornecedor cadastrado', 'CNPJ ausente'],
    ['recebimento devolvido', { cDevolvido: 'S' }, RecebimentoFiscalEtapaInesperadaError, 'devolvida', 'cDevolvido=S'],
    ['recebimento bloqueado', { cBloqueado: 'S' }, RecebimentoFiscalEtapaInesperadaError, 'bloqueado', 'cBloqueado=S'],
    ['fora da etapa 40', { cEtapa: '50' }, RecebimentoFiscalEtapaInesperadaError, 'Faturado pelo fornecedor', 'Etapa 50'],
  ])('%s: erro de domínio sem releitura nem reserva do PC, sem escrita, ledger em falha (consultar)', async (_nome, over, Classe, trechoMensagem, trechoMotivo) => {
    consultaUnica(over);

    const erro = await erroDe(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] })));

    expect(erro).toBeInstanceOf(Classe);
    expect(erro.message).toContain('NF 7813');
    expect(erro.message).toContain(trechoMensagem);
    expect(relerSpy).not.toHaveBeenCalled();
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(consultarSpy).toHaveBeenCalledTimes(1); // erro de dominio: nem reconsulta
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'ledger:falha', 'pc:falha']);
    expect(fechamentos).toHaveLength(1);
    expect(fechamentos[0]!.slice(1, 3)).toEqual(['falha', N_ID_RECEB]);
    expect(fechamentos[0]![6]).toBe('consultar');
    expect(fechamentos[0]![7]).toBeNull(); // recusa de dominio: sem codigo OMIE
    expect(String(fechamentos[0]![8])).toContain(trechoMotivo);
    expect(inserts()).toHaveLength(1); // so a trava do ledger: nenhuma reserva (INSERT em recebimento_fiscal_pc)
  });
});

// ── Cenario 6 — releitura do PC recusada ─────────────────────────────────────

describe('concluirRecebimentoFiscal com PC — releitura do PC recusada (cenário 6)', () => {
  it('PcVinculoInvalidoError depois da ConsultarRecebimento: nenhuma escrita, ledger em falha (consultar_pc) e o MESMO erro propagado', async () => {
    const erroPc = new PcVinculoInvalidoError('7813', '304', 'não tem saldo disponível (saldo atual: 0 kg)');
    relerFalhaCom(erroPc);

    await expect(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }))).rejects.toBe(erroPc);

    // a releitura vem DEPOIS da consulta por chave (achado fiscal-02); erro de dominio: nem reconsulta
    expect(consultarSpy.mock.calls).toEqual([['q2p', { cChaveNfe: CHAVE }]]);
    expect(consultarSpy.mock.invocationCallOrder[0]!).toBeLessThan(relerSpy.mock.invocationCallOrder[0]!);
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(fechamentos).toHaveLength(1);
    expect(fechamentos[0]!.slice(0, 2)).toEqual(['ledger-1', 'falha']);
    // a consulta ja tinha rodado: o ledger guarda etapa, recebido e itens do recebimento
    expect(fechamentos[0]!.slice(2, 6)).toEqual([N_ID_RECEB, '40', 'N', 1]);
    expect(fechamentos[0]![6]).toBe('consultar_pc');
    expect(fechamentos[0]![7]).toBeNull(); // recusa de dominio: sem codigo OMIE
    expect(fechamentos[0]![8]).toBe(erroPc.message);
    expect(fechamentos[0]![9]).toBe(TOKEN);
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'pc:reler', 'ledger:falha', 'pc:falha']);
    // sem escrita no OMIE: nao impoe a espera de 70 s da proxima tentativa
    expect(PASSOS_COM_ESCRITA).not.toContain('consultar_pc');
  });

  it('PcRecemUsadoAguardeError (PC concluído pelo Atlas há menos de 75 s): mesma recusa, com o erro original e os segundos de espera', async () => {
    const erroPc = new PcRecemUsadoAguardeError('304', 42);
    relerFalhaCom(erroPc);

    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));
    } catch (e) {
      erro = e;
    }

    expect(erro).toBe(erroPc);
    expect((erro as PcRecemUsadoAguardeError).segundos).toBe(42);
    expect(consultarSpy.mock.calls).toEqual([['q2p', { cChaveNfe: CHAVE }]]); // so a consulta por chave, antes da releitura
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(fechamentos[0]![1]).toBe('falha');
    expect(fechamentos[0]![6]).toBe('consultar_pc');
    expect(fechamentos[0]![8]).toBe(erroPc.message);
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'pc:reler', 'ledger:falha', 'pc:falha']);
  });

  it('a recusa libera as reservas: UPDATE das linhas confirmado/associado para falha com o motivo', async () => {
    const erroPc = new PcVinculoInvalidoError('7813', '304', 'está aguardando aprovação no OMIE');
    relerFalhaCom(erroPc);
    await expect(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }))).rejects.toBe(erroPc);
    expect(marcacoes).toEqual([{ ledgerId: 'ledger-1', de: ['confirmado', 'associado'], para: 'falha', codigo: null, mensagem: erroPc.message }]);
  });

  it('fault inesperado na releitura (ex.: ConsultarPedCompra fora do ar): RecebimentoFiscalError (consultar_pc), sem reconsulta e sem espera de 70 s', async () => {
    relerFalhaCom(fault('SOAP-ENV:Server', 'Servico indisponivel'));

    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));
    } catch (e) {
      erro = e;
    }

    expect(erro).toBeInstanceOf(RecebimentoFiscalError);
    expect((erro as RecebimentoFiscalError).passo).toBe('consultar_pc');
    expect(segundosAteNovaTentativa(erro as RecebimentoFiscalError)).toBe(0);
    expect((erro as Error).message).not.toContain('Servico indisponivel');
    // 'consultar_pc' nao e passo com escrita: so a consulta por chave, antes da releitura — sem reconsulta por nIdReceb
    expect(consultarSpy.mock.calls).toEqual([['q2p', { cChaveNfe: CHAVE }]]);
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'pc:reler', 'ledger:falha', 'pc:falha']);
    expect(fechamentos[0]!.slice(2, 6)).toEqual([N_ID_RECEB, '40', 'N', 1]); // o ledger guarda o que a consulta viu
    expect(fechamentos[0]![6]).toBe('consultar_pc');
    expect(fechamentos[0]![7]).toBe('SOAP-ENV:Server');
  });

  it('falha na ConsultarRecebimento: nenhuma releitura nem reserva do PC, nada é escrito e o ledger vai a falha (consultar)', async () => {
    consultarSpy.mockImplementationOnce(consultaFalha(fault('SOAP-ENV:Server', 'Servico indisponivel')));

    await expect(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }))).rejects.toMatchObject({ name: 'RecebimentoFiscalError', passo: 'consultar' });

    // achado fiscal-02: a consulta vem antes de qualquer releitura/reserva do PC
    expect(relerSpy).not.toHaveBeenCalled();
    expect(consultarSpy).toHaveBeenCalledTimes(1); // 'consultar' nao e passo com escrita: sem reconsulta
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'ledger:falha', 'pc:falha']);
    // sem consulta, o ledger nao tem etapa/recebido/itens; o passo e o erro tecnico do OMIE ficam la
    expect(fechamentos[0]!.slice(1, 9)).toEqual(['falha', N_ID_RECEB, null, null, null, 'consultar', 'SOAP-ENV:Server', 'Servico indisponivel']);
    // o UPDATE em bloco ainda sai (idempotente: 0 linhas, nada foi reservado) e carrega o passo e o erro
    expect(marcacoes).toEqual([
      { ledgerId: 'ledger-1', de: ['confirmado', 'associado'], para: 'falha', codigo: 'SOAP-ENV:Server', mensagem: '[consultar] Servico indisponivel' },
    ]);
  });
});

// ── Cenarios 7 e 8 — falha no ASSOCIAR e nova tentativa ──────────────────────

describe('concluirRecebimentoFiscal com PC — falha no ASSOCIAR-PEDIDO e nova tentativa (cenários 7 e 8)', () => {
  it('fault no ASSOCIAR com a reconsulta não concluída: RecebimentoFiscalError (associar), 70 s de espera, ledger e reservas em falha, nenhum EDITAR nem Concluir', async () => {
    alterarSpy.mockImplementationOnce(async () => {
      ordem.push('omie:associar-pedido');
      throw fault('SOAP-ENV:Client-5101', 'Pedido de compra nao localizado');
    });

    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));
    } catch (e) {
      erro = e;
    }

    expect(erro).toBeInstanceOf(RecebimentoFiscalError);
    const e = erro as RecebimentoFiscalError;
    expect(e.passo).toBe('associar');
    expect(segundosAteNovaTentativa(e)).toBe(70);
    expect(segundosAteNovaTentativa(e)).toBe(ESPERA_APOS_FALHA_SEG);
    // mensagem ao operador: NF + fornecedor, sem codigos nem texto tecnico do OMIE
    expect(e.message).toContain('NF 7813');
    expect(e.message).toContain(FORNECEDOR);
    expect(e.message).toContain('tente novamente em 1 minuto');
    expect(e.message).not.toContain('Client-5101');
    expect(e.message).not.toMatch(/\d{9,}/);

    // reconsulta por nIdReceb (OUTRO corpo — fura o cache de ~1 min); nada mais foi escrito
    expect(consultarSpy.mock.calls).toEqual([
      ['q2p', { cChaveNfe: CHAVE }],
      ['q2p', { nIdReceb: N_ID_RECEB }],
    ]);
    expect(alterarSpy).toHaveBeenCalledTimes(1);
    expect(seqsDaAcao('EDITAR')).toEqual([]);
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'pc:reler', 'omie:associar-pedido', 'omie:reconsultar', 'ledger:falha', 'pc:falha']);

    // ledger em falha no passo associar, com o erro tecnico do OMIE (so no banco)
    expect(fechamentos[0]!.slice(1, 9)).toEqual(['falha', N_ID_RECEB, '40', 'N', 1, 'associar', 'SOAP-ENV:Client-5101', 'Pedido de compra nao localizado']);
    // reservas em falha, com o erro e o passo
    expect(marcacoes).toEqual([
      { ledgerId: 'ledger-1', de: ['confirmado', 'associado'], para: 'falha', codigo: 'SOAP-ENV:Client-5101', mensagem: '[associar] Pedido de compra nao localizado' },
    ]);
    // falha no associar: nada de movimentacao/aprovacao (este servico so escreve no ledger fiscal)
    expect(poolQuerySpy.mock.calls.every((c) => !/movimentacao|aprovacao/i.test(String(c[0])))).toBe(true);
    expect(inserts()).toHaveLength(1); // so o INSERT do proprio ledger (a trava)
    expect(inserts()[0]).toContain('INSERT INTO stockbridge.recebimento_fiscal');
  });

  it('fault no ASSOCIAR e a reconsulta também falha (OMIE fora): o erro de domínio sobe mesmo assim; ledger e reservas em falha', async () => {
    alterarSpy.mockImplementationOnce(async () => {
      ordem.push('omie:associar-pedido');
      throw fault('SOAP-ENV:Client-5101', 'Pedido de compra nao localizado');
    });
    consultarSpy.mockImplementationOnce(consulta()).mockImplementationOnce(async () => {
      ordem.push('omie:reconsultar');
      throw new Error('ECONNRESET');
    });

    await expect(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }))).rejects.toMatchObject({ name: 'RecebimentoFiscalError', passo: 'associar' });

    expect(fechamentos[0]![1]).toBe('falha');
    expect(fechamentos[0]![6]).toBe('associar');
    expect(marcacoes.at(-1)).toMatchObject({ para: 'falha', codigo: 'SOAP-ENV:Client-5101', mensagem: '[associar] Pedido de compra nao localizado' });
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(seqsDaAcao('EDITAR')).toEqual([]);
  });

  it.each([
    [
      'editar',
      (c: { acao: string }) => c.acao === 'EDITAR',
      ['ledger:insert', 'omie:consultar', 'pc:reler', 'omie:associar-pedido', 'pc:associado', 'omie:editar', 'omie:reconsultar', 'ledger:falha', 'pc:falha'],
    ],
    [
      'ignorar',
      (c: { acao: string }) => c.acao === 'IGNORAR',
      ['ledger:insert', 'omie:consultar', 'pc:reler', 'omie:associar-pedido', 'pc:associado', 'omie:editar', 'omie:ignorar', 'omie:reconsultar', 'ledger:falha', 'pc:falha'],
    ],
  ])('fault no passo %s (NF mista): reservas em falha com "[passo] erro", 70 s de espera e nada depois do passo', async (passo, deveFalhar, esperado) => {
    consultaUnica({ itens: [itemRec(1), itemRec(2)] });
    alterarSpy.mockImplementation(async (_e: string, i: ChamadaAlterar) => {
      const acao = i.itens[0]!.cAcao;
      ordem.push(`omie:${acao.toLowerCase()}`);
      if (deveFalhar({ acao })) throw fault('SOAP-ENV:Client-7001', `falhou em ${passo}`);
      return { nIdReceb: i.nIdReceb, cCodStatus: '0', cDescStatus: 'ok' };
    });

    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { sequencias: [1] })], sequenciasSemVinculo: [2] }));
    } catch (e) {
      erro = e;
    }

    expect(erro).toBeInstanceOf(RecebimentoFiscalError);
    expect((erro as RecebimentoFiscalError).passo).toBe(passo);
    expect(segundosAteNovaTentativa(erro as RecebimentoFiscalError)).toBe(70);
    expect((erro as Error).message).toContain(', com o vínculo ao PC 304, no OMIE.'); // fiscal-04: o PC lido ao vivo (reserva)
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual(esperado);
    expect(fechamentos[0]![6]).toBe(passo);
    // a ultima marcacao e a liberacao das reservas, com o passo na mensagem
    expect(marcacoes.at(-1)).toEqual({
      ledgerId: 'ledger-1',
      de: ['confirmado', 'associado'],
      para: 'falha',
      codigo: 'SOAP-ENV:Client-7001',
      mensagem: `[${passo}] falhou em ${passo}`,
    });
  });

  it('fault no Concluir (a reconsulta segue N): reservas em falha com "[concluir] erro" e 70 s de espera para a próxima tentativa', async () => {
    consultaUnica({ itens: [itemRec(1), itemRec(2)] });
    concluirSpy.mockImplementationOnce(async () => {
      ordem.push('omie:concluir');
      throw fault('SOAP-ENV:Client-7002', 'Nao foi possivel concluir o recebimento');
    });

    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { sequencias: [1] })], sequenciasSemVinculo: [2] }));
    } catch (e) {
      erro = e;
    }

    expect(erro).toMatchObject({ name: 'RecebimentoFiscalError', passo: 'concluir' });
    expect(segundosAteNovaTentativa(erro as RecebimentoFiscalError)).toBe(70);
    expect((erro as Error).message).toContain(', com o vínculo ao PC 304, no OMIE.'); // fiscal-04
    expect(ordemSemEspera().slice(-4)).toEqual(['omie:concluir', 'omie:reconsultar', 'ledger:falha', 'pc:falha']);
    expect(marcacoes.at(-1)).toMatchObject({ para: 'falha', mensagem: '[concluir] Nao foi possivel concluir o recebimento' });
  });

  it('a espera de 70 s depois de falha lista exatamente os passos com escrita (associar incluso; consultar e consultar_pc de fora)', async () => {
    await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));
    const [sqlEspera] = sqlDe('make_interval(secs');
    const lista = /passo_falha IN \(([^)]*)\)/.exec(sqlEspera!)![1]!.split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(lista).toEqual([...PASSOS_COM_ESCRITA]);
    expect(lista).toContain('associar');
    expect(lista).not.toContain('consultar');
    expect(lista).not.toContain('consultar_pc');
  });

  it('nova tentativa depois de associar (a consulta mostra o vínculo vivo = escolhido): nenhum ASSOCIAR-PEDIDO; só EDITAR e Concluir', async () => {
    consultaUnica({ itens: [itemRec(1, vinculadoA(PC304))] }); // o ASSOCIAR da tentativa anterior ficou gravado

    // a tela carregou antes do ASSOCIAR (visto nulo); o portao 1, ja no POST da nova tentativa, leu o 304
    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { nCodItemOmieVisto: null, vinculosPorSequencia: lidoNoPortao([1, PC304]) })] }));

    expect(r.status).toBe('concluido');
    expect(ordemSemEspera()).toEqual([
      'ledger:insert',
      'omie:consultar',
      'pc:reler',
      'pc:associado',
      'omie:editar',
      'omie:concluir',
      'ledger:concluido',
      'pc:concluido',
    ]);
    expect(seqsDaAcao('ASSOCIAR-PEDIDO')).toEqual([]);
    expect(acoesPorChamada()).toEqual([['EDITAR']]);
    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' }]);
  });

  it('duas tentativas: a 1ª associa e falha no EDITAR; a 2ª (consulta com o vínculo) não repete o ASSOCIAR-PEDIDO; cada tentativa reserva de novo', async () => {
    consultarSpy
      .mockImplementationOnce(consulta()) // 1ª tentativa: item sem vinculo
      .mockImplementationOnce(consulta()) // reconsulta da 1ª: nada concluido
      .mockImplementationOnce(consulta({ itens: [itemRec(1, vinculadoA(PC304))] })); // 2ª: o ASSOCIAR ficou gravado
    alterarSpy.mockImplementationOnce(alterarOk).mockImplementationOnce(async () => {
      ordem.push('omie:editar');
      throw fault('SOAP-ENV:Client-7003', 'timeout no EDITAR');
    });

    await expect(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }))).rejects.toMatchObject({ name: 'RecebimentoFiscalError', passo: 'editar' });
    const r2 = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] })); // passado o tempo de espera

    expect(r2.status).toBe('concluido');
    expect(chamadasAlterar().flatMap((c) => c.itens.map((i) => i.cAcao))).toEqual(['ASSOCIAR-PEDIDO', 'EDITAR', 'EDITAR']);
    expect(seqsDaAcao('ASSOCIAR-PEDIDO')).toEqual([1]); // uma unica vez nas duas tentativas
    expect(relerSpy).toHaveBeenCalledTimes(2);
    expect(concluirSpy).toHaveBeenCalledTimes(1);
    expect(fechamentos.map((f) => f[1])).toEqual(['falha', 'concluido']);
    expect(marcacoes.map((m) => m.para)).toEqual(['associado', 'falha', 'associado', 'concluido']);
  });

  it('falha ao gravar a transição das reservas (banco fora): o fiscal conclui mesmo assim e o erro vai para o log (nunca esconde o desfecho do OMIE)', async () => {
    marcarLanca = true;
    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));
    expect(r.status).toBe('concluido');
    expect(r.vinculos).toHaveLength(1);
    expect(concluirSpy).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).toHaveBeenCalledWith(expect.objectContaining({ ledgerId: 'ledger-1' }), expect.stringContaining('vínculos com PC'));
  });
});

// ── Cenarios 9 e 11 — fiscal concluido no portal com estoque ─────────────────

describe('concluirRecebimentoFiscal com PC — fiscal concluído no portal COM estoque (cenários 9 e 11)', () => {
  it('cRecebido S, item não ignorado e cNaoGerarMovEstoque N: EstoqueJaLancadoPeloOmieError; ledger em falha (NUNCA ja_concluido); sem releitura nem reserva do PC; zero escrita', async () => {
    consultaUnica(concluidoComEstoque());

    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { origem: 'omie' })] }));
    } catch (e) {
      erro = e;
    }

    expect(erro).toBeInstanceOf(EstoqueJaLancadoPeloOmieError);
    expect((erro as Error).message).toContain('NF 7813');
    expect((erro as Error).message).toContain(FORNECEDOR);
    expect((erro as Error).message).not.toMatch(/\d{9,}/);
    expect(relerSpy).not.toHaveBeenCalled(); // achado fiscal-02: o D7 vem na primeira consulta, antes da releitura
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'ledger:falha', 'pc:falha']);
    expect(fechamentos.map((f) => f[1])).toEqual(['falha']);
    expect(ordem).not.toContain('ledger:ja_concluido');
    expect(fechamentos[0]!.slice(1, 7)).toEqual(['falha', N_ID_RECEB, '60', 'S', 1, 'consultar']);
    // o UPDATE em bloco ainda sai (idempotente: 0 linhas, nada foi reservado)
    expect(marcacoes).toEqual([
      { ledgerId: 'ledger-1', de: ['confirmado', 'associado'], para: 'falha', codigo: null, mensagem: expect.stringContaining('movimento de estoque') },
    ]);
    // sem nenhum INSERT alem da trava do ledger (nem movimentacao, nem aprovacao, nem reserva)
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]).toContain('INSERT INTO stockbridge.recebimento_fiscal');
  });

  it('fiscal-02 (b): portal concluiu SEM "não movimentar estoque" (cNaoGerarMovEstoque N em item não ignorado): EstoqueJaLancadoPeloOmieError sem reler o PC (mesmo que a releitura recusasse por saldo 0) e zero escrita', async () => {
    // O PC 304 ja foi consumido pela propria NF concluida no portal: se a releitura rodasse,
    // o operador receberia PC_VINCULO_INVALIDO (saldo 0) em vez do aviso certo (estoque ja lancado).
    relerSpy.mockImplementation(async () => {
      ordem.push('pc:reler');
      throw new PcVinculoInvalidoError('7813', '304', 'não tem saldo disponível (saldo atual: 0 kg)');
    });
    consultaUnica(concluidoComEstoque());

    const erro = await erroDe(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { origem: 'omie' })] })));

    expect(erro).toBeInstanceOf(EstoqueJaLancadoPeloOmieError);
    expect(erro).not.toBeInstanceOf(PcVinculoInvalidoError);
    expect(relerSpy).not.toHaveBeenCalled();
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(consultarSpy.mock.calls).toEqual([['q2p', { cChaveNfe: CHAVE }]]); // so a consulta por chave
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'ledger:falha', 'pc:falha']);
    expect(fechamentos[0]!.slice(1, 7)).toEqual(['falha', N_ID_RECEB, '60', 'S', 1, 'consultar']);
    expect(inserts()).toHaveLength(1); // so a trava do ledger — nenhuma reserva
  });

  it('SEM estoque (cNaoGerarMovEstoque S): ja_concluido, o vínculo vivo = escolhido aparece em vinculos — sem reserva; a escolha vai direto a concluido', async () => {
    consultaUnica(concluidoComEstoque({ cNaoGerarMovEstoque: 'S' }));
    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { origem: 'omie' })] }));
    expect(r.status).toBe('ja_concluido');
    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'omie', status: 'concluido' }]);
    expect(ordem).toContain('ledger:ja_concluido');
    expect(fechamentos[0]![1]).toBe('ja_concluido');
    expect(relerSpy).not.toHaveBeenCalled();
    expect(marcacoes).toEqual([]);
    expect(reservasFechadas).toEqual([]);
    expect(registros.map(registro)).toEqual([expect.objectContaining({ origem: 'omie', status: 'concluido' })]);
  });

  it('SEM estoque (item ignorado, mesmo com cNaoGerarMovEstoque N): ja_concluido', async () => {
    consultaUnica({ cRecebido: 'S', cEtapa: '60', itens: [itemRec(1, { cIgnorarItem: 'S', cNaoGerarMovEstoque: 'N' })] });
    const r = await concluirRecebimentoFiscal(input());
    expect(r.status).toBe('ja_concluido');
  });

  it('um item sem estoque e outro com estoque: basta um para bloquear (EstoqueJaLancadoPeloOmieError)', async () => {
    consultaUnica({
      cRecebido: 'S',
      cEtapa: '60',
      itens: [itemRec(1, { ...vinculadoA(PC304), cNaoGerarMovEstoque: 'S' }), itemRec(2, { cNaoGerarMovEstoque: 'N' })],
    });
    await expect(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }))).rejects.toBeInstanceOf(EstoqueJaLancadoPeloOmieError);
    expect(relerSpy).not.toHaveBeenCalled();
  });

  it('sem escolhas (receita da 016): o bloqueio de estoque já lançado vale igual, sem releitura de PC', async () => {
    consultaUnica({ cRecebido: 'S', cEtapa: '60', itens: [itemRec(1, { cNaoGerarMovEstoque: 'N' })] });
    await expect(concluirRecebimentoFiscal(input())).rejects.toBeInstanceOf(EstoqueJaLancadoPeloOmieError);
    expect(relerSpy).not.toHaveBeenCalled();
    expect(fechamentos[0]![1]).toBe('falha');
  });

  it('uma nova tentativa confere de novo no OMIE: o bloqueio não vira cache no ledger nem impõe a espera de 70 s', async () => {
    consultarSpy.mockImplementation(consulta(concluidoComEstoque()));

    await expect(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }))).rejects.toBeInstanceOf(EstoqueJaLancadoPeloOmieError);
    await expect(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }))).rejects.toBeInstanceOf(EstoqueJaLancadoPeloOmieError);

    expect(consultarSpy).toHaveBeenCalledTimes(2);
    expect(relerSpy).not.toHaveBeenCalled(); // nenhuma das duas tentativas chegou a reler o PC
    expect(fechamentos.map((f) => f[1])).toEqual(['falha', 'falha']);
    expect(ordem.filter((o) => o === 'ledger:insert')).toHaveLength(2); // linha NOVA a cada tentativa (indice parcial exclui falha)
    expect(ordem).not.toContain('ledger:ja_concluido');
  });

  it('timeout no Concluir e a reconsulta mostra concluído COM estoque: EstoqueJaLancadoPeloOmieError; ledger falha (concluir) e reservas em falha', async () => {
    concluirSpy.mockImplementationOnce(async () => {
      ordem.push('omie:concluir');
      throw new Error('timeout of 30000ms exceeded');
    });
    consultarSpy.mockImplementationOnce(consulta()).mockImplementationOnce(consulta(concluidoComEstoque()));

    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));
    } catch (e) {
      erro = e;
    }

    expect(erro).toBeInstanceOf(EstoqueJaLancadoPeloOmieError);
    expect(ordemSemEspera()).toEqual([
      'ledger:insert',
      'omie:consultar',
      'pc:reler',
      'omie:associar-pedido',
      'pc:associado',
      'omie:editar',
      'omie:concluir',
      'omie:reconsultar',
      'ledger:falha',
      'pc:falha',
    ]);
    expect(fechamentos.map((f) => f[1])).toEqual(['falha']);
    expect(fechamentos[0]![6]).toBe('concluir');
    expect(String(fechamentos[0]![8])).toContain('[concluir] timeout');
    expect(String(fechamentos[0]![8])).toContain('movimento de estoque');
    expect(marcacoes.at(-1)).toMatchObject({ de: ['confirmado', 'associado'], para: 'falha' });
    // foi um passo com escrita: a proxima tentativa espera os 70 s
    expect(PASSOS_COM_ESCRITA).toContain('concluir');
  });

  it('timeout no Concluir e a reconsulta mostra concluído SEM estoque: ja_concluido, com o vínculo vivo = escolhido em vinculos', async () => {
    concluirSpy.mockImplementationOnce(async () => {
      ordem.push('omie:concluir');
      throw new Error('timeout of 30000ms exceeded');
    });
    consultarSpy.mockImplementationOnce(consulta()).mockImplementationOnce(
      consulta({
        cRecebido: 'S',
        cEtapa: '60',
        cUsuarioRec: 'WEBSERVICE',
        itens: [itemRec(1, { ...vinculadoA(PC304), ...comAjustes })],
      }),
    );

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(r.status).toBe('ja_concluido');
    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' }]);
    expect(ordemSemEspera()).toEqual([
      'ledger:insert',
      'omie:consultar',
      'pc:reler',
      'omie:associar-pedido',
      'pc:associado',
      'omie:editar',
      'omie:concluir',
      'omie:reconsultar',
      'ledger:ja_concluido',
      'pc:reserva-concluido',
    ]);
    expect(fechamentos[0]![1]).toBe('ja_concluido');
    expect(String(fechamentos[0]![8])).toContain('[concluir] timeout');
    expect(reservasFechadas).toEqual([{ id: 'reserva-1', para: 'concluido' }]);
  });

  it('fault no EDITAR e a reconsulta mostra concluído COM estoque (portal em paralelo): EstoqueJaLancadoPeloOmieError, passo editar', async () => {
    alterarSpy.mockImplementation(async (_e: string, i: ChamadaAlterar) => {
      const acao = i.itens[0]!.cAcao;
      ordem.push(`omie:${acao.toLowerCase()}`);
      if (acao === 'EDITAR') throw fault('SOAP-ENV:Client-5002', 'Recebimento ja concluido');
      return { nIdReceb: i.nIdReceb, cCodStatus: '0', cDescStatus: 'ok' };
    });
    consultarSpy.mockImplementationOnce(consulta()).mockImplementationOnce(consulta(concluidoComEstoque()));

    await expect(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }))).rejects.toBeInstanceOf(EstoqueJaLancadoPeloOmieError);
    expect(fechamentos[0]![1]).toBe('falha');
    expect(fechamentos[0]![6]).toBe('editar');
    expect(concluirSpy).not.toHaveBeenCalled();
  });

  describe('estoqueLancadoNoRecebimento (D7)', () => {
    type Rec = Parameters<typeof estoqueLancadoNoRecebimento>[0];
    it.each([
      ['concluído, item não ignorado, sem "não movimentar estoque"', { cRecebido: 'S', itens: [itemRec(1, { cNaoGerarMovEstoque: 'N' })] }, true],
      ['concluído, "não movimentar estoque" = S', { cRecebido: 'S', itens: [itemRec(1, { cNaoGerarMovEstoque: 'S' })] }, false],
      ['concluído, item ignorado (mesmo com N)', { cRecebido: 'S', itens: [itemRec(1, { cIgnorarItem: 'S', cNaoGerarMovEstoque: 'N' })] }, false],
      ['ainda não concluído (cRecebido N), com N', { cRecebido: 'N', itens: [itemRec(1, { cNaoGerarMovEstoque: 'N' })] }, false],
      ['concluído, um item sem estoque e outro com', { cRecebido: 'S', itens: [itemRec(1, { cNaoGerarMovEstoque: 'S' }), itemRec(2, { cNaoGerarMovEstoque: 'N' })] }, true],
      ['concluído, um ignorado com N e outro com S', { cRecebido: 'S', itens: [itemRec(1, { cIgnorarItem: 'S' }), itemRec(2, { cNaoGerarMovEstoque: 'S' })] }, false],
      ['concluído, cNaoGerarMovEstoque ausente (null): só o N explícito conta (T039: "= N")', { cRecebido: 'S', itens: [itemRec(1, { cNaoGerarMovEstoque: null })] }, false],
    ])('%s -> %s', (_nome, over, esperado) => {
      expect(estoqueLancadoNoRecebimento(recebimento(over) as unknown as Rec)).toBe(esperado);
    });
  });
});

// ── Cenario 10 — ja_concluido com PC ─────────────────────────────────────────

describe('concluirRecebimentoFiscal com PC — ja_concluido na PRIMEIRA consulta: nada é relido nem reservado; a escolha vai direto ao estado final (cenário 10, achados fiscal-02 e fiscal-03)', () => {
  it('sem estoque, vínculo vivo igual ao escolhido: ja_concluido com o vínculo em vinculos; nenhuma releitura, reserva, UPDATE em recebimento_fiscal_pc nem escrita no OMIE', async () => {
    consultaUnica(concluidoSemEstoque([itemRec(1, { ...vinculadoA(PC304), ...comAjustes })]));

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(r).toMatchObject({ status: 'ja_concluido', ledgerId: 'ledger-1', itensTotal: 0, semVinculo: [] });
    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' }]);
    expect(relerSpy).not.toHaveBeenCalled();
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'ledger:ja_concluido', 'pc:fechar-orfas', 'pc:registrar-concluido']);
    expect(fechamentos[0]!.slice(1, 6)).toEqual(['ja_concluido', N_ID_RECEB, '60', 'S', 1]);
    expect(fechamentos[0]![10]).toBe(1); // itens_vinculados: o item terminou ligado ao PC no OMIE
    expect(reservasFechadas).toEqual([]);
    expect(marcacoes).toEqual([]);
    // a escolha do operador fica registrada no estado final (sem releitura: saldo/preço lidos nulos)
    expect(registros.map(registro)).toEqual([
      expect.objectContaining({ ledgerId: 'ledger-1', nSequencia: 1, nCodPed: PC304.nCodPed, nCodItem: PC304.nCodItem, pcNumero: '304', status: 'concluido', erro: null, concluidoEm: null }),
    ]);
  });

  it('fiscal-03: cada linha vai direto ao estado final, com o instante da conclusão NO OMIE (nunca o atual) — concluido só quando o vínculo vivo é o escolhido', async () => {
    // tres desfechos possiveis num so recebimento: vinculo igual, vinculo diferente e item ignorado;
    // o OMIE concluiu em 21/10/2026 18:05:00 (horario de Brasilia)
    consultaUnica({
      ...concluidoSemEstoque([
        itemRec(1, { ...vinculadoA(PC304), ...comAjustes }),
        itemRec(2, { ...vinculadoA(PC304), ...comAjustes }),
        itemRec(3, { cIgnorarItem: 'S', cNaoGerarMovEstoque: 'S' }),
      ]),
      dRec: '21/10/2026',
      hRec: '18:05:00',
    });
    const e1 = escolha(PC304, { indice: 0, sequencias: [1] });
    const e2 = escolha(PC302, { indice: 1, sequencias: [2], kgPorSequencia: { 2: 18000 } });
    const e3 = escolha(PC305, { indice: 2, sequencias: [3], kgPorSequencia: { 3: 18000 } });

    const r = await concluirRecebimentoFiscal(input({ vinculos: [e1, e2, e3] }));

    expect(r.status).toBe('ja_concluido');
    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' }]);
    expect(registros.map(registro)).toEqual([
      expect.objectContaining({ nSequencia: 1, pcNumero: '304', status: 'concluido', erro: null, concluidoEm: '2026-10-21T21:05:00.000Z' }),
      expect.objectContaining({ nSequencia: 2, pcNumero: '302', status: 'falha', erro: 'Fiscal concluído fora do Atlas sem este vínculo', concluidoEm: null }),
      expect.objectContaining({ nSequencia: 3, pcNumero: '305', status: 'falha', erro: 'Fiscal concluído fora do Atlas sem este vínculo', concluidoEm: null }),
    ]);
    // nada de reserva nem de marcacao em bloco: so o fechamento das orfas e os registros finais
    expect(marcacoes).toEqual([]);
    expect(reservasFechadas).toEqual([]);
    expect(relerSpy).not.toHaveBeenCalled();
    expect(ordem).toEqual([
      'ledger:espera?', 'ledger:insert', 'omie:consultar', 'ledger:ja_concluido', 'pc:fechar-orfas',
      'pc:registrar-concluido', 'pc:registrar-falha', 'pc:registrar-falha',
    ]);
  });

  it('ledger órfão retomado: as reservas vivas da tentativa que morreu são fechadas antes do registro (não ocupam o índice único)', async () => {
    insertFalha = violacaoLedgerViva();
    linhaViva = { id: 'ledger-0', status: 'em_andamento', iniciado_em: '2026-10-22 09:30:00-03', finalizado_em: null };
    retomadaOk = true;
    consultaUnica(concluidoSemEstoque([itemRec(1, { ...vinculadoA(PC304), ...comAjustes })]));

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(r).toMatchObject({ status: 'ja_concluido', ledgerId: 'ledger-0' });
    expect(orfasFechadas).toEqual([CHAVE]);
    expect(registros.map(registro)).toEqual([expect.objectContaining({ ledgerId: 'ledger-0', status: 'concluido' })]);
    expect(ordem.indexOf('pc:fechar-orfas')).toBeLessThan(ordem.indexOf('pc:registrar-concluido'));
  });

  it('troca registrada por linha (FR-007): o PC anterior de cada sequência vai na linha, com a justificativa', async () => {
    consultaUnica(concluidoSemEstoque([itemRec(1, { ...vinculadoA(PC304), ...comAjustes }), itemRec(2, { ...vinculadoA(PC304), ...comAjustes })]));
    const e = escolha(PC304, {
      sequencias: [1, 2], kgPorSequencia: { 1: 9000, 2: 9000 }, justificativa: 'Um PC só para o item', vinculosDivergentes: true,
      vinculosPorSequencia: { 1: { nIdPedido: PC304.nCodPed, nIdItPedido: PC304.nCodItem }, 2: { nIdPedido: PC302.nCodPed, nIdItPedido: PC302.nCodItem } },
    });
    await concluirRecebimentoFiscal(input({ vinculos: [e] }));
    expect(registros.map(registro)).toEqual([
      expect.objectContaining({ nSequencia: 1, anteriorPed: null, anteriorItem: null, status: 'concluido', justificativa: 'Um PC só para o item' }),
      expect.objectContaining({ nSequencia: 2, anteriorPed: PC302.nCodPed, anteriorItem: PC302.nCodItem, status: 'concluido' }),
    ]);
  });

  it('erro de banco ao registrar: vai para o log e o ja_concluido segue com os vínculos (a verdade é o OMIE)', async () => {
    registroLanca = true;
    consultaUnica(concluidoSemEstoque([itemRec(1, { ...vinculadoA(PC304), ...comAjustes })]));
    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));
    expect(r.status).toBe('ja_concluido');
    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' }]);
    expect(loggerMock.error).toHaveBeenCalled();
  });

  it('vínculo vivo diferente do escolhido: o vínculo NÃO aparece em vinculos e a escolha fica registrada como falha', async () => {
    consultaUnica(concluidoSemEstoque([itemRec(1, { ...vinculadoA(PC302), ...comAjustes })]));

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(r.status).toBe('ja_concluido');
    expect(r.vinculos).toEqual([]);
    expect(relerSpy).not.toHaveBeenCalled();
    expect(registros.map(registro)).toEqual([expect.objectContaining({ pcNumero: '304', status: 'falha', erro: 'Fiscal concluído fora do Atlas sem este vínculo' })]);
    expect(fechamentos[0]![10]).toBe(1); // o item esta ligado ao 302 no OMIE: conta como vinculado no ledger
  });

  it('item concluído sem nenhum vínculo no OMIE (portal ignorou o item): vinculos fica vazio, itens_vinculados nulo e a escolha fica como falha', async () => {
    consultaUnica(concluidoSemEstoque([itemRec(1, { cIgnorarItem: 'S', cNaoGerarMovEstoque: 'S' })]));

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(r.status).toBe('ja_concluido');
    expect(r.vinculos).toEqual([]);
    expect(relerSpy).not.toHaveBeenCalled();
    expect(registros.map(registro)).toEqual([expect.objectContaining({ status: 'falha', concluidoEm: null })]);
    expect(fechamentos[0]![10]).toBeNull();
  });

  it('dois itens: um com vínculo igual ao escolhido e outro com vínculo diferente; só o primeiro aparece em vinculos', async () => {
    consultaUnica(concluidoSemEstoque([itemRec(1, { ...vinculadoA(PC304), ...comAjustes }), itemRec(2, { ...vinculadoA(PC304), ...comAjustes })]));
    const e1 = escolha(PC304, { indice: 0, sequencias: [1] });
    const e2 = escolha(PC302, { indice: 1, sequencias: [2], kgPorSequencia: { 2: 18000 } });

    const r = await concluirRecebimentoFiscal(input({ vinculos: [e1, e2] }));

    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' }]);
    expect(registros.map((p) => [p[3], p[15]])).toEqual([
      [1, 'concluido'],
      [2, 'falha'],
    ]);
  });

  it('item agregado por descrição (2 sequências) com o vínculo vivo igual nas duas: uma entrada por sequência, na ordem da escolha', async () => {
    consultaUnica(
      concluidoSemEstoque([itemRec(1, { ...vinculadoA(PC304), ...comAjustes, nQtdeNFe: 9000 }), itemRec(3, { ...vinculadoA(PC304), ...comAjustes, nQtdeNFe: 9000 })]),
    );

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { origem: 'omie', sequencias: [1, 3], kgPorSequencia: { 1: 9000, 3: 9000 } })] }));

    expect(r.vinculos).toEqual([
      { nSequencia: 1, pcNumero: '304', origem: 'omie', status: 'concluido' },
      { nSequencia: 3, pcNumero: '304', origem: 'omie', status: 'concluido' },
    ]);
  });

  it('sequência escolhida ausente na consulta: fora de vinculos', async () => {
    consultaUnica(concluidoSemEstoque([itemRec(2, { ...vinculadoA(PC304), ...comAjustes })]));

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { sequencias: [1] })] }));

    expect(r.status).toBe('ja_concluido');
    expect(r.vinculos).toEqual([]);
    expect(registros.map((p) => [p[3], p[15]])).toEqual([[1, 'falha']]);
  });

  it('modo "receber sem vínculo": a sequência que terminou SEM PC segue em semVinculo (aviso a compras); a que ganhou vínculo no OMIE sai', async () => {
    consultaUnica(
      concluidoSemEstoque([
        itemRec(1, { ...vinculadoA(PC304), ...comAjustes }),
        itemRec(2, { cIgnorarItem: 'S', cNaoGerarMovEstoque: 'S' }),
        itemRec(3, { ...vinculadoA(PC302), ...comAjustes }),
      ]),
    );

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { sequencias: [1] })], sequenciasSemVinculo: [2, 3] }));

    expect(r.status).toBe('ja_concluido');
    expect(r.semVinculo).toEqual([2]);
    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' }]);
  });

  it('fiscal-02 (a): nova tentativa depois de um Concluir que gravou mas cuja resposta se perdeu — a consulta já mostra cRecebido S sem estoque: ja_concluido SEM reler o PC (mesmo que o saldo dele já esteja consumido pela própria NF)', async () => {
    // 1ª tentativa: o Concluir estoura o tempo (mas gravou no OMIE) e a reconsulta tambem falha -> falha (concluir)
    concluirSpy.mockImplementationOnce(async () => {
      ordem.push('omie:concluir');
      throw new Error('timeout of 30000ms exceeded');
    });
    consultarSpy
      .mockImplementationOnce(consulta()) // consulta por chave: o recebimento ainda estava aberto
      .mockImplementationOnce(consultaFalha(new Error('ECONNRESET'))) // reconsulta por nIdReceb: OMIE fora do ar
      .mockImplementationOnce(consulta(concluidoSemEstoque([itemRec(1, { ...vinculadoA(PC304), ...comAjustes })]))); // 2a tentativa: o Concluir tinha gravado

    await expect(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }))).rejects.toMatchObject({ name: 'RecebimentoFiscalError', passo: 'concluir' });
    expect(relerSpy).toHaveBeenCalledTimes(1);
    expect(fechamentos.map((f) => f[1])).toEqual(['falha']);

    // 2ª tentativa (passada a espera de 70 s): o PC 304 ja foi consumido pela propria NF. Se a releitura
    // rodasse, o operador veria PC_VINCULO_INVALIDO (saldo 0) para uma NF que ja esta certa no OMIE.
    relerSpy.mockImplementation(async () => {
      ordem.push('pc:reler');
      throw new PcVinculoInvalidoError('7813', '304', 'não tem saldo disponível (saldo atual: 0 kg)');
    });
    const escritasAntes = { alterar: alterarSpy.mock.calls.length, concluir: concluirSpy.mock.calls.length };
    const sqlAntes = poolQuerySpy.mock.calls.length;
    ordem = [];
    fechamentos = [];
    marcacoes = [];
    reservasFechadas = [];

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(r.status).toBe('ja_concluido');
    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' }]);
    expect(relerSpy).toHaveBeenCalledTimes(1); // so a da 1a tentativa: a 2a nao releu
    expect(alterarSpy.mock.calls.length).toBe(escritasAntes.alterar);
    expect(concluirSpy.mock.calls.length).toBe(escritasAntes.concluir);
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'ledger:ja_concluido', 'pc:fechar-orfas', 'pc:registrar-concluido']);
    expect(fechamentos[0]!.slice(1, 6)).toEqual(['ja_concluido', N_ID_RECEB, '60', 'S', 1]);
    expect(marcacoes).toEqual([]);
    expect(reservasFechadas).toEqual([]);
    // fiscal-03: na 2a tentativa so o fechamento das orfas e o registro final (sem releitura nem reserva)
    expect(
      poolQuerySpy.mock.calls
        .slice(sqlAntes)
        .map((c) => String(c[0]))
        .filter((s) => s.includes('stockbridge.recebimento_fiscal_pc'))
        .map((s) => (/^\s*INSERT/.test(s) ? 'insert' : 'update')),
    ).toEqual(['update', 'insert']);
  });
});

describe('concluirRecebimentoFiscal com PC — ja_concluido na RECONSULTA depois de falha com escrita: as reservas são fechadas (cenário 10)', () => {
  // O Concluir estoura o tempo (a escrita pode ter gravado) e a RECONSULTA por nIdReceb devolve o
  // recebimento ja concluido: diferente da 1a consulta, aqui o Atlas JA reservou e escreveu, entao
  // cada reserva vira concluido (vinculo vivo = reservado) ou falha (fiscal concluido sem ele).
  const timeoutNoConcluir = (primeira: Record<string, unknown>, reconsulta: Record<string, unknown>) => {
    concluirSpy.mockImplementationOnce(async () => {
      ordem.push('omie:concluir');
      throw new Error('timeout of 30000ms exceeded');
    });
    consultarSpy.mockImplementationOnce(consulta(primeira)).mockImplementationOnce(consulta(reconsulta));
  };

  it('sem estoque, reserva com vínculo vivo igual: UPDATE da reserva para concluido e o vínculo aparece em vinculos', async () => {
    timeoutNoConcluir({}, concluidoSemEstoque([itemRec(1, { ...vinculadoA(PC304), ...comAjustes })]));

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(r).toMatchObject({ status: 'ja_concluido', ledgerId: 'ledger-1', itensTotal: 0, semVinculo: [] });
    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' }]);
    expect(reservasFechadas).toEqual([{ id: 'reserva-1', para: 'concluido' }]);
    // UPDATE por reserva (id), so de confirmado/associado, e o concluido_em = now() so para concluido
    const [sqlReserva] = sqlDe('WHERE id = $1 AND status IN');
    expect(sqlReserva).toContain("status IN ('confirmado', 'associado')");
    expect(sqlReserva).toContain("concluido_em = CASE WHEN $2::text = 'concluido' THEN now() ELSE NULL END");
    expect(ordemSemEspera()).toEqual([
      'ledger:insert',
      'omie:consultar',
      'pc:reler',
      'omie:associar-pedido',
      'pc:associado',
      'omie:editar',
      'omie:concluir',
      'omie:reconsultar',
      'ledger:ja_concluido',
      'pc:reserva-concluido',
    ]);
    // etapa/recebido sao os da 1a consulta; itens, os da reconsulta; o erro do Concluir fica no ledger
    expect(fechamentos[0]!.slice(1, 6)).toEqual(['ja_concluido', N_ID_RECEB, '40', 'N', 1]);
    expect(String(fechamentos[0]![8])).toContain('[concluir] timeout');
    expect(String(fechamentos[0]![8])).toContain('reconsulta mostrou cRecebido=S');
    expect(fechamentos[0]![10]).toBe(1);
  });

  it('sem estoque, vínculo vivo diferente da reserva: UPDATE para falha e o vínculo NÃO aparece em vinculos', async () => {
    timeoutNoConcluir({}, concluidoSemEstoque([itemRec(1, { ...vinculadoA(PC302), ...comAjustes })]));

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(r.status).toBe('ja_concluido');
    expect(r.vinculos).toEqual([]);
    expect(reservasFechadas).toEqual([{ id: 'reserva-1', para: 'falha' }]);
  });

  it('item concluído sem nenhum vínculo no OMIE (portal ignorou o item): a reserva vai para falha e vinculos fica vazio', async () => {
    timeoutNoConcluir({}, concluidoSemEstoque([itemRec(1, { cIgnorarItem: 'S', cNaoGerarMovEstoque: 'S' })]));

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(r.status).toBe('ja_concluido');
    expect(r.vinculos).toEqual([]);
    expect(reservasFechadas).toEqual([{ id: 'reserva-1', para: 'falha' }]);
  });

  it('dois itens: um com vínculo igual (concluido) e outro com vínculo diferente (falha); só o primeiro aparece', async () => {
    timeoutNoConcluir(
      { itens: [itemRec(1), itemRec(2)] },
      concluidoSemEstoque([itemRec(1, { ...vinculadoA(PC304), ...comAjustes }), itemRec(2, { ...vinculadoA(PC304), ...comAjustes })]),
    );
    const e1 = escolha(PC304, { indice: 0, sequencias: [1] });
    const e2 = escolha(PC302, { indice: 1, sequencias: [2], kgPorSequencia: { 2: 18000 } });

    const r = await concluirRecebimentoFiscal(input({ vinculos: [e1, e2] }));

    expect(r.vinculos).toEqual([{ nSequencia: 1, pcNumero: '304', origem: 'sugestao', status: 'concluido' }]);
    expect(reservasFechadas).toEqual([
      { id: 'reserva-1', para: 'concluido' },
      { id: 'reserva-2', para: 'falha' },
    ]);
  });

  it('sequência da reserva ausente na reconsulta: falha e fora de vinculos', async () => {
    timeoutNoConcluir({}, concluidoSemEstoque([itemRec(2, { ...vinculadoA(PC304), ...comAjustes })]));

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { sequencias: [1] })] }));

    expect(r.vinculos).toEqual([]);
    expect(reservasFechadas).toEqual([{ id: 'reserva-1', para: 'falha' }]);
  });

  it('erro de banco ao fechar a reserva: vai para o log e o vínculo igual continua em vinculos (a verdade é o OMIE)', async () => {
    reservaFechaLanca = true;
    timeoutNoConcluir({}, concluidoSemEstoque([itemRec(1, { ...vinculadoA(PC304), ...comAjustes })]));

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(r.status).toBe('ja_concluido');
    expect(r.vinculos).toHaveLength(1);
    expect(loggerMock.error).toHaveBeenCalledWith(expect.objectContaining({ reserva: 'reserva-1' }), expect.stringContaining('reserva de PC'));
  });
});

// ── Cenario 13 — ledger ja concluido ─────────────────────────────────────────

describe('concluirRecebimentoFiscal com PC — ledger já concluído pelo Atlas (cenário 13)', () => {
  it('ledger já concluido pelo Atlas (lock devolve jaConcluido): relerEReservarPcs NÃO é chamado, nenhuma chamada OMIE; vinculos vêm do ledger', async () => {
    insertFalha = violacaoLedgerViva();
    linhaViva = { id: 'ledger-antigo', status: 'concluido', iniciado_em: '2026-10-22 09:00:00+00', finalizado_em: '2026-10-22 09:00:05+00' };
    vinculosLedgerRows = [
      { n_sequencia: 1, pc_numero: '304', origem: 'omie' },
      { n_sequencia: '2', pc_numero: '302', origem: 'manual' }, // o pg devolve bigint como texto
    ];

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(r).toMatchObject({ status: 'ja_concluido', ledgerId: 'ledger-antigo', itensTotal: 0, semVinculo: [] });
    expect(r.concluidoEm).toBe(new Date('2026-10-22 09:00:05+00').toISOString());
    expect(r.vinculos).toEqual([
      { nSequencia: 1, pcNumero: '304', origem: 'omie', status: 'concluido' },
      { nSequencia: 2, pcNumero: '302', origem: 'manual', status: 'concluido' },
    ]);
    expect(relerSpy).not.toHaveBeenCalled();
    expect(consultarSpy).not.toHaveBeenCalled();
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(fechamentos).toHaveLength(0);
    expect(marcacoes).toEqual([]);
    // a consulta dos vinculos usa o id do ledger ja concluido e so as linhas concluido
    const [sqlVinculos] = sqlDe('SELECT n_sequencia');
    expect(sqlVinculos).toContain("status = 'concluido'");
    const chamada = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('SELECT n_sequencia'))!;
    expect(chamada[1]).toEqual(['ledger-antigo']);
  });

  it('ledger já concluido e a leitura dos vínculos falha (banco fora): vinculos [] (aviso no log), sem erro', async () => {
    insertFalha = violacaoLedgerViva();
    linhaViva = { id: 'ledger-antigo', status: 'ja_concluido', iniciado_em: '2026-10-22 09:00:00+00', finalizado_em: '2026-10-22 09:00:05+00' };
    vinculosLedgerLanca = true;

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(r.status).toBe('ja_concluido');
    expect(r.vinculos).toEqual([]);
    expect(relerSpy).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.objectContaining({ ledgerId: 'ledger-antigo' }), expect.stringContaining('Vínculos do ledger fiscal indisponíveis'));
  });
});

// ── Cenario 14 — lock orfao e duplo clique ───────────────────────────────────

describe('concluirRecebimentoFiscal com PC — lock do ledger (cenário 14)', () => {
  it('lock órfão retomado com escolhas: relerEReservarPcs é chamado com o id do ledger retomado; o fechamento usa o token da retomada', async () => {
    insertFalha = violacaoLedgerViva();
    linhaViva = { id: 'ledger-orfao', status: 'em_andamento', iniciado_em: '2026-10-22 08:00:00+00', finalizado_em: null };
    retomadaOk = true;

    const r = await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    expect(r).toMatchObject({ status: 'concluido', ledgerId: 'ledger-orfao' });
    expect(relerSpy).toHaveBeenCalledTimes(1);
    expect(relerSpy.mock.calls[0]![0]).toMatchObject({ ledgerId: 'ledger-orfao' });
    expect(ordemSemEspera()).toEqual([
      'ledger:insert',
      'ledger:retomar',
      'omie:consultar',
      'pc:reler',
      'omie:associar-pedido',
      'pc:associado',
      'omie:editar',
      'omie:concluir',
      'ledger:concluido',
      'pc:concluido',
    ]);
    expect(fechamentos[0]![0]).toBe('ledger-orfao');
    expect(fechamentos[0]![9]).toBe('TOKEN-RETOMADA');
    expect(marcacoes.every((m) => m.ledgerId === 'ledger-orfao')).toBe(true);
  });

  it('duplo clique (lock ocupado, linha em andamento recente): RecebimentoFiscalEmAndamentoError sem relerEReservarPcs e sem OMIE', async () => {
    insertFalha = violacaoLedgerViva();
    linhaViva = { id: 'ledger-vivo', status: 'em_andamento', iniciado_em: '2026-10-22 09:59:50+00', finalizado_em: null };
    retomadaOk = false;

    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));
    } catch (e) {
      erro = e;
    }

    expect(erro).toBeInstanceOf(RecebimentoFiscalEmAndamentoError);
    expect((erro as Error).message).toContain('NF 7813');
    expect(relerSpy).not.toHaveBeenCalled();
    expect(consultarSpy).not.toHaveBeenCalled();
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(fechamentos).toHaveLength(0);
    expect(marcacoes).toEqual([]);
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'ledger:retomar']);
  });

  it('falha com escrita há menos de 70 s: RecebimentoFiscalAguardeError antes de qualquer releitura de PC (a trava e a espera vêm primeiro)', async () => {
    esperaSegundos = 42;

    let erro: unknown;
    try {
      await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));
    } catch (e) {
      erro = e;
    }

    expect(erro).toBeInstanceOf(RecebimentoFiscalAguardeError);
    expect(segundosAteNovaTentativa(erro as RecebimentoFiscalAguardeError)).toBe(42);
    expect(relerSpy).not.toHaveBeenCalled();
    expect(consultarSpy).not.toHaveBeenCalled();
    expect(ordem).toEqual(['ledger:espera?']);
  });
});

// ── Cenario 15 — empresa ─────────────────────────────────────────────────────

describe('concluirRecebimentoFiscal com PC — empresa (cenário 15)', () => {
  it("o INSERT do ledger leva empresa 'q2p' por default", async () => {
    await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));

    const ins = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO stockbridge.recebimento_fiscal'))!;
    expect(String(ins[0])).toMatch(/\(nf_chave_acesso, n_id_receb, nota_fiscal, fornecedor_nome, status, confirmado_por, empresa\)/);
    expect(ins[1]).toEqual([CHAVE, N_ID_RECEB, '7813', FORNECEDOR, USER, 'q2p']);
    expect(relerSpy.mock.calls[0]![0]).toMatchObject({ empresa: 'q2p' });
  });

  it("empresa 'acxe' informada: o INSERT do ledger leva 'acxe' e todas as chamadas OMIE (releitura, consulta, associar, editar, concluir) usam 'acxe'", async () => {
    await concluirRecebimentoFiscal(input({ empresa: 'acxe', vinculos: [escolha(PC304)] }));

    const ins = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO stockbridge.recebimento_fiscal'))!;
    expect(ins[1]).toEqual([CHAVE, N_ID_RECEB, '7813', FORNECEDOR, USER, 'acxe']);
    expect(relerSpy.mock.calls[0]![0]).toMatchObject({ empresa: 'acxe', ledgerId: 'ledger-1' });
    expect(consultarSpy).toHaveBeenCalledWith('acxe', { cChaveNfe: CHAVE });
    expect(alterarSpy.mock.calls.length).toBeGreaterThan(0);
    expect(alterarSpy.mock.calls.every((c) => c[0] === 'acxe')).toBe(true);
    expect(concluirSpy).toHaveBeenCalledWith('acxe', { nIdReceb: N_ID_RECEB, cEtapa: '60' });
  });

  it("empresa 'acxe': a reconsulta depois de uma falha também usa 'acxe' (por nIdReceb)", async () => {
    alterarSpy.mockImplementationOnce(async () => {
      ordem.push('omie:associar-pedido');
      throw fault('SOAP-ENV:Client-5101', 'falha qualquer');
    });
    await expect(concluirRecebimentoFiscal(input({ empresa: 'acxe', vinculos: [escolha(PC304)] }))).rejects.toBeInstanceOf(RecebimentoFiscalError);
    expect(consultarSpy.mock.calls).toEqual([
      ['acxe', { cChaveNfe: CHAVE }],
      ['acxe', { nIdReceb: N_ID_RECEB }],
    ]);
  });
});

// ── Cenario 18 — a mensagem do RecebimentoFiscalError cita o PC (achado fiscal-04) ──

describe('concluirRecebimentoFiscal com PC — a mensagem do RecebimentoFiscalError cita o PC (cenário 18, achado fiscal-04, FR-014)', () => {
  // A mensagem ganha ", com o vínculo ao PC 304," (ou ", com o vínculo aos PCs 302 e 304,") entre o
  // rotulo da NF e " no OMIE." quando ha PC em jogo: o numero lido AO VIVO (reserva) ou, se a falha
  // veio antes da reserva, o da escolha. Sem PC, e a mensagem da 016. Nunca o codigo do OMIE (ACXEGDP-313).
  const trechoDoPc = (lista: string) => `NF 7813 (${FORNECEDOR}), com o vínculo ${lista}, no OMIE.`;

  /** A PRIMEIRA chamada de AlterarRecebimento falha, seja qual for a acao (ASSOCIAR, se o item nao tem vinculo). */
  const faultNaPrimeiraAlteracao = () =>
    alterarSpy.mockImplementationOnce(async (_empresa: string, i: ChamadaAlterar) => {
      ordem.push(`omie:${i.itens[0]!.cAcao.toLowerCase()}`);
      throw fault('SOAP-ENV:Client-5101', 'Pedido de compra nao localizado');
    });

  it('fault no ASSOCIAR com reservas: ", com o vínculo ao PC 304," entre o rótulo da NF e " no OMIE."; sem o código do OMIE', async () => {
    faultNaPrimeiraAlteracao();

    const erro = await erroDe(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] })));

    expect(erro).toBeInstanceOf(RecebimentoFiscalError);
    expect((erro as RecebimentoFiscalError).passo).toBe('associar');
    expect(erro.message).toContain(trechoDoPc('ao PC 304'));
    expect(erro.message).toContain('PC 304');
    expect(erro.message).toContain('Nada foi registrado no estoque — tente novamente em 1 minuto.');
    expect(erro.message).not.toMatch(/\d{9,}/); // nenhuma sequencia de 9+ digitos (nCodPed/nCodItem do OMIE)
    expect(erro.message).not.toContain('Client-5101');
  });

  it.each([
    ['um PC', [PC304], 'ao PC 304'],
    ['dois PCs', [PC302, PC304], 'aos PCs 302 e 304'],
    ['três PCs', [PC302, PC304, PC305], 'aos PCs 302, 304 e 305'],
  ])('%s em jogo: a mensagem lista os números na ordem das escolhas', async (_nome, pcs, lista) => {
    consultaUnica({ itens: pcs.map((_, i) => itemRec(i + 1)) });
    faultNaPrimeiraAlteracao();
    const escolhas = pcs.map((pc, i) => escolha(pc, { indice: i, sequencias: [i + 1], kgPorSequencia: { [i + 1]: 18000 } }));

    const erro = await erroDe(concluirRecebimentoFiscal(input({ vinculos: escolhas })));

    expect(erro).toBeInstanceOf(RecebimentoFiscalError);
    expect(erro.message).toContain(trechoDoPc(lista));
    expect(erro.message).not.toMatch(/\d{9,}/);
  });

  it('o mesmo PC em várias sequências (item agregado) ou em vários itens aparece uma vez só', async () => {
    consultaUnica({ itens: [itemRec(1, { nQtdeNFe: 9000 }), itemRec(3, { nQtdeNFe: 9000 }), itemRec(4)] });
    faultNaPrimeiraAlteracao();
    const agregado = escolha(PC304, { indice: 0, sequencias: [1, 3], kgPorSequencia: { 1: 9000, 3: 9000 } });
    const outroItem = escolha(PC304, { indice: 1, sequencias: [4], kgPorSequencia: { 4: 18000 } });

    const erro = await erroDe(concluirRecebimentoFiscal(input({ vinculos: [agregado, outroItem] })));

    expect(erro.message).toContain(trechoDoPc('ao PC 304'));
    expect(erro.message).not.toContain('PCs');
  });

  it('o número vem da reserva (lido AO VIVO), não da escolha: vínculo do OMIE fora da cópia chega à escolha com número vazio', async () => {
    relerSpy.mockImplementationOnce(async (a: { escolhas: EscolhaPcValidada[] }) => {
      ordem.push('pc:reler');
      return reservasDe(a.escolhas).map((r) => ({ ...r, pcNumero: '304' })); // o ConsultarPedCompra trouxe o numero
    });
    consultaUnica({ itens: [itemRec(1, vinculadoA(PC304))] });
    faultNaPrimeiraAlteracao(); // vivo = escolhido: a 1a alteracao e o EDITAR
    const foraDaCopia = escolhaVendo(PC304, PC304, { origem: 'omie', candidato: candidato(PC304, { pcNumero: '' }) });

    const erro = await erroDe(concluirRecebimentoFiscal(input({ vinculos: [foraDaCopia] })));

    expect((erro as RecebimentoFiscalError).passo).toBe('editar');
    expect(erro.message).toContain(trechoDoPc('ao PC 304'));
  });

  it('números vazios são descartados: o PC sem número não vira "PC ,"; e sem nenhum número a mensagem é a da 016', async () => {
    consultaUnica({ itens: [itemRec(1), itemRec(2)] });
    faultNaPrimeiraAlteracao();
    relerSpy.mockImplementationOnce(async (a: { escolhas: EscolhaPcValidada[] }) => {
      ordem.push('pc:reler');
      return reservasDe(a.escolhas).map((r) => (r.nSequencia === 1 ? { ...r, pcNumero: '' } : r)); // so a seq 2 tem numero
    });
    const e1 = escolha(PC302, { indice: 0, sequencias: [1], candidato: candidato(PC302, { pcNumero: '' }) });
    const e2 = escolha(PC304, { indice: 1, sequencias: [2], kgPorSequencia: { 2: 18000 } });

    const comUm = await erroDe(concluirRecebimentoFiscal(input({ vinculos: [e1, e2] })));
    expect(comUm.message).toContain(trechoDoPc('ao PC 304'));
    expect(comUm.message).not.toContain('PC ,');

    consultaUnica({ itens: [itemRec(1)] });
    faultNaPrimeiraAlteracao();
    relerSpy.mockImplementationOnce(async (a: { escolhas: EscolhaPcValidada[] }) => {
      ordem.push('pc:reler');
      return reservasDe(a.escolhas).map((r) => ({ ...r, pcNumero: '' }));
    });
    const semNumero = await erroDe(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { candidato: candidato(PC304, { pcNumero: '' }) })] })));
    expect(semNumero).toBeInstanceOf(RecebimentoFiscalError);
    expect(semNumero.message).toContain(`da NF 7813 (${FORNECEDOR}) no OMIE.`);
    expect(semNumero.message).not.toMatch(/\bPCs?\b/);
  });

  it.each([
    ['um PC', [PC304], 'ao PC 304'],
    ['dois PCs', [PC302, PC304], 'aos PCs 302 e 304'],
  ])('fault genérico na releitura (consultar_pc), %s: ainda não há reserva, então a mensagem cita o PC da escolha', async (_nome, pcs, lista) => {
    consultaUnica({ itens: pcs.map((_, i) => itemRec(i + 1)) });
    relerFalhaCom(fault('SOAP-ENV:Server', 'Servico indisponivel'));
    const escolhas = pcs.map((pc, i) => escolha(pc, { indice: i, sequencias: [i + 1], kgPorSequencia: { [i + 1]: 18000 } }));

    const erro = await erroDe(concluirRecebimentoFiscal(input({ vinculos: escolhas })));

    expect(erro).toBeInstanceOf(RecebimentoFiscalError);
    expect((erro as RecebimentoFiscalError).passo).toBe('consultar_pc');
    expect(erro.message).toContain(trechoDoPc(lista));
    expect(erro.message).not.toContain('Servico indisponivel');
    expect(erro.message).not.toMatch(/\d{9,}/);
  });

  it('fault na ConsultarRecebimento (antes de qualquer reserva): a mensagem cita o PC da escolha', async () => {
    consultarSpy.mockImplementationOnce(consultaFalha(fault('SOAP-ENV:Server', 'Servico indisponivel')));

    const erro = await erroDe(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] })));

    expect((erro as RecebimentoFiscalError).passo).toBe('consultar');
    expect(relerSpy).not.toHaveBeenCalled();
    expect(erro.message).toContain(trechoDoPc('ao PC 304'));
  });

  it('recebimento sem itens na consulta: RecebimentoFiscalError (consultar) que cita o PC da escolha, sem releitura nem escrita', async () => {
    consultaUnica({ itens: [] });

    const erro = await erroDe(concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] })));

    expect(erro).toBeInstanceOf(RecebimentoFiscalError);
    expect((erro as RecebimentoFiscalError).passo).toBe('consultar');
    expect(erro.message).toContain(trechoDoPc('ao PC 304'));
    expect(relerSpy).not.toHaveBeenCalled();
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).not.toHaveBeenCalled();
    expect(fechamentos[0]![6]).toBe('consultar');
    expect(String(fechamentos[0]![8])).toContain('sem itens');
  });

  it.each([
    ['sem nenhuma escolha (NF sem PC, receita da 016)', {}],
    ['só com sequenciasSemVinculo (modo "receber sem vínculo")', { sequenciasSemVinculo: [1] }],
  ])('%s: a mensagem é exatamente a da 016, sem nenhuma menção a PC', async (_nome, over) => {
    faultNaPrimeiraAlteracao(); // a 1a alteracao e o EDITAR

    const erro = await erroDe(concluirRecebimentoFiscal(input(over)));

    expect(erro).toBeInstanceOf(RecebimentoFiscalError);
    expect((erro as RecebimentoFiscalError).passo).toBe('editar');
    expect(relerSpy).not.toHaveBeenCalled();
    expect(erro.message).toBe(
      `Não foi possível concluir o recebimento fiscal da NF 7813 (${FORNECEDOR}) no OMIE. ` +
        'Nada foi registrado no estoque — tente novamente em 1 minuto. Se persistir, avise o fiscal.',
    );
    expect(erro.message).not.toMatch(/\bPCs?\b/);
  });
});

// ── Lacunas encontradas na revisão (corrigidas) ──────────────────────────────

describe('concluirRecebimentoFiscal com PC — lacunas encontradas na revisão', () => {
  // Corrigido: na retomada depois de um IGNORAR ja gravado, a sequencia "sem vinculo" ja
  // ignorada continua em `semVinculo` (planejarAcoes e ramos ja_concluido), para compras
  // receber o aviso recebida_sem_vinculo (FR-020).
  it('retomada com a seq sem vínculo já ignorada na tentativa anterior: semVinculo continua [2] (compras precisa do aviso recebida_sem_vinculo)', async () => {
    consultaUnica({
      itens: [itemRec(1, { ...vinculadoA(PC304), ...comAjustes }), itemRec(2, { cIgnorarItem: 'S', cNaoGerarMovEstoque: 'S' })],
    });

    const r = await concluirRecebimentoFiscal(
      input({ vinculos: [escolhaVendo(PC304, PC304, { origem: 'omie' })], sequenciasSemVinculo: [2] }),
    );

    expect(r.status).toBe('concluido');
    expect(r.semVinculo).toEqual([2]);
  });
});

describe('instanteConclusaoOmie — dRec + hRec do recebimento (horário de Brasília)', () => {
  const AGORA = new Date('2026-10-22T13:00:00.000Z');
  it.each([
    ['21/10/2026', '18:05:00', '2026-10-21T21:05:00.000Z'],
    ['21/10/2026', '18:05', '2026-10-21T21:05:00.000Z'],
    ['2026-10-21', '08:00:30', '2026-10-21T11:00:30.000Z'],
    ['21/10/2026', null, '2026-10-21T03:00:00.000Z'],
  ])('%s %s -> %s', (dRec, hRec, iso) => {
    expect(instanteConclusaoOmie({ dRec, hRec }, AGORA)!.toISOString()).toBe(iso);
  });

  it('sem data, ou formato desconhecido: null', () => {
    expect(instanteConclusaoOmie({ dRec: null, hRec: '18:05:00' }, AGORA)).toBeNull();
    expect(instanteConclusaoOmie({ dRec: '21-10-2026', hRec: '18:05:00' }, AGORA)).toBeNull();
    expect(instanteConclusaoOmie({ dRec: '21/10/2026', hRec: '6h05' }, AGORA)).toBeNull();
  });

  it('nunca no futuro (relógio do OMIE adiantado): limitado a agora', () => {
    expect(instanteConclusaoOmie({ dRec: '23/10/2026', hRec: '10:00:00' }, AGORA)!.toISOString()).toBe(AGORA.toISOString());
  });
});

// ── Trava de unidade, modo 'converter' (22/10/2026): nQtdeRecebida no EDITAR ───────────────────────
//
// O OMIE copia para nQtdeRec do PC a quantidade recebida do item NA UNIDADE DA NF, sem converter (NF 60199 em
// toneladas baixou o PC 306 em kg com 8,25 em vez de 8.250). No modo 'converter' a releitura devolve, por
// sequencia, `ReservaPc.nQtdeRecebida` (kg da linha na unidade do PC; null = nada a converter) e o EDITAR manda
// itensAjustes.nQtdeRecebida SO nessas sequencias; "ajustes ja aplicados" passa a exigir tambem que o OMIE
// devolva a mesma nQtdeRecebida (tolerancia 1e-6) — senao o EDITAR corrige.
describe('concluirRecebimentoFiscal com PC — nQtdeRecebida no EDITAR (trava de unidade, modo converter)', () => {
  /** A releitura devolve as reservas com a quantidade convertida por sequencia (null = sem conversao). */
  const reservasComConversao = (qtdPorSeq: Record<number, number | null>) =>
    relerSpy.mockImplementationOnce(async (a: { escolhas: EscolhaPcValidada[] }) => {
      ordem.push('pc:reler');
      return reservasDe(a.escolhas).map((r) => ({ ...r, nQtdeRecebida: qtdPorSeq[r.nSequencia] ?? null }));
    });
  const ajustesDoEditar = () => chamadasAlterar().flatMap((c) => c.itens).filter((i) => i.cAcao === 'EDITAR').map((i) => [i.nSequencia, i.itensAjustes]);

  it('item sem vínculo: o ASSOCIAR-PEDIDO não leva ajuste; o EDITAR leva os dois ajustes de sempre MAIS nQtdeRecebida (8.250 kg em PC de kg)', async () => {
    reservasComConversao({ 1: 8250 });
    await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { qtdNfKg: 8250, kgPorSequencia: { 1: 8250 } })] }));

    const [associar, editar] = chamadasAlterar();
    expect(associar!.itens[0]).not.toHaveProperty('itensAjustes');
    expect(editar).toEqual({
      nIdReceb: N_ID_RECEB,
      itens: [{ nSequencia: 1, cAcao: 'EDITAR', itensAjustes: { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N', nQtdeRecebida: 8250 } }],
    });
  });

  it('sem conversão (nQtdeRecebida null — mesma unidade): o EDITAR NÃO leva a chave nQtdeRecebida', async () => {
    reservasComConversao({ 1: null });
    await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));
    const [, editar] = chamadasAlterar();
    expect(editar!.itens[0]!.itensAjustes).toEqual({ cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' });
    expect(editar!.itens[0]!.itensAjustes).not.toHaveProperty('nQtdeRecebida');
  });

  it('o comportamento padrão (reservas sem o campo, como antes da trava) também não manda nQtdeRecebida', async () => {
    await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304)] }));
    expect(chamadasAlterar()[1]!.itens[0]!.itensAjustes).toEqual({ cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' });
  });

  it('uma quantidade por SEQUÊNCIA: 5.000 kg e 3.250 kg do mesmo item agregado saem cada um na sua linha', async () => {
    consultaUnica({ itens: [itemRec(1, { nQtdeNFe: 5 }), itemRec(2, { nQtdeNFe: 3.25 })] });
    reservasComConversao({ 1: 5000, 2: 3250 });
    await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { sequencias: [1, 2], qtdNfKg: 8250, kgPorSequencia: { 1: 5000, 2: 3250 } })] }));
    expect(ajustesDoEditar()).toEqual([
      [1, { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N', nQtdeRecebida: 5000 }],
      [2, { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N', nQtdeRecebida: 3250 }],
    ]);
  });

  it('só algumas sequências com conversão: as demais seguem sem a chave', async () => {
    consultaUnica({ itens: [itemRec(1), itemRec(2)] });
    reservasComConversao({ 1: 8250, 2: null });
    await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { sequencias: [1, 2], kgPorSequencia: { 1: 8250, 2: 9750 } })] }));
    expect(ajustesDoEditar()).toEqual([
      [1, { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N', nQtdeRecebida: 8250 }],
      [2, { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' }],
    ]);
  });

  it('nQtdeRecebida só no EDITAR: o IGNORAR da outra sequência (sem PC) e o ASSOCIAR nunca levam itensAjustes (erro 151)', async () => {
    consultaUnica({ itens: [itemRec(1), itemRec(2)] });
    reservasComConversao({ 1: 8250 });
    await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { sequencias: [1] })], sequenciasSemVinculo: [2] }));
    expect(acoesPorChamada()).toEqual([['ASSOCIAR-PEDIDO'], ['EDITAR'], ['IGNORAR']]);
    const [associar, , ignorar] = chamadasAlterar();
    expect(associar!.itens[0]).not.toHaveProperty('itensAjustes');
    expect(ignorar!.itens).toEqual([{ nSequencia: 2, cAcao: 'IGNORAR' }]);
  });

  it('vínculo vivo = escolhido, com os ajustes E a mesma nQtdeRecebida já gravados no OMIE: não há AlterarRecebimento, só o Concluir', async () => {
    consultaUnica({ itens: [itemRec(1, { ...vinculadoA(PC304), ...comAjustes, nQtdeRecebida: 8250 })] });
    reservasComConversao({ 1: 8250 });
    await concluirRecebimentoFiscal(input({ vinculos: [escolhaVendo(PC304, PC304, { origem: 'omie' })] }));
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(concluirSpy).toHaveBeenCalledTimes(1);
  });

  it('a comparação da quantidade tem tolerância de 1e-6 (arredondamento da reserva): 8250,0000004 conta como igual', async () => {
    consultaUnica({ itens: [itemRec(1, { ...vinculadoA(PC304), ...comAjustes, nQtdeRecebida: 8250.0000004 })] });
    reservasComConversao({ 1: 8250 });
    await concluirRecebimentoFiscal(input({ vinculos: [escolhaVendo(PC304, PC304, { origem: 'omie' })] }));
    expect(alterarSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['o OMIE tem outra quantidade (8,25 — a baixa errada da NF 60199)', 8.25],
    ['o OMIE devolve 0', 0],
    ['o OMIE não devolve a quantidade (null)', null],
    ['o OMIE não devolve o campo (ausente)', undefined],
  ])('vínculo vivo = escolhido e ajustes já aplicados, mas %s: o EDITAR roda para corrigir a quantidade', async (_nome, atual) => {
    consultaUnica({ itens: [itemRec(1, { ...vinculadoA(PC304), ...comAjustes, ...(atual === undefined ? {} : { nQtdeRecebida: atual }) })] });
    reservasComConversao({ 1: 8250 });
    await concluirRecebimentoFiscal(input({ vinculos: [escolhaVendo(PC304, PC304, { origem: 'omie' })] }));
    expect(seqsDaAcao('EDITAR')).toEqual([1]);
    expect(chamadasAlterar()[0]!.itens[0]!.itensAjustes).toEqual({ cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N', nQtdeRecebida: 8250 });
    expect(seqsDaAcao('ASSOCIAR-PEDIDO')).toEqual([]);
  });

  it('quando NÃO há conversão a fazer, a nQtdeRecebida que o OMIE tem no item não é exigida: ajustes aplicados bastam (sem EDITAR)', async () => {
    consultaUnica({ itens: [itemRec(1, { ...vinculadoA(PC304), ...comAjustes, nQtdeRecebida: 123 })] });
    reservasComConversao({ 1: null });
    await concluirRecebimentoFiscal(input({ vinculos: [escolhaVendo(PC304, PC304, { origem: 'omie' })] }));
    expect(alterarSpy).not.toHaveBeenCalled();
  });

  it('item com vínculo vivo e SEM escolha no POST (fora do recorte): EDITAR sem nQtdeRecebida — a conversão é só do que o Atlas escolheu', async () => {
    consultaUnica({ itens: [itemRec(1), itemRec(2, vinculadoA(PC302))] });
    reservasComConversao({ 1: 8250 });
    await concluirRecebimentoFiscal(input({ vinculos: [escolha(PC304, { sequencias: [1] })] }));
    expect(ajustesDoEditar()).toEqual([
      [1, { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N', nQtdeRecebida: 8250 }],
      [2, { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' }],
    ]);
  });

  it('retomada depois de uma falha no Concluir: a releitura devolve a mesma quantidade e os ajustes já gravados (com nQtdeRecebida) não são reenviados', async () => {
    // 1ª tentativa: ASSOCIAR + EDITAR passaram (o OMIE agora tem o vínculo, os ajustes e a quantidade); o Concluir falhou.
    consultaUnica({ itens: [itemRec(1, { ...vinculadoA(PC304), ...comAjustes, nQtdeRecebida: 8250 })] });
    reservasComConversao({ 1: 8250 });
    await concluirRecebimentoFiscal(input({ vinculos: [escolhaVendo(PC304, PC304)] }));
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(ordemSemEspera()).toEqual(['ledger:insert', 'omie:consultar', 'pc:reler', 'pc:associado', 'omie:concluir', 'ledger:concluido', 'pc:concluido']);
  });
});
