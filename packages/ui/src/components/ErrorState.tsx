import { AlertTriangle } from 'lucide-react';

interface ErrorStateProps {
  /** Detalhe técnico opcional (ex.: message do Error). */
  message?: string;
  /** Callback do botão "Tentar novamente" (ex.: refetch da query). */
  retry?: () => void;
}

/**
 * Estado de erro padrão para falha de carregamento (UI-E, ACXEGDP-265).
 * Antes cada página tratava (ou não tratava) erro do seu jeito — algumas
 * ficavam presas no skeleton para sempre quando a query falhava.
 */
export function ErrorState({ message, retry }: ErrorStateProps) {
  return (
    <div className="p-8 text-center border border-crit/30 bg-crit/5 rounded-lg">
      <AlertTriangle size={20} className="mx-auto mb-2 text-crit" aria-hidden />
      <p className="text-sm text-atlas-ink mb-1">Não foi possível carregar os dados.</p>
      {message && <p className="text-xs text-atlas-muted mb-3">{message}</p>}
      {retry && (
        <button
          onClick={retry}
          className="text-xs px-3 py-1.5 rounded border border-atlas-border hover:bg-atlas-bg/60 transition-colors"
        >
          Tentar novamente
        </button>
      )}
    </div>
  );
}
