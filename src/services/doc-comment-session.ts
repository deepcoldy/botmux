import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BotConfig, DocCommentBinding, DocCommentFileType } from '../bot-registry.js';
import { configuredWorkingDirs, isPathWithinAnyDir } from '../utils/working-dir.js';

export interface DocCommentEventRef {
  fileToken: string;
  fileType?: DocCommentFileType;
  commentId: string;
  replyId?: string;
  authorOpenId?: string;
}

export type DocCommentPolicyResult =
  | {
      ok: true;
      anchor: string;
      workingDir: string;
      workingDirSource: 'temp' | 'binding';
      binding?: DocCommentBinding;
      canTalk: true;
      canOperate: false;
    }
  | {
      ok: false;
      reason:
        | 'disabled'
        | 'missing_file_token'
        | 'missing_comment_id'
        | 'file_disabled'
        | 'operator_not_configured'
        | 'author_not_allowed'
        | 'working_dir_outside_allowed_roots';
    };

export function docCommentAnchor(larkAppId: string, fileToken: string): string {
  return `doc:${larkAppId}:${fileToken}`;
}

export function safeDocSessionSegment(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 10);
  const label = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return `${label || 'doc'}-${hash}`;
}

export function docCommentTempDir(dataDir: string, larkAppId: string, fileToken: string): string {
  return join(
    resolve(dataDir),
    'doc-sessions',
    safeDocSessionSegment(larkAppId),
    safeDocSessionSegment(fileToken),
  );
}

export function ensureDocCommentTempDir(dataDir: string, larkAppId: string, fileToken: string): string {
  const dir = docCommentTempDir(dataDir, larkAppId, fileToken);
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
  larkAppId: string,
  bot: BotConfig,
  event: DocCommentEventRef,
  opts: { dataDir: string; operatorOpenIds?: string[]; ownerOpenId?: string },
): DocCommentPolicyResult {
  const cfg = bot.docComments;
  if (!cfg?.enabled) return { ok: false, reason: 'disabled' };

  const fileToken = event.fileToken.trim();
  const commentId = event.commentId.trim();
  if (!fileToken) return { ok: false, reason: 'missing_file_token' };
  if (!commentId) return { ok: false, reason: 'missing_comment_id' };

  const binding = cfg.files.find(f => f.fileToken === fileToken);
  if (binding?.enabled === false) return { ok: false, reason: 'file_disabled' };

  const allowedAuthors = new Set<string>(binding?.allowedAuthors ?? []);
  for (const openId of opts.operatorOpenIds ?? []) {
    if (openId) allowedAuthors.add(openId);
  }
  if (opts.ownerOpenId) allowedAuthors.add(opts.ownerOpenId);
  if (allowedAuthors.size === 0) return { ok: false, reason: 'operator_not_configured' };
  if (!event.authorOpenId || !allowedAuthors.has(event.authorOpenId)) {
    return { ok: false, reason: 'author_not_allowed' };
  }

  let workingDir = docCommentTempDir(opts.dataDir, larkAppId, fileToken);
  let workingDirSource: 'temp' | 'binding' = 'temp';
  if (binding?.workingDir) {
    const allowedRoots = docCommentAllowedRoots(bot);
    if (allowedRoots.length === 0 || !isPathWithinAnyDir(binding.workingDir, allowedRoots)) {
      return { ok: false, reason: 'working_dir_outside_allowed_roots' };
    }
    workingDir = binding.workingDir;
    workingDirSource = 'binding';
  }

  return {
    ok: true,
    anchor: docCommentAnchor(larkAppId, fileToken),
    workingDir,
    workingDirSource,
    ...(binding ? { binding } : {}),
    canTalk: true,
    canOperate: false,
  };
}
