import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  __testOnly_resetBotRegistry,
  registerBot,
  type BotConfig,
} from '../src/bot-registry.js';
import { buildIssueCommandDeps } from '../src/im/lark/issue-command-deps.js';
import { reposFor } from '../src/im/lark/issue-command.js';

function register(config: Partial<BotConfig> & Pick<BotConfig, 'larkAppId'>): void {
  registerBot({
    larkAppSecret: '',
    cliId: 'codex',
    apiOnly: true,
    ...config,
  });
}

beforeEach(() => __testOnly_resetBotRegistry());
afterEach(() => __testOnly_resetBotRegistry());

describe('Issue 领取仓库依赖接线', () => {
  it('显式扫描根优先，不混入 fixed 默认目录', () => {
    register({
      larkAppId: 'app_card',
      workingDir: '~/workspace',
      workingDirs: ['~/workspace', '~/other-workspace'],
      defaultWorkingDir: '~/fixed-repo',
    });

    const deps = buildIssueCommandDeps();
    expect(deps.workingDirs('app_card')).toEqual(['~/workspace', '~/other-workspace']);
    expect(deps.defaultWorkingDir('app_card')).toBe('~/fixed-repo');
  });

  it('fixed 模式接出 defaultWorkingDir，显式扫描根保持为空', () => {
    register({ larkAppId: 'app_fixed', defaultWorkingDir: '~/fixed-repo' });

    const deps = buildIssueCommandDeps();
    expect(deps.workingDirs('app_fixed')).toEqual([]);
    expect(deps.defaultWorkingDir('app_fixed')).toBe('~/fixed-repo');
  });

  it('oncall 模式接出有效默认目录，显式扫描根保持为空', () => {
    register({
      larkAppId: 'app_oncall',
      defaultOncall: { enabled: true, workingDir: '~/oncall-repo', since: 1 },
    });

    const deps = buildIssueCommandDeps();
    expect(deps.workingDirs('app_oncall')).toEqual([]);
    expect(deps.defaultWorkingDir('app_oncall')).toBe('~/oncall-repo');
  });

  it('oncall 有效默认目录接入候选生成全链路', () => {
    const repo = mkdtempSync(join(tmpdir(), 'botmux-issue-oncall-repo-'));
    try {
      mkdirSync(join(repo, '.git'));
      writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      register({
        larkAppId: 'app_oncall_flow',
        defaultOncall: { enabled: true, workingDir: repo, since: 1 },
      });

      expect(reposFor('app_oncall_flow', buildIssueCommandDeps())).toEqual([{
        name: basename(repo),
        path: repo,
        branch: 'unknown',
      }]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('未知 bot 返回空配置', () => {
    const deps = buildIssueCommandDeps();
    expect(deps.workingDirs('missing')).toEqual([]);
    expect(deps.defaultWorkingDir('missing')).toBeUndefined();
  });
});
