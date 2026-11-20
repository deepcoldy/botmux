import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prepareDirectSandbox, probeHostCredentialIsolationMechanism } from '../src/adapters/backend/sandbox.js';
import { buildFsPolicy } from '../src/adapters/cli/fs-policy.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';
import { tsEvalArgs } from './helpers/ts-runner.js';

const repoRoot = realpathSync(resolve('.'));
const builtCli = join(repoRoot, 'dist', 'cli.js');
const runtimeBin = realpathSync(process.execPath);
const bwrapUsable = probeHostCredentialIsolationMechanism().mechanism === 'bwrap';

function configFixture(initial: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-owner-notice-cli-')));
  const home = join(root, 'home');
  const botmuxHome = join(home, '.botmux');
  const configFile = join(botmuxHome, 'config.json');
  mkdirSync(botmuxHome, { recursive: true });
  const before = JSON.stringify({ groupOwnerNotice: initial });
  writeFileSync(configFile, before);
  return { root, home, botmuxHome, configFile, before };
}

function runHostCli(home: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(runtimeBin, [builtCli, 'create-group', 'owner-notice', ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...extraEnv },
    encoding: 'utf8', timeout: 20_000,
  });
}

function expectRefusal(result: ReturnType<typeof runHostCli>) {
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('宿主终端');
  expect(result.stderr).toContain('Dashboard');
}

describe.skipIf(!existsSync(builtCli))('create-group owner-notice host/sandbox signal', () => {
  it('keeps the host CLI functional', () => {
    const f = configFixture(true);
    try {
      const off = runHostCli(f.home, ['off']);
      expect(off.status, off.stderr).toBe(0);
      expect(JSON.parse(readFileSync(f.configFile, 'utf8'))).toEqual({ groupOwnerNotice: false });
      const status = runHostCli(f.home, ['status']);
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain('off');
      const on = runHostCli(f.home, ['on']);
      expect(on.status, on.stderr).toBe(0);
      expect(JSON.parse(readFileSync(f.configFile, 'utf8'))).toEqual({});
    } finally {
      rmSandboxScratch(f.root);
    }
  });

  it.each([
    { label: 'status', args: ['status'], initial: false },
    { label: 'on', args: ['on'], initial: false },
    { label: 'off', args: ['off'], initial: true },
  ] as const)('rejects $label through the BOTMUX_SEND_RELAY sandbox signal without changing the host', ({ args, initial }) => {
    const f = configFixture(initial);
    try {
      const result = runHostCli(f.home, args, { BOTMUX_SEND_RELAY: join(f.root, 'outbox') });
      expectRefusal(result);
      expect(readFileSync(f.configFile, 'utf8')).toBe(f.before);
    } finally {
      rmSandboxScratch(f.root);
    }
  });
});

describe.skipIf(!existsSync(builtCli) || !bwrapUsable)('create-group owner-notice in a production-shaped bwrap', () => {
  it.each([
    { label: 'default status', args: [], initial: false },
    { label: 'status', args: ['status'], initial: false },
    { label: 'on', args: ['on'], initial: false },
    { label: 'off with seccomp marker but no relay', args: ['off'], initial: true, markerOnly: true },
  ] as const)('rejects $label without a fake success or a host write', ({ args, initial, ...options }) => {
    const f = configFixture(initial);
    const dataDir = join(f.botmuxHome, 'data');
    const project = join(f.root, 'project');
    const botHome = join(f.botmuxHome, 'bots', 'cli_test');
    const sessionId = 'owner-notice';
    const outbox = join(dataDir, 'sandboxes', sessionId, 'outbox');
    // This read-only mount leaves the same writable, unbound ~/.botmux parent
    // that previously accepted a tmpfs-only "successful" config write.
    mkdirSync(join(f.botmuxHome, 'bin'), { recursive: true });
    for (const path of [project, botHome, outbox]) mkdirSync(path, { recursive: true });
    const policy = buildFsPolicy({
      platform: 'linux', homeDir: f.home, botmuxHome: f.botmuxHome,
      defaultBotmuxHome: f.botmuxHome, sessionDataDir: dataDir,
      workingDir: project, currentAppId: 'cli_test', sessionId,
      botHome, redirectedCliData: true,
      execPaths: [dirname(runtimeBin)],
      readonlyRoots: [realpathSync(resolve('node_modules'))],
      botmuxInstallRoot: repoRoot, outbox, larkTransportEnabled: true,
      loadedBotsConfigPath: join(f.botmuxHome, 'bots.json'), net: false,
    });
    policy.rules = policy.rules.filter(rule => rule.access === 'deny' || existsSync(rule.path));
    let sandbox: ReturnType<typeof prepareDirectSandbox> = null;
    const cliArgs = [builtCli, 'create-group', 'owner-notice', ...args];
    // In the marker-only case, clear relay BEFORE dist/cli.js evaluates its
    // guard. The bwrap seccomp marker survives, so a relay-only guard regresses.
    const bootstrapArgv = [runtimeBin, ...cliArgs];
    const bootstrap = 'delete process.env.BOTMUX_SEND_RELAY;'
      + `process.argv = ${JSON.stringify(bootstrapArgv)};`
      + `await import(${JSON.stringify(pathToFileURL(builtCli).href)});`;
    try {
      sandbox = prepareDirectSandbox({
        sessionId, dataDir, policy, chdir: project, home: f.home,
        cliBin: runtimeBin,
        cliArgs: options.markerOnly ? tsEvalArgs(bootstrap).args : cliArgs,
        effectivePath: process.env.PATH,
      });
      expect(sandbox).not.toBeNull();
      const result = spawnSync(sandbox!.bin, sandbox!.args, {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.home, ...sandbox!.env },
        encoding: 'utf8', timeout: 20_000,
      });
      expectRefusal(result);
      expect(readFileSync(f.configFile, 'utf8')).toBe(f.before);
    } finally {
      sandbox?.cleanup();
      rmSandboxScratch(f.root);
    }
  });
});
