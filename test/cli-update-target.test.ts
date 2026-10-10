import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { spawnSyncTsScript } from './helpers/ts-runner.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const PROJECT_ROOT = join(__dirname, '..');

const home = mkdtempSync(join(tmpdir(), 'botmux-cli-update-target-'));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSyncTsScript(CLI_PATH, args, {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SESSION_DATA_DIR: join(home, 'data'),
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

describe('botmux update/upgrade target arguments validation', () => {
  it('rejects conflicting multiple targets with rc=2', () => {
    const conflictingCases = [
      ['update', '--canary', '--beta'],
      ['update', '--canary', 'latest'],
      ['update', 'latest', '--canary'],
      ['upgrade', '--canary', '--beta'],
      ['upgrade', '--canary', 'latest'],
      ['upgrade', 'latest', '--canary'],
    ];

    for (const args of conflictingCases) {
      const res = runCli(args);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('不能同时指定多个升级目标');
      expect(res.stdout).not.toContain('本地 checkout 更新');
    }
  }, 15_000);

  it('rejects URL, protocol, and alias specs with rc=2', () => {
    const protocolCases = [
      ['update', 'npm:other-package@1.0.0'],
      ['update', 'https://example.invalid/botmux.tgz'],
      ['update', 'file:./local-botmux'],
      ['update', 'git+https://github.com/foo/bar.git'],
      ['upgrade', 'npm:other-package@1.0.0'],
      ['upgrade', 'https://example.invalid/botmux.tgz'],
    ];

    for (const args of protocolCases) {
      const res = runCli(args);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('非法的目标频道或版本格式');
      expect(res.stdout).not.toContain('本地 checkout 更新');
    }
  }, 30_000);

  it('rejects semver range, wildcard, and unknown tag specs with rc=2', () => {
    const rangeCases = [
      ['update', 'x'],
      ['update', 'X'],
      ['update', 'vx'],
      ['update', 'v3'],
      ['update', '3.x'],
      ['upgrade', 'x'],
      ['upgrade', 'v3'],
    ];

    for (const args of rangeCases) {
      const res = runCli(args);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('非法的目标频道或版本格式');
      expect(res.stdout).not.toContain('本地 checkout 更新');
    }
  }, 30_000);

  it('rejects non-latest channel/version updates on local git checkout', () => {
    const nonLatestCases = [
      ['update', 'canary'],
      ['update', '@canary'],
      ['update', '--canary'],
      ['update', '3.28.0'],
      ['upgrade', 'canary'],
      ['upgrade', '3.28.0'],
    ];

    for (const args of nonLatestCases) {
      const res = runCli(args);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('当前为本地 git checkout 开发环境，不支持切换到 npm 频道/版本');
      expect(res.stdout).not.toContain('本地 checkout 更新');
    }
  }, 15_000);
});
