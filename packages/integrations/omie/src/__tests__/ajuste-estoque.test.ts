import { describe, it, expect, vi, beforeEach } from 'vitest';

// Recuperação do erro 1035 ("Já existe um ajuste de estoque para o codigo de
// integracao [X]") em incluirAjusteEstoque. Este caminho é load-bearing para a
// idempotência do StockBridge (STK-01, ACXEGDP-281): com opId determinístico,
// duas chamadas concorrentes geram o mesmo cod_int_ajuste e a segunda DEVE
// herdar os IDs da primeira em vez de duplicar o ajuste no ERP.

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const callOmieSpy = vi.fn();
vi.mock('../client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../client.js')>();
  return {
    ...real,
    callOmie: (...args: unknown[]) => callOmieSpy(...args),
    isMockMode: () => false, // força o caminho real (o mock interno tem idempotência própria)
  };
});

const listarSpy = vi.fn();
vi.mock('../stockbridge/listar-ajuste-estoque.js', () => ({
  listarAjusteEstoque: (...args: unknown[]) => listarSpy(...args),
}));

import { OmieApiError } from '../client.js';
import { incluirAjusteEstoque } from '../stockbridge/ajuste-estoque.js';

const inputBase = {
  codigoLocalEstoque: '4498926337',
  idProduto: 1001,
  dataAtual: '20/04/2026',
  quantidade: 25_000,
  observacao: 'NF 12345',
  origem: 'AJU' as const,
  tipo: 'TRF' as const,
  motivo: 'TRF' as const,
  valor: 1.25,
  codIntAjuste: 'op-abc:acxe-trf',
};

function erro1035(mensagem: string): OmieApiError {
  return new OmieApiError('acxe', 'estoque/ajuste/', 'IncluirAjusteEstoque', 500, 'SOAP-ENV:Client-1035', mensagem);
}

describe('incluirAjusteEstoque — recuperação de 1035 (idempotência)', () => {
  beforeEach(() => {
    callOmieSpy.mockReset();
    listarSpy.mockReset();
  });

  it('1035 → recupera IDs reais via ListarAjusteEstoque (não propaga o erro)', async () => {
    callOmieSpy.mockRejectedValue(erro1035('Já existe um ajuste de estoque para o codigo de integracao [op-abc:acxe-trf] com o ID [987654]'));
    listarSpy.mockResolvedValue({
      pagina: 1, totalDePaginas: 1, registros: 1, totalDeRegistros: 1,
      ajustes: [{
        idMovest: 'M-EXISTENTE',
        idAjuste: 'A-EXISTENTE',
        codIntAjuste: 'op-abc:acxe-trf',
        dataMovimento: '20/04/2026',
        codigoLocalEstoque: '4498926337',
        idProduto: 1001,
        quantidade: 25_000,
        valor: 1.25,
        observacao: '',
      }],
    });

    const res = await incluirAjusteEstoque('acxe', inputBase);

    expect(res.idMovest).toBe('M-EXISTENTE');
    expect(res.idAjuste).toBe('A-EXISTENTE');
    expect(res.descricaoStatus).toBe('recuperado-por-idempotencia');
    expect(listarSpy).toHaveBeenCalledWith('acxe', expect.objectContaining({ codIntAjuste: 'op-abc:acxe-trf' }));
  });

  it('1035 + listar vazio → fallback regex extrai idMovest da faultstring', async () => {
    callOmieSpy.mockRejectedValue(erro1035('Já existe um ajuste de estoque para o codigo de integracao [op-abc:acxe-trf] com o ID [987654]'));
    listarSpy.mockResolvedValue({
      pagina: 1, totalDePaginas: 1, registros: 0, totalDeRegistros: 0, ajustes: [],
    });

    const res = await incluirAjusteEstoque('acxe', inputBase);

    expect(res.idMovest).toBe('987654');
    expect(res.idAjuste).toBe('op-abc:acxe-trf'); // placeholder documentado
    expect(res.descricaoStatus).toBe('recuperado-por-idempotencia-regex');
  });

  it('1035 + listar FALHA (não só vazio) → ainda cai no fallback regex', async () => {
    callOmieSpy.mockRejectedValue(erro1035('Já existe um ajuste de estoque para o codigo de integracao [op-abc:acxe-trf] com o ID [111222]'));
    listarSpy.mockRejectedValue(new Error('OMIE listar 503'));

    const res = await incluirAjusteEstoque('acxe', inputBase);

    expect(res.idMovest).toBe('111222');
    expect(res.descricaoStatus).toBe('recuperado-por-idempotencia-regex');
  });

  it('erro que NÃO é 1035 propaga sem tocar no listar', async () => {
    const erroReal = new OmieApiError('acxe', 'estoque/ajuste/', 'IncluirAjusteEstoque', 500, 'SOAP-ENV:Client-500', 'Produto inexistente');
    callOmieSpy.mockRejectedValue(erroReal);

    await expect(incluirAjusteEstoque('acxe', inputBase)).rejects.toThrow('Produto inexistente');
    expect(listarSpy).not.toHaveBeenCalled();
  });

  it('sem codIntAjuste no input, 1035 propaga (não há chave pra recuperar)', async () => {
    callOmieSpy.mockRejectedValue(erro1035('Já existe um ajuste de estoque para o codigo de integracao [x] com o ID [42]'));
    const { codIntAjuste: _omitido, ...semCodInt } = inputBase;

    await expect(incluirAjusteEstoque('acxe', semCodInt)).rejects.toThrow(/Já existe um ajuste/);
    expect(listarSpy).not.toHaveBeenCalled();
  });

  it('detecta 1035 também pela mensagem quando omieCode vem diferente', async () => {
    // OMIE nem sempre devolve o code estruturado — o detector aceita match na faultstring.
    const erroSoMensagem = new OmieApiError('acxe', 'estoque/ajuste/', 'IncluirAjusteEstoque', 500, null, 'Já existe um ajuste de estoque para o codigo de integracao [op-abc:acxe-trf] com o ID [555]');
    callOmieSpy.mockRejectedValue(erroSoMensagem);
    listarSpy.mockResolvedValue({ pagina: 1, totalDePaginas: 1, registros: 0, totalDeRegistros: 0, ajustes: [] });

    const res = await incluirAjusteEstoque('acxe', inputBase);
    expect(res.idMovest).toBe('555');
  });
});
