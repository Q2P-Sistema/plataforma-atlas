import { describe, it, expect, beforeAll } from 'vitest';

// escapeHtml/buildPasswordResetEmail sao puros, mas o barrel
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

  it('buildPasswordResetEmail no padrão da ACXEGDP-440: assunto, link, prazo e acentuação (EML-01)', async () => {
    const { buildPasswordResetEmail } = await import('@atlas/core');
    const url = 'https://atlas.local/reset-password/tok123';
    const { subject, html, text } = buildPasswordResetEmail(url);
    expect(subject).toBe('[AÇÃO REQUERIDA] - Acesso - Redefinir a senha - Atlas');
    // as formas sem acento nao devem mais aparecer
    expect(html).not.toMatch(/Voce|recuperacao|redefinicao|nao pediu/);
    expect(html).toContain(`<title>${subject}</title>`);
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain('O link vale por 1 hora e só pode ser usado uma vez.');
    expect(text).toContain(`Redefinir senha: ${url}`);
  });
});
