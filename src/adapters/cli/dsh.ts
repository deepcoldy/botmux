import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { writeRunnerInput } from './runner-input.js';

/**
 * Resolve the dsh binary to its REAL (symlink-followed) path.
 *
 * `resolveCommand` returns the raw entry as found on PATH — which is commonly a
 * symlink (e.g. `~/.local/bin/dsh-jsonrpc-agent` → the SDK's package dir), and
 * the user's HOME may itself be a symlink (`/home/x` → `/data00/home/x`). The
 * file sandbox only exposes the CANONICAL target dir read-only (worker.ts maps
 * exec paths through `dirname(canonical(p))`), so a spawn against the original
 * symlink path ENOENTs inside the sandbox. Canonicalizing here makes the path we
 * hand the runner (`--dsh-bin`) identical to the one the sandbox authorized, so
 * the in-sandbox spawn resolves. Falls back to the raw path if realpath fails
 * (binary genuinely absent — surfaces the same ENOENT as before, unmasked).
 */
function realResolveCommand(cmd: string): string {
  const resolved = resolveCommand(cmd);
  try { return realpathSync(resolved); } catch { return resolved; }
}

function runnerPath(): string {
  // Source-level worker integration tests execute through tsx and need the
  // matching source runner rather than a possibly absent/stale ignored dist
  // tree. Keep the override strictly test-scoped so production launch
  // resolution remains canonical and cannot be redirected by ambient env.
  const testOverride = process.env.NODE_ENV === 'test'
    ? process.env.BOTMUX_TEST_DSH_RUNNER_PATH
    : undefined;
  if (testOverride) return resolve(testOverride);
  const here = dirname(fileURLToPath(import.meta.url));
  const compiledSibling = resolve(here, '..', '..', 'dsh-runner.js');
  if (existsSync(compiledSibling)) return compiledSibling;
  const builtFromSourceTree = resolve(here, '..', '..', '..', 'dist', 'dsh-runner.js');
  if (existsSync(builtFromSourceTree)) return builtFromSourceTree;
  return compiledSibling;
}

function pushOpt(args: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  args.push(key, value);
}

export function createDshAdapter(pathOverride?: string): CliAdapter {
  // Resolve the wrapped `dsh-jsonrpc-agent` binary lazily, on first buildArgs
  // (spawn time), so constructing the adapter during `botmux setup` doesn't
  // shell out via resolveCommand. resolvedBin is the node runner, not dsh
  // itself.
  const rawDshBin = pathOverride ?? 'dsh-jsonrpc-agent';
  let cachedDshBin: string | undefined;
  return {
    id: 'dsh',
    // The runner reads ~/.dsh/settings.yaml + .credentials.yaml and writes
    // its generated composition + sessions under ~/.dsh/botmux/ and
    // ~/.dsh/sessions/botmux/. Keep the whole native dsh home REAL under the
    // file sandbox so both survive (see adapters CLAUDE.md sandbox notes).
    // Pre-created in buildArgs so the sandbox's keepExisting filter doesn't
    // drop it.
    authPaths: ['~/.dsh'],
    resolvedBin: process.execPath,

    // resolvedBin is node-running-the-runner; the real dsh runtime is spawned
    // by the runner. Declare its CANONICAL path so the file sandbox re-exposes
    // its bin dir when it lives under /run (fnm/nvm) — else --tmpfs /run masks
    // it and the in-sandbox spawn ENOENTs into a crash-loop. Must match the
    // path handed to --dsh-bin below (both canonical via realResolveCommand) so
    // the authorized dir and the spawned path agree. Same lazy resolve+cache as
    // buildArgs; only an executable path, never the cwd.
    sandboxExtraExecPaths() {
      return [(cachedDshBin ??= realResolveCommand(rawDshBin))];
    },

    buildArgs({ sessionId, workingDir, botName, botOpenId, locale, model, turnTimeoutMs }) {
      // Pre-create the native dsh home + botmux subdirs in the real HOME
      // before the worker enters the sandbox: the sandbox's keepExisting
      // filter drops authPaths that don't exist yet, and the runner can't
      // create them from inside.
      const dshHome = join(homedir(), '.dsh');
      mkdirSync(dshHome, { recursive: true });
      mkdirSync(join(dshHome, 'botmux'), { recursive: true });
      mkdirSync(join(dshHome, 'sessions', 'botmux'), { recursive: true });
      const args = [
        runnerPath(),
        '--session-id', sessionId,
        '--dsh-bin', (cachedDshBin ??= realResolveCommand(rawDshBin)),
      ];
      pushOpt(args, '--cwd', workingDir);
      pushOpt(args, '--bot-name', botName);
      pushOpt(args, '--bot-open-id', botOpenId);
      pushOpt(args, '--locale', locale);
      pushOpt(args, '--model', model && model.trim() ? model.trim() : undefined);
      // Per-bot turn timeout override; undefined → runner default (10 min).
      pushOpt(args, '--turn-timeout-ms', typeof turnTimeoutMs === 'number' && turnTimeoutMs > 0
        ? String(turnTimeoutMs)
        : undefined);
      return args;
    },

    buildResumeCommand() {
      // dsh sessions live inside the runner's JSON-RPC connection; there is no
      // stable user-facing CLI deeplink to resume one.
      return null;
    },

    async writeInput(pty: PtyHandle, content: string, context) {
      // Chunked + throttled stdin injection — a single send-keys of the whole
      // (potentially large) control line overruns the pane pty input buffer.
      // See runner-input.ts.
      return writeRunnerInput(pty, '::botmux-dsh:', content, undefined, context?.turnId);
    },

    supportsTypeAhead: false,
    completionPattern: undefined,
    readyPattern: /›/,
    // The runner only attaches its stdin listener after the JSON-RPC handshake
    // (up to 30s). Without this, the worker's 15s soft timeout would flush the
    // first prompt into an un-drained PTY and risk a dirty_unknown generation.
    deferFirstPromptTimeoutUntilReady: true,
    systemHints: [],
    injectsSessionContext: true,
    altScreen: false,
    modelChoices: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  };
}

export const create = createDshAdapter;
