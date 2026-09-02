import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runExistingPm2Command } from '../src/cli/pm2-existing.js';
import { captureReadonlyPm2Jlist } from '../src/cli/pm2-readonly.js';
import { inspectLinuxPm2GodOwnership } from '../src/core/pm2-lifecycle-owner.js';
import { isBunRuntime } from './helpers/ts-runner.js';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PM2_PATH = join(PKG_ROOT, 'node_modules', 'pm2', 'bin', 'pm2');

/**
 * A REAL Node executable for every PM2 child spawned by this file.
 *
 * WHY THIS IS NEEDED — `bun test` only; two INDEPENDENT blockers, both of which
 * this one seam removes. Neither is a weakened assertion: the daemon really is
 * unidentifiable, and the helper really cannot start, when the interpreter is bun.
 *
 * 1. PM2 advertises its God daemon ONLY via `process.title`
 *    (`node_modules/pm2/lib/Daemon.js`: `process.title = … 'PM2 v' + version +
 *    ': God Daemon (' + process.env.PM2_HOME + ')'` — the sole marker in the
 *    whole package), and this repo identifies it by reading
 *    `/proc/<pid>/cmdline`, requiring both `PM2 v` and `God Daemon (<home>)`
 *    (`scanLinuxPm2GodPids` in `src/core/pm2-lifecycle-owner.ts`).
 *    **Bun does not write a `process.title` assignment back into
 *    `/proc/self/cmdline`; Node does.** Measured on one PM2_HOME with each
 *    interpreter: node → `cmdline: PM2 v6.0.14: God Daemon (<home>)`; bun →
 *    `cmdline: …/bun.exe …/pm2/lib/Daemon.js` (marker absent, `comm` just
 *    `bun.exe`). Under `bun test` `process.execPath` is the bun binary and PM2's
 *    `lib/Client.js` spawns the God with `var interpreter = process.execPath`, so
 *    the God is a bun process carrying no marker → the scan matches no pid →
 *    `inspectLinuxPm2GodOwnership` returns `{ kind: 'absent' }`, which is exactly
 *    what the two `.not.toBe('absent')` assertions used to see.
 *
 * 2. Both production seams invoke their helper as `['--import','tsx', <…>.ts]`
 *    (`src/cli/pm2-existing.ts`, `src/cli/pm2-readonly.ts`) — a Node-only form.
 *    Measured: `bun --import tsx src/cli/pm2-existing-client.ts …` exits 1 with
 *    `Cannot find module './cjs/index.cjs'`, while the node form works. So even
 *    with the marker problem solved, the helper child cannot start under bun.
 *
 * The node path is threaded in through the seams that already exist for exactly
 * this purpose (`nodePath` on `runExistingPm2Command` / `captureReadonlyPm2Jlist`,
 * as `test/desktop/desktop-pm2-apps.test.ts` already does) — no production change.
 *
 * Under vitest the test body always runs on Node, so `process.execPath` is
 * returned and every spawn is byte-for-byte what this file did before; the PATH
 * scan is reached only under Bun. Same "resolve the shape from the runtime"
 * pattern as `test/helpers/ts-runner.ts`, whose `isBunRuntime` is reused here.
 */
function resolveNodeExecutable(): string | undefined {
  if (!isBunRuntime()) return process.execPath;
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH.
    }
  }
  return undefined;
}

const NODE = resolveNodeExecutable();

// No real Node on PATH ⇒ PM2's God cannot be made identifiable and the tsx
// helper cannot start, so there is nothing this file can honestly assert. Skip
// loudly instead of letting the assertions pass on a degraded daemon.
describe.runIf(process.platform === 'linux' && NODE !== undefined)('existing PM2 RPC mutation boundary', () => {
  const node = NODE!;

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
    const boot = spawnSync(node, [PM2_PATH, 'status'], {
      env: { ...process.env, PM2_HOME: pm2Home },
      stdio: 'ignore',
      timeout: 10_000,
    });
    expect(boot.status).toBe(0);
  });

  afterAll(() => {
    spawnSync(node, [PM2_PATH, 'kill'], {
      env: { ...process.env, PM2_HOME: pm2Home },
      stdio: 'ignore',
      timeout: 10_000,
    });
    if (root) rmSync(root, { recursive: true, force: true });
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
      nodePath: node,
      expectedGod: originalGod!,
    });
    const apps = JSON.parse(captureReadonlyPm2Jlist({ pkgRoot: PKG_ROOT, home: pm2Home, nodePath: node }));
    expect(apps.some((app: any) => app.name === 'botmux-existing-fixture')).toBe(true);
    expect(Number.parseInt(readFileSync(pidFile, 'utf8'), 10)).toBe(originalPid);

    runExistingPm2Command({
      pkgRoot: PKG_ROOT,
      home: pm2Home,
      args: ['delete', 'botmux-existing-fixture'],
      inherit: false,
      nodePath: node,
      expectedGod: originalGod!,
    });
    const killed = spawnSync(node, [PM2_PATH, 'kill'], {
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
      nodePath: node,
      expectedGod: originalGod!,
    })).toThrow(/no replacement daemon was created/);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('rejects a replacement generation before applying the mutation', () => {
    const boot = spawnSync(node, [PM2_PATH, 'status'], {
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
      nodePath: node,
      expectedGod: { ...god!, startIdentity: `${god!.startIdentity}-replaced` },
    })).toThrow(/generation changed before mutation/);
    const apps = JSON.parse(captureReadonlyPm2Jlist({ pkgRoot: PKG_ROOT, home: pm2Home, nodePath: node }));
    expect(apps.some((app: any) => app.name === 'botmux-existing-fixture')).toBe(false);
  });
});
