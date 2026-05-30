import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BotConfig } from '../bot-registry.js';
import { configuredWorkingDirs, isPathWithinAnyDir } from '../utils/working-dir.js';

export interface DocCommentEventRef {
  documentId: string;
  commentId: string;
  replyId?: string;
  authorId?: string;
}

export type DocCommentPolicyResult =
  | {
      ok: true;
      anchor: string;
      workingDir: string;
      workingDirSource: 'temp' | 'config';
      canTalk: true;
      canOperate: false;
    }
  | {
      ok: false;
      reason:
        | 'disabled'
        | 'missing_document_id'
        | 'missing_comment_id'
        | 'operator_not_configured'
        | 'author_not_allowed'
        | 'working_dir_outside_allowed_roots';
    };

export function docCommentAnchor(botId: string, documentId: string): string {
  return `doc:${botId}:${documentId}`;
}

export function safeDocSessionSegment(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 10);
  const label = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return `${label || 'doc'}-${hash}`;
}

export function docCommentTempDir(dataDir: string, botId: string, documentId: string): string {
  return join(
    resolve(dataDir),
    'doc-sessions',
    safeDocSessionSegment(botId),
    safeDocSessionSegment(documentId),
  );
}

export function ensureDocCommentTempDir(dataDir: string, botId: string, documentId: string): string {
  const dir = docCommentTempDir(dataDir, botId, documentId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function docCommentAllowedRoots(bot: BotConfig): string[] {
  const roots = [
    ...(bot.docComments?.allowedRoots ?? []),
    ...configuredWorkingDirs({
      workingDir: [bot.workingDir, bot.defaultWorkingDir],
      workingDirs: bot.workingDirs,
    }),
  ];
  const seen = new Set<string>();
  return roots.filter(root => {
    const key = resolve(root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resolveDocCommentSessionPolicy(
  botId: string,
  bot: BotConfig,
  event: DocCommentEventRef,
  opts: { dataDir: string; operatorIds?: string[]; ownerId?: string },
): DocCommentPolicyResult {
  const cfg = bot.docComments;
  if (!cfg?.enabled) return { ok: false, reason: 'disabled' };

  const documentId = event.documentId.trim();
  const commentId = event.commentId.trim();
  if (!documentId) return { ok: false, reason: 'missing_document_id' };
  if (!commentId) return { ok: false, reason: 'missing_comment_id' };

  const allowedOperatorIds = new Set<string>();
  for (const id of opts.operatorIds ?? []) {
    if (id) allowedOperatorIds.add(id);
  }
  if (opts.ownerId) allowedOperatorIds.add(opts.ownerId);
  if (allowedOperatorIds.size === 0) return { ok: false, reason: 'operator_not_configured' };
  if (!event.authorId || !allowedOperatorIds.has(event.authorId)) {
    return { ok: false, reason: 'author_not_allowed' };
  }

  let workingDir = docCommentTempDir(opts.dataDir, botId, documentId);
  let workingDirSource: 'temp' | 'config' = 'temp';
  if (cfg.workingDir) {
    const allowedRoots = docCommentAllowedRoots(bot);
    if (allowedRoots.length === 0 || !isPathWithinAnyDir(cfg.workingDir, allowedRoots)) {
      return { ok: false, reason: 'working_dir_outside_allowed_roots' };
    }
    workingDir = cfg.workingDir;
    workingDirSource = 'config';
  }

  return {
    ok: true,
    anchor: docCommentAnchor(botId, documentId),
    workingDir,
    workingDirSource,
    canTalk: true,
    canOperate: false,
  };
}
