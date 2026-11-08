/**
 * Codex App under credential-only bwrap with a SYMLINKED $HOME (board #86,
 * point 5). Real worker, real credential-only bwrap, real codex-app runner
 * (dist/codex-app-runner.js) against the fake app-server.
 *
 * The worker hands the runner its control bootstrap path in the lexical form
 * of SESSION_DATA_DIR (`<home-link>/.botmux/data/...`). That is only correct
 * because the credential-only flavour binds `/` as-is, so the host symlink
 * exists inside the pane too; the full oncall/scratch file sandboxes (fresh
 * root, canonical binds only) refuse codex-app on Linux before spawning
 * (`codex_app_file_sandbox_unsupported`). This test pins that the lexical
 * path keeps resolving: if a change hid or dropped the link inside the pane,
 * the runner could not consume its bootstrap and never authenticate.
 *
 * Starts a real sandbox, so it needs a host where bwrap can create user +
 * PID namespaces: CI enables bwrap on the runner (see the bwrap setup step in
 * .github/workflows/ci.yml), where both cases really execute; a nested
 * isolate-run additionally needs a spare procfs mounted first (its own PID
 * namespace cannot provide bwrap's inner `--proc`), and without that the
 * suite skips on the host-side namespace probe.
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { probeHostCredentialIsolationMechanism } from '../src/adapters/backend/sandbox.js';
import { MANAGED_TMUX_SOCKET_ENV } from '../src/adapters/backend/tmux-socket.js';
import { deviceCredentialIsolationMarkerPath } from '../src/adapters/cli/read-isolation.js';

const runnerPath = resolve('dist/codex-app-runner.js');
const credentialOnlyBwrap = process.platform === 'linux'
  && probeHostCredentialIsolationMechanism().mechanism === 'bwrap';
// Test-private tmux server: cleanup may kill exactly this server and nothing else.
const tmuxSocket = `botmux-p5-${process.pid}`;

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...children].map(child => new Promise<void>(done => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    child.once('exit', () => { clearTimeout(timer); done(); });
    if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
    else child.kill('SIGTERM');
  })));
  children.clear();
  try { execFileSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch { /* never started */ }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function waitFor(logs: string[], predicate: () => boolean, timeoutMs = 40_000): Promise<void> {
  return new Promise((done, fail) => {
    const poll = setInterval(() => {
      if (!predicate()) return;
      clearInterval(poll); clearTimeout(timer); done();
    }, 20);
    const timer = setTimeout(() => { clearInterval(poll); fail(new Error(`timed out\n${logs.join('')}`)); }, timeoutMs);
  });
}

describe.skipIf(!credentialOnlyBwrap)(
  'Codex App on a symlinked HOME under credential-only bwrap',
  () => {
    // A missing build is a harness error, not an unsupported host: fail loudly
    // like the other dist/-dependent suites instead of silently skipping.
    beforeAll(() => {
      if (!existsSync(runnerPath)) {
        throw new Error('dist/codex-app-runner.js missing — run `bun run build` first');
      }
    });

    it.each(['pty', 'tmux'] as const)('%s authenticates the runner and completes a turn', async backendType => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-p5-home-')));
      tempDirs.add(base);
      const realHome = join(base, 'real-home');
      const dataDir = join(realHome, '.botmux', 'data');
      mkdirSync(dataDir, { recursive: true });
      const linkHome = join(base, 'home-link');
      symlinkSync(realHome, linkHome);
      expect(realpathSync(linkHome)).not.toBe(linkHome);
      // Device enrollment marker: every new local CLI must run credential-only.
      // Deliberately EMPTY: the worker only lstat()s this path, so an empty or
      // unparseable marker still means "enrolled" (fail closed) — do not replace
      // it with a well-formed pending marker, which would probe a different rule.
      writeFileSync(deviceCredentialIsolationMarkerPath(linkHome), '');
      const fakeCodex = join(base, 'fake-codex');
      copyFileSync(resolve('test/fixtures/fake-codex-app-server.mjs'), fakeCodex);
      chmodSync(fakeCodex, 0o755);
      const pidPath = join(base, 'app-server.pid');
      const lexicalDataDir = join(linkHome, '.botmux', 'data');
      const sessionId = `${randomBytes(4).toString('hex')}-p5-${process.pid}-${Date.now()}`;

      const logs: string[] = [];
      const messages: WorkerToDaemon[] = [];
      const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          HOME: linkHome,
          NODE_ENV: 'test',
          NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=tsx'].filter(Boolean).join(' '),
          BOTMUX_TEST_CODEX_APP_RUNNER_PATH: runnerPath,
          [MANAGED_TMUX_SOCKET_ENV]: tmuxSocket,
          SESSION_DATA_DIR: lexicalDataDir,
          BOTMUX_SESSION_ID: sessionId,
          LARK_APP_ID: 'app_p5_symlinked_home',
          LARK_APP_SECRET: 'secret',
          FAKE_CODEX_LOG: join(base, 'requests.jsonl'),
          FAKE_CODEX_VERSION: '0.136.0',
          FAKE_CODEX_BEHAVIOR: 'success',
          FAKE_CODEX_PID_PATH: pidPath,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.add(child);
      child.stdout?.on('data', chunk => logs.push(chunk.toString()));
      child.stderr?.on('data', chunk => logs.push(chunk.toString()));
      child.on('message', raw => messages.push(raw as WorkerToDaemon));
      child.send({
        type: 'init',
        sessionId,
        chatId: 'oc_p5_symlinked_home',
        rootMessageId: 'om_p5_root',
        workingDir: resolve('.'),
        cliId: 'codex-app',
        cliPathOverride: fakeCodex,
        backendType,
        prompt: 'hello',
        turnId: 'om_p5_turn',
        promptCodexAppInput: { text: 'hello', clientUserMessageId: 'om_p5_turn' },
        larkAppId: 'app_p5_symlinked_home',
        larkAppSecret: 'secret',
      } satisfies DaemonToWorker);

      await waitFor(logs, () => messages.some(m => m.type === 'final_output' || m.type === 'error'));
      expect(messages.filter(m => m.type === 'error')).toEqual([]);
      expect(messages.some(m => m.type === 'final_output' && m.turnId === 'om_p5_turn')).toBe(true);
      // It really ran confined: the app-server lives in bwrap's PID namespace,
      // so its in-namespace pid (written by the fake) differs from the host
      // pid the worker attested.
      // The last attestation overall can be an engineless one (an engine clear
      // re-publishes cliPid alone); take the last one that still carries a pid.
      const attestation = messages.filter(
        (m): m is Extract<WorkerToDaemon, { type: 'local_process_attestation' }>
          & { enginePid: number } =>
          m.type === 'local_process_attestation' && m.enginePid !== undefined,
      ).at(-1);
      expect(attestation?.enginePid).toBeGreaterThan(1);
      const status = readFileSync(`/proc/${attestation!.enginePid}/status`, 'utf8');
      const nsPids = status.match(/^NSpid:\s+(.+)$/m)![1]!.trim().split(/\s+/);
      expect(nsPids.length).toBeGreaterThan(1);
      expect(Number(nsPids.at(-1))).toBe(Number(readFileSync(pidPath, 'utf8').trim()));
      expect(logs.join('')).toContain('wrapping codex-app in credential-only bwrap');
    }, 60_000);
  },
);
