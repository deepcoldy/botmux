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
 * bare `turn-idle`. `turn-idle-v2` falls through to its default branch (no
 * request at all), so the skew degrades to "no idle edge" — the safe direction.
 * `test/fixtures/v1-turn-idle-cli.mjs` is the frozen v1 snapshot that pins both
 * halves of that: the payload-ignoring read, and the unknown-subcommand branch.
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDshQuestionBridgePatch } from '../src/adapters/dsh-question-bridge.js';
import { turnIdleHookCommand } from '../src/adapters/hook-command.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V1_CLI = join(REPO_ROOT, 'test', 'fixtures', 'v1-turn-idle-cli.mjs');
const SESSION_ID = 'sess-version-skew';
/** The dispatch that is LIVE when the detached child runs (turn B). */
const LIVE_TURN = 'turn-b-live';
const LIVE_ATTEMPT = 7;
const LIVE_TOKEN = 'b'.repeat(64);

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

/** The worker's live publication at exec time: relay token + turn/attempt. */
function publishLiveRelayIdentity(relayDir: string): void {
  mkdirSync(relayDir, { recursive: true });
  writeFileSync(
    join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
    JSON.stringify({ sessionId: SESSION_ID, token: LIVE_TOKEN, turnId: LIVE_TURN, dispatchAttempt: LIVE_ATTEMPT }),
    { mode: 0o600 },
  );
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
const [pluginPath, homeDir, doneFile, sessionId] = process.argv.slice(2);
const injectDir = homeDir + '/.dsh-tui/inject';
mkdirSync(injectDir, { recursive: true });
// Our own record, published before the plugin loads (as dsh-tui does right
// after the first frame): the plugin binds to it and may report turn idle.
writeFileSync(injectDir + '/servers.json', JSON.stringify([{
  pid: process.pid, sessionId, cwd: homeDir, socketPath: injectDir + '/' + sessionId + '.sock', startedAt: Date.now(),
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
await new Promise(resolvePromise => setTimeout(resolvePromise, 600));
listeners.get('agent/status')?.({ agent: { session: { id: sessionId } }, status: 'running' });
listeners.get('agent/status')?.({ agent: { session: { id: sessionId } }, status: 'idle' });
// Long enough for the detached BOTMUX_TURN_IDLE_COMMAND child to run and post.
await new Promise(resolvePromise => setTimeout(resolvePromise, 1500));
appendFileSync(doneFile, 'done');
`;

/** Run the REAL generated v2 plugin with a given turn-idle command string. */
async function runPlugin(opts: {
  command: string;
  port: number;
}): Promise<{ done: boolean; output: string }> {
  const home = tmp();
  const relayDir = join(home, 'relay');
  publishLiveRelayIdentity(relayDir);
  const patch = ensureDshQuestionBridgePatch({
    cliId: 'dsh-tui',
    homeDir: home,
    dshTuiProfileDir: makeDshTuiProfile(home),
    hookCommand: { cmd: '/bin/true', args: [] },
    buildSalt: `version-skew-${opts.command.length}`,
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
    BOTMUX_TURN_IDLE_COMMAND: opts.command,
  };
  const child = spawnTsScript(
    driver,
    [patch!.pluginPath, home, doneFile, SESSION_ID],
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

describe('turn-idle version skew (v2 plugin → v1 CLI)', () => {
  it('names a subcommand v1 cannot interpret, and the frozen v1 snapshot proves it', () => {
    expect(turnIdleHookCommand()).toMatch(/turn-idle-v2$/);
    const fixture = readFileSync(V1_CLI, 'utf8');
    // The snapshot's ONLY dispatch entry is the bare name; nothing versioned.
    expect(fixture).toContain("case 'turn-idle':");
    expect(fixture).not.toContain('turn-idle-v2');
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
      // Its default branch (upstream: plugin lookup by that name → showHelp)
      // prints usage and never posts.
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('unknown command: turn-idle-v2');
      expect(received).toEqual([]);
    });
  }, 30_000);

  it('the real v2 plugin + a v1 CLI settles nothing: no turn-idle request reaches the daemon', async () => {
    await withRecorder(async (port, received) => {
      const run = await runPlugin({
        // The plugin execs the versioned argv against a binary that is v1.
        command: `"${process.execPath}" "${V1_CLI}" ${argvTailOfV2Command()}`,
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
        command: `"${process.execPath}" "${V1_CLI}" turn-idle`,
        port,
      });
      expect(run.done, run.output).toBe(true);
      // Proves the wiring above is live (the plugin really execs the command and
      // the fixture really posts): only the subcommand name separates "no
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

  it('keeps the v1 snapshot executable by construction (it is a real file)', () => {
    chmodSync(V1_CLI, 0o755);
    expect(existsSync(V1_CLI)).toBe(true);
  });
});
