import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { killWorkerTmuxSession } from './helpers/worker-tmux-session.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import type { DaemonSession } from '../src/core/types.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

interface CotRequest {
  method: string;
  data?: { events?: Array<{ event_type: string; content: string }> };
}
const request = vi.fn(async (req: CotRequest) => req.method === 'POST'
  ? { code: 0, data: { cot_id: 'cot_doubao', message_id: 'om_doubao_progress' } }
  : { code: 0, data: {} });
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { cotEnabled: true } }),
  getBotClient: () => ({ request }),
}));
import { finalizeCotMessage, handleCotThinkingUpdate } from '../src/im/lark/cot-message.js';

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
  request.mockClear();
});

async function waitUntil(check: () => boolean, logs: string[]): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() >= deadline || child?.exitCode != null || child?.signalCode != null) {
      throw new Error(`Worker did not reach the expected progress state\n${logs.join('').slice(-6000)}`);
    }
    await new Promise(done => setTimeout(done, 20));
  }
}

describe.skipIf(process.platform === 'win32')('Doubao worker execution progress', () => {
  for (const { backendType, resumed } of [
    { backendType: 'pty', resumed: false }, { backendType: 'tmux', resumed: false },
    { backendType: 'pty', resumed: true },
  ] as const) {
    it.skipIf(backendType === 'tmux' && !tmuxAvailable)(`shows tool activity in the native bubble before the final (${backendType}, resumed=${resumed})`, async () => {
      root = mkdtempSync(join(tmpdir(), 'doubao-worker-progress-'));
      const dataDir = join(root, 'data');
      mkdirSync(dataDir);
      const sessionId = randomUUID();
      const nativeId = '38459999999999999';
      const systemDir = join(root, ...(process.platform === 'darwin'
        ? ['Library', 'Application Support'] : ['.local', 'share']),
      'doubao_cli', 'agent_mode', '100', 'workspace', '.sessions', nativeId, 'agents', 'main', 'system');
      mkdirSync(systemDir, { recursive: true });
      const trajectory = join(systemDir, 'trajectory.jsonl');
      const oldTool = JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'pre-restart',
        function: { name: 'Read', arguments: '{}' } }] });
      const split = Math.floor(oldTool.length / 2);
      writeFileSync(trajectory, resumed
        ? JSON.stringify({ role: 'assistant', content: 'Old answer' }) + '\n' + oldTool.slice(0, split) : '');
      if (resumed) writeFileSync(join(systemDir, 'assignment.md'), '## [2026-01-01T00:00:00Z] 需求\nOld prompt\n');
      const completeFlag = join(root, 'complete');
      const fakeCli = join(root, 'fake-doubao');
      writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
let busy = false;
const ready = () => process.stdout.write('\\x1b[2J\\x1b[HAsk Doubao to do anything\\nEnter send · Ctrl+J newline\\n');
ready();
process.stdin.on('data', () => { busy = true; });
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(completeFlag)})) { busy = false; ready(); }
  else if (busy) process.stdout.write('Responding… (1s • esc to interrupt)\\n');
}, 100);
`, { mode: 0o755 });
      const messages: WorkerToDaemon[] = [];
      const logs: string[] = [];
      const ds = { larkAppId: 'app_doubao', chatId: 'oc_test',
        session: { sessionId, rootMessageId: 'om_root' } } as DaemonSession;
      // Unix socket paths are bounded; the nested test HOME can be too long.
      if (backendType === 'tmux') {
        tmuxRoot = mkdtempSync('/tmp/bmx-dp-');
        tmuxEnv = privateTmuxEnv(tmuxRoot);
        delete tmuxEnv.BOTMUX_TMUX_SOCKET;
        execFileSync('tmux', ['-L', 'botmux', 'new-session', '-d', '-s', 'anchor', 'sleep', '120'],
          { env: tmuxEnv, timeout: 5_000 });
      }
      const env = tmuxEnv ?? process.env;
      child = spawnTsScript(resolve('src/worker.ts'), [], {
        cwd: resolve('.'), env: { ...env, HOME: root, USERPROFILE: root,
          XDG_DATA_HOME: join(root, '.local', 'share'), SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: sessionId, BOTMUX_NO_CLAIM: '1',
          LARK_APP_ID: 'app_doubao', LARK_APP_SECRET: 'test-only' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child.on('message', raw => {
        const msg = raw as WorkerToDaemon;
        messages.push(msg);
        if (msg.type === 'thinking_update') handleCotThinkingUpdate(ds, msg);
        if (msg.type === 'turn_terminal') finalizeCotMessage(ds, msg.turnId, msg.status);
      });
      child.stdout?.on('data', data => logs.push(data.toString()));
      child.stderr?.on('data', data => logs.push(data.toString()));
      if (backendType === 'tmux') sessionName = TmuxBackend.sessionName(sessionId);
      child.send({ type: 'init', sessionId, chatId: 'oc_test', chatType: 'group', rootMessageId: 'om_root',
        workingDir: dataDir, cliId: 'doubao', cliPathOverride: fakeCli, cliSessionId: nativeId,
        resume: resumed,
        backendType, launchShell: '/bin/bash', prompt: 'inspect the application entry point and report the module',
        larkAppId: 'app_doubao', larkAppSecret: 'test-only', turnId: 'om_doubao_turn', apiOnly: true,
      } satisfies DaemonToWorker);
      await waitUntil(() => logs.some(line => line.includes('Writing to PTY (flush)')), logs);
      writeFileSync(join(systemDir, 'assignment.md'), `## [${new Date().toISOString()}] 需求\ninspect the application entry point and report the module\n`, { flag: 'a' });
      if (resumed) appendFileSync(trajectory, oldTool.slice(split) + '\n');
      appendFileSync(trajectory, JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'read-1',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: 'src/main.ts' }) } }] }) + '\n');
      await waitUntil(() => messages.some(msg => msg.type === 'thinking_update'), logs);
      expect(messages.some(msg => msg.type === 'final_output')).toBe(false);
      expect(messages.some(msg => msg.type === 'turn_terminal')).toBe(false);
      const progress = messages.find(msg => msg.type === 'thinking_update');
      expect(progress?.turnId).toBe('om_doubao_turn');
      expect(progress?.entries).toMatchObject([{ kind: 'tool_call', id: 'read-1', subject: 'src/main.ts' }]);
      expect(JSON.stringify(progress?.entries)).not.toContain('pre-restart');
      const events = () => request.mock.calls.flatMap(([req]) => req.data?.events ?? []);
      await waitUntil(() => events().some(event => event.event_type === 'TOOL_CALL_START'), logs);

      appendFileSync(trajectory, JSON.stringify({ role: 'tool', tool_call_id: 'read-1', content: 'entry point' }) + '\n'
        + JSON.stringify({ role: 'assistant', content: 'Entry point inspected.' }) + '\n');
      writeFileSync(completeFlag, 'done');
      await waitUntil(() => events().some(event => event.event_type === 'RUN_FINISHED'), logs);
      expect(messages.filter(msg => msg.type === 'final_output')).toMatchObject([
        { turnId: 'om_doubao_turn', content: 'Entry point inspected.' },
      ]);
      expect(events().filter(event => event.event_type === 'TOOL_CALL_START')).toHaveLength(1);
      expect(events().filter(event => event.event_type === 'TOOL_CALL_RESULT')).toHaveLength(1);
      expect(events().filter(event => event.event_type === 'RUN_FINISHED')).toHaveLength(1);
    }, 35_000);
  }
});
