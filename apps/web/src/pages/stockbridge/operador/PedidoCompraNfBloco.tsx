import { useId } from 'react';
import {
  JUSTIFICATIVA_MAX,
  RADIO_CLS,
  SELO_AMBAR,
  SELO_NEUTRO,
  SELO_VERDE,
  TITLE_EM_CACHE,
  TITLE_FORA_TOLERANCIA,
  fmtCnpj,
  mesmoPc,
  pcEscolhaEfetiva,
  pcJustificativaNecessaria,
  rotuloPc,
  textoMotivosJustificativa,
  titleOutroCadastro,
  type PcDaNf,
  type PcDaNfItem,
  type PcDoItem,
  type PcJustificativaInfo,
  type PcRef,
  type PcsDaNf,
  type Selo,
} from './PedidoCompraBloco.js';

/**
 * PC por NF (22/10/2026) — bloco "Pedido de compra da nota".
 *
 * Na NF 60199 (4 itens, o mesmo PC 306) o operador confirmava o pedido 3 vezes e justificava 3 vezes. Agora o servidor
 * manda, em `pcsDaNf`, os PCs que atendem a nota com a atribuicao item da NF -> item do PC, e o operador escolhe UMA vez.
 *
 * A escolha da nota nao e um estado novo: ela e expandida em `pcEscolha` de cada item coberto (o POST continua por item,
 * `itens[].pc`), e o radio da nota aparece marcado quando TODOS os itens cobertos de um PC tem como escolha efetiva a
 * atribuicao daquele PC (`pcDaNfEscolhido`). Assim a nota e os itens nao divergem: trocar o PC de um item desmarca a nota.
 *
 * Regra de tela (ACXEGDP-313): o PC aparece so pelo numero legivel ("PC 306"); `nCodPed`/`nCodItem` so identificam a opcao.
 */

// ── Decisao (funcoes puras) ─────────────────────────────────────────────────

/** O que a nota precisa saber de cada item a receber com PC. */
export interface PcNfItemEstado {
  /** `ItemNf.indice` */
  indice: number;
  pc: PcDoItem;
  /**
   * Escolha do formulario, ja resolvida com a pre-selecao da nota: `undefined` = o operador nao mexeu e a nota nao tem
   * pre-selecao para o item (vale a pre-selecao do proprio item, em `pcEscolhaEfetiva`).
   */
  escolhaForm: PcRef | null | undefined;
}

/** O item de PC que a atribuicao da nota escolhe para o item da NF. */
export function pcRefDaAtribuicao(pc: PcDaNf, a: PcDaNfItem): PcRef {
  return { nCodPed: pc.nCodPed, nCodItem: a.nCodItem };
}

/** Atribuicoes que valem para a nota atual: so itens que estao a receber e tem bloco de PC. */
function atribuicoesVigentes(pc: PcDaNf, indices: Set<number>): PcDaNfItem[] {
  return (pc.itens ?? []).filter((a) => indices.has(a.indice));
}

/**
 * Pre-selecao do servidor para a nota inteira: indice do item -> item de PC. Aplica-se so aos itens em que o operador
 * ainda nao mexeu (`pcEscolha === undefined`, a mesma regra da pre-selecao do item).
 */
export function preSelecaoDaNf(pcsDaNf: PcsDaNf | null | undefined): Map<number, PcRef> {
  const out = new Map<number, PcRef>();
  const alvo = pcsDaNf?.preSelecionado;
  if (alvo == null) return out;
  const pc = (pcsDaNf?.pcs ?? []).find((p) => p.nCodPed === alvo);
  if (!pc) return out;
  for (const a of pc.itens ?? []) out.set(a.indice, pcRefDaAtribuicao(pc, a));
  return out;
}

/**
 * PC marcado na nota: o primeiro, na ordem do servidor, cujas atribuicoes sao TODAS a escolha efetiva do item.
 * Estado derivado das escolhas por item — nao ha estado paralelo da nota.
 */
