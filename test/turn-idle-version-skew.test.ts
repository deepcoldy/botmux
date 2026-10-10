/**
 * Version skew: a v2 wrapper plugin + a v1 CLI on disk (the turn-idle channel).
 *
 * The plugin is generated once, at spawn, and lives in the long-running dsh-tui
 * process. The command it execs (`BOTMUX_TURN_IDLE_COMMAND`) points at the
 * botmux CLI on the SAME path, which an in-place update or rollback can replace
 * with any version at any time. So "v2 plugin + v1 CLI" is a real state, not a
 * theoretical one.
 *
 * WHY it is dangerous: v2 freezes `(turnId, dispatchAttempt[, capability])`
 * inside the `agent/status` callback and carries them in the payload. A v1 CLI
 * ignores the payload's identity entirely and re-reads the LIVE
 * marker/capability when the detached child finally runs — by then the worker
 * may have rotated to turn B (dsh-tui steers busy-period input), so A's idle
 * report comes out naming B with B's own token, satisfying the worker's
 * exact-match fence and calling fireIdle() while B is still running.
 *
 * WHY the versioned subcommand closes it: v1's dispatch table only knows the
 * bare `turn-idle`. The versioned name falls through to its REAL default branch
 * (`runPluginCommandByName(…) || showHelp()`, no request at all), so the skew
 * degrades to "no idle edge" — the safe direction.
 *
 * THE V1 SIDE IS NOT A STAND-IN: `test/fixtures/v1-turn-idle-cli.ts` is built by
 * mechanically extracting whole branches out of `git show 13f022b41:src/cli.ts`
 * (the branch's last pre-v2 revision — 6278cc59a already requires `v === 2`, so
 * 4260270a9/6a5f3cae6 are NOT the hazard, and a v3.40.0 release predates the
 * channel entirely), keeping the real `postSessionScopedSignal`, `cmdTurnIdle`,
 * `runPluginCommandByName` and `showHelp` with only module specifiers
 * rewritten to repo-relative paths. The last test in this file re-verifies that
 * claim byte-for-byte against the git object.
 */
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDshQuestionBridgePatch } from '../src/adapters/dsh-question-bridge.js';
import { turnIdleHookCommand } from '../src/adapters/hook-command.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';
import { spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V1_CLI = join(REPO_ROOT, 'test', 'fixtures', 'v1-turn-idle-cli.ts');
/** The revision the snapshot quotes (see the fixture header). */
const V1_CLI_SNAPSHOT_REF = '13f022b41';
const SESSION_ID = 'sess-version-skew';
/** The dispatch that is live when the detached child runs (turn B). */
const LIVE_TURN = 'turn-b-live';
const LIVE_ATTEMPT = 7;
const LIVE_TOKEN = 'b'.repeat(64);
/** The dispatch the plugin FREEZES at the event (turn A) — what the v2 payload
 *  claims, and what the v1 CLI must not be able to substitute for. */
const FROZEN_TURN = 'turn-a-frozen';
const FROZEN_ATTEMPT = 1;
const FROZEN_TOKEN = 'a'.repeat(64);

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
  const dir = mkdtempSync(join(tmpdir(), 'botmux-turn-idle-skew-'));
  tempDirs.add(dir);
  return dir;
}

interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
}

/** Collects whatever the CLI under test actually posts. */
async function withRecorder(run: (port: number, received: RecordedRequest[]) => Promise<void>): Promise<void> {
  const received: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { text += chunk; });
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        body: text ? JSON.parse(text) as Record<string, unknown> : {},
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as AddressInfo).port, received);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  }
  // Let any late (detached) child finish; the recorder result is what we assert.
  await new Promise(resolve => setTimeout(resolve, 250));
}

