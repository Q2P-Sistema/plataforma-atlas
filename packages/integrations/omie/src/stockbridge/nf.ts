import { callOmie, isMockMode, type OmieCnpj } from '../client.js';
import { mockConsultarNF } from './mock.js';

/**
 * Feature 013 (ACXEGDP-115): a NF pode ter N itens de produto — cada `det[i]`
 * vira um ItemNF. Historico: o modelo herdado do PHP lia so o det[0]
 * silenciosamente (valor unitario inflado + itens 2..n perdidos); o STK-10
 * (ACXEGDP-289) trocou isso por bloqueio explicito; a feature 013 destrava o
 * multi-item de verdade — o consumidor (recebimento) processa item a item.
 */
export interface ItemNF {
  nCodProd: number;
  codigoLocalEstoque: string;
  qCom: number;
  uCom: string;
  xProd: string;
  vUnCom: number;
}

export interface ConsultarNFResponse {
  nNF: number;
  cChaveNFe: string;
  dEmi: string;
  /** Valor total da NF (com tributos) — do cabecalho (ICMSTot), nao por item. */
  vNF: number;
  nCodCli: number;
  cRazao: string;
  /** 1..N itens de produto da NF, na ordem do det[] do OMIE. */
  itens: ItemNF[];
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
  }, { retries: 2 }); // STK-23: leitura idempotente — retry em falha transiente

  const dets = raw.det ?? [];
  const itens: ItemNF[] = dets
    .filter((det) => det?.prod && det?.nfProdInt)
    .map((det) => ({
      nCodProd: det.nfProdInt.nCodProd,
      codigoLocalEstoque: det.prod.codigo_local_estoque,
      qCom: det.prod.qCom,
      uCom: det.prod.uCom,
      xProd: det.prod.xProd,
      vUnCom: det.prod.vUnCom,
    }));
  if (itens.length === 0) {
    throw new Error(`NF ${numeroNota} nao possui itens ou estrutura invalida no OMIE`);
  }

  return {
    nNF: raw.ide.nNF,
    cChaveNFe: raw.compl.cChaveNFe,
    dEmi: raw.ide.dEmi,
    vNF: raw.total.ICMSTot.vNF,
    nCodCli: raw.nfDestInt.nCodCli,
    cRazao: raw.nfDestInt.cRazao,
    itens,
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
