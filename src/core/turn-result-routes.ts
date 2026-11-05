import { getBot } from '../bot-registry.js';
import { getTurnResultRuntime } from './turn-result-runtime.js';
import type { TurnResultLookup } from '../services/turn-result.js';
import type { ContractTurnResult } from '../services/persistent-turn-result-store.js';

export function lookupTurnResultRequest(
  botId: string, sessionId: string, turnId: string, search: URLSearchParams,
): { httpStatus: number; body: TurnResultLookup | { status: 'ready'; result: ContractTurnResult } } {
  const attempts = search.getAll('dispatchAttempt');
  if (!botId || !sessionId || !turnId || sessionId.length > 1024 || turnId.length > 1024
    || /[\0\r\n]/.test(sessionId + turnId) || attempts.length > 1
    || [...search.keys()].some(key => key !== 'dispatchAttempt' && key !== 'resultVersion')
    || search.getAll('resultVersion').length > 1 || (search.has('resultVersion') && search.get('resultVersion') !== '2')
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
  if ((configuration.apiOnly && search.get('resultVersion') !== '2') || configuration.readIsolation) {
    runtime?.clearBot(botId);
    return { httpStatus: 200, body: { status: 'unavailable', reason: 'unsupported_mode' } };
  }
  if (search.get('resultVersion') === '2') {
    const result = runtime?.readContract(botId, sessionId, turnId, attempt);
    return { httpStatus: 200, body: result ? { status: 'ready', result } : { status: 'not_found' } };
  }
  return { httpStatus: 200, body: runtime?.read(botId, sessionId, turnId, attempt) ?? { status: 'not_found' } };
}
