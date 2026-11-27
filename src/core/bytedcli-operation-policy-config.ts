import {
  BYTEDCLI_AUDITED_RELEASE, BYTEDCLI_OPERATION_CATALOG_VERSION, BYTEDCLI_OPERATION_CATALOG,
} from './bytedcli-operation-catalog.js';

export const BYTEDCLI_OPERATION_POLICY_SCHEMA = 'botmux.bytedcli-operation-policy.v1' as const;
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
const businessOperations = new Map(BYTEDCLI_OPERATION_CATALOG
  .filter(entry => entry.effect === 'read' || entry.effect === 'write').map(entry => [entry.id, entry]));

/** Optional Bot config may be absent/null. A present host file must additionally require an object. */
export function parseBytedcliOperationPolicy(raw: unknown): BytedcliOperationPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  const rec = record(raw);
  const keys = ['schema', 'cliVersion', 'catalogVersion', 'rules'];
  if (Object.keys(rec).length !== keys.length || keys.some(key => !Object.hasOwn(rec, key))
    || rec.schema !== BYTEDCLI_OPERATION_POLICY_SCHEMA || rec.cliVersion !== BYTEDCLI_AUDITED_RELEASE
    || rec.catalogVersion !== BYTEDCLI_OPERATION_CATALOG_VERSION) invalid();
  const rawRules = record(rec.rules);
  const operationIds = Object.keys(rawRules).sort();
  if (operationIds.length > 64) invalid();
  const rules: Record<string, BytedcliOperationRule> = {};
  for (const operationId of operationIds) {
    const operation = businessOperations.get(operationId);
    const rule = rawRules[operationId];
    if (!operation || typeof rule !== 'string' || !['machine', 'actor', 'deny'].includes(rule)
      || (operation.effect === 'write' && rule === 'machine')) invalid();
    rules[operationId] = rule as BytedcliOperationRule;
  }
  return Object.freeze({ schema: BYTEDCLI_OPERATION_POLICY_SCHEMA, cliVersion: BYTEDCLI_AUDITED_RELEASE,
    catalogVersion: BYTEDCLI_OPERATION_CATALOG_VERSION, rules: Object.freeze(rules) });
}

/** Deny > actor > machine. Neither a Bot nor the host can weaken the audited default. */
export function resolveBytedcliOperationRule(
  operationId: string, globalPolicy?: BytedcliOperationPolicy, botPolicy?: BytedcliOperationPolicy,
): { readonly operationId: string; readonly effect: 'read' | 'write'; readonly enabled: boolean; readonly identity: 'machine' | 'actor' } {
  const operation = businessOperations.get(operationId);
  if (!operation || (operation.effect !== 'read' && operation.effect !== 'write')) invalid();
  const globalRule = globalPolicy?.rules[operationId];
  const botRule = botPolicy?.rules[operationId];
  return Object.freeze({ operationId, effect: operation.effect, enabled: globalRule !== 'deny' && botRule !== 'deny',
    identity: operation.effect === 'write' || globalRule === 'actor' || botRule === 'actor' ? 'actor' : 'machine' });
}

export const BYTEDCLI_OPERATION_POLICY_STATUS_SCHEMA = 'botmux.bytedcli-operation-policy-status.v1' as const;
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
