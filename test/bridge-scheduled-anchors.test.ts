/**
 * Tests for the durable CronCreate task → topic anchor store
 * (src/services/bridge-scheduled-anchors.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readScheduledTaskAnchors,
  upsertScheduledTaskAnchor,
} from '../src/services/bridge-scheduled-anchors.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cron-anchors-'));
  file = join(dir, 'turn-marks', 'session-1.cron-anchors.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readScheduledTaskAnchors', () => {
  it('returns an empty map when the file is absent', () => {
    expect(readScheduledTaskAnchors(file).size).toBe(0);
  });

  it('round-trips a string anchor and a null (local-created) anchor', () => {
    upsertScheduledTaskAnchor(file, 'jobA', 'om_A');
    upsertScheduledTaskAnchor(file, 'jobLocal', undefined);
    const map = readScheduledTaskAnchors(file);
    expect(map.get('jobA')).toBe('om_A');
    // null on disk is delivered as undefined — but the KEY is present, which
    // is how the queue distinguishes "observed, genuinely anchorless" from
    // "never seen".
    expect(map.has('jobLocal')).toBe(true);
    expect(map.get('jobLocal')).toBeUndefined();
  });

  it('returns an empty map for a corrupt / wrong-version payload', () => {
    upsertScheduledTaskAnchor(file, 'jobA', 'om_A');
    const good = JSON.parse(readFileSync(file, 'utf8'));
    expect(good.version).toBe(1);
    // Corrupt JSON.
    writeFileSync(file, '{ not json');
    expect(readScheduledTaskAnchors(file).size).toBe(0);
    // Wrong version.
    writeFileSync(file, JSON.stringify({ version: 9, tasks: {} }));
    expect(readScheduledTaskAnchors(file).size).toBe(0);
    // tasks not an object.
    writeFileSync(file, JSON.stringify({ version: 1, tasks: null }));
    expect(readScheduledTaskAnchors(file).size).toBe(0);
  });

  it('skips malformed entries but keeps valid ones', () => {
    mkdirSync(join(dir, 'turn-marks'), { recursive: true });
    writeFileSync(file, JSON.stringify({
      version: 1,
      tasks: {
        good: { anchor: 'om_1', createdAtMs: 1 },
        badAnchor: { anchor: 42, createdAtMs: 2 },
        noAnchor: null,
      },
    }));
    const map = readScheduledTaskAnchors(file);
    expect(map.get('good')).toBe('om_1');
    expect(map.has('badAnchor')).toBe(false);
    expect(map.has('noAnchor')).toBe(false);
  });

  it('writes the file owner-only (0600), valid version:1 JSON, and no tmp leftover', () => {
    upsertScheduledTaskAnchor(file, 'jobA', 'om_A', 1234);
    // Mode & 0o777 accounts for differing umask representations.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(parsed).toEqual({
      version: 1,
      tasks: { jobA: { anchor: 'om_A', createdAtMs: 1234 } },
    });
    // Atomic rename leaves only the final file.
    expect(readdirSync(join(dir, 'turn-marks'))).toEqual(['session-1.cron-anchors.json']);
  });

  it('preserves existing entries when upserting another one', () => {
    upsertScheduledTaskAnchor(file, 'jobA', 'om_A', 100);
    upsertScheduledTaskAnchor(file, 'jobB', 'om_B', 200);
    const map = readScheduledTaskAnchors(file);
    expect([...map.entries()]).toEqual([['jobA', 'om_A'], ['jobB', 'om_B']]);
  });

  it('overwrites an anchor (re-creation may move a task to another topic)', () => {
    upsertScheduledTaskAnchor(file, 'jobA', 'om_A', 100);
    upsertScheduledTaskAnchor(file, 'jobA', 'om_Z', 300);
    const map = readScheduledTaskAnchors(file);
    expect(map.size).toBe(1);
    expect(map.get('jobA')).toBe('om_Z');
  });

  it('sheds the OLDEST entries once the cap (64) is exceeded', () => {
    for (let i = 0; i < 70; i++) {
      upsertScheduledTaskAnchor(file, `job${i}`, `om_${i}`, i);
    }
    const map = readScheduledTaskAnchors(file);
    expect(map.size).toBe(64);
    // Oldest six shed.
    expect(map.has('job0')).toBe(false);
    expect(map.has('job5')).toBe(false);
    expect(map.has('job6')).toBe(true);
    expect(map.get('job69')).toBe('om_69');
  });
});
