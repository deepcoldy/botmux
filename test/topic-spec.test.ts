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
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseTopicHeader, type TopicHeader } from '../src/core/topic-header.js';
import { resolveTopicSpec, type TopicSpecResult } from '../src/core/topic-spec.js';

let scanRoot: string;
let repoDir: string;
let spacedRepoDir: string;

beforeAll(() => {
  scanRoot = mkdtempSync(join(tmpdir(), 'botmux-topic-spec-'));
  repoDir = join(scanRoot, 'botmux');
  spacedRepoDir = join(scanRoot, 'my project');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(spacedRepoDir, { recursive: true });
});

afterAll(() => {
  rmSync(scanRoot, { recursive: true, force: true });
});

/** 解析 + 解规格的一步到位助手；解析必须成功，否则用例本身写错了。 */
function resolve(text: string, botCfg: Parameters<typeof resolveTopicSpec>[1]['botCfg']): TopicSpecResult {
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
  it('标题 / 仓库 / 模型 / 推理强度逐项落到规格上', () => {
    const result = resolve('日常运维 /t /repo botmux /model sonnet /effort high 看看日志', CLAUDE);
    expect(result).toEqual({
      ok: true,
      title: '日常运维',
      workingDir: repoDir,
      repoDisplayName: expect.any(String),
      model: 'sonnet',
      reasoningEffort: 'high',
    });
  });

  it('没写的指令不出现在规格里（缺席 = 沿用现有配置）', () => {
    expect(resolve('/t 看看日志', CLAUDE)).toEqual({ ok: true });
  });

  it('带空格的仓库路径经双引号参数解析', () => {
    const result = resolve(`/t /repo "${spacedRepoDir}" 跑测试`, CLAUDE);
    expect(result).toMatchObject({ ok: true, workingDir: spacedRepoDir });
  });

  it('模型名允许网关映射名与方括号变体', () => {
    for (const model of ['sonnet[1m]', 'claude-opus-5', 'model_hub/gpt-5.4', 'gpt-5.6-sol']) {
      expect(resolve(`/t /model ${model} 干活`, { cliId: 'codex' })).toMatchObject({ ok: true, model });
    }
  });
});

describe('resolveTopicSpec —— /repo 的拒绝分支', () => {
  it('数字形式：卡片才有编号，头部里没有卡片', () => {
    const result = resolve('/t /repo 2 干活', CLAUDE);
    expect(errorKinds(result)).toEqual(['repo_numeric']);
  });

  it('worktree 子命令：头部吃不下它的多个参数，显式拒绝而不是静默开错目录', () => {
    // `/t /repo wt botmux feat/x` 会把 `wt` 当仓库名。多数情况报「找不到仓库 wt」还算
    // 能懂，但扫描根下只要恰好有个叫 wt 的目录，就会**静默开在错误的目录里**。
    const result = resolve('/t /repo wt botmux feat/x', CLAUDE);
    expect(errorKinds(result)).toEqual(['repo_worktree_unsupported']);
  });

  it('解析不到任何存在的目录', () => {
    const result = resolve('/t /repo 并不存在的仓库 干活', CLAUDE);
    expect(errorKinds(result)).toEqual(['repo_not_found']);
  });
});

describe('resolveTopicSpec —— /model 的拒绝分支', () => {
  it('模型名不像模型名（正文被当成模型名消费的那条边界）', () => {
    const result = resolve('/t /repo botmux /model 命令为啥坏了', CLAUDE);
    expect(errorKinds(result)).toEqual(['model_invalid']);
  });

  it('模型名超长', () => {
    const result = resolve(`/t /model ${'a'.repeat(65)} 干活`, CLAUDE);
    expect(errorKinds(result)).toEqual(['model_invalid']);
  });

  it('CLI 的启动路径带不动模型（dsh-tui：列了候选但不注入）', () => {
    const result = resolve('/t /model deepseek-v4-pro 干活', { cliId: 'dsh-tui' });
    expect(errorKinds(result)).toEqual(['model_unsupported_cli']);
  });

  it('riff 后端：模型只从 bot 的 riff 配置块取，每次启动覆盖不了', () => {
    const result = resolve('/t /model gpt-5.4 干活', { cliId: 'codex', backendType: 'riff' });
    expect(errorKinds(result)).toEqual(['model_unsupported_cli']);
  });

  it('mojo 远端后端能带模型 → 放行', () => {
    expect(resolve('/t /model glm-5-turbo 干活', { cliId: 'mojo' })).toMatchObject({
      ok: true, model: 'glm-5-turbo',
    });
  });
});

describe('resolveTopicSpec —— /effort 的拒绝分支', () => {
  it('不是合法档位', () => {
    const result = resolve('/t /effort turbo 干活', CLAUDE);
    expect(errorKinds(result)).toEqual(['effort_invalid']);
  });

  it('CLI 没有显式推理控制', () => {
    const result = resolve('/t /effort high 干活', { cliId: 'gemini' });
    expect(errorKinds(result)).toEqual(['effort_unsupported_cli']);
  });

  it('档位合法但本次要用的模型不支持（Claude 的 haiku 不吃 effort）', () => {
    const result = resolve('/t /effort high 干活', { cliId: 'claude-code', model: 'haiku' });
    expect(errorKinds(result)).toEqual(['effort_unsupported_model']);
  });

  it('按头部钉的模型校验，而不是 bot 配置的模型', () => {
    // bot 配的 opus 支持 max；头部把模型改成 haiku 之后就不支持了。
    const result = resolve('/t /model haiku /effort max 干活', CLAUDE);
    expect(errorKinds(result)).toEqual(['effort_unsupported_model']);
    expect(resolve('/t /model opus /effort max 干活', CLAUDE)).toMatchObject({
      ok: true, model: 'opus', reasoningEffort: 'max',
    });
  });

  it('ultra 是 codex/traex 专属：Claude 上拒绝，codex 上放行', () => {
    expect(errorKinds(resolve('/t /effort ultra 干活', CLAUDE))).toEqual(['effort_unsupported_model']);
    expect(resolve('/t /model gpt-5.6-sol /effort ultra 干活', { cliId: 'codex' })).toMatchObject({
      ok: true, reasoningEffort: 'ultra',
    });
  });
});

describe('resolveTopicSpec —— 一次收齐所有错误', () => {
  it('仓库与模型都写错时两条一起返回，用户改一次就够', () => {
    const result = resolve('/t /repo 并不存在 /model 中文模型名 干活', CLAUDE);
    expect(errorKinds(result)).toEqual(['repo_not_found', 'model_invalid']);
  });

  it('任一项失败就整条拒绝，不落半截规格（D5 fail closed）', () => {
    const result = resolve('日常运维 /t /repo botmux /model 中文模型名 干活', CLAUDE);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('workingDir');
    expect(result).not.toHaveProperty('title');
  });
});
