import { Modal } from '@atlas/ui';

interface Props {
  onClose: () => void;
}

/**
 * Modal de drill-down de divergencias.
 * v1: placeholder ate US3 expor endpoint `/divergencias` com agrupamento
 * por familia/NCM/status. Por enquanto o cockpit ja expoe contagens por SKU.
 */
export function ModalDivergencias({ onClose }: Props) {
  return (
    <Modal open title="Divergências" onClose={onClose}>
      <div className="space-y-3 py-2">
        <p className="text-sm text-atlas-muted">
          A lista detalhada de divergências será exposta quando o endpoint
          <code className="mx-1 px-1 bg-slate-100 dark:bg-slate-800 rounded">GET /divergencias</code>
          for implementado em US3 (Aprovações Hierárquicas).
        </p>
        <p className="text-sm text-atlas-muted">
          Por enquanto, use o badge "N div" em cada card de SKU para identificar
          produtos com divergência aberta.
        </p>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-atlas-btn-bg text-atlas-btn-text rounded text-sm font-medium"
          >
            Entendi
          </button>
        </div>
      </div>
    </Modal>
  );
}
