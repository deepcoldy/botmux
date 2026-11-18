/**
 * Cutting a turn that failed without output, end to end on the worker: a real
 * worker (pty backend, never the host tmux server) driving a fake Claude Code
 * that writes its transcript the way 2.1.322 did on 2026-11-16 when the
 * upstream answered every request with a 503 — the prompt, then the API-error
 * record and turn_duration, nothing else. The directive each message carries is
 * planned by the daemon's real planner from the failed-turn record the
 * daemon's real builder makes of the worker's terminal.
 *
 * Before: every further input stacked a new turn on the failed one; the CLI
 * kept "prompt → API Error" pairs and got "继续" without the original task.
 */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { planFailedTurnRewind } from '../src/core/failed-turn-rewind.js';
import { buildFailedTurnRecord } from '../src/services/failed-turn-retry.js';
import type { DaemonToWorker, FailedTurnRecord, WorkerToDaemon } from '../src/types.js';

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

async function waitUntil(check: () => boolean, logs: string[], timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child?.exitCode !== null || child?.signalCode !== null) throw new Error(`Worker exited\n${logs.join('')}`);
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error(`Timed out\n${logs.join('')}`);
}

type Row = Record<string, any>;
const HINT = '【决策看板 · 提示】巡检发现 1 项可以推进或关闭';

