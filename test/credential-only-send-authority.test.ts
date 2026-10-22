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
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, realpathSync,
  rmSync, statSync, symlinkSync, unlinkSync,
} from 'node:fs';
import {
  attachCredentialOnlyRelayOutbox,
  buildCredentialOnlySandboxArgs,
  prepareCredentialOnlyRelayOutbox,
  probeHostCredentialIsolationMechanism,
} from '../src/adapters/backend/sandbox.js';
import {
  buildBotmuxEnvAssignments,
  shellCommandArgv,
  shellWrapperScript,
} from '../src/adapters/backend/tmux-backend.js';
import { tmuxEnv } from '../src/setup/ensure-tmux.js';
import {
  ensureManagedOriginAttestationDirectory,
  ensureManagedOriginCapabilityLeafSafe,
  managedOriginAttestationDirectory,
  managedOriginCapabilityDirectory,
  managedOriginCapabilityPath,
  RELAY_ORIGIN_CAPABILITY_BASENAME,
} from '../src/core/managed-origin-capability.js';
import { linuxIsolationLaunch } from '../src/core/linux-isolation.js';

const bwrapPath = (): string | null => {
  const r = spawnSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' });
  // String(): a co-loaded file's child_process mock (one Bun process for many
  // files) may hand back a non-string stdout; treat that as "no bwrap".
  const p = r.status === 0 ? String(r.stdout ?? '').trim() : '';
  return p.startsWith('/') ? p : null;
};

const distCli = join(__dirname, '..', 'dist', 'cli.js');
const bwrap = process.platform === 'linux' ? bwrapPath() : null;
// A bwrap binary on PATH is not enough: hosts that forbid unprivileged user
// namespaces (sysctl / AppArmor / container seccomp) have the binary but every
// launch fails. Gate on the SAME runtime probe production uses before it agrees
// to wrap a credential-only pane — it actually starts a seccomp-wrapped bwrap
// with the user/PID/IPC/UTS namespaces this flavour needs.
const credentialOnlyRuntime = process.platform === 'linux' && !!bwrap
  && (() => {
    const probe = probeHostCredentialIsolationMechanism();
    return probe.supported && probe.mechanism === 'bwrap';
  })();
// `dist/cli.js` is the artifact under test here (the gates live in the built
// CLI). A source-only checkout has nothing to exercise, so skip rather than
// assert against a file that does not exist.
const canRun = credentialOnlyRuntime && existsSync(distCli);
const hasTmux = process.platform === 'linux' && !spawnSync('tmux', ['-V']).error;

/** Provision the host-side state the worker creates for a credential-only pane,
 *  then run `argv` as the confined child. `withRelay` selects post-fix (relay
 *  outbox present) vs pre-fix (no relay) shape. */
function runConfined(argv: string[], opts: { withRelay: boolean; timeoutMs?: number }): {
  status: number | null; stdout: string; stderr: string;
  outbox?: string; outboxEntries?: string[]; outboxRequests?: Array<Record<string, unknown>>;
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

  // A SIBLING session's live outbox + capability leaf in the same data root:
  // the pane must not be able to see (and therefore forge into) it.
  const siblingOutbox = join(realpathSync(dataDir), 'sandboxes', 'sess-sibling', 'outbox');
  mkdirSync(siblingOutbox, { recursive: true, mode: 0o700 });
  writeFileSync(join(siblingOutbox, RELAY_ORIGIN_CAPABILITY_BASENAME), '{}', { mode: 0o600 });

  // A stand-in authority root, so the test never masks the developer's real
  // ~/.botmux. One mask is mandatory for buildCredentialOnlySandboxArgs.
  const authorityDir = join(root, 'device-auth');
  mkdirSync(authorityDir, { recursive: true, mode: 0o700 });

  const args = buildCredentialOnlySandboxArgs({
    hideDirectories: [realpathSync(authorityDir), ...(relay ? [relay.sessionsRoot] : [])],
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

  // Launch exactly like prepareCredentialOnlySandbox does in production: the
  // bwrap argv wrapped by the inherited seccomp isolation probe. Since that
  // probe landed, `linuxIsolationDetected()` is TRUE inside every credential-only
  // pane, which by itself forces cmdSend onto the read-isolated (locator) arm
  // whenever no relay is present — independent of the marker walk.
  // A private /dev keeps the fixture independent of the host's container device
  // mounts: Bun aborts (SIGABRT, exit 134) on those inside bwrap even without
  // seccomp. Same idiom as linux-isolation.test.ts; masks/binds are unaffected.
  args.splice(args.indexOf('--'), 0, '--dev', '/dev');
  const launch = linuxIsolationLaunch(bwrap!, args);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SESSION_DATA_DIR: dataDir,
    BOTMUX_SESSION_ID: sessionId,
    BOTMUX_ORIGIN_CHANNEL_ID: channelId,
    BOTMUX_CHAT_ID: 'oc_test',
    BOTMUX_LARK_APP_ID: 'cli_test',
  };
  // BOTMUX_SEND_RELAY is deliberately NOT in the launch env: on the default
  // tmux backend the pane env never carries it (tmuxEnv strips BOTMUX*, the
  // pane allowlist excludes it). The wrapper's own --setenv must deliver it.
  // Also drop any value inherited from a runner that is itself a botmux pane.
  delete env.BOTMUX_SEND_RELAY;
  const r = spawnSync(launch.bin, launch.args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 60_000,
    env,
  });
  // Read the outbox BEFORE tearing the tree down.
  const outboxEntries = relay
    ? readdirSync(relay.outbox).filter(name => name !== RELAY_ORIGIN_CAPABILITY_BASENAME)
    : undefined;
  const outboxRequests = relay
    ? outboxEntries!.filter(name => name.endsWith('.req.json'))
      .map(name => JSON.parse(readFileSync(join(relay.outbox, name), 'utf8')) as Record<string, unknown>)
    : undefined;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ...(relay ? { outbox: relay.outbox, outboxEntries, outboxRequests } : {}),
  };
}

