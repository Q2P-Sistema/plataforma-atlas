import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 016 (ACXEGDP-395), T046 — dispensa de NF pelo gestor (Historia 4).
// Detalhe da NF mockado; ledger de dispensa via getPool mockado; e-mail ao fiscal
// e um spy. Prova: guardas (flag, perfil, motivo), "ao menos um item pendente",
// situacao fiscal gravada como estava, idempotencia (409), reversao e listagem.

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

vi.mock('../services/correlacao-produto.service.js', () => ({
  sugerirProdutosEmLote: vi.fn().mockResolvedValue(new Map()),
}));

const emailSpy = vi.fn().mockResolvedValue(undefined);
const emailRevertidaSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/notificacao.service.js', () => ({
  enviarAlertaNfDispensada: (a: unknown) => emailSpy(a),
  enviarAlertaDispensaRevertida: (a: unknown) => emailRevertidaSpy(a),
}));

const detalheMock = vi.fn();
vi.mock('../services/fila-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/fila-nacional.service.js')>('../services/fila-nacional.service.js');
  return { ...real, getDetalheNfNacional: (c: string) => detalheMock(c) };
});

import {
  dispensarNf,
  listarDispensas,
  reverterDispensa,
  RecebimentoFiscalDesabilitadoError,
  DispensaNaoPermitidaError,
  NfNaoDispensavelError,
  NfJaDispensadaError,
  DispensaNaoEncontradaError,
  MotivoDispensaObrigatorioError,
  NfEmRecebimentoFiscalError,
} from '../services/nf-dispensa.service.js';
import { LOCK_FISCAL_ORFAO_MIN } from '../services/recebimento-fiscal.service.js';
import { converterItemNfParaKg } from '../services/unidade-nf.js';
import type { DetalheNfNacional, ItemNfNacional } from '../services/fila-nacional.service.js';

const CHAVE = '35261014555032000753550010000068421827355174';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';

function item(o: Partial<ItemNfNacional> = {}): ItemNfNacional {
  const conv = converterItemNfParaKg(18000, 'KG', 203400);
  const nfKg = conv.ok ? conv.quantidadeKg : null;
  return {
    indice: 0, descricaoFornecedor: 'SUCATA PLASTICO', descricaoNormalizada: 'SUCATA PLASTICO', cfop: '1.102', quantidadeNf: 18000, unidadeOriginal: 'KG',
    quantidadeNfKg: nfKg, valorUnitarioBrl: 11.3, valorTotalItemBrl: 203400, rsPorKg: conv.ok ? conv.rsPorKg : null, linhasAgregadas: 1,
    produtosSugeridos: [], bloqueio: 'sem_correlacao', bloqueioMensagem: null, jaRecebido: false, quantidadeNfJaAtribuidaKg: 0,
    quantidadeConferidaJaGravadaKg: 0, quantidadeRestanteKg: nfKg, baixadoComoExterno: false, baixaSolicitada: false, conversao: conv,
    ...o,
  };
}

const detalhe = (over: Partial<DetalheNfNacional> = {}): DetalheNfNacional => ({
  nfChaveAcesso: CHAVE, notaFiscal: '6842', fornecedorNome: 'REPLAS COMERCIAL LTDA', fornecedorCnpj: '14.555.032/0007-53',
  dtEmissao: '2026-10-01', diasDesdeEmissao: 1, cfop: '1.102', valorTotalBrl: 203400, itens: [item()], linhasForaDoRecorte: 0,
  fiscal: 'pendente', nIdReceb: 8510564869, dispensavel: true,
  // NF mista: a conta a pagar do OMIE e da NF inteira (inclusive item fora do recorte)
  valorNotaBrl: 210000,
  ...over,
});

let dispensaAtivaRows: Array<{ id: string; nota_fiscal: string }> = [];
let insertFalha: unknown = null;
let reverterRows: Array<Record<string, unknown>> = [];
/** ledger com recebimento (fiscal) em curso para a chave */
let ledgerEmCurso: Array<{ nota_fiscal: string }> = [];
let listaRows: Record<string, unknown>[] = [];

function responder(sql: string) {
  if (sql.includes('SELECT id, nota_fiscal FROM stockbridge.nf_dispensa')) return { rows: dispensaAtivaRows };
  if (sql.includes('FROM stockbridge.recebimento_fiscal') && sql.includes("status = 'em_andamento'")) return { rows: ledgerEmCurso };
  if (sql.includes('INSERT INTO stockbridge.nf_dispensa')) {
    if (insertFalha) {
      const e = insertFalha;
      insertFalha = null;
      throw e;
    }
    return { rows: [{ id: ID, dispensado_em: '2026-10-02 10:00:00+00' }] };
  }
  if (sql.includes('SELECT name FROM atlas.users')) return { rows: [{ name: 'Gestor Teste' }] };
  if (sql.includes('UPDATE stockbridge.nf_dispensa')) return { rows: reverterRows };
  if (sql.includes('FROM stockbridge.nf_dispensa d')) return { rows: listaRows };
  return { rows: [] };
}

