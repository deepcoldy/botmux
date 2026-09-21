// Regression cover for the classic --repo dispatch binding path: schema-parse
// at register time keeps malformed shapes out of the store, and the
// target-policy digest gate is authoritative at apply time — a stale digest
// (target rotated allow-lists / disabled after register) refuses to activate.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applyDispatchLaunchBinding,
  registerDispatchLaunchBinding,
  type DispatchLaunchBinding,
} from '../src/core/dispatch-launch-binding.js';
import {
  dispatchLaunchPolicyDigest,
  evaluateDispatchLaunchPolicy,
  type DispatchLaunchPolicyV1,
} from '../src/core/dispatch-launch-contract.js';
import type { Session } from '../src/types.js';

const basePolicy: DispatchLaunchPolicyV1 = {
  schemaVersion: 1,
  enabled: true,
  allowedSourceAppIds: ['cli_source'],
  allowedModels: ['gpt-6-astra'],
  allowedReasoningEfforts: ['high'],
};

function goodBinding(overrides: Partial<DispatchLaunchBinding> = {}): DispatchLaunchBinding {
  return {
    version: 1,
    targetLarkAppId: 'cli_target',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    requested: { model: 'gpt-6-astra', reasoningEffort: 'high' },
    effective: { model: 'gpt-6-astra', reasoningEffort: 'high' },
    ...overrides,
  };
}

function session(): Session {
  return {
    sessionId: 's1',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    title: 't',
    status: 'active',
    createdAt: new Date().toISOString(),
    larkAppId: 'cli_target',
  };
}

describe('dispatch launch policy evaluation', () => {
  it('rejects an absent policy', () => {
    const result = evaluateDispatchLaunchPolicy({
      sourceLarkAppId: 'cli_source',
      effective: { model: 'gpt-6-astra', reasoningEffort: 'high' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('POLICY_DENIED');
  });

  it('rejects a disabled policy', () => {
    const result = evaluateDispatchLaunchPolicy({
      policy: { ...basePolicy, enabled: false },
      sourceLarkAppId: 'cli_source',
      effective: { model: 'gpt-6-astra', reasoningEffort: 'high' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('POLICY_DENIED');
  });

  it('rejects an unauthorized source app', () => {
    const result = evaluateDispatchLaunchPolicy({
      policy: basePolicy,
      sourceLarkAppId: 'cli_other',
      effective: { model: 'gpt-6-astra', reasoningEffort: 'high' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('UNAUTHORIZED_SOURCE');
  });

  it('rejects a model outside the allow-list', () => {
    const result = evaluateDispatchLaunchPolicy({
      policy: basePolicy,
      sourceLarkAppId: 'cli_source',
      effective: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('MODEL_UNSUPPORTED');
  });

  it('rejects a reasoning effort outside the allow-list', () => {
    const result = evaluateDispatchLaunchPolicy({
      policy: basePolicy,
      sourceLarkAppId: 'cli_source',
      effective: { model: 'gpt-6-astra', reasoningEffort: 'medium' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('REASONING_EFFORT_UNSUPPORTED');
  });

  it('accepts allow-listed source+model+effort and produces a stable digest', () => {
    const first = evaluateDispatchLaunchPolicy({
      policy: basePolicy,
      sourceLarkAppId: 'cli_source',
      effective: { model: 'gpt-6-astra', reasoningEffort: 'high' },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.policyDigest).toBe(dispatchLaunchPolicyDigest(basePolicy));
    // Adding an extra allowed model changes the canonical policy → digest drifts.
    const drifted: DispatchLaunchPolicyV1 = {
      ...basePolicy,
      allowedModels: [...basePolicy.allowedModels, 'gpt-5.6-sol'],
    };
    expect(dispatchLaunchPolicyDigest(drifted)).not.toBe(first.policyDigest);
  });
});

describe('registerDispatchLaunchBinding schema gate', () => {
  it('rejects an unknown reasoning effort at the boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-launch-'));
    expect(() => registerDispatchLaunchBinding(dir, goodBinding({
      effective: { model: 'gpt-6-astra', reasoningEffort: 'turbo' as unknown as 'high' },
    }))).toThrow();
  });

  it('rejects a missing model on the effective side', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-launch-'));
    expect(() => registerDispatchLaunchBinding(dir, goodBinding({
      effective: { model: '', reasoningEffort: 'high' } as { model: string; reasoningEffort: 'high' },
    }))).toThrow();
  });

  it('rejects an extra key smuggled onto the effective override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-launch-'));
    expect(() => registerDispatchLaunchBinding(dir, goodBinding({
      effective: {
        model: 'gpt-6-astra',
        reasoningEffort: 'high',
        extra: 'value',
      } as unknown as { model: string; reasoningEffort: 'high' },
    }))).toThrow();
  });
});

describe('applyDispatchLaunchBinding policy digest gate', () => {
  it('applies when the target policy digest matches the frozen one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-launch-'));
    registerDispatchLaunchBinding(dir, goodBinding({
      policyDigest: dispatchLaunchPolicyDigest(basePolicy),
    }));
    const s = session();
    const applied = applyDispatchLaunchBinding(dir, s, 'cli_target', basePolicy);
    expect(applied).not.toBeNull();
    expect(s.reasoningEffort).toBe('high');
    expect(s.dispatchLaunchSpec?.effective).toMatchObject({
      model: 'gpt-6-astra', reasoningEffort: 'high',
    });
  });

  it('refuses to apply when the target policy digest has drifted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-launch-'));
    registerDispatchLaunchBinding(dir, goodBinding({
      policyDigest: dispatchLaunchPolicyDigest(basePolicy),
    }));
    const drifted: DispatchLaunchPolicyV1 = {
      ...basePolicy,
      allowedModels: [...basePolicy.allowedModels, 'gpt-5.6-sol'],
    };
    expect(applyDispatchLaunchBinding(dir, session(), 'cli_target', drifted)).toBeNull();
  });

  it('refuses to apply when the target policy is gone entirely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-launch-'));
    registerDispatchLaunchBinding(dir, goodBinding({
      policyDigest: dispatchLaunchPolicyDigest(basePolicy),
    }));
    expect(applyDispatchLaunchBinding(dir, session(), 'cli_target', undefined)).toBeNull();
  });
});
