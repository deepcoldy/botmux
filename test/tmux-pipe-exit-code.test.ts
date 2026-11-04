/**
 * tmux 后端的真实退出码通道。
 *
 * 事故背景（评审阻断 1）：`TmuxPipeBackend` 只从两个出口 `fireExit(1, null)`，
 * 于是 daemon 在所有默认（tmux）会话上永远只看到 code=1——崩溃重启策略里
 * 77/127 的永久退出通道在生产路径上结构不可达，`restart-policy` 那半边等于
 * 没接上。
 *
 * 这里钉的是行为，不是实现：用一个真 tmux（私有 socket）+ 真 TmuxPipeBackend
 * 起一个 CLI，让它以各种方式退出，断言 `onExit` 拿到的退出码。
 *
 * 同时钉 N3：`remain-on-exit failed` 会让崩溃的 pane 尸体留在原地，而尸体仍会
 * 回答 `#{pane_id}`、`has-session` 也返回 0——存活探针与后端闸口必须把它判成
 * missing，否则会话永远报不出退出、还会把下一代 attach 到尸体上。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TmuxPipeBackend, resolvePaneDeath } from '../src/adapters/backend/tmux-pipe-backend.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { readUnreapedPaneExit } from '../src/adapters/backend/unreaped-pane-exit.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

// Pure fold for the corpse waiter: merge one raw
// `#{pane_dead}:#{pane_dead_status}[:#{pane_pid}:#{pid}]` line into the
// observation so far (only the first two fields classify). ONLY a parseable
// 0:/1: updates it; an unreadable line (a spawnSync timeout returns null
// stdout under starvation) retains the previous observation, and an explicit
// later 0: is adopted (no erroneous freeze). Without this, a `1:` followed by
// timed-out reads was overwritten back to {dead:false}, erasing an
// already-confirmed death.
//
// SEMANTIC BOUNDARY vs the PRODUCTION resolvePaneDeath: this fold accumulates
// the CURRENT state across the fixture's reads — an explicit later `0:` is
// adopted, because it estimates "what is the pane now" across inconclusive
// reads. resolvePaneDeath returns a ONE-SHOT verdict and latches death
// irreversibly (a `0:` after `1:` is a tmux glitch there). The two must not be
// "unified": reachable sequences never disagree (a fixed-target pane does not
// revive; respawn-pane is unused in src/), but their monotonicity is opposite
// on purpose.
function mergePaneObservation(
  prev: { dead: boolean; status: string },
  rawLine: string,
): { dead: boolean; status: string } {
  const [dead, status] = String(rawLine ?? '').trim().split(':');
  if (dead !== '0' && dead !== '1') return prev; // unreadable: retain
  return { dead: dead === '1', status: status ?? '' };
}

let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }

// The #2453 lab chains `remain-on-exit failed` into new-session; tmux < 3.2
// rejects that value and no corpse is created, so the lab is modern-tmux only.
let realTmuxSupportsFailed = false;
try {
  const v = String(execFileSync(realTmux!, ['-V'], { encoding: 'utf8', timeout: 3000 }));
  const m = /tmux (\d+)\.(\d+)/.exec(v);
  const major = m ? Number(m[1]) : 0;
  const minor = m ? Number(m[2]) : 0;
  realTmuxSupportsFailed = major > 3 || (major === 3 && minor >= 2);
} catch { /* tmux missing: outer skipIf handles */ }
let python3: string | undefined;
try { python3 = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }

/**
 * Backend 退出检测依赖它自己的生命周期轮询（1s 起步、缺会话要连续 3 次才
 * 判定），单例最坏 ~14s。给足余量且不靠固定 sleep。
 */
const EXIT_TIMEOUT_MS = 45_000;

type TmuxRun = (...args: string[]) => { stdout?: string | null };

/**
 * Wait until a pane is dead and its exit status is known; returns the status
 * as text and what was last seen. `status` is '' both when no status became
 * known and for a signal death, which has no exit code; `seen` tells them
 * apart — a signal death ends with the kernel reading (`kernel={"kind":
 * "signaled",…}`) or, once tmux reaped it, with tmux's own empty status.
 *
 * tmux publishes `#{pane_dead_status}` only once it has reaped the pane's
 * process. Until then the pane reads `1:` — dead, no status — and on CI tmux
 * has gone the whole wait without reaping (#2459: 240 reads, 7.5s, `1:`
 * throughout). Waiting for tmux longer cannot fix that. The status is already
 * certain as soon as the process has exited: while it is an unreaped zombie of
 * the server the kernel holds it, which is exactly what the backend reads in
 * that case (#2457). So the wait ends on whichever arrives first, tmux's
 * status or the kernel's, and stops depending on when tmux reaps.
 *
 * What is left to wait for is tmux noticing the pane died at all. That is
 * bounded by READ COUNT, not wall clock: a descheduled test process does no
 * reads, so starvation stretches the wait instead of failing it (240 reads
 * measured 13.8–14.5s under a 4-core / 12×yes load, ~6s unloaded). Running out
 * of reads therefore means something is wrong rather than slow, and `seen`
 * says which: a pane that never died (`0:…`), a session that is gone (empty —
 * remain-on-exit was not applied), a dead pane whose process is neither
 * reaped nor an unreaped zombie of this server, or a death an earlier parseable
 * `1:` already confirmed while every later read timed out — that last case must
 * still read dead, so parseable answers are FOLDED (mergePaneObservation)
 * instead of trusting the final read.
 */
