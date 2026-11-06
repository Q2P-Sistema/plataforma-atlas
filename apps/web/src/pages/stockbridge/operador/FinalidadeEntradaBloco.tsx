import { useId } from 'react';
import { ROTULO_EMPRESA, type Empresa } from '../labels.js';
import { RADIO_CLS } from './PedidoCompraBloco.js';

/**
 * Feature 017 (ACXEGDP-437, research D23, 06/11/2026) — finalidade da compra no recebimento FISCAL da NF nacional.
 *
 * Quando o Atlas conclui o fiscal no OMIE, o CFOP de entrada vinha da sugestao do proprio OMIE. Na NF 979 da ACXE (Solutec,
 * fornecedor 6.101) a sugestao foi 2.102 (comercializacao), mas a ACXE compra para industrializacao (2.101): o financeiro corrigiu a
 * nota de entrada a mao. Agora o operador escolhe a FINALIDADE, uma vez por NF (vale para todos os itens):
 *  - Industrializacao = final 101; Comercializacao = final 102;
 *  - pre-selecionada pela empresa da NF (ACXE = industrializacao, Q2P = comercializacao);
 *  - o 1o digito (1 = mesmo estado, 2 = outro estado, 3 = importacao) e o do CFOP sugerido pelo OMIE: o Atlas so troca o final;
 *  - CFOP sugerido fora de x.101/x.102 (uso e consumo x.556, outros) nao muda.
 *
 * `cfopEntradaParaFinalidade` e a MESMA regra de `modules/stockbridge/src/services/cfop-entrada.ts` (regex ^([123])\.10[12]$): aqui
 * ela so alimenta a previa do CFOP em cada opcao; quem decide o que vai ao OMIE e o servidor, que le o CFOP sugerido ao vivo.
 */

export type FinalidadeEntrada = 'industrializacao' | 'comercializacao';

export const FINALIDADES_ENTRADA: readonly FinalidadeEntrada[] = ['industrializacao', 'comercializacao'];

export const ROTULO_FINALIDADE: Record<FinalidadeEntrada, string> = {
  industrializacao: 'Industrialização',
  comercializacao: 'Comercialização',
};

/** Final do CFOP de entrada de cada finalidade. */
const FINAL_CFOP: Record<FinalidadeEntrada, '101' | '102'> = { industrializacao: '101', comercializacao: '102' };

/** CFOP no recorte que o Atlas troca: 1o digito 1, 2 ou 3 e final 101 ou 102, com ponto. */
const CFOP_TROCAVEL = /^([123])\.10[12]$/;

export function ehFinalidadeEntrada(v: unknown): v is FinalidadeEntrada {
  return v === 'industrializacao' || v === 'comercializacao';
}

/**
 * CFOP de entrada que o Atlas manda para a finalidade, a partir do CFOP sugerido pelo OMIE ("2.102" + industrializacao -> "2.101").
 * null quando o sugerido esta fora de x.101/x.102 ou ausente: o Atlas nao mexe nele.
 */
export function cfopEntradaParaFinalidade(cfopSugerido: string | null | undefined, finalidade: FinalidadeEntrada): string | null {
  if (typeof cfopSugerido !== 'string') return null;
  const m = CFOP_TROCAVEL.exec(cfopSugerido.trim());
  return m ? `${m[1]}.${FINAL_CFOP[finalidade]}` : null;
}

/** Finalidade pre-selecionada pela empresa da NF (ACXE compra para industrializar, Q2P para revender). */
export function finalidadePadraoDaEmpresa(empresa: Empresa): FinalidadeEntrada {
  return empresa === 'acxe' ? 'industrializacao' : 'comercializacao';
}

/** Padrao da NF: o que o servidor mandou (`finalidadeEntradaPadrao`) ou, backend sem o campo, o da empresa. */
export function finalidadePadraoDaNf(padraoServidor: unknown, empresa: Empresa): FinalidadeEntrada {
  return ehFinalidadeEntrada(padraoServidor) ? padraoServidor : finalidadePadraoDaEmpresa(empresa);
}

/** Valor que vale na tela e no POST: a escolha do operador ou, enquanto ele nao mexeu, o padrao da NF. */
export function finalidadeEfetiva(escolhida: FinalidadeEntrada | undefined, padrao: FinalidadeEntrada): FinalidadeEntrada {
  return escolhida ?? padrao;
}

export interface CfopsPrevistos {
  /** CFOPs de entrada que resultam da finalidade, sem repetir, em ordem crescente (ex.: ["1.101", "2.101"]) */
  cfops: string[];
  /** quantos itens ficam como o OMIE sugeriu (CFOP fora de x.101/x.102 ou ausente) */
  mantidos: number;
}

