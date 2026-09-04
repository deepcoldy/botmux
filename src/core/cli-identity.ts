/**
 * Session credential handoff for trigger-user CLI authentication.
 *
 * The daemon knows who sent the current message; the CLI process does not. This
 * module is the channel between them: the daemon writes a small env-format file
 * per session, and a wrapper on `PATH` sources it just before exec'ing the real
 * tool.
 *
 * ## Why a file and not an environment variable
 *
 * A session is one long-lived CLI process (often a tmux pane). Its environment
 * is fixed by the kernel at spawn: the daemon cannot change it later, and a
 * child cannot rewrite its parent's. So env-injected credentials would freeze
 * whoever started the session — every later turn, by anyone, would keep running
 * as that first person.
 *
 * A file is re-read on every single CLI invocation, so the identity in force is
 * always the one the daemon wrote for the current turn. Switching people costs
 * nothing and never restarts the session (a restart would drop the CLI's whole
 * context, which in practice is unacceptable).
 *
 * ## Trust direction
 *
 * The daemon writes; the wrapper reads. The CLI process must never be able to
 * write these files — that would let an agent choose its own identity. They live
 * under the session's own data dir and are rewritten (not appended) each turn.
 *
 * ## Why `.env` and not JSON
 *
 * The wrapper is `/bin/sh` and runs on every invocation. `.` (source) is a shell
 * builtin; parsing JSON would mean spawning `jq` — measured at ~20ms extra per
 * call for zero benefit, since these files hold exactly a couple of opaque
 * values.
 */
