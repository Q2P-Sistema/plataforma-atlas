import { useId, useState, type ReactNode } from 'react';
import { fmtDataBr } from '../../../lib/format.js';

/**
 * Feature 017 (ACXEGDP-437) — bloco "Pedido de compra" de cada item da NF nacional.
 *
 * Com o fiscal pendente, o Atlas conclui o recebimento fiscal no OMIE com cada item
 * vinculado a um item de pedido de compra (PC). Aqui o operador CONFIRMA esse PC: o
 * vinculo que o OMIE ja traz, o candidato que o Atlas sugere (dentro da tolerancia de
 * quantidade e preco) ou, com justificativa, outro PC do fornecedor.
 *
 * Regra de tela (ACXEGDP-313): o PC aparece so pelo numero legivel ("PC 304").
 * `nCodPed`/`nCodItem` identificam a opcao escolhida e vao no corpo do POST, mas nunca
 * viram texto nem atributo do DOM.
 *
 * Tudo que decide "posso enviar?" (opcoes, escolha efetiva, justificativa, pendencia,
 * corpo do POST) e funcao pura e exportada: o Panel usa as mesmas para desabilitar o
 * botao, validar e montar o envio, e o componente usa para desenhar.
 */

// ── Contrato (GET /fila/:chaveAcesso → itens[].pc) ──────────────────────────

/** Identifica uma opcao de PC (item de pedido). So selecao e corpo do POST — nunca texto. */
export interface PcRef {
  nCodPed: number;
  nCodItem: number;
}

export interface PcCandidato extends PcRef {
  /** numero legivel do PC, ex.: "304"; vazio quando o OMIE nao informa o numero e o PC ja saiu da lista local (use `rotuloPc`) */
  pcNumero: string;
  /** produto do PC — referencia; nao substitui a correlacao do produto no estoque */
  produtoDescricao: string;
  qtdPedidaKg: number;
  saldoKg: number;
  /** R$/kg */
  precoUnit: number;
  /** 'YYYY-MM-DD' */
  dtPrevisao: string | null;
  etapa: '15' | '10';
  dentroTolerancia: boolean;
  casaNumeroPedidoNf: boolean;
  /** texto pronto: "Número do pedido na NF", "Preço 3,2% acima", ... */
  motivo: string;
  /**
   * So vem true no vinculo do OMIE cujo PC nao esta na lista local: produto, saldo e preco vem vazios ou zerados
   * e nao sao mostrados; quantidade e preco nao puderam ser comparados com a nota (manter o vinculo exige justificativa).
   */
  semDadosLocais?: boolean;
  /**
   * Preco da NF por kg na base que o servidor usou para comparar com o PC (comercial ou valor do item, a que
   * ficou mais perto). Opcional e informativo: a tela nao o mostra — quem decide a tolerancia e `dentroTolerancia`.
   */
  precoNfKgComparado?: number | null;
}

export interface PcDoItem {
  vinculoOmie: PcCandidato | null;
  /** false = o vinculo do OMIE nao pode ser mantido (ex.: PC-espelho): aparece, mas o operador precisa trocar */
  vinculoOmieElegivel: boolean;
  alertaVinculoOmie: string | null;
  /** dentro da tolerancia, ja ordenados */
  candidatos: PcCandidato[];
  /** etapa 15 com saldo, fora da tolerancia: escolha manual com justificativa */
  outrosDoFornecedor: PcCandidato[];
  /** etapa 10: aparecem desabilitados */
  aguardandoAprovacao: PcCandidato[];
  preSelecionado: PcRef | null;
  /** texto pronto quando nao ha nada selecionavel */
  semPcMotivo: string | null;
  /** fiscal ja feito: PC que o recebimento concluido traz (`pcNumero` pode vir vazio) */
  vinculadoNoOmie: { pcNumero: string } | null;
  /**
   * As linhas do item estao vinculadas a PCs diferentes no OMIE: `vinculoOmie` vem null e o alerta vem em
   * `alertaVinculoOmie`. Escolher qualquer PC conta como troca do vinculo (justificativa obrigatoria).
   */
  vinculosDivergentes?: boolean;
}

/** Item do corpo do POST /por-nf (snake_case, `.strict()` no servidor). */
export interface PcEnvio {
  n_cod_ped: number;
  n_cod_item: number;
  justificativa?: string;
  /** vinculo do OMIE que a tela mostrou (null = nenhum): base do 409 VINCULO_OMIE_MUDOU */
  n_cod_item_omie_visto: number | null;
}

