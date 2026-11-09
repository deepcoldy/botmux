import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateSandboxConfigAtStartup, migrateSandboxConfigOnDisk } from '../src/services/sandbox-migration.js';
import { parseBotConfigsFromText } from '../src/bot-registry.js';
import { withFileLock } from '../src/utils/file-lock.js';

let dir: string;
let botsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sbx-mig-'));
  botsPath = join(dir, 'bots.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (entries: any[]) => writeFileSync(botsPath, JSON.stringify(entries, null, 2));
const read = () => JSON.parse(readFileSync(botsPath, 'utf-8'));

describe('migrateSandboxConfigOnDisk', () => {
  it('migrates legacy fields to sandboxPaths, KEEPS old fields, creates backup', async () => {
    write([{
      larkAppId: 'cli_a', larkAppSecret: 's',
      sandbox: true,
      sandboxReadonlyPaths: ['~/ref'],
      sandboxHidePaths: ['~/.ssh'],
      customUnknownField: { keep: 'me' },
    }]);
    const { migrated } = await migrateSandboxConfigOnDisk(botsPath);
    expect(migrated).toEqual(['cli_a']);
    const [e] = read();
    expect(e.sandbox).toBe(true);
    expect(e.sandboxPaths).toEqual({ readOnly: ['~/ref'], deny: ['~/.ssh'] });
    // old fields preserved for downgrade
    expect(e.sandboxReadonlyPaths).toEqual(['~/ref']);
    expect(e.sandboxHidePaths).toEqual(['~/.ssh']);
    // unknown fields survive the rewrite
    expect(e.customUnknownField).toEqual({ keep: 'me' });
    // backup created with the ORIGINAL (pre-migration) content
    const bak = `${botsPath}.bak-sandbox-v1`;
    expect(existsSync(bak)).toBe(true);
    expect(JSON.parse(readFileSync(bak, 'utf-8'))[0].sandboxPaths).toBeUndefined();
  });

  it('absorbs readIsolation:true into sandbox:true', async () => {
    write([{ larkAppId: 'cli_b', larkAppSecret: 's', readIsolation: true, readDenyExtraPaths: ['~/x'] }]);
    await migrateSandboxConfigOnDisk(botsPath);
    const [e] = read();
    expect(e.sandbox).toBe(true);
    expect(e.readIsolation).toBe(true); // kept for downgrade
    expect(e.sandboxPaths).toEqual({ deny: ['~/x'] });
  });

  it('is idempotent: second run migrates nothing and leaves the file unchanged', async () => {
    write([{ larkAppId: 'cli_a', larkAppSecret: 's', sandbox: true, sandboxHidePaths: ['~/.aws'] }]);
    await migrateSandboxConfigOnDisk(botsPath);
    const after1 = readFileSync(botsPath, 'utf-8');
    const { migrated } = await migrateSandboxConfigOnDisk(botsPath);
    expect(migrated).toEqual([]);
    expect(readFileSync(botsPath, 'utf-8')).toBe(after1);
  });

  it('does not touch entries with nothing to migrate (plain sandbox / no sandbox)', async () => {
    write([
      { larkAppId: 'cli_plain', larkAppSecret: 's', sandbox: true },
      { larkAppId: 'cli_none', larkAppSecret: 's' },
    ]);
    const { migrated } = await migrateSandboxConfigOnDisk(botsPath);
    expect(migrated).toEqual([]);
    expect(existsSync(`${botsPath}.bak-sandbox-v1`)).toBe(false);
    expect(read()[0].sandboxPaths).toBeUndefined();
  });

  it('never throws on malformed json (startup must not brick)', async () => {
    writeFileSync(botsPath, '{not json');
    const { migrated } = await migrateSandboxConfigOnDisk(botsPath);
    expect(migrated).toEqual([]);
  });

  it('backup is written only once (first migration wins)', async () => {
    write([{ larkAppId: 'cli_a', larkAppSecret: 's', sandbox: true, sandboxHidePaths: ['~/.aws'] }]);
    await migrateSandboxConfigOnDisk(botsPath);
    const bakContent = readFileSync(`${botsPath}.bak-sandbox-v1`, 'utf-8');
    // simulate a later legacy edit + re-migration
    const entries = read();
    entries.push({ larkAppId: 'cli_late', larkAppSecret: 's', readIsolation: true });
    write(entries);
    await migrateSandboxConfigOnDisk(botsPath);
    expect(readFileSync(`${botsPath}.bak-sandbox-v1`, 'utf-8')).toBe(bakContent);
  });
});

describe('migration output stays loadable under strict sandbox field validation (#2530)', () => {
  it.each([
    ['legacy deny', { sandbox: true, sandboxHidePaths: ['~/.ssh', null] }],
    ['legacy readOnly', { sandbox: true, sandboxReadonlyPaths: ['/srv/ro', 42] }],
    ['readDenyExtraPaths', { readIsolation: true, readDenyExtraPaths: ['~/x', 7] }],
  ])('sanitizes non-string legacy elements so the migrated file parses (%s)', async (_label, entry) => {
    write([{ larkAppId: 'cli_a', larkAppSecret: 's', name: 'a', ...entry }]);
    const { migrated } = await migrateSandboxConfigOnDisk(botsPath);
    expect(migrated).toEqual(['cli_a']);
    expect(() => parseBotConfigsFromText(readFileSync(botsPath, 'utf-8'))).not.toThrow();
  });

  it('re-migrates an already-persisted malformed sandboxPaths back into a loadable shape', async () => {
    // An older build wrote the raw, unsanitized migration output to disk.
    write([{
      larkAppId: 'cli_a', larkAppSecret: 's', name: 'a',
      sandbox: true,
      sandboxHidePaths: ['~/.ssh', null],
      sandboxPaths: { deny: ['~/.ssh', null] },
    }]);
    const { migrated } = await migrateSandboxConfigOnDisk(botsPath);
    expect(migrated).toEqual(['cli_a']);
    expect(() => parseBotConfigsFromText(readFileSync(botsPath, 'utf-8'))).not.toThrow();
    expect(read()[0].sandboxPaths).toEqual({ deny: ['~/.ssh'] });
  });

  it('drops a malformed sandboxPaths when every legacy element is non-string', async () => {
    // Nothing valid survives sanitization; the unloadable on-disk value must be
    // removed rather than left to reject the whole bots.json at next startup.
    write([{
      larkAppId: 'cli_a', larkAppSecret: 's', name: 'a',
      sandbox: true,
      sandboxHidePaths: [null, 42],
      sandboxPaths: { deny: [null, 42] },
    }]);
    const { migrated } = await migrateSandboxConfigOnDisk(botsPath);
    expect(migrated).toEqual(['cli_a']);
    expect(() => parseBotConfigsFromText(readFileSync(botsPath, 'utf-8'))).not.toThrow();
    expect(read()[0].sandboxPaths).toBeUndefined();
  });

  it('repairs a malformed on-disk tier in place without losing its valid entries', async () => {
    // No legacy source at all: the surviving string element must be kept —
    // repairing loadability must never widen the sandbox by dropping a deny.
    write([{
      larkAppId: 'cli_a', larkAppSecret: 's', name: 'a',
      sandbox: true,
      sandboxPaths: { deny: ['/srv/secret', null] },
    }]);
    await migrateSandboxConfigOnDisk(botsPath);
    const tiers = read()[0].sandboxPaths;
    expect(() => parseBotConfigsFromText(readFileSync(botsPath, 'utf-8'))).not.toThrow();
    expect(tiers.deny).toContain('/srv/secret');
    expect(tiers.deny).toEqual(['/srv/secret']);
  });

  it('keeps valid on-disk tiers authoritative; stale legacy only fills absent tiers', async () => {
    write([{
      larkAppId: 'cli_a', larkAppSecret: 's', name: 'a',
      sandbox: true,
      sandboxHidePaths: ['~/.ssh'], // retained-for-downgrade legacy, now stale
      sandboxPaths: { deny: ['/srv/secret', 42], readWrite: ['/srv/work'] },
    }]);
    await migrateSandboxConfigOnDisk(botsPath);
    const tiers = read()[0].sandboxPaths;
    expect(() => parseBotConfigsFromText(readFileSync(botsPath, 'utf-8'))).not.toThrow();
    // Monotonicity: every valid on-disk entry survives the repair.
    expect(tiers.deny).toEqual(['/srv/secret']);
    expect(tiers.readWrite).toEqual(['/srv/work']);
    // Stale legacy must not overwrite an existing on-disk tier.
    expect(tiers.deny).not.toContain('~/.ssh');
  });

  it('fills an absent on-disk tier from legacy while repairing a malformed sibling', async () => {
    write([{
      larkAppId: 'cli_a', larkAppSecret: 's', name: 'a',
      sandbox: true,
      sandboxHidePaths: ['/legacy-deny'],
      sandboxPaths: { readOnly: ['/srv/ro', 9] },
    }]);
    await migrateSandboxConfigOnDisk(botsPath);
    const tiers = read()[0].sandboxPaths;
    expect(() => parseBotConfigsFromText(readFileSync(botsPath, 'utf-8'))).not.toThrow();
    expect(tiers.readOnly).toEqual(['/srv/ro']);
    expect(tiers.deny).toEqual(['/legacy-deny']);
  });

  it.each([
    ['scalar deny string', { deny: '~/.ssh' }],
    ['scalar readOnly number', { readOnly: 42 }],
    ['scalar readWrite boolean', { readWrite: true }],
  ])('does not silently delete a scalar tier without a legacy source — stays fail-closed (%s)', async (_label, tiers) => {
    // issue #2530 literal shape: a hand-written scalar carries an intent the
    // migration cannot extract. Deleting it would widen the sandbox before the
    // parser ever runs, so migration must leave the entry untouched and let the
    // strict loader report the exact bad field.
    write([{
      larkAppId: 'cli_a', larkAppSecret: 's', name: 'a',
      sandbox: true,
      sandboxPaths: tiers,
    }]);
    const { migrated } = await migrateSandboxConfigOnDisk(botsPath);
    expect(migrated).toEqual([]);
    expect(read()[0].sandboxPaths).toEqual(tiers);
    expect(() => parseBotConfigsFromText(readFileSync(botsPath, 'utf-8'))).toThrow(/must be an array of path strings|must be an object/);
  });

  it('still fail-closes when one tier is valid but a sibling scalar has no legacy source', async () => {
    write([{
      larkAppId: 'cli_a', larkAppSecret: 's', name: 'a',
      sandbox: true,
      sandboxPaths: { deny: ['/good'], readWrite: 5 },
    }]);
    const { migrated } = await migrateSandboxConfigOnDisk(botsPath);
    expect(migrated).toEqual([]);
    expect(() => parseBotConfigsFromText(readFileSync(botsPath, 'utf-8'))).toThrow(/sandboxPaths\.readWrite/);
    // The valid sibling stays on disk for the operator's repair.
    expect(read()[0].sandboxPaths.deny).toEqual(['/good']);
  });

  it('repairs a scalar tier from legacy when a legacy source exists', async () => {
    write([{
      larkAppId: 'cli_a', larkAppSecret: 's', name: 'a',
      sandbox: true,
      sandboxHidePaths: ['/legacy-deny'],
      sandboxPaths: { deny: '~/.ssh' },
    }]);
    const { migrated } = await migrateSandboxConfigOnDisk(botsPath);
    expect(migrated).toEqual(['cli_a']);
    expect(() => parseBotConfigsFromText(readFileSync(botsPath, 'utf-8'))).not.toThrow();
    expect(read()[0].sandboxPaths.deny).toEqual(['/legacy-deny']);
  });
});

describe('migrateSandboxConfigAtStartup when the bots.json lock is busy', () => {
  const legacy = [{ larkAppId: 'cli_busy', larkAppSecret: 's', sandbox: true, sandboxHidePaths: ['~/.ssh'] }];

  /** Hold the bots.json lock until `release()` is called. */
  function holdLock(): { held: Promise<void>; release: () => void; done: Promise<unknown> } {
    let release!: () => void;
    let markHeld!: () => void;
    const held = new Promise<void>(r => { markHeld = r; });
    const done = withFileLock(botsPath, () => new Promise<void>(r => { release = r; markHeld(); }));
    return { held, release: () => release(), done };
  }

  it('retries in the background and migrates once the lock frees up', async () => {
    write(legacy);
    const lock = holdLock();
    await lock.held;
    const scheduled: Array<() => void> = [];
    const prev = process.env.BOTS_CONFIG;
    process.env.BOTS_CONFIG = botsPath;
    try {
      await migrateSandboxConfigAtStartup({
        retryDelaysMs: [1, 1],
        schedule: fn => { scheduled.push(fn); },
        lockOpts: { maxWaitMs: 50 },
      });
      expect(read()[0].sandboxPaths).toBeUndefined();
      expect(scheduled).toHaveLength(1);
      lock.release();
      await lock.done;
      scheduled.shift()!();
      await vi.waitFor(() => expect(read()[0].sandboxPaths).toEqual({ deny: ['~/.ssh'] }));
      expect(scheduled).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = prev;
      lock.release();
    }
  });

  it('gives up after the last retry instead of rescheduling forever', async () => {
    write(legacy);
    const lock = holdLock();
    await lock.held;
    const scheduled: Array<() => void> = [];
    const prev = process.env.BOTS_CONFIG;
    process.env.BOTS_CONFIG = botsPath;
    try {
      await migrateSandboxConfigAtStartup({
        retryDelaysMs: [1],
        schedule: fn => { scheduled.push(fn); },
        lockOpts: { maxWaitMs: 50 },
      });
      expect(scheduled).toHaveLength(1);
      scheduled.shift()!();
      await new Promise(r => setTimeout(r, 300));
      expect(scheduled).toHaveLength(0);
      expect(read()[0].sandboxPaths).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = prev;
      lock.release();
      await lock.done;
    }
  });

  it('does not reschedule after a successful migration', async () => {
    write(legacy);
    const scheduled: Array<() => void> = [];
    const prev = process.env.BOTS_CONFIG;
    process.env.BOTS_CONFIG = botsPath;
    try {
      await migrateSandboxConfigAtStartup({ retryDelaysMs: [1], schedule: fn => { scheduled.push(fn); } });
      expect(scheduled).toHaveLength(0);
      expect(read()[0].sandboxPaths).toEqual({ deny: ['~/.ssh'] });
    } finally {
      if (prev === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = prev;
    }
  });
});