const gestor = { userId: USER, perfilUsuario: 'gestor' as const };

beforeEach(() => {
  config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
  dispensaAtivaRows = [];
  insertFalha = null;
  reverterRows = [];
  ledgerEmCurso = [];
  listaRows = [];
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation(async (sql: string) => responder(sql));
  emailSpy.mockReset();
  emailSpy.mockResolvedValue(undefined);
  emailRevertidaSpy.mockReset();
  emailRevertidaSpy.mockResolvedValue(undefined);
  detalheMock.mockReset();
  detalheMock.mockResolvedValue(detalhe());
});

const insertParams = () => poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO stockbridge.nf_dispensa'))?.[1] as unknown[] | undefined;

describe('dispensarNf — guardas', () => {
  it('flag desligada: RecebimentoFiscalDesabilitadoError antes de qualquer consulta', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = false;
    await expect(dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'x', ...gestor })).rejects.toBeInstanceOf(RecebimentoFiscalDesabilitadoError);
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(detalheMock).not.toHaveBeenCalled();
  });

  it('operador: DispensaNaoPermitidaError (defesa em profundidade alem do requireGestor)', async () => {
    await expect(dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'x', userId: USER, perfilUsuario: 'operador' })).rejects.toBeInstanceOf(DispensaNaoPermitidaError);
    expect(insertParams()).toBeUndefined();
  });

  it('motivo vazio/espacos: MotivoDispensaObrigatorioError com mensagem PROPRIA da dispensa (nao a da baixa externa)', async () => {
    await expect(dispensarNf({ nfChaveAcesso: CHAVE, motivo: '   ', ...gestor })).rejects.toBeInstanceOf(MotivoDispensaObrigatorioError);
    await expect(dispensarNf({ nfChaveAcesso: CHAVE, motivo: '', ...gestor })).rejects.toThrow('Informe o motivo da dispensa');
    expect(insertParams()).toBeUndefined();
  });

  it('so ledger em_andamento RECENTE bloqueia: a consulta limita pela janela do lock orfao (linha orfa nao trava a dispensa)', async () => {
    await dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'x', ...gestor });
    const q = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes("status = 'em_andamento'"))!;
    expect(String(q[0])).toContain('iniciado_em > now() - make_interval(mins => $2)');
    expect(q[1]).toEqual([CHAVE, LOCK_FISCAL_ORFAO_MIN]);
  });

  it('recebimento com fiscal em curso (ledger em_andamento): NfEmRecebimentoFiscalError, sem gravar nem avisar (ROT-3)', async () => {
    ledgerEmCurso = [{ nota_fiscal: '6842' }];
    await expect(dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'x', ...gestor })).rejects.toBeInstanceOf(NfEmRecebimentoFiscalError);
    expect(insertParams()).toBeUndefined();
    expect(detalheMock).not.toHaveBeenCalled();
    expect(emailSpy).not.toHaveBeenCalled();
  });

  it('NF sem item pendente (toda recebida): NfNaoDispensavelError com a mensagem do contrato', async () => {
    detalheMock.mockResolvedValue(detalhe({ itens: [item({ jaRecebido: true, quantidadeNfJaAtribuidaKg: 18000, quantidadeRestanteKg: 0 })] }));
    await expect(dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'carga nao veio', ...gestor })).rejects.toThrow(/NF 6842 já foi recebida no Atlas — não há o que dispensar/);
    await expect(dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'carga nao veio', ...gestor })).rejects.toBeInstanceOf(NfNaoDispensavelError);
    expect(insertParams()).toBeUndefined();
  });

  it('item baixado como externo nao conta como pendente; item parcialmente recebido (restante > 1 kg) conta', async () => {
    detalheMock.mockResolvedValue(detalhe({ itens: [item({ baixadoComoExterno: true })] }));
    await expect(dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'x', ...gestor })).rejects.toBeInstanceOf(NfNaoDispensavelError);

    detalheMock.mockResolvedValue(detalhe({ itens: [item({ jaRecebido: true, quantidadeNfJaAtribuidaKg: 6000, quantidadeRestanteKg: 12000 })] }));
    const r = await dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'restante nunca vira', ...gestor });
    expect(r.id).toBe(ID);
  });
});

