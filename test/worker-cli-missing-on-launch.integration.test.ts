/**
 * A CLI that is briefly missing from PATH when a session launches it.
 *
 * Claude Code's auto-update reinstalls it globally, and for about 2.5 s the
 * `claude` command does not exist. A session started inside that window used
 * to fail at once with 「找不到可执行文件」, although the command was back a
 * moment later. The launch now looks again once, a few seconds later.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerToDaemon } from '../src/types.js';
import {
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  promptReadyCount,
  setupFakeClaude as setup,
  type Generation,
} from './helpers/claude-worker-harness.js';

afterEach(cleanUpClaudeHarnesses);

const errorsOf = (g: Generation) =>
  g.messages.filter((m): m is Extract<WorkerToDaemon, { type: 'error' }> => m.type === 'error');
const retryLogs = (g: Generation) => g.logs.join('').split('\n').filter(line => line.includes('[cli-launch]'));

describe.skipIf(!runnable)('A CLI missing from PATH while a session launches it', () => {
  it.each(['tmux', 'pty'] as const)('%s: the command is back 2 s later, and the session starts with its first message', async backend => {
    const h = setup({ turnMs: 500, onPath: true });
    h.hideCli();
    const g = h.startWorker({ backendType: backend, prompt: 'P1 first message' });
    // The reinstall finishes 2 s after the launch first found the command gone.
    await g.waitFor(() => retryLogs(g).length > 0, 'the launch to find the command missing', 30_000);
    await new Promise(done => setTimeout(done, 2_000));
    h.restoreCli();
    await g.waitFor(() => h.doneAt('turn', 'reply: P1 first message') !== undefined, 'the first message to be answered', 30_000);
    expect(h.launches()).toHaveLength(1);
    expect(errorsOf(g)).toEqual([]);
  }, 60_000);

  it('the command is still missing after the retry: the session fails as it did before', async () => {
    const h = setup({ turnMs: 500, onPath: true });
    h.hideCli();
    const startedAt = Date.now();
    const g = h.startWorker({ backendType: 'pty' });
    await g.waitFor(() => errorsOf(g).length > 0, 'the startup error', 30_000);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3_000);
    expect(errorsOf(g).map(m => m.message)).toEqual([
      '无法启动 Claude：找不到可执行文件「claude」（自查：command -v claude）。请先在运行 botmux daemon 的这台机器上安装或修正 PATH / CLI 路径。',
    ]);
    expect(h.launches()).toEqual([]);
    // It waited once, and said so.
    expect(retryLogs(g).filter(line => line.includes('再试一次'))).toHaveLength(1);
  }, 60_000);

  it('the command is there: the session starts without waiting', async () => {
    const h = setup({ turnMs: 500, onPath: true });
    const g = h.startWorker({ backendType: 'pty' });
    await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready', 30_000);
    expect(retryLogs(g)).toEqual([]);
    expect(h.launches()).toHaveLength(1);
  }, 60_000);
});