// ── Decisao (funcoes puras) ─────────────────────────────────────────────────

/**
 * Texto do PC para o operador: "PC 304". O numero pode vir vazio (o OMIE nao o informa e o PC ja saiu
 * da lista local); nesse caso o texto e "PC (número não informado)". Nunca ha id interno aqui.
 */
export function rotuloPc(pcNumero: string | null | undefined): string {
  const n = (pcNumero ?? '').trim();
  return n ? `PC ${n}` : 'PC (número não informado)';
}

/** limite da justificativa do PC (1 a 500 caracteres) */
const JUSTIFICATIVA_MAX = 500;

export function mesmoPc(a: PcRef | null | undefined, b: PcRef | null | undefined): boolean {
  return a != null && b != null && a.nCodPed === b.nCodPed && a.nCodItem === b.nCodItem;
}

/**
 * Listas que a tela desenha, sem repetir o mesmo PC: o vinculo do OMIE e a propria linha dele (elegivel ou
 * nao), entao nao volta como candidato, "outro do fornecedor" nem "aguardando aprovacao"; um PC que esta em
 * `candidatos` nao se repete em "outros".
 */
export function pcListas(pc: PcDoItem): { candidatos: PcCandidato[]; outros: PcCandidato[]; aguardando: PcCandidato[] } {
  // `?? []`: lista omitida pelo servidor vira vazia — a tela de recebimento nao pode cair por isso
  const candidatos = (pc.candidatos ?? []).filter((c) => !mesmoPc(c, pc.vinculoOmie));
  return {
    candidatos,
    outros: (pc.outrosDoFornecedor ?? []).filter((c) => !mesmoPc(c, pc.vinculoOmie) && !candidatos.some((x) => mesmoPc(x, c))),
    aguardando: (pc.aguardandoAprovacao ?? []).filter((c) => !mesmoPc(c, pc.vinculoOmie)),
  };
}

/** O que o operador pode escolher: vinculo do OMIE (se elegivel), candidatos e "outros do fornecedor". */
export function opcoesSelecionaveis(pc: PcDoItem): PcCandidato[] {
  const { candidatos, outros } = pcListas(pc);
  return [...(pc.vinculoOmie && pc.vinculoOmieElegivel !== false ? [pc.vinculoOmie] : []), ...candidatos, ...outros];
}

/**
 * Escolha que vale: `undefined` = o operador ainda nao mexeu (vale a pre-selecao do servidor);
 * `null` = limpou; um PC que sumiu das opcoes depois de recarregar a nota tambem vira `null`.
 */
export function pcEscolhaEfetiva(pc: PcDoItem, escolha: PcRef | null | undefined): PcRef | null {
  const alvo = escolha === undefined ? pc.preSelecionado : escolha;
  if (!alvo || !opcoesSelecionaveis(pc).some((o) => mesmoPc(o, alvo))) return null;
  return { nCodPed: alvo.nCodPed, nCodItem: alvo.nCodItem };
}

export function pcOpcaoEscolhida(pc: PcDoItem, escolha: PcRef | null): PcCandidato | null {
  if (!escolha) return null;
  return opcoesSelecionaveis(pc).find((o) => mesmoPc(o, escolha)) ?? null;
}

export interface PcJustificativaInfo {
  obrigatoria: boolean;
  /** PC fora da tolerancia (inclusive o vinculo do OMIE mantido) ou escolhido entre os "outros do fornecedor" */
  foraDaTolerancia: boolean;
  /** vinculo do OMIE cujo PC nao esta na lista local: quantidade e preco nao puderam ser comparados com a nota */
  naoComparado: boolean;
  /** o item veio vinculado no OMIE (ou com vinculos divergentes) e o operador escolheu outro PC */
  trocaDoVinculo: boolean;
}

