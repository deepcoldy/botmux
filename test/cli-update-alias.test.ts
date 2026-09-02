import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { spawnSyncTsScript } from './helpers/ts-runner.js';

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
  const result = spawnSyncTsScript(CLI_PATH, [command], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SESSION_DATA_DIR: join(home, 'data'),
      // ⚠️ Must be a NON-EMPTY path to a directory that does not exist — NOT `PATH: ''`.
      //
      // The containment this test depends on is "the child cannot exec anything",
      // which makes `cmdUpgrade` abort at its very first `git` call. `PATH: ''`
      // delivers that under Node only: Bun substitutes a built-in default PATH for
      // the EMPTY string specifically, so under `bun test` the child resolved
      // /usr/bin and really ran git (measured: `PATH=''` → `git version 2.39.5`,
      // execFileSync SUCCEEDED). A non-empty bogus PATH is not substituted and
      // fails closed on both runtimes (bun: `Executable not found in $PATH: "git"`,
      // node: `spawnSync git ENOENT`).
      //
      // This is not cosmetic. With git actually reachable, `upgrade` got past the
      // ENOENT guard into the real update sequence, which made this test both
      // state-dependent and destructive:
      //   • the aborting error became the DIRTY-tree message, whose embedded
      //     `git status --porcelain` file list is inside the stderr that
      //     `expect(update).toEqual(upgrade)` compares — so a clean checkout that
      //     is merely BEHIND its remote made call #1 print "Fast-forward" and
      //     call #2 "Already up to date", failing toEqual; and any neighbour test
      //     touching the tree between the two calls reddened it too (the bun leg
      //     runs several files concurrently in this same repo root).
      //   • on a clean checkout it executed a real `git pull --ff-only`, i.e. it
      //     could fast-forward the very checkout under test (reproduced in a
      //     throwaway lab clone: HEAD moved).
      PATH: '/nonexistent-botmux-guard',
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

    // Running from this checkout (has .git/src) → the local-dev update branch.
    // The unresolvable PATH above (see runCli) makes it abort deterministically
    // at the first `git` exec, right after the banner, so the test never runs a
    // real pull/build/restart. The exact error text differs per runtime
    // (bun: "Executable not found in $PATH", node: "spawnSync git ENOENT") and
    // lives only in stderr, which no assertion below inspects directly — the
    // toEqual only requires the two calls to agree with each other.
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
