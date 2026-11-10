import { execFileSync } from 'node:child_process';
import { realpathSync, statSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { FeedbackAnswerWorktree, FeedbackHookRegistration, FeedbackQuestionRouting } from './feedback-extension-types.js';

function git(directory: string, ...arguments_: string[]): string {
  return execFileSync('git', ['-C', directory, ...arguments_], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 32768,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repositoryIdentity(directory: string) {
  const root = realpathSync(git(directory, 'rev-parse', '--show-toplevel'));
  const commonDir = realpathSync(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const gitDir = realpathSync(git(root, 'rev-parse', '--absolute-git-dir'));
  const info = statSync(root);
  const commonInfo = statSync(commonDir);
  const gitInfo = statSync(gitDir);
  return { root, commonDir, gitDir, device: info.dev, inode: info.ino,
    commonDevice: commonInfo.dev, commonInode: commonInfo.ino, gitDevice: gitInfo.dev, gitInode: gitInfo.ino };
}

export function normalizeFeedbackQuestionRouting(input: unknown): FeedbackQuestionRouting {
  const value = input as FeedbackQuestionRouting;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['questionTypeId', 'regions', 'reason'].includes(key))
    || !Number.isSafeInteger(value.questionTypeId) || value.questionTypeId < 1
    || !Array.isArray(value.regions) || value.regions.length > 8
    || value.regions.some(region => typeof region !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(region))
    || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000) {
    throw new Error('feedback_question_routing_invalid');
  }
  return { questionTypeId: value.questionTypeId, regions: [...new Set(value.regions)], reason: value.reason };
}

export function bindFeedbackAnswerWorktree(
  input: { sessionId: string; turnId: string; cliId?: string; nativeSessionId?: string;
    workingDir?: string; nativeWorkingDir?: string },
  registration?: NonNullable<FeedbackHookRegistration['answerWorktree']>,
): FeedbackAnswerWorktree {
  if (!input.sessionId || !input.turnId) throw new Error('feedback_worktree_identity_missing');
  if (input.cliId === 'traex' && (!input.nativeSessionId || !input.nativeWorkingDir)) {
    throw new Error('feedback_worktree_native_cwd_missing');
  }
  const directory = input.nativeWorkingDir ?? input.workingDir;
  if (!directory || !isAbsolute(directory)) throw new Error('feedback_worktree_cwd_missing');
  const identity = repositoryIdentity(directory);
  if (identity.root !== realpathSync(directory) || identity.gitDir === identity.commonDir) {
    throw new Error('feedback_worktree_not_registered');
  }
  if (registration && !registration.repositoryRoots.some(root => {
    try {
      const allowed = repositoryIdentity(root);
      return allowed.commonDir === identity.commonDir && allowed.commonDevice === identity.commonDevice
        && allowed.commonInode === identity.commonInode;
    } catch { return false; }
  })) {
    throw new Error('feedback_worktree_repository_unauthorized');
  }
  return { sessionId: input.sessionId, turnId: input.turnId, ...identity,
    ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}) };
}

export function resolveFeedbackAnswerCommand(
  hook: FeedbackHookRegistration, binding: FeedbackAnswerWorktree,
  sessionId: string, turnId: string,
) {
  if (!binding || binding.sessionId !== sessionId || binding.turnId !== turnId) {
    throw new Error('feedback_worktree_identity_mismatch');
  }
  if (!hook.answerWorktree) throw new Error('feedback_worktree_registration_missing');
  const observed = bindFeedbackAnswerWorktree({ sessionId, turnId, workingDir: binding.root }, hook.answerWorktree);
  for (const key of ['root', 'commonDir', 'gitDir', 'device', 'inode',
    'commonDevice', 'commonInode', 'gitDevice', 'gitInode'] as const) {
    if (observed[key] !== binding[key]) throw new Error('feedback_worktree_identity_changed');
  }
  const script = join(binding.root, hook.answerWorktree.script);
  const canonical = realpathSync(script);
  const inside = relative(binding.root, canonical);
  const info = lstatSync(script);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024
    || canonical !== script || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
    throw new Error('feedback_worktree_script_unsafe');
  }
  return {
    cwd: binding.root,
    command: [hook.command[0], script, ...hook.command.slice(2)],
    execution: {
      ...binding, commit: git(binding.root, 'rev-parse', 'HEAD'),
      script: hook.answerWorktree.script,
      scriptHash: createHash('sha256').update(readFileSync(script)).digest('hex'),
    },
  };
}
