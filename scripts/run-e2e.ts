#!/usr/bin/env tsx
/**
 * Run the migrated Feishu scenarios with Midscene Test. Each invocation gets
 * an isolated result directory so the report dashboard can group historical
 * runs without mixing logs, screenshots, or HTML reports.
 */
import { spawn } from 'node:child_process';
import { sweepOrphanSchedTasks } from '../test/e2e-browser/schedule-cleanup.js';

const groupUrl = process.env.FEISHU_TEST_GROUP_URL;
if (groupUrl) {
  const url = new URL(groupUrl);
  if (/^\/next\/messenger\/?$/.test(url.pathname)) {
    throw new Error(
      'FEISHU_TEST_GROUP_URL points to Messenger home. Configure a direct link to the real Botmux test group containing the Feishu bots.',
    );
  }
}

const ts = new Date()
  .toISOString()
  .replace('T', '_')
  .replace(/\..+$/, '')
  .replace(/:/g, '-');

const runDir = `midscene_run/runs/${ts}`;
process.env.MIDSCENE_RUN_DIR = runDir;

console.log(`[run-e2e] MIDSCENE_RUN_DIR=${runDir}`);

try {
  const removed = await sweepOrphanSchedTasks(1);
  if (removed.length > 0) {
    console.warn(
      `[run-e2e] swept ${removed.length} orphan schedule task(s): ${removed.join(', ')}`,
    );
  }
} catch (error) {
  console.warn(`[run-e2e] schedule sweep skipped: ${(error as Error).message}`);
}

const child = spawn(
  'midscene-test',
  ['test/e2e-browser', '--result-dir', runDir, ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env, shell: false }
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