const DEAD_PANE_POLL_INTERVAL_MS = 25;
const DEAD_PANE_MAX_READS = 240;
async function waitForDeadPane(
  tmux: TmuxRun,
  name: string,
  opts: { maxReads?: number; intervalMs?: number } = {},
): Promise<{ dead: boolean; status: string; seen: string }> {
  const maxReads = opts.maxReads ?? DEAD_PANE_MAX_READS;
  const intervalMs = opts.intervalMs ?? DEAD_PANE_POLL_INTERVAL_MS;
  let seen = '';
  let obs = { dead: false, status: '' };
  for (let reads = 0; reads < maxReads; reads += 1) {
    seen = String(tmux('display-message', '-p', '-t', name, '#{pane_dead}:#{pane_dead_status}:#{pane_pid}:#{pid}').stdout ?? '').trim();
    obs = mergePaneObservation(obs, seen);
    const [dead, status = '', panePid, serverPid] = seen.split(':');
    if (dead === '1') {
      if (status !== '') return { dead: true, status, seen };
      const kernel = readUnreapedPaneExit(Number(panePid), Number(serverPid));
      if (kernel) return { dead: true, status: kernel.kind === 'exited' ? String(kernel.code) : '', seen: `${seen} kernel=${JSON.stringify(kernel)}` };
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { dead: obs.dead, status: '', seen };
}

describe.skipIf(!realTmux)('tmux backend reports the pane pid\'s real exit code', () => {
  let dir: string;
  let socket: string;
  const saved: Record<string, string | undefined> = {};
  let seq = 0;

  // Per-call ceiling: a single hung tmux client blocks synchronously and never
  // reaches any retry/read counter, so without it one stuck spawnSync eats the
  // whole 30s hook budget and fails as the harder-to-read "Hook timed out".
  // A normal client answers in milliseconds; 5s only bites on a starved shard.
  const tmux = (...args: string[]) =>
    spawnSync(realTmux!, ['-S', socket, ...args], { encoding: 'utf8', timeout: 5_000 });

  /** One backend launch; resolves with the (code, signal) onExit reported. */
  const runToExit = async (script: string): Promise<{ code: number | null; signal: string | null }> => {
    const name = `bmx-exit${++seq}`;
    const backend = new TmuxPipeBackend(name, { createSession: true, ownsSession: true, socketName: socket });
    const workdir = mkdtempSync(join(tmpdir(), 'tmux-exit-cwd-'));
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${name} never reported an exit within ${EXIT_TIMEOUT_MS}ms`)),
          EXIT_TIMEOUT_MS,
        );
        backend.onExit((code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
        backend.spawn('/bin/sh', ['-c', script], {
          cwd: workdir,
          cols: 100,
          rows: 30,
          env: { ...process.env } as Record<string, string>,
          paneLaunchDir: workdir,
        });
      });
    } finally {
      rmSandboxScratch(workdir);
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmux-exit-'));
    socket = join(dir, 'socket');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -S '${socket}' "$@"\n`, { mode: 0o755 });
    for (const key of ['PATH', 'SHELL', 'TMUX', 'TMUX_PANE']) saved[key] = process.env[key];
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.SHELL = '/bin/sh';
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    tmux('kill-server');
    rmSandboxScratch(dir);
  });

  // 这两条是 PR 的全部意义所在：默认 tmux 后端必须能把「重试无意义」的退出码
  // 交给 daemon，否则 restart-policy 的永久通道在生产上是死代码。
  it('forwards 77 (identity/credential failure) instead of the historic sentinel 1', async () => {
    expect(await runToExit('sleep 1.5; exit 77')).toEqual({ code: 77, signal: null });
  });

  it('forwards 127 (missing executable, the shape /usr/bin/env produces) instead of 1', async () => {
    expect(await runToExit('sleep 1.5; exec /usr/bin/env /nonexistent-cli-xyz')).toEqual({ code: 127, signal: null });
  });

  // 秒崩（<100ms，127 的典型形态）走的是**启动失败**路径而非崩溃重启路径：
  // spawn() 抛错，worker 把它当 "CLI 启动失败" 报给用户（卡片上带最后一屏，
  // 明确写着「/usr/bin/env: ... No such file or directory」）。这条路径不需要
  // 也不应该依赖崩溃熔断——用户已经被告知具体原因。这里钉住这个分工，免得
  // 以后有人为了「让熔断也能收到秒崩」把它改成静默重启。
  it('treats an instantly-dying CLI as a startup failure (spawn throws, with the reason)', async () => {
    const backend = new TmuxPipeBackend(`bmx-instant${++seq}`, { createSession: true, ownsSession: true, socketName: socket });
    const workdir = mkdtempSync(join(tmpdir(), 'tmux-instant-'));
    try {
      expect(() => backend.spawn('/bin/sh', ['-c', 'exec /usr/bin/env /nonexistent-cli-instant'], {
        cwd: workdir, cols: 100, rows: 30, env: { ...process.env } as Record<string, string>, paneLaunchDir: workdir,
      })).toThrow(/启动后立即退出|No such file or directory/);
    } finally {
      rmSandboxScratch(workdir);
    }
  });

  // 普通非零退出同样要如实上报：熔断策略对 1 与 127 的处理不同，把 127 抖成 1
  // 会掩盖「命令没装」。
  it('forwards an ordinary non-zero code unchanged', async () => {
    expect(await runToExit('sleep 1.5; exit 3')).toEqual({ code: 3, signal: null });
  });

  // 信号死亡没有 tmux 可报的退出码（实测 `pane_dead_status` 为空）。这里钉的是
  // 「不得把信号死亡误归为永久失败」：它必须落回普通通道，而不是被当成 77/127
  // 那样一次就熔断的确定性错误。
  it('does not classify a signal death as a permanent exit', async () => {
    const { code } = await runToExit('sleep 1.5; kill -9 $$');
    expect(code === 77 || code === 127).toBe(false);
  });

  // `remain-on-exit failed` 会为一具崩溃的尸体留下整条 session；谁都不清理的话
  // 每次崩溃都漏一条。这里断言没漏（也包括信号死亡：它的 status 为空，只按
  // status 判清理会正好漏掉这一类）。
  // The remnant carries an EMPTY status when the CLI was killed by a signal
  // (`kill -9` has no exit code), so gating reaping on `pane_dead_status`
  // leaked exactly those sessions. Assert the signal case: it is the one that
  // proves reaping keys on `pane_dead`, not on a readable code.
  it('reaps the dead-pane remnant even when the CLI was signal-killed (no status)', async () => {
    const name = `bmx-reap${++seq}`;
    const backend = new TmuxPipeBackend(name, { createSession: true, ownsSession: true, socketName: socket });
    const workdir = mkdtempSync(join(tmpdir(), 'tmux-reap-'));
    try {
      const exited = await new Promise<{ code: number | null }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name}: no exit reported`)), EXIT_TIMEOUT_MS);
        backend.onExit((code) => { clearTimeout(timer); resolve({ code }); });
        backend.spawn('/bin/sh', ['-c', 'sleep 1.5; kill -9 $$'], {
          cwd: workdir, cols: 100, rows: 30, env: { ...process.env } as Record<string, string>, paneLaunchDir: workdir,
        });
      });
      // Signal death has no tmux status; the backend keeps the historic
      // sentinel (1) rather than inventing one. What matters here is that the
      // remnant is still reaped — see the has-session check below.
      expect(exited.code).toBe(1);
      const deadline = Date.now() + 5_000;
      let leftover = tmux('has-session', '-t', name).status === 0;
      while (leftover && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
        leftover = tmux('has-session', '-t', name).status === 0;
      }
      expect(leftover).toBe(false);
    } finally {
      rmSandboxScratch(workdir);
    }
  });

  /**
   * #2453: tmux publishes `pane_dead_status` only once it has reaped the pane
   * process. On CI it sometimes never did — the pane process stayed a zombie
   * child of the server for the rest of the test, the pane read `1:` (dead, no
   * status) throughout, and a real `exit 3` / `127` came out as 1.
   *
   * This lab makes that state deterministic instead of load-dependent: the
   * server is started with SIGCHLD blocked. tmux restores the signal mask it
   * inherited when it daemonises, so it never learns a pane died and never
   * reaps one — exactly the observed corpse, on every run.
   */
  // The lab uses remain-on-exit failed (modern tmux only); see realTmuxSupportsFailed.
  describe.skipIf(!python3 || process.platform !== 'linux' || !realTmuxSupportsFailed)('when the tmux server never reaps the pane process (#2453)', () => {
    const BLOCK_SIGCHLD_THEN_EXEC =
      'import os, signal, sys\n'
      + 'signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGCHLD})\n'
      + 'os.execv(sys.argv[1], sys.argv[1:])\n';

    beforeEach(() => {
      // The backend's sessions join the server this keeper session starts.
      const started = spawnSync(python3!, [
        '-c', BLOCK_SIGCHLD_THEN_EXEC,
        realTmux!, '-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'bmx-keeper', 'sleep 600',
      ], { encoding: 'utf8', timeout: 5_000 });
      expect(started.status).toBe(0);
    });

    // Without this the next two would pass vacuously on a server that reaps.
    it('the lab server really leaves a dead pane unreaped and status-less', async () => {
      tmux('new-session', '-d', '-s', 'bmx-unreaped', 'sh -c "exit 5"', ';', 'set-option', '-t', 'bmx-unreaped', 'remain-on-exit', 'on');
      let line = '';
      for (let reads = 0; reads < 200 && !line.startsWith('1:'); reads += 1) {
        await new Promise(r => setTimeout(r, 25));
        line = String(tmux('display-message', '-p', '-t', 'bmx-unreaped', '#{pane_dead}:#{pane_dead_status}:#{pane_pid}:#{pid}').stdout ?? '').trim();
      }
      // Give a reaping server ample time to publish; this one must not.
      await new Promise(r => setTimeout(r, 1_000));
      line = String(tmux('display-message', '-p', '-t', 'bmx-unreaped', '#{pane_dead}:#{pane_dead_status}:#{pane_pid}:#{pid}').stdout ?? '').trim();
      const [dead, status, panePid, serverPid] = line.split(':');
      expect({ dead, status }).toEqual({ dead: '1', status: '' });
      const stat = readFileSync(`/proc/${panePid}/stat`, 'utf8');
      const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      expect({ state, ppid }).toEqual({ state: 'Z', ppid: serverPid });
    });

    it('still forwards the real exit code', async () => {
      expect(await runToExit('sleep 1.5; exit 3')).toEqual({ code: 3, signal: null });
    });

    // #2459: the corpse fixture of the next describe waited for tmux to
    // publish the status, and on CI tmux did not within the whole wait.
    it('lets the corpse fixture learn the exit code tmux never publishes', async () => {
      tmux('new-session', '-d', '-s', 'bmx-corpse', 'sh -c "exit 77"', ';', 'set-option', '-t', 'bmx-corpse', 'remain-on-exit', 'failed');
      expect(await waitForDeadPane(tmux, 'bmx-corpse')).toMatchObject({ dead: true, status: '77' });
    });

    // The fixture's other kernel outcome: a signal death has no exit code, so
    // the wait ends with an empty status and says why in `seen`.
    it('lets the corpse fixture end on an unreaped signal death without inventing a code', async () => {
      tmux('new-session', '-d', '-s', 'bmx-signal-corpse', 'sh -c "kill -9 $$"', ';', 'set-option', '-t', 'bmx-signal-corpse', 'remain-on-exit', 'on');
      const result = await waitForDeadPane(tmux, 'bmx-signal-corpse');
      expect(result).toMatchObject({ dead: true, status: '' });
      expect(result.seen).toContain('kernel={"kind":"signaled","signal":9}');
    });

    it('keeps an unreaped signal death on the ordinary channel and reaps its remnant', async () => {
      expect(await runToExit('sleep 1.5; kill -9 $$')).toEqual({ code: 1, signal: null });
      const sessions = String(tmux('list-sessions', '-F', '#{session_name}').stdout ?? '').split('\n').filter(Boolean);
      expect(sessions).toEqual(['bmx-keeper']);
    });
  });
});

/**
 * N3：死 pane 在 tmux 眼里仍是「存在的会话」。任何拿会话存在性当存活证据的
 * 地方都必须先排除它，否则会话永远不报退出、且下一次启动会把尸体当活会话
 * attach。这两条钉的是 probe 层，也就是所有调用方共用的那一个判断。
 */
describe.skipIf(!realTmux)('tmux liveness probes treat a kept corpse as missing', () => {
  let dir: string;
  let socket: string;
  const saved: Record<string, string | undefined> = {};
  // Per-call ceiling. waitForDeadPane's read-count bound answers "how many reads still
  // saw nothing", but a single hung call blocks synchronously and never
  // reaches the counter — without a spawnSync timeout one stuck display-message
  // (or the two new-session setups in beforeEach) eats the whole 30s hook
  // budget and the failure surfaces as the harder-to-read "Hook timed out".
  // A normal tmux client answers in milliseconds; 5s only bites on a starved
  // shard, and a timed-out call returns status=null, which waitForDeadPane
  // treats like resolvePaneDeath's `unknown` and retries.
  const TMUX_CALL_TIMEOUT_MS = 5_000;
  const tmux = (...args: string[]) =>
    spawnSync(realTmux!, ['-S', socket, ...args], { encoding: 'utf8', timeout: TMUX_CALL_TIMEOUT_MS });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tmux-corpse-'));
    socket = join(dir, 'socket');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -S '${socket}' "$@"\n`, { mode: 0o755 });
    for (const key of ['PATH', 'SHELL']) saved[key] = process.env[key];
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.SHELL = '/bin/sh';
    // The corpse CLI exits IMMEDIATELY, with no sleep before the exit. We only
    // need a dead pane that recorded a status; we do NOT need one that lived
    // briefly. A `sleep N` ties "when is the pane dead" to the sh process
    // being scheduled for N wall-seconds — under a heavily starved shard that
    // death (and hence the first observable `1:77`) was pushed past the hook
    // timeout even though the option below is set atomically. Exiting at once
    // makes the pane dead essentially at creation; the atomic chain still
    // guarantees remain-on-exit is in effect, so status 77 is recorded.
    // Use `on` for the fixture so it also works on tmux <3.2 (where `failed`
    // is an unknown option); exit 77 is retained under BOTH `on` and
    // `failed`, and these probes only need a retained dead pane with its
    // status — the option mode does not change the lines they read.
    // The option MUST be chained ATOMICALLY into new-session (`\; set-option`,
    // one server queue, in order) — the same way createDetachedSession does it.
    // It is per session and must target the corpse itself, not the neighbour
    // — otherwise the corpse just vanishes on exit and the block tests nothing.
    tmux('new-session', '-d', '-s', 'bmx-live-one', 'sleep 60');
    tmux(
      'new-session', '-d', '-s', 'bmx-corpse', 'sh -c "exit 77"',
      ';', 'set-option', '-t', 'bmx-corpse', 'remain-on-exit', 'on',
    );
    // The corpse exits 77 at once, so its status must become known. A miss
    // means the corpse was not set up as intended; `seen` in the failure diff
    // shows how (see waitForDeadPane).
    expect(await waitForDeadPane(tmux, 'bmx-corpse')).toMatchObject({ dead: true, status: '77' });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    tmux('kill-server');
    rmSandboxScratch(dir);
  });

  // 前提本身也要钉住，否则下面两条断言可能因为尸体早被回收而假绿。
  it('the raw tmux answers still say the corpse session exists', () => {
    expect(tmux('has-session', '-t', 'bmx-corpse').status).toBe(0);
    const paneId = tmux('display-message', '-p', '-t', 'bmx-corpse', '#{pane_id}');
    expect(String(paneId.stdout).trim()).not.toBe('');
  });

  // The backend's own liveness probe is what the lifecycle watcher and every
  // guarded write consult, so THIS is where a corpse must read as missing.
  it('the backend\'s own liveness probe reports the corpse as missing', () => {
    const backend = new TmuxPipeBackend('bmx-corpse', { ownsSession: true, isReattach: true, socketName: socket });
    expect(backend.isPaneAlive()).toBe(false);
  });

  // Launch selection must not choose "reattach" for a corpse: that probe is
  // what the worker's backend gate consults before a spawn.
  it('launch selection reports the corpse as missing, not as a reattachable session', () => {
    expect(TmuxBackend.probeSessionForLaunch('bmx-corpse', socket)).toBe('missing');
    expect(TmuxBackend.probeSessionForLaunch('bmx-live-one', socket)).toBe('exists');
  });

  it('leaves a genuinely live session reported as alive', () => {
    const backend = new TmuxPipeBackend('bmx-live-one', { ownsSession: true, isReattach: true, socketName: socket });
    expect(backend.isPaneAlive()).toBe(true);
  });

  // Reattaching a fresh generation onto a corpse would point every later write
  // at a dead pane; report the exit instead so the restart policy decides.
  it('refuses to reattach to a corpse and reports its exit status', async () => {
    const backend = new TmuxPipeBackend('bmx-corpse', { ownsSession: true, isReattach: true, socketName: socket });
    const exited = await new Promise<{ code: number | null } | 'no-exit'>((resolve) => {
      const timer = setTimeout(() => resolve('no-exit'), 3_000);
      backend.onExit((code) => { clearTimeout(timer); resolve({ code }); });
      backend.spawn('/bin/sh', ['-c', 'exit 0'], {
        cwd: dir, cols: 100, rows: 30, env: { ...process.env } as Record<string, string>, paneLaunchDir: dir,
      });
    });
    expect(exited).toEqual({ code: 77 });
  });

  // PRODUCTION ORDERING: worker.ts calls backend.spawn() first and only wires
  // onExit afterwards (the main handler is registered after spawn returns).
  // The corpse refusal fires SYNCHRONOUSLY inside spawn(), so a fire straight
  // into an empty listener list would be lost — no watcher is started on that
  // branch either, and the session would silently stall (regression found
  // post-fix with a real-tmux probe). The exit must replay to the late
  // registration.
  it('delivers the synchronous corpse exit when onExit is wired only AFTER spawn', async () => {
    const backend = new TmuxPipeBackend('bmx-corpse', { ownsSession: true, isReattach: true, socketName: socket });
    backend.spawn('/bin/sh', ['-c', 'exit 0'], {
      cwd: dir, cols: 100, rows: 30, env: { ...process.env } as Record<string, string>, paneLaunchDir: dir,
    });
    const exited = await new Promise<{ code: number | null } | 'no-exit'>((resolve) => {
      const timer = setTimeout(() => resolve('no-exit'), 3_000);
      backend.onExit((code) => { clearTimeout(timer); resolve({ code }); });
    });
    expect(exited).toEqual({ code: 77 });
  });

  // An exit is a ONE-SHOT verdict. After the corpse branch reported 77, a later
  // stop (kill(), a stale watcher tick) must not re-deliver a different code to
  // listeners registered afterwards — that would hand the daemon two
  // contradictory crash reasons for the same CLI lifetime (and could restart a
  // session the policy had already decided to stop).
  it('reports exactly one exit verdict per CLI lifetime', async () => {
    const backend = new TmuxPipeBackend('bmx-corpse', { ownsSession: true, isReattach: true, socketName: socket });
    const seen: Array<number | null> = [];
    backend.spawn('/bin/sh', ['-c', 'exit 0'], {
      cwd: dir, cols: 100, rows: 30, env: { ...process.env } as Record<string, string>, paneLaunchDir: dir,
    });
    backend.onExit(code => seen.push(code));
    // A second teardown attempt after the verdict is already in.
    backend.kill();
    backend.kill();
    await new Promise(r => setTimeout(r, 300));
    // A listener registered later must still see the SAME first verdict.
    const late = await new Promise<{ code: number | null } | 'no-exit'>((resolve) => {
      const timer = setTimeout(() => resolve('no-exit'), 1_000);
      backend.onExit(code => { clearTimeout(timer); resolve({ code }); });
    });
    expect(seen).toEqual([77]);
    expect(late).toEqual({ code: 77 });
  });

  // The refusal must also reap the corpse session: otherwise the next launch's
  // new-session collides with the dead session of the same name.
  it('reaps the corpse session when refusing to reattach', async () => {
    const backend = new TmuxPipeBackend('bmx-corpse', { ownsSession: true, isReattach: true, socketName: socket });
    backend.spawn('/bin/sh', ['-c', 'exit 0'], {
      cwd: dir, cols: 100, rows: 30, env: { ...process.env } as Record<string, string>, paneLaunchDir: dir,
    });
    const deadline = Date.now() + 3_000;
    let exists = tmux('has-session', '-t', 'bmx-corpse').status === 0;
    while (exists && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
      exists = tmux('has-session', '-t', 'bmx-corpse').status === 0;
    }
    expect(exists).toBe(false);
  });
});

