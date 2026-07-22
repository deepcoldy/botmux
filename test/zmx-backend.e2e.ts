/**
 * Real ZMX smoke coverage for the tail/send/history transport.
 *
 * Requires zmx >= 0.7.1 with PR #202 semantics (ordinary contributors without ZMX are skipped):
 *   pnpm vitest run --project e2e test/zmx-backend.e2e.ts
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ZmxBackend } from '../src/adapters/backend/zmx-backend.js';

const TEST_SESSION = `bmx-e2e-zmx-${process.pid}`;
const RECOVERY_SESSION = `bmx-e2e-recover-${process.pid}`;
const FRAMING_SESSION = `bmx-e2e-frame-${process.pid}`;
const KILL_SESSION = `bmx-e2e-kill-${process.pid}`;
const SESSION_ID = `e2e-${process.pid}-1111-2222-333333333333`;
const PRIVATE_VALUE = `zmx-private-${process.pid}`;
const ZMX_AVAILABLE = ZmxBackend.isAvailable();

if (process.env.BOTMUX_E2E_REQUIRE_ZMX === '1' && !ZMX_AVAILABLE) {
  throw new Error(
    'BOTMUX_E2E_REQUIRE_ZMX=1, but a functional zmx >= 0.7.1 was not found in PATH',
  );
}

function waitFor(fn: () => boolean, timeoutMs = 7000, description = 'condition'): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out waiting for ${description}`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function backendFor(session: string, isReattach = false): ZmxBackend {
  return new ZmxBackend(session, {
    ownsSession: true,
    isReattach,
    sessionId: SESSION_ID,
  });
}

function observe(backend: ZmxBackend): { readonly screen: string } {
  let screen = '';
  backend.onData(data => { screen += data; });
  backend.onScreenResync(snapshot => { screen = snapshot; });
  return {
    get screen() { return screen; },
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!err && typeof err === 'object' && 'code' in err && err.code === 'EPERM';
  }
}

describe('ZmxBackend e2e', () => {
  afterEach(() => {
    ZmxBackend.killSession(TEST_SESSION);
    ZmxBackend.killSession(RECOVERY_SESSION);
    ZmxBackend.killSession(FRAMING_SESSION);
    ZmxBackend.killSession(KILL_SESSION);
  });

  it.skipIf(!ZMX_AVAILABLE)(
    'creates with a gated one-shot client, streams plain text, detaches, and reattaches from history',
    async () => {
      const backend = backendFor(TEST_SESSION);
      backend.spawn('sh', ['-lc', [
        "printf '\\033[31mBOOT\\033[0m\\n'",
        "printf 'UTF8=你好😀曛\\n'",
        "printf 'ZMX_SESSION=%s\\n' \"${ZMX_SESSION-unset}\"",
        "printf 'ZMX_SESSION_PREFIX=%s\\n' \"${ZMX_SESSION_PREFIX-unset}\"",
        "printf 'PRIVATE=%s\\n' \"${PROVIDER_TEST_TOKEN-unset}\"",
        'stty size',
        'while IFS= read -r line; do',
        '  echo "GOT:$line"',
        '  [ "$line" = done ] && { sleep 0.2; printf "FINAL=最终纯中文曛😀"; exit 0; }',
        'done',
      ].join('\n')], {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        env: process.env as Record<string, string>,
        injectEnv: { PROVIDER_TEST_TOKEN: PRIVATE_VALUE },
      });
      const observed = observe(backend);

      await waitFor(() => observed.screen.includes('BOOT'), 7000, 'initial plain BOOT output');
      await waitFor(() => /24\s+120/.test(observed.screen), 7000, 'headless terminal size');
      expect(observed.screen).not.toContain('\x1b');
      expect(observed.screen).toContain('UTF8=你好😀曛');
      expect(observed.screen).toContain('ZMX_SESSION=unset');
      expect(observed.screen).toContain('ZMX_SESSION_PREFIX=unset');
      expect(observed.screen).toContain(`PRIVATE=${PRIVATE_VALUE}`);
      // No terminal leader means ZMX keeps its documented headless default.
      expect(observed.screen).toMatch(/24\s+120/);
      const retainedCommand = ZmxBackend.listDetails();
      expect(retainedCommand).not.toContain(PRIVATE_VALUE);
      expect(retainedCommand).not.toContain("printf 'PRIVATE=");

      expect(backend.sendText('hello\r')).toBe(true);
      await waitFor(() => observed.screen.includes('GOT:hello'), 7000, 'first send');
      const cliPid = backend.getChildPid();
      expect(cliPid).toEqual(expect.any(Number));

      backend.resize(101, 33);
      backend.kill();
      expect(ZmxBackend.hasSession(TEST_SESSION)).toBe(true);

      const exits: Array<[number | null, string | null]> = [];
      const reattached = backendFor(TEST_SESSION, true);
      reattached.spawn('sh', ['-lc', 'echo should-not-run'], {
        cwd: process.cwd(),
        cols: 101,
        rows: 33,
        env: process.env as Record<string, string>,
      });
      const reattachedObserved = observe(reattached);
      reattached.onExit((code, signal) => exits.push([code, signal]));

      await waitFor(
        () => reattachedObserved.screen.includes('GOT:hello'),
        7000,
        'reattach history snapshot',
      );
      const snapshot = reattachedObserved.screen;
      expect(snapshot).toContain('BOOT');
      expect(snapshot).toContain('UTF8=你好😀曛');
      expect(snapshot).toContain('GOT:hello');
      expect(snapshot).not.toContain('should-not-run');
      expect(snapshot).not.toContain('\x1b');
      expect(reattached.getChildPid()).toBe(cliPid);

      expect(reattached.sendText('done\r')).toBe(true);
      await waitFor(
        () => reattachedObserved.screen.includes('GOT:done'),
        7000,
        'reattached send',
      );
      await waitFor(() => exits.length === 1, 7000, 'normal session exit');
      await waitFor(() => !ZmxBackend.hasSession(TEST_SESSION), 7000, 'session cleanup');
      expect(exits).toHaveLength(1);
      expect(reattachedObserved.screen).toContain('FINAL=最终纯中文曛😀');
    },
  );

  it.skipIf(!ZMX_AVAILABLE)(
    'keeps send independent from tail and observes pure Unicode through the safety poll',
    async () => {
      const exits: Array<[number | null, string | null]> = [];
      const backend = backendFor(RECOVERY_SESSION);
      backend.spawn('sh', ['-lc', [
        "printf 'READY\\n'",
        "trap 'printf \"INTERRUPTED\\n\"' INT",
        'while :; do',
        '  line=',
        '  IFS= read -r line || continue',
        '  [ "$line" = unicode ] && { printf "纯中文曛😀"; continue; }',
        '  echo "GOT:$line"',
        '  [ "$line" = done ] && exit 0',
        'done',
      ].join('\n')], {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        env: process.env as Record<string, string>,
      });
      const observed = observe(backend);
      backend.onExit((code, signal) => exits.push([code, signal]));

      await waitFor(() => observed.screen.includes('READY'), 7000, 'READY');
      // Upstream tail currently emits no bytes for this all-non-ASCII burst.
      // The cold safety poll must still make it visible from authoritative history.
      expect(backend.sendText('unicode\r')).toBe(true);
      await waitFor(
        () => observed.screen.includes('纯中文曛😀'),
        7000,
        'pure-Unicode history safety poll',
      );
      expect(backend.sendSpecialKeys('C-c')).toBe(true);
      await waitFor(() => observed.screen.includes('INTERRUPTED'), 7000, 'Ctrl-C delivery');
      expect(ZmxBackend.hasSession(RECOVERY_SESSION)).toBe(true);
      expect(backend.sendText('after-interrupt\r')).toBe(true);
      await waitFor(
        () => observed.screen.includes('GOT:after-interrupt'),
        7000,
        'input after handled Ctrl-C',
      );
      const cliPid = backend.getChildPid();
      expect(cliPid).toEqual(expect.any(Number));
      const firstTail = (backend as unknown as { tailProcess: { kill(signal?: string): void } | null })
        .tailProcess;
      expect(firstTail).not.toBeNull();
      firstTail!.kill('SIGKILL');
      await waitFor(
        () => (backend as unknown as { state: string }).state === 'recovering',
        7000,
        'tail recovery state',
      );

      // Input does not depend on the observer and is never replayed on an
      // ambiguous failure. History proves the original CLI consumed it once.
      expect(backend.sendText('while-offline\r')).toBe(true);
      await waitFor(
        () => (backend as unknown as { state: string }).state === 'observing',
        7000,
        'replacement tail',
      );
      await waitFor(
        () => observed.screen.includes('GOT:while-offline'),
        7000,
        'worker-facing history rebase after offline send',
      );
      expect(backend.getChildPid()).toBe(cliPid);
      expect(exits).toEqual([]);

      expect(backend.sendText('done\r')).toBe(true);
      await waitFor(() => observed.screen.includes('GOT:done'), 7000, 'post-recovery output');
      await waitFor(() => exits.length === 1, 7000, 'normal exit after recovery');
      expect(exits).toHaveLength(1);
    },
  );

  it.skipIf(!ZMX_AVAILABLE)(
    'preserves large, Unicode, control, and trailing-LF input across ordered send chunks',
    async () => {
      const payload = `${'-leading\n'.repeat(700)}你好😀曛\x00\x03\n`;
      const expected = Buffer.from(payload, 'utf8');
      const expectedHash = createHash('sha256').update(expected).digest('hex');
      const backend = backendFor(FRAMING_SESSION);
      backend.spawn(process.execPath, ['-e', [
        'process.stdin.setRawMode?.(true)',
        'process.stdin.resume()',
        `const expected=${expected.length}`,
        "const chunks=[];let length=0",
        "process.stdin.on('data',chunk=>{chunks.push(chunk);length+=chunk.length;if(length>=expected){const b=Buffer.concat(chunks);const out='LEN='+b.length+'\\nHASH='+require('node:crypto').createHash('sha256').update(b).digest('hex')+'\\n';process.stdout.write(out,()=>process.exit(b.length===expected?0:3))}})",
        "console.log('READY')",
      ].join(';')], {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        env: process.env as Record<string, string>,
      });
      const observed = observe(backend);

      await waitFor(() => observed.screen.includes('READY'), 7000, 'raw reader READY');
      expect(backend.sendText(payload)).toBe(true);
      try {
        await waitFor(() => observed.screen.includes('HASH='), 7000, 'input digest');
      } catch (err) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}; ` +
          `probe=${ZmxBackend.probeSession(FRAMING_SESSION)}; ` +
          `observed=${JSON.stringify(observed.screen.slice(-1000))}; ` +
          `history=${JSON.stringify(backend.captureCurrentScreen().slice(-1000))}`,
        );
      }
      expect(observed.screen).toContain(`LEN=${expected.length}`);
      expect(observed.screen).toContain(`HASH=${expectedHash}`);
    },
  );

  it.skipIf(!ZMX_AVAILABLE)(
    'kills the ZMX root and its foreground CLI without leaving an orphan',
    async () => {
      const backend = backendFor(KILL_SESSION);
      backend.spawn(process.execPath, ['-e', "process.on('SIGHUP',()=>{});console.log('READY');setInterval(()=>{},1000)"], {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        env: process.env as Record<string, string>,
      });
      const observed = observe(backend);
      await waitFor(() => observed.screen.includes('READY'), 7000, 'kill fixture READY');
      const cliPid = backend.getChildPid();
      expect(cliPid).toEqual(expect.any(Number));
      expect(processIsAlive(cliPid!)).toBe(true);

      backend.destroySession();
      await waitFor(() => !ZmxBackend.hasSession(KILL_SESSION), 7000, 'forced session removal');
      await waitFor(() => !processIsAlive(cliPid!), 7000, 'foreground CLI exit');
    },
  );
});
