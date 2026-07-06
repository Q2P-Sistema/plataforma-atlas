import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Largura máxima do card (UI-D, ACXEGDP-264). Default 'md' — compatível
   * com os usos existentes. Modais de formulário maiores usam 'xl'.
   */
  maxWidth?: 'md' | 'lg' | 'xl' | '2xl';
}

const MAX_WIDTH_CLASS: Record<NonNullable<ModalProps['maxWidth']>, string> = {
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
};

export function Modal({ open, onClose, title, children, footer, maxWidth = 'md' }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      dialog.showModal();
    } else {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-50 m-0 h-full w-full max-h-full max-w-full bg-transparent p-0 backdrop:bg-black/50"
      onClick={(e) => {
        if (contentRef.current && !contentRef.current.contains(e.target as Node)) {
          onClose();
        }
      }}
    >
      <div className="flex items-center justify-center min-h-full p-4">
        <div
          ref={contentRef}
          className={`w-full ${MAX_WIDTH_CLASS[maxWidth]} max-h-[90vh] overflow-y-auto bg-atlas-card rounded-xl shadow-xl border border-atlas-border`}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-atlas-border">
            <h2 className="text-lg font-heading font-semibold text-atlas-text">
              {title}
            </h2>
            <button
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-atlas-border focus:outline-none focus:ring-2 focus:ring-acxe transition-colors text-atlas-muted"
              aria-label="Fechar"
            >
              <X size={18} />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-4">{children}</div>

          {/* Footer */}
          {footer && (
            <div className="px-6 py-4 border-t border-atlas-border flex justify-end gap-3">
              {footer}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
