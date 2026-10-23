import { Router, type Request, type Response } from 'express';
import { idadeCopiaPcs, idadeEspelhoRecebimentos, statusHealthModulo } from '../services/fila-nacional.service.js';
import { requireAuth, requireModule, csrfProtection } from '@atlas/auth';
import { createLogger } from '@atlas/core';
import { recebimentoNacionalAcxeFlag, recebimentoNacionalAcxeHabilitado } from '../services/empresa-nacional.js';
import filaRouter from './fila.routes.js';
import recebimentoRouter from './recebimento.routes.js';
import recebimentoNacionalRouter from './recebimento-nacional.routes.js';
import cockpitRouter from './cockpit.routes.js';
import cockpitExecutivoRouter from './cockpit-executivo.routes.js';
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
import conferenciaRouter from './conferencia.routes.js';
import nfPedidoMapaRouter from './nf-pedido-mapa.routes.js';
import pendenciasFiscaisRouter from './pendencias-fiscais.routes.js';
import baixaPedidoRouter from './baixa-pedido.routes.js';

const logger = createLogger('stockbridge:routes');
const router: Router = Router();

// Rotas consumidas por n8n via integration key — sem sessão de usuário, ANTES do requireAuth
router.use(saidaAutomaticaRouter);
router.use(nfPedidoMapaRouter);

// Todas as demais rotas exigem sessão autenticada + acesso ao módulo
router.use('/api/v1/stockbridge', requireAuth, csrfProtection, requireModule('stockbridge'));

// Health check. Feature 016 (T051): expoe a defasagem do espelho de recebimentos
// de NF-e (fonte "fiscal pendente" da fila nacional) — `degraded` acima de 120 min
// com a flag ligada; 'desligado' quando a feature esta off. Feature 017 (D13): o
// mesmo para a copia de pedidos de compra, que decide a sugestao de PC.
// Historia 5 (ACXEGDP-437): o mesmo par para a ACXE (`...Acxe`), 'desligado' enquanto a compra
// nacional da ACXE nao esta habilitada; `recebimentoNacionalAcxe` mostra a chave e se ela esta
// de fato valendo (chave ligada sem o fiscal pelo Atlas ou sem o corte proprio = fora da fila).
router.get('/api/v1/stockbridge/health', async (_req: Request, res: Response) => {
  const [recebimentoNfeEspelho, pedidosCompraCopia, recebimentoNfeEspelhoAcxe, pedidosCompraCopiaAcxe] = await Promise.all([
    idadeEspelhoRecebimentos(),
    idadeCopiaPcs(),
    idadeEspelhoRecebimentos('acxe'),
    idadeCopiaPcs('acxe'),
  ]);
  // Com a flag ligada, espelho/copia vazios ('sem_dados') ou inacessiveis ('indisponivel')
  // tambem sao degradacao: a fila e a sugestao ficam cegas (revisao pre-UAT, ROT-6).
  const status = statusHealthModulo(recebimentoNfeEspelho, pedidosCompraCopia, recebimentoNfeEspelhoAcxe, pedidosCompraCopiaAcxe);
  res.json({
    data: {
      status,
      module: 'stockbridge',
      recebimentoNfeEspelhoIdadeMin: recebimentoNfeEspelho.idadeMin,
      recebimentoNfeEspelho,
      pedidosCompraCopiaIdadeMin: pedidosCompraCopia.idadeMin,
      pedidosCompraCopia,
      recebimentoNfeEspelhoAcxeIdadeMin: recebimentoNfeEspelhoAcxe.idadeMin,
      recebimentoNfeEspelhoAcxe,
      pedidosCompraCopiaAcxeIdadeMin: pedidosCompraCopiaAcxe.idadeMin,
      pedidosCompraCopiaAcxe,
      recebimentoNacionalAcxe: { chave: recebimentoNacionalAcxeFlag(), habilitada: recebimentoNacionalAcxeHabilitado() },
    },
    error: null,
  });
});

// US1 — Recebimento de NF com conferencia fisica
router.use(filaRouter);
router.use(recebimentoRouter);
// Recebimento nacional (single-empresa, sem fila OMIE)
router.use(recebimentoNacionalRouter);
// US2 — Cockpit de estoque por produto (gestor/diretor)
router.use(cockpitRouter);
// Visão Executiva "onde está o dinheiro" (diretor) — ACXEGDP-314
router.use(cockpitExecutivoRouter);
// US3 — Aprovacoes hierarquicas
router.use(aprovacaoRouter);
// Divergencias (drill-down do cockpit) — gestor+
router.use(divergenciaRouter);
// Pendencias Fiscais (drill-down de importação: recebido vs não recebido + aging) — gestor+ (ACXEGDP-183)
router.use(pendenciasFiscaisRouter);
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
// Baixa do pedido de compra Q2P apos recebimento (ACXEGDP-344) — painel + retry, gestor+
router.use(baixaPedidoRouter);
// Admin (gestor+) — disparo manual de crons (alerta comodato vencido, etc.)
router.use(adminCronRouter);
// Custos de Estoque (CMC por família/produto) — gestor+ (feature 008)
router.use(cmcRouter);
// Conferência de Estoque (ACXE × Q2P, substitui planilha) — gestor+ (feature 011)
router.use(conferenciaRouter);

logger.info('StockBridge router inicializado (US1..US8 + Movimentacoes + OperacoesPendentes)');

export default router;
