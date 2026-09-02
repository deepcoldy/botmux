/**
 * P1-12：Preview 端口的 listener 归属证明。
 *
 * 这里分两层：
 *   1) 真实 procfs + 真实进程：本机真的起一个监听进程，拿到归属证明；再让它退出、
 *      把同一个端口号交给**另一个**进程，复核必须判定失效。这正是评审里那条
 *      「dev server 退出后端口被别的宿主进程复用」的复现路径。
 *   2) 假 procfs 目录：内核表里那些真机上难以稳定构造的形状（0.0.0.0 通配、双栈
 *      `::`、SO_REUSEPORT 同址多 socket、持有者在血缘外），用真实文件与真实符号链接
 *      喂给同一份解析代码。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectSessionLineagePids,
  resolvePreviewPortOwner,
  verifyPreviewPortOwner,
} from '../src/core/preview-port-owner.js';
import {
  probeSessionPreviewTarget,
  sessionPreviewTargetStillOwned,
} from '../src/core/session-preview.js';
import { resolveSessionPreviewForProxy } from '../src/dashboard/preview-contract.js';

/**
 * Self-exit when reparented (the parent process died). Covers the residual
 * where vitest is Ctrl-C'd / crashes and afterEach never runs: the detached
 * children are in their own process group, so the terminal's SIGINT does not
 * reach them, and without this they would survive forever (one leaked
 * listener per aborted run).
 *
 * The criterion is "ppid CHANGED", not "ppid === 1": an ancestor that set
 * PR_SET_CHILD_SUBREAPER reparents orphans to itself instead of init, so
 * ppid would never become 1 there and the watchdog would silently never
 * fire. "Changed" fires for init, a subreaper, or any other reparenting
 * target. (Verified: with a subreaper ancestor, the orphaned grandchild's
 * ppid is the subreaper's pid, not 1.)
 */
const ORPHAN_WATCHDOG = 'const __parent = process.ppid; setInterval(() => { if (process.ppid !== __parent) process.exit(0); }, 1000);';

const LISTEN_SCRIPT = `
const net = require('net');
const s = net.createServer();
s.listen(0, '127.0.0.1', () => console.log('port ' + s.address().port));
${ORPHAN_WATCHDOG}
`;

/** 抢占一个指定端口号（模拟 dev server 退出后，别的本机进程拿到同一个号码）。 */
const REBIND_SCRIPT = `
const net = require('net');
const port = Number(process.argv[1]);
let tries = 0;
const attempt = () => {
  const s = net.createServer();
  s.once('error', () => {
    if (++tries > 60) { console.log('fail'); process.exit(1); }
    setTimeout(attempt, 50);
  });
  s.listen(port, '127.0.0.1', () => console.log('up'));
};
attempt();
${ORPHAN_WATCHDOG}
`;

/** 起一个孙子进程去监听：验证血缘是按 ppid 链向下走的，不是只看直接子进程。 */
const GRANDCHILD_SCRIPT = `
const cp = require('child_process');
const g = cp.spawn(process.execPath, ['-e', process.argv[1]], { stdio: ['ignore', 'pipe', 'ignore'] });
g.stdout.on('data', d => process.stdout.write(d));
${ORPHAN_WATCHDOG}
`;

const children: ChildProcess[] = [];
const tempRoots: string[] = [];
let inProcessServer: Server | null = null;

/**
 * Is `pid` its own process-group LEADER (pgid === pid)?
 *
 * This is the precondition that makes the group kill below safe, and it is NOT
 * self-evident from the call site: `process.kill(-N)` signals "the group whose
 * pgid is N", not "pid N and its descendants". A child spawned WITHOUT
 * `detached` sits in the PARENT's group, so `-childPid` names whatever group
 * happens to carry that number — usually nothing (ESRCH), but a recycled pid
 * that some `setsid` process once led can still have a live orphaned group, and
 * then the kill lands on unrelated processes.
 *
 * `process.getpgid` does not exist on Node 22 or Bun 1.4 (verified on both), so
 * the check reads field 5 of `/proc/<pid>/stat` — the fields after the `comm`
 * parenthesis are (state, ppid, pgrp, …), and `comm` itself may contain spaces
 * or parentheses, hence slicing from the LAST `)`.
 *
 * Unknown ⇒ false ⇒ the caller falls back to a single-process kill. That is the
 * safe direction: the grandchild case is Linux-only, and on any platform where
 * this cannot be answered there is no grandchild to reap.
 */
