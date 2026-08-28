#!/usr/bin/env node
/**
 * Backfill da baixa de pedido de compra Q2P (ACXEGDP-344).
 *
 * Processa, em ordem cronológica, as movimentações de entrada de importação
 * com `baixa_pedido_q2p IN ('pendente','falha','sem_saldo')` — as ~150 NFs
 * (3,5 kt) recebidas pelo Atlas desde 09/06/2026 sem baixa no OMIE, mais
 * qualquer pendência nova. Usa EXATAMENTE o mesmo serviço do fluxo contínuo
 * (`processarBaixaPedidoQ2p`), com origem='backfill'.
 *
 * Modos:
 *   (default)          DRY-RUN: consulta o OMIE ao vivo, simula a FIFO com
 *                      saldos encadeados (uma NF "gasta" o pedido para a
 *                      próxima) e imprime o relatório por NF e por pedido.
 *                      ZERO escrita no OMIE e no ledger.
 *   --execute          Executa de verdade (AlteraPedCompra + ledger). Para no
 *                      primeiro erro por NF (a NF fica 'falha', as demais
 *                      seguem) — re-rodar é idempotente pelo ledger.
 *   --consultar <nCodPed>  Só consulta um pedido ao vivo e imprime o parse —
 *                      para validar o formato do ConsultarPedCompra em UAT.
 *   --encerrar <nº,nº,...> --motivo "..."  Zera (0,1 kg) pedidos Q2P por NÚMERO
 *                      (cNumero) — carga cancelada / processo encerrado no FUP.
 *                      Ledger com criterio=manual. Com --execute aplica.
 *   --desfazer <nf> --motivo "..."  Reverte a baixa da NF (devolve a quantidade
 *                      aos pedidos, desativa o ledger, reabre como pendente).
 *                      Com --execute aplica; sem, só mostra o que faria.
 *   --nf <numero>      Restringe a uma NF.  --limit <n>  Limita a n movimentações.
 *   --apenas-vinculo   Processa só NFs com vínculo NF→pedido ACXE no mapa
 *                      (nf_pedido_mapa); as sem vínculo ficam pendentes para
 *                      quando o mapa as alcançar (evita FIFO em pedido errado).
 *   --json <arquivo>   Grava o relatório completo em JSON.
 *
 * Execução (na raiz do repo, com DATABASE_URL + OMIE_Q2P_KEY/SECRET do ambiente):
 *   pnpm --filter @atlas/stockbridge backfill-baixa-pedido-q2p            # dry-run
 *   pnpm --filter @atlas/stockbridge backfill-baixa-pedido-q2p -- --execute
 */

import { writeFileSync } from 'node:fs';
import { getPool, closePool, createLogger } from '@atlas/core';
import { consultarPedidoCompra } from '@atlas/integration-omie';
import {
  listarBaixasPendentes,
  processarBaixaPedidoQ2p,
  desfazerBaixaPedidoQ2p,
  encerrarPedidoQ2p,
  resolverPedidosAcxeDaNf,
  type CachePedidos,
  type ResultadoBaixa,
} from '../services/baixa-pedido.service.js';

const logger = createLogger('stockbridge:backfill-baixa-pedido');

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const flag = (nome: string): string | undefined => {
  const i = args.indexOf(nome);
  return i !== -1 ? args[i + 1] : undefined;
};
const CONSULTAR = flag('--consultar');
const DESFAZER = flag('--desfazer');
const ENCERRAR = flag('--encerrar');
const MOTIVO = flag('--motivo');
const NF = flag('--nf');
const APENAS_VINCULO = args.includes('--apenas-vinculo');
const LIMIT = flag('--limit') ? Number(flag('--limit')) : undefined;
const JSON_OUT = flag('--json');

