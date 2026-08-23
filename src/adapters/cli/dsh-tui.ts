import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

/**
 * dsh-tui adapter — PTY-driven full-screen TUI for DeepSeek Harness.
 *
 * Unlike the headless `dsh` adapter (which spawns a JSON-RPC runner bridging
 * `dsh-jsonrpc-agent`), this adapter drives the interactive `dsh-tui` Ink TUI
 * directly through a PTY — the same interaction model as claude-code / hermes.
 *
 * The `dsh-tui` binary is a launcher that boots `dsh --profile dsh-tui`:
 *   - Positional args are the initial prompt (issue #53), but we deliberately
 *     do NOT bake the prompt into argv: the launcher treats path/URL-shaped
 *     positional args as workspace targets (DSH_TUI_WORKSPACE_TARGET), which
 *     would hijack a prompt that happens to look like a path. All prompts go
 *     through writeInput instead.
 *   - `--resume` is intercepted by the launcher (sets DSH_TUI_RESUME_SESSION
 *     from ~/.dsh-tui/resume.txt); we pass it through for session resume.
 *
 * Selection: this adapter is never chosen directly from the CLI dropdown. The
 * bot keeps cliId='dsh' + dshRuntime='tui'; the worker resolves to this
 * adapter at spawn time (see worker.ts resolveDshAdapter).
 */
export function createDshTuiAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'dsh-tui';
  let cachedBin: string | undefined;
  // The launcher spawns `dsh` as a second-stage child. Inside the file sandbox
  // /run is masked, so an nvm/fnm-installed dsh would vanish — re-expose it
  // (same pattern as the dsh adapter's dsh-jsonrpc-agent).
  let cachedDshBin: string | undefined;
  return {
    id: 'dsh-tui',
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    sandboxExtraExecPaths() {
      return [(cachedDshBin ??= resolveCommand('dsh'))];
    },

    buildArgs({ resume, resumeSessionId }) {
      const args: string[] = [];
      if (resume) {
        // Bare --resume makes the launcher read ~/.dsh-tui/resume.txt; an
        // explicit session id is passed through verbatim.
        if (resumeSessionId) args.push('--resume', resumeSessionId);
        else args.push('--resume');
      }
      return args;
    },

    buildResumeCommand() {
      // The launcher's bare --resume reads resume.txt (last session), which is
      // not botmux-session-scoped — handing it out could resume a sibling
      // bot's conversation. Return null until we track the TUI's session id.
      return null;
    },

    async writeInput(pty: PtyHandle, content: string) {
      if (pty.sendText && pty.sendSpecialKeys) {
        pty.sendText(content);
        await delay(200);
        pty.sendSpecialKeys('Enter');
      } else {
        pty.write(content);
        await delay(1000);
        pty.write('\r');
      }
    },

    // The TUI's PromptInput renders `❯ ` as the prompt char (dimmed while a
    // turn is working). It is always visible, so readyPattern alone cannot
    // gate idle — quiescence (spinner stops when the turn ends) is the real
    // completion signal, same as hermes.
    readyPattern: /❯/,
    completionPattern: undefined,
    systemHints: [],
    // The TUI's Ink startup render can swallow stdin sent before the composer
    // is mounted; hold the first prompt until ❯ appears (90s hard cap in worker).
    deferFirstPromptTimeoutUntilReady: true,
    altScreen: false,
    // ~/.dsh holds profiles + credentials + sessions; ~/.dsh-tui holds
    // resume.txt. Both must survive the file sandbox.
    authPaths: ['~/.dsh', '~/.dsh-tui'],
    // Model is NOT injected: the TUI resolves its (provider, model) route from
    // its own profile config / persisted /model choice, and the bot's model
    // field carries no provider — hardcoding deepseek-official would break
    // multi-provider setups. Users pick the model in the TUI (/model).
    modelChoices: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  };
}

export const create = createDshTuiAdapter;
