import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeTsRunnerPrefix, resolveNodeExecutable } from './helpers/ts-runner.js';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PM2_PATH = join(PKG_ROOT, 'node_modules', 'pm2', 'bin', 'pm2');
const READONLY_CLIENT = join(PKG_ROOT, 'src', 'cli', 'pm2-readonly-client.ts');
const homes: string[] = [];

// PM2 is a Node program: under `bun test` process.execPath is bun, so resolve a
// real Node binary instead (see test/helpers/ts-runner.ts).
const NODE_BIN = resolveNodeExecutable();
function runPm2(args: readonly string[], options: Parameters<typeof spawnSync>[2]) {
  if (!NODE_BIN) throw new Error('node not found on PATH; PM2 needs a real Node executable');
  return spawnSync(NODE_BIN, [PM2_PATH, ...args], options);
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'botmux-pm2-readonly-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    const pm2Home = join(home, '.botmux', 'pm2');
    runPm2(['kill'], {
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
    expect(runPm2(['status'], {
      env: { ...process.env, PM2_HOME: pm2Home },
      stdio: 'ignore',
      timeout: 10_000,
    }).status).toBe(0);

    const idleScript = join(home, 'idle.js');
    writeFileSync(idleScript, 'setInterval(() => {}, 1000);\n');
    for (let i = 0; i < 6; i++) {
      const started = runPm2(['start', idleScript, '--name', `flush-probe-${i}`], {
        env: { ...process.env, PM2_HOME: pm2Home, BOTMUX_FLUSH_PROBE: 'x'.repeat(30_000) },
        stdio: 'ignore',
        timeout: 20_000,
      });
      expect(started.status).toBe(0);
    }

    // Same shape as the desktop observer (src/desktop/main/pm2-apps.ts): the
    // helper's stdout is a pipe the parent drains, and the helper exits
    // explicitly once the JSON is written.
    const { command, prefixArgs } = nodeTsRunnerPrefix();
    const jlist = spawnSync(command, [...prefixArgs, READONLY_CLIENT, 'jlist'], {
      cwd: PKG_ROOT,
      env: { ...process.env, PM2_HOME: pm2Home },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20_000,
    });
    expect(jlist.status, jlist.stderr).toBe(0);
    const stdout = jlist.stdout;
    // Keep the fixture well past the partial-flush range observed with a pipe.
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(200_000);
    expect(JSON.parse(stdout)).toHaveLength(6);
  }, 90_000);
});