function fmtKg(kg: number): string {
  return kg.toLocaleString('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

async function main(): Promise<void> {
  if (CONSULTAR) {
    const ped = await consultarPedidoCompra('q2p', {
      nCodPed: Number(CONSULTAR),
    });
    console.log(JSON.stringify(ped, null, 2));
    return;
  }

  if (ENCERRAR) {
    if (!MOTIVO) {
      console.error('--encerrar exige --motivo "..."');
      process.exitCode = 2;
      return;
    }
    const numeros = ENCERRAR.split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    const res = await getPool().query<{ ncodped: string; cnumero: string }>(
      `SELECT ncodped::text AS ncodped, cnumero FROM public."tbl_pedidosCompras_Q2P" WHERE cnumero = ANY($1::text[])`,
      [numeros],
    );
    const achados = new Set(res.rows.map((r) => r.cnumero));
    for (const n of numeros)
      if (!achados.has(n)) console.log(`Pedido ${n}: NAO encontrado no espelho — ignorado`);
    console.log(
      `\n${EXECUTE ? '▶ ENCERRAMENTO' : '○ DRY-RUN encerramento'} — ${res.rows.length} pedido(s)\n`,
    );
    let totalKg = 0;
    for (const r of res.rows) {
      try {
        const out = await encerrarPedidoQ2p({ ncodped: Number(r.ncodped), motivo: MOTIVO, dryRun: !EXECUTE });
        totalKg += out.status === 'ja_zerado' ? 0 : out.saldoAnteriorKg;
        console.log(
          `Pedido ${String(out.cnumero).padEnd(5)} ${out.produto.slice(0, 22).padEnd(22)} ${fmtKg(out.saldoAnteriorKg).padStart(10)} -> ${fmtKg(out.saldoNovoKg)} kg  ${out.status}`,
        );
      } catch (err) {
        console.log(`Pedido ${r.cnumero}: ERRO ${(err as Error).message}`);
      }
    }
    console.log(`\nTotal zerado: ${fmtKg(totalKg)} kg${EXECUTE ? '' : ' (nada alterado; use --execute)'}`);
    return;
  }

  if (DESFAZER) {
    if (!MOTIVO) {
      console.error('--desfazer exige --motivo "..."');
      process.exitCode = 2;
      return;
    }
    const alvo = DESFAZER.replace(/^0+/, '');
    const res = await getPool().query<{ id: string }>(
      `SELECT id FROM stockbridge.movimentacao
        WHERE ativo = true AND tipo_movimento = 'entrada_nf' AND baixa_pedido_q2p IS NOT NULL
          AND ltrim(nota_fiscal, '0') = $1`,
      [alvo],
    );
    if (res.rows.length === 0) {
      console.error(`Nenhuma movimentação de importação com baixa para a NF ${DESFAZER}`);
      process.exitCode = 2;
      return;
    }
    for (const r of res.rows) {
      const out = await desfazerBaixaPedidoQ2p({ movimentacaoId: r.id, motivo: MOTIVO, dryRun: !EXECUTE });
      console.log(`\n${EXECUTE ? '▶ REVERTIDO' : '○ DRY-RUN reversão'} — NF ${out.notaFiscal}`);
      for (const v of out.revertidos)
        console.log(`  pedido #${v.cnumero ?? v.ncodped}: ${fmtKg(v.de)} -> ${fmtKg(v.para)} kg`);
      for (const i of out.ignorados) console.log(`  IGNORADO pedido ${i.ncodped}: ${i.motivo}`);
      if (!EXECUTE) console.log('  (nada alterado; use --execute)');
    }
    return;
  }

  if ((process.env.OMIE_MODE ?? 'real') === 'mock') {
    console.error('OMIE_MODE=mock — o backfill precisa consultar o OMIE real (saldo ao vivo). Abortando.');
    process.exitCode = 2;
    return;
  }

  let fila = await listarBaixasPendentes();
  if (NF) {
    const alvo = NF.replace(/^0+/, '');
    fila = fila.filter((f) => f.notaFiscal.replace(/^0+/, '') === alvo);
  }
  if (APENAS_VINCULO) {
    const comVinculo = [];
    for (const item of fila) {
      const v = await resolverPedidosAcxeDaNf(item.notaFiscal, null);
      if (v.size > 0) comVinculo.push(item);
      else
        console.log(`NF ${item.notaFiscal.padEnd(9)} ADIADA — sem vínculo NF→pedido no mapa (fica pendente)`);
    }
    fila = comVinculo;
  }
  if (LIMIT) fila = fila.slice(0, LIMIT);

  console.log(
    `\n${EXECUTE ? '▶ EXECUÇÃO' : '○ DRY-RUN'} — ${fila.length} movimentação(ões) na fila de baixa de pedido Q2P\n`,
  );
  if (fila.length === 0) return;

  // Em dry-run os saldos simulados encadeiam entre NFs (o serviço não persiste).
  const simulacao = new Map<number, number>();
  // Cache de pedidos ao vivo compartilhado por toda a execução: sem ele, várias
  // NFs do mesmo pedido disparariam a trava de "consumo redundante" da OMIE
  // (60s de espera por reconsulta). Ver CachePedidos no serviço.
  const cachePedidos: CachePedidos = new Map();
  const resultados: ResultadoBaixa[] = [];
  const totais = {
    concluida: 0,
    sem_saldo: 0,
    falha: 0,
    aguardando: 0,
    kgDescontado: 0,
    kgSemPedido: 0,
  };

  for (const item of fila) {
    let res: ResultadoBaixa;
    try {
      res = await processarBaixaPedidoQ2p({
        movimentacaoId: item.movimentacaoId,
        origem: 'backfill',
        dryRun: !EXECUTE,
        simulacaoSaldos: EXECUTE ? undefined : simulacao,
        cachePedidos,
      });
    } catch (err) {
      logger.error({ err, movimentacaoId: item.movimentacaoId }, 'Falha inesperada');
      console.log(`NF ${item.notaFiscal.padEnd(9)} ERRO ${(err as Error).message}`);
      totais.falha += 1;
      continue;
    }
    resultados.push(res);
    const desfecho = res.statusPrevisto ?? res.status;
    if (desfecho === 'concluida') totais.concluida += 1;
    else if (desfecho === 'sem_saldo') totais.sem_saldo += 1;
    else if (desfecho === 'falha') totais.falha += 1;
    else totais.aguardando += 1;
    const kgDesc = res.alocacoes.reduce((acc, a) => acc + a.kgAlocado, 0);
    totais.kgDescontado += kgDesc;
    totais.kgSemPedido += res.restanteKg;

    const pedidosTxt = res.alocacoes
      .map(
        (a) =>
          `#${a.cnumero ?? a.ncodped}${a.preferido ? '*' : ''} ${fmtKg(a.saldoAnteriorKg)}→${fmtKg(a.saldoNovoKg)}`,
      )
      .join(' | ');
    console.log(
      `NF ${res.notaFiscal.padEnd(9)} ${res.produtoDescricao.slice(0, 22).padEnd(22)} ${fmtKg(res.quantidadeKg).padStart(10)} kg  ` +
        `${String(desfecho).padEnd(10)} ${pedidosTxt}${res.restanteKg > 0 ? `  [sem pedido: ${fmtKg(res.restanteKg)} kg]` : ''}${res.erro ? `  ERRO: ${res.erro}` : ''}`,
    );
  }

  // Consolidado por pedido (saldo inicial → final previsto/aplicado).
  const porPedido = new Map<number, { numero: string; inicial: number; final: number; nfs: string[] }>();
  for (const r of resultados) {
    for (const a of r.alocacoes) {
      const cur = porPedido.get(a.ncodped);
      if (cur) {
        cur.final = a.saldoNovoKg;
        cur.nfs.push(r.notaFiscal);
      } else {
        porPedido.set(a.ncodped, {
          numero: a.cnumero ?? String(a.ncodped),
          inicial: a.saldoAnteriorKg,
          final: a.saldoNovoKg,
          nfs: [r.notaFiscal],
        });
      }
    }
  }
  console.log(`\n── Pedidos Q2P afetados (${porPedido.size}) ──`);
  for (const [, p] of [...porPedido.entries()].sort((x, y) => Number(x[1].numero) - Number(y[1].numero))) {
    console.log(
      `Pedido ${p.numero.padEnd(6)} ${fmtKg(p.inicial).padStart(10)} → ${fmtKg(p.final).padStart(10)} kg   NFs: ${p.nfs.join(', ')}`,
    );
  }

  console.log(
    `\n── Resumo ── concluída: ${totais.concluida} · sem pedido: ${totais.sem_saldo} · falha: ${totais.falha} · aguardando OMIE: ${totais.aguardando}` +
      `\n   descontado: ${fmtKg(totais.kgDescontado)} kg · sem pedido: ${fmtKg(totais.kgSemPedido)} kg` +
      `\n   (* = pedido Q2P casado com o pedido ACXE da NF)`,
  );
  if (!EXECUTE) console.log('\nDry-run: nada foi alterado. Rode com --execute para aplicar.');

  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify(
        {
          executado: EXECUTE,
          geradoEm: new Date().toISOString(),
          totais,
          resultados,
        },
        null,
        2,
      ),
    );
    console.log(`Relatório gravado em ${JSON_OUT}`);
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'Backfill abortado');
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      getPool();
      await closePool();
    } catch {
      /* pool nunca aberto */
    }
  });
