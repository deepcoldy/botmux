/**
 * F3 five-cell matrix: the identity storage model for the
 * (BOTMUX_SANDBOX env × frozen sandbox/network config) grid.
 *
 * Every cell asserts the whole chain at the level production runs it:
 *
 *  1. resolveLocalSandboxMode (env override + frozen config + remote bypass)
 *     → resolveSpawnNetworkShape → resolveIdentityStorageModel produce the
 *     expected model in the WORKER;
 *  2. the loopback fact is real at the kernel level: the production
 *     buildFsPolicy/compileToBwrap argv compiled with the cell's net flag
 *     either shares the host network namespace or carries --unshare-net, and
 *     a connector launched exactly like that can/cannot reach a live loopback
 *     listener — this is what makes the model decision a spawn fact, not a
 *     config guess;
 *  3. the wrapper rendered by prepareTriggerUserCliEnv for the cell's model
 *     matches (proven invokes cli-identity-runner; single reads the root
 *     snapshot), and the on-disk layout carries no token of the other model;
 *  4. the daemon-side accessor returns the SAME model when fed the cell's
 *     worker report — a frozen config that disagrees with the report never
 *     flips the daemon answer (the F3 split-brain).
 *
 * Cells (env × frozen):
 *   1 BOTMUX_SANDBOX=0 + sandbox:true / network:false → off   → proven
 *   2 BOTMUX_SANDBOX=1 + sandbox:off  / network:false → oncall/unshare → single
 *   3 BOTMUX_SANDBOX=1 + sandbox:off  / network:true  → oncall/share    → proven
 *   4 (no env)         + sandbox:true / network:false → oncall/unshare → single
 *   5 BOTMUX_SANDBOX=0 + sandbox:true / network:true  → off   → proven
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';
import { buildFsPolicy, compileToBwrap } from '../src/adapters/cli/fs-policy.js';
import { resolveLocalSandboxMode } from '../src/adapters/backend/sandbox.js';
import { resolveSpawnNetworkShape } from '../src/adapters/cli/sandbox-mode.js';
import { resolveIdentityStorageModel } from '../src/core/lark-tool-binding.js';
import {
  prepareTriggerUserCliEnv,
  sessionIdentityBinDir,
  sessionIdentityPath,
  sessionIdentityDataDir,
  ensureSessionIdentityStorage,
  writeSessionIdentity,
  recallProvenIdentityContent,
} from '../src/core/cli-identity.js';
import * as botRegistry from '../src/bot-registry.js';
import {
  identityStorageModelForDaemonSession,
  recordWorkerIdentityDecision,
} from '../src/core/worker-pool.js';

const USRMERGE = ['/bin', '/lib', '/lib64', '/sbin', '/lib32', '/libx32'];

function bwrapUsable(): boolean {
  if (process.platform !== 'linux') return false;
  const probe = spawnSync('bwrap', [
    '--unshare-user', '--die-with-parent',
    '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '/usr/bin/true',
  ], { timeout: 10_000 });
  return probe.status === 0;
}

const d = bwrapUsable() ? describe : describe.skip;

interface Cell {
  n: number;
  envValue: string | undefined;
  frozenSandbox: boolean;
  frozenNetwork: boolean;
  mode: 'off' | 'oncall';
  engaged: boolean;
  shared: boolean;
  model: 'single' | 'proven';
}

const CELLS: Cell[] = [
  { n: 1, envValue: '0', frozenSandbox: true, frozenNetwork: false, mode: 'off', engaged: false, shared: true, model: 'proven' },
  { n: 2, envValue: '1', frozenSandbox: false, frozenNetwork: false, mode: 'oncall', engaged: true, shared: false, model: 'single' },
  { n: 3, envValue: '1', frozenSandbox: false, frozenNetwork: true, mode: 'oncall', engaged: true, shared: true, model: 'proven' },
  { n: 4, envValue: undefined, frozenSandbox: true, frozenNetwork: false, mode: 'oncall', engaged: true, shared: false, model: 'single' },
  { n: 5, envValue: '0', frozenSandbox: true, frozenNetwork: true, mode: 'off', engaged: false, shared: true, model: 'proven' },
];

/** Compile production bwrap argv for one cell and return its raw argv (the
 *  same constructor the worker uses for oncall launches). */
