import type { ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { setDefaultLocale, t } from '../src/i18n/index.js';
import { lookupCliDisplayName } from '../src/adapters/cli/display-names.js';
import { restartInterruptionNote, restartInterruptionNotice } from '../src/services/restart-interruption.js';

// The real worker resumes a fake Pi whose previous process died mid-turn (the
// 10-21 tmux server loss): the resumed CLI must receive the restart note and
// the daemon one user_notify. pty backend only — never the host tmux server.

// The workers below run with locale zh; expectations come from the same
// i18n keys and builders, so they pin what a message says, not its wording.
setDefaultLocale('zh');
const TURN_NOTE = restartInterruptionNote({ turnOpen: true, tasks: [] });
const piNotice = (noteDelivered: boolean) => restartInterruptionNotice(
  { turnOpen: true, tasks: [] }, { cliName: lookupCliDisplayName('pi') ?? 'CLI', noteDelivered },
);

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

async function waitUntil(check: () => boolean, logs: string[], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child?.exitCode !== null || child?.signalCode !== null) throw new Error(`Worker exited\n${logs.join('')}`);
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error(`Timed out\n${logs.join('')}`);
}

const PASTE_END = '\x1b[201~';
const OPEN_TURN_ROWS = [
  { role: 'user', content: [{ type: 'text', text: 'review PR 2048' }] },
  { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-0', name: 'read', arguments: { path: 'src/a.ts' } }] },
];

function setup(name: string, opts: { recordTurns: boolean; history?: object[] }) {
  root = mkdtempSync(join(tmpdir(), `botmux-${name}-`));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const cliSessionId = 'deadbeef-1234-4678-9abc-def012345680';
  const sessionsDir = join(root, '.pi', 'agent', 'sessions', dataDir.replace(/\//g, '--'));
  mkdirSync(sessionsDir, { recursive: true });
  const transcript = join(sessionsDir, `20261020_${cliSessionId}.jsonl`);
  writeFileSync(transcript, (opts.history ?? []).map(message => JSON.stringify({
    type: 'message', timestamp: '2026-10-20T20:40:00.000Z', message,
  })).map(line => `${line}\n`).join(''));
  const inputLog = join(root, 'input.log');
  const crashFlag = join(root, 'crash');
  const busyFlag = join(root, 'busy');
  const fakePi = join(root, 'fake-pi');
  // Records every byte typed into it (one `--- start` line per process). With
  // recordTurns, a submitted line is written as Pi writes a turn cut off mid
  // tool call: the user record and an assistant `toolUse`, no final.
  // Dynamic import: runs as CommonJS or ESM, whatever package.json sits above
  // the temp dir.
  writeFileSync(fakePi, `#!/usr/bin/env node
import('node:fs').then(fs => {
fs.appendFileSync(${JSON.stringify(inputLog)}, '--- start\\n');
process.stdout.write('pi> ');
let typed = '';
process.stdin.on('data', chunk => {
  const text = chunk.toString();
  fs.appendFileSync(${JSON.stringify(inputLog)}, text);
  typed += text;
  if (!${opts.recordTurns} || !typed.includes(${JSON.stringify(PASTE_END)}) || !/[\\r\\n]$/.test(typed)) return;
  const prompt = typed.replace(/\\x1b\\[20[01]~/g, '').trim();
  typed = '';
  const now = new Date().toISOString();
  const row = message => JSON.stringify({ type: 'message', timestamp: now, message });
  fs.appendFileSync(${JSON.stringify(transcript)}, [
    row({ role: 'user', content: [{ type: 'text', text: prompt }] }),
    row({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-' + Date.now(), name: 'read', arguments: { path: 'src/a.ts' } }] }),
  ].join('\\n') + '\\n');
});
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(crashFlag)})) { fs.unlinkSync(${JSON.stringify(crashFlag)}); process.exit(1); }
  if (fs.existsSync(${JSON.stringify(busyFlag)})) process.stdout.write('Working...\\n');
}, 20);
});
`);
  chmodSync(fakePi, 0o755);
  /** Input the n-th CLI process (0-based) received; complete once its paste ended. */
  const processInput = (n: number): string | undefined => {
    const processes = existsSync(inputLog) ? readFileSync(inputLog, 'utf8').split('--- start\n').slice(1) : [];
    return processes[n];
  };
  // Per test: a worker's owned CLI scope is named after the session, and a
  // previous test's teardown must not reach this test's CLI.
  const sid = `sid-${name}`;
  const unsentJournal = join(dataDir, 'turn-marks', `${sid}.unsent.json`);
  return { dataDir, cliSessionId, transcript, crashFlag, busyFlag, fakePi, processInput, sid, unsentJournal };
}

function startWorker(env: ReturnType<typeof setup>, init: Partial<Extract<DaemonToWorker, { type: 'init' }>> = {}) {
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env, HOME: root!, SESSION_DATA_DIR: env.dataDir,
      BOTMUX_SESSION_ID: env.sid, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({
    type: 'init', sessionId: env.sid, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: env.dataDir, cliId: 'pi', cliPathOverride: env.fakePi, cliSessionId: env.cliSessionId,
    backendType: 'pty', prompt: '', larkAppId: 'app_test', larkAppSecret: 'test-only', locale: 'zh', ...init,
  } satisfies DaemonToWorker);
  const notices = () => messages.filter((msg): msg is Extract<WorkerToDaemon, { type: 'user_notify' }> => msg.type === 'user_notify');
  return { messages, logs, notices };
}

async function crashAndRestart(env: ReturnType<typeof setup>, w: ReturnType<typeof startWorker>): Promise<void> {
  writeFileSync(env.crashFlag, '1');
  await waitUntil(() => w.messages.some(msg => msg.type === 'claude_exit'), w.logs);
  child!.send({ type: 'restart', reason: 'cli_crash' } satisfies DaemonToWorker);
}

describe('worker restart interruption notice (real worker, fake Pi)', () => {
  it('does not re-run a turn the CLI already started; hands it the note under that turn instead (#1650 on 10-21)', async () => {
    // The CLI wrote the message's user record and was working on it (mid tool
    // call) when the pane went away, twice.
    const env = setup('restart-started-turn', { recordTurns: true });
    const w = startWorker(env);
    await waitUntil(() => w.messages.some(msg => msg.type === 'prompt_ready'), w.logs);
    child!.send({ type: 'message', content: 'review PR 1650', turnId: 'om_turn1' } satisfies DaemonToWorker);
    await waitUntil(() => readFileSync(env.transcript, 'utf8').includes('review PR 1650'), w.logs);
    // Let the bridge read that record back.
    await new Promise(done => setTimeout(done, 1_500));
    await crashAndRestart(env, w);

    await waitUntil(() => !!env.processInput(1)?.includes(PASTE_END), w.logs);
    expect(env.processInput(1)).toContain(TURN_NOTE);
    expect(env.processInput(1)).not.toContain('review PR 1650');
    expect(w.notices()).toHaveLength(1);
    expect(w.notices()[0]).toMatchObject({ turnId: 'om_turn1' });
    expect(w.notices()[0].message).toBe(piNotice(true));
  }, 60_000);

  it('still re-delivers a started turn when the restart falls back to a fresh session', async () => {
    const env = setup('restart-started-fresh', { recordTurns: true });
    const w = startWorker(env);
    await waitUntil(() => w.messages.some(msg => msg.type === 'prompt_ready'), w.logs);
    child!.send({ type: 'message', content: 'review PR 1650', turnId: 'om_turn1' } satisfies DaemonToWorker);
    await waitUntil(() => readFileSync(env.transcript, 'utf8').includes('review PR 1650'), w.logs);
    await new Promise(done => setTimeout(done, 1_500));
    await crashAndRestart(env, w);
    // The resumed CLI dies before reaching its prompt: the next restart is the
    // second in a row and starts a fresh session, which never saw the message.
    const spawns = () => (w.logs.join('').match(/Spawning fresh CLI/g) ?? []).length;
    await waitUntil(() => spawns() >= 2, w.logs);
    writeFileSync(env.crashFlag, '1');
    await waitUntil(() => w.messages.filter(msg => msg.type === 'claude_exit').length >= 2, w.logs);
    child!.send({ type: 'restart', reason: 'cli_crash' } satisfies DaemonToWorker);
    await waitUntil(() => w.logs.join('').includes('Resume fallback: dropping --resume'), w.logs);
    await waitUntil(() => !!env.processInput(2)?.includes(PASTE_END), w.logs);
    expect(env.processInput(2)).toContain('review PR 1650');
  }, 60_000);

  it('once a resumed CLI is up on that turn, a later fresh fallback does not re-deliver it', async () => {
    const env = setup('restart-started-settled', { recordTurns: true });
    const w = startWorker(env);
    const promptReadies = () => w.messages.filter(msg => msg.type === 'prompt_ready').length;
    await waitUntil(() => promptReadies() >= 1, w.logs);
    child!.send({ type: 'message', content: 'review PR 1650', turnId: 'om_turn1' } satisfies DaemonToWorker);
    await waitUntil(() => readFileSync(env.transcript, 'utf8').includes('review PR 1650'), w.logs);
    await new Promise(done => setTimeout(done, 1_500));
    await crashAndRestart(env, w);
    // The resumed CLI reaches its prompt (it holds the turn and gets the note)…
    await waitUntil(() => promptReadies() >= 2 && !!env.processInput(1)?.includes(PASTE_END), w.logs);
    await new Promise(done => setTimeout(done, 1_500));
    // …then dies twice in a row, the second time before its prompt: the
    // fallback starts a fresh session.
    const exits = () => w.messages.filter(msg => msg.type === 'claude_exit').length;
    writeFileSync(env.crashFlag, '1');
    await waitUntil(() => exits() >= 2, w.logs);
    child!.send({ type: 'restart', reason: 'cli_crash' } satisfies DaemonToWorker);
    const spawns = () => (w.logs.join('').match(/Spawning fresh CLI/g) ?? []).length;
    await waitUntil(() => spawns() >= 3, w.logs);
    writeFileSync(env.crashFlag, '1');
    await waitUntil(() => exits() >= 3, w.logs);
    child!.send({ type: 'restart', reason: 'cli_crash' } satisfies DaemonToWorker);
    await waitUntil(() => w.logs.join('').includes('Resume fallback: dropping --resume'), w.logs);
    await waitUntil(() => promptReadies() >= 3 && env.processInput(3) !== undefined, w.logs);
    await new Promise(done => setTimeout(done, 1_500));
    expect(env.processInput(3)).not.toContain('review PR 1650');
  }, 90_000);

  it('replays an input the CLI died before recording, with the note in front of it', async () => {
    // History ends mid-turn; this worker reports that once (notice only), then
    // a new message is typed in and the CLI dies before writing its record.
    const env = setup('restart-note-replay', { recordTurns: false, history: OPEN_TURN_ROWS });
    const w = startWorker(env, { resume: true });
    await waitUntil(() => w.notices().length === 1 && w.messages.some(msg => msg.type === 'prompt_ready'), w.logs);
    child!.send({ type: 'message', content: 'review PR 2072', turnId: 'om_turn1' } satisfies DaemonToWorker);
    await waitUntil(() => !!env.processInput(0)?.includes(PASTE_END), w.logs);
    await crashAndRestart(env, w);

    await waitUntil(() => !!env.processInput(1)?.includes(PASTE_END), w.logs);
    const resumed = env.processInput(1)!;
    // The in-flight carry-over re-delivers the input, led by the note.
    expect(resumed.indexOf(TURN_NOTE)).toBeGreaterThanOrEqual(0);
    expect(resumed.indexOf(TURN_NOTE)).toBeLessThan(resumed.indexOf('review PR 2072'));
    expect(resumed.split(TURN_NOTE)).toHaveLength(2);
    expect(w.notices()).toHaveLength(2);
    expect(w.notices()[1]).toMatchObject({ turnId: 'om_turn1' });
    expect(w.notices()[1].message).toBe(piNotice(true));
  }, 60_000);

  it('hands the note in alone, under the last turn, when nothing is left to replay', async () => {
    // The previous process was mid-turn (its transcript ends on a tool call);
    // the last input it got was consumed, so nothing is carried over.
    const env = setup('restart-note-alone', { recordTurns: false, history: OPEN_TURN_ROWS });
    const w = startWorker(env, { resume: true });
    await waitUntil(() => w.messages.some(msg => msg.type === 'prompt_ready'), w.logs);
    // This worker's first resume already reported the open turn (notice only:
    // it had written nothing yet).
    await waitUntil(() => w.notices().length === 1, w.logs);
    expect(w.notices()[0].message).toBe(piNotice(false));
    const readyCount = () => w.messages.filter(msg => msg.type === 'prompt_ready').length;
    const before = readyCount();
    child!.send({ type: 'message', content: 'keep going', turnId: 'om_turn2' } satisfies DaemonToWorker);
    await waitUntil(() => !!env.processInput(0)?.includes(PASTE_END) && readyCount() > before, w.logs);
    await crashAndRestart(env, w);

    await waitUntil(() => !!env.processInput(1)?.includes(PASTE_END), w.logs);
    const resumed = env.processInput(1)!;
    expect(resumed).toContain(TURN_NOTE);
    expect(resumed).not.toContain('keep going');
    expect(w.notices()).toHaveLength(2);
    expect(w.notices()[1]).toMatchObject({ turnId: 'om_turn2' });
    expect(w.notices()[1].message).toBe(piNotice(true));
  }, 60_000);

  it('re-delivers an argv-baked first prompt the CLI died before starting (#1931 / #1841 / #2016 on 10-21)', async () => {
    // A message cold-starts the session; Pi takes it as a launch argument. The
    // pane is gone before Pi shows any sign of running it.
    const env = setup('restart-argv-prompt', { recordTurns: false });
    const w = startWorker(env, { resume: true, prompt: 'review PR 1931', turnId: 'om_cold' });
    await waitUntil(() => env.processInput(0) !== undefined && w.logs.join('').includes('Argv-baked first prompt'), w.logs);
    await crashAndRestart(env, w);

    await waitUntil(() => !!env.processInput(1)?.includes(PASTE_END), w.logs);
    expect(env.processInput(1)).toContain('review PR 1931');
    // Delivered, so nothing to report.
    expect(w.notices()).toHaveLength(0);
  }, 60_000);

  it('a message still queued when the daemon stops the worker reaches the next worker\'s CLI', async () => {
    const env = setup('restart-unsent', { recordTurns: false });
    writeFileSync(env.busyFlag, '1');
    const first = startWorker(env, { resume: true });
    await waitUntil(() => env.processInput(0) !== undefined, first.logs);
    // The CLI never reaches its prompt, so the message waits in the worker.
    child!.send({ type: 'message', content: 'check the deploy', turnId: 'om_queued' } satisfies DaemonToWorker);
    await new Promise(done => setTimeout(done, 500));
    expect(env.processInput(0)).not.toContain('check the deploy');
    const exited = new Promise<void>(done => child!.once('exit', () => done()));
    child!.kill('SIGTERM');
    await exited;
    expect(existsSync(env.unsentJournal)).toBe(true);

    rmSync(env.busyFlag, { force: true });
    const second = startWorker(env, { resume: true });
    await waitUntil(() => !!env.processInput(1)?.includes(PASTE_END), second.logs);
    expect(env.processInput(1)).toContain('check the deploy');
    // Written to the CLI: nothing is left for a later worker to report.
    await waitUntil(() => !existsSync(`${env.unsentJournal}.taken`), second.logs);
    expect(existsSync(env.unsentJournal)).toBe(false);
  }, 60_000);

  it('reports messages as unconfirmed when the worker delivering them died first', async () => {
    const env = setup('restart-unsent-unconfirmed', { recordTurns: false });
    writeFileSync(env.busyFlag, '1');
    const first = startWorker(env, { resume: true });
    await waitUntil(() => env.processInput(0) !== undefined, first.logs);
    child!.send({ type: 'message', content: 'check the deploy', turnId: 'om_queued' } satisfies DaemonToWorker);
    await new Promise(done => setTimeout(done, 500));
    let exited = new Promise<void>(done => child!.once('exit', () => done()));
    child!.kill('SIGTERM');
    await exited;
    // The next worker takes them back but is killed outright before its CLI is
    // ready to receive them.
    const second = startWorker(env, { resume: true });
    await waitUntil(() => env.processInput(1) !== undefined
      && existsSync(`${env.unsentJournal}.taken`), second.logs);
    exited = new Promise<void>(done => child!.once('exit', () => done()));
    child!.kill('SIGKILL');
    await exited;

    rmSync(env.busyFlag, { force: true });
    const third = startWorker(env, { resume: true });
    await waitUntil(() => third.notices().length > 0 && third.messages.some(msg => msg.type === 'prompt_ready'), third.logs);
    expect(third.notices()).toHaveLength(1);
    expect(third.notices()[0]).toMatchObject({ turnId: 'om_queued' });
    expect(third.notices()[0].message).toBe(t('worker.unsent_inputs_unconfirmed', { count: 1 }));
    await new Promise(done => setTimeout(done, 800));
    expect(env.processInput(2)).not.toContain('check the deploy');
  }, 90_000);

  it('reports a message saved too long ago as not delivered instead of typing it in', async () => {
    const env = setup('restart-unsent-expired', { recordTurns: false });
    mkdirSync(join(env.dataDir, 'turn-marks'), { recursive: true });
    writeFileSync(env.unsentJournal, JSON.stringify({
      version: 1, savedAtMs: Date.now() - 25 * 60 * 60 * 1000, inputs: [{ content: 'stale request', turnId: 'om_stale' }],
    }));
    const w = startWorker(env, { resume: true });
    await waitUntil(() => w.notices().length > 0 && w.messages.some(msg => msg.type === 'prompt_ready'), w.logs);
    expect(w.notices()[0]).toMatchObject({ turnId: 'om_stale' });
    expect(w.notices()[0].message).toBe(t('worker.unsent_inputs_expired', { count: 1 }));
    await new Promise(done => setTimeout(done, 800));
    expect(env.processInput(0)).not.toContain('stale request');
  }, 60_000);

  it('a restart after a finished turn says nothing', async () => {
    const env = setup('restart-quiet', {
      recordTurns: false,
      history: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'hello' }] },
      ],
    });
    const w = startWorker(env, { resume: true });
    await waitUntil(() => w.messages.some(msg => msg.type === 'prompt_ready'), w.logs);
    await new Promise(done => setTimeout(done, 800));
    expect(w.notices()).toHaveLength(0);
    expect(env.processInput(0)).not.toContain(TURN_NOTE);
  }, 60_000);
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** Claude Code 2.1.305 records (times relative to now) for a background CI
 *  wait launched and its turn ended; `killedMinutesAgo` adds the `killed` stop. */
function claudeBackgroundTaskRows(opts: { killedMinutesAgo?: number }): object[] {
  return [
    { type: 'user', uuid: 'p1', timestamp: minutesAgo(180), message: { role: 'user', content: 'watch CI' } },
    { type: 'assistant', uuid: 'a1', timestamp: minutesAgo(179), message: { role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'gh run watch 1', description: 'Wait for CI run 1 to complete', run_in_background: true } },
    ] } },
    { type: 'user', uuid: 'u1', timestamp: minutesAgo(179), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'running' }] },
      toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bqcj23cgb' } },
    { type: 'assistant', uuid: 'a2', timestamp: minutesAgo(178), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Waiting.' }] } },
    { type: 'system', subtype: 'turn_duration', timestamp: minutesAgo(178) },
    ...(opts.killedMinutesAgo !== undefined ? [{ type: 'queue-operation', operation: 'enqueue', timestamp: minutesAgo(opts.killedMinutesAgo), content:
      '<task-notification>\n<task-id>bqcj23cgb</task-id>\n<status>killed</status>\n<summary>Background command "Wait for CI run 1 to complete" was stopped</summary>\n</task-notification>' }] : []),
  ];
}

