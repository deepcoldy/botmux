/**
 * credential-only-send-authority.test.ts
 *
 * REGRESSION for the class of bug where `botmux send` has NO satisfiable
 * authority inside a Linux credential-only pane (device enrolled + the bot's
 * full file sandbox OFF), so the agent cannot answer the user at all — every
 * send, `botmux send --help` included, dies before argv parsing with
 * `read-isolated owning data-root locator is missing or ambiguous`.
 *
 * WHY THE PRE-EXISTING SUITES ALL STAYED GREEN THROUGH THIS: they cover the
 * locator/capability HELPERS in isolation, and nothing anywhere actually
 * SPAWNED a credential-only child and ran the real `botmux send` inside it.
 * The gates that fail are only reachable through that combination, so this file
 * deliberately spawns a real bwrap child running the real built CLI.
 *
 * Requires linux + bwrap; skipped elsewhere (never silently vacuous — the skip
 * is on the environment, not on the assertions).
 */
import { describe, it, expect } from 'vitest';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, realpathSync,
  rmSync, statSync,
} from 'node:fs';
import {
  buildCredentialOnlySandboxArgs,
  prepareCredentialOnlyRelayOutbox,
} from '../src/adapters/backend/sandbox.js';
import {
  ensureManagedOriginAttestationDirectory,
  ensureManagedOriginCapabilityLeafSafe,
  managedOriginAttestationDirectory,
  managedOriginCapabilityDirectory,
  managedOriginCapabilityPath,
  RELAY_ORIGIN_CAPABILITY_BASENAME,
} from '../src/core/managed-origin-capability.js';

const bwrapPath = (): string | null => {
  const r = spawnSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' });
  const p = r.status === 0 ? r.stdout.trim() : '';
  return p.startsWith('/') ? p : null;
};

const distCli = join(__dirname, '..', 'dist', 'cli.js');
const bwrap = process.platform === 'linux' ? bwrapPath() : null;
// `dist/cli.js` is the artifact under test here (the gates live in the built
// CLI). A source-only checkout has nothing to exercise, so skip rather than
// assert against a file that does not exist.
const canRun = process.platform === 'linux' && !!bwrap && existsSync(distCli);

/** Provision the host-side state the worker creates for a credential-only pane,
 *  then run `argv` as the confined child. `withRelay` selects post-fix (relay
 *  outbox present) vs pre-fix (no relay) shape. */
function runConfined(argv: string[], opts: { withRelay: boolean; timeoutMs?: number }): {
  status: number | null; stdout: string; stderr: string;
  outbox?: string; outboxEntries?: string[];
} {
  const root = mkdtempSync(join(tmpdir(), 'credonly-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const sessionId = `sess-${randomBytes(6).toString('hex')}`;
  const channelId = randomBytes(32).toString('hex');

  ensureManagedOriginCapabilityLeafSafe(managedOriginCapabilityPath(dataDir, sessionId, channelId));
  // Writes the isolation MARKER as a side effect — the very signal that makes
  // cmdSend classify this pane as read-isolated.
  ensureManagedOriginAttestationDirectory(dataDir, sessionId, channelId);
  writeFileSync(
    managedOriginCapabilityPath(dataDir, sessionId, channelId),
    JSON.stringify({ sessionId, channelId, capability: randomBytes(32).toString('hex') }),
    { mode: 0o600 },
  );

  const panePolicyDir = join(dataDir, 'read-isolation');
  const relay = opts.withRelay
    ? prepareCredentialOnlyRelayOutbox({ sessionId, dataDir })
    : null;
  if (opts.withRelay) {
    expect(relay).not.toBeNull();
    // The worker publishes this leaf right after wiring the watcher.
    writeFileSync(join(relay!.outbox, RELAY_ORIGIN_CAPABILITY_BASENAME), JSON.stringify({
      sessionId, channelId, token: randomBytes(32).toString('hex'),
      policyCapability: randomBytes(32).toString('hex'), larkAppId: 'cli_test', turnId: 'turn-1',
    }), { mode: 0o600 });
  }

  // A stand-in authority root, so the test never masks the developer's real
  // ~/.botmux. One mask is mandatory for buildCredentialOnlySandboxArgs.
  const authorityDir = join(root, 'device-auth');
  mkdirSync(authorityDir, { recursive: true, mode: 0o700 });

  const args = buildCredentialOnlySandboxArgs({
    hideDirectories: [realpathSync(authorityDir)],
    hideFiles: [],
    privateReadonlyDirectories: [
      {
        parent: realpathSync(panePolicyDir),
        directory: realpathSync(managedOriginCapabilityDirectory(dataDir, sessionId, channelId)),
      },
      {
        parent: realpathSync(panePolicyDir),
        directory: realpathSync(managedOriginAttestationDirectory(dataDir, sessionId, channelId)),
      },
    ],
    ...(relay ? { writableOutbox: relay.outbox } : {}),
    workingDir: root,
    cliBin: process.execPath,
    cliArgs: argv,
  });

  const r = spawnSync(bwrap!, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 60_000,
    env: {
      ...process.env,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sessionId,
      BOTMUX_ORIGIN_CHANNEL_ID: channelId,
      BOTMUX_CHAT_ID: 'oc_test',
      BOTMUX_LARK_APP_ID: 'cli_test',
      ...(relay ? { BOTMUX_SEND_RELAY: relay.outbox } : {}),
    },
  });
  // Read the outbox BEFORE tearing the tree down.
  const outboxEntries = relay
    ? readdirSync(relay.outbox).filter(name => name !== RELAY_ORIGIN_CAPABILITY_BASENAME)
    : undefined;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ...(relay ? { outbox: relay.outbox, outboxEntries } : {}),
  };
}

