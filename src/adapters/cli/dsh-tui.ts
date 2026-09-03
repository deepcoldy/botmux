import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureDshQuestionBridgePatch, type DshQuestionBridgePatch } from '../dsh-question-bridge.js';

function configuredDshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
}

function dshAuthPaths(): string[] {
  const configured = process.env.DSH_HOME?.trim();
  return configured ? ['~/.dsh', configured, '~/.dsh-tui'] : ['~/.dsh', '~/.dsh-tui'];
}

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

function sendBracketedPaste(pty: PtyHandle, content: string): boolean {
  const framed = `${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}`;
  if (pty.sendText) return pty.sendText(framed) !== false;
  return pty.write(framed) !== false;
}

/**
 * dsh-tui adapter — PTY-driven full-screen TUI for DeepSeek Harness.
 *
 * Unlike the headless `dsh` adapter (which spawns a JSON-RPC runner bridging
 * `dsh --profile <name>`), this adapter drives the interactive `dsh-tui` Ink TUI
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
  let cachedBridge: DshQuestionBridgePatch | null | undefined;
  const bridgePatch = () => (cachedBridge ??= ensureDshQuestionBridgePatch({ cliId: 'dsh-tui' }));
  // The launcher spawns `dsh` as a second-stage child. Inside the file sandbox
  // /run is masked, so an nvm/fnm-installed dsh would vanish — re-expose it
  // (same pattern as the dsh adapter's dsh binary).
  let cachedDshBin: string | undefined;
  return {
    id: 'dsh-tui',
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    sandboxExtraExecPaths() {
      return [(cachedDshBin ??= resolveCommand('dsh'))];
    },

    sandboxReadonlyPaths() {
      const bridge = bridgePatch();
      return bridge ? [bridge.readonlyRoot] : [];
    },

    buildArgs({ resume, resumeSessionId }) {
      // Pre-create the authPaths in the real HOME before the worker enters the
      // sandbox: the sandbox's keepExisting filter drops authPaths that don't
      // exist yet, and the TUI can't create them from inside. ~/.dsh-tui holds
      // resume.txt — without this, sandbox:true would silently break cross-
      // session resume (same pattern as the dsh adapter's mkdirSync).
      const home = homedir();
      const activeDshHome = configuredDshHome();
      mkdirSync(join(home, '.dsh'), { recursive: true });
      mkdirSync(activeDshHome, { recursive: true });
      mkdirSync(join(activeDshHome, 'profiles'), { recursive: true });
      mkdirSync(join(home, '.dsh-tui'), { recursive: true });
      const args: string[] = [];
      const bridge = bridgePatch();
      // dsh-tui's launcher treats a split `--patch /abs/path` value as a
      // workspace target. Keep the DSH overlay as one token so it reaches
      // `dsh --profile dsh-tui` intact.
      if (bridge) args.push(`--patch=${bridge.patchPath}`);
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
      // dsh-tui's Ink PromptInput treats ordinary newlines as submit keys.
      // Botmux prompts are often multiline, so inject them as bracketed paste
      // and press Enter exactly once after the whole draft is in the composer.
      try {
        // Emit the markers ourselves instead of relying on backend pasteText():
        // tmux/zellij wrap pasteText correctly, but herdr's pasteText is only a
        // literal write. One explicit wire format keeps every backend equivalent.
        const pasted = sendBracketedPaste(pty, content);
        if (!pasted) return { submitted: false };

        if (pty.sendSpecialKeys) {
          await delay(200);
          const submitted = pty.sendSpecialKeys('Enter');
          if (submitted === false) return { submitted: false };
        } else {
          await delay(1000);
          const submitted = pty.write('\r');
          if (submitted === false) return { submitted: false };
        }
      } catch {
        return { submitted: false };
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
    get authPaths(): string[] { return dshAuthPaths(); },
    // Model is NOT injected: the TUI resolves its (provider, model) route from
    // its own profile config / persisted /model choice, and the bot's model
    // field carries no provider — hardcoding deepseek-official would break
    // multi-provider setups. Users pick the model in the TUI (/model).
    modelChoices: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  };
}

export const create = createDshTuiAdapter;
