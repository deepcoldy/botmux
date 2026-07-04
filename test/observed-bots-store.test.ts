import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  recordObservedBots,
  listObservedBots,
  type ObservedBot,
} from '../src/services/observed-bots-store.js';

let dataDir = '';

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-observed-bots-'));
});

afterEach(() => {
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
  }
});

const APP_A = 'cli_appA';
const APP_B = 'cli_appB';

describe('observed-bots-store', () => {
  it('returns empty list when no file exists', () => {
    const out = listObservedBots(dataDir, APP_A, 'oc_nonexistent');
    expect(out).toEqual([]);
  });

  it('records a single bot and reads it back', () => {
    const t = 1_700_000_000_000;
    recordObservedBots(
      dataDir,
      APP_A,
      'oc_chat1',
      [{ openId: 'ou_aaa', name: 'BotA' }],
      'introduce',
      t,
    );
    const out = listObservedBots(dataDir, APP_A, 'oc_chat1', undefined, t);
    expect(out).toEqual<ObservedBot[]>([
      { openId: 'ou_aaa', name: 'BotA', source: 'introduce', firstSeenAt: t, lastSeenAt: t },
    ]);
  });

  it('writes file at observed-bots-<larkAppId>-<chatId>.json (per observer x chat)', () => {
    recordObservedBots(dataDir, APP_A, 'oc_chat1', [{ openId: 'ou_aaa', name: 'BotA' }], 'introduce', 1);
    expect(existsSync(join(dataDir, `observed-bots-${APP_A}-oc_chat1.json`))).toBe(true);
    expect(existsSync(join(dataDir, `observed-bots-${APP_A}-oc_chat2.json`))).toBe(false);
    expect(existsSync(join(dataDir, `observed-bots-${APP_B}-oc_chat1.json`))).toBe(false);
  });

  it('does not leak entries across chats', () => {
    const t = 1_700_000_000_000;
    recordObservedBots(dataDir, APP_A, 'oc_chat1', [{ openId: 'ou_aaa', name: 'BotA' }], 'introduce', t);
    recordObservedBots(dataDir, APP_A, 'oc_chat2', [{ openId: 'ou_bbb', name: 'BotB' }], 'introduce', t);
    expect(listObservedBots(dataDir, APP_A, 'oc_chat1', undefined, t).map(b => b.openId)).toEqual(['ou_aaa']);
    expect(listObservedBots(dataDir, APP_A, 'oc_chat2', undefined, t).map(b => b.openId)).toEqual(['ou_bbb']);
  });

  it('does not leak entries across observer apps in the same chat (per-app open_id scoping)', () => {
    // Same chat, two daemons. Each daemon's mentions[] view contains the SAME
    // bot but with DIFFERENT open_ids (Lark open_id is per-app scoped). If
    // both wrote to one shared file, A could read B's self-view open_id and
    // @ B with the wrong id. The store must isolate per observer.
    const t = 1_700_000_000_000;
    recordObservedBots(dataDir, APP_A, 'oc_shared', [
      { openId: 'ou_B_as_seen_by_A', name: 'BotB' },
    ], 'introduce', t);
    recordObservedBots(dataDir, APP_B, 'oc_shared', [
      { openId: 'ou_B_as_seen_by_B', name: 'BotB' },
    ], 'introduce', t);

    expect(listObservedBots(dataDir, APP_A, 'oc_shared', undefined, t).map(b => b.openId)).toEqual(['ou_B_as_seen_by_A']);
    expect(listObservedBots(dataDir, APP_B, 'oc_shared', undefined, t).map(b => b.openId)).toEqual(['ou_B_as_seen_by_B']);
  });

  it('upserts existing openId: preserves firstSeenAt, updates lastSeenAt and name', () => {
    recordObservedBots(dataDir, APP_A, 'oc_chat1', [{ openId: 'ou_aaa', name: 'OldName' }], 'introduce', 1_000);
    recordObservedBots(dataDir, APP_A, 'oc_chat1', [{ openId: 'ou_aaa', name: 'NewName' }], 'introduce', 2_000);
    const out = listObservedBots(dataDir, APP_A, 'oc_chat1', undefined, 2_000);
    expect(out).toEqual<ObservedBot[]>([
      { openId: 'ou_aaa', name: 'NewName', source: 'introduce', firstSeenAt: 1_000, lastSeenAt: 2_000 },
    ]);
  });

  it('records multiple bots in one call', () => {
    const t = 1_700_000_000_000;
    recordObservedBots(
      dataDir,
      APP_A,
      'oc_chat1',
      [
        { openId: 'ou_aaa', name: 'BotA' },
        { openId: 'ou_bbb', name: 'BotB' },
      ],
      'introduce',
      t,
    );
    const out = listObservedBots(dataDir, APP_A, 'oc_chat1', undefined, t).map(b => b.openId).sort();
    expect(out).toEqual(['ou_aaa', 'ou_bbb']);
  });

  it('filters out entries older than maxAgeMs', () => {
    const day = 24 * 60 * 60 * 1000;
    recordObservedBots(dataDir, APP_A, 'oc_chat1', [{ openId: 'ou_stale', name: 'Stale' }], 'introduce', 1_000);
    recordObservedBots(dataDir, APP_A, 'oc_chat1', [{ openId: 'ou_fresh', name: 'Fresh' }], 'introduce', 1_000 + 50 * day);

    const now = 1_000 + 50 * day;
    const out = listObservedBots(dataDir, APP_A, 'oc_chat1', 30 * day, now);
    expect(out.map(b => b.openId)).toEqual(['ou_fresh']);
  });

  it('default expiry is 30 days', () => {
    const day = 24 * 60 * 60 * 1000;
    recordObservedBots(dataDir, APP_A, 'oc_chat1', [{ openId: 'ou_stale', name: 'Stale' }], 'introduce', 1_000);
    const out = listObservedBots(dataDir, APP_A, 'oc_chat1', undefined, 1_000 + 31 * day);
    expect(out).toEqual([]);
  });

  it('skips entries with missing openId or name', () => {
    recordObservedBots(
      dataDir,
      APP_A,
      'oc_chat1',
      [
        { openId: 'ou_ok', name: 'Good' },
        { openId: '', name: 'NoId' },
        { openId: 'ou_noname', name: '' },
      ],
      'introduce',
      1_000,
    );
    const out = listObservedBots(dataDir, APP_A, 'oc_chat1', undefined, 1_000).map(b => b.openId).sort();
    expect(out).toEqual(['ou_ok']);
  });

  it('ignores corrupt JSON file (returns empty)', () => {
    writeFileSync(join(dataDir, `observed-bots-${APP_A}-oc_chat1.json`), '{not json');
    expect(listObservedBots(dataDir, APP_A, 'oc_chat1')).toEqual([]);
  });

  it('writes atomically via unique tmp + rename (no temp file left behind on success)', () => {
    recordObservedBots(dataDir, APP_A, 'oc_chat1', [{ openId: 'ou_aaa', name: 'A' }], 'introduce', 1);
    const fp = join(dataDir, `observed-bots-${APP_A}-oc_chat1.json`);
    expect(existsSync(fp)).toBe(true);
    // No .tmp leftover under any suffix variant
    const leftover = readdirSync(dataDir).filter(n => n.endsWith('.tmp'));
    expect(leftover).toEqual([]);
    // JSON shape sanity check
    const json = JSON.parse(readFileSync(fp, 'utf-8'));
    expect(json).toEqual({
      'ou_aaa': { name: 'A', source: 'introduce', firstSeenAt: 1, lastSeenAt: 1 },
    });
  });

  it('tmp file name is unique per call (pid + random) — avoids multi-process collision', () => {
    // Reach inside writeFile path by spying on the tmp basenames left behind
    // when we force-throw mid-rename. Simulating concurrent writes deterministically
    // is hard; assert at least that two back-to-back writes don't write to the
    // same tmp basename. We achieve this by creating an existing file with the
    // canonical tmp name and confirming writeAtomic still succeeds (proves it
    // used a different tmp).
    const existingTmp = join(dataDir, `observed-bots-${APP_A}-oc_chat1.json.tmp`);
    writeFileSync(existingTmp, 'placeholder — must not be clobbered/renamed');
    recordObservedBots(dataDir, APP_A, 'oc_chat1', [{ openId: 'ou_x', name: 'X' }], 'introduce', 1);
    // The pre-existing canonical tmp is untouched (because the store used a unique tmp)
    expect(readFileSync(existingTmp, 'utf-8')).toBe('placeholder — must not be clobbered/renamed');
    // Real file still written correctly
    const fp = join(dataDir, `observed-bots-${APP_A}-oc_chat1.json`);
    expect(JSON.parse(readFileSync(fp, 'utf-8'))).toMatchObject({ 'ou_x': { name: 'X' } });
  });

  it('no-op when called with empty bots array (does not create file)', () => {
    recordObservedBots(dataDir, APP_A, 'oc_chat1', [], 'introduce', 1);
    expect(existsSync(join(dataDir, `observed-bots-${APP_A}-oc_chat1.json`))).toBe(false);
  });

  it('replaces an old openId when the same name is observed with a new openId', () => {
    recordObservedBots(dataDir, APP_A, 'oc_chat1', [{ openId: 'ou_old', name: 'BotB' }], 'introduce', 1_000);
    recordObservedBots(dataDir, APP_A, 'oc_chat1', [{ openId: 'ou_new', name: 'BotB' }], 'introduce', 2_000);

    const out = listObservedBots(dataDir, APP_A, 'oc_chat1', undefined, 2_000);
    expect(out).toEqual<ObservedBot[]>([
      { openId: 'ou_new', name: 'BotB', source: 'introduce', firstSeenAt: 2_000, lastSeenAt: 2_000 },
    ]);

    const fp = join(dataDir, `observed-bots-${APP_A}-oc_chat1.json`);
    const json = JSON.parse(readFileSync(fp, 'utf-8'));
    expect(json).not.toHaveProperty('ou_old');
  });

  it('uses the last same-name entry within a single observed batch', () => {
    recordObservedBots(
      dataDir,
      APP_A,
      'oc_chat1',
      [
        { openId: 'ou_first', name: 'BotB' },
        { openId: 'ou_second', name: 'BotB' },
      ],
      'introduce',
      1_000,
    );

    const out = listObservedBots(dataDir, APP_A, 'oc_chat1', undefined, 1_000);
    expect(out.map(b => b.openId)).toEqual(['ou_second']);
  });
});
