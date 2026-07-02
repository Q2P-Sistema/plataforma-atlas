import { describe, it, expect, beforeAll } from 'vitest';

// buildEmailLayout/escapeHtml/buildPasswordResetEmail sao puros, mas o barrel
// @atlas/core carrega config no import. Setamos env e usamos import dinamico
// dentro dos testes (roda depois do beforeAll) para o loadConfig nao falhar.
beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.SESSION_SECRET ??= 'test-secret-1234567890';
});

describe('email-layout (@atlas/core)', () => {
  it('escapeHtml neutraliza caracteres perigosos (EML-07)', async () => {
    const { escapeHtml } = await import('@atlas/core');
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;',
    );
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });

  it('buildEmailLayout escapa titulo/CTA e gera versao text/plain (EML-06/15)', async () => {
    const { buildEmailLayout } = await import('@atlas/core');
    const { html, text } = buildEmailLayout({
      titulo: 'Divergência & Ação',
      corpoHtml: '<p>Olá, operador</p>',
      ctaLabel: 'Abrir aprovações',
      ctaUrl: 'https://atlas.local/x?a=1&b=2',
    });
    expect(html).toContain('Divergência &amp; Ação'); // titulo escapado
    expect(html).toContain('a=1&amp;b=2'); // url do CTA escapada
    expect(html).toContain('>Abrir aprovações<'); // rotulo do CTA
    expect(html).toContain('lang="pt-BR"');
    expect(html).toContain('Plataforma Atlas');
    // versao texto decodifica entidades e traz o link do CTA
    expect(text).toContain('Divergência & Ação');
    expect(text).toContain('Abrir aprovações: https://atlas.local/x?a=1&b=2');
  });

  it('buildPasswordResetEmail usa acentuacao pt-BR correta e inclui o link (EML-01)', async () => {
    const { buildPasswordResetEmail } = await import('@atlas/core');
    const url = 'https://atlas.local/reset-password/tok123';
    const { subject, html, text } = buildPasswordResetEmail(url);
    expect(subject).toBe('Atlas — Recuperação de senha');
    // as formas sem acento nao devem mais aparecer
    expect(html).not.toMatch(/Voce|recuperacao|nao solicitou/);
    expect(html).toContain('Você solicitou a recuperação');
    expect(html).toContain(url);
    expect(text).toContain(url);
  });
});
