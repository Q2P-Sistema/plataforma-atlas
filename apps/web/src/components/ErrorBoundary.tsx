import { Component, type ReactNode } from 'react';
import { CloudAlert } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  traceId: string | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, traceId: null };
  }

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    const traceId = crypto.randomUUID();
    return { hasError: true, traceId };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', {
      traceId: this.state.traceId,
      error: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-atlas-bg p-4">
          <div className="w-full max-w-md bg-atlas-card rounded-xl shadow-lg p-8 border border-atlas-border text-center">
            <CloudAlert size={40} className="mx-auto mb-4 text-atlas-muted" aria-hidden />
            <h1 className="text-xl font-heading font-semibold text-atlas-text mb-2">
              Algo deu errado
            </h1>
            <p className="text-atlas-muted text-sm mb-4">
              Ocorreu um erro inesperado. Tente recarregar a página.
            </p>
            {this.state.traceId && (
              <p className="text-xs text-atlas-muted font-mono bg-atlas-bg rounded px-3 py-2 border border-atlas-border">
                Trace: {this.state.traceId}
              </p>
            )}
            <button
              onClick={() => {
                this.setState({ hasError: false, traceId: null });
                window.location.href = '/';
              }}
              className="mt-6 px-6 py-2.5 rounded-lg bg-acxe text-white font-medium hover:bg-acxe/90 transition-colors"
            >
              Recarregar
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
