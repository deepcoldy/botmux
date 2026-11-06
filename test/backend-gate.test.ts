import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decideBackendGate,
  backendGateUserMessage,
  backendSandboxCompatibilityUserMessage,
} from '../src/adapters/backend/session-backend-selector.js';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

describe('decideBackendGate (PTY 退役 hard gate)', () => {
  it('always spawns when PTY is explicitly requested (escape hatch), even if "unavailable"', () => {
    expect(
      decideBackendGate({ requested: 'pty', available: false, hasExistingSession: false }),
    ).toEqual({ action: 'spawn' });
  });

  it('spawns tmux when the functional probe passes', () => {
    expect(
      decideBackendGate({ requested: 'tmux', available: true, hasExistingSession: false }),
    ).toEqual({ action: 'spawn' });
  });

  it('GATES tmux when probe fails and no live session exists (no silent PTY fallback)', () => {
    const d = decideBackendGate({ requested: 'tmux', available: false, hasExistingSession: false });
    expect(d.action).toBe('gate');
  });

  it('reattaches a live tmux session despite a transient probe failure (PR#249 exemption)', () => {
    expect(
      decideBackendGate({ requested: 'tmux', available: false, hasExistingSession: true }),
    ).toEqual({ action: 'spawn' });
  });

  it('gates herdr / zellij / zmx when unavailable instead of degrading to PTY', () => {
    expect(decideBackendGate({ requested: 'herdr', available: false, hasExistingSession: false }).action).toBe('gate');
    expect(decideBackendGate({ requested: 'zellij', available: false, hasExistingSession: false }).action).toBe('gate');
    expect(decideBackendGate({ requested: 'zmx', available: false, hasExistingSession: false }).action).toBe('gate');
  });

  it('keeps the generic existing-session exemption available for transient probes', () => {
    expect(
      decideBackendGate({ requested: 'zmx', available: false, hasExistingSession: true }),
    ).toEqual({ action: 'spawn' });
  });

  /**
   * Regression: `hasSession()` is `probeSession() === 'exists'`, so it answers
   * `false` both for "no such session" and for "the probe got no answer".
   * Under host load the zellij existence check (`list-sessions`, needs a
   * fork+exec) can be killed by its own timeout; the functional probe then
   * spawns a background session and times out under the same pressure, and a
   * session whose pane was alive the whole time got gated with
   * "zellij 不可用".
   */
  it('does NOT gate zellij when the existence check itself got no answer', () => {
    expect(
      decideBackendGate({
        requested: 'zellij',
        available: false,
        hasExistingSession: false,
        existingSessionUnknown: true,
      }),
    ).toEqual({ action: 'spawn' });
  });

  it('still gates zellij when the session is PROVABLY absent and the probe failed', () => {
    // The guard must keep its teeth: an authoritative "no such session" plus a
    // failed capability probe is the real "zellij is broken" case.
    expect(
      decideBackendGate({
        requested: 'zellij',
        available: false,
        hasExistingSession: false,
        existingSessionUnknown: false,
      }).action,
    ).toBe('gate');
  });

  it('still gates ZMX on an indeterminate ownership probe (opposite asymmetry, unchanged)', () => {
    // ZMX deliberately gates when ownership/protocol cannot be established —
    // adopting someone else's session is the worse outcome there. It never sets
    // existingSessionUnknown, so the zellij/tmux exemption must not reach it.
    expect(
      decideBackendGate({ requested: 'zmx', available: false, hasExistingSession: false }).action,
    ).toBe('gate');
  });

  it('gates on an indeterminate zellij probe ONLY via the explicit flag, not via available=false', () => {
    // Sanity: the exemption is opt-in per call site. A caller that never sets
    // the flag keeps the old fail-closed behaviour.
    expect(
      decideBackendGate({ requested: 'zellij', available: false, hasExistingSession: false }).action,
    ).toBe('gate');
  });
});

