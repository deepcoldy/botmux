import { describe, expect, it, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTOSTART_UNIT_ENV,
  consumeAutostartUnitMarker,
  launchProgram, launchCommand, unitContent, plistContent, windowsScriptContent,
  type AutostartOpts,
} from '../src/autostart.js';
import { createDashboardAutostartController } from '../src/dashboard/autostart-api.js';

/**
 * Regression tests for the autostart boot hook under the COMPILED BINARY.
 *
 * THE BUG (observed in production, on a devbox running the npm-installed
 * compiled binary): every boot hook was rendered as
 * `<exe> <pkgRoot>/dist/cli.js start`, with pkgRoot derived from `__dirname`.
 * Inside a compiled binary the module graph lives in the virtual, read-only
 * `/$bunfs/`, so the written systemd unit was literally
 *
 *     ExecStart=/…/botmux-linux-x64/botmux /$bunfs/dist/cli.js start
 *
 * and `/$bunfs` does not exist outside the process (`ls /$bunfs` → ENOENT).
 *
 * IT FAILED SILENTLY, which is why it went unnoticed: the binary treats the
 * bogus path as its subcommand token, does not recognise it, prints help and
 * EXITS 0. systemd records success while `start` is swallowed as an argument and
 * no daemon ever starts — the fleet does not come back after a reboot, with no
 * error anywhere. `botmux restart` re-synced the unit each run, so the broken
 * path stayed fresh.
 *
 * This is the same `__dirname` hazard as the wrapper self-destruct covered by
 * `wrapper-standalone-guard.test.ts`; these tests cover the boot-hook renderers,
 * which had NO coverage of either runtime shape.
 */

const tempDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** pkgRoot as it really looks inside a compiled binary (the value that produced
 *  the broken unit in production). */
const BUNFS_PKG_ROOT = '/$bunfs';
const BINARY = '/home/u/.local/lib/node_modules/botmux/node_modules/botmux-linux-x64/botmux';
const NODE = '/usr/bin/node';
const NODE_PKG_ROOT = '/opt/botmux';

function opts(over: Partial<AutostartOpts> = {}): AutostartOpts {
  return {
    pkgRoot: BUNFS_PKG_ROOT,
    configDir: '/home/u/.botmux',
    logDir: '/home/u/.botmux/logs',
    standalone: true,
    execPath: BINARY,
    ...over,
  };
}

/** The Node-install shape, for the backward-compatibility assertions. */
function nodeOpts(over: Partial<AutostartOpts> = {}): AutostartOpts {
  return opts({ pkgRoot: NODE_PKG_ROOT, standalone: false, execPath: NODE, ...over });
}

