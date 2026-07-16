/**
 * Single source of truth for which CliIds use the structured transcript
 * bridge (CodexBridgeQueue path in the worker).
 *
 * Split intentionally:
 *   - ALWAYS: harvested whenever the CLI is botmux-spawned (or adopted)
 *   - CURSOR: adopt-only — botmux-spawned cursor replies via `botmux send`,
 *     so the transcript bridge stays off outside adopt mode
 *
 * File-path resolution for JSONL-style bridges lives in
 * `resolveFileBridgePath` (same module family, worker-facing). Hermes/MTR
 * use SQLite drivers and are NOT in the file-path helper — they stay on
 * their dedicated attach paths. Full driver-table platformization is a
 * follow-up; this file only collapses the OR-list tax.
 */
import type { CliId } from '../adapters/cli/types.js';

/** Always-on structured-bridge CLIs (including SQLite-backed hermes/mtr). */
export const STRUCTURED_BRIDGE_ALWAYS_CLI_IDS = [
  'codex',
  'traex',
  'coco',
  'hermes',
  'mtr',
  'pi',
  'grok',
] as const satisfies readonly CliId[];

/** Adopt must forward pid/cwd/cliSessionId for these (CLIs whose worker
 *  adopt branch consumes them, plus cursor's store.db fd probe).
 *
 *  hermes is deliberately NOT here despite being ALWAYS: it has no adopt
 *  transcript branch (its bridge attaches via the timer's dedicated hermes
 *  path), and forwarding adoptCliPid would silently switch its tmux adopt
 *  from pane-only to pid liveness (TmuxPipeBackend.watchCliPid polls the
 *  pid and detaches on exit) — a behavior change that belongs to the
 *  driver-table follow-up, not this convergence PR. Matches the historical
 *  worker-pool allowlist. */
export const STRUCTURED_BRIDGE_ADOPT_CLI_IDS = [
  'codex',
  'traex',
  'coco',
  'mtr',
  'pi',
  'grok',
  'cursor',
] as const satisfies readonly CliId[];

const ALWAYS_SET: ReadonlySet<string> = new Set(STRUCTURED_BRIDGE_ALWAYS_CLI_IDS);
const ADOPT_SET: ReadonlySet<string> = new Set(STRUCTURED_BRIDGE_ADOPT_CLI_IDS);

/** Worker `codexBridgeFallbackActive` — cursor only when adoptMode. */
export function isStructuredBridgeFallbackActive(
  cliId: string | undefined,
  adoptMode?: boolean,
): boolean {
  if (!cliId) return false;
  if (ALWAYS_SET.has(cliId)) return true;
  if (cliId === 'cursor') return adoptMode === true;
  return false;
}

/** Daemon adopt path — forward transcript bind fields. */
export function isStructuredBridgeAdoptCli(cliId: string | undefined): boolean {
  return !!cliId && ADOPT_SET.has(cliId);
}

/**
 * Idle-adapter / adopt input-adapter: CLIs whose adapter should be used for
 * idle detection / writeInput during adopt (excludes cursor's special baseline
 * path and hermes which uses its own attach). Matches historical
 * `adoptIdleAdapter` allowlist: codex/traex/coco/mtr/pi/grok.
 */
export const STRUCTURED_BRIDGE_ADOPT_IDLE_CLI_IDS = [
  'codex',
  'traex',
  'coco',
  'mtr',
  'pi',
  'grok',
] as const satisfies readonly CliId[];

const ADOPT_IDLE_SET: ReadonlySet<string> = new Set(STRUCTURED_BRIDGE_ADOPT_IDLE_CLI_IDS);

export function isStructuredBridgeAdoptIdleCli(cliId: string | undefined): boolean {
  return !!cliId && ADOPT_IDLE_SET.has(cliId);
}

/** Adopt input adapter: needs writeInput for local pane typing. */
export const STRUCTURED_BRIDGE_ADOPT_INPUT_CLI_IDS = [
  'codex',
  'traex',
  'pi',
  'grok',
  'mtr',
] as const satisfies readonly CliId[];

const ADOPT_INPUT_SET: ReadonlySet<string> = new Set(STRUCTURED_BRIDGE_ADOPT_INPUT_CLI_IDS);

export function isStructuredBridgeAdoptInputCli(cliId: string | undefined): boolean {
  return !!cliId && ADOPT_INPUT_SET.has(cliId);
}
