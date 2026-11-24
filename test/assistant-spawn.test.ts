/**
 * Assistant-mode ownership for secondary session paths: the shared resolver,
 * the "is this old session still owned" check used by topic continuity, fork /
 * recovery inheritance of the owner, and v3 workflows refusing assistant bots.
 *
 * Run: npx vitest run --project unit test/assistant-spawn.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ assistantMode: true, unregistered: false, stored: undefined as string | undefined, dataDir: '' }));
vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/bot-registry.js')>(),
  getBot: (id: string) => {
    if (state.unregistered) throw new Error(`bot ${id} not registered`);
    return { config: { larkAppId: 'cli_app', assistantMode: state.assistantMode } };
  },
  loadBotConfigsCached: () => [{ larkAppId: 'cli_app', assistantMode: state.assistantMode }],
}));
vi.mock('../src/services/assistant-owner-store.js', () => ({
  getAssistantOwner: () => state.stored ? { openId: state.stored, since: '2026-11-20T00:00:00Z', how: 'claim' } : undefined,
}));
vi.mock('../src/services/session-groups-store.js', () => ({ getSessionGroup: () => undefined }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return state.dataDir; } } } }));

import { assistantScheduleCreatorAllowed, assistantSessionStillOwned, decideAssistantAdmission, resolveAssistantSpawn } from '../src/core/assistant-spawn.js';
import { inheritSessionLaunchConfiguration } from '../src/core/session-launch-inheritance.js';
import { botToSnapshot } from '../src/workflows/v3/bot-resolve.js';
import { assertNotAssistantModeBot } from '../src/workflows/v3/ephemeral-pool.js';
import type { Session } from '../src/types.js';

const A = 'ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-assistant-spawn-'));
  state.dataDir = join(root, 'data');
  state.assistantMode = true;
  state.stored = undefined;
  state.unregistered = false;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('resolveAssistantSpawn', () => {
  it('DM → the sender owns it, cwd under their own work dir', () => {
    const r = resolveAssistantSpawn('cli_app', 'oc_dm', 'p2p', A);
    expect(r).toEqual({ kind: 'owner', openId: A, workDir: join(root, 'bots', 'cli_app', 'users', A, 'work') });
  });
  it('group → the stored owner, not whoever sent the message; unclaimed group → unclaimed', () => {
    expect(resolveAssistantSpawn('cli_app', 'oc_g', 'group', B)).toEqual({ kind: 'unclaimed' });
    state.stored = A;
    expect(resolveAssistantSpawn('cli_app', 'oc_g', 'group', B)).toMatchObject({ kind: 'owner', openId: A });
  });
  it('mode off → off', () => {
    state.assistantMode = false;
    expect(resolveAssistantSpawn('cli_app', 'oc_dm', 'p2p', A)).toEqual({ kind: 'off' });
  });
});

describe('assistantScheduleCreatorAllowed (target-chat owner)', () => {
  it('admits only the target chat owner; an unclaimed group admits nobody; mode off admits everyone', () => {
    expect(assistantScheduleCreatorAllowed('cli_app', 'oc_g', 'group', A)).toBe(false);
    state.stored = A;
    expect(assistantScheduleCreatorAllowed('cli_app', 'oc_g', 'group', A)).toBe(true);
    expect(assistantScheduleCreatorAllowed('cli_app', 'oc_g', 'group', B)).toBe(false);
    expect(assistantScheduleCreatorAllowed('cli_app', 'oc_g', 'group', undefined)).toBe(false);
    expect(assistantScheduleCreatorAllowed('cli_app', 'oc_dm', 'p2p', B)).toBe(true);
    state.assistantMode = false;
    expect(assistantScheduleCreatorAllowed('cli_app', 'oc_g', 'group', B)).toBe(true);
  });
});

describe('assistantSessionStillOwned (topic continuity)', () => {
  it('only the current owner\'s session may be resumed; pre-mode rows without an owner may not', () => {
    state.stored = A;
    expect(assistantSessionStillOwned({ chatId: 'oc_g', chatType: 'group', assistantOwnerOpenId: A }, 'cli_app', B)).toBe(true);
    expect(assistantSessionStillOwned({ chatId: 'oc_g', chatType: 'group', assistantOwnerOpenId: B }, 'cli_app', B)).toBe(false);
    expect(assistantSessionStillOwned({ chatId: 'oc_g', chatType: 'group' }, 'cli_app', B)).toBe(false);
    state.stored = undefined;
    expect(assistantSessionStillOwned({ chatId: 'oc_g', chatType: 'group', assistantOwnerOpenId: A }, 'cli_app', A)).toBe(false);
  });
  it('mode off never blocks', () => {
    state.assistantMode = false;
    expect(assistantSessionStillOwned({ chatId: 'oc_g', chatType: 'group' }, 'cli_app', A)).toBe(true);
  });
});

describe('fork / clean-recovery inheritance', () => {
  it('carries the assistant owner', () => {
    const target = {} as Session;
    inheritSessionLaunchConfiguration({ assistantOwnerOpenId: A } as Session, target);
    expect(target.assistantOwnerOpenId).toBe(A);
  });
});

describe('v3 workflow', () => {
  it('refuses an assistant-mode bot instead of running it with the bot-wide home', () => {
    expect(() => botToSnapshot({ larkAppId: 'cli_app', larkAppSecret: 'x', cliId: 'claude-code', sandbox: true, assistantMode: true } as any, '/w'))
      .toThrow(/assistant/);
  });
  it('a resumed run (stored snapshot) is refused at launch once the live bot is in assistant mode', () => {
    expect(() => assertNotAssistantModeBot('cli_app')).toThrow(/assistant/);
    // a standalone run / another daemon's bot is not registered here: read the configured bots
    state.unregistered = true;
    expect(() => assertNotAssistantModeBot('cli_app')).toThrow(/assistant/);
    state.assistantMode = false;
    expect(() => assertNotAssistantModeBot('cli_app')).not.toThrow();
  });
});

describe('decideAssistantAdmission (worker launch gate)', () => {
  const g = (o: Partial<{ chatType: 'group' | 'p2p'; ownerOpenId: string; assistantOwnerOpenId: string; everRan: boolean; sandboxFrozenWithoutWithhold: boolean }>) =>
    decideAssistantAdmission('cli_app', { chatId: 'oc_g', chatType: 'group', everRan: false, sandboxFrozenWithoutWithhold: false, ...o });
  it('a never-run session created by a path that did not stamp an owner is adopted by the chat owner, cwd in their work dir', () => {
    state.stored = A;
    expect(g({ ownerOpenId: B })).toEqual({ kind: 'adopt', openId: A, workDir: join(root, 'bots', 'cli_app', 'users', A, 'work') });
    expect(decideAssistantAdmission('cli_app', { chatId: 'oc_dm', chatType: 'p2p', ownerOpenId: B, everRan: false, sandboxFrozenWithoutWithhold: false }))
      .toMatchObject({ kind: 'adopt', openId: B });
  });
  it('a sandbox shape frozen before the mode (secret not withheld) is never launched, adopted or owned', () => {
    state.stored = A;
    expect(g({ sandboxFrozenWithoutWithhold: true })).toMatchObject({ kind: 'reject', expected: A });
    expect(g({ assistantOwnerOpenId: A, sandboxFrozenWithoutWithhold: true })).toMatchObject({ kind: 'reject', have: A });
  });
  it('a session that already ran before the mode was enabled is not adopted', () => {
    state.stored = A;
    expect(g({ everRan: true })).toMatchObject({ kind: 'reject', expected: A });
  });
  it('owner match → allow; owner changed or unclaimed → reject', () => {
    state.stored = A;
    expect(g({ assistantOwnerOpenId: A, everRan: true })).toEqual({ kind: 'allow' });
    expect(g({ assistantOwnerOpenId: B })).toMatchObject({ kind: 'reject', have: B, expected: A });
    state.stored = undefined;
    expect(g({})).toEqual({ kind: 'reject' });
    expect(g({ assistantOwnerOpenId: A })).toEqual({ kind: 'reject', have: A });
  });
  it('mode off → allow', () => {
    state.assistantMode = false;
    expect(g({ everRan: true })).toEqual({ kind: 'allow' });
  });
});
