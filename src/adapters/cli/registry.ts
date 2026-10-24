import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { locateExecutable } from '../../utils/executable.js';
import type { CliAdapter, CliId, StructuredBridgeSpec } from './types.js';
import { cliSupportsConfigDir } from '../../core/cli-config-dir.js';
export { cliSupportsConfigDir };
import { createClaudeCodeAdapter } from './claude-code.js';
import { createSeedAdapter } from './seed.js';
import { createRelayAdapter } from './relay.js';
import { createAidenAdapter } from './aiden.js';
import { createCocoAdapter, cocoBridgeSpec } from './coco.js';
import { createCodexAdapter, codexBridgeSpec } from './codex.js';
import { createCodexAppAdapter } from './codex-app.js';
import { createCursorAdapter, cursorBridgeSpec } from './cursor.js';
import { createGeminiAdapter } from './gemini.js';
import { createGeniusAdapter } from './genius.js';
import { createOpenCodeAdapter } from './opencode.js';
import { createOpenCode2Adapter } from './opencode2.js';
import { createMiMoCodeAdapter } from './mimocode.js';
import { createAntigravityAdapter, antigravityBridgeSpec } from './antigravity.js';
import { createMtrAdapter } from './mtr.js';
import { createHermesAdapter } from './hermes.js';
import { createMiraAdapter } from './mira.js';
import { createMirAdapter } from './mir.js';
import { createTraexAdapter, traexBridgeSpec } from './traex.js';
import { createPiAdapter, piBridgeSpec } from './pi.js';
import { createCopilotAdapter } from './copilot.js';
import { createOhMyPiAdapter, ompBridgeSpec } from './oh-my-pi.js';
import { createEbsdAdapter, ebsdBridgeSpec } from './ebsd.js';
import { createKimiAdapter } from './kimi.js';
import { createCodemAdapter, defaultCodemExecutable } from './codem.js';
import { createGrokAdapter, grokBridgeSpec } from './grok.js';
import { createKiroCliAdapter } from './kiro-cli.js';
import { createRiffAdapter } from './riff.js';
import { createReasonixAdapter } from './reasonix.js';
import { createDshAdapter } from './dsh.js';
import { createDshTuiAdapter } from './dsh-tui.js';
import { createMojoAdapter } from './mojo.js';
import { createMinimaxAdapter } from './minimax.js';
import { createRemoteRunnerAdapter } from './remote-runner.js';

/**
 * The first CLI executable (or nested runner dependency) before shell
 * resolution.  Keep this next to the adapter factory switch so adding an
 * adapter cannot accidentally make cheap setup/dashboard availability checks
 * instantiate the adapter and trigger its lazy `resolvedBin` shell probes.
 */
const RAW_CLI_EXECUTABLES: Readonly<Record<CliId, string | undefined>> = {
  'claude-code': 'claude',
  seed: 'seed',
  relay: 'relay',
  aiden: 'aiden',
  coco: 'coco',
  codex: 'codex',
  // The adapter itself launches a bundled Node runner; codex is its real
  // second-stage dependency.
  'codex-app': 'codex',
  cursor: 'cursor-agent',
  gemini: 'gemini',
  genius: 'genius',
  opencode: 'opencode',
  opencode2: 'opencode2',
  mimocode: 'mimo',
  antigravity: 'agy',
  mtr: 'mtr',
  hermes: 'hermes',
  // API-backed; no local executable is required.
  mira: undefined,
  // The adapter itself launches a bundled Node runner; mircli is its real
  // second-stage dependency.
  mir: 'mircli',
  traex: 'traex',
  pi: 'pi',
  copilot: 'copilot',
  'oh-my-pi': 'omp',
  ebsd: 'ebsd',
  kimi: 'kimi',
  grok: 'grok',
  'kiro-cli': 'kiro-cli',
  // API-backed; no local executable is required.
  riff: undefined,
  reasonix: 'reasonix',
  // The adapter itself launches a bundled Node runner; `dsh` (the CLI) is
  // its real second-stage dependency.
  dsh: 'dsh',
  // PTY-driven TUI variant of dsh. Selected via the bot's dshRuntime='tui'
  // toggle, not directly from the CLI dropdown (absent from CLI_ID_CHOICES).
  'dsh-tui': 'dsh-tui',
  // The worker never spawns this (MojoBackend shells out per turn), but the
  // binary DOES have to exist locally — unlike riff/mira, which are pure HTTP.
  // Declaring it lets `botmux setup` fail fast on a missing install instead of
  // letting the first IM message die with ENOENT.
  mojo: 'mojo',
  // MiniMax Code — native exec stream-json, wrapped by minimax-runner.
  minimax: 'mcode',
  'remote-runner': 'botmux-remote-runner',
  codem: 'codem',
};

