/**
 * Command handler — processes /slash commands from users.
 * Extracted from daemon.ts for modularity.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { config } from '../config.js';
import { buildTerminalUrl } from './terminal-url.js';
import { getBot, getAllBots, getBotOpenId } from '../bot-registry.js';
import { repoPickerScanOptions } from '../global-config.js';
import * as sessionStore from '../services/session-store.js';
import * as scheduleStore from '../services/schedule-store.js';
import * as scheduler from './scheduler.js';
import { scanProjects, scanMultipleProjects, describeProjectDir } from '../services/project-scanner.js';
import { createRepoWorktree } from '../services/git-worktree.js';
import { worktreeSlugFromContextAI } from '../services/worktree-slug-ai.js';
import { buildRepoSelectCard, buildAdoptSelectCard, buildCodexAppThreadSelectCard, buildSlashListCard, getCliDisplayName, buildConfigCard, buildLandCard } from '../im/lark/card-builder.js';
import { computeSandboxDiff } from '../services/sandbox-land.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import type { CliId, ResumableSession } from '../adapters/cli/types.js';
import { deleteMessage, sendMessage, sendUserMessage, listChatBotMembers, resolveUserUnionId, getChatModeStrict, uploadFile } from '../im/lark/client.js';
import { chatAppLink, normalizeBrand } from '../im/lark/lark-hosts.js';
import { claimPairing } from '../services/pairing-store.js';
import { logger } from '../utils/logger.js';
import { killWorker, forkWorker, forkAdoptWorker, getCurrentCliVersion, postFreshStreamingCard, postPrivateSnapshotCard, resolvePrivateCardAudience, deliverEphemeralOrReply, deliverWritableTerminalCardTo } from './worker-pool.js';
import { expandHome, getSessionWorkingDir, getProjectScanDir, getProjectScanDirs, rememberLastCliInput } from './session-manager.js';
import { discoverSlashCommandsForAdapter, listMcpServerNames, supportsFilesystemCommandDiscovery } from './command-discovery.js';
import { validateWorkingDir } from './working-dir.js';
import { discoverAdoptableSessions, validateAdoptTarget, adoptTargetKey, adoptTargetLabel, type AdoptableSession } from './session-discovery.js';
import { discoverAdoptableZellijSessions, validateZellijAdoptTarget, type ZellijAdoptableSession } from './zellij-adopt-discovery.js';
import { listCodexAppThreads, type CodexAppThreadSummary } from '../services/codex-app-threads.js';
import { generateAuthUrl, getTokenStatus, resolveUserToken, DOC_COMMENT_OAUTH_SCOPES } from '../utils/user-token.js';
import { resolveDocFile, subscribeDocFile, unsubscribeDocFile } from '../im/lark/doc-comment.js';
import { UserTokenMissingError } from '../im/lark/client.js';
import {
  putDocSubscription, removeDocSubscription, listDocSubscriptionsForSession,
  type CommentTriggerMode,
} from '../services/doc-subs-store.js';
import { bindOncall, unbindOncall, getOncallStatus } from '../services/oncall-store.js';
import {
  CONFIG_FIELDS, findConfigField, settableFieldKeys, parseBooleanValue,
  applyConfigField, setBotAllowedUsers, getConfigSnapshot, getConfigCardData, coerceConfigValue, type ConfigEffect,
} from '../services/bot-config-store.js';
import { resolveCliId, findInvalidAllowedUserEntries } from '../setup/bot-config-editor.js';
import { buildClosedSessionCard } from './closed-session-card.js';
import { ttadkConfigModelChoices } from '../setup/cli-selection.js';
import { publishAttentionPatch, announcePendingRepoSession } from './session-activity.js';
import { setCardMode } from '../services/card-mode-store.js';
import { canOperate } from '../im/lark/event-dispatcher.js';
import { buildSafeInsightReport } from '../services/insight/report.js';
import type { SafeInsightReport } from '../services/insight/types.js';
import { invalidWorkingDirs } from '../utils/working-dir.js';
import { writeRoleFile, deleteRoleFile, resolveRole, resolveRoleFile, resolveTeamRoleFile, writeTeamRoleFile, deleteTeamRoleFile } from './role-resolver.js';
import { getBotCapability, setBotCapability, clearBotCapability } from '../services/bot-profile-store.js';
import {
  deleteRoleProfileEntry,
  deleteRoleProfileIfEmpty,
  isValidRoleProfileId,
  listRoleProfileEntries,
  listRoleProfiles,
  MAX_ROLE_PROFILE_ENTRY_BYTES,
  readRoleProfileEntry,
  writeRoleProfileEntry,
} from '../services/role-profile-store.js';
import type { LarkMessage, DaemonToWorker } from '../types.js';
import { sessionKey, sessionAnchorId } from './types.js';
import type { DaemonSession } from './types.js';
import { t, localeForBot, type Locale } from '../i18n/index.js';
import { runSkillsImCommand } from './skills/im-command.js';

// ─── Exported constants ──────────────────────────────────────────────────────

// DAEMON_COMMANDS / PASSTHROUGH_COMMANDS / normalizePassthroughCommand now live
// in the leaf ./passthrough-commands.js so the config store can share the
// normalization without a circular import; imported for internal use and
// re-exported to keep callers (daemon.ts, tests) importing from command-handler
// unchanged.
import { DAEMON_COMMANDS, PASSTHROUGH_COMMANDS, normalizePassthroughCommand, parseCustomPassthroughInput } from './passthrough-commands.js';
export { DAEMON_COMMANDS, PASSTHROUGH_COMMANDS };

/**
 * Daemon commands that act on the chat itself rather than opening a
 * conversation. `/group` (`/g`) just creates a Lark group and replies once —
 * no follow-up turns, no CLI worker. The new-topic spawn path normally
 * pre-creates a sessionStore record so a command can attach state and keep
 * card buttons routable, but for these that record is a phantom conversation
 * that pollutes the dashboard's session list. Handle them without a session.
 */
export const SESSIONLESS_DAEMON_COMMANDS = new Set(['/group', '/g', '/list-slash-command', '/slash', '/botconfig', '/skills']);

export function resolveAdapterDefaultPassthroughCommands(larkAppId?: string): string[] {
  if (!larkAppId) return [];
  try {
    const bot = getBot(larkAppId);
    const adapter = createCliAdapterSync(bot.config.cliId, bot.config.cliPathOverride);
    const normalized = (adapter.defaultPassthroughCommands ?? [])
      .map(normalizePassthroughCommand)
      .filter((c): c is string => !!c);
    return [...new Set(normalized)];
  } catch {
    return [];
  }
}

/**
 * Effective passthrough set for a bot: the fixed {@link PASSTHROUGH_COMMANDS}
 * plus adapter-scoped defaults and the bot's `customPassthroughCommands`
 * (bots.json). Entries that would shadow a botmux daemon command are dropped —
 * daemon commands must keep their daemon semantics, and passthrough is checked
 * BEFORE DAEMON_COMMANDS in the router, so an un-filtered custom `/status`
 * would hijack the daemon's own.
 * Unknown / no bot → falls back to the builtin set unchanged.
 */
export function resolvePassthroughCommands(larkAppId?: string): Set<string> {
  const effective = new Set(PASSTHROUGH_COMMANDS);
  if (!larkAppId) return effective;
  for (const c of resolveAdapterDefaultPassthroughCommands(larkAppId)) {
    effective.add(c);
  }
  try {
    for (const c of getBot(larkAppId).config.customPassthroughCommands ?? []) {
      const normalized = normalizePassthroughCommand(c);
      if (normalized) effective.add(normalized);
    }
  } catch {
    /* unknown bot — builtin set only */
  }
  return effective;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export interface SlashCommandInvocation {
  cmd: string;
  content: string;
}

const MULTILINE_COMMANDS = new Set(['/schedule', '/role']);

// `validateWorkingDir` now lives in ./working-dir.js (leaf module the CLI can
// import without the daemon graph); re-exported here for existing callers.
export { validateWorkingDir };

/**
 * Resolve a non-numeric `/repo <arg>` into a concrete repo path + display name.
 * `arg` is either a path (absolute or relative) or a first-level project name
 * under one of the bot's scan dirs — letting the user skip the selection card.
 *
 * Resolution:
 *   1. Build candidate absolute paths — absolute / `~` taken as-is; relative or
 *      bare names resolved against each scan dir, then the daemon cwd (mirrors
 *      how the card's project list is rooted).
 *   2. Prefer a candidate matching a scanned git project (carries a branch label).
 *   3. For a bare name, also match a scanned project by basename (covers projects
 *      nested deeper than the scan-dir top level).
 *   4. Fall back to any existing directory — lenient like `/cd`, whose trust model
 *      is "owner explicitly chose a dir"; the CLI already runs with full FS access.
 * Returns null when nothing resolves to an existing directory.
 */
export function resolveRepoSelection(
  repoArg: string,
  scanDirs: string[],
): { path: string; displayName: string } | null {
  const existingScanDirs = scanDirs.filter((d) => existsSync(d));
  const projects = existingScanDirs.length > 0 ? scanMultipleProjects(existingScanDirs) : [];

  const isExplicitPath =
    repoArg.startsWith('/') ||
    repoArg.startsWith('~') ||
    repoArg.startsWith('.') ||
    repoArg.includes('/');

  const candidates: string[] = [];
  if (repoArg.startsWith('/') || repoArg.startsWith('~')) {
    candidates.push(resolve(expandHome(repoArg)));
  } else {
    for (const d of scanDirs) candidates.push(resolve(d, repoArg));
    candidates.push(resolve(expandHome(repoArg))); // daemon-cwd fallback (matches /cd)
  }

  // 1) Exact scanned-project match — preferred, gives the "name (branch)" label.
  for (const cand of candidates) {
    const proj = projects.find((p) => resolve(p.path) === cand);
    if (proj) return { path: proj.path, displayName: `${proj.name} (${proj.branch})` };
  }
  // 2) Bare name → match a scanned project by basename.
  if (!isExplicitPath) {
    const byName = projects.find((p) => p.name === repoArg);
    if (byName) return { path: byName.path, displayName: `${byName.name} (${byName.branch})` };
  }
  // 3) Lenient fallback: any existing directory. Label it with a git ref when
  //    it's a repo (covers explicit paths outside the scan roots), else basename.
  for (const cand of candidates) {
    try {
      if (!statSync(cand).isDirectory()) continue;
    } catch {
      continue; // missing / not a dir — try next candidate
    }
    const desc = describeProjectDir(cand);
    return desc
      ? { path: cand, displayName: `${desc.name} (${desc.branch})` }
      : { path: cand, displayName: basename(cand) };
  }
  return null;
}

/**
 * Parse a force-topic invocation: `/t [prompt]` or `/topic [prompt]`.
 *
 * This is a routing meta-command, distinct from `parseSlashCommandInvocation`
 * (which routes to daemon command handlers). The match conditions are
 * deliberately tighter than the regular slash parser:
 *
 * - exact-prefix match (`/t` / `/topic`, case-insensitive); `/tea` / `/topical`
 *   must NOT match, otherwise we'd false-trigger on common /-prefixed words.
 * - tolerates leading whitespace (mention-stripping can leave a space).
 * - prompt is whatever follows the prefix (verbatim, including newlines).
 * - `/t` alone (no args) is allowed → empty prompt; the user can fill it in
 *   while the repo selection card is still pending.
 *
 * Returns null for anything else, so callers can fall through to the regular
 * `parseSlashCommandInvocation` / message-handling path.
 */
export function parseForceTopicInvocation(content: string): { prompt: string } | null {
  const trimmed = content.replace(/^\s+/, '');
  const match = /^\/(t|topic)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return null;
  return { prompt: (match[2] ?? '').trim() };
}

/** Parse a user-authored slash command after leading @mentions have already
 *  been stripped. Messages that look like command examples or command lists
 *  are intentionally left for the CLI instead of being intercepted by the
 *  daemon; otherwise discussion text such as `/adopt <pane>` can accidentally
 *  trigger real daemon actions. */
export function parseSlashCommandInvocation(content: string): SlashCommandInvocation | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('/')) return null;

  const lines = trimmed.split(/\r?\n/);
  const firstLine = (lines[0] ?? '').trimEnd();
  const [cmdRaw] = firstLine.split(/\s+/);
  const cmd = cmdRaw?.toLowerCase();
  if (!cmd) return null;

  // Treat angle-bracket placeholders as documentation, not an invocation.
  if (/<[^>\r\n]+>/.test(firstLine)) return null;

  const restNonBlank = lines.slice(1).map(l => l.trim()).filter(Boolean);
  if (restNonBlank.length > 0) {
    // A list of slash commands is almost certainly discussion / planning text.
    if (restNonBlank.some(l => l.startsWith('/'))) return null;
    if (!MULTILINE_COMMANDS.has(cmd)) return null;
  }

  return { cmd, content: trimmed };
}

function tag(ds: DaemonSession): string {
  return ds.session.sessionId.substring(0, 8);
}

/**
 * Lowercased display names of ALL bots known to the deployment, read from the
 * shared bots-info.json. This is the only globally-complete, process-stable
 * source of "is this @-mention a bot?": production runs one daemon per bot, so
 * getAllBots() only sees this process's own bot, and the live chat-member roster
 * (listChatBotMembers) can transiently miss a bot — either would let competing
 * bot processes disagree on who the first @-mentioned bot is and double-create.
 * bots-info.json is a local file merge-written by every daemon at startup.
 */
function globalKnownBotNames(): Set<string> {
  try {
    const p = join(config.session.dataDir, 'bots-info.json');
    if (!existsSync(p)) return new Set();
    const entries: Array<{ botName?: string | null }> = JSON.parse(readFileSync(p, 'utf-8'));
    return new Set(entries.map(e => e.botName?.toLowerCase()).filter((n): n is string => !!n));
  } catch {
    return new Set();
  }
}