function compileCellBwrap(root: string, netEnabled: boolean): string[] {
  const emptiesDir = join(root, 'sbx/empties');
  const emptyDir = join(root, 'sbx/empty');
  mkdirSync(emptiesDir, { recursive: true });
  mkdirSync(emptyDir, { recursive: true });
  const canonical = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const policy = buildFsPolicy({
    platform: 'linux', homeDir: canonical(homedir()),
    botmuxHome: join(root, 'botmux-home'), sessionDataDir: join(root, 'botmux-home/data'),
    sessionId: 'matrix-session',
    workingDir: join(root, 'proj'), currentAppId: 'cli_matrix',
    botHome: join(root, 'botmux-home/bots/cli_matrix'),
    redirectedCliData: true,
    execPaths: [dirname(canonical(process.execPath))],
    userPaths: { readOnly: [], readWrite: [join(root, 'proj')], deny: [] },
    net: netEnabled, writeRegexes: [],
  });
  policy.rules = policy.rules.filter(r => r.access === 'deny' || existsSync(r.path));
  const symlinks: { path: string; target: string }[] = [];
  for (const p of USRMERGE) {
    try { symlinks.push({ path: p, target: readlinkSync(p) }); } catch { /* */ }
  }
  const filePaths = new Set<string>();
  for (const r of policy.rules) {
    if (r.access !== 'deny') continue;
    try { if (statSync(r.path).isFile()) filePaths.add(r.path); } catch { /* */ }
  }
  const compiled = compileToBwrap(policy, {
    symlinks, emptyDir, emptiesDir, filePaths, chdir: join(root, 'proj'),
  });
  chmodSync(emptyDir, 0o000);
  for (const f of compiled.emptyFiles) writeFileSync(f.path, '', { mode: 0o000 });
  for (const m of compiled.maskMounts) {
    if (existsSync(m.path)) continue;
    if (m.kind === 'file') { mkdirSync(dirname(m.path), { recursive: true }); writeFileSync(m.path, ''); }
    else mkdirSync(m.path, { recursive: true });
  }
  return compiled.args;
}

function loopbackReachable(port: number, bwrapArgs: string[] | null): boolean {
  const script = `exec 3<>/dev/tcp/127.0.0.1/${port} && echo REACHED || echo REFUSED`;
  const r = bwrapArgs
    ? spawnSync('bwrap', [...bwrapArgs, '/bin/bash', '-c', script], { timeout: 10_000, encoding: 'utf8' })
    : spawnSync('/bin/bash', ['-c', script], { timeout: 10_000, encoding: 'utf8' });
  return (r.stdout ?? '').includes('REACHED');
}

