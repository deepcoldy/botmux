import { delimiter, dirname, join } from 'node:path';

export interface BuildBotmuxCommandInput {
  electronExecPath: string;
  cliPath: string;
  botmuxHome: string;
  args: string[];
  baseEnv: NodeJS.ProcessEnv;
}

export interface BotmuxCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface BuildExternalBotmuxCommandInput {
  binPath: string;
  botmuxHome: string;
  args: string[];
  baseEnv: NodeJS.ProcessEnv;
  pathEnv?: string;
}

export function buildBotmuxCommand(input: BuildBotmuxCommandInput): BotmuxCommand {
  return {
    command: input.electronExecPath,
    args: [input.cliPath, ...input.args],
    env: {
      ...input.baseEnv,
      // Reuse Electron's embedded Node runtime to execute the packaged CLI.
      ELECTRON_RUN_AS_NODE: '1',
      // Isolate desktop-managed PM2/session state from any global PM2 daemon.
      PM2_HOME: join(input.botmuxHome, 'pm2'),
      SESSION_DATA_DIR: join(input.botmuxHome, 'data'),
    },
  };
}

export function buildExternalBotmuxCommand(input: BuildExternalBotmuxCommandInput): BotmuxCommand {
  const env: NodeJS.ProcessEnv = {
    ...input.baseEnv,
    // External CLI bins often use /usr/bin/env node; Finder-launched apps have
    // a small PATH, so put the bin's directory first before invoking it.
    PATH: buildExternalPath(input.baseEnv.PATH, input.binPath, input.pathEnv),
    PM2_HOME: join(input.botmuxHome, 'pm2'),
    SESSION_DATA_DIR: join(input.botmuxHome, 'data'),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  return {
    command: input.binPath,
    args: input.args,
    env,
  };
}

function buildExternalPath(current: string | undefined, binPath: string, pathEnv: string | undefined): string {
  return joinPathEntries([
    dirname(binPath),
    pathEnv,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    current,
  ]);
}

function joinPathEntries(entries: Array<string | undefined>): string {
  const seen = new Set<string>();
  const ordered = entries
    .flatMap(entry => entry ? entry.split(delimiter) : [])
    .map(entry => entry.trim())
    .filter(entry => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
  return ordered.join(delimiter);
}
