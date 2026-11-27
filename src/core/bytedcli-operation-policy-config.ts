import {
  BYTEDCLI_AUDITED_RELEASE, BYTEDCLI_OPERATION_CATALOG_VERSION, BYTEDCLI_OPERATION_CATALOG,
} from './bytedcli-operation-catalog.js';

export const BYTEDCLI_OPERATION_POLICY_SCHEMA = 'botmux.bytedcli-operation-policy.v2' as const;
export type BytedcliOperationRule = 'machine' | 'actor' | 'deny';
export interface BytedcliOperationPolicy {
  readonly schema: typeof BYTEDCLI_OPERATION_POLICY_SCHEMA;
  readonly cliVersion: typeof BYTEDCLI_AUDITED_RELEASE;
  readonly catalogVersion: typeof BYTEDCLI_OPERATION_CATALOG_VERSION;
  readonly rules: Readonly<Record<string, BytedcliOperationRule>>;
}
export class BytedcliOperationPolicyConfigError extends Error {
  constructor() {
    super('Invalid bytedcli operation policy: use audited versions, business IDs and permitted rules');
    this.name = 'BytedcliOperationPolicyConfigError';
  }
}
function invalid(): never { throw new BytedcliOperationPolicyConfigError(); }
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) invalid();
  if (Reflect.ownKeys(raw).some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    return typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
  })) invalid();
  return raw as Record<string, unknown>;
}
const parsedPolicies = new WeakSet<object>();
/** Only parser-issued immutable policies prove explicit host-selected authority. */
export function isParsedBytedcliOperationPolicy(policy: unknown): policy is BytedcliOperationPolicy {
  return !!policy && typeof policy === 'object' && parsedPolicies.has(policy);
}
const businessOperations = new Map(BYTEDCLI_OPERATION_CATALOG
  .filter(entry => entry.effect === 'read' || entry.effect === 'write').map(entry => [entry.id, entry]));
// Historical migration authority must not grow when a future catalog appends
// entries. These are precisely the business IDs/effects reviewed in .26.1.
const legacyEffects: Readonly<Record<string, 'read' | 'write'>> = Object.freeze({
  'codebase.repo.get': 'read', 'codebase.repo.list': 'read', 'codebase.mr.get': 'read', 'codebase.mr.list': 'read',
  'codebase.mr.count': 'read', 'codebase.mr.diff': 'read', 'codebase.mr.files': 'read', 'codebase.mr.status': 'read',
  'codebase.mr.create': 'write', 'codebase.mr.update': 'write', 'codebase.mr.close': 'write', 'codebase.mr.reopen': 'write',
  'bits.develop.list': 'read', 'log.search-log-matchers': 'read',
});

const previousIds = new Set([...Object.keys(legacyEffects),
  'api-test.rpc-call.picko-troubleshoot',
  'api-test.rpc-call.picko-troubleshoot-ticket',
  'api-test.rpc-call.picko-size',
  'api-test.rpc-call.picko-size-ticket',
  'api-test.rpc-call.picko-is-online',
  'api-test.rpc-call.picko-is-online-ticket',
  'api-test.rpc-call.picko-export-pids',
  'api-test.rpc-call.picko-export-pids-ticket',
  'api-test.rpc-call.picko-user-email',
  'api-test.rpc-call.picko-user-email-ticket',
  'api-test.rpc-call.assign-info',
  'api-test.rpc-call.assign-info-ticket',
  'api-test.http-call.picko-tag-enum',
  'tcc.config.get.picko-rules',
  'rds.db.query',
  'cache.execute-command.picko-hget',
  'bam.method.get',
  'tce.service.get',
  'tce.service.search',
  'scm.repo.search',
  'log.get-logid-log',
  'log.search-psm-log',
  'iam.permission.apply.check-only',
  'iam.permission.apply.submit',
  'slardar.web.chat.check-auth',
  'slardar.web.chat.get',
  'slardar.web.chat.send',
  'libra.layer.get',
  'libra.experiment.list',
  'libra.experiment.get-batch',
  'tos.upload-object.c4-report',
  'bits.release.search',
  'bits.pipeline',
  'bits.develop.get',
  'bits.pipelines.vars',
  'bits.pipelines.run',
  'slardar.web.analyze-url',
  'slardar.web.data.list.mix-profile',
  'bits.anywhere.share.get',
  'codebase.repo.file']);

