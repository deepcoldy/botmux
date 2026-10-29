import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { killProcessTree } from './helpers/process-tree.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';

const tmuxAvailable = probeTmuxFunctional().ok;
for (const backendType of ['pty', 'tmux'] as const) {
for (const scenario of ['unfinished', 'completed', 'manual'] as const) {
  if (scenario === 'manual' && backendType !== 'tmux') continue;
  const completed = scenario === 'completed';
  const manual = scenario === 'manual';
  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(`${backendType}: ${scenario} work at the first restored prompt`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'deployment-worker-'));
    // A private HOME must not enter zsh-newuser-install before the fake CLI.
    writeFileSync(join(root, '.zshrc'), '# isolated worker test\n');
    // Unix-domain sockets have a much smaller path limit than HOME paths.
    const tmuxRoot = backendType === 'tmux' ? mkdtempSync('/tmp/bmx-dc-') : root;
    const dataDir = join(root, 'data'); mkdirSync(dataDir);
    const sessions = join(root, '.codex', 'sessions', '2026', '10', '27'); mkdirSync(sessions, { recursive: true });
    const nativeId = '11111111-2222-4333-8444-555555555555';
    const transcript = join(sessions, `rollout-2026-10-27T00-00-00-${nativeId}.jsonl`);
    const timestamp = new Date(Date.now() - 10_000).toISOString();
    const rows = [
      { type: 'session_meta', timestamp, payload: { id: nativeId, cwd: dataDir } },
      { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'original task: write a test' } },
      { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'native-turn' } },
      { type: 'response_item', timestamp, payload: { type: 'function_call', call_id: 'tool-1', name: 'exec_command', arguments: '{}' } },
      ...(completed ? [{ type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: 'native-turn', last_agent_message: 'done' } }] : []),
    ];
    writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const input = join(root, 'input');
    const started = join(root, 'started'), release = join(root, 'release');
    const fake = join(root, 'fake-codex');
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const fd = fs.openSync(${JSON.stringify(transcript)}, 'a');
fs.writeFileSync(${JSON.stringify(started)}, 'ready');
process.stdin.setRawMode(true);
let typed = '', recorded = false, cleared = false;
process.stdin.on('data', data => {
  fs.appendFileSync(${JSON.stringify(input)}, data); typed += data.toString();
  if (${manual} && !cleared && typed.includes('/clear') && typed.includes('\\r')) {
    cleared = true;
    process.stdout.write('\\x1b[2J\\x1b[HWorking...');
    setTimeout(() => process.stdout.write(screen), 300);
  }
  const match = typed.match(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~/);
  if (match && typed.includes('\\r') && !recorded) {
    recorded = true;
    fs.appendFileSync(${JSON.stringify(join(root, '.codex', 'history.jsonl'))}, JSON.stringify({session_id:${JSON.stringify(nativeId)}, text:match[1], ts:Date.now()/1000})+'\\n');
  }
});
const screen = '\\x1b[?2004h\\x1b[2J\\x1b[H│ model: custom-model /model to change │\\r\\n│ directory: /tmp │\\r\\n› Ask Codex to do anything\\r\\n  100% context left';
if (${manual}) {
  let released = false;
  setInterval(() => { if (!released && fs.existsSync(${JSON.stringify(release)})) { released = true; process.stdout.write(screen); } }, 100);
} else for (const delay of [0, 200, 400, 800]) setTimeout(() => process.stdout.write(screen), delay);
setInterval(() => {}, 1000);
`);
    chmodSync(fake, 0o755);
    const messages: WorkerToDaemon[] = [], logs: string[] = [];
    let child: ChildProcess | undefined;
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 22_000;
      while (!predicate()) {
        if (Date.now() > deadline || child?.exitCode != null) throw new Error(logs.join(''));
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    };
    try {
      child = spawnNodeTsScript(resolve('src/worker.ts'), [], { cwd: resolve('.'),
        env: privateTmuxEnv(tmuxRoot, { HOME: root, CODEX_HOME: join(root, '.codex'), USERPROFILE: root,
          BOTMUX_TMUX_SOCKET: 'botmux',
          SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: randomUUID(), LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only' }),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.on('message', message => messages.push(message as WorkerToDaemon));
      child.stdout?.on('data', data => logs.push(data.toString())); child.stderr?.on('data', data => logs.push(data.toString()));
      child.send({ type: 'init', sessionId: randomUUID(), chatId: 'oc_test', rootMessageId: 'om_root',
        cliId: 'codex', cliPathOverride: fake, cliSessionId: nativeId, workingDir: dataDir,
        backendType, prompt: '', resume: true, larkAppId: 'app_test', larkAppSecret: 'test-only',
        deploymentContinuation: { state: 'claimed', turnId: 'om_original', nativeSessionId: nativeId,
          consumedAt: Date.now() - 1000, workerGeneration: 1,
          caller: { senderType: 'user', requestLarkAppId: 'app_test', requestUserOpenId: 'ou_original' } },
      } satisfies DaemonToWorker);
      if (manual) {
        await wait(() => existsSync(started));
        child.send({ type: 'raw_input', content: '/clear' } satisfies DaemonToWorker);
        await wait(() => logs.some(line => line.includes('Deferred passthrough slash command')));
        writeFileSync(release, 'go');
      }
      await wait(() => messages.some(message => message.type === 'prompt_ready'));
      if (manual) {
        await wait(() => existsSync(input) && readFileSync(input, 'utf8').includes('/clear'));
        await wait(() => messages.filter(message => message.type === 'prompt_ready').length >= 2);
        await new Promise(resolve => setTimeout(resolve, 1000));
        expect(readFileSync(input, 'utf8')).toBe('/clear\r');
        expect(messages.some(message => message.type === 'native_input_consumed' && message.turnId === 'om_original')).toBe(false);
      } else if (completed) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        expect(existsSync(input) ? readFileSync(input, 'utf8') : '').toBe('');
      } else {
        await wait(() => messages.some(message => message.type === 'native_input_consumed' && message.turnId === 'om_original'));
        const text = readFileSync(input, 'utf8');
        expect(text).not.toContain('original task: write a test');
        expect(text.match(/\x1b\[200~/g)).toHaveLength(1);
        expect(messages).toContainEqual(expect.objectContaining({ type: 'managed_turn_origin', turnId: 'om_original',
          trustedCaller: expect.objectContaining({ requestUserOpenId: 'ou_original' }) }));
        expect(messages).toContainEqual(expect.objectContaining({ type: 'native_input_consumed', turnId: 'om_original', ordinaryInteractive: true }));
      }
    } finally {
      if (child) await killProcessTree(child);
      if (backendType === 'tmux') {
        const socket = join(tmuxRoot, `tmux-${process.getuid?.() ?? 0}`, 'botmux');
        try { execFileSync('tmux', ['-S', socket, 'kill-server'], { env: privateTmuxEnv(tmuxRoot), stdio: 'ignore' }); } catch { /* gone */ }
        rmSync(tmuxRoot, { recursive: true, force: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
}
}
