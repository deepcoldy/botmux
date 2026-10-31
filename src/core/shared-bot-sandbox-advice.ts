import type { CliId } from '../adapters/cli/types.js';

/**
 * Whether a CLI is known to work under the allowlist file sandbox
 * (`sandbox: "oncall"`), from the oncall-sandbox CLI matrix
 * (scripts/oncall-cli-matrix, table in docs/file-sandbox.md). The matrix was
 * run on **Linux only**:
 *
 *   verified    — start, first turn, shell tool, workdir read/write, network,
 *                 `botmux send` relay and host-credential isolation all pass
 *                 on tmux AND pty (resume too, where the adapter resumes at all)
 *   unsupported — the CLI refuses to start under the Linux sandbox by design
 *                 (worker gate `backendSandboxCompatibilityError`). The
 *                 codex-app refusal is Linux-only: macOS/Seatbelt is not
 *                 gated and was not matrix-tested either, so it resolves to
 *                 'unverified' off Linux.
 *   (absent)    — not verified; the advice does not vouch for it
 *
 * Update together with the table whenever the matrix is re-run.
 */
export const ALLOWLIST_SANDBOX_CLI_SUPPORT: Readonly<Partial<Record<CliId, 'verified' | 'unsupported'>>> = {
  'claude-code': 'verified',
  'codex': 'verified',
  'codex-app': 'unsupported',
  'gemini': 'verified',
  'opencode': 'verified',
  'pi': 'verified',
  'oh-my-pi': 'verified',
  'grok': 'verified',
  'kimi': 'verified',
};

export type SandboxCliSupport = 'verified' | 'unsupported' | 'unverified' | 'wrapper' | 'blocked';

/** Every support state with a dedicated card/Dashboard message (presentation
 *  tests iterate this so a new state cannot ship without its i18n keys). */
export const SANDBOX_CLI_SUPPORT_STATES: readonly SandboxCliSupport[] = [
  'verified', 'unsupported', 'unverified', 'wrapper', 'blocked',
];

export function allowlistSandboxCliSupport(
  cliId: string | null | undefined,
  opts?: { platform?: NodeJS.Platform | string },
): SandboxCliSupport {
  // Object.hasOwn: cliId is unvalidated external config (bots.json) and a plain
  // record index would resolve '__proto__'/'constructor' to a built-in object.
  if (!cliId || !Object.hasOwn(ALLOWLIST_SANDBOX_CLI_SUPPORT, cliId)) return 'unverified';
  const tableValue = ALLOWLIST_SANDBOX_CLI_SUPPORT[cliId as CliId];
  // Shared with the Dashboard bundle, where `process` does not exist: the page
  // passes the daemon's host platform instead. Unknown → not Linux.
  const platform = opts?.platform ?? (typeof process === 'undefined' ? undefined : process.platform);
  if (tableValue === 'unsupported' && platform !== 'linux') return 'unverified';
  return tableValue ?? 'unverified';
}

/** CLIs verified under the allowlist sandbox, in table order. */
export function allowlistSandboxVerifiedClis(): CliId[] {
  return (Object.keys(ALLOWLIST_SANDBOX_CLI_SUPPORT) as CliId[])
    .filter(id => ALLOWLIST_SANDBOX_CLI_SUPPORT[id] === 'verified');
}

/** Why a bot counts as used by more than its owner. */
export type SharedBotReason =
  | 'oncall'
  | 'allowedChatGroups'
  | 'allowedUsers'
  | 'triggerUserAuth';

/** Presentation tests iterate this so dynamically built i18n reason keys
 *  (`...sharedSandboxReason.${reason}`) cannot silently miss a translation. */
export const SHARED_BOT_REASONS: readonly SharedBotReason[] = [
  'oncall', 'allowedChatGroups', 'allowedUsers', 'triggerUserAuth',
];

