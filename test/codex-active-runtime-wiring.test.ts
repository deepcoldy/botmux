import { describe, expect, it } from 'vitest';
import { withCardRuntimeIdentity } from '../src/core/card-runtime-identity.js';
import type { DaemonSession } from '../src/core/types.js';

/**
 * Card runtime identity (PR #780 review point ⑤): `snapshot.tokens.model` is
 * the RAW transcript model and, for relay-style CLIs, an internal routing code
 * (ark/relay-code) that must never surface on a user card. The card model comes
 * only from the wired active runtime or the user-configured launch model.
 */
function session(extra: Partial<DaemonSession> = {}, model?: string): DaemonSession {
  return {
    larkAppId: 'cli_runtime_identity',
    session: { sessionId: 'runtime-identity', cliId: 'codex', ...(model ? { model } : {}) },
    ...extra,
  } as unknown as DaemonSession;
}

const rawSnapshot = {
  context: null,
  tokens: { in: 10, out: 2, model: 'ark-relay-code-123' },
} as never;

describe('card runtime identity', () => {
  it('never surfaces the raw transcript model when no runtime is known', () => {
    const card = withCardRuntimeIdentity(session(), rawSnapshot, 'codex');
    expect(card.model).toBeUndefined();
  });

  it('prefers the live active runtime, then the configured launch model', () => {
    expect(withCardRuntimeIdentity(
      session({ activeModel: 'gpt-5.5', activeReasoningEffort: 'high' }, 'configured-model'),
      rawSnapshot,
      'codex',
    )).toMatchObject({ model: 'gpt-5.5', reasoningEffort: 'high' });
    expect(withCardRuntimeIdentity(session({}, 'configured-model'), rawSnapshot, 'codex').model)
      .toBe('configured-model');
  });
  it('shows the current Auto context variant and clears the previous variant on native defaults', () => {
    const subject = session({ activeModel: 'gpt-6-astra', activeModelBackendVariant: 'max' });
    subject.session.modelBackendVariant = 'standard';
    expect(withCardRuntimeIdentity(subject, rawSnapshot, 'traex').modelBackendVariant).toBe('max');
    subject.activeModelBackendVariant = null;
    expect(withCardRuntimeIdentity(subject, { ...rawSnapshot, modelBackendVariant: 'max' }, 'traex').modelBackendVariant).toBeUndefined();
  });
});