describe('dispensarNf — gravacao (qualquer situacao fiscal — clarificacao 02/10/2026)', () => {
  it('NF com fiscal PENDENTE: grava situacao_fiscal_na_dispensa=pendente, motivo aparado, fornecedor e devolve o contrato §4', async () => {
    const r = await dispensarNf({ nfChaveAcesso: CHAVE, motivo: '  Carga nunca chegou  ', ...gestor });
    expect(r).toEqual({ id: ID, notaFiscal: '6842', fornecedorNome: 'REPLAS COMERCIAL LTDA', situacaoFiscalNaDispensa: 'pendente', dispensadoEm: new Date('2026-10-02 10:00:00+00').toISOString() });
    expect(insertParams()).toEqual([CHAVE, '6842', 'REPLAS COMERCIAL LTDA', '14.555.032/0007-53', 'pendente', 'Carga nunca chegou', USER]);
  });

  it('NF com fiscal JA FEITO e item pendente: aceita, com situacao_fiscal_na_dispensa=concluido', async () => {
    detalheMock.mockResolvedValue(detalhe({ fiscal: 'concluido', nIdReceb: 500 }));
    const r = await dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'fornecedor vai estornar', ...gestor });
    expect(r.situacaoFiscalNaDispensa).toBe('concluido');
    expect(insertParams()![4]).toBe('concluido');
  });

  it('fornecedor nao identificado (fonte b sem cadastro): CNPJ vazio vira NULL', async () => {
    detalheMock.mockResolvedValue(detalhe({ fornecedorNome: 'Fornecedor não identificado no OMIE', fornecedorCnpj: '' }));
    await dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'x', ...gestor });
    expect(insertParams()![3]).toBeNull();
  });

  it('segunda dispensa da mesma chave: NfJaDispensadaError (409) sem consultar o detalhe', async () => {
    dispensaAtivaRows = [{ id: 'd-antiga', nota_fiscal: '6842' }];
    await expect(dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'x', ...gestor })).rejects.toBeInstanceOf(NfJaDispensadaError);
    expect(detalheMock).not.toHaveBeenCalled();
    expect(insertParams()).toBeUndefined();
  });

  it('corrida entre dois gestores: 23505 no indice parcial vira NfJaDispensadaError', async () => {
    insertFalha = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'nf_dispensa_ativa_uq' });
    await expect(dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'x', ...gestor })).rejects.toBeInstanceOf(NfJaDispensadaError);
  });

  it('outro erro de banco propaga como esta', async () => {
    insertFalha = new Error('connection reset');
    await expect(dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'x', ...gestor })).rejects.toThrow('connection reset');
  });
});

describe('dispensarNf — aviso ao fiscal (FR-026, best-effort)', () => {
  it('envia o alerta com NF, fornecedor, situacao fiscal, valor, motivo e quem dispensou', async () => {
    await dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'Carga nunca chegou', ...gestor });
    await vi.waitFor(() => expect(emailSpy).toHaveBeenCalledTimes(1));
    expect(emailSpy.mock.calls[0]![0]).toEqual({
      notaFiscal: '6842',
      fornecedorNome: 'REPLAS COMERCIAL LTDA',
      situacaoFiscalNaDispensa: 'pendente',
      valorNfBrl: 210000, // valor da NF inteira (valorNotaBrl), nao so do recorte (SPEC016-7)
      motivo: 'Carga nunca chegou',
      dispensadoPorNome: 'Gestor Teste',
      dispensadoEm: new Date('2026-10-02 10:00:00+00').toISOString(),
    });
  });

  it('falha no e-mail nao desfaz nem propaga — a dispensa ja foi gravada', async () => {
    emailSpy.mockRejectedValue(new Error('smtp down'));
    const r = await dispensarNf({ nfChaveAcesso: CHAVE, motivo: 'x', ...gestor });
    expect(r.id).toBe(ID);
    await vi.waitFor(() => expect(emailSpy).toHaveBeenCalledTimes(1));
  });
});

