import cron from 'node-cron';
import { createLogger } from '@atlas/core';
import { processarAlertasComodatoVencido } from '../services/cron-comodato.service.js';
import { reprocessarBaixasAguardandoVinculo } from '../services/baixa-pedido.service.js';
import { verificarCopiaPcs, verificarEspelhoRecebimentos } from '../services/alerta-espelho-recebimentos.service.js';
import { registrarPcsVistos } from '../services/pc-visto.service.js';
import { recebimentoNacionalAcxeHabilitado } from '../services/empresa-nacional.js';
import { varrerExcedentesRejeitadosSemAviso } from '../services/pc-peso-conferido.service.js';

const logger = createLogger('stockbridge:cron');

let started = false;

/**
 * Registra os crons do StockBridge. Idempotente — multiplas chamadas no boot
 * (HMR, testes) sao ignoradas. Cada job tem timezone explicito BR.
 *
 * Jobs:
 *   - alerta-comodato-vencido: 08:00 BR todos os dias. Dispara emails pros
 *     responsaveis em D+1 (operador+gestor) e a cada 15 dias depois disso
 *     (operador+gestor+diretor). Detalhes em cron-comodato.service.ts.
 */
export function iniciarCronsStockBridge(): void {
  if (started) {
    logger.warn('Crons do StockBridge ja iniciados — ignorando');
    return;
  }
  started = true;

  cron.schedule(
    '0 8 * * *',
    () => {
      void processarAlertasComodatoVencido();
    },
    { timezone: 'America/Sao_Paulo' },
  );
  logger.info('Cron registrado: alerta-comodato-vencido (0 8 * * * BR)');

  // ACXEGDP-344: baixa do pedido Q2P sem FIFO — quem ficou 'aguardando_vinculo'
  // e tenta de novo a cada hora. O n8n (workflow "FUP para BD e StockBridge")
  // carrega o mapa NF->pedido em :13, das 8h as 18h, seg-sab. Roda em :20 para
  // pegar a carga recem-feita. Digest de atrasadas (> 3 dias) so na rodada das
  // 08h. Respeita STOCKBRIDGE_BAIXA_PEDIDO_Q2P_ENABLED (desligada, nao faz nada).
  cron.schedule(
    '20 * * * *',
    () => {
      const horaBr = new Date().toLocaleString('en-US', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        hour12: false,
      });
      void reprocessarBaixasAguardandoVinculo({ enviarDigest: horaBr === '08' });
    },
    { timezone: 'America/Sao_Paulo' },
  );
  logger.info('Cron registrado: baixa-pedido-aguardando-vinculo (20 * * * * BR)');

  // Feature 016: alerta de espelho de recebimentos de NF-e defasado (fonte "fiscal
  // pendente" da fila nacional). Em :05/:35 — depois das rodadas do n8n (:23/:53).
  // Feature 017 (D13): o mesmo job vigia a copia de pedidos de compra, que decide a
  // sugestao de PC. Com STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED desligada, nao faz nada.
  // O reaviso de 6 h conta a partir da ENTREGA do e-mail: se o envio falhar, o desfecho e
  // 'falha' e a rodada seguinte (30 min depois) tenta de novo.
  // Historia 5 (ACXEGDP-437): com a compra nacional da ACXE habilitada o mesmo job vigia tambem o
  // espelho de recebimentos e a copia de PCs da ACXE (estado de reaviso proprio) e mantem o cache
  // de PCs vistos dela. Sem a chave nada da ACXE roda (o espelho ainda vazio viraria alerta e o
  // cache so geraria ruido de auditoria). A chave e lida a cada rodada.
  cron.schedule(
    '5,35 * * * *',
    () => {
      verificarEspelhoRecebimentos('q2p').catch((err) => logger.error({ err }, 'Falha ao verificar o espelho de recebimentos de NF-e'));
      verificarCopiaPcs('q2p').catch((err) => logger.error({ err }, 'Falha ao verificar a cópia de pedidos de compra'));
      // 017 (0057): cache de PCs vistos — o OMIE tira da lista de pendentes o PC com item
      // associado a um recebimento aberto; o cache guarda a ultima versao vista (so o que mudou).
      void registrarPcsVistos('q2p');
      // 017 (research D20): entrada rejeitada com o PC baixado acima da nota (peso conferido) sem aviso a
      // compras — o aviso da hora da rejeicao pode ter falhado. Nunca lanca.
      void varrerExcedentesRejeitadosSemAviso();
      if (recebimentoNacionalAcxeHabilitado()) {
        verificarEspelhoRecebimentos('acxe').catch((err) => logger.error({ err }, 'Falha ao verificar o espelho de recebimentos de NF-e da ACXE'));
        verificarCopiaPcs('acxe').catch((err) => logger.error({ err }, 'Falha ao verificar a cópia de pedidos de compra da ACXE'));
        void registrarPcsVistos('acxe');
      }
    },
    { timezone: 'America/Sao_Paulo' },
  );
  logger.info('Cron registrado: alerta-espelho-recebimentos + cópia de PCs + cache de PCs vistos + avisos de PC baixado acima da nota, Q2P e ACXE (5,35 * * * * BR)');
}
