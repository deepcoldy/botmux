import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const remote = vi.hoisted(() => ({
  name: 'Project', description: 'Human notes\n', failUpdate: false,
  lieAboutUpdate: false, failRead: false, writes: 0, mode: 'group',
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    request = async () => {
      if (remote.failRead) throw new Error('offline');
      return { code: 0, data: { name: remote.name, description: remote.description, chat_mode: remote.mode, is_in_chat: true } };
    };
    im = { v1: { chat: { update: async ({ data }: { data: { name: string; description: string } }) => {
      remote.writes++;
      if (remote.failUpdate) return { code: 230001, msg: 'denied' };
      if (!remote.lieAboutUpdate) Object.assign(remote, data);
      return { code: 0 };
    } } } };
  },
  Domain: { Feishu: 'feishu', Lark: 'lark' }, LoggerLevel: { info: 2 },
}));

import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import * as manager from '../src/services/chat-manager.js';

const APP = 'cli_manager';
const OTHER = 'cli_other';
const CHAT = 'oc_project';
const testRoot = config.session.dataDir;
const change = (action: 'set' | 'clear', app = APP, name = 'Manager') =>
  manager.changeChatManager(app, CHAT, action, name);

describe('manager mutations with real durable state and a fake Lark transport', () => {
  beforeEach(() => {
    config.session.dataDir = mkdtempSync(join(testRoot, 'manager-op-'));
    Object.assign(remote, { name: 'Project', description: 'Human notes\n', failUpdate: false,
      lieAboutUpdate: false, failRead: false, writes: 0, mode: 'group' });
    for (const app of [APP, OTHER]) registerBot({ larkAppId: app, larkAppSecret: 'test', cliId: 'codex', allowedUsers: [] });
  });

  it('sets, repeats idempotently and clears without damaging the description', async () => {
    expect(await change('set')).toMatchObject({ ok: true, changed: true, managerAppId: APP });
    expect(remote.name).toBe('Project · Manager');
    expect(remote.description).toBe('Human notes\n\n[botmux:manager=cli_manager]');
    expect(await manager.isChatManager(APP, CHAT)).toBe(true);
    expect(await change('set')).toMatchObject({ ok: true, changed: false });
    expect(remote.writes).toBe(1);
    expect(await change('clear')).toMatchObject({ ok: true, changed: true });
    expect(remote.name).toBe('Project');
    expect(remote.description).toBe('Human notes\n');
    expect(await manager.isChatManager(APP, CHAT)).toBe(false);
  });

  it('requires an explicit clear before another bot can take over', async () => {
    await change('set');
    expect(await change('set', OTHER)).toMatchObject({ ok: false, reason: 'manager_already_set' });
    expect(await change('clear', OTHER)).toMatchObject({ ok: false, reason: 'not_current_manager' });
    await change('clear');
    expect(await change('set', OTHER, 'Second')).toMatchObject({ ok: true, managerAppId: OTHER });
    expect(remote.name).toBe('Project · Second');
    expect(await manager.isChatManager(APP, CHAT)).toBe(false);
    expect(await manager.isChatManager(OTHER, CHAT)).toBe(true);
  });

  it('serializes contenders on the same host, leaving only one active claim', async () => {
    const results = await Promise.all([change('set'), change('set', OTHER)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    const active = await Promise.all([manager.isChatManager(APP, CHAT), manager.isChatManager(OTHER, CHAT)]);
    expect(active.filter(Boolean)).toHaveLength(1);
  });

  it('refuses overfull descriptions without truncation or a partial mutation', async () => {
    remote.description = '文'.repeat(90);
    expect(await change('set')).toMatchObject({ ok: false, reason: 'description_too_long' });
    expect(remote.description).toBe('文'.repeat(90));
    expect(remote.name).toBe('Project');
    expect(remote.writes).toBe(0);
  });

  it('keeps a manual rename and description edit when clearing', async () => {
    await change('set');
    remote.name = 'User renamed';
    remote.description = `Updated notes\n[botmux:manager=${APP}]`;
    expect(await change('clear')).toMatchObject({ ok: true });
    expect(remote.name).toBe('User renamed');
    expect(remote.description).toBe('Updated notes');
  });

  it('does not activate or report success after a failed remote update', async () => {
    remote.failUpdate = true;
    expect(await change('set')).toMatchObject({ ok: false, reason: 'chat_update_failed' });
    expect(await manager.isChatManager(APP, CHAT)).toBe(false);
  });

  it('checks readback instead of treating code=0 as completion', async () => {
    remote.lieAboutUpdate = true;
    expect(await change('set')).toMatchObject({ ok: false, reason: 'chat_update_unconfirmed' });
    expect(await manager.isChatManager(APP, CHAT)).toBe(false);
  });

  it('does not adopt a manually forged marker without a local opt-in', async () => {
    remote.description = `[botmux:manager=${APP}]`;
    expect(await change('set')).toMatchObject({ ok: false, reason: 'unowned_manager_marker' });
    expect(remote.writes).toBe(0);
  });

  it('rejects duplicate markers instead of choosing an arbitrary winner', async () => {
    remote.description = `[botmux:manager=${APP}]\n[botmux:manager=${OTHER}]`;
    expect(await change('set')).toMatchObject({ ok: false, reason: 'ambiguous_manager_marker' });
  });

  it('does not mutate a topic group or when metadata cannot be read', async () => {
    remote.mode = 'topic';
    expect(await change('set')).toMatchObject({ ok: false, reason: 'regular_group_only' });
    remote.failRead = true;
    expect(await change('set')).toEqual({ ok: false, reason: 'manager_operation_failed' });
    expect(remote.writes).toBe(0);
  });

  it('restores long Unicode names and persists private, reloadable metadata', async () => {
    const original = '🎉'.repeat(95);
    remote.name = original;
    await change('set');
    expect(Array.from(remote.name).length).toBeLessThanOrEqual(100);
    const root = join(config.session.dataDir, 'chat-managers');
    const file = readdirSync(root).find(path => path.endsWith('.json'))!;
    const claim = JSON.parse(readFileSync(join(root, file), 'utf8'));
    expect(claim).toMatchObject({ enabled: true, originalName: original, larkAppId: APP, chatId: CHAT });
    if (process.platform !== 'win32') expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
    expect(await manager.isChatManager(APP, CHAT)).toBe(true);
    await change('clear');
    expect(remote.name).toBe(original);
  });
});
