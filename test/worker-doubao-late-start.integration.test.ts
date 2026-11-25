/**
 * Doubao input that reaches the CLI while it is still busy.
 *
 * Real worker (src/worker.ts) over daemon IPC, a private tmux server, and a
 * Doubao TUI double (test/helpers/fake-doubao-tui.ts) that follows Doubao
 * 2.37's composer/queue semantics: Enter while a turn runs parks the input in
 * Doubao's own send queue, and its native user record is written only when
 * that queue is pumped after the running work ends.
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { killWorkerTmuxSession } from './helpers/worker-tmux-session.js';
import { writeFakeDoubaoTui } from './helpers/fake-doubao-tui.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { WorkerOutputJournal } from '../src/services/worker-output-journal.js';

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

function startScenario(opts: { submitDelayMs?: number; pasteDelayMs?: number; fresh?: boolean; exportOnly?: boolean; backend?: 'tmux' | 'pty'; handoff?: boolean } = {}) {
  root = mkdtempSync(join(tmpdir(), 'doubao-late-start-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const sessionId = randomUUID();
  const nativeId = '38451111111111111';
  const systemDir = join(root, '.local', 'share', 'doubao_cli', 'agent_mode', '100', 'workspace',
    '.sessions', nativeId, 'agents', 'main', 'system');
  mkdirSync(systemDir, { recursive: true });
  const assignment = join(systemDir, 'assignment.md');
  writeFileSync(assignment, opts.fresh ? '' : '## [2026-01-01T00:00:00Z] 需求\nOld prompt\n\n');
  const trajectory = join(systemDir, 'trajectory.jsonl');
  writeFileSync(trajectory, opts.fresh ? '' : JSON.stringify({ role: 'assistant', content: 'Old answer' }) + '\n');
  const ctlDir = join(root, 'ctl');
  const inputLog = join(root, 'input.jsonl');
  const fakeCli = writeFakeDoubaoTui(root, { systemDir, ctlDir, inputLog });
  writeFileSync(join(ctlDir, 'export.json'), JSON.stringify(opts.fresh ? [] : [{ query: 'Old prompt', response: 'Old answer' }]));
  if (opts.exportOnly) writeFileSync(join(ctlDir, 'export-only'), '');
  if (opts.submitDelayMs) writeFileSync(join(ctlDir, 'submit-delay'), String(opts.submitDelayMs));
  if (opts.pasteDelayMs) writeFileSync(join(ctlDir, 'paste-delay'), String(opts.pasteDelayMs));
  // Unix socket paths are bounded; keep the private tmux dir short.
  tmuxRoot = mkdtempSync('/tmp/bmx-dl-');
  tmuxEnv = privateTmuxEnv(tmuxRoot);
  delete tmuxEnv.BOTMUX_TMUX_SOCKET;
  execFileSync('tmux', ['-L', 'botmux', 'new-session', '-d', '-s', 'anchor', 'sleep', '300'],
    { env: tmuxEnv, timeout: 5_000 });
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const workerEnv = {
    ...tmuxEnv, HOME: root, USERPROFILE: root, XDG_DATA_HOME: join(root, '.local', 'share'),
    SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, BOTMUX_NO_CLAIM: '1',
    LARK_APP_ID: 'app_doubao', LARK_APP_SECRET: 'test-only',
  };
  const init = {
    type: 'init', sessionId, daemonBootId: 'doubao-late-start-boot', chatId: 'oc_test', chatType: 'group',
    rootMessageId: 'om_root', workingDir: dataDir, cliId: 'doubao', cliPathOverride: fakeCli,
    ...(opts.fresh ? {} : { cliSessionId: nativeId, resume: true }),
    backendType: opts.backend ?? 'tmux', launchShell: '/bin/bash', replyDelivery: 'transcript',
    prompt: opts.fresh
      ? `<session_id>${sessionId}</session_id>\n<user_message>first task: inspect the build</user_message>`
      : 'first task: inspect the build', turnId: 'om_turn_1',
    larkAppId: 'app_doubao', larkAppSecret: 'test-only', apiOnly: true,
    ...(opts.handoff ? { finalOutputHandoff: { version: 2, token: 'fixture-token', admitNew: true } } : {}),
  } satisfies DaemonToWorker;
  const spawnObserver = (message: DaemonToWorker) => {
    child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'), env: workerEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', raw => {
      const event = raw as WorkerToDaemon;
      messages.push(event);
      if (opts.handoff && event.type === 'final_output' && event.handoff) {
        child!.send({ type: 'final_output_settled', ...event.handoff });
      }
    });
    child.stdout?.on('data', data => logs.push(data.toString()));
    child.stderr?.on('data', data => logs.push(data.toString()));
    child.send(message);
  };
  sessionName = TmuxBackend.sessionName(sessionId);
  spawnObserver(init);
  const waitUntil = async (check: () => boolean, what: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() >= deadline || child?.exitCode != null || child?.signalCode != null) {
        throw new Error(`timed out: ${what}\n${logs.join('').slice(-8000)}`);
      }
      await pause(50);
    }
  };
  const control = (name: string, content = '') => writeFileSync(join(ctlDir, name), content);
  const clear = (name: string) => { try { unlinkSync(join(ctlDir, name)); } catch { /* absent */ } };
  const assignmentText = () => readFileSync(assignment, 'utf8');
  const pastes = (needle: string) => (existsSync(inputLog) ? readFileSync(inputLog, 'utf8') : '')
    .split('\n').filter(Boolean).map(line => JSON.parse(line).data as string)
    .join('').split(needle).length - 1;
  const finals = (turnId: string) => messages.filter(msg => msg.type === 'final_output' && msg.turnId === turnId);
  const uncollected = (turnId: string) => messages.filter(msg => msg.type === 'user_notify'
    && (msg as { kind?: string }).kind === 'structured_turn_not_collected' && msg.turnId === turnId);
  const sendMessage = (turnId: string, content: string, dispatchAttempt?: number) => child!.send({
    type: 'message', turnId, content, ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
  } satisfies DaemonToWorker);
  /** A person pressing keys in the Web terminal. */
  const pressInTerminal = (...keys: string[]) => execFileSync('tmux', ['-L', 'botmux', 'send-keys', '-t', sessionName!, ...keys],
    { env: tmuxEnv, timeout: 5_000 });
  const pressEnterInTerminal = () => pressInTerminal('Enter');
  const pane = () => execFileSync('tmux', ['-L', 'botmux', 'capture-pane', '-p', '-t', sessionName!],
    { env: tmuxEnv, timeout: 5_000 }).toString();
  const notices = (turnId: string) => messages.filter(msg => msg.type === 'user_notify' && msg.turnId === turnId);
  const restartObserver = async () => {
    const previous = child!;
    previous.kill('SIGTERM');
    await waitUntil(() => previous.exitCode !== null || previous.signalCode !== null, 'observer detached');
    spawnObserver({ ...init, cliSessionId: nativeId, resume: true, prompt: '', turnId: undefined });
  };
  return {
    messages, logs, waitUntil, control, clear, assignmentText, pastes, finals, uncollected, sendMessage,
    pressEnterInTerminal, pressInTerminal, pane, notices,
    trajectory, ctlDir, dataDir, sessionId, restartObserver,
  };
}

