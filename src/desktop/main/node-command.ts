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

export interface BuildBundledBotmuxCommandInput {
  nodePath: string;
  cliPath: string;
  botmuxHome: string;
  args: string[];
  baseEnv: NodeJS.ProcessEnv;
  /** Probed user shell PATH (zsh/bash, profile+rc) — see probeShellPathEnv. */
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

export function buildBundledBotmuxCommand(input: BuildBundledBotmuxCommandInput): BotmuxCommand {
  const env: NodeJS.ProcessEnv = {
    ...input.baseEnv,
    // Finder-launched apps only carry launchd's minimal PATH. The daemon this
    // command starts must still find per-bot CLIs (claude/codex/traex/... via
    // nvm/fnm/homebrew) and a `node` for their `#!/usr/bin/env node` shebangs,
    // so repair PATH: user's shell PATH first (their nvm node keeps winning,
    // matching terminal behavior), bundled node as fallback, then well-known
    // install dirs.
    PATH: buildBundledPath(input.baseEnv.PATH, input.nodePath, input.pathEnv),
    PM2_HOME: join(input.botmuxHome, 'pm2'),
    SESSION_DATA_DIR: join(input.botmuxHome, 'data'),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  return {
    command: input.nodePath,
    args: [input.cliPath, ...input.args],
    env,
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

/**
 * PATH for anything spawned on behalf of the bundled runtime (daemon start and
 * pm2 contact alike — pm2's daemon env sticks and propagates into resurrected
 * apps, so BOTH chains must agree on ordering or which `node` a per-bot CLI
 * gets would depend on pm2 startup order). User shell PATH first: their
 * nvm/fnm node keeps winning like in a terminal; the bundled node dir is only
 * the fallback for `#!/usr/bin/env node` when the user has no node at all.
 * Callers never rely on this PATH to locate node/pm2 themselves — both are
 * invoked via absolute paths.
 */
export function buildBundledPath(current: string | undefined, nodePath: string, pathEnv: string | undefined): string {
  return joinPathEntries([
    pathEnv,
    dirname(nodePath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    current,
  ]);
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
