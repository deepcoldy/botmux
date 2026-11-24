/**
 * Real-worker regression for a transcript-delivery turn that has a native
 * input but no terminal assistant record. Uses only a private tmux server and
 * the existing Doubao TUI double; no Doubao installation/account is required.
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { killWorkerTmuxSession } from './helpers/worker-tmux-session.js';
import { writeFakeDoubaoTui } from './helpers/fake-doubao-tui.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

let child: ChildProcess | undefined;
let root: string | undefined;
let sessionName: string | undefined;
let tmuxEnv: NodeJS.ProcessEnv | undefined;
let tmuxRoot: string | undefined;
const tmuxAvailable = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(done => child!.once('exit', () => done()));
    child.kill('SIGKILL');
    await Promise.race([exited, new Promise<void>(done => setTimeout(done, 2_000))]);
  }
  child = undefined;
  if (sessionName) killWorkerTmuxSession(sessionName, tmuxEnv);
  if (tmuxEnv) {
    try { execFileSync('tmux', ['-L', 'botmux', 'kill-server'], { env: tmuxEnv, timeout: 3_000, stdio: 'ignore' }); }
    catch { /* This test may not have started its private server. */ }
  }
  sessionName = undefined;
  tmuxEnv = undefined;
  if (tmuxRoot) rmSync(tmuxRoot, { recursive: true, force: true });
  tmuxRoot = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const pause = (ms: number) => new Promise(done => setTimeout(done, ms));

function startScenario() {
  root = mkdtempSync(join(tmpdir(), 'structured-missing-final-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const sessionId = randomUUID();
  const nativeId = '38452222222222222';
  const systemDir = join(root, '.local', 'share', 'doubao_cli', 'agent_mode', '100', 'workspace',
    '.sessions', nativeId, 'agents', 'main', 'system');
  mkdirSync(systemDir, { recursive: true });
  const assignment = join(systemDir, 'assignment.md');
  const trajectory = join(systemDir, 'trajectory.jsonl');
  writeFileSync(assignment, '## [2026-01-01T00:00:00Z] 需求\nOld prompt\n\n');
  writeFileSync(trajectory, '');
  const ctlDir = join(root, 'ctl');
  mkdirSync(ctlDir);
  writeFileSync(join(ctlDir, 'no-trajectory'), '');
  const fakeCli = writeFakeDoubaoTui(root, { systemDir, ctlDir, inputLog: join(root, 'input.jsonl') });

  tmuxRoot = mkdtempSync('/tmp/bmx-mf-');
  tmuxEnv = privateTmuxEnv(tmuxRoot);
  delete tmuxEnv.BOTMUX_TMUX_SOCKET;
  execFileSync('tmux', ['-L', 'botmux', 'new-session', '-d', '-s', 'anchor', 'sleep', '300'],
    { env: tmuxEnv, timeout: 5_000 });
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  child = spawnTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...tmuxEnv, HOME: root, USERPROFILE: root, XDG_DATA_HOME: join(root, '.local', 'share'),
      SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, BOTMUX_NO_CLAIM: '1',
      LARK_APP_ID: 'app_doubao', LARK_APP_SECRET: 'test-only',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.stdout?.on('data', data => logs.push(data.toString()));
  child.stderr?.on('data', data => logs.push(data.toString()));
  sessionName = TmuxBackend.sessionName(sessionId);
  child.send({
    type: 'init', sessionId, daemonBootId: 'structured-missing-final-boot', chatId: 'oc_test', chatType: 'group',
    rootMessageId: 'om_root', workingDir: dataDir, cliId: 'doubao', cliPathOverride: fakeCli,
    cliSessionId: nativeId, resume: true, backendType: 'tmux', launchShell: '/bin/bash',
    prompt: 'first pure-text question', turnId: 'om_turn_1', replyDelivery: 'transcript',
    larkAppId: 'app_doubao', larkAppSecret: 'test-only', apiOnly: true,
  } satisfies DaemonToWorker);

  const waitUntil = async (check: () => boolean, what: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() >= deadline || child?.exitCode != null || child?.signalCode != null) {
        throw new Error(`timed out: ${what}\n${logs.join('').slice(-10_000)}`);
      }
      await pause(50);
    }
  };
  const control = (name: string, content = '') => writeFileSync(join(ctlDir, name), content);
  const clear = (name: string) => { try { unlinkSync(join(ctlDir, name)); } catch { /* absent */ } };
  const finals = (turnId: string) => messages.filter(msg => msg.type === 'final_output' && msg.turnId === turnId);
  const notices = (turnId: string) => messages.filter(msg => msg.type === 'user_notify'
    && msg.turnId === turnId && (msg as { kind?: string }).kind === 'structured_turn_not_collected');
  const sendMessage = (turnId: string, content: string) => child!.send({
    type: 'message', turnId, content,
  } satisfies DaemonToWorker);
  return { messages, logs, assignment, trajectory, waitUntil, control, clear, finals, notices, sendMessage };
}

