/**
 * codex / coco detectModels — live 模型枚举（`codex debug models` /
 * `coco debug models`）。两者输出与 traex 同构，共享 parseDebugModelsJson
 * （纯函数用例在 test/model-catalog-json.test.ts）。
 *
 * 本文件只测 spawn 参数与 fail-soft 契约，mock 模式与
 * test/traex-detect-models.test.ts 相同：vi.mock('node:child_process') +
 * importOriginal 保留 spawnSync（不污染 resolveCommand），mock 以
 * (err, { stdout, stderr }) 两参回调，默认 promisify 直接 resolve 该对象。
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

import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';

// 绝对路径：resolveCommand 对绝对路径原样返回（registry.ts），detectModels
// 不会 shell out，mock 只需覆盖 execFile。
const CODEX_BIN = '/usr/local/bin/codex';
const COCO_BIN = '/usr/local/bin/coco';

const REAL_SHAPE = (models: unknown[]) => JSON.stringify({ models });
const modelEntry = (slug: string, visibility: string = 'list') => ({
  slug,
  description: `model ${slug}`,
  visibility,
  supported_in_api: true,
});

describe('codex detectModels（mock child_process）', () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    execFileStdout = '';
    execFileError = null;
  });

  it('成功：spawn `codex debug models` 并返回解析出的 slug 列表', async () => {
    execFileStdout = REAL_SHAPE([modelEntry('gpt-5.6-sol'), modelEntry('gpt-5.5')]);
    const adapter = createCodexAdapter(CODEX_BIN);
    const models = await adapter.detectModels!();
    expect(models).toEqual(['gpt-5.6-sol', 'gpt-5.5']);
    expect(execFileCalls).toEqual([{ file: CODEX_BIN, args: ['debug', 'models'] }]);
  });

  it('过滤 visibility !== "list" 的模型', async () => {
    execFileStdout = REAL_SHAPE([
      modelEntry('gpt-5.6-sol'),
      modelEntry('gpt-5.6-hidden', 'hide'),
      modelEntry('gpt-5.2'),
    ]);
    const adapter = createCodexAdapter(CODEX_BIN);
    await expect(adapter.detectModels!()).resolves.toEqual(['gpt-5.6-sol', 'gpt-5.2']);
  });

  it('fail-soft：spawn 失败 → null（不抛）', async () => {
    execFileError = new Error('spawn ENOENT');
    const adapter = createCodexAdapter(CODEX_BIN);
    await expect(adapter.detectModels!()).resolves.toBeNull();
  });

  it('fail-soft：输出非法 JSON → null', async () => {
    execFileStdout = 'something went wrong';
    const adapter = createCodexAdapter(CODEX_BIN);
    await expect(adapter.detectModels!()).resolves.toBeNull();
  });

  it('fail-soft：models 为空 → null（picker 回退 modelChoices）', async () => {
    execFileStdout = REAL_SHAPE([]);
    const adapter = createCodexAdapter(CODEX_BIN);
    await expect(adapter.detectModels!()).resolves.toBeNull();
  });
});

describe('coco detectModels（mock child_process）', () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    execFileStdout = '';
    execFileError = null;
  });

  it('成功：spawn `coco debug models` 并返回解析出的 slug 列表', async () => {
    execFileStdout = REAL_SHAPE([modelEntry('Seed-Dogfooding-2.0'), modelEntry('gpt-5.5')]);
    const adapter = createCocoAdapter(COCO_BIN);
    const models = await adapter.detectModels!();
    expect(models).toEqual(['Seed-Dogfooding-2.0', 'gpt-5.5']);
    expect(execFileCalls).toEqual([{ file: COCO_BIN, args: ['debug', 'models'] }]);
  });

  it('fail-soft：spawn 失败 → null（不抛）', async () => {
    execFileError = new Error('spawn ENOENT');
    const adapter = createCocoAdapter(COCO_BIN);
    await expect(adapter.detectModels!()).resolves.toBeNull();
  });

  it('fail-soft：输出非法 JSON → null', async () => {
    execFileStdout = 'something went wrong';
    const adapter = createCocoAdapter(COCO_BIN);
    await expect(adapter.detectModels!()).resolves.toBeNull();
  });

  it('fail-soft：models 为空 → null（picker 回退 modelChoices）', async () => {
    execFileStdout = REAL_SHAPE([]);
    const adapter = createCocoAdapter(COCO_BIN);
    await expect(adapter.detectModels!()).resolves.toBeNull();
  });
});
