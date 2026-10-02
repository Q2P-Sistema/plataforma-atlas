import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireOperador, requireGestor } from '../middleware/role.js';
import { requireArmazemVinculado } from '../middleware/armazem-vinculado.js';
import type { Perfil } from '../types.js';
import {
  listarLocalidadesNacional,
  buscarProdutosNacional,
  processarRecebimentoNacional,
  processarRecebimentoNacionalPorNf,
  LocalidadeNaoElegivelError,
  ProdutoNaoEncontradoError,
  ValidacaoRecebimentoNacionalError,
  NfNacionalJaProcessadaError,
} from '../services/recebimento-nacional.service.js';
import {
  getFilaNacional,
  getDetalheNfNacional,
  recebimentoFiscalHabilitado,
  DataCorteNaoConfiguradaError,
  NfNacionalNaoEncontradaError,
  NfNacionalDispensadaError,
  NfNacionalCanceladaError,
  FornecedorExcluidoError,
  FilaNacionalIncompletaError,
  ehTabelaAusente,
} from '../services/fila-nacional.service.js';
import { definirConjuntoCorrelacao } from '../services/correlacao-produto.service.js';
import {
  RecebimentoFiscalError,
  RecebimentoFiscalEmAndamentoError,
  RecebimentoFiscalAguardeError,
  RecebimentoFiscalSemFornecedorError,
  RecebimentoFiscalNfCanceladaError,
  RecebimentoFiscalEtapaInesperadaError,
  segundosAteNovaTentativa,
  listarLedgerFiscal,
} from '../services/recebimento-fiscal.service.js';
import {
  dispensarNf,
  listarDispensas,
  reverterDispensa,
  RecebimentoFiscalDesabilitadoError,
  NfNaoDispensavelError,
  NfJaDispensadaError,
  DispensaNaoEncontradaError,
  DispensaNaoPermitidaError,
  MotivoDispensaObrigatorioError,
  NfEmRecebimentoFiscalError,
} from '../services/nf-dispensa.service.js';
import {
  solicitarRecebimentoExterno,
  recebimentoExternoHabilitado,
  RecebimentoExternoDesabilitadoError,
  MotivoObrigatorioError,
  ItemJaRecebidoError,
  NenhumItemPendenteError,
  ItemNaoCorrespondeError,
  BaixaExternaFiscalPendenteError,
} from '../services/recebimento-externo.service.js';

const logger = createLogger('stockbridge:recebimento-nacional');
const router: Router = Router();

// Payload invalido e sempre defeito de cliente (UI desatualizada, chamada fora
// da tela). O detalhe Zod fica em `message`; o operador ve so isto.
const USER_MSG_INVALID = 'Não foi possível processar o pedido — os dados enviados são inválidos. Recarregue a página e tente de novo.';

const EmpresaSchema = z.enum(['acxe', 'q2p']);

const LocalidadesQuerySchema = z.object({
  empresa: EmpresaSchema,
});

router.get(
  '/api/v1/stockbridge/recebimento/nacional/localidades',
  requireOperador,
  async (req: Request, res: Response) => {
    const parsed = LocalidadesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', userMessage: USER_MSG_INVALID, message: parsed.error.issues.map((i) => i.message).join('; ') },
      });
      return;
    }
    try {
      const data = await listarLocalidadesNacional(parsed.data.empresa);
      res.json({ data, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao listar localidades nacional');
      res.status(500).json({
        data: null,
        error: { code: 'LOCALIDADES_NACIONAL_FAIL', message: (err as Error).message },
      });
    }
  },
);

