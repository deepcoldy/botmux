import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { writeRunnerInput } from './runner-input.js';

function runnerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiledSibling = resolve(here, '..', '..', 'codex-app-runner.js');
  if (existsSync(compiledSibling)) return compiledSibling;
  const builtFromSourceTree = resolve(here, '..', '..', '..', 'dist', 'codex-app-runner.js');
  if (existsSync(builtFromSourceTree)) return builtFromSourceTree;
  return compiledSibling;
}

function pushOpt(args: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  args.push(key, value);
}

export function createCodexAppAdapter(pathOverride?: string): CliAdapter {
  // Resolve the wrapped `codex` binary lazily, on first buildArgs (spawn time),
  // so constructing the adapter during `botmux setup` doesn't shell out via
  // resolveCommand. resolvedBin is the node runner, not codex itself.
  const rawCodexBin = pathOverride ?? 'codex';
  let cachedCodexBin: string | undefined;
  return {
    id: 'codex-app',
    authPaths: ['~/.codex/auth.json'],
    resolvedBin: process.execPath,

    // resolvedBin is node-running-the-runner; the REAL codex is spawned later for
    // the app-server (codex-app-runner.ts). Declare it so the file sandbox can
    // re-expose its bin dir when it lives under /run (fnm/nvm) — else --tmpfs /run
    // masks it and the in-sandbox app-server spawn ENOENTs into a crash-loop. Same
    // lazy resolve+cache as buildArgs; only an executable path, never the cwd.
    sandboxExtraExecPaths() {
      return [(cachedCodexBin ??= resolveCommand(rawCodexBin))];
    },

    buildArgs({ sessionId, resume, resumeSessionId, workingDir, botName, botOpenId, locale }) {
      const args = [
        runnerPath(),
        '--session-id', sessionId,
        '--codex-bin', (cachedCodexBin ??= resolveCommand(rawCodexBin)),
      ];
      if (resume && resumeSessionId) args.push('--thread-id', resumeSessionId);
      pushOpt(args, '--cwd', workingDir);
      pushOpt(args, '--bot-name', botName);
      pushOpt(args, '--bot-open-id', botOpenId);
      pushOpt(args, '--locale', locale);
      return args;
    },

    buildResumeCommand() {
      // Codex App threads are resumed through the app-server protocol by
      // botmux. There is not yet a stable user-facing CLI deeplink for a
      // precise desktop thread.
      return null;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // Chunked + throttled stdin injection — a single send-keys of the whole
      // (potentially ~20KB) control line overruns the pane pty input buffer and
      // gets dropped. See runner-input.ts.
      return writeRunnerInput(pty, '::botmux-codex-app:', content);
    },

    completionPattern: undefined,
    readyPattern: /›/,
    systemHints: [],
    injectsSessionContext: true,
    altScreen: false,
  };
}

export const create = createCodexAppAdapter;
