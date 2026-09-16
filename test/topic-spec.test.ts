/**
 * 话题指令头的语义层：resolveTopicSpec 的每一条**拒绝分支**，以及成功路径落到哪。
 *
 * 对应设计文档 docs/design/2026-09-10-topic-directive-header.md §4「语义：每条指令落到哪」
 * 与 D5「fail closed」。与解析器（test/topic-header.test.ts）的分工：那边只管语法，
 * 这边负责仓库是否存在、模型能不能带、推理档位这个 CLI/模型认不认。
 *
 * Run:  bun run vitest run test/topic-spec.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseTopicHeader, type TopicHeader } from '../src/core/topic-header.js';
import { resolveTopicSpec, type TopicSpecResult } from '../src/core/topic-spec.js';

let scanRoot: string;
let repoDir: string;
let spacedRepoDir: string;

beforeAll(() => {
  // realpath：macOS 的 /var → /private/var，`git worktree list` 回的是真路径，目标目录要按它算。
  scanRoot = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-topic-spec-')));
  repoDir = join(scanRoot, 'botmux');
  spacedRepoDir = join(scanRoot, 'my project');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(spacedRepoDir, { recursive: true });
  // `/repo wt` 的语义校验要跑本地 git（check-ref-format / worktree list）：botmux 是真仓库，
  // 「my project」故意留成普通目录，用来钉 repo_not_git。
  execSync('git init -q', { cwd: repoDir });
});

afterAll(() => {
  rmSync(scanRoot, { recursive: true, force: true });
});

/** 解析 + 解规格的一步到位助手；解析必须成功，否则用例本身写错了。 */
function resolve(text: string, botCfg: Parameters<typeof resolveTopicSpec>[1]['botCfg']): Promise<TopicSpecResult> {
  const parsed = parseTopicHeader(text);
  expect(parsed).toMatchObject({ ok: true });
  return resolveTopicSpec(parsed as TopicHeader, { botCfg, scanDirs: [scanRoot] });
}

/** 拒绝结果里的 kind 列表，断言时比整个对象好读。 */
function errorKinds(result: TopicSpecResult): string[] {
  return result.ok ? [] : result.errors.map(e => e.kind);
}

const CLAUDE = { cliId: 'claude-code' as const, model: 'opus' };

describe('resolveTopicSpec —— 成功路径', () => {
  it('标题 / 仓库 / 模型 / 推理强度逐项落到规格上', async () => {
    const result = await resolve('日常运维 /t /repo botmux /model sonnet /effort high 看看日志', CLAUDE);
    expect(result).toEqual({
      ok: true,
      title: '日常运维',
      workingDir: repoDir,
      repoDisplayName: expect.any(String),
      model: 'sonnet',
      reasoningEffort: 'high',
    });
  });

  it('没写的指令不出现在规格里（缺席 = 沿用现有配置）', async () => {
    expect(await resolve('/t 看看日志', CLAUDE)).toEqual({ ok: true });
  });

  it('带空格的仓库路径经双引号参数解析', async () => {
    const result = await resolve(`/t /repo "${spacedRepoDir}" 跑测试`, CLAUDE);
    expect(result).toMatchObject({ ok: true, workingDir: spacedRepoDir });
  });

  it('模型名允许网关映射名与方括号变体', async () => {
    for (const model of ['sonnet[1m]', 'claude-opus-5', 'model_hub/gpt-5.4', 'gpt-5.6-sol']) {
      expect(await resolve(`/t /model ${model} 干活`, { cliId: 'codex' })).toMatchObject({ ok: true, model });
    }
  });
});

describe('resolveTopicSpec —— /repo 的拒绝分支', () => {
  it('数字形式：卡片才有编号，头部里没有卡片', async () => {
    const result = await resolve('/t /repo 2 干活', CLAUDE);
    expect(errorKinds(result)).toEqual(['repo_numeric']);
  });


  it('解析不到任何存在的目录', async () => {
    const result = await resolve('/t /repo 并不存在的仓库 干活', CLAUDE);
    expect(errorKinds(result)).toEqual(['repo_not_found']);
  });
});