const ProdutosQuerySchema = z.object({
  empresa: EmpresaSchema,
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get(
  '/api/v1/stockbridge/recebimento/nacional/produtos',
  requireOperador,
  async (req: Request, res: Response) => {
    const parsed = ProdutosQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', userMessage: USER_MSG_INVALID, message: parsed.error.issues.map((i) => i.message).join('; ') },
      });
      return;
    }
    try {
      const data = await buscarProdutosNacional({
        empresa: parsed.data.empresa,
        q: parsed.data.q ?? null,
        limit: parsed.data.limit ?? 50,
      });
      res.json({ data, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao buscar produtos nacional');
      res.status(500).json({
        data: null,
        error: { code: 'PRODUTOS_NACIONAL_FAIL', message: (err as Error).message },
      });
    }
  },
);

const ItemSchema = z
  .object({
    produto_codigo_acxe: z.number().int().positive().optional().nullable(),
    produto_codigo_q2p: z.number().int().positive().optional().nullable(),
    empresa: EmpresaSchema,
    localidade_id: z.string().uuid(),
    quantidade: z.number().positive(),
    unidade: z.enum(['t', 'kg', 'saco', 'bigbag']),
    // Peso do rateio (ACXEGDP-178) — não é o custo final do item, só a referência
    // usada para distribuir valor_total_nf_brl proporcionalmente entre os itens.
    valor_unitario_referencia_brl: z.number().positive(),
  })
  .refine(
    (d) =>
      (d.empresa === 'acxe' && d.produto_codigo_acxe != null) ||
      (d.empresa === 'q2p' && d.produto_codigo_q2p != null),
    { message: 'produto_codigo_acxe obrigatório para acxe; produto_codigo_q2p obrigatório para q2p' },
  );

const BodySchema = z.object({
  nf: z.string().min(1).max(50),
  // Valor total da NF (com impostos), informado uma única vez no cabeçalho e
  // rateado entre os itens pelo peso (valor unitário de referência × Kg).
  valor_total_nf_brl: z.number().positive(),
  observacoes: z.string().optional(),
  itens: z.array(ItemSchema).min(1),
});

router.post(
  '/api/v1/stockbridge/recebimento/nacional',
  requireOperador,
  requireArmazemVinculado,
  async (req: Request, res: Response) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: {
          code: 'INVALID_INPUT', userMessage: USER_MSG_INVALID,
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
      return;
    }

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessão sem usuário' } });
      return;
    }

    try {
      const result = await processarRecebimentoNacional({
        notaFiscal: parsed.data.nf,
        valorTotalNfBrl: parsed.data.valor_total_nf_brl,
        observacoes: parsed.data.observacoes ?? null,
        itens: parsed.data.itens.map((it) => ({
          produtoCodigoAcxe: it.produto_codigo_acxe ?? null,
          produtoCodigoQ2p: it.produto_codigo_q2p ?? null,
          empresa: it.empresa,
          localidadeId: it.localidade_id,
          quantidade: it.quantidade,
          unidade: it.unidade,
          valorUnitarioReferenciaBrl: it.valor_unitario_referencia_brl,
        })),
        userId,
      });
      res.status(201).json({ data: result, error: null });
    } catch (err) {
      if (err instanceof LocalidadeNaoElegivelError) {
        res.status(400).json({
          data: null,
          error: { code: 'LOCALIDADE_NAO_ELEGIVEL', message: err.message },
        });
        return;
      }
      if (err instanceof ProdutoNaoEncontradoError) {
        res.status(404).json({
          data: null,
          error: { code: 'PRODUTO_NAO_ENCONTRADO', message: err.message },
        });
        return;
      }
      logger.error({ err, nf: parsed.data.nf }, 'Erro inesperado em recebimento nacional');
      res.status(500).json({
        data: null,
        error: { code: 'RECEBIMENTO_NACIONAL_FAIL', message: (err as Error).message },
      });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Feature 015 (ACXEGDP-328) — recebimento nacional A PARTIR DA NF (espelho)
// As tres rotas acima (localidades/produtos/POST manual) permanecem intactas.
// ═══════════════════════════════════════════════════════════════════════════

/** Erros de dominio da fila/detalhe → HTTP. Mensagens ja em pt-BR, sem codigo OMIE. */
function responderErroFilaNacional(res: Response, err: unknown): boolean {
  if (err instanceof DataCorteNaoConfiguradaError) {
    res.status(503).json({ data: null, error: { code: 'FILA_NACIONAL_NAO_CONFIGURADA', userMessage: err.message, message: err.message } });
    return true;
  }
  // Feature 016 (revisao pre-UAT, MIG-3): tabela ausente (42P01 — migration
  // pendente) e erro de ambiente visivel, nunca 500 generico nem fila vazia.
  if (err instanceof FilaNacionalIncompletaError || ehTabelaAusente(err)) {
    const msg = err instanceof FilaNacionalIncompletaError ? err.message : new FilaNacionalIncompletaError().message;
    logger.error({ err }, 'Recebimento nacional: tabela inexistente (migration pendente?)');
    res.status(503).json({ data: null, error: { code: 'FILA_NACIONAL_NAO_CONFIGURADA', userMessage: msg, message: (err as Error).message } });
    return true;
  }
  if (err instanceof NfNacionalDispensadaError) {
    res.status(404).json({ data: null, error: { code: 'NF_DISPENSADA', userMessage: err.message, message: err.message } });
    return true;
  }
  if (err instanceof NfNacionalNaoEncontradaError) {
    res.status(404).json({ data: null, error: { code: 'NF_NAO_ENCONTRADA', userMessage: err.message, message: err.message } });
    return true;
  }
  if (err instanceof NfNacionalCanceladaError) {
    res.status(422).json({ data: null, error: { code: 'NF_CANCELADA', userMessage: err.message, message: err.message } });
    return true;
  }
  if (err instanceof FornecedorExcluidoError) {
    res.status(422).json({ data: null, error: { code: 'FORNECEDOR_EXCLUIDO', userMessage: err.message, message: err.message } });
    return true;
  }
  return false;
}

const FilaNacionalQuerySchema = z.object({
  q: z.string().max(100).optional(),
  fornecedor: z.string().max(100).optional(),
});

// A data de corte NAO e parametro de requisicao (invariante 10 do contrato):
// e configuracao do ambiente — expor como query permitiria puxar historico que
// a feature decidiu nao cobrir.
router.get(
  '/api/v1/stockbridge/recebimento/nacional/fila',
  requireOperador,
  requireArmazemVinculado,
  async (req: Request, res: Response) => {
    const parsed = FilaNacionalQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ data: null, error: { code: 'INVALID_QUERY', userMessage: USER_MSG_INVALID, message: parsed.error.issues.map((i) => i.message).join('; ') } });
      return;
    }
    try {
      const data = await getFilaNacional({ q: parsed.data.q ?? null, fornecedor: parsed.data.fornecedor ?? null });
      // Feature 016: a UI so mostra o selo fiscal quando a flag esta ligada — vai em `meta`, a lista segue em `data`.
      res.json({ data, error: null, meta: { recebimentoFiscalHabilitado: recebimentoFiscalHabilitado() } });
    } catch (err) {
      if (responderErroFilaNacional(res, err)) return;
      logger.error({ err }, 'Erro ao listar fila nacional');
      res.status(500).json({ data: null, error: { code: 'FILA_NACIONAL_FAIL', message: (err as Error).message } });
    }
  },
);

