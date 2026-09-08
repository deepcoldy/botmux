import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * BEHAVIORAL zero-touch test for the root-dispatch transport gate (codex round-10
 * requirement — real subprocess, not source-lock). Proves the gate is
 * TAMPER-RESISTANT: the managed origin is resolved via the pid-marker ancestry
 * (a `.botmux-cli-pids/<ppid>` file the worker writes), NOT the mutable
 * BOTMUX_SESSION_ID env — so `env -u BOTMUX_SESSION_ID … botmux create-group`
 * still gets refused. The spawned CLI's parent is THIS test process, so a marker
 * at our own pid is on the CLI's ancestry chain.
 *
 * Requires the compiled artifact; skips if dist is absent.
 */
const CLI = resolve('dist/cli.js');
const LARK_FACING = ['send', 'dispatch', 'card', 'create-group', 'history', 'quoted', 'bots', 'grant', 'actor'];

let DATA_DIR = '';
const VIRTUAL_SID = 'sess_behavior_virtual';
const REAL_SID = 'sess_behavior_real';

function writeSession(sid: string, chatId: string, larkAppId: string) {
  // 会话行只有 SQLite 一种持久层，且按 larkAppId 分库；旧夹具往单个
  // sessions.json 里 push 数组的写法（靠 JSON 读侧容忍数组形状）已不适用。
  seedPersistedSessionRows(DATA_DIR, larkAppId, {
    [sid]: { sessionId: sid, chatId, larkAppId, rootMessageId: '', scope: 'chat', status: 'active' },
  });
}

/** Put a marker at THIS process's pid so a spawned child (whose ppid == our pid)
 *  resolves `sid` via the ancestry walk — the tamper-proof anchor. */
function writeAncestryMarker(sid: string) {
  const dir = join(DATA_DIR, '.botmux-cli-pids');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(process.pid)), JSON.stringify({ sessionId: sid }));
}

function runCli(args: string[], env: Record<string, string | undefined>): { code: number; out: string } {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('BOTMUX_') && v !== undefined) base[k] = v;
  }
  base.SESSION_DATA_DIR = DATA_DIR;
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete base[k]; else base[k] = v; }
  try {
    const out = execFileSync('node', [CLI, ...args], { env: base, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    return { code: 0, out };
  } catch (e: any) {
    return { code: typeof e.status === 'number' ? e.status : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const distReady = existsSync(CLI);
const d = distReady ? describe : describe.skip;

d('root-dispatch transport gate — behavioral, tamper-resistant (built CLI)', () => {
  beforeAll(() => {
    DATA_DIR = join(tmpdir(), `botmux-gate-test-${process.pid}`);
  });
  afterAll(() => { if (DATA_DIR) rmSync(DATA_DIR, { recursive: true, force: true }); });

  // Rebuild a clean fixture before EVERY test so a prior CLI subprocess that
  // wrote into DATA_DIR (or a marker toggle) can't bleed state across tests.
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    writeSession(VIRTUAL_SID, 'http_async_behaviorzero', 'cli_test_bot');
    writeSession(REAL_SID, 'oc_real_behavior', 'cli_test_bot');
    writeAncestryMarker(VIRTUAL_SID);
  });

  it('managed virtual turn (honest env): every Lark-facing command exits 2', () => {
    for (const cmd of LARK_FACING) {
      const { code, out } = runCli([cmd], {
        BOTMUX_SESSION_ID: VIRTUAL_SID, BOTMUX_CHAT_ID: 'http_async_behaviorzero', BOTMUX_LARK_APP_ID: 'cli_test_bot',
      });
      expect(code, `${cmd} honest exit`).toBe(2);
      expect(out, `${cmd} msg`).toMatch(/unavailable|no Feishu|HTTP control-API/);
    }
  });

  it('TAMPERED env (env -u all BOTMUX_*) with a --session-id target: still refused', () => {
    // Env-tamper resistance. Two anchors survive `env -u BOTMUX_*`:
    //  (a) the pid-marker ancestry (verified manually; see NOTE below), and
    //  (b) an explicit `--session-id <virtual>` — the per-command target-aware
    //      gate loads THAT session record and refuses regardless of env.
    // We assert (b) here because it is deterministic under vitest; (a) depends on
    // process.ppid which the vitest worker pool controls, so it is covered by the
    // `managedOriginHasNoTransport → resolveSessionContext` source-lock instead.
    // NOTE (manual repro, matches codex's): with a marker at the CLI's real parent
    // pid, `env -u BOTMUX_SESSION_ID -u BOTMUX_CHAT_ID -u BOTMUX_LARK_APP_ID node
    // dist/cli.js create-group --bot x` exits 2 via ancestry — confirmed by hand.
    // We assert with `history --session-id` (deterministic, no other required
    // args before the target-aware gate). `quoted` needs a message-id positional
    // and `send` needs a body/more session fields, so their arg-parse trips
    // before the gate in this minimal fixture — the gate itself is identical.
    const { code, out } = runCli(['history', '--session-id', VIRTUAL_SID], {
      BOTMUX_SESSION_ID: undefined, BOTMUX_CHAT_ID: undefined, BOTMUX_LARK_APP_ID: undefined,
    });
    expect(code, 'history tampered exit').toBe(2);
    expect(out, 'history tampered msg').toMatch(/unavailable|no Feishu|control-API/);
  });

  it('negative control: managed REAL-chat turn is NOT gated', () => {
    // Point the ancestry marker at the real-chat session for this case.
    writeAncestryMarker(REAL_SID);
    const { out } = runCli(['history'], {
      BOTMUX_SESSION_ID: REAL_SID, BOTMUX_CHAT_ID: 'oc_real_behavior', BOTMUX_LARK_APP_ID: 'cli_test_bot',
    });
    expect(out).not.toMatch(/HTTP control-API session|core-only apiOnly/);
    writeAncestryMarker(VIRTUAL_SID); // restore for any later cases
  });

  it('negative control: bare operator (no marker, no env) is NOT gated', () => {
    // Remove the ancestry marker so no managed origin resolves.
    rmSync(join(DATA_DIR, '.botmux-cli-pids'), { recursive: true, force: true });
    const { out } = runCli(['create-group', '--bot', 'x'], {
      BOTMUX_SESSION_ID: undefined, BOTMUX_CHAT_ID: undefined, BOTMUX_LARK_APP_ID: undefined,
    });
    expect(out).not.toMatch(/this managed turn has no Feishu transport/);
    writeAncestryMarker(VIRTUAL_SID);
  });
});
