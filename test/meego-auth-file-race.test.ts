/** Cross-daemon Meego challenge mutation interleavings. */
import './helpers/require-fenced-data-dir.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ALICE = 'ou_alice';
const fsRace = vi.hoisted(() => ({
  path: '',
  reads: 0,
  replacement: '',
  deferred: false,
  sawWriterLock: false,
}));

vi.mock('node:fs', async importOriginal => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    readFileSync: (path: any, ...args: any[]) => {
      const raw = orig.readFileSync(path, ...args);
      if (String(path) !== fsRace.path) return raw;
      fsRace.reads += 1;
      if (fsRace.reads !== 2) return raw;

      // Model a cooperating second daemon at the exact compare/delete boundary.
      // It may install C2 immediately only when the deleting side does not hold
      // the shared writer lock; otherwise it waits until after the critical section.
      fsRace.sawWriterLock = orig.existsSync(`${String(path)}.lock`);
      if (fsRace.sawWriterLock) {
        fsRace.deferred = true;
      } else {
        const tmp = `${String(path)}.c2`;
        orig.writeFileSync(tmp, fsRace.replacement, { mode: 0o600 });
        orig.renameSync(tmp, path);
      }
      return raw;
    },
  };
});

let dir: string;
const saved: Record<string, string | undefined> = {};
const loadedModules: Array<{ stopAllMeegoPollers: () => void }> = [];
const realSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-meego-lock-race-'));
  for (const key of ['HOME', 'PATH', 'STUB_DIR']) saved[key] = process.env[key];
  process.env.HOME = join(dir, 'home');
  mkdirSync(process.env.HOME);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'bytedcli'), [
    '#!/bin/sh',
    'store="$HOME/.meegle"',
    '[ "$1" = -j ] && shift; shift',
    'case "$1 $2" in',
    '  "status ")',
    '    printf \'{"status":"success","data":{"official_meegle_cli_authenticated":false}}\\n\' ;;',
    '  "login --begin")',
    '    mkdir -p "$store" "$TMPDIR/bytedcli/meego-login-1"; : > "$TMPDIR/bytedcli/meego-login-1/qr.png"',
    '    printf \'{"status":"success","data":{"verification_uri_complete":"https://meego.example/device-c1","complete_token":"c1-token","qr_image_path":"%s"}}\\n\' "$TMPDIR/bytedcli/meego-login-1/qr.png" ;;',
    '  "login --complete")',
    '    printf \'{"status":"success","data":{"login_status":"expired"}}\\n\' ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'bytedcli'), 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.STUB_DIR = dir;
  fsRace.path = '';
  fsRace.reads = 0;
  fsRace.replacement = '';
  fsRace.deferred = false;
  fsRace.sawWriterLock = false;
});

afterEach(() => {
  for (const mod of loadedModules.splice(0)) mod.stopAllMeegoPollers();
  vi.useRealTimers();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function load() {
  vi.resetModules();
  const auth = await import('../src/services/meego-auth.js');
  const home = await import('../src/services/bytedcli-home.js');
  loadedModules.push(auth);
  return { ...auth, ...home };
}

async function settleRealIo(ms = 120): Promise<void> {
  await new Promise<void>(resolve => realSetTimeout(resolve, ms));
}

it('a cooperating daemon cannot install C2 between the locked C1 comparison and unlink', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
  const m = await load();
  await m.requestMeegoLogin(ALICE);

  const challenge = join(m.meegoHomeFor(ALICE), '.botmux-meego-challenge');
  fsRace.path = challenge;
  fsRace.replacement = JSON.stringify({
    token: 'c2-token',
    authUrl: 'https://meego.example/device-c2',
    createdAt: Date.now(),
  });
  vi.advanceTimersByTime(3_000);
  await settleRealIo();

  expect(fsRace.reads).toBe(2);
  expect(fsRace.sawWriterLock).toBe(true);
  expect(fsRace.deferred).toBe(true);

  // The second daemon now acquires the released lock and publishes C2.
  const { withFileLockSync } = await import('../src/utils/file-lock.js');
  withFileLockSync(challenge, () => {
    writeFileSync(`${challenge}.c2`, fsRace.replacement, { mode: 0o600 });
    renameSync(`${challenge}.c2`, challenge);
  });
  expect(existsSync(challenge)).toBe(true);
  expect(JSON.parse(readFileSync(challenge, 'utf8')).token).toBe('c2-token');
});
