import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeTsRunnerPrefix } from './helpers/ts-runner.js';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const READONLY_CLIENT = join(PKG_ROOT, 'src', 'cli', 'pm2-readonly-client.ts');
const PM2_FIXTURE = join(PKG_ROOT, 'test', 'fixtures', 'pm2-readonly-preload.cjs');
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('PM2 read-only jlist stdout integrity', () => {
  it('returns a large jlist without truncation or an installed PM2 daemon', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-pm2-readonly-'));
    homes.push(home);
    const pm2Home = join(home, '.botmux', 'pm2');

    // Exercise the real observer in a Node child on both test runtimes. Its
    // optional PM2 API is supplied by a process-local fixture, so a developer's
    // leftover node_modules/pm2 cannot hide a failure on clean CI installs.
    const { command, prefixArgs } = nodeTsRunnerPrefix();
    const jlist = spawnSync(command, [...prefixArgs, '--require', PM2_FIXTURE, READONLY_CLIENT, 'jlist'], {
      cwd: PKG_ROOT,
      env: { ...process.env, PM2_HOME: pm2Home },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20_000,
    });
    expect(jlist.status, jlist.stderr).toBe(0);
    expect(Buffer.byteLength(jlist.stdout)).toBeGreaterThan(1_500_000);
    expect(JSON.parse(jlist.stdout)).toEqual(Array.from({ length: 6 }, (_, index) => ({
      name: `flush-probe-${index}`,
      pm_id: index,
      pm2_env: { BOTMUX_FLUSH_PROBE: 'x'.repeat(256 * 1024) },
    })));
    expect(existsSync(pm2Home)).toBe(false);
  }, 30_000);
});
