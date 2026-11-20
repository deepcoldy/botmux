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

const state = vi.hoisted(() => ({ assistantMode: true, stored: undefined as string | undefined, dataDir: '' }));
vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/bot-registry.js')>(),
  getBot: () => ({ config: { larkAppId: 'cli_app', assistantMode: state.assistantMode } }),
}));
vi.mock('../src/services/assistant-owner-store.js', () => ({
  getAssistantOwner: () => state.stored ? { openId: state.stored, since: '2026-11-20T00:00:00Z', how: 'claim' } : undefined,
}));
vi.mock('../src/services/session-groups-store.js', () => ({ getSessionGroup: () => undefined }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return state.dataDir; } } } }));

import { assistantSessionStillOwned, resolveAssistantSpawn } from '../src/core/assistant-spawn.js';
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
    state.assistantMode = false;
    expect(() => assertNotAssistantModeBot('cli_app')).not.toThrow();
  });
});