describe('reverterDispensa', () => {
  it('gestor desfaz com motivo: UPDATE so em linha ATIVA (revertido_em IS NULL) e o fiscal e avisado (ROT-4)', async () => {
    reverterRows = [{ id: ID, nota_fiscal: '6842', fornecedor_nome: 'REPLAS COMERCIAL LTDA', situacao_fiscal_na_dispensa: 'pendente', revertido_em: '2026-10-03 09:00:00+00' }];
    const r = await reverterDispensa({ id: ID, motivo: 'lancada na nota errada', ...gestor });
    expect(r).toEqual({ id: ID, notaFiscal: '6842' });
    const upd = poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('UPDATE stockbridge.nf_dispensa'))!;
    expect(String(upd[0])).toContain('WHERE id = $1 AND revertido_em IS NULL');
    expect(String(upd[0])).not.toMatch(/DELETE/i);
    expect(upd[1]).toEqual([ID, USER, 'lancada na nota errada']);
    await vi.waitFor(() => expect(emailRevertidaSpy).toHaveBeenCalledTimes(1));
    expect(emailRevertidaSpy.mock.calls[0]![0]).toEqual({
      notaFiscal: '6842',
      fornecedorNome: 'REPLAS COMERCIAL LTDA',
      situacaoFiscalNaDispensa: 'pendente',
      motivoReversao: 'lancada na nota errada',
      revertidoPorNome: 'Gestor Teste',
      revertidoEm: new Date('2026-10-03 09:00:00+00').toISOString(),
    });
  });

  it('falha no aviso de reversao nao desfaz nada nem propaga', async () => {
    reverterRows = [{ id: ID, nota_fiscal: '6842', fornecedor_nome: null, situacao_fiscal_na_dispensa: 'concluido', revertido_em: '2026-10-03 09:00:00+00' }];
    emailRevertidaSpy.mockRejectedValue(new Error('smtp down'));
    await expect(reverterDispensa({ id: ID, motivo: 'x', ...gestor })).resolves.toEqual({ id: ID, notaFiscal: '6842' });
    await vi.waitFor(() => expect(emailRevertidaSpy).toHaveBeenCalledTimes(1));
  });

  it('inexistente ou ja revertida: DispensaNaoEncontradaError', async () => {
    reverterRows = [];
    await expect(reverterDispensa({ id: ID, motivo: 'x', ...gestor })).rejects.toBeInstanceOf(DispensaNaoEncontradaError);
  });

  it('exige motivo, gestor e flag', async () => {
    await expect(reverterDispensa({ id: ID, motivo: '', ...gestor })).rejects.toBeInstanceOf(MotivoDispensaObrigatorioError);
    await expect(reverterDispensa({ id: ID, motivo: '  ', ...gestor })).rejects.toThrow('Informe o motivo para desfazer a dispensa');
    await expect(reverterDispensa({ id: ID, motivo: 'x', userId: USER, perfilUsuario: 'operador' })).rejects.toBeInstanceOf(DispensaNaoPermitidaError);
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = false;
    await expect(reverterDispensa({ id: ID, motivo: 'x', ...gestor })).rejects.toBeInstanceOf(RecebimentoFiscalDesabilitadoError);
  });
});

describe('listarDispensas', () => {
  const linha = {
    id: ID, nf_chave_acesso: CHAVE, nota_fiscal: '6842', fornecedor_nome: 'REPLAS COMERCIAL LTDA', fornecedor_cnpj: '14.555.032/0007-53',
    situacao_fiscal_na_dispensa: 'concluido', motivo: 'fornecedor vai estornar', dispensado_por: USER, dispensado_por_nome: 'Gestor Teste',
    dispensado_em: '2026-10-02 10:00:00+00', revertido_por: null, revertido_por_nome: null, revertido_em: null, motivo_reversao: null,
  };

  it('por padrao so as ATIVAS; com incluirRevertidas traz todas; mapeia nomes via atlas.users', async () => {
    listaRows = [linha];
    const ativas = await listarDispensas();
    expect(String(poolQuerySpy.mock.calls.at(-1)![0])).toContain('WHERE d.revertido_em IS NULL');
    expect(ativas[0]).toMatchObject({
      id: ID, notaFiscal: '6842', situacaoFiscalNaDispensa: 'concluido', motivo: 'fornecedor vai estornar',
      dispensadoPor: { id: USER, nome: 'Gestor Teste' }, revertidoPor: null, revertidoEm: null, motivoReversao: null,
    });
    expect(ativas[0]!.dispensadoEm).toBe(new Date('2026-10-02 10:00:00+00').toISOString());

    listaRows = [{ ...linha, revertido_por: USER, revertido_por_nome: 'Gestor Teste', revertido_em: '2026-10-03 09:00:00+00', motivo_reversao: 'engano' }];
    const todas = await listarDispensas({ incluirRevertidas: true });
    expect(String(poolQuerySpy.mock.calls.at(-1)![0])).not.toContain('WHERE d.revertido_em IS NULL');
    expect(todas[0]!.revertidoPor).toEqual({ id: USER, nome: 'Gestor Teste' });
    expect(todas[0]!.motivoReversao).toBe('engano');
  });
});
