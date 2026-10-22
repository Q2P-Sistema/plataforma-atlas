import { getPool, createLogger } from '@atlas/core';
import {
  consultarRecebimentoNfe,
  alterarRecebimentoNfeItens,
  concluirRecebimentoNfe,
  type RecebimentoNfeConsultado,
  type ItemRecebimentoNfe,
  type ItemRecebimentoEditar,
} from '@atlas/integration-omie';
import { EstoqueJaLancadoPeloOmieError, FORNECEDOR_NAO_IDENTIFICADO } from './fila-nacional.service.js';
import {
  relerEReservarPcs,
  anteriorDaSequencia,
  PcRecemUsadoAguardeError,
  PcVinculoInvalidoError,
  type EmpresaPc,
  type EscolhaPcValidada,
  type OrigemVinculoPc,
  type ReservaPc,
} from './pc-sugestao.service.js';

const logger = createLogger('stockbridge:recebimento-fiscal');

/**
 * Recebimento FISCAL da NF nacional pelo Atlas (feature 016, ACXEGDP-395).
 *
 * Conclui no OMIE o recebimento de uma NF que chegou da SEFAZ e esta parada na
 * caixa "Recebimento de NF-e" (etapa 40), SEM movimentar estoque — o estoque
 * continua sendo lancado pelo recebimento fisico do Atlas (ajuste na aprovacao
 * do gestor). Reproduz exatamente o "Ignorar" da tela (testado em producao na
 * NF 6842, 02/10/2026 — research D1):
 *
 *   1. ConsultarRecebimento (por cChaveNfe)  — ja concluido? -> ja_concluido
 *   2. AlterarRecebimento  cAcao=EDITAR  + itensAjustes {cNaoGerarMovEstoque:S, cNaoGerarFinanceiro:N}
 *   3. AlterarRecebimento  cAcao=IGNORAR (sem ajustes — juntar da erro 151)
 *   4. ConcluirRecebimento cEtapa=60
 *
 * Lock, idempotencia e rastro vivem no LEDGER `stockbridge.recebimento_fiscal`
 * (research D6): a linha `em_andamento` e gravada ANTES da primeira chamada ao
 * OMIE e e unica por NF (indice parcial) — duplo clique perde no INSERT. Nao se
 * confia numa segunda consulta ao OMIE para isso porque `ConsultarRecebimento`
 * com corpo identico em < ~1 min devolve resposta antiga (cache — research D2);
 * por isso a RECONSULTA apos falha usa o OUTRO corpo (nIdReceb).
 *
 * Revisao pre-UAT (02/10/2026):
 *  - fornecedor nao cadastrado chega do OMIE como `nIdFornecedor: 0` (normalizado
 *    para null no parser) e/ou sem CNPJ — recusa ANTES de qualquer escrita;
 *  - so conclui a partir da etapa 40 e nunca recebimento bloqueado/devolvido;
 *  - o indice parcial solta o lock numa `falha`: uma nova tentativa da mesma NF
 *    espera ESPERA_APOS_FALHA_SEG depois de uma falha com escrita, para a 1a
 *    consulta nao cair no cache de ~1 min (leria o estado de antes do EDITAR);
 *  - passos ja feitos (lidos na consulta) sao pulados: EDITAR so em item nao
 *    ignorado e sem os ajustes; IGNORAR so em item nao ignorado;
 *  - o fechamento do ledger confere o dono do lock (`iniciado_em` como token):
 *    uma requisicao que perdeu o lock para a retomada nunca sobrescreve o desfecho.
 *
 * Nada aqui grava movimentacao/aprovacao: quem chama (recebimento-nacional)
 * so segue para a escrita fisica depois que esta funcao retorna (FR-008/FR-012).
 *
 * Feature 017 (ACXEGDP-437) — pedido de compra (PC). O IGNORAR desfaz o vinculo
 * do item com o PC (NF 7736), entao a receita passa a ser decidida POR ITEM:
 *  - item com PC escolhido e o MESMO vinculo vivo no OMIE -> mantem: so EDITAR
 *    (se faltarem os ajustes) e Concluir — validado na NF 7813 (research D1);
 *  - item com PC escolhido sem vinculo (ou com outro) -> ASSOCIAR-PEDIDO, numa
 *    chamada propria (itensAjustes so com EDITAR — erro 151), depois EDITAR (D2);
 *  - item com vinculo vivo e sem escolha (ex.: fora do recorte de CFOP) -> mantem,
 *    so EDITAR: item com PC NUNCA recebe IGNORAR (FR-011a);
 *  - item sem PC -> receita da 016 (EDITAR + IGNORAR).
 * Antes de escrever: releitura AO VIVO dos PCs escolhidos + reserva de saldo
 * (relerEReservarPcs, D4), e recusa se o vinculo vivo mudou em relacao ao que a
 * tela mostrou (VINCULO_OMIE_MUDOU). Recebimento concluido no portal COM
 * movimento de estoque -> EstoqueJaLancadoPeloOmieError (D7), tambem na reconsulta.
 * Cada vinculo vira linha em stockbridge.recebimento_fiscal_pc:
 * confirmado (reserva) -> associado -> concluido | falha.
 */

export type StatusFiscalLedger = 'em_andamento' | 'concluido' | 'ja_concluido' | 'falha';
export type PassoFiscal = 'consultar' | 'consultar_pc' | 'associar' | 'editar' | 'ignorar' | 'concluir' | 'reconsultar';

/**
 * Tempo apos o qual uma linha `em_andamento` e considerada orfa (processo morreu)
 * e pode ser retomada. Bem acima do pior caso de uma requisicao viva: a consulta
 * tem retry (ate ~2 min na trava de consumo redundante) e cada escrita tem timeout
 * de 30 s (revisao pre-UAT, FISC-3).
 */
export const LOCK_FISCAL_ORFAO_MIN = 15;

/** Espera minima entre uma falha COM escrita no OMIE e a proxima tentativa da mesma NF (cache de ~1 min). */
export const ESPERA_APOS_FALHA_SEG = 70;

/** Passos cuja falha deixa escrita possivelmente feita no OMIE — so eles impoem a espera. */
export const PASSOS_COM_ESCRITA: readonly PassoFiscal[] = Object.freeze(['associar', 'editar', 'ignorar', 'concluir']);

/** Quantos segundos a tela deve esperar antes de oferecer nova tentativa apos esta falha (0 = pode tentar ja). */
export function segundosAteNovaTentativa(err: RecebimentoFiscalError | RecebimentoFiscalAguardeError): number {
  if (err instanceof RecebimentoFiscalAguardeError) return err.segundos;
  return PASSOS_COM_ESCRITA.includes(err.passo) ? ESPERA_APOS_FALHA_SEG : 0;
}


// ── Erros (mensagens em pt-BR, com NF + fornecedor, sem codigo OMIE — ACXEGDP-313) ──

function rotuloNf(notaFiscal: string, fornecedorNome: string | null): string {
  const f = fornecedorNome && fornecedorNome.trim() ? fornecedorNome.trim() : FORNECEDOR_NAO_IDENTIFICADO;
  return `NF ${notaFiscal} (${f})`;
}

/** ", com o vínculo ao PC 304," / ", com o vínculo aos PCs 302 e 304," — so o numero legivel (ACXEGDP-313). */
function trechoPcs(numeros: string[] | undefined): string {
  const nums = Array.from(new Set((numeros ?? []).map((n) => n.trim()).filter((n) => n.length > 0)));
  if (nums.length === 0) return '';
  const lista = nums.length === 1 ? `ao PC ${nums[0]}` : `aos PCs ${nums.slice(0, -1).join(', ')} e ${nums[nums.length - 1]}`;
  return `, com o vínculo ${lista},`;
}