/**
 * Every known CLI id, derived from the closed `Record<CliId, …>` above rather
 * than re-typed by hand.
 *
 * A hand-maintained duplicate of this list in dashboard.ts silently went stale
 * twice (it was missing both `reasonix` and `mojo`), because a plain
 * `CliId[]` literal is only checked for *bad* members — never for missing ones.
 * Deriving it means adding a CLI to RAW_CLI_EXECUTABLES (which tsc forces) is
 * enough, and no consumer can drift again.
 */
export const ALL_CLI_IDS: readonly CliId[] = Object.keys(RAW_CLI_EXECUTABLES) as CliId[];

/** Return the unresolved command without constructing an adapter or spawning a
 * shell.  This is deliberately safe for synchronous UI option enumeration. */
export function rawCliExecutable(id: CliId, pathOverride?: string): string | undefined {
  const normalized = id.toLowerCase() as CliId;
  const override = pathOverride?.trim();
  return override || (normalized === 'codem' ? defaultCodemExecutable() : RAW_CLI_EXECUTABLES[normalized]);
}

const RESOLVE_COMMAND_SCRIPT = 'command -v -- "$1"';

function commandProbeArgv(sh: string, flags: string, cmd: string, useSetsid = true): string[] {
  const args = [sh, flags, RESOLVE_COMMAND_SCRIPT, 'botmux-resolve-command', cmd];
  return useSetsid && existsSync('/usr/bin/setsid') ? ['/usr/bin/setsid', '-w', ...args] : args;
}

function commandProbePath(stdout: string): string | undefined {
  return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    .reverse().find(line => isAbsolute(line));
}

/** macOS desktop apps bundle a standalone Codex binary even when `codex` is
 * not installed on PATH. ChatGPT is the current app name; keep the legacy
 * Codex.app locations so existing installations continue to work. */
export function macOSBundledCodexCandidates(userHome = homedir()): string[] {
  return ['ChatGPT.app', 'Codex.app'].flatMap(appName => [
    join('/Applications', appName, 'Contents', 'Resources', 'codex'),
    join(userHome, 'Applications', appName, 'Contents', 'Resources', 'codex'),
  ]);
}

/** Resolve a command name to its absolute path via a login/interactive shell.
 *  Tries login shell first (-lc), then interactive shell (-ic) for tools
 *  whose installers add PATH entries to .bashrc/.zshrc only. The command is
 *  passed as positional argv ($1), never interpolated into the shell program:
 *  spaces and shell metacharacters therefore remain one literal filename. */
