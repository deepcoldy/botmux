import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isStandaloneBinary } from '../core/self-spawn.js';

export const PM2_READONLY_CLIENT_SUBCOMMAND = '__pm2-readonly-client';
export const PM2_EXISTING_CLIENT_SUBCOMMAND = '__pm2-existing-client';

interface HelperSpawnInput {
  pkgRoot: string;
  nodePath?: string;
  clientName: 'pm2-readonly-client' | 'pm2-existing-client';
  clientSubcommand: typeof PM2_READONLY_CLIENT_SUBCOMMAND | typeof PM2_EXISTING_CLIENT_SUBCOMMAND;
  clientArgs: readonly string[];
  runningFromDist: boolean;
  standalone?: boolean;
  bunRuntime?: boolean;
}

export interface HelperSpawn {
  command: string;
  args: string[];
}

function isBunRuntime(): boolean {
  // @ts-ignore -- Bun global is absent under Node/tsc; guard at runtime.
  return typeof Bun !== 'undefined';
}

export function buildPm2HelperSpawn(input: HelperSpawnInput): HelperSpawn {
  const standalone = input.standalone ?? isStandaloneBinary();
  if (standalone) {
    return {
      command: process.execPath,
      args: [input.clientSubcommand, ...input.clientArgs],
    };
  }

  const command = input.nodePath ?? process.execPath;
  const sourceRunsTypescriptNatively = input.bunRuntime ?? (!input.nodePath && isBunRuntime());
  const built = join(input.pkgRoot, 'dist', 'cli', `${input.clientName}.js`);
  if (input.runningFromDist && existsSync(built)) {
    return { command, args: [built, ...input.clientArgs] };
  }

  const source = join(input.pkgRoot, 'src', 'cli', `${input.clientName}.ts`);
  return sourceRunsTypescriptNatively
    ? { command, args: [source, ...input.clientArgs] }
    : { command, args: ['--import', 'tsx', source, ...input.clientArgs] };
}
