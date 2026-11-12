/**
 * The conversation a re-attached Claude is running goes into its runtime
 * identity, and the session contract reuses the runtime a running turn was
 * submitted under only when that identity matches. So the answer must come from
 * the live process itself and be wrong never: a recycled pid's leftover record,
 * a record whose start time cannot be checked, or one that disagrees with the
 * conversation the process holds open must give no answer at all — the worker
 * then binds a new runtime, as it did before it read the record.
 *
 * The live process here is the test process itself: its pid, its start time
 * from /proc, and the files it holds open.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudePidStatePath, readClaudeLiveSessionId } from '../src/adapters/cli/claude-code.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';

const pid = process.pid;
const sid = randomUUID();
let root: string;
let dataDir: string;
const held: number[] = [];

const writeRecord = (fields: Record<string, unknown>) => {
  const path = claudePidStatePath(pid, dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, sessionId: sid, cwd: root, kind: 'interactive', procStart: readProcessStartIdentity(pid), ...fields }));
};
/** Hold a session's tasks lock open, the way Claude does for its active one. */
const holdTasksLock = (session: string) => {
  const dir = join(dataDir, 'tasks', session);
  mkdirSync(dir, { recursive: true });
  held.push(openSync(join(dir, '.lock'), 'a'));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-live-session-'));
  dataDir = join(root, 'config');
});
afterEach(() => {
  for (const fd of held.splice(0)) closeSync(fd);
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('the conversation a live Claude declares for its runtime identity', () => {
  it('is the one its own record names, when the record carries this process\'s start time', () => {
    writeRecord({});
    expect(readClaudeLiveSessionId(pid, dataDir)).toBe(sid);
    holdTasksLock(sid);
    expect(readClaudeLiveSessionId(pid, dataDir)).toBe(sid);
  });

  it.each([
    ['another process\'s start time (a recycled pid\'s leftover)', { procStart: '1' }],
    ['no start time to check', { procStart: undefined }],
    ['another pid', { pid: pid + 1 }],
    ['no session id', { sessionId: 'not-a-session' }],
  ])('is unknown for a record with %s', (_case, fields) => {
    writeRecord(fields);
    expect(readClaudeLiveSessionId(pid, dataDir)).toBeUndefined();
  });

  it('is unknown when there is no record', () => {
    expect(readClaudeLiveSessionId(pid, dataDir)).toBeUndefined();
  });

  it('is unknown for a record whose process is gone, so its start time cannot be checked', () => {
    // The kernel hands out pids below pid_max, so this one is never live.
    const gone = Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8'));
    expect(readProcessStartIdentity(gone)).toBeUndefined();
    const path = claudePidStatePath(gone, dataDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid: gone, sessionId: sid, cwd: root, kind: 'interactive', procStart: '123' }));
    expect(readClaudeLiveSessionId(gone, dataDir)).toBeUndefined();
  });

  it('is unknown when the process holds another conversation open (a record that kept its spawn-time id)', () => {
    writeRecord({});
    holdTasksLock(randomUUID());
    expect(readClaudeLiveSessionId(pid, dataDir)).toBeUndefined();
  });
});
