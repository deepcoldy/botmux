/**
 * startHcCoreSync against a shell script standing in for the hc binary: run N
 * answers with the Nth scripted reply.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HC_STARTUP_RETRY_DELAYS_MS,
  setHcStartupRetrySleepForTests,
  startHcCoreSync,
  type HcSyncCore,
} from '../src/adapters/backend/hc/sync-rpc.js';

const STARTED = `echo '{"version":"0.1.19","pid":77}'`;
const NO_ANSWER = 'exit 1';
const UNAVAILABLE = `echo '{"error":{"kind":"unavailable","message":"cannot start core"}}' >&2; exit 1`;
const REFUSED = `echo '{"error":{"kind":"usage","message":"bad flag"}}' >&2; exit 2`;

let dir: string;
let sleeps: number[];

function scriptedHc(replies: string[]): HcSyncCore {
  replies.forEach((reply, i) => writeFileSync(join(dir, `reply.${i + 1}`), `${reply}\n`));
  const bin = join(dir, 'hc');
  writeFileSync(bin, `#!/bin/sh
n=$(($(cat '${dir}/runs' 2>/dev/null || echo 0) + 1))
echo $n > '${dir}/runs'
. '${dir}/reply.'$n
`);
  chmodSync(bin, 0o755);
  return { bin, env: { PATH: '/usr/bin:/bin' }, socket: join(dir, 'core.sock') };
}

function runs(): number {
  return Number(readFileSync(join(dir, 'runs'), 'utf8'));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hc-sync-rpc-'));
  sleeps = [];
  setHcStartupRetrySleepForTests(ms => sleeps.push(ms));
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  setHcStartupRetrySleepForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('startHcCoreSync', () => {
  it('rides out server starts that got no answer or found no core', () => {
    const core = scriptedHc([NO_ANSWER, UNAVAILABLE, STARTED]);
    expect(startHcCoreSync(core)).toEqual({ version: '0.1.19', pid: 77 });
    expect(runs()).toBe(3);
    expect(sleeps).toEqual(HC_STARTUP_RETRY_DELAYS_MS);
  });

  it('gives up after the last retry', () => {
    const core = scriptedHc([NO_ANSWER, NO_ANSWER, NO_ANSWER, STARTED]);
    expect(() => startHcCoreSync(core)).toThrow(/hc core 启动失败/);
    expect(runs()).toBe(HC_STARTUP_RETRY_DELAYS_MS.length + 1);
  });

  it('reports a refusal hc answered without retrying', () => {
    const core = scriptedHc([REFUSED, STARTED]);
    expect(() => startHcCoreSync(core)).toThrow(/bad flag/);
    expect(runs()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('does not retry if a file appears at the socket during backoff', () => {
    const core = scriptedHc([UNAVAILABLE, STARTED]);
    setHcStartupRetrySleepForTests(() => writeFileSync(core.socket, 'keep me'));

    expect(() => startHcCoreSync(core)).toThrow(/非 socket/);
    expect(runs()).toBe(1);
    expect(readFileSync(core.socket, 'utf8')).toBe('keep me');
  });
});
