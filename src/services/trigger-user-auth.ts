/**
 * Trigger-user CLI authentication policy.
 *
 * Default OFF. When a bot enables it, that bot's CLI calls out to `lark-cli` /
 * `bytedcli` run as **the person who sent the current message**, instead of
 * "whoever happens to be logged in on this machine".
 *
 * ## The rule this file encodes
 *
 * A CLI call uses the credentials of the current message's sender, or none.
 * The only permitted downgrade is "the bot's own tenant identity", which
 * belongs to nobody. Falling back to *another person's* login is never
 * allowed — not even the owner's. That is what the feature exists to remove,
 * so there is deliberately no config value that asks for it.
 *
 * Why no owner exception: the moment one exists, "whose permissions ran this?"
 * loses its single answer, and every credential lookup grows a branch. Those
 * bugs are silent — nothing errors, the audit trail just names the wrong
 * person.
 *
 * ## Why the two tools cannot share one rule
 *
 * `lark-cli` has a real non-human identity (`--as bot`, usable with zero
 * login), so most calls can degrade safely. `bytedcli` has only SSO personal
 * login — no service account, no AK/SK — so for it "unauthorized" genuinely
 * means "this command cannot run". `supportsBotIdentity` records that
 * asymmetry rather than pretending both tools behave alike.
 *
 * Whether a *particular* lark-cli command accepts `--as bot` is not decided
 * here: the CLI itself declares it (an unsupported one answers `--as bot is
 * not supported, this command only supports: user`). A hand-maintained list of
 * "commands needing a person" would go stale and grow holes.
 */

/** Tools whose credentials botmux can inject per person. */
export const TRIGGER_USER_AUTH_TOOLS = ['lark-cli', 'bytedcli'] as const;
export type TriggerUserAuthTool = typeof TRIGGER_USER_AUTH_TOOLS[number];

/**
 * What happens when the current sender has not authorized this tool.
 *
 * - `bot-identity` (default): let the tool run under the bot's own tenant
 *   identity where it can. Nothing personal is touched, nobody is interrupted.
 * - `none`: the call fails and the sender is asked to authorize.
 *
 * Note there is no `device` / `machine-login` option — see the file header.
 */
export const TRIGGER_USER_AUTH_FALLBACKS = ['bot-identity', 'none'] as const;
export type TriggerUserAuthFallback = typeof TRIGGER_USER_AUTH_FALLBACKS[number];

export interface TriggerUserAuthConfig {
  enabled: boolean;
  /** Tools this applies to. Empty means the policy is inert. */
  tools: TriggerUserAuthTool[];
  fallback: TriggerUserAuthFallback;
}

/** Per-tool facts that decide what "unauthorized" can degrade to. */
export const TRIGGER_USER_AUTH_TOOL_CAPABILITIES: Record<
  TriggerUserAuthTool,
  { supportsBotIdentity: boolean }
> = {
  // `lark-cli --as bot` works with app credentials alone.
  'lark-cli': { supportsBotIdentity: true },
  // `bytedcli auth` offers only SSO personal login.
  bytedcli: { supportsBotIdentity: false },
};

/**
 * How well the on-disk token store is actually protected for this session.
 *
 * An honest report, not a reassurance. Botmux stores each person's token as a
 * 0600 file owned by the OS user — but the agent's CLI runs as that same OS
 * user, so without the file sandbox it can simply read every token file in
 * `~/.botmux/data/`. The per-person storage still fixes attribution and the
 * overwrite bug, and the wrapper still injects only the current sender's
 * credentials; what is missing is any barrier against an agent that goes
 * looking on its own.
 *
 * With the sandbox on, the whole data dir is deny-by-default and only this
 * session's own identity file is granted — the boundary is then enforced by the
 * OS rather than by convention.
 *
 * Callers surface this so an operator can decide; it deliberately does not gate
 * the feature. Refusing to run without a sandbox would push people away from a
 * change that is an improvement either way, and claiming isolation we do not
 * have would be worse than both.
 */
export function tokenStoreProtection(sandboxEnabled: boolean): {
  enforced: boolean;
  advisory?: string;
} {
  if (sandboxEnabled) return { enforced: true };
  return {
    enforced: false,
    advisory:
      'token 文件按人隔离，但未开启文件沙盒：agent 与 botmux 跑在同一个系统用户下，'
      + '有能力直接读取 ~/.botmux/data/ 里其他人的 token 文件。'
      + '归因与覆盖问题已解决；要让隔离由操作系统强制，请为本 bot 开启 sandbox。',
  };
}