/** Human-friendly name for a bot larkAppId — Lark app display name, else cliId, else the raw id. */
function botDisplayName(larkAppId: string): string {
  try {
    const bot = getBot(larkAppId);
    return bot.botName ?? getCliDisplayName(bot.config.cliId) ?? larkAppId;
  } catch {
    return larkAppId;
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function codexAppThreadTitle(thread: CodexAppThreadSummary): string {
  const raw = (thread.name || thread.preview || thread.threadId).replace(/\s+/g, ' ').trim();
  return raw.length > 80 ? raw.slice(0, 79) + '…' : raw;
}

function invalidConfiguredWorkingDirs(ds: DaemonSession | undefined, larkAppId: string | undefined): string[] {
  if (ds?.workingDir) return invalidWorkingDirs({ workingDir: ds.workingDir });
  if (larkAppId) {
    const bot = getBot(larkAppId);
    return invalidWorkingDirs({
      workingDir: bot.config.workingDir ?? '~',
      workingDirs: bot.config.workingDirs,
    });
  }
  return invalidWorkingDirs({
    workingDir: config.daemon.workingDir ?? '~',
    workingDirs: config.daemon.workingDirs,
  });
}


// ─── Types ───────────────────────────────────────────────────────────────────

export interface CommandHandlerDeps {
  activeSessions: Map<string, DaemonSession>;
  sessionReply: (rootId: string, content: string, msgType?: string, larkAppId?: string, turnId?: string) => Promise<string>;
  getActiveCount: () => number;
  lastRepoScan: Map<string, import('../services/project-scanner.js').ProjectInfo[]>;
}

// ─── Schedule command ────────────────────────────────────────────────────────

async function handleRoleCommand(
  args: string,
  rootId: string,
  chatId: string,
  larkAppId: string,
  senderId: string | undefined,
  deps: CommandHandlerDeps,
): Promise<void> {
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const trimmed = args.trim();
  const loc = localeForBot(larkAppId);
  const dataDir = config.session.dataDir;

  // /role profile [...] — reusable suites of per-bot chat roles. Profiles are
  // not a runtime role layer; applying one materializes this bot's entry into
  // the current chat role.
  const profileMatch = trimmed.match(/^profile\b([\s\S]*)$/);
  if (profileMatch) {
    const profileArgs = profileMatch[1].trim();
    const subMatch = profileArgs.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const sub = (subMatch?.[1] ?? '').toLowerCase();
    const subBody = subMatch?.[2]?.trim() ?? '';

    if (!sub || sub === 'help') {
      await sessionReply(rootId, t('role.profile.help', undefined, loc));
      return;
    }

    if (sub === 'list' || sub === 'ls') {
      const profiles = listRoleProfiles(dataDir);
      if (profiles.length === 0) {
        await sessionReply(rootId, t('role.profile.list_empty', undefined, loc));
        return;
      }
      const lines = profiles.map(p => {
        const hasEntry = readRoleProfileEntry(dataDir, p.profileId, larkAppId) !== null;
        const status = hasEntry
          ? t('role.profile.current_configured', undefined, loc)
          : t('role.profile.current_missing', undefined, loc);
        return `• ${p.profileId} — ${p.entryCount} ${t('role.profile.entries', undefined, loc)}; ${status}`;
      });
      await sessionReply(rootId, `${t('role.profile.list_header', undefined, loc)}\n${lines.join('\n')}`);
      return;
    }

    const [profileId = '', ...afterProfile] = subBody.split(/\s+/);
    if (!profileId || !isValidRoleProfileId(profileId)) {
      await sessionReply(rootId, t('role.profile.invalid', undefined, loc));
      return;
    }

    if (sub === 'show') {
      const showAll = afterProfile.includes('--all');
      if (showAll) {
        const entries = listRoleProfileEntries(dataDir, profileId);
        if (entries.length === 0) {
          await sessionReply(rootId, t('role.profile.no_entries', { profile: profileId }, loc));
          return;
        }
        const body = entries.map(entry =>
          `### ${entry.larkAppId}\n${t('role.byte_count', { bytes: entry.byteLength, max: MAX_ROLE_PROFILE_ENTRY_BYTES }, loc)}\n\`\`\`markdown\n${entry.content}\n\`\`\``,
        ).join('\n\n');
        await sessionReply(rootId, `${t('role.profile.show_all_header', { profile: profileId }, loc)}\n${body}`);
        return;
      }
      const content = readRoleProfileEntry(dataDir, profileId, larkAppId);
      if (content === null) {
        await sessionReply(rootId, t('role.profile.entry_empty', { profile: profileId }, loc));
        return;
      }
      await sessionReply(rootId, `${t('role.profile.entry_current', { profile: profileId }, loc)}\n\`\`\`markdown\n${content}\n\`\`\`\n${t('role.byte_count', { bytes: Buffer.byteLength(content, 'utf-8'), max: MAX_ROLE_PROFILE_ENTRY_BYTES }, loc)}`);
      return;
    }

    if (sub === 'set') {
      const content = subBody.slice(profileId.length).trim();
      if (!content) {
        await sessionReply(rootId, t('role.profile.set_empty', undefined, loc));
        return;
      }
      writeRoleProfileEntry(dataDir, profileId, larkAppId, content);
      await sessionReply(rootId, t('role.profile.entry_saved', {
        profile: profileId,
        bytes: Math.min(Buffer.byteLength(content.trim(), 'utf-8'), MAX_ROLE_PROFILE_ENTRY_BYTES),
        max: MAX_ROLE_PROFILE_ENTRY_BYTES,
      }, loc));
      return;
    }

    if (sub === 'save') {
      const { content, source } = resolveRole(larkAppId, chatId);
      if (!content) {
        await sessionReply(rootId, t('role.profile.save_no_effective', { profile: profileId }, loc));
        return;
      }
      writeRoleProfileEntry(dataDir, profileId, larkAppId, content);
      await sessionReply(rootId, t('role.profile.saved_effective', {
        profile: profileId,
        source,
        bytes: Buffer.byteLength(content, 'utf-8'),
        max: MAX_ROLE_PROFILE_ENTRY_BYTES,
      }, loc));
      return;
    }

    if (sub === 'delete' || sub === 'del' || sub === 'rm' || sub === '删除') {
      const existed = deleteRoleProfileEntry(dataDir, profileId, larkAppId);
      deleteRoleProfileIfEmpty(dataDir, profileId);
      await sessionReply(rootId, existed
        ? t('role.profile.entry_deleted', { profile: profileId }, loc)
        : t('role.profile.entry_nothing', { profile: profileId }, loc));
      return;
    }

    if (sub === 'apply') {
      const flags = new Set(afterProfile);
      const preview = flags.has('--preview');
      const force = flags.has('--force');
      const quiet = flags.has('--quiet');
      const content = readRoleProfileEntry(dataDir, profileId, larkAppId);
      if (content === null) {
        await sessionReply(rootId, t('role.profile.apply_missing', { profile: profileId }, loc));
        return;
      }
      const existing = resolveRoleFile(larkAppId, chatId);
      const bytes = Buffer.byteLength(content, 'utf-8');
      if (preview) {
        const overwriteLine = existing && !force
          ? `\n${t('role.profile.apply_would_refuse', undefined, loc)}`
          : '';
        await sessionReply(rootId, `${t('role.profile.apply_preview', { profile: profileId, bytes, max: MAX_ROLE_PROFILE_ENTRY_BYTES }, loc)}${overwriteLine}\n\`\`\`markdown\n${content}\n\`\`\``);
        return;
      }
      if (existing && !force) {
        // An empty entry would *clear* the chat role, not overwrite it — phrase
        // the --force refusal accordingly so the intent is not misread.
        const refusedKey = content ? 'role.profile.apply_refused' : 'role.profile.apply_refused_clear';
        await sessionReply(rootId, t(refusedKey, { profile: profileId }, loc));
        return;
      }
      if (!content) {
        deleteRoleFile(larkAppId, chatId);
        if (!quiet) {
          await sessionReply(rootId, t('role.profile.applied', { profile: profileId, bytes, max: MAX_ROLE_PROFILE_ENTRY_BYTES }, loc));
        }
        return;
      }
      writeRoleFile(larkAppId, chatId, content);
      if (!quiet) {
        await sessionReply(rootId, t('role.profile.applied', { profile: profileId, bytes, max: MAX_ROLE_PROFILE_ENTRY_BYTES }, loc));
      }
      return;
    }

    await sessionReply(rootId, t('role.profile.help', undefined, loc));
    return;
  }

  // /role team [...] — manage the team-level (per-bot, cross-chat) role
  const teamMatch = trimmed.match(/^team\b([\s\S]*)$/);
  if (teamMatch) {
    const teamArgs = teamMatch[1].trim();
    const teamSet = teamArgs.match(/^set\s+([\s\S]+)/);
    if (teamSet) {
      const content = teamSet[1].trim();
      if (!content) { await sessionReply(rootId, t('role.set_empty', undefined, loc)); return; }
      writeTeamRoleFile(larkAppId, content);
      await sessionReply(rootId, t('role.team_saved', { bytes: Buffer.byteLength(content, 'utf-8'), max: 4096 }, loc));
      return;
    }
    if (teamArgs === 'delete' || teamArgs === '删除') {
      await sessionReply(rootId, deleteTeamRoleFile(larkAppId) ? t('role.team_deleted', undefined, loc) : t('role.team_nothing', undefined, loc));
      return;
    }
    const content = resolveTeamRoleFile(larkAppId);
    if (content) {
      await sessionReply(rootId, `${t('role.team_current', undefined, loc)}\n\`\`\`markdown\n${content}\n\`\`\`\n${t('role.byte_count', { bytes: Buffer.byteLength(content, 'utf-8'), max: 4096 }, loc)}`);
    } else {
      await sessionReply(rootId, t('role.team_empty', undefined, loc));
    }
    return;
  }

  // /role cap [...] — manage the short capability label shown in the roster
  const capMatch = trimmed.match(/^cap\b([\s\S]*)$/);
  if (capMatch) {
    const capArgs = capMatch[1].trim();
    const capSet = capArgs.match(/^set\s+([\s\S]+)/);
    if (capSet) {
      const label = capSet[1].trim();
      if (!label) { await sessionReply(rootId, t('role.cap_set_empty', undefined, loc)); return; }
      setBotCapability(dataDir, larkAppId, label, senderId);
      await sessionReply(rootId, t('role.cap_saved', { cap: getBotCapability(dataDir, larkAppId) ?? label }, loc));
      return;
    }
    if (capArgs === 'clear' || capArgs === '清除') {
      await sessionReply(rootId, clearBotCapability(dataDir, larkAppId) ? t('role.cap_cleared', undefined, loc) : t('role.cap_empty', undefined, loc));
      return;
    }
    const cap = getBotCapability(dataDir, larkAppId);
    await sessionReply(rootId, cap ? t('role.cap_current', { cap }, loc) : t('role.cap_empty', undefined, loc));
    return;
  }

  // /role → show the EFFECTIVE role + where it comes from (chat override > team > none)
  if (!trimmed) {
    const { content, source } = resolveRole(larkAppId, chatId);
    if (content) {
      const len = Buffer.byteLength(content, 'utf-8');
      const srcLabel = source === 'chat' ? t('role.src_chat', undefined, loc) : t('role.src_team', undefined, loc);
      await sessionReply(rootId, `${t('role.current', undefined, loc)} ${srcLabel}\n\`\`\`markdown\n${content}\n\`\`\`\n${t('role.byte_count', { bytes: len, max: 4096 }, loc)}`);
    } else {
      await sessionReply(rootId, t('role.empty', undefined, loc));
    }
    return;
  }

  // /role set <content> — write role file
  const setMatch = trimmed.match(/^set\s+([\s\S]+)/);
  if (setMatch) {
    const content = setMatch[1].trim();
    if (!content) {
      await sessionReply(rootId, t('role.set_empty', undefined, loc));
      return;
    }
    writeRoleFile(larkAppId, chatId, content);
    const len = Buffer.byteLength(content, 'utf-8');
    await sessionReply(rootId, t('role.saved_via_cmd', { bytes: len, max: 4096 }, loc));
    return;
  }

  // /role delete
  if (trimmed === 'delete' || trimmed === '删除') {
    const existed = deleteRoleFile(larkAppId, chatId);
    if (existed) {
      await sessionReply(rootId, t('role.deleted_via_cmd', undefined, loc));
    } else {
      await sessionReply(rootId, t('role.nothing_to_delete', undefined, loc));
    }
    return;
  }

  // /role help — fallback
  await sessionReply(rootId, t('role.help', undefined, loc));
}

async function handleScheduleCommand(
  args: string,
  rootId: string,
  chatId: string,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const { activeSessions } = deps;
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const trimmed = args.trim();
  const loc = localeForBot(larkAppId);
  // Format dates using a locale that matches the user's UI choice. Both
  // forms include the wall-clock components the user cares about; the
  // difference is just punctuation and digit order.
  const timeLocale = loc === 'en' ? 'en-US' : 'zh-CN';
  const timeZone = 'Asia/Shanghai';

  // /schedule list | /schedule 列表
  if (!trimmed || trimmed === 'list' || trimmed === '列表') {
    const tasks = scheduleStore.listTasks();
    if (tasks.length === 0) {
      await sessionReply(rootId, t('schedule.empty_with_examples', undefined, loc));
      return;
    }
    const lines = tasks.map(task => {
      const status = task.enabled ? '✅' : '⏸️';
      const next = task.enabled ? scheduler.getNextRun(task.id) : null;
      const nextStr = next ? t('schedule.next_label', { time: next.toLocaleString(timeLocale, { timeZone }) }, loc) : '';
      const lastStr = task.lastRunAt ? t('schedule.last_label', { time: new Date(task.lastRunAt).toLocaleString(timeLocale, { timeZone }) }, loc) : '';
      const display = task.parsed?.display ?? task.schedule;
      return `${status} [${task.id}] ${display} | ${task.name}\n   prompt: ${task.prompt.substring(0, 50)}${task.prompt.length > 50 ? '...' : ''}${nextStr}${lastStr}`;
    });
    await sessionReply(rootId, `${t('schedule.list_header', { count: tasks.length }, loc)}\n\n${lines.join('\n\n')}`);
    return;
  }

  // /schedule remove <id> | /schedule 删除 <id>
  const removeMatch = trimmed.match(/^(?:remove|删除)\s+(\S+)/);
  if (removeMatch) {
    const id = removeMatch[1];
    if (scheduler.removeTask(id)) {
      await sessionReply(rootId, t('schedule.removed', { id }, loc));
    } else {
      await sessionReply(rootId, t('schedule.not_found', { id }, loc));
    }
    return;
  }

  // /schedule enable <id> | /schedule 启用 <id>
  const enableMatch = trimmed.match(/^(?:enable|启用)\s+(\S+)/);
  if (enableMatch) {
    const id = enableMatch[1];
    if (scheduler.enableTask(id)) {
      await sessionReply(rootId, t('schedule.enabled', { id }, loc));
    } else {
      await sessionReply(rootId, t('schedule.not_found', { id }, loc));
    }
    return;
  }

  // /schedule disable <id> | /schedule 禁用 <id>
  const disableMatch = trimmed.match(/^(?:disable|禁用)\s+(\S+)/);
  if (disableMatch) {
    const id = disableMatch[1];
    if (scheduler.disableTask(id)) {
      await sessionReply(rootId, t('schedule.disabled', { id }, loc));
    } else {
      await sessionReply(rootId, t('schedule.not_found', { id }, loc));
    }
    return;
  }

  // /schedule run <id> | /schedule 执行 <id>
  const runMatch = trimmed.match(/^(?:run|执行)\s+(\S+)/);
  if (runMatch) {
    const id = runMatch[1];
    if (scheduler.runTaskNow(id)) {
      await sessionReply(rootId, t('schedule.triggered_now', { id }, loc));
    } else {
      await sessionReply(rootId, t('schedule.not_found', { id }, loc));
    }
    return;
  }

  // Natural language: /schedule 每日17:50给我"帮我看看AI新闻"
  const parsed = scheduler.parseNaturalSchedule(trimmed);
  if (parsed) {
    const ds = larkAppId ? activeSessions.get(sessionKey(rootId, larkAppId)) : undefined;
    const workingDir = ds?.workingDir ?? (ds?.larkAppId ? getBot(ds.larkAppId).config.workingDir ?? '~' : getAllBots()[0]?.config.workingDir ?? '~');
    const taskScope: 'thread' | 'chat' = ds?.scope === 'chat' ? 'chat' : 'thread';
    // "新话题" keyword → every fire opens a brand-new topic in a fresh session.
    const { deliver, prompt: schedPrompt } = scheduler.extractDeliveryMode(parsed.prompt);
    const schedName = deliver === 'new-topic'
      ? (schedPrompt.length > 20 ? schedPrompt.slice(0, 20) + '...' : schedPrompt)
      : parsed.name;
    const task = scheduler.addTask({
      name: schedName,
      schedule: trimmed,
      parsed: parsed.parsed,
      prompt: schedPrompt,
      workingDir,
      chatId,
      rootMessageId: taskScope === 'thread' ? rootId : undefined,
      scope: taskScope,
      chatType: ds?.chatType === 'p2p' ? 'p2p' : 'topic_group',
      larkAppId,
      deliver,
    });
    const next = scheduler.getNextRun(task.id);
    const nextStr = next ? next.toLocaleString(timeLocale, { timeZone }) : 'N/A';
    const createdMsg = t('schedule.created', {
      id: task.id,
      name: task.name,
      rule: parsed.parsed.display,
      prompt: task.prompt,
      dir: expandHome(workingDir),
      next: nextStr,
    }, loc);
    const deliverNote = deliver === 'new-topic' ? '\n' + t('schedule.deliver_new_topic', undefined, loc) : '';
    await sessionReply(rootId, createdMsg + deliverNote);
    return;
  }

  // Unrecognized format
  await sessionReply(rootId, t('schedule.parse_failed', undefined, loc));
}

// ─── Config command ──────────────────────────────────────────────────────────

function configEffectNote(effect: ConfigEffect, loc: Locale): string {
  return effect === 'immediate'
    ? t('cmd.config.effect_immediate', undefined, loc)
    : t('cmd.config.effect_next_session', undefined, loc);
}

/** `/botconfig zh|en`（及常见别名）→ 卡片显示语言；非语言参数 → undefined（按子命令走）。 */
function cardLocaleArg(sub: string | undefined): Locale | undefined {
  if (!sub) return undefined;
  if (sub === 'zh' || sub === 'cn' || sub === '中文' || sub === '中') return 'zh';
  if (sub === 'en' || sub === 'english' || sub === '英文' || sub === '英') return 'en';
  return undefined;
}

function buildConfigHelp(loc: Locale): string {
  const fields = CONFIG_FIELDS.map(f => `• ${f.key} — ${f.hint}`).join('\n');
  return t('cmd.config.help', { fields }, loc);
}

function buildConfigSnapshot(larkAppId: string, loc: Locale): string {
  const snap = getConfigSnapshot(larkAppId);
  if (!snap.ok) return t('cmd.config.no_bot', undefined, loc);
  const lines = snap.rows.map(r => `• ${r.key} = ${r.value}`).join('\n');
  return t('cmd.config.snapshot', {
    cli: snap.info.cliId,
    brand: snap.info.brand,
    admins: snap.info.resolvedAdmins,
    dirs: snap.info.workingDirs.join(', ') || '∅',
    fields: lines,
  }, loc);
}

/**
 * `/botconfig set allowedUsers ...` —— 动信任根的敏感路径，与普通字段分开：
 * 末尾的 `确认`/`confirm` 才真正落盘；缺确认 → 回显预览要求二次确认。
 * 非法条目（裸邮箱前缀等）先挡；防自锁 / 解析空由 {@link setBotAllowedUsers} 兜底。
 */
async function applyAllowedUsersSet(
  tokens: string[],
  rootId: string,
  larkAppId: string,
  senderId: string | undefined,
  deps: CommandHandlerDeps,
  loc: Locale,
): Promise<void> {
  const reply = (c: string) => deps.sessionReply(rootId, c, undefined, larkAppId);
  let list = [...tokens];
  let confirmed = false;
  if (list.length && /^(confirm|确认|yes|--yes)$/i.test(list[list.length - 1])) {
    confirmed = true;
    list = list.slice(0, -1);
  }
  const entries = list.join(' ').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  if (entries.length === 0) { await reply(t('cmd.config.allow_usage', undefined, loc)); return; }
  const invalid = findInvalidAllowedUserEntries(entries);
  if (invalid.length) { await reply(t('cmd.config.allow_invalid', { items: invalid.join(', ') }, loc)); return; }
  if (!confirmed) { await reply(t('cmd.config.allow_confirm', { list: entries.join(', ') }, loc)); return; }

  const r = await setBotAllowedUsers(larkAppId, entries, senderId);
  if (!r.ok) {
    if (r.reason === 'self_lockout') { await reply(t('cmd.config.allow_lockout', undefined, loc)); return; }
    if (r.reason === 'empty_resolved') { await reply(t('cmd.config.allow_empty', undefined, loc)); return; }
    await reply(t('cmd.config.write_failed', { reason: r.reason }, loc));
    return;
  }
  await reply(t('cmd.config.allow_ok', { count: r.resolved.length, total: r.raw.length }, loc));
}

/**
 * `/botconfig` —— owner/allowedUsers 远程改本 bot 运营字段。sessionless：只认 larkAppId，
 * 不需活跃会话。严格 admin 闸（拒绝开放模式 bot），写盘 + 内存热更新，无需重启。
 */
async function handleConfigCommand(
  message: LarkMessage,
  rootId: string,
  larkAppId: string,
  deps: CommandHandlerDeps,
): Promise<void> {
  const loc = localeForBot(larkAppId);
  const reply = (c: string) => deps.sessionReply(rootId, c, undefined, larkAppId);
  const senderId = message.senderId;

  // Admin 闸：严格限定 allowedUsers，**拒绝开放模式**（无 allowlist 的 bot 没有可
  // 授权的 owner，不能凭聊天改配置）。上游 canOperate 对开放模式 / 兄弟 bot 也放行，
  // 改配置比一般 daemon 命令敏感，这里收紧到「本 bot 的 allowedUsers」。
  let bot;
  try { bot = getBot(larkAppId); } catch { await reply(t('cmd.config.no_bot', undefined, loc)); return; }
  const admins = bot.resolvedAllowedUsers;
  if (admins.length === 0) { await reply(t('cmd.config.no_owner', undefined, loc)); return; }
  if (!senderId || !admins.includes(senderId)) { await reply(t('cmd.config.not_admin', undefined, loc)); return; }

  const trimmed = message.content.replace(/^\/botconfig\s*/i, '').trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];
  const sub = parts[0]?.toLowerCase();

  // 裸 /botconfig → 交互配置卡片；`/botconfig zh|en` → 指定卡片显示语言（覆盖 bot 默认）。
  const cardLoc = cardLocaleArg(sub);
  if (!sub || cardLoc) {
    const renderLoc: Locale = cardLoc ?? loc;
    // ttadk 网关 bot：模型候选用 ttadk 网关模型（glm-5.1…），不是底层适配器的
    // opus/gpt-5（那会被 worker 注入成 `ttadk -m opus` 用错模型启动失败）；CoCo 无候选。
    // 非 ttadk（返回 null）才回落底层适配器自己的 modelChoices。
    const ttadkChoices = ttadkConfigModelChoices(bot.config.wrapperCli);
    let modelChoices: readonly string[] = ttadkChoices ?? [];
    if (ttadkChoices === null) {
      try { modelChoices = createCliAdapterSync(bot.config.cliId, bot.config.cliPathOverride).modelChoices ?? []; } catch { /* 无候选 → 不渲染 model 下拉 */ }
    }
    const data = getConfigCardData(larkAppId, modelChoices);
    if (!data) { await reply(buildConfigHelp(renderLoc)); return; }
    const cardJson = buildConfigCard(data, renderLoc);
    // 始终把卡片**私信**给 owner，群里不留任何回复：
    //   • 私聊（单发给 bot）→ sendUserMessage 落在当前私聊 = 直接返回配置；
    //   • 群 / 话题群 → 卡片落在 owner 私聊，群内不产生「话题回复」、也只他可见。
    // 不再依赖 getChatModeStrict（它会偶发 500 → 误判）。
    // 私信失败（owner 从未与 bot 开过单聊等）：**绝不**把整张配置卡回退到会话内——
    // 在群/话题群里那会让 owner-only 的运营配置卡全员可见（按钮虽仍重验 admin 无法提权，
    // 但卡片本身就违背「始终私信」意图）。只回一句简短文字引导去单聊后重试。
    try {
      await sendUserMessage(larkAppId, senderId, cardJson, 'interactive');
    } catch {
      await reply(t('cmd.config.card_dm_failed', undefined, renderLoc));
    }
    return;
  }
  if (sub === 'help' || sub === '帮助') { await reply(buildConfigHelp(loc)); return; }
  if (sub === 'get' || sub === 'show' || sub === 'list' || sub === '查看') { await reply(buildConfigSnapshot(larkAppId, loc)); return; }

  if (sub === 'set' || sub === 'unset') {
    const fieldKey = parts[1];
    if (!fieldKey) { await reply(t('cmd.config.set_usage', undefined, loc)); return; }
    const spec = findConfigField(fieldKey);
    if (!spec) { await reply(t('cmd.config.unknown_field', { field: fieldKey, fields: settableFieldKeys().join(', ') }, loc)); return; }

    if (sub === 'unset') {
      if (!spec.clearable) { await reply(t('cmd.config.not_clearable', { field: spec.key }, loc)); return; }
      const r = await applyConfigField(larkAppId, spec, null);
      if (!r.ok) { await reply(t('cmd.config.write_failed', { reason: r.reason }, loc)); return; }
      await reply(t('cmd.config.unset_ok', { field: spec.key, old: r.oldText, effect: configEffectNote(r.effect, loc) }, loc));
      return;
    }

    // set
    if (spec.kind === 'allowedUsers') {
      await applyAllowedUsersSet(parts.slice(2), rootId, larkAppId, senderId, deps, loc);
      return;
    }

    const rawValue = parts.slice(2).join(' ').trim();
    if (!rawValue) { await reply(t('cmd.config.value_required', { field: spec.key }, loc)); return; }

    let value: unknown;
    switch (spec.kind) {
      case 'stringList': {
        const arr = parseCustomPassthroughInput(rawValue);
        if (arr.length === 0) { await reply(t('cmd.config.value_required', { field: spec.key }, loc)); return; }
        value = arr;
        break;
      }
      case 'number': {
        // 统一走 coerceConfigValue 的 number 校验（正整数），避免文字路径把 '6'
        // 当字符串写进 maxLiveWorkers（与 card/API 路径同口径）。
        const coerced = coerceConfigValue(spec, rawValue);
        if (!coerced.ok) { await reply(t('cmd.config.invalid_number', { field: spec.key, value: rawValue }, loc)); return; }
        value = coerced.value;
        break;
      }
      case 'boolean': {
        const b = parseBooleanValue(rawValue);
        if (b === undefined) { await reply(t('cmd.config.invalid_bool', { field: spec.key, value: rawValue }, loc)); return; }
        value = b;
        break;
      }
      case 'enum': {
        const v = rawValue.toLowerCase();
        if (!spec.enumValues?.includes(v)) { await reply(t('cmd.config.invalid_enum', { field: spec.key, values: (spec.enumValues ?? []).join('|') }, loc)); return; }
        value = v;
        break;
      }
      case 'cli': {
        try {
          const id = resolveCliId(rawValue);
          if (!id) { await reply(t('cmd.config.value_required', { field: spec.key }, loc)); return; }
          value = id;
        } catch (e: any) {
          await reply(t('cmd.config.invalid_cli', { msg: e?.message ?? String(e) }, loc));
          return;
        }
        break;
      }
      case 'dir': {
        const v = validateWorkingDir(rawValue, loc);
        if (!v.ok) { await reply(v.error); return; }
        value = rawValue; // 存原始（保留 ~），与 workingDir 落盘一致；使用处再 expandHome
        break;
      }
      case 'json': {
        const coerced = coerceConfigValue(spec, rawValue);
        if (!coerced.ok) { await reply(t('cmd.config.write_failed', { reason: coerced.reason }, loc)); return; }
        value = coerced.value;
        break;
      }
      default: // 'string'
        value = rawValue;
    }

    const r = await applyConfigField(larkAppId, spec, value);
    if (!r.ok) { await reply(t('cmd.config.write_failed', { reason: r.reason }, loc)); return; }
    await reply(t('cmd.config.set_ok', { field: spec.key, old: r.oldText, new: r.newText, effect: configEffectNote(r.effect, loc) }, loc));
    return;
  }

  await reply(t('cmd.config.unknown_sub', { sub }, loc));
}

// ─── Main command handler ────────────────────────────────────────────────────

/**
 * Handle `/card` (operator-only). Resolves the active session itself, so off/on
 * work WITHOUT one -- they only toggle the per-chat `noCardChats` config. A
 * summon (show/bare) needs a live session.
 *
 * off  -> suppress the live streaming card for this chat (add to noCardChats);
 *         status falls back to master's pending-card morph.
 * on   -> restore cards for this chat (remove from noCardChats).
 * ''/show -> summon a live card. privateCard -> private ephemeral snapshot
 *         (fail closed on non-group); otherwise a group-visible live card.
 * off/on also clear `streamingCardForced` so a prior summon does not
 * short-circuit `streamingCardDisabled()`.
 */
export async function handleCardCommand(
  rootId: string,
  larkAppId: string,
  chatId: string,
  senderOpenId: string | undefined,
  content: string,
  deps: CommandHandlerDeps,
): Promise<void> {
  const loc = localeForBot(larkAppId);
  const reply = (c: string) => deps.sessionReply(rootId, c, undefined, larkAppId);

  // /card is an operator command — gate on canOperate, the same model every other
  // daemon command uses. Open mode (no owner/allowlist) → canOperate passes for
  // everyone; configured → any allowedUser (owner or co-owner); talk-only grantees
  // (chatGrant/globalGrant/oncall members) are never operators.
  if (!canOperate(larkAppId, chatId, senderOpenId)) {
    await reply(t('cmd.card.operator_only', undefined, loc));
    return;
  }

  const ds = deps.activeSessions.get(sessionKey(rootId, larkAppId));
  const sub = content.replace(/^\/card\s*/i, '').trim().toLowerCase();

  if (sub === 'off') {
    const r = await setCardMode(larkAppId, chatId, true);
    if (ds) ds.streamingCardForced = undefined;
    await reply(r.ok ? t('cmd.card.off_ok', undefined, loc) : t('cmd.card.fail', { reason: r.reason }, loc));
    return;
  }
  if (sub === 'on') {
    const r = await setCardMode(larkAppId, chatId, false);
    if (ds) ds.streamingCardForced = undefined;
    await reply(r.ok ? t('cmd.card.on_ok', undefined, loc) : t('cmd.card.fail', { reason: r.reason }, loc));
    return;
  }
  if (sub === '' || sub === 'show') {
    if (!ds) {
      await reply(t('cmd.no_active_session', undefined, loc));
      return;
    }
    if (getBot(ds.larkAppId).config.privateCard) {
      const mode = await getChatModeStrict(ds.larkAppId, ds.chatId);
      if (mode !== 'group') {
        await reply(t('cmd.card.private_not_group', undefined, loc));
        return;
      }
      const audience = resolvePrivateCardAudience(ds);
      if (audience.length === 0) {
        await reply(t('cmd.card.private_no_audience', undefined, loc));
        return;
      }
      const r = await postPrivateSnapshotCard(ds, audience);
      if (r.notReady) {
        await reply(t('cmd.card.private_not_ready', undefined, loc));
      } else if (r.sent === 0) {
        await reply(t('cmd.card.private_failed', undefined, loc));
      } else if (r.sent < r.total) {
        await reply(t('cmd.card.private_partial', { sent: r.sent, total: r.total }, loc));
      }
      return;
    }
    ds.streamingCardForced = true;
    const posted = await postFreshStreamingCard(ds, deps.sessionReply);
    if (!posted) await reply(t('cmd.card.not_ready', undefined, loc));
    return;
  }

  await reply(t('cmd.card.usage', undefined, loc));
}

/**
 * Handle `/term` (operator-only) — the slash-command twin of the "🔑 获取操作链接"
 * card button. Privately hands the operator a writable (token-bearing) terminal
 * card: an in-chat visible-to-you ephemeral card in plain groups, auto-falling back
 * to a DM in topic / p2p chats. The link rides only that private channel — never the
 * group. Gated identically to /card (`canOperate`), and strictly needs a live
 * session whose terminal is up. Routed for both the new-topic path (daemon.ts) and
 * the existing-session switch below.
 */
export async function handleTermLinkCommand(
  rootId: string,
  larkAppId: string,
  chatId: string,
  senderOpenId: string | undefined,
  _content: string,
  deps: CommandHandlerDeps,
): Promise<void> {
  const loc = localeForBot(larkAppId);
  const reply = (c: string) => deps.sessionReply(rootId, c, undefined, larkAppId);

  // /term is an operator command that hands out a *writable* terminal link — gate
  // on canOperate (same model as other daemon commands). senderOpenId must be
  // present: open-mode canOperate passes even an undefined sender, but the writable
  // card is delivered privately to that exact open_id.
  if (!senderOpenId || !canOperate(larkAppId, chatId, senderOpenId)) {
    await reply(t('cmd.term.operator_only', undefined, loc));
    return;
  }

  const ds = deps.activeSessions.get(sessionKey(rootId, larkAppId));
  if (!ds) {
    await reply(t('cmd.term.no_session', undefined, loc));
    return;
  }

  const channel = await deliverWritableTerminalCardTo(ds, senderOpenId);
  if (channel === 'not_ready') {
    await reply(t('cmd.term.not_ready', undefined, loc));
  } else if (channel === 'failed') {
    await reply(t('cmd.term.failed', undefined, loc));
  } else if (channel === 'dm') {
    // The card landed in DM (topic / p2p) — nothing showed in the topic, so drop a
    // visible breadcrumb pointing the owner at their DM. (No token, safe to show.)
    await reply(t('cmd.term.sent_dm', undefined, loc));
  }
  // channel === 'ephemeral': the visible-to-you card IS the response; no extra msg.
}

/** Format a SafeInsightReport into a compact owner-facing summary for the
 *  `/insight` command. Spans are never rendered here — the dashboard Insight tab
 *  owns span detail; the chat card stays a one-glance summary (aggregate + the
 *  severity-sorted rule suggestions, top first). */
function formatInsightCard(report: SafeInsightReport, loc: Locale): string {
  if (report.status === 'unsupported_cli') return t('cmd.insight.unsupported', undefined, loc);
  if (report.status === 'transcript_missing') return t('cmd.insight.no_transcript', undefined, loc);
  if (report.status !== 'ok') return t('cmd.insight.parse_error', undefined, loc);
  const a = report.agg;
  if (a.totalSpans === 0) return t('cmd.insight.no_spans', undefined, loc);
  const icon = (s: string) => (s === 'bad' ? '🔴' : s === 'warn' ? '🟡' : 'ℹ️');
  const header = t('cmd.insight.header', undefined, loc);
  const lines: string[] = [report.meta.asOf ? `${header} · ${report.meta.asOf}` : header];
  lines.push(t('cmd.insight.metrics_line', {
    total: String(a.totalSpans),
    failed: String(a.failedSpans),
    slow: String(a.slowSpans),
    rw: a.readWriteRatio === null ? '—' : String(a.readWriteRatio),
    compactions: String(a.compactions),
  }, loc));
  lines.push('', `${t('cmd.insight.suggestions_label', undefined, loc)}:`);
  for (const s of report.suggestions) {
    lines.push(`${icon(s.severity)} ${s.title} — ${s.action}`);
    if (s.evidence.length) lines.push(`   · ${s.evidence.join('；')}`);
  }
  return lines.join('\n');
}

export async function handleCommand(
  cmd: string,
  rootId: string,
  message: LarkMessage,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const { activeSessions, getActiveCount, lastRepoScan } = deps;
  // Command replies carry the triggering messageId as the turnId so a shared
  // (chat-scope) session triggered from inside a Lark thread anchors them into
  // that thread (resolveSessionReplyTarget turnId gate) instead of leaking a
  // plain top-level message.
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId, message.messageId);
  const ds = larkAppId ? activeSessions.get(sessionKey(rootId, larkAppId)) : undefined;
  const logTag = ds ? tag(ds) : rootId.substring(0, 12);
  const loc: Locale = localeForBot(ds?.larkAppId ?? larkAppId);

  logger.info(`[${logTag}] Command: ${cmd}`);
  logger.debug(`repo command`, message);

  try {
    switch (cmd) {
      case '/close': {
        if (ds) {
          // Capture the closed-session card BEFORE killWorker/closeSession —
          // it reads the live session's identity off `ds`.
          const card = buildClosedSessionCard(ds, loc);
          killWorker(ds);
          sessionStore.closeSession(ds.session.sessionId);
          activeSessions.delete(sessionKey(rootId, larkAppId!));
          // 「会话已关闭」卡片优先「仅自己可见」：普通群里走 ephemeral 只发给执行
          // /close 的本人；话题群不支持 ephemeral(18053) 时回退为正常的群内可见回复
          // ——与流式卡片上「关闭会话」按钮的送达方式保持一致。
          await deliverEphemeralOrReply(
            ds,
            message.senderId,
            card,
            'interactive',
            () => sessionReply(rootId, card, 'interactive'),
          );
          logger.info(`[${logTag}] Session closed by /close command`);
        } else {
          await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
        }
        break;
      }

      case '/insight': {
        if (!ds) {
          await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
          break;
        }
        // owner-only：与 /card /term 同一 operator 门（开放模式下 owner 通过；
        // 仅对话授权的 grantee 不算 operator）。无权限直接不回内容。
        if (!canOperate(larkAppId!, ds.chatId, message.senderId)) {
          await sessionReply(rootId, t('cmd.insight.operator_only', undefined, loc));
          break;
        }
        // 卡片只取 summary（聚合 + 规则建议）；span 明细留给 dashboard Insight tab。
        // buildSafeInsightReport 同步、只读、自带 fail-closed 脱敏，raw 永不进结构。
        const report = buildSafeInsightReport({
          cliId: ds.session.cliId ?? 'unknown',
          sessionId: ds.session.sessionId,
          cliSessionId: ds.session.cliSessionId,
          cwd: ds.session.workingDir,
        }, { detail: 'summary' });
        await sessionReply(rootId, formatInsightCard(report, loc));
        break;
      }

      case '/land': {
        // 把沙盒会话副本里 agent 的改动落回真实仓库。owner 审阅 diff 卡后点「应用到磁盘」。
        // agent 在沙盒里无感（以为改的就是真文件），所以只能由 owner 在此手动触发。
        if (!ds) { await sessionReply(rootId, t('cmd.no_active_session', undefined, loc)); break; }
        const sid = ds.session.sessionId;
        const wd = ds.session.workingDir;
        if (!wd) { await sessionReply(rootId, t('cmd.land.no_workingdir', undefined, loc)); break; }
        const d = computeSandboxDiff(config.session.dataDir, sid, loc);
        if (!d.ok) { await sessionReply(rootId, t('cmd.land.cannot', { error: d.error }, loc)); break; }
        if (d.empty) { await sessionReply(rootId, t('cmd.land.empty', undefined, loc)); break; }
        // In-card preview: cap by lines AND chars (Lark card size limit); the FULL
        // diff goes to an attached .patch file (better for large changesets).
        const MAX_LINES = 60, MAX_CHARS = 4000;
        const allLines = d.patch.split('\n');
        let preview = allLines.slice(0, MAX_LINES).join('\n');
        let truncated = allLines.length > MAX_LINES;
        if (preview.length > MAX_CHARS) { preview = preview.slice(0, MAX_CHARS); truncated = true; }
        // Attach the full .patch (git apply-able) — sent as a file message first,
        // then the review card below it.
        let patchAttached = false;
        if (larkAppId) {
          try {
            const patchName = `botmux-land-${sid.slice(0, 8)}.patch`;
            const patchPath = join(config.session.dataDir, 'sandboxes', sid, patchName);
            writeFileSync(patchPath, d.patch);
            const fileKey = await uploadFile(larkAppId, patchPath);
            await sendMessage(larkAppId, ds.session.chatId, JSON.stringify({ file_key: fileKey }), 'file');
            patchAttached = true;
          } catch (e) { logger.warn(`[${logTag}] /land patch attach failed: ${(e as Error).message}`); }
        }
        const card = buildLandCard({ sessionId: sid, workingDir: wd, statText: d.statText, files: d.files, insertions: d.insertions, deletions: d.deletions, preview, truncated, patchAttached }, loc);
        await sessionReply(rootId, card, 'interactive');
        logger.info(`[${logTag}] /land: ${d.files} files (+${d.insertions}/-${d.deletions}) → card${patchAttached ? ' + .patch' : ''}`);
        break;
      }

      case '/detach':
      case '/disconnect': {
        // 文字版的"⏏ 断开"按钮：仅 adopt 会话适用——botmux 只是观察用户原本在
        // 跑的 CLI，断开只清掉 botmux 这一侧的 worker / polling，绝不结束 CLI
        // 进程本身。等价于 card-handler 里 `actionType === 'disconnect'` 那段。
        if (!ds) {
          await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
          break;
        }
        if (!ds.adoptedFrom) {
          await sessionReply(rootId, t('cmd.detach.not_adopted', undefined, loc));
          break;
        }
        const closedSessionId = ds.session.sessionId;
        killWorker(ds);
        sessionStore.closeSession(closedSessionId);
        activeSessions.delete(sessionKey(rootId, larkAppId!));
        await sessionReply(rootId, t('cmd.detach.success', undefined, loc));
        logger.info(`[${logTag}] Detached (adopt) by ${cmd} command`);
        break;
      }

      case '/restart': {
        if (ds) {
          if (ds.worker && !ds.worker.killed) {
            ds.worker.send({ type: 'restart' } as DaemonToWorker);
            const cliName = getCliDisplayName(getBot(ds.larkAppId).config.cliId);
            await sessionReply(rootId, t('cmd.restart.in_progress', { cliName }, loc));
          } else {
            killWorker(ds);
            const cliName = getCliDisplayName(getBot(ds.larkAppId).config.cliId);
            await sessionReply(rootId, t('cmd.restart.terminated', { cliName }, loc));
          }
          logger.info(`[${logTag}] Restart by /restart command`);
        } else {
          await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
        }
        break;
      }

      case '/cd': {
        const targetPath = message.content.replace(/^\/cd\s*/, '').trim();
        if (!targetPath) {
          await sessionReply(rootId, t('cmd.cd.usage', undefined, loc));
          break;
        }
        if (!ds) {
          await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
          break;
        }
        const validation = validateWorkingDir(targetPath, loc);
        if (!validation.ok) {
          await sessionReply(rootId, validation.error);
          break;
        }
        const resolvedPath = validation.resolvedPath;
        killWorker(ds);
        ds.workingDir = targetPath;
        ds.session.workingDir = targetPath;
        sessionStore.updateSession(ds.session);
        await sessionReply(rootId, t('cmd.cd.switched', { path: resolvedPath }, loc));
        logger.info(`[${logTag}] Working directory changed to ${resolvedPath} by /cd command`);
        break;
      }

      case '/repo': {
        const repoArg = message.content.replace(/^\/repo\s*/, '').trim();

        // First-spawn fork: consume the buffered prompt/attachments and start the
        // CLI in whatever workingDir is currently set on the session. Shared by
        // `commitRepoSelection` (a repo was named) and the bare-`/repo` launch
        // (use the default workingDir) — both only run while `pendingRepo`.
        const forkPendingCli = async (replyText: string) => {
          const selfBot = getBot(ds!.larkAppId);
          const botCfg = selfBot.config;
          const commitGenSessionId = ds!.session.sessionId;
          ds!.pendingRepo = false;
          publishAttentionPatch(ds!);
          const pendingPrompt = ds!.pendingPrompt ?? '';
          const pendingRawInput = ds!.pendingRawInput;
          // Was there an actual buffered user message to deliver? A session
          // launched *via* `/repo` (the command itself is the first message) has
          // none — so boot the CLI idle and let the user's NEXT message be the
          // first prompt, instead of submitting an empty/boilerplate user_message.
          const hasBufferedInput =
            pendingPrompt.trim().length > 0 ||
            (ds!.pendingAttachments?.length ?? 0) > 0 ||
            (ds!.pendingFollowUps?.length ?? 0) > 0;
          if (pendingRawInput) {
            // Messages buffered while the repo card was pending must not be
            // dropped: wrap them now (full prompt-building context lives here)
            // and stash for delivery right after the raw input on prompt_ready.
            if (hasBufferedInput) {
              const { buildNewTopicPrompt, ensureSessionWhiteboard, getAvailableBots } = await import('./session-manager.js');
              ensureSessionWhiteboard(ds!);
              const followUpPrompt = buildNewTopicPrompt(
                pendingPrompt,
                ds!.session.sessionId,
                botCfg.cliId,
                botCfg.cliPathOverride,
                ds!.pendingAttachments,
                ds!.pendingMentions,
                await getAvailableBots(ds!.larkAppId, ds!.chatId),
                ds!.pendingFollowUps,
                { name: selfBot.botName, openId: selfBot.botOpenId },
                loc,
                ds!.pendingSender,
                { larkAppId, chatId: ds!.chatId, whiteboardId: ds!.session.whiteboardId },
              );
              ds!.pendingFollowUpInput = {
                userPrompt: pendingPrompt || (ds!.pendingFollowUps?.join('\n\n') ?? ''),
                cliInput: followUpPrompt,
              };
            }
            rememberLastCliInput(ds!, pendingRawInput, pendingRawInput);
            forkWorker(ds!, '', false);
          } else if (hasBufferedInput) {
            const { buildNewTopicPrompt, ensureSessionWhiteboard, getAvailableBots } = await import('./session-manager.js');
            ensureSessionWhiteboard(ds!);
            const prompt = buildNewTopicPrompt(
              pendingPrompt,
              ds!.session.sessionId,
              botCfg.cliId,
              botCfg.cliPathOverride,
              ds!.pendingAttachments,
              ds!.pendingMentions,
              await getAvailableBots(ds!.larkAppId, ds!.chatId),
              ds!.pendingFollowUps,
              { name: selfBot.botName, openId: selfBot.botOpenId },
              loc,
              ds!.pendingSender,
              { larkAppId, chatId: ds!.chatId, whiteboardId: ds!.session.whiteboardId },
            );
            // Last-line defence: prompt prep awaited above — if anything
            // replaced OR closed the session in that window (`/close` deletes
            // the active-map entry without touching sessionId), forking now
            // would clobber it or resurrect a closed session.
            const stillActive = activeSessions.get(sessionKey(rootId, larkAppId!)) === ds;
            if (!stillActive || ds!.session.sessionId !== commitGenSessionId) {
              logger.warn(`[${logTag}] Session replaced or closed while preparing the pending-CLI prompt (${commitGenSessionId} → ${ds!.session.sessionId}, active=${stillActive}) — aborting this fork`);
              return;
            }
            rememberLastCliInput(ds!, pendingPrompt, prompt);
            forkWorker(ds!, prompt);
          } else {
            // Empty initial prompt → worker spawns the CLI without submitting
            // anything (see worker.ts: the init prompt is only queued when truthy).
            forkWorker(ds!, '', false);
          }
          ds!.pendingPrompt = undefined;
          ds!.pendingAttachments = undefined;
          ds!.pendingMentions = undefined;
          ds!.pendingSender = undefined;
          ds!.pendingFollowUps = undefined;
          await sessionReply(rootId, replyText);
        };

        // Shared commit path for an already-resolved repo: update the session's
        // working dir, then either fork into the pending CLI (first spawn) or
        // close + recreate the session (mid-session switch). Used by both the
        // numeric `/repo <N>` form and the `/repo <path|name>` form.
        const commitRepoSelection = async (selectedPath: string, displayName: string, how: string) => {
          if (ds!.pendingRepo) {
            // First spawn: pin the new cwd onto the CURRENT session, then fork.
            ds!.workingDir = selectedPath;
            ds!.session.workingDir = selectedPath;
            sessionStore.updateSession(ds!.session);
            await forkPendingCli(t('cmd.repo.selected_in_pending', { name: displayName }, loc));
          } else {
            // Safety net: a mid-session `/repo` switch closes the running
            // session and spawns a fresh one on the SAME anchor. Without a
            // trace, the old context silently vanishes (relay/adopt/resume all
            // hit `anchor_occupied` once the new session holds the anchor).
            // So, before displacing it, post the same "session closed" card
            // `/close` emits — it keeps the old session visible and carries the
            // terminal `claude --resume` command. (Its in-card resume button
            // still hits anchor_occupied while the new session occupies this
            // anchor — expected; `/close` the new one first, or use the
            // command.) Mirrors the `/close` case above.
            //
            // The new cwd is NOT written onto the old session here — it would
            // pollute the displaced session's stored workingDir (and the closed
            // card), so `claude --resume` later would reopen the old context in
            // the new repo's cwd. The new repo is pinned onto the fresh session
            // below instead.
            const closedCard = buildClosedSessionCard(ds!, loc);
            killWorker(ds!);
            sessionStore.closeSession(ds!.session.sessionId);
            await deliverEphemeralOrReply(
              ds!,
              message.senderId,
              closedCard,
              'interactive',
              () => sessionReply(rootId, closedCard, 'interactive'),
            );

            const session = sessionStore.createSession(ds!.chatId, rootId, displayName, ds!.chatType);
            ds!.session = session;
            ds!.lastUserPrompt = undefined;
            ds!.lastCliInput = undefined;
            ds!.workingDir = selectedPath;
            ds!.session.workingDir = selectedPath;
            ds!.session.larkAppId = ds!.larkAppId;
            sessionStore.updateSession(ds!.session);
            ds!.hasHistory = false;
            forkWorker(ds!, '', false);
            await sessionReply(rootId, t('cmd.repo.switched_to', { name: displayName }, loc));
          }
          if (ds!.repoCardMessageId) {
            deleteMessage(ds!.larkAppId, ds!.repoCardMessageId);
            ds!.repoCardMessageId = undefined;
          }
          logger.info(`[${logTag}] Repo selected via ${how}: ${selectedPath}`);
        };

        // `/repo wt <N|name|path> [branch]` → create a worktree off the repo's
        // remote default branch and open THAT as the session repo. Without a
        // branch arg the branch/dir are auto-named from the topic title / first
        // pending prompt when possible (fallback: wt/N, <repo>-wt-N).
        if (ds && /^wt(\s|$)/i.test(repoArg)) {
          const rest = repoArg.replace(/^wt\s*/i, '').trim().split(/\s+/).filter(Boolean);
          if (rest.length < 1 || rest.length > 2) {
            await sessionReply(rootId, t('cmd.repo.worktree_usage', undefined, loc));
            break;
          }
          const [targetArg, branchArg] = rest;
          let repoPath: string;
          if (/^\d+$/.test(targetArg!)) {
            const cached = lastRepoScan.get(ds.chatId);
            if (!cached || cached.length === 0) {
              await sessionReply(rootId, t('cmd.repo.no_prior_scan', undefined, loc));
              break;
            }
            const repoIndex = parseInt(targetArg!, 10);
            if (repoIndex < 1 || repoIndex > cached.length) {
              await sessionReply(rootId, t('cmd.repo.index_out_of_range', { max: cached.length }, loc));
              break;
            }
            repoPath = cached[repoIndex - 1]!.path;
          } else {
            const resolved = resolveRepoSelection(targetArg!, getProjectScanDirs(ds));
            if (!resolved) {
              await sessionReply(rootId, t('cmd.repo.path_not_found', { arg: targetArg! }, loc));
              break;
            }
            repoPath = resolved.path;
          }
          if (ds.worktreeCreating) {
            await sessionReply(rootId, t('cmd.repo.worktree_in_progress', undefined, loc));
            break;
          }
          ds.worktreeCreating = true;
          // Session generation snapshot — another selection can land while the
          // (awaited) git fetch runs; committing afterwards would kill the
          // session it just spawned. Mirror of the card-side guard.
          const startSessionId = ds.session.sessionId;
          const wasPending = !!ds.pendingRepo;
          // Identity against the active map catches `/close` (which deletes
          // the entry without touching sessionId/pendingRepo) alongside the
          // generation snapshots.
          const wtSessionChanged = () =>
            activeSessions.get(sessionKey(rootId, larkAppId!)) !== ds ||
            ds!.session.sessionId !== startSessionId || !!ds!.pendingRepo !== wasPending;
          // Hold the in-flight lock through commit (matching the card path) —
          // releasing it right after `git` would let a second `/repo wt` start
          // while this one is still replying/committing.
          try {
            await sessionReply(rootId, t('cmd.repo.worktree_creating', { repo: repoPath }, loc));
            let creation;
            try {
              const slug = branchArg ? undefined : await worktreeSlugFromContextAI(ds!.session.title, ds!.pendingPrompt);
              creation = await createRepoWorktree(repoPath, {
                branch: branchArg,
                slug,
              });
            } catch (e) {
              await sessionReply(rootId, t('cmd.repo.worktree_failed', { error: e instanceof Error ? e.message : String(e) }, loc));
              break;
            }
            if (wtSessionChanged()) {
              logger.info(`[${logTag}] Worktree ${creation.path} created but session changed mid-flight — not switching`);
              await sessionReply(rootId, t('cmd.repo.worktree_created_not_switched', { path: creation.path, branch: creation.branch }, loc));
              break;
            }
            await sessionReply(rootId, t('cmd.repo.worktree_created', {
              path: creation.path, branch: creation.branch, base: creation.baseRef,
            }, loc));
            // The reply above awaited a Lark round-trip — a plain selection
            // (not gated by worktreeCreating) can land in that window. Re-check
            // right before committing. Mirror of the card-side double guard.
            if (wtSessionChanged()) {
              logger.info(`[${logTag}] Worktree ${creation.path} created but session changed during reply — not switching`);
              await sessionReply(rootId, t('cmd.repo.worktree_created_not_switched', { path: creation.path, branch: creation.branch }, loc));
              break;
            }
            try {
              await commitRepoSelection(creation.path, `${basename(creation.path)} (${creation.branch})`, `/repo wt`);
            } catch (e) {
              // The worktree DOES exist — only the switch failed. Don't report
              // it as a creation failure, or a retry trips over "already exists".
              logger.warn(`[${logTag}] Worktree ${creation.path} created but switching failed: ${e instanceof Error ? e.message : e}`);
              await sessionReply(rootId, t('cmd.repo.worktree_switch_failed', { path: creation.path, error: e instanceof Error ? e.message : String(e) }, loc));
            }
          } finally {
            ds.worktreeCreating = false;
          }
          break;
        }

        // Plain selections are blocked while a worktree creation/commit is in
        // flight: the worktree commit awaits (Lark replies, prompt prep) after
        // its generation checks, and a plain selection interleaving there
        // would double-fork. One lock gates both kinds until the commit
        // settles. (Bare `/repo` without pending only posts the picker card —
        // harmless, so it stays open.)
        if (ds?.worktreeCreating && (repoArg || ds.pendingRepo)) {
          await sessionReply(rootId, t('cmd.repo.worktree_in_progress', undefined, loc));
          break;
        }

        // Numeric arg → pick by 1-based index from the last scan.
        if (repoArg && ds && /^\d+$/.test(repoArg)) {
          const repoIndex = parseInt(repoArg, 10);
          const cached = lastRepoScan.get(ds.chatId);
          if (!cached || cached.length === 0) {
            await sessionReply(rootId, t('cmd.repo.no_prior_scan', undefined, loc));
            break;
          }
          if (repoIndex < 1 || repoIndex > cached.length) {
            await sessionReply(rootId, t('cmd.repo.index_out_of_range', { max: cached.length }, loc));
            break;
          }
          const project = cached[repoIndex - 1];
          await commitRepoSelection(project.path, `${project.name} (${project.branch})`, `/repo ${repoIndex}`);
          break;
        }

        // Non-numeric arg → a path (relative/absolute) or first-level project
        // name under workingDir; resolve it directly and skip the card.
        if (repoArg && ds) {
          const resolved = resolveRepoSelection(repoArg, getProjectScanDirs(ds));
          if (!resolved) {
            await sessionReply(rootId, t('cmd.repo.path_not_found', { arg: repoArg }, loc));
            break;
          }
          await commitRepoSelection(resolved.path, resolved.displayName, `/repo ${repoArg}`);
          break;
        }

        // Bare `/repo` while a repo card is pending → launch right away in the
        // default workingDir. This is the text-command twin of the card's
        // "start directly" button (and replaces the old `/skip` command).
        // Mid-session bare `/repo` (no pending) still falls through to the card.
        if (!repoArg && ds?.pendingRepo) {
          // Validate the configured workingDir before spawning — `forkWorker`
          // doesn't, so a dead cwd would otherwise spawn-and-fail silently. Same
          // guard the card path runs below. On failure we keep the pending state
          // so the user can recover with `/repo <valid-path>` (no card here).
          const invalidDirs = invalidConfiguredWorkingDirs(ds, ds.larkAppId ?? larkAppId);
          if (invalidDirs.length > 0) {
            await sessionReply(rootId, t('cmd.repo.working_dir_not_exist', { dirs: invalidDirs.map(d => `\`${d}\``).join(', ') }, loc));
            break;
          }
          const cwd = getSessionWorkingDir(ds);
          await forkPendingCli(t('cmd.skip.opened', { cwd }, loc));
          if (ds.repoCardMessageId) {
            deleteMessage(ds.larkAppId, ds.repoCardMessageId);
            ds.repoCardMessageId = undefined;
          }
          logger.info(`[${logTag}] Bare /repo while pending → launch in workingDir ${cwd}`);
          break;
        }

        if (ds?.worker && !ds.worker.killed) {
          await sessionReply(rootId, t('cmd.repo.warning_running', undefined, loc));
        }

        const scanDirs = getProjectScanDirs(ds);
        const invalidDirs = invalidConfiguredWorkingDirs(ds, ds?.larkAppId ?? larkAppId);
        if (invalidDirs.length > 0) {
          await sessionReply(rootId, t('cmd.repo.working_dir_not_exist', { dirs: invalidDirs.map(d => `\`${d}\``).join(', ') }, loc));
          break;
        }
        const validDirs = scanDirs.filter(d => existsSync(d));
        if (validDirs.length === 0) {
          await sessionReply(rootId, t('cmd.repo.scan_dir_not_exist', { dirs: scanDirs.join(', ') }, loc));
          break;
        }
        const projects = scanMultipleProjects(validDirs, 3, repoPickerScanOptions());
        if (projects.length === 0) {
          await sessionReply(rootId, t('cmd.repo.no_git_repos', { dirs: validDirs.join(', ') }, loc));
          break;
        }
        if (ds) lastRepoScan.set(ds.chatId, projects);
        const currentCwd = getSessionWorkingDir(ds);
        const cardJson = buildRepoSelectCard(projects, currentCwd, rootId, loc, ds ? getBot(ds.larkAppId).config.worktreeMultiPicker : undefined);
        const repoCardMsgId = await sessionReply(rootId, cardJson, 'interactive');
        if (ds) {
          ds.repoCardMessageId = repoCardMsgId;
          announcePendingRepoSession(ds);
        }
        logger.info(`[${logTag}] Sent repo card with ${projects.length} project(s)`);
        break;
      }

      case '/status': {
        if (ds) {
          const alive = ds.worker && !ds.worker.killed;
          const idle = formatUptime(Date.now() - ds.lastMessageAt);
          const termUrl = ds.workerPort ? buildTerminalUrl(ds) : '-';
          const lines = [
            `Session: ${ds.session.sessionId}`,
            `Status: ${alive ? t('cmd.status.running', undefined, loc) : t('cmd.status.waiting', undefined, loc)}`,
            `Terminal: ${termUrl}`,
            `CWD: ${getSessionWorkingDir(ds)}`,
            `${getCliDisplayName(getBot(ds.larkAppId).config.cliId)}: v${ds.cliVersion}${ds.cliVersion !== getCurrentCliVersion() ? ` (latest: v${getCurrentCliVersion()})` : ''}`,
            ...(alive ? [`Uptime: ${formatUptime(Date.now() - ds.spawnedAt)}`] : []),
            `Last message: ${idle} ago`,
            `Active sessions: ${getActiveCount()}`,
          ];
          await sessionReply(rootId, lines.join('\n'));
        } else {
          const fallbackCliName = larkAppId ? getCliDisplayName(getBot(larkAppId).config.cliId) : 'CLI';
          await sessionReply(rootId, t('cmd.status.fallback_no_session', {
            count: getActiveCount(),
            cliName: fallbackCliName,
            version: getCurrentCliVersion(),
          }, loc));
        }
        break;
      }

      case '/schedule': {
        const scheduleArgs = message.content.replace(/^\/schedule\s*/, '');
        const chatId = ds?.chatId!;
        await handleScheduleCommand(scheduleArgs, rootId, chatId, deps, larkAppId);
        logger.info(`[${logTag}] Schedule command handled`);
        break;
      }

      case '/role': {
        const chatId = ds?.chatId;
        if (!chatId || !larkAppId) {
          await sessionReply(rootId, t('role.no_chat', undefined, loc));
          break;
        }
        const roleArgs = message.content.replace(/^\/role\s*/, '');
        await handleRoleCommand(roleArgs, rootId, chatId, larkAppId, message.senderId, deps);
        logger.info(`[${logTag}] Role command handled`);
        break;
      }

      case '/botconfig': {
        const appId = larkAppId ?? ds?.larkAppId;
        if (!appId) {
          await sessionReply(rootId, t('cmd.config.no_bot', undefined, loc));
          break;
        }
        await handleConfigCommand(message, rootId, appId, deps);
        logger.info(`[${logTag}] Config command handled`);
        break;
      }

      case '/skills': {
        const appId = larkAppId ?? ds?.larkAppId;
        if (!appId) {
          await sessionReply(rootId, t('cmd.config.no_bot', undefined, loc));
          break;
        }
        const sub = message.content.replace(/^\/skills\s*/i, '').trim().split(/\s+/, 1)[0]?.toLowerCase();
        if (sub === 'attach' || sub === 'detach') {
          let bot;
          try { bot = getBot(appId); } catch { await sessionReply(rootId, t('cmd.config.no_bot', undefined, loc)); break; }
          const admins = bot.resolvedAllowedUsers ?? [];
          if (admins.length === 0) { await sessionReply(rootId, t('cmd.config.no_owner', undefined, loc)); break; }
          if (!message.senderId || !admins.includes(message.senderId)) { await sessionReply(rootId, t('cmd.config.not_admin', undefined, loc)); break; }
        }
        const result = await runSkillsImCommand(appId, message.content);
        await sessionReply(rootId, result.message);
        logger.info(`[${logTag}] Skills command handled: ${result.ok ? 'ok' : 'error'}`);
        break;
      }

      case '/pair': {
        const code = message.content.replace(/^\/pair\s*/, '').trim();
        if (!larkAppId) { await sessionReply(rootId, t('role.no_chat', undefined, loc)); break; }
        if (!code) { await sessionReply(rootId, t('pair.usage', undefined, loc)); break; }
        // Resolve the sender's canonical union_id (best-effort) so the web
        // session is keyed stably across apps; degrade to open_id-only.
        const who = await resolveUserUnionId(larkAppId, message.senderId);
        const result = claimPairing(config.session.dataDir, code, { openId: message.senderId, unionId: who.unionId, name: who.name, larkAppId });
        if (result.ok) await sessionReply(rootId, t('pair.ok', undefined, loc));
        else if (result.reason === 'expired') await sessionReply(rootId, t('pair.expired', undefined, loc));
        else if (result.reason === 'already_claimed') await sessionReply(rootId, t('pair.already', undefined, loc));
        else await sessionReply(rootId, t('pair.not_found', undefined, loc));
        logger.info(`[${logTag}] Pair command handled: ${result.ok ? 'ok' : result.reason}`);
        break;
      }

      case '/login': {
        const subCmd = message.content.replace(/^\/login\s*/, '').trim();
        // 先定位本 bot 配置——token 状态与 OAuth URL 都按 per-bot appId/brand 走。
        const botCfg2 = ds ? getBot(ds.larkAppId).config : (larkAppId ? getBot(larkAppId).config : getAllBots()[0]?.config);
        if (!botCfg2?.larkAppId || !botCfg2?.larkAppSecret) {
          await sessionReply(rootId, t('cmd.login.no_credentials', undefined, loc));
          break;
        }
        if (subCmd === 'status' || subCmd === '状态') {
          await sessionReply(rootId, getTokenStatus(botCfg2.larkAppId, normalizeBrand(botCfg2.brand)));
          break;
        }
        const { authUrl } = generateAuthUrl(botCfg2.larkAppId, botCfg2.larkAppSecret, normalizeBrand(botCfg2.brand));
        await sessionReply(rootId, [
          t('cmd.login.title', undefined, loc),
          '',
          t('cmd.login.step1', undefined, loc),
          authUrl,
          '',
          t('cmd.login.step2', undefined, loc),
          t('cmd.login.step3', undefined, loc),
          '',
          t('cmd.login.footer', undefined, loc),
          t('cmd.login.status_hint', undefined, loc),
        ].join('\n'));
        break;
      }

      case '/subscribe-lark-doc': {
        if (!ds || !larkAppId) { await sessionReply(rootId, t('cmd.subdoc.no_session', undefined, loc)); break; }
        const arg = message.content.replace(/^\/subscribe-lark-doc\s*/i, '').trim();
        const anchor = sessionAnchorId(ds);
        const dataDir = config.session.dataDir;
        const modeLabel = (m: CommentTriggerMode) =>
          t(m === 'all' ? 'cmd.subdoc.mode_all' : 'cmd.subdoc.mode_mention', undefined, loc);

        if (arg === 'list' || arg === '列表') {
          const subs = listDocSubscriptionsForSession(dataDir, larkAppId, anchor);
          if (!subs.length) { await sessionReply(rootId, t('cmd.subdoc.none', undefined, loc)); break; }
          const lines = subs.map(s => `• ${s.docTitle || s.fileToken}（${modeLabel(s.commentTriggerMode)}）`);
          await sessionReply(rootId, [t('cmd.subdoc.list_title', undefined, loc), ...lines].join('\n'));
          break;
        }

        if (arg === 'off' || arg === 'stop' || arg === '退订') {
          const subs = listDocSubscriptionsForSession(dataDir, larkAppId, anchor);
          for (const s of subs) {
            await unsubscribeDocFile(larkAppId, { fileToken: s.fileToken, fileType: s.fileType });
            removeDocSubscription(dataDir, larkAppId, s.fileToken);
          }
          await sessionReply(rootId, t('cmd.subdoc.unsubscribed', { count: subs.length }, loc));
          break;
        }

        if (!arg) { await sessionReply(rootId, t('cmd.subdoc.usage', undefined, loc)); break; }

        // 评论事件官方推荐用户身份订阅，tenant 订阅大概率收不到推送 → 需要带文档 scope
        // 的 User Token。文档 scope 不在通用 /login 里（避免污染所有 bot 的登录），
        // 这里按需生成带 DOC_COMMENT_OAUTH_SCOPES 的专用授权链接。
        const subCfg = getBot(larkAppId).config;
        const replyDocLogin = async () => {
          const { authUrl } = generateAuthUrl(subCfg.larkAppId, subCfg.larkAppSecret, normalizeBrand(subCfg.brand), DOC_COMMENT_OAUTH_SCOPES);
          await sessionReply(rootId, [
            t('cmd.subdoc.need_login', undefined, loc),
            '',
            t('cmd.login.step1', undefined, loc),
            authUrl,
            '',
            t('cmd.login.step2', undefined, loc),
            t('cmd.login.step3', undefined, loc),
          ].join('\n'));
        };
        const userTok = await resolveUserToken(subCfg.larkAppId, subCfg.larkAppSecret, normalizeBrand(subCfg.brand));
        if (!userTok) { await replyDocLogin(); break; }

        try {
          const file = await resolveDocFile(larkAppId, arg);
          await subscribeDocFile(larkAppId, file);
          const mode: CommentTriggerMode = subCfg.docSubscribeDefaultMode === 'all' ? 'all' : 'mention-only';
          const { previous } = putDocSubscription(dataDir, larkAppId, {
            fileToken: file.fileToken,
            fileType: file.fileType,
            sessionAnchor: anchor,
            sessionId: ds.session.sessionId,
            scope: ds.scope,
            chatId: ds.chatId,
            commentTriggerMode: mode,
            ownerOpenId: message.senderId,
            createdAt: Date.now(),
          });
          const title = file.fileToken.slice(0, 12);
          const rebound = previous && previous.sessionAnchor !== anchor;
          await sessionReply(rootId, t(
            rebound ? 'cmd.subdoc.subscribed_moved' : 'cmd.subdoc.subscribed',
            { title, mode: modeLabel(mode) },
            loc,
          ));
          logger.info(`[${logTag}] /subscribe-lark-doc → ${file.fileType}:${file.fileToken.slice(0, 12)} mode=${mode}${rebound ? ' (rebound)' : ''}`);
        } catch (err) {
          // token 缺失 / 失效 / 缺文档 scope（403）→ 给带文档 scope 的重新授权链接。
          if (err instanceof UserTokenMissingError) {
            await replyDocLogin();
          } else {
            await sessionReply(rootId, t('cmd.subdoc.failed', { err: err instanceof Error ? err.message : String(err) }, loc));
          }
        }
        break;
      }

      case '/adopt': {
        const adoptArgs = message.content.replace(/^\/adopt\s*/i, '').trim();
        if (ds?.adoptedFrom) {
          const adopted = ds.adoptedFrom;
          const cliName = getCliDisplayName(adopted.cliId ?? 'claude-code');
          const project = adopted.cwd ? (adopted.cwd.split('/').pop() || adopted.cwd) : '';
          const label = project ? `${cliName} · ${project}` : cliName;
          await sessionReply(rootId, t('cmd.adopt.already_adopted', { label, pane: adoptTargetLabel(adopted) }, loc));
          break;
        }
        const botCfgForAdopt = ds ? getBot(ds.larkAppId).config : (larkAppId ? getBot(larkAppId).config : undefined);
        if (botCfgForAdopt?.cliId === 'codex-app') {
          if (!ds) {
            await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
            break;
          }
          await handleCodexAppAdoptCommand(adoptArgs, rootId, ds, deps, larkAppId);
          break;
        }

        const botCliId = botCfgForAdopt?.cliId;

        // Discover BOTH tmux AND zellij sessions, regardless of the bot's own
        // backend — a normal tmux bot should still be able to adopt a CLI the
        // user is running inside zellij (and vice-versa). The adopt itself
        // picks the right observe backend from the chosen target.
        // discoverAdoptableZellijSessions returns [] when zellij isn't
        // installed, so this is safe on tmux-only hosts.
        const sessions: Array<AdoptableSession | ZellijAdoptableSession> = [
          ...discoverAdoptableSessions(botCliId),
          ...discoverAdoptableZellijSessions(botCliId),
        ];

        // Second filter: sessions resumable from disk (paseo-style import).
        // Only the bot's OWN CLI is offered (resume needs that CLI's binary).
        const resumable = botCliId
          ? await discoverResumableSessionsForBot(botCliId, botCfgForAdopt?.cliPathOverride, activeSessions)
          : [];

        if (sessions.length === 0 && resumable.length === 0) {
          await sessionReply(rootId, t('cmd.adopt.no_sessions', undefined, loc));
          break;
        }

        const directTarget = adoptArgs;
        if (directTarget) {
          // Match a tmux address ("session:window.pane") OR a zellij target
          // ("session:paneId" / "session/paneId") against the merged list.
          const zellijNorm = directTarget.replace('/', ':');
          const target = sessions.find(s =>
            'zellijPaneId' in s
              ? `${s.zellijSession}:${s.zellijPaneId}` === zellijNorm
              : adoptTargetLabel(s) === directTarget || adoptTargetKey(s) === directTarget || s.tmuxTarget === directTarget || s.herdrPaneId === directTarget,
          );
          if (target) {
            if (ds) await startAdoptSession(target, ds, deps, larkAppId);
            break;
          }
          // Fall back to a resumable session matched by its CLI-native id.
          const resumeTarget = resumable.find(r => r.cliSessionId === directTarget);
          if (resumeTarget) {
            if (ds) await startResumeImportSession(resumeTarget, ds, deps, larkAppId);
            break;
          }
          await sessionReply(rootId, t('cmd.adopt.pane_not_found', { pane: directTarget }, loc));
          break;
        }

        const cardJson = buildAdoptSelectCard(sessions, rootId, loc, resumable);
        await sessionReply(rootId, cardJson, 'interactive');
        break;
      }

      case '/oncall': {
        const args = message.content.replace(/^\/oncall\s*/i, '').trim();
        const [sub, ...rest] = args.length > 0 ? args.split(/\s+/) : [];
        const appId = larkAppId ?? ds?.larkAppId;
        const chatId = ds?.chatId;

        if (!appId || !chatId) {
          await sessionReply(rootId, t('cmd.oncall.need_group', undefined, loc));
          break;
        }

        if (!sub || sub === 'status' || sub === '状态') {
          const entry = getOncallStatus(appId, chatId);
          if (!entry) {
            await sessionReply(rootId, t('cmd.oncall.not_bound', undefined, loc));
          } else {
            await sessionReply(rootId, t('cmd.oncall.bound', { dir: entry.workingDir }, loc));
          }
          break;
        }

        if (sub === 'bind' || sub === '绑定') {
          const target = rest.join(' ').trim();
          if (!target) {
            await sessionReply(rootId, t('cmd.oncall.bind_usage', undefined, loc));
            break;
          }
          const validation = validateWorkingDir(target, loc);
          if (!validation.ok) {
            await sessionReply(rootId, validation.error);
            break;
          }
          const resolvedPath = validation.resolvedPath;
          const result = await bindOncall(appId, chatId, target);
          if (!result.ok) {
            if (result.reason === 'bot_not_in_config') {
              await sessionReply(rootId, t('cmd.oncall.bind_failed_no_bot', undefined, loc));
            } else {
              await sessionReply(rootId, t('cmd.oncall.bind_failed', { reason: result.reason }, loc));
            }
            break;
          }
          const verb = result.created
            ? t('cmd.oncall.verb_bound', undefined, loc)
            : t('cmd.oncall.verb_updated', undefined, loc);
          await sessionReply(rootId, t('cmd.oncall.bind_success', {
            verb,
            chatId,
            target,
            resolved: resolvedPath,
          }, loc));
          logger.info(`[${logTag}] /oncall bind chat=${chatId} dir=${target}`);
          break;
        }

        if (sub === 'unbind' || sub === '解绑') {
          const result = await unbindOncall(appId, chatId);
          if (!result.ok) {
            await sessionReply(rootId, t('cmd.oncall.unbind_failed', { reason: result.reason }, loc));
            break;
          }
          if (!result.wasBound) {
            await sessionReply(rootId, t('cmd.oncall.unbind_not_bound', undefined, loc));
          } else {
            await sessionReply(rootId, t('cmd.oncall.unbind_success', undefined, loc));
          }
          logger.info(`[${logTag}] /oncall unbind chat=${chatId} wasBound=${result.wasBound}`);
          break;
        }

        await sessionReply(rootId, t('cmd.oncall.unknown_sub', { sub }, loc));
        break;
      }

      case '/group':
      case '/g': {
        const creatorAppId = larkAppId ?? ds?.larkAppId;
        if (!creatorAppId) {
          await sessionReply(rootId, t('cmd.group.no_bot', undefined, loc));
          break;
        }

        const senderOpenId = message.senderId;
        if (!senderOpenId) {
          await sessionReply(rootId, t('cmd.group.no_sender', undefined, loc));
          break;
        }

        // Each @-mentioned bot independently receives this same event and reaches
        // this handler, so exactly one must create the group and the rest must
        // stay silent. Intent: pull every @-mentioned bot into a new group, with
        // the FIRST mentioned bot doing the creating.
        //
        // Two distinct sources, each used for what it's reliable at:
        //   • DETECTION ("is this @-mention a bot, and which is first?") uses
        //     globalKnownBotNames() from bots-info.json — process-stable and
        //     complete. getAllBots() can't be used (one daemon per bot ⇒ it only
        //     sees self), and the live roster can transiently miss a bot; either
        //     would let competing processes disagree on the first bot → split
        //     brain. The name set + my own open_id give every process the same
        //     leadership verdict with no API/cross-ref dependency.
        //   • RESOLUTION (bot → larkAppId for the invite) uses the live roster
        //     listChatBotMembers(), failing CLOSED on any miss.
        const mentions = message.mentions ?? [];
        // `/group` runs without a pre-created session (see
        // SESSIONLESS_DAEMON_COMMANDS), so the source chat comes from the
        // message; fall back to the active session when invoked mid-session.
        const sourceChatId = message.chatId ?? ds?.chatId;
        const knownBotNames = globalKnownBotNames();

        // Degraded-state guard: if the user @-mentioned someone but the global bot
        // registry is empty (bots-info.json missing/corrupt/not-yet-written), we
        // can't tell bots from users — so we can't elect a creator. Fail CLOSED
        // rather than fall through to "no bot mentions" → per-bot solo group,
        // which would let every @-mentioned bot create its own group.
        if (knownBotNames.size === 0 && mentions.some(m => !!m.name)) {
          logger.warn(`[${logTag}] /group: global bot registry empty (bots-info.json missing/corrupt); cannot elect a creator`);
          await sessionReply(rootId, t('cmd.group.resolve_failed', undefined, loc));
          break;
        }

        // The @-mentioned bots, in mention order. The first one is the creator.
        const botMentions = mentions.filter(m => m.name && knownBotNames.has(m.name.toLowerCase()));

        // ── Leader election ──────────────────────────────────────────────────
        const mentionedBotAppIds: string[] = [];
        const appIdToName = new Map<string, string>();
        if (botMentions.length > 0) {
          const firstBot = botMentions[0];
          const myOpenId = getBotOpenId(creatorAppId);
          // Am I the first @-mentioned bot? My own open_id is always reliable in
          // my own app scope (Lark reports a bot its own open_id consistently),
          // so this needs no cross-ref. Name fallback only when my open_id isn't
          // probed yet AND my display name is globally unambiguous.
          const myName = getBot(creatorAppId).botName?.toLowerCase();
          const myNameAmbiguous = !!myName && botMentions.filter(m => m.name?.toLowerCase() === myName).length > 1;
          const iAmFirstBot =
            (!!myOpenId && firstBot.openId === myOpenId) ||
            (!myOpenId && !!myName && !myNameAmbiguous && firstBot.name?.toLowerCase() === myName);
          if (!iAmFirstBot) {
            logger.info(`[${logTag}] /group: not the first @-mentioned bot (first="${firstBot.name}"), staying silent`);
            break;
          }
          // I'm the creator. Resolving invitees needs the chat roster — fail
          // CLOSED if it's missing rather than fall through to a per-bot solo
          // group (which would let every mentioned bot create one).
          if (!sourceChatId) {
            logger.warn(`[${logTag}] /group: missing source chatId, cannot resolve @-mentioned bots`);
            await sessionReply(rootId, t('cmd.group.resolve_failed', undefined, loc));
            break;
          }
          let members: Awaited<ReturnType<typeof listChatBotMembers>> = [];
          try {
            members = await listChatBotMembers(creatorAppId, sourceChatId);
          } catch (e: any) {
            logger.warn(`[${logTag}] /group failed to list chat bot members: ${e?.message ?? e}`);
          }
          const memberByOpenId = new Map(members.map(m => [m.openId, m]));
          for (const m of members) {
            if (m.larkAppId && m.displayName) appIdToName.set(m.larkAppId, m.displayName);
          }
          // Resolve each bot mention → larkAppId by open_id (our scope; reliable
          // for distinct bots, and disambiguates duplicate display names), in
          // mention order, deduped. Fail CLOSED on any unresolved bot rather than
          // build a group missing an intended one.
          const seen = new Set<string>();
          let unresolved: string | undefined;
          for (const bm of botMentions) {
            const mem = bm.openId ? memberByOpenId.get(bm.openId) : undefined;
            if (!mem || !mem.larkAppId) { unresolved = bm.name; break; }
            if (!seen.has(mem.larkAppId)) { seen.add(mem.larkAppId); mentionedBotAppIds.push(mem.larkAppId); }
          }
          if (unresolved) {
            logger.warn(`[${logTag}] /group: could not resolve @-mentioned bot "${unresolved}" to an app id; aborting`);
            await sessionReply(rootId, t('cmd.group.resolve_failed', undefined, loc));
            break;
          }
        }

        // Extract the requested group name. Strip whichever alias was used, then
        // remove any `@<name>` mention tokens that leaked into the body (Lark
        // renders mentions as literal `@Name` text in content), then take the
        // first non-blank line so multi-line pastes don't smear into the name.
        let rawArgs = message.content.replace(/^\/(group|g)\s*/i, '');
        for (const m of mentions) {
          if (m.name) rawArgs = rawArgs.split(`@${m.name}`).join(' ');
        }
        let roleProfileId: string | undefined;
        const roleProfileArg = rawArgs.match(/(?:^|\s)--role-profile(?:=|\s+)(\S+)/);
        if (roleProfileArg) {
          if (!isValidRoleProfileId(roleProfileArg[1])) {
            await sessionReply(rootId, t('role.profile.invalid', undefined, loc));
            break;
          }
          roleProfileId = roleProfileArg[1];
          rawArgs = rawArgs.replace(roleProfileArg[0], ' ');
        }
        const firstLine = rawArgs.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? '';
        const MAX_NAME = 50; // Lark group names cap around 60; leave headroom for '…'
        let groupName: string;
        if (firstLine) {
          groupName = firstLine.length > MAX_NAME ? firstLine.slice(0, MAX_NAME) + '…' : firstLine;
        } else {
          const now = new Date();
          const ts = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          groupName = t('cmd.group.empty_fallback', { ts }, loc);
        }

        // Bots to invite: every @-mentioned bot (creator filtered out internally
        // by the service). Empty mentions → solo group (creator only).
        const larkAppIdsForGroup = mentionedBotAppIds.length > 0 ? mentionedBotAppIds : [creatorAppId];

        try {
          const { createGroupWithBots } = await import('../services/group-creator.js');
          const result = await createGroupWithBots({
            creatorLarkAppId: creatorAppId,
            larkAppIds: larkAppIdsForGroup,
            name: groupName,
            userOpenIds: [senderOpenId],
            transferOwnerTo: senderOpenId,
            notifyOwnerOpenId: senderOpenId,
            roleProfileId,
          });
          // Prefer the shareable join link (others can click to *join*); fall
          // back to the member-only applink URL when Lark's link API failed.
          const applink = chatAppLink(result.chatId, normalizeBrand(getBot(creatorAppId).config.brand));
          const link = result.shareLink ?? applink;
          // Partial failures are non-fatal — the chat exists; surface them as
          // hints so the user knows whether to expect to be auto-invited.
          const hints: string[] = [];
          if (result.invalidUserIds.includes(senderOpenId)) {
            hints.push(t('cmd.group.warn_invite_rejected', undefined, loc));
          } else if (result.transferError) {
            hints.push(t('cmd.group.warn_transfer_failed', { reason: result.transferError }, loc));
          }
          // Share-link fetch failed → the displayed link is the member-only
          // applink; warn the user so they don't expect non-members to join via it.
          if (!result.shareLink && result.shareLinkError) {
            logger.warn(`[${logTag}] /group share-link unavailable, using applink: ${result.shareLinkError}`);
            hints.push(t('cmd.group.warn_share_link_failed', undefined, loc));
          }
          // List every bot in the new group (creator included), and warn about
          // any Feishu rejected. Names come from the chat roster (members) since
          // getBot() only knows this process's own bot in the one-daemon-per-bot
          // model; fall back to the registry/raw id for anything not in the map.
          const nameOf = (id: string) => appIdToName.get(id) ?? botDisplayName(id);
          const groupBotIds = larkAppIdsForGroup.filter(id => !result.invalidBotIds.includes(id));
          if (groupBotIds.length > 1) {
            hints.push(t('cmd.group.bots_invited', { bots: groupBotIds.map(nameOf).join('、') }, loc));
          }
          if (result.invalidBotIds.length > 0) {
            hints.push(t('cmd.group.warn_bots_rejected', { bots: result.invalidBotIds.map(nameOf).join('、') }, loc));
          }
          if (roleProfileId) {
            if (result.roleProfileBootstrapError) {
              hints.push(t('cmd.group.role_profile_bootstrap_failed', { profile: roleProfileId, reason: result.roleProfileBootstrapError ?? 'unknown' }, loc));
            } else {
              hints.push(t('cmd.group.role_profile_bootstrap_sent', { profile: roleProfileId }, loc));
            }
          }
          const hintsText = hints.length > 0 ? '\n' + hints.join('\n') : '';
          await sessionReply(rootId, t('cmd.group.created', { name: groupName, link, hints: hintsText }, loc));
          logger.info(`[${logTag}] /group created chat=${result.chatId} name="${groupName}" bots=[${larkAppIdsForGroup.join(',')}] invitee=${senderOpenId}`);
          // Intentionally NO auto-bootstrap (repo-select card / chat-scope
          // session) here: the group name rarely carries enough context to seed
          // a useful prompt. The user starts a real conversation with the bot in
          // the new group, which spawns the session on first message.
        } catch (err: any) {
          logger.error(`[${logTag}] /group failed: ${err?.message ?? err}`);
          await sessionReply(rootId, t('cmd.group.failed', { error: err?.message ?? String(err) }, loc));
        }
        break;
      }

      /**
       * `/relay --create <群名> @bot [@bot...]` — create a new chat, invite
       * the @-mentioned bots, then migrate every bot's session in this
       * thread (including the leader's) into the new chat.
       *
       * Two-path command:
       *   • `--create` (PR2) — implemented below; creates a new chat.
       *   • no flag (PR3)    — picker card listing user's relayable sessions
       *                         in OTHER chats so the user can pull one into
       *                         the current chat. Stubbed for now.
       *
       * Leader election is `mentions[0]` (identical to /group). The leader
       * is the only daemon that:
       *   1. Creates the new chat (createGroupWithBots)
       *   2. Sends the M1 announcement message (its message_id becomes the
       *      shared rootMessageId for all relayed sessions — multi-bot
       *      sessions co-anchor on the same root via different larkAppIds)
       *   3. Transfers its own session (if any) via local transferSession()
       *   4. POSTs /api/sessions/migrate-to-chat to every peer daemon to
       *      ask them to transfer their own session at the same anchor
       *   5. Aggregates results into a single reply in the source thread
       *
       * Owner-only: only the source session's `ownerOpenId` may invoke. Peers
       * enforce the same check independently inside the migrate endpoint.
       *
       * Failure mode: best-effort, no rollback. Peers that timeout / fail /
       * are offline simply appear in the report as "skipped". The new chat
       * and any successful transfers stand.
       */
      case '/relay': {
        const argsLine = message.content.replace(/^\/relay\s*/i, '').trim();
        if (!/^--create\b/i.test(argsLine)) {
          // ── Pull picker ───────────────────────────────────────────────────
          // /relay (no flag) lives in the *target* chat — list the operator's
          // own active sessions in OTHER chats so they can pull one in.
          //
          // Filter:
          //   • same bot (this larkAppId)
          //   • session is active (has a worker / appears in activeSessions)
          //   • session NOT in the current chat (can't relay to yourself)
          //   • operator IS the session owner (owner-only access)
          //
          // The button's `target_chat_id` / `target_root_id` are the chat we're
          // pulling INTO (the chat hosting this command). card-handler uses
          // them to invoke transferSession after sending the M1 announcement.
          const operatorOpenId = message.senderId;
          if (!operatorOpenId) {
            await sessionReply(rootId, t('cmd.relay.no_sender', undefined, loc));
            break;
          }
          const myAppId = larkAppId ?? ds?.larkAppId;
          if (!myAppId) {
            await sessionReply(rootId, t('cmd.group.no_bot', undefined, loc));
            break;
          }
          const targetChatId = ds?.chatId;
          if (!targetChatId) {
            await sessionReply(rootId, t('cmd.relay.no_session', undefined, loc));
            break;
          }
          // ── Target-routing resolution ─────────────────────────────────────
          // Resolve the chat mode once, then compute WHERE the relayed session
          // should land via resolveRelayTargetRouting (mirrors decideRouting;
          // 话题群 / 线程内 / 普通群 new-topic·shared → thread-scope, 普通群
          // flat → chat-scope; DM 扁平(p2pMode chat) → chat-scope, DM 话题模式
          // → thread-scope seeded on the /relay message).
          // p2p is authoritative from `ds.chatType` (recorded off the Lark
          // event payload — doesn't drift, and the API's safe-default 'group'
          // on failure would misclassify a DM); only group chats need the API
          // call to split topic-vs-regular (both record chatType 'group').
          const targetIsP2p = ds?.chatType === 'p2p';
          const targetChatType: 'group' | 'p2p' = targetIsP2p ? 'p2p' : 'group';
          let targetChatMode: 'group' | 'topic' | 'p2p' = 'p2p';
          if (!targetIsP2p) {
            const { getChatNameAndMode } = await import('../im/lark/client.js');
            const info = await getChatNameAndMode(myAppId, targetChatId).catch(() => null);
            targetChatMode = info?.mode ?? 'group';
          }
          const { resolveRelayTargetRouting } = await import('../im/lark/relay-target-routing.js');
          const targetRouting = resolveRelayTargetRouting({
            larkAppId: myAppId,
            chatId: targetChatId,
            message: { messageId: message.messageId, rootId: message.rootId || undefined, threadId: message.threadId },
            chatMode: targetChatMode,
          });
          const targetScope = targetRouting.scope;
          const targetAnchor = targetRouting.anchor;
          // ── Existing-session guard (anchor-based) ─────────────────────────
          // A real session already sitting AT the target anchor would collide
          // on sessionKey(targetAnchor, larkAppId) after transfer — Map.set
          // would orphan its worker. Scratch placeholders (worker:null, e.g.
          // the /relay command's own record at this anchor) are NOT a conflict;
          // transferSession closes them inline. We do NOT exclude `ds`: if
          // /relay rides an existing real session at the anchor, `ds` itself IS
          // the conflict. Anchor-based so同群 other-topic sessions (different
          // anchor) don't false-positive — that's what enables 同群话题间搬运.
          const conflict = [...activeSessions.values()].find(c =>
            c.larkAppId === myAppId
            && sessionAnchorId(c) === targetAnchor
            && !!c.worker   // real running session, not a placeholder
          );
          if (conflict) {
            await sessionReply(rootId, t('cmd.relay.target_has_session', { title: conflict.session.title || conflict.session.sessionId.substring(0, 8) }, loc));
            break;
          }
          // Shared candidate-collection logic — used here at initial render
          // and again in card-handler when the user clicks a card to switch
          // selection (the card re-render needs the same filtered list).
          // Excludes (by anchor) the target itself; keeps cross-group + 同群
          // other-topic sessions. Resolves friendly chat names + modes.
          const { collectRelayPickerEntries } = await import('../services/relay-picker.js');
          const entries = await collectRelayPickerEntries(activeSessions, myAppId, targetAnchor, operatorOpenId);
          const { buildRelayPickerCard } = await import('../im/lark/card-builder.js');
          const card = buildRelayPickerCard(entries, targetChatId, targetAnchor, operatorOpenId, loc, undefined, targetScope, targetChatType);
          await sessionReply(rootId, card, 'interactive');
          break;
        }
        const afterFlag = argsLine.replace(/^--create\s*/i, '').trim();

        const creatorAppId = larkAppId ?? ds?.larkAppId;
        if (!creatorAppId) {
          await sessionReply(rootId, t('cmd.group.no_bot', undefined, loc));
          break;
        }
        const senderOpenId = message.senderId;
        // Cross-app stable identity — peer daemons can't compare against
        // leader's open_id directly because the same user has a different
        // open_id in each bot's namespace. union_id is shared per tenant.
        // We pass it through the migrate-to-chat HTTP body; peers compare
        // against their session's `ownerUnionId` (with fallback to
        // open_id for sessions persisted before this field existed).
        const senderUnionId = message.senderUnionId;
        if (!senderOpenId) {
          await sessionReply(rootId, t('cmd.relay.no_sender', undefined, loc));
          break;
        }
        // `--create` must be invoked inside an existing thread — the source
        // anchor for peer transfers comes from `ds`. (Picker mode in PR3 is
        // allowed without a session.)
        if (!ds) {
          await sessionReply(rootId, t('cmd.relay.no_session', undefined, loc));
          break;
        }

        // Front-loaded guards — transferSession refuses adoptedFrom /
        // pendingRepo too, but only after createGroupWithBots has already
        // built a new chat. Failing here keeps relay clean and avoids
        // orphan-chat garbage when the operation can't possibly succeed.
        if (ds.session.adoptedFrom) {
          await sessionReply(rootId, t('cmd.relay.adopt_not_relayable', undefined, loc));
          break;
        }
        if (ds.pendingRepo) {
          await sessionReply(rootId, t('cmd.relay.not_started_yet', undefined, loc));
          break;
        }

        // ── Mention parsing & leader election (mirror of /group) ───────────
        const mentions = message.mentions ?? [];
        const knownBotNames = globalKnownBotNames();
        if (knownBotNames.size === 0 && mentions.some(m => !!m.name)) {
          logger.warn(`[${logTag}] /relay --create: global bot registry empty; cannot elect a creator`);
          await sessionReply(rootId, t('cmd.relay.resolve_failed', undefined, loc));
          break;
        }
        const botMentions = mentions.filter(m => m.name && knownBotNames.has(m.name.toLowerCase()));
        if (botMentions.length === 0) {
          await sessionReply(rootId, t('cmd.relay.no_mentions', undefined, loc));
          break;
        }

        // Am I `mentions[0]`?
        const firstBot = botMentions[0];
        const myOpenId = getBotOpenId(creatorAppId);
        const myName = getBot(creatorAppId).botName?.toLowerCase();
        const myNameAmbiguous = !!myName
          && botMentions.filter(m => m.name?.toLowerCase() === myName).length > 1;
        const iAmFirstBot =
          (!!myOpenId && firstBot.openId === myOpenId) ||
          (!myOpenId && !!myName && !myNameAmbiguous && firstBot.name?.toLowerCase() === myName);
        if (!iAmFirstBot) {
          logger.info(`[${logTag}] /relay --create: not the first @-mentioned bot, staying silent`);
          break;
        }

        // Owner-only — only the source session owner may relay this session.
        if (ds.session.ownerOpenId && ds.session.ownerOpenId !== senderOpenId) {
          await sessionReply(rootId, t('cmd.relay.not_owner', undefined, loc));
          break;
        }

        // ── Resolve @-bots to larkAppIds via the source chat's bot roster ──
        const sourceChatId = ds.chatId;
        let members: Awaited<ReturnType<typeof listChatBotMembers>> = [];
        try {
          members = await listChatBotMembers(creatorAppId, sourceChatId);
        } catch (e: any) {
          logger.warn(`[${logTag}] /relay --create: failed to list source chat members: ${e?.message ?? e}`);
        }
        const memberByOpenId = new Map(members.map(m => [m.openId, m]));
        const appIdToName = new Map<string, string>();
        for (const m of members) {
          if (m.larkAppId && m.displayName) appIdToName.set(m.larkAppId, m.displayName);
        }
        const mentionedBotAppIds: string[] = [];
        const seenApp = new Set<string>();
        let unresolved: string | undefined;
        for (const bm of botMentions) {
          const mem = bm.openId ? memberByOpenId.get(bm.openId) : undefined;
          if (!mem || !mem.larkAppId) { unresolved = bm.name; break; }
          if (!seenApp.has(mem.larkAppId)) {
            seenApp.add(mem.larkAppId);
            mentionedBotAppIds.push(mem.larkAppId);
          }
        }
        if (unresolved) {
          logger.warn(`[${logTag}] /relay --create: unresolved bot "${unresolved}"`);
          await sessionReply(rootId, t('cmd.relay.resolve_failed', undefined, loc));
          break;
        }

        // ── Group name extraction (mirror of /group) ───────────────────────
        let rawArgs = afterFlag;
        for (const m of mentions) {
          if (m.name) rawArgs = rawArgs.split(`@${m.name}`).join(' ');
        }
        const firstLine = rawArgs.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? '';
        const MAX_NAME = 50;
        let groupName: string;
        if (firstLine) {
          groupName = firstLine.length > MAX_NAME ? firstLine.slice(0, MAX_NAME) + '…' : firstLine;
        } else {
          const now = new Date();
          const ts = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          groupName = t('cmd.relay.empty_group_name', { ts }, loc);
        }

        // ── Create the new chat ────────────────────────────────────────────
        const nameOf = (id: string) => appIdToName.get(id) ?? botDisplayName(id);
        let newChatId: string;
        let inviteLink: string;
        try {
          const { createGroupWithBots } = await import('../services/group-creator.js');
          const result = await createGroupWithBots({
            creatorLarkAppId: creatorAppId,
            larkAppIds: mentionedBotAppIds,
            name: groupName,
            userOpenIds: [senderOpenId],
            transferOwnerTo: senderOpenId,
          });
          newChatId = result.chatId;
          const applink = chatAppLink(result.chatId, normalizeBrand(getBot(creatorAppId).config.brand));
          inviteLink = result.shareLink ?? applink;
        } catch (err: any) {
          logger.error(`[${logTag}] /relay --create: createGroup failed: ${err?.message ?? err}`);
          await sessionReply(rootId, t('cmd.relay.failed', { error: err?.message ?? String(err) }, loc));
          break;
        }

        // Snapshot the pre-transfer source anchor — peers locate their own
        // session by this value, and `transferSession()` will overwrite
        // `ds.session.rootMessageId` once it runs. Must capture BEFORE the
        // leader transfer call (caught in review).
        const sourceAnchor = ds.session.rootMessageId;

        // ── M1 deferred: post the announcement AFTER all transfers settle ──
        // Previous flow sent an optimistic "已接力" M1 before running any
        // transfer. When leader/peers later failed, that M1 was a lie — and
        // the --create path had no orphan-cleanup (picker path did).
        //
        // New flow: pass `newChatId` as a placeholder for targetRootMessageId
        // into transferSession. Chat-scope routing ignores rootMessageId
        // (worker-pool transferSession only stores it for audit/UX), so the
        // placeholder doesn't break routing. Once all outcomes are in, we
        // post the real M1 with success/failure breakdown, then patch the
        // leader's session.rootMessageId to that final M1 id. Peer sessions
        // keep newChatId as a cosmetic placeholder — fixing them would
        // require another round-trip; chat-scope doesn't actually care.
        const placeholderRootMessageId = newChatId;

        // Resolve friendly source-chat label for the M1 body — falls back to
        // raw chatId if Lark can't return a name. Mirrors picker-path
        // (card-handler.ts:341) so the message reads the same in both UX
        // entry points.
        const { getChatName } = await import('../im/lark/client.js');
        const sourceLabel = (await getChatName(creatorAppId, sourceChatId).catch(() => null)) ?? sourceChatId;

        // ── Step 1: leader transfers its own session (if any) ───────────────
        // Empty-leader handling: daemon auto-creates a placeholder ds for any
        // DAEMON_COMMAND (worker:null + hasHistory:false). If the user typed
        // `/relay --create` in a chat where they never actually chatted with
        // the bot, ds IS that placeholder — there's no real session to
        // migrate. Pre-Codex-review we'd happily transferSession the empty
        // shell and report "已就绪：leader" as a lie. Now we detect this,
        // skip transferSession, mark leader as `no_session`, and close the
        // scratch so it doesn't linger as a ghost.
        //
        // The new chat is still created (createGroupWithBots already ran
        // above) — that itself is a valuable product outcome since the
        // mentioned bots were invited. Peers continue through their normal
        // path; the final M1 template adapts to "all_fresh" when no bot
        // actually had a session to bring along.
        const reportLines: string[] = [];
        const leaderName = nameOf(creatorAppId);
        const successBotNames: string[] = [];
        const failedBotNames: string[] = [];
        // Use the persisted-marker predicate, not runtime ds.hasHistory:
        // restoreActiveSessions sets hasHistory:true UNCONDITIONALLY on
        // restart (session-manager.ts:618), so a scratch that survives a
        // restart comes back with hasHistory:true and would defeat a
        // naive `!!ds.worker || ds.hasHistory` check. cliId / lastCliInput
        // are only written after a real worker started the CLI, so they
        // survive restart correctly.
        const { isRelayableRealSession } = await import('./worker-pool.js');
        const leaderHasRealSession = isRelayableRealSession(ds);
        if (leaderHasRealSession) {
          const { transferSession } = await import('./worker-pool.js');
          // Target chat was just built by createGroupWithBots — by
          // construction a regular group, chat-scope.
          const leaderResult = await transferSession(ds.session.sessionId, newChatId, placeholderRootMessageId, 'group', 'chat');
          if (!leaderResult.ok) {
            // Real session, real failure (worker busy / unsupported target
            // / tmux issue). Abort the entire --create flow — the new chat
            // exists but is empty of any migrated session; we don't post
            // an M1 because there's nothing to announce.
            reportLines.push(t('cmd.relay.report_leader_failed', { bot: leaderName, error: leaderResult.error }, loc));
            await sessionReply(rootId, t('cmd.relay.created', { name: groupName, link: inviteLink, report: reportLines.join('\n') }, loc));
            break;
          }
          reportLines.push(t('cmd.relay.report_leader_ok', { bot: leaderName }, loc));
          successBotNames.push(leaderName);
        } else {
          // Empty leader: no real session to migrate.
          reportLines.push(t('cmd.relay.report_leader_no_session', { bot: leaderName }, loc));
          failedBotNames.push(leaderName);
          // Close the daemon-command scratch so it doesn't linger as a
          // ghost active row at the source anchor (same hygiene that
          // transferSession's pre-flight applies to target-chat scratches).
          const { closeSession } = await import('./worker-pool.js');
          await closeSession(ds.session.sessionId).catch(err => {
            logger.warn(`[${logTag}] /relay --create: failed to close empty-leader scratch: ${err instanceof Error ? err.message : err}`);
          });
        }

        // ── Step 2: coordinate peer daemons (parallel) ─────────────────────
        const { findOnlineDaemon } = await import('../utils/daemon-discovery.js');
        const peerAppIds = mentionedBotAppIds.filter(id => id !== creatorAppId);
        const peerOutcomes = await Promise.all(peerAppIds.map(async (peerAppId) => {
          const botName = nameOf(peerAppId);
          const daemon = findOnlineDaemon(peerAppId);
          if (!daemon) return { peerAppId, botName, status: 'offline' as const };
          try {
            const ctrl = new AbortController();
            const tt = setTimeout(() => ctrl.abort(), 5000);
            const res = await fetch(
              `http://127.0.0.1:${daemon.ipcPort}/api/sessions/migrate-to-chat`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  sourceAnchor,
                  targetChatId: newChatId,
                  targetRootMessageId: placeholderRootMessageId,
                  requesterLarkAppId: creatorAppId,
                  requestingUserOpenId: senderOpenId,
                  // union_id is cross-app stable within a tenant — peer
                  // compares against its own session.ownerUnionId rather
                  // than translating open_ids per bot. Optional for
                  // backward compat with daemons older than this commit.
                  requestingUserUnionId: senderUnionId,
                }),
                signal: ctrl.signal,
              },
            ).finally(() => clearTimeout(tt));
            const body = await res.json().catch(() => ({} as any));
            if (res.ok && body.ok) return { peerAppId, botName, status: 'ok' as const };
            if (body.error === 'no_session_at_anchor') return { peerAppId, botName, status: 'no_session' as const };
            if (body.error === 'not_session_owner') return { peerAppId, botName, status: 'not_owner' as const };
            if (body.error === 'worker_busy') return { peerAppId, botName, status: 'busy' as const };
            return { peerAppId, botName, status: 'failed' as const, error: body.error ?? `http_${res.status}` };
          } catch (err: any) {
            const reason = err?.name === 'AbortError' ? 'busy' : 'failed';
            return { peerAppId, botName, status: reason as 'busy' | 'failed', error: err?.message ?? String(err) };
          }
        }));

        // Bucket peer outcomes for the final M1 (success / failure) AND extend the
        // source-chat report with per-peer detail. Leader was already bucketed
        // above (real-success → successBotNames; real-fail or empty-leader →
        // failedBotNames), so we only iterate peers here.
        for (const r of peerOutcomes) {
          if (r.status === 'ok') {
            successBotNames.push(r.botName);
            reportLines.push(t('cmd.relay.report_peer_ok', { bot: r.botName }, loc));
          } else {
            failedBotNames.push(r.botName);
            switch (r.status) {
              case 'no_session': reportLines.push(t('cmd.relay.report_peer_no_session', { bot: r.botName },                             loc)); break;
              case 'not_owner':  reportLines.push(t('cmd.relay.report_peer_not_owner',  { bot: r.botName },                             loc)); break;
              case 'offline':    reportLines.push(t('cmd.relay.report_peer_offline',    { bot: r.botName },                             loc)); break;
              case 'busy':       reportLines.push(t('cmd.relay.report_peer_busy',       { bot: r.botName },                             loc)); break;
              case 'failed':     reportLines.push(t('cmd.relay.report_peer_failed',     { bot: r.botName, error: r.error ?? 'unknown' }, loc)); break;
            }
          }
        }

        // ── Step 3: post the real M1 with status breakdown ─────────────────
        // Three templates:
        //   - all_ok      : every bot migrated cleanly
        //   - partial     : some migrated, some didn't (failed list explains)
        //   - all_fresh   : nobody had a session to migrate (group's still
        //                   useful — bots were invited; user just @s to start)
        // Pass the raw text — sendMessage wraps `'text'` msgType bodies into
        // { text: content } itself.
        let finalM1Text: string;
        if (successBotNames.length === 0) {
          finalM1Text = t('cmd.relay.m1_final_all_fresh', { sourceChat: sourceLabel }, loc);
        } else if (failedBotNames.length === 0) {
          finalM1Text = t('cmd.relay.m1_final_all_ok', {
            sourceChat: sourceLabel,
            successBots: successBotNames.join('、'),
          }, loc);
        } else {
          finalM1Text = t('cmd.relay.m1_final_partial', {
            sourceChat: sourceLabel,
            successBots: successBotNames.join('、'),
            failedBots: failedBotNames.join('、'),
          }, loc);
        }
        try {
          const finalM1Id = await sendMessage(creatorAppId, newChatId, finalM1Text, 'text');
          // Patch the leader's session.rootMessageId to the real M1 id, but
          // only if the leader was actually transferred — for the empty-
          // leader / all_fresh path, ds was either closed or never moved,
          // so we don't touch it (would write to a closed/stale record).
          if (leaderHasRealSession && successBotNames.includes(leaderName)) {
            ds.session.rootMessageId = finalM1Id;
            sessionStore.updateSession(ds.session);
          }
        } catch (err: any) {
          // Non-fatal: transfers already succeeded. The source-chat report
          // (sessionReply below) is the user's authoritative status.
          logger.warn(`[${logTag}] /relay --create: final M1 send failed: ${err?.message ?? err}`);
        }

        await sessionReply(rootId, t('cmd.relay.created', { name: groupName, link: inviteLink, report: reportLines.join('\n') }, loc));
        logger.info(`[${logTag}] /relay --create completed: chat=${newChatId} leader=${creatorAppId} peers=[${peerAppIds.join(',')}]`);
        break;
      }

      case '/card': {
        // Existing-session path. New topics route /card via handleCardCommand at
        // the router (so no phantom session is created). off/on work without a
        // live worker; show/bare summons a card.
        const appId = ds?.larkAppId ?? larkAppId;
        const cardChatId = ds?.chatId;
        if (!appId || !cardChatId) {
          await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
          break;
        }
        await handleCardCommand(rootId, appId, cardChatId, message.senderId, message.content, deps);
        break;
      }

      case '/term': {
        // Existing-session path. New topics route /term via handleTermLinkCommand
        // at the router (daemon.ts) so no phantom worker=null session is created.
        const appId = ds?.larkAppId ?? larkAppId;
        if (!appId) {
          await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
          break;
        }
        await handleTermLinkCommand(rootId, appId, ds?.chatId ?? '', message.senderId, message.content, deps);
        break;
      }

      case '/list-slash-command':
      case '/slash': {
        // 列出本 bot 当前可用的 slash 命令，分四段：
        //   ① botmux 固定放行的透传白名单（PASSTHROUGH_COMMANDS）
        //   ② 当前 CLI adapter 默认透传命令（defaultPassthroughCommands）
        //   ③ 用户在 bots.json 自定义配置的额外透传命令（customPassthroughCommands）
        //   ④ 文件系统自动发现的 CLI 自定义命令 / skill / 插件
        // MCP 的 /mcp__<server>__<prompt> 需运行时握手才能枚举，这里仅按 .mcp.json 提示 server 名。
        const botCfg = ds
          ? getBot(ds.larkAppId).config
          : (larkAppId ? getBot(larkAppId).config : getAllBots()[0]?.config);
        const cliId = botCfg?.cliId ?? 'claude-code';
        const cliName = getCliDisplayName(cliId);
        const workingDir = getSessionWorkingDir(ds);
        const builtin = [...PASSTHROUGH_COMMANDS];
        const adapterDefaults = resolveAdapterDefaultPassthroughCommands(larkAppId);
        // 只展示「实际生效」的 custom 命令：用与 resolvePassthroughCommands 同一套
        // normalize 过滤掉手写 bots.json 里遮蔽 daemon 命令 / 非法的项（parser 出于
        // 兼容会保留它们，但路由会丢弃），避免 `/status` 之类被展示成可用却走 daemon。
        const custom = [...new Set(
          (botCfg?.customPassthroughCommands ?? [])
            .map(normalizePassthroughCommand)
            .filter((c): c is string => !!c),
        )];
        let cliAdapter;
        try {
          cliAdapter = createCliAdapterSync(cliId, botCfg?.cliPathOverride);
        } catch (err) {
          logger.warn(`[${logTag}] /list-slash-command could not create adapter for ${cliId}: ${err instanceof Error ? err.message : String(err)}`);
        }
        const discoverySupported = supportsFilesystemCommandDiscovery(cliAdapter);
        const discovered = cliAdapter && discoverySupported
          ? discoverSlashCommandsForAdapter(workingDir, cliAdapter)
          : [];
        const mcpServers = listMcpServerNames(workingDir);

        const card = buildSlashListCard(
          { cliName, builtin, adapterDefaults, custom, discovered, workingDir, mcpServers, discoverySupported },
          loc,
        );
        await sessionReply(rootId, card, 'interactive');
        logger.info(`[${logTag}] /list-slash-command builtin=${builtin.length} custom=${custom.length} discovered=${discovered.length}`);
        break;
      }

      case '/help': {
        const botCfg = ds ? getBot(ds.larkAppId).config : getAllBots()[0]?.config;
        const cliName = getCliDisplayName(botCfg?.cliId ?? 'claude-code');
        const help = [
          t('help.heading_session', undefined, loc),
          t('help.close', { cliName }, loc),
          t('help.restart', { cliName }, loc),
          t('help.cd', { cliName }, loc),
          t('help.repo_list', undefined, loc),
          t('help.repo_n', undefined, loc),
          t('help.repo_path', undefined, loc),
          t('help.repo_wt', undefined, loc),
          t('help.status', undefined, loc),
          t('help.card', undefined, loc),
          t('help.term', undefined, loc),
          t('help.subscribe_doc', undefined, loc),
          '',
          t('help.heading_passthrough', { cliName }, loc),
          // 直接从集合渲染，保证文案与 PASSTHROUGH_COMMANDS 不漂移
          [...PASSTHROUGH_COMMANDS].join(' '),
          '',
          t('help.heading_schedule', undefined, loc),
          t('help.schedule_create', undefined, loc),
          t('help.schedule_list', undefined, loc),
          t('help.schedule_remove', undefined, loc),
          t('help.schedule_toggle', undefined, loc),
          t('help.schedule_run', undefined, loc),
          '',
          t('help.schedule_formats', undefined, loc),
          '',
          t('help.heading_adopt', undefined, loc),
          t('help.adopt', undefined, loc),
          t('help.adopt_pane', undefined, loc),
          t('help.detach', undefined, loc),
          '',
          t('help.heading_login', undefined, loc),
          t('help.login', undefined, loc),
          t('help.login_status', undefined, loc),
          '',
          t('help.heading_oncall', undefined, loc),
          t('help.oncall_bind', undefined, loc),
          t('help.oncall_unbind', undefined, loc),
          t('help.oncall_status', undefined, loc),
          '',
          t('help.heading_grant', undefined, loc),
          t('help.grant', undefined, loc),
          t('help.revoke', undefined, loc),
          '',
          t('help.heading_config', undefined, loc),
          t('help.config_get', undefined, loc),
          t('help.config_set', undefined, loc),
          '',
          t('help.heading_group', undefined, loc),
          t('help.group', undefined, loc),
          '',
          t('help.list_slash', undefined, loc),
          t('help.help', undefined, loc),
        ];
        await sessionReply(rootId, help.join('\n'));
        break;
      }
    }
  } catch (err: any) {
    logger.error(`[${logTag}] Command ${cmd} error: ${err.message}`);
  }
}

