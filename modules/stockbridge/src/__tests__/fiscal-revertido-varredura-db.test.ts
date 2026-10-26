import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Feature 017 (ACXEGDP-437), research D21 — a varredura do cron com o SQL EXECUTADO num Postgres real (migration 0060).
// Prova o que os testes com dublê so leem no texto: o sinal avaliado sobre ledger + espelho de recebimentos (fase A), as
// condicoes da fase B (entrada fisica ativa, sem dispensa, ainda revertido, janelas, sem aviso), o DISTINCT ON por NF,
// o aviso gravado so apos a entrega e a idempotencia da segunda rodada. Inclui o caso em que a marcacao tira a UNICA
// evidencia de conclusao (sem nota de entrada no espelho de NF): o sinal sozinho viraria falso e o fiscal nao seria avisado.
//
// Opt-in: ATLAS_DB_INTEGRATION=1 + DATABASE_URL, com o schema stockbridge ate a 0060 e o espelho
// tbl_recebimentoNFe_Q2P. Sem isso o describe e PULADO. A varredura age sobre TODOS os ledgers recentes do banco: por
// seguranca o teste SO roda se nao houver ledger recente com chave fora do prefixo de teste (99) — ou seja, em banco
// descartavel/DEV, nunca num ambiente com dado real. Nunca chama o OMIE e nao envia e-mail (sendEmail e substituido).
// Os arquivos de banco criam e removem as mesmas tabelas do espelho: com o opt-in o vitest.config.ts do modulo os roda um
// por vez (fora dele, use --no-file-parallelism).
//
//   ATLAS_DB_INTEGRATION=1 DATABASE_URL=postgres://... REDIS_URL=redis://localhost:6379 SESSION_SECRET=<32+ chars> \
//     pnpm --filter @atlas/stockbridge exec vitest run src/__tests__/fiscal-revertido-varredura-db.test.ts

const DB_URL = process.env.DATABASE_URL;
const temBanco = process.env.ATLAS_DB_INTEGRATION === '1' && typeof DB_URL === 'string' && DB_URL.length > 0;

const h = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  sendEmail: vi.fn(),
}));

vi.mock('@atlas/core', async () => {
  const real = await vi.importActual<typeof import('@atlas/core')>('@atlas/core');
  const calado = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
  return { ...real, createLogger: () => calado, getConfig: () => h.config, sendEmail: (...a: unknown[]) => h.sendEmail(...a) };
});

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

const BASE = 7_000_000_000_000 + Math.floor(Math.random() * 900_000_000) * 1000;
const chave = (n: number): string => `99${String(BASE + n).padStart(42, '0')}`;
const NF = {
  revertidaAguardando: chave(1), // A: sinal ligado, entrada aguardando o gestor, PC 308 -> marca e avisa
  revertidaAprovada: chave(2), // duas reversoes da mesma NF, entrada aprovada -> um aviso so
  semEntrada: chave(3), // marca, mas sem entrada fisica: nao avisa
  comDispensa: chave(4), // marca, entrada ativa, mas dispensa ativa: nao avisa
  reconcluidaNoPortal: chave(5), // recebimento S depois da conclusao: nao e reversao
  espelhoAntigo: chave(6), // recebimento N ANTES da conclusao (defasagem): nao e reversao
  foraDaJanelaA: chave(7), // concluida ha 20 dias: fora dos 14 dias da fase A
  foraDaJanelaB: chave(8), // revertido ha 8 dias sem aviso: fora dos 7 dias da fase B
  jaAvisada: chave(9), // revertido ja avisado
  refeita: chave(10), // revertido, mas o Atlas refez o fiscal depois: nao avisa
  entradaRejeitada: chave(11), // marca, mas a unica entrada esta inativa (rejeitada): nao avisa
  acxe: chave(12), // ACXE (so se o espelho da ACXE existir)
  parcial: chave(13), // 2 itens: um aprovado, o outro rejeitado (volta a fila) -> marca e avisa (os itens lancados nao voltam)
};
const TODAS = Object.values(NF);
const FISCAL = ['fiscal1@teste.local', 'fiscal2@teste.local'];

