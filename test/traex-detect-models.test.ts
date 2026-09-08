/**
 * traex detectModels — live 模型枚举（`traex debug models`）。
 *
 * 输出解析（parseTraexModelsJson，即共享 parseDebugModelsJson 的 re-export）
 * 的纯函数用例已迁到 test/model-catalog-json.test.ts 统一覆盖；本文件只测
 * detectModels 的 spawn 参数与 fail-soft 契约。
 *
 * fail-soft（spawn 失败 / 超时 / 输出非法 → null，绝不抛）通过 mock
 * node:child_process 的 execFile 验证——沿用 test/zellij-observe-backend.test.ts
 * 的先例：importOriginal 保留 spawnSync 等真实导出，避免污染 resolveCommand。
 * traex.ts 顶层 promisify(execFile) 拿到的是这个 mock；mock 以
 * (err, { stdout, stderr }) 两参回调，默认 promisify 把单个 success 值
 * 直接 resolve 为该对象。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileCalls: { file: string; args: string[] }[] = [];
let execFileStdout = '';
let execFileError: Error | null = null;

vi.mock('node:child_process', () => {
  // `require` inside the factory, not the vitest-only `importOriginal` argument
  // (bun passes none) and not a top-level import (vitest hoists this call above
  // the imports, so a top-level namespace would be read before initialisation).
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

import { createTraexAdapter } from '../src/adapters/cli/traex.js';

// 绝对路径：resolveCommand 对绝对路径原样返回（registry.ts），detectModels
// 不会 shell out，mock 只需覆盖 execFile。
const TRAEX_BIN = '/usr/local/bin/traex';

const REAL_SHAPE = (models: unknown[]) => JSON.stringify({ models });
const modelEntry = (slug: string, visibility: string = 'list') => ({
  slug,
  description: `model ${slug}`,
  visibility,
  supported_in_api: true,
});

describe('traex detectModels（mock child_process）', () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    execFileStdout = '';
    execFileError = null;
  });

  it('成功：spawn `traex debug models` 并返回解析出的 slug 列表', async () => {
    execFileStdout = REAL_SHAPE([modelEntry('Seed-Evolving'), modelEntry('gpt-5.5')]);
    const adapter = createTraexAdapter(TRAEX_BIN);
    const models = await adapter.detectModels!();
    expect(models).toEqual(['Seed-Evolving', 'gpt-5.5']);
    expect(execFileCalls).toEqual([{ file: TRAEX_BIN, args: ['debug', 'models'] }]);
  });

  it('fail-soft：spawn 失败 → null（不抛）', async () => {
    execFileError = new Error('spawn ENOENT');
    const adapter = createTraexAdapter(TRAEX_BIN);
    await expect(adapter.detectModels!()).resolves.toBeNull();
  });

  it('fail-soft：输出非法 JSON → null', async () => {
    execFileStdout = 'something went wrong';
    const adapter = createTraexAdapter(TRAEX_BIN);
    await expect(adapter.detectModels!()).resolves.toBeNull();
  });

  it('fail-soft：models 为空 → null（与「无法枚举」不可区分，picker 回退 modelChoices）', async () => {
    execFileStdout = REAL_SHAPE([]);
    const adapter = createTraexAdapter(TRAEX_BIN);
    await expect(adapter.detectModels!()).resolves.toBeNull();
  });
});
