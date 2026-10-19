/**
 * Real worker lifecycle for a Linux credential-only pane on a persistent tmux
 * backend: the relay outbox must survive a daemon-restart-style worker exit
 * (SIGTERM → shutdownWorkerForParentExit), be re-served by the successor
 * worker WITHOUT killing the live CLI, and only be removed by a real close.
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

let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }
const credentialOnlyRuntime = process.platform === 'linux'
  && (() => {
    const probe = probeHostCredentialIsolationMechanism();
    return probe.supported && probe.mechanism === 'bwrap';
  })();

interface LabOptions {
  credentialOnly: boolean;
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
  mkdirSync(dataDir, { recursive: true });
  if (opts.credentialOnly) {
    // Device enrolled: mandatory credential isolation; bot sandbox stays OFF.
    writeFileSync(join(dir, '.botmux', DEVICE_CREDENTIAL_ISOLATION_MARKER_BASENAME), '{}', { mode: 0o600 });
  }
  const bots = join(dir, 'bots.json');
  writeFileSync(bots, JSON.stringify([{ larkAppId: 'app_probe', larkAppSecret: '', apiOnly: true, cliId: opts.cliId }]));
  const report = join(dir, 'report.jsonl');
  const script = join(dir, 'fake-cli');
  writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(opts.version)}); process.exit(); }
fs.appendFileSync(${JSON.stringify(report)}, JSON.stringify({ relay: process.env.BOTMUX_SEND_RELAY || null }) + '\\n');
console.log('Ready >'); setInterval(() => {}, 1 << 30);
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
  const init = (bootId: string, turn?: string) => ({
    type: 'init', sessionId, chatId, rootMessageId: opts.chatScope ? chatId : 'om_probe', workingDir: dir,
    cliId: opts.cliId, cliPathOverride: script, backendType: 'tmux',
    // A daemon restore (forkWorker(ds, '', true)) carries no prompt and no turn.
    prompt: turn ? 'hello' : '', ...(turn ? { turnId: turn } : {}),
    apiOnly: true, larkAppId: 'app_probe', larkAppSecret: '', ownerOpenId: 'ou_owner', daemonBootId: bootId,
    loadedBotsConfigPath: bots, loadedBotsConfigProvenance: 'loaded', promptInjection: 'none',
    ...(opts.existingAppServer ? {
      existingAppServerEndpoint: 'ws://127.0.0.1:9',
      cliSessionId: '019a0000-0000-7000-8000-000000000001',
    } : {}),
  });
  const workers = new Set<ChildProcess>();
  const lab = {
    sessionId, dataDir, sessionRoot, outbox, capabilityLeaf,
    reports: (): Array<{ relay: string | null }> => existsSync(report)
      ? readFileSync(report, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : [],
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
     *  credential-only pane's send is authorized from the relay capability.
     *  `absent` = no such file at all. */
    sendTurnIdentity: (): string | null | 'absent' => {
      const read = (path: string): string | null | 'absent' => {
        try { return (JSON.parse(readFileSync(path, 'utf8')) as { turnId?: string }).turnId ?? null; }
        catch { return 'absent'; }
      };
      if (opts.credentialOnly) return read(capabilityLeaf);
      const markers = join(dataDir, '.botmux-cli-pids');
      const names = existsSync(markers) ? readdirSync(markers) : [];
      return names.length === 1 ? read(join(markers, names[0]!)) : 'absent';
    },
    start(bootId: string, turn?: string): { worker: ChildProcess; logs: () => string } {
      const worker = spawnNodeTsScript('src/worker.ts', [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      workers.add(worker);
      let logs = '';
      worker.stdout?.on('data', data => { logs += String(data); });
      worker.stderr?.on('data', data => { logs += String(data); });
      worker.send(init(bootId, turn));
      return { worker, logs: () => logs };
    },
    async stop(worker: ChildProcess, how: 'SIGTERM' | 'close'): Promise<void> {
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
  it.skipIf(!realTmux || !credentialOnlyRuntime).each(cases)(
    '$label: keeps the outbox through SIGTERM, re-serves it on reattach, removes it on close',
    async ({ cliId, version, existingAppServer }) => {
      const lab = createLab({ credentialOnly: true, cliId, version, existingAppServer });
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

  /**
   * An in-flight chat-scope turn interrupted by a daemon restart. A daemon
   * restore is deliberately unattributed (forkWorker(ds, '', true) carries no
   * turn), and killCli() drops the CLI PID marker for EVERY session, so an
   * ordinary tmux pane also loses the executing-turn identity its later
   * `botmux send` needs (it then falls back to the chat's top level). That is
   * a pre-existing, cross-backend gap tracked separately; this test pins the
   * guarantee of this change: a credential-only pane is never worse off than
   * an ordinary one — identical identity before AND after the restart.
   */
  it.skipIf(!realTmux || !credentialOnlyRuntime)(
    'in-flight chat-scope turn across a daemon restart: credential-only send identity matches an ordinary pane',
    async () => {
      const observe = async (credentialOnly: boolean) => {
        const lab = createLab({ credentialOnly, cliId: 'claude-code', version: '2.1.0 (Claude Code)', chatScope: true });
        try {
          const first = lab.start('boot-1', 'om_turn_live');
          await vi.waitFor(() => expect(lab.reports().length, first.logs()).toBe(1), { timeout: 30_000 });
          await vi.waitFor(() => expect(lab.sendTurnIdentity(), first.logs()).toBe('om_turn_live'), { timeout: 15_000 });
          const during = lab.sendTurnIdentity();
          await lab.stop(first.worker, 'SIGTERM');
          expect(lab.paneAlive()).toBe(true);
          const second = lab.start('boot-2');
          await vi.waitFor(() => expect(second.logs()).toMatch(/Re-attaching to existing tmux session/), { timeout: 30_000 });
          await vi.waitFor(() => expect(lab.sendTurnIdentity(), second.logs()).not.toBe('absent'), { timeout: 15_000 });
          expect(lab.reports(), second.logs()).toHaveLength(1); // reattached, not cold-spawned
          return { during, afterRestore: lab.sendTurnIdentity() };
        } finally {
          await lab.dispose();
        }
      };
      const ordinary = await observe(false);
      const credentialOnly = await observe(true);
      // While the turn runs, both panes' sends resolve the live turn.
      expect(ordinary.during).toBe('om_turn_live');
      expect(credentialOnly.during).toBe('om_turn_live');
      // After the restore reattach the credential-only pane resolves exactly
      // what an ordinary pane does (and still has a serviceable relay).
      expect(credentialOnly.afterRestore).toBe(ordinary.afterRestore);
    },
    240_000,
  );
});
