import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
 *
 * PC por NF (22/10/2026): o operador escolhe o pedido UMA vez para a nota (bloco em
 * `PedidoCompraNfBloco.tsx`); a tela expande a escolha em escolhas por item e o POST
 * continua por item. Aqui ficam os tipos desse contrato e o modo compacto do item
 * ("PC 306 · produto · Trocar") quando o item segue o pedido escolhido na nota.
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
  /**
   * PC lancado em OUTRO cadastro do mesmo fornecedor no OMIE (mesma raiz de CNPJ: filial x matriz). Ausente = servidor anterior.
   */
  outroCadastro?: boolean;
  /** CNPJ do cadastro do PC, so digitos ('' sem cadastro); a tela formata com `fmtCnpj` */
  cnpjCadastro?: string;
  /**
   * Dados do cache do Atlas: o OMIE tirou o PC da lista de pendentes (ja tem item associado a um recebimento). O saldo e o da
   * ultima sincronizacao; a confirmacao confere ao vivo.
   */
  dadosEmCache?: boolean;
  /** unidade do PC no OMIE ('KG', 'TON', ...) */
  unidade?: string;
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
  /**
   * PCs do fornecedor em unidade DIFERENTE da nota: aparecem desabilitados, com o motivo do servidor. O OMIE baixaria o pedido
   * com a quantidade da nota na unidade da nota, sem converter. Ausente = servidor anterior.
   */
  unidadeIncompativel?: PcCandidato[];
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

// ── Contrato (GET /fila/:chaveAcesso → pcsDaNf): PC por NF ──────────────────

/** Atribuicao de UM item da NF a um item do PC (ids so de selecao — nunca texto). */
export interface PcDaNfItem {
  /** indice do item da NF (`ItemNf.indice`) */
  indice: number;
  /** item do PC atribuido */
  nCodItem: number;
  produtoDescricao: string;
  dentroTolerancia: boolean;
  motivo: string;
  origem: 'omie' | 'sugestao' | 'manual';
  /** manter/escolher este item exige justificativa */
  justificativaNecessaria: boolean;
}

/** Um PC que atende a nota, com a atribuicao item da NF -> item do PC. */
export interface PcDaNf {
  nCodPed: number;
  /** numero legivel; vazio quando o OMIE nao informa (use `rotuloPc`) */
  pcNumero: string;
  outroCadastro: boolean;
  /** so digitos; a tela formata */
  cnpjCadastro: string;
  dadosEmCache: boolean;
  /** um por item da NF que este PC atende */
  itens: PcDaNfItem[];
  /** atende todos os itens a receber com PC possivel */
  cobreTodos: boolean;
  /** todas as atribuicoes dentro da tolerancia */
  dentroTolerancia: boolean;
  /** e o PC que o OMIE ja tem vinculado em algum item da NF */
  vinculoOmie: boolean;
  /** alguma atribuicao exige justificativa (uma so para a nota inteira) */
  justificativaNecessaria: boolean;
}

