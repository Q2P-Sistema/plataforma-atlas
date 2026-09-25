/**
 * Unidade de medida dos itens de NF nacional (feature 015, ACXEGDP-328).
 *
 * Duas coisas, deliberadamente separadas de `FATOR_PARA_KG`/`converterParaKg`
 * (unidades do Atlas: t/kg/saco/bigbag) e de `normalizarUnidade` da importacao
 * (que assume `kg` no default e carrega risco documentado de erro de 1000x):
 *
 *  1. Tabela EXPLICITA de grafias que aparecem em `tbl_nf_itens_Q2P.u_com` no
 *     recorte de CFOP da feature: KG, TON, TL. Qualquer outra grafia BLOQUEIA o
 *     item — nunca NaN, nunca fator default (research D5, D15).
 *
 *  2. Conferencia de coerencia entre unidade declarada e quantidade (D24): ha
 *     itens rotulados KG cuja quantidade esta em toneladas (NF 58067, Zaraplast:
 *     q_com=1,375 KG a R$ 14.350 "por quilo" — e tonelada). Convertidos pela
 *     tabela entrariam com 1/1000 da quantidade. A conferencia compara as DUAS
 *     leituras da mesma linha: o R$/kg pela unidade declarada e o R$/kg pela
 *     leitura alternativa (KG<->tonelada). Declarada plausivel -> converte;
 *     declarada implausivel e alternativa plausivel -> CONTRADICAO, bloqueia;
 *     nenhuma plausivel -> INCONCLUSIVO, bloqueia. Medido em 1.626 itens de
 *     2026: 1.612 liberados, 14 bloqueados por contradicao, 0 inconclusivos.
 *
 *     NAO e faixa de preco absoluto: isso reprovaria papelao a R$ 0,35/kg em KG
 *     e sucata rigida a R$ 300/t em TON — material barato, nao unidade errada.
 *
 * O sistema detecta a contradicao mas NAO sabe qual campo esta errado (unidade
 * ou quantidade). Escolher seria adivinhar num fluxo que move estoque e dinheiro;
 * por isso bloqueia e deixa a conferencia humana (caminho manual) decidir.
 */

export type UnidadeNf = 'KG' | 'TON' | 'TL';

/** Fator explicito por grafia da NF. TL = tonelada (confirmado por preco, D5/D17). */
export const FATOR_UNIDADE_NF: Readonly<Record<UnidadeNf, number>> = Object.freeze({
  KG: 1,
  TON: 1000,
  TL: 1000,
});

/** Faixa de R$/kg plausivel para plastico/resina/sucata (D24). */
export const RS_POR_KG_PLAUSIVEL = Object.freeze({ min: 0.1, max: 100 });

export type LeituraUnidade = 'kg' | 'tonelada';

export type ConversaoNfOk = {
  ok: true;
  unidade: UnidadeNf;
  fator: number;
  quantidadeKg: number;
  /** R$/kg resultante da leitura declarada — util para exibicao e para o custo. */
  rsPorKg: number;
};

export type ConversaoNfBloqueio =
  | {
      ok: false;
      motivo: 'unidade_nao_conversivel';
      unidadeOriginal: string;
      mensagem: string;
    }
  | {
      ok: false;
      motivo: 'unidade_incoerente';
      unidadeOriginal: string;
      leituraDeclarada: LeituraUnidade;
      leituraAlternativa: LeituraUnidade;
      rsPorKgDeclarado: number;
      rsPorKgAlternativo: number;
      mensagem: string;
    }
  | {
      ok: false;
      motivo: 'unidade_inconclusiva';
      unidadeOriginal: string;
      rsPorKgDeclarado: number;
      rsPorKgAlternativo: number;
      mensagem: string;
    }
  | {
      ok: false;
      motivo: 'quantidade_invalida';
      unidadeOriginal: string;
      mensagem: string;
    };

export type ConversaoNf = ConversaoNfOk | ConversaoNfBloqueio;

/** Grafia da NF normalizada: trim + caixa alta. "kg ", " Ton" -> "KG", "TON". */
export function normalizarGrafiaUnidadeNf(raw: string | null | undefined): string {
  return (raw ?? '').trim().toUpperCase();
}

