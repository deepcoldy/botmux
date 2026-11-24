import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER_GROUP_FOLLOW_PRESETS } from '../src/dashboard/web/owner-group-follow-rules.js';
import { createOwnerGroupFollower, OwnerGroupFollowError, type OwnerGroupFollowContext, type OwnerGroupFollowIssue } from '../src/services/owner-group-follow.js';
import { OwnerGroupFollowStore } from '../src/services/owner-group-follow-store.js';
import {
  evaluateOwnerGroupFollowFilter, matchesOwnerGroupFollowRule, normalizeOwnerGroupFollowConfig,
  notifyOwnerGroupFollowChanged, validateOwnerGroupFollowRule, type OwnerGroupFollowRule,
} from '../src/services/owner-group-follow-policy.js';
import type { OwnerFollowChatItem } from '../src/services/owner-group-follow-runtime.js';

const includeAlert = { field: 'name', op: 'contains', pattern: 'alert' } satisfies OwnerGroupFollowRule;
const excludeClosed = { field: 'any', op: 'contains', pattern: '[已关单]' } satisfies OwnerGroupFollowRule;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe('owner group follow', () => {
  let dir: string;
  const followers: Array<ReturnType<typeof createOwnerGroupFollower>> = [];
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    dir = mkdtempSync(join(tmpdir(), 'owner-follow-'));
  });
  afterEach(() => {
    followers.splice(0).forEach(f => f.stop());
    vi.useRealTimers(); rmSync(dir, { recursive: true, force: true });
  });
  function harness() {
    let context: OwnerGroupFollowContext = { ownerOpenId: 'ou_owner', brand: 'feishu', config: { enabled: true } };
    let chats: (string | OwnerFollowChatItem)[] = ['oc_old'];
    let botChats: string[] = [];
    const token = vi.fn(async (owner: string, _signal: AbortSignal): Promise<string | null> => `token:${owner}`);
    const listChats = vi.fn(async (_token: string, _signal: AbortSignal) => [...chats]);
    const listBotChats = vi.fn(async (_signal: AbortSignal) => [...botChats]);
    const invite = vi.fn(async (chatId: string, _token: string, _signal: AbortSignal) => { botChats.push(chatId); });
    const notify = vi.fn(async (_owner: string, _chat?: string, _issue?: OwnerGroupFollowIssue) => {});
    const deps = { appId: 'cli_follow', dataDir: dir, context: () => context, token, listChats, listBotChats, invite,
      notify: (owner: string, chat: string | undefined, issue: OwnerGroupFollowIssue | undefined, _current: () => boolean) =>
        issue ? notify(owner, chat, issue) : notify(owner, chat), log: vi.fn() };
    const follower = createOwnerGroupFollower(deps); followers.push(follower);
    const store = new OwnerGroupFollowStore(dir, deps.appId);
    return {
      follower, store, deps, token, listChats, listBotChats, invite, notify,
      context: () => context,
      setContext(value: OwnerGroupFollowContext, notifyChange = false) { context = value; if (notifyChange) notifyOwnerGroupFollowChanged(deps.appId); },
      chats(value: (string | OwnerFollowChatItem)[]) { chats = value; }, bots(value: string[]) { botChats = value; },
      async scan(seconds = 60) { vi.setSystemTime(Date.now() + seconds * 1000); await follower.tick(); },
    };
  }

  it('defaults off without reading tokens or creating a journal', async () => {
    const h = harness(); h.setContext({ ownerOpenId: 'ou_owner', brand: 'feishu' });
    await h.scan();
    expect(h.token).not.toHaveBeenCalled(); expect(h.listBotChats).not.toHaveBeenCalled();
    expect(h.invite).not.toHaveBeenCalled(); expect(existsSync(h.store.path)).toBe(false);
  });
  it('requires an owner, and uses only that person when authorization is missing', async () => {
    const h = harness(); h.setContext({ brand: 'feishu', config: { enabled: true } });
    await h.scan(); expect(h.token).not.toHaveBeenCalled();
    h.setContext({ ownerOpenId: 'ou_owner', brand: 'feishu', config: { enabled: true } });
    h.token.mockResolvedValue(null);
    await h.scan(); await h.scan();
    expect(h.token.mock.calls.every(call => call[0] === 'ou_owner')).toBe(true);
    expect(h.notify).toHaveBeenCalledTimes(1); expect(h.listChats).not.toHaveBeenCalled();
    h.token.mockResolvedValue('restored'); await h.scan();
    expect(h.store.read()?.initialized).toBe(true); expect(h.invite).not.toHaveBeenCalled();
  });
  it('baselines existing chats then invites only a newly joined group with fresh owner credentials', async () => {
    const h = harness(); await h.scan(); expect(h.invite).not.toHaveBeenCalled();
    h.chats(['oc_old', 'oc_new']); await h.scan();
    expect(h.invite).toHaveBeenCalledTimes(1);
    expect(h.invite).toHaveBeenCalledWith('oc_new', 'token:ou_owner', expect.any(AbortSignal));
    expect(h.token).toHaveBeenCalledTimes(3);
    await h.scan(); expect(h.invite).toHaveBeenCalledTimes(1);
  });
  it('invites every eligible new chat while advancing the round revision through its own writes', async () => {
    const h = harness(); await h.scan();
    h.chats(['oc_old', 'oc_new_a', 'oc_new_b']); await h.scan();
    expect(h.invite.mock.calls.map(call => call[0])).toEqual(['oc_new_a', 'oc_new_b']);
    expect(h.store.read()?.entries.oc_new_a.status).toBe('joined');
    expect(h.store.read()?.entries.oc_new_b.status).toBe('joined');
  });
  it('does not turn a failed listing into a baseline or invite from it', async () => {
    const h = harness(); await h.scan();
    h.chats(['oc_old', 'oc_new']); h.listChats.mockRejectedValueOnce(new Error('page failed'));
    await h.scan(); expect(h.store.read()?.knownChatIds).toEqual(['oc_old']);
    expect(h.invite).not.toHaveBeenCalled(); await h.scan(); expect(h.invite).toHaveBeenCalledTimes(1);
  });
  it('does not invite or consume an attempt when authorization is revoked after listing', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    h.token.mockResolvedValueOnce('scan-token').mockResolvedValueOnce(null);
    await h.scan();
    expect(h.invite).not.toHaveBeenCalled();
    expect(h.store.read()?.entries.oc_new).toEqual({ status: 'pending', attempts: 0 });
    expect(h.notify).toHaveBeenCalledWith('ou_owner', undefined);
  });
  it('uses a rotated credential for the invitation rather than the earlier listing credential', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    h.token.mockResolvedValueOnce('scan-token').mockResolvedValueOnce('rotated-token');
    await h.scan();
    expect(h.listChats).toHaveBeenLastCalledWith('scan-token', expect.any(AbortSignal));
    expect(h.invite).toHaveBeenCalledWith('oc_new', 'rotated-token', expect.any(AbortSignal));
  });
  it('requires a successful bot membership snapshot before inviting', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    h.listBotChats.mockRejectedValueOnce(new Error('cannot list bot chats'));
    await h.scan(); expect(h.invite).not.toHaveBeenCalled();
    expect(h.store.read()?.knownChatIds).toEqual(['oc_old']);
    h.bots(['oc_new']); await h.scan(); expect(h.invite).not.toHaveBeenCalled();
  });
  it('excludes groups and does not backfill them after an exclusion is removed', async () => {
    const h = harness(); await h.scan();
    h.setContext({ ...h.context(), config: { enabled: true, excludeChatIds: ['oc_skip'] } }, true);
    h.chats(['oc_old', 'oc_skip', 'oc_new']); await h.scan();
    expect(h.invite.mock.calls.map(call => call[0])).toEqual(['oc_new']);
    h.setContext({ ...h.context(), config: { enabled: true } }, true);
    await h.scan(); expect(h.invite).toHaveBeenCalledTimes(1);
  });
  it('keeps all observed IDs without persisting metadata or backfilling after rules are relaxed', async () => {
    const h = harness();
    h.setContext({ ...h.context(), config: { enabled: true, includeRules: [includeAlert], excludeRules: [excludeClosed] } });
    await h.scan();
    h.chats([
      'oc_old',
      { chatId: 'oc_skipped', name: 'Private regular group', description: 'Private description' },
      { chatId: 'oc_closed', name: 'Private ALERT from yesterday', description: 'Private [已关单] note' },
      { chatId: 'oc_followed', name: 'Private ALERT of today', description: 'Private incident details' },
    ]);
    await h.scan();
    expect(h.invite.mock.calls.map(call => call[0])).toEqual(['oc_followed']);
    expect(h.store.read()?.knownChatIds).toEqual(['oc_old', 'oc_skipped', 'oc_closed', 'oc_followed']);
    expect(Object.keys(h.store.read()!.entries)).toEqual(['oc_followed']);
    expect(readFileSync(h.store.path, 'utf8')).not.toMatch(/Private|"name"|"description"/);
    h.setContext({ ...h.context(), config: { enabled: true } }, true);
    await h.scan();
    expect(h.invite).toHaveBeenCalledTimes(1);
  });
  it('uses only the first occurrence for filtering, invitation rechecks and the snapshot', async () => {
    const h = harness();
    h.setContext({ ...h.context(), config: { enabled: true, includeRules: [includeAlert] } });
    await h.scan();
    h.chats([
      'oc_old',
      { chatId: 'oc_first_match', name: 'Service alert' },
      { chatId: 'oc_first_skip', name: 'Daily chat' },
      { chatId: 'oc_first_match', name: 'Daily chat' },
      { chatId: 'oc_first_skip', name: 'Service alert' },
    ]);
    await h.scan();
    expect(h.invite.mock.calls.map(([chatId]) => chatId)).toEqual(['oc_first_match']);
    expect(h.store.read()?.knownChatIds).toEqual(['oc_old', 'oc_first_match', 'oc_first_skip']);
    expect(h.store.read()?.entries.oc_first_match?.status).toBe('joined');
    expect(h.store.read()?.entries.oc_first_skip).toBeUndefined();
  });
  it.each([
    ['pending', new OwnerGroupFollowError(true)],
    ['inviting', new TypeError('connection closed')],
  ] as const)('cancels a %s invitation when a rule tightens, even after its retry window', async (status, error) => {
    const h = harness();
    await h.scan();
    h.chats(['oc_old', { chatId: 'oc_new', name: 'Unrelated group' }]);
    h.invite.mockRejectedValueOnce(error);
    await h.scan();
    expect(h.store.read()?.entries.oc_new.status).toBe(status);
    h.setContext({ ...h.context(), config: { enabled: true, includeRules: [includeAlert] } }, true);
    await h.scan(300);
    expect(h.store.read()?.entries.oc_new).toBeUndefined();
    expect(h.store.read()?.knownChatIds).toContain('oc_new');
    h.setContext({ ...h.context(), config: { enabled: true } }, true);
    await h.scan();
    expect(h.invite).toHaveBeenCalledTimes(1);
  });
  it('records actual membership even when an uncertain invitation becomes ineligible, then detects removal', async () => {
    const h = harness();
    await h.scan();
    h.chats(['oc_old', { chatId: 'oc_new', name: 'Unrelated group' }]);
    h.invite.mockRejectedValueOnce(new TypeError('connection closed'));
    await h.scan();
    expect(h.store.read()?.entries.oc_new.status).toBe('inviting');
    h.bots(['oc_new']);
    h.setContext({ ...h.context(), config: { enabled: true, includeRules: [includeAlert] } }, true);
    await h.scan();
    expect(h.store.read()?.entries.oc_new).toEqual({ status: 'joined', attempts: 1 });
    h.bots([]);
    await h.scan();
    expect(h.store.read()?.entries.oc_new.status).toBe('removed');
    expect(h.invite).toHaveBeenCalledTimes(1);
  });
  it('reads current rules again after the fresh token resolves and before claiming an invitation', async () => {
    const h = harness();
    await h.scan();
    h.chats(['oc_old', { chatId: 'oc_new', name: 'Alert [已关单]' }]);
    const fresh = deferred<string>(), started = deferred<void>();
    h.token.mockResolvedValueOnce('scan-token')
      .mockImplementationOnce(async () => { started.resolve(); return fresh.promise; });
    const scan = h.scan();
    await started.promise;
    expect(h.store.read()?.entries.oc_new).toEqual({ status: 'pending', attempts: 0 });
    h.setContext({ ...h.context(), config: { enabled: true, excludeRules: [excludeClosed] } });
    fresh.resolve('fresh-token');
    await scan;
    expect(h.invite).not.toHaveBeenCalled();
    expect(h.store.read()?.entries.oc_new).toEqual({ status: 'pending', attempts: 0 });
    await h.scan();
    expect(h.store.read()?.entries.oc_new).toBeUndefined();
  });
  it('records a removal during an invitation and never overwrites it with the late success', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    const gate = deferred<void>(), started = deferred<void>();
    h.invite.mockImplementation(async () => { started.resolve(); await gate.promise; });
    const scan = h.scan(); await started.promise;
    h.store.removed('oc_new'); gate.resolve(); await scan;
    expect(h.store.read()?.entries.oc_new.status).toBe('removed');
    await h.scan(); expect(h.invite).toHaveBeenCalledTimes(1);
  });
  it('detects removal through a membership snapshot even if the push event was missed', async () => {
    const h = harness(); h.bots(['oc_old']); await h.scan(); h.bots([]); await h.scan();
    expect(h.store.read()?.entries.oc_old.status).toBe('removed');
    h.chats([]); await h.scan(); h.chats(['oc_old']); await h.scan();
    expect(h.invite).not.toHaveBeenCalled();
  });
  it('recovers a restart from the existing baseline without duplicating invitations', async () => {
    const h = harness(); await h.scan(); h.follower.stop();
    h.chats(['oc_old', 'oc_new']);
    const follower = createOwnerGroupFollower(h.deps); followers.push(follower);
    await follower.tick(); expect(h.invite).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 60_000); await follower.tick(); expect(h.invite).toHaveBeenCalledTimes(1);
  });
  it('reconciles an uncertain invitation against actual membership before retrying', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    const epoch = h.store.read()!.epoch;
    h.store.observe(epoch, ['oc_old', 'oc_new'], new Set(), new Set());
    expect(h.store.claim(epoch, 'oc_new', Date.now())).toBeDefined();
    h.bots(['oc_new']); await h.scan(180);
    expect(h.store.read()?.entries.oc_new.status).toBe('joined'); expect(h.invite).not.toHaveBeenCalled();
  });
  it('bounds transient retries and sends a terminal failure notice once', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    h.invite.mockRejectedValue(new OwnerGroupFollowError(true));
    await h.scan(); await h.scan(); await h.scan(120); await h.scan(300);
    expect(h.invite).toHaveBeenCalledTimes(3); expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.store.read()?.entries.oc_new.status).toBe('failed');
  });
  it('keeps an uncertain invitation claimed until the 120-second reconciliation window', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    h.invite.mockRejectedValueOnce(new TypeError('fetch failed'));
    await h.scan();
    expect(h.store.read()?.entries.oc_new).toMatchObject({ status: 'inviting', attempts: 1 });
    await h.scan();
    expect(h.invite).toHaveBeenCalledTimes(1);
    expect(h.store.read()?.entries.oc_new.status).toBe('inviting');
    await h.scan();
    expect(h.invite).toHaveBeenCalledTimes(2);
    expect(h.store.read()?.entries.oc_new.status).toBe('joined');
  });
  it('stops retrying permanent permission failures', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    h.invite.mockRejectedValue(new OwnerGroupFollowError(false));
    await h.scan(); await h.scan(3600); expect(h.invite).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith('ou_owner', 'oc_new');
  });
  it('waits for approval without manufacturing a removal or repeating the application', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    h.invite.mockRejectedValueOnce(new OwnerGroupFollowError(false, false, { pendingApproval: true }));
    await h.scan(); await h.scan();
    expect(h.store.read()?.entries.oc_new.status).toBe('approval');
    expect(h.invite).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith('ou_owner', 'oc_new', { pendingApproval: true });
    h.bots(['oc_new']); await h.scan();
    expect(h.store.read()?.entries.oc_new.status).toBe('joined');
  });
  it('preserves a platform authorization remedy through the notification path', async () => {
    const h = harness();
    const issue = { authorizationSource: 'platform' as const, authorizeUrl: 'https://platform.example/credentials', guidance: 'Platform authorization missing' };
    h.token.mockRejectedValue(new OwnerGroupFollowError(true, true, issue));
    await h.scan();
    expect(h.notify).toHaveBeenCalledWith('ou_owner', undefined, issue);
    expect(h.listChats).not.toHaveBeenCalled();
  });
  it('pauses for authorization without spending the transient failure budget', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    h.invite.mockRejectedValueOnce(new OwnerGroupFollowError(true, true));
    await h.scan(); expect(h.store.read()?.entries.oc_new.attempts).toBe(0);
    await h.scan(300); expect(h.invite).toHaveBeenCalledTimes(2);
    expect(h.store.read()?.entries.oc_new.status).toBe('joined');
  });
  it('fences a late listing when the user switches the feature off', async () => {
    const h = harness(); await h.scan(); const gate = deferred<string[]>(), started = deferred<void>();
    h.listChats.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    const scan = h.scan(); await started.promise;
    h.setContext({ ...h.context(), config: undefined }, true); gate.resolve(['oc_old', 'oc_new']); await scan;
    expect(h.invite).not.toHaveBeenCalled(); expect(h.store.read()?.active).toBe(false);
  });
  it('establishes a fresh baseline after off/on even between two polling ticks', async () => {
    const h = harness(); await h.scan();
    h.setContext({ ...h.context(), config: undefined }, true);
    h.setContext({ ...h.context(), config: { enabled: true } }, true);
    h.chats(['oc_old', 'oc_while_off']); await h.scan(); expect(h.invite).not.toHaveBeenCalled();
    h.chats(['oc_old', 'oc_while_off', 'oc_new']); await h.scan();
    expect(h.invite.mock.calls.map(call => call[0])).toEqual(['oc_new']);
  });
  it('preserves the scoped journal while the owner is temporarily unresolved during tick', async () => {
    const h = harness(); await h.scan(); h.store.removed('oc_old');
    h.setContext({ brand: 'feishu', config: { enabled: true } });
    await h.scan();
    expect(h.store.read()).toMatchObject({
      scope: 'feishu:ou_owner', active: true, initialized: true, knownChatIds: ['oc_old'],
      entries: { oc_old: { status: 'removed' } },
    });
    h.setContext({ ownerOpenId: 'ou_owner', brand: 'feishu', config: { enabled: true } });
    await h.scan();
    h.chats([]); await h.scan();
    h.chats(['oc_old']); await h.scan();
    expect(h.invite).not.toHaveBeenCalled();
    expect(h.store.read()?.entries.oc_old.status).toBe('removed');
  });
  it('changed() aborts an in-flight scan without replacing the journal when owner resolution is temporarily empty', async () => {
    const h = harness(); await h.scan(); h.store.removed('oc_old');
    const epoch = h.store.read()!.epoch;
    const gate = deferred<string[]>(), started = deferred<void>();
    h.listChats.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    const scan = h.scan(); await started.promise;
    h.setContext({ brand: 'feishu', config: { enabled: true } }, true);
    gate.resolve(['oc_old', 'oc_new']); await scan;
    expect(h.invite).not.toHaveBeenCalled();
    expect(h.store.read()).toMatchObject({
      scope: 'feishu:ou_owner', active: true, initialized: true,
      entries: { oc_old: { status: 'removed' } },
    });
    expect(h.store.read()?.epoch).not.toBe(epoch);
  });
  it('still resets the journal when the owner changes to a different resolved identity', async () => {
    const h = harness(); await h.scan(); h.store.removed('oc_old');
    h.setContext({ ownerOpenId: 'ou_new_owner', brand: 'feishu', config: { enabled: true } }, true);
    expect(h.store.read()).toMatchObject({ scope: 'feishu:ou_new_owner', initialized: false, entries: {} });
  });
  it('does not use credentials from a previous owner after ownership changes during a wait', async () => {
    const h = harness(); const gate = deferred<string | null>(), started = deferred<void>();
    h.token.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    const scan = h.scan(); await started.promise;
    h.setContext({ ...h.context(), ownerOpenId: 'ou_new_owner' }); gate.resolve('old-owner-token'); await scan;
    expect(h.listChats).not.toHaveBeenCalled(); await h.scan();
    expect(h.token).toHaveBeenLastCalledWith('ou_new_owner', expect.any(AbortSignal));
    expect(h.store.read()?.scope).toBe('feishu:ou_new_owner'); expect(h.invite).not.toHaveBeenCalled();
  });
  it('does not overlap polling ticks while an invitation is waiting', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    const gate = deferred<void>(), started = deferred<void>();
    h.invite.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    const scan = h.scan(); await started.promise;
    await h.scan(180); expect(h.invite).toHaveBeenCalledTimes(1); gate.resolve(); await scan;
  });
  it('uses a durable claim to avoid a second invitation by an overlapping daemon', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    const gate = deferred<void>(), started = deferred<void>();
    h.invite.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    const scan = h.scan(); await started.promise;
    const second = createOwnerGroupFollower(h.deps); followers.push(second);
    await second.tick(); expect(h.invite).toHaveBeenCalledTimes(1); gate.resolve(); await scan;
  });
  it('finishes an exhausted unknown attempt after restart instead of leaving it stuck', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    const epoch = h.store.read()!.epoch;
    h.store.observe(epoch, ['oc_old', 'oc_new'], new Set(), new Set());
    h.store.claim(epoch, 'oc_new', Date.now());
    h.store.update(epoch, state => { state.entries.oc_new.attempts = 3; });
    await h.scan(180); expect(h.store.read()?.entries.oc_new.status).toBe('failed');
    expect(h.notify).toHaveBeenCalledWith('ou_owner', 'oc_new'); expect(h.invite).not.toHaveBeenCalled();
  });
  it('rejects a stale membership snapshot after another daemon settles a new invitation', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    const gate = deferred<string[]>(), started = deferred<void>();
    h.listBotChats.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    const olderScan = h.scan(); await started.promise;
    const second = createOwnerGroupFollower(h.deps); followers.push(second);
    await second.tick(); expect(h.store.read()?.entries.oc_new.status).toBe('joined');
    gate.resolve([]); await olderScan;
    expect(h.store.read()?.entries.oc_new.status).toBe('joined');
    expect(h.invite).toHaveBeenCalledTimes(1);
  });
  it('does not claim from a round after another daemon advances its observed revision', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    const fresh = deferred<string>(), freshStarted = deferred<void>();
    h.token.mockImplementationOnce(async () => 'scan-token')
      .mockImplementationOnce(async () => { freshStarted.resolve(); return fresh.promise; });
    const olderScan = h.scan(); await freshStarted.promise;
    expect(h.store.read()?.entries.oc_new.status).toBe('pending');
    const second = createOwnerGroupFollower({
      ...h.deps,
      listChats: vi.fn(async () => ['oc_old']),
    });
    followers.push(second);
    await second.tick();
    expect(h.store.read()?.knownChatIds).toEqual(['oc_old']);
    fresh.resolve('fresh-token'); await olderScan;
    expect(h.invite).not.toHaveBeenCalled();
    expect(h.store.read()?.entries.oc_new.status).toBe('pending');
  });
  it('cancels a pending invitation when its group is excluded, without reviving it later', async () => {
    const h = harness(); await h.scan(); h.chats(['oc_old', 'oc_new']);
    h.invite.mockRejectedValueOnce(new OwnerGroupFollowError(true)); await h.scan();
    h.setContext({ ...h.context(), config: { enabled: true, excludeChatIds: ['oc_new'] } }, true); await h.scan();
    h.setContext({ ...h.context(), config: { enabled: true } }, true); await h.scan(300);
    expect(h.invite).toHaveBeenCalledTimes(1);
  });
  it('stops outstanding token waits and does not start new work after shutdown', async () => {
    const h = harness(); const gate = deferred<string | null>(), started = deferred<void>();
    h.token.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    const scan = h.scan(); await started.promise; h.follower.stop(); gate.resolve('late'); await scan;
    await h.scan(); expect(h.listChats).not.toHaveBeenCalled(); expect(h.token).toHaveBeenCalledTimes(1);
  });
});

