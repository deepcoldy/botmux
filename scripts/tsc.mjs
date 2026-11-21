#!/usr/bin/env node
/**
 * 构建用的 tsc 入口：优先 TypeScript 7 原生编译器（devDependency `typescript-native`），
 * 解析不到时退回 `typescript`（5.9）并告警。
 *
 * 退回是给「node_modules symlink 到 canonical checkout、而 canonical 还没装上
 * typescript-native」的 worktree 兜底：本地更新只跑 git pull + bun run build、不跑 install，
 * 没有退回的话从新 master 开出来的 worktree 会全部 build 失败。
 *
 * GitHub Actions 里按 lockfile 装齐依赖，在那里退回只能说明安装坏了，而且会让 CI 按旧版
 * 规则放行（TS 7 的 lib.dom 更严），所以直接失败。
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

function tscBin(pkg) {
  try {
    return join(dirname(require.resolve(`${pkg}/package.json`)), 'bin', 'tsc');
  } catch {
    return undefined;
  }
}

let bin = tscBin('typescript-native');
if (!bin) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error('[tsc] 找不到 typescript-native（TypeScript 7），CI 里不退回 typescript 5.9。检查 bun install --frozen-lockfile 是否装齐。');
    process.exit(1);
  }
  bin = tscBin('typescript');
  if (!bin) {
    console.error('[tsc] typescript-native 与 typescript 都解析不到，先安装依赖。');
    process.exit(1);
  }
  console.warn('[tsc] node_modules 里没有 typescript-native，本次退回 typescript 5.9（慢约一个数量级）。在 node_modules 所属的 checkout 里 bun install 后恢复。');
}

const result = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) {
  console.error(`[tsc] 启动 ${bin} 失败：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
