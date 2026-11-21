import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

describe('send preflight runs before queued-turn marker mutation', () => {
  it.each([
    ['lone dash with blank stdin', ['send', '--no-mention', '--response-kind', 'final', '-']],
    ['implicit stdin with blank input', ['send', '--no-mention', '--response-kind', 'final']],
  ])('%s leaves the ancestor marker byte-identical', (_name, args) => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-send-marker-'));
    try {
      const dataDir = join(dir, 'data');
      const markerDir = join(dataDir, '.botmux-cli-pids');
      mkdirSync(markerDir, { recursive: true });
      const markerPath = join(markerDir, String(process.pid));
      const marker = JSON.stringify({ sessionId: 's', turnId: 'turn1', queuedTurnId: 'turn2' });
      writeFileSync(markerPath, marker);
      const result = spawnSyncTsScript(cli, args, {
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: join(dir, 'bots.json'),
          BOTMUX_SESSION_ID: 's',
          BOTMUX_LARK_APP_ID: 'cli_test',
        },
        input: '   ',
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/stdin 没有内容|正文为空/);
      expect(readFileSync(markerPath, 'utf8')).toBe(marker);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
