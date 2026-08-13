import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { writeRunnerInput } from './runner-input.js';

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
    // Session JSONL lives here; keep it REAL under the file sandbox so
    // history persists across sessions (see adapters CLAUDE.md sandbox notes).
    authPaths: ['~/.botmux/dsh-sessions'],
    resolvedBin: process.execPath,

    // resolvedBin is node-running-the-runner; the real dsh runtime is spawned
    // by the runner. Declare it so the file sandbox can re-expose its bin dir
    // when it lives under /run (fnm/nvm) — else --tmpfs /run masks it and the
    // in-sandbox spawn ENOENTs into a crash-loop. Same lazy resolve+cache as
    // buildArgs; only an executable path, never the cwd.
    sandboxExtraExecPaths() {
      return [(cachedDshBin ??= resolveCommand(rawDshBin))];
    },

    buildArgs({ sessionId, workingDir, botName, botOpenId, locale, model }) {
      const args = [
        runnerPath(),
        '--session-id', sessionId,
        '--dsh-bin', (cachedDshBin ??= resolveCommand(rawDshBin)),
      ];
      pushOpt(args, '--cwd', workingDir);
      pushOpt(args, '--bot-name', botName);
      pushOpt(args, '--bot-open-id', botOpenId);
      pushOpt(args, '--locale', locale);
      pushOpt(args, '--model', model && model.trim() ? model.trim() : undefined);
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
