/**
 * A session whose working directory is gone — typically a PR worktree removed
 * after the PR merged — is never woken somewhere else. forkWorker refuses the
 * start ({@link MissingWorkingDirError}) and the chat gets the repo picker in
 * recovery form: rebuild the deleted worktree in place, or move the session to
 * another directory. Either way it stays the same session, so the next message
 * resumes the CLI conversation there.
 */
import { existsSync } from 'node:fs';
import type { DaemonSession } from './types.js';
import { isDocNativeSession, isHeadlessSessionChatId, runtimeSessionAnchorId, sessionAnchorId } from './types.js';
import { getProjectScanDirs, getSessionWorkingDir } from './session-manager.js';
import { getBot } from '../bot-registry.js';
import { repoPickerScanOptions } from '../global-config.js';
import { buildRepoSelectCard } from '../im/lark/card-builder.js';
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
 */
export async function publishWorkingDirRecovery(
  ds: DaemonSession,
  path: string,
  deps: WorkingDirRecoveryDeps,
  ctx: { turnId?: string; force?: boolean } = {},
): Promise<void> {
  // Headless (HTTP API) sessions have no chat; their caller gets the error.
  if (isHeadlessSessionChatId(ds.chatId)) return;
  const loc = localeForBot(ds.larkAppId);
  const anchor = sessionAnchorId(ds);
  const replyOpts = { sourceSessionId: ds.session.sessionId };
  if (isDocNativeSession(ds)) {
    // A document comment thread cannot carry a card.
    await deps.sessionReply(anchor, t('worker.working_dir_missing_text', { path }, loc), 'text', ds.larkAppId, ctx.turnId, replyOpts);
    return;
  }
  if (!ctx.force && ds.workingDirRecovery?.path === path) {
    if (ctx.turnId?.startsWith('om_')) {
      await deps.sessionReply(anchor, t('worker.working_dir_missing_again', { path }, loc), 'text', ds.larkAppId, ctx.turnId, replyOpts);
    }
    return;
  }
  const state: NonNullable<DaemonSession['workingDirRecovery']> = { path };
  ds.workingDirRecovery = state;
  state.rebuild = (await resolveDeletedWorktreeOrigin(path).catch(() => null)) ?? undefined;
  if (ds.workingDirRecovery !== state) return;
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
    { missingPath: path, rebuildBranch: state.rebuild?.branch },
  );
  try {
    const messageId = await deps.sessionReply(anchor, card, 'interactive', ds.larkAppId, ctx.turnId, replyOpts);
    if (ds.workingDirRecovery !== state) return;
    state.cardMessageId = messageId;
    ds.repoCardMessageId = messageId;
  } catch (err) {
    logger.warn(
      `[${ds.session.sessionId.substring(0, 8)}] working-dir recovery card for ${path} could not be published: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    // No card means no buttons: the next refusal should try the card again,
    // and this one still says what happened and how to move on.
    if (ds.workingDirRecovery === state) ds.workingDirRecovery = undefined;
    await deps.sessionReply(anchor, t('worker.working_dir_missing_text', { path }, loc), 'text', ds.larkAppId, ctx.turnId, replyOpts);
  }
}
