/**
 * Real macOS Seatbelt coverage for the daemon-relayed feedback send lease.
 * The profile is compiled from the production FsPolicy, so the sandbox really
 * denies both setuid `ps` and the feedback maintenance/lease files. Only the
 * daemon outside that profile can register the sender's exact process identity.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFsPolicy, compileToSeatbelt } from '../src/adapters/cli/fs-policy.js';
import { setIpcAuthSecret, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import { config } from '../src/config.js';
import { beginFeedbackMaintenance, inspectFeedbackMaintenance } from '../src/services/feedback-maintenance.js';
import { inspectSendRecovery } from '../src/services/feedback-recovery.js';
import { readDurableProcessIdentity } from '../src/utils/process-identity.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const seatbelt = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const d = seatbelt ? describe : describe.skip;
const sessionId = 'sess-seatbelt-lease';
const turnId = 'turn-seatbelt-lease';
const capability = 'ab12cd34'.repeat(8);
const repo = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const helper = fileURLToPath(new URL('./helpers/feedback-send-lease-relay-child.ts', import.meta.url));

let child: ChildProcess | undefined;
let handle: IpcServerHandle | undefined;
let root: string | undefined;
let previousDataDir: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  child = undefined;
  if (handle) await handle.close();
  handle = undefined;
  setIpcAuthSecret(null);
  if (previousDataDir !== undefined) config.session.dataDir = previousDataDir;
  previousDataDir = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.restoreAllMocks();
});

function leaseFiles(dataDir: string): string[] {
  const directory = join(dataDir, 'feedback-send-leases');
  return existsSync(directory) ? readdirSync(directory) : [];
}

d('feedback send lease under the compiled Seatbelt policy', () => {
  it('registers the exact sender identity through the external daemon and releases it', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'feedback-seatbelt-relay-')));
    const dataDir = join(root, 'botmux-home', 'data');
    const workingDir = join(root, 'project');
    const scratch = join(workingDir, 'tmp');
    const botHome = join(root, 'botmux-home', 'bots', 'cli_e2e');
    for (const directory of [dataDir, scratch, botHome]) mkdirSync(directory, { recursive: true });

    previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === sessionId ? {
      session: { sessionId, status: 'active', chatId: 'oc_seatbelt', rootMessageId: 'om_root' },
      worker: { killed: false, connected: true, send: vi.fn() },
      larkAppId: 'cli_e2e',
      chatId: 'oc_seatbelt',
      managedTurnOrigin: { capability, turnId, dispatchAttempt: 1 },
    } as never : undefined);
    setIpcAuthSecret('feedback-seatbelt-relay-secret');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });

    const policy = buildFsPolicy({
      platform: 'darwin',
      homeDir: root,
      botmuxHome: dirname(dataDir),
      sessionDataDir: dataDir,
      workingDir,
      currentAppId: 'cli_e2e',
      sessionId,
      botHome,
      redirectedCliData: true,
      execPaths: [dirname(realpathSync(process.execPath))],
      botmuxInstallRoot: repo,
      // Worktrees may symlink node_modules outside the checkout; Seatbelt
      // evaluates the resolved target when the TS loader imports dependencies.
      readonlyRoots: [realpathSync(join(repo, 'node_modules'))],
      net: true,
      writeRegexes: [],
    });
    policy.rules = policy.rules.filter(rule => rule.access === 'deny' || existsSync(rule.path));
    const profile = join(workingDir, 'feedback-lease.sb');
    writeFileSync(profile, compileToSeatbelt(policy));

    const { command, prefixArgs } = tsRunnerPrefix();
    child = spawn('/usr/bin/sandbox-exec', [
      '-f', profile, realpathSync(command), ...prefixArgs, helper,
      dataDir, String(handle.port), sessionId, capability, turnId,
    ], {
      cwd: repo,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, TMPDIR: scratch, SESSION_DATA_DIR: dataDir },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const ready = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(([code]) => { throw new Error(`sandboxed sender exited ${code}: ${stderr}`); }),
    ]);
    expect(ready[0]).toEqual({ ready: true });

    const [name] = leaseFiles(dataDir);
    expect(name).toBeDefined();
    const lease = JSON.parse(readFileSync(join(dataDir, 'feedback-send-leases', name!), 'utf8'));
    const exactIdentity = readDurableProcessIdentity(child.pid!);
    expect(exactIdentity).toBeDefined();
    expect(lease).toEqual({
      processId: child.pid, processStartId: exactIdentity, sessionId, releaseTokenHash: expect.any(String),
    });
    expect(lease.releaseToken).toBeUndefined();
    expect(inspectSendRecovery(dataDir)).toEqual([
      expect.objectContaining({ id: name, processId: child.pid, live: true }),
    ]);

    await beginFeedbackMaintenance(dataDir, 'seatbelt-relay');
    expect((await inspectFeedbackMaintenance(dataDir, 'seatbelt-relay')).blockers)
      .toContain(`send_in_progress:${child.pid}`);

    const exited = once(child, 'exit');
    child.send!('release');
    const [code] = await exited;
    expect(code, stderr).toBe(0);
    expect(leaseFiles(dataDir)).toEqual([]);
  }, 30_000);
});
