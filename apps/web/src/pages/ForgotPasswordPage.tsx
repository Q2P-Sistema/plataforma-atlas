import { useState, type FormEvent, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { ThemeToggle } from '@atlas/ui';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/v1/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const body = (await res.json()) as any;

      if (!res.ok) {
        setError(body.error?.message ?? 'Erro ao enviar');
        return;
      }

      setSubmitted(true);
    } catch {
      setError('Erro de conexão com o servidor');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-atlas-bg p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm bg-atlas-card rounded-xl shadow-lg p-8 border border-atlas-border">
        <div className="text-center mb-8">
          <h1 className="font-heading text-2xl font-bold text-atlas-text">
            Recuperar senha
          </h1>
          <p className="text-atlas-muted text-sm mt-2">
            {submitted
              ? 'Verifique seu e-mail'
              : 'Digite seu e-mail para receber o link de recuperação'}
          </p>
        </div>

        {submitted ? (
          <div className="space-y-4">
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg px-4 py-3 text-sm text-green-800 dark:text-green-300">
              Se o e-mail existir, um link de recuperação será enviado.
            </div>
            <Link
              to="/login"
              className="block text-center text-sm text-acxe hover:underline"
            >
              Voltar ao login
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-atlas-text mb-1"
              >
                E-mail
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text placeholder:text-atlas-muted focus:outline-none focus:ring-2 focus:ring-acxe"
                placeholder="seu@email.com.br"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="text-sm text-crit bg-crit/10 border border-crit/20 rounded-lg px-3 py-2"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg bg-acxe text-white font-medium hover:bg-acxe/90 focus:outline-none focus:ring-2 focus:ring-acxe focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Enviando...' : 'Enviar link de recuperação'}
            </button>

            <p className="text-center text-xs text-atlas-muted">
              <Link to="/login" className="hover:text-acxe underline">
                Voltar ao login
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
