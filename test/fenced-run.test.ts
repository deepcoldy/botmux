/**
 * scripts/fenced-run.ts: the wrapper for ad-hoc probes and hand-written test
 * configs, which the repo's vitest / bun test fences never reach. Runs the real
 * script as a child process and checks what the probe it launches observes.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'scripts', 'fenced-run.ts');
let bun: string | undefined;
try { bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }
let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }

const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(bun!, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000, env });

describe.skipIf(!bun)('fenced-run', () => {
  it('rejects a missing command with a usage error', () => {
    const r = run([]);
    expect(r.status).toBe(2);
  });

  it('gives the probe a temp HOME (even under Bun) and no user bus by default', () => {
    const home = process.env.HOME ?? '';
    const probe = 'const os=require("os");console.log(JSON.stringify({home:os.homedir(),bus:process.env.XDG_RUNTIME_DIR??null,dbus:process.env.DBUS_SESSION_BUS_ADDRESS??null}))';
    const r = run(['--', bun!, '-e', probe], { ...process.env, XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' });
    expect(r.status).toBe(0);
    const seen = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(seen.home).not.toBe(home);
    expect(seen.home).toMatch(/bmx-fenced-home-/);
    expect(seen.bus).toBeNull();
    expect(seen.dbus).toBeNull();
  });

  it('keeps the user bus only when asked', () => {
    const r = run(['--keep-user-bus', '--', bun!, '-e', 'console.log(process.env.XDG_RUNTIME_DIR ?? "none")'],
      { ...process.env, XDG_RUNTIME_DIR: '/run/user/0' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('/run/user/0');
  });

  it.skipIf(!realTmux)('fails the run when the probe addresses a host tmux socket', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    // A path in the host socket directory: the shim refuses it before tmux runs.
    const r = run(['--', 'tmux', '-S', `/tmp/tmux-${uid}/botmux`, 'list-sessions']);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/refus/i);
  });
});