export class TriggerUserAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TriggerUserAuthConfigError';
  }
}

function isTool(value: unknown): value is TriggerUserAuthTool {
  return typeof value === 'string' && (TRIGGER_USER_AUTH_TOOLS as readonly string[]).includes(value);
}

/**
 * Parse the `triggerUserAuth` entry from `bots.json`.
 *
 * Absent / `undefined` → `null`, meaning "feature off, take no part in credential
 * resolution at all". That is different from an explicit `{enabled: false}`,
 * which also reads as off but records a deliberate choice.
 *
 * Throws on malformed input rather than silently degrading: a typo'd tool name
 * would otherwise leave the operator believing a boundary is enforced when it
 * is not, which is worse than not having the feature.
 */
export function parseTriggerUserAuthConfig(raw: unknown): TriggerUserAuthConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TriggerUserAuthConfigError('triggerUserAuth must be an object');
  }
  const rec = raw as Record<string, unknown>;

  if (rec.enabled !== undefined && typeof rec.enabled !== 'boolean') {
    throw new TriggerUserAuthConfigError('triggerUserAuth.enabled must be a boolean');
  }
  const enabled = rec.enabled === true;

  let tools: TriggerUserAuthTool[];
  if (rec.tools === undefined) {
    // Enabling without naming tools means "all of them" — the operator asked
    // for the boundary, so apply it everywhere rather than nowhere.
    tools = [...TRIGGER_USER_AUTH_TOOLS];
  } else if (Array.isArray(rec.tools)) {
    const unknownTools = rec.tools.filter(item => !isTool(item));
    if (unknownTools.length) {
      throw new TriggerUserAuthConfigError(
        `triggerUserAuth.tools has unknown entries: ${unknownTools.map(String).join(', ')}`
        + ` (supported: ${TRIGGER_USER_AUTH_TOOLS.join(', ')})`,
      );
    }
    tools = [...new Set(rec.tools as TriggerUserAuthTool[])];
  } else {
    throw new TriggerUserAuthConfigError('triggerUserAuth.tools must be an array');
  }

  let fallback: TriggerUserAuthFallback = 'bot-identity';
  if (rec.fallback !== undefined) {
    if (!(TRIGGER_USER_AUTH_FALLBACKS as readonly unknown[]).includes(rec.fallback)) {
      // Name the rejected value: an operator reaching for "device" needs to be
      // told it is refused on purpose, not left guessing at a typo.
      throw new TriggerUserAuthConfigError(
        `triggerUserAuth.fallback must be one of ${TRIGGER_USER_AUTH_FALLBACKS.join(' | ')}`
        + ` (got ${JSON.stringify(rec.fallback)}; falling back to another person's login is never available)`,
      );
    }
    fallback = rec.fallback as TriggerUserAuthFallback;
  }

  return { enabled, tools, fallback };
}

/** Whether this policy governs `tool` right now. */
export function triggerUserAuthApplies(
  config: TriggerUserAuthConfig | null | undefined,
  tool: TriggerUserAuthTool,
): boolean {
  return !!config?.enabled && config.tools.includes(tool);
}

/** How a specific tool behaves when the sender has not authorized it. */
export type UnauthorizedOutcome = 'bot-identity' | 'fail';

/**
 * Resolve what to do for `tool` when the current sender has no credentials.
 *
 * `bytedcli` reports `fail` even under `fallback: 'bot-identity'` — not a
 * config violation, just the truth that it has no non-human identity to fall
 * back to. Reporting `bot-identity` there would produce a call that fails
 * anyway, with a misleading reason.
 */
export function unauthorizedOutcomeFor(
  config: TriggerUserAuthConfig | null | undefined,
  tool: TriggerUserAuthTool,
): UnauthorizedOutcome {
  if (!triggerUserAuthApplies(config, tool)) return 'bot-identity';
  if (config!.fallback === 'none') return 'fail';
  return TRIGGER_USER_AUTH_TOOL_CAPABILITIES[tool].supportsBotIdentity ? 'bot-identity' : 'fail';
}
