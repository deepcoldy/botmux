#!/usr/bin/env node
/**
 * flow runner 进程入口（BotmuxEntry `flow-runner`，设计文档 §6.1）。
 *
 * 参数：单个 JSON（`RunnerOptions` 的可序列化子集），由 `botmux flow run/resume` 写好后传入。
 * 进程独立于终端（CLI 用 detached 起它），SIGTERM/SIGINT 走 `interrupt`；退出码见 RunSummary。
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlowRunner, type RunnerOptions } from './flow/runner.js';

const argJson = process.argv[process.argv.length - 1];
if (!argJson || !argJson.startsWith('{')) {
  process.stderr.write('flow-runner expects a JSON options argument\n');
  process.exit(2);
}

type SerializedOptions = Omit<RunnerOptions, 'spawnScriptHost' | 'spawnAgentWorker' | 'hooks' | 'distDir' | 'botExecutor'> & { distDir?: string };
const parsed = JSON.parse(argJson) as SerializedOptions;
const __dirname = dirname(fileURLToPath(import.meta.url));

// 测试专用故障注入：`BOTMUX_FLOW_CRASH_AT=<hook point>[:<n>]` 在第 n 次到达该点时 SIGKILL 自己
// （默认第 1 次）。生产环境永远不设。
const crashAt = process.env.BOTMUX_FLOW_CRASH_AT;
let crashPoint: string | null = null;
let crashNth = 1;
if (crashAt) {
  const [point, nth] = crashAt.split(':');
  crashPoint = point ?? null;
  crashNth = Number(nth ?? '1') || 1;
}
let crashSeen = 0;

const runner = new FlowRunner({
  ...parsed,
  // 编译态下 __dirname 是 /$bunfs/root，但 resolveEntrySpawn 在编译态不用它
  distDir: parsed.distDir ?? __dirname,
  hooks: {
    log: (line) => process.stderr.write(`${line}\n`),
    at: (point, detail) => {
      if (crashPoint && point === crashPoint && ++crashSeen === crashNth) {
        process.stderr.write(`[flow-runner] crash injection at ${point} ${JSON.stringify(detail)}\n`);
        process.kill(process.pid, 'SIGKILL');
      }
      // `BOTMUX_FLOW_PAUSE_AT=<point>`：在该点 SIGSTOP 自己（测试从外面 SIGCONT），模拟假死/暂停的旧写者
      if (process.env.BOTMUX_FLOW_PAUSE_AT === point) {
        process.stderr.write(`[flow-runner] pause injection at ${point} ${JSON.stringify(detail)}\n`);
        process.kill(process.pid, 'SIGSTOP');
      }
    },
  },
});

let interrupting = false;
const onSignal = (signal: NodeJS.Signals) => {
  if (interrupting) return;
  interrupting = true;
  void runner.interrupt(signal).then(() => process.exit(130));
};
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));

runner
  .run()
  .then((summary) => {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    // daemon 以 IPC 起我时，最后一条快照可能还在通道里：给它一点时间再退出
    if (process.connected) setTimeout(() => process.exit(summary.exitCode), 150);
    else process.exit(summary.exitCode);
  })
  .catch((err: unknown) => {
    process.stderr.write(`flow-runner: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
