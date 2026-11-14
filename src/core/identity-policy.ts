import {
  capabilitiesOf,
  type TriggerUserAuthCapability,
  type TriggerUserAuthConfig,
  type TriggerUserAuthCredentialSource,
  type IdentityRouteTool,
} from '../services/trigger-user-auth.js';

export interface IdentityPolicy {
  /** Capabilities that run as the message sender; empty while the policy is off. */
  capabilities: ReadonlySet<TriggerUserAuthCapability>;
  credentialSource: TriggerUserAuthCredentialSource;
}

export function policyFromConfig(
  config: Pick<TriggerUserAuthConfig, 'enabled' | 'tools' | 'capabilities' | 'credentialSource'> | null | undefined,
): IdentityPolicy {
  return { capabilities: capabilitiesOf(config), credentialSource: config?.credentialSource ?? 'auto' };
}

/** The capability whose switch governs a published tool's identity. Meego is
 *  published through bytedcli but is its own switch (see publishMeegoOnly). */
export function capabilityOfTool(tool: IdentityRouteTool): TriggerUserAuthCapability {
  return tool === 'lark-cli' ? 'lark-user' : 'bytecloud';
}

export interface Availability {
  platformBound: boolean;
  platformGrant: boolean | 'unavailable';
  localLogin: boolean;
}

export type IdentityDecision =
  | { kind: 'person'; source: 'platform' | 'local' }
  | { kind: 'needs-auth'; entry: 'platform-page' | 'private-link' };

/**
 * Which credentials a switched-on capability uses for a known person, from the
 * credential-source matrix (docs/lark-tool-identity.md). Whether the capability
 * is on and whether there is a person at all is decided before this is asked
 * (publishToolIdentity).
 */
export function resolveIdentity(source: TriggerUserAuthCredentialSource, availability: Availability): IdentityDecision {
  const { platformBound, platformGrant, localLogin } = availability;
  if (source !== 'local' && platformBound && platformGrant === true) return { kind: 'person', source: 'platform' };
  if ((source === 'local' || (source === 'auto' && !platformBound)) && localLogin) return { kind: 'person', source: 'local' };
  return { kind: 'needs-auth', entry: platformBound || source === 'platform' ? 'platform-page' : 'private-link' };
}
