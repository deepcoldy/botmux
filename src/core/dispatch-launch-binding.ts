import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import type { CodexReasoningEffort } from '../services/codex-reasoning-effort.js';
import type { Session } from '../types.js';
import {
  dispatchLaunchPolicyDigest,
  effectiveOverrideSchema,
  requestedOverrideSchema,
  type DispatchLaunchPolicyV1,
} from './dispatch-launch-contract.js';

export interface DispatchLaunchSelection {
  requested: { model?: string; reasoningEffort?: CodexReasoningEffort };
  effective: { model: string; reasoningEffort?: CodexReasoningEffort };
}

export interface DispatchLaunchBinding extends DispatchLaunchSelection {
  version: 1;
  targetLarkAppId: string;
  chatId: string;
  rootMessageId: string;
  createdAt: string;
  expiresAt: string;
  sessionId?: string;
  /** Frozen digest of the target policy that authorised this binding. */
  policyDigest?: string;
}

type BindingFile = { version: 1; bindings: Record<string, DispatchLaunchBinding> };

export function dispatchLaunchBindingsPath(dataDir: string): string {
  return join(dataDir, 'dispatch-launch-bindings.json');
}

function key(input: Pick<DispatchLaunchBinding, 'targetLarkAppId' | 'chatId' | 'rootMessageId'>): string {
  return `${input.targetLarkAppId}\0${input.chatId}\0${input.rootMessageId}`;
}

function read(path: string): BindingFile {
  if (!existsSync(path)) return { version: 1, bindings: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BindingFile>;
  if (parsed.version !== 1 || !parsed.bindings || typeof parsed.bindings !== 'object') {
    throw new Error('invalid dispatch launch binding store');
  }
  return parsed as BindingFile;
}

function write(path: string, value: BindingFile): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

/** Register once; an exact replay is a no-op and a changed tuple fails closed.
 *  The `requested` / `effective` fields are schema-parsed at the boundary so a
 *  malformed enum, extra key or missing model can never reach the on-disk store
 *  (nor, via applyDispatchLaunchBinding, the codex argv). */
export function registerDispatchLaunchBinding(
  dataDir: string,
  binding: DispatchLaunchBinding,
): DispatchLaunchBinding {
  const validated: DispatchLaunchBinding = {
    ...binding,
    requested: requestedOverrideSchema.parse(binding.requested),
    effective: effectiveOverrideSchema.parse(binding.effective),
  };
  const path = dispatchLaunchBindingsPath(dataDir);
  return withFileLockSync(path, () => {
    const file = read(path);
    const bindingKey = key(validated);
    const existing = file.bindings[bindingKey];
    if (existing) {
      const same = JSON.stringify(existing.requested) === JSON.stringify(validated.requested)
        && JSON.stringify(existing.effective) === JSON.stringify(validated.effective);
      if (!same) throw new Error('dispatch launch binding conflicts with an existing launch spec');
      return existing;
    }
    file.bindings[bindingKey] = validated;
    write(path, file);
    return validated;
  });
}

/** Claim without deleting: duplicate Lark deliveries resolve to the same session/spec. */
export function bindDispatchLaunchToSession(
  dataDir: string,
  input: Pick<DispatchLaunchBinding, 'targetLarkAppId' | 'chatId' | 'rootMessageId'> & { sessionId: string },
): DispatchLaunchBinding | null {
  const path = dispatchLaunchBindingsPath(dataDir);
  return withFileLockSync(path, () => {
    const file = read(path);
    const binding = file.bindings[key(input)];
    if (!binding) return null;
    if (!Number.isFinite(Date.parse(binding.expiresAt)) || Date.parse(binding.expiresAt) < Date.now()) return null;
    if (binding.sessionId && binding.sessionId !== input.sessionId) {
      throw new Error('dispatch launch binding is already owned by another session');
    }
    if (!binding.sessionId) {
      binding.sessionId = input.sessionId;
      write(path, file);
    }
    return binding;
  });
}

export function applyDispatchLaunchBinding(
  dataDir: string,
  session: Session,
  targetLarkAppId: string,
  targetPolicy?: DispatchLaunchPolicyV1,
): DispatchLaunchBinding | null {
  const binding = bindDispatchLaunchToSession(dataDir, {
    targetLarkAppId,
    chatId: session.chatId,
    rootMessageId: session.rootMessageId,
    sessionId: session.sessionId,
  });
  if (!binding) return null;
  // Digest comparison is the target-side fail-closed gate promised by the PR
  // contract ("target end is authoritative"): the source stamps the policy
  // digest at register time, and if the target policy has drifted since then
  // (rotated allow-lists, disabled, or removed entirely) we refuse to activate
  // the binding — mirrors the direct-IPC coordinator's POLICY_CHANGED behaviour.
  const expected = binding.policyDigest;
  const current = targetPolicy ? dispatchLaunchPolicyDigest(targetPolicy) : undefined;
  if (expected !== undefined && expected !== current) {
    logger.warn(
      `[dispatch-launch] binding policy mismatch target=${binding.targetLarkAppId} `
      + `chat=${binding.chatId} root=${binding.rootMessageId} session=${session.sessionId} `
      + `reason=${current === undefined ? 'policy_missing' : 'policy_digest_mismatch'} `
      + `expected=${expected} current=${current ?? 'missing'}`,
    );
    return null;
  }
  session.dispatchLaunchSpec = {
    version: 1,
    targetLarkAppId: binding.targetLarkAppId,
    chatId: binding.chatId,
    rootMessageId: binding.rootMessageId,
    requested: binding.requested,
    effective: binding.effective,
    createdAt: binding.createdAt,
    expiresAt: binding.expiresAt,
  };
  session.reasoningEffort = binding.effective.reasoningEffort;
  return binding;
}
