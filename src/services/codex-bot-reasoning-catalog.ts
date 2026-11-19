import { botOneShotEnv, type SessionEnvBotInput } from '../core/session-env-resolve.js';
import { checkCliAvailability } from '../setup/cli-availability.js';
import type { CliId } from '../adapters/cli/types.js';
import { isCodexReasoningCliId, type ReasoningCatalog } from './codex-reasoning-effort.js';
import { loadCodexServiceTierCatalog } from './codex-service-tier-catalog.js';

export interface CodexCatalogBot extends SessionEnvBotInput {
  cliId: CliId;
  cliRuntime?: { readonly executable: string } | null;
  cliPathOverride?: string;
  wrapperCli?: string;
  codexProfile?: string;
}

export interface CodexCatalogDeps {
  loadCatalog?: typeof loadCodexServiceTierCatalog;
  availability?: typeof checkCliAvailability;
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Live catalogue of the runtime a bot launches Codex with, for daemon-side
 * writers that cannot borrow the Dashboard's (`/modelpin`, `/botconfig`). It
 * uses the binary and one-shot env the service-tier save check uses, so a
 * level is judged against the same `codex debug models` output the Dashboard
 * offered it from.
 *
 * null — and the caller falls back to the static table — when the catalogue
 * cannot speak for that launch: not Codex, a wrapper or Codex profile chooses
 * the provider, or the binary/catalogue is unavailable.
 */
export async function loadBotCodexReasoningCatalog(
  bot: CodexCatalogBot,
  deps: CodexCatalogDeps = {},
): Promise<ReasoningCatalog | null> {
  if (!isCodexReasoningCliId(bot.cliId) || bot.wrapperCli?.trim() || bot.codexProfile?.trim()) return null;
  try {
    const cliPath = bot.cliRuntime?.executable ?? (bot.cliRuntime ? undefined : bot.cliPathOverride);
    const availability = (deps.availability ?? checkCliAvailability)({ cliId: bot.cliId, cliPathOverride: cliPath });
    const cliBin = availability.resolvedPath ?? availability.command;
    if (!cliBin) return null;
    return await (deps.loadCatalog ?? loadCodexServiceTierCatalog)({
      cliBin,
      env: botOneShotEnv(deps.baseEnv ?? process.env, bot),
    });
  } catch {
    return null;
  }
}

/** The launch-shaping fields a session freezes (see worker-pool sessionAgentConfig). */
export interface CodexCatalogSession {
  cliId?: CliId;
  agentFrozen?: boolean;
  cliRuntime?: { readonly executable: string } | null;
  cliPathOverride?: string;
  wrapperCli?: string;
  codexProfile?: string | null;
  cliLaunchSnapshot?: {
    cliId: CliId;
    cliRuntime: { readonly executable: string } | null;
    cliPathOverride: string | null;
    wrapperCli: string | null;
  };
}

/**
 * Live Codex catalogue for the runtime this session will actually launch: its
 * frozen CLI / runtime / wrapper / profile once the agent is frozen (a
 * per-session `/cli` snapshot included), the bot's live config before that.
 * null when that runtime's provider cannot be attested by a bare catalogue.
 */
export function loadSessionCodexReasoningCatalog(
  session: CodexCatalogSession,
  bot: CodexCatalogBot,
  deps: CodexCatalogDeps = {},
): Promise<ReasoningCatalog | null> {
  const snapshot = session.cliLaunchSnapshot;
  const frozen = !!session.agentFrozen;
  return loadBotCodexReasoningCatalog(snapshot ? {
    ...bot,
    cliId: snapshot.cliId,
    cliRuntime: snapshot.cliRuntime,
    cliPathOverride: snapshot.cliPathOverride ?? undefined,
    wrapperCli: snapshot.wrapperCli ?? undefined,
    codexProfile: undefined,
  } : {
    ...bot,
    cliId: session.cliId ?? bot.cliId,
    cliRuntime: frozen ? session.cliRuntime ?? null : bot.cliRuntime,
    cliPathOverride: frozen ? session.cliPathOverride : bot.cliPathOverride,
    wrapperCli: frozen ? session.wrapperCli : session.wrapperCli ?? bot.wrapperCli,
    // Frozen at session creation (null = none) and launched as-is; never the bot's.
    codexProfile: session.codexProfile ?? undefined,
  }, deps);
}
