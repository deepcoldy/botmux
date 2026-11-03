/**
 * oncall-sandbox CLI matrix runner. Started by lab.sh INSIDE isolate-run (never
 * on the host: it drives real bwrap sandboxes and real CLIs).
 *
 *   bun scripts/oncall-cli-matrix/run.ts [--cli a,b] [--backend tmux,pty] [--out file.json]
 *
 * For every CLI × backend it starts a REAL worker (dist/worker.js, the same
 * entry the daemon forks) with `sandbox: 'oncall'`, the bot env a user would
 * configure, and a fake model endpoint (mock-model.ts) on loopback, then checks:
 *
 *   start    the worker reports `ready` and the CLI does not exit
 *   turn     the first prompt reaches the model and the CLI finishes the turn
 *            (the model saw the tool result and served the final text)
 *   tool     the shell tool call ran inside the sandbox (its output came back)
 *   rw       the tool wrote + read a file in the working dir, visible on the host
 *   net      HTTPS to a public model API from inside the sandbox (no auth; any
 *            HTTP status proves DNS + TLS + egress)
 *   send     `botmux send` inside the sandbox reached the host relay
 *   isolated a canary under the host home is NOT readable
 *   resume   after `restart` (= /restart) the CLI resumed the SAME conversation
 *            (the model saw the first turn's prompt in the history) and the
 *            second turn completed
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startMockModel, type MockModel } from './mock-model.js';
import { CLI_SPECS, type CliSpec } from './specs.js';

type Backend = 'tmux' | 'pty';
type Verdict = 'pass' | 'fail' | 'skip';
interface CheckResult { verdict: Verdict; detail?: string }
const CHECKS = ['start', 'turn', 'tool', 'rw', 'net', 'send', 'isolated', 'resume'] as const;
type Check = typeof CHECKS[number];
interface RowResult { cli: string; backend: Backend; sandbox?: string; checks: Record<Check, CheckResult>; note?: string; logTail?: string }

// Writes CLI configs under $HOME and starts real sandboxes: only inside the
// lab (lab.sh under isolate-run), where $HOME is a throwaway overlay. Checked
// on the mount table, not on an env var a caller could set by hand.
function labHomeIsOverlay(): boolean {
  try {
    const home = homedir();
    return readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
      .some(line => { const f = line.split(' '); return f[4] === home && line.includes(' - overlay '); });
  } catch { return false; }
}
if (!process.env.ISOLATE_LAB_HOME_OVERLAY || !labHomeIsOverlay()) {
  console.error('run.ts: start me through lab.sh under isolate-run ($HOME must be the lab overlay)');
  process.exit(2);
}

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const onlyClis = arg('--cli')?.split(',');
const backends = (arg('--backend')?.split(',') ?? ['tmux', 'pty']) as Backend[];
const outFile = arg('--out') ?? '/tmp/oncall-cli-matrix.json';
const turnTimeoutMs = Number(arg('--turn-timeout') ?? 240_000);
// `off` is the baseline: the same checks without the sandbox, so the table can
// tell a sandbox regression from something the adapter never does.
const sandboxMode = (arg('--sandbox') ?? 'oncall') as 'oncall' | 'off';
// Diagnostic only: extra bot env (K=V,K=V) merged over the spec's.
const extraEnv: Record<string, string> = Object.fromEntries((arg('--extra-env') ?? '').split(',').filter(Boolean).map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));

const HOME = homedir();
const REPO = process.cwd();
// Outside the private /tmp so the logs outlive the isolate-run job.
const LAB = process.env.OCM_LAB_DIR ?? '/tmp/ocm';
mkdirSync(LAB, { recursive: true });
// tmux socket paths are length-limited: keep them on the private /tmp.
const TMUX_TMPDIR = '/tmp/ocm-tmux';
mkdirSync(TMUX_TMPDIR, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs: number, stop?: () => string | null): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    if (stop?.()) return null;
    await sleep(500);
  }
  return null;
}

const tagOf = () => randomBytes(5).toString('hex');

/** The probe the model runs through the CLI's shell tool on the first turn. */
/** The probe script the first turn runs (written into the working dir by the
 *  harness, so the tool call itself is one plain `bash ./sbx-<tag>.sh` line:
 *  CLIs with their own command policies may reject `$(...)` or ask before
 *  touching paths outside the workdir (OpenCode), neither of which is what this
 *  matrix measures). */
