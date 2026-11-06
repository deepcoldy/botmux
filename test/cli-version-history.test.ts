/**
 * The daemon's version cache is in-memory, so an upgrade that lands while it is
 * down (2026-10-23: Grok Build 1.0.62 → 1.0.67 across a restart) used to be
 * logged as a plain "CLI version: 1.0.67". The persisted history keeps the
 * transition so a startup stall can say "just upgraded to 1.0.67".
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RECENT_CLI_UPGRADE_WINDOW_MS, noteObservedCliVersion, normalizeCliVersion, recentCliUpgrade,
} from '../src/core/cli-version-history.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const GROK = JSON.stringify(['grok', 'builtin', '', '']);
const CODEX = JSON.stringify(['codex', 'builtin', 'codex', 'codex']);
let dataDir: string;

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'bmx-cli-versions-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe('CLI version history', () => {
  it('treats build hashes and channel tags as the same version', () => {
    expect(normalizeCliVersion('1.0.67 (2fe064390d07) [stable]')).toBe('1.0.67');
    expect(normalizeCliVersion('codex-cli 0.162.1')).toBe('0.162.1');
    expect(normalizeCliVersion('2.1.310 (Claude Code)')).toBe('2.1.310');
    expect(normalizeCliVersion('nightly')).toBe('nightly');
  });

  it('remembers an upgrade observed across a daemon restart', () => {
    const t0 = Date.parse('2026-10-22T00:00:24Z');
    noteObservedCliVersion(GROK, '1.0.62 (1474f9cbdd91)', { dataDir, nowMs: t0 });
    // First sighting is not an upgrade.
    expect(recentCliUpgrade(GROK, { dataDir, nowMs: t0 })).toBeUndefined();

    // A different daemon process (fresh memory) sees the new binary next day.
    const t1 = Date.parse('2026-10-23T01:31:31Z');
    noteObservedCliVersion(GROK, '1.0.67 (2fe064390d07)', { dataDir, nowMs: t1 });
    const stall = Date.parse('2026-10-24T00:00:30Z');
    expect(recentCliUpgrade(GROK, { dataDir, nowMs: stall })).toEqual({ from: '1.0.62', to: '1.0.67' });

    // The "[stable]" tag that appeared later is not another upgrade.
    noteObservedCliVersion(GROK, '1.0.67 (2fe064390d07) [stable]', { dataDir, nowMs: stall });
    expect(recentCliUpgrade(GROK, { dataDir, nowMs: stall })).toEqual({ from: '1.0.62', to: '1.0.67' });

    expect(recentCliUpgrade(GROK, { dataDir, nowMs: t1 + RECENT_CLI_UPGRADE_WINDOW_MS + 1 })).toBeUndefined();
  });

  it('keeps runtimes apart and survives a corrupt record', () => {
    noteObservedCliVersion(GROK, '1.0.62', { dataDir, nowMs: 1 });
    noteObservedCliVersion(CODEX, '0.161.0', { dataDir, nowMs: 1 });
    noteObservedCliVersion(CODEX, '0.162.1', { dataDir, nowMs: 2 });
    expect(recentCliUpgrade(GROK, { dataDir, nowMs: 3 })).toBeUndefined();
    expect(recentCliUpgrade(CODEX, { dataDir, nowMs: 3 })).toEqual({ from: '0.161.0', to: '0.162.1' });

    const dir = join(dataDir, 'cli-version-history');
    for (const name of readdirSync(dir)) writeFileSync(join(dir, name), '{not json');
    expect(recentCliUpgrade(CODEX, { dataDir, nowMs: 3 })).toBeUndefined();
    expect(noteObservedCliVersion(GROK, '1.0.70', { dataDir, nowMs: 4 })).toEqual({ version: '1.0.70' });
    expect(recentCliUpgrade(GROK, { dataDir, nowMs: 5 })).toBeUndefined();
  });

  it('loses no runtime when several daemons record different runtimes at once', async () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => JSON.stringify([name, 'builtin', '', '']));
    const barrier = mkdtempSync(join(tmpdir(), 'bmx-cli-versions-barrier-'));
    try {
      const lasts = await Promise.all(keys.map((key, index) => new Promise<number>((resolve, reject) => {
        // Every writer starts only once all are up (so the writes really
        // overlap), and writes at least MIN times however slow the host is.
        const child = spawnTsEvalWithRepoImports(
          `import { existsSync, writeFileSync } from 'node:fs';
           import { noteObservedCliVersion } from './src/core/cli-version-history.js';
           const barrier = ${JSON.stringify(barrier)};
           writeFileSync(barrier + '/ready-${index}', '');
           while (![${keys.map((_k, i) => i).join(',')}].every(i => existsSync(barrier + '/ready-' + i))) {
             await new Promise(r => setTimeout(r, 5));
           }
           const MIN = 200;
           const until = Date.now() + 1_500;
           let i = 0;
           while (i < MIN || Date.now() < until) {
             i++;
             noteObservedCliVersion(${JSON.stringify(key)}, '1.0.' + i, { dataDir: ${JSON.stringify(dataDir)} });
           }
           process.stdout.write(String(i));`,
          { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let out = '';
        let err = '';
        child.stdout!.on('data', chunk => { out += chunk; });
        child.stderr!.on('data', chunk => { err += chunk; });
        child.on('exit', code => (code === 0 ? resolve(Number(out)) : reject(new Error(err))));
      })));
      expect(Math.min(...lasts)).toBeGreaterThanOrEqual(200);
      // One record per runtime, each still saying whose it is…
      const dir = join(dataDir, 'cli-version-history');
      const owners = readdirSync(dir).map(name => JSON.parse(readFileSync(join(dir, name), 'utf-8')).runtimeKey);
      expect(owners.sort()).toEqual([...keys].sort());
      // …and each daemon's own last write survived every other daemon's writes.
      keys.forEach((key, index) => {
        expect(recentCliUpgrade(key, { dataDir, windowMs: Number.MAX_SAFE_INTEGER }))
          .toEqual({ from: `1.0.${lasts[index]! - 1}`, to: `1.0.${lasts[index]}` });
      });
    } finally {
      rmSync(barrier, { recursive: true, force: true });
    }
  }, 60_000);
});
