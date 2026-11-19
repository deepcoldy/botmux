/**
 * 真实 tmux 拓扑下的 CLI 宿主存活探针 smoke 测试。
 *
 * 针对 PR 复核提出的边界：「执行服务退出、终端客户端仍活着」时探针必须仍
 * 报告存活。复现 opencode2 的托管服务进程模型：
 *
 *   tmux pane → client.sh （=TUI 客户端，backend.getChildPid 取 pane_pid）
 *                 └── serve （执行服务，真正跑工具、写状态库）
 *
 * 实测 opencode 2.0.32：serve 被 kill -9 后，存活的 TUI 在约 8s 内自动重启
 * serve、对账残留 running part 并注入 synthetic 消息续跑回合，因此「客户端
 * 存活」就是忙碌态应继续保持的承诺边界；只有 pane（客户端）本身退出才
 * fail-open。
 *
 * Skipped automatically when tmux is unavailable (e.g. CI without tmux).
 *
 * Run: npx vitest run test/cli-backend-liveness.smoke.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliProcessAliveFromBackend } from '../src/adapters/cli/backend-liveness.js';

function tmuxAvailable(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}
const hasTmux = tmuxAvailable();

const SESSION = 'liveness-probe-smoke';
let workDir: string;
let sockDir: string;

function tmux(args: string[], input?: string) {
  return execFileSync('tmux', ['-S', join(sockDir, 'sock'), ...args], {
    input, stdio: input ? ['pipe', 'pipe', 'ignore'] : ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
}

describe('cliProcessAliveFromBackend — real tmux client/serve topology', () => {
  beforeAll(() => {
    if (!hasTmux) return;
    workDir = mkdtempSync(join(tmpdir(), 'bmx-liveness-'));
    sockDir = mkdtempSync(join(tmpdir(), 'bmx-liveness-sock-'));
    // client.sh：启动「执行服务」（长睡眠子进程，pid 落盘），serve 死后
    // 客户端不退出（模拟真实 TUI 的自动重启 / 阻塞覆盖层），持续存活直到
    // pane 本身被杀。
    writeFileSync(join(workDir, 'client.sh'),
      '#!/bin/sh\n'
      + 'sleep 600 & SERVE=$!\n'
      + 'echo $SERVE > serve.pid\n'
      + 'while kill -0 $SERVE 2>/dev/null; do sleep 0.2; done\n'
      + 'echo SERVE_DIED\n'
      + 'sleep 600\n',
      { mode: 0o755 });
  });

  afterAll(() => {
    if (!hasTmux) return;
    try { tmux(['kill-session', '-t', SESSION]); } catch { /* ignore */ }
    rmSync(workDir, { recursive: true, force: true });
    rmSync(sockDir, { recursive: true, force: true });
  });

  it.skipIf(!hasTmux)('keeps the host alive after the execution child dies, then fails open when the pane dies', async () => {
    tmux(['new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50', '-c', workDir, './client.sh']);
    const panePid = Number(tmux(['list-panes', '-t', SESSION, '-F', '#{pane_pid}']).trim());
    expect(Number.isInteger(panePid)).toBe(true);

    // 等「serve」启动并落盘 pid
    let servePid = 0;
    for (let i = 0; i < 50 && !servePid; i++) {
      try { servePid = Number(readFileSync(join(workDir, 'serve.pid'), 'utf8').trim()); } catch { /* not yet */ }
      if (!servePid) await new Promise((r) => setTimeout(r, 100));
    }
    expect(servePid).toBeGreaterThan(0);

    // worker 侧只持有 pane pid（与 tmux backend getChildPid 一致）
    const probe = () => cliProcessAliveFromBackend({
      getChildPid: () => Number(tmux(['list-panes', '-t', SESSION, '-F', '#{pane_pid}']).trim()),
    });
    expect(probe()).toBe(true);

    // —— 复核边界：「执行服务退出、客户端仍活着」必须仍判存活 ——
    process.kill(servePid, 'SIGKILL');
    // client.sh 检测到 serve 死亡后进入长睡眠（不退出），所以这是稳定窗口：
    // 等待 pane 内容确认 serve 已死，期间探针必须持续为 true。
    let sawServeDied = false;
    for (let i = 0; i < 50; i++) {
      const cap = tmux(['capture-pane', '-t', SESSION, '-p']);
      if (cap.includes('SERVE_DIED')) { sawServeDied = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(sawServeDied).toBe(true);
    expect(probe()).toBe(true);

    // —— 客户端（pane）本身退出：必须 fail-open ——
    tmux(['kill-pane', '-t', SESSION]);
    for (let i = 0; i < 50; i++) {
      if (spawnSync('kill', ['-0', String(panePid)], { stdio: 'ignore' }).status !== 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // pane_pid 已死：直接对旧 pid 探测必为 false；session 也随之销毁
    expect(cliProcessAliveFromBackend({ cliPid: panePid })).toBe(false);
    let sessionGone = false;
    try { tmux(['list-panes', '-t', SESSION, '-F', '#{pane_pid}']); } catch { sessionGone = true; }
    expect(sessionGone).toBe(true);
  });
});