async function handleCodexAppAdoptCommand(
  args: string,
  rootId: string,
  ds: DaemonSession,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const loc: Locale = localeForBot(ds.larkAppId ?? larkAppId);
  const botCfg = getBot(ds.larkAppId).config;

  let threads: CodexAppThreadSummary[];
  try {
    threads = await listCodexAppThreads({
      codexBin: botCfg.cliPathOverride,
      cwd: getSessionWorkingDir(ds),
      limit: 50,
    });
  } catch (err: any) {
    await sessionReply(rootId, t('cmd.codex_app_adopt.list_failed', { error: err?.message ?? String(err) }, loc));
    return;
  }

  if (threads.length === 0) {
    await sessionReply(rootId, t('cmd.codex_app_adopt.no_threads', undefined, loc));
    return;
  }

  if (args) {
    const target = threads.find(t => t.threadId === args || t.threadId.startsWith(args));
    if (!target) {
      await sessionReply(rootId, t('cmd.codex_app_adopt.thread_not_found', { threadId: args }, loc));
      return;
    }
    await startCodexAppThreadSession(target, ds, deps, larkAppId);
    return;
  }

  const cardJson = buildCodexAppThreadSelectCard(threads, rootId, loc);
  await sessionReply(rootId, cardJson, 'interactive');
}

