import type { ReactNode } from 'react';

/**
 * Estado vazio padrão (UI-E, ACXEGDP-265) — o padrão visual que o StockBridge
 * já usava (p-12, centralizado, borda tracejada), agora como componente único
 * para todos os módulos.
 */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-atlas-border rounded-lg">
      {children}
    </div>
  );
}
