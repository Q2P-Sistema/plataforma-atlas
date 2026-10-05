interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_MAP = {
  sm: 'w-4 h-4',
  md: 'w-8 h-8',
  lg: 'w-12 h-12',
};

export function LoadingSpinner({ size = 'md', className = '' }: LoadingSpinnerProps) {
  return (
    <div
      className={`${SIZE_MAP[size]} animate-spin rounded-full border-2 border-atlas-border border-t-acxe ${className}`}
      role="status"
      aria-label="Carregando"
    >
      <span className="sr-only">Carregando...</span>
    </div>
  );
}

export function LoadingPage() {
  return (
    <div className="min-h-screen-app flex items-center justify-center bg-atlas-bg">
      <LoadingSpinner size="lg" />
    </div>
  );
}
