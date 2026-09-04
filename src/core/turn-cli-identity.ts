/**
 * Per-turn publication of the acting CLI identity.
 *
 * This is where the three pieces meet: the bot's {@link TriggerUserAuthConfig}
 * policy, the per-person token store, and the session identity file a wrapper
 * sources. It runs once per turn, just before the turn reaches the CLI.
 *
 * The single rule it enforces: **the credentials published for a turn belong to
 * the person who sent that turn, or nothing is published.** There is no path
 * here that reads another person's token — the sender's open_id is the only key
 * ever used, and when it yields nothing the previous file is DELETED rather than
 * left in place. A stale file would mean the next command silently runs as the
 * previous person, which is the exact failure the feature exists to remove.
 */
import { logger } from '../utils/logger.js';
import { resolveUserToken } from '../utils/user-token.js';
import { normalizeBrand } from '../im/lark/lark-hosts.js';
import type { BotConfig } from '../bot-registry.js';
import {
  triggerUserAuthApplies,
  unauthorizedOutcomeFor,
  TRIGGER_USER_AUTH_TOOLS,
  type TriggerUserAuthTool,
} from '../services/trigger-user-auth.js';
import {
  writeSessionIdentity,
  clearSessionIdentity,
  type CliIdentity,
} from './cli-identity.js';

/** What was published for one tool this turn — drives the user-visible notice. */
export interface ToolIdentityOutcome {
  tool: TriggerUserAuthTool;
  /**
   * - `user`: the sender's own credentials are in force.
   * - `bot-identity`: nothing published; the tool runs as the bot where it can.
   * - `needs-authorization`: nothing published AND the tool cannot degrade —
   *   the sender must authorize before it will work.
   * - `off`: the policy does not govern this tool; nothing was touched.
   */
  state: 'user' | 'bot-identity' | 'needs-authorization' | 'off';
}

export interface PublishTurnIdentityArgs {
  botConfig: BotConfig;
  sessionDataDir: string;
  sessionId: string;
  /** The person who sent THIS turn. Absent for turns with no human sender. */
  senderOpenId: string | undefined;
}

/**
 * Publish (or withhold) each governed tool's identity for the current turn.
 *
 * Never throws: a credential-publication failure must not take down the turn.
 * The worst case is a withheld identity, which the tool reports as an auth error
 * and the agent can act on.
 */
export async function publishTurnCliIdentity(
  args: PublishTurnIdentityArgs,
): Promise<ToolIdentityOutcome[]> {
  const { botConfig, sessionDataDir, sessionId, senderOpenId } = args;
  const policy = botConfig.triggerUserAuth;
  const outcomes: ToolIdentityOutcome[] = [];

  for (const tool of TRIGGER_USER_AUTH_TOOLS) {
    if (!triggerUserAuthApplies(policy, tool)) {
      outcomes.push({ tool, state: 'off' });
      continue;
    }
    try {
      outcomes.push(await publishOne(tool, botConfig, sessionDataDir, sessionId, senderOpenId));
    } catch (e) {
      // Fail closed: withhold rather than risk leaving a previous identity in
      // place. Withholding degrades to the bot identity (or a clear auth error);
      // a stale file would run as the wrong person with no signal at all.
      clearSessionIdentity(sessionDataDir, sessionId, tool);
      logger.warn(
        `[trigger-user-auth] withheld ${tool} identity for session ${sessionId}: `
        + `${e instanceof Error ? e.message : String(e)}`,
      );
      outcomes.push({ tool, state: unauthorizedOutcomeFor(policy, tool) === 'fail' ? 'needs-authorization' : 'bot-identity' });
    }
  }
  return outcomes;
}

async function publishOne(
  tool: TriggerUserAuthTool,
  botConfig: BotConfig,
  sessionDataDir: string,
  sessionId: string,
  senderOpenId: string | undefined,
): Promise<ToolIdentityOutcome> {
  const withheld = (): ToolIdentityOutcome => {
    clearSessionIdentity(sessionDataDir, sessionId, tool);
    return {
      tool,
      state: unauthorizedOutcomeFor(botConfig.triggerUserAuth, tool) === 'fail'
        ? 'needs-authorization'
        : 'bot-identity',
    };
  };

  // No human sender (scheduled run, hook, meeting event, bot-to-bot handoff):
  // there is no "trigger user" to act as. Withhold — never reach for the session
  // creator's or the owner's credentials to fill the gap.
  if (!senderOpenId) return withheld();

  const identity = await resolveIdentityFor(tool, botConfig, senderOpenId);
  if (!identity) return withheld();

  writeSessionIdentity(sessionDataDir, sessionId, identity);
  return { tool, state: 'user' };
}

async function resolveIdentityFor(
  tool: TriggerUserAuthTool,
  botConfig: BotConfig,
  senderOpenId: string,
): Promise<CliIdentity | null> {
  if (tool === 'lark-cli') {
    if (!botConfig.larkAppId || !botConfig.larkAppSecret) return null;
    const token = await resolveUserToken(
      botConfig.larkAppId,
      botConfig.larkAppSecret,
      normalizeBrand(botConfig.brand),
      senderOpenId,
    );
    if (!token) return null;
    // The app id travels with the token: lark-cli refuses a token without it
    // ("blocked by env: …USER_ACCESS_TOKEN is set but …APP_ID is missing").
    return { tool: 'lark-cli', appId: botConfig.larkAppId, userAccessToken: token };
  }

  // bytedcli authenticates against ByteCloud SSO, a different provider from
  // Lark OAuth — a Lark user token is not convertible into a ByteCloud JWT, so
  // there is nothing to derive here. Per-person bytedcli credentials arrive
  // through its own device flow (`auth login --begin` / `--complete`), which is
  // a separate slice; until that lands this correctly reports "not authorized"
  // instead of quietly falling back to the machine's own SSO session.
  return null;
}
