import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrincipalLaneSourceState } from '../src/types.js';
import {
  materializePrincipalLaneWorktree,
  principalLaneWorktreeMaterializationId,
} from '../src/core/principal-lane-worktree.js';

let tempRoot: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

function fixture() {
  const repo = join(tempRoot, 'project');
  const cwd = join(repo, 'packages', 'app');
  mkdirSync(cwd, { recursive: true });
  git(repo, 'init', '-b', 'master');
  writeFileSync(join(cwd, 'README.md'), 'fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  const canonicalCwd = realpathSync(cwd);
  const source: PrincipalLaneSourceState = {
    version: 1,
    sourcePrincipalKey: 'user:union:on_source',
    displayTarget: {
      scope: 'thread', larkAppId: 'app-live', chatId: 'chat-live', rootMessageId: 'root-live',
    },
    canonicalCwd,
    workspaceEpoch: 1,
    workspaceGroupId: 'principal-workspace:v2:test',
    workspaceGroupKeyVersion: 2,
    phase: 'active',
    revision: 1,
    updatedAt: '2026-09-20T06:00:00.000Z',
  };
  return { repo: realpathSync(repo), cwd: canonicalCwd, source };
}

beforeEach(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'principal-lane-worktree-')));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('principal lane forced worktree materialization', () => {
  it('creates and reuses one deterministic isolated target under concurrent admission', async () => {
    const { repo, cwd, source } = fixture();
    const commit = async (materialization: { materializationId: string; workingDir: string }) => ({
      materializationId: materialization.materializationId,
      workingDir: materialization.workingDir,
    });
    const args = {
      sourceSessionId: 'source-session',
      source,
      identity: { larkAppId: 'app-live', unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-20T06:01:00.000Z',
      commit,
    };
    const [left, right] = await Promise.all([
      materializePrincipalLaneWorktree(args),
      materializePrincipalLaneWorktree(args),
    ]);
    expect(left.status).toBe('ready');
    expect(right.status).toBe('ready');
    if (left.status !== 'ready' || right.status !== 'ready') {
      throw new Error('expected converged materializations');
    }
    expect(left.materialization.materializationId).toBe(
      principalLaneWorktreeMaterializationId({
        sourceSessionId: 'source-session',
        principalKey: 'user:union:on_b',
        workspaceEpoch: 1,
        sourceCanonicalCwd: cwd,
      }),
    );
    expect(right.materialization.materializationId).toBe(left.materialization.materializationId);
    expect(right.materialization.worktreeRoot).toBe(left.materialization.worktreeRoot);
    expect(left.materialization.sourceRepoRoot).toBe(repo);
    expect(left.materialization.sourceGitCommonDir).toBe(
      left.materialization.worktreeGitCommonDir,
    );
    expect(left.materialization.workingDir).not.toBe(cwd);
    expect(left.materialization.worktreeRoot).not.toBe(repo);
    expect(existsSync(join(left.materialization.workingDir, 'README.md'))).toBe(true);
    expect(git(left.materialization.worktreeRoot, 'branch', '--show-current')).toBe(
      left.materialization.branch,
    );
  });

  it('fails closed outside git and never returns the shared source cwd', async () => {
    const cwd = join(tempRoot, 'plain');
    mkdirSync(cwd);
    const source: PrincipalLaneSourceState = {
      version: 1,
      sourcePrincipalKey: 'user:union:on_source',
      displayTarget: { scope: 'chat', larkAppId: 'app-live', chatId: 'chat-live' },
      canonicalCwd: cwd,
      workspaceEpoch: 1,
      workspaceGroupId: 'principal-workspace:v2:test',
      workspaceGroupKeyVersion: 2,
      phase: 'active',
      revision: 1,
      updatedAt: '2026-09-20T06:00:00.000Z',
    };
    let committed = false;
    const result = await materializePrincipalLaneWorktree({
      sourceSessionId: 'source-session',
      source,
      identity: { larkAppId: 'app-live', unionId: 'on_b' },
      commit: () => { committed = true; },
    });
    expect(result).toMatchObject({ status: 'retry', reason: 'source_not_git' });
    expect(committed).toBe(false);
  });

  it('reports an immutable orphan and does not delete it when publication is unknown', async () => {
    const { source } = fixture();
    const result = await materializePrincipalLaneWorktree({
      sourceSessionId: 'source-session',
      source,
      identity: { larkAppId: 'app-live', unionId: 'on_b' },
      now: '2026-09-20T06:01:00.000Z',
      commit: () => { throw new Error('synthetic publication unknown'); },
    });
    expect(result).toMatchObject({
      status: 'unknown', reason: 'publication_unknown',
      orphan: { branch: expect.stringMatching(/^wt\/principal-lane-/) },
    });
    if (result.status !== 'unknown') throw new Error('expected unknown publication');
    expect(existsSync(result.orphan.worktreePath)).toBe(true);
  });
});
