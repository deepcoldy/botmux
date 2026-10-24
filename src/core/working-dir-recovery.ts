/**
 * A session whose working directory is gone — typically a PR worktree removed
 * after the PR merged — is never woken somewhere else. forkWorker refuses the
 * start ({@link MissingWorkingDirError}) and the chat gets the repo picker in
 * recovery form: rebuild the deleted worktree in place, or move the session to
 * another directory. Either way it stays the same session, so the next message
 * resumes the CLI conversation there.
 *
 * A session whose FIRST message has not started yet is the other case: it has
 * no conversation to resume, only that opening, still staged for repo
 * selection. Its card is the repo picker for that opening — choosing a
 * directory starts the message there, nothing to resend.
 */
import { existsSync } from 'node:fs';
import type { DaemonSession } from './types.js';
import { isDocNativeSession, isHeadlessSessionChatId, runtimeSessionAnchorId, sessionAnchorId } from './types.js';
import { getProjectScanDirs, getSessionWorkingDir } from './session-manager.js';
import { persistPendingRepoCardMessageId, restorePendingRepoRuntime } from './pending-repo-journal.js';
import { protectedSessionMutationReasons, type ProtectedSessionMutationReason } from './session-mutation-guard.js';
import { getBot } from '../bot-registry.js';
import { repoPickerScanOptions } from '../global-config.js';
import { buildRepoSelectCard, type RepoSelectRecovery } from '../im/lark/card-builder.js';
import { t, localeForBot } from '../i18n/index.js';
import { resolveDeletedWorktreeOrigin } from '../services/git-worktree.js';
import { scanMultipleProjects, type ProjectInfo } from '../services/project-scanner.js';
import { logger } from '../utils/logger.js';

export class MissingWorkingDirError extends Error {
  constructor(readonly path: string) {
    super(`session working directory does not exist: ${path}`);
    this.name = 'MissingWorkingDirError';
  }
}

/** The recovery card still describes the session: the directory it lost is
 *  still its directory and still missing. `/cd`, a manual re-create or a
 *  finished rebuild each retire it. */
export function workingDirRecoveryPending(ds: DaemonSession): boolean {
  const recovery = ds.workingDirRecovery;
  return !!recovery && getSessionWorkingDir(ds) === recovery.path && !existsSync(recovery.path);
}

/** The directory a session that names none would start in — the bot's default
 *  working dir — when that directory does not exist (deleted, mistyped, or
 *  configured on another host). Starting there is refused, so an opening must
 *  wait for a directory instead. */
export function missingStartDir(ds: DaemonSession): string | undefined {
  const dir = getSessionWorkingDir(ds);
  return dir && !existsSync(dir) ? dir : undefined;
}

// What a staged opening holds on its session: the queued opening itself, its
// repo-selection setup, the in-memory start gate, and the messages that arrived
// after it, queued behind it (the activation tail; with no activation in
// flight they wait for this opening and are released after it, as from the
// picker).
const OPENING_OWNERSHIP: ReadonlySet<ProtectedSessionMutationReason> = new Set([
  'queued_todo',
  'repository_setup',
  'initial_start',
  'activation_tail',
]);

/** True when nothing but an opening that never started keeps this session from
 *  switching directories: a start staged for repo selection (pendingRepoSetup,
 *  no activation in flight) that left the picker and was then refused — the
 *  directory it fell back to is missing. Any other unsettled work (an
 *  activation in flight, a Codex App dispatch, a principal-lane turn) makes
 *  this false. */
export function onlyUnstartedOpeningHolds(ds: DaemonSession): boolean {
  if (ds.pendingRepo || !ds.session.pendingRepoSetup || ds.session.queuedActivationPending) return false;
  if (ds.worker && !ds.worker.killed) return false;
  return protectedSessionMutationReasons(ds).every(reason => OPENING_OWNERSHIP.has(reason));
}

/** Put a session held only by its unstarted opening ({@link onlyUnstartedOpeningHolds})
 *  back in front of its repo picker, so the directory chosen next starts the
 *  opening. A card click passes its `cardMessageId`, which becomes that picker;
 *  `/repo <路径>` passes none and keeps the setup's. False when other work holds it. */
