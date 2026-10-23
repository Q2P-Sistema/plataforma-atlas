import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — dispensa de NF da ACXE pelo gestor (nf-dispensa.service.ts).
// A chave de acesso e unica entre os espelhos e a tabela nf_dispensa nao tem empresa: dispensar NF da ACXE funciona
// como sempre. O que a Historia 5 acrescentou foi o texto do aviso ao fiscal (enviarAlertaNfDispensada ganhou
// `empresa`, que cita a ACXE no assunto e no corpo). Detalhe da NF e e-mail sao mockados; o ledger via getPool fake.

const poolQuerySpy = vi.fn();
const config: Record<string, unknown> = {
  STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE: '2026-09-11',
  STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: true,
};

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  getConfig: () => config,
}));
vi.mock('../services/correlacao-produto.service.js', () => ({ sugerirProdutosEmLote: vi.fn().mockResolvedValue(new Map()) }));

const emailSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/notificacao.service.js', () => ({
  enviarAlertaNfDispensada: (a: unknown) => emailSpy(a),
  enviarAlertaDispensaRevertida: vi.fn().mockResolvedValue(undefined),
}));

const detalheMock = vi.fn();
vi.mock('../services/fila-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/fila-nacional.service.js')>('../services/fila-nacional.service.js');
  return { ...real, getDetalheNfNacional: (c: string) => detalheMock(c) };
});

import { dispensarNf } from '../services/nf-dispensa.service.js';
import { converterItemNfParaKg } from '../services/unidade-nf.js';
import type { DetalheNfNacional, ItemNfNacional } from '../services/fila-nacional.service.js';

const CHAVE = '35261011111111000111550010000009370000009370';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';

function item(): ItemNfNacional {
  const conv = converterItemNfParaKg(26000, 'KG', 124800);
  return {
    indice: 0, descricaoFornecedor: 'PP PRETO Q35', descricaoNormalizada: 'PP PRETO Q35', cfop: '1.101', quantidadeNf: 26000, unidadeOriginal: 'KG',
    quantidadeNfKg: 26000, valorUnitarioBrl: 4.8, valorTotalItemBrl: 124800, rsPorKg: 4.8, linhasAgregadas: 1, produtosSugeridos: [],
    bloqueio: 'sem_correlacao', bloqueioMensagem: null, jaRecebido: false, quantidadeNfJaAtribuidaKg: 0, quantidadeConferidaJaGravadaKg: 0,
    quantidadeRestanteKg: 26000, baixadoComoExterno: false, baixaSolicitada: false, conversao: conv, sequenciasRecebimento: [], pc: null,
  };
}
const detalhe = (over: Partial<DetalheNfNacional> = {}): DetalheNfNacional =>
  ({
    nfChaveAcesso: CHAVE, notaFiscal: '937', fornecedorNome: 'SOLUTEC PLASTICOS LTDA', fornecedorCnpj: '11.111.111/0001-11', dtEmissao: '2026-10-20',
    diasDesdeEmissao: 2, cfop: '1.101', valorTotalBrl: 124800, valorNotaBrl: 124800, itens: [item()], linhasForaDoRecorte: 0, fiscal: 'pendente',
    nIdReceb: 8517930857, dispensavel: true, empresa: 'acxe', ...over,
  }) as DetalheNfNacional;

beforeEach(() => {
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation(async (sql: string) => {
    if (sql.includes('INSERT INTO stockbridge.nf_dispensa')) return { rows: [{ id: ID, dispensado_em: '2026-10-22 10:00:00+00' }] };
    if (sql.includes('SELECT name FROM atlas.users')) return { rows: [{ name: 'Gestor Teste' }] };
    return { rows: [] };
  });
  emailSpy.mockReset();
  emailSpy.mockResolvedValue(undefined);
  detalheMock.mockReset();
  detalheMock.mockResolvedValue(detalhe());
});

const gestor = { userId: USER, perfilUsuario: 'gestor' as const };
const insertParams = () => poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO stockbridge.nf_dispensa'))?.[1] as unknown[] | undefined;

describe('dispensarNf — NF da ACXE', () => {
  it('grava a dispensa pela chave de acesso (unica entre os espelhos), com a situacao fiscal de como estava, e avisa o fiscal', async () => {
    const r = await dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'Fornecedor vai cancelar a nota', ...gestor });
    expect(r).toMatchObject({ id: ID, notaFiscal: '937', fornecedorNome: 'SOLUTEC PLASTICOS LTDA', situacaoFiscalNaDispensa: 'pendente' });
    expect(insertParams()).toEqual([CHAVE, '937', 'SOLUTEC PLASTICOS LTDA', '11.111.111/0001-11', 'pendente', 'Fornecedor vai cancelar a nota', USER]);
    await vi.waitFor(() => expect(emailSpy).toHaveBeenCalledTimes(1));
    expect(emailSpy.mock.calls[0]![0]).toMatchObject({ notaFiscal: '937', situacaoFiscalNaDispensa: 'pendente', valorNfBrl: 124800, dispensadoPorNome: 'Gestor Teste' });
  });

  // DEFEITO ENCONTRADO (nao corrigido aqui — fora do escopo dos testes): enviarAlertaNfDispensada recebeu o parametro
  // opcional `empresa` na Historia 5 (cita a ACXE no assunto e no corpo), mas o UNICO ponto de chamada,
  // nf-dispensa.service.ts (dispensarNf), nao o repassa: o fiscal da ACXE recebe o texto generico da Q2P, sem saber de qual
  // empresa e a nota. Correcao: `empresa: detalhe.empresa` na chamada de enviarAlertaNfDispensada (nf-dispensa.service.ts).
  // Defeito achado pelos testes da Fase 2 (a chamada nao passava a empresa) e corrigido em nf-dispensa.service.ts.
  it('o aviso ao fiscal leva a empresa da NF (acxe) para citar a ACXE no e-mail', async () => {
    await dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'Fornecedor vai cancelar a nota', ...gestor });
    await vi.waitFor(() => expect(emailSpy).toHaveBeenCalledTimes(1));
    expect(emailSpy.mock.calls[0]![0]).toMatchObject({ empresa: 'acxe' });
  });
});