/**
 * Pure race handling for `#{pane_dead}` flipping before `#{pane_dead_status}`
 * is populated. Deterministic (no real tmux, injected read/sleep) — this is
 * exactly the window that turned a real `exit 3` into the fallback code 1
 * under CI load, so it must not rely on a timing-dependent end-to-end test.
 */
describe('mergePaneObservation (corpse waiter fold)', () => {
  const fold = (lines: string[]) => lines.reduce(mergePaneObservation, { dead: false, status: '' });
  const alive = { dead: false, status: '' };
  const deadNoCode = { dead: true, status: '' };

  // '' = unreadable read (a spawnSync timeout has null stdout under starvation);
  // '0:' explicit alive; '1:' dead w/o status; '1:77' dead+code. Only parseable
  // 0:/1: updates the observation; unreadable retains; a later explicit 0: wins.
  it.each([
    [['1:', '', '', ''], deadNoCode],
    [['1:77', '', ''], { dead: true, status: '77' }],
    [['1:', '', ''], deadNoCode],
    [['0:', ''], alive],
    [['', '1:'], deadNoCode],
    [['1:', '1:', '1:'], deadNoCode],
    [['', '1:', '0:'], alive],
    [['1:', '', '0:'], alive],
    [['1:', '0:', ''], alive],
    [['', '', ''], alive],
    [['1:', '0:'], alive],
  ] as const)('folds %j -> %j', (lines, expected) => {
    expect(fold([...lines])).toEqual(expected);
  });
});

