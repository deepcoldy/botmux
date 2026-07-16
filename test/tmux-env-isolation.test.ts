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
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeTmuxFunctional, scrubTmuxServerGlobalEnv, tmuxEnv } from '../src/setup/ensure-tmux.js';
import { BOTMUX_INJECTED_ENV_KEYS, REDACTED_CHILD_ENV_KEYS, isBotmuxManagedTmuxEnvKey } from '../src/utils/child-env.js';

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

  it('strips botmux session/bot-scoped vars so they never seed the tmux server global env', () => {
    // The leak this guards against: the first `tmux new-session` copies its
    // client env into the server's *global* env, which then bleeds into the
    // user's own co-tenant tmux sessions → a plain Claude Code there inherits
    // BOTMUX_SESSION_ID/CHAT_ID and misroutes its AskUserQuestion hook to Lark.
    const stripped = tmuxEnv({
      BOTMUX: '1',
      BOTMUX_SESSION_ID: '190222fc-bc5f-4481-849b-6161901b8506',
      BOTMUX_CHAT_ID: 'oc_abc',
      BOTMUX_LARK_APP_ID: 'cli_x',
      BOTMUX_ROOT_MESSAGE_ID: 'om_x',
      BOTMUX_BOT_INDEX: '12',           // daemon-internal, swept by the BOTMUX prefix
      BOTMUX_QUIET_RESTART: '1',
      SESSION_DATA_DIR: '/root/.botmux/data',
      IS_SANDBOX: '1',
      CLAUDE_CONFIG_DIR: '/root/.seed/.claude-runtime',
      CODEX_HOME: '/root/.codex-bot',
      HERMES_HOME: '/root/.hermes-bot',
      HERMES_BOTMUX_SOURCE_HOME: '/root/.hermes-source',
      HERMES_BOTMUX_PROFILES_ROOT: '/root/.hermes-profiles',
      CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: '2147483647',
      CJADK_INTERACTIVE: '0',
      __OWNER_OPEN_ID: 'ou_x',
      LARK_APP_ID: 'cli_bot',           // bare creds must not seed the global either
      LARK_APP_SECRET: 'secret',
      CLAUDECODE: '1',
      // Legit passthrough — the tmux client still needs these.
      PATH: '/usr/bin',
      HOME: '/root',
      LANG: 'en_US.UTF-8',
      TERM: 'tmux-256color',
    });
    for (const leaked of [
      'BOTMUX', 'BOTMUX_SESSION_ID', 'BOTMUX_CHAT_ID', 'BOTMUX_LARK_APP_ID',
      'BOTMUX_ROOT_MESSAGE_ID', 'BOTMUX_BOT_INDEX', 'BOTMUX_QUIET_RESTART',
      'SESSION_DATA_DIR', 'IS_SANDBOX', 'CLAUDE_CONFIG_DIR', '__OWNER_OPEN_ID',
      'CODEX_HOME', 'HERMES_HOME', 'HERMES_BOTMUX_SOURCE_HOME',
      'HERMES_BOTMUX_PROFILES_ROOT', 'CLAUDE_CODE_RESUME_TOKEN_THRESHOLD',
      'CJADK_INTERACTIVE',
      'LARK_APP_ID', 'LARK_APP_SECRET', 'CLAUDECODE',
    ]) {
      expect(stripped[leaked]).toBeUndefined();
    }
    // Non-botmux env the tmux client legitimately needs survives.
    expect(stripped.HOME).toBe('/root');
    expect(stripped.LANG).toBe('en_US.UTF-8');
    expect(stripped.TERM).toBe('tmux-256color');
    expect(stripped.PATH?.split(':')[0]).toBe('/usr/bin');
  });

  it('does not strip lookalike keys that merely contain "BOTMUX" mid-name', () => {
    // The sweep is a prefix match (startsWith), not a substring match, so a
    // user var like MY_BOTMUX_HINT is left untouched.
    const stripped = tmuxEnv({ MY_BOTMUX_HINT: 'keep', PATH: '/usr/bin' });
    expect(stripped.MY_BOTMUX_HINT).toBe('keep');
  });

  it('classifies every per-pane and redacted key as tmux-managed', () => {
    for (const key of [...BOTMUX_INJECTED_ENV_KEYS, ...REDACTED_CHILD_ENV_KEYS]) {
      expect(isBotmuxManagedTmuxEnvKey(key), key).toBe(true);
    }
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

  it.skipIf(!tmuxAvailable)(
    'probeTmuxFunctional() removes its disposable probe socket',
    () => {
      const beforeTmpdir = process.env.TMUX_TMPDIR;
      const probeTmpdir = mkdtempSync(join(tmpdir(), 'botmux-tmux-probe-'));
      process.env.TMUX_TMPDIR = probeTmpdir;

      try {
        const result = probeTmuxFunctional();
        if (!result.ok) return;

        const socketDir = join(probeTmpdir, `tmux-${process.getuid?.() ?? 0}`);
        const probeSockets = readdirSync(socketDir, { withFileTypes: true })
          .filter(entry => entry.name.startsWith('bmx-probe-'))
          .map(entry => entry.name);
        expect(probeSockets).toEqual([]);
      } finally {
        if (beforeTmpdir === undefined) delete process.env.TMUX_TMPDIR;
        else process.env.TMUX_TMPDIR = beforeTmpdir;
        rmSync(probeTmpdir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!tmuxAvailable)(
    'startup scrub cleans a legacy server without mutating already-running panes',
    () => {
      const sock = `bmx-scrub-${process.pid}-${Date.now()}`;
      const dir = mkdtempSync(join(tmpdir(), 'botmux-tmux-scrub-'));
      const existingOut = join(dir, 'existing.env');
      const freshOut = join(dir, 'fresh.env');
      const pollutedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        BOTMUX_SESSION_ID: 'stale-session',
        BOTMUX_CHAT_ID: 'stale-chat',
        CODEX_HOME: '/stale/codex',
        HERMES_HOME: '/stale/hermes',
        LARK_APP_ID: 'stale-app',
        HOME: '/safe/home',
      };
      delete pollutedEnv.TMUX;
      delete pollutedEnv.TMUX_PANE;

      try {
        const started = spawnSync('tmux', [
          '-L', sock, 'new-session', '-d', '-s', 'holder', '--',
          '/bin/sh', '-c',
          'tmux -L "$1" wait-for bmx-go; /usr/bin/env > "$2"; tmux -L "$1" wait-for -S bmx-existing-done; sleep 60',
          '_', sock, existingOut,
        ], { env: pollutedEnv, encoding: 'utf-8', timeout: 10_000 });
        expect(started.status, started.stderr).toBe(0);

        const scrub = scrubTmuxServerGlobalEnv(sock);
        expect(scrub.serverFound).toBe(true);
        expect(scrub.failed).toEqual([]);
        expect(scrub.removed).toEqual(expect.arrayContaining([
          'BOTMUX_SESSION_ID', 'BOTMUX_CHAT_ID', 'CODEX_HOME', 'HERMES_HOME', 'LARK_APP_ID',
        ]));

        const globalEnv = spawnSync('tmux', ['-L', sock, 'show-environment', '-g'], {
          env: tmuxEnv(), encoding: 'utf-8', timeout: 5000,
        });
        expect(globalEnv.status, globalEnv.stderr).toBe(0);
        expect(globalEnv.stdout).toContain('HOME=/safe/home');
        for (const key of ['BOTMUX_SESSION_ID', 'BOTMUX_CHAT_ID', 'CODEX_HOME', 'HERMES_HOME', 'LARK_APP_ID']) {
          expect(globalEnv.stdout).not.toMatch(new RegExp(`(?:^|\\n)-?${key}(?:=|\\n|$)`));
        }

        // The holder existed before the global-table repair, so its process
        // environment remains untouched.
        expect(spawnSync('tmux', ['-L', sock, 'wait-for', '-S', 'bmx-go'], {
          env: tmuxEnv(), timeout: 5000,
        }).status).toBe(0);
        expect(spawnSync('tmux', ['-L', sock, 'wait-for', 'bmx-existing-done'], {
          env: tmuxEnv(), timeout: 5000,
        }).status).toBe(0);
        const existingEnv = readFileSync(existingOut, 'utf-8').split('\n');
        expect(existingEnv).toContain('BOTMUX_SESSION_ID=stale-session');
        expect(existingEnv).toContain('CODEX_HOME=/stale/codex');

        // A raw pane created after the scrub no longer inherits any stale key.
        const fresh = spawnSync('tmux', [
          '-L', sock, 'new-session', '-d', '-s', 'fresh', '--',
          '/bin/sh', '-c',
          '/usr/bin/env > "$1"; tmux -L "$2" wait-for -S bmx-fresh-done; sleep 60',
          '_', freshOut, sock,
        ], { env: pollutedEnv, encoding: 'utf-8', timeout: 10_000 });
        expect(fresh.status, fresh.stderr).toBe(0);
        expect(spawnSync('tmux', ['-L', sock, 'wait-for', 'bmx-fresh-done'], {
          env: tmuxEnv(), timeout: 5000,
        }).status).toBe(0);
        const freshEnv = readFileSync(freshOut, 'utf-8').split('\n');
        for (const key of ['BOTMUX_SESSION_ID', 'BOTMUX_CHAT_ID', 'CODEX_HOME', 'HERMES_HOME', 'LARK_APP_ID']) {
          expect(freshEnv.some(line => line.startsWith(`${key}=`)), key).toBe(false);
        }
        expect(freshEnv).toContain('HOME=/safe/home');
      } finally {
        spawnSync('tmux', ['-L', sock, 'kill-server'], { env: tmuxEnv(), timeout: 5000 });
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
