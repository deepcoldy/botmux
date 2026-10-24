import { type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { PI_TURN_BOUNDARY_CUSTOM_TYPE } from '../src/adapters/cli/pi-turn-boundary-extension.js';

// Real worker, fake `pi` executable, hand-written session JSONL: the turn ends
// the way the live incident did — Pi could not run its token command, wrote an
// error record and settled the turn as `error`. The group must get a failure
// notice and the daemon a failed terminal (which turns the card to 执行失败).

let child: ChildProcess | undefined;
let root: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>(done => child!.once('exit', () => done()));
    child.kill('SIGKILL');
    await Promise.race([stopped, new Promise<void>(done => setTimeout(done, 2_000))]);
  }
  child = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function waitUntil(check: () => boolean, logs: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child?.exitCode !== null || child?.signalCode !== null) throw new Error(`Worker exited\n${logs.join('')}`);
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error(`Timed out\n${logs.join('')}`);
}

describe('Pi worker: a turn Pi aborts on an unresolvable model credential', () => {
  it('posts the credential failure notice and emits a failed terminal', async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-fail-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const cliSessionId = 'deadbeef-1234-4678-9abc-def01234567a';
    const piSessionsDir = join(root, '.pi', 'agent', 'sessions', dataDir.replace(/\//g, '--'));
    mkdirSync(piSessionsDir, { recursive: true });
    const transcript = join(piSessionsDir, `20261020120000_${cliSessionId}.jsonl`);
    writeFileSync(transcript, '');
    const fakePi = join(root, 'fake-pi');
    // Like Pi itself: the busy line stays on screen while the turn runs and is
    // repainted away once the turn settles. Pi's idle detection is the viewport
    // (no busy line + quiet), so a fake that never clears it only passed when the
    // worker happened to check the screen before the busy line was drawn.
    writeFileSync(fakePi, `#!/usr/bin/env node
process.stdout.write('Working...\\n');
process.stdin.resume();
import('node:fs').then(({ readFileSync }) => {
  const settle = setInterval(() => {
    let rows = '';
    try { rows = readFileSync(${JSON.stringify(transcript)}, 'utf8'); } catch {}
    if (!/"lastStopReason":"/.test(rows)) return;
    clearInterval(settle);
    process.stdout.write('\\u001b[2J\\u001b[H> ');
  }, 50);
});
setInterval(() => {}, 1000);
`);
    chmodSync(fakePi, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env, HOME: root, SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-pi-fail', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', raw => { messages.push(raw as WorkerToDaemon); });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.send({
      type: 'init', sessionId: 'sid-pi-fail', chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: dataDir, cliId: 'pi', cliPathOverride: fakePi, cliSessionId,
      backendType: 'pty', prompt: 'review the PR', larkAppId: 'app_test', larkAppSecret: 'test-only',
      turnId: 'om_pi_turn',
    } satisfies DaemonToWorker);
    await waitUntil(() => logs.some(line => line.includes('Codex bridge fresh-empty:')), logs);

    const at = () => new Date().toISOString();
    const errorMessage = 'API key auth failed for provider super-relay: Failed to resolve API key for provider "super-relay" from shell command: bytedcli auth get-bytecloud-jwt-token';
    appendFileSync(transcript, [
      { type: 'custom', timestamp: at(), customType: PI_TURN_BOUNDARY_CUSTOM_TYPE, data: { lastStopReason: null } },
      { type: 'message', timestamp: at(), message: { role: 'user', content: [{ type: 'text', text: 'review the PR' }] } },
      { type: 'message', timestamp: at(), message: {
        role: 'assistant', stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'git log -1' } }],
      } },
      { type: 'message', timestamp: at(), message: { role: 'toolResult', toolCallId: 'bash-1', content: [{ type: 'text', text: 'abc123' }] } },
      { type: 'message', timestamp: at(), message: { role: 'assistant', stopReason: 'error', content: [], errorMessage } },
      { type: 'custom', timestamp: at(), customType: PI_TURN_BOUNDARY_CUSTOM_TYPE, data: { lastStopReason: 'error' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    await waitUntil(() => messages.some(msg => msg.type === 'turn_terminal'), logs);
    const finals = messages.filter((msg): msg is Extract<WorkerToDaemon, { type: 'final_output' }> => msg.type === 'final_output');
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      turnId: 'om_pi_turn', turnFailed: true, turnFailureCode: 'pi_credential_unavailable',
    });
    expect(finals[0].turnFailureNotice).toMatch(/获取模型凭据失败|could not obtain model credentials/);
    expect(finals[0].turnFailureNotice).toContain('Failed to resolve API key');
    const terminal = messages.find(msg => msg.type === 'turn_terminal');
    expect(terminal).toMatchObject({ turnId: 'om_pi_turn', status: 'failed', errorCode: 'pi_credential_unavailable' });
    expect(messages.indexOf(finals[0])).toBeLessThan(messages.indexOf(terminal!));
  }, 30_000);
});