function startWorker(init: Partial<Extract<DaemonToWorker, { type: 'init' }>> = {}) {
  root = mkdtempSync(join(tmpdir(), 'botmux-failed-turn-rewind-'));
  const workDir = join(root, 'work');
  const dataDir = join(root, 'data');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const cliSessionId = 'deadbeef-1234-4678-9abc-def012345692';
  const projectDir = join(root, '.claude', 'projects', realpathSync(workDir).replace(/[^A-Za-z0-9-]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${cliSessionId}.jsonl`);
  const ago = new Date(Date.now() - 30 * 60_000).toISOString();
  writeFileSync(transcript, [
    { type: 'user', uuid: 'p0', timestamp: ago, message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a0', timestamp: ago, message: { id: 'm0', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] } },
    { type: 'system', subtype: 'turn_duration', uuid: 'd0', timestamp: ago },
  ].map(row => `${JSON.stringify(row)}\n`).join(''));
  const prompts = join(root, 'prompts.jsonl');
  const down = join(root, 'provider-down');
  const slowResume = join(root, 'slow-resume');
  const dieOnResume = join(root, 'die-on-resume');
  writeFileSync(down, '');
  const fakeClaude = join(root, 'fake-claude');
  // Each launch (the first and every --resume) draws a prompt; each submitted
  // prompt is recorded, then answered by a 503 while `provider-down` exists.
  writeFileSync(fakeClaude, `#!/usr/bin/env node
import('node:fs').then(fs => {
const T = ${JSON.stringify(transcript)};
const put = row => fs.appendFileSync(T, JSON.stringify({ timestamp: new Date().toISOString(), uuid: Math.random().toString(36).slice(2), ...row }) + '\\n');
fs.appendFileSync(${JSON.stringify(prompts)}, JSON.stringify({ launch: process.argv.slice(2) }) + '\\n');
let running;
// A resumed launch can take a while to draw its prompt (a long transcript).
const slow = process.argv.includes('--resume') && fs.existsSync(${JSON.stringify(slowResume)});
setTimeout(() => process.stdout.write('❯ '), slow ? 4000 : 0);
// A resumed launch that crashes before it draws its prompt.
if (process.argv.includes('--resume') && fs.existsSync(${JSON.stringify(dieOnResume)})) setTimeout(() => process.exit(1), 1500);
// Claude Code 2.1.326 writes its cost state when it exits, even a resumed
// CLI that never got an input: no uuid, outside the conversation.
for (const signal of ['SIGHUP', 'SIGTERM']) process.on(signal, () => {
  fs.appendFileSync(T, JSON.stringify({ type: 'cost-state', sessionId: 'fake', totalCostUsd: 0 }) + '\\n');
  process.exit(0);
});
// Without raw mode the pty turns Ctrl-C into SIGINT (Claude reads it raw).
process.on('SIGINT', () => {
  fs.appendFileSync(${JSON.stringify(prompts)}, JSON.stringify({ sigint: true }) + '\\n');
  interrupt();
});
let typed = '';
// Ctrl-C / Esc while a turn runs: Claude cancels it and records the stop.
function interrupt() {
  if (!running) return;
  clearTimeout(running);
  running = undefined;
  fs.appendFileSync(${JSON.stringify(prompts)}, JSON.stringify({ interrupt: true }) + '\\n');
  put({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  process.stdout.write('\\r\\n❯ ');
}
process.stdin.on('data', chunk => {
  const raw = chunk.toString();
  if ((raw === '\\x03' || raw === '\\x1b') && running) { interrupt(); return; }
  typed += raw;
  if (!/[\\r\\n]$/.test(typed)) return;
  if (typed.includes('\\x1b[200~') && !typed.includes('\\x1b[201~')) return;
  const prompt = typed.replace(/\\x1b\\[20[01]~/g, '').trim();
  typed = '';
  fs.appendFileSync(${JSON.stringify(prompts)}, JSON.stringify({ prompt }) + '\\n');
  // A slash command (a bot's startup command): recorded as Claude Code does,
  // a user record of its own and its local output, no model turn.
  const command = /^(\\/[\\w:.-]+)(?:\\s+(.*))?$/.exec(prompt);
  if (command) {
    const record = () => {
      put({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>The command below was run directly in Claude Code</local-command-caveat>' } });
      put({ type: 'user', message: { role: 'user', content: '<command-name>' + command[1] + '</command-name>\\n<command-args>' + (command[2] || '') + '</command-args>' } });
      put({ type: 'user', message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' } });
      process.stdout.write('\\r\\n❯ ');
    };
    record();
    return;
  }
  put({ type: 'user', message: { role: 'user', content: prompt } });
  // 2.1.31x+ copies each request body into a blob record: message.role user,
  // no uuid, no timestamp.
  fs.appendFileSync(T, JSON.stringify({ type: 'api-request-blob', hash: 'h' + Date.now(),
    message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }] } }) + '\\n');
  const failing = fs.existsSync(${JSON.stringify(down)});
  const turnMs = 300;
  running = setTimeout(() => {
    running = undefined;
    if (failing) {
      put({ type: 'assistant', isApiErrorMessage: true, error: 'server_error', apiErrorStatus: 503,
        message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence',
          content: [{ type: 'text', text: 'API Error: 503 no eligible upstream account is currently available' }] } });
    } else {
      put({ type: 'assistant', message: { id: 'm' + Date.now(), role: 'assistant', model: 'claude-test', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done: ' + prompt.split('\\n')[0] }] } });
    }
    put({ type: 'system', subtype: 'turn_duration', durationMs: turnMs });
    process.stdout.write('\\r\\n❯ ');
  }, turnMs);
});
});
`);
  chmodSync(fakeClaude, 0o755);
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  // A fixed sid would let a concurrent run of this file stop this Claude's
  // session scope by name (see claude-api-error-after-prompt.integration).
  const sid = `sid-failed-turn-rewind-${randomUUID()}`;
  child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env, HOME: root, SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sid, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', raw => {
    messages.push(raw as WorkerToDaemon);
    const type = (raw as { type?: string }).type;
    if (type === 'error' || type === 'worker_error') logs.push(`[ipc ${type}] ${JSON.stringify(raw)}\n`);
  });
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({
    type: 'init', sessionId: sid, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: workDir, cliId: 'claude-code', cliPathOverride: fakeClaude, cliSessionId,
    backendType: 'pty', prompt: '', resume: true, larkAppId: 'app_test', larkAppSecret: 'test-only', locale: 'zh',
    ...init,
  } satisfies DaemonToWorker);
  const rows = (): Row[] => readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const received = () => readFileSync(prompts, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(entry => 'prompt' in entry).map(entry => entry.prompt as string);
  const launches = () => readFileSync(prompts, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(entry => 'launch' in entry).length;
  const events = () => readFileSync(prompts, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const sigints = () => events().filter(entry => 'sigint' in entry).length;
  /** What the fake CLI saw, in order: prompts and interrupts. */
  const timeline = () => events().filter(entry => 'prompt' in entry || 'interrupt' in entry)
    .map(entry => ('prompt' in entry ? flat(entry.prompt as string) : '<interrupt>'));
  return { messages, logs, rows, received, launches, sigints, timeline,
    slowResume: () => writeFileSync(slowResume, ''), dieOnResume: () => writeFileSync(dieOnResume, ''),
    providerUp: () => { if (existsSync(down)) unlinkSync(down); } };
}

type Worker = ReturnType<typeof startWorker>;
const terminalOf = (w: Worker, turnId: string) => w.messages.find((msg): msg is Extract<WorkerToDaemon, { type: 'turn_terminal' }> =>
  msg.type === 'turn_terminal' && msg.turnId === turnId);

/** One input as the daemon sends it: its directive planned from the record of
 *  the last failure. Resolves with that input's terminal. */
async function send(w: Worker, turnId: string, content: string, failed: FailedTurnRecord | undefined) {
  await waitUntil(() => w.messages.some(msg => msg.type === 'prompt_ready'), w.logs);
  const failedTurnRewind = planFailedTurnRewind({ record: failed, turnId, content, mode: 'merge' });
  child!.send({ type: 'message', content, turnId, ...(failedTurnRewind ? { failedTurnRewind } : {}) } satisfies DaemonToWorker);
  // The turn's terminal, then the CLI back at its prompt (Claude Code redraws
  // it as the turn ends; the next input arrives after that).
  const terminalIndex = () => w.messages.findIndex(msg => msg.type === 'turn_terminal' && msg.turnId === turnId);
  await waitUntil(() => terminalIndex() >= 0
    && w.messages.slice(terminalIndex()).some(msg => msg.type === 'prompt_ready'), w.logs, 60_000);
  const terminal = terminalOf(w, turnId)!;
  const writtenAs = failedTurnRewind && w.messages.some(msg => msg.type === 'failed_turn_rewind' && msg.turnId === turnId && msg.outcome === 'rewound')
    ? failedTurnRewind.content : content;
  const record = terminal.status === 'failed'
    ? buildFailedTurnRecord({ ...terminal, status: 'failed' }, { cliInput: writtenAs })
    : undefined;
  return { terminal, record, failedTurnRewind };
}

const userTurns = (w: Worker) => w.rows().filter(row => row.type === 'user').map(row => (
  typeof row.message.content === 'string'
    ? row.message.content
    : (row.message.content as Array<{ text?: string }>).map(block => block.text ?? '').join('')));
const apiErrors = (w: Worker) => w.rows().filter(row => row.isApiErrorMessage === true).length;
const REFRESH = /<botmux_skills_refresh>[\s\S]*?<\/botmux_skills_refresh>/g;
/** Whitespace-insensitive, without the skill catalog refresh the worker
 *  appends to the first input after each launch with --resume. */
const flat = (text: string) => text.replace(REFRESH, ' ').replace(/\s+/g, ' ').trim();
const refreshes = (texts: string[]) => texts.join('\n').match(REFRESH)?.length ?? 0;

describe('a turn that failed without output is cut before the next input (real worker, fake Claude Code)', () => {
  it('keeps at most the latest failure, hands the CLI the failed input with each new one, and continues once the provider is back', async () => {
    const w = startWorker();

    // The batch prompt meets the outage.
    const first = await send(w, 'board:app:hint-1', HINT, undefined);
    expect(first.terminal).toMatchObject({ status: 'failed', errorCode: 'provider_server_error', retryable: true, directFailure: true });
    expect(userTurns(w).map(flat)).toEqual(['hi', flat(HINT)]);

    // A connector's bare "继续": the failed turn is cut and both go in as one.
    const second = await send(w, 'trg_1', '继续', first.record);
    expect(second.failedTurnRewind).toMatchObject({ mode: 'merge', failedTurnId: 'board:app:hint-1' });
    expect(w.messages).toContainEqual(expect.objectContaining({ type: 'failed_turn_rewind', turnId: 'trg_1', outcome: 'rewound' }));
    expect(w.received().map(flat)).toEqual([flat(HINT), flat(`${HINT}\n\n继续`)]);
    expect(second.terminal).toMatchObject({ status: 'failed', directFailure: true });
    // One failed turn in the session, not two stacked ones.
    expect(userTurns(w).map(flat)).toEqual(['hi', flat(`${HINT}\n\n继续`)]);
    expect(apiErrors(w)).toBe(1);
    // The catalog refresh written with the cut turn went in again with it.
    expect(refreshes(userTurns(w))).toBe(1);

    // And again: still one failure, and the same "继续" is not appended twice.
    const third = await send(w, 'trg_2', '继续', second.record);
    expect(w.messages).toContainEqual(expect.objectContaining({ type: 'failed_turn_rewind', turnId: 'trg_2', outcome: 'rewound' }));
    expect(third.terminal).toMatchObject({ status: 'failed', directFailure: true });
    expect(userTurns(w).map(flat)).toEqual(['hi', flat(`${HINT}\n\n继续`)]);
    expect(apiErrors(w)).toBe(1);

    // The provider is back: the original task runs, and no failure is left.
    w.providerUp();
    const fourth = await send(w, 'trg_3', '继续', third.record);
    expect(fourth.terminal).toMatchObject({ status: 'completed' });
    expect(w.messages).toContainEqual(expect.objectContaining({ type: 'final_output', turnId: 'trg_3' }));
    expect(userTurns(w).map(flat)).toEqual(['hi', flat(`${HINT}\n\n继续`)]);
    expect(apiErrors(w)).toBe(0);
    expect(refreshes(userTurns(w))).toBe(1);
    // Each cut resumed the same conversation: one first launch + three resumes.
    expect(w.launches()).toBe(4);
  }, 180_000);

  it('leaves a failed turn that made progress, and any later input, as it was', async () => {
    const w = startWorker();
    const first = await send(w, 'board:app:hint-1', HINT, undefined);
    // Pretend the turn had called a tool before failing: the worker's own
    // reading of the transcript decides, whatever the record claims.
    const rows = w.rows();
    const errorAt = rows.findIndex(row => row.isApiErrorMessage === true);
    rows.splice(errorAt, 0, { type: 'assistant', uuid: 'tool', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], stop_reason: 'tool_use' } });
    const transcriptPath = join(root!, '.claude', 'projects');
    expect(existsSync(transcriptPath)).toBe(true);
    const file = (await import('node:fs')).readdirSync(transcriptPath, { recursive: true, withFileTypes: false })
      .map(String).find(name => name.endsWith('.jsonl'))!;
    writeFileSync(join(transcriptPath, file), rows.map(row => `${JSON.stringify(row)}\n`).join(''));

    const second = await send(w, 'trg_1', '继续', first.record);
    expect(w.messages).toContainEqual(expect.objectContaining({ type: 'failed_turn_rewind', turnId: 'trg_1', outcome: 'declined' }));
    expect(w.received().map(flat)).toEqual([flat(HINT), '继续']);
    expect(userTurns(w).map(flat)).toEqual(['hi', flat(HINT), '继续']);
    expect(w.launches()).toBe(1);
    expect(second.terminal.status).toBe('failed');
  }, 120_000);
  it('a bot with startup commands: a stop after the resumed CLI ran them still puts the failed turn back', async () => {
    const w = startWorker({ startupCommands: ['/effort high'] });
    const first = await send(w, 'board:app:hint-1', HINT, undefined);
    const commandRecords = () => userTurns(w).filter(text => text.startsWith('<command-name>/effort')).length;
    const before = commandRecords();
    const failedTurnRewind = planFailedTurnRewind({ record: first.record, turnId: 'trg_1', content: '继续', mode: 'merge' });
    child!.send({ type: 'message', content: '继续', turnId: 'trg_1', failedTurnRewind } satisfies DaemonToWorker);
    // Claude Code records the command the moment it runs: a turn of its own
    // after the cut, before the message reaches the CLI.
    await waitUntil(() => commandRecords() > before, w.logs);
    child!.send({ type: 'term_action', key: 'ctrlc' } satisfies DaemonToWorker);
    child!.send({ type: 'message', content: '还在吗', turnId: 'trg_2' } satisfies DaemonToWorker);
    w.providerUp();
    await waitUntil(() => !!terminalOf(w, 'trg_2'), w.logs, 90_000);
    expect(terminalOf(w, 'trg_1')).toMatchObject({ status: 'cancelled', errorCode: 'stopped_before_start' });
    expect(w.messages).toContainEqual(expect.objectContaining({
      type: 'failed_turn_rewind', turnId: 'trg_1', outcome: 'declined', reason: expect.stringMatching(/stopped after the cut; cut restored/),
    }));
    expect(w.received().filter(text => !text.startsWith('/')).map(flat)).toEqual([flat(HINT), '还在吗']);
    expect(userTurns(w).filter(text => !text.startsWith('<')).map(flat)).toEqual(['hi', flat(HINT), '还在吗']);
    expect(apiErrors(w)).toBe(1);
  }, 180_000);

  it('an at-most-once input dropped when the resumed CLI dies before it is written: the cut goes back, the daemon hears it', async () => {
    const w = startWorker();
    const first = await send(w, 'board:app:hint-1', HINT, undefined);
    w.slowResume();
    w.dieOnResume();
    const failedTurnRewind = planFailedTurnRewind({ record: first.record, turnId: 'bmx-recovery-retry-1', content: HINT, mode: 'resend' });
    // A recovery card's retry: never replayed once its CLI exited.
    child!.send({ type: 'message', content: HINT, turnId: 'bmx-recovery-retry-1', atMostOnce: true, failedTurnRewind } satisfies DaemonToWorker);
    await waitUntil(() => w.messages.some(msg => msg.type === 'failed_turn_rewind' && msg.turnId === 'bmx-recovery-retry-1'), w.logs, 60_000);
    expect(w.messages).toContainEqual(expect.objectContaining({
      type: 'failed_turn_rewind', turnId: 'bmx-recovery-retry-1', outcome: 'declined', reason: expect.stringMatching(/dropped on a CLI exit; cut restored/),
    }));
    expect(w.received().map(flat)).toEqual([flat(HINT)]);
    expect(userTurns(w).map(flat)).toEqual(['hi', flat(HINT)]);
    expect(apiErrors(w)).toBe(1);
  }, 120_000);

  it('a stop pressed while the CLI restarts for the cut: the message never runs, the failed turn stays in the conversation, the next input runs', async () => {
    // Before the cut: the message never runs and the failed turn stays.
    {
      const w = startWorker();
      const first = await send(w, 'board:app:hint-1', HINT, undefined);
      w.slowResume();
      const failedTurnRewind = planFailedTurnRewind({ record: first.record, turnId: 'trg_1', content: '继续', mode: 'merge' });
      // Stop right as the message arrives, before the old CLI's exit is proven.
      child!.send({ type: 'message', content: '继续', turnId: 'trg_1', failedTurnRewind } satisfies DaemonToWorker);
      child!.send({ type: 'term_action', key: 'ctrlc' } satisfies DaemonToWorker);
      await waitUntil(() => !!terminalOf(w, 'trg_1'), w.logs, 60_000);
      expect(terminalOf(w, 'trg_1')).toMatchObject({ status: 'cancelled', errorCode: 'stopped_before_start' });
      expect(w.messages).toContainEqual(expect.objectContaining({ type: 'failed_turn_rewind', turnId: 'trg_1', outcome: 'declined' }));
      expect(w.received().map(flat)).toEqual([flat(HINT)]);
      expect(userTurns(w).map(flat)).toEqual(['hi', flat(HINT)]);
      expect(w.sigints()).toBe(0);
      if (child && child.exitCode === null) {
        const stopped = new Promise<void>(done => child!.once('exit', () => done()));
        child.kill('SIGKILL');
        await stopped;
      }
      rmSync(root!, { recursive: true, force: true });
    }

    // After the cut, with the next input already queued behind it: the
    // message is not written either — nothing of it can run, not even a tool
    // call it would make at once — and the cut is put back once the resumed
    // CLI is gone (it writes its cost state on the way out). The queued input
    // runs after, on the conversation as it was before the message came.
    const w = startWorker();
    const first = await send(w, 'board:app:hint-1', HINT, undefined);
    w.slowResume();
    const failedTurnRewind = planFailedTurnRewind({ record: first.record, turnId: 'trg_1', content: '继续', mode: 'merge' });
    child!.send({ type: 'message', content: '继续', turnId: 'trg_1', failedTurnRewind } satisfies DaemonToWorker);
    await waitUntil(() => userTurns(w).length === 1, w.logs);
    // The daemon sends the next input plainly while the first is in flight.
    child!.send({ type: 'message', content: '还在吗', turnId: 'trg_2' } satisfies DaemonToWorker);
    w.providerUp();
    child!.send({ type: 'term_action', key: 'ctrlc' } satisfies DaemonToWorker);
    await waitUntil(() => !!terminalOf(w, 'trg_2'), w.logs, 90_000);
    expect(terminalOf(w, 'trg_1')).toMatchObject({ status: 'cancelled', errorCode: 'stopped_before_start' });
    expect(w.messages).toContainEqual(expect.objectContaining({ type: 'failed_turn_rewind', turnId: 'trg_1', outcome: 'declined' }));
    expect(w.timeline()).toEqual([flat(HINT), '还在吗']);
    expect(w.sigints()).toBe(0);
    expect(userTurns(w).map(flat)).toEqual(['hi', flat(HINT), '还在吗']);
    // The failed turn came back with its error: the daemon's record of it
    // still holds, and a retry finds it.
    expect(apiErrors(w)).toBe(1);
    expect(terminalOf(w, 'trg_2')).toMatchObject({ status: 'completed' });
    // The first launch, the resume after the cut, the resume after the restore.
    expect(w.launches()).toBe(3);
  }, 240_000);
});
