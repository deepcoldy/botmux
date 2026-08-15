/**
 * How a worker reads destroySession()'s answer. Both functions here are the exact
 * ones worker.ts calls on the `/close` prepare path.
 *
 * The malformed-result branch previously had no coverage, and `'ok' in raw`
 * accepted { ok: 'yes' } as a successful teardown.
 */
import { describe, expect, it } from 'vitest';
import { mayRestoreWriteAdmission, normalizeDestroyResult } from '../src/adapters/backend/destroy-result.js';

describe('normalizeDestroyResult', () => {
  it('rejects a truthy non-boolean ok from a remote backend', () => {
    // `'ok' in raw` was satisfied here, so this reached `if (result.ok)` and was
    // published as a closed row.
    expect(normalizeDestroyResult({ ok: 'yes' }, { remote: true })).toMatchObject({
      ok: false,
      error: 'remote_close_result_missing',
    });
  });

  it('treats a missing remote result as an unknown outcome, not success', () => {
    for (const raw of [undefined, null, 'ok', 42, {}]) {
      expect(normalizeDestroyResult(raw, { remote: true }).ok, `raw=${String(raw)}`).toBe(false);
    }
  });

  it('keeps void as success for local multiplexers', () => {
    // tmux/zellij/herdr destroy synchronously; "no result" really is success and
    // must not start failing.
    expect(normalizeDestroyResult(undefined, { remote: false })).toEqual({ ok: true });
    expect(normalizeDestroyResult({ ok: 'yes' }, { remote: false })).toEqual({ ok: true });
  });

  it('passes a well-formed result through untouched', () => {
    const raw = { ok: false, taskId: 'sid-1', error: 'boom', recovery: 'irreversible' as const };
    expect(normalizeDestroyResult(raw, { remote: true })).toBe(raw);
  });
});

describe('mayRestoreWriteAdmission', () => {
  it('restores admission only for a reversible failure', () => {
    expect(mayRestoreWriteAdmission({ ok: false, recovery: 'retryable' })).toBe(true);
    // Unknown side effect: a fresh lineage must not be started over a possible
    // unnamed orphan.
    expect(mayRestoreWriteAdmission({ ok: false, recovery: 'uncertain' })).toBe(false);
    // Remote already gone: restoring admission yields a session that looks
    // writable but can never continue.
    expect(mayRestoreWriteAdmission({ ok: false, recovery: 'irreversible' })).toBe(false);
  });

  it('defaults to the historical rollback behaviour when recovery is absent', () => {
    expect(mayRestoreWriteAdmission({ ok: false })).toBe(true);
  });

  it('never rolls back a successful prepare', () => {
    expect(mayRestoreWriteAdmission({ ok: true })).toBe(false);
  });
});
