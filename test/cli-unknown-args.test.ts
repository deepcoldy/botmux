/**
 * 不认识的参数必须让命令**停下**，不能被静默丢掉后按默认语义全效果执行。
 *
 * 这两组命令的解析方式都是「把要的参数从 argv 里拉出来，剩下的忽略」。
 * 只要用户心里的参数集合和真实的不一致，拼错的或臆造的参数就会在无声中被丢掉，
 * 而命令照常执行 —— 从输出上看，这和「命令听懂了」是同一个样子。
 *
 * 失效方向是单向的：
 *   · `botmux update --check` / `--dry-run` 读起来都像「只看看」，实际会真的升级；
 *   · `botmux history --thread`（正确写法是 `--scope thread`）会按 session scope
 *     返回，而对一个 thread-scope 的会话来说那恰好是同一个窗口，连输出里都看不出来。
 *
 * Run:  bun run vitest run --project unit test/cli-unknown-args.test.ts
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { tsRunnerPrefix } from './helpers/ts-runner.js';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** HOME 的递归快照：每个目录一条、每个文件一条「相对路径 + 内容 sha256 前 12 位」。
 *  一条断言覆盖三个方向：新建 / 删除（路径集合变化）、就地改写（hash 变化）。
 *  ⚠️ 只看顶层 `readdirSync` 是不够的：实测这些命令建的是 `.botmux/data/` 这类
 *  **嵌套**路径，而往一个已存在的目录里写东西，顶层列表一个字都不会变。
 *  夹具里放一个 `mutation-sentinel` 文件，是为了让「就地改写」这一维**有被试对象**
 *  —— 没有任何既存文件时，那一维在构造上就没有主语，快照永远测不到它。
 *  它是这条断言的输入，不是第二条断言。
 *
 *  `.bun` 在**根一级**被跳过：那是 Bun 运行时自己的 install cache
 *  （`.bun/install/cache/@t@/*.pile`），由跑子进程的**解释器**写入，与被测命令
 *  无关 —— 只在本套件跑在 `bun test` 下时出现，Node 下永远没有。实测在
 *  `bun test` 里它会铺开 300+ 个文件，把这条断言整片染红。
 *  ⚠️ 只预置一个空 `.bun/` 目录**不够**：递归快照会看见里面新铺的整棵缓存树。
 *  也不能靠 env 挡（实测 `BUN_INSTALL` / `BUN_INSTALL_CACHE_DIR` 都不改这个位置）。
 *  所以按仓内既有做法过滤这一个条目（同 `test/cli-root-help.test.ts`），
 *  而不是把断言弱化成子集匹配 —— 任何 botmux 自己创建的文件仍然会让它红。 */
function snapshot(dir: string, root = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (dir === root && e.name === '.bun') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { out.push(relative(root, p) + '/'); snapshot(p, root, out); }
    else if (e.isFile()) out.push(`${relative(root, p)}:${createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12)}`);
    else out.push(relative(root, p) + '?');
  }
  return out;
}

