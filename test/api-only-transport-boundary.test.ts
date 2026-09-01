import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Behavioral tests for PR D · API-only (core-only) transport boundary.
 *
 * Complements the source-lock in api-only-mode-wiring.test.ts with real
 * invariant checks:
 *  - larkTransportEnabled: the central "no Feishu side effects" predicate;
 *  - triggerSessionTurn fail-closes an apiOnly bot's request SHAPE (codex P1-2)
 *    so it can never be steered into a real Feishu chat/root or skip a response
 *    mode and re-enter the delivery path.
 */

const mockGetBot = vi.fn();
vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return { ...actual, getBot: (...a: any[]) => mockGetBot(...a) };
});

// A roster probe (getAvailableBots → is_in_chat) hitting Feishu would throw here
// in a headless test; we assert it is NEVER called for an apiOnly async trigger.
const mockIsInChat = vi.fn(async () => { throw new Error('is_in_chat must not be called for apiOnly'); });
vi.mock('../src/services/groups-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/groups-store.js')>();
  return { ...actual, isInChat: (...a: any[]) => mockIsInChat(...a) };
});

import { triggerSessionTurn } from '../src/core/trigger-session.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import { larkTransportEnabled, isHttpVirtualSession, type DaemonSession } from '../src/core/types.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP = 'local_riff';

function apiOnlyBot() {
  mockGetBot.mockReturnValue({
    config: { apiOnly: true, cliId: 'codex-app', larkAppId: APP },
    botName: 'Riff',
    botOpenId: `bot_${APP}`,
  });
}

function req(overrides: Partial<TriggerRequest['target']> & { options?: TriggerRequest['options'] } = {}): TriggerRequest {
  const { options, ...target } = overrides;
  return {
    source: { type: 'ui', requestId: 'r1' },
    target: { kind: 'turn', botId: APP, ...target },
    envelope: { format: 'botmux.ui.v1', sourceName: 'riff', trusted: false, payload: {} },
    options,
  };
}

describe('larkTransportEnabled — central no-Feishu predicate', () => {
  it('disables transport for an apiOnly bot regardless of chat', () => {
    expect(larkTransportEnabled({ chatId: 'oc_real', apiOnly: true })).toBe(false);
  });
  it('disables transport for an HTTP virtual session even on a normal bot', () => {
    expect(larkTransportEnabled({ chatId: 'http_async_abc', apiOnly: false })).toBe(false);
    expect(larkTransportEnabled({ chatId: 'http_wait_abc', apiOnly: undefined })).toBe(false);
  });
  it('enables transport for a normal bot in a real chat', () => {
    expect(larkTransportEnabled({ chatId: 'oc_real', apiOnly: false })).toBe(true);
  });
  it('isHttpVirtualSession recognizes both synthetic prefixes only', () => {
    expect(isHttpVirtualSession('http_async_x')).toBe(true);
    expect(isHttpVirtualSession('http_wait_x')).toBe(true);
    expect(isHttpVirtualSession('oc_real')).toBe(false);
    expect(isHttpVirtualSession('doc:tok')).toBe(false);
  });
  it('tolerates a nullish chatId (a missing surface is not an HTTP virtual chat)', () => {
    // Hardened when converging worker.ts's four inline copies onto this predicate:
    // one site (screenshot-upload gate) fed a `msg.chatId` that could be undefined,
    // and inline code guarded with `?.` — so the central helper must not throw.
    expect(isHttpVirtualSession(undefined)).toBe(false);
    expect(isHttpVirtualSession(null)).toBe(false);
    // A nullish chatId with a non-apiOnly bot ⇒ transport still enabled (no crash).
    expect(larkTransportEnabled({ chatId: undefined, apiOnly: false })).toBe(true);
    expect(larkTransportEnabled({ chatId: undefined, apiOnly: true })).toBe(false);
  });
  it('keeps `chatId` a REQUIRED key so omitting it cannot silently fail open', () => {
    // Tolerating a nullish VALUE (above) must not become tolerating a missing KEY.
    // This is a fail-closed gate: `larkTransportEnabled({ apiOnly: false })` would
    // read as "transport enabled", so the omission has to be a compile error.
    // Asserted on the source because a type-level mistake cannot be caught at
    // runtime — the signature must stay `chatId: string | null | undefined`.
    const src = readFileSync(resolve('src/core/types.ts'), 'utf8');
    const sig = /export function larkTransportEnabled\(\s*ds:\s*\{([^}]*)\}/.exec(src);
    expect(sig, 'larkTransportEnabled signature not found').not.toBeNull();
    // `chatId:` (required), NOT `chatId?:` (optional).
    expect(sig![1]).toMatch(/\bchatId\s*:/);
    expect(sig![1]).not.toMatch(/\bchatId\s*\?\s*:/);
    // …and the nullable value form is still there, so the tolerance above holds.
    expect(sig![1]).toMatch(/\bchatId\s*:\s*string\s*\|\s*null\s*\|\s*undefined/);
  });
});

describe('triggerSessionTurn — apiOnly request-shape fail-closed', () => {
  beforeEach(() => {
    mockGetBot.mockReset();
    mockIsInChat.mockClear();
    apiOnlyBot();
  });

  it('rejects an apiOnly trigger with no HTTP response mode', async () => {
    const res = await triggerSessionTurn(req({ chatId: 'http_async_seed' }), { larkAppId: APP, activeSessions: new Map() });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('bad_request');
    expect(res.error).toMatch(/HTTP response mode/);
  });

  it('rejects an apiOnly trigger targeting a real Feishu chatId', async () => {
    const res = await triggerSessionTurn(
      req({ chatId: 'oc_real_chat', options: { asyncReturnSessionId: true } }),
      { larkAppId: APP, activeSessions: new Map() },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('bad_request');
    expect(res.error).toMatch(/real Feishu chatId/);
  });

  it('rejects an apiOnly trigger targeting a Feishu rootMessageId', async () => {
    const res = await triggerSessionTurn(
      req({ rootMessageId: 'om_real_root', options: { asyncReturnSessionId: true } }),
      { larkAppId: APP, activeSessions: new Map() },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('bad_request');
    expect(res.error).toMatch(/rootMessageId/);
  });

  it('accepts a well-formed apiOnly async trigger (dry-run) — fail-closed does not over-reject', async () => {
    // asyncReturnSessionId + no real chat target is the canonical riff call.
    // dry-run stops before forkWorker but after the apiOnly shape gate, proving
    // the gate admits the legitimate request instead of rejecting everything.
    const res = await triggerSessionTurn(
      req({ options: { asyncReturnSessionId: true, dryRun: true } }),
      { larkAppId: APP, activeSessions: new Map() },
    );
    expect(res.ok).toBe(true);
    expect(res.action).toBe('dry_run');
    // No Feishu roster probe was reached on this path.
    expect(mockIsInChat).not.toHaveBeenCalled();
  });
});
