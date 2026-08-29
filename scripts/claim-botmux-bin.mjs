#!/usr/bin/env node
// 认领全局 `botmux`：把 ~/.botmux/bin/botmux 的瘦 wrapper 重写为指向「本 checkout」
// 的 dist/cli.js。供 `bun run use:here` / `bun run switch:here` 显式调用 —— 故意不挂进
// `build`，避免 review/验证别人 PR 时一次纯编译就悄悄抢走全局 botmux 的指向。
//
// 写入内容与 daemon 启动时写的 wrapper 完全一致（见 src/daemon.ts），所以两者幂等：
// 「在哪 build+use，全局 botmux 就指哪；下次 daemon restart-from-dir 再覆盖」均自洽。
//
// ── --binary 模式：让本地 fleet 真的跑编译版 ──────────────────────────────
// 默认模式写的是 `exec node <checkout>/dist/cli.js`，也就是**源码态**。用户装到的却是
// `bun build --compile` 出的单文件二进制（编译态），两者行为不一致的缺陷因此只在用户
// 侧暴露：编译态 `__dirname` 是虚拟的 `/$bunfs/root`，凡是「读随代码走的资源」或
// 「把拼出的路径交给别的进程」的代码都会坏，而本地开发 100% 走不到那条路。已经这样
// 漏过：Dashboard 整站 404（88e3d7f24）、setup 找不到 lark-scopes.json（2ef5c3a58）、
// `--version` 输出 unknown（c6b88e376）、二进制把自己覆盖成 47 字节壳（8386f34dd）。
//
// `--binary` 把全局 wrapper 改成 `exec <二进制> "$@"`（与生产 postinstall 写出的形态
// 逐字同构），于是日常 dogfood 用的就是用户用的形态，不一致会在使用中自己暴露，
// 不需要任何额外动作去发现它。
//
// 安全性：daemon 启动时也会写这个 wrapper，但它在 standalone 下写的是同一个 `exec
// <binary>` 形态，且写前 realpath 比对、目标是正在运行的二进制时跳过（src/daemon.ts
// 的 `isRunningBinary` 分支）——所以这里写完不会被 restart 改回去，也不会自毁。
import { fileURLToPath } from 'node:url';
import { dirname, basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, realpathSync, chmodSync, statSync } from 'node:fs';

// 原子写（与 src/utils/atomic-write.ts 同构，.mjs 不依赖 dist 故内联）：
// 这个 wrapper 随时被并发会话 exec，裸写半截会让它们的 `botmux send` 全体失败。
// 同构三要素缺一不可：①写前 realpath 穿透 symlink（否则把链接本体 rename 成
// 普通文件）②唯一 tmp 名 ③写后显式 chmod（creation mode 被 umask 截断，
// umask 077 下 0o755 会落成 0o700）。
function atomicWriteFileSync(filePath, data, mode) {
  try { filePath = realpathSync(filePath); }
  catch {
    try { filePath = join(realpathSync(dirname(filePath)), basename(filePath)); }
    catch { /* 父目录也不存在，保持原路径 */ }
  }
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  try {
    writeFileSync(tmp, data, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp 可能根本没写出来 */ }
    throw err;
  }
}

// 逃生阀：偶尔只想 build 不想抢全局时 `BOTMUX_NO_CLAIM=1 pnpm use:here`
if (process.env.BOTMUX_NO_CLAIM) {
  console.log('↪︎ BOTMUX_NO_CLAIM 已设，跳过认领全局 botmux');
  process.exit(0);
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binDir = join(homedir(), '.botmux', 'bin');
const wrapper = join(binDir, 'botmux');

// `--binary [路径]`：指向编译版二进制而不是 dist/cli.js。省略路径时用
// build:bun 的默认产物位置（scripts/build-bun-binary.mjs 的 dist-bin/botmux-<target>）。
const argv = process.argv.slice(2);
const binaryFlagAt = argv.indexOf('--binary');
const useBinary = binaryFlagAt !== -1;
const explicitBinary = useBinary ? argv[binaryFlagAt + 1] : undefined;

/** 本机 host target 的默认二进制名，与 build-bun-binary.mjs 的命名规则一致。 */
function defaultBinaryPath() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const plat = process.platform === 'darwin' ? 'darwin' : 'linux';
  return join(repoRoot, 'dist-bin', `botmux-${plat}-${arch}`);
}

let target;   // wrapper 里被 exec 的东西
let content;  // wrapper 全文