describe('autostart boot hook — compiled binary (standalone) shape', () => {
  it('execs the binary itself: no /$bunfs path, no dist/cli.js', () => {
    expect(launchProgram(opts())).toEqual([BINARY]);
    const cmd = launchCommand(opts(), 'start');
    expect(cmd).not.toContain('$bunfs');
    expect(cmd).not.toContain('cli.js');
    expect(cmd).toBe(`${BINARY} start`);
  });

  it('renders no /$bunfs into the systemd unit (ExecStart AND ExecStop)', () => {
    const unit = unitContent(opts());
    expect(unit).not.toContain('$bunfs');
    expect(unit).not.toContain('cli.js');
    expect(unit).toContain(`ExecStart=${BINARY} start`);
    // ExecStop was broken the same way and is just as load-bearing: a bad path
    // there makes `systemctl --user stop botmux` a no-op that reports success.
    expect(unit).toContain(`ExecStop=${BINARY} stop`);
  });

  it('renders no /$bunfs into the launchd plist or the Windows startup script', () => {
    const plist = plistContent(opts());
    expect(plist).not.toContain('$bunfs');
    expect(plist).not.toContain('cli.js');
    // ProgramArguments is an array: exactly the binary, then the subcommand.
    expect(plist).toContain(`        <string>${BINARY}</string>\n        <string>start</string>`);

    const bat = windowsScriptContent(opts());
    expect(bat).not.toContain('$bunfs');
    expect(bat).not.toContain('cli.js');
    expect(bat).toContain(`"${BINARY}" "start"`);
  });

  it('injects the boot marker into all three artifacts', () => {
    // `botmux start` needs to know it was launched at boot so it can skip the
    // purely presentational dashboard wait — that wait is up to 90s, exactly the
    // stock `DefaultTimeoutStartUSec` (VERIFIED: `systemctl --user show -p
    // DefaultTimeoutStartUSec` → 1min 30s), and our unit sets no TimeoutStartSec,
    // so blocking inside it would make systemd fail the start and (default
    // KillMode=control-group) take the supervisor down with it.
    expect(unitContent(opts())).toContain(`Environment=${AUTOSTART_UNIT_ENV}=1`);
    expect(plistContent(opts()))
      .toContain(`<key>${AUTOSTART_UNIT_ENV}</key>\n        <string>1</string>`);
    expect(windowsScriptContent(opts())).toContain(`set "${AUTOSTART_UNIT_ENV}=1"`);
    // Same on the Node shape: the hazard is about boot, not about runtime form.
    expect(unitContent(nodeOpts())).toContain(`Environment=${AUTOSTART_UNIT_ENV}=1`);
  });

  it('the rendered ExecStart actually starts botmux (not: prints help and exits 0)', () => {
    // THE HEART OF THE BUG. A string assertion alone would have passed even in
    // production, because the broken command was still a well-formed command
    // line — it just did the wrong thing and reported success. So run it.
    //
    // The stand-in binary behaves like the real one where it matters: it accepts
    // `start` and rejects anything else with help-on-stdout + exit 0, which is
    // exactly what made the failure invisible to systemd.
    const dir = tmp();
    const fakeBinary = join(dir, 'botmux');
    writeFileSync(fakeBinary, [
      '#!/bin/sh',
      'if [ "$1" = "start" ]; then echo "DAEMON_STARTED"; exit 0; fi',
      'echo "botmux — usage: botmux <command>"',   // help text, like the real CLI
      'exit 0',                                    // ...and a SUCCESS exit code
    ].join('\n'), { mode: 0o755 });
    chmodSync(fakeBinary, 0o755);

    const execStart = unitContent(opts({ execPath: fakeBinary }))
      .split('\n').find((l) => l.startsWith('ExecStart='))!.slice('ExecStart='.length);
    const r = spawnSync('/bin/sh', ['-c', execStart], { encoding: 'utf-8' });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DAEMON_STARTED');
    // The pre-fix command line hit this branch — and still exited 0.
    expect(r.stdout).not.toContain('usage');
  });

  it('proves the stand-in reproduces the silent failure (control for the test above)', () => {
    // Without this, "DAEMON_STARTED" could pass for a reason unrelated to the
    // fix. Feed the fake binary the PRE-FIX argv and show it is the documented
    // silent failure: help text, no daemon, exit 0.
    const dir = tmp();
    const fakeBinary = join(dir, 'botmux');
    writeFileSync(fakeBinary, [
      '#!/bin/sh',
      'if [ "$1" = "start" ]; then echo "DAEMON_STARTED"; exit 0; fi',
      'echo "botmux — usage: botmux <command>"',
      'exit 0',
    ].join('\n'), { mode: 0o755 });
    chmodSync(fakeBinary, 0o755);

    // Quoted so this test observes the real argv shape rather than sh's own
    // expansion of `$bunfs` (unquoted, sh would expand it to the empty string —
    // a second, independent way the old unit was wrong).
    const r = spawnSync('/bin/sh', ['-c', `${fakeBinary} '/$bunfs/dist/cli.js' start`], { encoding: 'utf-8' });
    expect(r.status).toBe(0);              // systemd saw success...
    expect(r.stdout).toContain('usage');   // ...while botmux only printed help
    expect(r.stdout).not.toContain('DAEMON_STARTED');
  });
});

