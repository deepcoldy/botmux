import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { captureReadonlyPm2Jlist } from '../src/cli/pm2-readonly.js';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PM2_PATH = join(PKG_ROOT, 'node_modules', 'pm2', 'bin', 'pm2');
const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'botmux-pm2-readonly-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    const pm2Home = join(home, '.botmux', 'pm2');
    spawnSync(process.execPath, [PM2_PATH, 'kill'], {
      env: { ...process.env, PM2_HOME: pm2Home },
      stdio: 'ignore',
      timeout: 10_000,
    });
    rmSync(home, { recursive: true, force: true });
  }
});

describe('PM2 read-only jlist stdout integrity', () => {
  it('returns a large jlist without truncation', () => {
    const home = tempHome();
    const pm2Home = join(home, '.botmux', 'pm2');
    mkdirSync(pm2Home, { recursive: true });
    expect(spawnSync(process.execPath, [PM2_PATH, 'status'], {
      env: { ...process.env, PM2_HOME: pm2Home },
      stdio: 'ignore',
      timeout: 10_000,
    }).status).toBe(0);

    const idleScript = join(home, 'idle.js');
    writeFileSync(idleScript, 'setInterval(() => {}, 1000);\n');
    for (let i = 0; i < 6; i++) {
      const started = spawnSync(process.execPath, [PM2_PATH, 'start', idleScript, '--name', `flush-probe-${i}`], {
        env: { ...process.env, PM2_HOME: pm2Home, BOTMUX_FLUSH_PROBE: 'x'.repeat(30_000) },
        stdio: 'ignore',
        timeout: 20_000,
      });
      expect(started.status).toBe(0);
    }

    const stdout = captureReadonlyPm2Jlist({ pkgRoot: PKG_ROOT, home: pm2Home });
    // Keep the fixture well past the partial-flush range observed with a pipe.
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(200_000);
    expect(JSON.parse(stdout)).toHaveLength(6);
  }, 90_000);
});
