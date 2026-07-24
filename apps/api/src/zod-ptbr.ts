import { z, type ZodErrorMap, ZodIssueCode, ZodParsedType } from 'zod';

/**
 * Mapa de erros Zod em pt-BR (PTB-1, ACXEGDP-256).
 *
 * Um único setErrorMap no bootstrap cobre TODAS as rotas de todos os módulos
 * (as mensagens padrão do Zod são em inglês e vazavam nos payloads de
 * INVALID_INPUT/INVALID_QUERY exibidos ao usuário). Mapa mínimo hand-rolled
 * para os issue codes que aparecem nos schemas do projeto; casos não mapeados
 * caem na mensagem default do Zod (ctx.defaultError).
 *
 * Nota: aplica-se ao runtime do app — suítes de teste dos módulos que rodam
 * fora deste bootstrap continuam vendo as mensagens default.
 */
const TIPOS_PTBR: Partial<Record<ZodParsedType, string>> = {
  string: 'texto',
  number: 'número',
  boolean: 'booleano',
  date: 'data',
  array: 'lista',
  object: 'objeto',
  undefined: 'vazio',
  null: 'nulo',
};

function nomeTipo(t: ZodParsedType): string {
  return TIPOS_PTBR[t] ?? t;
}

export const zodErrorMapPtBr: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        return { message: 'Campo obrigatório' };
      }
      return {
        message: `Esperado ${nomeTipo(issue.expected as ZodParsedType)}, recebido ${nomeTipo(issue.received as ZodParsedType)}`,
      };
    case ZodIssueCode.invalid_enum_value:
      return {
        message: `Valor inválido. Opções: ${issue.options.map((o) => `'${String(o)}'`).join(', ')}`,
      };
    case ZodIssueCode.too_small:
      if (issue.type === 'string') {
        return {
          message:
            Number(issue.minimum) <= 1
              ? 'Campo obrigatório'
              : `Deve ter pelo menos ${issue.minimum} caracteres`,
        };
      }
      if (issue.type === 'number') {
        return {
          message: issue.inclusive
            ? `Deve ser maior ou igual a ${issue.minimum}`
            : `Deve ser maior que ${issue.minimum}`,
        };
      }
      if (issue.type === 'array') {
        return { message: `Deve ter pelo menos ${issue.minimum} item(ns)` };
      }
      break;
    case ZodIssueCode.too_big:
      if (issue.type === 'string') {
        return { message: `Deve ter no máximo ${issue.maximum} caracteres` };
      }
      if (issue.type === 'number') {
        return {
          message: issue.inclusive
            ? `Deve ser menor ou igual a ${issue.maximum}`
            : `Deve ser menor que ${issue.maximum}`,
        };
      }
      if (issue.type === 'array') {
        return { message: `Deve ter no máximo ${issue.maximum} item(ns)` };
      }
      break;
    case ZodIssueCode.invalid_string:
      if (issue.validation === 'email') return { message: 'E-mail inválido' };
      if (issue.validation === 'uuid') return { message: 'Identificador (UUID) inválido' };
      if (issue.validation === 'url') return { message: 'URL inválida' };
      if (issue.validation === 'regex') return { message: 'Formato inválido' };
      break;
    case ZodIssueCode.invalid_date:
      return { message: 'Data inválida' };
    case ZodIssueCode.unrecognized_keys:
      return { message: `Campo(s) não reconhecido(s): ${issue.keys.join(', ')}` };
    default:
      break;
  }
  return { message: ctx.defaultError };
};

/** Ativa o mapa pt-BR globalmente (chamar uma vez, no bootstrap). */
export function ativarZodPtBr(): void {
  z.setErrorMap(zodErrorMapPtBr);
}