describe('resolveTopicSpec —— /model 的拒绝分支', () => {
  it('模型名不像模型名（正文被当成模型名消费的那条边界）', async () => {
    const result = await resolve('/t /repo botmux /model 命令为啥坏了', CLAUDE);
    expect(errorKinds(result)).toEqual(['model_invalid']);
  });

  it('模型名超长', async () => {
    const result = await resolve(`/t /model ${'a'.repeat(65)} 干活`, CLAUDE);
    expect(errorKinds(result)).toEqual(['model_invalid']);
  });

  it('CLI 的启动路径带不动模型（dsh-tui：列了候选但不注入）', async () => {
    const result = await resolve('/t /model deepseek-v4-pro 干活', { cliId: 'dsh-tui' });
    expect(errorKinds(result)).toEqual(['model_unsupported_cli']);
  });

  it('riff 后端：模型只从 bot 的 riff 配置块取，每次启动覆盖不了', async () => {
    const result = await resolve('/t /model gpt-5.4 干活', { cliId: 'codex', backendType: 'riff' });
    expect(errorKinds(result)).toEqual(['model_unsupported_cli']);
  });

  it('mojo 远端后端能带模型 → 放行', async () => {
    expect(await resolve('/t /model glm-5-turbo 干活', { cliId: 'mojo' })).toMatchObject({
      ok: true, model: 'glm-5-turbo',
    });
  });
});

describe('resolveTopicSpec —— /effort 的拒绝分支', () => {
  it('不是合法档位', async () => {
    const result = await resolve('/t /effort turbo 干活', CLAUDE);
    expect(errorKinds(result)).toEqual(['effort_invalid']);
  });

  it('CLI 没有显式推理控制', async () => {
    const result = await resolve('/t /effort high 干活', { cliId: 'gemini' });
    expect(errorKinds(result)).toEqual(['effort_unsupported_cli']);
  });

  it('档位合法但本次要用的模型不支持（Claude 的 haiku 不吃 effort）', async () => {
    const result = await resolve('/t /effort high 干活', { cliId: 'claude-code', model: 'haiku' });
    expect(errorKinds(result)).toEqual(['effort_unsupported_model']);
  });

  it('按头部钉的模型校验，而不是 bot 配置的模型', async () => {
    // bot 配的 opus 支持 max；头部把模型改成 haiku 之后就不支持了。
    const result = await resolve('/t /model haiku /effort max 干活', CLAUDE);
    expect(errorKinds(result)).toEqual(['effort_unsupported_model']);
    expect(await resolve('/t /model opus /effort max 干活', CLAUDE)).toMatchObject({
      ok: true, model: 'opus', reasoningEffort: 'max',
    });
  });

  it('ultra 是 codex/traex 专属：Claude 上拒绝，codex 上放行', async () => {
    expect(errorKinds(await resolve('/t /effort ultra 干活', CLAUDE))).toEqual(['effort_unsupported_model']);
    expect(await resolve('/t /model gpt-5.6-sol /effort ultra 干活', { cliId: 'codex' })).toMatchObject({
      ok: true, reasoningEffort: 'ultra',
    });
  });
});

describe('resolveTopicSpec —— 一次收齐所有错误', () => {
  it('仓库与模型都写错时两条一起返回，用户改一次就够', async () => {
    const result = await resolve('/t /repo 并不存在 /model 中文模型名 干活', CLAUDE);
    expect(errorKinds(result)).toEqual(['repo_not_found', 'model_invalid']);
  });

  it('任一项失败就整条拒绝，不落半截规格（D5 fail closed）', async () => {
    const result = await resolve('日常运维 /t /repo botmux /model 中文模型名 干活', CLAUDE);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('workingDir');
    expect(result).not.toHaveProperty('title');
  });
});

/**
 * `/repo wt <目标> [分支]` 的语义层（设计 docs/design/2026-09-11-command-router.md §8）：
 * 能提前查的全部 fail closed —— 目标可解析、是 git 仓库、分支名合法（git check-ref-format）、
 * 显式分支的目标目录不存在。目标目录的算法必须与 createRepoWorktree 逐字一致。
 */
