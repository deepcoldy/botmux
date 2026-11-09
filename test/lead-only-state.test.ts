import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const remote = vi.hoisted(() => ({ name: 'Project', description: 'Human notes\n' }));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    request = async () => ({ code: 0, data: { name: remote.name, description: remote.description, chat_mode: 'group', is_in_chat: true } });
    im = { v1: { chat: { update: async ({ data }: { data: { name: string; description: string } }) => {
      Object.assign(remote, data);
      return { code: 0 };
    } } } };
  },
  Domain: { Feishu: 'feishu', Lark: 'lark' }, LoggerLevel: { info: 2 },
}));

import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import * as manager from '../src/services/chat-manager.js';
import { isLeadOnlyManagerClaim, readManagerClaim, writeManagerClaim } from '../src/services/chat-manager-state.js';
import { isLeadOnlySession } from '../src/core/lead-only.js';

const APP = 'cli_lead';
const OTHER = 'cli_lead_other';
const CHAT = 'oc_lead';
const testRoot = config.session.dataDir;

describe('lead-only flag on the manager claim', () => {
  beforeEach(() => {
    config.session.dataDir = mkdtempSync(join(testRoot, 'lead-only-'));
    Object.assign(remote, { name: 'Project', description: 'Human notes\n' });
    for (const app of [APP, OTHER]) registerBot({ larkAppId: app, larkAppSecret: 'test', cliId: 'claude-code', allowedUsers: [] });
  });

  it('defaults off, requires the current manager, and toggles idempotently', async () => {
    expect(await manager.setChatManagerLeadOnly(APP, CHAT, true)).toMatchObject({ ok: false, reason: 'not_current_manager' });
    await manager.changeChatManager(APP, CHAT, 'set', 'Lead');
    expect(isLeadOnlyManagerClaim(APP, CHAT)).toBe(false);
    expect(await manager.getChatManagerStatus(APP, CHAT)).toMatchObject({ ok: true, leadOnly: false });
    expect(await manager.setChatManagerLeadOnly(OTHER, CHAT, true)).toMatchObject({ ok: false, reason: 'not_current_manager' });
    expect(await manager.setChatManagerLeadOnly(APP, CHAT, true)).toMatchObject({ ok: true, changed: true, leadOnly: true });
    expect(isLeadOnlyManagerClaim(APP, CHAT)).toBe(true);
    expect(await manager.getChatManagerStatus(APP, CHAT)).toMatchObject({ ok: true, leadOnly: true });
    expect(await manager.setChatManagerLeadOnly(APP, CHAT, true)).toMatchObject({ ok: true, changed: false });
    expect(await manager.setChatManagerLeadOnly(APP, CHAT, false)).toMatchObject({ ok: true, changed: true, leadOnly: false });
    expect(isLeadOnlyManagerClaim(APP, CHAT)).toBe(false);
  });

  it('honors the stillCurrent guard', async () => {
    await manager.changeChatManager(APP, CHAT, 'set', 'Lead');
    expect(await manager.setChatManagerLeadOnly(APP, CHAT, true, () => false))
      .toMatchObject({ ok: false, reason: 'human_turn_changed' });
    expect(isLeadOnlyManagerClaim(APP, CHAT)).toBe(false);
  });

  it('clear drops the flag so a later set starts OFF', async () => {
    await manager.changeChatManager(APP, CHAT, 'set', 'Lead');
    await manager.setChatManagerLeadOnly(APP, CHAT, true);
    await manager.changeChatManager(APP, CHAT, 'clear', 'Lead');
    expect(isLeadOnlyManagerClaim(APP, CHAT)).toBe(false);
    expect(readManagerClaim(APP, CHAT)?.leadOnly).toBeUndefined();
    await manager.changeChatManager(APP, CHAT, 'set', 'Lead');
    expect(isLeadOnlyManagerClaim(APP, CHAT)).toBe(false);
  });

  it('a disabled claim is never lead-only; a non-boolean flag is invalid and reads as false', () => {
    const claim = { schemaVersion: 1 as const, larkAppId: APP, chatId: CHAT, enabled: false, originalName: 'P', managedName: 'P · L', leadOnly: true };
    writeManagerClaim(claim);
    expect(isLeadOnlyManagerClaim(APP, CHAT)).toBe(false);
    writeManagerClaim({ ...claim, enabled: true, leadOnly: 'yes' as any });
    expect(() => readManagerClaim(APP, CHAT)).toThrow('invalid_local_claim');
    expect(isLeadOnlyManagerClaim(APP, CHAT)).toBe(false);
    writeManagerClaim({ ...claim, enabled: true, leadOnly: undefined });
    expect(readManagerClaim(APP, CHAT)?.enabled).toBe(true);
    expect(isLeadOnlyManagerClaim(APP, CHAT)).toBe(false);
  });

  it('isLeadOnlySession: manager group sessions only, executors and p2p exempt', () => {
    writeManagerClaim({ schemaVersion: 1, larkAppId: APP, chatId: CHAT, enabled: true, originalName: 'P', managedName: 'P · L', leadOnly: true });
    expect(isLeadOnlySession(APP, CHAT, 'group', {})).toBe(true);
    expect(isLeadOnlySession(APP, CHAT, 'p2p', {})).toBe(false);
    expect(isLeadOnlySession(APP, CHAT, 'group', { dispatchLaunchId: 'dl_1' })).toBe(false);
    expect(isLeadOnlySession(APP, CHAT, 'group', { workflowNode: {} as any })).toBe(false);
    // A main-topic handoff marker leaves the manager's ordinary session lead-only.
    expect(isLeadOnlySession(APP, CHAT, 'group', { workflowNode: { placement: 'main' } as any })).toBe(true);
    expect(isLeadOnlySession(OTHER, CHAT, 'group', {})).toBe(false);
    expect(isLeadOnlySession(APP, 'oc_other', 'group', {})).toBe(false);
  });
});
