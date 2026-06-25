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
  };
}

interface RawConsultarNF {
  ide: { nNF: number; dEmi: string };
  compl: { cChaveNFe: string };
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
  nfDestInt: { nCodCli: number; cRazao: string };
}
