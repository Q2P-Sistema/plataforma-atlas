// ACXEGDP-440 — roteiro TEMPORÁRIO (não vai para o repositório): roda os mesmos cenários no código antigo (main) e no
// novo e grava, por cenário, o que iria ao SendGrid (Para, Cc, Cco, assunto, HTML, texto) e o retorno da função.
// Dados de negócio fictícios (NF 90601, FORNECEDOR EXEMPLO LTDA); destinatários fixos = os de PROD informados pelo
// usuário em 25/10/2026; usuários do banco (gestor, quem lançou) fictícios. Nada é enviado: sendEmail é simulado.
import { describe, it, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';

const SAIDA = `${process.env.HARNESS_OUT}/${process.env.HARNESS_TREE}`;
mkdirSync(SAIDA, { recursive: true });

const { sendEmailMock, estado, CFG } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue(undefined),
  estado: { aprovadores: ['gestor@exemplo.com.br'], operador: 'operador@exemplo.com.br', ctx: null as Record<string, unknown> | null },
  CFG: {
    APP_URL: 'https://atlas.q2p.com.br',
    MODULE_STOCKBRIDGE_ENABLED: true,
    SEED_ADMIN_EMAIL: 'flavio.endo@acxe-polimeros.com.br',
    STOCKBRIDGE_ADMIN_CC_EMAIL: 'flavio.endo@acxe-polimeros.com.br',
    STOCKBRIDGE_OPS_EMAIL: 'flavio.endo@acxe-polimeros.com.br',
    STOCKBRIDGE_COMEX_EMAIL: 'comex_acxe@acxe-polimeros.com.br',
    STOCKBRIDGE_FISCAL_EMAILS: ['nfe@acxe-polimeros.com.br', 'mauricio@acxe-polimeros.com.br', 'gustavo.dreer@acxe-polimeros.com.br', 'flavio.endo@acxe-polimeros.com.br'],
    STOCKBRIDGE_COMPRAS_EMAILS: ['gustavo.dreer@acxe-polimeros.com.br', 'flavio.endo@acxe-polimeros.com.br'],
  } as Record<string, unknown>,
}));

vi.mock('@atlas/core', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const db = () => {
    let limitado = false;
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'innerJoin', 'where']) c[m] = () => c;
    c.limit = () => { limitado = true; return c; };
    c.then = (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
      Promise.resolve(limitado ? [{ email: estado.operador }] : estado.aprovadores.map((email) => ({ email }))).then(ok, erro);
    c.execute = async () => ({ rows: estado.ctx ? [estado.ctx] : [] });
    return c;
  };
  return {
    ...real,
    sendEmail: sendEmailMock,
    getConfig: () => CFG,
    getDb: db,
    getPool: () => ({ connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }) }),
    createLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }),
  };
});

type M = typeof import('../services/notificacao.service.js');
const CHAVE = '35261000000000000000550010000906011000000000';
const FORN = 'FORNECEDOR EXEMPLO LTDA';
const ctxNf = { por_nf: true, nota_fiscal: '90601', fornecedor: FORN, item_nf: 'SUCATA DE PP EXEMPLO', produto: 'PP RECICLADO EXEMPLO', quantidade_kg: '18000.000', local: 'SANTO ANDRÉ (NACIONAL)', empresa: 'q2p', tem_produto_q2p: true, q2p_pendente: false };
const longo = 'Observação longa com acentuação: ação, já, útil, ônibus, maçã e "aspas" & <b>tags</b>. '.repeat(5).slice(0, 400);
// O que os chamadores passam em cada versão (recebimento, saída manual e aprovação montam o lote e os detalhes).
const ANTES = process.env.HARNESS_TREE === 'antes';
const comodato = (over: Record<string, unknown>) => ({
  movimentacaoId: 'm1', cliente: 'CLIENTE EXEMPLO LTDA', produtoCodigoAcxe: 4506000002, produtoDescricao: 'PP EXEMPLO H503', quantidadeKg: 500,
  galpaoOrigem: '11.1', dtSaida: '2026-09-01 10:15:00-03', dtPrevistaRetorno: '2026-10-01', diasVencido: 5, fase: 'inicial', ...over,
});

