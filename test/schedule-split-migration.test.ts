/**
 * Startup split of the legacy shared data/schedules.json into per-bot stores
 * (services/schedule-split-migration.ts). Real fs in a temp botmux-home tree,
 * mocked config/logger — same scaffolding as schedule-store.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string; // botmux home root; dataDir = <tempDir>/data

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() {
        return join(tempDir, 'data');
      },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const PRIMARY = 'cli_primary000000001';
const OTHER = 'cli_other0000000002';

function legacyFp(): string {
  return join(tempDir, 'data', 'schedules.json');
}
function storeFp(appId: string): string {
  return join(tempDir, 'bots', appId, 'schedules.json');
}
function readStore(appId: string): Record<string, any> {
  return JSON.parse(readFileSync(storeFp(appId), 'utf-8'));
}

function legacyTask(id: string, larkAppId?: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `task ${id}`,
    schedule: '0 9 * * *',
    parsed: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
    prompt: `prompt ${id}`,
    workingDir: '/w',
    chatId: 'oc_x',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...(larkAppId ? { larkAppId } : {}),
    ...extra,
  };
}

async function freshImport() {
  vi.resetModules();
  const store = await import('../src/services/schedule-store.js');
  const migration = await import('../src/services/schedule-split-migration.js');
  return { store, migration };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'schedule-split-'));
  mkdirSync(join(tempDir, 'data'), { recursive: true });
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('migrateSharedSchedulesAtStartup', () => {
  it('routes by owner: ownerless→primary (kept ownerless), configured→own store, unconfigured-but-safe→own dormant store', async () => {
    const UNCONFIGURED = 'cli_unconfigured009'; // safe appId, NOT in bots.json
    writeFileSync(legacyFp(), JSON.stringify({
      a: legacyTask('a', PRIMARY),
      b: legacyTask('b', OTHER),
      c: legacyTask('c'),                     // ownerless → primary, stays ownerless
      d: legacyTask('d', UNCONFIGURED),       // safe but not configured → its OWN store (not primary)
    }));

    const { migration } = await freshImport();
    migration.migrateSharedSchedulesAtStartup([PRIMARY, OTHER], PRIMARY);

    // Ownerless 'c' lands in primary and STAYS ownerless (so the primary daemon's
    // owner filter runs it — stamping primary's appId would break that).
    expect(Object.keys(readStore(PRIMARY)).sort()).toEqual(['a', 'c']);
    expect(readStore(PRIMARY).c.larkAppId).toBeUndefined();
    expect(readStore(PRIMARY).a.larkAppId).toBe(PRIMARY);
    expect(Object.keys(readStore(OTHER))).toEqual(['b']);
    // 'd' goes to its OWN store keeping its appId — NOT folded into primary. This
    // is codex #611 finding 1: folding it into primary either strands it (foreign
    // appId fails primary's filter) or runs it under the wrong identity. Its own
    // dormant store keeps it intact until that bot is (re-)configured.
    expect(Object.keys(readStore(UNCONFIGURED))).toEqual(['d']);
    expect(readStore(UNCONFIGURED).d.larkAppId).toBe(UNCONFIGURED);
    // Legacy file renamed to backup, verbatim.
    expect(existsSync(legacyFp())).toBe(false);
    const bak = JSON.parse(readFileSync(`${legacyFp()}.bak-split-v1`, 'utf-8'));
    expect(Object.keys(bak).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('fail-safe on an unsafe larkAppId: aborts the split with no import, legacy file preserved', async () => {
    // A path-traversal appId cannot be a store path segment. The split must abort
    // BEFORE any import (imports happen after the routing loop) rather than throw
    // mid-way or silently drop the row — leave everything for a human.
    writeFileSync(legacyFp(), JSON.stringify({
      a: legacyTask('a', PRIMARY),
      evil: legacyTask('evil', '../../etc'),
    }));
    const { migration } = await freshImport();
    migration.migrateSharedSchedulesAtStartup([PRIMARY], PRIMARY);

    // Legacy left in place, no backup, no partial per-bot store written.
    expect(existsSync(legacyFp())).toBe(true);
    expect(existsSync(`${legacyFp()}.bak-split-v1`)).toBe(false);
    expect(existsSync(storeFp(PRIMARY))).toBe(false);
  });

  it.each([
    ['boolean true', true],
    ['boolean false', false],
    ['number', 123],
    ['zero', 0],
    ['null', null],
    ['empty string', ''],
    ['object', { evil: 1 }],
  ])('fail-safe on a non-string / empty larkAppId (%s): abort split, legacy preserved, no coerced store', async (_label, badOwner) => {
    // codex #611 findings 3+4: a present-but-non-string larkAppId must NOT be
    // treated as ownerless nor coerced into a path.
    //  - truthy non-string (`true`) slips past assertSafeAppId's RegExp.test
    //    (coerced to "true") → lands in bots/true/, unreachable (owner filter:
    //    true !== "true").
    //  - falsy non-string (`false`/`0`/`null`) would slip past a `!larkAppId`
    //    ownerless check into primary and run under primary's WRONG identity.
    //  - `''` is a string but not a legal appId (assertSafeAppId rejects it).
    // All must fail-safe: abort the whole split, keep legacy, import nothing.
    writeFileSync(legacyFp(), JSON.stringify({
      a: legacyTask('a', PRIMARY),
      bad: { ...legacyTask('bad'), larkAppId: badOwner },
    }));
    const { migration } = await freshImport();
    migration.migrateSharedSchedulesAtStartup([PRIMARY], PRIMARY);

    // Split aborted before any import: legacy preserved, no backup, and NO store
    // written — neither primary's nor a coerced-name one (bots/true/, bots/0/, …).
    expect(existsSync(legacyFp())).toBe(true);
    expect(existsSync(`${legacyFp()}.bak-split-v1`)).toBe(false);
    expect(existsSync(storeFp(PRIMARY))).toBe(false);
    // No sibling per-bot store dir was created for a coerced owner name.
    const botsDir = join(tempDir, 'bots');
    const siblingDirs = existsSync(botsDir) ? readdirSync(botsDir) : [];
    expect(siblingDirs).toEqual([]);
  });

  it('is idempotent — second run is a no-op', async () => {
    writeFileSync(legacyFp(), JSON.stringify({ a: legacyTask('a', PRIMARY) }));
    const { migration } = await freshImport();
    migration.migrateSharedSchedulesAtStartup([PRIMARY], PRIMARY);
    const first = readFileSync(storeFp(PRIMARY), 'utf-8');
    migration.migrateSharedSchedulesAtStartup([PRIMARY], PRIMARY);
    expect(readFileSync(storeFp(PRIMARY), 'utf-8')).toBe(first);
    expect(existsSync(legacyFp())).toBe(false);
  });

  it('keeps an existing per-bot entry on id conflict (per-bot store is newer)', async () => {
    writeFileSync(legacyFp(), JSON.stringify({ a: legacyTask('a', PRIMARY, { prompt: 'stale legacy' }) }));
    mkdirSync(dirname(storeFp(PRIMARY)), { recursive: true });
    writeFileSync(storeFp(PRIMARY), JSON.stringify({ a: legacyTask('a', PRIMARY, { prompt: 'newer per-bot' }) }));

    const { migration } = await freshImport();
    migration.migrateSharedSchedulesAtStartup([PRIMARY], PRIMARY);

    expect(readStore(PRIMARY).a.prompt).toBe('newer per-bot');
    expect(existsSync(`${legacyFp()}.bak-split-v1`)).toBe(true);
  });

  it('leaves a malformed legacy file in place (no rename, no brick)', async () => {
    writeFileSync(legacyFp(), '<<<not json>>>');
    const { migration } = await freshImport();
    migration.migrateSharedSchedulesAtStartup([PRIMARY], PRIMARY);
    expect(existsSync(legacyFp())).toBe(true);
    expect(existsSync(`${legacyFp()}.bak-split-v1`)).toBe(false);
  });

  it('no-ops when there is no legacy file', async () => {
    const { migration } = await freshImport();
    migration.migrateSharedSchedulesAtStartup([PRIMARY], PRIMARY);
    expect(existsSync(storeFp(PRIMARY))).toBe(false);
  });

  it('normalizes pre-parsed legacy rows through the store migration on import', async () => {
    writeFileSync(legacyFp(), JSON.stringify({
      old: { id: 'old', name: 'legacy', type: 'cron', schedule: '0 8 * * *', prompt: 'p', workingDir: '/w', chatId: 'oc', larkAppId: PRIMARY },
    }));
    const { migration, store } = await freshImport();
    migration.migrateSharedSchedulesAtStartup([PRIMARY], PRIMARY);
    store.setScheduleScope(PRIMARY);
    const t = store.getTask('old');
    expect(t?.parsed).toMatchObject({ kind: 'cron', expr: '0 8 * * *' });
  });

  it('per-bot stores stay independent after split (mutating one leaves the other untouched)', async () => {
    writeFileSync(legacyFp(), JSON.stringify({
      a: legacyTask('a', PRIMARY),
      b: legacyTask('b', OTHER),
    }));
    const { migration, store } = await freshImport();
    migration.migrateSharedSchedulesAtStartup([PRIMARY, OTHER], PRIMARY);

    store.setScheduleScope(PRIMARY);
    expect(store.removeTask('b')).toBe(false);   // not in primary's store
    expect(store.removeTask('a')).toBe(true);
    store.setScheduleScope(OTHER);
    expect(store.getTask('b')).toBeDefined();    // untouched
  });
});