const ChaveAcessoSchema = z.string().regex(/^\d{44}$/, 'chave de acesso deve ter 44 dígitos');

router.get(
  '/api/v1/stockbridge/recebimento/nacional/fila/:chaveAcesso',
  requireOperador,
  requireArmazemVinculado,
  async (req: Request, res: Response) => {
    const parsed = ChaveAcessoSchema.safeParse(req.params.chaveAcesso);
    if (!parsed.success) {
      res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', userMessage: USER_MSG_INVALID, message: parsed.error.issues.map((i) => i.message).join('; ') } });
      return;
    }
    try {
      const data = await getDetalheNfNacional(parsed.data);
      // A UI esconde a acao de baixa externa quando a flag esta desligada (T070);
      // a flag e configuracao de ambiente, e a tela precisa saber sem tentar o POST.
      // Feature 016: a UI mostra o selo/banner fiscal e o botao de dispensa so com a flag ligada.
      res.json({ data: { ...data, recebimentoExternoHabilitado: recebimentoExternoHabilitado(), recebimentoFiscalHabilitado: recebimentoFiscalHabilitado() }, error: null });
    } catch (err) {
      if (responderErroFilaNacional(res, err)) return;
      logger.error({ err, chave: parsed.data }, 'Erro ao detalhar NF nacional');
      res.status(500).json({ data: null, error: { code: 'DETALHE_NF_FAIL', message: (err as Error).message } });
    }
  },
);

