import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realDelay } from 'node:timers/promises';
import { persistRenamedBotName } from '../src/services/bot-name-sync.js';
import { rmwBotEntry } from '../src/services/config-store.js';
import { withFileLock } from '../src/utils/file-lock.js';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-name-sync-concurrent-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('BOTMUX_COORDINATION_MODE', '');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

// Observe rejections immediately, including before a deliberately held lock is released.
function track<T>(promise: Promise<T>) {
  let settled = false;
  const result = promise.then(
    value => { settled = true; return { status: 'fulfilled' as const, value }; },
    reason => { settled = true; return { status: 'rejected' as const, reason }; },
  );
  return { result, get settled() { return settled; } };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Fixture did not reach the expected state');
    // Keep OS process / file-lock polling on real timers on both Node and Bun.
    await realDelay(5);
  }
}

function seedConfig() {
  const path = join(root, 'bots.json');
  const entries = [
    { larkAppId: 'cli_a', larkAppSecret: 'fixture-a', cliId: 'doubao', name: 'old-a', model: 'original' },
    { larkAppId: 'cli_b', larkAppSecret: 'fixture-b', cliId: 'traex', name: 'old-b', model: 'peer-model' },
  ];
  writeFileSync(path, JSON.stringify(entries), { mode: 0o600 });
  return { path, entries };
}

describe('persistRenamedBotName concurrent configuration updates', () => {
  it('merges a rename with a different field edited while the rename waits for the lock', async () => {
    const { path, entries } = seedConfig();
    const releaseEdit = gate();
    let editing = false;
    const edit = track(rmwBotEntry('cli_a', async entry => {
      editing = true;
      await releaseEdit.promise;
      entry.model = 'concurrently-selected-model';
      return { write: true, result: entry.model };
    }, { path }));
    let rename: ReturnType<typeof track<string>> | undefined;
    try {
      await until(() => editing || edit.settled);
      expect(editing).toBe(true);
      rename = track(persistRenamedBotName('cli_a', 'Renamed A', path));
      // The explicit edit gate still owns the lock; give the contender an I/O
      // turn without faking filesystem or runtime timers.
      await realDelay(50);
      expect(rename.settled).toBe(false);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(entries);
      releaseEdit.release();
      await until(() => edit.settled && rename!.settled);
      expect(await edit.result).toMatchObject({ status: 'fulfilled', value: { ok: true } });
      expect(await rename.result).toEqual({ status: 'fulfilled', value: 'Renamed-A' });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([
        { ...entries[0], name: 'Renamed-A', model: 'concurrently-selected-model' },
        entries[1],
      ]);
    } finally {
      releaseEdit.release();
      await until(() => edit.settled && (!rename || rename.settled));
    }
  });

  it('keeps complete JSON and both updates when two renames contend for the same file', async () => {
    const { path, entries } = seedConfig();
    const releaseLock = gate();
    let locked = false;
    const holder = track(withFileLock(path, async () => {
      locked = true;
      await releaseLock.promise;
    }));
    const renames: Array<ReturnType<typeof track<string>>> = [];
    try {
      await until(() => locked || holder.settled);
      expect(locked).toBe(true);
      renames.push(track(persistRenamedBotName('cli_a', 'A substantially longer renamed bot', path)));
      renames.push(track(persistRenamedBotName('cli_b', 'B', path)));
      await realDelay(50);
      expect(renames.every(rename => !rename.settled)).toBe(true);
      releaseLock.release();
      await until(() => holder.settled && renames.every(rename => rename.settled));
      expect(await holder.result).toMatchObject({ status: 'fulfilled' });
      expect(await Promise.all(renames.map(rename => rename.result))).toEqual([
        { status: 'fulfilled', value: 'A-substantially-longer-renamed-bot' },
        { status: 'fulfilled', value: 'B' },
      ]);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([
        { ...entries[0], name: 'A-substantially-longer-renamed-bot' },
        { ...entries[1], name: 'B' },
      ]);
    } finally {
      releaseLock.release();
      await until(() => holder.settled && renames.every(rename => rename.settled));
    }
  });
});