let claudeWorkers = 0;

function startClaudeWorker(rows: object[], opts: { recordTurns?: boolean } = {}) {
  root = mkdtempSync(join(tmpdir(), 'botmux-restart-claude-'));
  const sid = `sid-restart-claude-${++claudeWorkers}`;
  const workDir = join(root, 'work');
  const dataDir = join(root, 'data');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const cliSessionId = 'deadbeef-1234-4678-9abc-def012345681';
  const projectDir = join(root, '.claude', 'projects', realpathSync(workDir).replace(/[^A-Za-z0-9-]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${cliSessionId}.jsonl`);
  writeFileSync(transcript, rows.map(row => `${JSON.stringify(row)}\n`).join(''));
  const fakeClaude = join(root, 'fake-claude');
  const crashFlag = join(root, 'crash');
  const inputLog = join(root, 'input.log');
  // Logs what is typed (one `--- start` line per process). With recordTurns a
  // submitted line becomes the user record Claude Code writes, so the bridge
  // sees the turn start.
  writeFileSync(fakeClaude, `#!/usr/bin/env node
import('node:fs').then(fs => {
fs.appendFileSync(${JSON.stringify(inputLog)}, '--- start\\n');
process.stdout.write('❯ ');
let typed = '';
process.stdin.on('data', chunk => {
  const text = chunk.toString();
  fs.appendFileSync(${JSON.stringify(inputLog)}, text);
  typed += text;
  if (!${!!opts.recordTurns} || !/[\\r\\n]$/.test(typed)) return;
  // A multi-line message arrives as one bracketed paste.
  if (typed.includes('\\x1b[200~') && !typed.includes('\\x1b[201~')) return;
  const prompt = typed.replace(/\\x1b\\[20[01]~/g, '').trim();
  typed = '';
  fs.appendFileSync(${JSON.stringify(transcript)}, JSON.stringify({ type: 'user', uuid: 'u-' + Date.now(), timestamp: new Date().toISOString(),
    message: { role: 'user', content: prompt } }) + '\\n');
});
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(crashFlag)})) { fs.unlinkSync(${JSON.stringify(crashFlag)}); process.exit(1); }
}, 20);
});
`);
  chmodSync(fakeClaude, 0o755);
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env, HOME: root, SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sid, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({
    type: 'init', sessionId: sid, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: workDir, cliId: 'claude-code', cliPathOverride: fakeClaude, cliSessionId,
    backendType: 'pty', prompt: '', resume: true, larkAppId: 'app_test', larkAppSecret: 'test-only', locale: 'zh',
  } satisfies DaemonToWorker);
  const notices = () => messages.filter((msg): msg is Extract<WorkerToDaemon, { type: 'user_notify' }> => msg.type === 'user_notify');
  const readies = () => messages.filter(msg => msg.type === 'prompt_ready').length;
  /** Crash the CLI inside this worker, as the daemon's auto-restart answers. */
  const crashAndResume = async (): Promise<void> => {
    await waitUntil(() => readies() > 0, logs);
    const before = readies();
    const exits = messages.filter(msg => msg.type === 'claude_exit').length;
    writeFileSync(crashFlag, '1');
    await waitUntil(() => messages.filter(msg => msg.type === 'claude_exit').length > exits, logs);
    child!.send({ type: 'restart', reason: 'cli_crash' } satisfies DaemonToWorker);
    await waitUntil(() => readies() > before, logs, 45_000);
    await new Promise(done => setTimeout(done, 800));
  };
  const processInput = (n: number): string | undefined =>
    (existsSync(inputLog) ? readFileSync(inputLog, 'utf8').split('--- start\n').slice(1) : [])[n];
  return { transcript, messages, logs, notices, readies, crashAndResume, processInput };
}

describe('worker restart interruption notice (real worker, fake Claude Code)', () => {
  it('reads the Claude transcript at the bridge baseline, names the killed background task, and says it once per worker', async () => {
    // Killed a minute ago: within any time bound, so only the per-worker
    // dedupe keeps the next crash from reporting it again.
    const w = startClaudeWorker(claudeBackgroundTaskRows({ killedMinutesAgo: 1 }));
    await waitUntil(() => w.notices().length > 0, w.logs, 45_000);
    expect(w.notices()).toHaveLength(1);
    // No turn cut off, one task named; this new worker never wrote a turn, so
    // the CLI is not handed the note.
    expect(w.notices()[0].message).toBe(restartInterruptionNotice({
      turnOpen: false,
      tasks: [{ taskId: 'bqcj23cgb', kind: 'shell', description: 'Wait for CI run 1 to complete' }],
    }, { cliName: lookupCliDisplayName('claude-code') ?? 'CLI', noteDelivered: false }));

    await w.crashAndResume();
    expect(w.notices()).toHaveLength(1);
  }, 90_000);

  it('does not re-send a message whose user record Claude Code already wrote; hands it the note instead', async () => {
    const w = startClaudeWorker([
      { type: 'user', uuid: 'p0', timestamp: minutesAgo(200), message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'a0', timestamp: minutesAgo(199), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] } },
    ], { recordTurns: true });
    await waitUntil(() => w.readies() > 0, w.logs, 45_000);
    child!.send({ type: 'message', content: 'review PR 1931', turnId: 'om_c1' } satisfies DaemonToWorker);
    await waitUntil(() => readFileSync(w.transcript, 'utf8').includes('review PR 1931'), w.logs);
    await new Promise(done => setTimeout(done, 1_500));
    await w.crashAndResume();
    await waitUntil(() => !!w.processInput(1)?.includes(TURN_NOTE), w.logs);
    await new Promise(done => setTimeout(done, 1_000));
    expect(w.processInput(1)).not.toContain('review PR 1931');
    expect(w.notices()).toHaveLength(1);
    expect(w.notices()[0]).toMatchObject({ turnId: 'om_c1' });
  }, 90_000);

  it('a stop made long before the CLI ended is not reported once the worker has seen that end', async () => {
    // Nothing interrupted when this worker starts. Later the transcript shows
    // the task stopped an hour ago (a TUI stop on an idle session looks just
    // like an exit kill); the worker saw its CLI end just now, so it is not
    // reported. A new worker without that record would report it.
    const w = startClaudeWorker([
      { type: 'user', uuid: 'p0', timestamp: minutesAgo(200), message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'a0', timestamp: minutesAgo(199), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] } },
    ]);
    await waitUntil(() => w.readies() > 0, w.logs, 45_000);
    expect(w.notices()).toHaveLength(0);
    appendFileSync(w.transcript, claudeBackgroundTaskRows({ killedMinutesAgo: 60 }).slice(1)
      .map(row => `${JSON.stringify(row)}\n`).join(''));
    await w.crashAndResume();
    expect(w.notices()).toHaveLength(0);
  }, 90_000);
});
