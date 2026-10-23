/**
 * Real worker lifecycle of a sandboxed session's per-session tree
 * (`<data>/sandboxes/<sid>`: relay outbox, oncall deny-mask mountpoints, the
 * scratch COW overlay) across the two ways a worker detaches from a CLI that it
 * does not end: a daemon restart (SIGTERM → shutdownWorkerForParentExit) and a
 * topic transfer (detach_for_transfer).
 *
 * A persistent tmux pane keeps running through both and still holds a bind of
 * its relay outbox BY INODE, so the tree must survive until the successor
 * worker re-serves it; the successor then has to re-wire the watcher and
 * re-publish the relay capability, and a request written INSIDE the pane must
 * be consumed by the host. PTY owns its CLI (it dies with the worker), so its
 * daemon-restart exit keeps removing the tree. Only a real close removes it for
 * a persistent pane.
 *
 * Fully hermetic: HOME, BOTMUX_HOME, SESSION_DATA_DIR and bots.json live in a
 * temp dir, and `tmux` on PATH is a shim pinned to a private socket. Runs as
 * root or unprivileged: pane liveness uses tmux `#{pane_pid}` (a host pid, not
 * the bwrap-namespace one), the pane shell is pinned to /bin/sh, and every
 * sandbox mechanism is gated on a runtime probe of the exact primitive the
 * worker will use.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';
import { scratchMountRuntimeAvailable } from './helpers/scratch-mount-probe.js';
import { nodeTsRunnerPrefix, spawnNodeTsScript, spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';
import {
  attachSandboxOutbox,
  mountsAtOrUnder,
  probeHostCredentialIsolationMechanism,
  sweepOrphanSandboxes,
} from '../src/adapters/backend/sandbox.js';
import { isMountpoint, sweepOrphanScratchSandboxes, teardownScratchSession } from '../src/adapters/backend/scratch-sandbox.js';
import {
  DEVICE_CREDENTIAL_ISOLATION_MARKER_BASENAME,
  isolationPaneMarkerPath,
} from '../src/adapters/cli/read-isolation.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';
import { recordedSandboxTreeFlavour } from '../src/adapters/backend/sandbox-tree-teardown.js';

type SandboxFlavour = 'off' | 'credential-only' | 'oncall' | 'scratch';
type Backend = 'tmux' | 'pty';
type Detach = 'restore' | 'transfer';

const isRoot = process.getuid?.() === 0;
let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }

/** user + mount + PID namespaces under bwrap: what every sandbox flavour here needs. */
const bwrapRuntime = process.platform === 'linux'
  && (() => {
    const probe = probeHostCredentialIsolationMechanism();
    return probe.supported && probe.mechanism === 'bwrap';
  })();

/** Root mounts a tmpfs slot + kernel overlay; an unprivileged worker can only
 *  serve the disk storage through fuse-overlayfs. */
const scratchStorage: 'tmpfs' | 'disk' = isRoot ? 'tmpfs' : 'disk';

/** Same primitives prepareScratchSandbox needs (see the helper). */
const scratchRuntime = bwrapRuntime && scratchMountRuntimeAvailable(scratchStorage);

function runtimeAvailable(flavour: SandboxFlavour): boolean {
  if (flavour === 'off') return true;
  if (flavour === 'scratch') return scratchRuntime;
  return bwrapRuntime;
}

interface RelayResponse { code?: number; stdout?: string; stderr?: string }
interface Report { event: string; relay?: string | null; id?: string; error?: string }

