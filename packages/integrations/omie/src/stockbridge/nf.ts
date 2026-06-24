import { callOmie, isMockMode, type OmieCnpj } from '../client.js';
import { mockConsultarNF } from './mock.js';

export interface ConsultarNFResponse {
  nNF: number;
  cChaveNFe: string;
  dEmi: string;
  nCodProd: number;
  codigoLocalEstoque: string;
  qCom: number;
  uCom: string;
  xProd: string;
  vUnCom: number;
  vNF: number;
  nCodCli: number;
  cRazao: string;
  /**
   * `true` quando a NF está fiscalmente inválida (cancelada/inutilizada/denegada).
   * Derivado do OR dos sinais em `sinaisCancelamento`. Feature 012 (ACXEGDP-204).
   */
  cancelada: boolean;
  /** Sinais brutos de invalidade preservados para log/diagnóstico/alerta. */
  sinaisCancelamento: { dCan?: string; dInut?: string; cDeneg?: string };
  /** Tipo de operação: 0=entrada, 1=saída. `undefined` se ausente → indeterminado. */
  tpNF?: number;
  /** Emitente da NF (CNPJ ou razão). `undefined` se ausente → indeterminado. Feature 012 (ACXEGDP-205). */
  cnpjEmitente?: string;
}

/**
 * Consulta uma NF por numero no OMIE ACXE ou Q2P.
 * Usa endpoint produtos/nfconsultar/ -> ConsultarNF.
 */
export async function consultarNF(cnpj: OmieCnpj, numeroNota: number): Promise<ConsultarNFResponse> {
  if (isMockMode()) {
    return mockConsultarNF(cnpj, numeroNota);
  }

  const raw = await callOmie<RawConsultarNF>(cnpj, {
    endpoint: 'produtos/nfconsultar/',
    method: 'ConsultarNF',
    params: { nCodNF: 0, nNF: numeroNota },
  });

  const det = raw.det?.[0];
  if (!det || !det.prod || !det.nfProdInt) {
    throw new Error(`NF ${numeroNota} nao possui itens ou estrutura invalida no OMIE`);
  }

  // Sinais de invalidade fiscal (feature 012 / ACXEGDP-184): dCan (cancelamento),
  // dInut (inutilizacao), cDeneg (denegacao). Lidos do mesmo retorno ao vivo.
  const dCan = raw.ide.dCan;
  const dInut = raw.ide.dInut;
  const cDeneg = raw.ide.cDeneg ?? raw.compl.cDeneg;
  const cancelada = Boolean(dCan || dInut || cDeneg);

  return {
    nNF: raw.ide.nNF,
    cChaveNFe: raw.compl.cChaveNFe,
    dEmi: raw.ide.dEmi,
    nCodProd: det.nfProdInt.nCodProd,
    codigoLocalEstoque: det.prod.codigo_local_estoque,
    qCom: det.prod.qCom,
    uCom: det.prod.uCom,
    xProd: det.prod.xProd,
    vUnCom: det.prod.vUnCom,
    vNF: raw.total.ICMSTot.vNF,
    nCodCli: raw.nfDestInt.nCodCli,
    cRazao: raw.nfDestInt.cRazao,
    cancelada,
    sinaisCancelamento: { dCan, dInut, cDeneg },
    tpNF: raw.ide.tpNF,
    cnpjEmitente: raw.nfEmitInt?.cnpj ?? raw.nfEmitInt?.cRazao,
  };
}

interface RawConsultarNF {
  ide: { nNF: number; dEmi: string; dCan?: string; dInut?: string; cDeneg?: string; tpNF?: number };
  compl: { cChaveNFe: string; cDeneg?: string };
  det: Array<{
    prod: {
      codigo_local_estoque: string;
      qCom: number;
      uCom: string;
      xProd: string;
      vUnCom: number;
    };
    nfProdInt: { nCodProd: number };
  }>;
  total: { ICMSTot: { vNF: number } };
  nfEmitInt?: { cnpj?: string; cRazao?: string };
  nfDestInt: { nCodCli: number; cRazao: string };
}