d('F3 five-cell identity model matrix', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-identity-matrix-'));
    mkdirSync(join(root, 'proj'), { recursive: true });
    mkdirSync(join(root, 'fakebin'), { recursive: true });
    for (const name of ['bytedcli', 'codebase']) {
      writeFileSync(join(root, 'fakebin', name), '#!/bin/sh\necho real\n');
      chmodSync(join(root, 'fakebin', name), 0o755);
    }
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: { larkAppId: 'cli_matrix', apiOnly: false, backendType: 'pty' },
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // compileCellBwrap chmods deny-mask sources to 0o000; a plain recursive
    // rm fails EACCES for a non-root uid (the GitHub runner). Reopen then rm,
    // exactly as the other real-bwrap suites do.
    rmSandboxScratch(root);
  });

  it.each(CELLS)('cell $n: model=$model engaged=$engaged loopbackShared=$shared', (cell) => {
    // ── 1. worker decision chain, exactly as spawnCli composes it ──
    const mode = resolveLocalSandboxMode({
      backendType: 'pty',
      configSandbox: cell.frozenSandbox,
      envValue: cell.envValue,
    });
    expect(mode).toBe(cell.mode);
    const shape = resolveSpawnNetworkShape({
      mode,
      sandboxNetwork: cell.frozenNetwork,
      sandboxNetworkPolicy: undefined,
    });
    expect(shape).toEqual({
      sandboxEngaged: cell.engaged,
      netEnabled: cell.engaged ? cell.shared : false,
      loopbackShared: cell.shared,
    });
    const model = resolveIdentityStorageModel({
      platform: 'linux', binding: true,
      sandboxEngaged: shape.sandboxEngaged,
      loopbackShared: shape.loopbackShared,
    });
    expect(model).toBe(cell.model);

    // ── 2. kernel-level loopback fact under production bwrap argv ──
    const server = net.createServer(socket => socket.end());
    const port = new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    }));
    return port.then(async listenedPort => {
      try {
        const args = cell.engaged ? compileCellBwrap(root, shape.netEnabled) : null;
        if (args) {
          // The production argv carries --unshare-net EXACTLY when the cell's
          // spawn cut the loopback; never the reverse.
          expect(args.includes('--unshare-net')).toBe(!cell.shared);
        }
        // A no-sandbox cell runs the connector plainly.
        expect(loopbackReachable(listenedPort, args)).toBe(cell.shared);

        // ── 3. wrapper + on-disk layout for the cell's model ──
        const dataDir = join(root, `data-cell-${cell.n}`);
        mkdirSync(dataDir, { recursive: true });
        const env: NodeJS.ProcessEnv = { PATH: `${join(root, 'fakebin')}:/usr/bin:/bin` };
        prepareTriggerUserCliEnv(
          env, dataDir, 'matrix-session',
          { enabled: true, tools: ['bytedcli'], fallback: 'none' },
          () => {}, model,
          model === 'proven' ? { appId: 'cli_matrix', ipcPort: 1 } : undefined,
        );
        const binDir = sessionIdentityBinDir(dataDir, 'matrix-session');
        const wrapper = readFileSync(join(binDir, 'bytedcli'), 'utf8');
        if (model === 'proven') {
          expect(wrapper).toContain('cli-identity-runner');
          expect(wrapper).toContain('--ipc-port');
        } else {
          expect(wrapper).not.toContain('cli-identity-runner');
          expect(wrapper).toContain('bytedcli.env');
        }
        const layoutDir = sessionIdentityDataDir(dataDir, 'matrix-session');
        expect(readFileSync(join(layoutDir, 'identity-layout'), 'utf8').trim()).toBe(`${model}-v1`);
        const tree = readdirSync(layoutDir, { recursive: true }) as string[];
        // Proven never carries token files; a single cell has only placeholders.
        if (model === 'proven') {
          expect(tree.some(p => p.endsWith('.env'))).toBe(false);
        }

        // ── 4. daemon consumes the worker report as the single source ──
        const ds: any = {
          session: { sessionId: 'matrix-session', status: 'active', backendType: 'pty' },
          larkAppId: 'cli_matrix', chatId: 'oc_matrix',
          worker: { killed: false }, workerGeneration: cell.n,
        };
        recordWorkerIdentityDecision(ds, { pid: 7000 + cell.n } as any, cell.n, {
          model, sandboxEngaged: shape.sandboxEngaged, loopbackShared: shape.loopbackShared,
        });
        expect(identityStorageModelForDaemonSession(ds)).toBe(cell.model);

        server.close();
      } finally {
        server.close();
      }
    });
  });

  it('repaired split cells leave no artifact of the other model (no sticky layout)', () => {
    const dataDir = join(root, 'data-repair');
    mkdirSync(dataDir, { recursive: true });
    const sessionId = 'matrix-session';
    const TOKEN = 'JWT-REPAIR-MATRIX';
    const tools = ['bytedcli', 'codebase'] as const;

    // Stale single layout first (cell-2 daemon side before the fix): live token
    // in the root snapshot.
    ensureSessionIdentityStorage(dataDir, sessionId, tools, 'single');
    writeSessionIdentity(dataDir, sessionId, { tool: 'bytedcli', cloudJwt: TOKEN, turnId: 'turn-old', openId: 'ou-a' }, 'single');
    expect(readFileSync(sessionIdentityPath(dataDir, sessionId, 'bytedcli'), 'utf8')).toContain(TOKEN);

    // Cell 1/5 repaired: worker now renders proven (env forced the sandbox off).
    // Re-init must wipe the plaintext token and the marker must move.
    ensureSessionIdentityStorage(dataDir, sessionId, tools, 'proven');
    const layoutDir = sessionIdentityDataDir(dataDir, sessionId);
    const treeAfterProven = readdirSync(layoutDir, { recursive: true }) as string[];
    expect(readFileSync(join(layoutDir, 'identity-layout'), 'utf8').trim()).toBe('proven-v1');
    for (const rel of treeAfterProven) {
      const p = join(layoutDir, rel);
      if (rel.endsWith('.env')) {
        expect(readFileSync(p, 'utf8')).toBe('');
      }
    }
    // A proven publication stays in memory only and is recallable there.
    writeSessionIdentity(dataDir, sessionId, { tool: 'bytedcli', cloudJwt: TOKEN, turnId: 'turn-new', openId: 'ou-a' }, 'proven');
    expect(recallProvenIdentityContent(dataDir, sessionId, 'turn-new', 'bytedcli')).toContain(TOKEN);
    for (const rel of readdirSync(layoutDir, { recursive: true }) as string[]) {
      if (rel.endsWith('.env')) expect(readFileSync(join(layoutDir, rel), 'utf8')).toBe('');
    }

    // And the reverse flip (cell 3→2: operator forced an isolated sandbox):
    // proven memory is forgotten and single placeholders are empty.
    ensureSessionIdentityStorage(dataDir, sessionId, tools, 'single');
    expect(recallProvenIdentityContent(dataDir, sessionId, 'turn-new', 'bytedcli')).toBeUndefined();
    expect(readFileSync(join(layoutDir, 'identity-layout'), 'utf8').trim()).toBe('single-v1');
    expect(readFileSync(sessionIdentityPath(dataDir, sessionId, 'bytedcli'), 'utf8')).toBe('');
  });
});