/** Previa do CFOP de entrada de cada item para a finalidade: os distintos que o Atlas mandaria e quantos itens ficam como estao. */
export function cfopsPrevistos(cfopsSugeridos: ReadonlyArray<string | null | undefined>, finalidade: FinalidadeEntrada): CfopsPrevistos {
  const distintos = new Set<string>();
  let mantidos = 0;
  for (const sugerido of cfopsSugeridos) {
    const alvo = cfopEntradaParaFinalidade(sugerido, finalidade);
    if (alvo) distintos.add(alvo);
    else mantidos += 1;
  }
  return { cfops: Array.from(distintos).sort(), mantidos };
}

/** Item do rastro devolvido pelo POST (`fiscal.cfopsEntrada`, o mesmo gravado no ledger). */
export interface CfopEntradaResultado {
  nSequencia: number;
  cfopSugerido: string | null;
  cfopAlvo: string | null;
  enviado: boolean;
}

/** O CFOP do item ja estava no alvo da finalidade (o Atlas nao precisou manda-lo). */
const jaNoAlvo = (c: CfopEntradaResultado) => c.cfopAlvo != null && (c.cfopSugerido ?? '').trim() === c.cfopAlvo;

/**
 * CFOPs de entrada com que os itens do recorte ficam neste envio — os enviados ao OMIE e os que ja estavam no alvo
 * (o servidor so manda o CFOP quando ele muda) —, distintos e em ordem crescente.
 */
export function cfopsFinais(cfopsEntrada: ReadonlyArray<CfopEntradaResultado> | null | undefined): string[] {
  const distintos = new Set<string>();
  for (const c of cfopsEntrada ?? []) if (c.cfopAlvo && (c.enviado || jaNoAlvo(c))) distintos.add(c.cfopAlvo);
  return Array.from(distintos).sort();
}

/** Itens em que a finalidade NAO foi aplicada: tinham CFOP a trocar mas nao receberam o EDITAR (ja ignorados no OMIE). */
export function cfopsNaoAplicados(cfopsEntrada: ReadonlyArray<CfopEntradaResultado> | null | undefined): CfopEntradaResultado[] {
  return (cfopsEntrada ?? []).filter((c) => c.cfopAlvo != null && !c.enviado && !jaNoAlvo(c));
}

/** "A" | "A e B" | "A, B e C" */
function listaPt(partes: string[]): string {
  if (partes.length <= 1) return partes[0] ?? '';
  return `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}`;
}

/** CFOPs em fonte monoespacada, separados por virgula e "e". */
function CfopsMono({ cfops }: { cfops: string[] }) {
  return (
    <>
      {cfops.map((c, i) => (
        <span key={c}>
          {i > 0 && (i === cfops.length - 1 ? ' e ' : ', ')}
          <span className="font-mono text-atlas-ink">{c}</span>
        </span>
      ))}
    </>
  );
}

interface OpcaoFinalidadeProps {
  finalidade: FinalidadeEntrada;
  grupo: string;
  selecionada: boolean;
  padrao: boolean;
  empresa: Empresa;
  previa: CfopsPrevistos;
  omieDaNf: string;
  onEscolher: (f: FinalidadeEntrada) => void;
}

