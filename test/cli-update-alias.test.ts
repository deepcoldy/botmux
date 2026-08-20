import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const PROJECT_ROOT = join(__dirname, '..');

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'botmux-update-alias-'));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function runCli(command: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI_PATH, command], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SESSION_DATA_DIR: join(home, 'data'),
      PATH: '',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('botmux update alias', () => {
  it('behaves exactly like upgrade', () => {
    const upgrade = runCli('upgrade');
    const update = runCli('update');

    // Running from this checkout (has .git/src) → the local-dev update branch.
    // PATH='' makes it abort deterministically at `git status` (ENOENT) right
    // after the banner, so the test never runs a real pull/build/restart.
    expect(upgrade.status).toBe(1);
    expect(upgrade.stdout).toContain('本地 checkout 更新');
    // The core contract: `update` is a pure alias of `upgrade`.
    expect(update).toEqual(upgrade);
  });

  it('documents the alias in help', () => {
    const help = runCli('--help');

    expect(help.status).toBe(0);
    expect(help.stdout).toContain('upgrade     升级到最新版本（别名：update）');
  });
});
