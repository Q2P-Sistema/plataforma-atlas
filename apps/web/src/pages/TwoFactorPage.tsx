import { useState, useRef, type FormEvent, type ChangeEvent, type KeyboardEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ThemeToggle } from '@atlas/ui';
import { useAuthStore } from '../stores/auth.store.js';

const CODE_LENGTH = 6;

export function TwoFactorPage() {
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const navigate = useNavigate();
  const location = useLocation();
  const setUser = useAuthStore((s) => s.setUser);

  const tempToken = (location.state as any)?.tempToken;

  if (!tempToken) {
    navigate('/login', { replace: true });
    return null;
  }

  const code = digits.join('');

  function handleChange(index: number, value: string) {
    if (!/^\d*$/.test(value)) return;

    const newDigits = [...digits];
    newDigits[index] = value.slice(-1);
    setDigits(newDigits);

    if (value && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  function handleKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, CODE_LENGTH);
    if (!pasted) return;

    const newDigits = Array(CODE_LENGTH).fill('');
    for (let i = 0; i < pasted.length; i++) {
      newDigits[i] = pasted[i]!;
    }
    setDigits(newDigits);

    const focusIndex = Math.min(pasted.length, CODE_LENGTH - 1);
    inputRefs.current[focusIndex]?.focus();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (code.length !== CODE_LENGTH) return;

    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/v1/auth/verify-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tempToken, code }),
      });

      const body = (await res.json()) as any;

      if (!res.ok) {
        setError(body.error?.message ?? 'Código inválido');
        setDigits(Array(CODE_LENGTH).fill(''));
        inputRefs.current[0]?.focus();
        return;
      }

      setUser(body.data.user, body.data.csrfToken);
      navigate('/', { replace: true });
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
            Verificação 2FA
          </h1>
          <p className="text-atlas-muted text-sm mt-2">
            Digite o código de 6 dígitos do seu aplicativo autenticador.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="flex justify-center gap-2" onPaste={handlePaste}>
            {digits.map((digit, i) => (
              <input
                key={i}
                ref={(el) => { inputRefs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e: ChangeEvent<HTMLInputElement>) => handleChange(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                className="w-11 h-13 text-center text-xl font-mono rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text focus:outline-none focus:ring-2 focus:ring-acxe"
                autoFocus={i === 0}
                aria-label={`Dígito ${i + 1}`}
              />
            ))}
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
            disabled={loading || code.length !== CODE_LENGTH}
            className="w-full py-2.5 rounded-lg bg-acxe text-white font-medium hover:bg-acxe/90 focus:outline-none focus:ring-2 focus:ring-acxe focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Verificando...' : 'Verificar'}
          </button>
        </form>

        <p className="text-center text-xs text-atlas-muted mt-6">
          <button
            onClick={() => navigate('/login', { replace: true })}
            className="hover:text-acxe underline"
          >
            Voltar ao login
          </button>
        </p>
      </div>
    </div>
  );
}
