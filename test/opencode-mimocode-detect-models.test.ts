/**
 * opencode / mimocode detectModels — live 模型枚举（`<bin> models` 纯文本列表）。
 *
 * fail-soft（spawn 失败 / 超时 / 输出无有效模型行 → null，绝不抛）通过 mock
 * node:child_process 的 execFile 验证——沿用 test/traex-detect-models.test.ts
 * 的先例：importOriginal 保留 spawnSync 等真实导出，避免污染 resolveCommand。
 * opencode.ts 顶层不 promisify（lazy 到调用时），mock 以 (err, { stdout, stderr })
 * 两参回调，默认 promisify 把单个 success 值直接 resolve 为该对象。
 *
 * parseModelList 的纯函数用例（ANSI 剥离 / 元数据截断 / 去重 / 坏行跳过）
 * 在本文件末尾直接测导出函数。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileCalls: { file: string; args: string[] }[] = [];
let execFileStdout = '';
let execFileError: Error | null = null;

vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      execFileCalls.push({ file, args });
      if (execFileError) cb(execFileError);
      else cb(null, { stdout: execFileStdout, stderr: '' });
    },
  };
});

import { createOpenCodeAdapter, parseModelList } from '../src/adapters/cli/opencode.js';
import { createMiMoCodeAdapter } from '../src/adapters/cli/mimocode.js';

// 绝对路径：resolveCommand 对绝对路径原样返回（registry.ts），detectModels
// 不会 shell out，mock 只需覆盖 execFile。
const OPENCODE_BIN = '/usr/local/bin/opencode';
const MIMO_BIN = '/usr/local/bin/mimo';

// 实测 mimo 1.x `models` 输出形态：每行 provider/name，可带展示元数据。
const MIMO_SAMPLE = [
  'mimo/mimo-auto — window 1M, compacts at 900K',
  'xiaomi/mimo-v2.5-pro — window 1.05M, compacts at 944K',
  'xiaomi-token-plan-cn/mimo-v2.5 — window 1.05M, compacts at 944K',
  '',
].join('\n');

describe('opencode/mimocode detectModels（mock child_process）', () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    execFileStdout = '';
    execFileError = null;
  });

  it('成功：spawn `opencode models` 并返回模型 id 列表（含多级 provider）', async () => {
    execFileStdout = 'anthropic/claude-sonnet-4\nopenrouter/anthropic/claude-sonnet-4\n';
    const adapter = createOpenCodeAdapter(OPENCODE_BIN);
    const models = await adapter.detectModels!();
    expect(models).toEqual(['anthropic/claude-sonnet-4', 'openrouter/anthropic/claude-sonnet-4']);
    expect(execFileCalls).toEqual([{ file: OPENCODE_BIN, args: ['models'] }]);
  });

  it('成功：spawn `mimo models` 并剥掉 ` — …` 展示元数据', async () => {
    execFileStdout = MIMO_SAMPLE;
    const adapter = createMiMoCodeAdapter(MIMO_BIN);
    const models = await adapter.detectModels!();
    expect(models).toEqual([
      'mimo/mimo-auto',
      'xiaomi/mimo-v2.5-pro',
      'xiaomi-token-plan-cn/mimo-v2.5',
    ]);
    expect(execFileCalls).toEqual([{ file: MIMO_BIN, args: ['models'] }]);
  });

  it('fail-soft：spawn 失败 → null（不抛）', async () => {
    execFileError = new Error('spawn ENOENT');
    const adapter = createOpenCodeAdapter(OPENCODE_BIN);
    await expect(adapter.detectModels!()).resolves.toBeNull();
  });

  it('fail-soft：输出无有效模型行 → null', async () => {
    execFileStdout = 'something went wrong\nnot-a-model-id\n';
    const adapter = createOpenCodeAdapter(OPENCODE_BIN);
    await expect(adapter.detectModels!()).resolves.toBeNull();
  });

  it('fail-soft：输出为空 → null（与「无法枚举」不可区分，picker 回退 modelChoices）', async () => {
    execFileStdout = '';
    const adapter = createMiMoCodeAdapter(MIMO_BIN);
    await expect(adapter.detectModels!()).resolves.toBeNull();
  });
});

describe('parseModelList（纯函数）', () => {
  it('剥离 ANSI 颜色序列（TTY 直出时可能带色）', () => {
    expect(parseModelList('\u001b[32mxiaomi/mimo-v2.5\u001b[0m\n')).toEqual(['xiaomi/mimo-v2.5']);
  });

  it('截断 ` — …` 元数据并去重，保持出现顺序', () => {
    const stdout = 'xiaomi/mimo-v2.5 — window 1.05M\nxiaomi/mimo-v2.5\nmimo/mimo-auto\n';
    expect(parseModelList(stdout)).toEqual(['xiaomi/mimo-v2.5', 'mimo/mimo-auto']);
  });

  it('跳过标题/空行/不符合 provider/name 形态的行', () => {
    const stdout = 'Available models:\n\nplain-word\n/g leading-slash\nok/model\n';
    expect(parseModelList(stdout)).toEqual(['ok/model']);
  });
});