/** Matriz do data-model §4 da feature 017: quando a justificativa e obrigatoria. */
export function pcJustificativaNecessaria(pc: PcDoItem, escolha: PcRef | null): PcJustificativaInfo {
  const nenhuma: PcJustificativaInfo = { obrigatoria: false, foraDaTolerancia: false, naoComparado: false, trocaDoVinculo: false };
  if (!escolha) return nenhuma;
  const { candidatos, outros } = pcListas(pc);
  const doVinculo = pc.vinculoOmie != null && mesmoPc(pc.vinculoOmie, escolha);
  const doCandidato = candidatos.find((c) => mesmoPc(c, escolha));
  const doOutros = outros.find((c) => mesmoPc(c, escolha));
  const opcao = (doVinculo ? pc.vinculoOmie : null) ?? doCandidato ?? doOutros;
  if (!opcao) return nenhuma;
  // sem dados locais nao ha comparacao: nao e "fora da tolerancia", e "nao comparado" (e tambem exige justificativa)
  const naoComparado = opcao.semDadosLocais === true;
  const foraDaTolerancia = !naoComparado && (doOutros != null || !opcao.dentroTolerancia);
  // vinculos divergentes: vinculoOmie vem null e qualquer PC escolhido substitui o que esta no OMIE
  const trocaDoVinculo = pc.vinculosDivergentes === true || (pc.vinculoOmie != null && !doVinculo);
  return { obrigatoria: foraDaTolerancia || naoComparado || trocaDoVinculo, foraDaTolerancia, naoComparado, trocaDoVinculo };
}

/** Item sem nenhum PC que o operador possa escolher. */
export function pcSemOpcao(pc: PcDoItem): boolean {
  return opcoesSelecionaveis(pc).length === 0;
}

/**
 * A nota nao pode ser recebida por este item (o servidor recusa com 422 NF_SEM_PC): sem PC possivel e (modo
 * "bloquear" OU item que veio vinculado no OMIE — vinculo unico ou divergente —, que nunca e ignorado, FR-011a,
 * nem no modo "receber sem vinculo").
 */
export function pcBloqueiaRecebimento(pc: PcDoItem, exigePc: boolean): boolean {
  return pcSemOpcao(pc) && (exigePc || pc.vinculoOmie != null || pc.vinculosDivergentes === true);
}

export type PcPendencia = { tipo: 'escolher' } | { tipo: 'justificar'; pcNumero: string };

/**
 * O que ainda impede de confirmar este item (null = nada). Item sem PC possivel nao tem o que escolher e
 * nao e pendencia: o clique segue e o servidor decide (422 NF_SEM_PC, que avisa compras, ou receber sem vinculo).
 */
export function pcPendencia(pc: PcDoItem, escolhaForm: PcRef | null | undefined, justificativa: string): PcPendencia | null {
  if (pcSemOpcao(pc)) return null;
  const escolha = pcEscolhaEfetiva(pc, escolhaForm);
  if (!escolha) return { tipo: 'escolher' };
  if (pcJustificativaNecessaria(pc, escolha).obrigatoria && justificativa.trim() === '') {
    return { tipo: 'justificar', pcNumero: pcOpcaoEscolhida(pc, escolha)?.pcNumero ?? '' };
  }
  return null;
}

/** `pc` do corpo do POST; null = item sem PC escolhido (a chave nem vai no corpo). */
export function pcParaEnvio(pc: PcDoItem, escolhaForm: PcRef | null | undefined, justificativa: string): PcEnvio | null {
  const escolha = pcEscolhaEfetiva(pc, escolhaForm);
  if (!escolha) return null;
  return {
    n_cod_ped: escolha.nCodPed,
    n_cod_item: escolha.nCodItem,
    // justificativa de outra escolha, ja trocada, nao segue junto
    ...(pcJustificativaNecessaria(pc, escolha).obrigatoria ? { justificativa: justificativa.trim().slice(0, JUSTIFICATIVA_MAX) } : {}),
    // so um vinculo com id valido conta como "visto" (null = a tela nao mostrou vinculo)
    n_cod_item_omie_visto: pc.vinculoOmie && pc.vinculoOmie.nCodItem > 0 ? pc.vinculoOmie.nCodItem : null,
  };
}

// ── Formatacao ──────────────────────────────────────────────────────────────

/** kg em pt-BR, ate 3 casas — o mesmo no Panel e no bloco */
export const fmtKg = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
/** R$/kg com 2 a 4 casas: a tolerancia de preco e de 1%, e 2 casas fixas esconderiam a diferenca. O mesmo no Panel (preco da NF) e no bloco (preco do PC) */
export const fmtBrlKg = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4 });

