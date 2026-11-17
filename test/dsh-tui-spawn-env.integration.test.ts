/**
 * Real worker + REAL backends (PTY and tmux) for a dsh-tui launch.
 *
 * What a helper-level unit test cannot see, pinned here:
 *
 *   1. The worker's own wiring: `planChildSpawnEnv` must actually feed
 *      `backend.spawn()`, `ready.spawnCommand` must be built from the SAME plan
 *      (the Dashboard "copy & run" command must not carry stale resume markers),
 *      and the fresh demotion must be reported. Removing the wiring leaves the
 *      unit tests green but turns these red.
 *   2. The child process's REAL environ, in both env-merge shapes. The markers
 *      are injected twice — once in the worker's inherited env (which is also
 *      what a persistent backend's shared tmux server would carry, so only the
 *      pane-side `env -u` can remove it) and once in the bot's `env`, which the
 *      PTY backend overlays AFTER the removals. The tmux case additionally has
 *      the pane's interactive rcfile re-export them.
 *   3. A PREDICTED reattach: the worker must still scrub, because the backend
 *      may freeze-downgrade the reattach into a real fresh spawn.
 *
 * The fake CLI dumps its argv + environ, so the assertions are about what the
 * CLI really received, never about source text.
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { killProcessTree } from './helpers/process-tree.js';

const tmuxAvailable = probeTmuxFunctional().ok;

const RESUME_MARKERS = [
  'DSH_TUI_RESUME_SESSION',
  'DSH_TUI_RESUME_BACKEND',
  'DSH_TUI_RESUME_RETRY',
] as const;

const FAKE_CLI = `#!/bin/sh
: > "$DUMP_DIR/args"
for a in "$@"; do printf '%s\\n' "$a" >> "$DUMP_DIR/args"; done
env > "$DUMP_DIR/env"
# The dsh-tui composer glyph: enough for the worker's idle detector to consider
# the CLI ready, so the ready IPC (with its spawnCommand) is observable early.
printf '\\342\\235\\257\\n'
sleep 300
`;

const children = new Set<ChildProcess>();
const roots: string[] = [];
const tmuxDirs: string[] = [];

afterEach(() => {
  for (const child of children) {
    try { killProcessTree(child); } catch { /* already gone */ }
  }
  children.clear();
  for (const tmuxDir of tmuxDirs.splice(0)) {
    for (const args of [[], ['-L', 'botmux']]) {
      try {
        execFileSync('tmux', [...args, 'kill-server'], {
          env: privateTmuxEnv(tmuxDir), stdio: 'ignore', timeout: 5000,
        });
      } catch { /* no server */ }
    }
    rmSync(tmuxDir, { recursive: true, force: true });
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function parseEnvDump(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

async function waitFor(check: () => boolean, timeoutMs: number, describeState: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out after ${timeoutMs}ms\n${describeState()}`);
}

interface Scaffold {
  root: string;
  home: string;
  dataDir: string;
  dumpDir: string;
  fakeCli: string;
  tmuxDir?: string;
  sessionId: string;
}

function makeScaffold(backendType: 'pty' | 'tmux'): Scaffold {
  const root = mkdtempSync(join(tmpdir(), `dsh-tui-spawn-${backendType}-`));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const dumpDir = join(root, 'dump');
  mkdirSync(dumpDir, { recursive: true });
  const fakeCli = join(root, 'fake-dsh-tui');
  writeFileSync(fakeCli, FAKE_CLI);
  chmodSync(fakeCli, 0o755);
  // A unix socket path is capped at ~108 bytes. The vitest TMPDIR resolves
  // through a long session-tmp symlink, so the private tmux root must be a
  // genuinely short path or tmux cannot bind at all (`File name too long`).
  const tmuxDir = tmuxAvailable ? mkdtempSync('/tmp/bmux-tmux-') : undefined;
  if (tmuxDir) tmuxDirs.push(tmuxDir);
  if (backendType === 'tmux') {
    // Simulate the REAL hazard: the pane's INTERACTIVE login shell re-exports
    // the markers from the user's rcfile. Deleting keys from the env layers
    // (childEnv / injectEnv) can never remove those — only the pane's final
    // `env -u` runs late enough.
    writeFileSync(
      join(home, '.bashrc'),
      `${RESUME_MARKERS.map(marker => `export ${marker}=rcfile-value`).join('\n')}\n`,
    );
  }
  return {
    root, home, dataDir, dumpDir, fakeCli, tmuxDir,
    sessionId: `dshspawn${Date.now().toString(36)}${process.pid.toString(36)}`,
  };
}

interface WorkerInitExtra {
  resume?: boolean;
  cliSessionId?: string;
  /** Run the REAL dsh runtime mapping ('dsh' + dshRuntime='tui'). */
  configuredTui?: boolean;
  persistentBackendTarget?: unknown;
}

function startWorker(scaffold: Scaffold, backendType: 'pty' | 'tmux', init: WorkerInitExtra) {
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: privateTmuxEnv(scaffold.tmuxDir ?? scaffold.root, {
      HOME: scaffold.home,
      USERPROFILE: scaffold.home,
      SESSION_DATA_DIR: scaffold.dataDir,
      BOTMUX_SESSION_ID: scaffold.sessionId,
      // The generated question-bridge profile is irrelevant here.
      BOTMUX_DSH_ASK_BRIDGE: '0',
      LARK_APP_ID: 'app_test',
      LARK_APP_SECRET: 'secret',
      DUMP_DIR: scaffold.dumpDir,
      // Source 1: inherited worker/daemon env. On the tmux backend this is also
      // what the private server's global environment starts from, so the CLI
      // would see these unless the pane's final `env -u` removes them.
      DSH_TUI_RESUME_SESSION: 'parent-session',
      DSH_TUI_RESUME_BACKEND: 'parent-backend',
      DSH_TUI_RESUME_RETRY: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout?.on('data', b => logs.push(b.toString()));
  child.stderr?.on('data', b => logs.push(b.toString()));
  child.on('message', m => messages.push(m as WorkerToDaemon));
  child.send({
    type: 'init',
    sessionId: scaffold.sessionId,
    chatId: 'oc_test',
    rootMessageId: 'om_root',
    workingDir: scaffold.root,
    // The default is the effective adapter; `configuredTui` exercises the REAL
    // bot config path ('dsh' + dshRuntime='tui') the worker resolves.
    cliId: init.configuredTui ? 'dsh' : 'dsh-tui',
    ...(init.configuredTui ? { dshRuntime: 'tui' as const } : {}),
    cliPathOverride: scaffold.fakeCli,
    backendType,
    prompt: '',
    turnId: 'turn-init',
    larkAppId: 'app_test',
    larkAppSecret: 'secret',
    // The tmux pane runs its interactive rcfile before our removals; pin bash
    // so the fixture .bashrc above is the shell that loads it.
    ...(backendType === 'tmux' ? { launchShell: 'bash' } : {}),
    ...(init.resume !== undefined ? { resume: init.resume } : {}),
    ...(init.cliSessionId ? { cliSessionId: init.cliSessionId } : {}),
    ...(init.persistentBackendTarget ? { persistentBackendTarget: init.persistentBackendTarget as never } : {}),
    // Source 2: this bot's configured env (applied as the PTY backend's
    // injectEnv / the pane's KEY=VAL operands).
    env: {
      DSH_TUI_RESUME_SESSION: 'bot-session',
      DSH_TUI_RESUME_BACKEND: 'bot-backend',
      DSH_TUI_RESUME_RETRY: '1',
    },
  } satisfies DaemonToWorker);
  return { child, messages, logs };
}

interface SpawnRun {
  args: string[];
  env: Record<string, string>;
  logs: string;
  messages: WorkerToDaemon[];
}

async function spawnAndDump(
  backendType: 'pty' | 'tmux',
  init: WorkerInitExtra,
  opts: { waitForReady?: boolean } = {},
): Promise<SpawnRun> {
  const scaffold = makeScaffold(backendType);
  const { messages, logs } = startWorker(scaffold, backendType, init);
  const envPath = join(scaffold.dumpDir, 'env');
  const argsPath = join(scaffold.dumpDir, 'args');
  await waitFor(
    () => existsSync(envPath) && existsSync(argsPath),
    30_000,
    () => `worker logs:\n${logs.join('')}`,
  );
  if (opts.waitForReady) {
    await waitFor(
      () => messages.some(msg => msg.type === 'ready'),
      40_000,
      () => `no ready message; worker logs:\n${logs.join('')}`,
    );
  }
  return {
    args: readFileSync(argsPath, 'utf8').split('\n').filter(Boolean),
    env: parseEnvDump(readFileSync(envPath, 'utf8')),
    logs: logs.join(''),
    messages,
  };
}

function readySpawnCommand(run: SpawnRun): string {
  const ready = run.messages.find(msg => msg.type === 'ready');
  expect(ready).toBeTruthy();
  const command = (ready as { spawnCommand?: string }).spawnCommand;
  expect(typeof command).toBe('string');
  return command!;
}

/** No marker is SERIALIZED as an assignment (the `env -u` removal tokens are
 *  expected and are not assignments). */
function expectNoMarkerAssignments(command: string): void {
  for (const marker of RESUME_MARKERS) {
    expect(command).not.toContain(`${marker}='`);
  }
}

function expectFreshEnv(run: SpawnRun): void {
  expect(run.args).not.toContain('--resume');
  for (const marker of RESUME_MARKERS) expect(run.env[marker]).toBeUndefined();
  // The worker-level audit line: the wiring itself, not just its effect.
  expect(run.logs).toContain('dsh-tui spawn env: resume=false');
  expect(run.logs).toContain('markersInEnv=-');
  expect(run.logs).toContain('markersInInject=-');
  expect(run.logs).toContain(`unsetEnv=${RESUME_MARKERS.join(',')}`);
}

describe('dsh-tui fresh demotion — real worker + real backend', () => {
  it('PTY: missing native id demotes to fresh, child env is clean, demotion is reported', async () => {
    const run = await spawnAndDump('pty', { resume: true }, { waitForReady: true });
    expectFreshEnv(run);
    const reports = run.messages.filter(msg => msg.type === 'user_notify' && msg.kind === 'resume_fallback');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ resumeTier: 'no-exact-id', resumeLost: true });
    // The Dashboard 「复现命令」 must describe the SAME cleaned spawn.
    const command = readySpawnCommand(run);
    expectNoMarkerAssignments(command);
    expect(command).toContain(
      '/usr/bin/env -u DSH_TUI_RESUME_SESSION -u DSH_TUI_RESUME_BACKEND -u DSH_TUI_RESUME_RETRY',
    );
  }, 90_000);

  it.skipIf(!tmuxAvailable)('tmux: the pane\'s final env is clean too (server env + bot env are both overridden)', async () => {
    const run = await spawnAndDump('tmux', { resume: true });
    expectFreshEnv(run);
  }, 60_000);

  it('the REAL bot mapping (cliId=dsh + dshRuntime=tui) takes the same fresh path', async () => {
    const run = await spawnAndDump('pty', { resume: true, configuredTui: true });
    expectFreshEnv(run);
    expect(run.messages.filter(msg => msg.type === 'user_notify' && msg.kind === 'resume_fallback')).toHaveLength(1);
  }, 60_000);

  it('resume WITH a native id keeps the payload but still drops the inherited retry flag', async () => {
    const run = await spawnAndDump('pty', { resume: true, cliSessionId: 'native-abc' }, { waitForReady: true });
    expect(run.args).toContain('--resume');
    expect(run.args).toContain('native-abc');
    // The bot layer wins over the inherited value — the resume payload itself
    // must survive, or dsh would silently start a fresh session.
    expect(run.env.DSH_TUI_RESUME_SESSION).toBe('bot-session');
    expect(run.env.DSH_TUI_RESUME_BACKEND).toBe('bot-backend');
    // ... but an INHERITED retry flag never reaches the launcher: it would turn
    // an explicit bad id into a silent downgrade instead of dsh's boot fatal.
    expect(run.env.DSH_TUI_RESUME_RETRY).toBeUndefined();
    expect(run.logs).toContain('dsh-tui spawn env: resume=true');
    expect(run.logs).toContain('unsetEnv=DSH_TUI_RESUME_RETRY');
    expect(run.messages.filter(msg => msg.type === 'user_notify' && msg.kind === 'resume_fallback')).toHaveLength(0);
    // Reproduction command parity: the resume payload stays, the retry flag is
    // expressed as a removal.
    const command = readySpawnCommand(run);
    expect(command).toContain("DSH_TUI_RESUME_SESSION='bot-session'");
    expect(command).toContain("DSH_TUI_RESUME_BACKEND='bot-backend'");
    expect(command).not.toContain("DSH_TUI_RESUME_RETRY='");
    expect(command).toContain('-u DSH_TUI_RESUME_RETRY');
  }, 90_000);

  it.skipIf(!tmuxAvailable)('a PREDICTED reattach still scrubs (frozen reattach can become a real spawn)', async () => {
    const scaffold = makeScaffold('tmux');
    // Generation 1 creates the pane (and its env dump).
    const first = startWorker(scaffold, 'tmux', { resume: false });
    await waitFor(
      () => existsSync(join(scaffold.dumpDir, 'env')),
      30_000,
      () => `worker logs:\n${first.logs.join('')}`,
    );
    const target = (first.messages.find(msg => msg.type === 'persistent_backend_target') as
      { target?: unknown } | undefined)?.target;
    expect(target).toBeTruthy();
    // The pane survives its worker (it belongs to the tmux server), so a
    // replacement worker predicts a reattach.
    killProcessTree(first.child);

    const second = startWorker(scaffold, 'tmux', { resume: true, persistentBackendTarget: target });
    await waitFor(
      () => second.logs.join('').includes('dsh-tui spawn env:'),
      30_000,
      () => `worker logs:\n${second.logs.join('')}`,
    );
    const line = second.logs.join('').split('\n').find(l => l.includes('dsh-tui spawn env:'))!;
    // Tier 0 is intentionally skipped on a predicted reattach (the CLI is still
    // running), so `resume=true` — and the markers must STILL be scrubbed
    // because a frozen backend may downgrade that reattach into a real spawn.
    expect(line).toContain('resume=true');
    expect(line).toContain('willReattachPersistent=true');
    expect(line).toContain(`unsetEnv=${RESUME_MARKERS.join(',')}`);
  }, 90_000);
});
