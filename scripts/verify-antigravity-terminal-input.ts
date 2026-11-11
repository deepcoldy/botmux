/** Verify native Antigravity paste through real PTY and Tmux transports in an isolated HOME. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { spawn } from 'node-pty';
import { createAntigravityAdapter } from '../src/adapters/cli/antigravity.js';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

const { values } = parseArgs({ options: {
  'agy-bin': { type: 'string' }, 'auth-dir': { type: 'string' }, report: { type: 'string' },
  model: { type: 'string', default: 'gemini-3.8-flash-high' }, worker: { type: 'boolean', default: false },
} });
if (process.env.BOTMUX_FENCED_RUN !== '1' || !values['agy-bin'] || !values['auth-dir'] || !values.report) {
  throw new Error('Use fenced-run with --agy-bin, --auth-dir and --report.');
}
const bin = resolve(values['agy-bin']);
const auth = resolve(values['auth-dir']);
const root = join(homedir(), '.gemini', 'antigravity-cli');
const cwd = join(homedir(), 'workspace');
const authFiles = ['antigravity-oauth-token', 'installation_id', 'jetski_state.pbtxt', 'cache/default_project_id.txt', 'cache/onboarding.json'];

/** Compare the original narrow authentication snapshot without exposing credentials. */
function authHashes(): string[] {
  return authFiles.filter(name => existsSync(join(auth, name)))
    .map(name => createHash('sha256').update(readFileSync(join(auth, name))).digest('hex'));
}
const before = authHashes();
for (const name of authFiles) {
  if (!existsSync(join(auth, name))) continue;
  mkdirSync(dirname(join(root, name)), { recursive: true });
  copyFileSync(join(auth, name), join(root, name));
}
mkdirSync(cwd, { recursive: true });
writeFileSync(join(root, 'settings.json'), JSON.stringify({ trustedWorkspaces: [cwd] }));
const version = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 3_000 }).trim();
const records: Array<Record<string, unknown>> = [];

/** Every run gets a fresh fenced HOME, so agy's per-HOME 15-minute self-update
 *  throttle never engages: without this, the background updater replaces the
 *  binary at --agy-bin in place. Must be the literal "true" (agy ignores "1"),
 *  matching scripts/oncall-cli-matrix/specs.ts. */
function probeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true', ...extra };
}

/** Wait without blocking the runner or the CLI's input processing. */
const wait = (ms: number): Promise<void> => new Promise(resolveWait => setTimeout(resolveWait, ms));
/** Quote only process-owned paths/arguments for a new private Tmux session. */
const quote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;

/** Read complete native user records; history.jsonl deliberately truncates long previews. */
function nativeInputs(marker: string): string[] {
  const found: string[] = [];
  const scan = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.name === 'transcript_full.jsonl') {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          try {
            const record: unknown = JSON.parse(line);
            if (record && typeof record === 'object' && 'type' in record && record.type === 'USER_INPUT'
              && 'content' in record && typeof record.content === 'string' && record.content.includes(marker)) found.push(record.content);
          } catch { /* An unfinished last JSONL row is not receipt evidence. */ }
        }
      }
    }
  };
  scan(join(root, 'brain'));
  return found;
}

/** Exercise the real adapter and one transport, with exact long-input receipt assertions. */
async function verify(transport: 'pty' | 'tmux'): Promise<void> {
  const processStarted = performance.now();
  const selected = createAntigravityAdapter(bin);
  const args = selected.buildArgs({ sessionId: randomUUID(), resume: false, reattach: false, cliVersion: version, workingDir: cwd, model: values.model });
  const marker = `AGY_${transport.toUpperCase()}_${randomUUID()}`;
  const content = `${marker}\nReply only OK. Do not use tools.\n\n` + '中文🙂 payload ; literal\n'.repeat(1000) + `END_${marker}`;
  let rawWrites = 0;
  let atomicSubmits = 0;
  let handle: PtyHandle;
  let ready: () => boolean;
  let screen: () => string;
  let close: () => void;
  if (transport === 'pty') {
    const child = spawn(bin, args, { name: 'xterm-256color', cols: 160, rows: 40, cwd, env: probeEnv({ TERM: 'xterm-256color', NO_COLOR: '1' }) });
    let output = '';
    child.onData(chunk => { output = (output + chunk).slice(-32_000); });
    handle = { cliPid: child.pid, cliCwd: cwd, write(text) { rawWrites++; child.write(text); return true; } };
    screen = () => stripVTControlCharacters(output);
    ready = () => /for shortcuts/.test(screen());
    close = () => { try { child.kill('SIGTERM'); } catch { /* Already exited. */ } };
  } else {
    const socket = `agy-proof-${randomUUID().slice(0, 8)}`;
    const tmuxArgs = ['-L', socket];
    execFileSync('tmux', [...tmuxArgs, 'new-session', '-d', '-s', 'agy-proof', '-x', '160', '-y', '40', '-c', cwd,
      `exec ${[bin, ...args].map(quote).join(' ')}`], { timeout: 5_000, env: probeEnv() });
    const backend = new TmuxPipeBackend('agy-proof', { socketName: socket });
    handle = { write(text) { rawWrites++; backend.write(text); return true; },
      submitBracketedPaste(text) { atomicSubmits++; return backend.submitBracketedPaste(text); } };
    screen = () => execFileSync('tmux', [...tmuxArgs, 'capture-pane', '-p', '-t', 'agy-proof'], { encoding: 'utf8', timeout: 3_000 });
    ready = () => /for shortcuts/.test(screen());
    close = () => { try { execFileSync('tmux', [...tmuxArgs, 'kill-server'], { timeout: 3_000 }); } catch { /* Already exited. */ } };
  }
  try {
    let isReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (ready()) { isReady = true; break; }
      await wait(100);
    }
    if (!isReady) throw new Error(`${transport} did not reach its input prompt: ${screen().slice(-1400)}`);
    const readyMs = Math.round(performance.now() - processStarted);
    const started = performance.now();
    const submit = await selected.writeInput(handle, content);
    const confirmedMs = Math.round(performance.now() - started);
    let inputs: string[] = [];
    for (let attempt = 0; attempt < 240; attempt++) {
      inputs = nativeInputs(marker);
      if (inputs.some(input => input.includes(content))) break;
      await wait(50);
    }
    const matched = inputs.filter(input => input.includes(content));
    records.push({ transport, bytes: Buffer.byteLength(content), lines: content.split('\n').length,
      rawWrites, atomicSubmits, readyMs, confirmedMs, nativeInputMs: Math.round(performance.now() - started),
      historyConfirmed: submit === undefined || submit.submitted === true, nativeFullInputMatches: matched.length });
    if ((submit && submit.submitted === false) || matched.length !== 1 || rawWrites + atomicSubmits !== 1) {
      throw new Error(`${transport} input failed exact receipt / single-submit assertions`);
    }
  } finally { close(); await wait(200); }
}

