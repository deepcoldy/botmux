import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import type { DaemonSession } from './types.js';
import { getBot } from '../bot-registry.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import type { CliId } from '../adapters/cli/types.js';
import { buildWrappedLaunch, decorateResumeForWrapper, parseWrapperCli } from '../setup/cli-selection.js';

type LocalTerminalBackend = 'cli' | 'app';

export type LocalTerminalOpenError =
  | 'cli_unavailable'
  | 'resume_unavailable'
  | 'unsupported_platform'
  | 'launcher_unavailable'
  | 'spawn_failed'
  | 'adapter_error';

export type LocalTerminalOpenResult =
  | { ok: true; backend: LocalTerminalBackend; command: string; launcher: string }
  | { ok: false; error: LocalTerminalOpenError; cliId?: string; executable?: string; detail?: string; command?: string };

type LocalCliCommandResult =
  | { ok: true; command: string; executable: string; mode: 'resume' | 'launch' }
  | { ok: false; error: 'cli_unavailable' | 'resume_unavailable' | 'adapter_error'; cliId?: string; executable?: string; detail?: string };

interface EffectiveCliConfig {
  cliId: CliId;
  cliPathOverride?: string;
  wrapperCli?: string;
  model?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function onPath(bin: string): boolean {
  if (bin.includes('/')) return spawnSync('test', ['-x', bin]).status === 0;
  const paths = (process.env.PATH || '').split(delimiter).filter(Boolean);
  if (paths.some(dir => spawnSync('test', ['-x', `${dir}/${bin}`]).status === 0)) return true;
  const shell = process.env.SHELL || '/bin/zsh';
  const result = spawnSync(shell, ['-lc', `command -v ${shellQuote(bin)}`], {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 && (result.stdout ?? '').trim().length > 0;
}

function effectiveCliConfig(ds: DaemonSession): EffectiveCliConfig {
  let botCfg: { cliId?: CliId; cliPathOverride?: string; wrapperCli?: string; model?: string } | undefined;
  try { botCfg = getBot(ds.larkAppId).config; } catch { /* tests / deregistered bot */ }
  return {
    cliId: (ds.session.cliId ?? ds.initConfig?.cliId ?? botCfg?.cliId ?? 'claude-code') as CliId,
    cliPathOverride: ds.session.cliPathOverride ?? ds.initConfig?.cliPathOverride ?? botCfg?.cliPathOverride,
    wrapperCli: ds.session.wrapperCli ?? ds.initConfig?.wrapperCli ?? botCfg?.wrapperCli,
    model: ds.session.model ?? ds.initConfig?.model ?? botCfg?.model,
  };
}

function isCodexFamily(cliId: string): boolean {
  return cliId === 'codex' || cliId === 'codex-app';
}

function defaultLocalExecutable(cliId: CliId, adapterResolvedBin: string, cliPathOverride?: string): string | null {
  if (cliPathOverride?.trim()) return cliPathOverride.trim();
  if (cliId === 'codex-app') return 'codex';
  if (cliId === 'mira') return null;
  if (cliId === 'mir') return 'mircli';
  return adapterResolvedBin;
}

function replaceFirstToken(command: string, executable: string): string {
  const rest = command.trim().replace(/^\S+/, '').trimStart();
  return rest ? `${shellQuote(executable)} ${rest}` : shellQuote(executable);
}

function shellJoin(parts: ReadonlyArray<string>): string {
  return parts.map(shellQuote).join(' ');
}

function commandForWrapperLaunch(wrapperCli: string, args: ReadonlyArray<string>, model?: string): { command: string; executable: string } {
  const tokens = parseWrapperCli(wrapperCli);
  const launch = buildWrappedLaunch(wrapperCli, args, (bin) => bin, { ttadkModel: model });
  return {
    command: shellJoin([launch.bin, ...launch.args]),
    executable: tokens[0] ?? launch.bin,
  };
}

function appleScriptString(value: string): string {
  return JSON.stringify(value);
}

export function localCliCommandForSession(ds: DaemonSession): LocalCliCommandResult {
  const cfg = effectiveCliConfig(ds);
  const cwd = ds.workingDir || ds.session.workingDir || ds.adoptedFrom?.cwd || homedir();
  const cd = `cd ${shellQuote(cwd)}`;
  let adapter: ReturnType<typeof createCliAdapterSync>;
  try {
    adapter = createCliAdapterSync(cfg.cliId, cfg.cliPathOverride);
  } catch (err) {
    return { ok: false, error: 'adapter_error', cliId: cfg.cliId, detail: err instanceof Error ? err.message : String(err) };
  }

  const rawResume = adapter.buildResumeCommand?.({
    sessionId: ds.session.sessionId,
    cliSessionId: ds.session.cliSessionId,
  }) ?? null;

  if (rawResume) {
    const decorated = decorateResumeForWrapper(rawResume, cfg.wrapperCli, { ttadkModel: cfg.model });
    if (cfg.wrapperCli?.trim()) {
      const executable = parseWrapperCli(cfg.wrapperCli)[0];
      if (!executable || !onPath(executable)) {
        return { ok: false, error: 'cli_unavailable', cliId: cfg.cliId, executable };
      }
      return { ok: true, mode: 'resume', executable, command: `${cd} && exec ${decorated}` };
    }
    const executable = defaultLocalExecutable(cfg.cliId, adapter.resolvedBin, cfg.cliPathOverride);
    if (!executable || !onPath(executable)) {
      return { ok: false, error: 'cli_unavailable', cliId: cfg.cliId, executable: executable ?? cfg.cliId };
    }
    return { ok: true, mode: 'resume', executable, command: `${cd} && exec ${replaceFirstToken(rawResume, executable)}` };
  }

  if (cfg.wrapperCli?.trim()) {
    const { command, executable } = commandForWrapperLaunch(cfg.wrapperCli, [], cfg.model);
    if (!executable || !onPath(executable)) {
      return { ok: false, error: 'cli_unavailable', cliId: cfg.cliId, executable };
    }
    return { ok: true, mode: 'launch', executable, command: `${cd} && exec ${command}` };
  }

  const executable = defaultLocalExecutable(cfg.cliId, adapter.resolvedBin, cfg.cliPathOverride);
  if (!executable) {
    return { ok: false, error: 'resume_unavailable', cliId: cfg.cliId };
  }
  if (!onPath(executable)) {
    return { ok: false, error: 'cli_unavailable', cliId: cfg.cliId, executable };
  }
  return { ok: true, mode: 'launch', executable, command: `${cd} && exec ${shellQuote(executable)}` };
}

function spawnDetached(command: string, args: string[]): { ok: true } | { ok: false; error: string } {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function openOnMac(command: string): LocalTerminalOpenResult {
  if (!onPath('osascript')) return { ok: false, error: 'launcher_unavailable', detail: 'osascript not found', command };
  const args = [
    '-e', 'tell application "Terminal"',
    '-e', 'activate',
    '-e', `do script ${appleScriptString(command)}`,
    '-e', 'end tell',
  ];
  const launched = spawnDetached('osascript', args);
  if (!launched.ok) return { ok: false, error: 'spawn_failed', detail: launched.error, command };
  return { ok: true, backend: 'cli', command, launcher: 'Terminal.app' };
}

function openCodexApp(): LocalTerminalOpenResult {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'unsupported_platform', detail: process.platform, command: 'open -a Codex' };
  }
  if (!onPath('open')) return { ok: false, error: 'launcher_unavailable', detail: 'open not found', command: 'open -a Codex' };
  const launched = spawnSync('open', ['-a', 'Codex'], { stdio: 'ignore', timeout: 3000 });
  if (launched.status === 0) {
    return { ok: true, backend: 'app', command: 'open -a Codex', launcher: 'Codex.app' };
  }
  return {
    ok: false,
    error: 'launcher_unavailable',
    detail: launched.error?.message ?? 'Codex.app not found',
    command: 'open -a Codex',
  };
}

/** Per-emulator command forwarding: gnome-terminal wants `--`, xfce4-terminal
 *  `-x`, kitty / xdg-terminal-exec take the command as positional args, and the
 *  xterm lineage (konsole / alacritty / xterm and most others, including
 *  whatever BOTMUX_TERMINAL points at) wants `-e`. */
export function terminalLaunchArgs(terminalBase: string, shell: string, command: string): string[] {
  if (terminalBase === 'gnome-terminal') return ['--', shell, '-lc', command];
  if (terminalBase === 'xfce4-terminal') return ['-x', shell, '-lc', command];
  if (terminalBase === 'kitty' || terminalBase === 'xdg-terminal-exec') return [shell, '-lc', command];
  return ['-e', shell, '-lc', command];
}

function openOnLinux(command: string): LocalTerminalOpenResult {
  const shell = process.env.SHELL || 'bash';
  const preferred = process.env.BOTMUX_TERMINAL || process.env.TERMINAL;
  const candidates = [
    ...(preferred ? [preferred] : []),
    'xdg-terminal-exec',
    'gnome-terminal',
    'konsole',
    'xfce4-terminal',
    'kitty',
    'alacritty',
    'xterm',
  ];
  const terminal = candidates.find(onPath);
  if (!terminal) return { ok: false, error: 'launcher_unavailable', detail: 'no terminal launcher found', command };
  const base = terminal.split('/').pop() || terminal;
  const launched = spawnDetached(terminal, terminalLaunchArgs(base, shell, command));
  if (!launched.ok) return { ok: false, error: 'spawn_failed', detail: launched.error, command };
  return { ok: true, backend: 'cli', command, launcher: terminal };
}

/** Whether the daemon host can plausibly pop a native terminal window at all.
 *  Gates the card button so headless/server deployments don't carry a button
 *  that can only ever fail: macOS always qualifies (osascript + Terminal.app
 *  ship with the OS); Linux only with a GUI session (DISPLAY/WAYLAND_DISPLAY)
 *  or an explicit BOTMUX_TERMINAL/TERMINAL override. */
export function localTerminalCapable(): boolean {
  if (process.platform === 'darwin') return true;
  if (process.platform === 'linux') {
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.BOTMUX_TERMINAL || process.env.TERMINAL);
  }
  return false;
}

export function openLocalTerminalForSession(ds: DaemonSession): LocalTerminalOpenResult {
  const cfg = effectiveCliConfig(ds);
  const resolved = localCliCommandForSession(ds);
  if (!resolved.ok && resolved.error === 'cli_unavailable' && isCodexFamily(cfg.cliId) && !cfg.wrapperCli?.trim()) {
    const app = openCodexApp();
    if (app.ok) return app;
    return { ...resolved, detail: app.detail ?? resolved.detail };
  }
  if (!resolved.ok) return resolved;
  if (process.platform === 'darwin') return openOnMac(resolved.command);
  if (process.platform === 'linux') return openOnLinux(resolved.command);
  return { ok: false, error: 'unsupported_platform', detail: process.platform, command: resolved.command };
}
