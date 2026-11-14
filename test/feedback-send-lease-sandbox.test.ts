import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tsRunnerPrefix } from './helpers/ts-runner.js';
import { beginFeedbackMaintenance, inspectFeedbackMaintenance } from '../src/services/feedback-maintenance.js';
import { inspectSendRecovery } from '../src/services/feedback-recovery.js';
import {
  APPROX_START_IDENTITY_PREFIX, approxStartIdentityMatches, parseUtcLstart, readSelfApproxStartIdentity,
} from '../src/utils/process-identity.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// macOS Seatbelt refuses exec of setuid binaries even under (allow default):
// `/bin/ps` is setuid root, so a sandboxed process cannot read its own identity.
const seatbelt = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

describe('send lease identity without ps', () => {
  it('parses UTC lstart output, including space-padded days', () => {
    expect(parseUtcLstart('Wed Nov 11 02:39:37 2026')).toBe(Date.UTC(2026, 10, 11, 2, 39, 37));
    expect(parseUtcLstart('Sun Nov  1 00:00:05 2026  ')).toBe(Date.UTC(2026, 10, 1, 0, 0, 5));
    expect(parseUtcLstart('garbage')).toBeUndefined();
    expect(parseUtcLstart('Mon Nov 31 00:00:05 2026')).toBeUndefined();
    expect(parseUtcLstart('Mon Nov 30 24:00:05 2026')).toBeUndefined();
  });

  it('only self-reports where the identity can be verified from outside', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      expect(readSelfApproxStartIdentity()).toBeUndefined();
      expect(approxStartIdentityMatches(process.pid, `${APPROX_START_IDENTITY_PREFIX}${Date.now()}`)).toBeUndefined();
      Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
      expect(readSelfApproxStartIdentity()).toMatch(new RegExp(`^${APPROX_START_IDENTITY_PREFIX}\\d+$`));
    } finally { Object.defineProperty(process, 'platform', platform); }
    expect(approxStartIdentityMatches(process.pid, `${APPROX_START_IDENTITY_PREFIX}not-a-number`)).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('verifies a self-reported birth time against the real one', () => {
    const own = readSelfApproxStartIdentity()!;
    expect(approxStartIdentityMatches(process.pid, own)).toBe(true);
    const claimed = Number(own.slice(APPROX_START_IDENTITY_PREFIX.length));
    expect(approxStartIdentityMatches(process.pid, `${APPROX_START_IDENTITY_PREFIX}${claimed - 60_000}`)).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('keeps the self-reported birth time stable across a later clock step', () => {
    const before = readSelfApproxStartIdentity();
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 3_600_000);
    try {
      expect(readSelfApproxStartIdentity()).toBe(before);
      expect(approxStartIdentityMatches(process.pid, before!)).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it.runIf(seatbelt)('lets a Seatbelt-sandboxed sender take a lease that blocks freezing while it lives', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-sandbox-lease-'));
    directories.push(directory);
    const { command, prefixArgs } = tsRunnerPrefix();
    const child = spawn('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', command, ...prefixArgs,
      'test/helpers/feedback-send-lease-child.ts', directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    try {
      const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`child exited ${code}: ${stderr}`); })]);
      expect(ready[0]).toMatchObject({ ready: true });
      const [name] = await readdir(join(directory, 'feedback-send-leases'));
      const lease = JSON.parse(await readFile(join(directory, 'feedback-send-leases', name!), 'utf8'));
      expect(lease.processStartId.startsWith(APPROX_START_IDENTITY_PREFIX)).toBe(true);
      expect(inspectSendRecovery(directory)).toEqual([expect.objectContaining({ processId: lease.processId, live: true })]);
      await beginFeedbackMaintenance(directory, 'sandboxed-send');
      expect((await inspectFeedbackMaintenance(directory, 'sandboxed-send')).blockers).toContain(`send_in_progress:${lease.processId}`);
      const exited = once(child, 'exit');
      child.kill();
      await exited;
      expect(inspectSendRecovery(directory)).toEqual([expect.objectContaining({ processId: lease.processId, live: false })]);
    } finally { child.kill(); }
  }, 30_000);
});
