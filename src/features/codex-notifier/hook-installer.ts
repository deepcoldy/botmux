import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';

function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function codexHooksPath(env = process.env, userHome = homedir()): string {
  const codexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()
    ? env.CODEX_HOME.trim()
    : join(userHome, '.codex');
  return join(codexHome, 'hooks.json');
}

export function botmuxCodexNotifierHookCommand(
  userHome = homedir(),
  nodePath = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const shim = win32.join(userHome, '.botmux', 'bin', 'botmux.cmd');
    return `"${shim.replaceAll('"', '""')}" codex-watch-hook`;
  }
  const path = [dirname(nodePath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  return `/usr/bin/env PATH=${shellWord(path)} ${shellWord(join(userHome, '.botmux', 'bin', 'botmux'))} codex-watch-hook`;
}

function plainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function botmuxShimFromCommand(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(
    /(?:^|\s)(?:'([^']*[\\/]\.botmux[\\/]bin[\\/]botmux(?:\.cmd)?)'|"([^"]*[\\/]\.botmux[\\/]bin[\\/]botmux(?:\.cmd)?)"|([^\s'"]*[\\/]\.botmux[\\/]bin[\\/]botmux(?:\.cmd)?))\s+codex-watch-hook(?:\s|$)/i,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function isBotmuxCodexNotifierCommand(value: unknown): boolean {
  return botmuxShimFromCommand(value) !== undefined;
}

function isRunnableBotmuxCodexNotifierCommand(value: unknown): boolean {
  const shim = botmuxShimFromCommand(value);
  if (!shim) return false;
  try {
    accessSync(shim, constants.X_OK);
  } catch {
    return false;
  }
  if (typeof value !== 'string') return false;
  const pathMatch = value.match(/(?:^|\s)PATH=(?:'([^']*)'|"([^"]*)"|([^\s]+))/);
  if (!pathMatch) return true;
  const path = pathMatch[1] ?? pathMatch[2] ?? pathMatch[3] ?? '';
  return path.split(':').some(dir => {
    if (!dir) return false;
    try {
      accessSync(join(dir, 'node'), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function readHooksRoot(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  const root = JSON.parse(readFileSync(path, 'utf8'));
  if (!plainObject(root)) throw new Error('hooks_config_invalid_root');
  return root;
}

const CODEX_NOTIFIER_HOOK_EVENTS = ['Stop', 'UserPromptSubmit'] as const;

function eventHasRunnableHook(root: Record<string, any>, eventName: string): boolean {
  const entries = root.hooks?.[eventName];
  return Array.isArray(entries) && entries.some((entry: any) => Array.isArray(entry?.hooks)
    && entry.hooks.some((hook: any) => hook?.type === 'command'
      && isRunnableBotmuxCodexNotifierCommand(hook.command)));
}

/** Stop 与 UserPromptSubmit 都存在时才算完整安装，避免失去真实用户 turn 的强来源证明。 */
export function isCodexNotifierHookInstalled(path = codexHooksPath()): boolean {
  try {
    const root = readHooksRoot(path);
    if (!plainObject(root.hooks)) return false;
    return CODEX_NOTIFIER_HOOK_EVENTS.every(eventName => eventHasRunnableHook(root, eventName));
  } catch {
    return false;
  }
}

/**
 * 幂等安装 UserPromptSubmit + Stop Hook。前者确认用户 turn，后者据此过滤内部 turn。
 * 会替换旧 checkout/旧 Node 路径，同时保留 Flux 和其他 Hook。
 * 迁移期 legacy-stop 只保留 Stop，避免旧插件收到不认识的 UserPromptSubmit。
 */
export function installCodexNotifierHook(options: {
  path?: string;
  command?: string;
  mode?: 'full' | 'legacy-stop';
} = {}): { path: string; command: string; changed: boolean } {
  const path = options.path ?? codexHooksPath();
  const requestedCommand = options.command ?? botmuxCodexNotifierHookCommand();
  const mode = options.mode ?? 'full';
  const root = readHooksRoot(path);
  const original = JSON.stringify(root);
  if (!Object.hasOwn(root, 'hooks')) root.hooks = {};
  if (!plainObject(root.hooks)) throw new Error('hooks_config_invalid_hooks');

  let existingCommand: string | undefined;
  for (const eventName of CODEX_NOTIFIER_HOOK_EVENTS) {
    const entries = root.hooks[eventName];
    if (entries !== undefined && !Array.isArray(entries)) {
      throw new Error(`hooks_config_invalid_${eventName.toLowerCase()}`);
    }
    for (const entry of entries ?? []) {
      for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
        if (
          !existingCommand
          && hook?.type === 'command'
          && isBotmuxCodexNotifierCommand(hook.command)
          && isRunnableBotmuxCodexNotifierCommand(hook.command)
        ) {
          existingCommand = hook.command;
        }
      }
    }
  }

  // 已信任的旧命令字节保持不变；只去重和收敛分组。新安装使用稳定 PATH。
  const command = existingCommand ?? requestedCommand;
  for (const eventName of CODEX_NOTIFIER_HOOK_EVENTS) {
    const nextEntries: any[] = [];
    for (const entry of root.hooks[eventName] ?? []) {
      if (!plainObject(entry) || !Array.isArray(entry.hooks)) {
        nextEntries.push(entry);
        continue;
      }
      const remaining = entry.hooks.filter((hook: any) =>
        !(hook?.type === 'command' && isBotmuxCodexNotifierCommand(hook.command)));
      if (remaining.length > 0) nextEntries.push({ ...entry, hooks: remaining });
    }
    if (mode === 'full' || eventName === 'Stop') {
      nextEntries.push({
        matcher: '*',
        hooks: [{ type: 'command', command, timeout: 10 }],
      });
    }
    if (nextEntries.length > 0) root.hooks[eventName] = nextEntries;
    else delete root.hooks[eventName];
  }

  const changed = JSON.stringify(root) !== original;
  if (changed) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(path, `${JSON.stringify(root, null, 2)}\n`, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  }
  return { path, command, changed };
}
