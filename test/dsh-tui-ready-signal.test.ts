/**
 * dsh-tui structured readiness (commit A).
 *
 * dsh-tui repaints a blinking cursor ~2x/s even while idle, so the worker's
 * PTY-quiescence IdleDetector can never call markPromptReady() and the first
 * queued prompt would wait out the 90s hard cap. The generated wrapper plugin
 * therefore fires BOTMUX_READY_COMMAND itself, as soon as dsh-tui publishes its
 * own inject-channel discovery record (written right after the first frame).
 *
 * These tests drive the REAL generated plugin in a child process (it is plain
 * ESM that imports the profile's dsh-tui entry), because the trigger is a file
 * the running TUI writes with its own pid.
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDshQuestionBridgePatch } from '../src/adapters/dsh-question-bridge.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const tempDirs = new Set<string>();
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-dsh-ready-'));
  tempDirs.add(dir);
  return dir;
}

/** Minimal stand-in for the dsh-tui profile package the wrapper imports. */
function makeDshTuiProfile(root: string): string {
  const profile = join(root, 'profile');
  const pkgRoot = join(profile, 'node_modules', '@deepseek-harness-tui', 'dsh-tui');
  mkdirSync(join(pkgRoot, 'lib', 'types'), { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'profile' }) + '\n');
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: '@deepseek-harness-tui/dsh-tui',
    type: 'module',
    exports: { '.': { import: './lib/types/index.js' } },
  }) + '\n');
  writeFileSync(
    join(pkgRoot, 'lib', 'types', 'index.js'),
    'export const name = "dsh-tui";\nexport const inject = ["agents"];\nexport const Config = { marker: true };\nexport async function apply() {}\n',
  );
  return profile;
}

