import { getBot } from '../bot-registry.js';
import { getTurnResultRuntime } from './turn-result-runtime.js';
import type { TurnResultLookup } from '../services/turn-result.js';

export function lookupTurnResultRequest(
  botId: string, sessionId: string, turnId: string, search: URLSearchParams,
): { httpStatus: number; body: TurnResultLookup } {
  const attempts = search.getAll('dispatchAttempt');
  if (!botId || !sessionId || !turnId || sessionId.length > 1024 || turnId.length > 1024
    || /[\0\r\n]/.test(sessionId + turnId) || attempts.length > 1
    || [...search.keys()].some(key => key !== 'dispatchAttempt')
    || (attempts.length === 1 && !/^(0|[1-9]\d*)$/.test(attempts[0]))) {
    return { httpStatus: 400, body: { status: 'unavailable', reason: 'invalid_reference' } };
  }
  const attempt = attempts.length ? Number(attempts[0]) : undefined;
  if (attempt !== undefined && !Number.isSafeInteger(attempt)) {
    return { httpStatus: 400, body: { status: 'unavailable', reason: 'invalid_reference' } };
  }
  const runtime = getTurnResultRuntime();
  let configuration;
  try { configuration = getBot(botId).config; } catch {
    return { httpStatus: 200, body: { status: 'not_found' } };
  }
  if (configuration.turnResults?.enabled !== true) {
    runtime?.clearBot(botId);
    return { httpStatus: 200, body: { status: 'unavailable', reason: 'disabled' } };
  }
  if (configuration.apiOnly || configuration.readIsolation) {
    runtime?.clearBot(botId);
    return { httpStatus: 200, body: { status: 'unavailable', reason: 'unsupported_mode' } };
  }
  return { httpStatus: 200, body: runtime?.read(botId, sessionId, turnId, attempt) ?? { status: 'not_found' } };
}
