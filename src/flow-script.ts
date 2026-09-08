#!/usr/bin/env node
/**
 * flow script host 进程入口（BotmuxEntry `flow-script`，设计文档 §6.1）。
 *
 * runner 用 `resolveEntrySpawn('flow-script')` 带 IPC 通道启动；本进程只等 `start`，
 * 在受限 vm 里跑脚本，把 ctx 调用当 RPC 发回去；runner 断开即退出。不读 argv、不碰磁盘。
 */
import { serveScriptHost } from './flow/script-ipc.js';
import type { RunnerToScriptMessage, ScriptToRunnerMessage } from './flow/types.js';

if (typeof process.send !== 'function') {
  process.stderr.write('flow-script must be spawned with an IPC channel\n');
  process.exit(2);
}

const session = serveScriptHost({
  send: (message: ScriptToRunnerMessage) => {
    if (!process.connected) return;
    try {
      // 带回调：通道已关时错误走回调（父进程死了另有 disconnect 事件收尾），不触发未处理的 'error' 事件
      process.send!(message, undefined, undefined, () => undefined);
    } catch {
      // 通道已关
    }
  },
  onMessage: (handler) => {
    process.on('message', (raw) => handler(raw as RunnerToScriptMessage));
  },
  onDisconnect: (handler) => {
    process.on('disconnect', handler);
  },
});

void session.finished.then((how) => {
  // done/error 已经发出；给 IPC 一点时间冲刷再退出
  setTimeout(() => process.exit(how === 'done' ? 0 : 1), 50).unref();
});
