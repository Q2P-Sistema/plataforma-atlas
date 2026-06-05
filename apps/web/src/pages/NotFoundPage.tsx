import { Link } from 'react-router-dom';
import { ThemeToggle } from '@atlas/ui';

export function NotFoundPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-atlas-bg p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="text-center">
        <p className="text-6xl font-heading font-bold text-atlas-muted mb-4">404</p>
        <h1 className="text-xl font-heading font-semibold text-atlas-text mb-2">
          Página não encontrada
        </h1>
        <p className="text-atlas-muted text-sm mb-6">
          A página que você procura não existe ou foi movida.
        </p>
        <Link
          to="/"
          className="inline-block px-6 py-2.5 rounded-lg bg-acxe text-white font-medium hover:bg-acxe/90 transition-colors"
        >
          Voltar ao inicio
        </Link>
      </div>
    </div>
  );
}