describe('backendGateUserMessage', () => {
  it('includes the reason, an install hint, and the explicit PTY escape hatch', () => {
    const msg = backendGateUserMessage('tmux', 'tmux 二进制不在 PATH 上');
    expect(msg).toContain('tmux 不可用');
    expect(msg).toContain('tmux 二进制不在 PATH 上');
    expect(msg).toContain('brew install tmux');
    expect(msg).toContain('BACKEND_TYPE=pty');
  });

  it('includes the supported ZMX version floor and an actionable install hint', () => {
    const msg = backendGateUserMessage('zmx', 'zmx 二进制不在 PATH 上');
    expect(msg).toContain('zmx >= 0.7.0');
    expect(msg).toContain('client leadership');
    // The hint must tell the user how to actually install it, not to wait for
    // an unreleased upstream build (0.7.0 has shipped).
    expect(msg).toContain('brew install neurosnap/tap/zmx');
    expect(msg).not.toContain('等待');
  });

  it('for clone3 EPERM (seccomp) shows the sandbox fix, NOT any tmux install command', () => {
    const reason = 'tmux new-session 启动失败：tmux 已安装，但当前运行环境（容器 seccomp/沙箱）禁止进程克隆（clone3 返回 EPERM / Operation not permitted），tmux server 无法启动';
    const msg = backendGateUserMessage('tmux', reason);
    expect(msg).toContain('tmux 不可用');
    expect(msg).toContain(reason);
    expect(msg).toContain('clone3');
    expect(msg).toContain('seccomp');
    expect(msg).toContain('BACKEND_TYPE=pty');
    expect(msg).toContain('不跨 daemon 重启存活');
    // No install guidance whatsoever — the binary is already installed.
    expect(msg).not.toMatch(/install/i);
    expect(msg).not.toContain('brew');
    expect(msg).not.toContain('apt');
  });

  it('keeps the install guidance for an ENOENT (missing) tmux', () => {
    const msg = backendGateUserMessage('tmux', 'tmux -V 启动失败：找不到 tmux 可执行文件（ENOENT）');
    expect(msg).toContain('brew install tmux');
    expect(msg).toContain('apt-get');
    expect(msg).toContain('BACKEND_TYPE=pty');
  });

  it('keeps the generic guidance (with raw reason) for unclassified failures', () => {
    const msg = backendGateUserMessage('tmux', 'tmux new-session 失败：server temporarily busy');
    expect(msg).toContain('server temporarily busy');
    expect(msg).toContain('brew install tmux');
  });

  it('does not apply the tmux env-denied wording to other backends', () => {
    const msg = backendGateUserMessage('zmx', 'clone3 EPERM in some probe text');
    expect(msg).toContain('brew install neurosnap/tap/zmx');
    expect(msg).not.toContain('seccomp');
  });
});

