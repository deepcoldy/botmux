/**
 * bot-admin-unions-store：每个 bot 用自己的凭证把管理员解析成 union_id 并发布，兄弟 bot
 * 按 allowedUsers 指纹读取——同机 bot 判「同一个 owner」的数据来源。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeBotAdminUnions,
  createBotAdminUnionsPublisher,
  readBotAdminUnions,
  writeBotAdminUnions,
} from '../src/services/bot-admin-unions-store.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-admin-unions-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('computeBotAdminUnions', () => {
  it('maps every admin form to union_id', async () => {
    const lookup = vi.fn(async (openId: string) => ({ ou_mail: 'on_mail', ou_lit: 'on_lit', ou_phone: 'on_phone' } as Record<string, string>)[openId]);
    const { snapshot, complete } = await computeBotAdminUnions(
      ['me@example.com', 'on_direct', 'ou_lit', '+86 138 0000 0000'],
      new Map([['me@example.com', 'ou_mail'], ['on_direct', 'ou_direct'], ['ou_lit', 'ou_lit'], ['+86 138 0000 0000', 'ou_phone']]),
      lookup,
    );
    expect(complete).toBe(true);
    expect(snapshot.exact).toBe(true);
    expect(snapshot.admins).toEqual(['on_mail', 'on_direct', 'on_lit', 'on_phone']);
    // on_ 本身就是 union_id，不必再查。
    expect(lookup).not.toHaveBeenCalledWith('ou_direct');
  });

  it('skips entries this app could not resolve (they are not effective admins)', async () => {
    const { snapshot, complete } = await computeBotAdminUnions(
      ['gone@example.com', 'on_invisible', 'on_kept'],
      new Map([['on_kept', 'ou_kept']]),
      async () => 'on_unexpected',
    );
    expect(complete).toBe(true);
    // 没解析出 ou_ 的条目本来就不是本 bot 的有效管理员，少了它们快照仍是准的。
    expect(snapshot.admins).toEqual(['on_kept']);
    expect(snapshot.exact).toBe(true);
  });

  it('a literal ou_ entry is used as-is even when the resolution map lacks it', async () => {
    const { snapshot } = await computeBotAdminUnions(['ou_only'], new Map(), async id => (id === 'ou_only' ? 'on_only' : undefined));
    expect(snapshot.admins).toEqual(['on_only']);
  });

  it('an effective admin without a union_id makes the snapshot inexact; only a transient miss is retried', async () => {
    const transient = await computeBotAdminUnions(['on_a', 'ou_b'], new Map([['on_a', 'ou_a'], ['ou_b', 'ou_b']]), async () => undefined);
    expect(transient.complete).toBe(false);
    expect(transient.snapshot).toMatchObject({ admins: ['on_a'], exact: false });
    const definitive = await computeBotAdminUnions(['on_a', 'ou_b'], new Map([['on_a', 'ou_a'], ['ou_b', 'ou_b']]), async () => null);
    expect(definitive.complete).toBe(true);
    expect(definitive.snapshot).toMatchObject({ admins: ['on_a'], exact: false });
  });
});

describe('readBotAdminUnions', () => {
  async function publish(appId: string, raw: string[], unions: Record<string, string>): Promise<void> {
    const { snapshot } = await computeBotAdminUnions(raw, new Map(raw.map(r => [r, `ou_${r}`])), async ou => unions[ou]);
    writeBotAdminUnions(dir, appId, snapshot);
  }

  it('returns the published admins while allowedUsers is unchanged', async () => {
    await publish('cli_a', ['me@example.com'], { 'ou_me@example.com': 'on_me' });
    const got = readBotAdminUnions(dir, 'cli_a', ['me@example.com']);
    expect(got?.exact).toBe(true);
    expect([...(got?.admins ?? [])]).toEqual(['on_me']);
  });

  it('a changed allowedUsers (not yet republished) reads as nothing', async () => {
    await publish('cli_a', ['me@example.com'], { 'ou_me@example.com': 'on_me' });
    expect(readBotAdminUnions(dir, 'cli_a', ['someone@example.com'])).toBeUndefined();
    // 指纹按原文顺序算，换顺序也要重新发布。
    await publish('cli_b', ['a@example.com', 'b@example.com'], { 'ou_a@example.com': 'on_a', 'ou_b@example.com': 'on_b' });
    expect(readBotAdminUnions(dir, 'cli_b', ['b@example.com', 'a@example.com'])).toBeUndefined();
  });

  it('a hand-edited snapshot whose admins contain non-union values is never read as exact', async () => {
    // 读侧会滤掉非 on_ 值；滤掉后集合变小却仍标 exact，会让兄弟判定在少算管理员的情况下放行。
    await publish('cli_a', ['me@example.com'], { 'ou_me@example.com': 'on_me' });
    const file = join(dir, 'bot-admin-unions', 'cli_a.json');
    const snap = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...snap, admins: ['on_me', 'ou_not_a_union'], exact: true }));
    const got = readBotAdminUnions(dir, 'cli_a', ['me@example.com']);
    expect(got?.exact).toBe(false);
    expect([...(got?.admins ?? [])]).toEqual(['on_me']);
  });

  it('missing, corrupt or unsafe-name snapshots read as nothing', () => {
    expect(readBotAdminUnions(dir, 'cli_none', ['me@example.com'])).toBeUndefined();
    mkdirSync(join(dir, 'bot-admin-unions'), { recursive: true });
    writeFileSync(join(dir, 'bot-admin-unions', 'cli_bad.json'), '{not json');
    expect(readBotAdminUnions(dir, 'cli_bad', ['me@example.com'])).toBeUndefined();
    expect(readBotAdminUnions(dir, '../escape', ['me@example.com'])).toBeUndefined();
  });

  it('empty current allowedUsers never yields admins', async () => {
    await publish('cli_open', [], {});
    expect(readBotAdminUnions(dir, 'cli_open', [])).toBeUndefined();
  });
});

describe('createBotAdminUnionsPublisher', () => {
  it('writes once per allowedUsers state, retries after a transient lookup failure, caches lookups', async () => {
    let raw = ['me@example.com'];
    let resolution = new Map([['me@example.com', 'ou_me']]);
    const results: Array<string | undefined> = [undefined, 'on_me'];
    const lookup = vi.fn(async () => results.shift());
    const publisher = createBotAdminUnionsPublisher({
      dataDir: dir,
      larkAppId: 'cli_pub',
      readState: () => ({ rawAllowedUsers: raw, resolution }),
      lookupUnion: lookup,
    });

    await publisher.publish();
    // 第一次查询瞬时失败：快照还不准，下次心跳会重试。
    expect(readBotAdminUnions(dir, 'cli_pub', raw)?.exact).toBe(false);
    await publisher.publish();
    expect(readBotAdminUnions(dir, 'cli_pub', raw)).toMatchObject({ exact: true, admins: new Set(['on_me']) });
    expect(lookup).toHaveBeenCalledTimes(2);

    // 状态没变：不再重算、不重写文件、不再查。
    const file = join(dir, 'bot-admin-unions', 'cli_pub.json');
    const before = readFileSync(file, 'utf-8');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    try {
      await publisher.publish();
    } finally {
      nowSpy.mockRestore();
    }
    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect(lookup).toHaveBeenCalledTimes(2);

    // 改了 owner：重新发布；同一个 ou_ 已缓存，新 ou_ 才查。
    raw = ['me@example.com', 'on_peer'];
    resolution = new Map([['me@example.com', 'ou_me'], ['on_peer', 'ou_peer']]);
    await publisher.publish();
    expect([...(readBotAdminUnions(dir, 'cli_pub', raw)?.admins ?? [])]).toEqual(['on_me', 'on_peer']);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('never rejects: a throwing readState is reported, and the next publish still runs', async () => {
    const onError = vi.fn();
    let broken = true;
    const publisher = createBotAdminUnionsPublisher({
      dataDir: dir,
      larkAppId: 'cli_err',
      readState: () => {
        if (broken) throw new Error('boom');
        return { rawAllowedUsers: ['on_me'], resolution: new Map([['on_me', 'ou_me']]) };
      },
      lookupUnion: async () => undefined,
      onError,
    });
    await expect(publisher.publish()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    broken = false;
    await publisher.publish();
    expect(readBotAdminUnions(dir, 'cli_err', ['on_me'])?.exact).toBe(true);
  });

  it('does nothing when the bot is gone', async () => {
    const publisher = createBotAdminUnionsPublisher({
      dataDir: dir, larkAppId: 'cli_gone', readState: () => undefined, lookupUnion: async () => 'on_x',
    });
    await publisher.publish();
    expect(readBotAdminUnions(dir, 'cli_gone', ['x'])).toBeUndefined();
  });
});
