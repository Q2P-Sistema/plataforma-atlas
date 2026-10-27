import { useEffect, useId, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@atlas/ui';
import { useAuthStore } from '../../../stores/auth.store.js';
import { ROTULO_EMPRESA, type Empresa } from '../labels.js';
import {
  ProdutoCombobox,
  ROTULO_SEM_CORRELATO_Q2P,
  agruparDestinos,
  entraNasDuas,
  legendaEntrada,
  msgProdutoSemCorrelatoQ2p,
  produtoSemCorrelatoNoLocal,
  useApiFetch,
  type DestinoEntrada,
  type Localidade,
  type ProdutoEscolhido,
} from './RecebimentoNacionalForm.js';
import {
  AVISO_AMBAR,
  PedidoCompraBloco,
  SELO_AMBAR,
  fmtBrlKg,
  fmtKg,
  localSugeridoPeloPc,
  mesmoPc,
  pcBloqueiaRecebimento,
  pcEscolhaEfetiva,
  pcOpcaoEscolhida,
  pcParaEnvio,
  pcPendencia,
  pcSemOpcao,
  rotuloPc,
  type LocalSugeridoPeloPc,
  type PcCompactoNota,
  type PcDaNf,
  type PcDoItem,
  type PcPendencia,
  type PcRef,
  type PcsDaNf,
} from './PedidoCompraBloco.js';
import {
  PedidoCompraNfBloco,
  escolhasDoPcDaNf,
  justificativaDaNota,
  pcDaNfEscolhido,
  pcJustificativaDaNota,
  preSelecaoDaNf,
  type PcNfItemEstado,
} from './PedidoCompraNfBloco.js';

/**
 * Feature 015 (ACXEGDP-328) — recebimento nacional A PARTIR DA NF.
 *
 * Fila de NFs nacionais pendentes (lida do espelho Postgres) + detalhe da NF com
 * os itens ja preenchidos: descricao do fornecedor, quantidade, unidade, valor
 * unitario e total. O operador NAO digita valor nem unidade — escolhe o produto
 * do catalogo e o estoque destino, e so altera a quantidade quando a balanca
 * discorda da NF (divergencia: motivo obrigatorio, aprovacao do gestor).
 *
 * Historia 3: o produto memorizado para (fornecedor, descricao) vem pre-
 * selecionado; a escolha final e memorizada no servidor ao dar entrada.
 * Historia 4: um item da NF pode virar N produtos (sucata classificada por
 * grau) — a soma das linhas tem de fechar com o peso conferido.
 * Historia 6: item recebido por FORA do Atlas (direto no OMIE) e baixado com
 * motivo e aprovacao do gestor — acao escondida quando a flag esta desligada.
 *
 * O formulario manual continua ao lado (FR-014) para NF fora do espelho.
 * Rotulos: a contraparte e "Fornecedor" — nunca "Destinatario" (research D7).
 * Mensagens: produto por descricao, local por nome; nada de codigo OMIE (313).
 *
 * Feature 017 (ACXEGDP-437) — pedido de compra (PC) no recebimento fiscal.
 * Com o fiscal pendente, o operador confirma, item a item, o PC ao qual o item sera
 * vinculado no OMIE (vinculo que o OMIE ja traz, sugestao do Atlas ou escolha manual com
 * justificativa) — bloco em `PedidoCompraBloco.tsx`. O PC aparece so pelo numero legivel
 * ("PC 304"); `nCodPed`/`nCodItem` ficam so na selecao e no corpo do POST. Tambem aqui:
 * selos de PC na fila, NF "aguardando pedido de compra" (com aviso a equipe de Compras), PC de cada item no resultado, os
 * 409/422/503 novos e o bloqueio quando o estoque ja entrou pelo OMIE. Item pendente que o Atlas nao recebe (unidade que nao
 * converte para kg) e que nao tem PC vinculado no OMIE (`itensSemAvaliacaoPc`): no modo "bloquear" barra a NF inteira, como o
 * 422 NF_SEM_PC do servidor; no modo "receber sem vinculo" so informa que o OMIE o conclui sem vinculo.
 *
 * Historia 5 (Fase 2) — compra nacional da ACXE na mesma fila. A empresa vem da NF (`empresa`), nunca do operador: selo e filtro
 * de empresa na fila so aparecem quando ha ACXE (a tela so da Q2P fica como sempre foi). Na NF da ACXE: o produto e o do catalogo da
 * ACXE (`produto_codigo_acxe`), o destino vem de uma lista propria (`destino=nf`) em dois grupos — "Entra na ACXE e na Q2P" e
 * "Entra só na ACXE" — e o estoque do PC escolhido vem marcado (derivado, sem useEffect; a escolha manual nunca e sobrescrita).
 * Produto sem correspondente na Q2P nao entra em estoque que tambem e da Q2P: a tela previne e bloqueia, e o servidor recusa antes do
 * fiscal. A memoria fornecedor x descricao e so da Q2P: a NF da ACXE nao chama o PUT /correlacao.
 *
 * D21 da 017 — recebimento fiscal REVERTIDO no OMIE: o fiscal da nota foi concluido e alguem o desfez no portal (a nota voltou para
 * a caixa de recebimento de NF-e). O servidor devolve `fiscal: 'pendente'` + `fiscalRevertido: true` — NUNCA um terceiro valor em
 * `SituacaoFiscal`: cada `=== 'pendente'` daqui trata o resto como "concluido" e a nota perderia o bloco de PC e o "Concluir fiscal". A
 * tela so informa (selo na fila, aviso no detalhe, 409 ambar no clique) e deixa o fluxo normal de fiscal pendente fazer o resto: o
 * operador confirma o PC e o Atlas conclui o fiscal de novo. Campo ausente (backend anterior) ou chave do fiscal desligada = nada muda.
 * O texto diz sempre "no OMIE": "revertido" sozinho ja significa outra coisa nesta tela ("Reverter baixa", em Aprovacoes).
 */

interface FilaNacionalItem {
  nfChaveAcesso: string;
  notaFiscal: string;
  fornecedorNome: string;
  fornecedorCnpj: string;
  dtEmissao: string;
  diasDesdeEmissao: number;
  itensTotal: number;
  itensPendentes: number;
  valorTotalBrl: number;
  /** feature 016: 'pendente' = a nota chegou da SEFAZ e o fiscal ainda nao foi concluido no OMIE */
  fiscal: SituacaoFiscal;
  /** quando o Atlas concluiu o fiscal — null se foi no OMIE/portal */
  fiscalConcluidoPeloAtlasEm: string | null;
  /** feature 017 (campos novos: ausentes = backend anterior): empresa da NF; ausente = Q2P */
  empresa?: Empresa;
  /** resumo do PC da NF (pior caso entre os itens); 'nao_aplicavel' = fiscal ja feito ou fiscal pelo Atlas desligado */
  pcSituacao?: PcSituacao;
  /** o fiscal ja lancou o estoque no OMIE: o recebimento fisico aqui lancaria em dobro */
  estoqueLancadoPeloOmie?: boolean;
  /**
   * D21 da 017 (campo novo: ausente = backend anterior = nao): o fiscal foi concluido (pelo Atlas ou no portal) e desfeito no OMIE
   * depois. Vem JUNTO de `fiscal: 'pendente'` — a reversao nunca e um terceiro valor de `SituacaoFiscal`.
   */
  fiscalRevertido?: boolean;
}

type SituacaoFiscal = 'pendente' | 'concluido';
type PcSituacao = 'vinculado_omie' | 'sugerido' | 'escolha_necessaria' | 'aguardando_aprovacao' | 'sem_pc' | 'nao_aplicavel';

/** GET /fila devolve a lista em `data` e a flag da feature 016 em `meta`. */
interface FilaResposta {
  fila: FilaNacionalItem[];
  fiscalHabilitado: boolean;
  /** `meta.recebimentoNacionalAcxeHabilitado` (Historia 5): a ACXE entra na fila neste ambiente; ausente = backend anterior = nao */
  acxeHabilitada: boolean;
}

type Bloqueio = 'unidade_nao_conversivel' | 'unidade_incoerente' | 'sem_correlacao' | null;

interface ProdutoSugerido {
  /** codigo no catalogo da empresa da NF (Q2P: memoria do fornecedor; ACXE: produto do item da nota ou do PC) */
  codigo: number;
  descricao: string;
  vezesUsada: number;
  /** so NF da ACXE: nao ha produto ativo de mesma descricao na Q2P (nao entra em estoque que tambem e da Q2P) */
  semCorrelatoQ2p?: boolean;
}

interface ItemNf {
  indice: number;
  descricaoFornecedor: string;
  cfop: string;
  quantidadeNf: number;
  unidadeOriginal: string;
  quantidadeNfKg: number | null;
  valorUnitarioBrl: number;
  valorTotalItemBrl: number;
  rsPorKg: number | null;
  linhasAgregadas: number;
  produtosSugeridos: ProdutoSugerido[];
  bloqueio: Bloqueio;
  bloqueioMensagem: string | null;
  jaRecebido: boolean;
  quantidadeNfJaAtribuidaKg: number;
  quantidadeConferidaJaGravadaKg: number;
  quantidadeRestanteKg: number | null;
  baixadoComoExterno: boolean;
  /** ha solicitacao de baixa externa aguardando o gestor */
  baixaSolicitada: boolean;
  /** ACXEGDP-412: sequencias do item no recebimento de NF-e do OMIE — casam com `fiscal.vinculos[].nSequencia` */
  sequenciasRecebimento?: number[];
  /** feature 017: PC do item; null/ausente = fiscal pelo Atlas desligado e nada a mostrar */
  pc?: PcDoItem | null;
}

interface DetalheNf {
  nfChaveAcesso: string;
  notaFiscal: string;
  fornecedorNome: string;
  fornecedorCnpj: string;
  dtEmissao: string;
  diasDesdeEmissao: number;
  cfop: string;
  valorTotalBrl: number;
  itens: ItemNf[];
  linhasForaDoRecorte: number;
  /** flag STOCKBRIDGE_RECEBIMENTO_EXTERNO_ENABLED — a acao de baixa some quando false */
  recebimentoExternoHabilitado?: boolean;
  /** feature 016: situacao do recebimento fiscal no OMIE */
  fiscal: SituacaoFiscal;
  nIdReceb: number | null;
  /** gestor pode dispensar a nota da fila (flag ligada, sem dispensa ativa, item pendente) */
  dispensavel: boolean;
  /** flag STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED — selo/banner fiscal somem quando false */
  recebimentoFiscalHabilitado?: boolean;
  /** feature 017 (campos novos: ausentes = backend anterior): empresa da NF (Historia 5); ausente = Q2P */
  empresa?: Empresa;
  /** true = item sem PC possivel bloqueia a NF; false = esse item e recebido sem vinculo */
  exigePc?: boolean;
  /** true = o estoque ja entrou pelo OMIE: bloqueia o recebimento */
  estoqueLancadoPeloOmie?: boolean;
  /**
   * D21 da 017 (campos novos: ausentes = backend anterior): o fiscal foi concluido (pelo Atlas ou no portal) e desfeito no OMIE
   * depois — vem JUNTO de `fiscal: 'pendente'`. `fiscalRevertidoEm` = instante da reversao no OMIE (ISO; null = o OMIE ainda nao
   * disse: o Atlas percebeu pela leitura ao vivo do clique e o espelho ainda nao trouxe a hora — o banner omite a hora).
   */
  fiscalRevertido?: boolean;
  fiscalRevertidoEm?: string | null;
  /** true = lista local de PCs desatualizada: sem sugestao confiavel e, com fiscal pendente, sem recebimento */
  copiaPcsDefasada?: boolean;
  /**
   * Itens PENDENTES que o Atlas nao recebe por bloqueio de unidade e que nao tem PC vinculado no OMIE. So vem preenchido
   * com o fluxo de PC valendo (chave da 016 ligada e fiscal pendente); senao [] (ausente = backend anterior = nenhum).
   * Modo "bloquear" (`exigePc`): o POST da NF e recusado com 422 NF_SEM_PC — o item nao tem como ser avaliado.
   * Modo "receber sem vinculo": o item e concluido no OMIE sem vinculo e compras e avisado depois.
   */
  itensSemAvaliacaoPc?: Array<{ indice: number; descricao: string }>;
  /**
   * NF 19252: itens a receber com linha marcada como "Ignorar" no recebimento do OMIE (espelho). Com PC escolhido o servidor
   * recusa o envio (409 ITEM_IGNORADO_NO_OMIE) — so o fiscal desmarca. So vem preenchido com o fluxo de PC valendo; ausente =
   * backend anterior (nenhum aviso).
   */
  itensIgnoradosNoOmie?: Array<{ indice: number; descricao: string }>;
  /**
   * PC por NF: os pedidos que atendem a nota, com a atribuicao item da NF -> item do PC, para o operador escolher uma vez.
   * Vazio fora do fluxo de PC ou com a lista local defasada; ausente = backend anterior (a tela segue so com o PC por item).
   */
  pcsDaNf?: PcsDaNf;
}

type StatusProduto = 'aguardando_aprovacao' | 'ja_recebido' | 'bloqueado_unidade' | 'bloqueado_unidade_incoerente' | 'falha';

interface ResultadoPorNf {
  notaFiscal: string;
  produtos: Array<{
    indice: number;
    produto: string;
    descricaoFornecedor: string;
    status: StatusProduto;
    quantidadeKg: number;
    mensagemErro?: string;
    /** Historia 5: empresas em que a entrada sera lancada na aprovacao ('acxe','q2p' nos estoques das duas); ausente = backend anterior */
    entradaEm?: Empresa[];
  }>;
  resumo: { enviadosParaAprovacao: number; jaRecebidos: number; bloqueados: number; falhas: number };
  /** feature 016: o que o Atlas fez com o recebimento FISCAL neste envio */
  fiscal?: {
    status: 'concluido' | 'ja_concluido' | 'nao_aplicavel' | 'desligado';
    concluidoEm: string | null;
    mensagem: string;
    /** feature 017: PC de cada item vinculado no OMIE, por sequencia do recebimento */
    vinculos?: VinculoPcResultado[];
    /** feature 017: sequencias recebidas sem PC (modo "receber sem vinculo") */
    semVinculo?: number[];
    /** feature 017: um aviso a compras partiu neste envio */
    avisoCompras?: boolean;
  };
}

type VinculoOrigem = 'omie' | 'sugestao' | 'manual';

interface VinculoPcResultado {
  nSequencia: number;
  pcNumero: string;
  origem: VinculoOrigem;
  status: 'concluido';
}

/** PC de cada item no resultado: `fiscal.vinculos` casado, por sequencia, com os itens enviados. */
interface ResumoPcResultado {
  linhas: Array<{ indice: number; descricao: string; pcs: Array<{ pcNumero: string; origem: VinculoOrigem }>; semVinculo: boolean }>;
  /** vinculos cuja sequencia nao pertence a nenhum item conhecido (espelho sem sequencia) */
  soltos: Array<{ pcNumero: string; origem: VinculoOrigem }>;
}

const ORIGEM_PC: Record<VinculoOrigem, string> = { omie: 'vínculo do OMIE', sugestao: 'sugerido pelo Atlas', manual: 'escolha manual' };
const origensPc = (pcs: Array<{ origem: VinculoOrigem }>) => Array.from(new Set(pcs.map((p) => ORIGEM_PC[p.origem] ?? p.origem))).join(', ');

function montarResumoPc(fiscal: ResultadoPorNf['fiscal'], itens: ItemNf[]): ResumoPcResultado {
  const vinculos = fiscal?.vinculos ?? [];
  const semVinculo = fiscal?.semVinculo ?? [];
  const usadas = new Set<number>();
  const linhas: ResumoPcResultado['linhas'] = [];
  for (const it of itens) {
    const seqs = it.sequenciasRecebimento ?? [];
    const dele = vinculos.filter((v) => seqs.includes(v.nSequencia));
    dele.forEach((v) => usadas.add(v.nSequencia));
    const pcs: ResumoPcResultado['linhas'][number]['pcs'] = [];
    for (const v of dele) if (!pcs.some((p) => p.pcNumero === v.pcNumero)) pcs.push({ pcNumero: v.pcNumero, origem: v.origem });
    const sem = dele.length === 0 && seqs.some((s) => semVinculo.includes(s));
    if (pcs.length > 0 || sem) linhas.push({ indice: it.indice, descricao: it.descricaoFornecedor.trim(), pcs, semVinculo: sem });
  }
  const soltos: ResumoPcResultado['soltos'] = [];
  for (const v of vinculos) {
    if (!usadas.has(v.nSequencia) && !soltos.some((p) => p.pcNumero === v.pcNumero)) soltos.push({ pcNumero: v.pcNumero, origem: v.origem });
  }
  return { linhas, soltos };
}

interface ResultadoBaixa {
  notaFiscal: string;
  aprovacoesCriadas: number;
  jaSolicitados: number;
}

/** POST /aviso-compras: a equipe de Compras foi avisada agora ('enviado') ou ja tinha sido nas ultimas 24 h ('deduplicado'). */
interface AvisoComprasResposta {
  status: 'enviado' | 'deduplicado';
  motivo: 'sem_pc' | 'pc_aguardando_aprovacao';
  itens: string[];
  /** texto pronto para o operador */
  mensagem: string;
}

/** Uma linha "produto no estoque" de um item da NF (Historia 4: pode haver N). */
interface LinhaProduto {
  produto: ProdutoEscolhido | null;
  /** estoque escolhido pelo operador; '' = ainda nao escolheu (na NF da ACXE vale o estoque do PC, se houver — `localDaLinha`) */
  localidadeId: string;
  /** input controlado; so usado quando ha mais de uma linha */
  quantidade: string;
}

/** Estado editavel por item (o resto vem da NF e e somente leitura). */
interface ItemForm {
  linhas: LinhaProduto[];
  /** input controlado; vazio = usa a quantidade da NF */
  quantidadeConferida: string;
  motivoDivergencia: string;
  /** feature 017: PC escolhido. undefined = ainda nao mexeu (vale a pre-selecao do servidor); null = sem escolha */
  pcEscolha?: PcRef | null;
  /** feature 017: justificativa (1 a 500) — so segue no envio quando a escolha a exige */
  pcJustificativa: string;
}

const TOLERANCIA_KG = 1;

const fmtBrl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtData = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('pt-BR');
};
/**
 * " em 25/10 às 17:13" — dia/mes e hora de Brasilia (o fuso das horas do OMIE e da operacao, qualquer que seja o do navegador), para
 * completar uma frase. '' quando o instante falta ou e invalido: a frase segue sem horario, nunca com "Invalid Date".
 */
