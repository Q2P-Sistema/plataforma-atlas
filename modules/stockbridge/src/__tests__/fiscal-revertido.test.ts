import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017 (ACXEGDP-437), research D21 — recebimento fiscal revertido no portal do OMIE (NF 19252, 25/10/2026).
// O modulo folha fiscal-revertido.ts: o predicado SQL (o mesmo na fila, no fiscal, no clique e no cron), a guarda da
// migration 0060, o kill switch e a marcacao 'revertido' do ledger e dos vinculos com o PC numa transacao so.

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  config: {} as Record<string, unknown>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getConfig: () => mocks.config,
  getPool: () => ({
    query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params),
    connect: async () => ({ query: (sql: string, params?: unknown[]) => mocks.clientQuery(sql, params), release: mocks.release }),
  }),
}));

import {
  ESPERA_LEITURA_AO_VIVO_SEG,
  MARGEM_REVERSAO_ESPELHO_MIN,
  RecebimentoFiscalRevertidoError,
  __resetColunaRevertido,
  colunaRevertidoExiste,
  conclusaoFiscalEmSql,
  fiscalRevertidoChaveLigada,
  fiscalRevertidoHabilitado,
  fiscalRevertidoSql,
  horaAlteracaoOmieSql,
  ledgerFiscalVigente,
  leituraAoVivoPodeDeclararReversao,
  marcarLedgerRevertido,
  nfComFiscalRevertido,
  pendenciaEspelhoEmSql,
  reversaoOmieDoLedgerEmSql,
} from '../services/fiscal-revertido.js';

const CHAVE = '31261061827663002031550010000192521253216947';
const espacos = (s: string) => s.replace(/\s+/g, ' ');

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.clientQuery.mockReset();
  mocks.release.mockReset();
  mocks.logger.error.mockClear();
  mocks.logger.warn.mockClear();
  mocks.config = { STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: true, STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: true };
  __resetColunaRevertido();
});

describe('horaAlteracaoOmieSql', () => {
  it('d_alt + h_alt em horario de Brasilia, com cast so depois do formato conferido (hora invalida = NULL, nunca 22007)', () => {
    const s = horaAlteracaoOmieSql('rr');
    expect(s).toContain(`rr.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'`);
    expect(s).toContain(`(rr.d_alt::date + rr.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo'`);
    expect(s.indexOf('rr.d_alt IS NOT NULL')).toBeLessThan(s.indexOf('THEN'));
    expect(s.trim().endsWith('END')).toBe(true);
  });
});

