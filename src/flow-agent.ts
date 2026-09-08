#!/usr/bin/env node
/**
 * flow agent worker 进程入口（BotmuxEntry `flow-agent`，设计文档 §6.3）。
 *
 * runner 带 IPC 通道启动本进程，把它放进容器后发 `contained`，之后才 `open` 起 CLI。
 * 10 秒等不到 `contained` 自行退出；IPC 断开即退出（父死子亡的快速路径）。
 */
import { serveAgentWorker, type AgentWorkerDeps } from './flow/agent-worker.js';
import { fakeAgentDeps } from './flow/fake-agent.js';
import type { AgentToRunnerMessage, RunnerToAgentMessage } from './flow/types.js';

if (typeof process.send !== 'function') {
  process.stderr.write('flow-agent must be spawned with an IPC channel\n');
  process.exit(2);
}

void serveAgentWorker(
  {
    send: (message: AgentToRunnerMessage) => {
      if (!process.connected) return;
      try {
        // 带回调：通道已关时错误走回调（父进程死了另有 disconnect 事件收尾），不触发未处理的 'error' 事件
        process.send!(message, undefined, undefined, () => undefined);
      } catch {
        // 通道已关
      }
    },
    onMessage: (handler) => {
      process.on('message', (raw) => handler(raw as RunnerToAgentMessage));
    },
    onDisconnect: (handler) => {
      process.on('disconnect', handler);
    },
  },
  {
    // 测试专用：假 agent 不起真实 CLI（见 src/flow/fake-agent.ts）
    ...(process.env.BOTMUX_FLOW_FAKE_AGENT ? fakeAgentDeps(process.env.BOTMUX_FLOW_FAKE_AGENT) : ({} as AgentWorkerDeps)),
    exit: (code) => {
      setTimeout(() => process.exit(code), 50).unref();
    },
  },
);