export interface SharedBotSandboxAdviceInput {
  /**
   * Effective sandbox mode of the bot ('off' | 'oncall' | 'scratch'), resolved
   * the same way the worker resolves the spawn (BOTMUX_SANDBOX env and the
   * legacy readIsolation flag folded in via resolveSandboxMode) — not the raw
   * config value.
   */
  sandboxMode: string | null | undefined;
  cliId: string | null | undefined;
  /**
   * Oncall bindings that make the bot talk-open to whole groups, EXCLUDING
   * bindings that only carry a p2pMode='group' session group's workingDir
   * (those are owner-only at the talk gate; callers filter with isSessionGroup).
   */
  oncallChatCount: number | null | undefined;
  /** `defaultOncall.enabled`: every new group auto-binds to oncall. */
  defaultOncallEnabled: boolean | null | undefined;
  /**
   * `allowedChatGroups` entries that are NOT session groups (sender-independent
   * talk-open for every group member; callers filter with isSessionGroup).
   */
  allowedChatGroupsCount: number | null | undefined;
  /** Number of RESOLVED `allowedUsers` identities (effective admins). */
  allowedUsersCount: number | null | undefined;
  triggerUserAuthEnabled: boolean | null | undefined;
  /**
   * Launcher wrapper configured (cfg.wrapperCli). Since #2548 the wrapper runs
   * INSIDE the file sandbox on local pty/tmux backends (buildsSandboxWrapperLaunch),
   * so it is not dropped — but its launch shape differs from the stock CLI the
   * matrix tested, and paths its launcher needs must be allowlisted
   * (sandboxPaths readOnly/readWrite) or the session refuses with a clear
   * preflight error. That caveat is what the "wrapper" verdict conveys. (On a
   * sandbox-incapable backend the wrapper is ignored, but that case is already
   * the "blocked" verdict above.)
   */
  wrapperCli?: string | null | undefined;
  /** Custom cliRuntime configured: the matrix only covered stock runtimes. */
  cliRuntimeConfigured?: boolean | null | undefined;
  /** Host platform; defaults to the current process. The unsupported verdict
   *  for codex-app is Linux-only. */
  platform?: NodeJS.Platform | string;
  /**
   * Whether a LOCAL file sandbox can wrap this bot's CLI at all. Callers
   * resolve it with the worker's `localSandboxApplies(backendType, mojoConfig)`:
   * false for riff / remote-runner / a provably-remote mojo session. When
   * false the advice is silenced — turning the toggle on changes nothing for a
   * CLI that executes off this host, so the recommendation would be dead.
   * Defaults to true (old daemons / callers without backend info).
   */
  localSandboxApplies?: boolean | null | undefined;
  /**
   * Whether the CURRENT backend would actually accept a file sandbox. Local is
   * not enough: herdr / zellij / zmx / orca run on this host but the worker's
   * `backendSandboxCompatibilityError` refuses to spawn under a sandbox (and a
   * local mojo without a remote proof is refused too). Callers pass
   * `backendSandboxCompatibilityError(...) === undefined`. When false the
   * advice does NOT say "verified / turn it on below" — that combination fails
   * every new session; it points the user to tmux/pty instead. Defaults to true
   * (old daemons / callers without backend info).
   */
  sandboxCapable?: boolean | null | undefined;
}

export interface SharedBotSandboxAdvice {
  reasons: SharedBotReason[];
  cliSupport: SandboxCliSupport;
}

/**
 * Advice shown on a bot that other people use while its file sandbox is off:
 * those people talk to an agent that runs as this OS user and can read the
 * host's credentials. Display only — no default and no behavior changes.
 *
 * "Shared" is a DELIBERATELY NON-EXHAUSTIVE list (plan A): oncall/default-oncall,
 * non-session allowedChatGroups, more than one resolved allowedUsers entry, or
 * trigger-user auth. Other talk-open legs (p2pOpen, per-chat/global grants, and
 * the no-allowlist "open" fall-through) are intentionally not covered yet.
 * Scratch does not count as protected: it keeps the whole disk readable.
 * null = nothing to say.
 */
export function sharedBotSandboxAdvice(input: SharedBotSandboxAdviceInput): SharedBotSandboxAdvice | null {
  // The CLI runs off this host (riff / remote-runner / provably-remote mojo):
  // the local file sandbox never wraps it, so the toggle does nothing for it.
  if (input.localSandboxApplies === false) return null;
  if (input.sandboxMode === 'oncall') return null;
  const reasons: SharedBotReason[] = [];
  if ((input.oncallChatCount ?? 0) > 0 || input.defaultOncallEnabled === true) reasons.push('oncall');
  if ((input.allowedChatGroupsCount ?? 0) > 0) reasons.push('allowedChatGroups');
  if ((input.allowedUsersCount ?? 0) > 1) reasons.push('allowedUsers');
  if (input.triggerUserAuthEnabled === true) reasons.push('triggerUserAuth');
  if (reasons.length === 0) return null;
  const base = allowlistSandboxCliSupport(input.cliId, { platform: input.platform });
  let cliSupport: SandboxCliSupport = base;
  if (base !== 'unsupported') {
    // The backend refuses to spawn under a sandbox at all (herdr / zellij /
    // zmx / orca, or a local mojo without a remote proof): telling the user the
    // CLI is "verified, turn it on below" would fail every new session. This is
    // checked before the wrapper caveat — a sandbox-blocking backend makes the
    // wrapper question moot.
    if (input.sandboxCapable === false) cliSupport = 'blocked';
    // A wrapper launcher changes the launch the matrix tested; a custom runtime
    // merely forfeits the "verified" verdict.
    else if (input.wrapperCli && input.wrapperCli.trim()) cliSupport = 'wrapper';
    else if (base === 'verified' && input.cliRuntimeConfigured === true) cliSupport = 'unverified';
  }
  return { reasons, cliSupport };
}
