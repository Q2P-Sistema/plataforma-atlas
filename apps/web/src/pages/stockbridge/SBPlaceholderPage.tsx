/**
 * Placeholder da Phase 2 (Foundational). Sera substituido por paginas reais
 * conforme as user stories US1-US8 forem implementadas.
 */
export function SBPlaceholderPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-serif text-atlas-ink mb-4">StockBridge</h1>
      <p className="text-atlas-muted">
        Módulo em desenvolvimento. A base técnica está concluída. Próximas etapas:
      </p>
      <ul className="list-disc list-inside mt-4 text-atlas-muted space-y-1">
        <li>Recebimento de NF com conferência física</li>
        <li>Cockpit de estoque por produto</li>
        <li>Aprovações hierárquicas</li>
        <li>Pipeline de trânsito marítimo</li>
        <li>Saídas automáticas via OMIE</li>
        <li>Saídas manuais, métricas e gestão</li>
      </ul>
    </div>
  );
}
