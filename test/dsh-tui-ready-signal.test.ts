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
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';
import { TURN_IDLE_PROTOCOL_VERSION } from '../src/utils/turn-idle-report.js';
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
const [pluginPath, homeDir, readyCountFile, doneFile, injectPidArg, sessionId, statusScript, staleSessionId] = process.argv.slice(2);
const injectDir = homeDir + '/.dsh-tui/inject';
mkdirSync(injectDir, { recursive: true });
function publishRecord(pid, sid, startedAt) {
  writeFileSync(injectDir + '/servers.json', JSON.stringify([{
    pid,
    sessionId: sid,
    cwd: homeDir,
    socketPath: injectDir + '/' + sid + '.sock',
    startedAt: startedAt === undefined ? Date.now() : startedAt,
  }]));
}
if (injectPidArg === 'stale-then-self') {
  // PID reuse: OUR pid, but the record was published by a previous process for
  // a previous session. The birth stamp must reject it.
  publishRecord(process.pid, staleSessionId || 'stale-session', 1);
} else if (injectPidArg === 'rebind') {
  // A record of ours that is NOT the session the agent reports (dsh-tui
  // restarted its server / republished): binding once would filter out the real
  // event forever.
  publishRecord(process.pid, staleSessionId || 'superseded-session');
} else {
  publishRecord(injectPidArg === 'self' ? process.pid : Number(injectPidArg), sessionId);
}
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
if (injectPidArg === 'rebind' || injectPidArg === 'stale-then-self') {
  // The real TUI record finally shows up for the same pid.
  publishRecord(process.pid, sessionId);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
}
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
  /** Raw bridge payloads the turn-idle command received, one JSON object each. */
  idlePayloads: Array<Record<string, unknown>>;
}