const SELO_BASE = 'text-xs font-medium px-1.5 py-0.5 rounded';
const SELO_VERDE = `${SELO_BASE} bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400`;
const SELO_AMBAR = `${SELO_BASE} bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400`;
const AVISO_AMBAR = 'p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-sm text-amber-900 dark:text-amber-200';
const TITLE_FORA_TOLERANCIA = 'Quantidade ou preço da nota fora da tolerância deste pedido: exige justificativa.';
const TITLE_NAO_COMPARADO =
  'Este pedido não está na lista local; a quantidade e o preço não puderam ser comparados. Manter o vínculo exige justificativa.';

// ── Tela ────────────────────────────────────────────────────────────────────

interface Selo {
  texto: string;
  cls: string;
  title?: string;
}

function OpcaoPc({
  c,
  grupo,
  selecionado,
  desabilitado = false,
  selos = [],
  aviso,
  mostrarMotivo = true,
  onEscolher,
}: {
  c: PcCandidato;
  grupo: string;
  selecionado: boolean;
  desabilitado?: boolean;
  selos?: Selo[];
  /** aviso do servidor sobre esta opcao (ex.: alerta do vinculo do OMIE) */
  aviso?: string | null;
  /** false nas linhas "aguardando aprovacao": o motivo do servidor ali nao ajuda a escolher */
  mostrarMotivo?: boolean;
  onEscolher: (ref: PcRef) => void;
}) {
  const id = useId();
  const idTitulo = `${id}-t`;
  const idDetalhe = `${id}-d`;
  const borda = desabilitado
    ? 'border-dashed border-atlas-border cursor-not-allowed'
    : selecionado
      ? 'border-atlas-btn-bg ring-1 ring-atlas-btn-bg cursor-pointer'
      : 'border-atlas-border cursor-pointer';
  // "Vínculo do OMIE" ja vem como selo; o motivo identico seria texto repetido
  const motivoTexto = (c.motivo ?? '').trim();
  const motivo = mostrarMotivo && motivoTexto && motivoTexto.toLowerCase() !== 'vínculo do omie' ? motivoTexto : null;
  // PC fora da lista local: produto, saldo e preco vem vazios ou zerados e nao sao mostrados
  const semDados = c.semDadosLocais === true;
  return (
    <label className={`flex items-start gap-3 rounded border bg-atlas-card p-3 focus-within:ring-2 focus-within:ring-atlas-btn-bg ${borda}`}>
      <input
        type="radio"
        name={grupo}
        checked={selecionado}
        disabled={desabilitado}
        onChange={() => onEscolher({ nCodPed: c.nCodPed, nCodItem: c.nCodItem })}
        aria-labelledby={idTitulo}
        aria-describedby={idDetalhe}
        // radio desenhado com os tokens atlas: o nativo no tema escuro vira um disco branco/cinza cheio, que parece "marcado";
        // em modo de alto contraste (forced-colors) volta o nativo, que o sistema desenha
        className="mt-1 h-4 w-4 shrink-0 appearance-none rounded-full border-2 border-atlas-muted bg-atlas-card checked:border-atlas-btn-bg checked:bg-atlas-btn-bg checked:shadow-[inset_0_0_0_2px_var(--atlas-card)] disabled:border-atlas-border forced-colors:appearance-auto"
      />
      <span className="min-w-0 flex-1">
        <span id={idTitulo} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={`text-sm text-atlas-ink ${c.pcNumero?.trim() ? 'font-mono' : ''}`}>{rotuloPc(c.pcNumero)}</span>
          {selos.map((s) => (
            <span key={s.texto} className={s.cls} title={s.title}>
              {s.texto}
            </span>
          ))}
          {!semDados && (
            <span className="text-sm text-atlas-ink break-words">
              <span className="text-xs text-atlas-muted">Produto do PC </span>
              {c.produtoDescricao}
            </span>
          )}
        </span>
        <span id={idDetalhe} className="mt-0.5 block text-xs text-atlas-muted">
          {semDados ? (
            <span className="block">Saldo e preço indisponíveis: o pedido não está na lista local.</span>
          ) : (
            <span className="block">
              Saldo {fmtKg(c.saldoKg)} kg{c.qtdPedidaKg !== c.saldoKg && ` de ${fmtKg(c.qtdPedidaKg)} kg pedidos`}
              {' · '}
              {fmtBrlKg(c.precoUnit)}/kg
              {c.dtPrevisao && ` · entrega prevista ${fmtDataBr(c.dtPrevisao)}`}
            </span>
          )}
          {motivo && <span className="block">{motivo}</span>}
          {aviso && <span className="mt-1 block text-amber-800 dark:text-amber-300">{aviso}</span>}
        </span>
      </span>
    </label>
  );
}

