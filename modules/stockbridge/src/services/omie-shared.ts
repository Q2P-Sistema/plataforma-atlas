/**
 * Helpers compartilhados de integração OMIE do StockBridge. STK-17 (ACXEGDP-267).
 */

/**
 * Formata uma data no padrão `dd/MM/yyyy` que a API OMIE espera (campo de data
 * dos ajustes/movimentações). Default = agora.
 *
 * Consolida 4 cópias idênticas que existiam nos serviços:
 *   - `dataAtualOmie()`  em omie-saida.service.ts
 *   - `formatarDataBR()` em operacoes-pendentes.service.ts
 *   - `formatarDataBR()` em recebimento.service.ts
 *   - IIFE inline        em aprovacao.service.ts (recebimento nacional)
 * Comportamento idêntico ao das cópias — todas usavam a data atual em dd/MM/yyyy.
 */
export function formatarDataOmie(d: Date = new Date()): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}
