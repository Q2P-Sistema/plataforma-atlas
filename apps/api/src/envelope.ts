/**
 * Re-export do envelope canônico, agora em @atlas/core (MOD-17, ACXEGDP-269/298)
 * — módulos não podem importar de apps/*, então a fonte mudou de lugar; este
 * arquivo permanece para não quebrar os imports existentes do apps/api.
 */
export { sendSuccess, sendError, type ApiResponse, type ApiError } from '@atlas/core';
