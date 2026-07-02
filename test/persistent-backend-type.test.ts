/**
 * getSessionPersistentBackendType precedence + the PTY退役 legacy-safety fix.
 *
 * Regression target (Codex P1 on PR #289): after the default backend flipped to
 * always-tmux, a session created under the OLD probe-based default (implicit PTY
 * on a tmux-less host) — with no per-session backendType stamped and a bot that
 * pins no backend — must NOT be re-derived as tmux. Otherwise restore probes for
 * a `bmx-<sid>` pane that never existed and zombie-closes a recoverable session.
 *
 * Run:  pnpm vitest run test/persistent-backend-type.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable per-test bot backend config the mocked getBot returns.
const bot = vi.hoisted(() => ({ backendType: undefined as string | undefined }));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { backendType: bot.backendType } })),
}));

import { getSessionPersistentBackendType } from '../src/core/persistent-backend.js';

function ds(opts: { initBackend?: string; sessionBackend?: string }): any {
  return {
    larkAppId: 'app1',
    initConfig: opts.initBackend ? { backendType: opts.initBackend } : undefined,
    session: { sessionId: 'abcdef12', backendType: opts.sessionBackend },
  };
}

describe('getSessionPersistentBackendType', () => {
  beforeEach(() => { bot.backendType = undefined; });

  it('prefers the live worker initConfig backend', () => {
    expect(getSessionPersistentBackendType(ds({ initBackend: 'tmux', sessionBackend: 'zellij' }))).toBe('tmux');
  });

  it('falls back to the backend stamped on the persisted session', () => {
    expect(getSessionPersistentBackendType(ds({ sessionBackend: 'zellij' }))).toBe('zellij');
  });

  it('uses an explicit per-bot backend when the session has none stamped', () => {
    bot.backendType = 'herdr';
    expect(getSessionPersistentBackendType(ds({}))).toBe('herdr');
  });

  it('LEGACY SAFETY: unstamped session + bot pins no backend → undefined (not tmux), so restore keeps it for lazy resume instead of zombie-closing', () => {
    bot.backendType = undefined;
    expect(getSessionPersistentBackendType(ds({}))).toBeUndefined();
  });

  it('a stamped pty session is not a persistent backend', () => {
    expect(getSessionPersistentBackendType(ds({ sessionBackend: 'pty' }))).toBeUndefined();
    expect(getSessionPersistentBackendType(ds({ initBackend: 'pty' }))).toBeUndefined();
  });
});