/** The relay capability + tuple the worker published for ONE dispatch. */
function publishRelayIdentity(
  relayDir: string,
  identity: { token: string; turnId: string; dispatchAttempt: number },
): void {
  mkdirSync(relayDir, { recursive: true });
  writeFileSync(
    join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
    JSON.stringify({
      sessionId: SESSION_ID,
      token: identity.token,
      turnId: identity.turnId,
      dispatchAttempt: identity.dispatchAttempt,
    }),
    { mode: 0o600 },
  );
}

/** The dispatch that is live when the detached child runs (turn B). */
function publishLiveRelayIdentity(relayDir: string): void {
  publishRelayIdentity(relayDir, { token: LIVE_TOKEN, turnId: LIVE_TURN, dispatchAttempt: LIVE_ATTEMPT });
}

function runV1Cli(
  subcommand: string,
  env: NodeJS.ProcessEnv,
  stdinPayload: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(V1_CLI, [subcommand], { env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(stdinPayload);
  });
}

function v1Env(home: string, relayDir: string, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    SESSION_DATA_DIR: join(home, 'session-data'),
    BOTMUX_SESSION_ID: SESSION_ID,
    BOTMUX_CHAT_ID: 'oc-version-skew',
    BOTMUX_LARK_APP_ID: 'cli-version-skew',
    BOTMUX_SEND_RELAY: relayDir,
    BOTMUX_DAEMON_IPC_PORT: String(port),
    BOTMUX_TURN_ID: LIVE_TURN,
    BOTMUX_DISPATCH_ATTEMPT: String(LIVE_ATTEMPT),
  };
}

/** Minimal stand-in for the dsh-tui profile package the generated wrapper imports. */
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