// .strict() em todos os niveis: valor de item, valor total, unidade ou qualquer
// campo que o cliente nao deva mandar e REJEITADO — o ponto da feature e que
// esses dados nao passam pelo cliente (SC-001, invariante 2 do contrato).
const ProdutoDistribuicaoSchema = z
  .object({
    produto_codigo_q2p: z.number().int().positive(),
    quantidade_kg: z.number().positive(),
    localidade_id: z.string().uuid(),
  })
  .strict();

const ItemPorNfSchema = z
  .object({
    indice: z.number().int().min(0),
    descricao_fornecedor: z.string().min(1).max(500),
    quantidade_conferida_kg: z.number().positive().optional().nullable(),
    motivo_divergencia: z.string().max(1000).optional().nullable(),
    observacoes: z.string().max(1000).optional().nullable(),
    produtos: z.array(ProdutoDistribuicaoSchema).min(1).max(20),
  })
  .strict();

const PorNfBodySchema = z
  .object({
    nf_chave_acesso: ChaveAcessoSchema,
    observacoes: z.string().max(1000).optional().nullable(),
    itens: z.array(ItemPorNfSchema).min(1).max(100),
  })
  .strict();

router.post(
  '/api/v1/stockbridge/recebimento/nacional/por-nf',
  requireOperador,
  requireArmazemVinculado,
  async (req: Request, res: Response) => {
    const parsed = PorNfBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: {
          code: 'INVALID_INPUT', userMessage: USER_MSG_INVALID,
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
      return;
    }
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessão sem usuário' } });
      return;
    }
    try {
      const result = await processarRecebimentoNacionalPorNf({
        nfChaveAcesso: parsed.data.nf_chave_acesso,
        observacoes: parsed.data.observacoes ?? null,
        itens: parsed.data.itens.map((it) => ({
          indice: it.indice,
          descricaoFornecedor: it.descricao_fornecedor,
          quantidadeConferidaKg: it.quantidade_conferida_kg ?? null,
          motivoDivergencia: it.motivo_divergencia ?? null,
          observacoes: it.observacoes ?? null,
          produtos: it.produtos.map((p) => ({
            produtoCodigoQ2p: p.produto_codigo_q2p,
            quantidadeKg: p.quantidade_kg,
            localidadeId: p.localidade_id,
          })),
        })),
        userId,
      });
      // 201 sempre que passa o portao de validacao — o desfecho e por produto.
      res.status(201).json({ data: result, error: null });
    } catch (err) {
      if (responderErroFilaNacional(res, err)) return;
      if (err instanceof ValidacaoRecebimentoNacionalError) {
        res.status(400).json({ data: null, error: { code: err.code, userMessage: err.message, message: err.message } });
        return;
      }
      if (err instanceof LocalidadeNaoElegivelError) {
        res.status(400).json({ data: null, error: { code: 'LOCALIDADE_NAO_ELEGIVEL', userMessage: err.message, message: err.message } });
        return;
      }
      if (err instanceof ProdutoNaoEncontradoError) {
        res.status(404).json({ data: null, error: { code: 'PRODUTO_NAO_ENCONTRADO', userMessage: err.message, message: err.message } });
        return;
      }
      if (err instanceof NfNacionalJaProcessadaError) {
        res.status(409).json({ data: null, error: { code: 'NF_JA_PROCESSADA', userMessage: err.message, message: err.message } });
        return;
      }
      // Feature 016 — falhas do recebimento FISCAL (contrato §3): nada foi gravado.
      // O detalhe tecnico (passo, fault OMIE) fica no ledger e no log, nunca na UI.
      if (err instanceof RecebimentoFiscalEmAndamentoError) {
        res.status(409).json({ data: null, error: { code: 'RECEBIMENTO_FISCAL_EM_ANDAMENTO', userMessage: err.message, message: err.message } });
        return;
      }
      if (err instanceof RecebimentoFiscalAguardeError) {
        res.status(409).json({
          data: null,
          error: { code: 'RECEBIMENTO_FISCAL_AGUARDE', userMessage: err.message, message: `aguardar ${err.segundos}s apos falha com escrita no OMIE`, retryAfterSeconds: segundosAteNovaTentativa(err) },
        });
        return;
      }
      if (err instanceof RecebimentoFiscalEtapaInesperadaError) {
        res.status(422).json({ data: null, error: { code: 'RECEBIMENTO_FISCAL_ETAPA_INESPERADA', userMessage: err.message, message: `recebimento fora da etapa esperada (${err.motivo})` } });
        return;
      }
      if (err instanceof RecebimentoFiscalSemFornecedorError) {
        res.status(422).json({ data: null, error: { code: 'RECEBIMENTO_FISCAL_SEM_FORNECEDOR', userMessage: err.message, message: err.message } });
        return;
      }
      if (err instanceof RecebimentoFiscalNfCanceladaError) {
        res.status(422).json({ data: null, error: { code: 'NF_CANCELADA', userMessage: err.message, message: err.message } });
        return;
      }
      if (err instanceof RecebimentoFiscalError) {
        logger.error({ err, chave: parsed.data.nf_chave_acesso, passo: err.passo }, 'Recebimento fiscal falhou no OMIE — nada gravado');
        // retryAfterSeconds: 70 quando a falha foi DEPOIS de uma escrita (cache do OMIE), 0 na consulta.
        res.status(502).json({
          data: null,
          error: { code: 'RECEBIMENTO_FISCAL_FAIL', userMessage: err.message, message: `fiscal falhou no passo ${err.passo}`, retryAfterSeconds: segundosAteNovaTentativa(err) },
        });
        return;
      }
      logger.error({ err, chave: parsed.data.nf_chave_acesso }, 'Erro inesperado em recebimento nacional por NF');
      res.status(500).json({ data: null, error: { code: 'RECEBIMENTO_NACIONAL_NF_FAIL', message: (err as Error).message } });
    }
  },
);