describe('credential-only pane: botmux send authority', () => {
  it.skipIf(!canRun)(
    'reproduces the defect shape when the pane has no relay outbox (pre-fix)',
    () => {
      // This is the exact user-visible failure: the refusal lands before argv is
      // even parsed, which is why `--help` cannot escape it either.
      const r = runConfined([distCli, 'send', '--help'], { withRelay: false });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('read-isolated owning data-root locator is missing or ambiguous');
    },
    90_000,
  );

  it.skipIf(!canRun)(
    'clears the locator gate once the pane carries the host relay outbox (post-fix)',
    () => {
      // A short spawn timeout is the ORACLE here, not a nuisance: no daemon or
      // outbox watcher runs in a unit test, so a send that correctly reaches the
      // relay path parks waiting to be delivered and gets killed (status null).
      // Pre-fix the same call returns a fast exit 2 instead. Distinguishing
      // "killed while waiting on the relay" from "refused for missing authority"
      // is exactly the property under test.
      const r = runConfined([distCli, 'send', 'hello', '--no-mention'], {
        withRelay: true,
        timeoutMs: 8_000,
      });
      // The locator/data-root gates must be gone. Asserting on their ABSENCE is
      // the point: a regression reinstates one of these strings.
      expect(r.stderr).not.toContain('owning data-root locator is missing or ambiguous');
      expect(r.stderr).not.toContain('locator-selected data root is not protected');
      expect(r.stderr).not.toContain('managed host relay capability is stale or missing');
      expect(r.stderr).not.toContain('read-isolated managed origin capability is stale');
      // Never a refusal exit; it either parks on the relay (killed → null) or the
      // relay itself reports a delivery timeout.
      if (r.status !== null) {
        expect(r.stderr).toMatch(/relay|daemon/i);
        expect(r.status).not.toBe(2);
      }
      // It must have written its request INTO the host outbox — proof the
      // read-write bind is real and the host watcher has something to service.
      expect(r.outboxEntries?.length ?? 0).toBeGreaterThan(0);
    },
    90_000,
  );

  it.skipIf(process.platform !== 'linux')(
    'binds the outbox read-write AFTER every mask so no tmpfs can shadow it',
    () => {
      // Ordering is load-bearing: a --tmpfs over an ancestor placed later would
      // silently swallow the relay, and the child's send would write into a
      // throwaway filesystem no watcher reads.
      const dataDir = mkdtempSync(join(tmpdir(), 'credonly-order-'));
      const outbox = join(dataDir, 'sandboxes', 'sX', 'outbox');
      mkdirSync(outbox, { recursive: true });
      const parent = join(dataDir, 'read-isolation');
      const own = join(parent, `origin-${'a'.repeat(64)}`);
      mkdirSync(own, { recursive: true });
      const args = buildCredentialOnlySandboxArgs({
        hideDirectories: [dataDir],
        hideFiles: [],
        privateReadonlyDirectories: [{ parent, directory: own }],
        writableOutbox: outbox,
        workingDir: '/tmp',
        cliBin: '/usr/bin/true',
        cliArgs: [],
      });
      const outboxAt = args.findIndex((v, i) =>
        v === '--bind' && args[i + 1] === outbox && args[i + 2] === outbox);
      expect(outboxAt).toBeGreaterThan(-1);
      const lastMaskAt = args.reduce(
        (acc, v, i) => (v === '--tmpfs' || (v === '--ro-bind' && args[i + 1] === '/dev/null'))
          ? i
          : acc,
        -1,
      );
      expect(lastMaskAt).toBeGreaterThan(-1);
      expect(outboxAt).toBeGreaterThan(lastMaskAt);
      // Read-WRITE specifically: --ro-bind here would EROFS the agent's send.
      expect(args[outboxAt]).toBe('--bind');
      rmSync(dataDir, { recursive: true, force: true });
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'provisions the outbox 0700 inside the same per-session tree cleanup already covers',
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'credonly-prov-'));
      const relay = prepareCredentialOnlyRelayOutbox({ sessionId: 'sess-prov', dataDir });
      expect(relay).not.toBeNull();
      // Same `sandboxes/<sid>/outbox` shape the full sandbox uses, so the
      // existing close/exit teardown and orphan sweep already cover it.
      expect(relay!.outbox).toBe(
        join(realpathSync(dataDir), 'sandboxes', 'sess-prov', 'outbox'),
      );
      expect(statSync(relay!.outbox).isDirectory()).toBe(true);
      expect(statSync(relay!.outbox).mode & 0o777).toBe(0o700);
      relay!.cleanup();
      expect(existsSync(join(realpathSync(dataDir), 'sandboxes', 'sess-prov'))).toBe(false);
      rmSync(dataDir, { recursive: true, force: true });
    },
  );

  it('returns null off-linux so the worker fails closed instead of running unconfined', () => {
    if (process.platform === 'linux') return;
    expect(prepareCredentialOnlyRelayOutbox({
      sessionId: 's1',
      dataDir: mkdtempSync(join(tmpdir(), 'credonly-gate-')),
    })).toBeNull();
  });
});