describe('owner follow policy validation', () => {
  it('normalizes disabled/default values while preserving exclusions', () => {
    expect(normalizeOwnerGroupFollowConfig(undefined)).toBeUndefined();
    expect(normalizeOwnerGroupFollowConfig({ enabled: false, pollIntervalSeconds: 60 })).toBeUndefined();
    expect(normalizeOwnerGroupFollowConfig({ enabled: true, excludeChatIds: ['oc_a', 'oc_a'] }))
      .toEqual({ enabled: true, excludeChatIds: ['oc_a'] });
  });
  it.each([true, [], { enabled: 'true' }, { owner: 'ou_other' }, { excludeChatIds: ['ou_user'] }, { pollIntervalSeconds: 0 }]
    .map(value => ({ value })))
    ('rejects invalid settings rather than accidentally enabling: $value', ({ value }) => {
      expect(() => normalizeOwnerGroupFollowConfig(value)).toThrow();
    });
  it('normalizes include and exclude rules independently in input order, preserving pattern whitespace', () => {
    const exactCase = { ...includeAlert, caseSensitive: true };
    const literalWithSpaces = { ...excludeClosed, pattern: ' [已关单] ' };
    expect(normalizeOwnerGroupFollowConfig({
      enabled: true,
      includeRules: [{ ...includeAlert, caseSensitive: false }, exactCase, includeAlert],
      excludeRules: [literalWithSpaces, { ...literalWithSpaces, caseSensitive: false }, includeAlert],
    })).toEqual({ enabled: true, includeRules: [includeAlert, exactCase], excludeRules: [literalWithSpaces, includeAlert] });
    expect(normalizeOwnerGroupFollowConfig({ includeRules: [], excludeRules: [] })).toBeUndefined();
    expect(normalizeOwnerGroupFollowConfig({ includeRules: Array(50).fill(includeAlert) })).toEqual({ includeRules: [includeAlert] });
  });
  it.each([
    ['not a plain object', new (class { field = 'name'; op = 'contains'; pattern = 'alert'; })(), 'shape'],
    ['unknown attribute', { ...includeAlert, negate: true }, 'unknownField'],
    ['unknown field', { ...includeAlert, field: 'subject' }, 'field'],
    ['unknown op', { ...includeAlert, op: 'equals' }, 'op'],
    ['non-string pattern', { ...includeAlert, pattern: 5 }, 'empty'],
    ['empty pattern', { ...includeAlert, pattern: '' }, 'empty'],
    ['whitespace pattern', { ...includeAlert, pattern: '  \t ' }, 'empty'],
    ['long pattern', { ...includeAlert, pattern: 'a'.repeat(201) }, 'tooLong'],
    ['non-boolean case', { ...includeAlert, caseSensitive: 'yes' }, 'caseSensitive'],
    ['invalid regex', { ...includeAlert, op: 'regex', pattern: '[' }, 'invalidRegex'],
  ])('rejects %s in both rule lists', (_name, rule, error) => {
    expect(validateOwnerGroupFollowRule(rule)).toBe(error);
    for (const list of ['includeRules', 'excludeRules']) {
      expect(() => normalizeOwnerGroupFollowConfig({ [list]: [rule] })).toThrow(`${list}[0]`);
    }
  });
  it.each(['includeRules', 'excludeRules'])('rejects a non-list or oversized %s before deduplication', list => {
    expect(() => normalizeOwnerGroupFollowConfig({ [list]: includeAlert })).toThrow(list);
    expect(() => normalizeOwnerGroupFollowConfig({ [list]: Array(51).fill(includeAlert) })).toThrow(list);
  });
  it.each(['(\\w+)+', '(a|aa)+', '(.*a){10}', '(?:(\\w{1,3})){2,}', '(a)\\1', '(?<a>.)\\k<a>',
    '^.*Service[\\s\\S]*Alert[^]*Closed$', '^a?a?a?a?$',
    String.raw`\w+\d+\w+\d+\w+\d+\w+\d+!`,
    '(?:a)+(?:a)+(?:a)+(?:a)+(?:a)+(?:a)+b',
    String.raw`[^\n]*a[^\n]*a[^\n]*a[^\n]*a[^\n]*a[^\n]*ab`,
    '(?:a)?'.repeat(24) + 'a'.repeat(24),
    'a?[a]?'.repeat(12) + 'a'.repeat(24),
    String.raw`[\S]+x\D+y[\x00-\xff]+z`,
    'a?b'.repeat(9),
    '(a*a*)(a*a*)f',
    '(a*a*)(a*a*)(a*a*)(a*a*)f',
    'a*(a*b*)',
    'a*a*(a*b)',
    '(a*b*)?',
    '(a*b*){2}',
    '(a*b*){1}a*',
    'a*(a*|b)c*',
  ])
    ('rejects high-risk regex %s and skips evaluation if it was not normalized', pattern => {
      const rule = { ...includeAlert, op: 'regex', pattern } as const;
      expect(validateOwnerGroupFollowRule(rule)).toBe('unsafeRegex');
      expect(() => normalizeOwnerGroupFollowConfig({ includeRules: [rule] })).toThrow(/unsafe regular expression/);
      expect(matchesOwnerGroupFollowRule(rule, { name: 'aaaaa' })).toBe(false);
    });
  it.each([
    '\\(.*\\)', '[(|+?)]{2}', '\\\\1', '(?:bug){2}', '(?:bug|issue)$', '^(?:arg\\w+)?$', '.*outage.*|.*oncall.*',
    String.raw`(?:\d{2}:){2}\d{2}`, '(?:[0-9a-f]{4}-){3}', '(?:[A-Z]{2}-)+', '(?i:alert){2}',
    String.raw`\d+-\d+-\d+`, String.raw`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}`,
    '[0-9]+-[0-9]+-[0-9]+', 'a?b'.repeat(8) + '|' + 'c?d'.repeat(8), '(?:a??b){1}',
    '(a*b*){1}', 'a*(a*b){1}', '(a*|b)c*',
  ])
    ('accepts safe regex %s', pattern => {
      expect(validateOwnerGroupFollowRule({ ...includeAlert, op: 'regex', pattern })).toBeUndefined();
    });
  it('accepts every built-in preset and matches a scoped case-insensitive group', () => {
    for (const { rules } of OWNER_GROUP_FOLLOW_PRESETS) {
      for (const rule of rules) expect(validateOwnerGroupFollowRule(rule)).toBeUndefined();
    }
    expect(matchesOwnerGroupFollowRule({ ...includeAlert, op: 'regex', pattern: '(?i:alert){2}' }, { name: 'AlertALERT' })).toBe(true);
  });
});