function OpcaoFinalidade({ finalidade, grupo, selecionada, padrao, empresa, previa, omieDaNf, onEscolher }: OpcaoFinalidadeProps) {
  const id = useId();
  const idTitulo = `${id}-titulo`;
  const idDetalhe = `${id}-detalhe`;
  const borda = selecionada ? 'border-atlas-btn-bg ring-1 ring-atlas-btn-bg' : 'border-atlas-border';
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded border bg-atlas-card p-3 focus-within:ring-2 focus-within:ring-atlas-btn-bg ${borda}`}>
      <input
        type="radio"
        name={grupo}
        value={finalidade}
        checked={selecionada}
        onChange={() => onEscolher(finalidade)}
        aria-labelledby={idTitulo}
        aria-describedby={idDetalhe}
        className={RADIO_CLS}
      />
      <span className="min-w-0 flex-1">
        <span id={idTitulo} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm text-atlas-ink">{ROTULO_FINALIDADE[finalidade]}</span>
          {padrao && <span className="text-[11px] text-atlas-muted">padrão da {ROTULO_EMPRESA[empresa]}</span>}
        </span>
        <span id={idDetalhe} className="mt-1 block text-xs text-atlas-muted">
          {previa.cfops.length > 0 ? (
            <>
              {previa.cfops.length > 1 ? 'CFOPs' : 'CFOP'} de entrada <CfopsMono cfops={previa.cfops} />
              {previa.mantidos > 0 && (
                <>
                  {' '}
                  · {previa.mantidos === 1 ? 'outro item mantém' : 'outros itens mantêm'} o CFOP sugerido pelo {omieDaNf}
                </>
              )}
            </>
          ) : (
            <>Mantém o CFOP de entrada sugerido pelo {omieDaNf}</>
          )}
        </span>
      </span>
    </label>
  );
}

export interface FinalidadeEntradaBlocoProps {
  /** finalidade que vale agora (`finalidadeEfetiva`) */
  valor: FinalidadeEntrada;
  /** a que vem pre-selecionada (`finalidadePadraoDaNf`) — ganha o texto "padrão da ACXE/Q2P" */
  padrao: FinalidadeEntrada;
  empresa: Empresa;
  /** CFOP sugerido pelo OMIE de cada item que sera recebido neste envio (`itens[].cfop` do detalhe) */
  cfopsSugeridos: ReadonlyArray<string | null | undefined>;
  /** "OMIE" ou "OMIE da ACXE", como o resto da tela */
  omieDaNf: string;
  onEscolher: (f: FinalidadeEntrada) => void;
}

/**
 * Campo por NF, obrigatorio, so aparece quando o Atlas conclui o fiscal e o CFOP de entrada esta habilitado. Duas opcoes em cartao,
 * cada uma com o CFOP de entrada que resulta (previa a partir do CFOP sugerido pelo OMIE de cada item).
 */
export function FinalidadeEntradaBloco({ valor, padrao, empresa, cfopsSugeridos, omieDaNf, onEscolher }: FinalidadeEntradaBlocoProps) {
  const base = useId();
  const grupo = `${base}-finalidade`;
  const idAjuda = `${base}-ajuda`;
  return (
    <fieldset className="mb-4 min-w-0 rounded-lg border border-atlas-border bg-atlas-card p-4" aria-describedby={idAjuda}>
      <legend className="px-1 text-sm font-medium text-atlas-ink">
        Finalidade da compra <span aria-hidden="true">*</span>
        <span className="sr-only"> (obrigatório)</span>
      </legend>
      <p id={idAjuda} className="mb-3 text-xs text-atlas-muted">
        Define o CFOP de entrada do recebimento fiscal no {omieDaNf}. Vale para todos os itens da nota; o Atlas só troca o final do CFOP sugerido pelo {omieDaNf} (101
        para industrialização, 102 para comercialização).
      </p>
      <div className="flex flex-col gap-2">
        {FINALIDADES_ENTRADA.map((f) => (
          <OpcaoFinalidade
            key={f}
            finalidade={f}
            grupo={grupo}
            selecionada={valor === f}
            padrao={padrao === f}
            empresa={empresa}
            previa={cfopsPrevistos(cfopsSugeridos, f)}
            omieDaNf={omieDaNf}
            onEscolher={onEscolher}
          />
        ))}
      </div>
    </fieldset>
  );
}

/** "CFOP de entrada: 2.101 (industrialização)" — linha do resultado pos-envio; null quando a finalidade nao vale para nenhum item. */
export function textoCfopResultado(cfopsEntrada: ReadonlyArray<CfopEntradaResultado> | null | undefined, finalidade: FinalidadeEntrada | null | undefined): string | null {
  const cfops = cfopsFinais(cfopsEntrada);
  if (cfops.length === 0) return null;
  const complemento = ehFinalidadeEntrada(finalidade) ? ` (${ROTULO_FINALIDADE[finalidade].toLowerCase()})` : '';
  return `${cfops.length > 1 ? 'CFOPs' : 'CFOP'} de entrada: ${listaPt(cfops)}${complemento}`;
}

/**
 * Aviso do resultado quando a finalidade nao valeu para algum item (ja ignorado no recebimento do OMIE, sem EDITAR):
 * "1 item ficou com o CFOP de entrada 2.102 no OMIE da ACXE, porque já estava ignorado no recebimento. Confira com o fiscal."
 */
export function textoCfopNaoAplicado(cfopsEntrada: ReadonlyArray<CfopEntradaResultado> | null | undefined, omieDaNf: string): string | null {
  const itens = cfopsNaoAplicados(cfopsEntrada);
  if (itens.length === 0) return null;
  const atuais = Array.from(new Set(itens.map((c) => (c.cfopSugerido ?? '').trim()).filter(Boolean))).sort();
  const sujeito = itens.length === 1 ? '1 item ficou' : `${itens.length} itens ficaram`;
  const rotuloCfop = atuais.length > 1 ? 'os CFOPs de entrada' : 'o CFOP de entrada';
  const motivo = itens.length === 1 ? 'já estava ignorado' : 'já estavam ignorados';
  return `${sujeito} com ${rotuloCfop} ${listaPt(atuais)} no ${omieDaNf}, porque ${motivo} no recebimento. Confira com o fiscal.`;
}
