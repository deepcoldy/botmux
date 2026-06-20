import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CliAdapter, PtyHandle } from './types.js';
import { writeRunnerInput } from './runner-input.js';
import { resolveCommand } from './registry.js';

/**
 * Mir CLI (mircli) adapter — drives the local `mircli` in non-interactive Print
 * Mode through a small Node runner (src/mir-runner.ts), mirroring the `mira`
 * (Mira App / Web API) adapter's runner shape. See mir-runner.ts for why Print
 * Mode (`mircli -p --lean`) is used instead of driving the interactive TUI.
 *
 * Distinct from the `mira` adapter:
 *   - `mira` → Mira Web API (cloud orchestration + remote sandbox; chat/search).
 *   - `mir`  → local `mircli` (executes on this machine, operates the workspace;
 *              requires the user's local MCP bridge connected, like mircli).
 *
 * Delivery is the runner's stdout (OSC `final` markers parsed by the worker —
 * `mir` is in APP_RUNNER_OSC_CLI_IDS), so it needs neither `botmux send` nor a
 * BOTMUX_SESSION_ID. Conversation continuity across turns / resume is handled by
 * mircli itself via `--session-id` (the runner passes botmux's session id).
 */

function runnerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiledSibling = resolve(here, '..', '..', 'mir-runner.js');
  if (existsSync(compiledSibling)) return compiledSibling;
  const builtFromSourceTree = resolve(here, '..', '..', '..', 'dist', 'mir-runner.js');
  if (existsSync(builtFromSourceTree)) return builtFromSourceTree;
  return compiledSibling;
}

function pushOpt(args: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  args.push(key, value);
}

export function createMirAdapter(pathOverride?: string): CliAdapter {
  // A configured cliPathOverride is the mircli binary the runner should spawn
  // (resolvedBin is the node runner itself). Resolve a bare name to an absolute
  // path and hand it to the runner via --mircli-bin; the runner falls back to
  // MIRCLI_BIN / `mircli` on PATH when unset.
  let cachedMircliBin: string | undefined;
  const mircliBin = (): string | undefined => {
    if (!pathOverride || !pathOverride.trim()) return undefined;
    return (cachedMircliBin ??= resolveCommand(pathOverride.trim()));
  };
  return {
    id: 'mir',
    resolvedBin: process.execPath,

    buildArgs({ sessionId, botName, botOpenId, locale }) {
      const args = [runnerPath(), '--session-id', sessionId];
      pushOpt(args, '--bot-name', botName);
      pushOpt(args, '--bot-open-id', botOpenId);
      pushOpt(args, '--locale', locale);
      pushOpt(args, '--mircli-bin', mircliBin());
      return args;
    },

    // The conversation lives in mircli's own per-session store (`--session-id`);
    // botmux re-spawns the runner with the same id to continue. There's no
    // portable copy-paste resume command for the user's own terminal.
    buildResumeCommand() {
      return null;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // Chunked + throttled stdin injection (see runner-input.ts) — same path
      // the mira / codex-app runners use.
      return writeRunnerInput(pty, '::botmux-mir:', content);
    },

    completionPattern: undefined,
    // The runner prints `› ` as its ready prompt between turns.
    readyPattern: /›/,
    systemHints: [],
    // The runner injects its own local-runtime context; botmux skips appending
    // routing/identity + session id to every message.
    injectsSessionContext: true,
    altScreen: false,
  };
}

export const create = createMirAdapter;