describe('Dashboard autostart toggle — the same __dirname bug, second call site', () => {
  // `defaultRunner()` hardcoded `[process.execPath, join(pkgRoot,'dist','cli.js'),
  // 'autostart', …]`. In the compiled binary `process.execPath` IS the botmux
  // binary and there is no cli.js on disk, so the bogus path became an unknown
  // subcommand: help printed, exit 0, state unchanged, and the controller reported
  // `command_failed` — the Dashboard's autostart toggle was simply dead in the
  // shipped build. Exercised through the CONTROLLER with its real default runner,
  // because the bug lived in the runner, not in the helper it now calls.
  // FIXTURE CONTRACT: the controller no-ops when already in the target state and
  // then re-reads to confirm the state flipped, so `inspect` must be driven by the
  // RUNNER'S REAL SIDE EFFECT — here, the argv log the fake binary writes. Each case
  // gets its own tmp dir and its own log, and each starts in the state OPPOSITE to
  // its target. If the runner is ever changed to not write that file, these tests
  // would stop exercising it, so keep the side effect and the `enabled` predicate in
  // step.
  function fakeBotmux(dir: string, argvLog: string): string {
    const bin = join(dir, 'botmux');
    writeFileSync(bin, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" >> ${JSON.stringify(argvLog)}`,
      // Behave like the real CLI: only `autostart` is a known subcommand here.
      'if [ "$1" != "autostart" ]; then echo "usage: botmux <command>"; exit 0; fi',
      'exit 0',
    ].join('\n'), { mode: 0o755 });
    chmodSync(bin, 0o755);
    return bin;
  }

  it('standalone: invokes `<binary> autostart enable`, with no /$bunfs and no cli.js', async () => {
    const dir = tmp();
    const argvLog = join(dir, 'argv.log');
    const bin = fakeBotmux(dir, argvLog);
    // Model the real flow: the controller no-ops if already in the target state,
    // and after running it re-reads and fails unless the state FLIPPED. So the
    // first read reports the old value; the fake binary flips it by writing argv.
    const controller = createDashboardAutostartController({
      // No `run` override: this must go through the real defaultRunner.
      opts: opts({ execPath: bin }),
      inspect: () => ({ supported: true, enabled: existsSync(argvLog) }),
    });

    await controller.setEnabled(true);

    const argv = readFileSync(argvLog, 'utf-8').trim().split('\n');
    expect(argv).toEqual(['autostart', 'enable']);   // no cli.js argument at all
    expect(argv.join(' ')).not.toContain('$bunfs');
  });

  it('standalone: disable maps to `<binary> autostart disable`', async () => {
    const dir = tmp();
    const argvLog = join(dir, 'argv.log');
    const bin = fakeBotmux(dir, argvLog);
    const controller = createDashboardAutostartController({
      opts: opts({ execPath: bin }),
      inspect: () => ({ supported: true, enabled: !existsSync(argvLog) }),
    });

    await controller.setEnabled(false);

    expect(readFileSync(argvLog, 'utf-8').trim().split('\n')).toEqual(['autostart', 'disable']);
  });

  it('Node: still invokes `node <pkgRoot>/dist/cli.js autostart enable`', async () => {
    // The path that already worked must keep working — the fix must not "succeed"
    // by breaking it.
    const dir = tmp();
    const argvLog = join(dir, 'argv.log');
    const bin = fakeBotmux(dir, argvLog);
    const controller = createDashboardAutostartController({
      opts: nodeOpts({ execPath: bin }),
      inspect: () => ({ supported: true, enabled: existsSync(argvLog) }),
    });

    await controller.setEnabled(true);

    expect(readFileSync(argvLog, 'utf-8').trim().split('\n'))
      .toEqual([`${NODE_PKG_ROOT}/dist/cli.js`, 'autostart', 'enable']);
  });
});