export class RecebimentoFiscalError extends Error {
  constructor(
    public readonly passo: PassoFiscal,
    public readonly notaFiscal: string,
    public readonly fornecedorNome: string | null,
    /** `pcs`: numeros dos PCs em jogo (FR-014: a mensagem cita o PC) */
    options?: { cause?: unknown; pcs?: string[] },
  ) {
    super(
      `Não foi possível concluir o recebimento fiscal da ${rotuloNf(notaFiscal, fornecedorNome)}${trechoPcs(options?.pcs)} no OMIE. ` +
        'Nada foi registrado no estoque — tente novamente em 1 minuto. Se persistir, avise o fiscal.',
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'RecebimentoFiscalError';
  }
}

export class RecebimentoFiscalEmAndamentoError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`O recebimento fiscal da NF ${notaFiscal} já está sendo concluído. Aguarde alguns segundos e recarregue a nota.`);
    this.name = 'RecebimentoFiscalEmAndamentoError';
  }
}

export class RecebimentoFiscalAguardeError extends Error {
  constructor(public readonly notaFiscal: string, public readonly segundos: number) {
    super(
      `A tentativa anterior do recebimento fiscal da NF ${notaFiscal} falhou há instantes. ` +
        `Aguarde cerca de ${segundos} ${segundos === 1 ? 'segundo' : 'segundos'} e tente de novo — o OMIE leva até 1 minuto para mostrar a última alteração.`,
    );
    this.name = 'RecebimentoFiscalAguardeError';
  }
}

export class RecebimentoFiscalSemFornecedorError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`A NF ${notaFiscal} está sem fornecedor cadastrado no OMIE. Peça ao fiscal para cadastrar o fornecedor e tente de novo.`);
    this.name = 'RecebimentoFiscalSemFornecedorError';
  }
}

export class RecebimentoFiscalNfCanceladaError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`A NF ${notaFiscal} consta como cancelada no OMIE e não pode ter o recebimento fiscal concluído.`);
    this.name = 'RecebimentoFiscalNfCanceladaError';
  }
}

/**
 * 409 VINCULO_OMIE_MUDOU (feature 017, T028): o vinculo vivo de algum item no
 * recebimento e diferente do que a tela mostrou E diferente do PC escolhido (ou o
 * item mudou de estado). Vinculo vivo igual ao escolhido nunca e conflito.
 */
export class VinculoOmieMudouError extends Error {
  constructor(public readonly notaFiscal: string, public readonly itemDescricao: string | null) {
    super(
      `O vínculo da NF ${notaFiscal}${itemDescricao ? ` (item ${itemDescricao.trim()})` : ''} com pedido de compra mudou no OMIE. ` +
        'Recarregue a nota e confira o pedido de cada item.',
    );
    this.name = 'VinculoOmieMudouError';
  }
}

export type MotivoEtapaInesperada = 'etapa' | 'bloqueado' | 'devolvido';

export class RecebimentoFiscalEtapaInesperadaError extends Error {
  constructor(public readonly notaFiscal: string, public readonly motivo: MotivoEtapaInesperada) {
    super(
      motivo === 'bloqueado'
        ? `O recebimento da NF ${notaFiscal} está bloqueado no OMIE. Peça ao fiscal para liberar ou concluir o recebimento no OMIE.`
        : motivo === 'devolvido'
          ? `A NF ${notaFiscal} consta como devolvida no OMIE e não pode ter o recebimento fiscal concluído pelo Atlas. Fale com o fiscal.`
          : `O recebimento da NF ${notaFiscal} não está na etapa "Faturado pelo fornecedor" no OMIE, a única em que o Atlas conclui o fiscal. Peça ao fiscal para concluir o recebimento no OMIE.`,
    );
    this.name = 'RecebimentoFiscalEtapaInesperadaError';
  }
}

// ── Contrato ────────────────────────────────────────────────────────────────

export interface ConcluirRecebimentoFiscalInput {
  nfChaveAcesso: string;
  /** do espelho; se nulo, vem da ConsultarRecebimento */
  nIdReceb: number | null;
  notaFiscal: string;
  fornecedorNome: string | null;
  userId: string;
  /** 017: empresa da NF (fase 2 = ACXE). Default 'q2p'. */
  empresa?: EmpresaPc;
  /** 017: nIdFornecedor do recebimento (espelho) — PC de outro fornecedor e recusado na releitura */
  fornecedorCodigo?: number | null;
  /** 017: escolhas de PC validadas no portao 1. Vazio = nenhum item com PC escolhido. */
  vinculos?: EscolhaPcValidada[];
  /** 017: sequencias que seguem SEM vinculo (modo "receber sem vinculo") */
  sequenciasSemVinculo?: number[];
}

/** Vinculo concluido no OMIE neste fiscal (contrato §3, `fiscal.vinculos`). */
export interface VinculoFiscalConcluido {
  nSequencia: number;
  pcNumero: string;
  origem: OrigemVinculoPc;
  status: 'concluido';
}

export interface ConcluirRecebimentoFiscalResult {
  status: 'concluido' | 'ja_concluido';
  concluidoEm: string;
  ledgerId: string;
  /** itens do recebimento no OMIE (0 em ja_concluido sem escrita) */
  itensTotal: number;
  /** 017: itens vinculados a PC pelo Atlas neste fiscal (ou mantidos) */
  vinculos: VinculoFiscalConcluido[];
  /** 017: sequencias concluidas sem vinculo (IGNORAR, modo "receber sem vinculo") */
  semVinculo: number[];
}

// ── Ledger (raw SQL via getPool — espelha o padrao da fila; facil de mockar) ──

/** `token` = `iniciado_em` da posse atual do lock (texto devolvido pelo Postgres, precisao de microssegundo). */
type Ledger = { id: string; token: string };

interface LinhaViva {
  id: string;
  status: StatusFiscalLedger;
  iniciado_em: string;
  finalizado_em: string | null;
}

function violacaoLedgerViva(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const o = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (o.code === '23505' && o.constraint === 'recebimento_fiscal_nf_viva_uq') return true;
    e = o.cause;
  }
  return false;
}

/**
 * Adquire o lock: INSERT `em_andamento`. Antes, a espera apos uma falha com
 * escrita (cache do OMIE). Se ja existe linha viva para a chave:
 *  - `concluido`/`ja_concluido` -> devolve `jaConcluido` (nenhuma chamada OMIE);
 *  - `em_andamento` recente     -> RecebimentoFiscalEmAndamentoError (duplo clique);
 *  - `em_andamento` orfa        -> retoma a linha (UPDATE atomico, novo token).
 */
