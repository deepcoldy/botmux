import { BYTEDCLI_EXEC_SCHEMA, type BytedcliExecResponse } from '../cli/bytedcli-exec-protocol.js';
import { BYTEDCLI_AUDITED_RELEASE, BYTEDCLI_OPERATION_CATALOG, BYTEDCLI_OPERATION_CATALOG_VERSION } from './bytedcli-operation-policy.js';
import { BytedcliBrokerError } from './bytedcli-broker-process.js';
import type { BytedcliLeaseResolver } from './bytedcli-broker-credentials.js';
import type { BytedcliExecutionRequest } from './bytedcli-executor.js';
import type { BytedcliFrozenOperationPolicy } from './bytedcli-host-operation-policy.js';
import { resolveBytedcliOperationRule } from './bytedcli-operation-policy-config.js';

/** Credential-free effective catalog; trusted status callers can reuse it. */
export function projectBytedcliSafeCatalog(policy?: BytedcliFrozenOperationPolicy) {
  return Object.freeze(BYTEDCLI_OPERATION_CATALOG.map(entry => {
    if (entry.effect !== 'read' && entry.effect !== 'write') return entry;
    const rule = resolveBytedcliOperationRule(entry.id, policy?.globalPolicy, policy?.botPolicy);
    return Object.freeze({ ...entry, enabled: rule.enabled, executionIdentity: rule.identity });
  }));
}

/** Host projection only. Never execute SDK help/device flows or serialize a
 * provider envelope. Personal control stays with the existing private flow. */
export async function runBytedcliSafeCommand(
  request: BytedcliExecutionRequest,
  personalLeases?: () => Promise<BytedcliLeaseResolver>,
): Promise<BytedcliExecResponse> {
  const { operation, authority } = request;
  const signal = request.signal ?? new AbortController().signal;
  const check = async () => {
    if (signal.aborted) throw new BytedcliBrokerError('cancelled');
    const error = await authority.recheck();
    if (error) throw new BytedcliBrokerError(error);
    if (signal.aborted) throw new BytedcliBrokerError('cancelled');
  };
  const response = (data: unknown, controlRequired = false): BytedcliExecResponse => ({
    schema: BYTEDCLI_EXEC_SCHEMA, requestId: request.requestId, operationId: operation.id,
    effectiveIdentity: { kind: operation.effect === 'auth' ? 'actor' : 'none' },
    outcome: controlRequired ? 'rejected' : 'completed', exitCode: controlRequired ? 77 : 0,
    stdoutBase64: Buffer.from(JSON.stringify(data) + '\n').toString('base64'), stderrBase64: '',
    ...(controlRequired ? { errorCode: 'personal_auth_control_required' as const } : {}),
  });
  await check();
  if (operation.effect === 'help') {
    const prefix = operation.id.slice('help.'.length);
    const projected = projectBytedcliSafeCatalog(authority.operationPolicy);
    const catalog = prefix === 'root' ? projected
      : projected.filter(entry => entry.id === prefix || entry.id.startsWith(prefix + '.'));
    return response({ auditedCliVersion: BYTEDCLI_AUDITED_RELEASE, catalogVersion: BYTEDCLI_OPERATION_CATALOG_VERSION,
      versionScope: 'audited-contract-not-installed-version',
      ...(prefix === 'version' ? {} : { catalog, restrictions: ['cn-only', 'noninteractive', 'explicit-repository',
        'unknown-commands-and-options-refused', 'personal-auth-control-required', 'fresh-linux-isolation-required'] }) });
  }
  if (operation.effect !== 'auth') throw new BytedcliBrokerError('unsupported_operation');
  const actor = authority.actor;
  if (!actor) throw new BytedcliBrokerError('actor_required');
  const action = operation.id.slice('auth.'.length);
  if (action === 'login' || action === 'logout') {
    // /logout ignores its suffix and revokes Lark, ByteCloud and Meego together.
    // It must never be advertised as a scoped ByteCloud logout operation.
    return response({ state: 'personal-control-required', identity: 'actor', action, performed: false,
      ...(action === 'login' ? { personalCommand: '/login bytedcli' } : { reason: 'scoped-logout-unavailable' }) }, true);
  }
  if (!['status', 'userinfo'].includes(action) || !personalLeases) throw new BytedcliBrokerError('unsupported_operation');
  try {
    const leases = await personalLeases();
    await check();
    // Reuse the exact official account match, source selection, local queue and
    // epoch fences from actor business execution. No machine lease is possible.
    const lease = await leases.actor({ region: 'cn', actor, recheck: authority.recheck, signal,
      botAppId: authority.botAppId, sessionId: authority.sessionId, identityTurnId: authority.identityTurnId ?? authority.turnId });
    await check();
    const stale = await lease.stillCurrent(signal);
    if (stale) throw new BytedcliBrokerError(stale);
    await check();
    if (lease.kind !== 'actor' || !['local', 'platform'].includes(lease.source)) throw new BytedcliBrokerError('actor_identity_unverified');
    return response({ state: 'authorized', identity: 'actor', source: lease.source,
      ...(action === 'userinfo' ? { email: actor.verifiedEmail } : {}) });
  } catch (error) {
    await check();
    if (error instanceof BytedcliBrokerError && error.code === 'actor_auth_required') {
      return response({ state: 'needs-login', identity: 'actor', source: actor.source, personalCommand: '/login bytedcli' });
    }
    throw error;
  }
}