if (useBinary) {
  const requested = resolve(explicitBinary && !explicitBinary.startsWith('--') ? explicitBinary : defaultBinaryPath());
  if (!existsSync(requested)) {
    console.error(
      `❌ 找不到编译版二进制：${requested}\n`
      + '   先编一个：`bun run build && bun scripts/build-bun-binary.mjs --target bun-'
      + `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
      + ` --out dist-bin/botmux-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}\`\n`
      + '   或显式给路径：`bun run use:here --binary <path>`',
    );
    process.exit(1);
  }
  // 必须是可执行文件而不是脚本/目录：wrapper 会 `exec` 它，写错了全局 botmux 直接坏，
  // 而 ~50 个 live daemon 靠它跑 `botmux send`。
  if (!statSync(requested).isFile()) {
    console.error(`❌ ${requested} 不是文件，拒绝写入 wrapper。`);
    process.exit(1);
  }
  // realpath 而非 resolve：生产两侧都写解析后的真实路径（postinstall-bin.mjs 的
  // 原子写、daemon 传的 `process.execPath` 已由 OS 解析），经软链调用时若这里写
  // 未解析路径，三处形态就会漂移。
  target = realpathSync(requested);
  // 与 botmuxWrapperFiles() 的 standalone 分支、以及生产 postinstall 写出的 launcher
  // 逐字同构（test/claim-botmux-bin-binary.test.ts 钉住三者一致）。
  content = `#!/bin/sh\nexec "${target}" "$@"\n`;
} else {
  target = join(repoRoot, 'dist', 'cli.js');
  content = `#!/bin/sh\nexec node "${target}" "$@"\n`;
  if (!existsSync(target)) {
    console.warn(`⚠️  ${target} 还不存在——先 \`bun run build\`（或用 \`bun run switch:here\`）。wrapper 仍按此路径写入。`);
  }
}

const cliScript = target;

// 自毁守卫。`--binary` 让 wrapper 的**内容**指向一个真实二进制，而 install.sh 把二进制
// 装在 `~/.botmux/bin/botmux` —— 正是这个 wrapper 自己的路径。若两者是同一个文件，写入
// 会把可执行本体替换成 47 字节的 sh 壳（8386f34dd 实测：147,392,640 → 47 字节，inode 变化
// 证明 rename 顶掉了本体），随后 `botmux` 彻底不可用，而 fleet 里每个 worker 都把这个目录
// 前置 PATH，所有会话的 `botmux send` 会一起坏。
//
// 判据用 realpath 比对而不是字符串比较：两边可能经不同的 symlink 到达同一 inode。
if (useBinary) {
  let sameFile = false;
  try { sameFile = realpathSync(wrapper) === realpathSync(target); }
  catch { /* wrapper 尚不存在 ⟹ 不可能是同一个文件 */ }
  if (sameFile) {
    console.error(
      `❌ 拒绝写入：${wrapper} 就是 ${target} 本身。\n`
      + '   写下去会把二进制覆盖成一个几十字节的 sh 壳（历史事故 8386f34dd），\n'
      + '   全局 botmux 当场不可用，且 fleet 里所有会话的 `botmux send` 会一起坏。\n'
      + '   这种情况下本来就不需要认领：该二进制已经在 wrapper 的位置上了。',
    );
    process.exit(1);
  }
}

try {
  mkdirSync(binDir, { recursive: true });
  let existing = '';
  try { existing = readFileSync(wrapper, 'utf-8'); } catch { /* 尚不存在 */ }
  if (existing === content) {
    console.log(`✓ 全局 botmux 已指向${useBinary ? '编译版二进制' : '本 checkout'}（${cliScript}）`);
  } else {
    atomicWriteFileSync(wrapper, content, 0o755);
    console.log(`✅ 全局 botmux → ${useBinary ? '编译版二进制' : '本 checkout'}（${cliScript}）`);
    if (useBinary) {
      console.log('   下一步 `botmux restart` 让 fleet 跑编译版——之后日常使用的就是用户拿到的形态。');
      console.log('   切回源码态：`bun run use:here`（不带 --binary）。');
    } else {
      console.log('   下一步 `bun run daemon:restart` 即从本 checkout 重启 daemon（避免 PATH 中的旧全局 botmux 抢先）。');
    }
  }
} catch (err) {
  console.warn(`⚠️  写 botmux wrapper 失败：${err.message}`);
  process.exit(1);
}
