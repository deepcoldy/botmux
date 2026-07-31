/**
 * E2E test: HerdrBackend spawn, output capture, detach, re-attach, destroy.
 *
 * Runs against a real `herdr` binary in a dedicated named session so it can't
 * step on the user's default session or any in-flight bmx-* work.
 *
 * Verifies:
 *   1. spawn() creates a herdr session + botmux agent, output reaches onData
 *   2. kill() detaches the backend; the herdr session keeps running
 *   3. A fresh HerdrBackend on the same name re-attaches (no `agent start`,
 *      pane content recoverable via `pane read`)
 *   4. destroySession() actually stops the herdr session
 *   5. listBotmuxSessions() enumerates bmx-* sessions
 *
 * Requires: `herdr` on PATH. Skips otherwise.
 * Run: pnpm vitest run test/herdr-backend.e2e.ts
 */
import { describe, it, expect, afterAll, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { HerdrBackend } from '../src/adapters/backend/herdr-backend.js';

// Unique enough to never collide with anything the user has running.
const TEST_SESSION = 'bmx-e2e7777';
const TEST_TIMEOUT = 30_000;
// Keep this root short: Unix-domain socket paths are capped at ~104 bytes on
// macOS, and named Herdr sessions append /xdg/herdr/sessions/<name>/herdr.sock.
const FIXTURE_ROOT = mkdtempSync('/tmp/botmux-herdr-e2e-');
const FAKE_MANAGED_AGENT = join(FIXTURE_ROOT, 'pi');
const FIXTURE_CONFIG = join(FIXTURE_ROOT, 'config.toml');
const FIXTURE_XDG_CONFIG_HOME = join(FIXTURE_ROOT, 'xdg');
const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_HERDR_CONFIG_PATH = process.env.HERDR_CONFIG_PATH;

// All Herdr sockets, session metadata, and config reads stay inside the
// fixture. Keep HOME untouched; XDG_CONFIG_HOME/HERDR_CONFIG_PATH are the
// tool-specific isolation controls supported by Herdr.
process.env.XDG_CONFIG_HOME = FIXTURE_XDG_CONFIG_HOME;
process.env.HERDR_CONFIG_PATH = FIXTURE_CONFIG;

// Herdr >=0.7.5 only starts a known managed-agent kind. Keep this E2E
// independent of any real coding-agent install by presenting a canonical
// `pi` executable whose process is still just /bin/bash. HERDR_AGENT is
// Herdr's cross-platform process identity hint, so the facade can verify that
// the lightweight fixture is the requested managed agent.
writeFileSync(FAKE_MANAGED_AGENT, `#!/bin/bash
export HERDR_AGENT=pi
herdr pane report-agent "$HERDR_PANE_ID" \\
  --source custom:botmux-e2e --agent pi --state idle >/dev/null 2>&1
/bin/bash "$@"
`);
chmodSync(FAKE_MANAGED_AGENT, 0o700);
writeFileSync(FIXTURE_CONFIG, `[terminal]
default_shell = "/bin/sh"
shell_mode = "non_login"
`);

afterAll(() => {
  hardResetSession(TEST_SESSION);
  if (ORIGINAL_XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = ORIGINAL_XDG_CONFIG_HOME;
  if (ORIGINAL_HERDR_CONFIG_PATH === undefined) delete process.env.HERDR_CONFIG_PATH;
  else process.env.HERDR_CONFIG_PATH = ORIGINAL_HERDR_CONFIG_PATH;
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

/**
 * Hard reset for a test session. `herdr session stop` is asynchronous and
 * leaves agent metadata behind in the session dir — subsequent `agent start`
 * calls then fail with `agent_name_taken`. We follow `stop` with a forced
 * sessions-dir wipe so each test sees a truly clean slate.
 */
function hardResetSession(name: string) {
  HerdrBackend.killSession(name);
  rmSync(join(FIXTURE_XDG_CONFIG_HOME, 'herdr', 'sessions', name), { recursive: true, force: true });
}

function spawnOpts() {
  return {
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    env: {
      ...process.env,
      HERDR_CONFIG_PATH: FIXTURE_CONFIG,
      PATH: [FIXTURE_ROOT, process.env.PATH].filter(Boolean).join(delimiter),
    } as Record<string, string>,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

describe('HerdrBackend (e2e)', () => {
  beforeEach(() => {
    hardResetSession(TEST_SESSION);
  });

  afterEach(() => {
    hardResetSession(TEST_SESSION);
  });

  it.skipIf(!HerdrBackend.isAvailable())('spawn captures output from a live herdr agent', async () => {
    const backend = new HerdrBackend(TEST_SESSION);
    const output: string[] = [];
    backend.onData(d => output.push(d));

    backend.spawn(FAKE_MANAGED_AGENT, ['-lc', 'echo HELLO_HERDR; sleep 30'], spawnOpts());

    await waitFor(() => output.join('').includes('HELLO_HERDR'), 10_000, 'HELLO_HERDR in output');
    expect(output.join('')).toContain('HELLO_HERDR');
    expect(HerdrBackend.hasSession(TEST_SESSION)).toBe(true);
    expect(backend.isReattach).toBe(false);

    backend.kill();
    // kill() only tears down the backend's observers; the herdr session and
    // its agent process must outlive a detach so daemon restarts can resume.
    expect(HerdrBackend.hasSession(TEST_SESSION)).toBe(true);
  }, TEST_TIMEOUT);

  it.skipIf(!HerdrBackend.isAvailable())('re-attach observes the same agent without spawning a new one', async () => {
    // Phase 1: create the session and let it produce a marker line.
    const be1 = new HerdrBackend(TEST_SESSION);
    const out1: string[] = [];
    be1.onData(d => out1.push(d));
    be1.spawn(FAKE_MANAGED_AGENT, ['-lc', 'echo PHASE1_MARKER; sleep 30'], spawnOpts());
    await waitFor(() => out1.join('').includes('PHASE1_MARKER'), 10_000, 'PHASE1_MARKER');
    be1.kill();
    expect(HerdrBackend.hasSession(TEST_SESSION)).toBe(true);

    // Phase 2: a second backend attaches to the same session. It must NOT
    // start a fresh `bash` (the bin/args are ignored on reuse), and it
    // should see PHASE1_MARKER on its first `pane read --source recent`.
    const be2 = new HerdrBackend(TEST_SESSION, { isReattach: true });
    const out2: string[] = [];
    be2.onData(d => out2.push(d));
    be2.spawn(FAKE_MANAGED_AGENT, ['-lc', 'echo SHOULD_NOT_RUN'], spawnOpts());
    expect(be2.isReattach).toBe(true);

    // Read recent pane content via the backend's capture API. Don't gate on
    // onData here — the second backend snapshots last-text at spawn time so
    // the marker shows up in captureCurrentScreen, not the delta stream.
    await waitFor(() => {
      const screen = be2.captureCurrentScreen();
      return screen.includes('PHASE1_MARKER') && !screen.includes('SHOULD_NOT_RUN');
    }, 10_000, 'pane recent contains PHASE1 but not SHOULD_NOT_RUN');

    be2.destroySession();
    await waitFor(() => !HerdrBackend.hasSession(TEST_SESSION), 10_000, 'session torn down');
  }, TEST_TIMEOUT);

  it.skipIf(!HerdrBackend.isAvailable())('restart: destroySession() then a fresh spawn on the same name runs the NEW CLI', async () => {
    // Regression for the /restart no-op: destroySession() does `session stop`,
    // but herdr persists the session dir and resurrects a dead `botmux` agent
    // row when the server reboots. The old code reused that zombie row and
    // skipped `agent start`, so the resume:true respawn never ran the new CLI
    // (the pane showed only a shell prompt). Fix: killSession() now deletes the
    // session, and a NON-reattach spawn always `agent start`s.
    const be1 = new HerdrBackend(TEST_SESSION);
    be1.spawn(FAKE_MANAGED_AGENT, ['-lc', 'echo FIRST_CLI; sleep 30'], spawnOpts());
    await waitFor(() => be1.captureCurrentScreen().includes('FIRST_CLI'), 10_000, 'FIRST_CLI ran');

    // /restart: tear the session down, then a fresh (non-reattach) spawn.
    be1.destroySession();
    await waitFor(() => !HerdrBackend.hasSession(TEST_SESSION), 10_000, 'session destroyed');

    const be2 = new HerdrBackend(TEST_SESSION, { createSession: true });
    be2.spawn(FAKE_MANAGED_AGENT, ['-lc', 'echo SECOND_CLI; sleep 30'], spawnOpts());
    expect(be2.isReattach).toBe(false);

    // The new CLI must actually run: its marker appears, and the stale one is
    // gone (we started a brand-new pane, not the resurrected dead row).
    await waitFor(() => {
      const screen = be2.captureCurrentScreen();
      return screen.includes('SECOND_CLI') && !screen.includes('FIRST_CLI');
    }, 12_000, 'SECOND_CLI ran on a fresh pane (not the resurrected FIRST row)');

    be2.destroySession();
    await waitFor(() => !HerdrBackend.hasSession(TEST_SESSION), 10_000, 'session torn down');
  }, TEST_TIMEOUT);

  it.skipIf(!HerdrBackend.isAvailable())('write() routes input to the pane and the shell echoes it back', async () => {
    const backend = new HerdrBackend(TEST_SESSION);
    backend.spawn(FAKE_MANAGED_AGENT, ['-lc', 'cat'], spawnOpts());
    await waitFor(() => HerdrBackend.hasSession(TEST_SESSION), 10_000, 'session up');

    const seen: string[] = [];
    backend.onData(d => seen.push(d));

    // `cat` echoes stdin to stdout — verifies the full write→pane→read loop.
    // PTY line discipline submits on CR (Enter), not LF — use sendSpecialKeys
    // for the Enter so the line is actually delivered to cat's stdin.
    backend.write('PING_FROM_BOTMUX');
    backend.sendSpecialKeys('Enter');

    await waitFor(() => seen.join('').includes('PING_FROM_BOTMUX'), 10_000, 'cat echoed input');
    expect(seen.join('')).toContain('PING_FROM_BOTMUX');

    backend.destroySession();
  }, TEST_TIMEOUT);

  it.skipIf(!HerdrBackend.isAvailable())('web attach resizes the real agent terminal', async () => {
    const backend = new HerdrBackend(TEST_SESSION);
    backend.spawn(FAKE_MANAGED_AGENT, ['-lc', `trap 'printf "SIZE "; stty size' WINCH; echo READY; while :; do sleep 0.1; done`], spawnOpts());
    await waitFor(() => backend.captureCurrentScreen().includes('READY'), 10_000, 'resize fixture ready');

    const viewer = {};
    backend.acquireWebTerminal(viewer);
    backend.resizeWebTerminal(viewer, 80, 24);
    await waitFor(() => backend.captureCurrentScreen().includes('SIZE 24 80'), 10_000, 'initial 80x24 WINCH');

    backend.resizeWebTerminal(viewer, 150, 42);
    await waitFor(() => backend.captureCurrentScreen().includes('SIZE 42 150'), 10_000, 'resized 150x42 WINCH');

    backend.releaseWebTerminal(viewer);
    expect(HerdrBackend.hasSession(TEST_SESSION)).toBe(true);
    backend.destroySession();
  }, TEST_TIMEOUT);

  it.skipIf(!HerdrBackend.isAvailable())('destroySession stops the herdr session', async () => {
    const backend = new HerdrBackend(TEST_SESSION);
    backend.spawn(FAKE_MANAGED_AGENT, ['-lc', 'sleep 30'], spawnOpts());
    await waitFor(() => HerdrBackend.hasSession(TEST_SESSION), 10_000, 'session up');

    backend.destroySession();
    await waitFor(() => !HerdrBackend.hasSession(TEST_SESSION), 10_000, 'session gone');
    expect(HerdrBackend.hasSession(TEST_SESSION)).toBe(false);
  }, TEST_TIMEOUT);

  it.skipIf(!HerdrBackend.isAvailable())('listBotmuxSessions enumerates running bmx-* sessions', async () => {
    const backend = new HerdrBackend(TEST_SESSION);
    backend.spawn(FAKE_MANAGED_AGENT, ['-lc', 'sleep 30'], spawnOpts());
    await waitFor(() => HerdrBackend.listBotmuxSessions().includes(TEST_SESSION), 10_000, 'session listed');
    expect(HerdrBackend.listBotmuxSessions()).toContain(TEST_SESSION);
    backend.destroySession();
  }, TEST_TIMEOUT);

  it.skipIf(!HerdrBackend.isAvailable())('onExit fires after the agent process exits', async () => {
    const backend = new HerdrBackend(TEST_SESSION);
    const exits: Array<[number | null, string | null]> = [];
    backend.onExit((code, signal) => exits.push([code, signal]));

    // Herdr 0.7.5 deliberately requires a 3s stable/interactive window before
    // `agent start` returns. Exit immediately after that window, then verify
    // the bg `wait agent-status` / 500ms poll observes the disappearance.
    backend.spawn(FAKE_MANAGED_AGENT, ['-lc', 'echo BYE; sleep 4; exit 0'], spawnOpts());

    await waitFor(() => exits.length > 0, 15_000, 'onExit fired');
    expect(exits.length).toBeGreaterThan(0);

    backend.destroySession();
  }, TEST_TIMEOUT);
});

// Sanity preflight — fail loudly if `herdr` is wedged so the .skipIf above
// doesn't silently mask a broken environment.
describe('herdr binary smoke check', () => {
  it('reports a version via --version', () => {
    if (!HerdrBackend.isAvailable()) return;
    const out = execFileSync('herdr', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    expect(out).toMatch(/herdr\s+\d+\.\d+/i);
  });
});
