/**
 * Regression test: tmux subcommands must not inherit `$TMUX` / `$TMUX_PANE`
 * from the parent process.
 *
 * Failure mode this guards against:
 *   - User starts `botmux start` from inside a tmux session.
 *   - tmux exports TMUX=/tmp/tmux-1001/default,<pid>,<id> to the daemon env.
 *   - Daemon spawns worker → worker inherits TMUX.
 *   - User's terminal tmux later dies (logged out / server killed / /tmp wiped).
 *   - Every `tmux <cmd>` from worker walks TMUX first → "error connecting to
 *     /tmp/tmux-1001/default (No such file or directory)" gets emitted to
 *     stderr, which the daemon's worker.stderr handler logs every poll.
 *   - User's own `tmux -V` / `tmux new-session` works fine from a fresh shell
 *     (no stale TMUX), so the bug looks unreproducible from their side.
 *
 * The fix is `tmuxEnv(env?)` — strips TMUX / TMUX_PANE and is the env every
 * tmux invocation in the codebase MUST pass.
 */
import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { tmuxEnv, probeTmuxFunctional } from '../src/setup/ensure-tmux.js';

describe('tmuxEnv()', () => {
  it('strips TMUX and TMUX_PANE from the env', () => {
    const stripped = tmuxEnv({
      TMUX: '/tmp/tmux-99999/missing,12345,0',
      TMUX_PANE: '%99',
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
    });
    expect(stripped.TMUX).toBeUndefined();
    expect(stripped.TMUX_PANE).toBeUndefined();
    expect(stripped.PATH?.split(':')[0]).toBe('/usr/bin');
    expect(stripped.PATH).toContain('/opt/homebrew/bin');
    expect(stripped.LANG).toBe('en_US.UTF-8');
  });

  it('leaves TMUX_TMPDIR alone (user override, not tmux-injected)', () => {
    const stripped = tmuxEnv({
      TMUX: '/tmp/tmux-99999/missing,12345,0',
      TMUX_TMPDIR: '/custom/tmp',
    });
    expect(stripped.TMUX).toBeUndefined();
    expect(stripped.TMUX_TMPDIR).toBe('/custom/tmp');
  });

  it('is safe to call with no args (defaults to process.env)', () => {
    const stripped = tmuxEnv();
    expect(stripped.TMUX).toBeUndefined();
    expect(stripped.TMUX_PANE).toBeUndefined();
    expect(stripped.PATH).toContain('/opt/homebrew/bin');
    if (process.env.PATH) {
      expect(stripped.PATH?.startsWith(process.env.PATH.split(':')[0]!)).toBe(true);
    }
  });

  it('does not mutate the input env', () => {
    const input: NodeJS.ProcessEnv = { TMUX: '/dead/socket,1,1', PATH: '/usr/bin' };
    tmuxEnv(input);
    expect(input.TMUX).toBe('/dead/socket,1,1');
  });

  it('adds common Homebrew tmux paths for daemon/pm2 environments with a sparse PATH', () => {
    const stripped = tmuxEnv({ PATH: '/usr/bin' });
    expect(stripped.PATH).toBe('/usr/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/bin:/usr/sbin:/sbin');
  });
});

describe('tmux subcommand with stale $TMUX', () => {
  // Only run when tmux is actually available — CI containers may not have it.
  const tmuxAvailable = (() => {
    try {
      execSync('tmux -V', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!tmuxAvailable)(
    'reproduces the bug: bare execSync with stale TMUX leaks stderr to parent',
    () => {
      // This is the BEFORE state — proves the failure mode is real.
      const result = spawnSync('node', ['-e', `
        process.env.TMUX = '/tmp/tmux-99999/missing,12345,0';
        try {
          require('node:child_process').execSync('tmux display-message -p "#{pane_pid}"', {
            encoding: 'utf-8',
            timeout: 3000,
          });
        } catch { /* expected: status 1 */ }
      `], { encoding: 'utf-8', timeout: 10_000 });
      // Bug: tmux's "error connecting to" message lands in parent stderr.
      expect(result.stderr).toMatch(/error connecting to .*missing/);
    },
  );

  it.skipIf(!tmuxAvailable)(
    'fix: tmuxEnv() + explicit pipe stdio keeps parent stderr clean',
    () => {
      // This is the AFTER state — the helper plus explicit stdio together.
      const result = spawnSync('node', [
        '--import',
        'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("ts-node/esm", pathToFileURL("./"));',
        '-e', `
          process.env.TMUX = '/tmp/tmux-99999/missing,12345,0';
          const { execSync } = require('node:child_process');
          // Same call shape used in tmux-backend.getChildPid after the fix.
          try {
            execSync('tmux display-message -p "#{pane_pid}"', {
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
              timeout: 3000,
              env: (() => { const { TMUX, TMUX_PANE, ...rest } = process.env; return rest; })(),
            });
          } catch (err) {
            // Stderr should be in err.stderr (captured), NOT leaked to parent.
            process.stdout.write('captured-stderr-len=' + (err.stderr || '').length + '\\n');
          }
        `,
      ], { encoding: 'utf-8', timeout: 10_000 });
      // The fix: parent stderr is clean even when the child errors out.
      expect(result.stderr).not.toMatch(/error connecting to/);
    },
  );

  it.skipIf(!tmuxAvailable)(
    'probeTmuxFunctional() ignores stale $TMUX and reports the real install state',
    () => {
      // The probe used to be `tmux -V` (already version-only, but still
      // inherited TMUX which is fine for -V). After the helper it explicitly
      // strips TMUX so even if a future probe added a `new-session` step
      // (which we DID add), it doesn't accidentally target a dead server.
      const before = process.env.TMUX;
      process.env.TMUX = '/tmp/tmux-99999/missing,12345,0';
      try {
        const result = probeTmuxFunctional();
        // Either ok (most CI machines) or a *reason* — but never the stale
        // socket path, which would prove we still walked $TMUX.
        if (!result.ok) {
          expect(result.reason).not.toMatch(/\/tmp\/tmux-99999/);
        }
      } finally {
        if (before === undefined) delete process.env.TMUX;
        else process.env.TMUX = before;
      }
    },
  );
});
