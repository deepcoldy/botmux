import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
const commandHandlerSource = readFileSync(new URL('../src/core/command-handler.ts', import.meta.url), 'utf8');
const dashboardIpcSource = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');
const cardHandlerSource = readFileSync(new URL('../src/im/lark/card-handler.ts', import.meta.url), 'utf8');
const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const webSessionsSource = readFileSync(new URL('../src/dashboard/web/sessions.ts', import.meta.url), 'utf8');

function ipcCase(name: string, next: string): string {
  const start = workerSource.indexOf(`case '${name}':`);
  const end = workerSource.indexOf(`case '${next}':`, start + 1);
  expect(start, name).toBeGreaterThanOrEqual(0);
  expect(end, name).toBeGreaterThan(start);
  return workerSource.slice(start, end);
}

/** The guard's own `break;` must come before the first destructive call. */
function expectRefusalBefore(region: string, guard: string, destructive: string): void {
  const guardAt = region.indexOf(guard);
  expect(guardAt, guard).toBeGreaterThanOrEqual(0);
  const refusalBreak = region.indexOf('break;', guardAt);
  expect(refusalBreak, `${guard} has no refusal break`).toBeGreaterThan(guardAt);
  expect(region.indexOf(destructive, refusalBreak), `${destructive} after ${guard}`).toBeGreaterThan(refusalBreak);
  expect(region.slice(0, refusalBreak)).not.toContain(destructive);
}

describe('worker remote retirement protocol', () => {
  // 源码结构护栏(K3)：close / suspend / restart 三个 IPC 分支都在 worker.ts 的消息
  // switch 里，没有可执行 seam。P0-2：request-less close 曾落到本地 destroySession()
  // ——对 Mojo 就是 `mojo session cancel`——每次通用回收都静默且不可逆地取消远端会话；
  // Riff 的 suspend / generation restart 走本地 teardown 同样会丢掉已接受的远端工作
  // （dc2de1d8b4「为关闭与守护进程退出增加两阶段关停围栏」）。只钉「拒绝分支先于
  // 本地破坏性调用」，不钉日志措辞与具体错误码。
  it('refuses request-less remote close, Riff suspend and Riff restart before any local teardown', () => {
    const close = ipcCase('close', 'close_commit');
    const remoteBranch = close.indexOf('if (isRemoteBackendType(effectiveBackendType))');
    expect(remoteBranch).toBeGreaterThanOrEqual(0);
    expectRefusalBefore(close.slice(remoteBranch), 'if (!msg.requestId)', 'backend?.destroySession?.()');

    const suspendStart = workerSource.indexOf("case 'suspend':");
    expect(suspendStart).toBeGreaterThanOrEqual(0);
    // `suspend` is the last case of the IPC switch.
    const suspend = workerSource.slice(suspendStart, workerSource.indexOf('\n  }\n});', suspendStart));
    expectRefusalBefore(suspend, "if (effectiveBackendType === 'riff')", 'destroySession');
    expectRefusalBefore(ipcCase('restart', 'expire_durable_turn'), "if (effectiveBackendType === 'riff')", 'restartCliProcess(');
  });

  // 源码结构护栏(K3)：按文件计数的 lint 式绊线，不解析 AST，也只覆盖下列入口文件。
  // 四轮复审在这些入口里逐个找到 riff-only 的回收护栏（/cd → /restart+/repo → 卡片 →
  // crash loop → web dashboard），每一处都会放 Mojo 穿过并执行会取消远端会话的本地
  // 回收。入口必须统一用覆盖所有远端后端的 isRemoteBackendSession / isRemoteCliId。
  it('keeps riff-only retirement guards out of the scanned entry-point files', () => {
    for (const [name, source] of [
      ['worker-pool', workerPoolSource],
      ['command-handler', commandHandlerSource],
      ['dashboard-ipc-server', dashboardIpcSource],
      ['card-handler', cardHandlerSource],
      ['daemon', daemonSource],
      ['worker', workerSource],
      ['dashboard-web-sessions', webSessionsSource],
    ] as const) {
      expect(source.split('isRiffBackendSession(').length - 1, `${name} still calls isRiffBackendSession`).toBe(0);
    }
  });
});
