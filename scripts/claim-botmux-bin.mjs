#!/usr/bin/env node
// 认领全局 `botmux`：把 ~/.botmux/bin/botmux 的瘦 wrapper 重写为指向「本 checkout」
// 的 dist/cli.js。供 `pnpm use:here` / `pnpm switch:here` 显式调用 —— 故意不挂进
// `build`，避免 review/验证别人 PR 时一次纯编译就悄悄抢走全局 botmux 的指向。
//
// 写入内容与 daemon 启动时写的 wrapper 完全一致（见 src/daemon.ts），所以两者幂等：
// 「在哪 build+use，全局 botmux 就指哪；下次 daemon restart-from-dir 再覆盖」均自洽。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

// 逃生阀：偶尔只想 build 不想抢全局时 `BOTMUX_NO_CLAIM=1 pnpm use:here`
if (process.env.BOTMUX_NO_CLAIM) {
  console.log('↪︎ BOTMUX_NO_CLAIM 已设，跳过认领全局 botmux');
  process.exit(0);
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliScript = join(repoRoot, 'dist', 'cli.js');
const binDir = join(homedir(), '.botmux', 'bin');
const wrapper = join(binDir, 'botmux');
const content = `#!/bin/sh\nexec node "${cliScript}" "$@"\n`;

if (!existsSync(cliScript)) {
  console.warn(`⚠️  ${cliScript} 还不存在——先 \`pnpm build\`（或用 \`pnpm switch:here\`）。wrapper 仍按此路径写入。`);
}

try {
  mkdirSync(binDir, { recursive: true });
  let existing = '';
  try { existing = readFileSync(wrapper, 'utf-8'); } catch { /* 尚不存在 */ }
  if (existing === content) {
    console.log(`✓ 全局 botmux 已指向本 checkout（${cliScript}）`);
  } else {
    writeFileSync(wrapper, content, { mode: 0o755 });
    console.log(`✅ 全局 botmux → 本 checkout（${cliScript}）`);
    console.log('   下一步 `botmux restart` 即从本 checkout 重启 daemon。');
  }
} catch (err) {
  console.warn(`⚠️  写 botmux wrapper 失败：${err.message}`);
  process.exit(1);
}
