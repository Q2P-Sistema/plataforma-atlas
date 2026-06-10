import { Router, type Request, type Response } from 'express';
import { requireAuth, requireModule } from '@atlas/auth';
import { createLogger } from '@atlas/core';
import filaRouter from './fila.routes.js';
import recebimentoRouter from './recebimento.routes.js';
import recebimentoNacionalRouter from './recebimento-nacional.routes.js';
import cockpitRouter from './cockpit.routes.js';
import aprovacaoRouter from './aprovacao.routes.js';
import divergenciaRouter from './divergencia.routes.js';
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
import adminCronRouter from './admin-cron.routes.js';
import cmcRouter from './cmc.routes.js';
import nfPedidoMapaRouter from './nf-pedido-mapa.routes.js';

const logger = createLogger('stockbridge:routes');
const router: Router = Router();

// Rotas consumidas por n8n via integration key — sem sessão de usuário, ANTES do requireAuth
router.use(saidaAutomaticaRouter);
router.use(nfPedidoMapaRouter);

// Todas as demais rotas exigem sessão autenticada + acesso ao módulo
router.use('/api/v1/stockbridge', requireAuth, requireModule('stockbridge'));

// Health check
router.get('/api/v1/stockbridge/health', (_req: Request, res: Response) => {
  res.json({ data: { status: 'ok', module: 'stockbridge' }, error: null });
});

// US1 — Recebimento de NF com conferencia fisica
router.use(filaRouter);
router.use(recebimentoRouter);
// Recebimento nacional (single-empresa, sem fila OMIE)
router.use(recebimentoNacionalRouter);
// US2 — Cockpit de estoque por produto (gestor/diretor)
router.use(cockpitRouter);
// US3 — Aprovacoes hierarquicas
router.use(aprovacaoRouter);
// Divergencias (drill-down do cockpit) — gestor+
router.use(divergenciaRouter);
// US4 — Pipeline de transito maritimo
router.use(transitoRouter);
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
// Admin (gestor+) — disparo manual de crons (alerta comodato vencido, etc.)
router.use(adminCronRouter);
// Custos de Estoque (CMC por família/produto) — gestor+ (feature 008)
router.use(cmcRouter);

logger.info('StockBridge router inicializado (US1..US8 + Movimentacoes + OperacoesPendentes)');

export default router;