export function pcDaNfEscolhido(pcs: PcDaNf[], itens: PcNfItemEstado[]): PcDaNf | null {
  const porIndice = new Map(itens.map((i) => [i.indice, i]));
  const indices = new Set(porIndice.keys());
  for (const p of pcs) {
    const alvo = atribuicoesVigentes(p, indices);
    if (alvo.length === 0) continue;
    const todos = alvo.every((a) => {
      const it = porIndice.get(a.indice);
      return it != null && mesmoPc(pcEscolhaEfetiva(it.pc, it.escolhaForm), pcRefDaAtribuicao(p, a));
    });
    if (todos) return p;
  }
  return null;
}

/** A escolha da nota expandida em escolhas por item (so os itens a receber que a nota conhece). */
export function escolhasDoPcDaNf(pc: PcDaNf, indices: Set<number>): Array<{ indice: number; ref: PcRef }> {
  return atribuicoesVigentes(pc, indices).map((a) => ({ indice: a.indice, ref: pcRefDaAtribuicao(pc, a) }));
}

/**
 * Justificativa UNICA da nota: obrigatoria quando o servidor a exige para o PC (`justificativaNecessaria`) ou quando a regra
 * por item (`pcJustificativaNecessaria`) a exige em algum item coberto. Os motivos somam os de todos os itens.
 */
export function pcJustificativaDaNota(escolhido: PcDaNf | null, itens: PcNfItemEstado[]): PcJustificativaInfo {
  const info: PcJustificativaInfo = { obrigatoria: false, foraDaTolerancia: false, naoComparado: false, trocaDoVinculo: false };
  if (!escolhido) return info;
  const porIndice = new Map(itens.map((i) => [i.indice, i]));
  for (const a of atribuicoesVigentes(escolhido, new Set(porIndice.keys()))) {
    const it = porIndice.get(a.indice);
    if (!it) continue;
    const j = pcJustificativaNecessaria(it.pc, pcEscolhaEfetiva(it.pc, it.escolhaForm));
    info.obrigatoria ||= j.obrigatoria;
    info.foraDaTolerancia ||= j.foraDaTolerancia;
    info.naoComparado ||= j.naoComparado;
    info.trocaDoVinculo ||= j.trocaDoVinculo;
  }
  // o servidor exige e a regra por item nao: a atribuicao nao cabe no saldo do item do PC (conta como fora da tolerancia)
  if (!info.obrigatoria && escolhido.justificativaNecessaria === true) {
    info.obrigatoria = true;
    info.foraDaTolerancia = true;
  }
  return info;
}

/** Texto unico de justificativa da nota: o primeiro nao vazio entre os itens cobertos (eles recebem o mesmo texto). */
export function justificativaDaNota(escolhido: PcDaNf | null, textoPorIndice: (indice: number) => string): string {
  if (!escolhido) return '';
  for (const a of escolhido.itens ?? []) {
    const t = textoPorIndice(a.indice);
    if (t.length > 0) return t;
  }
  return '';
}

// ── Tela ────────────────────────────────────────────────────────────────────

/** Sufixo que o servidor poe no motivo de PC de outro cadastro: ja vem no selo e na linha do cadastro, entao nao se repete por item. */
const SUFIXO_OUTRO_CADASTRO = /\s*·?\s*em outro cadastro do fornecedor(?:\s*\(CNPJ[^)]*\))?\s*$/i;

const motivoUtil = (motivo: string | null | undefined): string | null => {
  const t = (motivo ?? '').replace(SUFIXO_OUTRO_CADASTRO, '').trim();
  // "Vínculo do OMIE" ja vem como selo; o motivo identico seria texto repetido
  return t && t.toLowerCase() !== 'vínculo do omie' ? t : null;
};