export function emDataHoraBr(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const fuso = 'America/Sao_Paulo';
  const dia = d.toLocaleString('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit' });
  const hora = d.toLocaleString('pt-BR', { timeZone: fuso, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return ` em ${dia} às ${hora}`;
}
const parseNum = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  // aceita "13.500,5" e "13500.5"
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  return Number.isFinite(n) ? n : NaN;
};

/** Aging da fila do operador: verde ≤3 dias, âmbar ≤7, vermelho depois. */
function agingClass(dias: number): string {
  if (dias <= 3) return 'text-green-700 dark:text-green-400';
  if (dias <= 7) return 'text-amber-700 dark:text-amber-400';
  return 'text-red-700 dark:text-red-400';
}

const STATUS_LABEL: Record<StatusProduto, { label: string; cls: string }> = {
  aguardando_aprovacao: { label: 'Enviado para aprovação', cls: 'text-green-700 dark:text-green-400' },
  ja_recebido: { label: 'Já recebido', cls: 'text-atlas-muted' },
  bloqueado_unidade: { label: 'Bloqueado — unidade', cls: 'text-amber-700 dark:text-amber-400' },
  bloqueado_unidade_incoerente: { label: 'Bloqueado — unidade incoerente', cls: 'text-amber-700 dark:text-amber-400' },
  falha: { label: 'Falha', cls: 'text-red-700 dark:text-red-400' },
};

/** Item que o operador pode receber por aqui: conversivel, nao recebido por inteiro, sem baixa em andamento. */
function itemRecebivel(it: ItemNf): boolean {
  if (it.quantidadeNfKg == null) return false;
  if (it.bloqueio === 'unidade_nao_conversivel' || it.bloqueio === 'unidade_incoerente') return false;
  if (it.jaRecebido && (it.quantidadeRestanteKg ?? 0) <= TOLERANCIA_KG) return false;
  if (it.baixaSolicitada) return false;
  return true;
}

/** Item que pode ser declarado como recebido fora do Atlas. */
function itemBaixavel(it: ItemNf): boolean {
  if (it.baixadoComoExterno || it.baixaSolicitada) return false;
  return !(it.jaRecebido && (it.quantidadeNfJaAtribuidaKg === 0 || (it.quantidadeRestanteKg ?? 0) <= TOLERANCIA_KG));
}

/** Form inicial de um item: os produtos memorizados ja vem selecionados (Historia 3). */
function formInicial(it: ItemNf): ItemForm {
  // NF da ACXE (as sugestoes dela trazem semCorrelatoQ2p): as sugestoes sao ALTERNATIVAS em ordem de confianca (produto
  // que o OMIE associou ao item, depois o do item do PC), nao os produtos do item como a memoria da Q2P — so a 1a
  // vira linha; as outras continuam no combobox. Senao o item abriria com N linhas para ratear o peso.
  const ehSugestaoAcxe = it.produtosSugeridos.some((s) => s.semCorrelatoQ2p !== undefined);
  const sugestoes = ehSugestaoAcxe ? it.produtosSugeridos.slice(0, 1) : it.produtosSugeridos;
  const linhas: LinhaProduto[] =
    sugestoes.length > 0
      ? sugestoes.map((s) => ({
          produto: { codigo: s.codigo, descricao: s.descricao, ...(s.semCorrelatoQ2p !== undefined ? { semCorrelatoQ2p: s.semCorrelatoQ2p } : {}) },
          localidadeId: '',
          quantidade: '',
        }))
      : [{ produto: null, localidadeId: '', quantidade: '' }];
  return { linhas, quantidadeConferida: '', motivoDivergencia: '', pcJustificativa: '' };
}

/** Volta a escolha de PC de todos os itens para a pre-selecao do servidor (a nota foi recarregada). */
function limparEscolhasPc(prev: Record<number, ItemForm>): Record<number, ItemForm> {
  return Object.fromEntries(Object.entries(prev).map(([k, f]) => [k, { ...f, pcEscolha: undefined, pcJustificativa: '' }]));
}

/**
 * Erros em que o servidor recusou com dado que mudou no OMIE, ou que a tela via diferente dele (lista de PCs velha, PC que
 * passou a exigir justificativa, item que ganhou PC possivel): a nota e recarregada junto com a mensagem. A escolha e a
 * justificativa digitadas ficam — `pcEscolha` so vira "sem escolha" se a opcao sumir da nota recarregada. NF_SEM_PC fica de
 * fora: a nota nao mudou, o aviso ambar basta.
 */
const ERROS_QUE_RECARREGAM_NOTA = new Set([
  'ESTOQUE_JA_LANCADO_PELO_OMIE',
  'PC_VINCULO_INVALIDO',
  'VINCULO_OMIE_MUDOU',
  'PC_NAO_ELEGIVEL',
  'PC_NAO_ESCOLHIDO',
  'PC_JUSTIFICATIVA_OBRIGATORIA',
  'COPIA_PCS_DEFASADA',
  // Historia 5: a tela mandou o campo de produto de uma empresa que nao e a da NF (detalhe velho): a nota volta com a empresa certa.
  // PRODUTO_SEM_CORRELATO_Q2P e PRODUTO_CORRELATO_Q2P_REPETIDO ficam de fora: a nota nao mudou, a mensagem diz o que escolher.
  'PRODUTO_EMPRESA_INCOMPATIVEL',
  // a NF mudou desde que a tela abriu (item que passou a ser recebivel ou sumiu): a mensagem do
  // servidor manda recarregar — a tela recarrega e mantem o formulario (achado portao-r02)
  'NF_INCOMPLETA',
  'ITEM_NAO_ENCONTRADO',
  // D21: o fiscal que o Atlas concluiu foi desfeito no OMIE. O servidor ja marcou o ledger como revertido: a nota recarregada volta como
  // fiscal pendente (bloco de PC, "Concluir fiscal e dar entrada") e o formulario digitado fica — nenhum setForm roda para este codigo.
  'RECEBIMENTO_FISCAL_REVERTIDO',
  // NF 19252: item com PC escolhido marcado como "Ignorar" no portal. A nota e recarregada (se o fiscal concluiu no portal, ela
  // deixa de ser fiscal pendente e a caixa sai sozinha); a escolha de PC fica — nao e ela que esta errada, e o fiscal que precisa
  // desmarcar.
  'ITEM_IGNORADO_NO_OMIE',
]);

/**
 * Recusas que orientam o operador (o proximo passo e dele, nada falhou): caixa ambar em vez da vermelha, que no arquivo significa
 * bloqueio ou falha. NF_SEM_PC: avisar compras. RECEBIMENTO_FISCAL_REVERTIDO: a nota reabriu como fiscal pendente, confirmar o PC.
 * ITEM_IGNORADO_NO_OMIE: pedir ao fiscal para desmarcar "Ignorar" no OMIE.
 */
const ERROS_DE_ORIENTACAO = new Set(['NF_SEM_PC', 'RECEBIMENTO_FISCAL_REVERTIDO', 'ITEM_IGNORADO_NO_OMIE']);

