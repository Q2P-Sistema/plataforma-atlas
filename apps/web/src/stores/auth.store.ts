import { create } from 'zustand';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'operador' | 'gestor' | 'diretor';
  totp_enabled: boolean;
  last_login_at: string | null;
  // Flag global AUTH_2FA_ENABLED vinda do backend (/me, login). Ausente => trata
  // como habilitado (default seguro). Desligada, o ProtectedShell nao forca o
  // setup de 2FA de gestor/diretor.
  two_factor_enforced?: boolean;
}

interface AuthState {
  user: AuthUser | null;
  csrfToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  setUser: (user: AuthUser, csrfToken?: string) => void;
  clearUser: () => void;
  setLoading: (loading: boolean) => void;

  login: (email: string, password: string) => Promise<{ requires2FA: boolean; tempToken?: string }>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  csrfToken: null,
  isAuthenticated: false,
  isLoading: true,

  setUser: (user, csrfToken) =>
    set({ user, csrfToken: csrfToken ?? get().csrfToken, isAuthenticated: true, isLoading: false }),

  clearUser: () =>
    set({ user: null, csrfToken: null, isAuthenticated: false, isLoading: false }),

  setLoading: (isLoading) => set({ isLoading }),

  login: async (email, password) => {
    const res = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });

    const body = (await res.json()) as any;

    if (!res.ok) {
      throw new Error(body.error?.message ?? 'Erro ao fazer login');
    }

    if (body.data.requires2FA) {
      return { requires2FA: true, tempToken: body.data.tempToken as string };
    }

    set({
      user: body.data.user,
      csrfToken: body.data.csrfToken,
      isAuthenticated: true,
      isLoading: false,
    });

    return { requires2FA: false };
  },

  logout: async () => {
    const { csrfToken } = get();
    try {
      await fetch('/api/v1/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
      });
    } finally {
      set({ user: null, csrfToken: null, isAuthenticated: false, isLoading: false });
    }
  },

  checkSession: async () => {
    set({ isLoading: true });
    try {
      const res = await fetch('/api/v1/auth/me', {
        credentials: 'include',
        // UAT 25/09/2026: sem isto, uma resposta 200 de HTML (fallback de SPA
        // do nginx numa janela de deploy) ficava no cache do navegador e o /me
        // seguinte lia o cache em vez da rede — sessao valida sendo tratada
        // como deslogada por ~1h30 apos todo redeploy.
        cache: 'no-store',
      });

      if (!res.ok) {
        set({ user: null, csrfToken: null, isAuthenticated: false, isLoading: false });
        return;
      }

      // Resposta 200 que nao e JSON (ex.: o mesmo fallback de SPA acima) nao e
      // "deslogado" -- e uma falha de infra. Tratar como sessao invalida
      // escondia o problema real atras de um redirect silencioso pro login.
      if (!res.headers.get('content-type')?.includes('application/json')) {
        throw new Error('Resposta inesperada do servidor ao verificar sessão');
      }

      const body = (await res.json()) as any;
      // SEG-07: restaura o csrfToken após F5 — /me passou a devolvê-lo. Sem
      // isso, o token se perdia no refresh e toda mutação falhava com 403.
      set({
        user: body.data,
        csrfToken: body.data?.csrfToken ?? get().csrfToken,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch {
      set({ user: null, csrfToken: null, isAuthenticated: false, isLoading: false });
    }
  },
}));