// ─── Adopt session helper ────────────────────────────────────────────────────

/** Discriminate a zellij adopt candidate from tmux/herdr candidates. */
function isZellijTarget(t: AdoptableSession | ZellijAdoptableSession): t is ZellijAdoptableSession {
  return 'zellijPaneId' in t;
}

export async function startCodexAppThreadSession(
  thread: CodexAppThreadSummary,
  ds: DaemonSession,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const loc: Locale = localeForBot(ds.larkAppId ?? larkAppId);
  const title = codexAppThreadTitle(thread);

  ds.adoptedFrom = undefined;
  ds.workingDir = thread.cwd;
  ds.hasHistory = true;
  ds.currentTurnTitle = undefined;
  ds.lastScreenContent = undefined;
  ds.lastScreenStatus = undefined;

  ds.session.workingDir = thread.cwd;
  ds.session.title = `Codex App: ${title}`;
  ds.session.cliId = 'codex-app';
  ds.session.cliSessionId = thread.threadId;
  ds.session.adoptedFrom = undefined;
  sessionStore.updateSession(ds.session);

  forkWorker(ds, '', true);
  await sessionReply(sessionAnchorId(ds), t('cmd.codex_app_adopt.success', { title }, loc));
}

export async function startAdoptSession(
  target: AdoptableSession | ZellijAdoptableSession,
  ds: DaemonSession,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const loc: Locale = localeForBot(ds.larkAppId ?? larkAppId);

  const zellij = isZellijTarget(target);
  const valid = zellij
    ? validateZellijAdoptTarget(target.zellijSession, target.zellijPaneId, target.cliPid, target.cliId)
    : validateAdoptTarget(target);
  if (!valid) {
    await sessionReply(sessionAnchorId(ds), t('cmd.adopt.target_exited', undefined, loc));
    return;
  }

  const project = target.cwd.split('/').pop() || target.cwd;
  const pane = zellij ? `${target.zellijSession}/${target.zellijPaneId}` : adoptTargetLabel(target);

  ds.workingDir = target.cwd;
  ds.session.workingDir = target.cwd;
  ds.session.title = `Adopt: ${project}`;
  ds.adoptedFrom = {
    source: zellij ? 'zellij' : target.source,
    tmuxTarget: zellij ? undefined : target.tmuxTarget,
    zellijSession: zellij ? target.zellijSession : undefined,
    zellijPaneId: zellij ? target.zellijPaneId : undefined,
    herdrSessionName: zellij ? undefined : target.herdrSessionName,
    herdrTarget: zellij ? undefined : target.herdrTarget,
    herdrPaneId: zellij ? undefined : target.herdrPaneId,
    herdrAgentName: zellij ? undefined : target.herdrAgentName,
    herdrTerminalId: zellij ? undefined : target.herdrTerminalId,
    originalCliPid: target.cliPid,
    sessionId: target.sessionId,
    cliId: target.cliId,
    cwd: target.cwd,
    paneCols: target.paneCols,
    paneRows: target.paneRows,
  };
  ds.session.adoptedFrom = { ...ds.adoptedFrom };
  sessionStore.updateSession(ds.session);

  forkAdoptWorker(ds);

  const cliName = getCliDisplayName(target.cliId);
  await sessionReply(sessionAnchorId(ds), t('cmd.adopt.success', { cliName, project, pane }, loc));
}

