import { useEffect, useState } from 'react';

export interface CountdownProps {
  semana: number | null;
  label: string;
  icon: string;
  sub?: string;
}

export function Countdown({ semana, label, icon, sub }: CountdownProps) {
  const [count, setCount] = useState(0);
  const dias = semana ? semana * 7 : null;

  useEffect(() => {
    if (!dias) return;
    let i = 0;
    const t = setInterval(() => {
      i += 2;
      setCount(Math.min(i, dias));
      if (i >= dias) clearInterval(t);
    }, 15);
    return () => clearInterval(t);
  }, [dias]);

  if (!semana) {
    return (
      <div className="flex-1 bg-atlas-card border border-green-500/30 rounded-xl p-5 text-center">
        <div className="text-2xl mb-1" aria-hidden>✅</div>
        <div className="text-xs text-green-600 dark:text-green-400 font-semibold uppercase tracking-wider">{label}</div>
        <div className="text-xs text-atlas-muted mt-1">Sem risco nos 180 dias</div>
      </div>
    );
  }

  const urgency =
    dias! <= 30
      ? 'border-red-500/40 text-red-600 dark:text-red-400 bg-red-500/5 shadow-red-500/20'
      : dias! <= 60
        ? 'border-orange-500/40 text-orange-600 dark:text-orange-400 bg-orange-500/5'
        : dias! <= 90
          ? 'border-amber-500/40 text-amber-600 dark:text-amber-400 bg-amber-500/5'
          : 'border-teal-500/40 text-teal-600 dark:text-teal-400 bg-teal-500/5';

  return (
    <div
      className={`flex-1 border rounded-xl p-5 text-center ${urgency} ${dias! <= 30 ? 'shadow-lg' : ''}`}
      role="status"
      aria-label={`${label}: ${dias} dias restantes`}
    >
      <div className="text-2xl mb-1" aria-hidden>{icon}</div>
      <div className="text-xs uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-3xl font-bold tabular-nums my-1">{count}</div>
      <div className="text-xs font-semibold">dias restantes</div>
      {sub && (
        <div className="text-xs mt-2 font-semibold opacity-80">
          Sem {semana} · {sub}
        </div>
      )}
    </div>
  );
}
