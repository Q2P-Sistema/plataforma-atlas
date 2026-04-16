import { requireRole } from '@atlas/auth';

/**
 * Wrappers convenientes para os 3 perfis do StockBridge.
 * Cada perfil herda acesso dos niveis superiores (operador < gestor < diretor).
 */

export const requireOperador = requireRole('operador', 'gestor', 'diretor');
export const requireGestor = requireRole('gestor', 'diretor');
export const requireDiretor = requireRole('diretor');
