import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { upsertBotInfoEntries } from '../src/services/bots-info-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-bots-info-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readEntries(): Array<{ larkAppId: string; botName: string | null }> {
  return JSON.parse(readFileSync(join(dir, 'bots-info.json'), 'utf8'));
}

function entry(larkAppId: string, botName: string | null = null) {
  return { larkAppId, botOpenId: null, botName, botAvatarUrl: null, cliId: 'claude-code' };
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise(resolveExit => child.on('exit', code => resolveExit(code)));
}

describe('upsertBotInfoEntries', () => {
  it('merges into entries written by other daemons and replaces its own', () => {
    upsertBotInfoEntries(dir, [entry('cli_a', 'A')]);
    upsertBotInfoEntries(dir, [entry('cli_b', 'B')]);
    upsertBotInfoEntries(dir, [entry('cli_a', 'A2')]);
    expect(readEntries().map(e => [e.larkAppId, e.botName])).toEqual([['cli_a', 'A2'], ['cli_b', 'B']]);
  });

  it('does not lose entries when many daemons upsert at the same time', async () => {
    // A fleet restart starts one daemon per bot at once. Each child here plays
    // one daemon and rewrites its own entry repeatedly; an unlocked
    // read-merge-write drops other daemons' entries.
    const storeUrl = pathToFileURL(resolve('src/services/bots-info-store.ts')).href;
    const daemons = 8;
    const children = Array.from({ length: daemons }, (_, i) => spawnTsEvalWithRepoImports(`
      import { upsertBotInfoEntries } from ${JSON.stringify(storeUrl)};
      for (let round = 0; round < 25; round++) {
        upsertBotInfoEntries(${JSON.stringify(dir)}, [{
          larkAppId: 'cli_${i}', botOpenId: null, botName: 'bot-${i}', botAvatarUrl: null, cliId: 'claude-code',
        }]);
      }
    `, { stdio: 'ignore' }));
    const codes = await Promise.all(children.map(waitForExit));
    expect(codes).toEqual(Array(daemons).fill(0));
    expect(readEntries().map(e => e.larkAppId).sort()).toEqual(
      Array.from({ length: daemons }, (_, i) => `cli_${i}`).sort(),
    );
  }, 60_000);
});