describe('persistent-backend filesystem-isolation gate', () => {
  it('formats an actionable startup error before failing closed', () => {
    const msg = backendSandboxCompatibilityUserMessage(
      'backend "zmx" does not support file/read isolation',
    );
    expect(msg).toContain('backend "zmx"');
    expect(msg).toContain('拒绝启动');
    expect(msg).toContain('tmux');
    expect(msg).toContain('pty');
    expect(msg).toContain('sandbox');
    expect(msg).toContain('readIsolation');
  });

  // 源码结构护栏(K2)：沙箱围栏——不支持文件/读隔离的持久后端在 sandbox 开启时必须拒启，且判定先于后端
  // 选择/herdr 退役等任何后端变更。判定函数 backendSandboxCompatibilityError 已有行为测试
  // （mojo-wiring.test.ts），但它在 worker 巨型 spawn 闭包里的接线没有行为 seam；漏传 sandbox 请求或吞掉
  // 返回值会让沙箱会话静默跑在无隔离的后端上（#458 引入）。
  it('refuses an isolation-incompatible backend before selecting or mutating it', () => {
    const gateCall = workerSource.match(
      /const (\w+) = backendSandboxCompatibilityError\(\{([\s\S]*?)\}\);\s*if \(\1\) \{\s*throw new Error\(/,
    );
    expect(gateCall, 'compatibility verdict must be thrown, not ignored').not.toBeNull();
    expect(gateCall![2]).toMatch(/fileSandboxRequested:\s*sandboxRequested\b/);
    const gateAt = gateCall!.index!;
    for (const mutation of ['retireSupersededRecordedHerdrTarget(', 'const selectBackend =']) {
      expect(workerSource.indexOf(mutation), mutation).toBeGreaterThan(gateAt);
    }
  });
});

describe('read-isolation persistent-pane teardown', () => {
  // 源码结构护栏(K2)：沙箱围栏——开启 read-isolation 时旧的未隔离持久 pane 必须被确认杀掉才能冷启新 pane。
  // 状态机/执行器的真值表与顺序在 read-isolation.test.ts 有行为测试，这里守 worker 闭包里的接线：三态存活
  // 探测喂给状态机（unknown → 拒启）、kill 与 post-kill 探测针对重选前捕获的同一 target、只有权威 'missing'
  // 才算拆除成功，之后才重选后端。否则会围着一个可能仍存活、仍在旧围栏下的 pane 发布新一代（#899）。
  // post-kill 探测走统一的 kill 后入口 probePaneAfterKill：只对 kill 刚让 tmux server 退出时的瞬时 unknown
  // 有界重探，重探完仍 unknown 照样拒启（行为由 sandbox-relay-lifecycle 的注入用例守）。
  it('fails closed unless the exact captured stale target is proven gone before re-selection', () => {
    const start = workerSource.indexOf('evaluatePersistentPaneMigration({');
    const end = workerSource.indexOf('executePersistentPaneMigration(migration', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = workerSource.slice(start, end);

    expect(block).toMatch(/\bpaneProbe,/);
    expect(block).toContain('refuseInconclusiveProbe:');
    const capture = block.match(/const (\w+) = selectedBackend\.persistentBackendTarget;/);
    expect(capture).not.toBeNull();
    const target = capture![1];
    const kill = block.indexOf(`killPersistentBackendTarget(${target}`, capture!.index);
    const probe = block.search(new RegExp(`probePaneAfterKill\\(\\w+, ${target}\\)`));
    const strict = block.indexOf("postKillProbe !== 'missing'", probe);
    const reselect = block.indexOf('selectedBackend = selectBackend();', strict);
    expect(kill).toBeGreaterThan(capture!.index!);
    expect(probe).toBeGreaterThan(kill);
    expect(strict).toBeGreaterThan(probe);
    expect(reselect).toBeGreaterThan(strict);
  });

  // 源码结构护栏(K2)：kill 后确认 pane 已消失的统一入口 probePaneAfterKill 里，zmx 必须走拥有式的
  // probeOwnedZmxSession（完整 sessionId + 冻结 PID）；换成 target 级的 after-kill 探测会悄悄降级成按名字探测，
  // 把同名的别家会话当成自己的（#2166）。入口是 spawnCli 里的闭包、CI 上也没有真实 zmx 运行时，没有行为 seam，
  // 只能钉这条分支的接线；tmux 分支的行为由 sandbox-relay-lifecycle 的注入用例守。
  it('keeps the owned ZMX probe in the shared post-kill entry', () => {
    const start = workerSource.indexOf('const probePaneAfterKill = ');
    expect(start).toBeGreaterThan(-1);
    const entry = workerSource.slice(start, workerSource.indexOf('\n  );\n', start));
    const zmxBranch = entry.indexOf("effectiveBackendType === 'zmx'");
    const owned = entry.indexOf('probeOwnedZmxSession(', zmxBranch);
    const afterKill = entry.indexOf('probePersistentBackendTargetAfterKill(');
    expect(zmxBranch).toBeGreaterThan(-1);
    expect(owned).toBeGreaterThan(zmxBranch);
    expect(afterKill).toBeGreaterThan(owned);
  });
});