async function adquirirLedger(
  input: ConcluirRecebimentoFiscalInput,
  tentativa = 0,
): Promise<{ ledger: Ledger; jaConcluido: { concluidoEm: string } | null }> {
  const pool = getPool();

  // Espera apos falha com escrita — em TODA tentativa, inclusive na recursao abaixo:
  // o caso "a outra requisicao acabou de fechar em falha" e justamente o que ela cobre.
  {
    const recente = await pool.query<{ segundos: number | string }>(
      `SELECT CEIL(EXTRACT(EPOCH FROM (finalizado_em + make_interval(secs => $2) - now())))::int AS segundos
         FROM stockbridge.recebimento_fiscal
        WHERE nf_chave_acesso = $1 AND status = 'falha'
          AND passo_falha IN ('associar', 'editar', 'ignorar', 'concluir')
          AND finalizado_em > now() - make_interval(secs => $2)
        ORDER BY finalizado_em DESC
        LIMIT 1`,
      [input.nfChaveAcesso, ESPERA_APOS_FALHA_SEG],
    );
    const espera = recente.rows[0];
    if (espera) throw new RecebimentoFiscalAguardeError(input.notaFiscal, Math.max(1, Number(espera.segundos)));
  }

  try {
    const ins = await pool.query<{ id: string; token: string }>(
      `INSERT INTO stockbridge.recebimento_fiscal
         (nf_chave_acesso, n_id_receb, nota_fiscal, fornecedor_nome, status, confirmado_por, empresa)
       VALUES ($1, $2, $3, $4, 'em_andamento', $5, $6)
       RETURNING id, iniciado_em::text AS token`,
      [input.nfChaveAcesso, input.nIdReceb, input.notaFiscal, input.fornecedorNome, input.userId, input.empresa ?? 'q2p'],
    );
    return { ledger: { id: ins.rows[0]!.id, token: ins.rows[0]!.token }, jaConcluido: null };
  } catch (err) {
    if (!violacaoLedgerViva(err)) throw err;
  }

  const viva = await pool.query<LinhaViva>(
    `SELECT id, status, iniciado_em::text AS iniciado_em, finalizado_em::text AS finalizado_em
       FROM stockbridge.recebimento_fiscal
      WHERE nf_chave_acesso = $1 AND status IN ('em_andamento', 'concluido', 'ja_concluido')
      LIMIT 1`,
    [input.nfChaveAcesso],
  );
  const linha = viva.rows[0];
  if (!linha) {
    // A linha viva sumiu entre o INSERT e o SELECT (outra requisicao fechou em
    // 'falha'): tentar de novo uma vez so.
    if (tentativa >= 1) throw new RecebimentoFiscalEmAndamentoError(input.notaFiscal);
    return adquirirLedger(input, tentativa + 1);
  }
  if (linha.status === 'concluido' || linha.status === 'ja_concluido') {
    return {
      ledger: { id: linha.id, token: linha.iniciado_em },
      jaConcluido: { concluidoEm: linha.finalizado_em ? new Date(linha.finalizado_em).toISOString() : new Date().toISOString() },
    };
  }
  // em_andamento: orfa (processo morreu) -> retoma com novo token; recente -> alguem esta concluindo agora.
  const retomada = await pool.query<{ id: string; token: string }>(
    `UPDATE stockbridge.recebimento_fiscal
        SET confirmado_por = $2, iniciado_em = clock_timestamp(), updated_at = now(),
            n_id_receb = COALESCE($3, n_id_receb)
      WHERE id = $1 AND status = 'em_andamento'
        AND iniciado_em < now() - make_interval(mins => $4)
      RETURNING id, iniciado_em::text AS token`,
    [linha.id, input.userId, input.nIdReceb, LOCK_FISCAL_ORFAO_MIN],
  );
  if (retomada.rows.length === 0) throw new RecebimentoFiscalEmAndamentoError(input.notaFiscal);
  logger.warn({ ledgerId: linha.id, nf: input.notaFiscal, iniciadoEm: linha.iniciado_em }, 'Lock fiscal órfão retomado');
  return { ledger: { id: linha.id, token: retomada.rows[0]!.token }, jaConcluido: null };
}

interface FecharLedgerArgs {
  status: Exclude<StatusFiscalLedger, 'em_andamento'>;
  nIdReceb?: number | null;
  etapaAntes?: string | null;
  recebidoAntes?: string | null;
  itensTotal?: number | null;
  passoFalha?: PassoFiscal | null;
  erroOmieCodigo?: string | null;
  erroOmieMensagem?: string | null;
  /** 017: itens que terminaram vinculados a PC (null = receita da 016) */
  itensVinculados?: number | null;
}

/**
 * Fecha a linha SO se esta requisicao ainda e dona do lock (status em_andamento
 * e mesmo `iniciado_em`). Devolve o `finalizado_em` ou null se perdeu o lock —
 * nesse caso quem retomou e que grava o desfecho.
 */
async function fecharLedger(ledger: Ledger, a: FecharLedgerArgs): Promise<string | null> {
  const pool = getPool();
  const r = await pool.query<{ finalizado_em: string }>(
    `UPDATE stockbridge.recebimento_fiscal
        SET status = $2,
            n_id_receb = COALESCE($3, n_id_receb),
            etapa_antes = COALESCE($4, etapa_antes),
            recebido_antes = COALESCE($5, recebido_antes),
            itens_total = COALESCE($6, itens_total),
            passo_falha = $7,
            erro_omie_codigo = $8,
            erro_omie_mensagem = $9,
            itens_vinculados = COALESCE($11, itens_vinculados),
            finalizado_em = now(),
            updated_at = now()
      WHERE id = $1 AND status = 'em_andamento' AND iniciado_em = $10::timestamptz
      RETURNING finalizado_em::text AS finalizado_em`,
    [
      ledger.id,
      a.status,
      a.nIdReceb ?? null,
      a.etapaAntes ?? null,
      a.recebidoAntes ?? null,
      a.itensTotal ?? null,
      a.passoFalha ?? null,
      a.erroOmieCodigo ?? null,
      a.erroOmieMensagem ? a.erroOmieMensagem.slice(0, 4000) : null,
      ledger.token,
      a.itensVinculados ?? null,
    ],
  );
  const fim = r.rows[0]?.finalizado_em;
  if (!fim) {
    logger.warn({ ledgerId: ledger.id, desfecho: a.status }, 'Lock fiscal perdido para uma retomada — desfecho desta requisição não gravado no ledger');
    return null;
  }
  return new Date(fim).toISOString();
}

/** fecharLedger que nunca lanca: erro de banco aqui nao pode esconder o desfecho/erro do OMIE (FISC-6). */
async function fecharLedgerSeguro(ledger: Ledger, a: FecharLedgerArgs): Promise<string | null> {
  try {
    return await fecharLedger(ledger, a);
  } catch (err) {
    logger.error({ err, ledgerId: ledger.id, desfecho: a.status }, 'Não foi possível gravar o desfecho no ledger fiscal — a linha fica em_andamento até expirar');
    return null;
  }
}

// ── OMIE ────────────────────────────────────────────────────────────────────

/** Extrai codigo/mensagem de um OmieApiError (ou qualquer erro) sem depender de instanceof. */
function extrairErroOmie(err: unknown): { codigo: string | null; mensagem: string } {
  const e = (err ?? {}) as { omieCode?: unknown; message?: unknown };
  return {
    codigo: typeof e.omieCode === 'string' ? e.omieCode : null,
    mensagem: typeof e.message === 'string' ? e.message : String(err),
  };
}

// Research pendencia 3: o faultstring do OMIE para "fornecedor nao cadastrado"
// ainda nao foi observado; a deteccao principal e pela consulta (nIdFornecedor
// 0/nulo ou sem CNPJ). Este regex e a rede secundaria, a calibrar com a primeira
// ocorrencia real.
const RE_SEM_FORNECEDOR = /fornecedor[^.!]*(n[aã]o (cadastrad|informad|encontrad|identificad)|inv[aá]lid|inexist)/i;

const ajustesJaAplicados = (it: ItemRecebimentoNfe) => it.cNaoGerarMovEstoque === 'S' && it.cNaoGerarFinanceiro === 'N';
const ignorado = (it: ItemRecebimentoNfe) => it.cIgnorarItem === 'S';

