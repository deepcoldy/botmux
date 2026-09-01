/**
 * grant-store 持久化语义单测。
 * Run: pnpm vitest run test/grant-store.test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';

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
  process.env.SESSION_DATA_DIR = dir; // isolate allowedUsers sidecar (revokeGrant writes it)
});
afterEach(() => { delete process.env.BOTS_CONFIG; delete process.env.SESSION_DATA_DIR; vi.restoreAllMocks(); });

describe('grant-store', () => {
  it('addChatGrant persists & syncs in-memory; only affects given chat', async () => {
    writeConfig({
      allowedUsers: ['ou_owner'],
      allowedChatGroups: ['oc_existing'],
      globalGrants: ['ou_existing_global'],
    });
    const { registry, store } = await freshModules();
    const r = await store.addChatGrant('a1', 'oc_1', 'ou_guest');
    expect(r).toEqual({ ok: true, created: true });
    expect(readConfig().chatGrants).toEqual({ oc_1: ['ou_guest'] });
    expect(registry.getBot('a1').config.chatGrants).toEqual({ oc_1: ['ou_guest'] });
    expect(readConfig().allowedUsers).toEqual(['ou_owner']);
    expect(readConfig().allowedChatGroups).toEqual(['oc_existing']);
    expect(readConfig().globalGrants).toEqual(['ou_existing_global']);
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
  it('persists expiry and re-granting as permanent clears only the expiry record', async () => {
    writeConfig({ allowedUsers: ['ou_owner'] });
    const { registry, store } = await freshModules();
    const expiresAt = Date.now() + 60_000;
    await store.addChatGrant('a1', 'oc_1', 'ou_g', 3, expiresAt);
    expect(readConfig().grantExpiryState).toEqual({ 'chat:oc_1:ou_g': { expiresAt } });
    expect(registry.getBot('a1').config.grantExpiryState).toEqual({ 'chat:oc_1:ou_g': { expiresAt } });
    await store.addChatGrant('a1', 'oc_1', 'ou_g', 3);
    expect(readConfig().grantExpiryState).toBeUndefined();
    expect(registry.getBot('a1').config.grantExpiryState).toBeUndefined();
  });

  it('expired cleanup is conditional and cannot remove a freshly renewed grant', async () => {
    writeConfig({ allowedUsers: ['ou_owner'] });
    const { registry, store } = await freshModules();
    const expiredAt = Date.now() - 1;
    await store.addChatGrant('a1', 'oc_1', 'ou_g', 3, expiredAt);
    const renewedAt = Date.now() + 60_000;
    await store.addChatGrant('a1', 'oc_1', 'ou_g', 3, renewedAt);
    expect(await store.removeExpiredGrant('a1', 'chat', 'oc_1', 'ou_g', expiredAt))
      .toEqual({ ok: true, removed: false });
    expect(registry.getBot('a1').config.chatGrants).toEqual({ oc_1: ['ou_g'] });
    expect(await store.removeExpiredGrant('a1', 'chat', 'oc_1', 'ou_g', renewedAt, renewedAt))
      .toEqual({ ok: true, removed: true });
    expect(readConfig().chatGrants).toEqual({});
    expect(readConfig().quotaState).toBeUndefined();
    expect(readConfig().grantExpiryState).toBeUndefined();
  });

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

  it('consumeQuota(expiredGrant) current expiry <= now: atomically clears membership+quota+expiry AND falls to default', async () => {
    // codex delta round-5: oncall ∩ 过期 chatGrant。清理+额度决策收口进 consumeQuota 同一把锁。
    // CAS 命中(磁盘 expiry==observed 且过期) → 原子清「成员+quota+expiry」+ 回落 default {7,1}。
    // 断言成员被删（否则重启当永久授权=提权）+ 陈旧 {2,2} 不再误拒。
    const qk = 'chat:oc_1:ou_x';
    writeConfig({
      allowedUsers: ['ou_owner'],
      chatGrants: { oc_1: ['ou_x'] },
      quotaState: { [qk]: { limit: 2, used: 2 } },              // 陈旧已耗尽
      grantExpiryState: { [qk]: { expiresAt: 1000 } },          // 已过期
    });
    const { registry, store } = await freshModules();
    const r = await store.consumeQuota('a1', qk, 7, { scope: 'chat', chatId: 'oc_1', openId: 'ou_x', now: 5000 });
    expect(r).toMatchObject({ tracked: true, allow: true, used: 1, limit: 7 }); // 回落 default，不再看到 {2,2}
    expect(readConfig().chatGrants).toEqual({});                 // 成员原子清掉（磁盘）
    expect(registry.getBot('a1').config.chatGrants).toEqual({}); // 内存一致
    expect(readConfig().grantExpiryState).toBeUndefined();
    expect(readConfig().quotaState).toEqual({ [qk]: { limit: 7, used: 1 } });
  });

  it('consumeQuota(expiredGrant) renewed-to-UNLIMITED (future expiry, still member): stays unlimited, def NOT applied', async () => {
    // codex delta round-5 关键角落：evaluate 观察到旧 expiry→给 expiredGrantCleanup(observed=1000)，
    // 但 owner 并发把 grant 续成永久/不限（清 quota + 清 expiry）。锁内 CAS 用旧 observed 不命中当前
    //（当前 expiry 已 undefined）→ grant 仍 live → **绝不兜 default**：无 quota 记录 → tracked:false 不限。
    const qk = 'chat:oc_1:ou_x';
    writeConfig({
      allowedUsers: ['ou_owner'],
      chatGrants: { oc_1: ['ou_x'] },
      // 续期为永久不限后的磁盘态：无 quota 记录、无 expiry 记录
    });
    const { store } = await freshModules();
    const r = await store.consumeQuota('a1', qk, 7, { scope: 'chat', chatId: 'oc_1', openId: 'ou_x', now: 5000 });
    expect(r).toMatchObject({ tracked: false, allow: true });    // 保持不限，未被 def=7 套回
    expect(readConfig().quotaState).toBeUndefined();             // 没被 lazy-init 成 {7,1}
    expect(readConfig().chatGrants).toEqual({ oc_1: ['ou_x'] }); // live 成员保留（续期未过期，不误清）
  });

  it('consumeQuota(expiredGrant) renewed-to-FINITE-N (future expiry): consumes existing record, def NOT applied', async () => {
    // 续期为「有限 N」：expiry 变新 + quota 记录重置。旧 observed CAS 不命中 → 按现有 {5,1} 记录消费，
    // 不兜 default（不会把 5 覆盖成 7）。
    const qk = 'chat:oc_1:ou_x';
    writeConfig({
      allowedUsers: ['ou_owner'],
      chatGrants: { oc_1: ['ou_x'] },
      quotaState: { [qk]: { limit: 5, used: 1 } },               // 续期后的新有限记录
      grantExpiryState: { [qk]: { expiresAt: 99999 } },          // 续期到未来
    });
    const { store } = await freshModules();
    const r = await store.consumeQuota('a1', qk, 7, { scope: 'chat', chatId: 'oc_1', openId: 'ou_x', now: 5000 });
    expect(r).toMatchObject({ tracked: true, allow: true, used: 2, limit: 5 }); // 消费现有 {5}，非 7
    expect(readConfig().grantExpiryState).toEqual({ [qk]: { expiresAt: 99999 } }); // 新 expiry 未动
  });

  it('consumeQuota(expiredGrant) grant ALREADY CLEANED (member absent, no expiry) + no rec → falls to default {7,1}', async () => {
    // codex delta round-6：CAS miss 的第三态——过期 grant 已被别处整条清（revoke / 另一清理者）。
    // 此时用户已非成员 = 只是普通 oncall 访客，本条必须按 oncall default 计数，绝不能误判「不限」放行免费。
    const qk = 'chat:oc_1:ou_x';
    writeConfig({
      allowedUsers: ['ou_owner'],
      // 无 chatGrants 成员、无 quota、无 expiry（整条已被清）
    });
    const { store } = await freshModules();
    const r = await store.consumeQuota('a1', qk, 7, { scope: 'chat', chatId: 'oc_1', openId: 'ou_x', now: 5000 });
    expect(r).toMatchObject({ tracked: true, allow: true, used: 1, limit: 7 }); // 回落 oncall default，非免费不限
    expect(readConfig().quotaState).toEqual({ [qk]: { limit: 7, used: 1 } });
  });

  it('consumeQuota(expiredGrant) member absent + existing oncall rec → normal increment (not reset)', async () => {
    // 同第三态，但已有 oncall counter：按现有记录正常递增，不因陈旧 descriptor 重置/误判不限。
    const qk = 'chat:oc_1:ou_x';
    writeConfig({
      allowedUsers: ['ou_owner'],
      quotaState: { [qk]: { limit: 7, used: 3 } },  // 已有 oncall 计数，非成员（无 chatGrants）
    });
    const { store } = await freshModules();
    const r = await store.consumeQuota('a1', qk, 7, { scope: 'chat', chatId: 'oc_1', openId: 'ou_x', now: 5000 });
    expect(r).toMatchObject({ tracked: true, allow: true, used: 4, limit: 7 }); // 正常 +1
  });

  it('consumeQuota(expiredGrant) current expiry != observed but ALSO expired + stale exhausted rec → cleans + default {7,1} (NOT wrongly rejected)', async () => {
    // codex delta round-7：descriptor observed=1000，但锁内当前 expiry 已换成 2000（也 <= now）、
    // 仍是成员、残留已耗尽 {2,2}。清理决策以**当前 expiry <= now** 为准（不再严格 CAS 等于 observed），
    // 否则陈旧 {2,2} 会误拒本条合法 oncall 消息（+误发已用尽通知）——正是 round-3 要消除的窗口。
    const qk = 'chat:oc_1:ou_x';
    writeConfig({
      allowedUsers: ['ou_owner'],
      chatGrants: { oc_1: ['ou_x'] },                     // 仍是成员
      quotaState: { [qk]: { limit: 2, used: 2 } },        // 陈旧已耗尽
      grantExpiryState: { [qk]: { expiresAt: 2000 } },    // 当前 expiry != observed(1000)，但也已过期
    });
    const { registry, store } = await freshModules();
    const r = await store.consumeQuota('a1', qk, 7, { scope: 'chat', chatId: 'oc_1', openId: 'ou_x', now: 5000 });
    // 本条即清三样并回落 default，绝不被陈旧 {2,2} 误拒
    expect(r).toMatchObject({ tracked: true, allow: true, used: 1, limit: 7 });
    expect(readConfig().chatGrants).toEqual({});                 // 成员清掉（磁盘）
    expect(registry.getBot('a1').config.chatGrants).toEqual({}); // 内存一致
    expect(readConfig().quotaState).toEqual({ [qk]: { limit: 7, used: 1 } });
    expect(readConfig().grantExpiryState).toBeUndefined();
  });

  it('consumeQuota(expiredGrant) current expiry in the FUTURE (renewed) + no rec → stays unlimited (live, def NOT applied)', async () => {
    // 对照：当前 expiry 在未来 = 已续期 live → 不清、不兜 default，无记录保持不限。
    const qk = 'chat:oc_1:ou_x';
    writeConfig({
      allowedUsers: ['ou_owner'],
      chatGrants: { oc_1: ['ou_x'] },
      grantExpiryState: { [qk]: { expiresAt: 99999 } },   // 续期到未来
    });
    const { store } = await freshModules();
    const r = await store.consumeQuota('a1', qk, 7, { scope: 'chat', chatId: 'oc_1', openId: 'ou_x', now: 5000 });
    expect(r).toMatchObject({ tracked: false, allow: true });    // live 续期，保持不限
    expect(readConfig().chatGrants).toEqual({ oc_1: ['ou_x'] }); // 成员保留（未误清）
    expect(readConfig().grantExpiryState).toEqual({ [qk]: { expiresAt: 99999 } });
  });

  it('removeExpiredGrant standalone still atomically clears finite/unlimited (grantNotExpired path)', async () => {
    // pure chatGrant/globalGrant 过期走 grantNotExpired→removeExpiredGrant（fire-and-forget）。
    // 该 API 未变，仍原子清「成员+quota+expiry」，CAS 保护。
    const qk = 'chat:oc_1:ou_y';
    writeConfig({
      allowedUsers: ['ou_owner'],
      chatGrants: { oc_1: ['ou_y'] },
      quotaState: { [qk]: { limit: 2, used: 2 } },
      grantExpiryState: { [qk]: { expiresAt: 1000 } },
    });
    const { store } = await freshModules();
    expect(await store.removeExpiredGrant('a1', 'chat', 'oc_1', 'ou_y', 1000, 5000))
      .toEqual({ ok: true, removed: true });
    expect(readConfig().chatGrants).toEqual({});
    expect(readConfig().quotaState).toBeUndefined();
    expect(readConfig().grantExpiryState).toBeUndefined();
    // CAS no-op 反向保护：旧 observed 不误删续期授权
    writeConfig({ allowedUsers: ['ou_owner'], chatGrants: { oc_2: ['ou_z'] }, grantExpiryState: { 'chat:oc_2:ou_z': { expiresAt: 9999 } } });
    const { store: store2 } = await freshModules();
    expect(await store2.removeExpiredGrant('a1', 'chat', 'oc_2', 'ou_z', 1000, 5000))
      .toEqual({ ok: true, removed: false });
    expect(readConfig().chatGrants).toEqual({ oc_2: ['ou_z'] });
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
