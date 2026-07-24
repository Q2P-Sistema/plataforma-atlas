import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { ativarZodPtBr } from '../zod-ptbr.js';

// PTB-1 (ACXEGDP-256): mensagens de validação Zod em pt-BR via setErrorMap
// global — cobre todas as rotas de todos os módulos sem editar cada schema.

beforeAll(() => ativarZodPtBr());

function primeiraMensagem(result: z.SafeParseReturnType<unknown, unknown>): string {
  if (result.success) throw new Error('esperava falha de validação');
  return result.error.issues[0]!.message;
}

describe('zodErrorMapPtBr', () => {
  it('campo ausente → "Campo obrigatório"', () => {
    const r = z.object({ nf: z.string() }).safeParse({});
    expect(primeiraMensagem(r)).toBe('Campo obrigatório');
  });

  it('tipo errado → mensagem pt-BR com tipos traduzidos', () => {
    const r = z.object({ qtd: z.number() }).safeParse({ qtd: 'abc' });
    expect(primeiraMensagem(r)).toBe('Esperado número, recebido texto');
  });

  it('enum inválido → lista as opções', () => {
    const r = z.enum(['acxe', 'q2p']).safeParse('xpto');
    expect(primeiraMensagem(r)).toBe("Valor inválido. Opções: 'acxe', 'q2p'");
  });

  it('string vazia com min(1) → "Campo obrigatório"', () => {
    const r = z.string().min(1).safeParse('');
    expect(primeiraMensagem(r)).toBe('Campo obrigatório');
  });

  it('número abaixo do mínimo → mensagem com o limite', () => {
    const r = z.number().positive().safeParse(-5);
    expect(primeiraMensagem(r)).toBe('Deve ser maior que 0');
  });

  it('string acima do máximo → mensagem com o limite', () => {
    const r = z.string().max(3).safeParse('abcd');
    expect(primeiraMensagem(r)).toBe('Deve ter no máximo 3 caracteres');
  });

  it('e-mail e uuid inválidos → mensagens específicas', () => {
    expect(primeiraMensagem(z.string().email().safeParse('x'))).toBe('E-mail inválido');
    expect(primeiraMensagem(z.string().uuid().safeParse('x'))).toBe('Identificador (UUID) inválido');
  });

  it('mensagem customizada no schema TEM precedência sobre o mapa', () => {
    const r = z.string().min(1, 'motivo é obrigatório').safeParse('');
    expect(primeiraMensagem(r)).toBe('motivo é obrigatório');
  });
});