describe('autostart boot hook — Node install shape stays unchanged', () => {
  // The fix must not "work" by breaking the path that was already correct.
  it('still runs `node <pkgRoot>/dist/cli.js`', () => {
    expect(launchProgram(nodeOpts())).toEqual([NODE, `${NODE_PKG_ROOT}/dist/cli.js`]);
    expect(launchCommand(nodeOpts(), 'start')).toBe(`${NODE} ${NODE_PKG_ROOT}/dist/cli.js start`);
  });

  it('unit, plist and .bat all keep the two-element program', () => {
    expect(unitContent(nodeOpts()))
      .toContain(`ExecStart=${NODE} ${NODE_PKG_ROOT}/dist/cli.js start`);
    expect(unitContent(nodeOpts()))
      .toContain(`ExecStop=${NODE} ${NODE_PKG_ROOT}/dist/cli.js stop`);
    expect(plistContent(nodeOpts()))
      .toContain(`        <string>${NODE}</string>\n        <string>${NODE_PKG_ROOT}/dist/cli.js</string>`);
    expect(windowsScriptContent(nodeOpts()))
      .toContain(`"${NODE}" "${NODE_PKG_ROOT}/dist/cli.js" "start"`);
  });
});

describe('boot-hook marker is consumed on entry, not after dependency probes', () => {
  it("returns true and deletes the key when the value is '1'", () => {
    const env: NodeJS.ProcessEnv = { [AUTOSTART_UNIT_ENV]: '1', OTHER: 'keep' };
    expect(consumeAutostartUnitMarker(env)).toBe(true);
    expect(AUTOSTART_UNIT_ENV in env).toBe(false);
    expect(env.OTHER).toBe('keep');
  });

  it('returns false but STILL deletes the key for any other value', () => {
    // A stray unrecognised value must not keep leaking to children either.
    for (const v of ['0', 'true', '', 'yes', '11']) {
      const env: NodeJS.ProcessEnv = { [AUTOSTART_UNIT_ENV]: v };
      expect(consumeAutostartUnitMarker(env)).toBe(false);
      expect(AUTOSTART_UNIT_ENV in env).toBe(false);
    }
  });

  it('returns false and stays a no-op when the key is absent', () => {
    const env: NodeJS.ProcessEnv = { OTHER: 'keep' };
    expect(consumeAutostartUnitMarker(env)).toBe(false);
    expect(AUTOSTART_UNIT_ENV in env).toBe(false);
    expect(env.OTHER).toBe('keep');
  });

  it('cmdStart consumes the marker before its first await / dependency probe', () => {
    // Structural guard: dependency probes and installers run as CHILD processes,
    // so they would inherit a marker consumed after them. Assert on source order.
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
    const start = src.indexOf('async function cmdStart(): Promise<void> {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);

    // STRIP COMMENTS FIRST. Both needles occur in this function's own comments:
    // matching those would find `await` in the prose (false failure) and the
    // helper's name in "see consumeAutostartUnitMarker" (false PASS, which is the
    // dangerous direction — it would satisfy the guard without a real call).
    const body = src.slice(start, end)
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');

    const consumeAt = body.indexOf('consumeAutostartUnitMarker(');
    expect(consumeAt, 'cmdStart must call consumeAutostartUnitMarker').toBeGreaterThan(-1);

    const firstAwaitAt = body.indexOf('await ');
    expect(firstAwaitAt, 'cmdStart is expected to await something').toBeGreaterThan(-1);
    expect(consumeAt).toBeLessThan(firstAwaitAt);

    // And specifically before the dependency probe that spawns children.
    const depsAt = body.indexOf('ensureSystemDependencies(');
    expect(depsAt).toBeGreaterThan(-1);
    expect(consumeAt).toBeLessThan(depsAt);
  });
});