interface Cenario { id: string; ctx?: Record<string, unknown> | null; run: (m: M) => Promise<unknown>; dificil?: boolean }
const CENARIOS: Cenario[] = [
  { id: 'E01', run: (m) => m.enviarAlertaProdutoSemCorrelato({ codigoProdutoAcxe: 4506000001, notaFiscal: '90601', descricaoProduto: 'POLIPROPILENO EXEMPLO H503' }) },
  { id: 'E02a_acxe', run: (m) => m.enviarAlertaNfIndeterminada({ nf: '90601', cnpj: 'acxe', motivo: 'Consulta da NF no OMIE sem resposta (tempo esgotado)' }) },
  { id: 'E02b_q2p', run: (m) => m.enviarAlertaNfIndeterminada({ nf: '90601', cnpj: 'q2p', motivo: 'Consulta da NF no OMIE sem resposta (tempo esgotado)' }) },
  { id: 'E03', run: (m) => m.enviarAlertaDebitoCruzado({ notaFiscal: '90601', cnpjEmissor: 'q2p', cnpjFisico: 'acxe', quantidadeKg: 1250.5, movimentacaoId: 'mov-exemplo' }) },
  { id: 'E04a_divergencia', run: (m) => m.enviarAlertaAprovacaoPendente({ aprovacaoId: 'ap-1', tipoAprovacao: 'recebimento_divergencia', nivel: 'gestor', loteCodigo: ANTES ? 'L900' : 'Lote L900', produto: 'POLIPROPILENO EXEMPLO H503', quantidadeKg: 24975, detalhes: ANTES ? 'Divergência faltando de 25 kg — sacaria rasgada' : 'Faltando: 25 kg a menos — sacaria rasgada' }) },
  { id: 'E04b_saida_diretor', run: (m) => m.enviarAlertaAprovacaoPendente({ aprovacaoId: 'ap-2', tipoAprovacao: 'saida_descarte', nivel: 'diretor', loteCodigo: 'Galpão 11.1', produto: 'PEAD EXEMPLO F200', quantidadeKg: 300, detalhes: ANTES ? 'Saída manual descarte — material contaminado' : 'material contaminado' }) },
  { id: 'E04c_retorno_comodato', run: (m) => m.enviarAlertaAprovacaoPendente({ aprovacaoId: 'ap-3', tipoAprovacao: 'retorno_comodato', nivel: 'gestor', loteCodigo: ANTES ? 'Retorno comodato 1a2b3c4d' : 'CLIENTE EXEMPLO LTDA', produto: 'PP EXEMPLO H503', quantidadeKg: 500, detalhes: ANTES ? 'Retorno de comodato — devolvido completo' : 'devolvido completo' }) },
  { id: 'E05a_2itens', run: (m) => m.enviarAlertaRecebimentoNacionalLote({ notaFiscal: '90601', nivel: 'gestor', itens: [{ produto: 'SUCATA DE PP EXEMPLO', empresa: 'q2p', galpao: '11.1', quantidadeKg: 18000 }, { produto: 'SUCATA DE PE EXEMPLO', empresa: 'q2p', galpao: '11.1', quantidadeKg: 4500 }], detalhes: `Recebimento nacional via fila · ${FORN}` }) },
  { id: 'E05b_acxe_1item', run: (m) => m.enviarAlertaRecebimentoNacionalLote({ notaFiscal: '90601', nivel: 'gestor', itens: [{ produto: 'PP PRETO EXEMPLO', empresa: 'ACXE + Q2P', galpao: '21.1', quantidadeKg: 26000 }], detalhes: `Recebimento nacional via fila · ${FORN}` }) },
  { id: 'E06a_pendente', run: (m) => m.enviarAlertaNfDispensada({ notaFiscal: '90601', fornecedorNome: FORN, situacaoFiscalNaDispensa: 'pendente', valorNfBrl: 10000, motivo: 'Carga nunca chegou; o fornecedor vai cancelar a nota', dispensadoPorNome: 'Gestor Exemplo', dispensadoEm: '2026-10-26T13:00:00.000Z' }) },
  { id: 'E06b_concluido_acxe_pc', run: (m) => m.enviarAlertaNfDispensada({ notaFiscal: '90601', fornecedorNome: FORN, situacaoFiscalNaDispensa: 'concluido', valorNfBrl: 10000, motivo: 'Material devolvido ao fornecedor', dispensadoPorNome: 'Gestor Exemplo', dispensadoEm: '2026-10-26T13:00:00.000Z', pcsPorItem: [{ descricao: 'SUCATA DE PP EXEMPLO', pcNumero: '305' }], empresa: 'acxe' }) },
  { id: 'E06c_sem_fornecedor', run: (m) => m.enviarAlertaNfDispensada({ notaFiscal: '90601', fornecedorNome: null, situacaoFiscalNaDispensa: 'pendente', valorNfBrl: 10000, motivo: 'Nota em duplicidade', dispensadoPorNome: null, dispensadoEm: '2026-10-26T13:00:00.000Z' }) },
  { id: 'E07a_sem_pc', run: (m) => m.enviarAvisoComprasNfSemPc({ empresa: 'q2p', nfChaveAcesso: CHAVE, notaFiscal: '90601', fornecedorNome: FORN, itens: [{ nSequencia: 1, descricao: 'SUCATA DE PP EXEMPLO', qtdKg: 18000, precoUnit: 2.5 }], pcsAguardandoAprovacao: [], motivo: 'sem_pc', disparadoPor: null }) },
  { id: 'E07b_aguardando', run: (m) => m.enviarAvisoComprasNfSemPc({ empresa: 'q2p', nfChaveAcesso: CHAVE, notaFiscal: '90601', fornecedorNome: FORN, itens: [{ nSequencia: 1, descricao: 'SUCATA DE PP EXEMPLO', qtdKg: 18000, precoUnit: 2.5 }], pcsAguardandoAprovacao: ['305'], motivo: 'pc_aguardando_aprovacao', disparadoPor: null }) },
  { id: 'E07c_sem_vinculo', run: (m) => m.enviarAvisoComprasNfSemPc({ empresa: 'acxe', nfChaveAcesso: CHAVE, notaFiscal: '90601', fornecedorNome: FORN, itens: [{ nSequencia: 1, descricao: 'SUCATA DE PP EXEMPLO', qtdKg: 18000, precoUnit: 2.5 }], pcsAguardandoAprovacao: [], motivo: 'recebida_sem_vinculo', disparadoPor: null }) },
  { id: 'E07d_unidade', run: (m) => m.enviarAvisoComprasNfSemPc({ empresa: 'q2p', nfChaveAcesso: CHAVE, notaFiscal: '90601', fornecedorNome: FORN, itens: [{ nSequencia: 1, descricao: 'SUCATA DE PP EXEMPLO', qtdKg: 8250, precoUnit: 2.5 }], pcsAguardandoAprovacao: [], motivo: 'sem_pc', disparadoPor: null, unidadeIncompativel: { unidadeNf: 'TON', pcs: ['306'], itens: ['SUCATA DE PP EXEMPLO'] } }) },
  { id: 'E07f_acxe', run: (m) => m.enviarAvisoComprasNfSemPc({ empresa: 'acxe', nfChaveAcesso: CHAVE, notaFiscal: '90601', fornecedorNome: FORN, itens: [{ nSequencia: 1, descricao: 'SUCATA DE PP EXEMPLO', qtdKg: 18000, precoUnit: 2.5 }], pcsAguardandoAprovacao: [], motivo: 'sem_pc', disparadoPor: null }) },
  { id: 'E07e_item_un', run: (m) => m.enviarAvisoComprasNfSemPc({ empresa: 'q2p', nfChaveAcesso: CHAVE, notaFiscal: '90601', fornecedorNome: FORN, itens: [{ nSequencia: 2, descricao: 'TAMPA EXEMPLO', qtdKg: null, precoUnit: null, quantidadeTexto: '40 UN' }], pcsAguardandoAprovacao: [], motivo: 'sem_pc', disparadoPor: null }) },
  { id: 'E08', run: (m) => m.enviarAvisoComprasExcedenteRejeitado({ empresa: 'q2p', nfChaveAcesso: CHAVE, notaFiscal: '90601', fornecedorNome: FORN, itemDescricao: 'SUCATA DE PP EXEMPLO', produto: 'PP RECICLADO EXEMPLO', motivoRejeicao: 'Balança da portaria descalibrada; o peso real é o da nota', linhas: [{ nSequencia: 1, pcNumero: '305', qtdNfKg: 13382, kgRecebidoPc: 13500 }], disparadoPor: null }) },
  { id: 'E09a_parado_q2p', run: (m) => m.enviarAlertaEspelhoRecebimentosDefasado({ status: 'degraded', idadeMin: 185.4, limiteMin: 120 }, 'q2p') },
  { id: 'E09b_vazio_acxe', run: (m) => m.enviarAlertaEspelhoRecebimentosDefasado({ status: 'sem_dados', idadeMin: null, limiteMin: 120 }, 'acxe') },
  { id: 'E09c_sem_leitura_q2p', run: (m) => m.enviarAlertaEspelhoRecebimentosDefasado({ status: 'indisponivel', idadeMin: null, limiteMin: 120 }, 'q2p') },
  { id: 'E10a_parada_q2p', run: (m) => m.enviarAlertaCopiaPcsDefasada({ status: 'degraded', idadeMin: 240.2, limiteMin: 120 }, 'q2p') },
  { id: 'E10b_vazia_acxe', run: (m) => m.enviarAlertaCopiaPcsDefasada({ status: 'sem_dados', idadeMin: null, limiteMin: 120 }, 'acxe') },
  { id: 'E10c_sem_leitura_q2p', run: (m) => m.enviarAlertaCopiaPcsDefasada({ status: 'indisponivel', idadeMin: null, limiteMin: 120 }, 'q2p') },
  { id: 'E11a_pendente', run: (m) => m.enviarAlertaDispensaRevertida({ notaFiscal: '90601', fornecedorNome: FORN, situacaoFiscalNaDispensa: 'pendente', motivoReversao: 'A carga chegou afinal', revertidoPorNome: 'Gestor Exemplo', revertidoEm: '2026-10-26T15:00:00.000Z' }) },
  { id: 'E11b_concluido', run: (m) => m.enviarAlertaDispensaRevertida({ notaFiscal: '90601', fornecedorNome: FORN, situacaoFiscalNaDispensa: 'concluido', motivoReversao: 'A carga chegou afinal', revertidoPorNome: 'Gestor Exemplo', revertidoEm: '2026-10-26T15:00:00.000Z' }) },
  { id: 'E12a_q2p', run: (m) => m.enviarAvisoFiscalRevertido({ empresa: 'q2p', notaFiscal: '90601', fornecedorNome: FORN, concluidoEm: '2026-10-25T20:02:01.437Z', desfeitoEm: '2026-10-25T20:13:36.000Z', entrada: { pendentes: 1, aprovadas: 0, aprovadaEm: null }, pcs: ['308'] }) },
  { id: 'E12b_acxe_2pcs', run: (m) => m.enviarAvisoFiscalRevertido({ empresa: 'acxe', notaFiscal: '90601', fornecedorNome: FORN, concluidoEm: '2026-10-25T20:02:01.437Z', desfeitoEm: '2026-10-25T20:13:36.000Z', entrada: { pendentes: 1, aprovadas: 1, aprovadaEm: '2026-10-26T14:00:00.000Z' }, pcs: ['308', '309'] }) },
  { id: 'E12c_fora_do_atlas', run: (m) => m.enviarAvisoFiscalRevertido({ empresa: 'q2p', notaFiscal: '90601', fornecedorNome: FORN, concluidoEm: '2026-10-25T20:02:01.437Z', concluidoForaDoAtlas: true, desfeitoEm: null, entrada: { pendentes: 0, aprovadas: 0, aprovadaEm: null }, pcs: [] }) },
  { id: 'E13', run: (m) => m.enviarAlertaAprovacaoPendenteImportacaoLote({ notaFiscal: '90601', nivel: 'gestor', itens: [{ produto: 'PP EXEMPLO H503', quantidadeKg: 24975, deltaKg: -25, tipoDivergencia: 'faltando' }, { produto: 'PEAD EXEMPLO F200', quantidadeKg: 9990, deltaKg: -10, tipoDivergencia: 'varredura' }] }) },
  { id: 'E14a_q2p', run: (m) => m.enviarAlertaPendenciaOmie({ movimentacaoId: 'mov-exemplo', opId: 'op-exemplo', notaFiscal: '90601', ladoPendente: 'q2p', mensagemErro: 'OMIE: requisição rejeitada (tempo esgotado)', tentativas: 1 }) },
  { id: 'E14b_acxe_faltando', run: (m) => m.enviarAlertaPendenciaOmie({ movimentacaoId: 'mov-exemplo', opId: 'op-exemplo', notaFiscal: '90601', ladoPendente: 'acxe-faltando', mensagemErro: 'OMIE: requisição rejeitada (tempo esgotado)', tentativas: 2 }) },
  { id: 'E15a_falha', run: (m) => m.enviarAlertaBaixaPedidoQ2p({ movimentacaoId: 'mov-exemplo', notaFiscal: '90601', produtoDescricao: 'PP EXEMPLO H503', quantidadeKg: 24975, motivo: 'falha', mensagemErro: 'OMIE: pedido bloqueado para alteração', restanteKg: 24975, pedidos: [] }) },
  { id: 'E15b_sem_saldo', run: (m) => m.enviarAlertaBaixaPedidoQ2p({ movimentacaoId: 'mov-exemplo', notaFiscal: '90601', produtoDescricao: 'PP EXEMPLO H503', quantidadeKg: 24975, motivo: 'sem_saldo', restanteKg: 4975, pedidos: [{ numero: '251', saldoAnteriorKg: 20000, saldoNovoKg: 0.1 }] }) },
  { id: 'E16a_1nf', run: (m) => m.enviarDigestBaixasAguardandoVinculo({ itens: [{ notaFiscal: '90601', dias: 4 }], diasLimite: 3 }) },
  { id: 'E16b_3nfs', run: (m) => m.enviarDigestBaixasAguardandoVinculo({ itens: [{ notaFiscal: '90601', dias: 4 }, { notaFiscal: '90602', dias: 5 }, { notaFiscal: '90603', dias: 12 }], diasLimite: 3 }) },
  { id: 'E17a_por_nf', ctx: ctxNf, run: (m) => m.enviarNotificacaoRejeicaoOperador({ operadorUserId: 'u1', aprovacaoId: 'a1b2c3d4-1111-4222-8333-944455556666', loteId: 'mov', motivo: 'Peso não confere com a balança', fluxo: 'recebimento', tipoAprovacao: 'entrada_manual' }) },
  { id: 'E17b_manual', ctx: { ...ctxNf, por_nf: false, fornecedor: null, item_nf: null }, run: (m) => m.enviarNotificacaoRejeicaoOperador({ operadorUserId: 'u1', aprovacaoId: 'a1b2c3d4-1111-4222-8333-944455556666', loteId: 'mov', motivo: 'Número da NF digitado errado', fluxo: 'recebimento', tipoAprovacao: 'entrada_manual' }) },
  { id: 'E17c_saida', ctx: null, run: (m) => m.enviarNotificacaoRejeicaoOperador({ operadorUserId: 'u1', aprovacaoId: 'b2c3d4e5-1111-4222-8333-944455556666', loteId: 'mov', motivo: 'Descarte sem laudo', fluxo: 'saida_manual', tipoAprovacao: 'saida_descarte' }) },
  { id: 'E18a_por_nf', ctx: ctxNf, run: (m) => m.enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'a1b2c3d4-1111-4222-8333-944455556666', tipoAprovacao: 'entrada_manual' }) },
  { id: 'E18b_divergencia_comex', ctx: null, run: (m) => m.enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'c3d4e5f6-1111-4222-8333-944455556666', tipoAprovacao: 'recebimento_divergencia', incluirComex: true }) },
  { id: 'E18d_divergencia_pendente', ctx: null, run: (m) => m.enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'c3d4e5f6-1111-4222-8333-944455556666', tipoAprovacao: 'recebimento_divergencia', incluirComex: false, pendenciaOmie: true } as never) },
  { id: 'E18c_acxe', ctx: { ...ctxNf, empresa: 'acxe', local: 'EXTREMA (21.1)' }, run: (m) => m.enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'a1b2c3d4-1111-4222-8333-944455556666', tipoAprovacao: 'entrada_manual' }) },
  { id: 'E19', run: (m) => m.enviarNotificacaoRecebimentoConcluido({ operadorUserId: 'u1', loteCodigo: 'L900', notaFiscal: '90601', produto: 'PP EXEMPLO H503', quantidadeKg: 25000, fornecedor: FORN, localidade: 'ARMAZÉM EXEMPLO (11.1)' }) },
  { id: 'E20', run: (m) => m.enviarNotificacaoRecebimentoConcluidoLote({ operadorUserId: 'u1', notaFiscal: '90601', fornecedor: FORN, itens: [{ loteCodigo: 'L900', produto: 'PP EXEMPLO H503', quantidadeKg: 25000, localidade: 'ARMAZÉM EXEMPLO (11.1)' }, { loteCodigo: 'L901', produto: 'PEAD EXEMPLO F200', quantidadeKg: 12500, localidade: 'ARMAZÉM EXEMPLO (11.1)' }, { loteCodigo: 'L902', produto: 'PVC EXEMPLO K57', quantidadeKg: 800.5, localidade: 'ARMAZÉM EXEMPLO (12.1)' }] }) },
  { id: 'E21a_1', run: (m) => m.enviarDigestComodatosVencidos({ to: 'gestor@exemplo.com.br', comodatos: [comodato({})] as never }) },
  { id: 'E21b_escalada', run: (m) => m.enviarDigestComodatosVencidos({ to: 'gestor@exemplo.com.br', comodatos: [comodato({ cliente: 'CLIENTE A EXEMPLO', diasVencido: 2 }), comodato({ cliente: 'CLIENTE B EXEMPLO', diasVencido: 31, fase: 'escalada' }), comodato({ cliente: null, diasVencido: 16, fase: 'escalada' })] as never }) },
  // entradas difíceis (só o novo é conferido)
  { id: 'H1_dispensa', dificil: true, run: (m) => m.enviarAlertaNfDispensada({ notaFiscal: '000090601', fornecedorNome: 'ACME "Plásticos" & <script>alert(1)</script> Indústria e Comércio de Embalagens Ltda', situacaoFiscalNaDispensa: 'pendente', valorNfBrl: Number.NaN, motivo: longo, dispensadoPorNome: null, dispensadoEm: 'lixo' }) },
  { id: 'H2_compras', dificil: true, run: (m) => m.enviarAvisoComprasNfSemPc({ empresa: 'q2p', nfChaveAcesso: CHAVE, notaFiscal: '000090601', fornecedorNome: null, itens: [{ nSequencia: 1, descricao: '<b>SUCATA</b> "PP" & PE', qtdKg: Number.NaN, precoUnit: null }], pcsAguardandoAprovacao: [], motivo: 'sem_pc', disparadoPor: null }) },
  { id: 'H3_rejeicao', dificil: true, ctx: { ...ctxNf, fornecedor: null, item_nf: null, produto: null, quantidade_kg: null, local: null }, run: (m) => m.enviarNotificacaoRejeicaoOperador({ operadorUserId: 'u1', aprovacaoId: 'd4e5f6a7-1111-4222-8333-944455556666', loteId: 'mov', motivo: longo, fluxo: 'recebimento', tipoAprovacao: 'entrada_manual' }) },
  { id: 'H4_fiscal', dificil: true, run: (m) => m.enviarAvisoFiscalRevertido({ empresa: 'acxe', notaFiscal: '000', fornecedorNome: '   ', concluidoEm: 'lixo', desfeitoEm: null, entrada: { pendentes: 0, aprovadas: 3, aprovadaEm: null }, pcs: ['8518467850', ''] }) },
];

describe('ACXEGDP-440 — antigo × novo', () => {
  beforeEach(() => {
    sendEmailMock.mockClear();
  });
  for (const c of CENARIOS) {
    it(c.id, async () => {
      estado.ctx = c.ctx ?? null;
      const m = (await import('../services/notificacao.service.js')) as M;
      let retorno: unknown;
      let erro: string | null = null;
      try {
        retorno = await c.run(m);
      } catch (e) {
        erro = (e as Error).message;
      }
      const envios = sendEmailMock.mock.calls.map((a) => a[0] as Record<string, unknown>);
      writeFileSync(`${SAIDA}/${c.id}.json`, JSON.stringify({ id: c.id, dificil: !!c.dificil, retorno: retorno ?? null, erro, envios }, null, 2));
    });
  }
});
