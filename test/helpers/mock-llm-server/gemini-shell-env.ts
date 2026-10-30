/**
 * Diagnostic shell fragment for the Feishu core-clis Gemini lane.
 *
 * The live run could not tell whether the per-bot `GITHUB_SHA: ''` actually
 * reached Gemini CLI's shell subprocess: an empty string that disables
 * gemini-cli's strict environment sanitization, an unset variable, and a
 * leaked non-empty runner value all look identical in the browser (no ACK).
 *
 * This fragment appends one line per shell-tool invocation to a file in the
 * CLI working directory, recording presence (`${VAR+x}` distinguishes
 * set-but-empty from unset) and value for the variables that decide routing.
 * It runs *before* the `botmux send` reply, in the same shell, so the snapshot
 * reflects exactly what the shell tool's sanitization left behind.
 *
 * Pure and fixed — the only interpolated input is the marker, gated to a
 * quoted-safe charset — so it is unit-testable.
 */

/** File the gemini shell appends snapshots to (relative to the CLI cwd '.'). */
export const GEMINI_SHELL_ENV_LOG = '.e2e-gemini-shell-env.log';

const SNAPSHOT_VARS = ['GITHUB_SHA', 'BOTMUX_SESSION_ID', 'BOTMUX_IDENTITY_BIN', 'BASH_ENV', '__OWNER_OPEN_ID'] as const;

/**
 * Shell fragment that appends one line recording each tracked variable as
 * `[epoch marker] NAME={presence:value} …`, e.g. `GITHUB_SHA={x:}` (set,
 * empty) vs `GITHUB_SHA={:}` (unset). The timestamp + marker separate retry
 * attempts. Safe to prepend to another command with `; `.
 *
 * The value half uses `${VAR-}` (not bare `${VAR}`) so an unset variable does
 * not abort the shell under `set -u` / BASH_ENV profiles that enable nounset —
 * otherwise a failed snapshot would also swallow the following `botmux send`
 * and look identical to "the CLI never submitted". Presence is still decided
 * solely by `${VAR+x}`, so the three-way distinction is unchanged.
 */
/** Markers are interpolated inside double quotes; this is the safe charset. */
const SAFE_MARKER = /^[A-Za-z0-9_\-.:#@ ]*$/;

export function buildGeminiShellEnvSnapshotFragment(marker?: string): string {
  // Defense in depth: callers get markers from regex extraction, but the
  // fragment is a shell command — refuse anything outside the quoted-safe
  // charset instead of trusting the extractor never to change.
  if (marker !== undefined && !SAFE_MARKER.test(marker)) {
    throw new Error(`refusing to build shell snapshot with unsafe marker: ${JSON.stringify(marker)}`);
  }
  const tag = marker ? ` ${marker}` : '';
  const fields = SNAPSHOT_VARS.map(
    (name) => `${name}={\${${name}+x}:\${${name}-}}`,
  ).join(' ');
  // Double quotes so the shell expands ${...}; literal braces/colon survive.
  return `printf '%s %s %s\\n' "$(date +%s)" "${tag.trim()}" "${fields}" >> ${GEMINI_SHELL_ENV_LOG}`;
}
