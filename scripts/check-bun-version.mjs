#!/usr/bin/env bun
// 软强制本地 bun 版本：与 package.json 的 `packageManager` 不一致时打告警，**永不让调用方失败**。
//
// `packageManager` 是唯一来源：CI 所有 workflow 的 `bun-version` / `npm i -g bun@…` 都钉同一版本，
// test/release-darwin-codesign-gate.test.ts 守着它们一致。但 bun 自己不校验这个字段，本地版本
// 漂了不会有任何报错——只是编译产物（`bun build --compile`）、bun.lock 重写、`bun test` 的行为
// 悄悄与 CI 不同，排查时很难想到是工具链版本。所以在 build 与编译入口让它至少被看见一次。
//
// 告警而不拦截：试新版 bun、或 pin 还没跟上新 patch 时，硬失败只会挡住正常开发。
//
// 调用方：`bun run build` 开头直接跑本文件；scripts/build-bun-binary.mjs import
// `warnIfBunVersionDrifts()`——CI 与文档都直接调那个脚本，不经过 `bun run build:bun`。
//
// 对齐命令用官方安装脚本而不是 `bun upgrade`：前者能指定版本（后者只会升到最新，可能越过
// pin），且是解压到同目录再 `mv` 换 inode，fleet 正跑着的 bun 进程不受影响；bun 已在 PATH
// 上时它在改 shell rc 之前就退出。
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  return m ? m.slice(1, 4).map(Number) : undefined;
}

/** 告警文案；版本一致、或任一方解析不出时返回 undefined。 */
export function bunVersionWarning(pinned, actual) {
  const p = parse(pinned);
  const a = parse(actual);
  if (!p || !a || pinned === actual) return undefined;
  const diff = a.map((n, i) => n - p[i]).find(d => d !== 0) ?? 0;
  const relation = diff < 0 ? '旧于' : diff > 0 ? '新于' : '不同于';
  return [
    `⚠️  本地 bun ${actual} ${relation}项目钉的 ${pinned}（package.json packageManager，CI 同版本）`,
    '   编译产物、bun.lock 重写、bun test 的行为可能与 CI 不一致（仅告警，不拦截）。',
    `   对齐：curl -fsSL https://bun.sh/install | bash -s "bun-v${pinned}"`,
  ].join('\n');
}

function pinnedBunVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  return /^bun@(.+)$/.exec(pkg.packageManager ?? '')?.[1];
}

function localBunVersion() {
  // 被 bun 跑时就是那个 bun；被 node 跑时问 PATH 上的 bun（`bun run` 用的也是它）。
  if (process.versions.bun) return process.versions.bun;
  return execFileSync('bun', ['--version'], { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** 漂了就往 stderr 打一段告警。任何内部错误都吞掉：这是提醒，不能让 build 因它失败。 */
export function warnIfBunVersionDrifts() {
  try {
    const warning = bunVersionWarning(pinnedBunVersion(), localBunVersion());
    if (warning) console.warn(warning);
  } catch { /* 读不到 package.json / 没有 bun：交给后续步骤自己报错 */ }
}

// 守卫自身的路径解析也不许抛出（argv[1] 可能过期或不存在）：本文件的契约是
// 「只提醒，永不连累调用方」，任何方式 import/执行它都必须静默 exit 0。
try {
  if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    warnIfBunVersionDrifts();
  }
} catch { /* argv[1] 不可解析：不按自执处理即可 */ }