describe('credential-only pane: botmux send authority', () => {
  it.skipIf(!canRun)(
    'reproduces the defect shape when the pane has no relay outbox (pre-fix)',
    () => {
      // This is the exact user-visible failure: every real send is refused by
      // the locator gate before it can reach Lark or any relay.
      const r = runConfined([distCli, 'send', 'hello', '--no-mention'], { withRelay: false });
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

  it.skipIf(!canRun)(
    'hides sibling sessions\' relay outboxes while keeping its own writable',
    () => {
      // Every outbox carries that session's live relay capability token. This
      // flavour binds `/`, so without masking `sandboxes/` a pane could read a
      // sibling's token and drop a forged request into the sibling's outbox.
      const script = [
        "const fs=require('fs'),p=require('path');",
        "const root=p.join(fs.realpathSync(process.env.SESSION_DATA_DIR),'sandboxes');",
        "const sib=p.join(root,'sess-sibling','outbox');",
        "let sibling='visible';try{fs.readdirSync(sib)}catch(e){sibling=e.code}",
        "let own='ok';try{fs.writeFileSync(p.join(process.env.BOTMUX_SEND_RELAY,'probe'),'x')}catch(e){own=e.code}",
        "process.stdout.write(JSON.stringify({sibling,own,listing:fs.readdirSync(root)}));",
      ].join('');
      const r = runConfined(['-e', script], { withRelay: true });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout) as { sibling: string; own: string; listing: string[] };
      expect(out.sibling).toBe('ENOENT');
      expect(out.own).toBe('ok');
      expect(out.listing).not.toContain('sess-sibling');
      expect(r.outboxEntries).toContain('probe');
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
      // The relay path is delivered by the wrapper itself, before the command.
      const setenvAt = args.findIndex((v, i) =>
        v === '--setenv' && args[i + 1] === 'BOTMUX_SEND_RELAY' && args[i + 2] === outbox);
      expect(setenvAt).toBeGreaterThan(-1);
      expect(setenvAt).toBeLessThan(args.indexOf('--'));
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

// Wait for the pane to PUBLISH content, not merely for the file to exist:
// the readers write via a shell redirect (`printf … > file`), which truncate-
// creates the file a beat before the bytes land. Returning on existence let the
// caller read the empty create-vs-write window under CI contention (observed
// flake: expected 'unset' / the outbox path, received ''). Both callers assert
// on a specific NON-empty value, so keep polling until the content is non-empty
// and let the caller's toBe() keep the precise assertion (a wrong/leaked value
// still fails deterministically; only the empty window is ridden out).
function waitForFile(path: string, timeoutMs: number): string | null {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const body = readFileSync(path, 'utf8');
      if (body.length > 0) return body;
    } catch { /* not yet */ }
    spawnSync('sleep', ['0.1']);
  }
  return null;
}

/** The pane launch path the DEFAULT (non-strict) tmux backend really uses:
 *  `tmux new-session` with the client env filtered through tmuxEnv(), and the
 *  pane command built from shellCommandArgv + shellWrapperScript +
 *  buildBotmuxEnvAssignments. Only the wrapper's own argv can carry
 *  BOTMUX_SEND_RELAY across it. */
describe('credential-only pane on the default tmux backend', () => {
  it.skipIf(!credentialOnlyRuntime || !hasTmux)(
    'delivers BOTMUX_SEND_RELAY into the confined CLI, and only into that pane',
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'credonly-tmux-')));
      const socket = `bmx-credonly-${process.pid}-${Date.now()}`;
      // Keep the fence's private socket root: a hand-built env without
      // TMUX_TMPDIR puts this server in the HOST socket directory.
      const clientBase: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
      const runTmux = (args: string[], env: NodeJS.ProcessEnv) => {
        const r = spawnSync('tmux', ['-L', socket, ...args], { env, encoding: 'utf8', timeout: 10_000 });
        expect(r.status, r.stderr || String(r.error ?? '')).toBe(0);
      };
      try {
        const dataDir = join(root, 'data');
        mkdirSync(dataDir);
        const authorityDir = join(root, 'device-auth');
        mkdirSync(authorityDir, { mode: 0o700 });
        const relay = prepareCredentialOnlyRelayOutbox({ sessionId: 'sess-tmux', dataDir })!;
        expect(relay).not.toBeNull();
        // What the worker hands the backend for this session.
        const childEnv: NodeJS.ProcessEnv = {
          ...clientBase,
          BOTMUX_SESSION_ID: 'sess-tmux',
          BOTMUX_SEND_RELAY: relay.outbox,
        };
        // Pre-fix shape, documented: neither tmux channel carries the key.
        expect(tmuxEnv(childEnv).BOTMUX_SEND_RELAY).toBeUndefined();
        expect(buildBotmuxEnvAssignments(childEnv).some(a => a.startsWith('BOTMUX_SEND_RELAY=')))
          .toBe(false);

        const args = buildCredentialOnlySandboxArgs({
          hideDirectories: [authorityDir, relay.sessionsRoot],
          hideFiles: [],
          writableOutbox: relay.outbox,
          workingDir: root,
          cliBin: '/bin/sh',
          cliArgs: ['-c', 'printf "%s" "${BOTMUX_SEND_RELAY-unset}" > "$0/confined-env"', relay.outbox],
        });
        const launch = linuxIsolationLaunch(bwrap!, args);
        runTmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'confined',
          ...shellCommandArgv({ shell: '/bin/sh', flags: [] }, shellWrapperScript(root), [
            root, ...buildBotmuxEnvAssignments(childEnv), launch.bin, ...launch.args,
          ]),
        ], tmuxEnv(childEnv));
        // Written THROUGH the read-write bind from inside the pane.
        expect(waitForFile(join(relay.outbox, 'confined-env'), 20_000)).toBe(relay.outbox);

        // A co-tenant, non-credential-only pane on the same server must not
        // inherit it (no server-global seeding, no ambient leak).
        const plainOut = join(root, 'plain-env');
        runTmux(['new-session', '-d', '-s', 'plain',
          ...shellCommandArgv({ shell: '/bin/sh', flags: [] }, shellWrapperScript(root), [
            root, ...buildBotmuxEnvAssignments({ ...clientBase, BOTMUX_SESSION_ID: 'other' }),
            '/bin/sh', '-c', 'printf "%s" "${BOTMUX_SEND_RELAY-unset}" > "$0"', plainOut,
          ]),
        ], tmuxEnv({ ...clientBase, BOTMUX_SESSION_ID: 'other' }));
        expect(waitForFile(plainOut, 10_000)).toBe('unset');
      } finally {
        spawnSync('tmux', ['-L', socket, 'kill-server'], { env: clientBase, timeout: 10_000 });
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

/** Warm reattach (daemon restart / detach_for_transfer / suspend→resume) keeps
 *  the confined CLI alive with its ORIGINAL outbox bind. The successor worker
 *  must re-serve that exact directory — never a recreated one. */
describe('credential-only relay on warm reattach', () => {
  it.skipIf(process.platform !== 'linux')(
    'never creates the outbox; only re-serves one that survived',
    () => {
      const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'credonly-attach-')));
      try {
        expect(attachCredentialOnlyRelayOutbox({ sessionId: 'sess-a', dataDir })).toBeNull();
        expect(existsSync(join(dataDir, 'sandboxes', 'sess-a'))).toBe(false);

        const relay = prepareCredentialOnlyRelayOutbox({ sessionId: 'sess-a', dataDir })!;
        // Transfer teardown revokes the capability leaf but keeps the directory.
        writeFileSync(join(relay.outbox, RELAY_ORIGIN_CAPABILITY_BASENAME), '{}', { mode: 0o600 });
        unlinkSync(join(relay.outbox, RELAY_ORIGIN_CAPABILITY_BASENAME));
        const attached = attachCredentialOnlyRelayOutbox({ sessionId: 'sess-a', dataDir });
        expect(attached?.outbox).toBe(relay.outbox);
        expect(attached?.sessionsRoot).toBe(relay.sessionsRoot);

        // A planted symlink is not this session's outbox.
        const elsewhere = join(dataDir, 'elsewhere');
        mkdirSync(elsewhere);
        mkdirSync(join(dataDir, 'sandboxes', 'sess-b'), { recursive: true });
        symlinkSync(elsewhere, join(dataDir, 'sandboxes', 'sess-b', 'outbox'));
        expect(attachCredentialOnlyRelayOutbox({ sessionId: 'sess-b', dataDir })).toBeNull();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!credentialOnlyRuntime)(
    'a re-published capability reaches the still-running confined CLI',
    async () => {
      const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'credonly-live-')));
      try {
        const authorityDir = join(dataDir, 'device-auth');
        mkdirSync(authorityDir, { mode: 0o700 });
        const relay = prepareCredentialOnlyRelayOutbox({ sessionId: 'sess-live', dataDir })!;
        const leaf = RELAY_ORIGIN_CAPABILITY_BASENAME;
        // The confined CLI outlives its worker: it waits for a capability leaf
        // in the outbox it was launched with.
        const args = buildCredentialOnlySandboxArgs({
          hideDirectories: [authorityDir, relay.sessionsRoot],
          hideFiles: [],
          writableOutbox: relay.outbox,
          workingDir: dataDir,
          cliBin: '/bin/sh',
          cliArgs: ['-c',
            'i=0; while [ ! -s "$BOTMUX_SEND_RELAY/$0" ] && [ $i -lt 200 ]; do sleep 0.1; i=$((i+1)); done; cat "$BOTMUX_SEND_RELAY/$0"',
            leaf],
        });
        const launch = linuxIsolationLaunch(bwrap!, args);
        const child = spawn(launch.bin, launch.args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
        await new Promise(resolve => setTimeout(resolve, 500));

        // Successor worker: re-serve the SAME outbox, then publish (the
        // previous worker's teardown had revoked the leaf).
        const attached = attachCredentialOnlyRelayOutbox({ sessionId: 'sess-live', dataDir });
        expect(attached).not.toBeNull();
        writeFileSync(join(attached!.outbox, leaf), 'generation-2', { mode: 0o600 });

        expect(await exited).toBe(0);
        expect(stdout).toBe('generation-2');
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe('credential-only relay sandbox masks', () => {
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

  // 源码结构护栏(K2)：每个会话的 relay outbox 里都放着一枚活的 relay capability；credential-only pane 的 bwrap 必须
  // 遮住全部会话的 outbox 根，只把本会话 outbox 重新 bind 回来，否则本 pane 能读兄弟会话的 capability、往它们的
  // outbox 伪造发送（#1321）。遮罩列表在 worker spawnCli 闭包里组装，没有行为 seam；
  // credential-only-relay-lifecycle.integration.test.ts 只验证本会话 outbox 可用，验证不到兄弟会话被遮住。
  it('hides every session outbox root and re-binds only its own outbox', () => {
    const provisionAt = source.indexOf('= prepareCredentialOnlyRelayOutbox({');
    const sandboxAt = source.indexOf('prepareCredentialOnlySandbox({', provisionAt);
    expect(provisionAt).toBeGreaterThan(-1);
    expect(sandboxAt).toBeGreaterThan(provisionAt);
    const call = source.slice(sandboxAt, source.indexOf('});', sandboxAt));
    expect(call).toMatch(/hideDirectories:[^\n]*credentialRelay\.sessionsRoot/);
    expect(call).toMatch(/writableOutbox:\s*credentialRelay\.outbox/);
  });
});
