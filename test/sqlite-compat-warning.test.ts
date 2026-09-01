/**
 * 会话库上了 SQLite 之后，CLI 的 stderr 必须保持干净。
 *
 * Node 22（CI 与多数安装跑的版本）在首次加载 `node:sqlite` 时会打两行
 * `ExperimentalWarning: SQLite is an experimental feature …`。对 daemon 只是
 * 一行噪音；对 CLI 是真缺陷：`botmux list` 跑在备用屏上，这两行会把钉住的
 * 标题挤出屏幕（CI 上正是这样挂的），并且污染每一个碰会话库的 agent 侧
 * `botmux` 命令的 stderr。加 `process.on('warning')` 监听器挡不住——Node 的
 * 默认打印照跑——所以必须在 emit 处过滤。
 *
 * ⚠️ 这条用例的把关能力**依赖运行时**：Node 24 本身就不再发这个警告，所以在
 * 24 上它恒绿。真正的回归拦截发生在 CI（Node 22）。
 */
import { describe, it, expect } from 'vitest';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

describe('sqlite-compat 不把 Node 的实验特性警告漏到 stderr', () => {
  it('加载引擎不产生任何 ExperimentalWarning', () => {
    const r = spawnSyncTsEvalWithRepoImports(
      `import { sqliteEngineAvailable } from './src/services/sqlite-compat.js';
       process.stdout.write(String(sqliteEngineAvailable()));`,
      { encoding: 'utf-8', cwd: process.cwd() },
    );
    expect(String(r.stdout)).toBe('true');
    expect(String(r.stderr)).not.toMatch(/ExperimentalWarning/);
    expect(String(r.stderr)).not.toMatch(/SQLite is an experimental feature/);
  });
});
