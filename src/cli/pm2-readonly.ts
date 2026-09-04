import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LinuxPm2GodProcess } from '../core/pm2-lifecycle-owner.js';
import { isStandaloneBinary, resolveEntrySpawn } from '../core/self-spawn.js';

const ABSENT_EXIT_CODE = 3;

function nodeHelperArgs(pkgRoot: string, modeArgs: string[]): string[] {
  const built = join(pkgRoot, 'dist', 'cli', 'pm2-readonly-client.js');
  if (import.meta.url.includes('/dist/cli/pm2-readonly.js') && existsSync(built)) {
    return [built, ...modeArgs];
  }
  return ['--import', 'tsx', join(pkgRoot, 'src', 'cli', 'pm2-readonly-client.ts'), ...modeArgs];
}

/** Resolve the isolated observer across both runtime shapes.
 *
 * A compiled binary has no physical dist/ or src/ helper to hand to a child.
 * Re-enter the binary through a statically-dispatched hidden entry instead;
 * this also makes Bun trace and embed pm2-readonly-client in the module graph.
 */
export function resolveReadonlyPm2Spawn(input: {
  pkgRoot: string;
  modeArgs: string[];
  nodePath?: string;
}): { command: string; args: string[] } {
  if (isStandaloneBinary()) {
    const resolved = resolveEntrySpawn('pm2-readonly-client', join(input.pkgRoot, 'dist'));
    return { command: resolved.command, args: [...resolved.args, ...input.modeArgs] };
  }
  return {
    command: input.nodePath ?? process.execPath,
    args: nodeHelperArgs(input.pkgRoot, input.modeArgs),
  };
}

function readonlyEnv(
  home: string,
  expectedGod?: LinuxPm2GodProcess,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PM2_HOME: home,
    PM2_SILENT: 'true',
    PM2_USAGE: 'CLI',
  };
  delete env.BOTMUX_PM2_EXPECTED_GOD;
  if (expectedGod) env.BOTMUX_PM2_EXPECTED_GOD = JSON.stringify(expectedGod);
  return env;
}

export function captureReadonlyPm2Jlist(input: {
  pkgRoot: string;
  home: string;
  nodePath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  expectedGod?: LinuxPm2GodProcess;
}): string {
  const helper = resolveReadonlyPm2Spawn({
    pkgRoot: input.pkgRoot,
    modeArgs: ['jlist'],
    nodePath: input.nodePath,
  });
  const result = spawnSync(helper.command, helper.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: readonlyEnv(input.home, input.expectedGod, { ...process.env, ...(input.env ?? {}) }),
    timeout: input.timeoutMs ?? 10_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === ABSENT_EXIT_CODE) return '[]';
  if (result.status !== 0) {
    const detail = result.error?.message
      ?? (String(result.stderr ?? '').trim() || `status ${result.status}`);
    throw new Error(`PM2 read-only jlist failed: ${detail}`);
  }
  return String(result.stdout ?? '');
}

export function printReadonlyPm2Status(input: {
  pkgRoot: string;
  home: string;
  nodePath?: string;
  expectedGod?: LinuxPm2GodProcess;
}): void {
  const helper = resolveReadonlyPm2Spawn({
    pkgRoot: input.pkgRoot,
    modeArgs: ['status'],
    nodePath: input.nodePath,
  });
  const result = spawnSync(helper.command, helper.args, {
    stdio: 'inherit',
    env: readonlyEnv(input.home, input.expectedGod),
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new Error(`PM2 read-only status failed: ${result.error?.message ?? `status ${result.status}`}`);
  }
}

export function spawnReadonlyPm2Logs(input: {
  pkgRoot: string;
  home: string;
  target: string;
  lines: string;
  nodePath?: string;
  expectedGod?: LinuxPm2GodProcess;
}): ChildProcess {
  const helper = resolveReadonlyPm2Spawn({
    pkgRoot: input.pkgRoot,
    modeArgs: ['logs', input.target, input.lines],
    nodePath: input.nodePath,
  });
  return spawn(
    helper.command,
    helper.args,
    { stdio: 'inherit', env: readonlyEnv(input.home, input.expectedGod) },
  );
}
