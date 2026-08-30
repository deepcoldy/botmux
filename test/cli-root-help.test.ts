import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { tsRunnerPrefix } from './helpers/ts-runner.js';

describe('botmux root help workflow surface', () => {
  it('advertises v3 Saved/ad-hoc commands and isolates v2 under the migration namespace', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-root-help-'));
    try {
      const env = { ...process.env, HOME: home };
      delete env.BOTMUX_WORKFLOW;
      // execFileSync 形态，wrapper 表达不了，用 runner 前缀拼 argv。
      const { command, prefixArgs } = tsRunnerPrefix();
      const stdout = execFileSync(
        command,
        [
          ...prefixArgs,
          fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
          '--help',
        ],
        { cwd: process.cwd(), env, encoding: 'utf-8' },
      );

      expect(stdout).toContain('workflow save [last|runId] [名称]');
      expect(stdout).toContain('goal run <goal> [--run-id <id>]');
      expect(stdout).toContain('actor current --json');
      expect(stdout).toContain('同一 run-id 可安全重放终态或接续崩溃运行');
      expect(stdout).toContain('发布当前 Bot 全局版本 / 确认 unsafe lint 请由用户在飞书显式发送');
      expect(stdout).toContain('workflow run <名称|workflowId> [--param key=value ...]');
      expect(stdout).toContain('workflow new|spec-finalize|approve-spec|revise-spec|architect|revise-dag');
      expect(stdout).toContain('workflow approve-dag|start');
      expect(stdout).toContain('template migrate-v3 [id|path ...]');
      expect(stdout).toContain('v2 定义迁移：默认 dry-run');
      expect(stdout).toContain('template archive-runs [--commit|--verify <archive>|--retire <archive> --ack-daemon-stopped]');
      expect(stdout).toContain('v2 历史 run 私有静态归档');
      expect(stdout).toContain('原子迁入 quarantine');
      expect(stdout).not.toContain('template <run|resume|cancel|ls|tail|validate|show>');
      expect(stdout).not.toContain('v2 执行兼容面');
      expect(stdout).not.toContain('workflow <run|resume|cancel|ls|tail|validate|show>');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ['start', '--help'],
    ['start', '-h'],
    ['stop', '--help'],
    ['stop', '-h'],
    ['restart', '--help'],
    ['restart', '-h'],
    ['upgrade', '--help'],
    ['upgrade', '-h'],
    ['update', '--help'],
    ['update', '-h'],
  ])('%s %s prints root help without fleet or package-manager side effects', (command, flag) => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-root-help-mutation-'));
    const binDir = join(home, 'empty-bin');
    const sentinel = join(home, 'mutation-sentinel');
    mkdirSync(binDir);
    writeFileSync(sentinel, 'untouched\n');
    try {
      const env = {
        ...process.env,
        HOME: home,
        PATH: binDir,
        SESSION_DATA_DIR: join(home, '.botmux', 'data'),
        BOTS_CONFIG: join(home, '.botmux', 'bots.json'),
      };
      delete env.BOTMUX_WORKFLOW;
      const before = readdirSync(home).sort();
      // 注意：本测试的 `command` 是被测子命令参数，runner 可执行文件另起名避免遮蔽。
      const { command: runner, prefixArgs } = tsRunnerPrefix();
      const stdout = execFileSync(
        runner,
        [
          ...prefixArgs,
          fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
          command,
          flag,
        ],
        { cwd: process.cwd(), env, encoding: 'utf-8' },
      );

      expect(stdout).toContain('botmux v');
      expect(stdout).toContain('restart     重启 daemon');
      // The claim under test is that BOTMUX mutates nothing in HOME. `.bun` is
      // the Bun runtime's own install cache (`.bun/install/cache`), minted by the
      // interpreter that runs the child — it appears when the suite runs under
      // `bun test`, never under Node. Filter just that entry rather than
      // weakening to a subset match, so any botmux-created file still fails.
      expect(readdirSync(home).filter(entry => entry !== '.bun').sort()).toEqual(before);
      expect(readFileSync(sentinel, 'utf8')).toBe('untouched\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
