import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Process-start tokens are persisted in lock files / owner records and compared
// across processes, so consolidating the /proc/<pid>/stat parsers must not move a
// single byte of output. Every `old*` function below is a VERBATIM copy of the
// implementation that existed before utils/proc-stat.ts; each new call site is
// driven over the same corpus and must produce the identical value.

const fakeProc = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    const hit = fakeProc.files.get(String(path));
    if (hit !== undefined) return hit;
    if (String(path).startsWith('/proc/') && fakeProc.files.size > 0) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, default: { ...real, readFileSync }, readFileSync };
});

import { readSupervisorProcessStartIdentity } from '../src/core/process-start-identity.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { readCodexAppProcessStartToken } from '../src/utils/codex-app-control.js';
import { readProcStartTime } from '../src/core/mojo-containment.js';
import { parseProcessStat } from '../src/core/resource-monitor/procfs.js';
import { snapshotProcessIdentities } from '../src/core/current-actor-attestation.js';
import {
  PROC_STAT_STARTTIME_INDEX,
  procStatFieldsAfterComm,
  procStatStartTime,
  procStatStartTimeDigits,
} from '../src/utils/proc-stat.js';

// ---- verbatim pre-consolidation implementations --------------------------------
function oldStartIdentity(raw: string): string | undefined {            // utils/process-identity, core/process-start-identity, pm2-lifecycle-owner, codex-app-control
  const closeParen = raw.lastIndexOf(')');
  if (closeParen >= 0) {
    const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
    if (fields[19]) return fields[19];
  }
  return undefined;
}
function oldStartDigits(raw: string): string | undefined {               // current-actor-attestation.readProcStart (procfs branch)
  const closeParen = raw.lastIndexOf(')');
  if (closeParen < 0) return undefined;
  const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
  return /^\d+$/.test(fields[19] ?? '') ? fields[19] : undefined;
}
function oldMojoStartTime(text: string): number | null {                 // mojo-containment.readProcStartTime
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const started = Number(rest[19]);
  return Number.isInteger(started) ? started : null;
}
function oldParseProcessStat(raw: string) {                              // resource-monitor/procfs.parseProcessStat
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(raw.slice(0, open).trim());
  const fieldsAfterComm = raw.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fieldsAfterComm[1]);
  const utime = Number(fieldsAfterComm[11]) || 0;
  const stime = Number(fieldsAfterComm[12]) || 0;
  const startTicks = Number(fieldsAfterComm[19]) || 0;
  const rssPages = Number(fieldsAfterComm[21]) || 0;
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null;
  return { pid, ppid, cpuTicks: utime + stime, startTicks, rssPages };
}

// ---- corpus --------------------------------------------------------------------
function statLine(pid: number, comm: string, opts: { state?: string; ppid?: number; start?: string; fields?: number; eol?: string } = {}): string {
  const n = opts.fields ?? 50; // fields 3..52 -> 50 entries
  const after: string[] = Array.from({ length: n }, (_, i) => String(1000 + i));
  after[0] = opts.state ?? 'S';
  after[1] = String(opts.ppid ?? 1);
  if (n > 11) after[11] = '7';
  if (n > 12) after[12] = '5';
  if (n > 21) after[21] = '33';
  if (n > 19) after[19] = opts.start ?? '123456789';
  return `${pid} (${comm}) ${after.join(' ')}${opts.eol ?? '\n'}`;
}

const COMMS = [
  'bash', 'node', 'a b', 'a  b', 'a) b', ') (', '(((', ')', '()', 'x) S 1 2 3 (y', 'a\nb', 'tab\tname',
  '', ' ', '中文 进程', 'Web Content', '(sd-pam)', 'very-long-name-' + 'x'.repeat(200), 'trailing ) 99 S 1',
];
const STARTS = ['0', '1', '4294967295', '123456789', '18446744073709551615', '007'];
const CORPUS: string[] = [];
for (const comm of COMMS) {
  for (const start of STARTS) {
    CORPUS.push(statLine(4242, comm, { start }));
    CORPUS.push(statLine(4242, comm, { start, eol: '' }));
    CORPUS.push(statLine(4242, comm, { start, state: 'Z', ppid: 77 }));
  }
}
// short / truncated / degenerate / non-digit starttime
CORPUS.push(
  statLine(5, 'short', { fields: 19 }),   // no field 22
  statLine(5, 'short', { fields: 20 }),   // exactly field 22
  statLine(5, 'trunc', { fields: 3 }),
  `5 (nothing)`, `5 (nothing) `, `5 (nothing)\n`,
  '', ' ', 'garbage', 'no paren 1 2 3', '5 (open only', '5 )close first(',
  statLine(9, 'nondigit', { start: '12x' }), statLine(9, 'nondigit', { start: '-5' }),
  statLine(9, 'nondigit', { start: '1e3' }), statLine(9, 'nondigit', { start: '1.5' }),
  statLine(9, 'nondigit', { start: '0x10' }), statLine(9, 'nondigit', { start: '' }),
  statLine(9, 'multispace', { start: '77' }).replace(/ /g, '   '),
  statLine(9, 'crlf', { start: '77', eol: '\r\n' }),
);

