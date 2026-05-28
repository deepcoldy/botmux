/**
 * grant-store 持久化语义单测。
 * Run: pnpm vitest run test/grant-store.test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

let configPath: string;

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/grant-store.js');
  registry.loadBotConfigs().forEach(c => registry.registerBot(c));
  return { registry, store };
}

function writeConfig(entry: Record<string, unknown>) {
  writeFileSync(configPath, JSON.stringify([{ larkAppId: 'a1', larkAppSecret: 's', cliId: 'claude-code', ...entry }], null, 2), 'utf-8');
}
function readConfig(): any { return JSON.parse(readFileSync(configPath, 'utf-8'))[0]; }

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-grant-store-'));
  configPath = join(dir, 'bots.json');
  process.env.BOTS_CONFIG = configPath;
});
afterEach(() => { delete process.env.BOTS_CONFIG; vi.restoreAllMocks(); });

describe('grant-store', () => {
  it('addChatGrant persists & syncs in-memory; only affects given chat', async () => {
    writeConfig({ allowedUsers: ['ou_owner'] });
    const { registry, store } = await freshModules();
    const r = await store.addChatGrant('a1', 'oc_1', 'ou_guest');
    expect(r).toEqual({ ok: true, created: true });
    expect(readConfig().chatGrants).toEqual({ oc_1: ['ou_guest'] });
    expect(registry.getBot('a1').config.chatGrants).toEqual({ oc_1: ['ou_guest'] });
    // idempotent
    expect(await store.addChatGrant('a1', 'oc_1', 'ou_guest')).toEqual({ ok: true, created: false });
  });

  it('revokeGrant refuses to empty resolvedAllowedUsers (would_open_bot)', async () => {
    writeConfig({ allowedUsers: ['ou_owner'] });
    const { store } = await freshModules();
    const r = await store.revokeGrant('a1', 'oc_1', 'ou_owner');
    expect(r).toEqual({ ok: false, reason: 'would_open_bot' });
  });

  it('revokeGrant refuses to revoke the owner even when others remain (#2)', async () => {
    writeConfig({ allowedUsers: ['ou_owner', 'ou_guest'] });
    const { store } = await freshModules();
    const r = await store.revokeGrant('a1', 'oc_1', 'ou_owner');
    expect(r).toEqual({ ok: false, reason: 'would_open_bot' });
  });

  it('revokeGrant atomically removes chat+global for a normal user', async () => {
    writeConfig({ allowedUsers: ['ou_owner', 'ou_guest'], chatGrants: { oc_1: ['ou_guest'] } });
    const { registry, store } = await freshModules();
    const r = await store.revokeGrant('a1', 'oc_1', 'ou_guest');
    expect(r).toEqual({ ok: true, removed: { chat: true, global: true, globalTalk: false } });
    const disk = readConfig();
    expect(disk.allowedUsers).toEqual(['ou_owner']);
    expect(disk.chatGrants).toEqual({});
    expect(registry.getBot('a1').resolvedAllowedUsers).toEqual(['ou_owner']);
    expect(registry.getBot('a1').config.chatGrants).toEqual({});
  });

  it('revokeGrant deletes email raw entry via resolution map', async () => {
    writeConfig({ allowedUsers: ['owner@x.com', 'guest@x.com'] });
    const { registry, store } = await freshModules();
    const bot = registry.getBot('a1');
    // simulate post-startup email resolution
    bot.resolvedAllowedUsers = ['ou_owner', 'ou_guest'];
    bot.rawAllowedUserResolution = new Map([['owner@x.com', 'ou_owner'], ['guest@x.com', 'ou_guest']]);
    const r = await store.revokeGrant('a1', 'oc_1', 'ou_guest');
    expect(r.ok).toBe(true);
    expect(readConfig().allowedUsers).toEqual(['owner@x.com']);
    expect(bot.resolvedAllowedUsers).toEqual(['ou_owner']);
  });

  it('addGlobalGrant persists & syncs in-memory; idempotent; never touches allowedUsers', async () => {
    writeConfig({ allowedUsers: ['ou_owner'] });
    const { registry, store } = await freshModules();
    const r = await store.addGlobalGrant('a1', 'ou_peer_bot');
    expect(r).toEqual({ ok: true, created: true });
    expect(readConfig().globalGrants).toEqual(['ou_peer_bot']);
    expect(registry.getBot('a1').config.globalGrants).toEqual(['ou_peer_bot']);
    expect(readConfig().allowedUsers).toEqual(['ou_owner']);  // talk-only: operate tier untouched
    // idempotent
    expect(await store.addGlobalGrant('a1', 'ou_peer_bot')).toEqual({ ok: true, created: false });
    expect(readConfig().globalGrants).toEqual(['ou_peer_bot']);
  });

  it('revokeGrant removes a globalGrants-only target (globalTalk), not blocked by would_open guard', async () => {
    // ou_peer 只在 globalGrants 里、不在 allowedUsers → would_open_bot 守卫不该拦它。
    writeConfig({ allowedUsers: ['ou_owner'], globalGrants: ['ou_peer', 'ou_other'] });
    const { registry, store } = await freshModules();
    const r = await store.revokeGrant('a1', 'oc_x', 'ou_peer');
    expect(r).toEqual({ ok: true, removed: { chat: false, global: false, globalTalk: true } });
    expect(readConfig().globalGrants).toEqual(['ou_other']);
    expect(registry.getBot('a1').config.globalGrants).toEqual(['ou_other']);
    expect(readConfig().allowedUsers).toEqual(['ou_owner']);  // untouched
  });

  it('revokeGrant deletes the globalGrants key entirely when it becomes empty', async () => {
    writeConfig({ allowedUsers: ['ou_owner'], globalGrants: ['ou_solo'] });
    const { registry, store } = await freshModules();
    const r = await store.revokeGrant('a1', 'oc_x', 'ou_solo');
    expect(r.ok).toBe(true);
    expect(readConfig().globalGrants).toBeUndefined();
    expect(registry.getBot('a1').config.globalGrants).toBeUndefined();
  });

  it('addAllowedChatGroup persists the chat_id & syncs in-memory; idempotent', async () => {
    writeConfig({ allowedUsers: ['ou_owner'] });
    const { registry, store } = await freshModules();
    const r = await store.addAllowedChatGroup('a1', 'oc_team');
    expect(r).toEqual({ ok: true, created: true });
    expect(readConfig().allowedChatGroups).toEqual(['oc_team']);
    expect(registry.getBot('a1').config.allowedChatGroups).toEqual(['oc_team']);
    // idempotent
    expect(await store.addAllowedChatGroup('a1', 'oc_team')).toEqual({ ok: true, created: false });
    expect(readConfig().allowedChatGroups).toEqual(['oc_team']);
  });

  it('removeAllowedChatGroup removes the chat_id from disk & memory', async () => {
    writeConfig({ allowedUsers: ['ou_owner'], allowedChatGroups: ['oc_team', 'oc_other'] });
    const { registry, store } = await freshModules();
    const r = await store.removeAllowedChatGroup('a1', 'oc_team');
    expect(r).toEqual({ ok: true, removed: true });
    expect(readConfig().allowedChatGroups).toEqual(['oc_other']);
    expect(registry.getBot('a1').config.allowedChatGroups).toEqual(['oc_other']);
    // removing one that isn't there
    expect(await store.removeAllowedChatGroup('a1', 'oc_team')).toEqual({ ok: true, removed: false });
  });

});
