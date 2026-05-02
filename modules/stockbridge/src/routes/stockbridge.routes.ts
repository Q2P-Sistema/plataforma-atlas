import { Router, type Request, type Response } from 'express';
import { requireAuth } from '@atlas/auth';
import { createLogger } from '@atlas/core';
import filaRouter from './fila.routes.js';
import recebimentoRouter from './recebimento.routes.js';
import cockpitRouter from './cockpit.routes.js';
import aprovacaoRouter from './aprovacao.routes.js';
import transitoRouter from './transito.routes.js';
import saidaAutomaticaRouter from './saida-automatica.routes.js';
import saidaManualRouter from './saida-manual.routes.js';
import metricasRouter from './metricas.routes.js';
import fornecedorRouter from './fornecedor.routes.js';
import localidadeRouter from './localidade.routes.js';
import configRouter from './config.routes.js';
import movimentacaoRouter from './movimentacao.routes.js';
import meuEstoqueRouter from './meu-estoque.routes.js';
import adminUserGalpaoRouter from './admin-user-galpao.routes.js';
import operacoesPendentesRouter from './operacoes-pendentes.routes.js';

const logger = createLogger('stockbridge:routes');
const router: Router = Router();

// Todas as rotas do StockBridge exigem autenticacao
router.use('/api/v1/stockbridge', requireAuth);

// Health check
router.get('/api/v1/stockbridge/health', (_req: Request, res: Response) => {
  res.json({ data: { status: 'ok', module: 'stockbridge' }, error: null });
});

// US1 — Recebimento de NF com conferencia fisica
router.use(filaRouter);
router.use(recebimentoRouter);
// US2 — Cockpit de estoque por produto (gestor/diretor)
router.use(cockpitRouter);
// US3 — Aprovacoes hierarquicas
router.use(aprovacaoRouter);
// US4 — Pipeline de transito maritimo
router.use(transitoRouter);
// US5 — Saidas automaticas via OMIE (polling n8n)
router.use(saidaAutomaticaRouter);
// US6 — Saidas manuais com aprovacao
router.use(saidaManualRouter);
// US7 — Metricas (diretor) + fornecedores
router.use(metricasRouter);
router.use(fornecedorRouter);
// US8 — Gestao de localidades + config de produtos
router.use(localidadeRouter);
router.use(configRouter);
// Phase 11 — Movimentacoes (listagem + soft delete)
router.use(movimentacaoRouter);
// Meu Estoque (operador/gestor/diretor) — espelha vw_posicaoEstoqueUnificadaFamilia OMIE
router.use(meuEstoqueRouter);
// Admin (diretor) — vinculacao N:N usuario × galpao
router.use(adminUserGalpaoRouter);
// Idempotencia OMIE — retry de operacoes pendentes (US2/US3/US4)
router.use(operacoesPendentesRouter);

logger.info('StockBridge router inicializado (US1..US8 + Movimentacoes + OperacoesPendentes)');

export default router;
