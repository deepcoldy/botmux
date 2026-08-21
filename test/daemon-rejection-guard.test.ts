/**
 * The daemon must survive a fire-and-forget rejection; a worker must not.
 *
 * This is the third link of the corrupt-store P1. The first two links are local
 * fixes (move a throwing constructor inside a try; add the missing `.catch` on
 * one call site). They close the holes we found. This link is structural: it
 * makes the NEXT missed `.catch` a logged incident affecting one session instead
 * of an outage that ends every live Lark session at once.
 *
 * The distinction from worker.ts matters and is asserted here: the worker's
 * handler deliberately exits, because a worker owns exactly one session. The
 * daemon owns all of them, so exiting is the failure, not the safety measure.
 *
 * The last case spawns a REAL node process, because "the process stays alive"
 * cannot be demonstrated by unit-testing a callback — the thing under test is
 * Node's default termination behaviour, and only an actual process exercises it.
 *
 * Run:  pnpm vitest run test/daemon-rejection-guard.test.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatRejectionReason,
  handleDaemonUnhandledRejection,
  installDaemonRejectionGuard,
  resetDaemonRejectionGuardForTest,
} from '../src/utils/daemon-rejection-guard.js';

afterEach(() => resetDaemonRejectionGuardForTest());

const sink = (): { lines: string[]; error(msg: string): void } => {
  const lines: string[] = [];
  return { lines, error(msg: string) { lines.push(msg); } };
};

describe('formatRejectionReason', () => {
  it('prefers the stack, since that is the part the caller failed to observe', () => {
    const err = new Error('store unreadable');
    const out = formatRejectionReason(err);
    expect(out).toContain('store unreadable');
    // A bare message would make the report nearly useless for finding the throw.
    expect(out).toContain('at ');
  });

  it('still renders non-Error reasons readably', () => {
    // String({}) is "[object Object]", which is what makes these reports mysteries.
    expect(formatRejectionReason({ code: 'EBADSTORE' })).toContain('"code":"EBADSTORE"');
    expect(formatRejectionReason('plain string')).toContain('plain string');
    expect(formatRejectionReason(undefined)).toContain('undefined');
  });

  it('does not throw on a circular reason', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => formatRejectionReason(circular)).not.toThrow();
    expect(formatRejectionReason(circular)).toContain('non-Error rejection');
  });
});

describe('handleDaemonUnhandledRejection', () => {
  it('logs loudly instead of swallowing silently', () => {
    const s = sink();
    expect(handleDaemonUnhandledRejection(new Error('boom'), s)).toBe(true);
    expect(s.lines).toHaveLength(1);
    // The operator must be able to tell this was a bug that was survived, not a
    // normal event: silence here is what turns the guard into a bug-hider.
    expect(s.lines[0]).toContain('boom');
    expect(s.lines[0]).toMatch(/STAYING UP/);
    expect(s.lines[0]).toMatch(/\.catch/);
  });

  it('drops broken-pipe reasons, which are noise rather than bugs', () => {
    const s = sink();
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(handleDaemonUnhandledRejection(epipe, s)).toBe(false);
    expect(s.lines).toHaveLength(0);
  });
});

describe('installDaemonRejectionGuard', () => {
  it('registers a listener and routes rejections to the sink', () => {
    const s = sink();
    const target = new EventEmitter();
    expect(installDaemonRejectionGuard(s, target)).toBe(true);
    expect(target.listenerCount('unhandledRejection')).toBe(1);
    target.emit('unhandledRejection', new Error('escaped teardown'));
    expect(s.lines[0]).toContain('escaped teardown');
  });

  it('is idempotent so multiple entry points may call it', () => {
    const s = sink();
    const target = new EventEmitter();
    expect(installDaemonRejectionGuard(s, target)).toBe(true);
    expect(installDaemonRejectionGuard(s, target)).toBe(false);
    expect(target.listenerCount('unhandledRejection')).toBe(1);
  });

  it('never lets a throwing sink escalate into an uncaughtException', () => {
    // The guard must not become the crash it prevents.
    const target = new EventEmitter();
    installDaemonRejectionGuard({ error() { throw new Error('logger died'); } }, target);
    expect(() => target.emit('unhandledRejection', new Error('x'))).not.toThrow();
  });
});

describe('a real process with the guard survives an unhandled rejection', () => {
  // Behavioural, not a callback assertion: the thing under test is Node's default
  // termination, so it needs a real process to be observable at all.
  const runNode = (body: string): { code: number; out: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-rejection-'));
    try {
      const file = join(dir, 'probe.mjs');
      writeFileSync(file, body);
      chmodSync(file, 0o644);
      // spawnSync, not execFileSync: both streams are needed in BOTH outcomes.
      // execFileSync returns only stdout on success, which silently dropped the
      // guard's stderr report and failed the assertion for the wrong reason.
      const r = spawnSync(process.execPath, [file], { encoding: 'utf-8', timeout: 20_000 });
      return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('exits non-zero WITHOUT the guard (the bug being fixed)', () => {
    // Pins the premise. If this ever stops failing, the guard is guarding nothing
    // and the whole file is measuring an environment default instead of our code.
    const r = runNode([
      'void Promise.reject(new Error("corrupt store"));',
      'setTimeout(() => { console.log("STILL_ALIVE"); }, 300);',
    ].join('\n'));
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain('STILL_ALIVE');
  });

  it('stays alive WITH the guard, and reports the rejection', () => {
    const r = runNode([
      // Mirrors installDaemonRejectionGuard's contract without importing TS.
      'process.on("unhandledRejection", (reason) => {',
      '  console.error("GUARD_LOGGED:" + (reason && reason.stack ? reason.message : String(reason)));',
      '});',
      'void Promise.reject(new Error("corrupt store"));',
      'setTimeout(() => { console.log("STILL_ALIVE"); }, 300);',
    ].join('\n'));
    expect(r.code).toBe(0);
    expect(r.out).toContain('STILL_ALIVE');
    expect(r.out).toContain('GUARD_LOGGED:corrupt store');
  }, 30_000);
});

describe('daemon wiring', () => {
  const daemonSrc = (): string =>
    // readFileSync, not `execFileSync('cat', …)`: daemon.ts crossed 1MB, and
    // execFileSync's default maxBuffer (1MB) then throws ENOBUFS. Reading the
    // file directly has no buffer cap and no subprocess.
    readFileSync(join(import.meta.dirname, '../src/daemon.ts'), 'utf-8');

  it('installs the guard inside startDaemon, not only in one entry file', () => {
    // startDaemon has TWO callers (index-daemon.ts and index-core-only.ts), so
    // guarding a single entry file would leave the other one unprotected.
    //
    // Comments are stripped FIRST. Without that, commenting the call out leaves
    // the searched text in the file and this assertion still passes — a mutation
    // proved exactly that (G6 survived until this was fixed), which is the same
    // trap where prose satisfies its own assertion.
    const src = daemonSrc()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .join('\n');
    const start = src.indexOf('export async function startDaemon(');
    expect(start).toBeGreaterThan(-1);
    const install = src.indexOf('installDaemonRejectionGuard(logger)', start);
    expect(install).toBeGreaterThan(-1);
    // Must be at the top of startDaemon: a guard installed after the first await
    // would miss rejections raised during startup.
    expect(src.slice(start, install)).not.toContain('await ');
  });
});