/** `true` se a grafia esta na tabela explicita. Nao infere nada. */
export function isUnidadeNfConhecida(raw: string | null | undefined): raw is UnidadeNf {
  const u = normalizarGrafiaUnidadeNf(raw);
  return u === 'KG' || u === 'TON' || u === 'TL';
}

function plausivel(rsPorKg: number): boolean {
  return Number.isFinite(rsPorKg) && rsPorKg >= RS_POR_KG_PLAUSIVEL.min && rsPorKg <= RS_POR_KG_PLAUSIVEL.max;
}

const fmtBrl = (v: number): string =>
  Number.isFinite(v) ? v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

/**
 * Converte um item da NF para Kg, aplicando a tabela explicita E a conferencia
 * de coerencia. Nunca lanca; nunca devolve NaN; nunca converte por aproximacao.
 *
 * @param quantidade  `q_com` da NF, na unidade declarada
 * @param unidadeRaw  `u_com` da NF, como veio
 * @param valorTotal  valor do item da NF (R$), de `i.v_prod` — base do preco
 *                    implicito. NAO `v_tot_item`, que soma o IPI duas vezes
 *                    (D26). A troca nao muda nenhum veredito: medido em PROD,
 *                    1.633 liberados / 14 bloqueados com os dois campos.
 */
export function converterItemNfParaKg(
  quantidade: number,
  unidadeRaw: string | null | undefined,
  valorTotal: number,
): ConversaoNf {
  const unidadeOriginal = normalizarGrafiaUnidadeNf(unidadeRaw);

  if (!isUnidadeNfConhecida(unidadeOriginal)) {
    return {
      ok: false,
      motivo: 'unidade_nao_conversivel',
      unidadeOriginal: unidadeOriginal || '(vazia)',
      mensagem: `Unidade "${unidadeOriginal || '(vazia)'}" não é conversível para kg. Este item precisa ser recebido pelo formulário manual.`,
    };
  }

  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    return {
      ok: false,
      motivo: 'quantidade_invalida',
      unidadeOriginal,
      mensagem: `Quantidade declarada na NF (${String(quantidade)}) não é positiva. Este item precisa ser recebido pelo formulário manual.`,
    };
  }

  const fator = FATOR_UNIDADE_NF[unidadeOriginal];
  const leituraDeclarada: LeituraUnidade = fator === 1 ? 'kg' : 'tonelada';
  const leituraAlternativa: LeituraUnidade = fator === 1 ? 'tonelada' : 'kg';
  const fatorAlternativo = fator === 1 ? 1000 : 1;

  // R$/kg por cada leitura. valorTotal <= 0 torna as duas leituras 0 -> inconclusivo.
  const rsPorKgDeclarado = Number.isFinite(valorTotal) ? valorTotal / (quantidade * fator) : NaN;
  const rsPorKgAlternativo = Number.isFinite(valorTotal) ? valorTotal / (quantidade * fatorAlternativo) : NaN;

  if (plausivel(rsPorKgDeclarado)) {
    return {
      ok: true,
      unidade: unidadeOriginal,
      fator,
      quantidadeKg: quantidade * fator,
      rsPorKg: rsPorKgDeclarado,
    };
  }

  if (plausivel(rsPorKgAlternativo)) {
    return {
      ok: false,
      motivo: 'unidade_incoerente',
      unidadeOriginal,
      leituraDeclarada,
      leituraAlternativa,
      rsPorKgDeclarado,
      rsPorKgAlternativo,
      mensagem:
        `A unidade declarada (${unidadeOriginal}) contradiz a quantidade: lida como ${leituraDeclarada} dá ` +
        `R$ ${fmtBrl(rsPorKgDeclarado)}/kg; lida como ${leituraAlternativa} dá R$ ${fmtBrl(rsPorKgAlternativo)}/kg. ` +
        `O sistema não escolhe qual está certa — confira na NF e receba pelo formulário manual.`,
    };
  }

  return {
    ok: false,
    motivo: 'unidade_inconclusiva',
    unidadeOriginal,
    rsPorKgDeclarado,
    rsPorKgAlternativo,
    mensagem:
      `Não foi possível validar a unidade (${unidadeOriginal}): nenhuma leitura produz um preço por quilo plausível ` +
      `(R$ ${fmtBrl(rsPorKgDeclarado)}/kg ou R$ ${fmtBrl(rsPorKgAlternativo)}/kg). Confira na NF e receba pelo formulário manual.`,
  };
}
