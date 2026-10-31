import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { spawnSyncTsScript } from './helpers/ts-runner.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const PROJECT_ROOT = join(__dirname, '..');

// 桩 git 输出的哨兵：断言靠它证明 status 调用被桩接住、真实 git/pull 从未执行。
const STUB_DIRTY_LINE = 'M botmux-test-stub-deliberately-dirty';
const STUB_STATUS_FAIL = 'botmux-test-stub: synthetic git status failure';
const STUB_UNEXPECTED = 'botmux-test-stub: unexpected git invocation';

let home: string;
let stubBin: string;
let failStubBin: string;

// 写一个只含桩 git 的非空 PATH 目录。不能用 PATH:''：Bun 在 PATH 为空/未设时会
// 回退到内置默认 PATH，bun-test 腿上因此解析到真实 git，CLI 对 runner 的真实
// checkout 跑了 git pull --ff-only（#2643）；非空但没有目标二进制的 PATH 在
// Node 与 Bun 下都严格 ENOENT。
function writeGitStub(dir: string, statusBody: { stdout?: string; stderr?: string; exit: number }): void {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const gitStub = join(bin, 'git');
  writeFileSync(gitStub, [
    '#!/bin/sh',
    'case "$1" in',
    '  status)',
    ...(statusBody.stdout ? [`    echo '${statusBody.stdout}'`] : []),
    ...(statusBody.stderr ? [`    echo '${statusBody.stderr}' >&2`] : []),
    `    exit ${statusBody.exit}`,
    '    ;;',
    '  *)',
    // 干净检查之后的任何调用都意味着隔离失效（真的要 pull/build 了）。
    `    echo '${STUB_UNEXPECTED}:' "$*" >&2`,
    '    exit 97',
    '    ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(gitStub, 0o755);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'botmux-update-alias-'));
  // 本地更新流程的第一步是 porcelain 干净检查；这个桩返回非空，让 CLI 走既有的
  // 「工作区不干净，中止更新」路径，不会进入 pull/build/restart。
  stubBin = mkdtempSync(join(tmpdir(), 'botmux-update-alias-dirty-'));
  writeGitStub(stubBin, { stdout: STUB_DIRTY_LINE, exit: 0 });
  // git status 自身失败（git 损坏/IO 错误）：CLI 必须报「读取 git 状态失败」并
  // 以 exit 1 中止，同样不得进入 pull/build/restart。
  failStubBin = mkdtempSync(join(tmpdir(), 'botmux-update-alias-fail-'));
  writeGitStub(failStubBin, { stderr: STUB_STATUS_FAIL, exit: 1 });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(stubBin, { recursive: true, force: true });
  rmSync(failStubBin, { recursive: true, force: true });
});

function runCli(command: string, binDir: string = stubBin): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSyncTsScript(CLI_PATH, [command], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SESSION_DATA_DIR: join(home, 'data'),
      PATH: join(binDir, 'bin'),
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 助手返回 string | Buffer(不带 spawnSync 的 encoding 重载narrowing);此处 encoding:'utf8' 保证是 string。
  return { status: result.status, stdout: result.stdout as string, stderr: result.stderr as string };
}

describe('botmux update alias', () => {
  it('behaves exactly like upgrade', () => {
    const upgrade = runCli('upgrade');
    const update = runCli('update');

    // 从本 checkout（有 .git/src）运行 → 走本地 checkout 更新分支。桩 git 让它在
    // 打印 banner 后的 porcelain 干净检查处确定性中止（报工作区不干净），不会真的
    // pull/build/restart。
    expect(upgrade.status).toBe(1);
    expect(upgrade.stdout).toContain('本地 checkout 更新');
    expect(upgrade.stderr).toContain(STUB_DIRTY_LINE);
    expect(upgrade.stderr).not.toContain(STUB_UNEXPECTED);
    // The core contract: `update` is a pure alias of `upgrade`. Compare the
    // observable CLI output, not the whole spawnSync result — bun adds extra
    // enumerable fields (`resourceUsage`, …) that differ across two invocations.
    expect(update.status).toBe(upgrade.status);
    expect(update.stdout).toBe(upgrade.stdout);
    expect(update.stderr).toContain(STUB_DIRTY_LINE);
    expect(update.stderr).not.toContain(STUB_UNEXPECTED);
  });

  it('aborts when the git status check itself fails, without pulling', () => {
    const result = runCli('upgrade', failStubBin);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('本地 checkout 更新');
    expect(result.stderr).toContain('读取 git 状态失败');
    expect(result.stderr).toContain(STUB_STATUS_FAIL);
    expect(result.stderr).not.toContain(STUB_UNEXPECTED);
  });

  it('documents the alias in help', () => {
    const help = runCli('--help');

    expect(help.status).toBe(0);
    expect(help.stdout).toContain('upgrade     升级到最新版本（别名：update）');
  });
});
