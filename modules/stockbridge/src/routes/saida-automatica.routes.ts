import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireIntegrationKey } from '../middleware/integration-key.js';
import { processarSaidaAutomatica } from '../services/saida-automatica.service.js';

const logger = createLogger('stockbridge:saida-automatica');
const router: Router = Router();

// Normaliza a unidade vinda do OMIE (uCom), que chega em MAIUSCULA e em formas
// variadas (KG, TON, SC, BG), para o enum canonico. Unidade desconhecida NAO cai
// em kg silenciosamente: fica crua e o enum a rejeita com 400 (STK-05, ACXEGDP-285).
const unidadeSchema = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const u = v.trim().toLowerCase();
  const alias: Record<string, string> = {
    t: 't', ton: 't', tonelada: 't', toneladas: 't',
    kg: 'kg', quilo: 'kg', quilos: 'kg', kilo: 'kg', kilos: 'kg',
    saco: 'saco', sc: 'saco', sacos: 'saco',
    bigbag: 'bigbag', 'big bag': 'bigbag', bb: 'bigbag', bg: 'bigbag',
  };
  return alias[u] ?? u;
}, z.enum(['t', 'kg', 'saco', 'bigbag']));

const BodySchema = z.object({
  nf: z.string().min(1),
  tipo_omie: z.enum(['venda', 'remessa_beneficiamento', 'transf_cnpj', 'devolucao_fornecedor']),
  cnpj_emissor: z.enum(['acxe', 'q2p']),
  // OMIE pode enviar codigos/quantidades como string — coerce aceita "123" e 123.
  produto_codigo: z.coerce.number().int().positive(),
  quantidade_original: z.coerce.number().positive(),
  unidade: unidadeSchema,
  localidade_origem_codigo: z.coerce.number().int().positive(),
  // OMIE emite a data como dd/MM/aaaa (campo dEmi). Validar o formato aqui evita
  // que o parse no service caia em Invalid Date (dia>12) ou troque dia/mes
  // silenciosamente via new Date() (STK-04, ACXEGDP-284).
  dt_emissao: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, 'dt_emissao deve estar no formato dd/MM/aaaa'),
  id_movest_omie: z.string().min(1),
  id_ajuste_omie: z.string().optional(),
});

/**
 * Endpoint consumido por workflow n8n que faz polling das NFs de saida do OMIE.
 * Exige header `X-Atlas-Integration-Key` (shared secret).
 *
 * Contrato: docs/contracts/api.md "8. Saidas Automaticas — Sistema (n8n)".
 */
router.post(
  '/api/v1/stockbridge/saida-automatica/processar',
  requireIntegrationKey,
  async (req: Request, res: Response) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: {
          code: 'INVALID_INPUT',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
      return;
    }

    try {
      const result = await processarSaidaAutomatica({
        nf: parsed.data.nf,
        tipoOmie: parsed.data.tipo_omie,
        cnpjEmissor: parsed.data.cnpj_emissor,
        produtoCodigo: parsed.data.produto_codigo,
        quantidadeOriginal: parsed.data.quantidade_original,
        unidade: parsed.data.unidade,
        localidadeOrigemCodigo: parsed.data.localidade_origem_codigo,
        dtEmissao: parsed.data.dt_emissao,
        idMovestOmie: parsed.data.id_movest_omie,
        idAjusteOmie: parsed.data.id_ajuste_omie,
      });
      res.json({ data: result, error: null });
    } catch (err) {
      logger.error({ err, nf: parsed.data.nf }, 'Erro ao processar saida automatica');
      res.status(500).json({
        data: null,
        error: { code: 'SAIDA_AUTOMATICA_FAIL', message: (err as Error).message },
      });
    }
  },
);

export default router;
