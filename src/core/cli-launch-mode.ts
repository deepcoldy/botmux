import type { CliId } from '../adapters/cli/types.js';

export type CliLaunchMode = 'forge-traex';

export const CLI_LAUNCH_MODE_FORGE_TRAEX: CliLaunchMode = 'forge-traex';

export function normalizeCliLaunchMode(
  raw: unknown,
  context = 'cliLaunchMode',
): CliLaunchMode | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (raw === CLI_LAUNCH_MODE_FORGE_TRAEX) return raw;
  throw new Error(`${context} must be "forge-traex"`);
}

export function validateCliLaunchModeConfig(input: {
  cliId?: CliId | string;
  cliLaunchMode?: CliLaunchMode;
  wrapperCli?: string;
  cliRuntime?: unknown;
  cliPathOverride?: string;
  sandbox?: boolean;
  readIsolation?: boolean;
}, context = 'Bot config'): void {
  if (!input.cliLaunchMode) return;
  if (input.cliLaunchMode !== CLI_LAUNCH_MODE_FORGE_TRAEX) {
    throw new Error(`${context}: unsupported cliLaunchMode "${input.cliLaunchMode}"`);
  }
  if (input.cliId !== 'traex') {
    throw new Error(`${context}: cliLaunchMode "forge-traex" is supported only for cliId "traex"`);
  }
  if (input.wrapperCli?.trim()) {
    throw new Error(`${context}: cliLaunchMode cannot be combined with wrapperCli`);
  }
  if (input.cliRuntime !== undefined) {
    throw new Error(`${context}: cliLaunchMode cannot be combined with cliRuntime`);
  }
  if (input.cliPathOverride?.trim()) {
    throw new Error(`${context}: cliLaunchMode cannot be combined with cliPathOverride`);
  }
  if (input.sandbox === true || input.readIsolation === true) {
    throw new Error(`${context}: cliLaunchMode cannot be combined with sandbox or readIsolation`);
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(args: ReadonlyArray<string>): string {
  return args.map(shellQuote).join(' ');
}

function forgeAgentArgQuote(value: string): string {
  return shellQuote(value.replace(/\\/g, '\\\\'));
}

function forgeAgentArgsJoin(args: ReadonlyArray<string>): string {
  return args.map(forgeAgentArgQuote).join(' ');
}

export function buildForgeTraexLaunch(
  traexArgs: ReadonlyArray<string>,
  binResolver: (bin: string) => string = (bin) => bin,
): { bin: string; args: string[] } {
  return {
    bin: binResolver('forge'),
    args: ['run', '--agent', 'traex', '--agent-args', forgeAgentArgsJoin(traexArgs)],
  };
}

export function decorateResumeForCliLaunchMode(
  command: string,
  cliLaunchMode: CliLaunchMode | undefined,
): string {
  if (cliLaunchMode !== CLI_LAUNCH_MODE_FORGE_TRAEX) return command;
  const traexArgs = command.trim().replace(/^\S+/, '').trimStart();
  return [
    'forge',
    'run',
    '--agent',
    'traex',
    '--agent-args',
    shellQuote(traexArgs),
  ].join(' ');
}
