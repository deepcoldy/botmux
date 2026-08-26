import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LinuxPm2GodProcess } from '../core/pm2-lifecycle-owner.js';

const ABSENT_EXIT_CODE = 4;

type ExistingPm2Mutation =
  | { operation: 'start'; target: string; only?: string; updateEnv?: boolean }
  | { operation: 'restart'; target: string; updateEnv?: boolean }
  | { operation: 'stop' | 'delete'; target: string }
  | { operation: 'kill' };

type ExistingPm2Request = ExistingPm2Mutation & { expectedGod: LinuxPm2GodProcess };

function mutationFromArgs(args: string[]): ExistingPm2Mutation {
  const [operation, target] = args;
  // `pm2 kill` is socket-addressed ("whichever God owns this home"), not
  // PID-addressed: the helper asks the attested God to shut itself down over
  // its own RPC socket. It deliberately takes no target.
  if (operation === 'kill') {
    if (args.length !== 1) throw new Error(`unsupported PM2 mutation: ${args.join(' ')}`);
    return { operation: 'kill' };
  }
  if (!target) throw new Error(`unsupported PM2 mutation without target: ${args.join(' ')}`);
  if (operation === 'stop' || operation === 'delete') {
    if (args.length !== 2) throw new Error(`unsupported PM2 mutation: ${args.join(' ')}`);
    return { operation, target };
  }
  if (operation !== 'start') throw new Error(`unsupported PM2 mutation: ${args.join(' ')}`);
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
  const updateEnv = args.includes('--update-env');
  const expectedLength = 2 + (only ? 2 : 0) + (updateEnv ? 1 : 0);
  if (args.length !== expectedLength || (onlyIndex >= 0 && !only)) {
    throw new Error(`unsupported PM2 start mutation: ${args.join(' ')}`);
  }
  if (updateEnv && !only) return { operation: 'restart', target, updateEnv: true };
  return {
    operation: 'start',
    target,
    ...(only ? { only } : {}),
    ...(updateEnv ? { updateEnv: true } : {}),
  };
}

function helperArgs(pkgRoot: string, request: ExistingPm2Request): string[] {
  const built = join(pkgRoot, 'dist', 'cli', 'pm2-existing-client.js');
  const payload = JSON.stringify(request);
  // Source/test execution must not silently select a stale dist helper with an
  // older request contract. Installed production code runs from dist and uses
  // the sibling built helper.
  if (import.meta.url.includes('/dist/cli/pm2-existing.js') && existsSync(built)) {
    return [built, payload];
  }
  return ['--import', 'tsx', join(pkgRoot, 'src', 'cli', 'pm2-existing-client.ts'), payload];
}

/** Mutate an attested existing God without PM2's public connect/daemonize path. */
export function runExistingPm2Command(input: {
  pkgRoot: string;
  home: string;
  args: string[];
  inherit?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  expectedGod: LinuxPm2GodProcess;
}): void {
  if (!input.expectedGod.startIdentity) {
    throw new Error(`PM2 God pid ${input.expectedGod.pid} has no process-birth identity`);
  }
  const request = { ...mutationFromArgs(input.args), expectedGod: input.expectedGod };
  const result = spawnSync(
    input.nodePath ?? process.execPath,
    helperArgs(input.pkgRoot, request),
    {
      stdio: input.inherit === false ? 'pipe' : 'inherit',
      env: {
        ...(input.env ?? process.env),
        PM2_HOME: input.home,
      },
      timeout: input.timeoutMs ?? 30_000,
    },
  );
  if (result.status === 0) return;
  const stderr = String(result.stderr ?? '').trim();
  const detail = result.error?.message ?? (stderr || `status ${result.status}`);
  if (result.status === ABSENT_EXIT_CODE) {
    throw new Error(`PM2 God disappeared before mutation; no replacement daemon was created: ${detail}`);
  }
  throw new Error(`PM2 existing-daemon ${input.args.join(' ')} failed: ${detail}`);
}
