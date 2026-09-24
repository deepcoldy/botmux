import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
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
      expect(stdout).toContain('auth request [--scope "<scope1 scope2,...>"] [--json]');
      expect(stdout).toContain('auth wait --request-id <id> [--json]');
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
  // `send --help` regressed differently from the commands above: cmdSend had no
  // --help intercept at all, so `--help` fell through positionals() (which
  // filters it as a flag) into readStdin(). With a pipe that reaches EOF that
  // surfaced as exit 1 「没有内容可发送」; with stdin that never closes — an open
  // socket, which is what a relay shell hands the CLI — the process waited for
  // EOF forever and wedged the calling shell. Both shapes are asserted here.
  it.each([
    ['--help'],
    ['-h'],
    // --help must outrank every other flag, including the @-decision gate that
    // rejects this contradictory pair with exit 2 when a body is present.
    ['--no-mention', '--help'],
    ['--mention', 'ou_probe:probe', '--no-mention', '--help'],
  ])('send %s prints the send help instead of waiting on stdin', (...flags) => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-send-help-'));
    try {
      const env = { ...process.env, HOME: home };
      delete env.BOTMUX_WORKFLOW;
      const { command, prefixArgs } = tsRunnerPrefix();
      const stdout = execFileSync(
        command,
        [
          ...prefixArgs,
          fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
          'send',
          ...flags,
        ],
        // An empty pipe still reaches EOF, so a missing intercept fails loudly
        // (exit 1) here rather than hanging the suite.
        { cwd: process.cwd(), env, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );

      // The flag documentation itself, not merely the one-line usage error.
      expect(stdout).toContain('send [content]');
      expect(stdout).toContain('--help, -h');
      expect(stdout).toContain('--image-mode <mode>');
      expect(stdout).toContain('--video-covers <path>');
      expect(stdout).toContain('@ 硬门：每条回复须三选一');
      expect(stdout).not.toContain('没有内容可发送');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('send --help does not wait for EOF when stdin is a socket that never closes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-send-help-socket-'));
    const server = createServer();
    try {
      const env = { ...process.env, HOME: home };
      delete env.BOTMUX_WORKFLOW;
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      // A connected socket held open by the peer: readStdin() would never see
      // 'end', so a missing intercept hangs until the test timeout instead of
      // exiting. This is the shape that left `send --help` processes resident
      // for days, each blocking the shell that spawned it.
      const peer = connect(port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        peer.once('connect', () => resolve());
        peer.once('error', reject);
      });
      const { command, prefixArgs } = tsRunnerPrefix();
      const child = spawn(
        command,
        [
          ...prefixArgs,
          fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
          'send',
          '--help',
        ],
        { cwd: process.cwd(), env, stdio: [peer, 'pipe', 'ignore'] },
      );
      let stdout = '';
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      const code = await new Promise<number | null>(resolve => child.once('close', resolve));

      expect(code).toBe(0);
      expect(stdout).toContain('send [content]');
      peer.destroy();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
