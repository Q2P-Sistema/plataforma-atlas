import { useState, useRef, useEffect } from 'react';
import { ChevronDown, X } from 'lucide-react';

export interface MultiSelectOption {
  value: string;
  label: string;
}

/**
 * Combo box com multi-seleção (US3) — checkboxes + busca + click-outside.
 * Espelha o padrão do CockpitPage, extraído para reuso pelas duas abas do CMC.
 */
export function MultiSelectCombo({
  label,
  allLabel,
  options,
  selected,
  onChange,
  title,
}: {
  label: string;
  allLabel: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (v: string[]) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busca, setBusca] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (v: string) => {
    if (selected.includes(v)) onChange(selected.filter((s) => s !== v));
    else onChange([...selected, v]);
  };

  const filtradas = busca
    ? options.filter((o) => o.label.toLowerCase().includes(busca.toLowerCase()))
    : options;

  const triggerLabel =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${label}: ${selected.length} selecionados`;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-xs flex items-center gap-2 hover:border-slate-400 dark:hover:border-slate-500 transition"
      >
        <span className={selected.length > 0 ? 'text-atlas-ink' : 'text-atlas-muted'}>{triggerLabel}</span>
        {selected.length > 0 && (
          <span
            role="button"
            aria-label={`Limpar ${label}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
            className="text-atlas-muted hover:text-atlas-ink"
          >
            <X size={12} />
          </span>
        )}
        <ChevronDown size={12} className="text-atlas-muted" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 min-w-[240px] max-h-[340px] overflow-y-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg text-xs">
          <div className="p-2 border-b border-slate-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800">
            <input
              type="text"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={`Buscar ${label.toLowerCase()}...`}
              className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-xs focus:outline-none focus:ring-1 focus:ring-acxe"
            />
          </div>
          {filtradas.length === 0 ? (
            <div className="px-3 py-2 text-atlas-muted">Sem opções disponíveis</div>
          ) : (
            <>
              {filtradas.map((opt) => {
                const checked = selected.includes(opt.value);
                return (
                  <label
                    key={opt.value}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-700/50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(opt.value)}
                      className="w-3.5 h-3.5 accent-atlas-ink"
                    />
                    <span className={checked ? 'text-atlas-ink' : 'text-atlas-muted'}>{opt.label}</span>
                  </label>
                );
              })}
              {selected.length > 0 && (
                <div className="border-t border-slate-200 dark:border-slate-700 px-3 py-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => onChange([])}
                    className="text-[11px] text-atlas-muted hover:text-atlas-ink"
                  >
                    Limpar seleção
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