let dir: string;
let realPlatform: PropertyDescriptor | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bmx-procstat-'));
  realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  fakeProc.files.clear();
});
afterEach(() => {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  fakeProc.files.clear();
  rmSync(dir, { recursive: true, force: true });
});

function asLinux(): void {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
}

describe('procStat parsers vs the pre-consolidation implementations (byte-identical)', () => {
  it('corpus is non-trivial', () => {
    expect(CORPUS.length).toBeGreaterThan(300);
    expect(PROC_STAT_STARTTIME_INDEX).toBe(19);
  });

  it('procStatStartTime == old start-identity extraction', () => {
    for (const raw of CORPUS) expect(procStatStartTime(raw), JSON.stringify(raw)).toBe(oldStartIdentity(raw));
  });

  it('procStatStartTimeDigits == old digits-only extraction', () => {
    for (const raw of CORPUS) expect(procStatStartTimeDigits(raw), JSON.stringify(raw)).toBe(oldStartDigits(raw));
  });

  it('exact tokens for the shapes the lock files actually hold', () => {
    expect(procStatStartTime(statLine(1234, 'node', { start: '98765' }))).toBe('98765');
    expect(procStatStartTime(statLine(1234, 'a) b (c', { start: '98765' }))).toBe('98765');
    expect(procStatStartTime(statLine(1234, 'x', { fields: 19 }))).toBeUndefined();
    expect(procStatStartTime('no paren')).toBeUndefined();
    expect(procStatStartTimeDigits(statLine(1234, 'x', { start: '12x' }))).toBeUndefined();
    expect(procStatFieldsAfterComm('1 (a) S 4 5')).toEqual(['S', '4', '5']);
    expect(procStatFieldsAfterComm('nope')).toBeUndefined();
  });
});

describe('every migrated call site yields the old value for the same /proc/<pid>/stat bytes', () => {
  it('utils/process-identity.readProcessStartIdentity and core/process-start-identity (linux)', () => {
    asLinux();
    for (const raw of CORPUS) {
      fakeProc.files.set('/proc/4242/stat', raw);
      const expected = oldStartIdentity(raw);
      expect(readProcessStartIdentity(4242), JSON.stringify(raw)).toBe(expected);
      expect(readSupervisorProcessStartIdentity(4242), JSON.stringify(raw)).toBe(expected);
    }
  });

  it('keeps the pid guard: <=1, NaN, fractional and unsafe pids never read /proc', () => {
    asLinux();
    for (const pid of [0, 1, -3, Number.NaN, 2.5, Number.MAX_SAFE_INTEGER + 2, 1e300, Infinity]) {
      fakeProc.files.set(`/proc/${pid}/stat`, statLine(2, 'x'));
      expect(readProcessStartIdentity(pid)).toBeUndefined();
      expect(readSupervisorProcessStartIdentity(pid)).toBeUndefined();
    }
  });

  it('a missing /proc entry is undefined and never falls through to ps (linux)', () => {
    asLinux();
    fakeProc.files.set('/proc/1/stat', 'seed so unknown /proc paths throw ENOENT');
    expect(readProcessStartIdentity(31337)).toBeUndefined();
  });

  it('utils/codex-app-control.readCodexAppProcessStartToken (linux)', () => {
    for (const raw of CORPUS) {
      fakeProc.files.set('/proc/4242/stat', raw);
      expect(readCodexAppProcessStartToken(4242, 'linux'), JSON.stringify(raw)).toBe(oldStartIdentity(raw));
    }
  });

  it('core/mojo-containment.readProcStartTime', () => {
    const procRoot = join(dir, 'proc');
    mkdirSync(join(procRoot, '4242'), { recursive: true });
    for (const raw of CORPUS) {
      writeFileSync(join(procRoot, '4242', 'stat'), raw);
      expect(readProcStartTime(4242, { procRoot }), JSON.stringify(raw)).toBe(oldMojoStartTime(raw));
    }
    expect(readProcStartTime(999, { procRoot })).toBeNull();
  });

  it('core/resource-monitor/procfs.parseProcessStat', () => {
    for (const raw of CORPUS) expect(parseProcessStat(raw), JSON.stringify(raw)).toEqual(oldParseProcessStat(raw));
  });

  it('core/current-actor-attestation.snapshotProcessIdentities (digits-only token, pid-prefixed)', () => {
    const procRoot = join(dir, 'proc');
    mkdirSync(join(procRoot, '4242'), { recursive: true });
    for (const raw of CORPUS) {
      writeFileSync(join(procRoot, '4242', 'stat'), raw);
      // The seed pid is always in its own lineage; its token is the digits-only
      // starttime (or nothing when the line is unusable).
      const digits = oldStartDigits(raw);
      const expected = digits !== undefined ? [`4242:${digits}`] : undefined;
      expect(snapshotProcessIdentities(4242, procRoot), JSON.stringify(raw)).toEqual(expected);
    }
  });
});