describe('predicado do fiscal revertido', () => {
  it('conclusao: ledger concluido/ja_concluido E revertido (a conclusao desfeita aconteceu), nota de entrada (qualquer situacao) e recebimento S, das tabelas da empresa', () => {
    const q = espacos(conclusaoFiscalEmSql('u.c_chave_nfe', 'q2p'));
    // o ledger revertido conta pelo finalizado_em: marcada a reversao e sem nota de entrada nem recebimento 'S' no
    // espelho, o marcador (revertido_em, posterior) segue ligando o sinal; uma conclusao nova o desliga
    expect(q).toContain(
      `FROM stockbridge.recebimento_fiscal rfc WHERE rfc.nf_chave_acesso = u.c_chave_nfe AND rfc.status IN ('concluido', 'ja_concluido', 'revertido')`,
    );
    expect(q).toContain(`FROM public."tbl_nf_header_Q2P" hnc WHERE hnc.c_chave_nfe = u.c_chave_nfe AND hnc.tp_nf = 0)`);
    expect(q).toContain(`FROM public."tbl_recebimentoNFe_Q2P" rrc WHERE rrc.c_chave_nfe = u.c_chave_nfe AND rrc.c_recebido = 'S')`);
    // recebimento S conta pela hora de alteracao E pela de recebimento: concluir no portal nao mexe em d_alt (NF 67988)
    expect(q).toContain(`MAX(GREATEST(CASE WHEN rrc.d_alt IS NOT NULL`);
    expect(q).toContain(`(rrc.d_rec::date + rrc.h_rec::text::time) AT TIME ZONE 'America/Sao_Paulo'`);
    // a nota de entrada excluida ou cancelada continua provando que houve conclusao (o espelho nunca a apaga)
    expect(q).not.toMatch(/hnc\.(deletada|cancelada)/);
    const a = espacos(conclusaoFiscalEmSql('u.c_chave_nfe', 'acxe'));
    expect(a).toContain('"tbl_nf_header_ACXE"');
    expect(a).toContain('"tbl_recebimentoNFe_ACXE"');
    expect(a).not.toContain('_Q2P"');
  });

  it('pendencia pelo espelho: recebimento N nao cancelado; nulo (linha defasada sem hora) nao conta', () => {
    const p = espacos(pendenciaEspelhoEmSql('$1::text', 'q2p'));
    expect(p).toContain(`rrp.c_recebido = 'N' AND COALESCE(rrp.c_cancelada, 'N') <> 'S'`);
    expect(p).toContain('MAX(CASE WHEN rrp.d_alt IS NOT NULL');
  });

  it('sinal: pendencia do espelho com margem de 2 min, marcador do ledger estrito, comparados com a conclusao mais recente; nunca NULL', () => {
    expect(MARGEM_REVERSAO_ESPELHO_MIN).toBe(2);
    const s = espacos(fiscalRevertidoSql('h.c_chave_nfe', 'q2p'));
    expect(s.startsWith('COALESCE(GREATEST(')).toBe(true);
    // o marcador vale pela hora da REVERSAO (do OMIE, quando veio do espelho; da leitura ao vivo, senao), nunca pela hora em que
    // a varredura ou o detalhe a perceberam: uma reconclusao no portal nesse meio-tempo desliga o sinal
    expect(s).toContain(
      `- interval '2 minutes', (SELECT MAX(COALESCE(rfr.revertido_omie_em, rfr.revertido_em)) FROM stockbridge.recebimento_fiscal rfr WHERE rfr.nf_chave_acesso = h.c_chave_nfe AND rfr.status = 'revertido')) > GREATEST(`,
    );
    expect(s.trim().endsWith(', false)')).toBe(true);
    // sem bind novo: a fila nao muda a numeracao dos parametros
    expect(s).not.toMatch(/\$\d/);
  });

  it('hora do OMIE gravada no ledger para a tela: a da reversao MAIS RECENTE (a que da o marcador), nunca a de uma anterior', () => {
    const r = espacos(reversaoOmieDoLedgerEmSql('x'));
    expect(r).toContain("SELECT rfo.revertido_omie_em FROM stockbridge.recebimento_fiscal rfo WHERE rfo.nf_chave_acesso = x AND rfo.status = 'revertido'");
    expect(r).toContain('ORDER BY COALESCE(rfo.revertido_omie_em, rfo.revertido_em) DESC, rfo.revertido_em DESC LIMIT 1');
    expect(r).not.toContain('MAX(');
  });

  it('nfComFiscalRevertido: avalia o sinal com a chave em $1; erro de banco = "nao revertido" com log', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ revertido: true }] });
    expect(await nfComFiscalRevertido(CHAVE, 'q2p')).toBe(true);
    const [sql, params] = mocks.poolQuery.mock.calls[0]!;
    expect(sql).toContain('rrp.c_chave_nfe = $1::text');
    expect(params).toEqual([CHAVE]);
    mocks.poolQuery.mockRejectedValueOnce(new Error('boom'));
    expect(await nfComFiscalRevertido(CHAVE, 'q2p')).toBe(false);
    expect(mocks.logger.error).toHaveBeenCalled();
  });
});

