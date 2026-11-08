/**
 * Real worker lifecycle for a Linux credential-only pane on a persistent tmux
 * backend: the relay outbox must survive a daemon-restart-style worker exit
 * (SIGTERM → shutdownWorkerForParentExit), be re-served by the successor
 * worker WITHOUT killing the live CLI, and only be removed by a real close.
 * The same restart must also hand the executing turn on to the successor, for
 * an ordinary pane, a credential-only pane and a full (oncall) file sandbox.
 *
 * Fully hermetic: HOME, SESSION_DATA_DIR and bots.json live in a temp dir (the
 * worker resolves the enrollment marker from `homedir()`), and `tmux` on PATH
 * is a shim pinned to a private socket.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { probeHostCredentialIsolationMechanism } from '../src/adapters/backend/sandbox.js';
import {
  DEVICE_CREDENTIAL_ISOLATION_MARKER_BASENAME,
  isolationPaneMarkerPath,
} from '../src/adapters/cli/read-isolation.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';
import { readJsonLines } from './helpers/read-json-lines.js';

let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }
/** user + mount + PID namespaces under bwrap: what both sandboxed flavours need. */
const bwrapRuntime = process.platform === 'linux'
  && (() => {
    const probe = probeHostCredentialIsolationMechanism();
    return probe.supported && probe.mechanism === 'bwrap';
  })();

/** off = ordinary pane; credential-only = device enrolled, bot sandbox off;
 *  oncall = the full fs-policy file sandbox. */
type Flavour = 'off' | 'credential-only' | 'oncall';

interface LabOptions {
  flavour: Flavour;
  cliId: string;
  version: string;
  existingAppServer?: boolean;
  /** Chat-scope session (rootMessageId === chatId): replies follow the turn. */
  chatScope?: boolean;
}

/** One hermetic session on a private tmux server, driven by real workers. */
function createLab(opts: LabOptions) {
  const sessionId = randomUUID();
  // Short path: tmux socket paths are length-limited.
  const dir = mkdtempSync('/tmp/credonly-life-');
  const socket = join(dir, 'socket');
  const dataDir = join(dir, '.botmux', 'data');
  // The CLI's own files live in the working dir: the one place every flavour
  // (including the oncall allow-list) lets it read and write.
  const workDir = join(dir, 'work');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const sandboxed = opts.flavour !== 'off';
  if (opts.flavour === 'credential-only') {
    // Device enrolled: mandatory credential isolation; bot sandbox stays OFF.
    writeFileSync(join(dir, '.botmux', DEVICE_CREDENTIAL_ISOLATION_MARKER_BASENAME), '{}', { mode: 0o600 });
  }
  // Under ~/.botmux: a no-transport (apiOnly) oncall policy refuses a bots
  // config outside every botmux authority root.
  const bots = join(dir, '.botmux', 'bots.json');
  writeFileSync(bots, JSON.stringify([{ larkAppId: 'app_probe', larkAppSecret: '', apiOnly: true, cliId: opts.cliId }]));
  const report = join(workDir, 'report.jsonl');
  // Every byte the worker types into the CLI, i.e. proof a turn reached it.
  const typed = join(workDir, 'typed.log');
  const script = join(workDir, 'fake-cli');
  // Pin the extensionless script to CommonJS: a stray ancestor package.json
  // with "type": "module" (e.g. another process's file in /tmp) would
  // otherwise flip it to ESM and the CLI would die on `require`.
  writeFileSync(join(workDir, 'package.json'), '{"type":"commonjs"}\n');
  // `❯` is the Claude Code input box the worker waits for before its first
  // write. Once typed into, the CLI shows Claude's working footer for good: the
  // turn stays in flight, so no idle edge ends it during the test.
  writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(opts.version)}); process.exit(); }
