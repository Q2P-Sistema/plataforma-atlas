import { describe, it, expect } from 'vitest';
import { isSubtipoSaidaManual } from '../services/saida-manual.service.js';
import { NIVEL_APROVACAO_POR_SUBTIPO } from '../types.js';

describe('saida-manual#isSubtipoSaidaManual', () => {
  it('aceita os 6 subtipos validos', () => {
    const validos = ['transf_intra_cnpj', 'comodato', 'amostra', 'descarte', 'quebra', 'inventario_menos'];
    for (const s of validos) {
      expect(isSubtipoSaidaManual(s)).toBe(true);
    }
  });

  it('rejeita subtipos de entrada ou invalidos', () => {
    expect(isSubtipoSaidaManual('importacao')).toBe(false);
    expect(isSubtipoSaidaManual('venda')).toBe(false);
    expect(isSubtipoSaidaManual('regularizacao_fiscal')).toBe(false);
    expect(isSubtipoSaidaManual('inexistente')).toBe(false);
  });
});

describe('NIVEL_APROVACAO_POR_SUBTIPO — regras de autoridade', () => {
  it('comodato exige diretor', () => {
    expect(NIVEL_APROVACAO_POR_SUBTIPO.comodato).toBe('diretor');
  });

  it('saidas normais exigem gestor', () => {
    expect(NIVEL_APROVACAO_POR_SUBTIPO.transf_intra_cnpj).toBe('gestor');
    expect(NIVEL_APROVACAO_POR_SUBTIPO.amostra).toBe('gestor');
    expect(NIVEL_APROVACAO_POR_SUBTIPO.descarte).toBe('gestor');
    expect(NIVEL_APROVACAO_POR_SUBTIPO.quebra).toBe('gestor');
    expect(NIVEL_APROVACAO_POR_SUBTIPO.inventario_menos).toBe('gestor');
  });
});