// ── Historia 3/4 — correlacao memorizada (contrato §4) ──────────────────────
// O cliente manda o CONJUNTO de produtos da descricao; fornecedor (cnpj/nome) e
// nome do produto sao resolvidos AQUI, a partir da chave da NF e do catalogo —
// nunca aceitos do payload. Produto que saiu do conjunto e desativado, nao apagado.
const CorrelacaoBodySchema = z
  .object({
    nf_chave_acesso: ChaveAcessoSchema,
    descricao_nf: z.string().trim().min(1).max(500),
    produtos_codigo_q2p: z.array(z.number().int().positive()).max(20),
  })
  .strict();

router.put(
  '/api/v1/stockbridge/recebimento/nacional/correlacao',
  requireOperador,
  requireArmazemVinculado,
  async (req: Request, res: Response) => {
    const parsed = CorrelacaoBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', userMessage: USER_MSG_INVALID, message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
      });
      return;
    }
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessão sem usuário' } });
      return;
    }
    const codigos = parsed.data.produtos_codigo_q2p;
    if (new Set(codigos).size !== codigos.length) {
      res.status(400).json({
        data: null,
        error: { code: 'PRODUTO_REPETIDO_NO_ITEM', userMessage: 'O mesmo produto aparece mais de uma vez.', message: 'produtos_codigo_q2p com repetição' },
      });
      return;
    }
    try {
      const detalhe = await getDetalheNfNacional(parsed.data.nf_chave_acesso);
      const result = await definirConjuntoCorrelacao({
        fornecedorCnpj: detalhe.fornecedorCnpj,
        fornecedorNome: detalhe.fornecedorNome,
        descricaoNf: parsed.data.descricao_nf,
        produtosCodigoQ2p: codigos,
        userId,
      });
      if (result.produtosNaoEncontrados.length > 0) {
        const n = result.produtosNaoEncontrados.length;
        res.status(404).json({
          data: null,
          error: {
            code: 'PRODUTO_NAO_ENCONTRADO',
            userMessage: n === 1 ? 'O produto informado não existe no cadastro da Q2P.' : `${n} produtos informados não existem no cadastro da Q2P.`,
            message: `produtos não encontrados: ${result.produtosNaoEncontrados.join(', ')}`,
          },
        });
        return;
      }
      res.json({ data: { adicionados: result.adicionados, mantidos: result.mantidos, desativados: result.desativados }, error: null });
    } catch (err) {
      if (responderErroFilaNacional(res, err)) return;
      logger.error({ err, chave: parsed.data.nf_chave_acesso }, 'Erro ao definir correlação fornecedor→produto');
      res.status(500).json({ data: null, error: { code: 'CORRELACAO_FAIL', message: (err as Error).message } });
    }
  },
);