fs.appendFileSync(${JSON.stringify(report)}, JSON.stringify({ relay: process.env.BOTMUX_SEND_RELAY || null }) + '\\n');
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(${JSON.stringify(typed)}, chunk);
  process.stdout.write('\\n⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt\\n');
});
console.log('Ready >'); process.stdout.write('❯ '); setInterval(() => {}, 1 << 30);
`, { mode: 0o700 });
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -S '${socket}' "$@"\n`, { mode: 0o700 });
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
  const sessionRoot = join(dataDir, 'sandboxes', sessionId);
  const outbox = join(sessionRoot, 'outbox');
  const capabilityLeaf = join(outbox, RELAY_ORIGIN_CAPABILITY_BASENAME);
  const paneTarget = `bmx-${sessionId.slice(0, 8)}`;
  const chatId = 'oc_probechat';
  const markersDir = join(dataDir, '.botmux-cli-pids');
  // Only pid-named entries are markers (production looks them up by pid). A
  // rewrite's `<pid>.lock` / atomic-write tmp siblings would otherwise make the
  // count 2, and before the first marker lands the lock alone would read as a
  // turnless marker.
  const markerNames = (): string[] => existsSync(markersDir)
    ? readdirSync(markersDir).filter(name => /^\d+$/.test(name))
    : [];
  const init = (bootId: string, turn?: string) => ({
    type: 'init', sessionId, chatId, rootMessageId: opts.chatScope ? chatId : 'om_probe', workingDir: workDir,
    cliId: opts.cliId, cliPathOverride: script, backendType: 'tmux',
    // A daemon restore (forkWorker(ds, '', true)) carries no prompt and no turn.
    prompt: turn ? 'hello' : '', ...(turn ? { turnId: turn } : {}),
    apiOnly: true, larkAppId: 'app_probe', larkAppSecret: '', ownerOpenId: 'ou_owner', daemonBootId: bootId,
    loadedBotsConfigPath: bots, loadedBotsConfigProvenance: 'loaded', promptInjection: 'none',
    ...(opts.flavour === 'oncall' ? { sandbox: 'oncall' } : {}),
    ...(opts.existingAppServer ? {
      existingAppServerEndpoint: 'ws://127.0.0.1:9',
      cliSessionId: '019a0000-0000-7000-8000-000000000001',
    } : {}),
  });
  const workers = new Set<ChildProcess>();
  const lab = {
    sessionId, dataDir, sessionRoot, outbox, capabilityLeaf,
    reports: (): Array<{ relay: string | null }> => readJsonLines(report),
    typed: (): string => { try { return readFileSync(typed, 'utf8'); } catch { return ''; } },
    paneAlive: (): boolean => spawnSync(realTmux!, ['-S', socket, 'has-session', '-t', paneTarget]).status === 0,
    // HOST pid of the pane's process. (The fake CLI's own process.pid is
    // namespace-local under bwrap --unshare-pid and means nothing out here.)
    panePid: (): number => Number(spawnSync(realTmux!, [
      '-S', socket, 'display-message', '-p', '-t', paneTarget, '#{pane_pid}',
    ], { encoding: 'utf8' }).stdout.trim()),
    hostProcessAlive: (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    },
    /** The executing-turn identity a `botmux send` in this pane resolves:
     *  ordinary panes read the live CLI PID marker (process-tree walk); a
     *  sandboxed pane's send is authorized from the relay capability.
     *  `absent` = no such file at all. */
    sendTurnIdentity: (): string | null | 'absent' => {
      const read = (path: string): string | null | 'absent' => {
        try { return (JSON.parse(readFileSync(path, 'utf8')) as { turnId?: string }).turnId ?? null; }
        catch { return 'absent'; }
      };
      if (sandboxed) return read(capabilityLeaf);
      const names = markerNames();
      return names.length === 1 ? read(join(markersDir, names[0]!)) : 'absent';
    },
    /** Path of the one CLI PID marker, if exactly one exists. */
    markerPath: (): string | undefined => {
      const names = markerNames();
      return names.length === 1 ? join(markersDir, names[0]!) : undefined;
    },
    markerCount: (): number => markerNames().length,
    start(bootId: string, turn?: string): { worker: ChildProcess; logs: () => string; origins: () => Array<string | null> } {
      const worker = spawnNodeTsScript('src/worker.ts', [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      workers.add(worker);
      let logs = '';
      // The turn of every managed-send origin this worker announced to its daemon.
      const origins: Array<string | null> = [];
      worker.stdout?.on('data', data => { logs += String(data); });
      worker.stderr?.on('data', data => { logs += String(data); });
      worker.on('message', (message: { type?: string; turnId?: string }) => {
        if (message?.type === 'managed_turn_origin') origins.push(message.turnId ?? null);
      });
      worker.send(init(bootId, turn));
      return { worker, logs: () => logs, origins: () => origins };
    },
    async stop(worker: ChildProcess, how: 'SIGTERM' | 'close'): Promise<void> {
      // A worker that already exited (e.g. a failed launch) has no IPC channel.
      if (worker.exitCode !== null || worker.signalCode !== null) { workers.delete(worker); return; }
      const exited = once(worker, 'exit');
      if (how === 'close') worker.send({ type: 'close' });
      else worker.kill('SIGTERM');
      const timer = setTimeout(() => worker.kill('SIGKILL'), 15_000);
      try { if (worker.exitCode === null && worker.signalCode === null) await exited; }
      finally { clearTimeout(timer); workers.delete(worker); }
    },
    async dispose(): Promise<void> {
      for (const worker of [...workers]) await lab.stop(worker, 'close').catch(() => undefined);
      try { execFileSync(realTmux!, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return lab;
}

const cases = [
  { label: 'managed Claude Code pane', cliId: 'claude-code', version: '2.1.0 (Claude Code)', existingAppServer: false },
  // The external-App-Server remote TUI takes an EARLIER shutdown branch (it
  // never runs killCli); the relay outbox must survive that branch too.
  { label: 'Codex remote TUI on an existing App Server', cliId: 'codex', version: 'codex-cli 0.136.0', existingAppServer: true },
];

describe('credential-only relay across a real worker lifecycle (tmux)', () => {
  it.skipIf(!realTmux || !bwrapRuntime).each(cases)(
    '$label: keeps the outbox through SIGTERM, re-serves it on reattach, removes it on close',
    async ({ cliId, version, existingAppServer }) => {
      const lab = createLab({ flavour: 'credential-only', cliId, version, existingAppServer });
      try {
        // 1. Fresh credential-only spawn: the CLI sees the relay, the host has it.
        const first = lab.start('boot-1');
        await vi.waitFor(() => expect(lab.reports().length, first.logs()).toBe(1), { timeout: 30_000 });
        expect(lab.reports()[0]!.relay).toBe(lab.outbox);
        await vi.waitFor(() => expect(existsSync(lab.capabilityLeaf), first.logs()).toBe(true), { timeout: 10_000 });
        await vi.waitFor(() => expect(readFileSync(isolationPaneMarkerPath(lab.dataDir, lab.sessionId), 'utf8'), first.logs())
          .toContain('committed'), { timeout: 30_000 });
        const firstPanePid = lab.panePid();
        expect(firstPanePid).toBeGreaterThan(1);
        // Same user as this test, so a plain liveness probe is meaningful (no EPERM).
        expect(lab.hostProcessAlive(firstPanePid)).toBe(true);

        // 2. Daemon restart shape: SIGTERM. The pane survives; so must its outbox.
        await lab.stop(first.worker, 'SIGTERM');
        expect(lab.paneAlive()).toBe(true);
        expect(existsSync(lab.outbox), first.logs()).toBe(true);

        // 3. Successor worker reattaches the SAME live CLI and re-serves the relay.
        const second = lab.start('boot-2');
        await vi.waitFor(() => expect(second.logs()).toContain('REATTACH'), { timeout: 30_000 });
        await vi.waitFor(() => expect(existsSync(lab.capabilityLeaf), second.logs()).toBe(true), { timeout: 10_000 });
        expect(lab.reports(), second.logs()).toHaveLength(1); // no cold spawn
        // The very same pane process survived both workers.
        expect(lab.panePid()).toBe(firstPanePid);
        expect(lab.hostProcessAlive(firstPanePid)).toBe(true);

        // 4. A real close removes the pane and the relay tree.
        await lab.stop(second.worker, 'close');
        await vi.waitFor(() => expect(existsSync(lab.sessionRoot), second.logs()).toBe(false), { timeout: 10_000 });
        expect(lab.paneAlive()).toBe(false);
      } finally {
        await lab.dispose();
      }
    },
    120_000,
  );
});

const restartFlavours: Array<{ flavour: Flavour; label: string }> = [
  { flavour: 'off', label: 'ordinary pane' },
  { flavour: 'credential-only', label: 'credential-only pane' },
  { flavour: 'oncall', label: 'full file sandbox (oncall)' },
];

/**
 * An in-flight chat-scope turn interrupted by a daemon restart. A daemon
 * restore is deliberately unattributed (forkWorker(ds, '', true) carries no
 * turn) while the CLI keeps executing that turn in its pane, so the successor
 * worker has to take the turn back from what its predecessor left behind:
 * otherwise every later `botmux send` of the turn falls to the chat's top
 * level instead of the turn's topic.
 */
describe('in-flight chat-scope turn across a daemon restart (tmux)', () => {
  for (const { flavour, label } of restartFlavours) {
    it.skipIf(!realTmux || (flavour !== 'off' && !bwrapRuntime))(
      `${label}: the successor resolves the same turn; a real close drops it`,
      async () => {
        const lab = createLab({ flavour, cliId: 'claude-code', version: '2.1.0 (Claude Code)', chatScope: true });
        try {
          const first = lab.start('boot-1', 'om_turn_live');
          await vi.waitFor(() => expect(lab.reports().length, first.logs()).toBe(1), { timeout: 30_000 });
          // The turn is executing in the CLI, not still queued in the worker
          // (an unwritten input would reach the successor through the
          // unsent-input handoff instead).
          await vi.waitFor(() => expect(lab.typed(), first.logs()).toContain('hello'), { timeout: 45_000 });
          await vi.waitFor(() => expect(lab.sendTurnIdentity(), first.logs()).toBe('om_turn_live'), { timeout: 15_000 });

          await lab.stop(first.worker, 'SIGTERM');
          expect(lab.paneAlive()).toBe(true);
          // Between the two workers an ordinary pane's send still resolves the
          // turn; a sandboxed pane has no live authority at all (the exiting
          // worker revoked its capability).
          expect(lab.sendTurnIdentity(), first.logs()).toBe(flavour === 'off' ? 'om_turn_live' : 'absent');

          const second = lab.start('boot-2');
          await vi.waitFor(() => expect(second.logs()).toMatch(/Re-attaching to existing tmux session/), { timeout: 30_000 });
          // The successor took the turn back: it announces the turn's
          // managed-send origin to its daemon, and the pane's send resolves it.
          await vi.waitFor(() => expect(second.origins(), second.logs()).toContain('om_turn_live'), { timeout: 15_000 });
          await vi.waitFor(() => expect(lab.sendTurnIdentity(), second.logs()).toBe('om_turn_live'), { timeout: 15_000 });
          expect(lab.reports(), second.logs()).toHaveLength(1); // reattached, not cold-spawned

          await lab.stop(second.worker, 'close');
          expect(lab.paneAlive()).toBe(false);
          expect(lab.markerCount(), second.logs()).toBe(0);
        } finally {
          await lab.dispose();
        }
      },
      120_000,
    );
  }

  /**
   * The successor adopts only a marker this live CLI process got from this
   * session's worker. One stamped with another process's birth time (the
   * leftover of a since-exited process whose PID the kernel recycled onto the
   * pane) is discarded, never adopted.
   */
  it.skipIf(!realTmux)(
    'a marker at the pane pid stamped with another process birth time is discarded, not adopted',
    async () => {
      const lab = createLab({ flavour: 'off', cliId: 'claude-code', version: '2.1.0 (Claude Code)', chatScope: true });
      try {
        const first = lab.start('boot-1', 'om_turn_live');
        await vi.waitFor(() => expect(lab.reports().length, first.logs()).toBe(1), { timeout: 30_000 });
        await vi.waitFor(() => expect(lab.typed(), first.logs()).toContain('hello'), { timeout: 45_000 });
        await vi.waitFor(() => expect(lab.sendTurnIdentity(), first.logs()).toBe('om_turn_live'), { timeout: 15_000 });
        await lab.stop(first.worker, 'SIGTERM');
        const marker = lab.markerPath();
        expect(marker, first.logs()).toBeDefined();
        const record = JSON.parse(readFileSync(marker!, 'utf8')) as { procStart?: unknown };
        expect(typeof record.procStart).toBe('string');
        writeFileSync(marker!, JSON.stringify({ ...record, procStart: `${String(record.procStart)}0` }));

        const second = lab.start('boot-2');
        await vi.waitFor(() => expect(second.logs()).toMatch(/Re-attaching to existing tmux session/), { timeout: 30_000 });
        // Rewritten for the live process, without the planted turn.
        await vi.waitFor(() => expect(lab.sendTurnIdentity(), second.logs()).toBeNull(), { timeout: 15_000 });
        expect(lab.reports(), second.logs()).toHaveLength(1);
      } finally {
        await lab.dispose();
      }
    },
    120_000,
  );
});