/** Discover the sessions resumable from disk for `cliId`, excluding any whose
 *  CLI-native id is already live in a botmux session (so a session botmux
 *  already runs isn't offered for re-import). Returns [] when the adapter has
 *  no on-disk store. */
export async function discoverResumableSessionsForBot(
  cliId: CliId,
  cliPathOverride: string | undefined,
  activeSessions: Map<string, DaemonSession>,
  limit = 20,
): Promise<ResumableSession[]> {
  let adapter: ReturnType<typeof createCliAdapterSync>;
  try { adapter = createCliAdapterSync(cliId, cliPathOverride); } catch { return []; }
  if (!adapter.listResumableSessions) return [];
  // Exclude every session botmux already manages — live OR closed — so the
  // picker surfaces only genuinely external sessions (a CLI the user ran
  // standalone). botmux's own closed sessions stay resumable via their
  // session-closed cards, so hiding them here avoids a redundant, confusing
  // duplicate. The identity set spans all bot stores and includes both the
  // botmux sessionId (= the claude jsonl filename) and the cliSessionId
  // (codex/traex rollout id), covering every CLI's id shape. Passed INTO the
  // adapter so exclusion happens BEFORE the `limit` truncation.
  const exclude = sessionStore.collectBotmuxSessionIdentities() ?? new Set<string>();
  // Belt-and-suspenders: also fold in the in-memory active map (freshest).
  for (const ds of activeSessions.values()) {
    if (ds.session.sessionId) exclude.add(ds.session.sessionId);
    if (ds.session.cliSessionId) exclude.add(ds.session.cliSessionId);
  }
  try {
    return await adapter.listResumableSessions({ limit, exclude });
  } catch {
    return [];
  }
}

/** Import (resume) a stored session into the current topic: re-spawn the bot's
 *  CLI via `--resume <cliSessionId>` in `cwd`. Mirrors the manual resume path —
 *  the worker owns the CLI (NOT an observe-adopt), so no `adoptedFrom` is set. */
export async function startResumeImportSession(
  target: ResumableSession,
  ds: DaemonSession,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const loc: Locale = localeForBot(ds.larkAppId ?? larkAppId);
  const project = target.cwd.split('/').pop() || target.cwd;

  ds.workingDir = target.cwd;
  ds.session.workingDir = target.cwd;
  ds.session.cliSessionId = target.cliSessionId;
  ds.session.title = target.title || `Import: ${project}`;
  // Resume sandbox decision is left to forkWorker (resume=true → not sandboxed,
  // matching restore semantics). Mark history so the session is treated as a
  // resume, not a fresh spawn.
  ds.hasHistory = true;
  sessionStore.updateSession(ds.session);

  forkWorker(ds, '', true);

  const cliName = getCliDisplayName(getBot(ds.larkAppId).config.cliId);
  await sessionReply(sessionAnchorId(ds), t('cmd.adopt.resume_success', { cliName, project, title: target.title || target.cliSessionId.slice(0, 8) }, loc));
}