// ── Historia 6 — baixa por recebimento externo (contrato §5) ───────────────
// NAO cria movimentacao, NAO altera estoque, NAO chama OMIE: so uma aprovacao
// de gestor por item. `itens` vazio/ausente = todos os pendentes da NF.
const RecebimentoExternoBodySchema = z
  .object({
    nf_chave_acesso: ChaveAcessoSchema,
    motivo: z.string().trim().min(1, 'motivo é obrigatório').max(1000),
    itens: z
      .array(z.object({ indice: z.number().int().nonnegative(), descricao_fornecedor: z.string().min(1).max(500) }).strict())
      .max(50)
      .optional(),
  })
  .strict();

router.post(
  '/api/v1/stockbridge/recebimento/nacional/recebimento-externo',
  requireOperador,
  requireArmazemVinculado,
  async (req: Request, res: Response) => {
    // Flag primeiro: desligada, nem valida o corpo — a capacidade nao existe.
    if (!recebimentoExternoHabilitado()) {
      res.status(403).json({
        data: null,
        error: {
          code: 'RECEBIMENTO_EXTERNO_DESABILITADO',
          userMessage: 'A baixa por recebimento externo está desligada neste ambiente.',
          message: 'STOCKBRIDGE_RECEBIMENTO_EXTERNO_ENABLED=false',
        },
      });
      return;
    }
    const parsed = RecebimentoExternoBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const soMotivo = parsed.error.issues.every((i) => i.path[0] === 'motivo');
      res.status(400).json({
        data: null,
        error: {
          code: soMotivo ? 'MOTIVO_OBRIGATORIO' : 'INVALID_INPUT',
          userMessage: soMotivo ? 'Informe o motivo da baixa: onde e como este item foi recebido fora do Atlas.' : USER_MSG_INVALID,
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
      return;
    }
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessão sem usuário' } });
      return;
    }
    try {
      const result = await solicitarRecebimentoExterno({
        nfChaveAcesso: parsed.data.nf_chave_acesso,
        motivo: parsed.data.motivo,
        itens: parsed.data.itens?.map((it) => ({ indice: it.indice, descricaoFornecedor: it.descricao_fornecedor })) ?? null,
        userId,
      });
      res.status(201).json({ data: result, error: null });
    } catch (err) {
      if (responderErroFilaNacional(res, err)) return;
      if (err instanceof RecebimentoExternoDesabilitadoError) {
        res.status(403).json({ data: null, error: { code: 'RECEBIMENTO_EXTERNO_DESABILITADO', userMessage: err.message, message: err.message } });
        return;
      }
      if (err instanceof BaixaExternaFiscalPendenteError) {
        res.status(409).json({ data: null, error: { code: 'BAIXA_EXTERNA_FISCAL_PENDENTE', userMessage: err.message, message: err.message } });
        return;
      }
      if (err instanceof MotivoObrigatorioError) {
        res.status(400).json({ data: null, error: { code: 'MOTIVO_OBRIGATORIO', userMessage: err.message, message: err.message } });
        return;
      }
      if (err instanceof ItemJaRecebidoError) {
        res.status(409).json({ data: null, error: { code: 'ITEM_JA_RECEBIDO', userMessage: err.message, message: err.message } });
        return;
      }
      if (err instanceof NenhumItemPendenteError) {
        res.status(409).json({ data: null, error: { code: 'NENHUM_ITEM_PENDENTE', userMessage: err.message, message: err.message } });
        return;
      }
      if (err instanceof ItemNaoCorrespondeError) {
        res.status(400).json({ data: null, error: { code: 'ITEM_NAO_ENCONTRADO', userMessage: err.message, message: err.message } });
        return;
      }
      logger.error({ err, chave: parsed.data.nf_chave_acesso }, 'Erro ao solicitar baixa por recebimento externo');
      res.status(500).json({ data: null, error: { code: 'RECEBIMENTO_EXTERNO_FAIL', message: (err as Error).message } });
    }
  },
);

// ── Feature 016 (ACXEGDP-395): dispensa de NF pelo gestor + rastreabilidade do fiscal ──

// Motivo vazio ou ausente passa pelo schema de proposito: o service responde
// 400 MOTIVO_OBRIGATORIO com a mensagem da dispensa (contrato §4/§6, ROT-8).
const DispensarSchema = z
  .object({
    nf_chave_acesso: z.string().regex(/^\d{44}$/, 'chave de acesso deve ter 44 dígitos'),
    motivo: z.string().max(1000).optional(),
  })
  .strict();

const ReverterDispensaSchema = z.object({ motivo: z.string().max(1000).optional() }).strict();

const DispensasQuerySchema = z.object({
  incluirRevertidas: z.enum(['true', 'false']).optional(),
});

const LedgerFiscalQuerySchema = z.object({
  status: z.enum(['em_andamento', 'concluido', 'ja_concluido', 'falha']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

function responderErroDispensa(res: Response, err: unknown): boolean {
  if (responderErroFilaNacional(res, err)) return true;
  if (err instanceof RecebimentoFiscalDesabilitadoError) {
    res.status(403).json({ data: null, error: { code: 'RECEBIMENTO_FISCAL_DESABILITADO', userMessage: err.message, message: err.message } });
    return true;
  }
  if (err instanceof DispensaNaoPermitidaError) {
    res.status(403).json({ data: null, error: { code: 'FORBIDDEN', userMessage: err.message, message: err.message } });
    return true;
  }
  if (err instanceof MotivoDispensaObrigatorioError) {
    res.status(400).json({ data: null, error: { code: 'MOTIVO_OBRIGATORIO', userMessage: err.message, message: err.message } });
    return true;
  }
  if (err instanceof NfEmRecebimentoFiscalError) {
    res.status(409).json({ data: null, error: { code: 'NF_EM_RECEBIMENTO', userMessage: err.message, message: err.message } });
    return true;
  }
  if (err instanceof NfJaDispensadaError) {
    res.status(409).json({ data: null, error: { code: 'NF_JA_DISPENSADA', userMessage: err.message, message: err.message } });
    return true;
  }
  if (err instanceof NfNaoDispensavelError) {
    res.status(422).json({ data: null, error: { code: 'NF_NAO_DISPENSAVEL', userMessage: err.message, message: err.message } });
    return true;
  }
  if (err instanceof DispensaNaoEncontradaError) {
    res.status(404).json({ data: null, error: { code: 'DISPENSA_NAO_ENCONTRADA', userMessage: err.message, message: err.message } });
    return true;
  }
  return false;
}

// POST /api/v1/stockbridge/recebimento/nacional/dispensar — gestor+ (contrato §4).
// Com a flag desligada responde 403 ANTES de validar o corpo (a acao nao existe).
router.post(
  '/api/v1/stockbridge/recebimento/nacional/dispensar',
  requireGestor,
  async (req: Request, res: Response) => {
    if (!recebimentoFiscalHabilitado()) {
      const err = new RecebimentoFiscalDesabilitadoError();
      res.status(403).json({ data: null, error: { code: 'RECEBIMENTO_FISCAL_DESABILITADO', userMessage: err.message, message: err.message } });
      return;
    }
    const parsed = DispensarSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', userMessage: USER_MSG_INVALID, message: parsed.error.issues.map((i) => i.message).join('; ') },
      });
      return;
    }
    const user = (req as Request & { user?: { id: string; role: Perfil } }).user;
    if (!user) {
      res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessão sem usuário' } });
      return;
    }
    try {
      const result = await dispensarNf({ nfChaveAcesso: parsed.data.nf_chave_acesso, motivo: parsed.data.motivo ?? '', userId: user.id, perfilUsuario: user.role });
      res.status(201).json({ data: result, error: null });
    } catch (err) {
      if (responderErroDispensa(res, err)) return;
      logger.error({ err, chave: parsed.data.nf_chave_acesso }, 'Erro ao dispensar NF da fila');
      res.status(500).json({ data: null, error: { code: 'NF_DISPENSA_FAIL', message: (err as Error).message } });
    }
  },
);

// GET /api/v1/stockbridge/recebimento/nacional/dispensas — gestor+ (contrato §5)
router.get(
  '/api/v1/stockbridge/recebimento/nacional/dispensas',
  requireGestor,
  async (req: Request, res: Response) => {
    if (!recebimentoFiscalHabilitado()) {
      const err = new RecebimentoFiscalDesabilitadoError();
      res.status(403).json({ data: null, error: { code: 'RECEBIMENTO_FISCAL_DESABILITADO', userMessage: err.message, message: err.message } });
      return;
    }
    const parsed = DispensasQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ data: null, error: { code: 'INVALID_QUERY', userMessage: USER_MSG_INVALID, message: parsed.error.issues.map((i) => i.message).join('; ') } });
      return;
    }
    try {
      const data = await listarDispensas({ incluirRevertidas: parsed.data.incluirRevertidas === 'true' });
      res.json({ data, error: null });
    } catch (err) {
      if (responderErroDispensa(res, err)) return;
      logger.error({ err }, 'Erro ao listar dispensas de NF');
      res.status(500).json({ data: null, error: { code: 'NF_DISPENSA_LIST_FAIL', message: (err as Error).message } });
    }
  },
);