describe('resolveTopicSpec —— /repo wt', () => {
  it('显式分支：仓库、分支、预算出的目标目录一起落到规格上', async () => {
    const result = await resolve('/t /repo wt botmux ci/temp_split 简单确认', CLAUDE);
    expect(result).toEqual({
      ok: true,
      worktree: { repoPath: repoDir, branch: 'ci/temp_split', targetPath: join(scanRoot, 'botmux-ci-temp_split') },
      repoDisplayName: expect.any(String),
    });
  });

  it('无分支：只带仓库，目录由 createRepoWorktree 自动命名', async () => {
    const result = await resolve('/t /repo wt botmux 简单确认', CLAUDE);
    expect(result).toEqual({
      ok: true,
      worktree: { repoPath: repoDir },
      repoDisplayName: expect.any(String),
    });
  });

  it('与 /model /effort 并存', async () => {
    const result = await resolve('/t /repo wt botmux ci/x /model sonnet /effort high 干活', CLAUDE);
    expect(result).toMatchObject({ ok: true, worktree: { repoPath: repoDir, branch: 'ci/x' }, model: 'sonnet', reasoningEffort: 'high' });
  });

  it('编号形式 → repo_numeric', async () => {
    expect(errorKinds(await resolve('/t /repo wt 2 x', CLAUDE))).toEqual(['repo_numeric']);
  });

  it('目标解析不到 → repo_not_found', async () => {
    expect(errorKinds(await resolve('/t /repo wt 并不存在 x', CLAUDE))).toEqual(['repo_not_found']);
  });

  it('目标不是 git 仓库 → repo_not_git（有无分支都一样）', async () => {
    expect(errorKinds(await resolve(`/t /repo wt "${spacedRepoDir}" feat/x`, CLAUDE))).toEqual(['repo_not_git']);
    expect(errorKinds(await resolve(`/t /repo wt "${spacedRepoDir}" 干活`, CLAUDE))).toEqual(['repo_not_git']);
  });

  it('分支过了粗模式但 git check-ref-format 拒绝 → branch_invalid', async () => {
    expect(errorKinds(await resolve('/t /repo wt botmux a.lock', CLAUDE))).toEqual(['branch_invalid']);
    expect(errorKinds(await resolve('/t /repo wt botmux feat/', CLAUDE))).toEqual(['branch_invalid']);
  });

  it('显式分支的目标目录已存在 → worktree_target_exists（零副作用）', async () => {
    mkdirSync(join(scanRoot, 'botmux-feat-taken'), { recursive: true });
    const result = await resolve('/t /repo wt botmux feat/taken', CLAUDE);
    expect(result).toEqual({ ok: false, errors: [{ kind: 'worktree_target_exists', path: join(scanRoot, 'botmux-feat-taken') }] });
  });

  it('多处错误一次收齐', async () => {
    expect(errorKinds(await resolve('/t /repo wt botmux a.lock /model 命令为啥坏了', CLAUDE)))
      .toEqual(['branch_invalid', 'model_invalid']);
  });
});

describe('resolveTopicSpec —— 生命周期变体', () => {
  it('/tw、/t here 透传 lifecycle，不解析目录（目录由 daemon 按群会话状态决定）', async () => {
    const wt = await resolve('/tw 干活', CLAUDE);
    expect(wt).toMatchObject({ ok: true, lifecycle: 'worktree' });
    expect(wt).not.toHaveProperty('workingDir');
    expect(await resolve('/t here /model sonnet 干活', CLAUDE)).toMatchObject({ ok: true, lifecycle: 'here', model: 'sonnet' });
  });

  it('变体与 /repo（含 /repo wt、裸 /repo）相斥 → lifecycle_conflicts_repo，不做静默优先级', async () => {
    expect(errorKinds(await resolve('/tw /repo botmux 干活', CLAUDE))).toEqual(['lifecycle_conflicts_repo']);
    expect(errorKinds(await resolve('/th /repo wt botmux ci/x 干活', CLAUDE))).toEqual(['lifecycle_conflicts_repo']);
    expect(errorKinds(await resolve('/t here /repo', CLAUDE))).toEqual(['lifecycle_conflicts_repo']);
  });

  it('相斥之外的错误照常一并收齐', async () => {
    expect(errorKinds(await resolve('/tw /repo botmux /model 命令为啥坏了', CLAUDE)))
      .toEqual(['lifecycle_conflicts_repo', 'model_invalid']);
  });
});
