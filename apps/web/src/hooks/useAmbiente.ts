import { useQuery } from '@tanstack/react-query';

/** Espelha GET /api/v1/ambiente (ACXEGDP-405). */
export interface AmbienteInfo {
  nome: 'prod' | 'uat' | 'dev';
  omie_modo: 'real' | 'leitura' | 'mock';
  email: 'normal' | 'log' | 'desviado' | 'suprimido';
}

export function useAmbiente() {
  return useQuery<AmbienteInfo | null>({
    queryKey: ['ambiente'],
    queryFn: async () => {
      const res = await fetch('/api/v1/ambiente');
      // 404 = API anterior à rota: sem faixa. Outros erros entram no retry.
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET /api/v1/ambiente: HTTP ${res.status}`);
      const body = (await res.json()) as { data?: AmbienteInfo };
      return body.data ?? null;
    },
    // Não muda sem novo deploy. Uma falha momentânea não pode esconder a faixa
    // do UAT pela sessão inteira — tenta de novo.
    staleTime: Infinity,
    retry: 3,
  });
}
