/**
 * `botmux wecom logs` through the real CLI entry, in a throwaway HOME holding a
 * registered connection and log files where the fleet writes them: the
 * gateway's under the log base name the supervisor's member spec carries, the
 * core's under the name the gateway uses for its core.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWecomFleetMembers } from '../src/core/fleet-wecom-members.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { setWecomFleetDesiredState } from '../src/im/wecom/config/fleet-desired-state.js';
import { wecomCoreLogBaseName, wecomFleetMemberName } from '../src/im/wecom/contract/fleet-member.js';
import { runWecomLogsCommand, type WecomLogsDeps } from '../src/cli/wecom/logs.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const repoRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const cliEntry = join(repoRoot, 'src', 'cli.ts');

const homes: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];
/** The CLI child leads its own process group, so its `tail` goes with it. */
function killGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try { process.kill(-child.pid!, signal); } catch { /* already gone */ }
}
afterEach(() => {
  for (const child of children.splice(0)) killGroup(child, 'SIGKILL');
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A HOME with one registered connection; `logs` writes its fixture log files. */
function fixture(logs: { gateway?: boolean; core?: boolean } = { gateway: true, core: true }) {
  const home = mkdtempSync(join(tmpdir(), 'wecom-logs-'));
  homes.push(home);
  const botmux = join(home, '.botmux');
  const root = join(botmux, 'wecom');
  const logDir = join(botmux, 'logs');
  mkdirSync(join(root, 'a'), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(join(botmux, 'data'), { recursive: true });
  const file = join(root, 'a', 'config.json');
  writeFileSync(file, JSON.stringify({ botId: 'bot-a', coreUrl: 'http://127.0.0.1:18080', allowedUsers: ['u'] }));
  writeFileSync(join(root, 'config-registry.json'), JSON.stringify({ version: 1, paths: [file] }));
  const configId = wecomConfigId(file);
  // The supervisor's own member spec names the gateway's log files.
  setWecomFleetDesiredState(configId, 'running', { root });
  const spec = resolveWecomFleetMembers({ distDir: '/unused', baseEnv: {}, readEnvFileText: () => undefined, wecomRoot: root })
    .members.find(member => member.name === wecomFleetMemberName(configId))!;
  const gatewayOut = join(logDir, `${spec.logBaseName}-out.log`);
  if (logs.gateway) {
    writeFileSync(gatewayOut, 'gateway out 1\ngateway out 2\ngateway out 3\n');
    writeFileSync(join(logDir, `${spec.logBaseName}-err.log`), 'gateway err 1\n');
  }
  if (logs.core) {
    writeFileSync(join(logDir, `${wecomCoreLogBaseName(configId)}-out.log`), 'core out 1\n');
    writeFileSync(join(logDir, `${wecomCoreLogBaseName(configId)}-err.log`), 'core err 1\n');
  }
  return { home, file, configId, member: spec.name, gatewayOut };
}

function cliEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    SESSION_DATA_DIR: join(home, '.botmux', 'data'),
    BOTS_CONFIG: join(home, '.botmux', 'bots.json'),
  };
}

/**
 * Run the CLI to its end (at most 60 s). It leads its own process group and the
 * whole group is killed on timeout: a command that wrongly keeps following must
 * not leave its `tail` behind.
 */
async function runCli(home: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { command, prefixArgs } = tsRunnerPrefix();
  const child = spawn(command, [...prefixArgs, cliEntry, ...args], {
    cwd: repoRoot, env: cliEnv(home), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const timer = setTimeout(() => killGroup(child, 'SIGKILL'), 60_000);
  const [status] = await once(child, 'exit') as [number | null];
  clearTimeout(timer);
  return { status, stdout, stderr };
}

describe('botmux wecom logs', () => {
  it('prints the last lines of the gateway\'s logs and exits with --no-follow, by member name or by configId', async () => {
    const f = fixture();
    const byMember = await runCli(f.home, ['wecom', 'logs', f.member, '--no-follow']);
    expect(byMember.status, byMember.stderr).toBe(0);
    expect(byMember.stdout).toContain('gateway out 3');
    expect(byMember.stdout).toContain('gateway err 1');
    expect(byMember.stdout).not.toContain('core out 1');

    const lastLine = await runCli(f.home, ['wecom', 'logs', f.configId, '--lines', '1', '--no-follow']);
    expect(lastLine.status, lastLine.stderr).toBe(0);
    expect(lastLine.stdout).toContain('gateway out 3');
    expect(lastLine.stdout).not.toContain('gateway out 2');
  }, 120_000);

  it('reads the logs when the desired-state file is broken: the registry alone names the target', async () => {
    const f = fixture();
    writeFileSync(join(f.home, '.botmux', 'wecom', 'fleet-desired.json'), '{ broken');
    const result = await runCli(f.home, ['wecom', 'logs', f.member, '--no-follow']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('gateway out 3');
  }, 60_000);

  it('prints the dedicated core\'s logs with --core', async () => {
    const f = fixture();
    const result = await runCli(f.home, ['wecom', 'logs', '--no-follow', '--config', f.file, '--core']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('core out 1');
    expect(result.stdout).toContain('core err 1');
    expect(result.stdout).not.toContain('gateway out');
  }, 60_000);

  it('rejects a connection that is not registered, listing the registered ones, and a target it cannot parse', async () => {
    const f = fixture();
    const unknownId = 'f'.repeat(64);
    const unknown = await runCli(f.home, ['wecom', 'logs', unknownId]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain(unknownId);
    expect(unknown.stderr).toContain(f.configId);
    expect(unknown.stdout).toBe('');

    const unknownMember = await runCli(f.home, ['wecom', 'logs', wecomFleetMemberName(unknownId)]);
    expect(unknownMember.status).toBe(1);
    expect(unknownMember.stderr).toContain(f.configId);

    const unparsable = await runCli(f.home, ['wecom', 'logs', 'botmux-0']);
    expect(unparsable.status).toBe(2);
  }, 120_000);

  it('fails when the selected log files do not exist', async () => {
    const f = fixture({ gateway: true, core: false });
    const core = await runCli(f.home, ['wecom', 'logs', f.member, '--core']);
    expect(core.status).not.toBe(0);
    expect(core.stderr).toContain(`${wecomCoreLogBaseName(f.configId)}-out.log`);
    expect(core.stdout).toBe('');

    const none = fixture({ gateway: false, core: false });
    const gateway = await runCli(none.home, ['wecom', 'logs', none.member]);
    expect(gateway.status).not.toBe(0);
    expect(gateway.stderr).toContain(none.gatewayOut);
  }, 120_000);

  it.each([{ extra: [] as string[] }, { extra: ['-f'] }])('keeps following the gateway\'s log by default (extra arguments: $extra)', async ({ extra }) => {
    const f = fixture();
    const { command, prefixArgs } = tsRunnerPrefix();
    const child = spawn(command, [...prefixArgs, cliEntry, 'wecom', 'logs', f.member, ...extra], {
      cwd: repoRoot, env: cliEnv(f.home), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    children.push(child);
    let stdout = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    const until = async (text: string) => {
      const deadline = Date.now() + 60_000;
      while (!stdout.includes(text)) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`no "${text}" in: ${stdout}`);
        await new Promise(done => setTimeout(done, 100));
      }
    };
    await until('gateway out 3');
    appendFileSync(f.gatewayOut, 'written after start\n');
    await until('written after start');
    expect(child.exitCode).toBeNull();
    const exited = once(child, 'exit');
    killGroup(child, 'SIGTERM');
    await exited;
  }, 90_000);
});

describe('botmux wecom logs --lines', () => {
  const configId = 'a'.repeat(64);
  const member = wecomFleetMemberName(configId);
  /** One registered connection whose log files exist; `tail` only records its arguments. */
  function deps() {
    const tails: string[][] = [];
    const wired: WecomLogsDeps = {
      listConnections: () => [{ configId, file: '/registry/a/config.json', memberName: member }],
      registryPath: '/registry/config-registry.json',
      logDir: async () => '/logs',
      exists: () => true,
      tail: async args => {
        tails.push(args);
        return 0;
      },
      error: () => {},
      log: () => {},
    };
    return { wired, tails };
  }

  it.each(['abc', '-5', '1.5'])('treats --lines %s as a usage error and runs no tail', async lines => {
    const { wired, tails } = deps();
    expect(await runWecomLogsCommand([member, '--lines', lines, '--no-follow'], wired)).toBe(2);
    expect(tails).toEqual([]);
  });

  it('hands --lines 50 to tail', async () => {
    const { wired, tails } = deps();
    expect(await runWecomLogsCommand([member, '--lines', '50', '--no-follow'], wired)).toBe(0);
    expect(tails).toHaveLength(1);
    expect(tails[0]![tails[0]!.indexOf('-n') + 1]).toBe('50');
  });
});