async function startFirstTurn(s: ReturnType<typeof startScenario>) {
  await s.waitUntil(() => s.messages.some(msg => msg.type === 'ready'), 'worker ready');
  await s.waitUntil(() => readFileSync(s.assignment, 'utf8').includes('first pure-text question'), 'first native input');
  s.control('finish-1', 'VISIBLE_IN_THE_TERMINAL');
}

describe.skipIf(process.platform === 'win32' || !tmuxAvailable)('structured transcript missing final', () => {
  it('ends an empty-trajectory wait with a Web-terminal notice, then delivers the next turn', async () => {
    const s = startScenario();
    await startFirstTurn(s);
    await s.waitUntil(() => s.notices('om_turn_1').length === 1, 'bounded missing-final notice', 45_000);
    expect(s.notices('om_turn_1')[0]?.message).toContain('没拿到最终回答');
    expect(s.notices('om_turn_1')[0]?.message).toContain('Web 终端');
    expect(s.finals('om_turn_1')).toEqual([]);

    s.clear('no-trajectory');
    s.sendMessage('om_turn_2', 'second question after the timeout');
    await s.waitUntil(() => readFileSync(s.assignment, 'utf8').includes('second question after the timeout'), 'successor native input');
    s.control('finish-2', 'SECOND_ANSWER');
    await s.waitUntil(() => s.finals('om_turn_2').length === 1, 'successor final');
    expect(s.finals('om_turn_2')[0]).toMatchObject({ content: 'SECOND_ANSWER' });
    expect(s.notices('om_turn_2')).toEqual([]);
  }, 70_000);

  it('lets a late trajectory final win before the deadline without a warning or duplicate', async () => {
    const s = startScenario();
    await startFirstTurn(s);
    await pause(3_000);
    s.clear('no-trajectory');
    appendFileSync(s.trajectory, JSON.stringify({ role: 'assistant', content: 'LATE_NATIVE_FINAL' }) + '\n');
    await s.waitUntil(() => s.finals('om_turn_1').length === 1, 'late native final');
    await pause(22_000);
    expect(s.finals('om_turn_1').map(msg => msg.type === 'final_output' && msg.content)).toEqual(['LATE_NATIVE_FINAL']);
    expect(s.notices('om_turn_1')).toEqual([]);
  }, 50_000);

  it('does not warn for a stopped turn, and the following turn still delivers', async () => {
    const s = startScenario();
    await startFirstTurn(s);
    await pause(3_000);
    child!.send({ type: 'interrupt_turn', requestId: 'stop-missing-final', turnId: 'om_turn_1' } satisfies DaemonToWorker);
    await s.waitUntil(() => s.messages.some(msg => msg.type === 'turn_interrupt_result'
      && msg.requestId === 'stop-missing-final' && msg.delivered), 'exact stop acknowledged');

    s.clear('no-trajectory');
    s.sendMessage('om_turn_2', 'after the stop');
    await s.waitUntil(() => readFileSync(s.assignment, 'utf8').includes('after the stop'), 'post-stop native input');
    s.control('finish-2', 'POST_STOP_ANSWER');
    await s.waitUntil(() => s.finals('om_turn_2').length === 1, 'post-stop final');
    expect(s.finals('om_turn_1')).toEqual([]);
    expect(s.notices('om_turn_1')).toEqual([]);
    expect(s.notices('om_turn_2')).toEqual([]);
  }, 50_000);
});
