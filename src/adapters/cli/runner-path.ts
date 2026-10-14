import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 定位「runner 型适配器」（codex-app / dsh / mira / mir / minimax）随包携带的 `<name>-runner.js`。
 *
 * 之前每个适配器各抄一份 `runnerPath()`，只有文件名、测试覆盖 env、末位兜底三处不同。
 * 本文件与各适配器同在 `adapters/cli/` 下（源码态与 `dist/adapters/cli/` 同层），所以
 * `import.meta.url` 解析出的相对位置与原先各自的 `runnerPath()` 完全一致。
 *
 * 编译态（单文件二进制）下模块图在 `/$bunfs/` 里，这两个候选都不存在 —— 编译态的真实入口
 * 由 `core/self-spawn.ts` 的 `runnerArgv0` 决定，这里返回的路径在编译态不会被使用。
 */
export interface RunnerPathOptions {
  /**
   * 仅测试用：`NODE_ENV === 'test'` 时由该环境变量覆盖。源码级 worker 集成测试走 tsx，需要匹配的
   * 源码 runner，而不是可能缺失/过期的 dist；严格限定在测试环境，生产解析不会被环境变量改写。
   */
  testOverrideEnv?: string;
  /**
   * 两个候选都不存在时返回哪一个：默认 `'sibling'`（编译产物同层，沿袭 codex-app / dsh / mira / mir），
   * `'dist'` 返回源码树的 `dist/` 路径（minimax 的历史行为）。
   */
  fallback?: 'sibling' | 'dist';
}

export function resolveRunnerPath(runnerFile: string, opts: RunnerPathOptions = {}): string {
  const testOverride = opts.testOverrideEnv && process.env.NODE_ENV === 'test'
    ? process.env[opts.testOverrideEnv]
    : undefined;
  if (testOverride) return resolve(testOverride);
  const here = dirname(fileURLToPath(import.meta.url));
  const compiledSibling = resolve(here, '..', '..', runnerFile);
  if (existsSync(compiledSibling)) return compiledSibling;
  const builtFromSourceTree = resolve(here, '..', '..', '..', 'dist', runnerFile);
  if (opts.fallback === 'dist') return builtFromSourceTree;
  if (existsSync(builtFromSourceTree)) return builtFromSourceTree;
  return compiledSibling;
}