export interface PcsDaNf {
  /** na ordem do servidor */
  pcs: PcDaNf[];
  /** `nCodPed` do PC pre-selecionado para a nota inteira, ou null */
  preSelecionado: number | null;
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
export const JUSTIFICATIVA_MAX = 500;

export function mesmoPc(a: PcRef | null | undefined, b: PcRef | null | undefined): boolean {
  return a != null && b != null && a.nCodPed === b.nCodPed && a.nCodItem === b.nCodItem;
}

/**
 * Listas que a tela desenha, sem repetir o mesmo PC: o vinculo do OMIE e a propria linha dele (elegivel ou
 * nao), entao nao volta como candidato, "outro do fornecedor" nem "aguardando aprovacao"; um PC que esta em
 * `candidatos` nao se repete em "outros".
 */
export function pcListas(pc: PcDoItem): {
  candidatos: PcCandidato[];
  outros: PcCandidato[];
  aguardando: PcCandidato[];
  /** unidade diferente da nota: desabilitados, nunca selecionaveis */
  incompativeis: PcCandidato[];
} {
  // `?? []`: lista omitida pelo servidor vira vazia — a tela de recebimento nao pode cair por isso
  const candidatos = (pc.candidatos ?? []).filter((c) => !mesmoPc(c, pc.vinculoOmie));
  const outros = (pc.outrosDoFornecedor ?? []).filter((c) => !mesmoPc(c, pc.vinculoOmie) && !candidatos.some((x) => mesmoPc(x, c)));
  const aguardando = (pc.aguardandoAprovacao ?? []).filter((c) => !mesmoPc(c, pc.vinculoOmie));
  const incompativeis = (pc.unidadeIncompativel ?? []).filter(
    (c) => !mesmoPc(c, pc.vinculoOmie) && ![...candidatos, ...outros, ...aguardando].some((x) => mesmoPc(x, c)),
  );
  return { candidatos, outros, aguardando, incompativeis };
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

/**
 * `pc` do corpo do POST; null = item sem PC escolhido (a chave nem vai no corpo).
 * `justificativaDaNota`: o item segue um pedido escolhido na nota cuja justificativa (uma so, por nota) foi exigida —
 * ela vai tambem nos itens em que a regra por item nao a exigiria (o servidor a guarda como informada).
 */
export function pcParaEnvio(pc: PcDoItem, escolhaForm: PcRef | null | undefined, justificativa: string, justificativaDaNota = false): PcEnvio | null {
  const escolha = pcEscolhaEfetiva(pc, escolhaForm);
  if (!escolha) return null;
  const texto = justificativa.trim().slice(0, JUSTIFICATIVA_MAX);
  return {
    n_cod_ped: escolha.nCodPed,
    n_cod_item: escolha.nCodItem,
    // justificativa de outra escolha, ja trocada, nao segue junto
    ...(pcJustificativaNecessaria(pc, escolha).obrigatoria || (justificativaDaNota && texto !== '') ? { justificativa: texto } : {}),
    // so um vinculo com id valido conta como "visto" (null = a tela nao mostrou vinculo)
    n_cod_item_omie_visto: pc.vinculoOmie && pc.vinculoOmie.nCodItem > 0 ? pc.vinculoOmie.nCodItem : null,
  };
}

// ── Formatacao ──────────────────────────────────────────────────────────────

/** kg em pt-BR, ate 3 casas — o mesmo no Panel e no bloco */
export const fmtKg = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
/** R$/kg com 2 a 4 casas: a tolerancia de preco e de 1%, e 2 casas fixas esconderiam a diferenca. O mesmo no Panel (preco da NF) e no bloco (preco do PC) */
export const fmtBrlKg = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4 });

/**
 * CNPJ (14 digitos) ou CPF (11) com mascara; qualquer outro tamanho devolve '' — nunca inventa mascara nem mostra um numero
 * que nao e documento (ex.: codigo interno do OMIE, ACXEGDP-313). Aceita o valor ja mascarado.
 */