/** Measure the compiled production worker through native CLI readiness and exact input receipt. */
async function verifyWorker(transport: 'pty' | 'tmux'): Promise<void> {
  const marker = `AGY_WORKER_${transport.toUpperCase()}_${randomUUID()}`;
  const prompt = `${marker} Reply only OK. Do not use tools.`;
  const started = performance.now();
  let importedMs: number | undefined;
  let cliSpawnMs: number | undefined;
  let cliReadyMs: number | undefined;
  let promptReadyMs: number | undefined;
  const worker = fork(resolve('dist/worker.js'), [], {
    cwd, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: probeEnv({ BOTMUX_NO_CLAIM: '1' }),
  });
  let logs = '';
  worker.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString(); logs = (logs + text).slice(-8000);
    const elapsed = Math.round(performance.now() - started);
    if (text.includes('Worker started')) importedMs ??= elapsed;
    if (text.includes('Spawning fresh CLI:')) cliSpawnMs ??= elapsed;
    if (text.includes('Prompt detected (idle)')) cliReadyMs ??= elapsed;
  });
  worker.stderr?.on('data', (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-8000); });
  worker.on('message', (message: WorkerToDaemon) => {
    if (message.type === 'prompt_ready') promptReadyMs ??= Math.round(performance.now() - started);
  });
  const exited = new Promise<void>(resolveExit => worker.once('exit', () => resolveExit()));
  worker.send({ type: 'init', sessionId: randomUUID(), chatId: 'oc_input_benchmark', rootMessageId: 'om_input_benchmark',
    workingDir: cwd, cliId: 'antigravity', cliPathOverride: bin, cliVersion: version, backendType: transport,
    model: values.model, prompt, turnId: marker, larkAppId: 'benchmark_isolated', larkAppSecret: 'benchmark_isolated',
    apiOnly: true, promptInjection: 'none',
  } satisfies DaemonToWorker);
  try {
    let inputs: string[] = [];
    for (let attempt = 0; attempt < 900; attempt++) {
      inputs = nativeInputs(marker);
      if (inputs.length) break;
      if (worker.exitCode !== null) throw new Error(`Worker exited before native receipt (${worker.exitCode})`);
      await wait(50);
    }
    if (inputs.length !== 1 || !inputs[0]?.includes(prompt)) throw new Error(`Worker native receipt missing or duplicated: ${logs.slice(-2000)}`);
    records.push({ transport, scope: 'compiled-worker', importedMs, cliSpawnMs, cliReadyMs, promptReadyMs,
      nativeInputMs: Math.round(performance.now() - started), nativeFullInputMatches: inputs.length,
      promptInjection: 'none', note: 'No Feishu delivery/network latency; isolated small prompt.' });
  } finally {
    if (worker.connected) worker.send({ type: 'close' } satisfies DaemonToWorker, () => {});
    const timer = setTimeout(() => worker.kill('SIGKILL'), 6000);
    await exited;
    clearTimeout(timer);
  }
}

try {
  await verify('pty');
  await verify('tmux');
  if (values.worker) {
    await verifyWorker('pty');
    await verifyWorker('tmux');
  }
  const sourceAuthUnchanged = JSON.stringify(before) === JSON.stringify(authHashes());
  if (!sourceAuthUnchanged) throw new Error('Source authentication changed during verification');
  const report = { success: true, version, records, isolated: true, sourceAuthUnchanged };
  writeFileSync(resolve(values.report), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  const report = { success: false, version, records, error: String(error) };
  writeFileSync(resolve(values.report), JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report));
  process.exitCode = 1;
}
