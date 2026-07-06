import { create } from 'zustand';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'operador' | 'gestor' | 'diretor';
  totp_enabled: boolean;
  last_login_at: string | null;
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
      });

      if (!res.ok) {
        set({ user: null, csrfToken: null, isAuthenticated: false, isLoading: false });
        return;
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