export function reclaimUnstartedOpening(ds: DaemonSession, cardMessageId?: string): boolean {
  if (!onlyUnstartedOpeningHolds(ds)) return false;
  restorePendingRepoRuntime(ds);
  if (cardMessageId === undefined) return true;
  ds.repoCardMessageId = cardMessageId;
  try {
    persistPendingRepoCardMessageId(ds, cardMessageId);
  } catch (err) {
    // The in-memory picker still works; only a restart would replace it.
    logger.warn(
      `[${ds.session.sessionId.substring(0, 8)}] could not persist recovery card ${cardMessageId} as the repo picker: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return true;
}

/** The recovery form of the repo picker for `recovery`, as this session needs it now. */
export function recoveryCardForm(
  ds: DaemonSession,
  recovery: NonNullable<DaemonSession['workingDirRecovery']>,
): RepoSelectRecovery {
  return {
    missingPath: recovery.path,
    rebuildBranch: recovery.rebuild?.branch,
    ...(ds.pendingRepo || onlyUnstartedOpeningHolds(ds) ? { opening: true } : {}),
  };
}

export interface WorkingDirRecoveryDeps {
  sessionReply: (
    rootId: string,
    content: string,
    msgType?: string,
    larkAppId?: string,
    turnId?: string,
    opts?: { sourceSessionId?: string },
  ) => Promise<string>;
  lastRepoScan: Map<string, ProjectInfo[]>;
}

/**
 * Tell the chat that a CLI start was refused because `path` is gone. The
 * first refusal for a path publishes the recovery card; later ones while it is
 * up only answer a human message (`om_` turn) with one line saying it was not
 * delivered — scheduler or restore starts stay quiet rather than repeat the
 * card. `force` re-publishes it (bare `/repo`).
 *
 * For a session whose opening has not started (still pendingRepo, or held only
 * by that opening) the card is that opening's repo picker: it is persisted as
 * the setup's picker, and its text says the message starts once a directory is
 * chosen. Resolves to the published card's message id, if any.
 */
export async function publishWorkingDirRecovery(
  ds: DaemonSession,
  path: string,
  deps: WorkingDirRecoveryDeps,
  ctx: { turnId?: string; force?: boolean } = {},
): Promise<string | undefined> {
  // Headless (HTTP API) sessions have no chat; their caller gets the error.
  if (isHeadlessSessionChatId(ds.chatId)) return undefined;
  const loc = localeForBot(ds.larkAppId);
  const anchor = sessionAnchorId(ds);
  const replyOpts = { sourceSessionId: ds.session.sessionId };
  const missingText = (): string => t(
    ds.pendingRepo || onlyUnstartedOpeningHolds(ds) ? 'worker.working_dir_missing_opening_text' : 'worker.working_dir_missing_text',
    { path },
    loc,
  );
  if (isDocNativeSession(ds)) {
    // A document comment thread cannot carry a card.
    await deps.sessionReply(anchor, missingText(), 'text', ds.larkAppId, ctx.turnId, replyOpts);
    return undefined;
  }
  if (!ctx.force && ds.workingDirRecovery?.path === path) {
    if (ctx.turnId?.startsWith('om_')) {
      await deps.sessionReply(anchor, t('worker.working_dir_missing_again', { path }, loc), 'text', ds.larkAppId, ctx.turnId, replyOpts);
    }
    return undefined;
  }
  const state: NonNullable<DaemonSession['workingDirRecovery']> = { path };
  ds.workingDirRecovery = state;
  state.rebuild = (await resolveDeletedWorktreeOrigin(path).catch(() => null)) ?? undefined;
  if (ds.workingDirRecovery !== state) return undefined;
  const scanDirs = getProjectScanDirs(ds).filter(dir => existsSync(dir));
  const projects = scanDirs.length > 0 ? scanMultipleProjects(scanDirs, 3, repoPickerScanOptions()) : [];
  deps.lastRepoScan.set(ds.chatId, projects);
  // Card callbacks look the session up by its registry anchor (root_id).
  const card = buildRepoSelectCard(
    projects,
    path,
    runtimeSessionAnchorId(ds),
    loc,
    getBot(ds.larkAppId).config.worktreeMultiPicker,
    recoveryCardForm(ds, state),
  );
  try {
    const messageId = await deps.sessionReply(anchor, card, 'interactive', ds.larkAppId, ctx.turnId, replyOpts);
    if (ds.workingDirRecovery !== state) return undefined;
    state.cardMessageId = messageId;
    ds.repoCardMessageId = messageId;
    // A staged opening restores its picker from the setup after a restart.
    if (ds.session.pendingRepoSetup) {
      try {
        persistPendingRepoCardMessageId(ds, messageId);
      } catch (err) {
        logger.warn(
          `[${ds.session.sessionId.substring(0, 8)}] could not persist recovery card ${messageId} as the repo picker: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return messageId;
  } catch (err) {
    logger.warn(
      `[${ds.session.sessionId.substring(0, 8)}] working-dir recovery card for ${path} could not be published: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    // No card means no buttons: the next refusal should try the card again,
    // and this one still says what happened and how to move on.
    if (ds.workingDirRecovery === state) ds.workingDirRecovery = undefined;
    await deps.sessionReply(anchor, missingText(), 'text', ds.larkAppId, ctx.turnId, replyOpts);
    return undefined;
  }
}