function isOwnGroupLeader(pid: number): boolean {
  try {
    const getpgid = (process as unknown as { getpgid?: (p: number) => number }).getpgid;
    if (typeof getpgid === 'function') return getpgid(pid) === pid;
    if (process.platform !== 'linux') return false;
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(afterComm[2]) === pid;
  } catch {
    return false; /* unreadable → treat as "not a leader" */
  }
}

/**
 * Kill the child's whole PROCESS GROUP, not just the child.
 *
 * `GRANDCHILD_SCRIPT` deliberately spawns a grandchild (that is the point of the
 * lineage test), and both scripts hold an idle `setInterval`. Killing only the
 * direct child left every grandchild reparented to init and running forever:
 * one leaked listener per run, each holding a port and ~40MB. On this host that
 * had accumulated to 738 orphans / ~28GB PSS before it was noticed.
 *
 * `startChild` spawns detached so each child leads its own group — but that
 * coupling lives in a different function, so it is asserted here rather than
 * assumed: a group kill is only issued for a confirmed group leader. The
 * negative pid needs `process.kill`; `child.kill()` only ever signals the one
 * process.
 */
function killChildTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined && isOwnGroupLeader(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch { /* group already gone */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

afterEach(async () => {
  for (const child of children.splice(0)) killChildTree(child);
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (inProcessServer) {
    await new Promise<void>(resolve => inProcessServer!.close(() => resolve()));
    inProcessServer = null;
  }
});

function startChild(script: string, args: string[] = []): ChildProcess {
  const child = spawn(process.execPath, ['-e', script, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
    // Own process group, so afterEach can reap the grandchildren too
    // (see killChildTree). Not unref'd: these children stay tracked in
    // `children` and are killed explicitly.
    detached: true,
  });
  children.push(child);
  return child;
}

function waitForLine(child: ChildProcess, match: RegExp, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${match}`)), timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', chunk => {
      buffer += String(chunk);
      const found = buffer.split('\n').find(line => match.test(line));
      if (found === undefined) return;
      clearTimeout(timer);
      resolve(found.trim());
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`listener exited early (code ${code})`));
    });
  });
}

async function startExternalListener(): Promise<{ child: ChildProcess; port: number }> {
  const child = startChild(LISTEN_SCRIPT);
  const line = await waitForLine(child, /^port \d+$/);
  return { child, port: Number(line.slice('port '.length)) };
}

describe.skipIf(process.platform !== 'linux')('P1-12 preview listener ownership (real procfs)', () => {
  it('proves which process holds the port and rejects a port taken over by another process', async () => {
    const listener = await startExternalListener();

    const resolved = resolvePreviewPortOwner({
      host: '127.0.0.1',
      port: listener.port,
      ownerPids: [listener.child.pid],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.proof.pid).toBe(listener.child.pid);
    expect(verifyPreviewPortOwner({ host: '127.0.0.1', port: listener.port, proof: resolved.proof }))
      .toBe('ok');

    // dev server 退出：端口号交还内核。
    const exited = new Promise<void>(resolve => listener.child.once('exit', () => resolve()));
    listener.child.kill('SIGKILL');
    await exited;
    expect(verifyPreviewPortOwner({ host: '127.0.0.1', port: listener.port, proof: resolved.proof }))
      .toBe('changed');

    // 另一个**完全无关**的本机进程抢到了同一个号码。一次 TCP connect 会成功——这正是
    // 旧实现被骗的地方——归属复核必须判定失效。
    const squatter = startChild(REBIND_SCRIPT, [String(listener.port)]);
    expect(await waitForLine(squatter, /^(up|fail)$/)).toBe('up');
    expect(verifyPreviewPortOwner({ host: '127.0.0.1', port: listener.port, proof: resolved.proof }))
      .toBe('changed');
  });

  it('refuses a listener outside the session lineage and follows a real ppid chain into it', async () => {
    const outsider = startChild('setInterval(() => {}, 1000); console.log("ready");');
    await waitForLine(outsider, /^ready$/);
    const listener = await startExternalListener();

    // 端口可达，但血缘根是另一个进程 → 拿不到归属证明。
    expect(resolvePreviewPortOwner({
      host: '127.0.0.1',
      port: listener.port,
      ownerPids: [outsider.pid],
    })).toEqual({ ok: false, reason: 'owner_unknown' });

    // 真实多层血缘：worker → CLI → shell → dev server 的形状，用「孙子进程监听」表达。
    const grandparent = startChild(GRANDCHILD_SCRIPT, [LISTEN_SCRIPT]);
    const line = await waitForLine(grandparent, /^port \d+$/);
    const grandchildPort = Number(line.slice('port '.length));
    const nested = resolvePreviewPortOwner({
      host: '127.0.0.1',
      port: grandchildPort,
      ownerPids: [grandparent.pid],
    });
    expect(nested.ok).toBe(true);
    if (!nested.ok) return;
    expect(nested.proof.pid).not.toBe(grandparent.pid);
    expect(collectSessionLineagePids('/proc', [grandparent.pid!])).toContain(nested.proof.pid);
  });

  it('detects a same-process relisten: a new socket on the same port is a new inode', async () => {
    inProcessServer = createServer();
    await new Promise<void>(resolve => inProcessServer!.listen(0, '127.0.0.1', resolve));
    const port = (inProcessServer.address() as { port: number }).port;
    const resolved = resolvePreviewPortOwner({ host: '127.0.0.1', port, ownerPids: [process.pid] });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    await new Promise<void>(resolve => inProcessServer!.close(() => resolve()));
    inProcessServer = createServer();
    await new Promise<void>(resolve => inProcessServer!.listen(port, '127.0.0.1', resolve));

    // 同一个 pid、同一个端口号，但换了一个 listen socket。旧证明不能继续生效。
    expect(verifyPreviewPortOwner({ host: '127.0.0.1', port, proof: resolved.proof })).toBe('changed');
  });

  it('the proxy stops routing the moment the port changes hands, and asks for the target to be retired', async () => {
    const listener = await startExternalListener();
    const probe = await probeSessionPreviewTarget({
      port: listener.port,
      ownerPids: [listener.child.pid],
      workerGeneration: 3,
    });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;

    const row = {
      sessionId: 's1',
      larkAppId: 'app-a',
      status: 'idle',
      backendType: 'pty',
      previewTarget: probe.target,
    };
    const retired: string[] = [];
    const resolveNow = () => resolveSessionPreviewForProxy({
      row,
      sessionId: 's1',
      ownerLarkAppId: 'app-a',
      daemonOnline: true,
      // 生产接线就是这个函数（dashboard.ts 传的同一个）。
      isTargetOwned: sessionPreviewTargetStillOwned,
      onStaleTarget: sessionId => retired.push(sessionId),
    });

    expect(resolveNow()).toEqual({ ok: true, target: probe.target });
    expect(retired).toEqual([]);

    // dev server 退出，另一个本机进程抢到同一个端口号：TCP 依然连得通。
    const exited = new Promise<void>(resolve => listener.child.once('exit', () => resolve()));
    listener.child.kill('SIGKILL');
    await exited;
    const squatter = startChild(REBIND_SCRIPT, [String(listener.port)]);
    expect(await waitForLine(squatter, /^(up|fail)$/)).toBe('up');

    expect(resolveNow()).toEqual({ ok: false, status: 409, error: 'preview_target_stale' });
    expect(retired).toEqual(['s1']);
  });

  it('has no fallback: a target registered on Linux is unverifiable off procfs', () => {
    const missingRoot = mkdtempSync(join(tmpdir(), 'preview-owner-empty-'));
    tempRoots.push(missingRoot);
    expect(verifyPreviewPortOwner({
      host: '127.0.0.1',
      port: 4173,
      proof: { pid: 4242, procStart: '918273', inode: '556677' },
      procRoot: missingRoot,
    })).toBe('unverifiable');
  });

  it('orphan watchdog: a script self-exits when its parent dies', async () => {
    // The watchdog criterion is "ppid CHANGED", not "ppid === 1" (see
    // ORPHAN_WATCHDOG): a PR_SET_CHILD_SUBREAPER ancestor reparents orphans to
    // itself, so ppid === 1 would never fire there. This test only asserts the
    // change-triggered exit; the reparenting target (init or subreaper) is
    // irrelevant to the criterion.
    const WATCHDOG = 'const parent = process.ppid; setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 100);';
    const NO_WATCHDOG = 'setInterval(() => {}, 100);';
    // Each grandparent spawns a grandchild and exits after the grandchild has
    // started (1000ms, ~20x Node startup), so the grandchild records its
    // ORIGINAL ppid before the reparenting.
    const spawnAndExit = (grandchildScript: string) => startChild(`
      const cp = require('child_process');
      const g = cp.spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
      console.log(g.pid);
      setTimeout(() => process.exit(0), 1000);
    `);
    const watchdogGrandparent = spawnAndExit(WATCHDOG);
    const noWatchdogGrandparent = spawnAndExit(NO_WATCHDOG);
    const watchdogPid = Number(await waitForLine(watchdogGrandparent, /^\d+$/));
    const noWatchdogPid = Number(await waitForLine(noWatchdogGrandparent, /^\d+$/));

    const isAlive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };

    // Watchdog grandchild: ppid changed → exits within ~100ms of the grandparent's exit.
    const watchdogExited = await new Promise<boolean>((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (!isAlive(watchdogPid)) { clearInterval(timer); resolve(true); return; }
        if (Date.now() - start > 5000) { clearInterval(timer); resolve(false); }
      }, 50);
      timer.unref?.();
    });

    // Negative control: without the watchdog, the grandchild survives the
    // reparenting (proves the watchdog is load-bearing, not the OS cleaning up).
    // Kill it before asserting so a failed assertion cannot leak it.
    const noWatchdogSurvived = isAlive(noWatchdogPid);
    try { process.kill(noWatchdogPid, 'SIGKILL'); } catch { /* already gone */ }

    expect(watchdogExited).toBe(true);
    expect(noWatchdogSurvived).toBe(true);
  });
});

/** 用真实文件/真实符号链接搭一个 procfs 视图，喂给同一份解析代码。 */
function fakeProc(spec: {
  tcp?: string[];
  tcp6?: string[];
  processes?: Array<{ pid: number; ppid: number; startTime: string; comm?: string; inodes?: string[] }>;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'preview-owner-proc-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'net'), { recursive: true });
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  writeFileSync(join(root, 'net', 'tcp'), header + (spec.tcp ?? []).join('\n') + '\n');
  writeFileSync(join(root, 'net', 'tcp6'), header + (spec.tcp6 ?? []).join('\n') + '\n');
  for (const proc of spec.processes ?? []) {
    const dir = join(root, String(proc.pid));
    mkdirSync(join(dir, 'fd'), { recursive: true });
    const tail = Array.from({ length: 24 }, (_, i) => (i === 19 ? proc.startTime : '0'));
    writeFileSync(
      join(dir, 'stat'),
      `${proc.pid} (${proc.comm ?? 'node'}) S ${proc.ppid} ${tail.slice(2).join(' ')}\n`,
    );
    (proc.inodes ?? []).forEach((inode, index) => {
      symlinkSync(`socket:[${inode}]`, join(dir, 'fd', String(index + 3)));
    });
  }
  return root;
}

/** `<sl>: <addr>:<port> …` — 只有 state 0A（LISTEN）会被采纳。 */
function tcpRow(addrHex: string, port: number, inode: string, state = '0A'): string {
  const portHex = port.toString(16).toUpperCase().padStart(4, '0');
  return `   0: ${addrHex}:${portHex} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
}

describe('P1-12 preview listener ownership (kernel table shapes)', () => {
  it('matches wildcard and dual-stack binds, preferring the most specific listener', () => {
    // 0.0.0.0 通配（dev server 常见）与双栈 `::`：都服务 127.0.0.1，但更具体的那个先。
    const wildcardOnly = fakeProc({
      tcp: [tcpRow('00000000', 4173, '900001')],
      processes: [{ pid: 1000, ppid: 1, startTime: '111', inodes: ['900001'] }],
    });
    expect(resolvePreviewPortOwner({
      host: '127.0.0.1', port: 4173, ownerPids: [1000], procRoot: wildcardOnly,
    })).toEqual({ ok: true, proof: { pid: 1000, procStart: '111', inode: '900001' } });

    const dualStackOnly = fakeProc({
      tcp6: [tcpRow('00000000000000000000000000000000', 4173, '900002')],
      processes: [{ pid: 1000, ppid: 1, startTime: '111', inodes: ['900002'] }],
    });
    expect(resolvePreviewPortOwner({
      host: '127.0.0.1', port: 4173, ownerPids: [1000], procRoot: dualStackOnly,
    })).toMatchObject({ ok: true, proof: { inode: '900002' } });

    const both = fakeProc({
      tcp: [tcpRow('0100007F', 4173, '900003')],
      tcp6: [tcpRow('00000000000000000000000000000000', 4173, '900004')],
      processes: [
        { pid: 1000, ppid: 1, startTime: '111', inodes: ['900003'] },
        { pid: 1001, ppid: 1, startTime: '222', inodes: ['900004'] },
      ],
    });
    expect(resolvePreviewPortOwner({
      host: '127.0.0.1', port: 4173, ownerPids: [1000, 1001], procRoot: both,
    })).toMatchObject({ ok: true, proof: { pid: 1000, inode: '900003' } });
    // ::1 走 v6 表：同一个端口号上的 v4 socket 不能冒充它。
    expect(resolvePreviewPortOwner({
      host: '::1', port: 4173, ownerPids: [1000, 1001], procRoot: both,
    })).toMatchObject({ ok: true, proof: { pid: 1001, inode: '900004' } });
  });

  it('fails closed on a non-listening socket, an ambiguous SO_REUSEPORT pair, and a foreign holder', () => {
    const established = fakeProc({
      tcp: [tcpRow('0100007F', 4173, '900005', '01')],
      processes: [{ pid: 1000, ppid: 1, startTime: '111', inodes: ['900005'] }],
    });
    expect(resolvePreviewPortOwner({
      host: '127.0.0.1', port: 4173, ownerPids: [1000], procRoot: established,
    })).toEqual({ ok: false, reason: 'no_listener' });

    const reusePort = fakeProc({
      tcp: [tcpRow('0100007F', 4173, '900006'), tcpRow('0100007F', 4173, '900007')],
      processes: [
        { pid: 1000, ppid: 1, startTime: '111', inodes: ['900006'] },
        { pid: 1001, ppid: 1, startTime: '222', inodes: ['900007'] },
      ],
    });
    expect(resolvePreviewPortOwner({
      host: '127.0.0.1', port: 4173, ownerPids: [1000], procRoot: reusePort,
    })).toEqual({ ok: false, reason: 'ambiguous_listener' });

    // 宿主上的 Docker API / 别人的 dev server：监听在那儿，但不在本会话血缘里。
    const foreign = fakeProc({
      tcp: [tcpRow('0100007F', 2375, '900008')],
      processes: [
        { pid: 500, ppid: 1, startTime: '50', comm: 'dockerd', inodes: ['900008'] },
        { pid: 1000, ppid: 1, startTime: '111', inodes: [] },
        { pid: 1010, ppid: 1000, startTime: '112', inodes: [] },
      ],
    });
    expect(resolvePreviewPortOwner({
      host: '127.0.0.1', port: 2375, ownerPids: [1000], procRoot: foreign,
    })).toEqual({ ok: false, reason: 'owner_unknown' });

    // init 不能当血缘根：那等于「本机任何进程都算数」，形同没有证明。
    expect(resolvePreviewPortOwner({
      host: '127.0.0.1', port: 2375, ownerPids: [1], procRoot: foreign,
    })).toEqual({ ok: false, reason: 'owner_unknown' });
  });

  it('treats a pid reused after the original exited as a changed owner', () => {
    const before = fakeProc({
      tcp: [tcpRow('0100007F', 4173, '900009')],
      processes: [{ pid: 1000, ppid: 1, startTime: '111', inodes: ['900009'] }],
    });
    const resolved = resolvePreviewPortOwner({
      host: '127.0.0.1', port: 4173, ownerPids: [1000], procRoot: before,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(verifyPreviewPortOwner({
      host: '127.0.0.1', port: 4173, proof: resolved.proof, procRoot: before,
    })).toBe('ok');

    // 同一个 inode 还在监听，但 pid 1000 已经是另一个进程（starttime 变了）。
    const pidReused = fakeProc({
      tcp: [tcpRow('0100007F', 4173, '900009')],
      processes: [{ pid: 1000, ppid: 1, startTime: '999', inodes: ['900009'] }],
    });
    expect(verifyPreviewPortOwner({
      host: '127.0.0.1', port: 4173, proof: resolved.proof, procRoot: pidReused,
    })).toBe('changed');
  });
});
