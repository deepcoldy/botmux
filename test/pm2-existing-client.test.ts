import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runExistingPm2Command } from '../src/cli/pm2-existing.js';
import { captureReadonlyPm2Jlist } from '../src/cli/pm2-readonly.js';
import { inspectLinuxPm2GodOwnership } from '../src/core/pm2-lifecycle-owner.js';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PM2_PATH = join(PKG_ROOT, 'node_modules', 'pm2', 'bin', 'pm2');

describe.runIf(process.platform === 'linux')('existing PM2 RPC mutation boundary', () => {
  let root = '';
  let pm2Home = '';
  let config = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-pm2-existing-'));
    pm2Home = join(root, 'pm2');
    mkdirSync(pm2Home, { recursive: true });
    const script = join(root, 'fixture.cjs');
    config = join(root, 'ecosystem.config.cjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    writeFileSync(config, `module.exports = { apps: [{ name: 'botmux-existing-fixture', script: ${JSON.stringify(script)} }] };\n`);
    const boot = spawnSync(process.execPath, [PM2_PATH, 'status'], {
      env: { ...process.env, PM2_HOME: pm2Home },
      stdio: 'ignore',
      timeout: 10_000,
    });
    expect(boot.status).toBe(0);
  });

  afterAll(() => {
    spawnSync(process.execPath, [PM2_PATH, 'kill'], {
      env: { ...process.env, PM2_HOME: pm2Home },
      stdio: 'ignore',
      timeout: 10_000,
    });
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('flushes a large read-only jlist projection before exiting', () => {
    const largeAppName = 'botmux-readonly-large-fixture';
    const largeConfig = join(root, 'ecosystem-large.config.cjs');
    const largeEnv = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
      `BOTMUX_PM2_READONLY_LARGE_${index}`,
      'x'.repeat(32 * 1024),
    ]));
    writeFileSync(largeConfig, `module.exports = ${JSON.stringify({
      apps: [{ name: largeAppName, script: join(root, 'fixture.cjs'), env: largeEnv }],
    })};\n`);
    const ownership = inspectLinuxPm2GodOwnership(pm2Home);
    expect(ownership.kind).not.toBe('absent');
    const god = ownership.kind === 'absent' ? undefined : ownership.processes[0];

    runExistingPm2Command({
      pkgRoot: PKG_ROOT,
      home: pm2Home,
      args: ['start', largeConfig],
      inherit: false,
      expectedGod: god!,
    });
    try {
      const output = captureReadonlyPm2Jlist({ pkgRoot: PKG_ROOT, home: pm2Home });
      expect(output.at(-1)).toBe(']');
      const apps = JSON.parse(output) as Array<{ name?: string }>;
      expect(apps.some(app => app.name === largeAppName)).toBe(true);
    } finally {
      runExistingPm2Command({
        pkgRoot: PKG_ROOT,
        home: pm2Home,
        args: ['delete', largeAppName],
        inherit: false,
        expectedGod: god!,
      });
    }
  });

  it('mutates an existing God without rotation, then fails absent without replacement', () => {
    const pidFile = join(pm2Home, 'pm2.pid');
    const originalPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    const originalOwnership = inspectLinuxPm2GodOwnership(pm2Home);
    expect(originalOwnership.kind).not.toBe('absent');
    const originalGod = originalOwnership.kind === 'absent'
      ? undefined
      : originalOwnership.processes[0];
    expect(originalGod?.pid).toBe(originalPid);
    runExistingPm2Command({
      pkgRoot: PKG_ROOT,
      home: pm2Home,
      args: ['start', config],
      inherit: false,
      expectedGod: originalGod!,
    });
    const apps = JSON.parse(captureReadonlyPm2Jlist({ pkgRoot: PKG_ROOT, home: pm2Home }));
    expect(apps.some((app: any) => app.name === 'botmux-existing-fixture')).toBe(true);
    expect(Number.parseInt(readFileSync(pidFile, 'utf8'), 10)).toBe(originalPid);

    runExistingPm2Command({
      pkgRoot: PKG_ROOT,
      home: pm2Home,
      args: ['delete', 'botmux-existing-fixture'],
      inherit: false,
      expectedGod: originalGod!,
    });
    const killed = spawnSync(process.execPath, [PM2_PATH, 'kill'], {
      env: { ...process.env, PM2_HOME: pm2Home },
      stdio: 'ignore',
      timeout: 10_000,
    });
    expect(killed.status).toBe(0);

    expect(() => runExistingPm2Command({
      pkgRoot: PKG_ROOT,
      home: pm2Home,
      args: ['start', config],
      inherit: false,
      expectedGod: originalGod!,
    })).toThrow(/no replacement daemon was created/);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('rejects a replacement generation before applying the mutation', () => {
    const boot = spawnSync(process.execPath, [PM2_PATH, 'status'], {
      env: { ...process.env, PM2_HOME: pm2Home },
      stdio: 'ignore',
      timeout: 10_000,
    });
    expect(boot.status).toBe(0);
    const ownership = inspectLinuxPm2GodOwnership(pm2Home);
    expect(ownership.kind).not.toBe('absent');
    const god = ownership.kind === 'absent' ? undefined : ownership.processes[0];
    expect(god).toBeDefined();
    expect(() => runExistingPm2Command({
      pkgRoot: PKG_ROOT,
      home: pm2Home,
      args: ['start', config],
      inherit: false,
      expectedGod: { ...god!, startIdentity: `${god!.startIdentity}-replaced` },
    })).toThrow(/generation changed before mutation/);
    const apps = JSON.parse(captureReadonlyPm2Jlist({ pkgRoot: PKG_ROOT, home: pm2Home }));
    expect(apps.some((app: any) => app.name === 'botmux-existing-fixture')).toBe(false);
  });
});