/** One hermetic session on a private tmux server, driven by real workers. */
function createLab(opts: { flavour: SandboxFlavour; backend: Backend }) {
  const sessionId = randomUUID();
  // Short path: tmux socket paths are length-limited.
  const dir = mkdtempSync('/tmp/sbx-life-');
  const socket = join(dir, 'socket');
  const botmuxHome = join(dir, '.botmux');
  const dataDir = join(botmuxHome, 'data');
  const workDir = join(dir, 'work');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  // The flavour of the NEXT worker start (start() may switch it).
  let flavour: SandboxFlavour = opts.flavour;
  let everScratch = false;
  const deviceMarker = join(botmuxHome, DEVICE_CREDENTIAL_ISOLATION_MARKER_BASENAME);
  const applyFlavour = (next: SandboxFlavour): void => {
    flavour = next;
    if (next === 'scratch') everScratch = true;
    // Device enrolled: mandatory credential isolation; bot sandbox stays OFF.
    // (oncall / scratch cover credentials themselves; "off" means not enrolled.)
    if (next === 'credential-only') writeFileSync(deviceMarker, '{}', { mode: 0o600 });
    if (next === 'off') rmSync(deviceMarker, { force: true });
  };
  applyFlavour(opts.flavour);
  // Under ~/.botmux: a no-transport (apiOnly) oncall policy refuses a bots
  // config outside every botmux authority root.
  const bots = join(botmuxHome, 'bots.json');
  writeFileSync(bots, JSON.stringify([{ larkAppId: 'app_probe', larkAppSecret: '', apiOnly: true, cliId: 'claude-code' }]));
  const sessionRoot = join(dataDir, 'sandboxes', sessionId);
  const outbox = join(sessionRoot, 'outbox');
  const capabilityLeaf = join(outbox, RELAY_ORIGIN_CAPABILITY_BASENAME);
  // The fake CLI lives in the working dir (visible in every flavour: oncall
  // grants it, scratch re-exposes its COW view over the fresh /tmp) and keeps
  // its report in the host-real outbox (scratch writes elsewhere never reach
  // the host). `RELAY-PING <id>` typed into the pane writes a relay request the
  // same way the in-sandbox `botmux send` does.
  const script = join(workDir, 'fake-cli');
  // Pin the extensionless script to CommonJS: credential-only sees the real
  // /tmp, and a stray ancestor package.json with "type": "module" (another
  // process's temp file) would otherwise flip it to ESM.
  writeFileSync(join(workDir, 'package.json'), '{"type":"commonjs"}\n');
  writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const relay = process.env.BOTMUX_SEND_RELAY || null;
const reportFile = path.join(relay || __dirname, 'fake-cli-report.jsonl');
const report = (entry) => { try { fs.appendFileSync(reportFile, JSON.stringify(entry) + '\\n'); } catch {} };
report({ event: 'start', relay });
const ping = (id) => {
  try {
    const capability = JSON.parse(fs.readFileSync(path.join(relay, ${JSON.stringify(RELAY_ORIGIN_CAPABILITY_BASENAME)}), 'utf8'));
    fs.writeFileSync(path.join(relay, id + '.content'), 'pong ' + id);
    const tmp = path.join(relay, '.' + id + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ contentFile: id + '.content', flags: [], originCapability: capability.token }));
    fs.renameSync(tmp, path.join(relay, id + '.req.json'));
    report({ event: 'ping', id });
  } catch (error) {
    report({ event: 'ping-error', id, error: String((error && error.message) || error) });
  }
};
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  const lines = pending.split(/[\\r\\n]/);
  pending = lines.pop();
  for (const line of lines) {
    const match = /RELAY-PING ([0-9a-f]+)/.exec(line);
    if (match) ping(match[1]);
  }
});
console.log('Ready >');
setInterval(() => {}, 1 << 30);
`, { mode: 0o755 });
  const reportFile = (): string => join(flavour === 'off' ? workDir : outbox, 'fake-cli-report.jsonl');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const paneTarget = `bmx-${sessionId.slice(0, 8)}`;
  // `failNewSession` makes creating THIS session's pane fail (the worker's
  // earlier backend-availability probe uses its own session), i.e. after the
  // worker has already built the sandbox tree for a fresh launch.
  const failNewSessionFlag = join(dir, 'fail-new-session');
  // `failKillSession` makes every kill fail (a pane that cannot be retired).
  const failKillSessionFlag = join(dir, 'fail-kill-session');
  // `corruptProofOnPipePane` garbles this session's PENDING isolation proof the
  // moment the worker attaches pipe-pane, i.e. after its pane exists: the
  // post-spawn provenance commit then fails (a real post-spawn failure exit).
  const corruptProofFlag = join(dir, 'corrupt-proof-on-pipe-pane');
  // `exitingServerOnPostKillProbes(ordinals)`: after a kill of THIS pane (plain,
  // or the conditional one a retire sends), each listed has-session of it (1 =
  // the first probe after the kill) meets the server while it is still exiting
  // (killing its last session makes a tmux server exit), i.e. reads `server
  // exited unexpectedly`. Scoped to the pane so unrelated kills/probes
  // (diagnostic sessions, backend selection) neither arm nor count.
  const exitingServerFlag = join(dir, 'exiting-server-on-post-kill-probe');
  const paneMarker = isolationPaneMarkerPath(dataDir, sessionId);
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh
if [ -e '${failNewSessionFlag}' ]; then
  creating=0; ours=0
  for arg in "$@"; do
    [ "$arg" = new-session ] && creating=1
    [ "$arg" = '${paneTarget}' ] && ours=1
  done
  if [ $creating = 1 ] && [ $ours = 1 ]; then echo 'new-session refused by test' >&2; exit 1; fi
fi
if [ -e '${failKillSessionFlag}' ]; then
  # Any kill: a plain kill-session, or the conditional one a retire sends.
  # Scan every argument: managed calls lead with the server (\`-L botmux\`).
  for arg in "$@"; do
    if [ "$arg" = if-shell ]; then echo 'if-shell refused by test' >&2; exit 1; fi
    if [ "$arg" = kill-session ]; then echo 'kill-session refused by test' >&2; exit 1; fi
  done
fi
if [ -e '${exitingServerFlag}' ]; then
  ours=0; killing=0; probing=0
  for arg in "$@"; do
    case "$arg" in
      '${paneTarget}'|'=${paneTarget}') ours=1 ;;
      *kill-session*'${paneTarget}'*) ours=1; killing=1 ;;
    esac
    [ "$arg" = kill-session ] && killing=1
    [ "$arg" = has-session ] && probing=1
  done
  [ $ours = 1 ] && [ $killing = 1 ] && : > '${exitingServerFlag}.killed'
  if [ $ours = 1 ] && [ $probing = 1 ] && [ -e '${exitingServerFlag}.killed' ]; then
    echo >> '${exitingServerFlag}.probes'
    seen=$(($(wc -l < '${exitingServerFlag}.probes')))
    for want in $(cat '${exitingServerFlag}'); do
      if [ "$seen" -eq "$want" ]; then
        echo fired >> '${exitingServerFlag}.fired'
        echo 'server exited unexpectedly' >&2; exit 1
      fi
    done
  fi
fi
if [ -e '${corruptProofFlag}' ]; then
  for arg in "$@"; do
    if [ "$arg" = pipe-pane ]; then printf 'garbled-by-test' > '${paneMarker}'; fi
  done
