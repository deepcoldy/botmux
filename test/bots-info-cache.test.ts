import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetBotsInfoCacheForTest, readBotsInfoJson } from '../src/services/bots-info-cache.js';

let dir: string;

function publish(value: unknown, raw?: string): void {
  // Mirror sibling daemons: write a temp file, then atomically rename it in.
  const tmp = join(dir, `bots-info.json.${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(tmp, raw ?? JSON.stringify(value));
  renameSync(tmp, join(dir, 'bots-info.json'));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-bots-info-'));
  __resetBotsInfoCacheForTest();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readBotsInfoJson', () => {
  it('returns undefined when the file does not exist', () => {
    expect(readBotsInfoJson(dir)).toBeUndefined();
  });

  it('parses once and serves the same snapshot while the file is unchanged', () => {
    publish([{ larkAppId: 'cli_a', botName: 'A' }]);
    const first = readBotsInfoJson(dir);
    expect(first).toEqual([{ larkAppId: 'cli_a', botName: 'A' }]);
    expect(readBotsInfoJson(dir)).toBe(first);
  });

  it('sees a sibling daemon atomically replacing the file', () => {
    publish([{ larkAppId: 'cli_a', botName: 'A' }]);
    expect(readBotsInfoJson(dir)).toEqual([{ larkAppId: 'cli_a', botName: 'A' }]);
    publish([{ larkAppId: 'cli_a', botName: 'A' }, { larkAppId: 'cli_b', botName: 'B' }]);
    expect(readBotsInfoJson(dir)).toEqual([
      { larkAppId: 'cli_a', botName: 'A' },
      { larkAppId: 'cli_b', botName: 'B' },
    ]);
  });

  it('sees the file disappearing', () => {
    publish([]);
    expect(readBotsInfoJson(dir)).toEqual([]);
    rmSync(join(dir, 'bots-info.json'));
    expect(readBotsInfoJson(dir)).toBeUndefined();
  });

  it('throws on a corrupt file every time, and recovers once it is repaired', () => {
    publish(undefined, '{not json');
    expect(() => readBotsInfoJson(dir)).toThrow(SyntaxError);
    expect(() => readBotsInfoJson(dir)).toThrow(SyntaxError);
    publish([{ larkAppId: 'cli_a' }]);
    expect(readBotsInfoJson(dir)).toEqual([{ larkAppId: 'cli_a' }]);
  });
});