describe('habilitacao: chave da 016 + kill switch + migration 0060', () => {
  it('kill switch: so false desliga (ausente = ligada)', () => {
    mocks.config = {};
    expect(fiscalRevertidoChaveLigada()).toBe(true);
    mocks.config = { STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: false };
    expect(fiscalRevertidoChaveLigada()).toBe(false);
  });

  it('sem a chave da 016 ou com o kill switch desligado, nem confere a coluna', async () => {
    mocks.config = { STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: false, STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: true };
    expect(await fiscalRevertidoHabilitado()).toBe(false);
    mocks.config = { STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: true, STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: false };
    expect(await fiscalRevertidoHabilitado()).toBe(false);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('coluna presente fica em cache; ausente loga erro e confere de novo so depois do prazo', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ ok: false }] });
    expect(await fiscalRevertidoHabilitado()).toBe(false);
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('migration 0060'));
    expect(await colunaRevertidoExiste()).toBe(false);
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    __resetColunaRevertido();
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ ok: true }] });
    expect(await fiscalRevertidoHabilitado()).toBe(true);
    expect(await colunaRevertidoExiste()).toBe(true);
    expect(mocks.poolQuery).toHaveBeenCalledTimes(2);
    expect(mocks.poolQuery.mock.calls[1]![0]).toContain("table_name = 'recebimento_fiscal' AND column_name = 'revertido_em'");
  });

  it('o prazo de verdade: ausente fica em cache por 5 min (a 0060 aplicada com a API no ar liga a D21 sozinha); erro, por 30 s', async () => {
    let agora = Date.parse('2026-10-25T20:00:00.000Z');
    const relogio = vi.spyOn(Date, 'now').mockImplementation(() => agora);
    try {
      mocks.poolQuery.mockResolvedValue({ rows: [{ ok: false }] });
      expect(await colunaRevertidoExiste()).toBe(false);
      agora += 4 * 60_000 + 59_000; // 4m59s: ainda do cache, sem consultar
      expect(await colunaRevertidoExiste()).toBe(false);
      expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
      mocks.poolQuery.mockResolvedValue({ rows: [{ ok: true }] }); // a 0060 foi aplicada
      agora += 2_000; // 5m01s: confere de novo e liga
      expect(await colunaRevertidoExiste()).toBe(true);
      expect(mocks.poolQuery).toHaveBeenCalledTimes(2);
      // presente fica para sempre (sem nova consulta)
      agora += 60 * 60_000;
      expect(await colunaRevertidoExiste()).toBe(true);
      expect(mocks.poolQuery).toHaveBeenCalledTimes(2);

      // erro do banco: ausente por 30 s
      __resetColunaRevertido();
      mocks.poolQuery.mockReset();
      mocks.poolQuery.mockRejectedValueOnce(new Error('timeout'));
      expect(await colunaRevertidoExiste()).toBe(false);
      agora += 29_000;
      expect(await colunaRevertidoExiste()).toBe(false);
      expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
      mocks.poolQuery.mockResolvedValueOnce({ rows: [{ ok: true }] });
      agora += 2_000;
      expect(await colunaRevertidoExiste()).toBe(true);
      expect(mocks.poolQuery).toHaveBeenCalledTimes(2);
    } finally {
      relogio.mockRestore();
    }
  });

  it('erro ao conferir conta como ausente (sem derrubar quem chamou)', async () => {
    mocks.poolQuery.mockRejectedValueOnce(new Error('timeout'));
    expect(await colunaRevertidoExiste()).toBe(false);
    expect(mocks.logger.warn).toHaveBeenCalled();
  });
});

describe('ledgerFiscalVigente / espera da leitura ao vivo', () => {
  it('le a conclusao viva da NF (BIGINT como string vira numero)', async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [{ id: 'l1', status: 'concluido', empresa: 'q2p', n_id_receb: '8518467850', nota_fiscal: '19252', fornecedor_nome: 'ZARAPLAST S/A', finalizado_em: '2026-10-25T20:02:01.437Z' }],
    });
    expect(await ledgerFiscalVigente(CHAVE)).toEqual({
      id: 'l1', status: 'concluido', empresa: 'q2p', nIdReceb: 8518467850, notaFiscal: '19252', fornecedorNome: 'ZARAPLAST S/A', finalizadoEm: '2026-10-25T20:02:01.437Z',
    });
    expect(mocks.poolQuery.mock.calls[0]![0]).toContain("status IN ('concluido', 'ja_concluido')");
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await ledgerFiscalVigente(CHAVE)).toBeNull();
  });

  it(`a leitura ao vivo so declara a reversao ${ESPERA_LEITURA_AO_VIVO_SEG} s depois da conclusao (cache do OMIE)`, () => {
    const fim = '2026-10-25T20:02:01.000Z';
    expect(leituraAoVivoPodeDeclararReversao(fim, new Date('2026-10-25T20:03:00.000Z'))).toBe(false);
    expect(leituraAoVivoPodeDeclararReversao(fim, new Date('2026-10-25T20:03:16.000Z'))).toBe(true);
    expect(leituraAoVivoPodeDeclararReversao(null)).toBe(true);
  });
});