export function resolveCommand(cmd: string): string {
  if (isAbsolute(cmd)) return cmd;
  const shell = process.env.SHELL || '/bin/zsh';
  const shells = [shell, '/bin/zsh', '/bin/bash'].filter((v, i, a) => a.indexOf(v) === i);
  // `setsid` (util-linux) runs the probe in its own session with NO controlling
  // terminal. Absent on macOS — there the tty-free stdio below is the safeguard.
  // -lc: login shell (sources .profile/.zprofile) — covers npm/nvm/fnm installs
  // -ic: interactive shell (sources .bashrc/.zshrc) — covers installers like opencode
  for (const flags of ['-lc', '-ic']) {
    for (const sh of shells) {
      // Harden the probe so it can't disturb the caller's terminal:
      //  - stdio ['ignore','pipe','ignore'] → stdin & stderr are /dev/null, so a
      //    `read` in the user's rc gets EOF instead of blocking, and the
      //    interactive `-ic` shell sees no tty on its fds → it won't enable job
      //    control or tcsetpgrp the controlling terminal;
      //  - `setsid` (when present) gives it its own session with no controlling
      //    tty, so even rc that pokes /dev/tty directly can't grab it or
      //    SIGTTIN-suspend us.
      // Without this, probing a CLI during `botmux setup` could silently
      // suspend setup (the reported "[1]+ Stopped" with no error). `-ic` is
      // kept so rc-only installs are still found.
      const argv = commandProbeArgv(sh, flags, cmd);
      const result = spawnSync(argv[0]!, argv.slice(1), {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      // Rc files may echo banners to stdout before the resolver output, so take
      // the LAST absolute line — and only after a clean exit, so a failed
      // lookup can't let an echoed path-looking line masquerade as a result.
      if (result.status !== 0) continue;
      const found = commandProbePath(result.stdout ?? '');
      if (found) return found;
    }
  }
  if (process.platform === 'darwin' && cmd === 'codex') {
    for (const candidate of macOSBundledCodexCandidates()) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return cmd;
}

/**
 * Dashboard probes use the same shells, lookup program and desktop fallback
 * as the worker, without blocking the HTTP event loop. A timeout or broken
 * shell is inconclusive, rather than evidence that a CLI is uninstalled.
 */
export async function resolveCommandAsync(
  cmd: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ resolved: string; inconclusive: boolean }> {
  if (isAbsolute(cmd)) return { resolved: cmd, inconclusive: false };
  const env = opts.env ?? process.env;
  const shells = [env.SHELL || '/bin/zsh', '/bin/zsh', '/bin/bash']
    .filter((v, i, a) => a.indexOf(v) === i);
  let inconclusive = false;
  for (const flags of ['-lc', '-ic']) {
    for (const sh of shells) {
      // detached spawn already creates a new session on POSIX. Wrapping it
      // in setsid again would fork out of the process group we reap below.
      const argv = commandProbeArgv(sh, flags, cmd, false);
      const result = await new Promise<{ stdout: string; status: number | null; failed: boolean }>(resolve => {
        const child = spawn(argv[0]!, argv.slice(1), {
          env, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
        });
        let stdout = '';
        let settled = false;
        const finish = (status: number | null, failed: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // Rc files can leave background children holding stdout open. Do not
          // wait for their pipe EOF, and reap the isolated probe process group.
          try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          child.stdout?.destroy();
          resolve({ stdout, status, failed });
        };
        const timer = setTimeout(() => finish(null, true), opts.timeoutMs ?? 5_000);
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk;
          if (stdout.length > 64 * 1024) finish(null, true);
        });
        child.once('error', (err: NodeJS.ErrnoException) => finish(null, err.code !== 'ENOENT'));
        child.once('close', status => finish(status, status === null || (status !== 0 && status !== 1 && status !== 127)));
      });
      inconclusive ||= result.failed;
      if (result.status !== 0) continue;
      const found = commandProbePath(result.stdout);
      if (found) return { resolved: found, inconclusive: false };
    }
  }
  if (process.platform === 'darwin' && cmd === 'codex') {
    for (const candidate of macOSBundledCodexCandidates(env.HOME)) {
      if (existsSync(candidate)) return { resolved: candidate, inconclusive: false };
    }
  }
  return { resolved: cmd, inconclusive };
}

/**
 * `resolveCommand` + realpath — use this for any path that will be handed to a
 * SPAWNER (a runner's `--*-bin` argv, or anything the adapter execs itself).
 *
 * WHY: `resolveCommand` returns the entry as found on PATH, which is commonly a
 * symlink — `~/.local/bin/codex` → `~/.codex/packages/standalone/current/bin/codex`
 * → a versioned release dir (two hops, and the middle `current` re-points on every
 * upgrade). The file sandbox authorizes `dirname(canonical(p))` (see worker.ts's
 * `execDirs`), so a spawn against the ORIGINAL symlink path ENOENTs inside the
 * sandbox and the second-stage process crash-loops. Canonicalizing here makes the
 * spawned path identical to the one the sandbox authorized.
 *
 * NOT needed for `resolvedBin` alone: the worker canonicalizes that itself on both
 * the authorization side and the spawn side. The bug only appears where an adapter
 * passes a path THROUGH to something else that execs it — which is why this is a
 * shared helper rather than folded into `resolveCommand` (that would also rewrite
 * the many display/probe call sites, where the user-facing PATH entry is the more
 * useful string).
 *
 * Falls back to the non-canonical path when realpath fails (binary genuinely
 * absent) so the failure surfaces as the same unmasked ENOENT as before.
 */
export function resolveCommandReal(cmd: string): string {
  const resolved = resolveCommand(cmd);
  try { return realpathSync(resolved); } catch { return resolved; }
}

/**
 * Locate an executable the way `execvp` will at spawn time: an absolute path is
 * checked directly, a bare name is searched across the current process's PATH.
 * Returns the resolved absolute path, or null when nothing runnable is found.
 *
 * Used by the worker as a pre-flight before spawning the CLI, so a missing
 * binary becomes one clear, reproducible message to the user instead of a
 * silent crash-loop. Cheap and shell-free (no rc side effects).
 */
export function locateOnPath(cmd: string): string | null {
  return locateExecutable(cmd);
}

const adapterCache = new Map<string, CliAdapter>();

/** Per-bot launch options that change WHERE an adapter's CLI keeps its data. */
export interface CliAdapterOptions {
  /**
   * CLI config profile dir (`cliConfigDir`). Claude Code only: launched with
   * `CLAUDE_CONFIG_DIR=<dir>`, and the adapter's data root, hook target,
   * `.claude.json` and MCP gateway entry all follow it. Ignored for CLIs that do
   * not support it (see `cliSupportsConfigDir`).
   */
  readonly configDir?: string;
}


/** Async adapter factory (uses dynamic import for lazy loading in daemon process). */
export async function createCliAdapter(id: CliId, pathOverride?: string, opts?: CliAdapterOptions): Promise<CliAdapter> {
  const normalized = id.toLowerCase() as CliId;
  const configDir = cliSupportsConfigDir(normalized) ? opts?.configDir : undefined;
  const key = `${normalized}:${pathOverride ?? ''}:${configDir ?? ''}`;
  if (adapterCache.has(key)) return adapterCache.get(key)!;
  const adapter = createCliAdapterSync(normalized, pathOverride, { configDir });
  adapterCache.set(key, adapter);
  return adapter;
}

export { createClaudeCodeAdapter, createSeedAdapter, createRelayAdapter, createAidenAdapter, createCocoAdapter, createCodexAdapter, createCodexAppAdapter, createCursorAdapter, createGeminiAdapter, createGeniusAdapter, createOpenCodeAdapter, createOpenCode2Adapter, createMiMoCodeAdapter, createAntigravityAdapter, createMtrAdapter, createHermesAdapter, createMiraAdapter, createMirAdapter, createTraexAdapter, createPiAdapter, createCopilotAdapter, createOhMyPiAdapter, createEbsdAdapter, createKimiAdapter, createCodemAdapter, createGrokAdapter, createKiroCliAdapter, createRiffAdapter, createReasonixAdapter, createDshAdapter, createDshTuiAdapter, createMojoAdapter, createMinimaxAdapter, createRemoteRunnerAdapter };

/** Synchronous version for use in worker process. */
export function createCliAdapterSync(id: CliId, pathOverride?: string, opts?: CliAdapterOptions): CliAdapter {
  switch (id.toLowerCase() as CliId) {
    case 'claude-code': return createClaudeCodeAdapter(pathOverride, opts?.configDir || undefined);
    case 'seed': return createSeedAdapter(pathOverride);
    case 'relay': return createRelayAdapter(pathOverride);
    case 'aiden': return createAidenAdapter(pathOverride);
    case 'coco': return createCocoAdapter(pathOverride);
    case 'codex': return createCodexAdapter(pathOverride);
    case 'codex-app': return createCodexAppAdapter(pathOverride);
    case 'cursor': return createCursorAdapter(pathOverride);
    case 'gemini': return createGeminiAdapter(pathOverride);
    case 'genius': return createGeniusAdapter(pathOverride);
    case 'opencode': return createOpenCodeAdapter(pathOverride);
    case 'opencode2': return createOpenCode2Adapter(pathOverride);
    case 'mimocode': return createMiMoCodeAdapter(pathOverride);
    case 'antigravity': return createAntigravityAdapter(pathOverride);
    case 'mtr': return createMtrAdapter(pathOverride);
    case 'hermes': return createHermesAdapter(pathOverride);
    case 'mira': return createMiraAdapter(pathOverride);
    case 'mir': return createMirAdapter(pathOverride);
    case 'traex': return createTraexAdapter(pathOverride);
    case 'pi': return createPiAdapter(pathOverride);
    case 'copilot': return createCopilotAdapter(pathOverride);
    case 'oh-my-pi': return createOhMyPiAdapter(pathOverride);
    case 'ebsd': return createEbsdAdapter(pathOverride);
    case 'kimi': return createKimiAdapter(pathOverride);
    case 'codem': return createCodemAdapter(pathOverride);
    case 'grok': return createGrokAdapter(pathOverride);
    case 'kiro-cli': return createKiroCliAdapter(pathOverride);
    case 'riff': return createRiffAdapter(pathOverride);
    case 'reasonix': return createReasonixAdapter(pathOverride);
    case 'dsh': return createDshAdapter(pathOverride);
    case 'dsh-tui': return createDshTuiAdapter(pathOverride);
    case 'mojo': return createMojoAdapter(pathOverride);
    case 'minimax': return createMinimaxAdapter(pathOverride);
    case 'remote-runner': return createRemoteRunnerAdapter(pathOverride);
    default: throw new Error(`Unknown CLI adapter: ${id}`);
  }
}

/**
 * Structured-transcript bridge capability of a CLI, WITHOUT constructing its
 * adapter. Some factories do real work up front (`createPiAdapter` /
 * `createOhMyPiAdapter` shell out through `resolveCommand`), and the worker asks
 * on every bridge tick, so this is a plain static lookup — the same specs that
 * each adapter exposes as `CliAdapter.bridgeSpec`
 * (`test/structured-bridge-spec.test.ts` pins the two together).
 *
 * hermes / mtr deliberately have none: their transcript is a SQLite store with
 * dedicated attach and ingest paths in the worker.
 */
export function bridgeSpecFor(cliId: string | undefined): StructuredBridgeSpec | undefined {
  switch (cliId) {
    case 'codex': return codexBridgeSpec;
    case 'traex': return traexBridgeSpec;
    case 'coco': return cocoBridgeSpec;
    case 'cursor': return cursorBridgeSpec;
    case 'antigravity': return antigravityBridgeSpec;
    case 'pi': return piBridgeSpec;
    case 'oh-my-pi': return ompBridgeSpec;
    case 'ebsd': return ebsdBridgeSpec;
    case 'grok': return grokBridgeSpec;
    default: return undefined;
  }
}