function firstProbeScript(tag: string): string {
  return [
    '#!/bin/bash',
    `printf 'SBX%s-%s\\n' OUT ${tag}`,
    `echo "rw=$( (echo ok-${tag} > ./sbx-${tag}.txt && cat ./sbx-${tag}.txt) 2>&1 | head -c 120)"`,
    `echo "canary=$(cat "$HOME/.sbx-canary/secret.txt" >/dev/null 2>&1 && echo READ || echo HIDDEN)"`,
    `echo "net=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' https://api.anthropic.com 2>&1 | head -c 120)"`,
    'echo "relay=${BOTMUX_SEND_RELAY:+set}"',
    `echo "send=$(botmux send --no-mention 'SBXACK-${tag}' 2>&1 | tr '\\n' ' ' | head -c 400)"`,
    '',
  ].join('\n');
}

function firstProbe(tag: string): string {
  return `bash ./sbx-${tag}.sh > ./sbx-${tag}.result 2>&1; cat ./sbx-${tag}.result`;
}

function secondProbe(tag: string, firstTag: string): string {
  return `printf 'SBX%s-%s\\n' OUT ${tag}; cat ./sbx-${firstTag}.txt`;
}

function parseResult(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^(\w+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function runOne(spec: CliSpec, backend: Backend, mock: MockModel): Promise<RowResult> {
  const checks = Object.fromEntries(CHECKS.map(c => [c, { verdict: 'skip' } as CheckResult])) as Record<Check, CheckResult>;
  const row: RowResult = { cli: spec.id, backend, sandbox: sandboxMode, checks };
  const dir = join(LAB, `${spec.id.replace(/[^a-z0-9-]/g, '_')}-${backend}-${sandboxMode}`);
  rmSync(dir, { recursive: true, force: true });
  const botmuxHome = join(dir, '.botmux');
  const dataDir = join(botmuxHome, 'data');
  const workDir = join(dir, 'work');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const appId = `cli_sbx${spec.id.replace(/[^a-z0-9]/g, '')}`;
  const base = spec.setup({ home: HOME, mockUrl: mock.baseUrl, workDir });
  const setup = Object.keys(extraEnv).length ? { ...base, env: { ...base.env, ...extraEnv } } : base;
  const bots = join(botmuxHome, 'bots.json');
  writeFileSync(bots, JSON.stringify([{
    larkAppId: appId, larkAppSecret: 'fake-secret', cliId: spec.cliId ?? spec.id, sandbox: sandboxMode,
    ...(setup.env ? { env: setup.env } : {}),
  }], null, 2));

  const sessionId = randomUUID();
  const tag1 = tagOf();
  writeFileSync(join(workDir, `sbx-${tag1}.sh`), firstProbeScript(tag1), { mode: 0o755 });
  mock.register(tag1, { command: firstProbe(tag1), firstTag: tag1 });
  // Allowlisted env, never the caller's: the shell this runs from may carry
  // real model credentials (GEMINI_API_KEY, gateway keys, ANTHROPIC_*), and a
  // CLI that cannot see its mock config inside the sandbox falls back to them.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: HOME,
    USER: process.env.USER ?? 'root',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'root',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'xterm-256color',
    TZ: process.env.TZ,
    SESSION_DATA_DIR: dataDir,
    BOTS_CONFIG: bots,
    BOTMUX_NO_CLAIM: '1',
    TMUX_TMPDIR,
    SHELL: '/bin/bash',
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];

  const messages: any[] = [];
  let logs = '';
  const worker: ChildProcess = spawn(process.env.OCM_NODE ?? 'node', [join(REPO, 'dist/worker.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], cwd: workDir,
  });
  worker.stdout?.on('data', d => { logs += String(d); });
  worker.stderr?.on('data', d => { logs += String(d); });
  worker.on('message', m => { messages.push(m); });
  const exited = () => worker.exitCode !== null || worker.signalCode !== null;
  const fatal = (): string | null => {
    const f = messages.find(m => m?.type === 'worker_fatal' || (m?.type === 'error' && m.message));
    if (f) return `${f.type}: ${String(f.message ?? f.error ?? JSON.stringify(f)).slice(0, 300)}`;
    if (exited()) return `worker exited code=${worker.exitCode} signal=${worker.signalCode}`;
    return null;
  };
  const cliExit = () => messages.find(m => m?.type === 'claude_exit');
  const init = {
    type: 'init', sessionId, chatId: 'oc_sbxprobe', chatType: 'group', rootMessageId: 'om_sbxprobe', workingDir: workDir,
    cliId: spec.cliId ?? spec.id, ...(setup.cliPathOverride ? { cliPathOverride: setup.cliPathOverride } : {}),
    backendType: backend, sandbox: sandboxMode,
    // The daemon's routing envelope always carries <session_id>; adapters that
    // find their native session by it (OpenCode) need it in the prompt too.
    prompt: `<session_id>${sessionId}</session_id>\nSBXP-${tag1} 这是沙盒探针：按工具调用执行即可。`,
    larkAppId: appId, larkAppSecret: 'fake-secret', ownerOpenId: 'ou_sbxowner',
    loadedBotsConfigPath: bots, loadedBotsConfigProvenance: 'loaded',
    ...(setup.env ? { env: setup.env } : {}),
    ...(spec.initExtra ?? {}),
  };
  worker.send(init);

  const finalFor = (tag: string) => mock.log.find(e => e.tag === tag && e.phase === 'final');
  const toolFor = (tag: string) => mock.log.find(e => e.tag === tag && e.phase === 'tool');
  const cleanup = async () => {
    if (!exited()) {
      try { worker.send({ type: 'close' }); } catch { /* */ }
      await waitFor(() => exited(), 20_000);
      if (!exited()) worker.kill('SIGKILL');
    }
    spawnSync('tmux', ['-L', 'botmux', 'kill-server'], { env, stdio: 'ignore' });
  };
  try {
    const ready = await waitFor(() => messages.find(m => m?.type === 'ready'), 90_000, fatal);
    const dead = fatal() ?? (cliExit() ? `CLI exited: ${JSON.stringify(cliExit()).slice(0, 300)}` : null);
    checks.start = ready && !dead ? { verdict: 'pass' } : { verdict: 'fail', detail: dead ?? 'no ready in 90s' };
    if (checks.start.verdict === 'fail') return row;

    const done = await waitFor(() => finalFor(tag1), turnTimeoutMs, () => fatal() ?? (cliExit() ? 'cli exit' : null));
    const sawPrompt = mock.log.some(e => e.tag === tag1);
    checks.turn = done ? { verdict: 'pass' } : { verdict: 'fail', detail: sawPrompt ? (toolFor(tag1) ? 'tool result never came back' : 'model saw prompt but CLI declared no shell tool') : 'prompt never reached the model' };
    checks.tool = done ? { verdict: 'pass', detail: toolFor(tag1)?.tool } : { verdict: toolFor(tag1) ? 'fail' : 'skip', detail: toolFor(tag1)?.tool };
    // Give the shell a moment to flush the result file.
    await waitFor(() => existsSync(join(workDir, `sbx-${tag1}.result`)) && /send=/.test(readFileSync(join(workDir, `sbx-${tag1}.result`), 'utf8')), 15_000);
    const r = parseResult(join(workDir, `sbx-${tag1}.result`));
    if (Object.keys(r).length) {
      checks.rw = r.rw === `ok-${tag1}` && readFileSync(join(workDir, `sbx-${tag1}.txt`), 'utf8').trim() === `ok-${tag1}` ? { verdict: 'pass' } : { verdict: 'fail', detail: r.rw };
      checks.net = process.env.OCM_NO_EGRESS ? { verdict: 'skip', detail: 'lab without egress' }
        : /^\d{3}$/.test(r.net ?? '') && r.net !== '000' ? { verdict: 'pass', detail: `HTTP ${r.net}` } : { verdict: 'fail', detail: r.net };
      checks.isolated = sandboxMode === 'off' ? { verdict: 'skip', detail: `sandbox off: ${r.canary}` }
        : r.canary === 'HIDDEN' ? { verdict: 'pass' } : { verdict: 'fail', detail: r.canary };
      checks.send = sandboxMode === 'off' ? { verdict: 'skip', detail: 'sandbox off: no relay' } : defaultSendOk(r.send ?? '', r.relay);
    } else if (done) {
      checks.rw = { verdict: 'fail', detail: 'result file missing on host' };
    }
    if (!done) return row;

    // /restart: kill the CLI and respawn it with its resume id.
    const readyCount = messages.filter(m => m?.type === 'ready' || m?.type === 'prompt_ready').length;
    const exitCount = messages.filter(m => m?.type === 'claude_exit').length;
    await sleep(spec.settleMs ?? 3_000);
    worker.send({ type: 'restart', reason: 'operator', attemptId: `ocm-${tag1}` });
    const reReady = await waitFor(
      () => messages.filter(m => m?.type === 'ready' || m?.type === 'prompt_ready').length > readyCount,
      90_000, fatal,
    );
    const tag2 = tagOf();
    mock.register(tag2, { command: secondProbe(tag2, tag1), firstTag: tag1 });
    await sleep(2_000);
    worker.send({ type: 'message', content: `<session_id>${sessionId}</session_id>\nSBXP-${tag2} 第二轮：按工具调用执行即可。`, turnId: `om_${tag2}` });
    const done2 = await waitFor(() => finalFor(tag2), turnTimeoutMs, fatal);
    const resumed = done2 ? (mock.log.find(e => e.tag === tag2 && e.phase === 'final') as any)?.resumed : undefined;
    checks.resume = !reReady ? { verdict: 'fail', detail: 'no ready after restart' }
      : !done2 ? { verdict: 'fail', detail: 'second turn did not finish' }
      : resumed === 'yes' ? { verdict: 'pass' } : { verdict: 'fail', detail: 'second turn ran in a NEW conversation (history lost)' };
    if (messages.filter(m => m?.type === 'claude_exit').length > exitCount + 1) row.note = 'extra CLI exits after restart';
    return row;
  } finally {
    row.logTail = logs.split('\n').filter(l => /error|fail|EPERM|EACCES|ENOENT|denied|sandbox/i.test(l)).slice(-25).join('\n');
    writeFileSync(join(dir, 'worker.log'), logs);
    // What the CLI left in its state dirs (paths only): which files a precise
    // sandbox grant has to cover. The hidden real dirs are tmpfs in the lab.
    const listing = spawnSync('bash', ['-c', `for d in ${(spec.stateDirs ?? []).map(d => `"$HOME/${d}"`).join(' ')}; do [ -e "$d" ] && find "$d" -maxdepth 5 -printf '%y %p\\n' 2>/dev/null | head -300; done`], { encoding: 'utf8' });
    writeFileSync(join(dir, 'state-tree.txt'), listing.stdout ?? '');
    writeFileSync(join(dir, 'ipc.jsonl'), messages.map(m => JSON.stringify(m)).join('\n'));
    await cleanup();
  }
}

function defaultSendOk(send: string, relay: string | undefined): CheckResult {
  // The relay's host leg re-runs `botmux send` OUTSIDE the sandbox with
  // BOTMUX_SEND_RELAY stripped. This lab has no daemon, so that leg stops at the
  // session lookup; its diagnostic (`relayDir=absent`, i.e. printed by the host
  // process) proves the request crossed the sandbox boundary through the outbox.
  if (relay === 'set' && /relayDir=absent/.test(send)) return { verdict: 'pass', detail: 'host leg reached' };
  return { verdict: 'fail', detail: send.slice(0, 200) || 'no output' };
}

const mock = await startMockModel();
const results: RowResult[] = [];
for (const spec of CLI_SPECS) {
  if (onlyClis && !onlyClis.includes(spec.id)) continue;
  for (const backend of backends) {
    const t0 = Date.now();
    let row: RowResult;
    try {
      row = await runOne(spec, backend, mock);
    } catch (e) {
      row = { cli: spec.id, backend, checks: Object.fromEntries(CHECKS.map(c => [c, { verdict: 'skip' }])) as any, note: `harness error: ${e instanceof Error ? e.stack : e}` };
    }
    results.push(row);
    const line = CHECKS.map(c => `${c}=${row.checks[c].verdict}${row.checks[c].detail && row.checks[c].verdict !== 'pass' ? `(${row.checks[c].detail})` : ''}`).join(' ');
    console.log(`[${spec.id}/${backend}/${sandboxMode}] ${((Date.now() - t0) / 1000).toFixed(0)}s ${line}${row.note ? ` note=${row.note}` : ''}`);
    if (CHECKS.some(c => row.checks[c].verdict === 'fail') && row.logTail) console.log(row.logTail.split('\n').map(l => `    | ${l}`).join('\n'));
    writeFileSync(outFile, JSON.stringify({ results, mockLog: mock.log.slice(-200) }, null, 2));
  }
}
await mock.close();
console.log(`wrote ${outFile}`);
process.exit(0);
