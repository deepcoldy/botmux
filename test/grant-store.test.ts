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

describe('grant-store message quota', () => {
  it('addChatGrant with quota writes a scope-aware quotaState record (disk + memory)', async () => {
    writeConfig({ allowedUsers: ['ou_owner'] });
    const { registry, store } = await freshModules();
    await store.addChatGrant('a1', 'oc_1', 'ou_g', 5);
    expect(readConfig().quotaState).toEqual({ 'chat:oc_1:ou_g': { limit: 5, used: 0 } });
    expect(registry.getBot('a1').config.quotaState).toEqual({ 'chat:oc_1:ou_g': { limit: 5, used: 0 } });
  });

  it('re-granting with a new quota resets used to 0 (refill); without quota deletes the record', async () => {
    writeConfig({ allowedUsers: ['ou_owner'] });
    const { store } = await freshModules();
    await store.addChatGrant('a1', 'oc_1', 'ou_g', 5);
    await store.consumeQuota('a1', 'chat:oc_1:ou_g');
    await store.consumeQuota('a1', 'chat:oc_1:ou_g');
    expect(readConfig().quotaState['chat:oc_1:ou_g'].used).toBe(2);
    await store.addChatGrant('a1', 'oc_1', 'ou_g', 3); // refill
    expect(readConfig().quotaState['chat:oc_1:ou_g']).toEqual({ limit: 3, used: 0 });
    await store.addChatGrant('a1', 'oc_1', 'ou_g'); // no quota → unlimited (record gone)
    expect(readConfig().quotaState).toBeUndefined();
  });

  it('addGlobalGrant with quota uses the global key', async () => {
    writeConfig({ allowedUsers: ['ou_owner'] });
    const { store } = await freshModules();
    await store.addGlobalGrant('a1', 'ou_g', 7);
    expect(readConfig().quotaState).toEqual({ 'global:ou_g': { limit: 7, used: 0 } });
  });

  it('consumeQuota: tracked=false when no record; increments; exhausted on last; allow=false past limit', async () => {
    writeConfig({ allowedUsers: ['ou_owner'] });
    const { store } = await freshModules();
    expect(await store.consumeQuota('a1', 'chat:oc_1:ou_none')).toMatchObject({ tracked: false, allow: true });
    await store.addChatGrant('a1', 'oc_1', 'ou_g', 2);
    expect(await store.consumeQuota('a1', 'chat:oc_1:ou_g')).toMatchObject({ tracked: true, allow: true, exhausted: false, used: 1, limit: 2 });
    expect(await store.consumeQuota('a1', 'chat:oc_1:ou_g')).toMatchObject({ tracked: true, allow: true, exhausted: true, used: 2, limit: 2 });
    // already at/over limit → allow:false (block + heal)
    expect(await store.consumeQuota('a1', 'chat:oc_1:ou_g')).toMatchObject({ tracked: true, allow: false });
  });

  it('removeChatGrant clears only the chat grant + its quota key, leaves global intact', async () => {
    writeConfig({ allowedUsers: ['ou_owner'], chatGrants: { oc_1: ['ou_g'] }, globalGrants: ['ou_g'],
      quotaState: { 'chat:oc_1:ou_g': { limit: 5, used: 1 }, 'global:ou_g': { limit: 9, used: 2 } } });
    const { registry, store } = await freshModules();
    const r = await store.removeChatGrant('a1', 'oc_1', 'ou_g');
    expect(r).toEqual({ ok: true, removed: true });
    const disk = readConfig();
    expect(disk.chatGrants).toEqual({});
    expect(disk.globalGrants).toEqual(['ou_g']);       // global untouched
    expect(disk.quotaState).toEqual({ 'global:ou_g': { limit: 9, used: 2 } });
    expect(registry.getBot('a1').config.quotaState).toEqual({ 'global:ou_g': { limit: 9, used: 2 } });
  });

  it('removeGlobalGrant clears only the global grant + its quota key', async () => {
    writeConfig({ allowedUsers: ['ou_owner'], globalGrants: ['ou_g', 'ou_other'],
      quotaState: { 'global:ou_g': { limit: 9, used: 2 } } });
    const { store } = await freshModules();
    const r = await store.removeGlobalGrant('a1', 'ou_g');
    expect(r).toEqual({ ok: true, removed: true });
    expect(readConfig().globalGrants).toEqual(['ou_other']);
    expect(readConfig().quotaState).toBeUndefined();
  });

  it('manual revokeGrant also clears both scope quota keys for the target', async () => {
    writeConfig({ allowedUsers: ['ou_owner', 'ou_g'], chatGrants: { oc_1: ['ou_g'] }, globalGrants: ['ou_g'],
      quotaState: { 'chat:oc_1:ou_g': { limit: 5, used: 1 }, 'global:ou_g': { limit: 9, used: 2 } } });
    const { store } = await freshModules();
    const r = await store.revokeGrant('a1', 'oc_1', 'ou_g');
    expect(r.ok).toBe(true);
    expect(readConfig().quotaState).toBeUndefined();
  });

  it('exposes scope-aware key builders', async () => {
    writeConfig({ allowedUsers: ['ou_owner'] });
    const { store } = await freshModules();
    expect(store.chatQuotaKey('oc_1', 'ou_g')).toBe('chat:oc_1:ou_g');
    expect(store.globalQuotaKey('ou_g')).toBe('global:ou_g');
  });
});