/** Vinculo vivo do item com um item de PC (017): nIdPedido > 0 ja normalizado pelo parser. */
const vinculoVivo = (it: ItemRecebimentoNfe): { nIdPedido: number; nIdItPedido: number | null } | null =>
  it.nIdPedido != null ? { nIdPedido: it.nIdPedido, nIdItPedido: it.nIdItPedido } : null;

const editarItem = (nSequencia: number): ItemRecebimentoEditar => ({
  nSequencia,
  cAcao: 'EDITAR',
  itensAjustes: { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' },
});

interface PlanoFiscal {
  associar: ItemRecebimentoEditar[];
  editar: ItemRecebimentoEditar[];
  ignorar: ItemRecebimentoEditar[];
  /** sequencias do modo "receber sem vinculo" que vao para o IGNORAR */
  semVinculo: number[];
  /** itens que terminam vinculados a PC (escolhidos ou mantidos) */
  vinculados: number;
}

/**
 * Acao por item (feature 017). EDITAR so em item ainda nao ignorado e sem os
 * ajustes (EDITAR em item ja ignorado nunca foi testado no OMIE real) — exceto
 * logo depois de um ASSOCIAR-PEDIDO, que pode ter mexido no item (D2). IGNORAR so
 * em item SEM vinculo e sem escolha: item com PC nunca e ignorado (FR-011a).
 */
function planejarAcoes(rec: RecebimentoNfeConsultado, escolhas: EscolhaPcValidada[], semVinculo: Set<number>): PlanoFiscal {
  const escolhaPorSeq = new Map<number, EscolhaPcValidada>();
  for (const e of escolhas) for (const seq of e.sequencias) escolhaPorSeq.set(seq, e);
  const plano: PlanoFiscal = { associar: [], editar: [], ignorar: [], semVinculo: [], vinculados: 0 };
  for (const it of rec.itens) {
    if (ignorado(it)) {
      // Retomada: o IGNORAR da tentativa anterior ja passou — o item segue "sem vinculo"
      // no resultado (compras precisa do aviso recebida_sem_vinculo).
      if (semVinculo.has(it.nSequencia)) plano.semVinculo.push(it.nSequencia);
      continue;
    }
    const e = escolhaPorSeq.get(it.nSequencia);
    const vivo = vinculoVivo(it);
    if (e) {
      plano.vinculados++;
      const mesmo = vivo != null && vivo.nIdPedido === e.candidato.nCodPed && vivo.nIdItPedido === e.candidato.nCodItem;
      if (!mesmo) {
        plano.associar.push({
          nSequencia: it.nSequencia,
          cAcao: 'ASSOCIAR-PEDIDO',
          nIdPedidoExistente: e.candidato.nCodPed,
          nIdItPedidoExistente: e.candidato.nCodItem,
        });
      }
      if (!mesmo || !ajustesJaAplicados(it)) plano.editar.push(editarItem(it.nSequencia));
    } else if (vivo) {
      plano.vinculados++;
      if (!ajustesJaAplicados(it)) plano.editar.push(editarItem(it.nSequencia));
    } else {
      if (!ajustesJaAplicados(it)) plano.editar.push(editarItem(it.nSequencia));
      plano.ignorar.push({ nSequencia: it.nSequencia, cAcao: 'IGNORAR' });
      if (semVinculo.has(it.nSequencia)) plano.semVinculo.push(it.nSequencia);
    }
  }
  return plano;
}

/**
 * T028: vinculo vivo diferente do que a tela mostrou E do escolhido -> conflito.
 * Tambem: item escolhido ausente ou ja ignorado no OMIE, e item que seguiria sem
 * vinculo mas ganhou vinculo no OMIE. Vinculo vivo igual ao escolhido nunca e
 * conflito; vinculo removido no OMIE tambem nao (o ASSOCIAR refaz a escolha).
 * Item com linhas ligadas a PCs diferentes (vinculosDivergentes): a tela nao tem um
 * "visto" unico, entao a base de cada sequencia e o vinculo lido no portao 1 — a
 * escolha troca todas as linhas pelo PC escolhido (FR-002c/FR-007), sem 409.
 */
function vinculoMudou(
  rec: RecebimentoNfeConsultado,
  escolhas: EscolhaPcValidada[],
  semVinculo: Set<number>,
): { itemDescricao: string | null; motivo: string } | null {
  for (const e of escolhas) {
    for (const seq of e.sequencias) {
      const it = rec.itens.find((i) => i.nSequencia === seq);
      if (!it) return { itemDescricao: e.itemDescricao, motivo: `sequência ${seq} ausente no recebimento` };
      if (ignorado(it)) return { itemDescricao: e.itemDescricao, motivo: `sequência ${seq} marcada para ignorar no OMIE` };
      const vivo = vinculoVivo(it);
      const base = e.vinculosDivergentes ? (e.vinculosPorSequencia?.[seq]?.nIdItPedido ?? null) : e.nCodItemOmieVisto;
      if (vivo && vivo.nIdItPedido !== base && vivo.nIdItPedido !== e.candidato.nCodItem) {
        return {
          itemDescricao: e.itemDescricao,
          motivo: `sequência ${seq}: vínculo vivo ${vivo.nIdPedido}/${vivo.nIdItPedido} ≠ ${e.vinculosDivergentes ? 'lido no portão' : 'visto'} ${base ?? 'nenhum'} ≠ escolhido ${e.candidato.nCodItem}`,
        };
      }
    }
  }
  for (const seq of semVinculo) {
    const it = rec.itens.find((i) => i.nSequencia === seq);
    if (it && vinculoVivo(it)) return { itemDescricao: it.cDescricaoProduto, motivo: `sequência ${seq} ganhou vínculo no OMIE` };
  }
  return null;
}

/**
 * Sequencias do modo "receber sem vinculo" que terminaram SEM PC no recebimento —
 * tambem nos ramos `ja_concluido` (ex.: o Concluir de uma tentativa anterior passou
 * mas a resposta se perdeu): compras precisa do aviso recebida_sem_vinculo (FR-020).
 */
function semVinculoNoRecebimento(rec: RecebimentoNfeConsultado, semVinculo: Set<number>): number[] {
  return rec.itens.filter((it) => semVinculo.has(it.nSequencia) && !vinculoVivo(it)).map((it) => it.nSequencia);
}

/** Itens nao ignorados que terminaram vinculados a PC (ledger.itens_vinculados; null = nenhum). */
function itensVinculadosNoRecebimento(rec: RecebimentoNfeConsultado): number | null {
  const n = rec.itens.filter((it) => !ignorado(it) && vinculoVivo(it)).length;
  return n > 0 ? n : null;
}

/** D7: recebimento concluido com item nao ignorado e SEM "nao movimentar estoque" = o OMIE lancou o estoque. */
export function estoqueLancadoNoRecebimento(rec: RecebimentoNfeConsultado): boolean {
  return rec.cRecebido === 'S' && rec.itens.some((it) => !ignorado(it) && it.cNaoGerarMovEstoque === 'N');
}

// ── Linhas de vinculo (stockbridge.recebimento_fiscal_pc — T029) ──────────────

async function marcarVinculos(
  ledgerId: string,
  de: Array<'confirmado' | 'associado'>,
  para: 'associado' | 'concluido' | 'falha',
  erro?: { codigo: string | null; mensagem: string },
): Promise<void> {
  await getPool().query(
    // $3::text nas duas posicoes: sem o cast o Postgres deduz varchar (coluna) e text
    // (comparacao) para o mesmo parametro e recusa ("inconsistent types deduced").
    `UPDATE stockbridge.recebimento_fiscal_pc
        SET status = $3::text,
            concluido_em = CASE WHEN $3::text = 'concluido' THEN now() ELSE concluido_em END,
            erro_omie_codigo = COALESCE($4, erro_omie_codigo),
            erro_omie_mensagem = COALESCE($5, erro_omie_mensagem),
            updated_at = now()
      WHERE recebimento_fiscal_id = $1 AND status = ANY($2::text[])`,
    [ledgerId, de, para, erro?.codigo ?? null, erro ? erro.mensagem.slice(0, 4000) : null],
  );
}

/** Nunca lanca: falha ao marcar a linha nao pode esconder o desfecho do OMIE (FISC-6). */
async function marcarVinculosSeguro(...a: Parameters<typeof marcarVinculos>): Promise<void> {
  try {
    await marcarVinculos(...a);
  } catch (err) {
    logger.error({ err, ledgerId: a[0], para: a[2] }, 'Não foi possível atualizar os vínculos com PC do ledger fiscal');
  }
}

/**
 * Fiscal ja concluido no OMIE (portal, ou clique anterior): cada reserva vira
 * `concluido` se o vinculo vivo e o escolhido (nada a escrever — T038), senao
 * `falha` (o fiscal foi concluido sem este vinculo).
 */
async function fecharVinculosJaConcluido(ledgerId: string, rec: RecebimentoNfeConsultado, reservas: ReservaPc[]): Promise<VinculoFiscalConcluido[]> {
  const concluidos: VinculoFiscalConcluido[] = [];
  for (const r of reservas) {
    const it = rec.itens.find((i) => i.nSequencia === r.nSequencia);
    const vivo = it ? vinculoVivo(it) : null;
    const igual = vivo != null && vivo.nIdPedido === r.nCodPed && vivo.nIdItPedido === r.nCodItemPed;
    try {
      await getPool().query(
        `UPDATE stockbridge.recebimento_fiscal_pc
            SET status = $2::text, concluido_em = CASE WHEN $2::text = 'concluido' THEN now() ELSE NULL END,
                erro_omie_mensagem = CASE WHEN $2::text = 'falha' THEN 'Fiscal concluído fora do Atlas sem este vínculo' ELSE erro_omie_mensagem END,
                updated_at = now()
          WHERE id = $1 AND status IN ('confirmado', 'associado')`,
        [r.id, igual ? 'concluido' : 'falha'],
      );
    } catch (err) {
      logger.error({ err, ledgerId, reserva: r.id }, 'Não foi possível fechar a reserva de PC no ja_concluido');
    }
    if (igual) concluidos.push({ nSequencia: r.nSequencia, pcNumero: r.pcNumero, origem: r.origem, status: 'concluido' });
  }
  return concluidos;
}

/** Escolhas que o recebimento ja concluido tem no OMIE (vinculo vivo = escolhido), por sequencia. */
function vinculosJaNoRecebimento(rec: RecebimentoNfeConsultado, escolhas: EscolhaPcValidada[]): VinculoFiscalConcluido[] {
  const out: VinculoFiscalConcluido[] = [];
  for (const e of escolhas) {
    for (const seq of e.sequencias) {
      const it = rec.itens.find((i) => i.nSequencia === seq);
      const vivo = it ? vinculoVivo(it) : null;
      if (vivo && vivo.nIdPedido === e.candidato.nCodPed && vivo.nIdItPedido === e.candidato.nCodItem) {
        out.push({ nSequencia: seq, pcNumero: e.candidato.pcNumero, origem: e.origem, status: 'concluido' });
      }
    }
  }
  return out;
}

/**
 * Instante da conclusao do recebimento no OMIE (infoCadastro.dRec + hRec, horario de
 * Brasilia — sem horario de verao desde 2019), limitado a agora. null quando o OMIE nao
 * informa ou o formato nao e reconhecido.
 */
export function instanteConclusaoOmie(rec: Pick<RecebimentoNfeConsultado, 'dRec' | 'hRec'>, agora: Date = new Date()): Date | null {
  const d = (rec.dRec ?? '').trim();
  const h = (rec.hRec ?? '').trim() || '00:00:00';
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  const hm = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(h);
  if ((!br && !iso) || !hm) return null;
  const [ano, mes, dia] = br ? [br[3], br[2], br[1]] : [iso![1], iso![2], iso![3]];
  const t = new Date(`${ano}-${mes}-${dia}T${hm[1]}:${hm[2]}:${hm[3] ?? '00'}-03:00`);
  if (Number.isNaN(t.getTime())) return null;
  return t.getTime() > agora.getTime() ? agora : t;
}

/**
 * Fecha como `falha` as linhas vivas (confirmado/associado) da NF que sobraram de uma
 * tentativa anterior que morreu — de qualquer ledger: a trava da NF (ledger em_andamento
 * desta tentativa) garante que nenhuma outra tentativa dela esta viva. Sem isto, a linha
 * ficaria viva num ledger fechado, ocupando recebimento_fiscal_pc_item_vivo_uq (achado
 * fiscal-v01). Com escolhas de PC quem fecha e o relerEReservarPcs. Best-effort.
 */
async function fecharReservasOrfasDaNf(nfChaveAcesso: string, empresa: EmpresaPc): Promise<void> {
  try {
    await getPool().query(
      `UPDATE stockbridge.recebimento_fiscal_pc
          SET status = 'falha', updated_at = now(),
              erro_omie_mensagem = COALESCE(erro_omie_mensagem, 'Tentativa anterior sem desfecho; substituída por nova confirmação')
        WHERE nf_chave_acesso = $1 AND empresa = $2 AND status IN ('confirmado', 'associado')`,
      [nfChaveAcesso, empresa],
    );
  } catch (err) {
    logger.error({ err, nfChaveAcesso }, 'Não foi possível fechar as reservas de PC de uma tentativa anterior');
  }
}

/**
 * Fiscal ja concluido na PRIMEIRA consulta (portal, ou Concluir anterior cuja resposta se
 * perdeu): nada foi relido nem reservado nesta tentativa (achado fiscal-02). Fecha as
 * reservas de uma tentativa anterior que morreu (ledger orfao retomado — senao ficariam
 * vivas, ocupando o indice unico) e registra, no estado final, o PC que o operador
 * confirmou em cada linha: `concluido` quando o vinculo vivo e o escolhido, com o instante
 * da conclusao NO OMIE (um `concluido` com o instante atual seria descontado de novo da
 * copia que ja viu a conclusao — achado fiscal-03); `falha` quando o fiscal foi concluido
 * sem ele. Best-effort: erro de banco so vai ao log (a verdade e o OMIE).
 */
async function registrarVinculosJaConcluido(
  ledgerId: string,
  rec: RecebimentoNfeConsultado,
  escolhas: EscolhaPcValidada[],
  ctx: { empresa: EmpresaPc; nfChaveAcesso: string; userId: string },
): Promise<VinculoFiscalConcluido[]> {
  const pool = getPool();
  await fecharReservasOrfasDaNf(ctx.nfChaveAcesso, ctx.empresa);
  const concluidoEm = instanteConclusaoOmie(rec);
  for (const e of escolhas) {
    for (const seq of e.sequencias) {
      const it = rec.itens.find((i) => i.nSequencia === seq);
      const vivo = it ? vinculoVivo(it) : null;
      const igual = vivo != null && vivo.nIdPedido === e.candidato.nCodPed && vivo.nIdItPedido === e.candidato.nCodItem;
      const anterior = anteriorDaSequencia(e, seq);
      try {
        await pool.query(
          `INSERT INTO stockbridge.recebimento_fiscal_pc
             (recebimento_fiscal_id, empresa, nf_chave_acesso, n_sequencia, origem, n_cod_ped, n_cod_item_ped, pc_numero,
              n_cod_ped_omie_anterior, n_cod_item_ped_omie_anterior, dentro_tolerancia, justificativa, candidatos,
              qtd_nf_kg, preco_nf, status, erro_omie_mensagem, confirmado_por, concluido_em)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19)`,
          [
            ledgerId, ctx.empresa, ctx.nfChaveAcesso, seq, e.origem, e.candidato.nCodPed, e.candidato.nCodItem, e.candidato.pcNumero ?? '',
            anterior?.nIdPedido ?? null, anterior?.nIdItPedido ?? null, e.dentroTolerancia, e.justificativa, JSON.stringify(e.oferecidos),
            (e.kgPorSequencia[seq] ?? 0).toFixed(3), e.precoNfKg.toFixed(6),
            igual ? 'concluido' : 'falha', igual ? null : 'Fiscal concluído fora do Atlas sem este vínculo', ctx.userId,
            igual && concluidoEm ? concluidoEm.toISOString() : null,
          ],
        );
      } catch (err) {
        logger.error({ err, ledgerId, nSequencia: seq }, 'Não foi possível registrar o vínculo com PC no ja_concluido');
      }
    }
  }
  return vinculosJaNoRecebimento(rec, escolhas);
}

/** Vinculos `concluido` de um ledger (clique repetido depois de concluido pelo Atlas). */
async function vinculosConcluidosDoLedger(ledgerId: string): Promise<VinculoFiscalConcluido[]> {
  try {
    const r = await getPool().query<{ n_sequencia: number; pc_numero: string; origem: OrigemVinculoPc }>(
      `SELECT n_sequencia, pc_numero, origem FROM stockbridge.recebimento_fiscal_pc
        WHERE recebimento_fiscal_id = $1 AND status = 'concluido' ORDER BY n_sequencia`,
      [ledgerId],
    );
    return r.rows.map((x) => ({ nSequencia: Number(x.n_sequencia), pcNumero: x.pc_numero, origem: x.origem, status: 'concluido' as const }));
  } catch (err) {
    logger.warn({ err: (err as Error).message, ledgerId }, 'Vínculos do ledger fiscal indisponíveis');
    return [];
  }
}

/** Recusas decididas so com a consulta — sempre ANTES de qualquer escrita no OMIE. */
function recusaAntesDeEscrever(rec: RecebimentoNfeConsultado, input: ConcluirRecebimentoFiscalInput): { erro: Error; motivo: string } | null {
  if (rec.cCancelada === 'S') return { erro: new RecebimentoFiscalNfCanceladaError(input.notaFiscal), motivo: 'NF cancelada no OMIE (cCancelada=S)' };
  if (!rec.nIdFornecedor || !rec.cCNPJ_CPF) {
    return { erro: new RecebimentoFiscalSemFornecedorError(input.notaFiscal), motivo: `Recebimento sem fornecedor cadastrado (nIdFornecedor=${rec.nIdFornecedor ?? 'nulo'}, CNPJ ${rec.cCNPJ_CPF ? 'presente' : 'ausente'})` };
  }
  if (rec.cDevolvido === 'S') return { erro: new RecebimentoFiscalEtapaInesperadaError(input.notaFiscal, 'devolvido'), motivo: 'Recebimento devolvido (cDevolvido=S)' };
  if (rec.cBloqueado === 'S') return { erro: new RecebimentoFiscalEtapaInesperadaError(input.notaFiscal, 'bloqueado'), motivo: 'Recebimento bloqueado (cBloqueado=S)' };
  if (rec.cEtapa !== '40') {
    return { erro: new RecebimentoFiscalEtapaInesperadaError(input.notaFiscal, 'etapa'), motivo: `Etapa ${rec.cEtapa || '(vazia)'} — a receita só foi validada a partir da etapa 40` };
  }
  if (rec.itens.length === 0) {
    return {
      erro: new RecebimentoFiscalError('consultar', input.notaFiscal, input.fornecedorNome, { pcs: (input.vinculos ?? []).map((e) => e.candidato.pcNumero) }),
      motivo: 'Recebimento sem itens na ConsultarRecebimento',
    };
  }
  return null;
}

function erroDeDominio(err: unknown): boolean {
  return (
    err instanceof RecebimentoFiscalSemFornecedorError ||
    err instanceof RecebimentoFiscalNfCanceladaError ||
    err instanceof RecebimentoFiscalEtapaInesperadaError ||
    err instanceof RecebimentoFiscalError ||
    err instanceof VinculoOmieMudouError ||
    err instanceof EstoqueJaLancadoPeloOmieError
  );
}

/**
 * Conclui o recebimento fiscal de UMA NF (todos os itens, de uma vez — FR-010).
 *
 * Desfechos:
 *  - `concluido`     — as escritas necessarias passaram; ledger `concluido`.
 *  - `ja_concluido`  — o OMIE ja mostrava cRecebido='S' (alguem concluiu no portal,
 *                      ou um clique anterior deu timeout mas gravou); nada escrito.
 * Falhas lancam (ledger `falha` com passo + erro OMIE):
 *  - RecebimentoFiscalAguardeError        — falha com escrita ha menos de 70 s (cache).
 *  - RecebimentoFiscalEmAndamentoError    — outra confirmacao em curso (lock).
 *  - PcRecemUsadoAguardeError / PcVinculoInvalidoError — releitura do PC (017, D4).
 *  - EstoqueJaLancadoPeloOmieError        — concluido no portal com estoque (017, D7).
 *  - VinculoOmieMudouError                — vinculo vivo mudou (017, T028).
 *  - RecebimentoFiscalSemFornecedorError  — NF sem fornecedor cadastrado no OMIE.
 *  - RecebimentoFiscalNfCanceladaError    — NF cancelada no OMIE.
 *  - RecebimentoFiscalEtapaInesperadaError — fora da etapa 40, bloqueado ou devolvido.
 *  - RecebimentoFiscalError               — fault/timeout em associar/EDITAR/IGNORAR/Concluir
 *                                           (ou na leitura do PC) e a reconsulta nao mostrou concluido.
 */
export async function concluirRecebimentoFiscal(input: ConcluirRecebimentoFiscalInput): Promise<ConcluirRecebimentoFiscalResult> {
  const empresa: EmpresaPc = input.empresa ?? 'q2p';
  const escolhas = input.vinculos ?? [];
  const semVinculo = new Set(input.sequenciasSemVinculo ?? []);
  const { ledger, jaConcluido } = await adquirirLedger(input);
  if (jaConcluido) {
    logger.info({ ledgerId: ledger.id, nf: input.notaFiscal }, 'Fiscal já concluído pelo Atlas (ledger) — nenhuma chamada OMIE');
    return {
      status: 'ja_concluido', concluidoEm: jaConcluido.concluidoEm, ledgerId: ledger.id, itensTotal: 0,
      vinculos: await vinculosConcluidosDoLedger(ledger.id), semVinculo: [],
    };
  }

  let passo: PassoFiscal = 'consultar';
  let nIdReceb: number | null = input.nIdReceb;
  let rec: RecebimentoNfeConsultado | null = null;
  let reservas: ReservaPc[] = [];

  /** Fecha ledger + reservas em `falha` sem escrita no OMIE (recusa de dominio) e devolve o erro para lancar. */
  const recusar = async (erro: Error, motivo: string, passoFalha: PassoFiscal): Promise<Error> => {
    await fecharLedgerSeguro(ledger, {
      status: 'falha', nIdReceb, etapaAntes: rec?.cEtapa ?? null, recebidoAntes: rec?.cRecebido ?? null,
      itensTotal: rec?.itens.length ?? null, passoFalha, erroOmieCodigo: null, erroOmieMensagem: motivo,
    });
    await marcarVinculosSeguro(ledger.id, ['confirmado', 'associado'], 'falha', { codigo: null, mensagem: motivo });
    logger.warn({ ledgerId: ledger.id, nf: input.notaFiscal, nIdReceb, motivo }, 'Recebimento fiscal recusado antes de escrever no OMIE');
    return erro;
  };

  try {
    // 1. Consulta por CHAVE (corpo A) — ANTES da releitura do PC (achado fiscal-02): a NF
    //    ja concluida (portal, ou Concluir cuja resposta se perdeu) vai para ja_concluido/D7
    //    sem exigir saldo de um PC que ela mesma pode ja ter consumido. A reconsulta apos
    //    falha usa nIdReceb (corpo B) — D2.
    rec = await consultarRecebimentoNfe(empresa, { cChaveNfe: input.nfChaveAcesso });
    nIdReceb = rec.nIdReceb;

    if (rec.cRecebido === 'S') {
      // 017 (D7): concluido fora do Atlas COM movimento de estoque -> bloqueia o fisico.
      if (estoqueLancadoNoRecebimento(rec)) {
        throw await recusar(
          new EstoqueJaLancadoPeloOmieError(input.notaFiscal, input.fornecedorNome),
          'Recebimento concluído fora do Atlas com movimento de estoque (item não ignorado e sem "não movimentar estoque")',
          'consultar',
        );
      }
      const concluidoEm = await fecharLedger(ledger, {
        status: 'ja_concluido',
        nIdReceb,
        etapaAntes: rec.cEtapa,
        recebidoAntes: rec.cRecebido,
        itensTotal: rec.itens.length,
        itensVinculados: itensVinculadosNoRecebimento(rec),
      });
      logger.info({ ledgerId: ledger.id, nf: input.notaFiscal, nIdReceb }, 'Fiscal já estava concluído no OMIE — nada escrito');
      return {
        status: 'ja_concluido', concluidoEm: concluidoEm ?? new Date().toISOString(), ledgerId: ledger.id, itensTotal: 0,
        vinculos: await registrarVinculosJaConcluido(ledger.id, rec, escolhas, { empresa, nfChaveAcesso: input.nfChaveAcesso, userId: input.userId }),
        semVinculo: semVinculoNoRecebimento(rec, semVinculo),
      };
    }

    const recusa = recusaAntesDeEscrever(rec, input);
    if (recusa) throw await recusar(recusa.erro, recusa.motivo, 'consultar');

    // 017 (T028): o vinculo vivo mudou em relacao ao que a tela mostrou.
    const mudou = vinculoMudou(rec, escolhas, semVinculo);
    if (mudou) {
      throw await recusar(new VinculoOmieMudouError(input.notaFiscal, mudou.itemDescricao), `Vínculo mudou no OMIE: ${mudou.motivo}`, 'consultar');
    }

    // 2. Feature 017 (D4): PCs relidos AO VIVO e reservados — depois da trava da NF e da
    //    consulta do recebimento (ainda aberto), antes de qualquer escrita. Sem escolha de PC,
    //    so fecha as reservas que sobraram de uma tentativa anterior (achado fiscal-v01).
    if (escolhas.length === 0) await fecharReservasOrfasDaNf(input.nfChaveAcesso, empresa);
    if (escolhas.length > 0) {
      passo = 'consultar_pc';
      try {
        reservas = await relerEReservarPcs({
          empresa, ledgerId: ledger.id, nfChaveAcesso: input.nfChaveAcesso, notaFiscal: input.notaFiscal,
          fornecedorCodigo: input.fornecedorCodigo ?? null, userId: input.userId, escolhas,
          vinculosVivos: Object.fromEntries(rec.itens.map((it) => [it.nSequencia, vinculoVivo(it)])),
        });
      } catch (err) {
        if (err instanceof PcVinculoInvalidoError || err instanceof PcRecemUsadoAguardeError) {
          throw await recusar(err, err.message, 'consultar_pc');
        }
        throw err;
      }
    }

    // 3–6. Escritas, na ordem, so do que falta — SEM retry (STK-23).
    const plano = planejarAcoes(rec, escolhas, semVinculo);
    if (plano.associar.length > 0) {
      passo = 'associar';
      await alterarRecebimentoNfeItens(empresa, { nIdReceb, itens: plano.associar });
    }
    if (reservas.length > 0) await marcarVinculosSeguro(ledger.id, ['confirmado'], 'associado');
    if (plano.editar.length > 0) {
      passo = 'editar';
      await alterarRecebimentoNfeItens(empresa, { nIdReceb, itens: plano.editar });
    }
    if (plano.ignorar.length > 0) {
      passo = 'ignorar';
      await alterarRecebimentoNfeItens(empresa, { nIdReceb, itens: plano.ignorar });
    }
    passo = 'concluir';
    await concluirRecebimentoNfe(empresa, { nIdReceb, cEtapa: '60' });

    const concluidoEm = await fecharLedgerSeguro(ledger, {
      status: 'concluido',
      nIdReceb,
      etapaAntes: rec.cEtapa,
      recebidoAntes: rec.cRecebido,
      itensTotal: rec.itens.length,
      itensVinculados: plano.vinculados > 0 ? plano.vinculados : null,
    });
    if (reservas.length > 0) await marcarVinculosSeguro(ledger.id, ['confirmado', 'associado'], 'concluido');
    logger.info(
      {
        ledgerId: ledger.id, nf: input.notaFiscal, nIdReceb, itens: rec.itens.length, associados: plano.associar.length,
        editados: plano.editar.length, ignorados: plano.ignorar.length, vinculados: plano.vinculados,
      },
      'Recebimento fiscal concluído no OMIE pelo Atlas',
    );
    return {
      status: 'concluido',
      concluidoEm: concluidoEm ?? new Date().toISOString(),
      ledgerId: ledger.id,
      itensTotal: rec.itens.length,
      vinculos: reservas.map((r) => ({ nSequencia: r.nSequencia, pcNumero: r.pcNumero, origem: r.origem, status: 'concluido' as const })),
      semVinculo: plano.semVinculo,
    };
  } catch (err) {
    // Erros de dominio ja fecharam o ledger (e as reservas) acima.
    if (erroDeDominio(err) || err instanceof PcVinculoInvalidoError || err instanceof PcRecemUsadoAguardeError) throw err;

    // O erro do OMIE vai para o log ANTES de qualquer escrita no ledger: se o
    // banco falhar agora, o faultstring nao se perde (FISC-6).
    const omie = extrairErroOmie(err);
    logger.error(
      { err, ledgerId: ledger.id, nf: input.notaFiscal, chave: input.nfChaveAcesso, passo, omieCodigo: omie.codigo },
      'Falha ao concluir recebimento fiscal no OMIE',
    );

    // Reconsulta com o OUTRO corpo (nIdReceb) para furar o cache de ~1 min (D2/D3):
    // so depois de um passo com escrita — um timeout em Concluir pode ter gravado;
    // um fault em EDITAR pode ser "ja concluido".
    let re: RecebimentoNfeConsultado | null = null;
    if (PASSOS_COM_ESCRITA.includes(passo) && nIdReceb != null) {
      try {
        re = await consultarRecebimentoNfe(empresa, { nIdReceb });
      } catch (err2) {
        logger.warn({ err: (err2 as Error).message, nf: input.notaFiscal }, 'Reconsulta após falha do fiscal também falhou');
      }
    }

    if (re && re.cRecebido === 'S') {
      // 017 (D7): tambem na reconsulta — concluido com estoque (ex.: no portal, em paralelo).
      if (estoqueLancadoNoRecebimento(re)) {
        rec = re;
        throw await recusar(
          new EstoqueJaLancadoPeloOmieError(input.notaFiscal, input.fornecedorNome),
          `[${passo}] ${omie.mensagem} — reconsulta: concluído com movimento de estoque`,
          passo,
        );
      }
      const concluidoEm = await fecharLedgerSeguro(ledger, {
        status: 'ja_concluido',
        nIdReceb,
        etapaAntes: rec?.cEtapa ?? null,
        recebidoAntes: rec?.cRecebido ?? null,
        itensTotal: re.itens.length,
        erroOmieCodigo: omie.codigo,
        erroOmieMensagem: `[${passo}] ${omie.mensagem} — reconsulta mostrou cRecebido=S`,
        itensVinculados: itensVinculadosNoRecebimento(re),
      });
      const vinculos = await fecharVinculosJaConcluido(ledger.id, re, reservas);
      logger.warn({ ledgerId: ledger.id, nf: input.notaFiscal, passo }, 'Fault no fiscal, mas a reconsulta mostra concluído — tratado como ja_concluido');
      return {
        status: 'ja_concluido', concluidoEm: concluidoEm ?? new Date().toISOString(), ledgerId: ledger.id, itensTotal: 0,
        vinculos, semVinculo: semVinculoNoRecebimento(re, semVinculo),
      };
    }

    await fecharLedgerSeguro(ledger, {
      status: 'falha',
      nIdReceb,
      etapaAntes: rec?.cEtapa ?? null,
      recebidoAntes: rec?.cRecebido ?? null,
      itensTotal: rec?.itens.length ?? null,
      passoFalha: passo,
      erroOmieCodigo: omie.codigo,
      erroOmieMensagem: omie.mensagem,
    });
    await marcarVinculosSeguro(ledger.id, ['confirmado', 'associado'], 'falha', { codigo: omie.codigo, mensagem: `[${passo}] ${omie.mensagem}` });
    if (RE_SEM_FORNECEDOR.test(omie.mensagem)) throw new RecebimentoFiscalSemFornecedorError(input.notaFiscal);
    // FR-014: a mensagem cita o PC — o numero lido ao vivo (reserva) ou, antes dela, o da escolha.
    const pcs = reservas.length > 0 ? reservas.map((r) => r.pcNumero) : escolhas.map((e) => e.candidato.pcNumero);
    throw new RecebimentoFiscalError(passo, input.notaFiscal, input.fornecedorNome, { cause: err, pcs });
  }
}

// ── Rastreabilidade (contrato §7) ───────────────────────────────────────────

/** Feature 017 (T042): vinculo item da NF -> PC, legivel para o gestor (sem erro_omie_*). */
export interface LedgerFiscalVinculo {
  nSequencia: number;
  pcNumero: string;
  origem: OrigemVinculoPc;
  justificativa: string | null;
  status: 'confirmado' | 'associado' | 'concluido' | 'falha';
  confirmadoPor: { id: string; nome: string | null };
  confirmadoEm: string;
}

export interface LedgerFiscalItem {
  id: string;
  nfChaveAcesso: string;
  notaFiscal: string;
  fornecedorNome: string | null;
  status: StatusFiscalLedger;
  passoFalha: PassoFiscal | null;
  itensTotal: number | null;
  confirmadoPor: { id: string; nome: string | null };
  iniciadoEm: string;
  finalizadoEm: string | null;
  /** feature 017 */
  empresa: EmpresaPc;
  vinculos: LedgerFiscalVinculo[];
}

/** Lista o ledger para o gestor — SEM erro_omie_* (fica no banco e no log; ACXEGDP-313). */
export async function listarLedgerFiscal(params: { status?: StatusFiscalLedger | null; limit?: number } = {}): Promise<LedgerFiscalItem[]> {
  const pool = getPool();
  const limit = Math.min(200, Math.max(1, params.limit ?? 100));
  const args: unknown[] = [limit];
  let filtro = '';
  if (params.status) {
    args.push(params.status);
    filtro = `WHERE rf.status = $${args.length}`;
  }
  const r = await pool.query<{
    id: string; nf_chave_acesso: string; nota_fiscal: string; fornecedor_nome: string | null; status: StatusFiscalLedger;
    passo_falha: PassoFiscal | null; itens_total: number | null; confirmado_por: string; confirmado_por_nome: string | null;
    iniciado_em: string; finalizado_em: string | null; empresa: EmpresaPc | null;
  }>(
    `SELECT rf.id, rf.nf_chave_acesso, rf.nota_fiscal, rf.fornecedor_nome, rf.status, rf.passo_falha, rf.itens_total,
            rf.confirmado_por, u.name AS confirmado_por_nome,
            rf.iniciado_em::text AS iniciado_em, rf.finalizado_em::text AS finalizado_em, rf.empresa
       FROM stockbridge.recebimento_fiscal rf
       LEFT JOIN atlas.users u ON u.id = rf.confirmado_por
       ${filtro}
      ORDER BY rf.iniciado_em DESC
      LIMIT $1`,
    args,
  );
  // Feature 017 (T042): vinculos de cada tentativa — uma consulta para a pagina inteira.
  const vinculosPorLedger = new Map<string, LedgerFiscalVinculo[]>();
  const ids = r.rows.map((x) => x.id);
  if (ids.length > 0) {
    const v = await pool.query<{
      recebimento_fiscal_id: string; n_sequencia: number; pc_numero: string; origem: OrigemVinculoPc; justificativa: string | null;
      status: LedgerFiscalVinculo['status']; confirmado_por: string; confirmado_por_nome: string | null; confirmado_em: string;
    }>(
      `SELECT pc.recebimento_fiscal_id, pc.n_sequencia, pc.pc_numero, pc.origem, pc.justificativa, pc.status,
              pc.confirmado_por, u.name AS confirmado_por_nome, pc.confirmado_em::text AS confirmado_em
         FROM stockbridge.recebimento_fiscal_pc pc
         LEFT JOIN atlas.users u ON u.id = pc.confirmado_por
        WHERE pc.recebimento_fiscal_id = ANY($1::uuid[])
        ORDER BY pc.confirmado_em, pc.n_sequencia`,
      [ids],
    );
    for (const x of v.rows) {
      const lista = vinculosPorLedger.get(x.recebimento_fiscal_id) ?? [];
      lista.push({
        nSequencia: Number(x.n_sequencia),
        pcNumero: x.pc_numero,
        origem: x.origem,
        justificativa: x.justificativa,
        status: x.status,
        confirmadoPor: { id: x.confirmado_por, nome: x.confirmado_por_nome },
        confirmadoEm: new Date(x.confirmado_em).toISOString(),
      });
      vinculosPorLedger.set(x.recebimento_fiscal_id, lista);
    }
  }
  return r.rows.map((x) => ({
    id: x.id,
    nfChaveAcesso: x.nf_chave_acesso,
    notaFiscal: x.nota_fiscal,
    fornecedorNome: x.fornecedor_nome,
    status: x.status,
    passoFalha: x.passo_falha,
    itensTotal: x.itens_total != null ? Number(x.itens_total) : null,
    confirmadoPor: { id: x.confirmado_por, nome: x.confirmado_por_nome },
    iniciadoEm: new Date(x.iniciado_em).toISOString(),
    finalizadoEm: x.finalizado_em ? new Date(x.finalizado_em).toISOString() : null,
    empresa: x.empresa ?? 'q2p',
    vinculos: vinculosPorLedger.get(x.id) ?? [],
  }));
}