describe('owner follow matching', () => {
  const operations = [
    ['contains', 'ALERT'], ['startsWith', 'ACTIVE'], ['endsWith', 'CHAT'], ['regex', '^ACTIVE.+CHAT$'],
  ] as const;
  const fields = ['name', 'description', 'any'] as const;
  it.each(fields.flatMap(field => operations.flatMap(([op, pattern]) => [false, true].map(caseSensitive => ({
    field, op, pattern, caseSensitive,
  })))))('matches $field with $op and caseSensitive=$caseSensitive', rule => {
    const match = (value: string) => {
      if (rule.field !== 'description') {
        expect(matchesOwnerGroupFollowRule(rule, { name: value, description: 'unrelated' })).toBe(!rule.caseSensitive || value.startsWith('ACTIVE'));
      }
      if (rule.field !== 'name') {
        expect(matchesOwnerGroupFollowRule(rule, { name: 'unrelated', description: value })).toBe(!rule.caseSensitive || value.startsWith('ACTIVE'));
      }
    };
    match('ACTIVE ALERT CHAT');
    match('active alert chat');
    expect(matchesOwnerGroupFollowRule(rule, { name: 'unrelated', description: 'unrelated' })).toBe(false);
  });
  it('uses only the selected field, handles missing metadata and safely skips invalid regex', () => {
    expect(matchesOwnerGroupFollowRule(includeAlert, { description: 'alert' })).toBe(false);
    expect(matchesOwnerGroupFollowRule({ ...includeAlert, field: 'description' }, { name: 'alert' })).toBe(false);
    expect(matchesOwnerGroupFollowRule({ ...includeAlert, field: 'any', pattern: 'ab' }, { name: 'a', description: 'b' })).toBe(false);
    expect(matchesOwnerGroupFollowRule({ ...includeAlert, op: 'regex', pattern: '^$' }, {})).toBe(true);
    expect(matchesOwnerGroupFollowRule({ ...includeAlert, op: 'regex', pattern: '[' }, {})).toBe(false);
  });
  it('does not match empty or whitespace-only patterns from unnormalized rules', () => {
    for (const [op] of operations) {
      for (const pattern of ['', ' \t ']) {
        expect(matchesOwnerGroupFollowRule({ field: 'any', op, pattern }, { name: pattern, description: pattern })).toBe(false);
      }
    }
  });
  it('rechecks a cached regex when its pattern or case setting changes', () => {
    const rule: OwnerGroupFollowRule = { ...includeAlert, op: 'regex' };
    expect(matchesOwnerGroupFollowRule(rule, { name: 'ALERT' })).toBe(true);
    rule.caseSensitive = true;
    expect(matchesOwnerGroupFollowRule(rule, { name: 'ALERT' })).toBe(false);
    rule.pattern = '[';
    expect(matchesOwnerGroupFollowRule(rule, { name: 'alert' })).toBe(false);
  });
  it('reports the first matching rule with chat ID and exclusion precedence', () => {
    const config = { excludeChatIds: ['oc_banned'], includeRules: [includeAlert, includeAlert], excludeRules: [includeAlert, excludeClosed] };
    expect(evaluateOwnerGroupFollowFilter(config, { chatId: 'oc_banned', name: 'alert [已关单]' }))
      .toEqual({ matched: false, reason: 'excluded_chat_id' });
    expect(evaluateOwnerGroupFollowFilter(config, { name: 'alert [已关单]' }))
      .toEqual({ matched: false, reason: 'excluded_rule', ruleIndex: 0, rule: includeAlert });
    expect(evaluateOwnerGroupFollowFilter(config, { description: '[已关单]' }))
      .toEqual({ matched: false, reason: 'excluded_rule', ruleIndex: 1, rule: excludeClosed });
    expect(evaluateOwnerGroupFollowFilter({ includeRules: [excludeClosed, includeAlert, includeAlert] }, { name: 'alert' }))
      .toEqual({ matched: true, reason: 'included_rule', ruleIndex: 1, rule: includeAlert });
    expect(evaluateOwnerGroupFollowFilter(config, { name: 'general' })).toEqual({ matched: false, reason: 'not_included' });
    expect(evaluateOwnerGroupFollowFilter({ includeRules: [], excludeRules: [excludeClosed] }, {})).toEqual({ matched: true, reason: 'all' });
    expect(evaluateOwnerGroupFollowFilter(undefined, {})).toEqual({ matched: true, reason: 'all' });
  });
});