const DRIVER_SOURCE = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [pluginPath, homeDir, doneFile, sessionId, liveTurn, liveAttempt, identityModuleUrl] = process.argv.slice(2);
const injectDir = homeDir + '/.dsh-tui/inject';
mkdirSync(injectDir, { recursive: true });
// Our own record, published before the plugin loads (as dsh-tui does right
// after the first frame): the plugin binds to it and may report turn idle.
writeFileSync(injectDir + '/servers.json', JSON.stringify([{
  pid: process.pid, sessionId, cwd: homeDir, socketPath: injectDir + '/' + sessionId + '.sock', startedAt: Date.now(),
}]));
// The CLI-pid marker the worker publishes for THIS process, rewritten on every
// turn advance: this is the live turn identity a v1 CLI resolves by walking its
// ancestors from process.ppid (session-marker.ts), i.e. the production source
// the skew reads — not an env fallback we invented.
const { readProcessStartIdentity } = await import(identityModuleUrl);
const dataDir = process.env.SESSION_DATA_DIR;
const markersDir = join(dataDir, '.botmux-cli-pids');
mkdirSync(markersDir, { recursive: true });
const procStart = readProcessStartIdentity(process.pid);
writeFileSync(join(markersDir, String(process.pid)), JSON.stringify({
  sessionId,
  turnId: liveTurn,
  dispatchAttempt: Number(liveAttempt),
  ...(procStart ? { procStart } : {}),
}));
const listeners = new Map();
const mod = await import(pluginPath);
const ctx = {
  get: () => undefined,
  on: (name, fn) => { listeners.set(name, fn); return () => {}; },
  effect: () => () => {},
  loader: { entries: function* () { yield { options: { id: 'dsh-tui', config: {} } }; } },
};
await mod.apply(ctx, {});
await new Promise(resolvePromise => setTimeout(resolvePromise, 600));
listeners.get('agent/status')?.({ agent: { session: { id: sessionId } }, status: 'running' });
listeners.get('agent/status')?.({ agent: { session: { id: sessionId } }, status: 'idle' });
// Long enough for the detached BOTMUX_TURN_IDLE_COMMAND child to run and post.
await new Promise(resolvePromise => setTimeout(resolvePromise, 1500));
appendFileSync(doneFile, 'done');
`;

/** Run the REAL generated v2 plugin with a given turn-idle command string.
 *
 *  The relay capability starts at turn A (what the plugin FREEZES at the event)
 *  and the command rotates it to turn B before exec'ing the CLI — exactly the
 *  worker rotation that happens between the event and the detached child. */
async function runPlugin(opts: {
  /** Subcommand handed to the v1 CLI (the versioned one, or the bare name for
   *  the control that proves the wiring). */
  v1Subcommand: string;
  port: number;
}): Promise<{ done: boolean; output: string }> {
  const home = tmp();
  const relayDir = join(home, 'relay');
  publishRelayIdentity(relayDir, { token: FROZEN_TOKEN, turnId: FROZEN_TURN, dispatchAttempt: FROZEN_ATTEMPT });
  const rotate = join(home, 'rotate-relay.mjs');
  writeFileSync(rotate,
    'import { writeFileSync } from "node:fs";\n'
    + `const relayDir = ${JSON.stringify(relayDir)};\n`
    + 'import { join } from "node:path";\n'
    + 'writeFileSync(join(relayDir, ' + JSON.stringify(RELAY_ORIGIN_CAPABILITY_BASENAME) + '), '
    + `JSON.stringify(${JSON.stringify({ sessionId: SESSION_ID, token: LIVE_TOKEN, turnId: LIVE_TURN, dispatchAttempt: LIVE_ATTEMPT })}), { mode: 0o600 });\n`);
  const patch = ensureDshQuestionBridgePatch({
    cliId: 'dsh-tui',
    homeDir: home,
    dshTuiProfileDir: makeDshTuiProfile(home),
    hookCommand: { cmd: '/bin/true', args: [] },
    buildSalt: `version-skew-${opts.v1Subcommand}`,
  });
  expect(patch).not.toBeNull();
  const doneFile = join(home, 'driver-done');
  const driver = join(home, 'driver.mjs');
  writeFileSync(driver, DRIVER_SOURCE);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    SESSION_DATA_DIR: join(home, 'session-data'),
    BOTMUX_SESSION_ID: SESSION_ID,
    BOTMUX_CHAT_ID: 'oc-version-skew',
    BOTMUX_LARK_APP_ID: 'cli-version-skew',
    BOTMUX_SEND_RELAY: relayDir,
    BOTMUX_DAEMON_IPC_PORT: String(opts.port),
    BOTMUX_TURN_IDLE_COMMAND: `${pluginCommandFor(rotate, '')} ; exec ${pluginCommandFor(V1_CLI, opts.v1Subcommand)}`,
  };
  // No BOTMUX_TURN_ID / BOTMUX_DISPATCH_ATTEMPT: the live identity below must be
  // resolved from the CLI-pid marker, like any in-session subcommand.
  delete env.BOTMUX_TURN_ID;
  delete env.BOTMUX_DISPATCH_ATTEMPT;
  const child = spawnTsScript(
    driver,
    [
      patch!.pluginPath, home, doneFile, SESSION_ID,
      LIVE_TURN, String(LIVE_ATTEMPT),
      pathToFileURL(join(REPO_ROOT, 'src', 'utils', 'process-identity.ts')).href,
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;
  children.add(child);
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.on('data', (chunk: string) => { output += chunk; });
  await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 20_000).unref();
  });
  return { done: existsSync(doneFile), output };
}

/** The v2 argv the plugin's env command carries, applied to the v1 binary. */
function argvTailOfV2Command(): string {
  const parts = turnIdleHookCommand().split(' ');
  return parts[parts.length - 1];
}

/** A BOTMUX_TURN_IDLE_COMMAND-shaped string for a TS script, using the same
 *  runtime prefix tests use (under Node the scripts need the tsx loader). */
function pluginCommandFor(script: string, subcommand: string): string {
  const { command, prefixArgs } = tsRunnerPrefix();
  return [command, ...prefixArgs, script, ...(subcommand ? [subcommand] : [])]
    .map(part => `"${part}"`)
    .join(' ');
}

/** The real generated plugin must have reached the shell exec for the control
 *  below to mean anything; the usage banner is the old CLI's own output. */
function usedRealShowHelp(stdout: string): boolean {
  return stdout.includes('botmux v') && stdout.includes('IM ↔ AI 编程 CLI 桥接');
}

describe('turn-idle version skew (v2 plugin → v1 CLI)', () => {
  it('names a subcommand v1 cannot interpret, and the frozen v1 snapshot proves it', () => {
    expect(turnIdleHookCommand()).toMatch(/turn-idle-v2$/);
    const fixture = readFileSync(V1_CLI, 'utf8');
    // The snapshot's ONLY dispatch entry is the bare name; nothing versioned.
    expect(fixture).toContain("case 'turn-idle':");
    expect(fixture).not.toContain('turn-idle-v2');
    // …and its default branch is the REAL one: plugin lookup by exact command
    // name, then showHelp — no fabricated "unknown command" output, and no
    // request either way.
    expect(fixture).toContain('if (!await runPluginCommandByName(command, process.argv.slice(3))) showHelp();');
    expect(fixture).toContain('async function runPluginCommandByName(');
    expect(fixture).not.toContain('unknown command');
    const cli = readFileSync(join(REPO_ROOT, 'src', 'cli.ts'), 'utf8');
    // …and our CLI no longer answers the unversioned name either.
    expect(cli).toContain("case 'turn-idle-v2':");
    expect(cli).not.toContain("case 'turn-idle':");
  }, 30_000);

  it('v1 CLI receiving a v2 payload reports the LIVE (B) turn, not the frozen one — the bug', async () => {
    const home = tmp();
    const relayDir = join(home, 'relay');
    publishLiveRelayIdentity(relayDir);
    await withRecorder(async (port, received) => {
      const result = await runV1Cli(
        'turn-idle',
        v1Env(home, relayDir, port),
        JSON.stringify({ v: 2, seq: 3, pid: 4242, turnId: 'turn-a-frozen', dispatchAttempt: 1, capability: 'a'.repeat(64) }),
      );
      expect(result.status).toBe(0);
      // The frozen (turn A, attempt 1, token A) identity in the payload was
      // ignored wholesale: the report names the live generation, token included.
      // The token is the capability the daemon verifies — so this request would
      // pass the daemon's capability check AND the worker's tuple fence.
      expect(received).toEqual([{
        url: '/api/turn-idle',
        body: {
          sessionId: SESSION_ID,
          originCapability: LIVE_TOKEN,
          originTurnId: LIVE_TURN,
          originDispatchAttempt: LIVE_ATTEMPT,
          seq: 3,
          pid: 4242,
        },
      }]);
    });
  }, 30_000);

  it('v1 CLI given the v2 subcommand issues no request at all (fail closed)', async () => {
    const home = tmp();
    const relayDir = join(home, 'relay');
    publishLiveRelayIdentity(relayDir);
    await withRecorder(async (port, received) => {
      const result = await runV1Cli(
        argvTailOfV2Command(),
        v1Env(home, relayDir, port),
        JSON.stringify({ v: 2, seq: 3, pid: 4242, turnId: 'turn-a-frozen', dispatchAttempt: 1, capability: 'a'.repeat(64) }),
      );
      // Its real default branch (plugin lookup by that name → showHelp) prints
      // the usage banner and never posts.
      expect(result.status).toBe(0);
      expect(usedRealShowHelp(result.stdout), result.stdout).toBe(true);
      expect(received).toEqual([]);
    });
  }, 30_000);

  it('the real v2 plugin + a v1 CLI settles nothing: no turn-idle request reaches the daemon', async () => {
    await withRecorder(async (port, received) => {
      const run = await runPlugin({
        // The plugin execs the versioned argv against a binary that is v1.
        v1Subcommand: argvTailOfV2Command(),
        port,
      });
      expect(run.done, run.output).toBe(true);
      // The idle edge produced no report at all — B can never be settled early.
      expect(received).toEqual([]);
    });
  }, 30_000);

  it('control: the same plugin + the SAME v1 CLI under the old subcommand would report B', async () => {
    await withRecorder(async (port, received) => {
      const run = await runPlugin({
        v1Subcommand: 'turn-idle',
        port,
      });
      expect(run.done, run.output).toBe(true);
      // Proves the wiring above is live (the plugin really execs the command and
      // the snapshot really posts): only the subcommand name separates "no
      // request" from "claim the live generation".
      expect(received.map(r => r.body)).toEqual([expect.objectContaining({
        sessionId: SESSION_ID,
        originCapability: LIVE_TOKEN,
        originTurnId: LIVE_TURN,
        originDispatchAttempt: LIVE_ATTEMPT,
        seq: 1,
      })]);
    });
  }, 30_000);

  // ── provenance of the snapshot itself ──────────────────────────────────────
  /** Extract `…<marker> … }` (the first line that is exactly `}` at column 0). */
  function extractBlock(source: string, marker: string): string | null {
    const lines = source.split('\n');
    const start = lines.findIndex(line => line.startsWith(marker));
    if (start < 0) return null;
    let depth = 0;
    for (let j = start; j < lines.length; j += 1) {
      depth += (lines[j].match(/\{/g)?.length ?? 0) - (lines[j].match(/\}/g)?.length ?? 0);
      if (j > start && depth <= 0 && lines[j] === '}') return lines.slice(start, j + 1).join('\n');
    }
    return null;
  }

  /** The only rewrite the snapshot generator applies (module specifiers). */
  const SPEC_REWRITES: ReadonlyArray<readonly [string, string]> = [
    ["'./core/", "'../../src/core/"],
    ["'./services/", "'../../src/services/"],
    ["'./utils/", "'../../src/utils/"],
    ["'./global-config.js'", "'../../src/global-config.js'"],
  ];

  function hasGitObject(ref: string): boolean {
    try {
      execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: REPO_ROOT, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  const hasSnapshotRef = hasGitObject(V1_CLI_SNAPSHOT_REF);

  it.skipIf(!hasSnapshotRef)(
    `the snapshot is byte-identical to the ${V1_CLI_SNAPSHOT_REF} branches it quotes`,
    () => {
      const upstream = execFileSync('git', ['show', `${V1_CLI_SNAPSHOT_REF}:src/cli.ts`], {
        cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
      const fixture = readFileSync(V1_CLI, 'utf8');
      for (const marker of [
        'async function readStdinWithTimeout(ms: number): Promise<Buffer> {',
        'function resolveDataDir(): string {',
        'function listOnlineDaemons(): DaemonDescriptorLite[] {',
        'function findDaemon(',
        'async function postSessionScopedSignal(',
        'async function cmdTurnIdle(): Promise<void> {',
        'function readPluginRegistryCached()',
        'async function loadPluginRegistryForCommand(',
        'function printPluginUsage(): void {',
        'async function runPluginCommandByName(',
        'function getVersion(): string {',
        'function showHelp(): void {',
      ]) {
        const block = extractBlock(upstream, marker);
        expect(block, `upstream block missing: ${marker}`).not.toBeNull();
        let expected = block!;
        for (const [from, to] of SPEC_REWRITES) expected = expected.split(from).join(to);
        expect(fixture, `snapshot drifted: ${marker}`).toContain(expected);
      }
      // The dispatch branches, verbatim.
      for (const branch of [
        "  case 'turn-idle': {",
        '  default:',
        '    if (!await runPluginCommandByName(command, process.argv.slice(3))) showHelp();',
      ]) {
        expect(upstream).toContain(branch);
        expect(fixture).toContain(branch);
      }
    },
    30_000,
  );
});
