/**
 * Where a daemon's drafts may clarify, as production reads it: the bot's
 * default dir, else the same scan as the Feishu repo picker card (the bot's
 * working dirs, three levels deep, worktrees per `repoPickerMode`). Real bot
 * registry, global config file, git repos and project scanner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { productionWorkflowDraftProjects } from '../src/core/dashboard-ipc-server.js';
import { registerBot } from '../src/bot-registry.js';
import { invalidateGlobalConfigCache } from '../src/global-config.js';

const NO_DEFAULT = 'cli_projects_nodef';
const WITH_DEFAULT = 'cli_projects_def';

let root: string;
let projects: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
}

function writeGlobalConfig(value: Record<string, unknown>): void {
  writeFileSync(join(root, 'config.json'), JSON.stringify(value));
  invalidateGlobalConfigCache();
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wf-draft-projects-')));
  projects = join(root, 'projects');
  const web = join(projects, 'web-portal');
  mkdirSync(web, { recursive: true });
  git(web, 'init', '-q', '-b', 'main');
  git(web, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(web, 'worktree', 'add', '-q', '-b', 'feat/invoice', join(projects, 'web-portal-invoice'));
  vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', join(root, 'config.json'));
  writeGlobalConfig({});
  registerBot({ larkAppId: NO_DEFAULT, larkAppSecret: '', cliId: 'claude-code', apiOnly: true, workingDirs: [projects] } as any);
  registerBot({ larkAppId: WITH_DEFAULT, larkAppSecret: '', cliId: 'claude-code', apiOnly: true, workingDirs: [projects], defaultWorkingDir: `${projects}/web-portal/../web-portal` } as any);
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateGlobalConfigCache();
  rmSync(root, { recursive: true, force: true });
});

describe('productionWorkflowDraftProjects', () => {
  it('a bot without a default dir: no default, the repo picker\'s repos and worktrees', () => {
    const list = productionWorkflowDraftProjects(NO_DEFAULT);
    expect(list.defaultDir()).toBeUndefined();
    expect(list.candidates().map(({ path, type }) => [path, type]).sort()).toEqual([
      [join(projects, 'web-portal'), 'repo'],
      [join(projects, 'web-portal-invoice'), 'worktree'],
    ]);
  });

  it('follows repoPickerMode: 「只列仓库」 drops the worktrees, as the card does', () => {
    writeGlobalConfig({ repoPickerMode: 'repos' });
    expect(productionWorkflowDraftProjects(NO_DEFAULT).candidates().map((candidate) => candidate.path)).toEqual([join(projects, 'web-portal')]);
  });

  it('a bot with a default dir: that dir, normalised', () => {
    expect(productionWorkflowDraftProjects(WITH_DEFAULT).defaultDir()).toBe(join(projects, 'web-portal'));
  });
});