/** The worker half of the fix. The spawn-path tests above drive the CLI directly
 *  and therefore cannot observe worker.ts at all — without these assertions,
 *  deleting the worker's relay wiring leaves the whole suite green while every
 *  real credential-only send breaks again (measured). Source-text assertions are
 *  the existing idiom for this file (see read-isolation.test.ts). */
describe('worker wiring for the credential-only relay', () => {
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

  it('provisions the outbox, injects BOTMUX_SEND_RELAY, and starts the host watcher', () => {
    const provisionAt = source.indexOf('const credentialRelay = prepareCredentialOnlyRelayOutbox({');
    expect(provisionAt).toBeGreaterThanOrEqual(0);
    // Fail CLOSED: an outbox that cannot be prepared must abort the spawn rather
    // than silently launch a pane whose every send will be refused.
    const failClosedAt = source.indexOf('credential-only relay outbox could not be prepared', provisionAt);
    expect(failClosedAt).toBeGreaterThan(provisionAt);
    // The child must be TOLD about the relay; the outbox alone routes nothing.
    const envAt = source.indexOf('childEnv.BOTMUX_SEND_RELAY = credentialRelay.outbox;', provisionAt);
    expect(envAt).toBeGreaterThan(provisionAt);
    // And a host watcher must service it, with the session id forced.
    const watcherAt = source.indexOf('sandboxStopWatcher = startOutboxWatcher(', envAt);
    expect(watcherAt).toBeGreaterThan(envAt);
    expect(source.indexOf('credentialRelay.outbox', watcherAt)).toBeGreaterThan(watcherAt);
    // Teardown must be owned, or the session tree leaks.
    expect(source.indexOf('sandboxCleanup = credentialRelay.cleanup;', provisionAt))
      .toBeGreaterThan(provisionAt);
    // The bwrap wrapper has to receive the outbox as a writable bind.
    expect(source.indexOf('writableOutbox: credentialRelay.outbox', provisionAt))
      .toBeGreaterThan(provisionAt);
  });

  it('re-publishes the capability so the outbox leaf exists for the relay reader', () => {
    // The earlier credential-only publish runs before any outbox exists and so
    // writes only the managed-origin copy; `botmux send` in relay mode reads the
    // OUTBOX leaf, so a second publish after wiring is required.
    const provisionAt = source.indexOf('const credentialRelay = prepareCredentialOnlyRelayOutbox({');
    const watcherAt = source.indexOf('sandboxStopWatcher = startOutboxWatcher(', provisionAt);
    const publishAt = source.indexOf('publishSandboxRelayCapability({ failClosed: true })', watcherAt);
    expect(publishAt).toBeGreaterThan(watcherAt);
  });
});