function LegendaPc({ dica }: { dica?: ReactNode }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <span aria-hidden="true" className="text-[11px] uppercase tracking-wide text-atlas-muted">
        Pedido de compra
      </span>
      {dica && <span className="text-[11px] text-atlas-muted">{dica}</span>}
    </div>
  );
}

interface PedidoCompraBlocoProps {
  pc: PcDoItem;
  /** descricao do item da NF — so para o leitor de tela saber de que item e o grupo */
  descricaoItem: string;
  /** escolha efetiva (`pcEscolhaEfetiva`) */
  escolha: PcRef | null;
  onEscolher: (ref: PcRef) => void;
  justificativa: string;
  onJustificar: (texto: string) => void;
  /** STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC: true = item sem PC possivel bloqueia a NF */
  exigePc: boolean;
  /** lista local de PCs desatualizada: sem sugestao confiavel */
  copiaDefasada: boolean;
}

export function PedidoCompraBloco({ pc, descricaoItem, escolha, onEscolher, justificativa, onJustificar, exigePc, copiaDefasada }: PedidoCompraBlocoProps) {
  const base = useId();
  const grupo = `${base}-pc`;
  /** o operador abriu (ou fechou) "Outros PCs do fornecedor"; a escolha em "outros" abre sozinha, abaixo */
  const [outrosAberto, setOutrosAberto] = useState(false);

  if (copiaDefasada) {
    // o aviso completo (e o botao de recarregar) esta no topo da nota; aqui so o fato, no lugar da sugestao
    return (
      <div className="mt-3">
        <LegendaPc />
        <div className={AVISO_AMBAR}>Sugestão de PC indisponível.</div>
      </div>
    );
  }

  const elegivel = pc.vinculoOmieElegivel !== false;
  const semOpcao = pcSemOpcao(pc);
  const bloqueia = pcBloqueiaRecebimento(pc, exigePc);
  const just = pcJustificativaNecessaria(pc, escolha);
  const { candidatos, outros, aguardando } = pcListas(pc);
  /**
   * A escolha efetiva esta em "outros do fornecedor" (ex.: a nota foi recarregada e o PC escolhido passou para la):
   * a lista abre sozinha para a opcao marcada aparecer ao lado do campo de justificativa.
   */
  const escolhaEmOutros = escolha != null && outros.some((o) => mesmoPc(o, escolha));
  const divergentes = pc.vinculosDivergentes === true;
  const motivosJust = [
    just.foraDaTolerancia && 'O PC escolhido está fora da tolerância de quantidade ou preço da nota.',
    just.naoComparado && 'Não foi possível comparar a quantidade e o preço deste pedido com a nota.',
    just.trocaDoVinculo && 'Você está trocando o vínculo que veio do OMIE.',
  ]
    .filter(Boolean)
    .join(' ');
  const textoDivergentes =
    (pc.alertaVinculoOmie ?? '').trim() || 'As linhas deste item estão vinculadas a pedidos de compra diferentes no OMIE. Escolha o pedido de compra correto.';
  const semPcTexto =
    (pc.semPcMotivo ?? '').trim() ||
    (pc.vinculoOmie && !elegivel
      ? 'O vínculo que veio do OMIE não pode ser mantido e não há outro pedido de compra possível para este item.'
      : divergentes
        ? 'As linhas deste item estão vinculadas a pedidos de compra diferentes no OMIE e não há pedido de compra possível para escolher.'
        : 'Nenhum pedido de compra aprovado com saldo foi encontrado para este item.');
  const selosForaTolerancia = (c: PcCandidato): Selo[] =>
    c.semDadosLocais === true || c.dentroTolerancia ? [] : [{ texto: 'Fora da tolerância', cls: SELO_AMBAR, title: TITLE_FORA_TOLERANCIA }];

  return (
    <fieldset className="mt-3 min-w-0">
      <legend className="sr-only">Pedido de compra do item {descricaoItem}</legend>
      <LegendaPc dica={!semOpcao && !escolha ? 'escolha uma opção' : undefined} />

      {/* vinculos divergentes: nao ha `vinculoOmie` para carregar o alerta na linha; ele vem acima das opcoes */}
      {divergentes && !pc.vinculoOmie && <div className={`mb-2 ${AVISO_AMBAR}`}>{textoDivergentes}</div>}

      <div className="flex flex-col gap-2">
        {pc.vinculoOmie && (
          <OpcaoPc
            c={pc.vinculoOmie}
            grupo={grupo}
            selecionado={mesmoPc(escolha, pc.vinculoOmie)}
            desabilitado={!elegivel}
            selos={[
              { texto: 'Vínculo do OMIE', cls: elegivel ? SELO_VERDE : SELO_AMBAR, title: 'O OMIE já trouxe este item vinculado a este pedido de compra.' },
              ...(!elegivel ? [{ texto: 'Não pode ser mantido', cls: SELO_AMBAR }] : []),
              ...(elegivel && pc.vinculoOmie.semDadosLocais === true ? [{ texto: 'Não comparado', cls: SELO_AMBAR, title: TITLE_NAO_COMPARADO }] : []),
              ...(elegivel ? selosForaTolerancia(pc.vinculoOmie) : []),
            ]}
            aviso={pc.alertaVinculoOmie}
            onEscolher={onEscolher}
          />
        )}
        {candidatos.map((c) => (
          <OpcaoPc key={`${c.nCodPed}-${c.nCodItem}`} c={c} grupo={grupo} selecionado={mesmoPc(escolha, c)} selos={selosForaTolerancia(c)} onEscolher={onEscolher} />
        ))}
      </div>

      {semOpcao && (
        <div className={`${pc.vinculoOmie || candidatos.length > 0 ? 'mt-2 ' : ''}${AVISO_AMBAR}`}>
          <div className="font-semibold">{bloqueia ? 'Aguardando pedido de compra' : 'Será recebido sem vínculo com pedido de compra'}</div>
          <div>{semPcTexto}</div>
        </div>
      )}

      {aguardando.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {aguardando.map((c) => (
            <OpcaoPc
              key={`${c.nCodPed}-${c.nCodItem}`}
              c={c}
              grupo={grupo}
              selecionado={false}
              desabilitado
              mostrarMotivo={false}
              selos={[{ texto: 'PC aguardando aprovação', cls: SELO_AMBAR, title: 'Só é possível vincular pedido de compra aprovado.' }]}
              onEscolher={onEscolher}
            />
          ))}
        </div>
      )}

      {outros.length > 0 && (
        <details open={outrosAberto || escolhaEmOutros} onToggle={(e) => setOutrosAberto(e.currentTarget.open)} className="mt-2">
          <summary className="cursor-pointer text-xs text-atlas-muted underline hover:text-atlas-ink">
            Outros PCs do fornecedor ({outros.length})
          </summary>
          <p className="mt-2 mb-2 text-xs text-atlas-muted">
            Pedidos aprovados e com saldo, mas fora da tolerância de quantidade ou preço desta nota. Escolher um deles exige justificativa.
          </p>
          <div className="flex flex-col gap-2">
            {outros.map((c) => (
              <OpcaoPc
                key={`${c.nCodPed}-${c.nCodItem}`}
                c={c}
                grupo={grupo}
                selecionado={mesmoPc(escolha, c)}
                selos={[{ texto: 'Fora da tolerância', cls: SELO_AMBAR, title: TITLE_FORA_TOLERANCIA }]}
                onEscolher={onEscolher}
              />
            ))}
          </div>
        </details>
      )}

      {just.obrigatoria && (
        <div className="mt-3">
          <label htmlFor={`${base}-just`} className="block text-xs font-medium text-atlas-muted mb-1">
            Justificativa da escolha do PC *
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
            className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg text-atlas-ink placeholder:text-atlas-muted rounded text-sm"
          />
          <div id={`${base}-just-ajuda`} className="mt-1 flex justify-between gap-3 text-[11px] text-atlas-muted">
            <span>{motivosJust}</span>
            <span className="whitespace-nowrap">
              {justificativa.length}/{JUSTIFICATIVA_MAX}
            </span>
          </div>
        </div>
      )}
    </fieldset>
  );
}
