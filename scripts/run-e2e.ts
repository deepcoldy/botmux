#!/usr/bin/env tsx
/**
 * 包装 vitest e2e 运行：为每一次 run 生成独立 run-id，设置 MIDSCENE_RUN_DIR
 * 让 midscene 把 report/log/cache/screenshots 全部写进
 * midscene_run/runs/<run-id>/，方便 dashboard 按批次聚合。
 */
import { spawn } from 'node:child_process';

const ts = new Date()
  .toISOString()
  .replace('T', '_')
  .replace(/\..+$/, '')
  .replace(/:/g, '-');

const runDir = `midscene_run/runs/${ts}`;
process.env.MIDSCENE_RUN_DIR = runDir;

console.log(`[run-e2e] MIDSCENE_RUN_DIR=${runDir}`);

const child = spawn(
  'vitest',
  ['run', 'test/e2e-browser/', ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env, shell: false }
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
