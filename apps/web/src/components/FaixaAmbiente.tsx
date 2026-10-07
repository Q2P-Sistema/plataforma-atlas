import { useLayoutEffect } from 'react';
import { FlaskConical } from 'lucide-react';
import { useAmbiente, type AmbienteInfo } from '../hooks/useAmbiente.js';

// Altura da faixa — publicada em --atlas-faixa-ambiente, que os utilitários
// min-h-screen-app / top-banner (tailwind.config.ts) descontam (sem faixa, 0).
const ALTURA_FAIXA = '1.75rem';

const OMIE_TEXTO: Record<AmbienteInfo['omie_modo'], string> = {
  real: 'gravações no OMIE são reais',
  leitura: 'gravações no OMIE são simuladas',
  mock: 'OMIE simulado, sem consulta ao ERP',
};

const EMAIL_TEXTO: Partial<Record<AmbienteInfo['email'], string>> = {
  desviado: 'e-mails vão para a caixa de testes',
  suprimido: 'e-mails não são enviados',
};

/**
 * Faixa fixa no topo do UAT (ACXEGDP-405) para ninguém operar no ambiente
 * errado. Aparece também nas telas de login. Em produção não renderiza nada.
 */
export function FaixaAmbiente() {
  const { data } = useAmbiente();
  const ehUat = data?.nome === 'uat';

  // Layout effect: a variável entra no mesmo quadro da faixa (sem rolagem de 28 px).
  useLayoutEffect(() => {
    if (!ehUat) return;
    const root = document.documentElement;
    root.style.setProperty('--atlas-faixa-ambiente', ALTURA_FAIXA);
    return () => {
      root.style.removeProperty('--atlas-faixa-ambiente');
    };
  }, [ehUat]);

  if (!ehUat || !data) return null;

  const detalhes = [OMIE_TEXTO[data.omie_modo], EMAIL_TEXTO[data.email]].filter(Boolean).join(' · ');

  return (
    <div className="sticky top-0 z-50 h-7 flex items-center justify-center gap-2 px-4 bg-amber-500 text-amber-950 text-xs font-medium">
      <FlaskConical size={14} aria-hidden="true" className="shrink-0" />
      <span className="font-semibold uppercase tracking-wide whitespace-nowrap">Ambiente de testes</span>
      {detalhes && <span className="hidden sm:inline truncate">· {detalhes}</span>}
    </div>
  );
}
