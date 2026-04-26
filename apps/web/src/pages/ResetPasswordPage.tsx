import { useState, type FormEvent, type ChangeEvent } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ThemeToggle } from '@atlas/ui';

export function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  if (!token) {
    navigate('/login', { replace: true });
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Senha deve ter pelo menos 8 caracteres');
      return;
    }

    if (password !== confirmPassword) {
      setError('As senhas não coincidem');
      return;
    }

    setLoading(true);

    try {
      const res = await fetch('/api/v1/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      });

      const body = (await res.json()) as any;

      if (!res.ok) {
        setError(body.error?.message ?? 'Erro ao redefinir senha');
        return;
      }

      setSuccess(true);
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
            {success ? 'Senha alterada' : 'Nova senha'}
          </h1>
        </div>

        {success ? (
          <div className="space-y-4">
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg px-4 py-3 text-sm text-green-800 dark:text-green-300">
              Senha alterada com sucesso.
            </div>
            <Link
              to="/login"
              className="block w-full py-2.5 rounded-lg bg-acxe text-white font-medium text-center hover:bg-acxe/90 transition-colors"
            >
              Ir para login
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-atlas-text mb-1"
              >
                Nova senha
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={password}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text placeholder:text-atlas-muted focus:outline-none focus:ring-2 focus:ring-acxe"
                placeholder="Mínimo 8 caracteres"
              />
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="block text-sm font-medium text-atlas-text mb-1"
              >
                Confirmar senha
              </label>
              <input
                id="confirmPassword"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setConfirmPassword(e.target.value)
                }
                className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text placeholder:text-atlas-muted focus:outline-none focus:ring-2 focus:ring-acxe"
                placeholder="Repita a senha"
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
              {loading ? 'Salvando...' : 'Redefinir senha'}
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