async function runReadyDriver(opts: {
  home: string;
  injectPid: string;
  botmuxSessionEnv: boolean;
  statusScript?: string;
  staleSessionId?: string;
  /** Frozen dispatch identity the worker published for the executing turn. */
  publishedTurn?: { turnId: string; dispatchAttempt?: number };
  /** Per-dispatch relay token + tuple (isolated transport), when enabled. */
  relayIdentity?: { token: string; turnId: string; dispatchAttempt?: number; sessionId?: string };
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

  const sessionId = 'sess-ready-signal';
  const dataDir = join(opts.home, 'session-data');
  const relayDir = join(opts.home, 'relay');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(relayDir, { recursive: true });
  if (opts.publishedTurn) {
    const identityDir = join(dataDir, 'cli-identity', `${sessionId}.bin`, '.data');
    mkdirSync(identityDir, { recursive: true });
    writeFileSync(
      join(identityDir, 'turn.json'),
      JSON.stringify(opts.publishedTurn),
      { mode: 0o600 },
    );
  }
  if (opts.relayIdentity) {
    writeFileSync(
      join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({
        sessionId: opts.relayIdentity.sessionId ?? sessionId,
        token: opts.relayIdentity.token,
        turnId: opts.relayIdentity.turnId,
        ...(opts.relayIdentity.dispatchAttempt !== undefined
          ? { dispatchAttempt: opts.relayIdentity.dispatchAttempt }
          : {}),
      }),
      { mode: 0o600 },
    );
  }

  const readyCountFile = join(opts.home, 'ready-count');
  const readyCommand = makeExecutable(
    join(opts.home, 'ready-command.mjs'),
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(readyCountFile)}, 'x');\n`,
  );
  const idlePayloadFile = join(opts.home, 'idle-payloads');
  const idleCommand = makeExecutable(
    join(opts.home, 'idle-command.mjs'),
    'import { appendFileSync, readFileSync } from "node:fs";\n'
      + `appendFileSync(${JSON.stringify(idlePayloadFile)}, readFileSync(0, "utf8") + "\\n");\n`,
  );
  const doneFile = join(opts.home, 'driver-done');
  const driver = join(opts.home, 'driver.mjs');
  writeFileSync(driver, DRIVER_SOURCE);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: opts.home,
    USERPROFILE: opts.home,
    SESSION_DATA_DIR: dataDir,
    BOTMUX_READY_COMMAND: `"${process.execPath}" "${readyCommand}"`,
    BOTMUX_TURN_IDLE_COMMAND: `"${process.execPath}" "${idleCommand}"`,
  };
  if (opts.relayIdentity) env.BOTMUX_SEND_RELAY = relayDir;
  else delete env.BOTMUX_SEND_RELAY;
  if (opts.botmuxSessionEnv) {
    env.BOTMUX_SESSION_ID = sessionId;
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
      opts.staleSessionId ?? '',
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
  const idleText = existsSync(idlePayloadFile) ? readFileSync(idlePayloadFile, 'utf8') : '';
  const idlePayloads = idleText.split('\n').filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>);
  return { readyLines: [...readyText], idlePayloads };
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
      publishedTurn: { turnId: 'published-turn', dispatchAttempt: 3 },
    });
    // The duplicate idle is a no-op (agent/status only fires on a transition),
    // so exactly the two real turn ends report — each with the frozen pair.
    // Each report is delivered by its OWN detached child (the plugin spawns one
    // `botmux turn-idle` per edge), so the order those two appends land in the
    // shared file is a scheduling artifact, not the report order: the reporter
    // counted seq 1 then 2, and the file has been observed holding [2, 1]
    // (same pid) on an idle machine. Order the raw file by seq before comparing.
    expect([...run.idlePayloads].sort((a, b) => (a.seq as number) - (b.seq as number))).toEqual([
      {
        v: TURN_IDLE_PROTOCOL_VERSION,
        seq: 1,
        pid: expect.any(Number),
        turnId: 'published-turn',
        dispatchAttempt: 3,
      },
      {
        v: TURN_IDLE_PROTOCOL_VERSION,
        seq: 2,
        pid: expect.any(Number),
        turnId: 'published-turn',
        dispatchAttempt: 3,
      },
    ]);
  }, 30_000);

  it('never reports a sibling agent mounted in the same TUI process', async () => {
    const home = tmp();
    const run = await runReadyDriver({
      home,
      injectPid: 'self',
      botmuxSessionEnv: true,
      statusScript: 'some-other-session:running,some-other-session:idle',
      publishedTurn: { turnId: 'published-turn' },
    });
    expect(run.idlePayloads).toEqual([]);
  });

  it('never reports before the inject record binds this process to a session', async () => {
    const home = tmp();
    const run = await runReadyDriver({
      home,
      injectPid: '999999',
      botmuxSessionEnv: true,
      statusScript: 'owner:running,owner:idle',
      publishedTurn: { turnId: 'published-turn' },
    });
    expect(run.idlePayloads).toEqual([]);
  });

  it('freezes the per-dispatch relay identity at the event, token included', async () => {
    const home = tmp();
    const run = await runReadyDriver({
      home,
      injectPid: 'self',
      botmuxSessionEnv: true,
      statusScript: 'owner:running,owner:idle',
      // Both sources are present with DIFFERENT values: the relay (isolated
      // transport) carries the generation's own token and must win, so the claim
      // is bound to the generation it was minted for.
      publishedTurn: { turnId: 'stale-published-turn', dispatchAttempt: 3 },
      relayIdentity: { token: 'c'.repeat(64), turnId: 'relay-turn', dispatchAttempt: 5 },
    });
    expect(run.idlePayloads).toEqual([{
      v: TURN_IDLE_PROTOCOL_VERSION,
      seq: 1,
      pid: expect.any(Number),
      turnId: 'relay-turn',
      dispatchAttempt: 5,
      capability: 'c'.repeat(64),
    }]);
  }, 30_000);

  it('falls back to the published turn file when no relay token is available', async () => {
    const home = tmp();
    const run = await runReadyDriver({
      home,
      injectPid: 'self',
      botmuxSessionEnv: true,
      statusScript: 'owner:running,owner:idle',
      publishedTurn: { turnId: 'published-turn', dispatchAttempt: 3 },
    });
    // No capability: the daemon still binds the claim to the origin its live
    // token names before forwarding.
    expect(run.idlePayloads).toEqual([{
      v: TURN_IDLE_PROTOCOL_VERSION,
      seq: 1,
      pid: expect.any(Number),
      turnId: 'published-turn',
      dispatchAttempt: 3,
    }]);
  });

  it('stays silent when no frozen identity is readable (never claims a live marker)', async () => {
    const home = tmp();
    const run = await runReadyDriver({
      home,
      injectPid: 'self',
      botmuxSessionEnv: true,
      statusScript: 'owner:running,owner:idle',
    });
    // Nothing to freeze ⇒ no report. Re-reading the worker's marker inside the
    // detached child would be exactly the "claim the NEXT turn" bug.
    expect(run.idlePayloads).toEqual([]);
  });

  it('ignores a pid-reuse discovery record and binds the real one', async () => {
    const home = tmp();
    const run = await runReadyDriver({
      home,
      injectPid: 'stale-then-self',
      botmuxSessionEnv: true,
      staleSessionId: 'previous-process-session',
      statusScript: 'owner:running,owner:idle',
      publishedTurn: { turnId: 'published-turn' },
    });
    // Exactly one ready exec: the ancient record for our pid is not ours, and the
    // real record (published afterwards) is what releases the gate.
    expect(run.readyLines).toEqual(['x']);
    expect(run.idlePayloads.map(payload => payload.turnId)).toEqual(['published-turn']);
  }, 30_000);

  it('re-binds when the real discovery record supersedes a claimed one', async () => {
    const home = tmp();
    const run = await runReadyDriver({
      home,
      injectPid: 'rebind',
      botmuxSessionEnv: true,
      staleSessionId: 'superseded-session',
      statusScript: 'owner:running,owner:idle',
      publishedTurn: { turnId: 'published-turn' },
    });
    // The process first claimed a record naming another session; a one-shot
    // binding would filter out every real agent/status event afterwards.
    expect(run.idlePayloads.map(payload => payload.turnId)).toEqual(['published-turn']);
  }, 30_000);

  it('interpolates the shared protocol version and relay path into the plugin', () => {
    const home = tmp();
    const patch = ensureDshQuestionBridgePatch({
      cliId: 'dsh-tui',
      homeDir: home,
      dshTuiProfileDir: makeDshTuiProfile(home),
      hookCommand: { cmd: '/bin/true', args: [] },
      buildSalt: 'protocol-drift-guard',
    })!;
    const plugin = readFileSync(patch.pluginPath, 'utf8');
    // Both sides of the wire read the same constant / path layout: a drift here
    // would make the CLI drop every report (or read a foreign file).
    expect(plugin).toContain(`const BOTMUX_TURN_IDLE_PROTOCOL = ${TURN_IDLE_PROTOCOL_VERSION};`);
    expect(plugin).toContain(JSON.stringify(RELAY_ORIGIN_CAPABILITY_BASENAME));
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
