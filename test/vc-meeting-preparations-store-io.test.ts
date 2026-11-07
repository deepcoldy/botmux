// Must stay the first import (this file fakes node:fs; see the helper).
import './helpers/require-fenced-data-dir.js';
/**
 * A transient read error on vc-meeting-preparations.json must never turn a
 * write into "replace every record with just this one". Faults are injected for
 * one exact path; all other fs calls stay real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fsFaults = vi.hoisted(() => ({
  /** errno for opening this exact path */
  open: new Map<string, string>(),
  /** errno for opening any path that starts with this prefix (atomic-write temp files) */
  openPrefix: new Map<string, string>(),
  /** runs right after this path was opened (the fd already pins the old inode) */
  afterOpen: new Map<string, () => void>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const fault = (path: unknown): string | undefined => {
    if (typeof path !== 'string') return undefined;
    const exact = fsFaults.open.get(path);
    if (exact) return exact;
    for (const [prefix, code] of fsFaults.openPrefix) if (path.startsWith(prefix) && path !== prefix) return code;
    return undefined;
  };
  const raise = (code: string, path: unknown): never => {
    throw Object.assign(new Error(`${code}: injected open failure, open '${String(path)}'`), { code, syscall: 'open', path });
  };
  const openSync = ((path: unknown, ...rest: unknown[]) => {
    const code = fault(path);
    if (code) raise(code, path);
    const fd = (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
    const hook = typeof path === 'string' ? fsFaults.afterOpen.get(path) : undefined;
    if (hook) {
      fsFaults.afterOpen.delete(path as string);
      hook();
    }
    return fd;
  }) as typeof actual.openSync;
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    const code = fault(path);
    if (code) raise(code, path);
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  const patched = { ...actual, openSync, readFileSync };
  return { ...patched, default: patched };
});

import { isStoreFileUnavailableError } from '../src/utils/json-file.js';
import { logger } from '../src/utils/logger.js';
import {
  getVcMeetingPreparation,
  listVcMeetingPreparations,
  putVcMeetingPreparation,
  removeVcMeetingPreparation,
  removeVcMeetingPreparationsByChat,
  removeVcMeetingPreparationsForApp,
} from '../src/services/vc-meeting-preparations-store.js';

let dir: string;
let fp: string;

function seed(): string {
  for (const larkAppId of ['cli_a', 'cli_b']) {
    putVcMeetingPreparation(dir, {
      larkAppId, meetingNo: '688542737', prepChatId: `oc_${larkAppId}`, agentAppId: larkAppId, qaMode: 'auto',
    });
  }
  return readFileSync(fp, 'utf-8');
}

function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (err) { return err; }
  throw new Error('expected the call to throw');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-vc-prep-io-'));
  fp = join(dir, 'vc-meeting-preparations.json');
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  fsFaults.open.clear();
  fsFaults.openPrefix.clear();
  fsFaults.afterOpen.clear();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('vc meeting preparations store with an unreadable file', () => {
  it('refuses every write instead of replacing the other records', () => {
    const before = seed();
    fsFaults.open.set(fp, 'EMFILE');

    const writes: Array<() => unknown> = [
      () => putVcMeetingPreparation(dir, {
        larkAppId: 'cli_c', meetingNo: '123456789', prepChatId: 'oc_c', agentAppId: 'cli_c', qaMode: 'off',
      }),
      () => removeVcMeetingPreparation(dir, 'cli_a', '688542737'),
      () => removeVcMeetingPreparationsByChat(dir, 'cli_b', 'oc_cli_b'),
      () => removeVcMeetingPreparationsForApp(dir, 'cli_a'),
    ];
    for (const write of writes) expect(isStoreFileUnavailableError(thrown(write))).toBe(true);

    fsFaults.open.clear();
    expect(readFileSync(fp, 'utf-8')).toBe(before);
    expect(readdirSync(dir).filter(name => name.includes('.corrupt'))).toEqual([]);
  });

  it('degrades read-only lookups to "none" without quarantining, unless asked to throw', () => {
    seed();
    fsFaults.open.set(fp, 'EIO');

    expect(listVcMeetingPreparations(dir, 'cli_a')).toEqual([]);
    expect(getVcMeetingPreparation(dir, 'cli_a', '688542737')).toBeUndefined();
    const readErr = thrown(() =>
      listVcMeetingPreparations(dir, 'cli_a', { ioErrors: 'throw' }));
    if (!isStoreFileUnavailableError(readErr)) throw new Error('expected StoreFileUnavailableError');
    expect(readErr.op).toBe('read');
    expect(readdirSync(dir).filter(name => name.includes('.corrupt'))).toEqual([]);

    fsFaults.open.clear();
    expect(listVcMeetingPreparations(dir, 'cli_a')).toHaveLength(1);
  });

  it('reports lock and write failures as unavailable, never as a silent crash, and leaves the file intact', () => {
    const before = seed();
    const put = () => putVcMeetingPreparation(dir, {
      larkAppId: 'cli_c', meetingNo: '123456789', prepChatId: 'oc_c', agentAppId: 'cli_c', qaMode: 'off',
    });

    fsFaults.open.set(`${fp}.lock`, 'EMFILE');
    expect(isStoreFileUnavailableError(thrown(put))).toBe(true);
    fsFaults.open.clear();

    fsFaults.openPrefix.set(fp, 'ENOSPC');
    expect(isStoreFileUnavailableError(thrown(put))).toBe(true);
    fsFaults.openPrefix.clear();

    expect(readFileSync(fp, 'utf-8')).toBe(before);
    put();
    expect(listVcMeetingPreparations(dir, 'cli_c')).toHaveLength(1);
  });

  it('never overwrites a file that was repaired after its corrupt bytes were judged', () => {
    writeFileSync(fp, '{broken', 'utf-8');
    const repaired = JSON.stringify({
      'cli_ops:111111111': {
        larkAppId: 'cli_ops', meetingNo: '111111111', prepChatId: 'oc_ops', agentAppId: 'cli_ops',
        qaMode: 'auto', createdAt: 1, updatedAt: 1,
      },
    });
    // An operator atomically puts a repaired file in place while the write is in flight.
    fsFaults.afterOpen.set(fp, () => {
      writeFileSync(`${fp}.repair`, repaired, 'utf-8');
      renameSync(`${fp}.repair`, fp);
    });

    expect(isStoreFileUnavailableError(thrown(() => putVcMeetingPreparation(dir, {
      larkAppId: 'cli_c', meetingNo: '123456789', prepChatId: 'oc_c', agentAppId: 'cli_c', qaMode: 'off',
    })))).toBe(true);
    expect(readFileSync(fp, 'utf-8')).toBe(repaired);
    expect(readdirSync(dir).filter(name => name.includes('.corrupt'))).toEqual([]);
  });

  it('read-only lookups on corrupt content neither quarantine nor answer "none" when asked to throw', () => {
    writeFileSync(fp, '{broken', 'utf-8');

    expect(listVcMeetingPreparations(dir, 'cli_a')).toEqual([]);
    expect(readdirSync(dir).filter(name => name.includes('.corrupt'))).toEqual([]);
    const parseErr = thrown(() =>
      listVcMeetingPreparations(dir, 'cli_a', { ioErrors: 'throw' }));
    if (!isStoreFileUnavailableError(parseErr)) throw new Error('expected StoreFileUnavailableError');
    expect(parseErr.op).toBe('parse');
  });
});

