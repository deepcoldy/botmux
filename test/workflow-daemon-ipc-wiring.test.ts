import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');

function sourceBetween(source: string, begin: string, end: string): string {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) {
    throw new Error(`source boundary not found: ${begin} .. ${end}`);
  }
  return source.slice(start, finish);
}

describe('Workflow v3 daemon IPC wiring', () => {
  // 源码结构护栏(K2)：v3 run 的 start/cancel/retry/grant 写操作只能经 workflowDaemonMutationRoute 注册，
  // 它先 verifyWorkflowDaemonIpcRequest 鉴权、再把 runId 交给 handler。路由注册在 daemon.ts 顶层闭包里，
  // 没有可 import 的 seam；有人另写一条字面量 ipcRoute 就会静默绕过鉴权（e88647ace8 统一 v3 IPC 写鉴权）。
  it('registers all four mutations only through the authenticated route seam', () => {
    const seam = sourceBetween(
      daemonSource,
      'function workflowDaemonMutationRoute<',
      '\nfunction ',
    );
    const verify = seam.indexOf('verifyWorkflowDaemonIpcRequest(');
    const handlerCall = seam.indexOf('handler(', verify);
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(handlerCall).toBeGreaterThan(verify);

    for (const mutation of ['start', 'cancel', 'retry', 'grant'] as const) {
      expect(daemonSource.match(new RegExp(`workflowDaemonMutationRoute\\(\\s*'${mutation}'`, 'g')))
        .toHaveLength(1);
      // Any literal route ending in /:runId/<mutation> would bypass the seam.
      // The seam itself registers a template path and is therefore not matched.
      expect(daemonSource).not.toMatch(new RegExp(
        `ipcRoute\\(\\s*['"]POST['"]\\s*,\\s*['"\`][^'"\`]*\\/:runId\\/${mutation}['"\`]`,
      ));
    }
  });

  // 源码结构护栏(K4)：daemon 写 dashboard-daemons 描述符、dashboard 读它，两边必须落在同一个数据目录。
  // 两个都是有副作用的进程入口，无法 import 后直接比较；daemon 曾写死 ~/.botmux/data，
  // 设了自定义数据目录时 dashboard 就发现不了 daemon（e88647ace8）。
  it('resolves the daemon descriptor directory from the shared data-dir seam', () => {
    const sharedDir = /join\(\s*resolveBotmuxDataDir\(\)\s*,\s*'dashboard-daemons'\s*\)/;
    expect(daemonSource).toMatch(sharedDir);
    expect(dashboardSource).toMatch(sharedDir);
  });
});
