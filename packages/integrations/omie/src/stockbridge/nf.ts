import { callOmie, isMockMode, type OmieCnpj } from '../client.js';
import { mockConsultarNF } from './mock.js';

/**
 * STK-10 (ACXEGDP-289): NF com mais de um item de produto. O modelo do
 * StockBridge (herdado do legado PHP) pressupoe 1 produto por NF — ler so o
 * det[0] silenciosamente inflava o valor unitario (vNF total / qtd do item 1)
 * e os itens 2..n nunca entravam em estoque. Ate multi-item virar feature,
 * rejeitamos explicitamente.
 */
export class NotaFiscalMultiItemError extends Error {
  constructor(
    public readonly notaFiscal: number,
    public readonly totalItens: number,
  ) {
    super(
      `A NF ${notaFiscal} tem ${totalItens} itens de produto — o recebimento suporta apenas NF de item único. ` +
        'Contate o admin para processar esta NF manualmente.',
    );
    this.name = 'NotaFiscalMultiItemError';
  }
}

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
  }, { retries: 2 }); // STK-23: leitura idempotente — retry em falha transiente

  // STK-10: det[0] silencioso mascarava NF multi-item (valor unitario inflado
  // pelo vNF total + itens 2..n perdidos). Rejeita explicito.
  if ((raw.det?.length ?? 0) > 1) {
    throw new NotaFiscalMultiItemError(numeroNota, raw.det!.length);
  }
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