// POST /api/v1/stockbridge/recebimento/nacional/dispensas/:id/reverter — gestor+ (contrato §6)
router.post(
  '/api/v1/stockbridge/recebimento/nacional/dispensas/:id/reverter',
  requireGestor,
  async (req: Request, res: Response) => {
    if (!recebimentoFiscalHabilitado()) {
      const err = new RecebimentoFiscalDesabilitadoError();
      res.status(403).json({ data: null, error: { code: 'RECEBIMENTO_FISCAL_DESABILITADO', userMessage: err.message, message: err.message } });
      return;
    }
    const id = String(req.params.id ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', userMessage: USER_MSG_INVALID, message: 'id inválido' } });
      return;
    }
    const parsed = ReverterDispensaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', userMessage: USER_MSG_INVALID, message: parsed.error.issues.map((i) => i.message).join('; ') },
      });
      return;
    }
    const user = (req as Request & { user?: { id: string; role: Perfil } }).user;
    if (!user) {
      res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessão sem usuário' } });
      return;
    }
    try {
      const result = await reverterDispensa({ id, motivo: parsed.data.motivo ?? '', userId: user.id, perfilUsuario: user.role });
      res.json({ data: result, error: null });
    } catch (err) {
      if (responderErroDispensa(res, err)) return;
      logger.error({ err, id }, 'Erro ao reverter dispensa de NF');
      res.status(500).json({ data: null, error: { code: 'NF_DISPENSA_REVERTER_FAIL', message: (err as Error).message } });
    }
  },
);