async function finishFirstTurn(s: ReturnType<typeof startScenario>): Promise<void> {
  await s.waitUntil(() => s.messages.some(msg => msg.type === 'ready'), 'worker ready');
  await s.waitUntil(() => s.assignmentText().includes('first task'), 'turn 1 native start', 30_000);
  s.control('finish-1', 'FIRST_ANSWER');
  await s.waitUntil(() => s.finals('om_turn_1').length > 0, 'turn 1 reply forwarded');
  await s.waitUntil(() => s.messages.filter(msg => msg.type === 'prompt_ready').length >= 2, 'idle after turn 1');
}

describe.skipIf(process.platform === 'win32' || !tmuxAvailable)('Doubao input accepted while the CLI is busy', () => {
  it.each(['tmux', 'pty'] as const)('bypasses asynchronous clipboard work and automatically collects consecutive answers on %s', async backend => {
    const s = startScenario({ fresh: true, exportOnly: true, backend, pasteDelayMs: 1600 });
    await s.waitUntil(() => s.assignmentText().includes('first task'), 'delayed paste first submit', 30_000);
    s.control('finish-1', 'FIRST_DELAYED_PASTE');
    await s.waitUntil(() => s.finals('om_turn_1').length > 0, 'first automatic final', 30_000);
    s.control('paste-delay', '2100');
    const second = 'second task\n────────\nAsk Doubao to do anything\nline four\nline five\\';
    s.sendMessage('om_turn_2', second);
    await s.waitUntil(() => s.assignmentText().includes(second), 'second automatic submit', 30_000);
    s.control('finish-2', 'SECOND_DELAYED_PASTE');
    await s.waitUntil(() => s.finals('om_turn_2').length > 0, 'second automatic final', 30_000);
    await pause(1500);
    expect(s.finals('om_turn_1').map(msg => (msg as { content: string }).content)).toEqual(['FIRST_DELAYED_PASTE']);
    expect(s.finals('om_turn_2').map(msg => (msg as { content: string }).content)).toEqual(['SECOND_DELAYED_PASTE']);
    expect(s.pastes('first task')).toBe(1);
    expect(s.pastes('line five')).toBe(1);
    expect(s.assignmentText().split(second)).toHaveLength(2);
    expect(s.notices('om_turn_2')).toEqual([]);
    expect(readFileSync(s.trajectory, 'utf8')).toBe('');
    // The tmux transport must not put large literal input in a single argv.
    const large = `third task ${'x'.repeat(140_000)}\nlarge input ends here`;
    s.sendMessage('om_turn_3', large);
    await s.waitUntil(() => s.assignmentText().includes(large), 'large input delivered intact', 30_000);
    s.control('finish-3', 'LARGE_INPUT_ANSWER');
    await s.waitUntil(() => s.finals('om_turn_3').length > 0, 'large input answer', 30_000);
    expect(s.finals('om_turn_3').map(msg => (msg as { content: string }).content)).toEqual(['LARGE_INPUT_ANSWER']);
    expect(s.pastes('large input ends here')).toBe(1);
  }, 90_000);

  it('never treats an opaque collapsed control-bearing paste as proof of the complete draft', async () => {
    const s = startScenario({ fresh: true, exportOnly: true });
    await finishFirstTurn(s);
    s.sendMessage('om_turn_2', 'opaque paste\t\nsecond line\nthird line\nfourth line');
    await s.waitUntil(() => s.pane().includes('[Pasted text'), 'opaque paste rendered');
    await s.waitUntil(() => s.logs.some(line => line.includes('Quarantined input delivery')), 'unproven draft quarantined', 30_000);
    expect(s.assignmentText()).not.toContain('opaque paste');
    expect(s.finals('om_turn_2')).toEqual([]);
    // A human may submit this draft; Botmux must never guess from its line count.
    s.pressInTerminal('C-u');
  }, 60_000);

  it('never submits a delayed paste after the user stops it, and holds the successor off that draft', async () => {
    const s = startScenario({ fresh: true, exportOnly: true });
    await finishFirstTurn(s);
    s.control('paste-hold');
    s.sendMessage('om_turn_2', 'stopped while waiting\tfor clipboard');
    await s.waitUntil(() => s.pastes('stopped while waiting') === 1, 'pending paste bytes delivered');
    child!.send({ type: 'interrupt_turn', requestId: 'stop-paste', turnId: 'om_turn_2' } satisfies DaemonToWorker);
    await s.waitUntil(() => s.messages.some(msg => msg.type === 'turn_interrupt_result' && msg.requestId === 'stop-paste'), 'stop handled');
    s.sendMessage('om_turn_3', 'successor must wait for cleared composer');
    s.clear('paste-hold');
    await s.waitUntil(() => s.pane().includes('stopped while waiting'), 'cancelled paste remains a draft');
    await pause(2000);
    expect(s.assignmentText()).not.toContain('stopped while waiting');
    expect(s.pastes('successor must wait')).toBe(0);
    expect(s.finals('om_turn_2')).toEqual([]);
    s.pressInTerminal('C-u');
    await s.waitUntil(() => s.assignmentText().includes('successor must wait'), 'successor submitted after clearing', 90_000);
    s.control('finish-2', 'SUCCESSOR_ONLY');
    await s.waitUntil(() => s.finals('om_turn_3').length > 0, 'successor final', 30_000);
    expect(s.finals('om_turn_3').map(msg => (msg as { content: string }).content)).toEqual(['SUCCESSOR_ONLY']);
  }, 150_000);

  it('does not submit a partial or manually changed draft while a clipboard probe is pending', async () => {
    const s = startScenario({ fresh: true, exportOnly: true });
    await finishFirstTurn(s);
    s.control('paste-hold');
    s.sendMessage('om_turn_2', 'second task with delayed\tclipboard');
    await s.waitUntil(() => s.pastes('second task with delayed') === 1, 'paste frame delivered');
    // A half-written draft is visible, but it is not the complete input. When
    // clipboard work finishes it must not make that mixed draft ours to submit.
    s.pressInTerminal('manual-fragment');
    await s.waitUntil(() => s.logs.some(line => line.includes('Quarantined input delivery')), 'changed draft held', 20_000);
    s.sendMessage('om_turn_3', 'successor after a changed draft');
    s.clear('paste-hold');
    await s.waitUntil(() => s.pane().includes('clipboard'), 'late paste rendered');
    await pause(1500);
    expect(s.assignmentText()).not.toContain('second task with delayed');
    expect(s.pastes('successor after a changed')).toBe(0);
    s.pressInTerminal('C-u');
    await s.waitUntil(() => s.assignmentText().includes('successor after a changed'), 'successor cleanly submitted', 90_000);
    s.control('finish-2', 'CLEAN_SUCCESSOR');
    await s.waitUntil(() => s.finals('om_turn_3').length > 0, 'clean successor final');
    expect(s.finals('om_turn_2')).toEqual([]);
    expect(s.finals('om_turn_3').map(msg => (msg as { content: string }).content)).toEqual(['CLEAN_SUCCESSOR']);
  }, 150_000);

  it('does not let paste readiness after the wait expires submit a held successor or revive the old turn', async () => {
    const s = startScenario({ fresh: true, exportOnly: true });
    await finishFirstTurn(s);
    s.control('paste-hold');
    s.sendMessage('om_turn_2', 'late paste\t\nsecond line\nthird line\nfourth line');
    await s.waitUntil(() => s.pastes('late paste') === 1, 'clipboard started');
    await s.waitUntil(() => s.logs.some(line => line.includes('Quarantined input delivery')), 'bounded readiness wait ended', 30_000);
    s.sendMessage('om_turn_3', 'successor overlapping expired paste wait');
    s.clear('paste-hold');
    await s.waitUntil(() => s.pane().includes('[Pasted text'), 'paste completes after deadline');
    await pause(1500);
    expect(s.assignmentText()).not.toContain('late paste');
    expect(s.pastes('successor overlapping')).toBe(0);
    s.pressInTerminal('C-u');
    await s.waitUntil(() => s.assignmentText().includes('successor overlapping'), 'successor after clearing expired draft', 90_000);
    s.control('finish-2', 'AFTER_EXPIRED_PASTE');
    await s.waitUntil(() => s.finals('om_turn_3').length > 0, 'overlapping successor final');
    expect(s.finals('om_turn_2')).toEqual([]);
    expect(s.finals('om_turn_3').map(msg => (msg as { content: string }).content)).toEqual(['AFTER_EXPIRED_PASTE']);
  }, 150_000);

  it('export recovery survives an observer reattach without submitting the pending input again', async () => {
    const s = startScenario({ fresh: true, exportOnly: true });
    await s.waitUntil(() => s.assignmentText().includes('first task'), 'native input proof', 30_000);
    await s.waitUntil(() => {
      try {
        const journal = JSON.parse(readFileSync(join(s.dataDir, 'turn-marks', `${s.sessionId}.json.structured`), 'utf8'));
        return journal.pending.some((turn: { turnId: string; nativeUserProof?: unknown }) => turn.turnId === 'om_turn_1' && turn.nativeUserProof);
      } catch { return false; }
    }, 'native attribution proof persisted');
    await s.restartObserver();
    await s.waitUntil(() => s.messages.filter(msg => msg.type === 'ready').length >= 2, 'replacement observer ready');
    s.control('finish-1', 'ANSWER_AFTER_REATTACH');
    await s.waitUntil(() => s.finals('om_turn_1').length > 0, 'pending answer recovered without new submit', 30_000);
    await pause(2_000);
    expect(s.finals('om_turn_1').map(msg => (msg as { content: string }).content)).toEqual(['ANSWER_AFTER_REATTACH']);
    expect(s.pastes('first task')).toBe(1);
  }, 90_000);

  it.each(['tmux', 'pty'] as const)('export recovery collects a fresh tool-less first answer once on %s, including consecutive turns and late logs', async backend => {
    const s = startScenario({ fresh: true, exportOnly: true, backend });
    await s.waitUntil(() => s.assignmentText().includes('first task'), 'first assignment proof', 30_000);
    expect(readFileSync(s.trajectory, 'utf8')).toBe('');
    s.control('finish-1', 'EXPORTED_FIRST');
    await s.waitUntil(() => s.finals('om_turn_1').length > 0, 'exported first answer', 30_000);
    s.sendMessage('om_turn_2', 'second tool-less task');
    await s.waitUntil(() => s.assignmentText().includes('second tool-less'), 'second assignment proof', 30_000);
    // A late id-less final from the recovered first turn must never close N+1.
    appendFileSync(s.trajectory, JSON.stringify({ role: 'assistant', content: 'EXPORTED_FIRST' }) + '\n');
    await pause(2_000);
    expect(s.finals('om_turn_2')).toEqual([]);
    s.control('finish-2', 'EXPORTED_SECOND');
    await s.waitUntil(() => s.finals('om_turn_2').length > 0, 'exported successor', 30_000);
    await pause(2_000);
    expect(s.finals('om_turn_1').map(msg => (msg as { content: string }).content)).toEqual(['EXPORTED_FIRST']);
    expect(s.finals('om_turn_2').map(msg => (msg as { content: string }).content)).toEqual(['EXPORTED_SECOND']);
    expect(s.messages.filter(msg => msg.type === 'turn_terminal' && msg.turnId === 'om_turn_1')).toHaveLength(1);
    expect(s.messages.filter(msg => msg.type === 'turn_terminal' && msg.turnId === 'om_turn_2')).toHaveLength(1);
  }, 100_000);

  it('export recovery settles an idle turn with an uncollected failure when export remains unavailable', async () => {
    const s = startScenario({ fresh: true, exportOnly: true });
    s.control('export-error');
    await s.waitUntil(() => s.assignmentText().includes('first task'), 'first assignment proof', 30_000);
    s.control('finish-1', 'ONLY_IN_TERMINAL');
    await s.waitUntil(() => s.messages.some(msg => msg.type === 'turn_terminal'
      && msg.turnId === 'om_turn_1'), 'bounded terminal', 90_000);
    expect(s.finals('om_turn_1')).toEqual([]);
    expect(s.messages.filter(msg => msg.type === 'turn_display_retired' && msg.turnId === 'om_turn_1')).toHaveLength(1);
    expect(s.messages.find(msg => msg.type === 'turn_terminal' && msg.turnId === 'om_turn_1'))
      .toMatchObject({ status: 'ambiguous', errorCode: 'doubao_reply_not_collected' });
    await pause(2_000);
    expect(s.messages.filter(msg => msg.type === 'turn_display_retired' && msg.turnId === 'om_turn_1')).toHaveLength(1);
  }, 130_000);

  it('export recovery never publishes a stopped turn and still recovers its successor', async () => {
    const s = startScenario({ fresh: true, exportOnly: true });
    await s.waitUntil(() => s.assignmentText().includes('first task'), 'first assignment proof', 30_000);
    child!.send({ type: 'interrupt_turn', requestId: 'stop-first', turnId: 'om_turn_1' } satisfies DaemonToWorker);
    await s.waitUntil(() => s.messages.some(msg => msg.type === 'turn_interrupt_result'
      && msg.requestId === 'stop-first'), 'stop receipt');
    expect(s.messages.find(msg => msg.type === 'turn_interrupt_result' && msg.requestId === 'stop-first'))
      .toMatchObject({ delivered: true });
    s.sendMessage('om_turn_2', 'successor after stop');
    await s.waitUntil(() => s.assignmentText().includes('successor after stop'), 'successor proof', 30_000);
    s.control('finish-2', 'AFTER_STOP');
    await s.waitUntil(() => s.finals('om_turn_2').length > 0, 'successor reply', 30_000);
    expect(s.finals('om_turn_1')).toEqual([]);
    expect(s.finals('om_turn_2').map(msg => (msg as { content: string }).content)).toEqual(['AFTER_STOP']);
  }, 90_000);

  it('export recovery retries the real output journal after only the mode barrier committed', async () => {
    const s = startScenario({ fresh: true, exportOnly: true, backend: 'pty', handoff: true });
    await s.waitUntil(() => s.assignmentText().includes('first task'), 'first assignment proof', 30_000);
    const journal = new WorkerOutputJournal(s.dataDir, 'app_doubao', s.sessionId);
    rmSync(journal.directory, { recursive: true });
    writeFileSync(journal.directory, 'block the publication write');
    s.control('finish-1', 'AFTER_DISK_REPAIR');
    await s.waitUntil(() => s.logs.some(line => line.includes('ENOTDIR')), 'real publication failure', 30_000);
    expect(s.finals('om_turn_1')).toEqual([]);
    expect(s.messages.filter(msg => msg.type === 'turn_terminal' && msg.turnId === 'om_turn_1')).toEqual([]);
    rmSync(journal.directory);
    mkdirSync(journal.directory);
    await s.waitUntil(() => s.finals('om_turn_1').length > 0, 'retry after disk repair', 30_000);
    await s.waitUntil(() => s.messages.some(msg => msg.type === 'turn_terminal' && msg.turnId === 'om_turn_1'), 'ordered terminal');
    await s.waitUntil(() => journal.readPending().length === 0, 'handoff ACK');
    await pause(2_000);
    expect(s.finals('om_turn_1').map(msg => (msg as { content: string }).content)).toEqual(['AFTER_DISK_REPAIR']);
    expect(s.messages.filter(msg => msg.type === 'turn_terminal' && msg.turnId === 'om_turn_1')).toHaveLength(1);
  }, 100_000);

  it('holds a follow-up in botmux while Doubao is still running, then delivers it and its reply', async () => {
    const s = startScenario({ submitDelayMs: 3_000 });
    await s.waitUntil(() => s.messages.some(msg => msg.type === 'ready'), 'worker ready');
    await s.waitUntil(() => s.pastes('first task') === 1, 'turn 1 pasted', 30_000);
    // Arrives while turn 1's write still waits for its receipt.
    s.sendMessage('om_turn_2', 'second task: summarize the failures');
    await s.waitUntil(() => s.assignmentText().includes('first task'), 'turn 1 native start', 30_000);
    await pause(1_000);
    // Doubao writes a content-only assistant record mid-turn and keeps
    // running tools; its busy footer stays on screen.
    s.control('midfinal-1', 'Interim note.');
    // Well past the 20s pre-start lease that used to expire the follow-up.
    await pause(26_000);
    // Nothing is typed into Doubao while it visibly works.
    expect(s.pastes('second task: summarize the failures')).toBe(0);
    expect(s.uncollected('om_turn_2')).toEqual([]);

    s.control('finish-1', 'FIRST_ANSWER');
    await s.waitUntil(() => s.assignmentText().includes('second task'), 'turn 2 native start', 30_000);
    s.control('finish-2', 'SECOND_ANSWER');
    await s.waitUntil(() => s.finals('om_turn_2').length > 0, 'turn 2 reply forwarded');
    await pause(1_500);
    expect(s.finals('om_turn_2').map(msg => (msg as { content: string }).content)).toEqual(['SECOND_ANSWER']);
    expect(s.uncollected('om_turn_2')).toEqual([]);
    expect(s.pastes('second task: summarize the failures')).toBe(1);
  }, 120_000);

  it('keeps an input that Doubao queued behind its own work attributable until Doubao sends it', async () => {
    const s = startScenario();
    await finishFirstTurn(s);
    // Doubao looks idle, but the Enter finds it busy with work that is not a
    // botmux turn: the input waits in Doubao's own send queue.
    s.control('background-busy');
    s.sendMessage('om_turn_2', 'second task: summarize the failures');
    await s.waitUntil(() => s.pastes('second task: summarize the failures') === 1, 'turn 2 pasted');
    await pause(30_000);
    expect(s.assignmentText()).not.toContain('second task');
    expect(s.uncollected('om_turn_2')).toEqual([]);

    s.clear('background-busy');
    await s.waitUntil(() => s.assignmentText().includes('second task'), 'turn 2 native start', 15_000);
    s.control('finish-2', 'SECOND_ANSWER');
    await s.waitUntil(() => s.finals('om_turn_2').length > 0, 'turn 2 reply forwarded');
    await pause(1_500);
    expect(s.finals('om_turn_2').map(msg => (msg as { content: string }).content)).toEqual(['SECOND_ANSWER']);
    expect(s.notices('om_turn_2')).toEqual([]);
    expect(s.pastes('second task: summarize the failures')).toBe(1);
  }, 120_000);

  it('stops holding once the queued input is removed in Doubao, reports it once and keeps the session usable', async () => {
    const s = startScenario();
    await finishFirstTurn(s);
    s.control('background-busy');
    s.sendMessage('om_turn_2', 'second task: summarize the failures');
    await s.waitUntil(() => s.pastes('second task: summarize the failures') === 1, 'turn 2 pasted');
    await pause(5_000);
    // The user removes it from Doubao's queue; Doubao then goes idle without sending it.
    s.control('drop-queue');
    s.clear('background-busy');
    await s.waitUntil(() => s.uncollected('om_turn_2').length > 0, 'uncollected notice once the hold ends', 40_000);
    expect(s.assignmentText()).not.toContain('second task');

    s.clear('drop-queue');
    s.sendMessage('om_turn_3', 'third task: list the owners');
    await s.waitUntil(() => s.assignmentText().includes('third task'), 'next input delivered', 20_000);
    s.control('finish-2', 'THIRD_ANSWER');
    await s.waitUntil(() => s.finals('om_turn_3').length > 0, 'next reply forwarded');
    await pause(1_500);
    expect(s.uncollected('om_turn_2')).toHaveLength(1);
    expect(s.finals('om_turn_2')).toEqual([]);
    expect(s.finals('om_turn_3').map(msg => (msg as { content: string }).content)).toEqual(['THIRD_ANSWER']);
    expect(s.pastes('second task: summarize the failures')).toBe(1);
  }, 120_000);

  it('keeps a draft Doubao did not submit for a manual Enter, holding later input instead of re-pasting', async () => {
    const s = startScenario();
    await finishFirstTurn(s);
    // Doubao's composer refuses the Enter (canSubmit=false): the draft stays.
    s.control('drop-enter');
    s.sendMessage('om_turn_2', 'second task: summarize the failures');
    await s.waitUntil(() => s.logs.some(line => line.includes('Quarantined input delivery')), 'unconfirmed submit quarantined', 30_000);
    // A follow-up must not be pasted onto the parked draft.
    s.sendMessage('om_turn_3', 'third task: list the owners');
    // The user is told once that the submit was not confirmed.
    // Two 20s receipt rechecks precede the single warning.
    await s.waitUntil(() => s.notices('om_turn_2').length > 0, 'unconfirmed-submit notice', 75_000);
    await pause(5_000);
    expect(s.pastes('third task: list the owners')).toBe(0);
    expect(s.uncollected('om_turn_2')).toEqual([]);

    // Well after every lease, the user submits the parked draft by hand.
    s.clear('drop-enter');
    s.pressEnterInTerminal();
    await s.waitUntil(() => s.assignmentText().includes('second task'), 'manual submit reaches Doubao', 10_000);
    s.control('finish-2', 'SECOND_ANSWER');
    await s.waitUntil(() => s.finals('om_turn_2').length > 0, 'late reply forwarded');
    // The held follow-up goes out only after that turn, as its own input.
    await s.waitUntil(() => s.assignmentText().includes('third task'), 'held follow-up delivered', 20_000);
    s.control('finish-3', 'THIRD_ANSWER');
    await s.waitUntil(() => s.finals('om_turn_3').length > 0, 'follow-up reply forwarded');
    await pause(1_500);
    expect(s.finals('om_turn_2').map(msg => (msg as { content: string }).content)).toEqual(['SECOND_ANSWER']);
    expect(s.finals('om_turn_3').map(msg => (msg as { content: string }).content)).toEqual(['THIRD_ANSWER']);
    expect(s.pastes('second task: summarize the failures')).toBe(1);
    expect(s.pastes('third task: list the owners')).toBe(1);
    expect(s.assignmentText().split('third task').length - 1).toBe(1);
  }, 180_000);

  it.each([
    ['an ordinary turn', undefined],
    ['a durable delivery attempt', 1],
  ] as const)('stops holding later input once the parked draft of %s is cleared by hand', async (_kind, dispatchAttempt) => {
    const s = startScenario();
    await finishFirstTurn(s);
    s.control('drop-enter');
    s.sendMessage('om_turn_2', 'second task: summarize the failures', dispatchAttempt);
    await s.waitUntil(() => s.logs.some(line => line.includes('Quarantined input delivery')), 'unconfirmed submit quarantined', 30_000);
    // The user deletes the draft in the Web terminal instead of submitting it.
    s.clear('drop-enter');
    for (let i = 0; i < 20 && !s.pane().includes('Ask Doubao to do anything'); i++) {
      s.pressInTerminal(...Array(120).fill('BSpace'));
      await pause(300);
    }
    s.sendMessage('om_turn_3', 'third task: list the owners');
    await s.waitUntil(() => s.assignmentText().includes('third task'), 'held follow-up delivered after the draft is gone', 90_000);
    s.control('finish-2', 'THIRD_ANSWER');
    await s.waitUntil(() => s.finals('om_turn_3').length > 0, 'follow-up reply forwarded');
    await pause(1_500);
    expect(s.finals('om_turn_3').map(msg => (msg as { content: string }).content)).toEqual(['THIRD_ANSWER']);
    expect(s.finals('om_turn_2')).toEqual([]);
    // An ordinary turn is told once that it was not submitted (a durable
    // attempt settles through its receiver instead); never re-pasted.
    expect(s.notices('om_turn_2')).toHaveLength(dispatchAttempt === undefined ? 1 : 0);
    expect(s.pastes('second task: summarize the failures')).toBe(1);
    expect(s.pastes('third task: list the owners')).toBe(1);
  }, 180_000);

  it('does not let a removed queued input park the next turn behind it', async () => {
    const s = startScenario();
    await finishFirstTurn(s);
    s.control('background-busy');
    s.sendMessage('om_turn_2', 'second task: summarize the failures');
    await s.waitUntil(() => s.pastes('second task: summarize the failures') === 1, 'turn 2 pasted');
    await pause(3_000);
    // Removed from Doubao's queue by hand; the other work then ends.
    s.control('drop-queue');
    await pause(600);
    s.clear('background-busy');
    await pause(1_000);
    s.clear('drop-queue');
    await pause(1_000);
    // Within 20s of Doubao going idle the next message comes. Its receipt
    // proves the removed input will never be sent, so its own start and
    // answer are not parked behind that dead head's lease.
    s.sendMessage('om_turn_3', 'third task: list the owners');
    await s.waitUntil(() => s.assignmentText().includes('third task'), 'turn 3 native start', 30_000);
    await pause(3_000);
    s.control('finish-2', 'THIRD_ANSWER');
    await s.waitUntil(() => s.finals('om_turn_3').length > 0, 'turn 3 reply forwarded promptly', 8_000);
    await pause(1_500);
    expect(s.finals('om_turn_3').map(msg => (msg as { content: string }).content)).toEqual(['THIRD_ANSWER']);
    expect(s.uncollected('om_turn_2')).toHaveLength(1);
    expect(s.uncollected('om_turn_3')).toEqual([]);
  }, 150_000);

  it('keeps a queued input attributable when a panel briefly covers Doubao\'s screen', async () => {
    const s = startScenario();
    await finishFirstTurn(s);
    s.control('background-busy');
    s.sendMessage('om_turn_2', 'second task: summarize the failures');
    await s.waitUntil(() => s.pastes('second task: summarize the failures') === 1, 'turn 2 pasted');
    await pause(3_000);
    // The user glances at Doubao's queue manager: footer, composer and queue
    // line are all covered for a moment, nothing is changed.
    s.control('panel');
    await pause(3_000);
    s.clear('panel');
    await pause(30_000);
    expect(s.uncollected('om_turn_2')).toEqual([]);
    s.clear('background-busy');
    await s.waitUntil(() => s.assignmentText().includes('second task'), 'turn 2 native start', 15_000);
    s.control('finish-2', 'SECOND_ANSWER');
    await s.waitUntil(() => s.finals('om_turn_2').length > 0, 'turn 2 reply forwarded');
    await pause(1_500);
    expect(s.finals('om_turn_2').map(msg => (msg as { content: string }).content)).toEqual(['SECOND_ANSWER']);
    expect(s.uncollected('om_turn_2')).toEqual([]);
  }, 150_000);

  it('collects a reply whose request row reaches trajectory.jsonl long before its assignment section', async () => {
    const s = startScenario();
    await finishFirstTurn(s);
    s.control('row-first', '15000');
    s.sendMessage('om_turn_2', 'second task: summarize the failures');
    await s.waitUntil(() => s.pastes('second task: summarize the failures') === 1, 'turn 2 pasted');
    // The answer is written while the section is still missing.
    await pause(4_000);
    s.control('finish-2', 'SECOND_ANSWER');
    await s.waitUntil(() => s.assignmentText().includes('second task'), 'turn 2 section', 30_000);
    await s.waitUntil(() => s.finals('om_turn_2').length > 0, 'turn 2 reply forwarded');
    await pause(1_500);
    expect(s.finals('om_turn_2').map(msg => (msg as { content: string }).content)).toEqual(['SECOND_ANSWER']);
    expect(s.uncollected('om_turn_2')).toEqual([]);
  }, 120_000);

  it('keeps a reply whose request row came first while Doubao went idle long before the section', async () => {
    const s = startScenario();
    await finishFirstTurn(s);
    s.control('row-first', '45000');
    s.sendMessage('om_turn_2', 'second task: summarize the failures');
    await s.waitUntil(() => s.pastes('second task: summarize the failures') === 1, 'turn 2 pasted');
    // Doubao answers within seconds and is idle well past the 20s lease.
    await pause(2_000);
    s.control('finish-2', 'SECOND_ANSWER');
    await s.waitUntil(() => s.assignmentText().includes('second task'), 'turn 2 section', 60_000);
    await s.waitUntil(() => s.finals('om_turn_2').length > 0, 'turn 2 reply forwarded');
    await pause(1_500);
    expect(s.finals('om_turn_2').map(msg => (msg as { content: string }).content)).toEqual(['SECOND_ANSWER']);
    expect(s.uncollected('om_turn_2')).toEqual([]);
  }, 150_000);

  it('keeps earlier work\'s answer away when the request row of the queued input lands a poll later', async () => {
    const s = startScenario();
    await finishFirstTurn(s);
    s.control('submit-delay', '1');
    s.control('row-after', '400');
    s.control('background-final', 'LOCAL_ANSWER_NOT_FOR_TURN_2');
    s.control('background-busy');
    s.sendMessage('om_turn_2', 'second task: summarize the failures');
    await s.waitUntil(() => s.pastes('second task: summarize the failures') === 1, 'turn 2 pasted');
    await pause(5_000);
    s.clear('background-busy');
    await s.waitUntil(() => s.assignmentText().includes('second task'), 'turn 2 native start', 15_000);
    await pause(1_500);
    s.control('finish-2', 'SECOND_ANSWER');
    await s.waitUntil(() => s.finals('om_turn_2').length > 0, 'turn 2 reply forwarded');
    await pause(1_500);
    expect(s.finals('om_turn_2').map(msg => (msg as { content: string }).content)).toEqual(['SECOND_ANSWER']);
  }, 120_000);

  it('keeps the answer of earlier work away from a queued input Doubao sends right after it', async () => {
    const s = startScenario();
    await finishFirstTurn(s);
    s.control('submit-delay', '1');
    s.control('background-final', 'LOCAL_ANSWER_NOT_FOR_TURN_2');
    s.control('background-busy');
    s.sendMessage('om_turn_2', 'second task: summarize the failures');
    await s.waitUntil(() => s.pastes('second task: summarize the failures') === 1, 'turn 2 pasted');
    await pause(5_000);
    s.clear('background-busy');
    await s.waitUntil(() => s.assignmentText().includes('second task'), 'turn 2 native start', 15_000);
    await pause(1_500);
    s.control('finish-2', 'SECOND_ANSWER');
    await s.waitUntil(() => s.finals('om_turn_2').length > 0, 'turn 2 reply forwarded');
    await pause(1_500);
    expect(s.finals('om_turn_2').map(msg => (msg as { content: string }).content)).toEqual(['SECOND_ANSWER']);
  }, 120_000);
});