function makeExecutable(file: string, body: string): string {
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

/**
 * Child driver: publishes the inject record for ITS OWN pid (exactly what
 * dsh-tui does after the first frame), imports the generated wrapper, calls
 * apply(), then idles long enough for several poll intervals to elapse.
 */
const DRIVER_SOURCE = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const [pluginPath, homeDir, readyCountFile, doneFile, injectPidArg, sessionId, statusScript] = process.argv.slice(2);
const injectDir = homeDir + '/.dsh-tui/inject';
mkdirSync(injectDir, { recursive: true });
writeFileSync(injectDir + '/servers.json', JSON.stringify([{
  pid: injectPidArg === 'self' ? process.pid : Number(injectPidArg),
  sessionId,
  cwd: homeDir,
  socketPath: injectDir + '/' + sessionId + '.sock',
  startedAt: Date.now(),
}]));
const listeners = new Map();
const mod = await import(pluginPath);
const ctx = {
  get: () => undefined,
  on: (name, fn) => { listeners.set(name, fn); return () => {}; },
  effect: () => () => {},
  loader: { entries: function* () { yield { options: { id: 'dsh-tui', config: {} } }; } },
};
await mod.apply(ctx, {});
// Longer than several 250ms poll ticks: a non-idempotent signal would append
// repeatedly here.
await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
// Scripted agent/status edges, as "<agentSessionId|owner>:<status>" tokens.
for (const token of statusScript === 'none' ? [] : statusScript.split(',')) {
  const sep = token.indexOf(':');
  const who = token.slice(0, sep);
  const status = token.slice(sep + 1);
  listeners.get('agent/status')?.({
    agent: { session: { id: who === 'owner' ? sessionId : who } },
    status,
  });
}
await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
appendFileSync(doneFile, 'done');
`;

interface ReadyRun {
  readyLines: string[];
  idleLines: string[];
}

async function runReadyDriver(opts: {
  home: string;
  injectPid: string;
  botmuxSessionEnv: boolean;
  statusScript?: string;
}): Promise<ReadyRun> {
  const profile = makeDshTuiProfile(opts.home);
  const patch = ensureDshQuestionBridgePatch({
    cliId: 'dsh-tui',
    homeDir: opts.home,
    dshTuiProfileDir: profile,
    hookCommand: { cmd: '/bin/true', args: [] },
    buildSalt: `ready-${opts.injectPid}-${opts.botmuxSessionEnv}-${opts.statusScript ?? 'none'}`,
  });
  expect(patch).not.toBeNull();

  const readyCountFile = join(opts.home, 'ready-count');
  const readyCommand = makeExecutable(
    join(opts.home, 'ready-command.mjs'),
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(readyCountFile)}, 'x');\n`,
  );
  const idleCountFile = join(opts.home, 'idle-count');
  const idleCommand = makeExecutable(
    join(opts.home, 'idle-command.mjs'),
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(idleCountFile)}, 'x');\n`,
  );
  const doneFile = join(opts.home, 'driver-done');
  const driver = join(opts.home, 'driver.mjs');
  writeFileSync(driver, DRIVER_SOURCE);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: opts.home,
    USERPROFILE: opts.home,
    BOTMUX_READY_COMMAND: `"${process.execPath}" "${readyCommand}"`,
    BOTMUX_TURN_IDLE_COMMAND: `"${process.execPath}" "${idleCommand}"`,
  };
  if (opts.botmuxSessionEnv) {
    env.BOTMUX_SESSION_ID = 'sess-ready-signal';
    env.BOTMUX_CHAT_ID = 'oc_ready_signal';
    env.BOTMUX_LARK_APP_ID = 'cli_ready_signal';
  } else {
    delete env.BOTMUX_SESSION_ID;
    delete env.BOTMUX_CHAT_ID;
    delete env.BOTMUX_LARK_APP_ID;
  }

  const child = spawnTsScript(
    driver,
    [
      patch!.pluginPath,
      opts.home,
      readyCountFile,
      doneFile,
      opts.injectPid,
      'dsh-session-1',
      opts.statusScript ?? 'none',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;
  children.add(child);
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.on('data', (chunk: string) => { output += chunk; });
  const status = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('close', resolvePromise);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 20_000).unref();
  });
  if (!existsSync(doneFile)) {
    throw new Error(`ready-signal driver did not finish (status=${status})\n${output}\n${patch!.pluginPath}`);
  }
  const readyText = existsSync(readyCountFile) ? readFileSync(readyCountFile, 'utf8') : '';
  const idleText = existsSync(idleCountFile) ? readFileSync(idleCountFile, 'utf8') : '';
  return { readyLines: [...readyText], idleLines: [...idleText] };
}

describe('dsh-tui structured readiness', () => {
  it('opts the dsh-tui adapter into the ready hook', () => {
    // Source-level: importing the CLI adapter registry pulls in every adapter,
    // which needs the full node_modules tree (not available in every checkout).
    const source = readFileSync(join(__dirname, '..', 'src', 'adapters', 'cli', 'dsh-tui.ts'), 'utf8');
    expect(source).toContain('injectsReadyHook: true');
  });

  it('fires BOTMUX_READY_COMMAND exactly once after the inject record appears', async () => {
    const home = tmp();
    const run = await runReadyDriver({ home, injectPid: 'self', botmuxSessionEnv: true });
    // Idempotent: the driver outlives ~6 poll ticks and must still see one exec.
    expect(run.readyLines).toEqual(['x']);
  }, 30_000);

  it('stays silent while the published inject record belongs to another process', async () => {
    const home = tmp();
    const run = await runReadyDriver({ home, injectPid: '999999', botmuxSessionEnv: true });
    expect(run.readyLines).toEqual([]);
  }, 30_000);

  it('stays silent outside a botmux session', async () => {
    const home = tmp();
    const run = await runReadyDriver({ home, injectPid: 'self', botmuxSessionEnv: false });
    expect(run.readyLines).toEqual([]);
  }, 30_000);

  it('opts the dsh-tui adapter into the structured turn-idle hook', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'adapters', 'cli', 'dsh-tui.ts'), 'utf8');
    expect(source).toContain('injectsTurnIdleHook: true');
  });

  it('reports one turn idle per agent/status idle edge of its own agent', async () => {
    const home = tmp();
    const run = await runReadyDriver({
      home,
      injectPid: 'self',
      botmuxSessionEnv: true,
      statusScript: 'owner:running,owner:idle,owner:idle,owner:running,owner:idle',
    });
    // The duplicate idle is a no-op (agent/status only fires on a transition),
    // so exactly the two real turn ends report.
    expect(run.idleLines).toEqual(['x', 'x']);
  }, 30_000);

  it('never reports a sibling agent mounted in the same TUI process', async () => {
    const home = tmp();
    const run = await runReadyDriver({
      home,
      injectPid: 'self',
      botmuxSessionEnv: true,
      statusScript: 'some-other-session:running,some-other-session:idle',
    });
    expect(run.idleLines).toEqual([]);
  });

  it('never reports before the inject record binds this process to a session', async () => {
    const home = tmp();
    const run = await runReadyDriver({
      home,
      injectPid: '999999',
      botmuxSessionEnv: true,
      statusScript: 'owner:running,owner:idle',
    });
    expect(run.idleLines).toEqual([]);
  });

  it('never leaks the TUI status channel into the headless dsh bridge plugin', () => {
    const home = tmp();
    const patch = ensureDshQuestionBridgePatch({
      cliId: 'dsh',
      homeDir: home,
      hookCommand: { cmd: '/bin/true', args: ['hook', 'dsh'] },
      buildSalt: 'ordinary-has-no-status-channel',
    })!;
    const plugin = readFileSync(patch.pluginPath, 'utf8');
    expect(plugin).not.toContain('BOTMUX_READY_COMMAND');
    expect(plugin).not.toContain('BOTMUX_TURN_IDLE_COMMAND');
    expect(plugin).not.toContain('servers.json');
    expect(plugin).toContain('const RUNTIME = "official"');
  });
});