/** "ao PC 304" | "aos PCs 304 e 305" | "ao PC (número não informado)" — o PC (ou os PCs) a que um item foi vinculado. */
function textoPcsVinculados(pcs: Array<{ pcNumero: string }>): string {
  if (pcs.length === 1) return `ao ${rotuloPc(pcs[0]?.pcNumero)}`;
  const nomes = pcs.map((p) => p.pcNumero.trim() || '(número não informado)');
  return `aos PCs ${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
}

function textoPendenciaPc(p: PcPendencia, rot: string): string {
  switch (p.tipo) {
    case 'escolher':
      return `Escolha o pedido de compra do item ${rot}.`;
    case 'justificar':
      return `Informe por que o ${rotuloPc(p.pcNumero)} foi escolhido para o item ${rot}.`;
  }
}

/** "A" | "A e B" | "A, B e C" */
function listaPt(partes: string[]): string {
  if (partes.length <= 1) return partes[0] ?? '';
  return `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}`;
}

/**
 * Item pendente com unidade que o Atlas nao converte para kg e sem PC vinculado no OMIE, no modo "bloquear": a NF inteira
 * fica barrada (o servidor recusaria com 422 NF_SEM_PC). `destaque` diz o que ha; `orientacao`, o que fazer.
 */
function textoSemAvaliacaoBloqueio(nomes: string[]): { destaque: string; orientacao: string } {
  const itens = nomes.map((n) => `"${n}"`);
  return nomes.length === 1
    ? {
        destaque: `O item ${itens[0]} tem unidade que o Atlas não converte para kg e não tem pedido de compra vinculado no OMIE.`,
        orientacao: 'Peça ao fiscal para corrigir a unidade ou concluir o recebimento desta NF no OMIE, vinculando o pedido.',
      }
    : {
        destaque: `Os itens ${listaPt(itens)} têm unidades que o Atlas não converte para kg e não têm pedido de compra vinculado no OMIE.`,
        orientacao: 'Peça ao fiscal para corrigir as unidades ou concluir o recebimento desta NF no OMIE, vinculando os pedidos.',
      };
}

/** Mesmo item, no modo "receber sem vinculo": nao bloqueia — o OMIE conclui o recebimento sem vinculo e compras e avisado depois. */
function textoSemAvaliacaoInforma(nomes: string[]): string {
  const itens = nomes.map((n) => `"${n}"`);
  return nomes.length === 1
    ? `O item ${itens[0]} será concluído no OMIE sem vínculo com pedido de compra.`
    : `Os itens ${listaPt(itens)} serão concluídos no OMIE sem vínculo com pedido de compra.`;
}

/**
 * NF 19252: item com pedido de compra a confirmar marcado como "Ignorar" no recebimento do OMIE — o servidor recusaria o envio
 * (409 ITEM_IGNORADO_NO_OMIE). `destaque` diz o que ha; `orientacao`, o que fazer. O aviso nao bloqueia: o espelho pode estar
 * atrasado e o fiscal pode ja ter desmarcado.
 */
function textoIgnoradoNoOmie(nomes: string[], omieDaNf: string, recebimentoBarrado: boolean): { destaque: string; orientacao: string } {
  const itens = nomes.map((n) => `"${n}"`);
  return {
    destaque:
      nomes.length === 1
        ? `O item ${itens[0]} está marcado como "Ignorar" no recebimento do ${omieDaNf}.`
        : `Os itens ${listaPt(itens)} estão marcados como "Ignorar" no recebimento do ${omieDaNf}.`,
    orientacao:
      `Com essa marcação o pedido de compra não pode ser vinculado, e o Atlas recusa a entrada. Peça ao fiscal para desmarcar "Ignorar" no ${omieDaNf}. ` +
      // com outro aviso barrando o botao, nao prometer "pode dar entrada"
      (recebimentoBarrado
        ? `Este aviso sai na próxima atualização do espelho do ${omieDaNf} (até cerca de 30 minutos).`
        : 'Se ele já desmarcou, pode dar entrada: este aviso pode levar até cerca de 30 minutos para sair.'),
  };
}

/** Selo de PC na fila, por `pcSituacao` ('nao_aplicavel' fica sem selo). */
const SELO_PC: Record<Exclude<PcSituacao, 'nao_aplicavel'>, { label: string; title: string; cls: string }> = {
  vinculado_omie: {
    label: 'PC vinculado no OMIE',
    title: 'O OMIE já traz os itens desta nota vinculados a pedido de compra. Confirme o PC na conferência.',
    cls: 'font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  },
  sugerido: {
    label: 'PC sugerido',
    title: 'O Atlas encontrou pedido de compra compatível com os itens desta nota. Confirme o PC na conferência.',
    cls: 'border border-atlas-border text-atlas-muted',
  },
  escolha_necessaria: {
    label: 'Escolher PC',
    title: 'Há mais de um pedido de compra possível, ou o pedido está fora da tolerância de quantidade ou preço. A escolha é feita na conferência.',
    cls: 'font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  },
  aguardando_aprovacao: {
    label: 'PC aguardando aprovação',
    title: 'O pedido de compra desta nota ainda aguarda aprovação no OMIE.',
    cls: 'font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  },
  sem_pc: {
    label: 'Sem PC',
    title: 'Não há pedido de compra aprovado com saldo para esta nota no OMIE.',
    cls: 'font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  },
};

// ── Empresa da NF (Historia 5) ──────────────────────────────────────────────

/**
 * Contorno na cor da marca (ACXE azul, Q2P verde) e texto na cor do tema. Preenchido, o verde da Q2P se confunde com o verde de
 * "tudo certo" dos outros selos, e o texto colorido sobre o card escuro nao passa no contraste.
 */
const BORDA_EMPRESA: Record<Empresa, string> = { acxe: 'border-acxe', q2p: 'border-q2p' };

export function SeloEmpresa({ empresa }: { empresa: Empresa }) {
  return (
    <span className={`text-xs font-medium px-1.5 py-0.5 rounded border text-atlas-ink ${BORDA_EMPRESA[empresa]}`}>
      <span className="sr-only">Empresa </span>
      {ROTULO_EMPRESA[empresa]}
    </span>
  );
}

/** Onde a entrada de um produto e lancada na aprovacao, em frase ("entra na ACXE e na Q2P" | "entra só na ACXE"); '' fora da ACXE. */
export function textoEntradaEm(entradaEm: readonly Empresa[] | null | undefined): string {
  if (!entradaEm?.includes('acxe')) return '';
  return entradaEm.includes('q2p') ? 'entra na ACXE e na Q2P' : 'entra só na ACXE';
}

/**
 * Linha de produto do corpo do POST /por-nf: exatamente UM dos dois campos de codigo, o da empresa da NF (o servidor recusa o
 * outro com 400 PRODUTO_EMPRESA_INCOMPATIVEL). Na NF da ACXE o servidor acha o produto da Q2P de mesma descricao quando o
 * estoque tambem e da Q2P.
 */
export function produtoParaEnvio(empresa: Empresa, codigo: number, quantidadeKg: number, localidadeId: string) {
  return {
    ...(empresa === 'acxe' ? { produto_codigo_acxe: codigo } : { produto_codigo_q2p: codigo }),
    quantidade_kg: quantidadeKg,
    localidade_id: localidadeId,
  };
}

/**
 * Estoque que vale para uma linha de produto. NF da Q2P: so a escolha do operador (como sempre foi). NF da ACXE: a escolha do
 * operador, se a lista de destinos ainda a oferece; senao o estoque do PC escolhido (`sugerido`, tambem so se oferecido) — derivado,
 * sem estado paralelo: trocar o PC da nota muda so as linhas que o operador nao escolheu. `doPedido` diz que veio do PC.
 */
export function localEfetivo(
  empresa: Empresa,
  escolhido: string,
  sugerido: LocalSugeridoPeloPc | null,
  destinos: readonly Pick<DestinoEntrada, 'id'>[],
): { id: string; doPedido: boolean } {
  if (empresa !== 'acxe') return { id: escolhido, doPedido: false };
  if (escolhido && destinos.some((d) => d.id === escolhido)) return { id: escolhido, doPedido: false };
  if (sugerido && destinos.some((d) => d.id === sugerido.localidadeId)) return { id: sugerido.localidadeId, doPedido: true };
  return { id: '', doPedido: false };
}

interface Props {
  /** Abre o formulario manual (NF fora do espelho / fornecedor sem NF-e). */
  onAbrirManual: () => void;
}

export function RecebimentoNacionalNfPanel({ onAbrirManual }: Props) {
  const [chave, setChave] = useState<string | null>(null);
  /** a fila diz se a ACXE esta ligada; o detalhe usa para mostrar a empresa tambem numa NF da Q2P (a lista pode sair do cache enquanto a nota esta aberta) */
  const [acxeAtiva, setAcxeAtiva] = useState(false);
  return chave ? (
    <DetalheSection chave={chave} acxeAtiva={acxeAtiva} onVoltar={() => setChave(null)} onAbrirManual={onAbrirManual} />
  ) : (
    <FilaSection onSelecionar={setChave} onAcxeAtiva={setAcxeAtiva} onAbrirManual={onAbrirManual} />
  );
}

// ── Fila ────────────────────────────────────────────────────────────────────

type FiltroEmpresa = 'todas' | Empresa;

const CHIP_EMPRESA = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs transition-colors';
const CHIP_EMPRESA_ATIVO = `${CHIP_EMPRESA} border-atlas-ink bg-atlas-bg text-atlas-ink font-medium`;
const CHIP_EMPRESA_INATIVO = `${CHIP_EMPRESA} border-atlas-border text-atlas-muted hover:text-atlas-ink`;

function FilaSection({
  onSelecionar,
  onAbrirManual,
  onAcxeAtiva,
}: {
  onSelecionar: (chave: string) => void;
  onAbrirManual: () => void;
  onAcxeAtiva: (ativa: boolean) => void;
}) {
  const apiFetch = useApiFetch();
  const [filtro, setFiltro] = useState('');
  const [filtroEmpresa, setFiltroEmpresa] = useState<FiltroEmpresa>('todas');

  const { data, isLoading, error } = useQuery<FilaResposta, Error>({
    queryKey: ['sb', 'rec-nacional', 'fila'],
    queryFn: async () => {
      const body = (await apiFetch('/api/v1/stockbridge/recebimento/nacional/fila')) as {
        data: unknown;
        meta?: { recebimentoFiscalHabilitado?: boolean; recebimentoNacionalAcxeHabilitado?: boolean };
      };
      return {
        fila: body.data as FilaNacionalItem[],
        fiscalHabilitado: body.meta?.recebimentoFiscalHabilitado === true,
        acxeHabilitada: body.meta?.recebimentoNacionalAcxeHabilitado === true,
      };
    },
  });
  const fila = data?.fila ?? [];
  const fiscalHabilitado = data?.fiscalHabilitado ?? false;
  /** D21: o fiscal que o Atlas concluiu foi desfeito no OMIE — so lido com a chave do fiscal ligada e com a nota em fiscal pendente */
  const fiscalRevertidoNaFila = (x: FilaNacionalItem) => fiscalHabilitado && x.fiscal === 'pendente' && x.fiscalRevertido === true;
  /** a ACXE esta ligada ou ha NF dela na lista: so entao a tela mostra a empresa (sem ACXE ela e a de sempre) */
  const mostrarEmpresa = (data?.acxeHabilitada ?? false) || fila.some((x) => x.empresa === 'acxe');
  useEffect(() => {
    onAcxeAtiva(mostrarEmpresa);
  }, [mostrarEmpresa, onAcxeAtiva]);
  const empresaAtiva: FiltroEmpresa = mostrarEmpresa ? filtroEmpresa : 'todas';

  const f = filtro.trim().toLowerCase();
  const daEmpresa = empresaAtiva === 'todas' ? fila : fila.filter((x) => (x.empresa ?? 'q2p') === empresaAtiva);
  const filtrada = f
    ? daEmpresa.filter((x) => x.notaFiscal.toLowerCase().includes(f) || x.fornecedorNome.toLowerCase().includes(f))
    : daEmpresa;
  const filtrando = f !== '' || empresaAtiva !== 'todas';

  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <h2 className="text-lg font-serif text-atlas-ink">
          Notas fiscais aguardando recebimento
          {!isLoading && fila.length > 0 && (
            <span className="ml-2 text-xs font-sans font-normal text-atlas-muted">
              {filtrando ? `${filtrada.length} de ${fila.length}` : `${fila.length} ${fila.length === 1 ? 'nota fiscal' : 'notas fiscais'}`}
            </span>
          )}
        </h2>
        <div className={`flex items-center gap-2${mostrarEmpresa ? ' flex-wrap' : ''}`}>
          {!isLoading && fila.length > 0 && mostrarEmpresa && (
            <div role="group" aria-label="Filtrar notas por empresa" className="flex items-center gap-1">
              {(['todas', 'acxe', 'q2p'] as const).map((op) => (
                <button
                  key={op}
                  type="button"
                  aria-pressed={empresaAtiva === op}
                  onClick={() => setFiltroEmpresa(op)}
                  className={empresaAtiva === op ? CHIP_EMPRESA_ATIVO : CHIP_EMPRESA_INATIVO}
                >
                  {op !== 'todas' && <span aria-hidden="true" className={`h-2 w-2 rounded-full ${op === 'acxe' ? 'bg-acxe' : 'bg-q2p'}`} />}
                  {op === 'todas' ? 'Todas' : ROTULO_EMPRESA[op]}
                </button>
              ))}
            </div>
          )}
          {!isLoading && fila.length > 0 && (
            <input
              value={filtro}
              onChange={(e) => setFiltro(e.target.value)}
              placeholder="Filtrar por NF ou fornecedor…"
              aria-label="Filtrar fila por número da NF ou fornecedor"
              className="w-64 px-3 py-1.5 border border-atlas-border bg-atlas-bg rounded text-sm outline-none focus:ring-2 focus:ring-atlas-accent"
            />
          )}
          <button
            type="button"
            onClick={onAbrirManual}
            className="px-3 py-1.5 border border-atlas-border text-atlas-ink rounded text-xs font-medium hover:bg-atlas-bg/60 whitespace-nowrap"
          >
            Não encontrou a NF? Registrar manualmente
          </button>
        </div>
      </div>
      <div className="text-xs text-atlas-muted mb-4 space-y-1">
        {fiscalHabilitado ? (
          <>
            <p>
              {mostrarEmpresa ? 'A lista traz as notas de compra da Q2P e da ACXE que chegaram ao OMIE de cada empresa.' : 'A lista traz as notas de compra que chegaram ao OMIE.'}{' '}
              As marcadas como <strong className="text-atlas-ink font-medium">fiscal pendente</strong> terão o
              recebimento fiscal concluído ao confirmar, com cada item vinculado ao pedido de compra (PC) escolhido; as demais já tiveram o fiscal feito e recebem só o estoque.
              Quantidade e valor vêm do documento.
            </p>
            {fila.some(fiscalRevertidoNaFila) && (
              <p>
                As marcadas como <strong className="text-atlas-ink font-medium">fiscal revertido no OMIE</strong> também estão com o fiscal pendente: o recebimento
                fiscal foi concluído e depois desfeito no portal do OMIE. Ao confirmar, o Atlas o conclui de novo.
              </p>
            )}
            <p>
              Notas recém-chegadas da SEFAZ aparecem após a próxima atualização do espelho do OMIE. O formulário manual não conclui o recebimento fiscal:
              use-o só para nota que não está nesta lista e, nesse caso, avise o fiscal.
            </p>
          </>
        ) : (
          <p>A lista vem das notas de compra já registradas no OMIE. Escolha a nota, confira os itens e dê entrada — quantidade e valor vêm do documento.</p>
        )}
      </div>

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando notas…</div>}

      {!isLoading && error != null && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          {error.message}
        </div>
      )}

      {!isLoading && error == null && fila.length === 0 && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-atlas-border rounded-lg">
          {fiscalHabilitado
            ? 'Nenhuma nota nacional aguardando recebimento. Notas recém-chegadas da SEFAZ aparecem após a próxima atualização do espelho do OMIE.'
            : 'Nenhuma nota nacional aguardando recebimento. Se a nota ainda não aparece aqui, registre pelo formulário manual.'}
        </div>
      )}

      {!isLoading && fila.length > 0 && filtrada.length === 0 && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-atlas-border rounded-lg">
          {empresaAtiva === 'todas'
            ? `Nenhuma nota corresponde ao filtro "${filtro.trim()}".`
            : f
              ? `Nenhuma nota da ${ROTULO_EMPRESA[empresaAtiva]} corresponde ao filtro "${filtro.trim()}".`
              : `Nenhuma nota da ${ROTULO_EMPRESA[empresaAtiva]} aguardando recebimento.`}
        </div>
      )}

      {!isLoading && filtrada.length > 0 && (
        <div className="flex flex-col gap-2">
          {filtrada.map((x) => {
            const parcial = x.itensPendentes < x.itensTotal;
            return (
              <div key={x.nfChaveAcesso} className="bg-atlas-card border border-atlas-border rounded-lg p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <span className="font-mono text-sm text-atlas-ink">NF {x.notaFiscal}</span>
                    {mostrarEmpresa && <SeloEmpresa empresa={x.empresa ?? 'q2p'} />}
                    <span className="text-sm text-atlas-ink truncate" title={x.fornecedorNome}>
                      <span className="text-xs text-atlas-muted mr-1">Fornecedor</span>
                      {x.fornecedorCnpj ? x.fornecedorNome : <span className="text-atlas-muted">não identificado no OMIE</span>}
                    </span>
                    {parcial ? (
                      <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                        {x.itensPendentes} de {x.itensTotal} itens pendentes
                      </span>
                    ) : (
                      <span className="text-xs text-atlas-muted">{x.itensTotal} {x.itensTotal === 1 ? 'item' : 'itens'}</span>
                    )}
                    {fiscalHabilitado &&
                      (x.fiscal === 'pendente' && !x.fornecedorCnpj ? (
                        <span
                          className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                          title="O recebimento fiscal está pendente e a nota não tem fornecedor cadastrado no OMIE: só pode ser recebida depois que o fiscal cadastrar o fornecedor."
                        >
                          Sem fornecedor no OMIE
                        </span>
                      ) : x.fiscal === 'pendente' ? (
                        <span
                          className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                          title="A nota chegou da SEFAZ e o recebimento fiscal ainda não foi concluído no OMIE — o Atlas conclui ao dar entrada."
                        >
                          Fiscal pendente
                        </span>
                      ) : (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded border border-atlas-border text-atlas-muted"
                          title={
                            x.fiscalConcluidoPeloAtlasEm
                              ? `Recebimento fiscal concluído pelo Atlas em ${fmtData(x.fiscalConcluidoPeloAtlasEm)}`
                              : 'Recebimento fiscal já concluído no OMIE'
                          }
                        >
                          Fiscal já feito
                        </span>
                      ))}
                    {fiscalRevertidoNaFila(x) && (
                      <span
                        className={SELO_AMBAR}
                        title="O recebimento fiscal desta nota foi concluído e depois desfeito no OMIE. Ao dar entrada, o Atlas conclui o fiscal de novo."
                      >
                        Fiscal revertido no OMIE
                      </span>
                    )}
                    {x.pcSituacao && x.pcSituacao !== 'nao_aplicavel' && SELO_PC[x.pcSituacao] && (
                      <span className={`text-xs px-1.5 py-0.5 rounded ${SELO_PC[x.pcSituacao].cls}`} title={SELO_PC[x.pcSituacao].title}>
                        {SELO_PC[x.pcSituacao].label}
                      </span>
                    )}
                    {x.estoqueLancadoPeloOmie === true && (
                      <span
                        className="text-xs font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                        title="O fiscal concluiu esta nota no OMIE com movimento de estoque. O recebimento físico por aqui está bloqueado para não lançar o estoque em dobro."
                      >
                        Estoque já lançado pelo OMIE — fale com o fiscal
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-atlas-muted mt-0.5">
                    <span className={agingClass(x.diasDesdeEmissao)}>
                      {x.diasDesdeEmissao === 0
                        ? 'emitida hoje'
                        : `emitida em ${fmtData(x.dtEmissao)} · há ${x.diasDesdeEmissao} ${x.diasDesdeEmissao === 1 ? 'dia' : 'dias'}`}
                    </span>
                  </div>
                  {/* o title dos selos nao alcanca teclado nem toque: o motivo da reversao fica escrito na linha */}
                  {fiscalRevertidoNaFila(x) && (
                    <div className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
                      O recebimento fiscal desta nota foi concluído e depois desfeito no OMIE.
                      {x.fornecedorCnpj ? ' Ao dar entrada, o Atlas conclui o fiscal de novo.' : ''}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="font-serif text-atlas-ink">{fmtBrl(x.valorTotalBrl)}</div>
                  <div className="text-[11px] uppercase tracking-wide text-atlas-muted">Valor da nota</div>
                </div>
                <button
                  onClick={() => onSelecionar(x.nfChaveAcesso)}
                  className={`px-4 py-2 rounded text-sm font-medium whitespace-nowrap ${
                    x.estoqueLancadoPeloOmie === true
                      ? 'border border-atlas-border text-atlas-ink hover:bg-atlas-bg'
                      : 'bg-atlas-btn-bg text-atlas-btn-text hover:opacity-90'
                  }`}
                >
                  Conferir →
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Detalhe ─────────────────────────────────────────────────────────────────

type PedidoBaixa = { modo: 'item'; item: ItemNf } | { modo: 'todos' };

function DetalheSection({
  chave,
  acxeAtiva,
  onVoltar,
  onAbrirManual,
}: {
  chave: string;
  /** a fila avisou que a ACXE esta ligada: a empresa aparece no cabecalho tambem numa NF da Q2P */
  acxeAtiva: boolean;
  onVoltar: () => void;
  onAbrirManual: () => void;
}) {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Record<number, ItemForm>>({});
  const [resultado, setResultado] = useState<ResultadoPorNf | null>(null);
  /** feature 017: PC de cada item do envio, casado por sequencia (montado no sucesso, com os itens da epoca do clique) */
  const [pcResultado, setPcResultado] = useState<ResumoPcResultado | null>(null);
  const [erroEnvio, setErroEnvio] = useState<string | null>(null);
  /** codigo do erro da API (feature 016: 409 em andamento -> recarregar; 502 fiscal -> tentar de novo) */
  const [erroCodigo, setErroCodigo] = useState<string | null>(null);
  const [pedidoBaixa, setPedidoBaixa] = useState<PedidoBaixa | null>(null);
  const [dispensando, setDispensando] = useState(false);
  /** feature 016: apos falha do fiscal, o servidor recusa nova tentativa por ~1 min (cache do OMIE) — a UI espera junto */
  const [retryLiberaEm, setRetryLiberaEm] = useState<number | null>(null);
  const [agora, setAgora] = useState(() => Date.now());
  const [motivoDispensa, setMotivoDispensa] = useState('');
  const role = useAuthStore((s) => s.user?.role);

  useEffect(() => {
    if (retryLiberaEm == null) return;
    const t = setInterval(() => {
      const n = Date.now();
      setAgora(n);
      if (n >= retryLiberaEm) {
        setRetryLiberaEm(null);
        clearInterval(t);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [retryLiberaEm]);
  const [motivoBaixa, setMotivoBaixa] = useState('');
  const [avisoBaixa, setAvisoBaixa] = useState<string | null>(null);

  const { data: nf, isLoading, isFetching, error } = useQuery<DetalheNf, Error>({
    queryKey: ['sb', 'rec-nacional', 'detalhe', chave],
    queryFn: async () => (await apiFetch(`/api/v1/stockbridge/recebimento/nacional/fila/${chave}`)).data as DetalheNf,
  });

  /** Historia 5: empresa da NF (ausente = backend anterior = Q2P). So se sabe com o detalhe carregado. */
  const empresaNf: Empresa = nf?.empresa ?? 'q2p';
  const ehAcxe = empresaNf === 'acxe';
  /** o OMIE em que o fiscal acontece, nos textos da tela (a Q2P segue dizendo so "OMIE") */
  const omieDaNf = ehAcxe ? 'OMIE da ACXE' : 'OMIE';
  const mostrarEmpresa = acxeAtiva || ehAcxe;

  // NF da Q2P: a lista plana de sempre (sai em paralelo com o detalhe; deixa de ser buscada quando a NF se mostra da ACXE)
  const { data: localidades = [] } = useQuery<Localidade[], Error>({
    queryKey: ['sb', 'rec-nacional', 'localidades', 'q2p'],
    enabled: !ehAcxe,
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/recebimento/nacional/localidades?empresa=q2p')).data as Localidade[],
  });

  // NF da ACXE: destinos da entrada por NF (locais da ACXE com a empresa(s) em que cada um lanca). Chave propria — a do formulario
  // manual (`localidades`) lista so estoques de uma empresa — e so depois do detalhe, para nao oferecer a lista errada.
  const {
    data: destinosAcxe = [],
    error: destinosErro,
    isSuccess: destinosCarregados,
    isFetching: destinosBuscando,
    refetch: recarregarDestinos,
  } = useQuery<DestinoEntrada[], Error>({
    queryKey: ['sb', 'rec-nacional', 'destinos', 'acxe'],
    enabled: ehAcxe,
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/recebimento/nacional/localidades?empresa=acxe&destino=nf')).data as DestinoEntrada[],
  });
  /** estoques oferecidos nesta NF: os destinos da ACXE ou a lista plana da Q2P */
  const destinos: DestinoEntrada[] = ehAcxe ? destinosAcxe : localidades;

  const getForm = (it: ItemNf): ItemForm => form[it.indice] ?? formInicial(it);
  const setItem = (it: ItemNf, patch: Partial<ItemForm>) => setForm((prev) => ({ ...prev, [it.indice]: { ...getForm(it), ...patch } }));

  const recebiveis = useMemo(() => (nf?.itens ?? []).filter(itemRecebivel), [nf]);
  const baixaveis = useMemo(() => (nf?.itens ?? []).filter(itemBaixavel), [nf]);
  const baixaHabilitada = nf?.recebimentoExternoHabilitado !== false;
  /** feature 016: a NF esta com o recebimento fiscal pendente no OMIE */
  const fiscalPendente = nf?.recebimentoFiscalHabilitado === true && nf.fiscal === 'pendente';
  /** D21: o Atlas concluiu o fiscal e ele foi desfeito no OMIE depois (so informa: o fluxo e o do fiscal pendente, `fiscal` segue 'pendente') */
  const fiscalRevertido = fiscalPendente && nf?.fiscalRevertido === true;
  /** fornecedor nao cadastrado no OMIE: o fiscal nao pode ser concluido ate o fiscal cadastrar */
  const fiscalSemFornecedor = fiscalPendente && !nf?.fornecedorCnpj;
  /** o fiscal sera concluido no OMIE neste clique (ha o que receber e fornecedor cadastrado) */
  const fiscalNoClique = fiscalPendente && !fiscalSemFornecedor && recebiveis.length > 0;
  /** baixa externa nao cabe em NF com fiscal pendente (tiraria a nota da fila com o fiscal parado) */
  const baixaPermitida = baixaHabilitada && !fiscalPendente;
  const retryRestanteSeg = retryLiberaEm != null ? Math.max(0, Math.ceil((retryLiberaEm - agora) / 1000)) : 0;
  /** feature 016 (Historia 4): gestor/diretor pode tirar da fila uma NF que nunca sera recebida */
  const podeDispensar = (role === 'gestor' || role === 'diretor') && nf?.recebimentoFiscalHabilitado === true && nf.dispensavel === true && !resultado;

  // ── feature 017: pedido de compra (PC) ──
  /** o PC so entra quando o Atlas conclui o fiscal agora: flag ligada, fiscal pendente e fornecedor cadastrado */
  const pcAtivo = fiscalPendente && !fiscalSemFornecedor;
  /** true = item sem PC possivel bloqueia a NF; false = esse item e recebido sem vinculo (o servidor decide; ausente = bloquear) */
  const exigePc = nf?.exigePc !== false;
  /** lista local de PCs desatualizada: sem sugestao confiavel e, com fiscal pendente, sem recebimento ate ela voltar */
  const copiaPcsDefasada = fiscalPendente && nf?.copiaPcsDefasada === true;
  /** o fiscal ja lancou o estoque no OMIE: receber aqui lancaria em dobro (vale tambem com o fiscal pelo Atlas desligado) */
  const estoqueLancadoPeloOmie = nf?.estoqueLancadoPeloOmie === true;
  // ── PC por NF: o operador escolhe o pedido uma vez; a escolha e expandida em `pcEscolha` de cada item coberto ──
  /** pedidos que atendem a nota inteira, na ordem do servidor (vazio = backend anterior, fora do fluxo de PC ou lista defasada) */
  const pcsDaNf = nf?.pcsDaNf?.pcs ?? [];
  const pcNfDisponivel = pcAtivo && !copiaPcsDefasada && recebiveis.length > 0 && pcsDaNf.length > 0;
  /** pre-selecao do servidor para a nota: vale so nos itens em que o operador ainda nao mexeu (`pcEscolha === undefined`) */
  const preSelecaoNf = useMemo(() => (pcNfDisponivel ? preSelecaoDaNf(nf?.pcsDaNf) : new Map<number, PcRef>()), [nf, pcNfDisponivel]);
  /** escolha do formulario do item com a pre-selecao da nota: `undefined` = nem o operador nem a nota escolheram (vale a pre-selecao do item) */
  const escolhaFormDoItem = (it: ItemNf, fi: ItemForm = getForm(it)): PcRef | null | undefined =>
    fi.pcEscolha !== undefined ? fi.pcEscolha : preSelecaoNf.get(it.indice);
  /**
   * Historia 5: estoque do PC que vale para o item (a escolha do operador ou a pre-selecao), so na NF da ACXE — o fluxo da Q2P nao
   * muda. Derivado a cada render (sem useEffect): acompanha a troca de PC da nota e nunca sobrescreve uma escolha manual.
   */
  const localSugeridoDoItem = (it: ItemNf): LocalSugeridoPeloPc | null =>
    ehAcxe && pcAtivo && !copiaPcsDefasada ? localSugeridoPeloPc(it.pc, escolhaFormDoItem(it), nf?.pcsDaNf?.pcs, it.indice) : null;
  /** estoque que vale para a linha (a escolha do operador, ou o do PC) — o mesmo na tela, na validacao e no corpo do POST */
  const localDaLinha = (it: ItemNf, l: LinhaProduto) => localEfetivo(empresaNf, l.localidadeId, localSugeridoDoItem(it), destinos);
  const indicesRecebiveis = new Set(recebiveis.map((it) => it.indice));
  const estadoPcItens: PcNfItemEstado[] = pcNfDisponivel
    ? recebiveis.flatMap((it) => (it.pc ? [{ indice: it.indice, pc: it.pc, escolhaForm: escolhaFormDoItem(it) }] : []))
    : [];
  /** pedido marcado na nota: derivado das escolhas por item (todos os itens cobertos seguem a atribuicao dele) */
  const pcEscolhidoNf = pcNfDisponivel ? pcDaNfEscolhido(pcsDaNf, estadoPcItens) : null;
  /** item a receber coberto pelo pedido marcado -> atribuicao dele */
  const atribuicaoNf = new Map((pcEscolhidoNf?.itens ?? []).filter((a) => indicesRecebiveis.has(a.indice)).map((a) => [a.indice, a] as const));
  /**
   * Linha compacta do PC no item ("Usar outro pedido de compra neste item"): o item segue o pedido marcado na nota, ou nenhum
   * pedido esta marcado ainda e algum pedido da nota atende o item sem que ele tenha escolha propria. Nesse segundo caso a
   * escolha e feita no bloco da nota — antes, as mesmas opcoes apareciam tambem no item (NF 19252, 25/10/2026).
   */
  const compactoNotaDoItem = (it: ItemNf): PcCompactoNota | null => {
    const atribuicao = atribuicaoNf.get(it.indice);
    if (pcEscolhidoNf && atribuicao) return { pcNumero: pcEscolhidoNf.pcNumero, produtoDescricao: atribuicao.produtoDescricao ?? '' };
    const atendidoPelaNota = pcsDaNf.some((p) => (p.itens ?? []).some((a) => a.indice === it.indice));
    if (pcNfDisponivel && pcEscolhidoNf == null && it.pc && atendidoPelaNota && pcEscolhaEfetiva(it.pc, escolhaFormDoItem(it)) == null) {
      return { pcNumero: '', produtoDescricao: '', aguardandoNota: true };
    }
    return null;
  };
  /** uma so justificativa por nota: gravada em `pcJustificativa` de todos os itens cobertos */
  const justNotaInfo = pcJustificativaDaNota(pcEscolhidoNf, estadoPcItens);
  const modoJustNota = pcEscolhidoNf != null && justNotaInfo.obrigatoria;
  const justificativaNota = justificativaDaNota(pcEscolhidoNf, (indice) => form[indice]?.pcJustificativa ?? '');
  const faltaJustificativaNota = modoJustNota && justificativaNota.trim() === '';
  /** o item usa a justificativa da nota: o campo por item nao aparece e vale o texto da nota */
  const itemNaJustNota = (it: ItemNf): boolean => modoJustNota && atribuicaoNf.has(it.indice);
  const justificativaPcDoItem = (it: ItemNf): string => (itemNaJustNota(it) ? justificativaNota : getForm(it).pcJustificativa);
  /** o operador escolheu o pedido da nota: aplica a atribuicao em cada item coberto; os demais itens seguem com a escolha propria */
  function escolherPcDaNf(p: PcDaNf) {
    const aplicar = escolhasDoPcDaNf(p, indicesRecebiveis);
    if (aplicar.length === 0) return;
    // Trocar o pedido da nota LIMPA a justificativa: o texto escrito para o PC anterior nao justifica o
    // novo (revisao de design, 22/10/2026). Marcar de novo o mesmo pedido mantem o que estava.
    const mesmoPedido = pcEscolhidoNf?.nCodPed === p.nCodPed;
    const texto = mesmoPedido ? justificativaNota : '';
    setForm((prev) => {
      const prox = { ...prev };
      for (const { indice, ref } of aplicar) {
        const it = recebiveis.find((i) => i.indice === indice);
        if (it) prox[indice] = { ...(prev[indice] ?? formInicial(it)), pcEscolha: ref, pcJustificativa: texto };
      }
      return prox;
    });
  }
  function justificarNota(texto: string) {
    setForm((prev) => {
      const prox = { ...prev };
      for (const it of recebiveis) {
        if (atribuicaoNf.has(it.indice)) prox[it.indice] = { ...(prev[it.indice] ?? formInicial(it)), pcJustificativa: texto };
      }
      return prox;
    });
  }
  /** o que falta em item COM PC possivel para o PC estar confirmado (escolha ou justificativa): isso desabilita o botao */
  const pcPendencias: Array<{ it: ItemNf; p: PcPendencia }> =
    pcAtivo && !copiaPcsDefasada
      ? recebiveis.flatMap((it) => {
          if (!it.pc) return [];
          const p = pcPendencia(it.pc, escolhaFormDoItem(it), justificativaPcDoItem(it));
          return p ? [{ it, p }] : [];
        })
      : [];
  /** pendencias que a tela diz por item (as de justificativa dos itens cobertos viram uma so, a da nota) */
  const pendenciasItens = pcPendencias.filter((x) => !itemNaJustNota(x.it));
  /** com o bloco da nota na tela e nenhum pedido marcado, o que falta e escolher o pedido da nota (nao o de cada item) */
  const faltaEscolherNota = pcNfDisponivel && pcEscolhidoNf == null && pendenciasItens.some((x) => x.p.tipo === 'escolher');
  const textoJustNota = `Informe por que o ${rotuloPc(pcEscolhidoNf?.pcNumero)} foi escolhido para a nota.`;
  /**
   * Itens a receber sem PC que possa ser vinculado (inclusive vinculo do OMIE inelegivel ou divergente sem outro PC,
   * nos dois modos): a nota nao pode ser recebida agora. Banner "Aguardando pedido de compra" com o botao que avisa a
   * equipe de Compras (POST /aviso-compras) e botao de receber desabilitado. Se um POST de recebimento chegar mesmo
   * assim (corrida), o servidor recusa com 422 NF_SEM_PC.
   */
  const itensSemPc = pcAtivo && !copiaPcsDefasada ? recebiveis.filter((it) => it.pc != null && pcBloqueiaRecebimento(it.pc, exigePc)).length : 0;
  const aguardandoPcCompras = itensSemPc > 0;
  /**
   * Itens pendentes que o Atlas nao recebe (bloqueio de unidade) e sem PC vinculado no OMIE: o servidor nao tem como
   * avalia-los (`itensSemAvaliacaoPc`, so preenchido com o fluxo de PC valendo). Com a lista de PCs defasada o servidor nao
   * decide nada de PC (D13) e o aviso da lista velha vale sozinho. Lista ausente ou vazia = nada disto aparece.
   */
  const listaSemAvaliacao = nf?.itensSemAvaliacaoPc;
  const nomesSemAvaliacao =
    pcAtivo && !copiaPcsDefasada && Array.isArray(listaSemAvaliacao)
      ? listaSemAvaliacao.map((x) => (x.descricao ?? '').trim() || nf?.itens.find((i) => i.indice === x.indice)?.descricaoFornecedor.trim() || '(sem descrição)')
      : [];
  /** modo "bloquear": a NF inteira fica barrada (o servidor recusa com 422 NF_SEM_PC); no modo "receber sem vinculo" so informa */
  const semAvaliacaoBloqueia = exigePc && nomesSemAvaliacao.length > 0;
  const semAvaliacaoInforma = !exigePc && nomesSemAvaliacao.length > 0;
  const avisoSemAvaliacao = semAvaliacaoBloqueia ? textoSemAvaliacaoBloqueio(nomesSemAvaliacao) : null;
  /**
   * NF 19252: itens a receber marcados como "Ignorar" no recebimento do OMIE e com pedido de compra a confirmar — o servidor
   * recusaria o envio (409 ITEM_IGNORADO_NO_OMIE). So avisa, sem desabilitar o botao: o espelho atualiza a cada 30 min e o
   * fiscal pode ter acabado de desmarcar; quem decide e a leitura ao vivo do clique. Item ignorado sem PC segue sem vinculo.
   */
  const nomesIgnoradosNoOmie =
    pcAtivo && !copiaPcsDefasada
      ? (nf?.itensIgnoradosNoOmie ?? []).flatMap((x) => {
          const it = recebiveis.find((i) => i.indice === x.indice);
          if (!it?.pc || pcSemOpcao(it.pc)) return [];
          return [(x.descricao ?? '').trim() || it.descricaoFornecedor.trim() || '(sem descrição)'];
        })
      : [];
  /**
   * O espelho ou o ultimo clique (409 ITEM_IGNORADO_NO_OMIE) viu a marcacao: a tela deixa de prometer que o fiscal sera concluido
   * com o pedido de compra vinculado (avisos do fiscal pendente, da reversao e o rodape do botao).
   */
  const haIgnoradoNoOmie = nomesIgnoradosNoOmie.length > 0 || erroCodigo === 'ITEM_IGNORADO_NO_OMIE';
  // O 409 descreve a nota como estava no clique. Se ela deixa de ser fiscal pendente (o fiscal concluiu no portal), a caixa
  // mandaria esperar uma desmarcacao que ja nao e necessaria: sai sozinha.
  useEffect(() => {
    if (erroCodigo === 'ITEM_IGNORADO_NO_OMIE' && !pcAtivo) {
      setErroEnvio(null);
      setErroCodigo(null);
    }
  }, [erroCodigo, pcAtivo]);
  /** recebimento barrado por um aviso proprio (banner acima dos itens): botao desabilitado */
  const recebimentoBarrado = estoqueLancadoPeloOmie || copiaPcsDefasada || aguardandoPcCompras || semAvaliacaoBloqueia;
  /**
   * Aviso do espelho. Some enquanto a caixa do 409 ITEM_IGNORADO_NO_OMIE esta na tela: ela traz a lista lida ao vivo, e o espelho
   * pode estar atrasado (duas listas diferentes lado a lado confundiriam).
   */
  const avisoIgnoradoNoOmie =
    nomesIgnoradosNoOmie.length > 0 && erroCodigo !== 'ITEM_IGNORADO_NO_OMIE'
      ? textoIgnoradoNoOmie(nomesIgnoradosNoOmie, omieDaNf, recebimentoBarrado)
      : null;
  const bloqueadoPorPc = recebimentoBarrado || pcPendencias.length > 0 || faltaJustificativaNota;
  /** por que o botao esta desabilitado (aviso visivel ao lado do botao) */
  const primeiraPendenciaPc = pendenciasItens[0];
  const nomeItem = (it: ItemNf) => `"${it.descricaoFornecedor.trim()}"`;
  const dicaPc = estoqueLancadoPeloOmie
    ? 'Recebimento bloqueado: o estoque desta NF já entrou pelo OMIE. Fale com o fiscal.'
    : copiaPcsDefasada
      ? 'Recebimento bloqueado: a lista de pedidos de compra está desatualizada.'
      : aguardandoPcCompras
        ? 'Recebimento bloqueado: a nota está aguardando pedido de compra.'
        : semAvaliacaoBloqueia
          ? nomesSemAvaliacao.length === 1
            ? `Recebimento bloqueado: o item "${nomesSemAvaliacao[0]}" tem unidade que o Atlas não converte e não tem pedido de compra vinculado no OMIE.`
            : `Recebimento bloqueado: ${nomesSemAvaliacao.length} itens têm unidade que o Atlas não converte e não têm pedido de compra vinculado no OMIE.`
          : faltaEscolherNota
            ? 'Escolha o pedido de compra da nota.'
            : faltaJustificativaNota
              ? `Falta a justificativa do ${rotuloPc(pcEscolhidoNf?.pcNumero)} para a nota.`
              : !primeiraPendenciaPc
                ? null
                : pendenciasItens.length > 1
                  ? `Falta escolher ou justificar o pedido de compra em ${pendenciasItens.length} itens.`
                  : primeiraPendenciaPc.p.tipo === 'justificar'
                    ? `Falta a justificativa do ${rotuloPc(primeiraPendenciaPc.p.pcNumero)} no item ${nomeItem(primeiraPendenciaPc.it)}.`
                    : `Falta escolher o pedido de compra do item ${nomeItem(primeiraPendenciaPc.it)}.`;
  /** ha item com PC para confirmar neste envio (muda o texto do aviso do fiscal) */
  const haPcParaConfirmar = pcAtivo && !copiaPcsDefasada && recebiveis.some((it) => it.pc != null);
  /** D21: algum item a receber tem PC que o operador possa de fato confirmar (opcao selecionavel) — o aviso da reversao so o promete entao */
  const haPcSelecionavel = pcAtivo && !copiaPcsDefasada && recebiveis.some((it) => it.pc != null && !pcSemOpcao(it.pc));

  /** Peso que ainda entra por este envio: conferido (ou da NF) menos o que ja foi gravado. */
  function alvoKg(it: ItemNf, fi: ItemForm): number {
    const conferida = parseNum(fi.quantidadeConferida);
    const kg = conferida !== null && !Number.isNaN(conferida) ? conferida : (it.quantidadeNfKg ?? 0);
    return Math.max(0, kg - it.quantidadeConferidaJaGravadaKg);
  }

  /** Quantidade por linha: uma linha leva tudo; N linhas usam o que o operador distribuiu. */
  function quantidadesDasLinhas(it: ItemNf, fi: ItemForm): Array<number | null> {
    const alvo = alvoKg(it, fi);
    if (fi.linhas.length === 1) return [alvo];
    return fi.linhas.map((l) => parseNum(l.quantidade));
  }

  /** Validacao local — espelha a do servidor para o operador ver antes de enviar. */
  function validar(): string | null {
    if (recebiveis.length === 0) return 'Nenhum item desta nota pode ser recebido por aqui.';
    // feature 017: o botao ja fica desabilitado nestes casos; aqui cobre "Tentar novamente" e nota recarregada
    if (estoqueLancadoPeloOmie) return 'O estoque desta NF já entrou pelo OMIE. Fale com o fiscal.';
    if (copiaPcsDefasada) return 'A lista de pedidos de compra está desatualizada. Tente de novo em alguns minutos.';
    if (aguardandoPcCompras) return 'Esta nota está aguardando pedido de compra e não pode ser recebida agora.';
    if (avisoSemAvaliacao) return `${avisoSemAvaliacao.destaque} ${avisoSemAvaliacao.orientacao}`;
    for (const it of recebiveis) {
      const fi = getForm(it);
      const rot = `"${it.descricaoFornecedor.trim()}"`;
      const conferida = parseNum(fi.quantidadeConferida);
      if (conferida !== null && (Number.isNaN(conferida) || conferida <= 0)) return `Quantidade conferida de ${rot} deve ser positiva.`;
      const nfKg = it.quantidadeNfKg ?? 0;
      const delta = (conferida ?? nfKg) - nfKg;
      if (Math.abs(delta) > TOLERANCIA_KG && !fi.motivoDivergencia.trim()) {
        return `${rot}: a balança marcou ${fmtKg(conferida ?? nfKg)} kg e a nota declara ${fmtKg(nfKg)} kg. Informe o motivo da diferença.`;
      }
      const vistos = new Set<number>();
      const qtds = quantidadesDasLinhas(it, fi);
      for (let i = 0; i < fi.linhas.length; i++) {
        const l = fi.linhas[i]!;
        const n = fi.linhas.length > 1 ? ` (linha ${i + 1})` : '';
        if (!l.produto) return `Escolha o produto para ${rot}${n}.`;
        if (vistos.has(l.produto.codigo)) return `O produto "${l.produto.descricao}" aparece mais de uma vez em ${rot}. Some as quantidades numa linha só.`;
        vistos.add(l.produto.codigo);
        const local = localDaLinha(it, l);
        if (!local.id) return `Escolha o estoque destino para ${rot}${n}.`;
        // Historia 5: produto da ACXE sem correspondente na Q2P nao entra em estoque que tambem e da Q2P (a tela ja desabilita; o servidor recusa antes do fiscal)
        if (ehAcxe && produtoSemCorrelatoNoLocal(l.produto, destinos.find((d) => d.id === local.id))) return msgProdutoSemCorrelatoQ2p(l.produto.descricao);
        const q = qtds[i];
        if (q === null || q === undefined || Number.isNaN(q) || q <= 0) return `Informe a quantidade de "${l.produto.descricao}" em ${rot}.`;
      }
      if (fi.linhas.length > 1) {
        const soma = qtds.reduce<number>((s, q) => s + (q ?? 0), 0);
        const alvo = alvoKg(it, fi);
        if (Math.abs(soma - alvo) > TOLERANCIA_KG) {
          return `${rot}: a soma dos produtos (${fmtKg(soma)} kg) não fecha com o peso conferido (${fmtKg(alvo)} kg).`;
        }
      }
      const pend = pcPendencias.find((x) => x.it === it);
      if (pend) {
        // PC por NF: a pendencia e da nota (escolher o pedido ou a justificativa unica), nao do item
        if (pend.p.tipo === 'escolher' && faltaEscolherNota) return 'Escolha o pedido de compra da nota.';
        if (pend.p.tipo === 'justificar' && itemNaJustNota(it)) return textoJustNota;
        return textoPendenciaPc(pend.p, rot);
      }
    }
    if (faltaJustificativaNota) return textoJustNota;
    return null;
  }

  const enviarMut = useMutation<ResultadoPorNf, Error>({
    mutationFn: async () => {
      const payload = {
        nf_chave_acesso: chave,
        itens: recebiveis.map((it) => {
          const fi = getForm(it);
          const conferida = parseNum(fi.quantidadeConferida);
          const qtds = quantidadesDasLinhas(it, fi);
          // feature 017: so com o fiscal sendo concluido agora; item sem PC possivel vai sem a chave `pc`
          const pcEnvio = pcAtivo && !copiaPcsDefasada && it.pc ? pcParaEnvio(it.pc, escolhaFormDoItem(it, fi), justificativaPcDoItem(it), itemNaJustNota(it)) : null;
          return {
            indice: it.indice,
            descricao_fornecedor: it.descricaoFornecedor,
            ...(conferida !== null ? { quantidade_conferida_kg: conferida } : {}),
            ...(fi.motivoDivergencia.trim() ? { motivo_divergencia: fi.motivoDivergencia.trim() } : {}),
            // o campo de codigo e o da empresa da NF; o estoque, o escolhido ou o do PC (derivado)
            produtos: fi.linhas.map((l, i) => produtoParaEnvio(empresaNf, l.produto!.codigo, qtds[i] ?? 0, localDaLinha(it, l).id)),
            ...(pcEnvio ? { pc: pcEnvio } : {}),
          };
        }),
      };
      const r = await apiFetch('/api/v1/stockbridge/recebimento/nacional/por-nf', { method: 'POST', body: JSON.stringify(payload) });
      return r.data as ResultadoPorNf;
    },
    onSuccess: (r) => {
      setResultado(r);
      setPcResultado(montarResumoPc(r.fiscal, recebiveis));
      setErroEnvio(null);
      // Historia 3/4: o servidor memoriza o que foi GRAVADO; se o operador tirou um
      // produto que vinha sugerido, o conjunto memorizado e corrigido aqui (best-effort).
      for (const it of recebiveis) {
        // a memoria fornecedor x descricao e so da Q2P: a NF da ACXE nao a grava nem a corrige (o PUT /correlacao e Q2P-only)
        if (ehAcxe || it.produtosSugeridos.length === 0) continue;
        const escolhidos = getForm(it).linhas.map((l) => l.produto!.codigo);
        const sugeridos = it.produtosSugeridos.map((s) => s.codigo);
        const mesmoConjunto = escolhidos.length === sugeridos.length && sugeridos.every((c) => escolhidos.includes(c));
        if (mesmoConjunto) continue;
        void apiFetch('/api/v1/stockbridge/recebimento/nacional/correlacao', {
          method: 'PUT',
          body: JSON.stringify({ nf_chave_acesso: chave, descricao_nf: it.descricaoFornecedor, produtos_codigo_q2p: escolhidos }),
        }).catch(() => undefined);
      }
      queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'fila'] });
      queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'detalhe', chave] });
      queryClient.invalidateQueries({ queryKey: ['stockbridge'] });
    },
    onError: (e) => {
      const { code, status, retryAfterSeconds, pc: pcRecusado } = e as Error & { code?: string; status?: number; retryAfterSeconds?: number; pc?: PcRef };
      // VINCULO_OMIE_MUDOU: a nota e recarregada logo abaixo; o operador precisa saber que as escolhas voltaram ao que o OMIE traz
      setErroEnvio(
        code === 'VINCULO_OMIE_MUDOU'
          ? `${e.message.replace(/\s*[.!?]*\s*$/, '.')} A nota foi recarregada. ${pcNfDisponivel ? 'Confira o pedido de compra da nota.' : 'Confira o pedido de cada item.'}`
          // ITEM_IGNORADO_NO_OMIE: a mensagem do servidor nomeia os itens lidos ao vivo (o aviso do espelho sai enquanto ela esta na tela)
          : e.message,
      );
      // feature 017: o servidor recusou com base em dado que mudou no OMIE — a nota e recarregada junto com a mensagem
      if (code && ERROS_QUE_RECARREGAM_NOTA.has(code)) {
        queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'detalhe', chave] });
        queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'fila'] });
      }
      // O vinculo do OMIE mudou: a escolha feita sobre o vinculo antigo nao vale — volta a pre-selecao da nota recarregada
      if (code === 'VINCULO_OMIE_MUDOU') setForm(limparEscolhasPc);
      // O PC recusado deixa de estar escolhido em TODO item que o tenha como escolha efetiva: "escolha outro PC". O servidor manda
      // o item de PC recusado (error.pc, ids so de selecao) — vale tambem para o vinculo do OMIE fora da lista local, sem numero.
      // Sem error.pc (servidor anterior), cai no numero que a mensagem cita ("PC 304"). A escolha e lida do estado mais recente
      // (`prev`): quem trocou de PC enquanto o envio estava em andamento nao perde a escolha nova.
      if (code === 'PC_VINCULO_INVALIDO') {
        const numero = pcRecusado ? undefined : /\bPC\s+(\S+?)[\s.,;:)]/.exec(`${e.message} `)?.[1];
        const foiRecusado = (it: ItemNf, f: ItemForm): boolean => {
          const efetiva = it.pc ? pcEscolhaEfetiva(it.pc, escolhaFormDoItem(it, f)) : null;
          if (!it.pc || !efetiva) return false;
          return pcRecusado ? mesmoPc(efetiva, pcRecusado) : numero != null && pcOpcaoEscolhida(it.pc, efetiva)?.pcNumero === numero;
        };
        setForm((prev) => {
          let prox = prev;
          for (const it of recebiveis) {
            const atual = prev[it.indice] ?? formInicial(it);
            if (!foiRecusado(it, atual)) continue;
            if (prox === prev) prox = { ...prev };
            prox[it.indice] = { ...atual, pcEscolha: null };
          }
          return prox;
        });
      }
      // Proxy/rede sem corpo da API (502/503/504 ou conexao caida): o fiscal pode ter
      // passado — repetir e seguro (o ledger devolve ja_concluido ou 409).
      setErroCodigo(code ?? (status === 0 || status === 502 || status === 503 || status === 504 ? 'FALHA_DE_REDE' : null));
      // O servidor diz quanto esperar: 70 s apos falha com escrita no OMIE (cache), 0 na consulta.
      const seg = Number(retryAfterSeconds ?? 0);
      if (seg > 0) {
        const n = Date.now();
        setAgora(n);
        setRetryLiberaEm(n + seg * 1000);
      } else {
        setRetryLiberaEm(null);
      }
    },
  });

  const dispensarMut = useMutation<{ notaFiscal: string }, Error>({
    mutationFn: async () => {
      const r = await apiFetch('/api/v1/stockbridge/recebimento/nacional/dispensar', {
        method: 'POST',
        body: JSON.stringify({ nf_chave_acesso: chave, motivo: motivoDispensa.trim() }),
      });
      return r.data as { notaFiscal: string };
    },
    onSuccess: () => {
      setDispensando(false);
      setMotivoDispensa('');
      queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'fila'] });
      queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'detalhe', chave] });
      queryClient.invalidateQueries({ queryKey: ['stockbridge'] });
      onVoltar();
    },
  });

  /** feature 017: avisa a equipe de Compras (e-mail) de que a nota aguarda pedido de compra — nao exige produto, estoque nem peso */
  const avisarComprasMut = useMutation<AvisoComprasResposta, Error>({
    mutationFn: async () => {
      const r = await apiFetch('/api/v1/stockbridge/recebimento/nacional/aviso-compras', {
        method: 'POST',
        body: JSON.stringify({ nf_chave_acesso: chave }),
      });
      return r.data as AvisoComprasResposta;
    },
  });

  const baixaMut = useMutation<ResultadoBaixa, Error, PedidoBaixa>({
    mutationFn: async (pedido) => {
      const payload = {
        nf_chave_acesso: chave,
        motivo: motivoBaixa.trim(),
        ...(pedido.modo === 'item' ? { itens: [{ indice: pedido.item.indice, descricao_fornecedor: pedido.item.descricaoFornecedor }] } : {}),
      };
      const r = await apiFetch('/api/v1/stockbridge/recebimento/nacional/recebimento-externo', { method: 'POST', body: JSON.stringify(payload) });
      return r.data as ResultadoBaixa;
    },
    onSuccess: (r) => {
      setPedidoBaixa(null);
      setMotivoBaixa('');
      const n = r.aprovacoesCriadas;
      setAvisoBaixa(
        n > 0
          ? `Baixa solicitada para ${n} ${n === 1 ? 'item' : 'itens'} da NF ${r.notaFiscal} — aguardando aprovação do gestor.`
          : `Os itens desta nota já tinham baixa solicitada — nada foi duplicado.`,
      );
      queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'fila'] });
      queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'detalhe', chave] });
      queryClient.invalidateQueries({ queryKey: ['stockbridge'] });
    },
  });

  function handleEnviar() {
    const msg = validar();
    if (msg) {
      setErroEnvio(msg);
      setErroCodigo(null);
      return;
    }
    setErroEnvio(null);
    setErroCodigo(null);
    setRetryLiberaEm(null);
    enviarMut.mutate();
  }

  return (
    <div>
      <button type="button" onClick={onVoltar} className="mb-3 text-sm text-atlas-muted hover:text-atlas-ink transition-colors">
        ← Voltar à lista de notas
      </button>

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando nota…</div>}

      {!isLoading && error != null && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          {error.message}
          {!['NF_DISPENSADA', 'NF_CANCELADA'].includes((error as Error & { code?: string }).code ?? '') && (
            <>
              {' '}
              <button type="button" onClick={onAbrirManual} className="underline">
                Registrar manualmente
              </button>
            </>
          )}
        </div>
      )}

      {nf && (
        <>
          <div className="bg-atlas-card border border-atlas-border rounded-lg p-4 mb-4 flex flex-wrap gap-x-8 gap-y-2 items-baseline">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-atlas-muted">Nota fiscal</div>
              <div className="font-mono text-lg text-atlas-ink">NF {nf.notaFiscal}</div>
            </div>
            {mostrarEmpresa && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-atlas-muted">Empresa</div>
                <div className="mt-0.5">
                  <SeloEmpresa empresa={empresaNf} />
                </div>
              </div>
            )}
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-atlas-muted">Fornecedor</div>
              <div className="text-sm text-atlas-ink truncate" title={nf.fornecedorNome}>
                {nf.fornecedorCnpj ? nf.fornecedorNome : <span className="text-atlas-muted">Não identificado no OMIE</span>}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-atlas-muted">Emissão</div>
              <div className="text-sm text-atlas-ink">{fmtData(nf.dtEmissao)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-atlas-muted">CFOP</div>
              <div className="text-sm font-mono text-atlas-ink">{nf.cfop}</div>
            </div>
            {nf.recebimentoFiscalHabilitado && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-atlas-muted">Recebimento fiscal</div>
                <div className={`text-sm ${nf.fiscal === 'pendente' ? 'text-amber-700 dark:text-amber-400' : 'text-atlas-muted'}`}>
                  {nf.fiscal === 'pendente' ? `Pendente no ${omieDaNf}` : `Concluído no ${omieDaNf}`}
                </div>
              </div>
            )}
            <div className="ml-auto text-right">
              <div className="text-[11px] uppercase tracking-wide text-atlas-muted">Valor da nota</div>
              <div className="font-serif text-lg text-atlas-ink">{fmtBrl(nf.valorTotalBrl)}</div>
            </div>
          </div>

          {ehAcxe && !resultado && (destinosErro != null || (destinosCarregados && destinosAcxe.length === 0)) && (
            <div className="mb-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-sm text-amber-900 dark:text-amber-200 flex items-start gap-3 flex-wrap">
              <p role="alert" className="flex-1 min-w-[16rem]">
                {destinosErro != null
                  ? `Não foi possível carregar os estoques de destino da ACXE. ${destinosErro.message}`
                  : 'Nenhum estoque de destino está cadastrado para a entrada da ACXE. Avise o suporte.'}
              </p>
              <button
                type="button"
                onClick={() => void recarregarDestinos()}
                disabled={destinosBuscando}
                className="px-3 py-1 border border-amber-700 dark:border-amber-500 rounded text-xs font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40 whitespace-nowrap disabled:opacity-50"
              >
                {destinosBuscando ? 'Carregando…' : 'Tentar de novo'}
              </button>
            </div>
          )}

          {estoqueLancadoPeloOmie && !resultado && (
            <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
              <strong className="font-semibold">O estoque desta NF já entrou pelo OMIE. Fale com o fiscal.</strong> Para não lançar o estoque em dobro, o recebimento por aqui está bloqueado.
            </div>
          )}

          {copiaPcsDefasada && !resultado && (
            <div className="mb-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-sm text-amber-900 dark:text-amber-200 flex items-start gap-3 flex-wrap">
              <p className="flex-1 min-w-[16rem]">
                <strong className="font-semibold">A lista de pedidos de compra está desatualizada.</strong> Sem ela não há como sugerir nem vincular o PC, então o recebimento desta nota
                fica bloqueado por enquanto. Tente de novo em alguns minutos; se persistir, avise o suporte.
              </p>
              <button
                type="button"
                onClick={() => queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'detalhe', chave] })}
                disabled={isFetching}
                className="px-3 py-1 border border-amber-700 dark:border-amber-500 rounded text-xs font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40 whitespace-nowrap disabled:opacity-50"
              >
                {isFetching ? 'Recarregando…' : 'Recarregar nota'}
              </button>
            </div>
          )}

          {aguardandoPcCompras && !resultado && (
            <div className="mb-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-sm text-amber-900 dark:text-amber-200">
              <div className="flex items-start gap-3 flex-wrap">
                <p className="flex-1 min-w-[16rem]">
                  <strong className="font-semibold">Aguardando pedido de compra.</strong> Esta nota tem {itensSemPc} {itensSemPc === 1 ? 'item' : 'itens'} sem pedido de compra (PC) que{' '}
                  {itensSemPc === 1 ? 'possa ser vinculado' : 'possam ser vinculados'} no OMIE e não pode ser recebida agora. Avise a equipe de Compras para lançar ou aprovar o PC; a nota
                  continua na fila.
                </p>
                {avisarComprasMut.data == null && (
                  <button
                    type="button"
                    onClick={() => avisarComprasMut.mutate()}
                    disabled={avisarComprasMut.isPending}
                    className="px-3 py-1 border border-amber-700 dark:border-amber-500 rounded text-xs font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40 whitespace-nowrap disabled:opacity-50"
                  >
                    {avisarComprasMut.isPending ? 'Enviando…' : 'Avisar a equipe de Compras'}
                  </button>
                )}
              </div>
              <div aria-live="polite">
                {avisarComprasMut.data && (
                  <p
                    className={`mt-2 p-2 rounded text-xs border ${
                      avisarComprasMut.data.status === 'enviado'
                        ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                        : 'bg-atlas-card border-atlas-border text-atlas-ink'
                    }`}
                  >
                    {avisarComprasMut.data.mensagem}
                  </p>
                )}
                {avisarComprasMut.isError && (
                  <p role="alert" className="mt-2 p-2 rounded text-xs border bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300">
                    {avisarComprasMut.error.message}
                    {['AVISO_COMPRAS_NAO_APLICAVEL', 'COPIA_PCS_DEFASADA'].includes((avisarComprasMut.error as Error & { code?: string }).code ?? '') && (
                      <>
                        {' '}
                        <button
                          type="button"
                          onClick={() => queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'detalhe', chave] })}
                          disabled={isFetching}
                          className="underline disabled:opacity-50"
                        >
                          Recarregar nota
                        </button>
                      </>
                    )}
                  </p>
                )}
              </div>
            </div>
          )}

          {avisoSemAvaliacao && !resultado && (
            <div className="mb-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-sm text-amber-900 dark:text-amber-200">
              <p>
                <strong className="font-semibold">{avisoSemAvaliacao.destaque}</strong> {avisoSemAvaliacao.orientacao}
              </p>
            </div>
          )}

          {/* D21: fora da guarda do aviso abaixo, para a historia aparecer tambem com o recebimento barrado por outro aviso */}
          {fiscalRevertido && !resultado && (
            <div className={`mb-3 ${AVISO_AMBAR}`}>
              <p>
                <strong className="font-semibold">O recebimento fiscal desta nota foi desfeito no {omieDaNf}{emDataHoraBr(nf.fiscalRevertidoEm)} depois de concluído.</strong>
                {/* com o recebimento barrado por outro aviso (PC, lista de PCs, unidade) ou item em "Ignorar", nao prometer "ao dar entrada" */}
                {fiscalNoClique && !recebimentoBarrado && !haIgnoradoNoOmie && (
                  <>
                    {' '}
                    Ao dar entrada, o Atlas conclui o fiscal de novo{haPcSelecionavel ? ', com o pedido de compra confirmado abaixo' : ''}.
                  </>
                )}{' '}
                Se a reversão foi feita para corrigir a nota no {omieDaNf}, fale com o fiscal antes de dar entrada.
              </p>
            </div>
          )}

          {/* NF 19252: so avisa — o espelho pode estar atrasado, e o clique le o OMIE ao vivo */}
          {avisoIgnoradoNoOmie && !resultado && (
            <div id="rec-nacional-ignorado-omie" className={`mb-3 ${AVISO_AMBAR}`}>
              <p>
                <strong className="font-semibold">{avisoIgnoradoNoOmie.destaque}</strong> {avisoIgnoradoNoOmie.orientacao}
              </p>
            </div>
          )}

          {/* item em "Ignorar": a promessa de concluir o fiscal com o PC some; sem fornecedor e "nada a receber" continuam */}
          {fiscalPendente && !resultado && (fiscalSemFornecedor || recebiveis.length === 0 || (!recebimentoBarrado && !haIgnoradoNoOmie)) && (
            <div className="mb-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-sm text-amber-900 dark:text-amber-200">
              {fiscalSemFornecedor
                ? `Esta nota está sem fornecedor cadastrado no ${omieDaNf}, então o recebimento fiscal não pode ser concluído. Peça ao fiscal para cadastrar o fornecedor; a nota pode ser recebida depois da próxima atualização do espelho do ${omieDaNf}.`
                : recebiveis.length === 0
                  ? `Nenhum item desta nota pode ser recebido por aqui agora (veja o motivo em cada item), e o recebimento fiscal continua pendente no ${omieDaNf}. Se a nota não for recebida, peça ao gestor para dispensá-la.`
                  : (
                    <>
                      <p>
                        O recebimento fiscal desta nota será concluído no {omieDaNf} ao confirmar — a conta a pagar é gerada e nenhum estoque é movimentado por ele. O estoque continua entrando pela aprovação do gestor.
                      </p>
                      {haPcParaConfirmar && <p className="mt-1">Cada item fica vinculado ao pedido de compra escolhido abaixo.</p>}
                      {semAvaliacaoInforma && <p className="mt-1">{textoSemAvaliacaoInforma(nomesSemAvaliacao)}</p>}
                    </>
                  )}
            </div>
          )}

          {nf.linhasForaDoRecorte > 0 && (
            <div className="mb-3 text-xs text-atlas-muted">
              {nf.linhasForaDoRecorte} {nf.linhasForaDoRecorte === 1 ? 'linha desta nota não é' : 'linhas desta nota não são'} de compra de mercadoria e {nf.linhasForaDoRecorte === 1 ? 'fica' : 'ficam'} fora deste recebimento.
            </div>
          )}

          {avisoBaixa && (
            <div className="mb-3 p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded text-sm text-emerald-900 dark:text-emerald-200 flex items-start gap-2">
              <span className="flex-1">{avisoBaixa}</span>
              <button type="button" onClick={() => setAvisoBaixa(null)} className="opacity-60 hover:opacity-100" aria-label="Fechar">×</button>
            </div>
          )}

          {pcNfDisponivel && (
            <PedidoCompraNfBloco
              pcs={pcsDaNf}
              escolhido={pcEscolhidoNf}
              totalItens={recebiveis.length}
              descricaoDoItem={(indice) => nf.itens.find((x) => x.indice === indice)?.descricaoFornecedor.trim() || 'Item da nota'}
              onEscolher={escolherPcDaNf}
              justificativaInfo={justNotaInfo}
              justificativa={justificativaNota}
              onJustificar={justificarNota}
            />
          )}

          <div className="flex flex-col gap-3">
            {nf.itens.map((it) => (
              <ItemCard
                key={it.indice}
                item={it}
                form={getForm(it)}
                empresa={empresaNf}
                destinos={destinos}
                resolverLocal={(l) => localDaLinha(it, l)}
                alvoKg={alvoKg(it, getForm(it))}
                onChange={(patch) => setItem(it, patch)}
                onSolicitarBaixa={baixaPermitida && itemBaixavel(it) && !resultado ? () => setPedidoBaixa({ modo: 'item', item: it }) : undefined}
                fiscalPendente={fiscalPendente}
                pcAtivo={pcAtivo}
                exigePc={exigePc}
                copiaPcsDefasada={copiaPcsDefasada}
                escolhaPcForm={escolhaFormDoItem(it)}
                justificativaPc={justificativaPcDoItem(it)}
                pcCompactoNota={compactoNotaDoItem(it)}
                justificativaNaNota={itemNaJustNota(it)}
                pcSemTrocaNoItem={recebiveis.length === 1 && pcsDaNf.length === 1}
              />
            ))}
          </div>

          {resultado && (
            <div className="mt-4 p-4 bg-atlas-card border border-atlas-border rounded-lg">
              <div className="text-sm text-atlas-ink mb-2">
                NF {resultado.notaFiscal}: {resultado.resumo.enviadosParaAprovacao} {resultado.resumo.enviadosParaAprovacao === 1 ? 'item enviado' : 'itens enviados'} para aprovação do gestor
                {resultado.resumo.jaRecebidos > 0 && ` · ${resultado.resumo.jaRecebidos} já ${resultado.resumo.jaRecebidos === 1 ? 'recebido' : 'recebidos'}`}
                {resultado.resumo.bloqueados > 0 && ` · ${resultado.resumo.bloqueados} ${resultado.resumo.bloqueados === 1 ? 'bloqueado' : 'bloqueados'}`}
                {resultado.resumo.falhas > 0 && ` · ${resultado.resumo.falhas} ${resultado.resumo.falhas === 1 ? 'falha' : 'falhas'}`}
              </div>
              {resultado.fiscal && resultado.fiscal.status !== 'desligado' && (
                <div className={`text-xs mb-2 ${resultado.fiscal.status === 'concluido' ? 'text-green-700 dark:text-green-400' : 'text-atlas-muted'}`}>
                  {resultado.fiscal.mensagem}
                </div>
              )}
              {pcResultado && (pcResultado.linhas.length > 0 || pcResultado.soltos.length > 0) && (
                <ul className="text-xs space-y-1 mb-2" aria-label="Pedido de compra de cada item">
                  {pcResultado.linhas.map((l) => (
                    <li key={l.indice} className="flex flex-wrap gap-x-2">
                      <span className="text-atlas-ink">{l.descricao}</span>{' '}
                      {l.pcs.length > 0 ? (
                        <span className="text-green-700 dark:text-green-400">
                          vinculado {textoPcsVinculados(l.pcs)} <span className="text-atlas-muted">· {origensPc(l.pcs)}</span>
                        </span>
                      ) : (
                        <span className="text-amber-700 dark:text-amber-400">recebido sem vínculo com pedido de compra</span>
                      )}
                    </li>
                  ))}
                  {pcResultado.soltos.map((p) => (
                    <li key={p.pcNumero} className="text-green-700 dark:text-green-400">
                      Vinculado {textoPcsVinculados([p])} <span className="text-atlas-muted">· {origensPc([p])}</span>
                    </li>
                  ))}
                </ul>
              )}
              {resultado.fiscal?.avisoCompras === true && (
                <div className="mb-2 p-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-900 dark:text-amber-200">
                  {(resultado.fiscal.semVinculo?.length ?? 0) > 1
                    ? 'A equipe de Compras foi avisada sobre os itens recebidos sem pedido de compra.'
                    : (resultado.fiscal.semVinculo?.length ?? 0) === 1
                      ? 'A equipe de Compras foi avisada sobre o item recebido sem pedido de compra.'
                      : 'A equipe de Compras foi avisada sobre esta nota.'}
                </div>
              )}
              {(resultado.fiscal?.status === 'concluido' || resultado.fiscal?.status === 'ja_concluido') && resultado.resumo.falhas > 0 && (
                <div className="mb-2 p-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-900 dark:text-amber-200">
                  O recebimento fiscal foi concluído no OMIE, mas {resultado.resumo.falhas === 1 ? 'um item não foi registrado' : `${resultado.resumo.falhas} itens não foram registrados`} no estoque —
                  a nota continua na fila como fiscal já feito. Volte à lista e refaça a entrada dos itens com falha.
                </div>
              )}
              <ul className="text-xs space-y-1">
                {resultado.produtos.map((p, i) => (
                  <li key={i} className="flex gap-2">
                    <span className={STATUS_LABEL[p.status].cls}>{STATUS_LABEL[p.status].label}</span>
                    <span className="text-atlas-ink">{p.produto || p.descricaoFornecedor.trim()}</span>
                    <span className="text-atlas-muted">{fmtKg(p.quantidadeKg)} kg</span>
                    {p.status === 'aguardando_aprovacao' && textoEntradaEm(p.entradaEm) && <span className="text-atlas-muted">· {textoEntradaEm(p.entradaEm)} na aprovação</span>}
                    {p.mensagemErro && <span className="text-atlas-muted">— {p.mensagemErro}</span>}
                  </li>
                ))}
              </ul>
              <button type="button" onClick={onVoltar} className="mt-3 px-4 py-2 bg-atlas-btn-bg text-atlas-btn-text rounded text-sm font-medium hover:opacity-90">
                Voltar à lista
              </button>
            </div>
          )}

          {erroEnvio && (
            <div
              className={`mt-4 p-3 border rounded text-sm flex items-start gap-3 flex-wrap ${
                erroCodigo != null && ERROS_DE_ORIENTACAO.has(erroCodigo)
                  ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200'
                  : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300'
              }`}
            >
              <span role="alert" className="flex-1">{erroEnvio}</span>
              {erroCodigo === 'RECEBIMENTO_FISCAL_EM_ANDAMENTO' && (
                <button
                  type="button"
                  onClick={() => {
                    setErroEnvio(null);
                    setErroCodigo(null);
                    queryClient.invalidateQueries({ queryKey: ['sb', 'rec-nacional', 'detalhe', chave] });
                  }}
                  className="px-3 py-1 border border-red-300 dark:border-red-700 rounded text-xs font-medium hover:bg-red-100 dark:hover:bg-red-900/40 whitespace-nowrap"
                >
                  Recarregar nota
                </button>
              )}
              {(erroCodigo === 'RECEBIMENTO_FISCAL_FAIL' || erroCodigo === 'RECEBIMENTO_FISCAL_AGUARDE' || erroCodigo === 'PC_RECEM_USADO_AGUARDE' || erroCodigo === 'FALHA_DE_REDE') && (
                <button
                  type="button"
                  onClick={handleEnviar}
                  disabled={enviarMut.isPending || retryRestanteSeg > 0}
                  className="px-3 py-1 border border-red-300 dark:border-red-700 rounded text-xs font-medium hover:bg-red-100 dark:hover:bg-red-900/40 whitespace-nowrap disabled:opacity-50"
                >
                  {retryRestanteSeg > 0 ? `Tentar novamente em ${retryRestanteSeg} s` : 'Tentar novamente'}
                </button>
              )}
            </div>
          )}

          {!resultado && (
            <div className="mt-4 flex items-center justify-between gap-4 flex-wrap">
              <div className="text-xs text-atlas-muted">
                {ehAcxe
                  ? 'Cada item vira uma aprovação do gestor. O ajuste de estoque no OMIE acontece na aprovação: na ACXE e, nos estoques que também são da Q2P, na Q2P.'
                  : 'Cada item vira uma aprovação do gestor. O ajuste no OMIE acontece na aprovação.'}
                {fiscalNoClique && !recebimentoBarrado && !haIgnoradoNoOmie && ` O recebimento fiscal é concluído no ${omieDaNf} agora, ao confirmar${haPcParaConfirmar ? ', com cada item vinculado ao pedido de compra escolhido' : ''}.`}
                {baixaPermitida && baixaveis.length > 0 && (
                  <>
                    {' '}
                    <button type="button" onClick={() => setPedidoBaixa({ modo: 'todos' })} className="underline hover:text-atlas-ink">
                      {baixaveis.length === 1 ? 'O item já foi recebido fora do Atlas?' : 'Todos os itens já foram recebidos fora do Atlas?'}
                    </button>
                  </>
                )}
                {podeDispensar && (
                  <>
                    {' '}
                    <button type="button" onClick={() => { dispensarMut.reset(); setDispensando(true); }} className="underline hover:text-atlas-ink">
                      Esta nota não será recebida? Dispensar da fila
                    </button>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={handleEnviar}
                disabled={enviarMut.isPending || recebiveis.length === 0 || fiscalSemFornecedor || retryRestanteSeg > 0 || bloqueadoPorPc}
                aria-describedby={[dicaPc ? 'rec-nacional-pc-dica' : null, avisoIgnoradoNoOmie ? 'rec-nacional-ignorado-omie' : null].filter(Boolean).join(' ') || undefined}
                className="px-5 py-2 bg-atlas-btn-bg text-atlas-btn-text rounded text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {enviarMut.isPending
                  ? 'Enviando…'
                  : `${fiscalNoClique ? 'Concluir fiscal e dar entrada' : 'Dar entrada'} em ${recebiveis.length} ${recebiveis.length === 1 ? 'item' : 'itens'} →`}
              </button>
            </div>
          )}

          {!resultado && dicaPc && (
            <p id="rec-nacional-pc-dica" className="mt-2 text-right text-xs text-amber-800 dark:text-amber-300">
              {dicaPc}
            </p>
          )}

          {dispensando && (
            <Modal open title="Dispensar NF da fila" onClose={() => { setDispensando(false); setMotivoDispensa(''); dispensarMut.reset(); }}>
              <div className="space-y-3">
                <p className="text-sm text-atlas-muted">
                  A NF <strong className="text-atlas-ink">{nf.notaFiscal}</strong> ({nf.fornecedorNome}) sai da fila de recebimento para todos os operadores e não será
                  recebida no estoque pelo Atlas. Isso <strong className="text-atlas-ink">não altera nada no OMIE</strong> — cancelar, recusar ou devolver a NF continua com o
                  fiscal, que será avisado por e-mail. A dispensa pode ser desfeita em Aprovações.
                </p>
                {nf.fiscal === 'concluido' && (
                  <p className="text-sm text-amber-800 dark:text-amber-300">
                    O recebimento fiscal desta nota já foi concluído no OMIE: há conta a pagar a estornar ou manter — o aviso ao fiscal diz isso.
                  </p>
                )}
                <div>
                  <label htmlFor="motivo-dispensa-nf" className="block text-xs font-semibold text-atlas-muted mb-1">Por que esta nota não será recebida? *</label>
                  <textarea
                    id="motivo-dispensa-nf"
                    value={motivoDispensa}
                    onChange={(e) => setMotivoDispensa(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    autoFocus
                    placeholder="Ex.: carga nunca chegou; fornecedor vai cancelar a nota"
                    className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg text-atlas-ink placeholder:text-atlas-muted rounded text-sm"
                  />
                </div>
                {dispensarMut.isError && (
                  <div role="alert" className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-800 dark:text-red-300">
                    {dispensarMut.error.message}
                  </div>
                )}
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => { setDispensando(false); setMotivoDispensa(''); dispensarMut.reset(); }}
                    className="px-4 py-2 border border-atlas-border bg-atlas-card text-atlas-ink hover:bg-atlas-bg/60 rounded text-sm"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => dispensarMut.mutate()}
                    disabled={!motivoDispensa.trim() || dispensarMut.isPending}
                    className={`px-5 py-2 rounded text-sm font-medium ${motivoDispensa.trim() ? 'bg-atlas-btn-bg text-atlas-btn-text hover:opacity-90' : 'bg-atlas-muted/20 text-atlas-muted cursor-not-allowed'}`}
                  >
                    {dispensarMut.isPending ? 'Enviando…' : 'Dispensar da fila'}
                  </button>
                </div>
              </div>
            </Modal>
          )}

          {pedidoBaixa && (
            <Modal open title="Baixa por recebimento fora do Atlas" onClose={() => { setPedidoBaixa(null); setMotivoBaixa(''); }}>
              <div className="space-y-3">
                <p className="text-sm text-atlas-muted">
                  {pedidoBaixa.modo === 'item'
                    ? <>O item <strong className="text-atlas-ink">{pedidoBaixa.item.descricaoFornecedor.trim()}</strong> da NF {nf.notaFiscal} será marcado como já recebido por outro caminho.</>
                    : <>{baixaveis.length === 1 ? 'O item pendente' : `Os ${baixaveis.length} itens pendentes`} da NF {nf.notaFiscal} {baixaveis.length === 1 ? 'será marcado' : 'serão marcados'} como já recebidos por outro caminho.</>}
                  {' '}Isso <strong className="text-atlas-ink">não</strong> movimenta estoque nem altera o OMIE — só tira a nota da fila, depois que o gestor aprovar.
                </p>
                <div>
                  <label className="block text-xs font-semibold text-atlas-muted mb-1">Onde e como foi recebido *</label>
                  <textarea
                    value={motivoBaixa}
                    onChange={(e) => setMotivoBaixa(e.target.value)}
                    rows={3}
                    autoFocus
                    placeholder="Ex.: lançado direto no OMIE em 12/09 por indisponibilidade do Atlas"
                    className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg text-atlas-ink placeholder:text-atlas-muted rounded text-sm"
                  />
                </div>
                {baixaMut.isError && (
                  <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-800 dark:text-red-300">
                    {baixaMut.error.message}
                  </div>
                )}
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => { setPedidoBaixa(null); setMotivoBaixa(''); }}
                    className="px-4 py-2 border border-atlas-border bg-atlas-card text-atlas-ink hover:bg-atlas-bg/60 rounded text-sm"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => baixaMut.mutate(pedidoBaixa)}
                    disabled={!motivoBaixa.trim() || baixaMut.isPending}
                    className={`px-5 py-2 rounded text-sm font-medium ${motivoBaixa.trim() ? 'bg-atlas-btn-bg text-atlas-btn-text hover:opacity-90' : 'bg-atlas-muted/20 text-atlas-muted cursor-not-allowed'}`}
                  >
                    {baixaMut.isPending ? 'Enviando…' : 'Solicitar baixa ao gestor'}
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </>
      )}
    </div>
  );
}

// ── Item ────────────────────────────────────────────────────────────────────

function ItemCard({
  item,
  form,
  empresa,
  destinos,
  resolverLocal,
  alvoKg,
  onChange,
  onSolicitarBaixa,
  fiscalPendente = false,
  pcAtivo = false,
  exigePc = true,
  copiaPcsDefasada = false,
  escolhaPcForm,
  justificativaPc,
  pcCompactoNota = null,
  justificativaNaNota = false,
  pcSemTrocaNoItem = false,
}: {
  item: ItemNf;
  form: ItemForm;
  /** empresa da NF: define o catalogo de produtos, o campo do POST e se o destino vem em grupos (ACXE) ou em lista plana (Q2P) */
  empresa: Empresa;
  /** estoques oferecidos como destino (ACXE: com `entradaEm`; Q2P: a lista plana de sempre) */
  destinos: DestinoEntrada[];
  /** estoque que vale para a linha: o escolhido ou, na NF da ACXE, o do PC (`doPedido`) — o mesmo da validacao e do POST */
  resolverLocal: (l: LinhaProduto) => { id: string; doPedido: boolean };
  /** peso que este envio vai distribuir entre as linhas */
  alvoKg: number;
  onChange: (p: Partial<ItemForm>) => void;
  /** ausente = acao indisponivel (flag desligada, item ja recebido/baixado, envio concluido) */
  onSolicitarBaixa?: () => void;
  /** feature 016: a NF esta com o fiscal pendente — o formulario manual nao o conclui */
  fiscalPendente?: boolean;
  /** feature 017: o Atlas conclui o fiscal agora, entao o item pede o PC (bloco "Pedido de compra") */
  pcAtivo?: boolean;
  /** feature 017: true = item sem PC possivel bloqueia a NF; false = e recebido sem vinculo */
  exigePc?: boolean;
  /** feature 017: lista local de PCs desatualizada — sem sugestao */
  copiaPcsDefasada?: boolean;
  /** feature 017: escolha do formulario ja com a pre-selecao da nota (`undefined` = ninguem escolheu: vale a pre-selecao do item) */
  escolhaPcForm: PcRef | null | undefined;
  /** feature 017: texto de justificativa que vale para o item (o da nota, quando ele segue o pedido escolhido na nota) */
  justificativaPc: string;
  /** PC por NF: o item segue o pedido escolhido na nota, ou espera a escolha dela (so o link "Usar outro pedido de compra neste item") */
  pcCompactoNota?: PcCompactoNota | null;
  /** PC por NF: a justificativa deste item e a unica da nota (o campo por item nao aparece) */
  justificativaNaNota?: boolean;
  /** nota de um item e um PC: o item que segue o pedido da nota nao mostra nada de PC (nao ha o que trocar) */
  pcSemTrocaNoItem?: boolean;
}) {
  const idBase = useId();
  const ehAcxe = empresa === 'acxe';
  const bloqueadoUnidade = item.bloqueio === 'unidade_nao_conversivel' || item.bloqueio === 'unidade_incoerente';
  const recebidoIntegral = item.jaRecebido && (item.quantidadeRestanteKg ?? 0) <= TOLERANCIA_KG;
  const parcial = item.quantidadeNfJaAtribuidaKg > 0 && !recebidoIntegral;
  const editavel = itemRecebivel(item);
  const pcDoItem = item.pc ?? null;
  /** feature 017: item a receber sem PC que possa ser vinculado — "Aguardando pedido de compra" */
  const aguardandoPc = editavel && pcAtivo && !copiaPcsDefasada && pcDoItem != null && pcBloqueiaRecebimento(pcDoItem, exigePc);
  const nfKg = item.quantidadeNfKg ?? 0;
  const conferida = parseNum(form.quantidadeConferida);
  const conferidaEfetiva = conferida !== null && !Number.isNaN(conferida) ? conferida : nfKg;
  const delta = conferidaEfetiva - nfKg;
  const temDivergencia = Math.abs(delta) > TOLERANCIA_KG;
  const sugeridos = new Set(item.produtosSugeridos.map((s) => s.codigo));

  const multi = form.linhas.length > 1;
  const somaLinhas = multi ? form.linhas.reduce((s, l) => s + (parseNum(l.quantidade) ?? 0), 0) : alvoKg;
  const falta = alvoKg - somaLinhas;

  const setLinha = (i: number, patch: Partial<LinhaProduto>) =>
    onChange({ linhas: form.linhas.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const addLinha = () => onChange({ linhas: [...form.linhas, { produto: null, localidadeId: form.linhas[0]?.localidadeId ?? '', quantidade: '' }] });
  const removeLinha = (i: number) => onChange({ linhas: form.linhas.filter((_, j) => j !== i) });

  return (
    <div className={`bg-atlas-card border rounded-lg p-4 ${bloqueadoUnidade || aguardandoPc ? 'border-amber-300 dark:border-amber-800' : 'border-atlas-border'}`}>
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-[16rem]">
          <div className="text-[11px] uppercase tracking-wide text-atlas-muted">Item da nota</div>
          <div className="font-serif text-base text-atlas-ink" title={item.descricaoFornecedor}>{item.descricaoFornecedor.trim()}</div>
          <div className="text-xs text-atlas-muted mt-0.5">
            {fmtKg(item.quantidadeNf)} {item.unidadeOriginal}
            {item.quantidadeNfKg != null && item.unidadeOriginal !== 'KG' && ` = ${fmtKg(item.quantidadeNfKg)} kg`}
            {' · '}
            {fmtBrl(item.valorTotalItemBrl)}
            {item.rsPorKg != null && ` (${fmtBrlKg(item.rsPorKg)}/kg)`}
            {item.linhasAgregadas > 1 && ` · ${item.linhasAgregadas} linhas da nota somadas`}
          </div>
        </div>

        {recebidoIntegral && (
          <div className="text-xs font-medium px-2 py-1 rounded bg-atlas-muted/20 text-atlas-muted self-center">
            {item.baixadoComoExterno ? 'Baixado como recebido fora do Atlas' : 'Já recebido'}
          </div>
        )}
        {!recebidoIntegral && item.baixaSolicitada && (
          <div className="text-xs font-medium px-2 py-1 rounded bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300 self-center">
            Baixa solicitada — aguardando o gestor
          </div>
        )}
        {parcial && (
          <div className="text-xs font-medium px-2 py-1 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 self-center">
            {fmtKg(item.quantidadeNfJaAtribuidaKg)} kg já recebidos · faltam {fmtKg(item.quantidadeRestanteKg ?? 0)} kg
          </div>
        )}
        {!pcAtivo && pcDoItem?.vinculadoNoOmie && (
          <div
            className="text-xs px-2 py-1 rounded border border-atlas-border text-atlas-muted self-center"
            title="Pedido de compra ao qual este item foi vinculado no recebimento fiscal do OMIE."
          >
            {pcDoItem.vinculadoNoOmie.pcNumero?.trim() ? `PC ${pcDoItem.vinculadoNoOmie.pcNumero.trim()} vinculado no OMIE` : 'PC vinculado no OMIE'}
          </div>
        )}
        {onSolicitarBaixa && (
          <button
            type="button"
            onClick={onSolicitarBaixa}
            className="text-xs text-atlas-muted underline hover:text-atlas-ink self-center whitespace-nowrap"
          >
            Recebido fora do Atlas?
          </button>
        )}
      </div>

      {bloqueadoUnidade && (
        <div className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-sm text-amber-900 dark:text-amber-200">
          {item.bloqueioMensagem}
          {fiscalPendente && (
            <div className="mt-1 text-xs">
              Atenção: esta nota está com o recebimento fiscal pendente, e o formulário manual não o conclui no OMIE. Se receber por lá, avise o fiscal.
            </div>
          )}
        </div>
      )}

      {/* Item coberto pelo pedido da nota (escolhido ou ainda por escolher): o bloco "Pedido de compra da nota" ja mostra o PC e a
          ligacao item -> item do PC; no item fica so o link "Usar outro pedido de compra neste item", e nem ele na nota de um item
          e um PC (usuario, 22/10/2026). */}
      {editavel && pcAtivo && pcDoItem && !(pcCompactoNota && pcSemTrocaNoItem) && (
        <PedidoCompraBloco
          pc={pcDoItem}
          descricaoItem={item.descricaoFornecedor.trim()}
          escolha={pcEscolhaEfetiva(pcDoItem, escolhaPcForm)}
          onEscolher={(ref) => onChange({ pcEscolha: ref })}
          justificativa={justificativaPc}
          onJustificar={(texto) => onChange({ pcJustificativa: texto })}
          exigePc={exigePc}
          copiaDefasada={copiaPcsDefasada}
          compactoNota={pcCompactoNota}
          justificativaNaNota={justificativaNaNota}
        />
      )}

      {editavel && (
        <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-8 flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <label className="block text-xs font-medium text-atlas-muted">
                {multi ? 'Produtos no estoque' : 'Produto no estoque'}
                {ehAcxe && ' da ACXE'}
              </label>
              {item.produtosSugeridos.length > 0 && (
                <span className="text-[11px] text-atlas-muted">
                  {ehAcxe
                    ? 'sugestão pela nota ou pelo pedido de compra'
                    : item.produtosSugeridos.length === 1
                      ? 'sugestão pelo histórico deste fornecedor'
                      : `${item.produtosSugeridos.length} produtos pelo histórico deste fornecedor`}
                </span>
              )}
            </div>
            {form.linhas.map((l, i) => {
              const local = resolverLocal(l);
              const destino = destinos.find((d) => d.id === local.id) ?? null;
              /** NF da ACXE: produto sem correspondente na Q2P no estoque que tambem e da Q2P — a entrada nao tem como ser lancada */
              const semCorrelatoNoLocal = ehAcxe && produtoSemCorrelatoNoLocal(l.produto, destino);
              const idLegenda = `${idBase}-destino-${i}`;
              return (
                <div key={i} className="grid grid-cols-12 gap-2 items-start">
                  <div className={multi ? 'col-span-6' : 'col-span-7'}>
                    <ProdutoCombobox
                      empresa={empresa}
                      valor={l.produto}
                      onChange={(p) => setLinha(i, { produto: p })}
                      correlatoQ2p={ehAcxe ? (entraNasDuas(destino) ? 'exigir' : 'sinalizar') : undefined}
                    />
                    {l.produto && sugeridos.has(l.produto.codigo) && (
                      <div className="text-[11px] text-atlas-muted mt-0.5">
                        {ehAcxe ? 'sugerido pela nota ou pelo pedido de compra — pode trocar' : 'sugerido pelo histórico — pode trocar'}
                      </div>
                    )}
                    {ehAcxe && l.produto?.semCorrelatoQ2p === true && (
                      <div className="text-[11px] text-atlas-muted mt-0.5">{ROTULO_SEM_CORRELATO_Q2P}: não entra em estoque que também é da Q2P.</div>
                    )}
                  </div>
                  <div className={multi ? 'col-span-3' : 'col-span-5'}>
                    <select
                      value={local.id}
                      onChange={(e) => setLinha(i, { localidadeId: e.target.value })}
                      aria-label="Estoque destino"
                      aria-describedby={ehAcxe && destino ? idLegenda : undefined}
                      className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm"
                    >
                      <option value="">Estoque destino…</option>
                      {ehAcxe
                        ? agruparDestinos(destinos).map((g) => (
                            <optgroup key={g.chave} label={g.rotulo}>
                              {g.locais.map((d) => {
                                const bloqueado = produtoSemCorrelatoNoLocal(l.produto, d);
                                return (
                                  <option key={d.id} value={d.id} disabled={bloqueado}>
                                    {d.codigo} — {d.nome}
                                    {bloqueado ? ' (produto sem correspondente na Q2P)' : ''}
                                  </option>
                                );
                              })}
                            </optgroup>
                          ))
                        : destinos.map((loc) => (
                            <option key={loc.id} value={loc.id}>{loc.codigo} — {loc.nome}</option>
                          ))}
                    </select>
                    {ehAcxe && destino && (
                      <div id={idLegenda} className="mt-0.5 text-[11px]">
                        {semCorrelatoNoLocal ? (
                          <span className="text-amber-800 dark:text-amber-300">
                            Este produto não tem correspondente na Q2P e não pode entrar neste estoque, que também é da Q2P. Escolha um estoque só da ACXE ou peça o cadastro do produto na Q2P.
                          </span>
                        ) : (
                          <span className="text-atlas-muted">{legendaEntrada(destino)}</span>
                        )}
                        {local.doPedido && <span className="block text-atlas-muted">Estoque sugerido pelo pedido de compra — pode trocar</span>}
                      </div>
                    )}
                  </div>
                  {multi && (
                    <div className="col-span-3 flex items-start gap-1">
                      <input
                        inputMode="decimal"
                        value={l.quantidade}
                        onChange={(e) => setLinha(i, { quantidade: e.target.value })}
                        placeholder="kg"
                        aria-label="Quantidade deste produto em kg"
                        className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => removeLinha(i)}
                        aria-label="Remover produto"
                        title="Remover produto"
                        className="px-2 py-2 text-atlas-muted hover:text-red-700 dark:hover:text-red-400"
                      >
                        ×
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="flex items-center justify-between gap-2">
              <button type="button" onClick={addLinha} className="text-xs text-atlas-muted underline hover:text-atlas-ink self-start">
                + Este item vira mais de um produto
              </button>
              {multi && (
                <span className={`text-[11px] ${Math.abs(falta) > TOLERANCIA_KG ? 'text-amber-700 dark:text-amber-400' : 'text-green-700 dark:text-green-400'}`}>
                  {Math.abs(falta) <= TOLERANCIA_KG
                    ? `Distribuídos ${fmtKg(somaLinhas)} kg — fecha com o peso conferido`
                    : falta > 0
                      ? `Faltam ${fmtKg(falta)} kg para fechar ${fmtKg(alvoKg)} kg`
                      : `${fmtKg(-falta)} kg acima do peso conferido (${fmtKg(alvoKg)} kg)`}
                </span>
              )}
            </div>
          </div>
          <div className="md:col-span-4">
            <label className="block text-xs font-medium text-atlas-muted mb-1">Peso conferido na balança (kg)</label>
            <input
              inputMode="decimal"
              value={form.quantidadeConferida}
              onChange={(e) => onChange({ quantidadeConferida: e.target.value })}
              placeholder={fmtKg(nfKg)}
              className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm font-mono"
            />
            <div className={`text-[11px] mt-1 ${temDivergencia ? 'text-amber-700 dark:text-amber-400' : 'text-atlas-muted'}`}>
              {temDivergencia
                ? `${delta > 0 ? '+' : ''}${fmtKg(delta)} kg em relação à nota — exige motivo e aprovação`
                : 'Em branco = quantidade da nota'}
            </div>
          </div>
          {temDivergencia && (
            <div className="md:col-span-12">
              <label className="block text-xs font-medium text-atlas-muted mb-1">Motivo da diferença</label>
              <input
                value={form.motivoDivergencia}
                onChange={(e) => onChange({ motivoDivergencia: e.target.value })}
                placeholder="Ex.: peso da balança acima do declarado na nota"
                className="w-full px-3 py-2 border border-atlas-border bg-atlas-bg rounded text-sm"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