function OpcaoPcNf({
  pc,
  grupo,
  selecionado,
  totalItens,
  descricaoDoItem,
  onEscolher,
}: {
  pc: PcDaNf;
  grupo: string;
  selecionado: boolean;
  /** itens a receber da nota (o "M" de "Atende N de M itens") */
  totalItens: number;
  descricaoDoItem: (indice: number) => string;
  onEscolher: (pc: PcDaNf) => void;
}) {
  const id = useId();
  const idTitulo = `${id}-t`;
  const idDetalhe = `${id}-d`;
  const itens = pc.itens ?? [];
  const selos: Selo[] = [
    ...(pc.vinculoOmie === true ? [{ texto: 'Vínculo do OMIE', cls: SELO_VERDE, title: 'O OMIE já trouxe esta nota vinculada a este pedido de compra.' }] : []),
    ...(pc.outroCadastro === true ? [{ texto: 'Outro cadastro do fornecedor', cls: SELO_AMBAR, title: titleOutroCadastro(pc.cnpjCadastro) }] : []),
    ...(pc.dadosEmCache === true ? [{ texto: 'Fora da lista de pendentes', cls: SELO_NEUTRO, title: TITLE_EM_CACHE }] : []),
    ...(pc.dentroTolerancia === false
      ? [{ texto: 'Fora da tolerância', cls: SELO_AMBAR, title: `${TITLE_FORA_TOLERANCIA} Vale para ao menos um item desta nota.` }]
      : []),
    ...(pc.cobreTodos === false
      ? [{ texto: `Atende ${itens.length} de ${totalItens} ${totalItens === 1 ? 'item' : 'itens'}`, cls: SELO_NEUTRO, title: 'Os demais itens da nota continuam com a escolha própria, abaixo.' }]
      : []),
  ];
  const doc = fmtCnpj(pc.cnpjCadastro);
  // Compra nacional da ACXE: estoque de cada item do PC. Uma linha so quando e o mesmo em todos os itens (o comum); senao, junto de cada item.
  const locais = itens.map((a) => (a.localDescricao ?? '').trim());
  const localUnico = locais.length > 0 && locais.every((l) => l !== '' && l === locais[0]) ? locais[0]! : '';
  const borda = selecionado ? 'border-atlas-btn-bg ring-1 ring-atlas-btn-bg' : 'border-atlas-border';
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded border bg-atlas-card p-3 focus-within:ring-2 focus-within:ring-atlas-btn-bg ${borda}`}>
      <input
        type="radio"
        name={grupo}
        checked={selecionado}
        onChange={() => onEscolher(pc)}
        aria-labelledby={idTitulo}
        aria-describedby={idDetalhe}
        className={RADIO_CLS}
      />
      <span className="min-w-0 flex-1">
        <span id={idTitulo} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={`text-sm text-atlas-ink ${pc.pcNumero?.trim() ? 'font-mono' : ''}`}>{rotuloPc(pc.pcNumero)}</span>
          {selos.map((s) => (
            <span key={s.texto} className={s.cls} title={s.title}>
              {s.texto}
            </span>
          ))}
        </span>
        <span id={idDetalhe} className="mt-1 block text-xs text-atlas-muted">
          {itens.map((a) => {
            const produto = (a.produtoDescricao ?? '').trim();
            const motivo = motivoUtil(a.motivo);
            return (
              <span key={a.indice} className="mb-1 block">
                <span className="break-words text-atlas-ink">{descricaoDoItem(a.indice)}</span>
                <span aria-hidden="true"> → </span>
                <span className="sr-only"> vinculado ao produto do pedido </span>
                <span className="break-words text-atlas-ink">{produto || 'produto do pedido não informado'}</span>
                {motivo && <span className="block text-[11px]">{motivo}</span>}
                {!localUnico && (a.localDescricao ?? '').trim() !== '' && <span className="block text-[11px]">Estoque do pedido: {a.localDescricao!.trim()}</span>}
              </span>
            );
          })}
          {localUnico && <span className="block">Estoque do pedido: {localUnico}</span>}
          {pc.outroCadastro === true && (
            <span className="block">{doc ? `Pedido lançado no cadastro CNPJ ${doc} do mesmo fornecedor.` : 'Pedido lançado em outro cadastro do mesmo fornecedor.'}</span>
          )}
          {pc.dadosEmCache === true && (
            <span className="block">Dados da última sincronização do Atlas; o saldo é conferido ao vivo na confirmação.</span>
          )}
        </span>
      </span>
    </label>
  );
}

interface PedidoCompraNfBlocoProps {
  pcs: PcDaNf[];
  /** PC marcado (`pcDaNfEscolhido`) */
  escolhido: PcDaNf | null;
  /** itens a receber da nota (o "M" de "Atende N de M itens") */
  totalItens: number;
  /** descricao do item da NF pelo indice */
  descricaoDoItem: (indice: number) => string;
  onEscolher: (pc: PcDaNf) => void;
  /** justificativa unica da nota (`pcJustificativaDaNota`) */
  justificativaInfo: PcJustificativaInfo;
  justificativa: string;
  onJustificar: (texto: string) => void;
}

export function PedidoCompraNfBloco({ pcs, escolhido, totalItens, descricaoDoItem, onEscolher, justificativaInfo, justificativa, onJustificar }: PedidoCompraNfBlocoProps) {
  const base = useId();
  const grupo = `${base}-pc-nf`;
  const idAjuda = `${base}-ajuda`;
  const motivos = textoMotivosJustificativa(justificativaInfo);
  return (
    <fieldset className="mb-4 min-w-0 rounded-lg border border-atlas-border bg-atlas-card p-4" aria-describedby={idAjuda}>
      <legend className="px-1 text-sm font-medium text-atlas-ink">Pedido de compra da nota</legend>
      <p id={idAjuda} className="mb-3 text-xs text-atlas-muted">
        {pcs.length === 1
          ? 'Confirme o pedido de compra desta nota. Cada item fica vinculado ao item correspondente do pedido.'
          : 'Escolha o pedido de compra desta nota. Cada item fica vinculado ao item correspondente do pedido.'}
      </p>
      <div className="flex flex-col gap-2">
        {pcs.map((p) => (
          <OpcaoPcNf
            key={p.nCodPed}
            pc={p}
            grupo={grupo}
            selecionado={escolhido != null && escolhido.nCodPed === p.nCodPed}
            totalItens={totalItens}
            descricaoDoItem={descricaoDoItem}
            onEscolher={onEscolher}
          />
        ))}
      </div>

      {escolhido && justificativaInfo.obrigatoria && (
        <div className="mt-3">
          <label htmlFor={`${base}-just`} className="mb-1 block text-xs font-medium text-atlas-muted">
            Justificativa da escolha do pedido de compra da nota <span aria-hidden="true">*</span>
          </label>
          <textarea
            id={`${base}-just`}
            value={justificativa}
            onChange={(e) => onJustificar(e.target.value)}
            rows={2}
            maxLength={JUSTIFICATIVA_MAX}
            aria-required="true"
            aria-describedby={`${base}-just-ajuda`}
            placeholder="Ex.: o fornecedor faturou esta carga com outro número de pedido"
            className="w-full rounded border border-atlas-border bg-atlas-bg px-3 py-2 text-sm text-atlas-ink placeholder:text-atlas-muted"
          />
          <div id={`${base}-just-ajuda`} className="mt-1 flex justify-between gap-3 text-[11px] text-atlas-muted">
            <span>{[motivos, 'Uma só justificativa vale para todos os itens deste pedido.'].filter(Boolean).join(' ')}</span>
            <span className="whitespace-nowrap">
              {justificativa.length}/{JUSTIFICATIVA_MAX}
            </span>
          </div>
        </div>
      )}
    </fieldset>
  );
}
