/**
 * Placeholder da Phase 2 (Foundational). Sera substituido por paginas reais
 * conforme as user stories US1-US8 forem implementadas.
 */
export function SBPlaceholderPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-serif text-atlas-ink mb-4">StockBridge</h1>
      <p className="text-atlas-muted">
        Modulo em desenvolvimento. Phase 2 (Foundational) concluida. Proximas fases:
      </p>
      <ul className="list-disc list-inside mt-4 text-atlas-muted space-y-1">
        <li>US1 — Recebimento de NF com conferencia fisica (P1)</li>
        <li>US2 — Cockpit de estoque por produto (P1)</li>
        <li>US3 — Aprovacoes hierarquicas (P2)</li>
        <li>US4 — Pipeline de transito maritimo (P2)</li>
        <li>US5 — Saidas automaticas via OMIE (P2)</li>
        <li>US6-US8 — Saidas manuais, metricas, gestao (P3)</li>
      </ul>
    </div>
  );
}
