import { useState, type FormEvent, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ThemeToggle } from '@atlas/ui';
import { useAuthStore } from '../stores/auth.store.js';
import { useAuth } from '../hooks/useAuth.js';

export function TwoFactorSetupPage() {
  const { user, isLoading } = useAuth({ requireAuth: true });
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [step, setStep] = useState<'loading' | 'scan' | 'confirm'>('loading');
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  async function initSetup() {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;

      const res = await fetch('/api/v1/auth/setup-2fa', {
        method: 'POST',
        credentials: 'include',
        headers,
      });

      const body = (await res.json()) as any;

      if (!res.ok) {
        setError(body.error?.message ?? 'Erro ao configurar 2FA');
        return;
      }

      setQrCodeDataUrl(body.data.qrCodeDataUrl);
      setSecret(body.data.secret);
      setStep('scan');
    } catch {
      setError('Erro de conexão com o servidor');
    }
  }

  // Auto-init on mount when user is loaded
  if (!isLoading && user && step === 'loading' && !qrCodeDataUrl && !error) {
    initSetup();
  }

  async function handleConfirm(e: FormEvent) {
    e.preventDefault();
    if (code.length !== 6) return;

    setError('');
    setSubmitting(true);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;

      const res = await fetch('/api/v1/auth/confirm-2fa', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ code }),
      });

      const body = (await res.json()) as any;

      if (!res.ok) {
        setError(body.error?.message ?? 'Código inválido');
        setCode('');
        return;
      }

      // 2FA is now enabled, redirect to dashboard
      navigate('/', { replace: true });
    } catch {
      setError('Erro de conexão com o servidor');
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading || step === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-atlas-bg">
        <p className="text-atlas-muted">Carregando...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-atlas-bg p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-md bg-atlas-card rounded-xl shadow-lg p-8 border border-atlas-border">
        <div className="text-center mb-6">
          <h1 className="font-heading text-2xl font-bold text-atlas-text">
            Configurar 2FA
          </h1>
          <p className="text-atlas-muted text-sm mt-2">
            Seu perfil requer autenticação em dois fatores.
          </p>
        </div>

        {step === 'scan' && (
          <div className="space-y-6">
            <div className="space-y-3">
              <p className="text-sm text-atlas-text font-medium">
                1. Abra seu aplicativo autenticador (Google Authenticator, Authy, etc.)
              </p>
              <p className="text-sm text-atlas-text font-medium">
                2. Escaneie o QR code abaixo:
              </p>
            </div>

            {qrCodeDataUrl && (
              <div className="flex justify-center">
                <img
                  src={qrCodeDataUrl}
                  alt="QR Code para configuração 2FA"
                  className="w-48 h-48 rounded-lg border border-atlas-border"
                />
              </div>
            )}

            <div className="bg-atlas-bg rounded-lg p-3 border border-atlas-border">
              <p className="text-xs text-atlas-muted mb-1">
                Ou digite o código manualmente:
              </p>
              <code className="text-sm font-mono text-atlas-text break-all select-all">
                {secret}
              </code>
            </div>

            <button
              onClick={() => setStep('confirm')}
              className="w-full py-2.5 rounded-lg bg-acxe text-white font-medium hover:bg-acxe/90 focus:outline-none focus:ring-2 focus:ring-acxe focus:ring-offset-2 transition-colors"
            >
              Próximo: Confirmar código
            </button>
          </div>
        )}

        {step === 'confirm' && (
          <form onSubmit={handleConfirm} className="space-y-6">
            <div className="space-y-3">
              <p className="text-sm text-atlas-text font-medium">
                3. Digite o código de 6 dígitos do aplicativo:
              </p>
            </div>

            <div>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                className="w-full px-4 py-3 text-center text-2xl font-mono tracking-[0.5em] rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text focus:outline-none focus:ring-2 focus:ring-acxe"
                placeholder="000000"
                autoFocus
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

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setStep('scan');
                  setError('');
                }}
                className="flex-1 py-2.5 rounded-lg border border-atlas-border text-atlas-text font-medium hover:bg-atlas-border/50 transition-colors"
              >
                Voltar
              </button>
              <button
                type="submit"
                disabled={submitting || code.length !== 6}
                className="flex-1 py-2.5 rounded-lg bg-acxe text-white font-medium hover:bg-acxe/90 focus:outline-none focus:ring-2 focus:ring-acxe focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? 'Verificando...' : 'Confirmar'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