export function fmtCnpj(valor: string | null | undefined): string {
  const d = String(valor ?? '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return '';
}

export const SELO_BASE = 'text-xs font-medium px-1.5 py-0.5 rounded';
export const SELO_VERDE = `${SELO_BASE} bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400`;
export const SELO_AMBAR = `${SELO_BASE} bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400`;
/** informativo: nao pede acao do operador */
export const SELO_NEUTRO = `${SELO_BASE} border border-atlas-border text-atlas-muted`;
export const AVISO_AMBAR = 'p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-sm text-amber-900 dark:text-amber-200';
export const TITLE_FORA_TOLERANCIA = 'Quantidade ou preço da nota fora da tolerância deste pedido: exige justificativa.';
const TITLE_NAO_COMPARADO =
  'Este pedido não está na lista local; a quantidade e o preço não puderam ser comparados. Manter o vínculo exige justificativa.';
export const TITLE_EM_CACHE =
  'O OMIE retirou este pedido da lista de pendentes. Os dados são os da última sincronização do Atlas; o saldo é conferido ao vivo na confirmação.';
const TITLE_UNIDADE_DIFERENTE =
  'O pedido está em unidade diferente da nota e o OMIE baixaria o saldo sem converter a quantidade. Este pedido não pode ser vinculado.';

/** Texto do selo "Outro cadastro do fornecedor": o CNPJ do cadastro do pedido, quando conhecido. */
export function titleOutroCadastro(cnpjCadastro: string | null | undefined): string {
  const doc = fmtCnpj(cnpjCadastro);
  return doc ? `Pedido lançado no cadastro CNPJ ${doc} do mesmo fornecedor` : 'Pedido lançado em outro cadastro do mesmo fornecedor';
}

/** Radio desenhado com os tokens atlas (o nativo no tema escuro vira um disco cheio que parece "marcado"); forced-colors volta o nativo. */
export const RADIO_CLS =
  'mt-1 h-4 w-4 shrink-0 appearance-none rounded-full border-2 border-atlas-muted bg-atlas-card checked:border-atlas-btn-bg checked:bg-atlas-btn-bg checked:shadow-[inset_0_0_0_2px_var(--atlas-card)] disabled:border-atlas-border forced-colors:appearance-auto';

/** Por que a justificativa e obrigatoria, em frases (a mesma redacao no item e na nota). */
export function textoMotivosJustificativa(just: PcJustificativaInfo): string {
  return [
    just.foraDaTolerancia && 'O PC escolhido está fora da tolerância de quantidade ou preço da nota.',
    just.naoComparado && 'Não foi possível comparar a quantidade e o preço deste pedido com a nota.',
    just.trocaDoVinculo && 'Você está trocando o vínculo que veio do OMIE.',
  ]
    .filter(Boolean)
    .join(' ');
}

// ── Tela ────────────────────────────────────────────────────────────────────

export interface Selo {
  texto: string;
  cls: string;
  title?: string;
}

/** Selos que vem do proprio candidato (origem dos dados), iguais no item e na nota. */
function selosDeOrigem(c: Pick<PcCandidato, 'outroCadastro' | 'cnpjCadastro' | 'dadosEmCache'>): Selo[] {
  return [
    ...(c.outroCadastro === true ? [{ texto: 'Outro cadastro do fornecedor', cls: SELO_AMBAR, title: titleOutroCadastro(c.cnpjCadastro) }] : []),
    ...(c.dadosEmCache === true ? [{ texto: 'Fora da lista de pendentes', cls: SELO_NEUTRO, title: TITLE_EM_CACHE }] : []),
  ];
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
  // o saldo e sempre em kg; a unidade do pedido so aparece quando nao e kg (ex.: pedido em toneladas)
  const unidadePc = (c.unidade ?? '').trim();
  const mostrarUnidade = unidadePc !== '' && unidadePc.toUpperCase() !== 'KG';
  const todosSelos = [...selos, ...selosDeOrigem(c)];
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
        className={RADIO_CLS}
      />
      <span className="min-w-0 flex-1">
        <span id={idTitulo} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={`text-sm text-atlas-ink ${c.pcNumero?.trim() ? 'font-mono' : ''}`}>{rotuloPc(c.pcNumero)}</span>
          {todosSelos.map((s) => (
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
              {mostrarUnidade && ` · pedido em ${unidadePc}`}
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

/** O item segue o pedido escolhido na nota: a linha compacta mostra qual e deixa trocar. */
export interface PcCompactoNota {
  pcNumero: string;
  /** produto do item do PC atribuido a este item ('' quando o servidor nao o informa) */
  produtoDescricao: string;
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
  /**
   * A escolha efetiva do item e a atribuicao do PC escolhido na nota: so a linha "PC 306 · produto · Trocar"; as opcoes
   * abrem ao clicar em "Trocar".
   */
  compactoNota?: PcCompactoNota | null;
  /** a justificativa deste item e a da nota (um unico campo no bloco da nota): o campo por item nao aparece */
  justificativaNaNota?: boolean;
}

export function PedidoCompraBloco({
  pc,
  descricaoItem,
  escolha,
  onEscolher,
  justificativa,
  onJustificar,
  exigePc,
  copiaDefasada,
  compactoNota = null,
  justificativaNaNota = false,
}: PedidoCompraBlocoProps) {
  const base = useId();
  const grupo = `${base}-pc`;
  /** o operador abriu (ou fechou) "Outros PCs do fornecedor"; a escolha em "outros" abre sozinha, abaixo */
  const [outrosAberto, setOutrosAberto] = useState(false);
  /** o operador abriu "Trocar" na linha compacta */
  const [trocando, setTrocando] = useState(false);
  const compacto = compactoNota != null;
  const raiz = useRef<HTMLDivElement>(null);
  const idOpcoes = `${base}-opcoes`;
  useLayoutEffect(() => {
    // o item deixou de seguir o pedido da nota (escolheu outro): ao voltar a seguir, a linha compacta volta fechada
    if (!compacto) {
      setTrocando(false);
      return;
    }
    // o item passou a seguir o pedido da nota por uma escolha feita nas proprias opcoes: ocultar as opcoes com o foco dentro
    // jogaria o foco no <body>; fica aberto ate o operador fechar
    if (raiz.current?.contains(document.activeElement)) setTrocando(true);
  }, [compacto]);

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
  const { candidatos, outros, aguardando, incompativeis } = pcListas(pc);
  /**
   * A escolha efetiva esta em "outros do fornecedor" (ex.: a nota foi recarregada e o PC escolhido passou para la):
   * a lista abre sozinha para a opcao marcada aparecer ao lado do campo de justificativa.
   */
  const escolhaEmOutros = escolha != null && outros.some((o) => mesmoPc(o, escolha));
  const divergentes = pc.vinculosDivergentes === true;
  const motivosJust = textoMotivosJustificativa(just);
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

  const opcoes = (
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

      {incompativeis.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {incompativeis.map((c) => (
            <OpcaoPc
              key={`${c.nCodPed}-${c.nCodItem}`}
              c={c}
              grupo={grupo}
              selecionado={false}
              desabilitado
              selos={[{ texto: 'Unidade diferente da nota', cls: SELO_AMBAR, title: TITLE_UNIDADE_DIFERENTE }]}
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

      {justificativaNaNota ? (
        !compacto && <p className="mt-3 text-xs text-atlas-muted">A justificativa deste item é a do pedido de compra da nota.</p>
      ) : (
        just.obrigatoria && (
          <div className="mt-3">
            <label htmlFor={`${base}-just`} className="block text-xs font-medium text-atlas-muted mb-1">
              Justificativa da escolha do PC <span aria-hidden="true">*</span>
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
        )
      )}
    </fieldset>
  );

  // A lista de opcoes fica SEMPRE na mesma posicao da arvore (so o `hidden` e a linha compacta mudam): se ela fosse remontada ao
  // alternar entre compacto e aberto, o radio que o operador acabou de marcar perderia o foco.
  const produto = compactoNota?.produtoDescricao.trim() ?? '';
  return (
    <div ref={raiz} className={compacto ? 'mt-3' : undefined}>
      <div className={compacto ? 'rounded border border-atlas-border' : undefined}>
        {compactoNota && (
          <button
            type="button"
            aria-expanded={trocando}
            aria-controls={idOpcoes}
            onClick={() => setTrocando((v) => !v)}
            className="flex w-full cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-1 rounded px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-atlas-btn-bg"
          >
            <span className="text-[11px] uppercase tracking-wide text-atlas-muted">Pedido de compra</span>
            <span className={`text-atlas-ink ${compactoNota.pcNumero.trim() ? 'font-mono' : ''}`}>{rotuloPc(compactoNota.pcNumero)}</span>
            {produto && (
              <>
                <span aria-hidden="true" className="text-atlas-muted">
                  ·
                </span>
                <span className="break-words text-atlas-ink">{produto}</span>
              </>
            )}
            <span aria-hidden="true" className="text-atlas-muted">
              ·
            </span>
            <span className="text-xs text-atlas-muted underline">
              {trocando ? 'Fechar' : 'Trocar'}
              <span className="sr-only"> {trocando ? 'as opções de pedido de compra' : 'o pedido de compra'} do item {descricaoItem}</span>
            </span>
          </button>
        )}
        <div id={idOpcoes} hidden={compacto && !trocando} className={compacto ? 'border-t border-atlas-border px-3 pb-3' : undefined}>
          {opcoes}
        </div>
      </div>
      {compacto && justificativaNaNota && <p className="mt-1 text-xs text-atlas-muted">A justificativa deste item é a do pedido de compra da nota.</p>}
    </div>
  );
}