/** Optional Bot config may be absent/null. A present host file must additionally require an object. */
export function parseBytedcliOperationPolicy(raw: unknown): BytedcliOperationPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  const rec = record(raw);
  const keys = ['schema', 'cliVersion', 'catalogVersion', 'rules'];
  if (Object.keys(rec).length !== keys.length || keys.some(key => !Object.hasOwn(rec, key))
    || ![BYTEDCLI_OPERATION_POLICY_SCHEMA, 'botmux.bytedcli-operation-policy.v1'].includes(rec.schema as string) || rec.cliVersion !== BYTEDCLI_AUDITED_RELEASE
    || ![BYTEDCLI_OPERATION_CATALOG_VERSION, '2026-11-27.1', '2026-11-26.1'].includes(rec.catalogVersion as string)) invalid();
  if (rec.schema === 'botmux.bytedcli-operation-policy.v1' && rec.catalogVersion !== '2026-11-26.1') invalid();
  const rawRules = record(rec.rules);
  const operationIds = Object.keys(rawRules).sort();
  if (operationIds.length > businessOperations.size) invalid();
  const rules: Record<string, BytedcliOperationRule> = {};
  for (const operationId of operationIds) {
    const operation = businessOperations.get(operationId);
    const rule = rawRules[operationId];
    if ((rec.catalogVersion === '2026-11-27.1' && !previousIds.has(operationId))
      || (rec.catalogVersion === '2026-11-26.1' && !Object.hasOwn(legacyEffects, operationId))
      || !operation || typeof rule !== 'string' || !['machine', 'actor', 'deny'].includes(rule)
      || (rec.schema === 'botmux.bytedcli-operation-policy.v1' && legacyEffects[operationId] === 'write' && rule === 'machine')) invalid();
    rules[operationId] = rule as BytedcliOperationRule;
  }
  const policy = Object.freeze({ schema: BYTEDCLI_OPERATION_POLICY_SCHEMA, cliVersion: BYTEDCLI_AUDITED_RELEASE,
    catalogVersion: BYTEDCLI_OPERATION_CATALOG_VERSION, rules: Object.freeze(rules) });
  parsedPolicies.add(policy);
  return policy;
}

/** Explicit deny > actor > machine. Audited defaults apply only without identity rules. */
export function resolveBytedcliOperationRule(
  operationId: string, globalPolicy?: BytedcliOperationPolicy, botPolicy?: BytedcliOperationPolicy,
): { readonly operationId: string; readonly effect: 'read' | 'write' | 'unknown'; readonly enabled: boolean; readonly identity: 'machine' | 'actor' } {
  if (/^unknown\.[a-f0-9]{64}$/.test(operationId)) return Object.freeze({ operationId, effect: 'unknown', enabled: true, identity: 'actor' });
  const operation = businessOperations.get(operationId);
  if (!operation || (operation.effect !== 'read' && operation.effect !== 'write')) invalid();
  const globalRule = globalPolicy?.rules[operationId];
  const botRule = botPolicy?.rules[operationId];
  return Object.freeze({ operationId, effect: operation.effect, enabled: globalRule !== 'deny' && botRule !== 'deny',
    identity: globalRule === 'actor' || botRule === 'actor' ? 'actor'
      : globalRule === 'machine' || botRule === 'machine' ? 'machine'
      : operation.effect === 'read' ? 'machine' : 'actor' });
}

export const BYTEDCLI_OPERATION_POLICY_STATUS_SCHEMA = 'botmux.bytedcli-operation-policy-status.v2' as const;
export interface BytedcliOperationPolicyStatus {
  readonly schema: typeof BYTEDCLI_OPERATION_POLICY_STATUS_SCHEMA;
  readonly cliVersion: typeof BYTEDCLI_AUDITED_RELEASE;
  readonly catalogVersion: typeof BYTEDCLI_OPERATION_CATALOG_VERSION;
  readonly active: boolean;
  readonly global: {
    readonly state: 'default' | 'valid' | 'invalid';
    readonly revision: string;
    readonly rules?: Readonly<Record<string, BytedcliOperationRule>>;
    readonly errorCode?: 'operation_policy_invalid';
  };
  readonly botRules: Readonly<Record<string, BytedcliOperationRule>>;
  readonly effectiveEntries: readonly ReturnType<typeof resolveBytedcliOperationRule>[];
}
/** Credential-free projection. The host supplies its frozen reader; browser
 * consumers compose the same audited resolver with their current Bot edits. */
export function projectBytedcliOperationPolicyStatus(
  snapshot: { readonly revision: string; readonly policy?: BytedcliOperationPolicy; readonly errorCode?: 'operation_policy_invalid' },
  botPolicy: BytedcliOperationPolicy | undefined, active: boolean,
): BytedcliOperationPolicyStatus {
  const invalid = snapshot.errorCode === 'operation_policy_invalid';
  return Object.freeze({ schema: BYTEDCLI_OPERATION_POLICY_STATUS_SCHEMA, cliVersion: BYTEDCLI_AUDITED_RELEASE,
    catalogVersion: BYTEDCLI_OPERATION_CATALOG_VERSION, active,
    global: Object.freeze(invalid ? { state: 'invalid' as const, revision: snapshot.revision, errorCode: 'operation_policy_invalid' as const }
      : { state: snapshot.policy ? 'valid' as const : 'default' as const, revision: snapshot.revision, rules: snapshot.policy?.rules ?? Object.freeze({}) }),
    botRules: botPolicy?.rules ?? Object.freeze({}),
    effectiveEntries: Object.freeze(invalid ? [] : BYTEDCLI_OPERATION_CATALOG
      .filter(row => row.effect === 'read' || row.effect === 'write')
      .map(row => resolveBytedcliOperationRule(row.id, snapshot.policy, botPolicy))),
  });
}
