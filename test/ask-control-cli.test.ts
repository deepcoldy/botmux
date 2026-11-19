import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

describe('botmux ask control CLI', () => {
  it.each([
    ['a missing control file', null],
    ['malformed JSON', '{"larkAppId":'],
    ['a JSON value that is not an object', '[]'],
  ])('rejects %s as a usage error with one clean line', (_case, content) => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-control-cli-'));
    try {
      const file = join(dir, 'control.json');
      if (content !== null) writeFileSync(file, content);
      const result = spawnSyncTsScript(resolve('src/cli.ts'), ['ask', 'control', 'inspect', '--control-file', file], {
        cwd: resolve('.'), env: { ...process.env, HOME: dir }, encoding: 'utf8',
      }) as SpawnSyncReturns<string>;
      expect(result.status).toBe(2);
      expect(result.stderr.trim().split('\n')).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
