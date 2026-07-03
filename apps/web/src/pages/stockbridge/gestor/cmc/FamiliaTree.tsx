import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { CmcFamiliaNode } from './types.js';
import { fmtKg, fmtBrl, fmtCmc } from './format.js';

/**
 * Árvore de Custos por família → produto, estilo "pastas do Explorer" (FR-017):
 * famílias recolhidas por padrão; clicar expande/recolhe no lugar revelando os
 * produtos (PN × origem). Componente apresentacional (recebe as famílias prontas).
 */
export function FamiliaTree({ familias }: { familias: CmcFamiliaNode[] }) {
  // Multi-expansão: várias famílias podem ficar abertas ao mesmo tempo.
  const [abertas, setAbertas] = useState<Set<string>>(() => new Set());

  function toggle(familia: string) {
    setAbertas((prev) => {
      const next = new Set(prev);
      if (next.has(familia)) next.delete(familia);
      else next.add(familia);
      return next;
    });
  }

  return (
    <div className="overflow-x-auto bg-atlas-card border border-atlas-border rounded-lg">
      <table className="w-full text-xs">
        <thead className="bg-atlas-bg text-[10px] uppercase tracking-wide text-atlas-muted">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Família / Produto</th>
            <th className="text-left px-3 py-2 font-medium">Origem</th>
            <th className="text-right px-3 py-2 font-medium">CMC (R$/kg)</th>
            <th className="text-right px-3 py-2 font-medium">Volume (kg)</th>
            <th className="text-right px-3 py-2 font-medium">Valor (R$)</th>
          </tr>
        </thead>
        <tbody>
          {familias.map((f) => (
            <FamiliaRows
              key={f.descricaoFamilia}
              familia={f}
              aberta={abertas.has(f.descricaoFamilia)}
              onToggle={() => toggle(f.descricaoFamilia)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FamiliaRows({
  familia: f,
  aberta,
  onToggle,
}: {
  familia: CmcFamiliaNode;
  aberta: boolean;
  onToggle: () => void;
}) {
  const imp = f.porOrigem.importado;
  const nac = f.porOrigem.nacional;
  // Quebra Importado/Nacional (FR-004) como subtexto da família — só origens com volume.
  const partes: string[] = [];
  if (imp.volumeKg > 0) partes.push(`Importado ${fmtKg(imp.volumeKg)} kg`);
  if (nac.volumeKg > 0) partes.push(`Nacional ${fmtKg(nac.volumeKg)} kg`);

  return (
    <>
      <tr
        onClick={onToggle}
        className="border-t border-atlas-border cursor-pointer hover:bg-atlas-bg/60"
      >
        <td className="px-3 py-2">
          <button
            type="button"
            aria-expanded={aberta}
            aria-label={`${aberta ? 'Recolher' : 'Expandir'} família ${f.descricaoFamilia}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="flex items-center gap-1.5 text-left focus:outline-none focus:ring-2 focus:ring-acxe rounded"
          >
            {aberta ? (
              <ChevronDown className="w-3.5 h-3.5 text-atlas-muted shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-atlas-muted shrink-0" />
            )}
            <span>
              <span className="font-semibold text-atlas-ink">{f.descricaoFamilia}</span>
              {partes.length > 0 && (
                <span className="block text-[10px] text-atlas-muted">{partes.join(' · ')}</span>
              )}
            </span>
          </button>
        </td>
        <td className="px-3 py-2 text-atlas-muted">—</td>
        <td className="px-3 py-2 text-right font-mono text-atlas-ink">{fmtCmc(f.cmcPonderado)}</td>
        <td className="px-3 py-2 text-right font-mono text-atlas-ink">{fmtKg(f.volumeKg)}</td>
        <td className="px-3 py-2 text-right font-mono text-atlas-ink">{fmtBrl(f.valor)}</td>
      </tr>

      {aberta &&
        f.produtos.map((p) => (
          <tr
            key={`${f.descricaoFamilia}-${p.codigoProduto}-${p.origem}`}
            className="border-t border-atlas-border/60 bg-atlas-bg/40"
          >
            <td className="px-3 py-1.5 pl-9">
              <span className="text-atlas-ink">{p.descricaoProduto}</span>
              <span className="block text-[10px] font-mono text-atlas-muted">{p.codigoProduto}</span>
            </td>
            <td className="px-3 py-1.5">
              <OrigemBadge origem={p.origem} />
            </td>
            <td className="px-3 py-1.5 text-right font-mono text-atlas-ink">{fmtCmc(p.cmcPonderado)}</td>
            <td className="px-3 py-1.5 text-right font-mono text-atlas-ink">{fmtKg(p.volumeKg)}</td>
            <td className="px-3 py-1.5 text-right font-mono text-atlas-ink">{fmtBrl(p.valor)}</td>
          </tr>
        ))}
    </>
  );
}

function OrigemBadge({ origem }: { origem: 'IMPORTADO' | 'NACIONAL' }) {
  const isImp = origem === 'IMPORTADO';
  return (
    <span
      className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wider ${
        isImp ? 'bg-acxe/10 text-acxe' : 'bg-q2p/10 text-q2p'
      }`}
    >
      {isImp ? 'Importado' : 'Nacional'}
    </span>
  );
}
