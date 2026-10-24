import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

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

// Every argument combination is decided in-process by `decideUpgradeArgs`
// (test/update-target.test.ts). These cases only prove the real CLI wires each
// exit path to its exit code and never reaches the update itself, so each one
// cold-starts src/cli.ts exactly once: a cold start costs seconds on a loaded
// runner, and six of them in a row used to blow the per-test budget.
describe('botmux update/upgrade target arguments validation', () => {
  it('rejects conflicting multiple targets with rc=2', () => {
    const res = runCli(['update', '--canary', 'latest']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('不能同时指定多个升级目标');
    expect(res.stdout).not.toContain('本地 checkout 更新');
  });

  it('rejects URL, protocol, and alias specs with rc=2', () => {
    const res = runCli(['upgrade', 'npm:other-package@1.0.0']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('非法的目标频道或版本格式');
    expect(res.stdout).not.toContain('本地 checkout 更新');
  });

  it('rejects non-latest channel/version updates on local git checkout', () => {
    const res = runCli(['update', 'canary']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('当前为本地 git checkout 开发环境，不支持切换到 npm 频道/版本');
    expect(res.stdout).not.toContain('本地 checkout 更新');
  });
});
