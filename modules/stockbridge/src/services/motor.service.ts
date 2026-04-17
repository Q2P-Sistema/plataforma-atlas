import { FATOR_PARA_TONELADA, type UnidadeMedida } from '../types.js';

/**
 * Converte uma quantidade em unidade arbitraria para toneladas.
 * Preserva sinal (valores negativos para saidas).
 */
export function converterParaToneladas(quantidade: number, unidade: UnidadeMedida): number {
  return quantidade * FATOR_PARA_TONELADA[unidade];
}

const UNIDADE_LABEL: Record<UnidadeMedida, string> = {
  t: 't',
  kg: 'kg',
  saco: 'saco',
  bigbag: 'big bag',
};

/**
 * Formata quantidade + unidade para exibicao (pt-BR).
 */
export function fmtQtdUnidade(quantidade: number, unidade: UnidadeMedida): string {
  const formatado = quantidade.toLocaleString('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
  return `${formatado} ${UNIDADE_LABEL[unidade]}`;
}

export type Criticidade = 'critico' | 'alerta' | 'ok' | 'excesso';

const LEAD_TIME_DEFAULT_DIAS = 60;

/**
 * Calcula cobertura de estoque em dias.
 * saldo / consumoMedioDiario, arredondado para inteiro.
 * Retorna null se consumo nao configurado (sem base para dividir).
 */
export function calcularCobertura(saldoFisicoT: number, consumoMedioDiarioT: number | null): number | null {
  if (consumoMedioDiarioT == null || consumoMedioDiarioT <= 0) return null;
  return Math.round(saldoFisicoT / consumoMedioDiarioT);
}

/**
 * Classifica criticidade do SKU segundo regras do FR-005:
 *   critico  — cobertura < 50% do lead time
 *   alerta   — cobertura entre 50% e 120% do lead time
 *   ok       — cobertura entre 120% e 400% do lead time
 *   excesso  — saldo fisico > consumo * lead time * 4 (sobra > 4x)
 *
 * Quando nao e possivel calcular (sem consumo ou sem lead time), retorna 'ok'.
 */
export function classificarCriticidade(
  cobertura: number | null,
  leadTimeDias: number | null,
  saldoFisicoT: number,
  consumoMedioDiarioT: number | null,
): Criticidade {
  if (consumoMedioDiarioT == null || consumoMedioDiarioT <= 0) return 'ok';
  const lt = leadTimeDias ?? LEAD_TIME_DEFAULT_DIAS;
  const cob = cobertura ?? calcularCobertura(saldoFisicoT, consumoMedioDiarioT);
  if (cob == null) return 'ok';

  if (saldoFisicoT > consumoMedioDiarioT * lt * 4) return 'excesso';
  if (cob < lt * 0.5) return 'critico';
  if (cob < lt * 1.2) return 'alerta';
  return 'ok';
}
