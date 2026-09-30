import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTraexRolloutBySessionId } from '../src/services/traex-transcript.js';
import { openDatabaseSyncNow } from '../src/services/sqlite-compat.js';

const fsProbe = vi.hoisted(() => ({
  readdirPaths: [] as string[],
  statPaths: [] as string[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      fsProbe.readdirPaths.push(String(args[0]));
      return actual.readdirSync(...args);
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      fsProbe.statPaths.push(String(args[0]));
      return actual.statSync(...args);
    },
  };
});

const SID = '00000000-0000-7000-8000-000000000001';
let dir: string;
let previousTraeHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traex-rollout-lookup-'));
  previousTraeHome = process.env.TRAE_HOME;
  process.env.TRAE_HOME = join(dir, 'trae-home');
  fsProbe.readdirPaths.length = 0;
  fsProbe.statPaths.length = 0;
});

afterEach(() => {
  if (previousTraeHome === undefined) delete process.env.TRAE_HOME;
  else process.env.TRAE_HOME = previousTraeHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('TRAE rollout lookup filesystem budget', () => {
  it('uses the threads index without scanning the sessions tree', () => {
    const traeHome = process.env.TRAE_HOME!;
    const dayDir = join(traeHome, 'cli', 'sessions', '2026', '06', '04');
    const rollout = join(dayDir, `rollout-2026-06-04T12-00-00-${SID}.jsonl`);
    const dbPath = join(traeHome, 'cli', 'state_5.sqlite');
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(rollout, '{}\n');
    const db = openDatabaseSyncNow(dbPath);
    expect(db).not.toBeNull();
    db!.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
    db!.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(SID, rollout);
    db!.close();
    fsProbe.readdirPaths.length = 0;

    expect(findTraexRolloutBySessionId(SID)).toBe(rollout);
    expect(fsProbe.readdirPaths).toEqual([]);
  });

  it('keeps fallback work independent of sidecar contents', () => {
    const dayDir = join(process.env.TRAE_HOME!, 'cli', 'sessions', '2026', '06', '04');
    const sidecarDir = join(dayDir, 'rollout-blobs');
    mkdirSync(sidecarDir, { recursive: true });
    for (let i = 0; i < 200; i += 1) {
      writeFileSync(join(sidecarDir, `blob-${i}.json`), '{}');
    }
    fsProbe.readdirPaths.length = 0;
    fsProbe.statPaths.length = 0;

    expect(findTraexRolloutBySessionId('00000000-0000-7000-8000-000000000099')).toBeUndefined();
    expect(fsProbe.statPaths.length).toBe(0);
    expect(fsProbe.readdirPaths).not.toContain(sidecarDir);
    expect(fsProbe.readdirPaths.length).toBeLessThanOrEqual(4);
  });
});