// These drive the REAL fixture waiter (module-level waitForDeadPane) with a
// scripted tmux, so the fold is asserted on the loop the corpse describe
// actually calls — there is no second seam loop to bypass. 2-field lines give
// NaN pane/server pids, so the kernel probe names no /proc entry and fails
// closed (readUnreapedPaneExit returns null); only the tmux fold is exercised.
describe('waitForDeadPane folds parseable answers across reads', () => {
  const run = (lines: readonly string[]) => {
    let i = 0;
    const fakeTmux: TmuxRun = () => ({ stdout: lines[Math.min(i++, lines.length - 1)] });
    return waitForDeadPane(fakeTmux, 'bmx-fold', { maxReads: lines.length, intervalMs: 0 });
  };

  // The exact #2436 defect: a code-less death confirmed, then every later read
  // times out ('' = null stdout). Reverting the waiter to trust only its final
  // read (dead: seen.startsWith('1:')) must make THIS test red.
  it('keeps a confirmed code-less death when every later read times out', async () => {
    expect(await run(['1:', '', ''])).toMatchObject({ dead: true, status: '' });
  });

  it('keeps a death confirmed mid-run even though the last read is unreadable', async () => {
    expect(await run(['', '1:', ''])).toMatchObject({ dead: true, status: '' });
  });

  it('returns the real code as soon as a dead-with-code read arrives', async () => {
    expect(await run(['1:', '1:77'])).toMatchObject({ dead: true, status: '77' });
  });

  // The fixture estimates CURRENT state: an explicit alive answer after a
  // code-less death is adopted (production resolvePaneDeath instead latches —
  // see the boundary note above mergePaneObservation).
  it('adopts a later explicit 0: and ends unconfirmed when the budget then runs out', async () => {
    expect(await run(['1:', '0:', ''])).toMatchObject({ dead: false, status: '' });
  });

  it('stays unconfirmed when every read is unreadable', async () => {
    expect(await run(['', '', ''])).toMatchObject({ dead: false, status: '' });
  });
});

