import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { killWorkerTmuxSession } from './helpers/worker-tmux-session.js';
import { writeFakeDoubaoTui } from './helpers/fake-doubao-tui.js';
import { loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import { trackStartingCardPublication } from '../src/core/starting-card-publication.js';
import { replyCardAwaitsNativeThinking, replyCardDispatchAttempt, replyCardModeFor, updateTurnReplyCard } from '../src/core/turn-reply-card.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { buildNewTopicPrompt } from '../src/core/session-manager.js';
import { readBridgeTurnJournal } from '../src/services/bridge-turn-journal.js';
import type { DaemonSession } from '../src/core/types.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

interface CotRequest {
  method: string;
  data?: { events?: Array<{ event_type: string; content: string }> };
}
const defaultRequest = async (req: CotRequest) => req.method === 'POST'
  ? { code: 0, data: { cot_id: 'cot_doubao', message_id: 'om_doubao_progress' } }
  : { code: 0, data: {} };
const request = vi.fn(defaultRequest);
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { cotEnabled: true, cliId: 'doubao', replyCardMode: 'unified', replyCardNativeCot: true } }),
  getBotClient: () => ({ request }),
  normalizeUsageDisplay: () => 'off',
}));
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}), uploadFile: vi.fn(), replyMessage: vi.fn(), sendMessage: vi.fn(),
  MessageWithdrawnError: class extends Error {},
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
  request.mockReset().mockImplementation(defaultRequest);
  vi.unstubAllEnvs();
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
  it.skipIf(!tmuxAvailable).each(['tmux', 'pty'] as const)('settles a cold export-only native progress bubble and its successor exactly once on %s', async backendType => {
    root = mkdtempSync(join(tmpdir(), 'doubao-cold-cot-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir);
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
    const sessionId = randomUUID();
    const systemDir = join(root, '.local', 'share', 'doubao_cli', 'agent_mode', '100', 'workspace',
      '.sessions', '38451111111111111', 'agents', 'main', 'system');
    mkdirSync(systemDir, { recursive: true });
    const assignment = join(systemDir, 'assignment.md');
    const trajectory = join(systemDir, 'trajectory.jsonl');
    writeFileSync(assignment, ''); writeFileSync(trajectory, '');
    const ctlDir = join(root, 'ctl');
    const fakeCli = writeFakeDoubaoTui(root, { systemDir, ctlDir, inputLog: join(root, 'input.jsonl') });
    writeFileSync(join(ctlDir, 'export-only'), '');
    let cotSequence = 0;
    request.mockImplementation(async (req: any) => req.method === 'POST' && req.url === '/open-apis/im/v1/message_cot'
      ? { code: 0, data: { cot_id: `cot_${++cotSequence}`, message_id: `om_cot_${cotSequence}` } }
      : { code: 0, data: {} });
    const ds = { larkAppId: 'app_doubao', chatId: 'oc_test', workingDir: dataDir, scope: 'thread',
      currentTurnId: 'om_first', worker: null, workerGeneration: 1,
      streamCardPending: true, streamCardPendingTurnId: 'om_first',
      session: { sessionId, rootMessageId: 'om_root', chatId: 'oc_test', status: 'active', cliId: 'doubao', backendType },
    } as DaemonSession;
    const cardSend = async (_body: string, _type: string, _uuid: string, beforeWrite: () => unknown) => {
      await beforeWrite(); return `om_answer_${ds.currentTurnId}`;
    };
    const statusPost = vi.fn(async () => true);
    const scope: Record<string, any> = {
      replyCardModeFor, replyCardAwaitsNativeThinking, trackStartingCardPublication,
      deferredUnifiedReplyTurns: new WeakMap(), remoteRetirementAdmissionPhase: () => undefined,
      postTurnStartingStatusCard: statusPost,
      postUnifiedReplyPlaceholder: (target: DaemonSession, _send: unknown, turnId: string) =>
        updateTurnReplyCard(target, turnId, { kind: 'start' }, cardSend, { dispatchAttempt: replyCardDispatchAttempt(target, turnId) })
          .then(Boolean),
    };
    for (const name of ['currentCaptureIdentity', 'unifiedReplyTurnNotCapturing', 'rememberDeferredUnifiedReply',
      'forgetDeferredUnifiedReply', 'takeReadyUnifiedReply', 'postTurnStartingCard', 'releaseDeferredUnifiedReplyCard']) {
      scope[name] = loadWorkerPoolFunction(name, scope);
    }
    await scope.postTurnStartingCard(ds, cardSend, 'om_first');
    expect(request).not.toHaveBeenCalled();
    expect(statusPost).toHaveBeenCalledTimes(1);

    tmuxRoot = mkdtempSync('/tmp/bmx-cot-');
    tmuxEnv = privateTmuxEnv(tmuxRoot);
    delete tmuxEnv.BOTMUX_TMUX_SOCKET;
    execFileSync('tmux', ['-L', 'botmux', 'new-session', '-d', '-s', 'anchor', 'sleep', '120'], { env: tmuxEnv, timeout: 5000 });
    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const publications: Promise<unknown>[] = [];
    child = spawnTsScript(resolve('src/worker.ts'), [], { cwd: resolve('.'),
      env: { ...tmuxEnv, HOME: root, USERPROFILE: root, XDG_DATA_HOME: join(root, '.local', 'share'),
        SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, BOTMUX_NO_CLAIM: '1',
        LARK_APP_ID: 'app_doubao', LARK_APP_SECRET: 'test-only' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    ds.worker = child;
    child.on('message', raw => {
      const msg = raw as WorkerToDaemon;
      messages.push(msg);
      if (msg.type === 'capture_identity') {
        ds.captureIdentity = { workerGeneration: 1, revision: msg.revision, turnId: msg.turnId, dispatchAttempt: msg.dispatchAttempt };
        if (msg.turnId && msg.dispatchAttempt !== undefined) {
          ds.turnDispatchAttemptHighWater = { turnId: msg.turnId, dispatchAttempt: msg.dispatchAttempt };
        }
        publications.push(scope.releaseDeferredUnifiedReplyCard(ds, cardSend));
      }
      if (msg.type === 'turn_terminal') finalizeCotMessage(ds, msg.turnId, msg.status, msg.dispatchAttempt);
    });
    child.stdout?.on('data', data => logs.push(data.toString()));
    child.stderr?.on('data', data => logs.push(data.toString()));
    if (backendType === 'tmux') sessionName = TmuxBackend.sessionName(sessionId);
    child.send({ type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root', workingDir: dataDir,
      cliId: 'doubao', cliPathOverride: fakeCli, backendType, launchShell: '/bin/bash',
      larkAppId: 'app_doubao', larkAppSecret: 'test-only', apiOnly: true, replyDelivery: 'transcript',
    } satisfies DaemonToWorker);
    await waitUntil(() => messages.some(msg => msg.type === 'ready'), logs);
    const events = () => request.mock.calls.flatMap(([req]) => req.data?.events ?? []);
    for (const [turnId, question, answer] of [['om_first', 'first greeting', 'FIRST_COLD_REPLY'],
      ['om_second', 'second greeting', 'SECOND_COLD_REPLY']] as const) {
      ds.currentTurnId = turnId;
      ds.streamCardPending = true;
      ds.streamCardPendingTurnId = turnId;
      await scope.postTurnStartingCard(ds, cardSend, turnId);
      child.send({ type: 'message', turnId, dispatchAttempt: 1,
        content: `<session_id>${sessionId}</session_id>\n<user_message>${question}</user_message>` } satisfies DaemonToWorker);
      await waitUntil(() => readFileSync(assignment, 'utf8').includes(question), logs);
      await waitUntil(() => events().some(e => e.event_type === 'RUN_STARTED' && JSON.parse(e.content).runId === turnId), logs);
      writeFileSync(join(ctlDir, turnId === 'om_first' ? 'finish-1' : 'finish-2'), answer);
      await waitUntil(() => messages.some(msg => msg.type === 'final_output' && msg.turnId === turnId), logs);
      await waitUntil(() => events().some(e => e.event_type === 'RUN_FINISHED' && JSON.parse(e.content).runId === turnId), logs);
      expect(events().filter(e => e.event_type === 'RUN_FINISHED' && JSON.parse(e.content).runId === turnId)).toHaveLength(1);
    }
    await Promise.all(publications);
    expect(cotSequence).toBe(2);
    expect(readFileSync(trajectory, 'utf8')).toBe('');
  }, 90_000);

  for (const { backendType, resumed, restart } of [
    { backendType: 'pty', resumed: false, restart: 'none' }, { backendType: 'tmux', resumed: false, restart: 'none' },
    { backendType: 'pty', resumed: true, restart: 'none' },
    { backendType: 'tmux', resumed: false, restart: 'tools' },
    { backendType: 'tmux', resumed: false, restart: 'tools-during-restart' },
    { backendType: 'tmux', resumed: false, restart: 'partial-final' },
    { backendType: 'tmux', resumed: false, restart: 'completed-final' },
  ] as const) {
    it.skipIf(backendType === 'tmux' && !tmuxAvailable)(`shows tool activity in the native bubble before the final (${backendType}, resumed=${resumed}, restart=${restart})`, async () => {
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
      const readyPaint = join(root, 'paint-ready');
      const inputFile = join(root, 'input');
      const fakeCli = join(root, 'fake-doubao');
      writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
let busy = false;
let paintedReady = false;
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const ready = () => process.stdout.write('\\x1b[2J\\x1b[H' + '─'.repeat(60) + '\\r\\n❯ Ask Doubao to do anything\\r\\n' + '─'.repeat(60) + '\\r\\nEnter send · Ctrl+J newline\\r\\n');
process.stdin.on('data', data => { busy = true; fs.appendFileSync(${JSON.stringify(inputFile)}, data); });
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(completeFlag)})) { busy = false; ready(); }
  else if (busy) process.stdout.write('\\x1b[48;1H\\x1b[KResponding… (1s • esc to interrupt)');
  else if (!paintedReady && fs.existsSync(${JSON.stringify(readyPaint)})) { paintedReady = true; ready(); }
}, 100);
`, { mode: 0o755 });
      const messages: WorkerToDaemon[] = [];
      const logs: string[] = [];
      let ds = { larkAppId: 'app_doubao', chatId: 'oc_test',
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
      const launchWorker = () => {
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
      };
      launchWorker();
      if (backendType === 'tmux') sessionName = TmuxBackend.sessionName(sessionId);
      const prompt = restart === 'none' ? 'inspect the application entry point and report the module'
        : buildNewTopicPrompt('Inspect the entry point', sessionId, 'doubao', undefined,
          undefined, undefined, undefined, undefined, undefined, undefined, undefined,
          { turnId: 'om_doubao_turn', chatId: 'oc_test' });
      const init = { type: 'init', sessionId, daemonBootId: 'doubao-integration-boot', chatId: 'oc_test', chatType: 'group', rootMessageId: 'om_root',
        workingDir: dataDir, cliId: 'doubao', cliPathOverride: fakeCli, cliSessionId: nativeId,
        resume: resumed,
        backendType, launchShell: '/bin/bash', prompt,
        larkAppId: 'app_doubao', larkAppSecret: 'test-only', turnId: 'om_doubao_turn', apiOnly: true,
      } satisfies DaemonToWorker;
      child!.send(init);
      // A fast Linux CLI can paint before tmux pipe-pane subscribes. Wait for
      // the real worker to install its observers before the fixture's one-shot
      // ready frame; prompt detection and the literal submit still run normally.
      await waitUntil(() => messages.some(msg => msg.type === 'ready'), logs);
      expect(logs.some(line => line.includes('Writing to PTY (flush)'))).toBe(false);
      writeFileSync(readyPaint, 'paint');
      await waitUntil(() => logs.some(line => line.includes('Writing to PTY (flush)')), logs);
      await waitUntil(() => existsSync(inputFile) && readFileSync(inputFile, 'utf8').endsWith('\x13'), logs);
      const nativePrompt = readFileSync(inputFile, 'utf8').replace(/\x13$/, '');
      writeFileSync(join(systemDir, 'assignment.md'), `## [${new Date().toISOString()}] 需求\n${nativePrompt}\n`, { flag: 'a' });
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

      if (restart !== 'none') {
        await waitUntil(() => existsSync(inputFile) && readFileSync(inputFile, 'utf8').includes('</user_message>'), logs);
        await new Promise(done => setTimeout(done, 500));
        const journal = join(dataDir, 'turn-marks', `${sessionId}.json.structured`);
        await waitUntil(() => !!readBridgeTurnJournal(journal)[0]?.nativeUserProof, logs);
        if (restart === 'partial-final') appendFileSync(trajectory, '{"role":"assistant","content":"Entry point inspec');
        const inputBefore = readFileSync(inputFile, 'utf8');
        const old = child!;
        const exited = new Promise<void>(done => old.once('exit', () => done()));
        old.disconnect();
        await exited;
        if (restart === 'tools-during-restart') {
          appendFileSync(trajectory, JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'read-after-restart',
            function: { name: 'Read', arguments: '{"file_path":"src/next.ts"}' } }] }) + '\n');
        }
        if (restart === 'completed-final') {
          appendFileSync(trajectory, JSON.stringify({ role: 'assistant', content: 'Answer completed during restart.' }) + '\n');
          writeFileSync(completeFlag, 'done');
        }
        messages.length = 0;
        logs.length = 0;
        ds = { ...ds, session: { ...ds.session } };
        request.mockClear();
        launchWorker();
        child!.send({ ...init, resume: true, prompt: undefined, turnId: undefined });
        await waitUntil(() => logs.some(line => line.includes('Doubao live execution restored')), logs);
        expect(readFileSync(inputFile, 'utf8')).toBe(inputBefore);
        if (restart === 'completed-final') {
          await waitUntil(() => messages.some(msg => msg.type === 'final_output'), logs);
          expect(messages.filter(msg => msg.type === 'final_output')).toMatchObject([
            { turnId: 'om_doubao_turn', content: 'Answer completed during restart.' },
          ]);
          child!.send({ type: 'message', turnId: 'om_doubao_next', content: 'Inspect successor module' });
          await waitUntil(() => readFileSync(inputFile, 'utf8').includes('Inspect successor module'), logs);
          appendFileSync(join(systemDir, 'assignment.md'), `## [${new Date().toISOString()}] 需求\nInspect successor module\n`);
          appendFileSync(trajectory, JSON.stringify({ role: 'assistant', content: 'Successor answer.' }) + '\n');
          await waitUntil(() => messages.filter(msg => msg.type === 'final_output').length === 2, logs);
          expect(messages.filter(msg => msg.type === 'final_output')).toMatchObject([
            { turnId: 'om_doubao_turn', content: 'Answer completed during restart.' },
            { turnId: 'om_doubao_next', content: 'Successor answer.' },
          ]);
          return;
        }
        if (restart === 'tools' || restart === 'tools-during-restart') {
          if (restart === 'tools') appendFileSync(trajectory, JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'read-after-restart',
            function: { name: 'Read', arguments: '{"file_path":"src/next.ts"}' } }] }) + '\n');
          await waitUntil(() => messages.some(msg => msg.type === 'thinking_update'), logs);
          expect(messages.find(msg => msg.type === 'thinking_update')).toMatchObject({ turnId: 'om_doubao_turn',
            entries: [{ kind: 'tool_call', id: 'read-after-restart' }] });
          expect(messages.some(msg => msg.type === 'final_output')).toBe(false);
        }
      }

      appendFileSync(trajectory, restart === 'partial-final' ? 'ted."}\n'
        : JSON.stringify({ role: 'tool', tool_call_id: restart === 'tools' || restart === 'tools-during-restart' ? 'read-after-restart' : 'read-1', content: 'entry point' }) + '\n'
        + JSON.stringify({ role: 'assistant', content: 'Entry point inspected.' }) + '\n');
      writeFileSync(completeFlag, 'done');
      await waitUntil(() => messages.some(msg => msg.type === 'final_output'), logs);
      expect(messages.filter(msg => msg.type === 'final_output')).toMatchObject([
        { turnId: 'om_doubao_turn', content: 'Entry point inspected.' },
      ]);
      if (restart !== 'partial-final') {
        await waitUntil(() => events().some(event => event.event_type === 'RUN_FINISHED'), logs);
        expect(events().filter(event => event.event_type === 'TOOL_CALL_START')).toHaveLength(1);
        expect(events().filter(event => event.event_type === 'TOOL_CALL_RESULT')).toHaveLength(1);
        expect(events().filter(event => event.event_type === 'RUN_FINISHED')).toHaveLength(1);
      }
    }, 45_000);
  }
});
