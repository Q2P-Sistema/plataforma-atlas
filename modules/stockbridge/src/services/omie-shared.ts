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

/**
 * Fragmento SQL de filtro por empresa sobre vw_posicaoEstoqueUnificadaFamilia
 * (alias obrigatório `o`). Consolida 2 cópias byte-idênticas (STK-17,
 * ACXEGDP-267): saida-manual.service.ts e o inline de
 * consultarValorUnitarioProduto em aprovacao.service.ts.
 *
 * Regra: ACXE só enxerga sub-estoques espelhados (.1); Q2P enxerga espelhados
 * (.1) e nacionais (.2).
 *
 * ATENÇÃO: string interpolada via sql.raw() — mantenha livre de input do
 * usuário (o parâmetro é um union type fechado).
 */
export function filtroEmpresaOmie(empresa: 'acxe' | 'q2p'): string {
  return empresa === 'acxe'
    ? `(o.codigo_estoque LIKE '%.1' AND o.empresa = 'ACXE')`
    : `((o.codigo_estoque LIKE '%.1' OR o.codigo_estoque LIKE '%.2') AND o.empresa = 'Q2P')`;
}