describe.skipIf(!temBanco)('migration 0060 — varredura do recebimento fiscal revertido (integracao)', () => {
  let pool: Pool;
  let pronto = false;
  let temAcxe = false;
  let usuario = '';
  let criouUsuario = false;
  const movs: string[] = [];
  const aprovacoes: string[] = [];
  let varrer: typeof import('../services/fiscal-revertido-varredura.service.js').varrerFiscaisRevertidos;
  let primeira: { marcados: number; avisados: number; falhas: number };
  /** espelhos de NF criados por este teste (faltavam no banco): apagados no fim */
  const headersCriados: string[] = [];
  let enviados: Array<{ to: string; subject: string; html: string; text?: string }> = [];

  const sp = (sqlInstante: string) => ({
    // d_alt (date) e h_alt (HH:MI:SS) em horario de Brasilia, como o OMIE grava
    d: `(${sqlInstante} AT TIME ZONE 'America/Sao_Paulo')::date`,
    h: `to_char(${sqlInstante} AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI:SS')`,
  });

  async function ledger(nf: string, status: string, finalizadoHa: string, opts: { empresa?: string; revertidoHa?: string; avisadoHa?: string; nota?: string } = {}): Promise<string> {
    const r = await pool.query(
      `INSERT INTO stockbridge.recebimento_fiscal (nf_chave_acesso, n_id_receb, nota_fiscal, fornecedor_nome, status, confirmado_por, iniciado_em, finalizado_em, empresa,
                                                   revertido_em, revertido_origem, aviso_fiscal_em)
       VALUES ($1, $2, $3, 'ZARAPLAST S/A', $4, $5, now() - ($6::text)::interval - interval '1 minute', now() - ($6::text)::interval, $7,
               CASE WHEN $8::text IS NOT NULL THEN now() - ($8::text)::interval END, CASE WHEN $8::text IS NOT NULL THEN 'espelho' END,
               CASE WHEN $9::text IS NOT NULL THEN now() - ($9::text)::interval END)
       RETURNING id`,
      [nf, BASE + Math.floor(Math.random() * 1000), opts.nota ?? '000019252', status, usuario, finalizadoHa, opts.empresa ?? 'q2p', opts.revertidoHa ?? null, opts.avisadoHa ?? null],
    );
    return String(r.rows[0]!.id);
  }

  async function espelho(tabela: string, nf: string, recebido: 'N' | 'S', alteradoHa: string): Promise<void> {
    const { d, h: hora } = sp(`(now() - ($3::text)::interval)`);
    await pool.query(
      `INSERT INTO public."${tabela}" (n_id_receb, c_chave_nfe, c_recebido, c_cancelada, d_alt, h_alt) VALUES ($1, $2, $4, 'N', ${d}, ${hora})`,
      [BASE + Math.floor(Math.random() * 100000) + 500000, nf, alteradoHa, recebido],
    );
  }

  async function entrada(nf: string, status: 'pendente' | 'aprovada', opts: { ativo?: boolean; descricao?: string } = {}): Promise<void> {
    const ativo = opts.ativo ?? true;
    const m = await pool.query(
      `INSERT INTO stockbridge.movimentacao (nota_fiscal, tipo_movimento, subtipo, quantidade_kg, empresa, galpao, produto_codigo_q2p, status_omie, ativo,
          nf_chave_acesso, nf_item_descricao, nf_item_descricao_normalizada, nf_item_sequencias, quantidade_nf_kg)
       VALUES ('19252', 'entrada_manual', 'compra_nacional', 13750, 'q2p', '11.2', $1, 'concluida', $3, $2, $4, $4, ARRAY[1], 13750)
       RETURNING id`,
      [BASE + 9, nf, ativo, opts.descricao ?? 'SUCATA PP'],
    );
    movs.push(String(m.rows[0]!.id));
    const a = await pool.query(
      `INSERT INTO stockbridge.aprovacao (precisa_nivel, tipo_aprovacao, lancado_por, status, movimentacao_id, produto_codigo_q2p, galpao, empresa, aprovado_por, aprovado_em)
       VALUES ('gestor', 'entrada_manual', $1, $2::text, $3, $4, '11.2', 'q2p', CASE WHEN $2::text = 'aprovada' THEN $1::uuid END, CASE WHEN $2::text = 'aprovada' THEN now() - interval '1 hour' END)
       RETURNING id`,
      [usuario, status, String(m.rows[0]!.id), BASE + 9],
    );
    aprovacoes.push(String(a.rows[0]!.id));
  }

  async function vinculoPc(ledgerId: string, nf: string, seq: number, numero: string, status: string): Promise<void> {
    await pool.query(
      `INSERT INTO stockbridge.recebimento_fiscal_pc (recebimento_fiscal_id, nf_chave_acesso, n_sequencia, origem, n_cod_ped, n_cod_item_ped, pc_numero, dentro_tolerancia,
                                                      qtd_nf_kg, preco_nf, status, confirmado_por)
       VALUES ($1, $2, $3, 'sugestao', $4, $5, $6, true, 13750, 3.5, $7, $8)`,
      [ledgerId, nf, seq, BASE + 100 + seq, BASE + 200 + seq, numero, status, usuario],
    );
  }

  const estado = async (nf: string) =>
    (await pool.query(`SELECT status, revertido_origem, (revertido_omie_em IS NOT NULL) AS omie_em, (aviso_fiscal_em IS NOT NULL) AS avisado FROM stockbridge.recebimento_fiscal WHERE nf_chave_acesso = $1 ORDER BY created_at, id`, [nf]))
      .rows;
  const emailsDe = (nota: string) => enviados.filter((e) => e.subject.includes(`NF ${nota} `));

  beforeAll(async () => {
    const core = await import('@atlas/core');
    pool = core.getPool() as unknown as Pool;
    const col = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'stockbridge' AND table_name = 'recebimento_fiscal' AND column_name = 'aviso_fiscal_em'`,
    );
    const esp = await pool.query(`SELECT to_regclass('public."tbl_recebimentoNFe_Q2P"') AS t, to_regclass('public."tbl_recebimentoNFe_ACXE"') AS a`);
    if (col.rows.length === 0 || !esp.rows[0]!.t) {
      console.warn('[fiscal-revertido-varredura-db] testes pulados: schema sem a migration 0060 ou sem o espelho tbl_recebimentoNFe_Q2P');
      return;
    }
    // a varredura age sobre todo ledger recente do banco: so roda onde nao ha dado real na janela
    const reais = await pool.query(
      `SELECT count(*)::int AS n FROM stockbridge.recebimento_fiscal
        WHERE nf_chave_acesso NOT LIKE '99%'
          AND ((status IN ('concluido', 'ja_concluido') AND finalizado_em > now() - interval '14 days') OR (status = 'revertido' AND revertido_em > now() - interval '7 days'))`,
    );
    if (Number(reais.rows[0]!.n) > 0) {
      console.warn('[fiscal-revertido-varredura-db] testes pulados: o banco tem ledger recente de dado real (a varredura o marcaria)');
      return;
    }
    temAcxe = Boolean(esp.rows[0]!.a);
    // O sinal tambem le o espelho de NF (nota de entrada como evidencia de conclusao). Nenhuma migration o cria (o n8n cria):
    // num banco descartavel ele pode faltar — cria-se o minimo que o sinal le e apaga-se no fim (fase adiada com 42P01, senao).
    for (const [tabela, criar] of [['tbl_nf_header_Q2P', true], ['tbl_nf_header_ACXE', temAcxe]] as const) {
      if (!criar) continue;
      const existe = await pool.query(`SELECT to_regclass($1) AS t`, [`public."${tabela}"`]);
      if (existe.rows[0]!.t) continue;
      await pool.query(`CREATE TABLE public."${tabela}" (n_id_nf bigint PRIMARY KEY, c_chave_nfe varchar(44), tp_nf smallint, d_alt date, h_alt time, deletada boolean NOT NULL DEFAULT false, cancelada boolean NOT NULL DEFAULT false)`);
      headersCriados.push(tabela);
    }
    const u = await pool.query(`SELECT id FROM atlas.users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`);
    if (u.rows[0]) {
      usuario = String(u.rows[0].id);
    } else {
      const novo = await pool.query(`INSERT INTO atlas.users (name, email, password_hash, role) VALUES ('teste 0060', $1, 'x', 'gestor') RETURNING id`, [`teste-0060-${BASE}@t.local`]);
      usuario = String(novo.rows[0]!.id);
      criouUsuario = true;
    }

    h.config = {
      APP_URL: 'https://atlas.teste.local',
      STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: true,
      STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: true,
      STOCKBRIDGE_FISCAL_EMAILS: FISCAL,
      ...(temAcxe ? { STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED: true, STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE: '2026-10-01' } : {}),
    };
    h.sendEmail.mockImplementation(async (e: { to: string; subject: string; html: string; text?: string }) => {
      enviados.push(e);
    });

    // A) concluida ha 3 h; o recebimento voltou a N 11 min depois; entrada aguardando o gestor; PC 308 em duas linhas + um PC com cara de codigo OMIE
    const a = await ledger(NF.revertidaAguardando, 'concluido', '3 hours');
    await vinculoPc(a, NF.revertidaAguardando, 1, '308', 'concluido');
    await vinculoPc(a, NF.revertidaAguardando, 2, '308', 'concluido');
    await vinculoPc(a, NF.revertidaAguardando, 3, '8518467850', 'concluido');
    await espelho('tbl_recebimentoNFe_Q2P', NF.revertidaAguardando, 'N', '2 hours 49 minutes');
    await entrada(NF.revertidaAguardando, 'pendente');
    // duas reversoes da mesma NF (ambas sem aviso), entrada aprovada: um e-mail so
    await ledger(NF.revertidaAprovada, 'revertido', '30 hours', { revertidoHa: '29 hours', nota: '000010010' });
    await ledger(NF.revertidaAprovada, 'revertido', '6 hours', { revertidoHa: '5 hours', nota: '000010010' });
    await entrada(NF.revertidaAprovada, 'aprovada');
    // marca, mas nao avisa
    await ledger(NF.semEntrada, 'concluido', '3 hours', { nota: '3003' });
    await espelho('tbl_recebimentoNFe_Q2P', NF.semEntrada, 'N', '2 hours');
    await ledger(NF.comDispensa, 'concluido', '3 hours', { nota: '4004' });
    await espelho('tbl_recebimentoNFe_Q2P', NF.comDispensa, 'N', '2 hours');
    await entrada(NF.comDispensa, 'pendente');
    await pool.query(
      `INSERT INTO stockbridge.nf_dispensa (nf_chave_acesso, nota_fiscal, situacao_fiscal_na_dispensa, motivo, dispensado_por) VALUES ($1, '4004', 'concluido', 'teste 0060', $2)`,
      [NF.comDispensa, usuario],
    );
    await ledger(NF.entradaRejeitada, 'concluido', '3 hours', { nota: '11011' });
    await espelho('tbl_recebimentoNFe_Q2P', NF.entradaRejeitada, 'N', '2 hours');
    await entrada(NF.entradaRejeitada, 'pendente', { ativo: false });
    // marca e avisa: NF de 2 itens com um aprovado e o outro rejeitado (o rejeitado volta a fila como fiscal revertido)
    await ledger(NF.parcial, 'concluido', '3 hours', { nota: '13013' });
    await espelho('tbl_recebimentoNFe_Q2P', NF.parcial, 'N', '2 hours');
    await entrada(NF.parcial, 'aprovada');
    await entrada(NF.parcial, 'pendente', { ativo: false, descricao: 'SUCATA PEAD' });
    // nao e reversao
    await ledger(NF.reconcluidaNoPortal, 'concluido', '3 hours', { nota: '5005' });
    await espelho('tbl_recebimentoNFe_Q2P', NF.reconcluidaNoPortal, 'S', '2 hours');
    await entrada(NF.reconcluidaNoPortal, 'aprovada');
    await ledger(NF.espelhoAntigo, 'concluido', '3 hours', { nota: '6006' });
    await espelho('tbl_recebimentoNFe_Q2P', NF.espelhoAntigo, 'N', '5 hours');
    await entrada(NF.espelhoAntigo, 'pendente');
    // fora das janelas
    await ledger(NF.foraDaJanelaA, 'concluido', '20 days', { nota: '7007' });
    await espelho('tbl_recebimentoNFe_Q2P', NF.foraDaJanelaA, 'N', '19 days');
    await entrada(NF.foraDaJanelaA, 'pendente');
    await ledger(NF.foraDaJanelaB, 'revertido', '9 days', { revertidoHa: '8 days', nota: '8008' });
    await entrada(NF.foraDaJanelaB, 'pendente');
    await ledger(NF.jaAvisada, 'revertido', '2 days', { revertidoHa: '1 day', avisadoHa: '23 hours', nota: '9009' });
    await entrada(NF.jaAvisada, 'pendente');
    // revertido, mas o Atlas refez o fiscal depois
    await ledger(NF.refeita, 'revertido', '5 hours', { revertidoHa: '4 hours', nota: '10101' });
    await ledger(NF.refeita, 'concluido', '1 hour', { nota: '10101' });
    await entrada(NF.refeita, 'aprovada');
    if (temAcxe) {
      await ledger(NF.acxe, 'concluido', '3 hours', { empresa: 'acxe', nota: '012012' });
      await espelho('tbl_recebimentoNFe_ACXE', NF.acxe, 'N', '2 hours');
      await entrada(NF.acxe, 'pendente');
    }

    const mod = await import('../services/fiscal-revertido-varredura.service.js');
    varrer = mod.varrerFiscaisRevertidos;
    primeira = await varrer();
    pronto = true;
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    const apagar = async (sql: string, params: unknown[]) => {
      try {
        await pool.query(sql, params);
      } catch {
        /* limpeza em melhor esforco */
      }
    };
    await apagar(`DELETE FROM stockbridge.recebimento_fiscal_pc WHERE nf_chave_acesso = ANY($1::text[])`, [TODAS]);
    await apagar(`DELETE FROM stockbridge.recebimento_fiscal WHERE nf_chave_acesso = ANY($1::text[])`, [TODAS]);
    await apagar(`DELETE FROM stockbridge.nf_dispensa WHERE nf_chave_acesso = ANY($1::text[])`, [TODAS]);
    await apagar(`DELETE FROM stockbridge.aprovacao WHERE id = ANY($1::uuid[])`, [aprovacoes]);
    await apagar(`DELETE FROM stockbridge.movimentacao WHERE id = ANY($1::uuid[])`, [movs]);
    await apagar(`DELETE FROM public."tbl_recebimentoNFe_Q2P" WHERE c_chave_nfe = ANY($1::text[])`, [TODAS]);
    if (temAcxe) await apagar(`DELETE FROM public."tbl_recebimentoNFe_ACXE" WHERE c_chave_nfe = ANY($1::text[])`, [TODAS]);
    if (criouUsuario) await apagar(`DELETE FROM atlas.users WHERE id = $1`, [usuario]);
    for (const tabela of headersCriados) await apagar(`DROP TABLE IF EXISTS public."${tabela}"`, []);
    const core = await import('@atlas/core');
    await core.closePool();
  });

  it('fase A: marca so o ledger cujo espelho de recebimentos voltou a N DEPOIS da conclusao (com a hora do OMIE) e leva os vinculos de PC para revertido', async (ctx) => {
    if (!pronto) return ctx.skip();
    expect(await estado(NF.revertidaAguardando)).toEqual([{ status: 'revertido', revertido_origem: 'espelho', omie_em: true, avisado: true }]);
    const pcs = await pool.query(`SELECT status, count(*)::int AS n FROM stockbridge.recebimento_fiscal_pc WHERE nf_chave_acesso = $1 GROUP BY status`, [NF.revertidaAguardando]);
    expect(pcs.rows).toEqual([{ status: 'revertido', n: 3 }]);
    for (const nf of [NF.semEntrada, NF.comDispensa, NF.entradaRejeitada, NF.parcial]) {
      expect(await estado(nf)).toEqual([expect.objectContaining({ status: 'revertido', revertido_origem: 'espelho', omie_em: true })]);
    }
    // nao e reversao: recebimento S depois, N antes da conclusao, fora da janela de 14 dias
    for (const nf of [NF.reconcluidaNoPortal, NF.espelhoAntigo, NF.foraDaJanelaA]) {
      expect(await estado(nf)).toEqual([expect.objectContaining({ status: 'concluido', revertido_origem: null })]);
    }
    // 5 sempre (A, sem entrada, dispensada, entrada rejeitada, parcial); + ACXE quando o espelho dela existe
    expect(primeira.marcados).toBe(temAcxe ? 6 : 5);
  });

  it('fase B: avisa o fiscal da NF com a entrada fisica ativa (um e-mail por destinatario) e grava aviso_fiscal_em so depois', async (ctx) => {
    if (!pronto) return ctx.skip();
    const nf = emailsDe('19252');
    expect(nf.map((e) => e.to).sort()).toEqual(FISCAL);
    expect(nf[0]!.subject).toBe('Recebimento fiscal desfeito no OMIE — NF 19252 (ZARAPLAST S/A)');
    expect(nf[0]!.html).toContain('aguardando aprovação do gestor');
    expect(nf[0]!.html).toContain('PC 308');
    expect(primeira.avisados).toBe(temAcxe ? 4 : 3);
    expect(primeira.falhas).toBe(0);
  });

  it('NF parcial (um item aprovado, o outro rejeitado): avisa mesmo com o rejeitado de volta a fila — o e-mail fala dos itens lancados, nao da nota inteira', async (ctx) => {
    if (!pronto) return ctx.skip();
    const nf = emailsDe('13013');
    expect(nf.map((e) => e.to).sort()).toEqual(FISCAL);
    expect(nf[0]!.html).toContain('aprovada em');
    expect(nf[0]!.html).toContain('os itens lançados não voltam à fila de recebimento do StockBridge');
    expect(nf[0]!.html).not.toContain('a nota não volta à fila');
    expect((await estado(NF.parcial))[0]!.avisado).toBe(true);
  });

  it('nenhum e-mail carrega sequencia de 10+ digitos (chave de acesso, nIdReceb, nCodPed), nem o PC com cara de codigo do OMIE', async (ctx) => {
    if (!pronto) return ctx.skip();
    expect(enviados.length).toBeGreaterThan(0);
    for (const e of enviados) {
      expect(e.subject).not.toMatch(/\d{10}/);
      expect(e.html).not.toMatch(/\d{10}/);
      expect(e.text ?? '').not.toMatch(/\d{10}/);
    }
  });

  it('duas reversoes da mesma NF viram UM aviso (a mais recente) e as duas linhas ficam marcadas como avisadas', async (ctx) => {
    if (!pronto) return ctx.skip();
    expect(emailsDe('10010').map((e) => e.to).sort()).toEqual(FISCAL);
    expect(emailsDe('10010')[0]!.html).toContain('aprovada em');
    expect((await estado(NF.revertidaAprovada)).map((l) => l.avisado)).toEqual([true, true]);
  });

  it('marcada sem entrada fisica, com dispensa ativa ou com a entrada rejeitada: nao avisa (e fica sem aviso)', async (ctx) => {
    if (!pronto) return ctx.skip();
    for (const [nf, nota] of [[NF.semEntrada, '3003'], [NF.comDispensa, '4004'], [NF.entradaRejeitada, '11011']] as const) {
      expect(emailsDe(nota)).toHaveLength(0);
      expect((await estado(nf))[0]!.avisado).toBe(false);
    }
  });

  it('fora das janelas, ja avisada ou com o fiscal refeito depois (sinal desligado): nao avisa', async (ctx) => {
    if (!pronto) return ctx.skip();
    for (const nota of ['8008', '9009', '10101']) expect(emailsDe(nota)).toHaveLength(0);
    expect((await estado(NF.foraDaJanelaB))[0]!.avisado).toBe(false);
    expect(await estado(NF.refeita)).toEqual([
      expect.objectContaining({ status: 'revertido', avisado: false }),
      expect.objectContaining({ status: 'concluido', avisado: false }),
    ]);
  });

  it('o espelho da ACXE e varrido com a empresa da ACXE (so quando existe)', async (ctx) => {
    if (!pronto || !temAcxe) return ctx.skip();
    expect(await estado(NF.acxe)).toEqual([expect.objectContaining({ status: 'revertido', avisado: true })]);
    expect(emailsDe('12012')[0]!.subject).toBe('Recebimento fiscal desfeito no OMIE da ACXE — NF 12012 (ZARAPLAST S/A)');
  });

  it('segunda rodada: nada a marcar, nada a avisar (o aviso gravado e a marcacao sao definitivos)', async (ctx) => {
    if (!pronto) return ctx.skip();
    const antes = enviados.length;
    expect(await varrer()).toEqual({ marcados: 0, avisados: 0, falhas: 0 });
    expect(enviados).toHaveLength(antes);
  });
});