/** 在一个一次性 HOME 里跑 cli，返回 rc/stdout/stderr。
 *  PATH 指向空目录：万一某天这道闸被拿掉，落进去的命令也找不到 git/包管理器，
 *  不会真的动这台机器（既有的 cli-root-help 测试用的是同一个夹具）。 */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string; homeUnchanged: boolean } {
  const home = mkdtempSync(join(tmpdir(), 'botmux-unknown-arg-'));
  const binDir = join(home, 'empty-bin');
  mkdirSync(binDir);
  writeFileSync(join(home, 'mutation-sentinel'), 'untouched\n');
  try {
    const env = {
      ...process.env,
      HOME: home,
      PATH: binDir,
      SESSION_DATA_DIR: join(home, '.botmux', 'data'),
      BOTS_CONFIG: join(home, '.botmux', 'bots.json'),
    };
    delete env.BOTMUX_WORKFLOW;
    const before = snapshot(home);
    const { command: runner, prefixArgs } = tsRunnerPrefix();
    let status: number | null = 0;
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync(runner, [...prefixArgs, CLI, ...args], { cwd: process.cwd(), env, encoding: 'utf-8' });
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? null;
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
    }
    return {
      status,
      stdout,
      stderr,
      homeUnchanged: JSON.stringify(snapshot(home)) === JSON.stringify(before),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('fleet 变更类命令：未知参数一律中止', () => {
  // 放行哪些参数由 `FLEET_KNOWN_FLAGS` 这张显式的表决定，**不是**由「dispatch 处
  // 零参数调用」推出来的。那条推论在本仓库不成立：`cmdStop()` / `cmdRestart()`
  // 同样是零参数调用，却直接从全局 `process.argv` 里读 `--with-plugin`
  // （`cmdLogs` / `cmdList` / `cmdSuspend` / `cmdSlash` 是同一个形状）。
  // 函数签名管不住 `process.argv`，所以「这个命令接受哪些参数」只有那张表说了算。
  // 下面「合法参数不被误杀」那一组就是这条推论的被试对象 —— 少了它，
  // 把一个真参数闸掉的改动在这个文件里不会有任何一格变红。
  // 第三列是**这条命令进了 dispatch 之后打的第一行字**。断言它缺席，证明的是
  // 「根本没进去过」，而不只是「进去了但恰好失败了」—— PATH 为空时命令落进去
  // 也会失败、退出码同样非 0，所以只看退出码分不开这两件事。
  //
  // 这三个串不是猜的，是在**没有这道闸**的 master 上逐条实测出来的（同一套夹具）：
  //   update / upgrade --check → rc=1，先打印「🔄 本地 checkout 更新：<repo>」，
  //                              然后真的去跑 git（只因 PATH 为空才 ENOENT 收场）
  //   restart / start          → rc=1，「❌ 未找到配置文件」
  //   stop --force             → rc=0，「daemon 未在运行。」
  it.each([
    ['update', '--check', '本地 checkout 更新'],
    ['update', '--dry-run', '本地 checkout 更新'],
    ['update', '-n', '本地 checkout 更新'],
    ['upgrade', '--check', '本地 checkout 更新'],
    ['restart', '--now', '未找到配置文件'],
    ['start', '--daemon', '未找到配置文件'],
    ['stop', '--force', 'daemon 未在运行'],
  ])('botmux %s %s → rc=2，不执行', (command, flag, dispatchMarker) => {
    const r = runCli([command, flag]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('未知参数');
    expect(r.stderr).toContain(flag);
    expect(r.stdout + r.stderr).not.toContain(dispatchMarker);
    // ⚠️ 这条断言的区分力**逐格不同**，同样是实测：没有这道闸时，
    //    update / upgrade 会新建 `.botmux/`+`.botmux/data/`，stop 会新建 4 个目录
    //    ⇒ 这四格上它真的会红；restart / start 在写任何东西之前就因缺配置退出
    //    ⇒ 那两格上它**恒绿**，那两格的全部区分力在上面那行 dispatchMarker 上。
    //    写在这儿是为了下一个人不要把「它一直是绿的」读成「它守住了什么」。
    expect(r.homeUnchanged).toBe(true);
  });

  it('--help 仍然照常打印帮助（不能被这道闸误伤）', () => {
    const r = runCli(['update', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('botmux v');
  });

  // ── 合法参数不被误杀 ────────────────────────────────────────────────────
  // `--with-plugin` 是 `stop` / `restart` 的正式参数：`cmdStop` (`process.argv
  // .includes('--with-plugin')`) 与 `cmdRestart` 都读它，`showHelp()` 也在教用户
  // 用它。一道只按「有没有多余 token」判断的闸会把它一起拒掉，而帮助里那一行仍在
  // 宣传它 —— 那正是这道闸最容易犯的错，所以它必须在这里有被试对象。
  //
  // 判据不用退出码：`stop` 在空 HOME 下 rc=0、`restart` rc=1，两者都不为 2 只说明
  // 「不是被这道闸拒的」，说明不了「进了 dispatch」。所以两条一起断言 ——
  // 没有「未知参数」，且**打出了这条命令进 dispatch 之后的第一行字**。
  // 这两个串同样是在 master 上实测出来的，与上面 it.each 第三列同源。
  it.each([
    ['stop', 'daemon 未在运行'],
    ['restart', '未找到配置文件'],
  ])('botmux %s --with-plugin 照常放行', (command, dispatchMarker) => {
    const r = runCli([command, '--with-plugin']);
    expect(r.stderr).not.toContain('未知参数');
    expect(r.stdout + r.stderr).toContain(dispatchMarker);
  });

  // 白名单是**按命令**的，不是全局的：同一个 flag 在没声明它的命令上仍是未知参数。
  // 少了这条，把 FLEET_KNOWN_FLAGS 摊平成一个全局集合不会有任何一格变红。
  //
  // `start --with-plugin` 落在这里是有意的，不是遗漏：`startConfiguredFleet` 无条件
  // 调 `reconcilePluginServicesForCli(undefined, { autoOnly: true })`，start 本来就
  // 永远拉起 auto plugin service；`--with-plugin` 在 stop/restart 上的语义是「额外
  // 把 plugin service 也停掉」，start 没有「停」这一段，加上去是个不生效的参数。
  it.each([
    ['start', '未找到配置文件'],
    ['update', '本地 checkout 更新'],
  ])('botmux %s --with-plugin → rc=2（这条命令没声明它）', (command, dispatchMarker) => {
    const r = runCli([command, '--with-plugin']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('未知参数');
    expect(r.stderr).toContain('--with-plugin');
    expect(r.stdout + r.stderr).not.toContain(dispatchMarker);
  });

  // 位置参数也要拦住。这一格不是顺带 —— 它排除了「用 `unknownFlags()` 实现这道闸」
  // 这条改法：那个 helper 只报以 `-` 开头的 token（是为 `history om_xxx` 这类命令
  // 设计的），照搬会让 `botmux stop foo` 静默通过，退回本 PR 之前的行为。
  it('botmux stop foo → rc=2（位置参数同样是未知参数）', () => {
    const r = runCli(['stop', 'foo']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('未知参数');
    expect(r.stderr).toContain('foo');
    expect(r.stdout + r.stderr).not.toContain('daemon 未在运行');
  });

  // 报错文案要按命令说出它到底接受什么，否则 stop/restart 上那句「只有 --help」
  // 本身就是错的，用户会照着它把一个能用的参数当成不存在。
  it('报错文案按命令列出可接受的参数', () => {
    expect(runCli(['stop', '--force']).stderr).toContain('只接受: --help --with-plugin');
    expect(runCli(['update', '--check']).stderr).toContain('只接受: --help');
    expect(runCli(['update', '--check']).stderr).not.toContain('--with-plugin');
  });
});

describe('botmux history：未知参数一律中止', () => {
  it.each([
    // 并不存在 `--thread`；正确写法是 `--scope thread`。
    ['--thread'],
    ['--json'],
    // 与已知参数共享前缀，仍然算未知。
    ['--limitless'],
  ])('botmux history %s → rc=2', (flag) => {
    const r = runCli(['history', flag]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('未知参数');
    expect(r.stderr).toContain(flag);
  });

  it('认识的参数不会被这道闸挡住', () => {
    // 这条用例只断言「没有被参数校验挡下」。它之后会撞上 transport / session 闸并
    // 以别的方式退出（那些闸也用 rc=2），所以退出码在这里没有区分力，不拿它做判据。
    const r = runCli(['history', '--limit', '10', '--scope', 'chat', '--with-card-json']);
    expect(r.stderr).not.toContain('未知参数');
  });
});