describe('resolvePaneDeath three-way verdict: alive / dead / unknown', () => {
  const noSleep = () => {};
  const OPTS = { attempts: 5, intervalMs: 0 };

  it('returns the dead status immediately when the first read carries it (no re-read)', () => {
    let reads = 0;
    const r = resolvePaneDeath('1:77', () => { reads += 1; return '1:77'; }, noSleep, OPTS);
    expect(r).toEqual({ kind: 'dead', status: 77 });
    expect(reads).toBe(0);
  });

  it('a live pane (0:) is alive and never re-read', () => {
    let reads = 0;
    const r = resolvePaneDeath('0:', () => { reads += 1; return '0:'; }, noSleep, OPTS);
    expect(r).toEqual({ kind: 'alive' });
    expect(reads).toBe(0);
  });

  it('polls through the 1: → 1:<code> gap and returns the real code', () => {
    const lines = ['1:', '1:3'];
    let reads = 0;
    const r = resolvePaneDeath('1:', () => lines[Math.min(reads++, lines.length - 1)]!, noSleep, OPTS);
    expect(r).toEqual({ kind: 'dead', status: 3 });
    expect(reads).toBe(2);
  });

  it('accepts a permanently-empty status as a status-less dead verdict (signal death)', () => {
    let reads = 0;
    const r = resolvePaneDeath('1:', () => { reads += 1; return '1:'; }, noSleep, OPTS);
    expect(r).toEqual({ kind: 'dead', status: null });
    expect(reads).toBe(OPTS.attempts);
  });

  it('an unreadable mid-poll line does not undo an already-confirmed death', () => {
    const lines = ['1:', '', '1:127'];
    let reads = 0;
    const r = resolvePaneDeath('1:', () => lines[Math.min(reads++, lines.length - 1)]!, noSleep, OPTS);
    expect(r).toEqual({ kind: 'dead', status: 127 });
  });

  it('keeps the confirmed death when every read after a transient error is unreadable', () => {
    const lines = ['1:', '', '', ''];
    let reads = 0;
    const r = resolvePaneDeath('1:', () => lines[Math.min(reads++, lines.length - 1)]!, noSleep, OPTS);
    expect(r).toEqual({ kind: 'dead', status: null });
  });

  it('respects the attempt bound when the status lands exactly on the last poll', () => {
    const lines = ['1:', '1:', '1:', '1:', '1:77'];
    let reads = 0;
    const r = resolvePaneDeath('1:', () => lines[Math.min(reads++, lines.length - 1)]!, noSleep, OPTS);
    expect(r).toEqual({ kind: 'dead', status: 77 });
    expect(reads).toBe(5);
  });

  // #2408 exit B: an UNREADABLE FIRST read used to return {dead:false} with
  // ZERO re-reads, collapsing a transient tmux timeout into "pane is fine" and
  // dropping both the real code and the corpse reap. It must retry.
  it('retries when the FIRST read is unreadable and then adopts the dead code', () => {
    // firstLine ('') is the unreadable first read and is passed directly; the
    // injected reader returns only SUBSEQUENT reads (so it starts at 1:77).
    let reads = 0;
    const r = resolvePaneDeath('', () => { reads += 1; return '1:77'; }, noSleep, OPTS);
    expect(r).toEqual({ kind: 'dead', status: 77 });
    expect(reads).toBe(1);
  });

  it('retries an unreadable first read through the 1: → 1:<code> gap', () => {
    const lines = ['1:', '1:127'];
    let reads = 0;
    const r = resolvePaneDeath('', () => lines[Math.min(reads++, lines.length - 1)]!, noSleep, OPTS);
    expect(r).toEqual({ kind: 'dead', status: 127 });
    expect(reads).toBe(2);
  });

  it('retries an unreadable first read and adopts an explicit alive answer', () => {
    let reads = 0;
    const r = resolvePaneDeath('', () => { reads += 1; return '0:'; }, noSleep, OPTS);
    expect(r).toEqual({ kind: 'alive' });
    expect(reads).toBe(1);
  });

  it('returns unknown only after the whole budget stays unreadable (never invents alive/dead)', () => {
    let reads = 0;
    const r = resolvePaneDeath('', () => { reads += 1; return ''; }, noSleep, OPTS);
    expect(r).toEqual({ kind: 'unknown' });
    // first read + attempts re-reads
    expect(reads).toBe(OPTS.attempts);
  });

  it('a 0: after death was already observed does not un-latch the dead verdict (dead is irreversible)', () => {
    const lines = ['1:77', '0:']; // first read already carries the code; returns at once
    let reads = 0;
    const r0 = resolvePaneDeath('1:77', () => lines[Math.min(reads++, lines.length - 1)]!, noSleep, OPTS);
    expect(r0).toEqual({ kind: 'dead', status: 77 });
    // and a glitch 0: while waiting on a status-less corpse does not revive it
    const glitch = ['1:', '0:', '1:127'];
    let r2 = 0;
    const r1 = resolvePaneDeath('1:', () => glitch[Math.min(r2++, glitch.length - 1)]!, noSleep, OPTS);
    expect(r1).toEqual({ kind: 'dead', status: 127 });
  });

  // #2453: `1:` because tmux has not reaped the pane process. The kernel's
  // record of that zombie is the same status tmux would publish, so it is
  // taken at once instead of waiting on a tmux that may never look.
  it('takes an unpublished exit code from the kernel for the pane and server pids on the line', () => {
    let reads = 0;
    const asked: Array<[number, number]> = [];
    const r = resolvePaneDeath('1::4242:99', () => { reads += 1; return '1::4242:99'; }, noSleep, OPTS, (pane, server) => {
      asked.push([pane, server]);
      return { kind: 'exited', code: 3 };
    });
    expect(r).toEqual({ kind: 'dead', status: 3 });
    expect(asked).toEqual([[4242, 99]]);
    expect(reads).toBe(0);
  });

  it('resolves an unreaped signal death as status-less without polling', () => {
    let reads = 0;
    const r = resolvePaneDeath('1::4242:99', () => { reads += 1; return '1::4242:99'; }, noSleep, OPTS, () => ({ kind: 'signaled', signal: 9 }));
    expect(r).toEqual({ kind: 'dead', status: null });
    expect(reads).toBe(0);
  });

  it('keeps asking tmux while the kernel has nothing (process reaped or still exiting)', () => {
    const lines = ['1::4242:99', '1::4242:99', '1:127:4242:99'];
    let reads = 0;
    let asked = 0;
    const r = resolvePaneDeath('1::4242:99', () => lines[Math.min(++reads, lines.length - 1)]!, noSleep, OPTS, () => {
      asked += 1;
      return null;
    });
    expect(r).toEqual({ kind: 'dead', status: 127 });
    expect(asked).toBe(2);
  });

  it('prefers a status tmux did publish, and never asks the kernel about a live pane', () => {
    const kernel = () => { throw new Error('kernel must not be consulted'); };
    expect(resolvePaneDeath('1:77:4242:99', () => '', noSleep, OPTS, kernel)).toEqual({ kind: 'dead', status: 77 });
    expect(resolvePaneDeath('0::4242:99', () => '', noSleep, OPTS, kernel)).toEqual({ kind: 'alive' });
  });
});;