describe('marcarLedgerRevertido', () => {
  const okTransacao = (marcados: Array<{ id: string; nf_chave_acesso: string; nota_fiscal: string }>) => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE stockbridge.recebimento_fiscal rf')) return { rows: marcados };
      return { rows: [] };
    });
  };

  it('espelho: re-confere o sinal DENTRO do UPDATE, grava a hora do OMIE e leva os vinculos com o PC na mesma transacao', async () => {
    okTransacao([{ id: 'l1', nf_chave_acesso: CHAVE, nota_fiscal: '19252' }]);
    const r = await marcarLedgerRevertido({ nfChaveAcesso: CHAVE, empresa: 'q2p', origem: 'espelho' });
    expect(r).toEqual([{ id: 'l1', nfChaveAcesso: CHAVE, notaFiscal: '19252' }]);
    const sqls = mocks.clientQuery.mock.calls.map((c) => espacos(String(c[0])));
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toContain("SET status = 'revertido', revertido_em = now(), revertido_origem = $2, revertido_por = $3");
    expect(sqls[1]).toContain("WHERE rf.nf_chave_acesso = $1 AND rf.status IN ('concluido', 'ja_concluido') AND COALESCE(GREATEST(");
    expect(sqls[1]).toContain('revertido_omie_em = CASE WHEN (SELECT MAX(CASE WHEN rrp.d_alt');
    expect(sqls[1]).toContain('ELSE LEAST(');
    expect(mocks.clientQuery.mock.calls[1]![1]).toEqual([CHAVE, 'espelho', null]);
    expect(sqls[2]).toContain("UPDATE stockbridge.recebimento_fiscal_pc SET status = 'revertido'");
    expect(sqls[2]).toContain("status IN ('confirmado', 'associado', 'concluido')");
    expect(mocks.clientQuery.mock.calls[2]![1]).toEqual([['l1']]);
    expect(sqls[3]).toBe('COMMIT');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('leitura ao vivo: marca so a linha lida, sem re-conferir o espelho (a leitura e a prova), com quem clicou', async () => {
    okTransacao([{ id: 'l1', nf_chave_acesso: CHAVE, nota_fiscal: '19252' }]);
    await marcarLedgerRevertido({ nfChaveAcesso: CHAVE, empresa: 'q2p', origem: 'omie_ao_vivo', ledgerId: 'l1', userId: 'u-op' });
    const upd = espacos(String(mocks.clientQuery.mock.calls[1]![0]));
    expect(upd).toContain('AND rf.id = $4');
    expect(upd).not.toContain('COALESCE(GREATEST(');
    expect(upd).toContain('revertido_omie_em = NULL');
    expect(mocks.clientQuery.mock.calls[1]![1]).toEqual([CHAVE, 'omie_ao_vivo', 'u-op', 'l1']);
  });

  it('leitura ao vivo sem ledgerId e erro de programacao (nada e aberto)', async () => {
    await expect(marcarLedgerRevertido({ nfChaveAcesso: CHAVE, empresa: 'q2p', origem: 'omie_ao_vivo' })).rejects.toThrow(/ledgerId/);
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });

  it('nada a marcar (outra requisicao chegou antes, ou uma conclusao mais nova desligou o sinal): nao toca nos vinculos', async () => {
    okTransacao([]);
    expect(await marcarLedgerRevertido({ nfChaveAcesso: CHAVE, empresa: 'q2p', origem: 'espelho' })).toEqual([]);
    const sqls = mocks.clientQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('recebimento_fiscal_pc'))).toBe(false);
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
  });

  it('erro no meio: ROLLBACK, conexao devolvida e o erro sobe', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE stockbridge.recebimento_fiscal rf')) return { rows: [{ id: 'l1', nf_chave_acesso: CHAVE, nota_fiscal: '19252' }] };
      if (sql.includes('recebimento_fiscal_pc')) throw new Error('23514');
      return { rows: [] };
    });
    await expect(marcarLedgerRevertido({ nfChaveAcesso: CHAVE, empresa: 'q2p', origem: 'espelho' })).rejects.toThrow('23514');
    expect(mocks.clientQuery.mock.calls.map((c) => String(c[0]))).toContain('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});

describe('RecebimentoFiscalRevertidoError', () => {
  it('mensagem para o operador: NF, fornecedor, o que fazer — sem codigo do OMIE', () => {
    const e = new RecebimentoFiscalRevertidoError('19252', 'ZARAPLAST S/A');
    expect(e.name).toBe('RecebimentoFiscalRevertidoError');
    expect(e.message).toContain('NF 19252 (ZARAPLAST S/A) foi desfeito no OMIE depois de concluído');
    expect(e.message).toContain('A nota voltou para fiscal pendente');
    expect(e.message).not.toMatch(/[Rr]ecarregue/); // a tela ja recarrega a nota ao receber o 409
    // o "fale com o fiscal" fica no aviso da nota recarregada (a frase aparecia duas vezes na tela)
    expect(e.message).not.toContain('fale com o fiscal');
    expect(e.message).not.toMatch(/\d{10}/);
  });
});
