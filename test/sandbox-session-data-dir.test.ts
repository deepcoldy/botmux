import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prepareDirectSandbox } from '../src/adapters/backend/sandbox.js';
import type { FsPolicy } from '../src/adapters/cli/fs-policy.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';
import { ensureManagedOriginAttestationDirectory, RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';

const linux = process.platform === 'linux';
const hasBwrap = linux && spawnSync('bwrap', ['--version']).status === 0;
const canRunBwrap = hasBwrap && spawnSync('bwrap', [
  '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc',
  '--', '/bin/true',
], { stdio: 'ignore', timeout: 5_000 }).status === 0;
const canRunRootBwrap = canRunBwrap && spawnSync('bwrap', [
  '--ro-bind', '/', '/', '--unshare-user', '--uid', '0', '--gid', '0',
  '--unshare-pid', '--proc', '/proc', '--', '/bin/bash', '-c', 'test "$EUID" = 0',
], { stdio: 'ignore', timeout: 5_000 }).status === 0;

function allowTestRuntime(policy: FsPolicy) {
  const repoRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  const runtime = tsRunnerPrefix();
  // Review worktrees can share dependencies outside the mounted checkout.
  for (const path of [repoRoot, realpathSync(join(repoRoot, 'node_modules')), dirname(realpathSync(runtime.command))]) {
    policy.rules.push({ path, access: 'readOnly', source: 'internal' });
  }
  return { repoRoot, ...runtime };
}

function fixture(layout: 'home-link' | 'data-link' | 'canonical') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-sandbox-data-')));
  const home = join(root, 'home');
  const dataDir = join(home, '.botmux/data');
  const ownStore = join(dataDir, 'session-stores/app-a');
  const ownBotHome = join(home, '.botmux/bots/app-a');
  const workspace = join(root, 'workspace');
  const origin = join(dataDir, 'read-isolation/origin-own');
  const attestation = join(dataDir, 'read-isolation/attest-own');
  for (const path of [ownStore, ownBotHome, workspace, origin, attestation]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(ownStore, 'sessions.db'), 'own-session');
  writeFileSync(join(origin, 'capability.json'), 'own-capability');
  writeFileSync(join(attestation, 'proof.json'), 'own-proof');
  const siblingStore = join(dataDir, 'session-stores/app-b');
  const siblingOrigin = join(dataDir, 'read-isolation/origin-other');
  for (const path of [siblingStore, siblingOrigin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(siblingStore, 'sessions.db'), 'private-sibling');
  writeFileSync(join(siblingOrigin, 'capability.json'), 'private-sibling');
  const alias = join(root, 'alias');
  symlinkSync(layout === 'home-link' ? home : dataDir, alias);
  const configuredDataDir = layout === 'home-link'
    ? join(alias, '.botmux/data')
    : layout === 'data-link' ? alias : dataDir;
  const policy: FsPolicy = {
    rules: [
      ...['/usr', '/etc', ownStore, origin, attestation].map(path => ({
        path, access: 'readOnly' as const, source: 'internal' as const,
      })),
      ...[workspace, ownBotHome].map(path => ({
        path, access: 'readWrite' as const, source: 'internal' as const,
      })),
    ],
    net: true,
    writeRegexes: [],
  };
  return { root, home, dataDir, configuredDataDir, ownBotHome, workspace, policy };
}

function cleanup(f: ReturnType<typeof fixture>, plan: ReturnType<typeof prepareDirectSandbox>) {
  // Bun's recursive rm does not repair mode-000 directories like Node does.
  // Restore only this fixture's empty mask, after the sandbox child has exited.
  const empty = join(f.dataDir, 'sandboxes/session/empty');
  if (existsSync(empty)) chmodSync(empty, 0o700);
  plan?.cleanup();
  rmSync(f.root, { recursive: true, force: true });
}

describe.skipIf(!hasBwrap)('sandbox session-data root', () => {
  it.each(['home-link', 'data-link', 'canonical'] as const)(
    'pins the mounted root in both the child env and bwrap argv (%s)', layout => {
      const f = fixture(layout);
      let plan: ReturnType<typeof prepareDirectSandbox> = null;
      try {
        plan = prepareDirectSandbox({
          sessionId: 'session', dataDir: f.configuredDataDir, policy: f.policy,
          chdir: f.workspace, home: f.home, cliBin: '/bin/true', cliArgs: [],
        });
        expect(plan).not.toBeNull();
        expect(plan!.env.SESSION_DATA_DIR).toBe(f.dataDir);
        const keyAt = plan!.args.indexOf('SESSION_DATA_DIR');
        expect(plan!.args.slice(keyAt - 1, keyAt + 2)).toEqual([
          '--setenv', 'SESSION_DATA_DIR', f.dataDir,
        ]);
      } finally {
        cleanup(f, plan);
      }
    },
  );

  it.skipIf(!canRunBwrap)('resolves session state through a symlinked home without exposing siblings', () => {
    const f = fixture('home-link');
    let plan: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      plan = prepareDirectSandbox({
        sessionId: 'session', dataDir: f.configuredDataDir, policy: f.policy,
        chdir: f.workspace, home: f.home, cliBin: '/bin/sh', cliArgs: ['-ec', `
          cat "$SESSION_DATA_DIR/session-stores/app-a/sessions.db"
          cat "$SESSION_DATA_DIR/read-isolation/origin-own/capability.json"
          cat "$SESSION_DATA_DIR/read-isolation/attest-own/proof.json"
          test ! -r "$SESSION_DATA_DIR/session-stores/app-b/sessions.db"
          test ! -r "$SESSION_DATA_DIR/read-isolation/origin-other/capability.json"
          printf schedule > "$SESSION_DATA_DIR/../bots/app-a/schedule-probe"
        `],
      });
      expect(plan).not.toBeNull();
      const result = spawnSync(plan!.bin, plan!.args, {
        env: { ...process.env, SESSION_DATA_DIR: f.configuredDataDir },
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('own-sessionown-capabilityown-proof');
      expect(readFileSync(join(f.ownBotHome, 'schedule-probe'), 'utf8')).toBe('schedule');
    } finally {
      cleanup(f, plan);
    }
  });

  it.skipIf(!canRunBwrap)('creates a schedule for the inferred session inside the real sandbox', () => {
    const f = fixture('home-link');
    let plan: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      rmSync(join(f.dataDir, 'session-stores/app-a/sessions.db'));
      seedPersistedSessionRows(f.dataDir, 'app-a', {
        session: {
          sessionId: 'session', chatId: 'oc_own', rootMessageId: 'om_own',
          title: 'own session', status: 'active', createdAt: new Date(0).toISOString(),
          larkAppId: 'app-a', cliId: 'codex', workingDir: f.workspace,
          ownerOpenId: 'ou_owner', chatType: 'p2p', scope: 'chat',
        },
      });
      const { repoRoot, command, prefixArgs } = allowTestRuntime(f.policy);
      plan = prepareDirectSandbox({
        sessionId: 'session', dataDir: f.configuredDataDir, policy: f.policy,
        chdir: repoRoot, home: f.home, cliBin: command,
        cliArgs: [...prefixArgs, join(repoRoot, 'src/cli.ts'),
          'schedule', 'add', '0 12 * * *', 'fixture reminder'],
      });
      expect(plan).not.toBeNull();
      const result = spawnSync(plan!.bin, plan!.args, {
        cwd: repoRoot,
        env: {
          ...process.env,
          SESSION_DATA_DIR: f.configuredDataDir,
          BOTMUX_SESSION_ID: 'session', BOTMUX_LARK_APP_ID: 'app-a',
          BOTMUX_API_ONLY: '0', BOTMUX_READ_ISOLATION: '1',
          BOTMUX_WORKFLOW: '',
        },
        encoding: 'utf8', timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('已创建定时任务');
      const store = JSON.parse(readFileSync(join(f.ownBotHome, 'schedules.json'), 'utf8'));
      expect(Object.values(store)).toEqual([expect.objectContaining({
        chatId: 'oc_own', larkAppId: 'app-a', ownerOpenId: 'ou_owner',
        workingDir: f.workspace, prompt: 'fixture reminder',
      })]);
    } finally {
      cleanup(f, plan);
    }
  });

  it.skipIf(!canRunRootBwrap)('rejects a root sandbox forging the host relay flag and worker PID', () => {
    const f = fixture('canonical');
    let plan: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      rmSync(join(f.dataDir, 'session-stores/app-a/sessions.db'));
      const workerPid = 64;
      const channelId = 'ac'.repeat(32);
      const attestationDir = ensureManagedOriginAttestationDirectory(f.dataDir, 'session', channelId);
      f.policy.rules.push({ path: attestationDir, access: 'readOnly', source: 'internal' });
      seedPersistedSessionRows(f.dataDir, 'app-a', {
        session: {
          sessionId: 'session', chatId: 'oc_own', rootMessageId: 'om_own',
          title: 'settled', status: 'active', createdAt: new Date(0).toISOString(),
          larkAppId: 'app-a', cliId: 'codex-app', pid: workerPid,
        },
      });
      const { repoRoot, command, prefixArgs } = allowTestRuntime(f.policy);
      // No external effects even if the regression returns: the later ledger
      // gate rejects this settled turn, and the sandbox has no network.
      f.policy.net = false;
      plan = prepareDirectSandbox({
        sessionId: 'session', dataDir: f.dataDir, policy: f.policy,
        chdir: repoRoot, home: f.home, cliBin: '/bin/bash',
        cliArgs: ['-c', `
          unset BOTMUX_SEND_RELAY BOTMUX_READ_ISOLATED
          export BOTMUX_HOST_RELAY_AUTHORIZED=1
          while :; do
            (
              if (( BASHPID == ${workerPid} )); then
                printf 'fixture uid=%s parent=%s\\n' "$EUID" "$BASHPID"
                "$@"
                exit $?
              fi
              if (( BASHPID > ${workerPid} )); then exit 99; fi
              exit 77
            )
            result=$?
            if (( result != 77 )); then exit "$result"; fi
          done
        `, 'pid-collision', command, ...prefixArgs, join(repoRoot, 'src/cli.ts'),
        'send', 'must not send', '--session-id', 'session', '--no-mention'],
      });
      expect(plan).not.toBeNull();
      const args = [...plan!.args];
      args.splice(args.indexOf('--'), 0, '--uid', '0', '--gid', '0');
      const result = spawnSync(plan!.bin, args, {
        cwd: repoRoot,
        env: {
          ...process.env,
          SESSION_DATA_DIR: f.dataDir,
          BOTMUX_SESSION_ID: 'session', BOTMUX_ORIGIN_CHANNEL_ID: channelId,
          BOTMUX_TURN_ID: 'turn-settled', BOTMUX_DISPATCH_ATTEMPT: '4',
          BOTMUX_HOST_RELAY_REQUIRES_CODEX_APP_LEDGER: '1',
          BOTMUX_API_ONLY: '0', BOTMUX_WORKFLOW: '',
          BOTMUX_LARK_APP_ID: '', BOTMUX_LARK_APP_SECRET: '',
        },
        encoding: 'utf8', timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.stdout).toBe(`fixture uid=0 parent=${workerPid}\n`);
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('read-isolated owning data-root locator is missing or ambiguous');
      expect(result.stderr).not.toContain('authorized Codex App origin');
    } finally {
      cleanup(f, plan);
    }
  });

  it.each([0, 65534])('rejects env-cleared direct sends inside a real sandbox (UID %s)', uid => {
    if (!canRunBwrap) return;
    const f = fixture('canonical');
    f.policy.net = false;
    let plan: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      rmSync(join(f.dataDir, 'session-stores/app-a/sessions.db'));
      seedPersistedSessionRows(f.dataDir, 'app-a', {
        session: {
          sessionId: 'session', chatId: 'oc_own', rootMessageId: 'om_own',
          title: 'fixture', status: 'active', createdAt: new Date(0).toISOString(),
          larkAppId: 'app-a', cliId: 'codex',
        },
      });
      const { repoRoot, command, prefixArgs } = allowTestRuntime(f.policy);
      plan = prepareDirectSandbox({
        sessionId: 'session', dataDir: f.dataDir, policy: f.policy,
        chdir: repoRoot, home: f.home, cliBin: '/usr/bin/env',
        cliArgs: ['-i', `HOME=${f.home}`, `SESSION_DATA_DIR=${f.dataDir}`,
          'BOTMUX_SESSION_ID=session', 'BOTMUX_LARK_APP_ID=app-a',
          'BOTMUX_HOST_RELAY_AUTHORIZED=1', command, ...prefixArgs,
          // If classification ever regresses, stop at the later argument
          // validation gate. No credentials, provider request or network.
          join(repoRoot, 'src/cli.ts'), 'send', 'fixture', '--video'],
      });
      expect(plan).not.toBeNull();
      const args = [...plan!.args];
      args.splice(args.indexOf('--'), 0, '--uid', String(uid), '--gid', String(uid));
      const result = spawnSync(plan!.bin, args, {
        cwd: repoRoot, encoding: 'utf8', timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('read-isolated pane authority channel is missing or invalid');
      expect(result.stderr).not.toContain('--video 需要路径参数');
    } finally {
      cleanup(f, plan);
    }
  });

  it.skipIf(!canRunBwrap)('does not let a forged relay and process marker authorize direct send', () => {
    const f = fixture('canonical');
    f.policy.net = false;
    let plan: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      const { repoRoot, command, prefixArgs } = allowTestRuntime(f.policy);
      const fakeDataDir = join(f.ownBotHome, 'fake-data');
      plan = prepareDirectSandbox({
        sessionId: 'session', dataDir: f.dataDir, policy: f.policy,
        chdir: repoRoot, home: f.home, cliBin: '/usr/bin/env',
        cliArgs: ['-i', `HOME=${f.home}`, `SESSION_DATA_DIR=${fakeDataDir}`,
          `BOTMUX_SEND_RELAY=${join(f.ownBotHome, 'fake-relay')}`, 'BOTMUX_SESSION_ID=session',
          '/bin/sh', '-c', `
            mkdir -p "$SESSION_DATA_DIR/.botmux-cli-pids"
            printf session > "$SESSION_DATA_DIR/.botmux-cli-pids/$$"
            "$@"
          `, 'marker-fixture', command, ...prefixArgs, join(repoRoot, 'src/cli.ts'),
          'send', 'fixture', '--video'],
      });
      expect(plan).not.toBeNull();
      const result = spawnSync(plan!.bin, plan!.args, {
        cwd: repoRoot, encoding: 'utf8', timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('managed host relay capability is stale or missing');
      expect(result.stderr).not.toContain('--video 需要路径参数');
    } finally {
      cleanup(f, plan);
    }
  });

  it.skipIf(!canRunBwrap)('keeps a valid sandbox capability on the relay path', () => {
    const f = fixture('canonical');
    f.policy.net = false;
    f.policy.rules.push({ path: join(f.dataDir, 'sandboxes/session/outbox'), access: 'readWrite', source: 'internal' });
    let plan: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      const { repoRoot, command, prefixArgs } = allowTestRuntime(f.policy);
      plan = prepareDirectSandbox({
        sessionId: 'session', dataDir: f.dataDir, policy: f.policy,
        chdir: repoRoot, home: f.home, cliBin: command,
        // This flag is rejected at the start of relaySend, proving that the
        // normal relay path was reached without issuing any real request.
        cliArgs: [...prefixArgs, join(repoRoot, 'src/cli.ts'), 'send', 'fixture', '--top-level'],
      });
      expect(plan).not.toBeNull();
      writeFileSync(join(plan!.outbox, RELAY_ORIGIN_CAPABILITY_BASENAME), JSON.stringify({
        token: 'ab'.repeat(32), turnId: 'turn', dispatchAttempt: 1,
      }), { mode: 0o600 });
      const result = spawnSync(plan!.bin, plan!.args, {
        cwd: repoRoot, env: { ...process.env, BOTMUX_SESSION_ID: 'session' },
        encoding: 'utf8', timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('ROUTING_NOT_SUPPORTED');
    } finally {
      cleanup(f, plan);
    }
  });
});
