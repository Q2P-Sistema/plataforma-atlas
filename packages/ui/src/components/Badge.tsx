interface BadgeProps {
  variant: 'active' | 'inactive' | 'operador' | 'gestor' | 'diretor';
  children: React.ReactNode;
}

// Fonte única de cor por role/status (UI-B2, ACXEGDP-262) — páginas não devem
// reimplementar badge com cores próprias. active/inactive mantêm os pares
// green/red com shade por tema: texto no MESMO tom do fundo /10 (ex.
// text-success sobre bg-success/10) reprova WCAG AA (~3.3:1); estes pares
// medem ~8:1 nos dois temas.
const VARIANT_STYLES: Record<string, string> = {
  active: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  inactive: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  operador: 'bg-atlas-muted/20 text-atlas-muted',
  gestor: 'bg-acxe/10 text-acxe',
  diretor: 'bg-ndf/10 text-ndf',
};

export function Badge({ variant, children }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wider ${VARIANT_STYLES[variant] ?? VARIANT_STYLES.operador}`}
    >
      {children}
    </span>
  );
}
