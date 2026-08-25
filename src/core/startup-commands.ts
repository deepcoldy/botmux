/**
 * Startup commands — per-bot slash commands the worker types into a freshly
 * spawned CLI right after it's ready, BEFORE the user's first prompt (e.g.
 * `/effort ultracode`, `/model opus`). A narrow TraeX exception lets users
 * write `-c model_reasoning_effort="medium"` in the same field; that line is
 * consumed as a launch-time config override instead of being typed into the
 * TUI. Extracted into a leaf module so both
 * bots.json parsing ({@link ../bot-registry.js}) and the `/botconfig` config
 * store ({@link ../services/bot-config-store.js}) share one normalization
 * without a circular import.
 *
 * Unlike {@link ./passthrough-commands.js}'s customPassthroughCommands — which
 * are single-token slash commands routed through the daemon — a startup command
 * is a whole input LINE typed verbatim into the CLI's TUI, so it MAY carry
 * space-delimited arguments (`/effort ultracode`). That's why the free-text
 * parser splits on comma/newline only (never whitespace) and the per-entry
 * normalizer keeps internal spaces intact.
 */

/** Defensive cap on a single startup-command line (chars). */
const MAX_STARTUP_COMMAND_LEN = 200;

/**
 * Normalize a single startup command: collapse embedded newlines (each command
 * must submit as one line), trim, and ensure a leading `/` (so users can type
 * `effort ultracode` or `/effort ultracode`). TraeX launch config lines may
 * start with `-c` / `--config` and are preserved without a slash. Returns null
 * for empty / too-long input. Internal spaces (arguments) are preserved.
 */
export function normalizeStartupCommand(cmd: unknown): string | null {
  if (typeof cmd !== 'string') return null;
  const oneLine = cmd.replace(/[\r\n]+/g, ' ').trim();
  if (!oneLine) return null;
  if (/^(?:-c|--config)\s+/.test(oneLine)) {
    if (oneLine.length > MAX_STARTUP_COMMAND_LEN) return null;
    return oneLine;
  }
  const withSlash = oneLine.startsWith('/') ? oneLine : `/${oneLine}`;
  if (withSlash.length > MAX_STARTUP_COMMAND_LEN) return null;
  return withSlash;
}

/**
 * Parse free-text dashboard / `/botconfig` input into a normalized, order-
 * preserving, deduped startup-command list. Commands are separated by comma OR
 * newline (NOT whitespace, since a command's arguments are space-delimited).
 * Mirrors the normalization {@link ../bot-registry.js}'s parseBotConfigsFromText
 * applies when loading bots.json, so a round-trip through the card is stable.
 */
export function parseStartupCommandsInput(raw: string): string[] {
  const out: string[] = [];
  for (const tok of String(raw ?? '').split(/[,\n]+/)) {
    const norm = normalizeStartupCommand(tok);
    if (norm) out.push(norm);
  }
  return [...new Set(out)];
}

/** Normalize an array (bots.json form) of startup commands. */
export function normalizeStartupCommandList(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const entry of arr) {
    const norm = normalizeStartupCommand(entry);
    if (norm) out.push(norm);
  }
  return [...new Set(out)];
}

/**
 * Whether a spawn should (re-)run startupCommands. They run on a genuinely fresh
 * CLI process; a reattach to a LIVE persistent (tmux/zellij/herdr/zmx) pane — e.g. a
 * daemon restart recovering an existing session — is the SAME CLI with its
 * effort/model/context already established, so re-typing `/effort` (idempotent)
 * or `/clear`,`/compact` (NOT idempotent) would corrupt it. Skip on reattach.
 */
export function shouldRunStartupCommandsOnSpawn(opts: { willReattachPersistent: boolean }): boolean {
  return !opts.willReattachPersistent;
}

/**
 * Whether to defer the initial prompt from launch-args to the normal input queue
 * so startupCommands precede it. Only when commands exist AND the CLI bakes the
 * first prompt into launch args (passesInitialPromptViaArgs, e.g. Gemini `-i`):
 * an args-baked prompt would execute BEFORE flushPending's startup-command hook,
 * breaking the "before the first message" contract. Adopt never spawns fresh.
 * Default path (no startupCommands) is untouched, so args-CLIs keep their robust
 * `-i` delivery unless a bot opts in.
 */
export function shouldDeferInitialPromptForStartup(opts: {
  hasStartupCommands: boolean;
  adoptMode: boolean;
  passesInitialPromptViaArgs: boolean;
}): boolean {
  return opts.hasStartupCommands && !opts.adoptMode && opts.passesInitialPromptViaArgs;
}

export interface StartupCommandPlan {
  tuiCommands: string[];
  launchConfigArgs: string[];
}

function parseTraexLaunchConfigCommand(command: string): string[] | null {
  const match = command.trim().match(/^(?:-c|--config)\s+(.+)$/);
  if (!match) return null;
  const config = match[1]?.trim();
  if (!config || !config.startsWith('model_reasoning_effort=')) return null;
  return ['-c', config];
}

export function planStartupCommandsForCli(cliId: string | undefined, commands: readonly string[] | undefined): StartupCommandPlan {
  const tuiCommands: string[] = [];
  const launchConfigArgs: string[] = [];
  for (const command of commands ?? []) {
    if (cliId === 'traex') {
      const args = parseTraexLaunchConfigCommand(command);
      if (args) {
        launchConfigArgs.push(...args);
        continue;
      }
    }
    tuiCommands.push(command);
  }
  return { tuiCommands, launchConfigArgs };
}
