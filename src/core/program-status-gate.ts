import type { CliAdapter } from '../adapters/cli/types.js';
import type { ProgramStatusBlock } from '../utils/idle-detector.js';
import { compareTraexVersions, parseTraexVersion } from '../adapters/cli/traex-version.js';
import { classifyStuckPage } from '../utils/stuck-detector.js';

/** What the worker knows about this launch when it decides whether to parse
 *  OSC 7501 reports. */
export interface ProgramStatusLaunch {
  /** The daemon's probed `--version` output for the installed CLI (raw:
   *  `0.167.0`, `0.214.1\ninstallation: internal`, `unknown`). */
  cliVersion?: string;
  /** An adopted pane runs whatever process the user started; its version is
   *  not the probed install. */
  adoptMode?: boolean;
  /** A `--remote` viewer of an App Server thread: input and turn boundaries
   *  come from the JSON-RPC engine, not from this TUI. */
  remoteViewer?: boolean;
}

/** `true` when `raw` names a release at or above `min`. Unknown, unparsable
 *  and pre-releases of `min` itself count as below. */
export function cliVersionAtLeast(raw: string | undefined, min: string): boolean {
  // Both CLIs print `<name> x.y.z[-pre]`; the shared parser takes the first
  // such token (TraeX appends an `installation:` line).
  const version = raw ? parseTraexVersion(raw) : undefined;
  return version !== undefined && compareTraexVersions(version, min) >= 0;
}

/** Whether this launch mounts the OSC 7501 parser. Adapters without a
 *  verified minimum version keep their unconditional declaration; a gated one
 *  needs a probed version at or above it on a CLI this worker launched. */
export function programStatusEnabledForLaunch(
  adapter: Pick<CliAdapter, 'supportsProgramStatus' | 'programStatusMinVersion'> | null | undefined,
  launch: ProgramStatusLaunch,
): boolean {
  if (adapter?.supportsProgramStatus !== true) return false;
  const min = adapter.programStatusMinVersion;
  if (min === undefined) return true;
  if (launch.adoptMode || launch.remoteViewer) return false;
  return cliVersionAtLeast(launch.cliVersion, min);
}

/** Whether the rendered screen can stand behind an `idle` the CLI reported
 *  before botmux's first write. The report only says the CLI is not running a
 *  turn: a resumed TraeX reports it in the same burst that draws its
 *  session-lock page. So the screen must still show a prompt row and no
 *  known blocking page; the footer under the prompt is what may be unknown. */
export function startupIdleReportScreenAdmits(screen: string, readyPattern: RegExp | undefined): boolean {
  return !!screen && !!readyPattern?.test(screen) && classifyStuckPage(screen) === undefined;
}

/** Whether a reported block keeps queued input from being typed ahead (for
 *  adapters that opt in with `programStatusBlockedHoldsInput`). An approval
 *  dialog — and an auth prompt or a block of unnamed kind — would take the
 *  text and its Enter as an answer. A question is the one block the user's
 *  next message is meant to answer; holding it until the turn ends would
 *  wait on itself, so it keeps the pre-OSC behaviour. */
export function programStatusBlockHoldsTypeAhead(block: ProgramStatusBlock | null): boolean {
  return block !== null && block.kind !== 'question';
}