fi
exec '${realTmux}' -S '${socket}' "$@"
`, { mode: 0o755 });
  // Loaded into the worker only: SIGUSR2 throws on the event loop, i.e. a real
  // uncaughtException through the worker's own crash handler.
  const crashHook = join(dir, 'crash-hook.cjs');
  writeFileSync(crashHook, `process.on('SIGUSR2', () => setImmediate(() => { throw new Error('test-induced worker crash'); }));\n`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    // Pane launch goes through the user's shell; pin a plain one so the test
    // does not depend on the runner's login shell (nologin for service
    // accounts) or its rcfiles.
    SHELL: '/bin/sh',
    SESSION_DATA_DIR: dataDir,
    BOTS_CONFIG: bots,
    BOTMUX_NO_CLAIM: '1',
  };
  for (const key of Object.keys(env)) if (key.startsWith('BOTMUX_') && key !== 'BOTMUX_NO_CLAIM') delete env[key];
  delete env.TMUX;
  delete env.TMUX_PANE;
  const init = (bootId: string) => ({
    type: 'init', sessionId, chatId: 'oc_probechat', rootMessageId: 'om_probe', workingDir: workDir,
    cliId: 'claude-code', cliPathOverride: script, backendType: opts.backend,
    // A daemon restore (forkWorker(ds, '', true)) carries no prompt and no turn.
    prompt: '',
    apiOnly: true, larkAppId: 'app_probe', larkAppSecret: '', ownerOpenId: 'ou_owner', daemonBootId: bootId,
    loadedBotsConfigPath: bots, loadedBotsConfigProvenance: 'loaded', promptInjection: 'none',
    ...(flavour === 'oncall' ? { sandbox: 'oncall' } : {}),
    ...(flavour === 'scratch' ? { sandbox: 'scratch', scratchStorage } : {}),
  });
  const workers = new Set<ChildProcess>();
  const tmuxCommand = (args: string[]) => spawnSync(realTmux!, ['-S', socket, ...args], { encoding: 'utf8' });
  const lab = {
    sessionId, dataDir, sessionRoot, outbox, capabilityLeaf, script,
    reports: (): Report[] => existsSync(reportFile())
      ? readFileSync(reportFile(), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : [],
    starts: (): Report[] => lab.reports().filter(entry => entry.event === 'start'),
    paneAlive: (): boolean => tmuxCommand(['has-session', '-t', paneTarget]).status === 0,
    // HOST pid of the pane's process. (The fake CLI's own process.pid is
    // namespace-local under bwrap --unshare-pid and means nothing out here.)
    panePid: (): number => Number(tmuxCommand(['display-message', '-p', '-t', paneTarget, '#{pane_pid}']).stdout.trim()),
    hostProcessAlive: (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    },
    failNewSession: (): void => writeFileSync(failNewSessionFlag, ''),
    corruptProofOnPipePane: (): void => writeFileSync(corruptProofFlag, ''),
    exitingServerOnPostKillProbes: (ordinals: number[]): void => {
      if (ordinals.length) writeFileSync(exitingServerFlag, ordinals.join(' '));
    },
    /** How many injected `server exited unexpectedly` answers were actually given. */
    exitingServerProbesFired: (): number => existsSync(`${exitingServerFlag}.fired`)
      ? readFileSync(`${exitingServerFlag}.fired`, 'utf8').split('\n').filter(Boolean).length
      : 0,
    failKillSession: (on: boolean): void => {
      if (on) writeFileSync(failKillSessionFlag, '');
      else rmSync(failKillSessionFlag, { force: true });
    },
    killPane: (): boolean => tmuxCommand(['kill-session', '-t', `=${paneTarget}`]).status === 0,
    /** The daemon's worker-less close (killWorker with no live worker), run
     *  out of process against this lab's data dir and tmux. */
    closeWithoutWorker(): string {
      const result = spawnSyncTsEvalWithRepoImports(`
        import { killWorker } from './src/core/worker-pool.js';
        killWorker({
          larkAppId: 'app_probe', chatId: 'oc_probechat', chatType: 'group', scope: 'thread', worker: null,
          session: { sessionId: ${JSON.stringify(sessionId)}, backendType: 'tmux', rootMessageId: 'om_probe' },
          initConfig: { backendType: 'tmux' },
        });
      `, { env, encoding: 'utf8', timeout: 60_000 });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      return `${result.stdout}\n${result.stderr}`;
    },
    /** Host pids whose argv runs this lab's fake CLI (any pid namespace).
     *  Linux-only (/proc); elsewhere only the unsandboxed tmux case runs and
     *  `kill-server` already ends its pane. */
    cliHostPids: (): number[] => {
      const pids: number[] = [];
      if (process.platform !== 'linux') return pids;
      let entries: string[];
      try { entries = readdirSync('/proc'); } catch { return pids; }
      for (const pid of entries) {
        if (!/^\d+$/.test(pid)) continue;
        let argv: string[];
        try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { continue; }
        // The CLI process itself (`node <script>`), not the bwrap/sh launchers
        // whose argv merely mentions the script path.
        if (/(^|\/)node$/.test(argv[0] ?? '') && argv[1] === script) pids.push(Number(pid));
      }
      return pids;
    },
    scratchMerged: (): string | null => {
      try { return (JSON.parse(readFileSync(join(sessionRoot, 'scratch.json'), 'utf8')) as { merged: string }).merged; }
      catch { return null; }
    },
    /** Type `RELAY-PING <id>` into the pane; the CLI turns it into a relay request. */
    ping(): string {
      const id = randomBytes(8).toString('hex');
      const sent = tmuxCommand(['send-keys', '-t', paneTarget, `RELAY-PING ${id}`, 'Enter']);
      expect(sent.status, sent.stderr).toBe(0);
      return id;
    },
    response: (id: string): RelayResponse | null => {
      try { return JSON.parse(readFileSync(join(outbox, `${id}.res.json`), 'utf8')) as RelayResponse; }
      catch { return null; }
    },
    start(
      bootId: string,
      startOpts: { env?: NodeJS.ProcessEnv; crashHook?: boolean; flavour?: SandboxFlavour; envPolicy?: { mode: 'strict' } } = {},
    ): { worker: ChildProcess; logs: () => string; errors: () => string[] } {
      if (startOpts.flavour) applyFlavour(startOpts.flavour);
      const workerEnv = { ...env, ...startOpts.env };
      const stdio: ['ignore', 'pipe', 'pipe', 'ipc'] = ['ignore', 'pipe', 'pipe', 'ipc'];
      const worker = startOpts.crashHook
        ? (() => {
            const { command, prefixArgs } = nodeTsRunnerPrefix();
            return spawn(command, ['--require', crashHook, ...prefixArgs, 'src/worker.ts'], { env: workerEnv, stdio });
          })()
        : spawnNodeTsScript('src/worker.ts', [], { env: workerEnv, stdio });
      workers.add(worker);
      let logs = '';
      const errors: string[] = [];
      worker.stdout?.on('data', data => { logs += String(data); });
      worker.stderr?.on('data', data => { logs += String(data); });
      worker.on('message', (message: { type?: string; message?: string }) => {
        if (message?.type === 'error') errors.push(String(message.message));
      });
      worker.send({ ...init(bootId), ...(startOpts.envPolicy ? { envPolicy: startOpts.envPolicy } : {}) });
      return { worker, logs: () => logs, errors: () => errors };
    },
    async stop(worker: ChildProcess, how: 'SIGTERM' | 'transfer' | 'close'): Promise<void> {
      // A worker that already exited (e.g. a failed launch) has no IPC channel.
      if (worker.exitCode !== null || worker.signalCode !== null) { workers.delete(worker); return; }
      const exited = once(worker, 'exit');
      if (how === 'close') worker.send({ type: 'close' });
      else if (how === 'transfer') worker.send({ type: 'detach_for_transfer', requestId: `transfer-${randomUUID()}` });
      else worker.kill('SIGTERM');
      const timer = setTimeout(() => worker.kill('SIGKILL'), 30_000);
      try { if (worker.exitCode === null && worker.signalCode === null) await exited; }
      finally { clearTimeout(timer); workers.delete(worker); }
    },
    async dispose(): Promise<void> {
      for (const worker of [...workers]) await lab.stop(worker, 'close').catch(() => undefined);
      try { execFileSync(realTmux!, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
      for (const pid of lab.cliHostPids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      // Never leave a host overlay / tmpfs slot behind a failed assertion.
      if (everScratch) teardownScratchSession(sessionId, dataDir);
      // teardownScratchSession keeps a tree it could not unmount; so does this
      // (reported, never deleted through the full-root COW view).
      rmSandboxScratch(dir);
    },
  };
  return lab;
}

type Lab = ReturnType<typeof createLab>;

/** A request typed inside the pane is consumed by the host watcher, authorized
 *  against the CURRENT relay capability and re-executed outside the sandbox. */
async function expectPaneRelayServed(lab: Lab, logs: () => string): Promise<void> {
  const id = lab.ping();
  await vi.waitFor(() => expect(lab.reports().some(entry => entry.id === id), logs()).toBe(true), { timeout: 20_000 });
  expect(lab.reports().find(entry => entry.id === id)?.event, JSON.stringify(lab.reports())).toBe('ping');
  // The host re-exec of `botmux send` loads the whole CLI; allow for a busy runner.
  await vi.waitFor(() => expect(lab.response(id), logs()).not.toBeNull(), { timeout: 60_000 });
  const response = lab.response(id)!;
  expect(response.stderr ?? '', JSON.stringify(response)).not.toMatch(/relay rejected|relay: bad json/);
  expect(typeof response.code).toBe('number');
  // The watcher consumes a request before publishing its response, so this
  // holds the moment the response is visible (sandbox-relay-watcher.test.ts).
  expect(existsSync(join(lab.outbox, `${id}.req.json`))).toBe(false);
}

async function workerExit(started: { worker: ChildProcess; logs: () => string }): Promise<void> {
  const { worker } = started;
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      once(worker, 'exit'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`worker did not exit\n${started.logs()}`)), 60_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const sandboxed: SandboxFlavour[] = ['oncall', 'scratch', 'credential-only'];

describe.each(sandboxed)('%s sandbox tree across a real worker lifecycle', (flavour) => {
  const runtime = runtimeAvailable(flavour);

  it.skipIf(!realTmux || !runtime).each(['restore', 'transfer'] as Detach[])(
    'tmux × %s: keeps the tree for the live pane, re-serves its relay, removes it on close',
    async (detach) => {
      const lab = createLab({ flavour, backend: 'tmux' });
      try {
        // 1. Fresh sandboxed spawn: the CLI sees the relay and the host serves it.
        const first = lab.start('boot-1');
        await vi.waitFor(() => expect(lab.starts().length, first.logs()).toBe(1), { timeout: 60_000 });
        expect(lab.starts()[0]!.relay).toBe(lab.outbox);
        await vi.waitFor(() => expect(existsSync(lab.capabilityLeaf), first.logs()).toBe(true), { timeout: 20_000 });
        await vi.waitFor(() => expect(readFileSync(isolationPaneMarkerPath(lab.dataDir, lab.sessionId), 'utf8'), first.logs())
          .toContain('committed'), { timeout: 60_000 });
        await expectPaneRelayServed(lab, first.logs);
        const panePid = lab.panePid();
        expect(panePid).toBeGreaterThan(1);
        // Same user as this test, so a plain liveness probe is meaningful (no EPERM).
        expect(lab.hostProcessAlive(panePid)).toBe(true);
        const merged = flavour === 'scratch' ? lab.scratchMerged() : null;
        if (flavour === 'scratch') expect(merged && isMountpoint(merged)).toBe(true);

        // 2. Detach without ending the CLI. The pane survives; so must its tree.
        await lab.stop(first.worker, detach === 'restore' ? 'SIGTERM' : 'transfer');
        expect(lab.paneAlive()).toBe(true);
        expect(existsSync(lab.outbox), first.logs()).toBe(true);
        // This generation's relay authority is revoked with the worker.
        expect(existsSync(lab.capabilityLeaf), first.logs()).toBe(false);
        if (flavour === 'scratch') {
          // The host-side COW view (transcript reads, cold resume) stays mounted.
          expect(lab.scratchMerged(), first.logs()).toBe(merged);
          expect(isMountpoint(merged!)).toBe(true);
        }

        // 3. Successor worker reattaches the SAME live CLI and re-serves the relay.
        const second = lab.start('boot-2');
        await vi.waitFor(() => expect(second.logs()).toContain('REATTACH'), { timeout: 60_000 });
        await vi.waitFor(() => expect(existsSync(lab.capabilityLeaf), second.logs()).toBe(true), { timeout: 20_000 });
        expect(second.logs()).not.toMatch(/no on-disk sandbox tree|no scratch tree found|lost its relay outbox/);
        expect(lab.starts(), second.logs()).toHaveLength(1); // no cold spawn
        expect(lab.panePid()).toBe(panePid);
        expect(lab.hostProcessAlive(panePid)).toBe(true);
        await expectPaneRelayServed(lab, second.logs);

        // 4. A real close removes the pane and the whole tree.
        await lab.stop(second.worker, 'close');
        await vi.waitFor(() => expect(existsSync(lab.sessionRoot), second.logs()).toBe(false), { timeout: 20_000 });
        expect(lab.paneAlive()).toBe(false);
        if (flavour === 'scratch') expect(isMountpoint(merged!)).toBe(false);
      } finally {
        await lab.dispose();
      }
    },
    240_000,
  );

  // A fresh launch builds the tree before the pane exists. If pane creation
  // fails, nothing will ever run against that tree: the fatal exit must roll it
  // back (mountpoints, args file, scratch overlay) — the orphan sweep skips the
  // still-active session and would never reclaim it.
  it.skipIf(!realTmux || !runtime)('tmux × fresh launch failing before the pane exists: rolls the tree back', async () => {
    const lab = createLab({ flavour, backend: 'tmux' });
    try {
      lab.failNewSession();
      const first = lab.start('boot-1');
      await vi.waitFor(() => expect(first.logs()).toMatch(/Sandbox ON \(|in credential-only bwrap/), { timeout: 60_000 });
      await workerExit(first);
      expect(first.errors().join('\n'), first.logs()).toContain('new-session refused by test');
      expect(lab.paneAlive()).toBe(false);
      expect(lab.starts()).toEqual([]);
      expect(existsSync(lab.sessionRoot), first.logs()).toBe(false);
      if (flavour === 'scratch') {
        expect(isMountpoint(join(lab.sessionRoot, 'root'))).toBe(false);
        expect(existsSync(join('/var/tmp/botmux-scratch', lab.sessionId))).toBe(false);
      }
    } finally {
      await lab.dispose();
    }
  }, 120_000);

  // tmux creates the detached pane first, then the FIFO / wake fd / pipe-pane.
  // A failure after the pane exists must retire exactly that pane before the
  // tree goes — and keep the tree when that cannot be proven.
  it.skipIf(!realTmux || !runtime)('tmux × fresh launch failing after its pane exists: retires that pane, then rolls the tree back', async () => {
    const lab = createLab({ flavour, backend: 'tmux' });
    try {
      const first = lab.start('boot-1', { env: { BOTMUX_TEST_FORCE_WAKE_OPEN_FAIL: '1' } });
      await workerExit(first);
      expect(first.errors().join('\n'), first.logs()).toContain('EMFILE: injected by test');
      expect(first.logs()).toContain('retired the tmux session it had created');
      expect(lab.paneAlive()).toBe(false);
      expect(existsSync(lab.sessionRoot), first.logs()).toBe(false);
      if (flavour === 'scratch') {
        expect(isMountpoint(join(lab.sessionRoot, 'root'))).toBe(false);
        expect(existsSync(join('/var/tmp/botmux-scratch', lab.sessionId))).toBe(false);
      }
    } finally {
      await lab.dispose();
    }
  }, 120_000);

  it.skipIf(!realTmux || !runtime)('tmux × fresh launch failing after its pane exists, pane cannot be retired: keeps the tree for it', async () => {
    const lab = createLab({ flavour, backend: 'tmux' });
    try {
      lab.failKillSession(true);
      const first = lab.start('boot-1', { env: { BOTMUX_TEST_FORCE_WAKE_OPEN_FAIL: '1' } });
      await workerExit(first);
      expect(first.errors().join('\n'), first.logs()).toContain('EMFILE: injected by test');
      expect(first.logs()).toContain('keeping the sandbox tree for the pane that may still run');
      expect(lab.paneAlive()).toBe(true);
      expect(existsSync(lab.outbox), first.logs()).toBe(true);
      if (flavour === 'scratch') expect(isMountpoint(join(lab.sessionRoot, 'root'))).toBe(true);
    } finally {
      lab.failKillSession(false);
      await lab.dispose();
    }
  }, 120_000);

  // A post-spawn failure exit (here: the provenance commit) tears the fresh
  // pane down before refusing. Preservation is armed as soon as the pane
  // exists and dropped only once the teardown PROVED the pane gone — never
  // leave a live pane without the relay tree it is bound to.
  // The retire kills the private server's last session, so its post-kill probe
  // can meet that server mid-exit ('unknown' once, or twice in a row): that
  // transient must not keep the tree as if the pane might still run.
  it.skipIf(!realTmux || !runtime).each([
    { variant: '', exitingProbes: [] as number[] },
    { variant: ' (post-kill probe 1 meets the exiting tmux server)', exitingProbes: [1] },
    { variant: ' (post-kill probes 1 & 2 meet the exiting tmux server)', exitingProbes: [1, 2] },
  ])('tmux × provenance commit fails after the pane exists, pane retired$variant: rolls the tree back', async ({ exitingProbes }) => {
    const lab = createLab({ flavour, backend: 'tmux' });
    try {
      lab.corruptProofOnPipePane();
      lab.exitingServerOnPostKillProbes(exitingProbes);
      const first = lab.start('boot-1');
      await workerExit(first);
      expect(first.errors().join('\n'), first.logs()).toMatch(/could not commit .* generation proof/);
      expect(lab.exitingServerProbesFired(), first.logs()).toBe(exitingProbes.length);
      expect(lab.paneAlive()).toBe(false);
      expect(existsSync(lab.sessionRoot), first.logs()).toBe(false);
      if (flavour === 'scratch') expect(mountsAtOrUnder(dirname(lab.dataDir))).toEqual([]);
    } finally {
      await lab.dispose();
    }
  }, 120_000);

  it.skipIf(!realTmux || !runtime)('tmux × provenance commit fails, pane cannot be retired: keeps the tree for it', async () => {
    const lab = createLab({ flavour, backend: 'tmux' });
    try {
      lab.corruptProofOnPipePane();
      lab.failKillSession(true);
      const first = lab.start('boot-1');
      await workerExit(first);
      expect(first.errors().join('\n'), first.logs()).toMatch(/post-kill probe exists \(not missing\)/);
      expect(lab.paneAlive()).toBe(true);
      expect(existsSync(lab.outbox), first.logs()).toBe(true);
      if (flavour === 'scratch') expect(isMountpoint(join(lab.sessionRoot, 'root'))).toBe(true);
    } finally {
      lab.failKillSession(false);
      await lab.dispose();
    }
  }, 120_000);

  // A crash keeps the tree for a successor (the pane survives). If the session
  // is closed before any successor attached, the daemon's worker-less close is
  // the only cleanup left: it must retire the pane, then tear the tree down
  // with the flavour's own teardown (scratch: unmount first). The kill takes
  // the private server's last session, so the post-kill probe can meet that
  // server mid-exit; that transient must not leave the tree behind.
  it.skipIf(!realTmux || !runtime).each([
    { variant: 'the worker-less close tears the tree down', exitingProbes: [] as number[] },
    { variant: 'a post-kill probe that meets the exiting tmux server still tears the tree down', exitingProbes: [1] },
  ])('tmux × worker crash, closed before a successor attached: $variant', async ({ exitingProbes }) => {
    const lab = createLab({ flavour, backend: 'tmux' });
    try {
      const first = lab.start('boot-1', { crashHook: true });
      await vi.waitFor(() => expect(lab.starts().length, first.logs()).toBe(1), { timeout: 60_000 });
      await vi.waitFor(() => expect(readFileSync(isolationPaneMarkerPath(lab.dataDir, lab.sessionId), 'utf8'), first.logs())
        .toContain('committed'), { timeout: 60_000 });
      const merged = flavour === 'scratch' ? lab.scratchMerged() : null;
      first.worker.kill('SIGUSR2');
      await workerExit(first);
      expect(first.worker.exitCode, first.logs()).toBe(1);
      expect(first.logs()).toContain('test-induced worker crash');
      // The crash kept the tree for the still-running pane.
      expect(lab.paneAlive()).toBe(true);
      expect(existsSync(lab.outbox), first.logs()).toBe(true);
      if (merged) expect(isMountpoint(merged)).toBe(true);

      lab.exitingServerOnPostKillProbes(exitingProbes);
      const closeLog = lab.closeWithoutWorker();
      expect(lab.exitingServerProbesFired(), closeLog).toBe(exitingProbes.length);
      expect(lab.paneAlive(), closeLog).toBe(false);
      expect(existsSync(lab.sessionRoot), closeLog).toBe(false);
      if (merged) {
        expect(isMountpoint(merged)).toBe(false);
        expect(existsSync(join('/var/tmp/botmux-scratch', lab.sessionId))).toBe(false);
      }
    } finally {
      await lab.dispose();
    }
  }, 120_000);

  // Same crash, but the pane vanished on its own and the session went inactive:
  // the daemon's periodic generic sweep runs first. It must never recurse into
  // the still-mounted full-root COW view (it would walk the whole host and fill
  // the upper with whiteouts); the scratch teardown unmounts first.
  it.skipIf(!realTmux || !runtime || flavour !== 'scratch')('tmux × worker crash, pane gone: the generic orphan sweep never recurses into the mounted scratch tree', async () => {
    const lab = createLab({ flavour, backend: 'tmux' });
    try {
      const first = lab.start('boot-1', { crashHook: true });
      await vi.waitFor(() => expect(lab.starts().length, first.logs()).toBe(1), { timeout: 60_000 });
      const merged = lab.scratchMerged()!;
      first.worker.kill('SIGUSR2');
      await workerExit(first);
      expect(lab.killPane()).toBe(true);
      await vi.waitFor(() => expect(lab.cliHostPids()).toEqual([]), { timeout: 20_000 });
      expect(isMountpoint(merged)).toBe(true);
      // A COW write through the merged view, which a traversal would delete.
      const canary = join(merged, dirname(lab.script), 'sweep-canary');
      writeFileSync(canary, 'kept');
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(lab.sessionRoot, old, old);

      sweepOrphanSandboxes(lab.dataDir, new Set());
      expect(existsSync(lab.sessionRoot)).toBe(true);
      expect(isMountpoint(merged)).toBe(true);
      expect(readFileSync(canary, 'utf8')).toBe('kept');

      // (Not sweepOrphanScratchSandboxes: its /var/tmp slot pass is host-wide.)
      teardownScratchSession(lab.sessionId, lab.dataDir);
      expect(isMountpoint(merged)).toBe(false);
      expect(existsSync(lab.sessionRoot)).toBe(false);
    } finally {
      await lab.dispose();
    }
  }, 120_000);

  // A build without this fix (or any other loss) deleted the tree under a pane
  // that is still alive. Nothing can re-serve the outbox it bound by inode, so
  // the successor must cold-spawn — never reattach a pane whose sends nobody
  // answers, nor serve a recreated outbox the pane cannot see.
  it.skipIf(!realTmux || !runtime)('tmux × restore after the tree was lost: cold-spawns instead of reattaching', async () => {
    const lab = createLab({ flavour, backend: 'tmux' });
    try {
      const first = lab.start('boot-1');
      await vi.waitFor(() => expect(lab.starts().length, first.logs()).toBe(1), { timeout: 60_000 });
      await vi.waitFor(() => expect(readFileSync(isolationPaneMarkerPath(lab.dataDir, lab.sessionId), 'utf8'), first.logs())
        .toContain('committed'), { timeout: 60_000 });
      const panePid = lab.panePid();
      await lab.stop(first.worker, 'SIGTERM');
      expect(lab.paneAlive()).toBe(true);
      // Exactly the teardown the old exit path ran.
      if (flavour === 'scratch') teardownScratchSession(lab.sessionId, lab.dataDir);
      else attachSandboxOutbox({ sessionId: lab.sessionId, dataDir: lab.dataDir })!.cleanup();
      expect(existsSync(lab.sessionRoot)).toBe(false);

      const second = lab.start('boot-2');
      await vi.waitFor(() => expect(second.logs()).toContain('lost its relay outbox — killing + cold-spawning'), { timeout: 60_000 });
      await vi.waitFor(() => expect(lab.starts().length, second.logs()).toBe(1), { timeout: 60_000 });
      expect(lab.starts()[0]!.relay).toBe(lab.outbox);
      expect(lab.hostProcessAlive(panePid)).toBe(false);
      expect(lab.panePid()).not.toBe(panePid);
      await vi.waitFor(() => expect(existsSync(lab.capabilityLeaf), second.logs()).toBe(true), { timeout: 20_000 });
      await expectPaneRelayServed(lab, second.logs);
      await lab.stop(second.worker, 'close');
      await vi.waitFor(() => expect(existsSync(lab.sessionRoot), second.logs()).toBe(false), { timeout: 20_000 });
    } finally {
      await lab.dispose();
    }
  }, 240_000);

  // PTY owns its CLI: the worker's exit ends it, so nothing survives to re-serve.
  it.skipIf(!runtime)('pty × restore: a daemon-restart exit ends the CLI and removes its tree', async () => {
    const lab = createLab({ flavour, backend: 'pty' });
    try {
      const first = lab.start('boot-1');
      await vi.waitFor(() => expect(lab.starts().length, first.logs()).toBe(1), { timeout: 60_000 });
      await vi.waitFor(() => expect(existsSync(lab.capabilityLeaf), first.logs()).toBe(true), { timeout: 20_000 });
      expect(lab.cliHostPids().length, first.logs()).toBe(1);
      const merged = flavour === 'scratch' ? lab.scratchMerged() : null;
      await lab.stop(first.worker, 'SIGTERM');
      await vi.waitFor(() => expect(lab.cliHostPids(), first.logs()).toEqual([]), { timeout: 20_000 });
      expect(existsSync(lab.sessionRoot), first.logs()).toBe(false);
      if (merged) expect(isMountpoint(merged)).toBe(false);
    } finally {
      await lab.dispose();
    }
  }, 120_000);

  // Transfer already kept the tree for the replacement worker (which cold-spawns
  // over it); pinned so a unified preserve decision cannot regress it.
  it.skipIf(!runtime)('pty × transfer: keeps the tree for the replacement, which cold-spawns and serves it', async () => {
    const lab = createLab({ flavour, backend: 'pty' });
    try {
      const first = lab.start('boot-1');
      await vi.waitFor(() => expect(lab.starts().length, first.logs()).toBe(1), { timeout: 60_000 });
      await vi.waitFor(() => expect(existsSync(lab.capabilityLeaf), first.logs()).toBe(true), { timeout: 20_000 });
      await lab.stop(first.worker, 'transfer');
      await vi.waitFor(() => expect(lab.cliHostPids(), first.logs()).toEqual([]), { timeout: 20_000 });
      expect(existsSync(lab.outbox), first.logs()).toBe(true);
      const second = lab.start('boot-2');
      await vi.waitFor(() => expect(lab.starts().length, second.logs()).toBe(2), { timeout: 60_000 });
      await vi.waitFor(() => expect(existsSync(lab.capabilityLeaf), second.logs()).toBe(true), { timeout: 20_000 });
      await lab.stop(second.worker, 'close');
      await vi.waitFor(() => expect(existsSync(lab.sessionRoot), second.logs()).toBe(false), { timeout: 20_000 });
    } finally {
      await lab.dispose();
    }
  }, 120_000);
});

describe('unsandboxed session across a real worker lifecycle', () => {
  it.skipIf(!realTmux)('tmux × restore: reattaches the pane and never creates a sandbox tree', async () => {
    const lab = createLab({ flavour: 'off', backend: 'tmux' });
    try {
      const first = lab.start('boot-1');
      await vi.waitFor(() => expect(lab.starts().length, first.logs()).toBe(1), { timeout: 60_000 });
      expect(lab.starts()[0]!.relay).toBeNull();
      const panePid = lab.panePid();
      await lab.stop(first.worker, 'SIGTERM');
      expect(lab.paneAlive()).toBe(true);
      const second = lab.start('boot-2');
      await vi.waitFor(() => expect(second.logs()).toMatch(/Re-attaching to existing tmux session/), { timeout: 60_000 });
      expect(lab.starts(), second.logs()).toHaveLength(1);
      expect(lab.panePid()).toBe(panePid);
      expect(existsSync(lab.sessionRoot)).toBe(false);
      await lab.stop(second.worker, 'close');
      expect(lab.paneAlive()).toBe(false);
      expect(existsSync(lab.sessionRoot)).toBe(false);
    } finally {
      await lab.dispose();
    }
  }, 120_000);
});

// A policy flip across a daemon restart (sandbox on/off, oncall <-> scratch <->
// credential-only) while the old pane and its tree were preserved. The
// successor must not reattach the pane under the new flavour, and must tear
// the OLD tree down with ITS OWN teardown (scratch: unmount first) once the
// pane is gone, before building the new tree in the same place - never prepare
// a credential-only outbox inside a still-mounted full-root COW view.
const flavourSwitches: Array<[SandboxFlavour, SandboxFlavour]> = [
  ['scratch', 'credential-only'],
  ['scratch', 'oncall'],
  ['scratch', 'off'],
  ['oncall', 'scratch'],
  ['oncall', 'credential-only'],
  ['credential-only', 'oncall'],
];

describe('sandbox flavour switch across a daemon restart', () => {
  const switchRuns = (from: SandboxFlavour, to: SandboxFlavour): boolean =>
    !!realTmux && runtimeAvailable(from) && runtimeAvailable(to);
  // Combinations this host cannot run are reported as skipped, never as passed.
  // The retire kills the private server's last session, so a probe after it
  // can meet that server mid-exit ('unknown'); one pair also runs with that
  // transient injected: the new pane must still cold-spawn, not be refused.
  // Probe 1 is the migration's own confirmation, probe 2 the tree
  // reconciliation's check of the same (by then gone) pane.
  for (const [from, to, exitingProbes] of [
    ...flavourSwitches.map(([from, to]) => [from, to, [] as number[]] as const),
    ['oncall', 'credential-only', [1]] as const,
    ['oncall', 'credential-only', [2]] as const,
  ]) {
    const variant = exitingProbes.length ? ` (post-kill probe ${exitingProbes.join(' & ')} meets the exiting tmux server)` : '';
    it.skipIf(!switchRuns(from, to))(`tmux ${from} -> ${to}${variant}: retires the old pane, tears its tree down first, then builds the new one`, async () => {
      const lab = createLab({ flavour: from, backend: 'tmux' });
      try {
        const first = lab.start('boot-1');
        await vi.waitFor(() => expect(lab.starts().length, first.logs()).toBe(1), { timeout: 60_000 });
        await vi.waitFor(() => expect(readFileSync(isolationPaneMarkerPath(lab.dataDir, lab.sessionId), 'utf8'), first.logs())
          .toContain('committed'), { timeout: 60_000 });
        const oldPane = lab.panePid();
        const merged = from === 'scratch' ? lab.scratchMerged() : null;
        await lab.stop(first.worker, 'SIGTERM');
        expect(existsSync(lab.outbox), first.logs()).toBe(true);
        expect(recordedSandboxTreeFlavour(lab.sessionId, lab.dataDir)).toBe(from);

        lab.exitingServerOnPostKillProbes([...exitingProbes]);
        const second = lab.start('boot-2', { flavour: to });
        await vi.waitFor(() => expect(second.logs()).toContain(`sandbox flavour changed (${from} → ${to === 'off' ? 'none' : to})`), { timeout: 60_000 });
        expect(lab.exitingServerProbesFired(), second.logs()).toBe(exitingProbes.length);
        // The old tree (and the old CLI's report in it) is gone and the new
        // flavour's tree is in place before the NEW pane reports its start.
        await vi.waitFor(() => expect(recordedSandboxTreeFlavour(lab.sessionId, lab.dataDir), second.logs())
          .toBe(to === 'off' ? null : to), { timeout: 60_000 });
        await vi.waitFor(() => expect(lab.panePid(), second.logs()).not.toBe(oldPane), { timeout: 60_000 });
        await vi.waitFor(() => expect(lab.starts().length, second.logs()).toBe(1), { timeout: 60_000 });
        expect(lab.hostProcessAlive(oldPane)).toBe(false);
        if (merged) expect(mountsAtOrUnder(merged), second.logs()).toEqual([]);
        if (to === 'off') {
          expect(lab.starts()[0]!.relay).toBeNull();
          expect(existsSync(lab.sessionRoot)).toBe(false);
        } else {
          expect(lab.starts()[0]!.relay).toBe(lab.outbox);
          expect(recordedSandboxTreeFlavour(lab.sessionId, lab.dataDir)).toBe(to);
          await vi.waitFor(() => expect(existsSync(lab.capabilityLeaf), second.logs()).toBe(true), { timeout: 20_000 });
          await expectPaneRelayServed(lab, second.logs);
        }

        await lab.stop(second.worker, 'close');
        await vi.waitFor(() => expect(existsSync(lab.sessionRoot), second.logs()).toBe(false), { timeout: 20_000 });
        expect(mountsAtOrUnder(dirname(lab.dataDir))).toEqual([]);
      } finally {
        await lab.dispose();
      }
    }, 240_000);
  }
});

// A persistent pane from a generation without the configured strict
// environment policy is killed and cold-spawned (strict never reuses an
// unstamped generation). The kill takes the private server's last session, so
// its post-kill probe can meet that server mid-exit ('unknown' once, or twice
// in a row): that transient must not refuse the start.
describe('persistent pane retired for a changed environment policy', () => {
  it.skipIf(!realTmux).each([
    { variant: '', exitingProbes: [] as number[] },
    { variant: ' (post-kill probe 1 meets the exiting tmux server)', exitingProbes: [1] },
    { variant: ' (post-kill probes 1 & 2 meet the exiting tmux server)', exitingProbes: [1, 2] },
  ])('tmux, strict policy over an unstamped generation$variant: kills the old pane and cold-spawns', async ({ exitingProbes }) => {
    const lab = createLab({ flavour: 'off', backend: 'tmux' });
    try {
      const first = lab.start('boot-1');
      await vi.waitFor(() => expect(lab.starts().length, first.logs()).toBe(1), { timeout: 60_000 });
      const oldPane = lab.panePid();
      await lab.stop(first.worker, 'SIGTERM');
      expect(lab.paneAlive()).toBe(true);

      lab.exitingServerOnPostKillProbes(exitingProbes);
      const second = lab.start('boot-2', { envPolicy: { mode: 'strict' } });
      await vi.waitFor(() => expect(second.logs()).toContain('environment policy — killing + cold-spawning'), { timeout: 60_000 });
      await vi.waitFor(() => expect(lab.starts().length, `${second.logs()}\n${second.errors().join('\n')}`).toBe(2), { timeout: 60_000 });
      expect(second.errors()).toEqual([]);
      expect(lab.exitingServerProbesFired(), second.logs()).toBe(exitingProbes.length);
      expect(lab.hostProcessAlive(oldPane)).toBe(false);
      expect(lab.panePid()).not.toBe(oldPane);
    } finally {
      await lab.dispose();
    }
  }, 120_000);
});
