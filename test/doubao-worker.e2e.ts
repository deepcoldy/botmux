/**
 * Opt-in real-worker smoke for the Doubao adapter: the real botmux worker
 * process (src/worker.ts) over its daemon IPC, a real logged-in `doubao`, and
 * the real tmux backend. No Feishu traffic (apiOnly HTTP-style chat).
 *
 * Verifies the production path end to end:
 *   - first message reaches the TUI once the composer is ready,
 *   - the worker reports the native session id (`cli_session_id`),
 *   - turn completion is detected (prompt_ready / screen idle),
 *   - a second message submitted after the first turn is executed,
 *   - a respawn with resume + cliSessionId restores the conversation.
 *
 * Run: BOTMUX_DOUBAO_E2E=1 vitest run --project e2e test/doubao-worker.e2e.ts
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { killWorkerTmuxSession, workerTmuxArgs } from './helpers/worker-tmux-session.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const roots: string[] = [];
const children: ChildProcess[] = [];
const tmuxSessions: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
      await pause(1500);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  for (const name of tmuxSessions.splice(0)) killWorkerTmuxSession(name);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmuxCapture(sessionName: string): string {
  try {
    return execFileSync('tmux', [...workerTmuxArgs(), 'capture-pane', '-p', '-t', sessionName], { encoding: 'utf8', timeout: 3000 });
  } catch { return ''; }
}

function startWorker(opts: { root: string; sessionId: string; resume?: boolean; cliSessionId?: string }) {
  const dataDir = join(opts.root, 'data');
  const cwd = join(opts.root, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  // Inherit the whole test environment (tmux fence shim + private TMUX_TMPDIR)
  // and keep the real HOME so the logged-in doubao account is visible.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: opts.sessionId, BOTMUX_NO_CLAIM: '1',
    LARK_APP_ID: 'app_doubao_e2e', LARK_APP_SECRET: 'test-secret',
  };
  const child = spawnTsScript(resolve('src/worker.ts'), [], { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  child.on('message', m => messages.push(m as WorkerToDaemon));
  child.stdout?.on('data', b => logs.push(b.toString()));
  child.stderr?.on('data', b => logs.push(b.toString()));
  child.send({
    type: 'init', sessionId: opts.sessionId, chatId: 'oc_doubao_e2e', chatType: 'group', rootMessageId: 'om_root',
    workingDir: cwd, cliId: 'doubao', backendType: 'tmux', prompt: '', apiOnly: true,
    resume: opts.resume, cliSessionId: opts.cliSessionId,
    larkAppId: 'app_doubao_e2e', larkAppSecret: 'test-secret',
  } satisfies DaemonToWorker);
  const waitFor = async (cond: () => boolean, what: string, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() >= deadline || child.exitCode != null) {
        throw new Error(`worker timed out: ${what}\n--- logs ---\n${logs.join('').slice(-6000)}`);
      }
      await pause(250);
    }
  };
  const send = (content: string, turnId: string) =>
    child.send({ type: 'message', content, turnId } satisfies DaemonToWorker);
  const count = (type: string) => messages.filter(m => m.type === type).length;
  const log = () => logs.join('');
  return { child, messages, logs, log, waitFor, send, count };
}

describe.runIf(process.env.BOTMUX_DOUBAO_E2E === '1')('Doubao through the real worker', () => {
  it('delivers turns, reports the native id, detects completion and resumes', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-doubao-')));
    roots.push(root);
    const sessionId = randomUUID();
    tmuxSessions.push(TmuxBackend.sessionName(sessionId));
    // A live private server makes a missing pane a definite `missing`, rather
    // than an absent-socket `unknown` on a developer host with other tmux servers.
    const anchor = `doubao-anchor-${randomUUID()}`;
    execFileSync('tmux', [...workerTmuxArgs(), 'new-session', '-d', '-s', anchor, 'sleep', '480'], { timeout: 5000 });
    tmuxSessions.push(anchor);
    const marker = `DBW_${randomUUID().replaceAll('-', '').slice(0, 10)}`;

    const w = startWorker({ root, sessionId });
    await w.waitFor(() => w.messages.some(m => m.type === 'ready'), 'worker ready', 30_000);

    w.send(`当前测试对话的临时字符串是 ${marker}，仅用于本会话，不要保存为长期记忆或用户偏好。只回复 FIRST_OK`, 'om_turn_1');
    await w.waitFor(() => w.messages.some(m => m.type === 'cli_session_id'), 'cli_session_id reported');
    const sidMsg = w.messages.find(m => m.type === 'cli_session_id') as Extract<WorkerToDaemon, { type: 'cli_session_id' }>;
    expect(sidMsg.cliSessionId).toMatch(/^\d{10,24}$/);

    // Turn 1 completes: worker publishes prompt_ready once the composer is idle again.
    await w.waitFor(() => w.count('prompt_ready') >= 1, 'turn 1 prompt_ready');
    await w.waitFor(() => w.messages.some(m => m.type === 'final_output' && m.turnId === 'om_turn_1' && m.content.trim() === 'FIRST_OK'), 'turn 1 final output IPC');
    const turn1ReadyAt = Date.now();

    w.send('第二轮：只回复 SECOND_OK', 'om_turn_2');
    await w.waitFor(() => w.count('prompt_ready') >= 2, 'turn 2 prompt_ready');
    await w.waitFor(() => w.messages.some(m => m.type === 'final_output' && m.turnId === 'om_turn_2' && m.content.trim() === 'SECOND_OK'), 'turn 2 final output IPC');
    expect(Date.now() - turn1ReadyAt).toBeGreaterThan(1000);
    expect(w.log()).not.toContain('First prompt timeout');
    expect(w.log()).not.toMatch(/submit_unconfirmed|did not submit/i);

    // Restart: a fresh worker with resume + the reported native id.
    w.child.send({ type: 'close' } satisfies DaemonToWorker);
    await pause(3000);
    const r = startWorker({ root, sessionId, resume: true, cliSessionId: sidMsg.cliSessionId });
    await r.waitFor(() => r.messages.some(m => m.type === 'ready'), 'resumed worker ready', 30_000);
    expect(r.log()).not.toContain('历史会话无法恢复');
    r.send('本测试对话第一轮提到的临时字符串是什么？只回复字符串本身，不读取长期记忆', 'om_turn_3');
    await r.waitFor(() => r.count('prompt_ready') >= 1, 'resumed turn prompt_ready');
    await r.waitFor(() => r.messages.some(m => m.type === 'final_output' && m.turnId === 'om_turn_3' && m.content.trim() === marker), 'resumed final output IPC');
    // The resumed session id is already known, so no new id is reported.
    expect(r.messages.some(m => m.type === 'cli_session_id' && m.cliSessionId !== sidMsg.cliSessionId)).toBe(false);
    const screens = r.messages
      .filter((m): m is Extract<WorkerToDaemon, { type: 'screen_update' }> => m.type === 'screen_update')
      .map(m => m.content).join('\n');
    expect(screens + tmuxCapture(TmuxBackend.sessionName(sessionId))).toContain(marker);
  }, 420_000);
});