// GET /api/v1/stockbridge/recebimento/nacional/fiscal — ledger do recebimento fiscal, gestor+ (contrato §7).
// `erro_omie_*` nao sai daqui (fica no banco e no log — ACXEGDP-313).
router.get(
  '/api/v1/stockbridge/recebimento/nacional/fiscal',
  requireGestor,
  async (req: Request, res: Response) => {
    // Rotas novas da 016 respondem 403 com a flag desligada (contrato, ROT-7).
    if (!recebimentoFiscalHabilitado()) {
      const err = new RecebimentoFiscalDesabilitadoError();
      res.status(403).json({ data: null, error: { code: 'RECEBIMENTO_FISCAL_DESABILITADO', userMessage: err.message, message: err.message } });
      return;
    }
    const parsed = LedgerFiscalQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ data: null, error: { code: 'INVALID_QUERY', userMessage: USER_MSG_INVALID, message: parsed.error.issues.map((i) => i.message).join('; ') } });
      return;
    }
    try {
      const data = await listarLedgerFiscal({ status: parsed.data.status ?? null, limit: parsed.data.limit ?? 100 });
      res.json({ data, error: null });
    } catch (err) {
      if (responderErroFilaNacional(res, err)) return;
      logger.error({ err }, 'Erro ao listar ledger do recebimento fiscal');
      res.status(500).json({ data: null, error: { code: 'LEDGER_FISCAL_FAIL', message: (err as Error).message } });
    }
  },
);

export default router;
