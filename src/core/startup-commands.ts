/**
 * Startup commands — per-bot slash commands the worker types into a freshly
 * spawned CLI right after it's ready, BEFORE the user's first prompt (e.g.
 * `/effort ultracode`, `/model opus`). Extracted into a leaf module so both
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
 * `effort ultracode` or `/effort ultracode`). Returns null for empty / too-long
 * input. Internal spaces (arguments) are preserved.
 */
export function normalizeStartupCommand(cmd: unknown): string | null {
  if (typeof cmd !== 'string') return null;
  const oneLine = cmd.replace(/[\r\n]+/g, ' ').trim();
  if (!oneLine) return null;
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

/**
 * Whether an args-baked initial prompt must be routed through the input queue
 * because this spawn is predicted to REATTACH a live persistent pane. A reattach
 * never executes the launch argv (tmux pipe-pane / zellij attach just rejoin the
 * running CLI), so a prompt baked only into argv would be silently dropped while
 * init still counts it as delivered. Queueing it instead types it into the live
 * CLI once it is idle — and, if the reattach fails, init fails before any ACK.
 */
export function shouldDeferInitialPromptForReattach(opts: {
  willReattachPersistent: boolean;
  adoptMode: boolean;
  passesInitialPromptViaArgs: boolean;
}): boolean {
  return opts.willReattachPersistent && !opts.adoptMode && opts.passesInitialPromptViaArgs;
}

/** How long one startup command may take to show execution evidence before the
 *  first prompt is held instead of typed behind it. A live Claude Code records
 *  `/effort` within ~1s (incident 2026-10-20: 17:46:24 typed → 17:46:25 recorded
 *  under heavy load); 20s leaves an order of magnitude for a loaded host. */
export const STARTUP_COMMAND_ACK_TIMEOUT_MS = 20_000;

/**
 * Has one typed startup command demonstrably been executed?
 *
 * Deterministic adapter evidence (Claude's transcript `<command-name>` record)
 * is authoritative when the adapter provides it. PTY evidence is weaker and
 * therefore NOT consulted for such adapters: a command whose Enter was folded
 * into a paste burst also echoes, goes quiet and leaves the prompt glyph on
 * screen — exactly the state in which typing the first prompt behind it merges
 * both into one unsubmitted composer. Adapters without a deterministic source
 * fall back to PTY evidence: output after the submit key (a CLI that is not
 * reading input yet produces none), a quiet PTY, and — if the adapter has a
 * readyPattern — the prompt back on screen.
 */
export function judgeStartupCommandAck(state: {
  /** Adapter probe result; undefined when the adapter has no deterministic source. */
  executionRecorded: boolean | undefined;
  /** Any PTY output since the command's submit key was written. */
  outputSinceSubmit: boolean;
  /** Milliseconds since the most recent PTY output. */
  quietForMs: number;
  /** readyPattern visible in the viewport; undefined when the adapter has none. */
  promptVisible: boolean | undefined;
  /** Required PTY silence before PTY evidence counts. */
  quietMs: number;
}): boolean {
  if (state.executionRecorded !== undefined) return state.executionRecorded;
  return state.outputSinceSubmit && state.quietForMs >= state.quietMs && state.promptVisible !== false;
}