import { accessSync, constants, existsSync, mkdirSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import type { TriggerUserAuthTool } from '../services/trigger-user-auth.js';

/** Where a session's identity files live, under its own data dir. */
export function sessionIdentityDir(sessionDataDir: string): string {
  return join(sessionDataDir, 'cli-identity');
}

/**
 * Identity file for one tool in one session.
 *
 * Named by session id so concurrent sessions of the same bot — different people
 * in different chats — never read each other's credentials.
 */
export function sessionIdentityPath(
  sessionDataDir: string,
  sessionId: string,
  tool: TriggerUserAuthTool,
): string {
  return join(sessionIdentityDir(sessionDataDir), `${assertSafeSegment(sessionId)}.${tool}.env`);
}

/** Session ids reach here from IPC; they are concatenated into a path, so a
 *  `../` shaped id must not be able to redirect a credential write. */
function assertSafeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(value) || /^\.+$/.test(value)) {
    throw new Error(`[cli-identity] unsafe session id used as path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Env vars each tool reads to act as a specific person.
 *
 * `lark-cli` needs the app id alongside the token: given only
 * `LARKSUITE_CLI_USER_ACCESS_TOKEN` it refuses outright with `blocked by env:
 * LARKSUITE_CLI_USER_ACCESS_TOKEN is set but LARKSUITE_CLI_APP_ID is missing`.
 *
 * Note we do NOT use `LARKSUITE_CLI_CONFIG_DIR`: lark-cli keeps tokens under
 * `~/Library/Application Support/lark-cli/<appId>_<openId>.enc`, which does not
 * move with that variable — pointing it elsewhere isolates config but not
 * credentials. Injecting the token directly also sidesteps the macOS Keychain
 * (whose master key a sandboxed process cannot read).
 */
export const IDENTITY_ENV_KEYS: Record<TriggerUserAuthTool, readonly string[]> = {
  'lark-cli': ['LARKSUITE_CLI_APP_ID', 'LARKSUITE_CLI_USER_ACCESS_TOKEN'],
  // ByteCloud JWT and the Codebase JWT derived from it. The latter is what git
  // pushes authenticate with, so attribution of a commit follows from it.
  bytedcli: ['BYTEDCLI_USER_CLOUD_JWT', 'BYTEDCLI_USER_CODE_JWT'],
};

export interface LarkCliIdentity {
  tool: 'lark-cli';
  appId: string;
  userAccessToken: string;
}

export interface BytedCliIdentity {
  tool: 'bytedcli';
  cloudJwt: string;
  /** Optional: only present once a Codebase JWT has been minted for this person. */
  codeJwt?: string;
}

export type CliIdentity = LarkCliIdentity | BytedCliIdentity;

/**
 * Values must survive `.` (source) in `/bin/sh` unchanged.
 *
 * A single-quoted shell word is fully literal apart from the quote itself, so
 * escaping `'` is the whole job. Newlines and `$` are safe inside it. We reject
 * rather than sanitize: a credential we had to alter to make safe is a
 * credential that will not work, and a silent truncation would surface much
 * later as a baffling auth failure.
 */
function shellSingleQuote(value: string): string {
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new Error('[cli-identity] credential value contains a line break or NUL');
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Render the `.env` body a wrapper will source. */
export function renderIdentityEnv(identity: CliIdentity): string {
  const pairs: Array<[string, string]> = identity.tool === 'lark-cli'
    ? [
        ['LARKSUITE_CLI_APP_ID', identity.appId],
        ['LARKSUITE_CLI_USER_ACCESS_TOKEN', identity.userAccessToken],
      ]
    : [
        ['BYTEDCLI_USER_CLOUD_JWT', identity.cloudJwt],
        ...(identity.codeJwt ? [['BYTEDCLI_USER_CODE_JWT', identity.codeJwt] as [string, string]] : []),
      ];
  const header = '# botmux trigger-user identity — rewritten each turn, do not edit\n';
  return header + pairs.map(([k, v]) => `${k}=${shellSingleQuote(v)}`).join('\n') + '\n';
}

/**
 * Publish the identity in force for this turn.
 *
 * 0600 because the file holds a live token, and the containing dir is 0700.
 * Written atomically: a CLI invocation that lands mid-write must read either the
 * previous identity or the new one, never a half-written token that would fail
 * with a confusing error.
 */
export function writeSessionIdentity(
  sessionDataDir: string,
  sessionId: string,
  identity: CliIdentity,
): string {
  const path = sessionIdentityPath(sessionDataDir, sessionId, identity.tool);
  mkdirSync(sessionIdentityDir(sessionDataDir), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, renderIdentityEnv(identity), { mode: 0o600 });
  return path;
}

/**
 * Remove the identity for one tool.
 *
 * Called when the current sender has no credentials: the file must GO, not go
 * stale. Leaving the previous person's token in place is precisely the failure
 * this feature exists to prevent — the next command would run as them, silently
 * and with the wrong name in the audit trail.
 */
export function clearSessionIdentity(
  sessionDataDir: string,
  sessionId: string,
  tool: TriggerUserAuthTool,
): void {
  try { rmSync(sessionIdentityPath(sessionDataDir, sessionId, tool), { force: true }); }
  catch { /* best-effort: absence is the desired state */ }
}

/** Drop every identity for a session (teardown). */
export function clearAllSessionIdentities(sessionDataDir: string, sessionId: string): void {
  for (const tool of Object.keys(IDENTITY_ENV_KEYS) as TriggerUserAuthTool[]) {
    clearSessionIdentity(sessionDataDir, sessionId, tool);
  }
}

/**
 * The wrapper script for one tool.
 *
 * Design constraints, each learned the hard way elsewhere in this codebase:
 *
 *  - `exec` so signals and the exit code pass straight through.
 *  - Absolute path to the real binary: the wrapper shadows the tool's own name
 *    on `PATH`, so resolving by name again would re-enter this script forever.
 *  - `BOTMUX_SESSION_ID` / `SESSION_DATA_DIR` come from the session env the
 *    worker already injects; the wrapper is identical for every session, so
 *    nothing needs rewriting when sessions come and go.
 *  - Missing identity file is NOT an error here. Under `fallback: bot-identity`
 *    the tool is meant to run as the bot, and lark-cli does that with no env at
 *    all. Failing closed is the daemon's decision (it withholds the file and
 *    tells the sender to authorize), not the wrapper's.
 */
export function renderIdentityWrapper(tool: TriggerUserAuthTool, realBinaryPath: string): string {
  return [
    '#!/bin/sh',
    '# botmux trigger-user identity wrapper — generated, do not edit.',
    '# Sources the identity the daemon published for the CURRENT turn, then execs',
    '# the real tool. Re-read on every invocation, which is what lets the acting',
    '# identity change without restarting the session.',
    'if [ -n "$SESSION_DATA_DIR" ] && [ -n "$BOTMUX_SESSION_ID" ]; then',
    `  __botmux_cred="$SESSION_DATA_DIR/cli-identity/$BOTMUX_SESSION_ID.${tool}.env"`,
    '  if [ -f "$__botmux_cred" ]; then',
    '    . "$__botmux_cred"',
    `    export ${IDENTITY_ENV_KEYS[tool].join(' ')}`,
    '  fi',
    '  unset __botmux_cred',
    'fi',
    `exec ${shellSingleQuote(realBinaryPath)} "$@"`,
    '',
  ].join('\n');
}

/** Whether the wrapper for `tool` is currently installed in `binDir`. */
export function identityWrapperInstalled(binDir: string, tool: TriggerUserAuthTool): boolean {
  return existsSync(join(binDir, tool));
}

/**
 * Where a session's identity wrappers live.
 *
 * Deliberately NOT the shared `~/.botmux/bin`: a wrapper there would shadow
 * `lark-cli` for every bot on the machine, including ones that never enabled
 * this feature — and for the operator's own shell too, since that dir is on
 * their PATH. Keeping it per session means the shadowing is exactly as narrow
 * as the policy that asked for it.
 */
export function sessionIdentityBinDir(sessionDataDir: string, sessionId: string): string {
  return join(sessionIdentityDir(sessionDataDir), `${assertSafeSegment(sessionId)}.bin`);
}

/**
 * Install the wrapper for `tool` into `binDir`.
 *
 * `binDir` must be prepended to the session PATH by the caller, so the wrapper
 * shadows the tool for that session only.
 *
 * Returns the wrapper path, or null when the real tool is not installed (nothing
 * to wrap, and a wrapper pointing at a missing binary would turn "tool not
 * installed" into a confusing wrapper error).
 */
export function installIdentityWrapper(
  binDir: string,
  tool: TriggerUserAuthTool,
  realBinaryPath: string | null | undefined,
): string | null {
  if (!realBinaryPath) return null;
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, tool);
  atomicWriteFileSync(path, renderIdentityWrapper(tool, realBinaryPath), { mode: 0o755 });
  return path;
}

/**
 * Locate the real tool binary, skipping any botmux wrapper.
 *
 * `which` would happily return our own wrapper once it is on PATH, producing a
 * script that execs itself forever. Scanning the caller-supplied PATH while
 * excluding the wrapper dir keeps that impossible by construction.
 */
export function findRealToolBinary(
  tool: TriggerUserAuthTool,
  pathValue: string | undefined,
  excludeDirs: readonly string[] = [],
): string | null {
  const excluded = new Set(excludeDirs.filter(Boolean));
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir || excluded.has(dir)) continue;
    const candidate = join(dir, tool);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not here, keep looking */ }
  }
  return null;
}
