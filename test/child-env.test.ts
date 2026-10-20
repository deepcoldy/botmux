import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  applySessionOwnerEnv,
  scrubExternalMemberEnv,
  BOTMUX_INJECTED_ENV_KEYS,
  CA_BUNDLE_ENV_KEYS,
  CLAUDE_SESSION_MARKER_ENV_KEYS,
  COMPANION_STARTUP_ENV_KEYS,
  DASHBOARD_H5_ENV_KEYS,
  DASHBOARD_H5_ENV_PREFIX,
  INVOKER_TERMINAL_ENV_KEYS,
  PROXY_ENV_KEYS,
  redactChildEnv,
  REDACTED_CHILD_ENV_KEYS,
  scrubClaudeSessionMarkerEnv,
  scrubInvokerTerminalEnv,
  scrubSessionCliHomeEnv,
  scrubSessionTurnMarkerEnv,
  scrubWorkflowWorkerEnv,
  SESSION_CLI_HOME_ENV_KEYS,
  SESSION_TURN_MARKER_ENV_KEYS,
  stripCompanionStartupEnv,
  stripDashboardH5Env,
  WORKFLOW_WORKER_ENV_KEYS,
} from '../src/utils/child-env.js';
import { PM2_GRACEFUL_EXIT_CODE_ENV } from '../src/pm2-graceful-exit.js';
import { COMPANION_BOT_APP_ID_ENV, COMPANION_SECRET_FILE_ENV } from '../src/config.js';
import { GOAL_ENV } from '../src/workflows/v3/contract.js';
import { resolveDashboardH5AuthConfig } from '../src/dashboard/h5-auth.js';

describe('applySessionOwnerEnv()', () => {
  it('injects both the public contract and legacy owner names', () => {
    const env: NodeJS.ProcessEnv = {};
    applySessionOwnerEnv(env, 'ou_owner');
    expect(env).toMatchObject({
      BOTMUX_OWNER_OPEN_ID: 'ou_owner',
      __OWNER_OPEN_ID: 'ou_owner',
    });
  });

  it('removes inherited owner names when the session has no owner', () => {
    const env: NodeJS.ProcessEnv = {
      BOTMUX_OWNER_OPEN_ID: 'ou_stale',
      __OWNER_OPEN_ID: 'ou_stale',
    };
    applySessionOwnerEnv(env, undefined);
    expect(env).not.toHaveProperty('BOTMUX_OWNER_OPEN_ID');
    expect(env).not.toHaveProperty('__OWNER_OPEN_ID');
  });
});

describe('redactChildEnv()', () => {
  it('truly removes leaked keys — absent, not present-with-"undefined"', () => {
    const out = redactChildEnv({
      LARK_APP_ID: 'cli_bot',
      LARK_APP_SECRET: 'secret',
      ONCALL_SERVICE_SECRET: 'oncall-secret',
      NODE_CHANNEL_FD: '3',
      NODE_CHANNEL_SERIALIZATION_MODE: 'json',
      CLAUDECODE: '1',
      KEEP: 'v',
      PATH: '/usr/bin',
      GOFLAGS: '-p=4',
    });
    // The bug this guards: `{ ...env, LARK_APP_ID: undefined }` leaves the key
    // PRESENT (`'LARK_APP_ID' in obj === true`), and node-pty then stringifies
    // it to "undefined". Deleting makes the key absent. Assert ABSENCE, not
    // just falsy value.
    expect('LARK_APP_ID' in out).toBe(false);
    expect('LARK_APP_SECRET' in out).toBe(false);
    expect('ONCALL_SERVICE_SECRET' in out).toBe(false);
    expect('NODE_CHANNEL_FD' in out).toBe(false);
    expect('NODE_CHANNEL_SERIALIZATION_MODE' in out).toBe(false);
    expect(REDACTED_CHILD_ENV_KEYS).toContain('ONCALL_SERVICE_SECRET');
    expect('CLAUDECODE' in out).toBe(false);
    // Unrelated vars pass through untouched.
    expect(out.KEEP).toBe('v');
    expect(out.PATH).toBe('/usr/bin');
    // Host-scoped build policy reaches the CLI through the ordinary child env.
    expect(out.GOFLAGS).toBe('-p=4');
  });

  it('does not mutate the input env', () => {
    const base = { LARK_APP_ID: 'a', LARK_APP_SECRET: 's', CLAUDECODE: '1' };
    redactChildEnv(base);
    expect(base.LARK_APP_ID).toBe('a');
    expect(base.LARK_APP_SECRET).toBe('s');
    expect(base.CLAUDECODE).toBe('1');
  });

  it('removes every Claude session marker from child env', () => {
    // CLAUDE_CODE_CHILD_SESSION is the destructive one — an inherited marker
    // makes the CLI treat itself as a nested subagent session and stop saving
    // transcripts, silently breaking --resume continuity. The rest are the
    // dead parent session's identity and must not reach a fresh CLI either.
    const base = Object.fromEntries(CLAUDE_SESSION_MARKER_ENV_KEYS.map((k) => [k, 'leaked']));
    const out = redactChildEnv({ ...base, CLAUDE_EFFORT: 'high', KEEP: 'v' });
    for (const key of CLAUDE_SESSION_MARKER_ENV_KEYS) {
      expect(key in out, key).toBe(false);
    }
    // Behavior knob, not an identity marker — must survive.
    expect(out.CLAUDE_EFFORT).toBe('high');
    expect(out.KEEP).toBe('v');
  });

  it('removes companion authority from non-serving process environments', () => {
    const env = Object.fromEntries(COMPANION_STARTUP_ENV_KEYS.map(key => [key, 'private']));
    stripCompanionStartupEnv(env);
    for (const key of COMPANION_STARTUP_ENV_KEYS) expect(key in env, key).toBe(false);
  });

  it('removes the companion secret-file path from child env', () => {
    const out = redactChildEnv({
      [COMPANION_SECRET_FILE_ENV]: '/run/secrets/botmux/companion',
      [COMPANION_BOT_APP_ID_ENV]: 'local_test_bot',
      KEEP: 'v',
    });
    expect(COMPANION_SECRET_FILE_ENV in out).toBe(false);
    expect(COMPANION_BOT_APP_ID_ENV in out).toBe(false);
    expect(REDACTED_CHILD_ENV_KEYS).toContain(COMPANION_SECRET_FILE_ENV);
    expect(REDACTED_CHILD_ENV_KEYS).toContain(COMPANION_BOT_APP_ID_ENV);
    expect(out.KEEP).toBe('v');
  });

  it('removes GitHub tokens from child env', () => {
    const out = redactChildEnv({
      GITHUB_TOKEN: 'ghp_secret',
      GH_TOKEN: 'ghs_secret',
      KEEP: 'v',
    });
    expect('GITHUB_TOKEN' in out).toBe(false);
    expect('GH_TOKEN' in out).toBe(false);
    expect(out.KEEP).toBe('v');
  });

  it('removes the Dashboard Feishu H5 credential family from child env', () => {
    // BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET is a full Feishu app credential: the
    // daemon dotenv-loads ~/.botmux/.env wholesale, so before this scrub every
    // PTY/direct CLI child — and every one-shot the daemon forks, e.g. the
    // session group-title call — inherited the secret that mints
    // app_access_token for the Dashboard's login app.
    const out = redactChildEnv({
      ...Object.fromEntries(DASHBOARD_H5_ENV_KEYS.map((key) => [key, 'leaked'])),
      KEEP: 'v',
    });
    for (const key of DASHBOARD_H5_ENV_KEYS) {
      expect(key in out, key).toBe(false);
    }
    expect(out.KEEP).toBe('v');
  });

  it('sweeps the whole H5 prefix, including a knob added after this list', () => {
    // Minimum exposure: no CLI child consumes anything under the prefix, so a
    // future BOTMUX_DASHBOARD_FEISHU_H5_* var must be redacted the day it is
    // added, not the day someone remembers to extend DASHBOARD_H5_ENV_KEYS.
    const future = `${DASHBOARD_H5_ENV_PREFIX}ENCRYPT_KEY`;
    const out = redactChildEnv({ [future]: 'leaked', KEEP: 'v' });
    expect(future in out).toBe(false);
    expect(out.KEEP).toBe('v');
  });

  it('keeps the H5 keys listed by name so the tmux pane wrapper unsets them too', () => {
    // The prefix sweep only covers redactChildEnv (pty/direct + tmux CLIENT
    // env). On the tmux backend the pane inherits the tmux SERVER's global env,
    // which the client env cannot override — PANE_ENV_UNSET_CLAUSE is built from
    // REDACTED_CHILD_ENV_KEYS, and that clause needs literal names.
    for (const key of DASHBOARD_H5_ENV_KEYS) {
      expect(REDACTED_CHILD_ENV_KEYS, key).toContain(key);
    }
  });

  it('covers every H5 var the dashboard actually reads', () => {
    // resolveDashboardH5AuthConfig is the single consumer; record the keys it
    // really reads so adding a knob there without extending the named deny
    // list (which the tmux pane unset clause needs) fails here.
    const read = new Set<string>();
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      get: (_target, key) => { if (typeof key === 'string') read.add(key); return undefined; },
    });
    resolveDashboardH5AuthConfig(env);
    const h5Reads = [...read].filter(key => key.startsWith(DASHBOARD_H5_ENV_PREFIX));
    expect(h5Reads.length).toBeGreaterThanOrEqual(DASHBOARD_H5_ENV_KEYS.length);
    for (const key of h5Reads) {
      expect(DASHBOARD_H5_ENV_KEYS as readonly string[], key).toContain(key);
    }
  });

  it('leaves non-H5 dashboard settings alone — they are not credentials', () => {
    // The sweep is scoped to the H5 credential family. Ordinary dashboard
    // settings that happen to share the BOTMUX_DASHBOARD_ prefix are not
    // secrets and are not part of this deny list.
    const out = redactChildEnv({ BOTMUX_DASHBOARD_PORT: '7991' });
    expect(out.BOTMUX_DASHBOARD_PORT).toBe('7991');
  });

  it('removes the PM2 graceful-exit sentinel so a foreground CLI child exits 0, not 90', () => {
    // pm2 bakes BOTMUX_PM2_GRACEFUL_EXIT_CODE=90 into the daemon env so ONLY the
    // daemon/dashboard cores exit with the sentinel on graceful stop. Left in a
    // session's CLI-child env, a foreground `botmux serve --api-only` / `daemon`
    // launched from inside that session would exit 90 on a clean Ctrl+C
    // (gracefulProcessExitCode reads this key) — a supervisor reads non-zero as
    // a crash. redactChildEnv must strip it at the child boundary.
    const out = redactChildEnv({
      [PM2_GRACEFUL_EXIT_CODE_ENV]: '90',
      KEEP: 'v',
    });
    expect(PM2_GRACEFUL_EXIT_CODE_ENV in out).toBe(false);
    expect(out.KEEP).toBe('v');
  });

  it('pins the redacted sentinel key to PM2_GRACEFUL_EXIT_CODE_ENV (drift guard)', () => {
    // The key is a string literal in REDACTED_CHILD_ENV_KEYS (matching its
    // neighbors) rather than an import, so guard against the two definitions
    // drifting apart if the env var is ever renamed.
    expect(REDACTED_CHILD_ENV_KEYS).toContain(PM2_GRACEFUL_EXIT_CODE_ENV);
  });

  // Two REAL-CHILD guards for the same leak vector, split by transport.
  //
  // The plain-spawn one runs everywhere. The node-pty one is Node-only, because
  // node-pty's fork/exec is broken under Bun when cores are scarce — MEASURED
  // here with `taskset` (node-pty 1.1.0, bun 1.4.2, `/bin/sh -c`):
  //
  //     node, 1 core .......... 25/25 child ran
  //     bun,  1 core ..........  1/25
  //     bun,  2 cores .........  24/25   <- the ~4% red on the 2-core CI runner
  //
  // It is NOT a lost read, which is what this test used to claim. Point the child
  // at a file instead of the pty stream and it still fails 1/25 under bun; have
  // the shell announce itself first (`exec >>log; echo ENTERED`) and a failing run
  // leaves exitCode 1 with no log file at all — /bin/sh never starts. So no
  // amount of draining, waiting or retrying on the JS side can fix it: retrying
  // four times inside one process recovered 0/20 on one core, because the failure
  // is per-process, not per-attempt. A retry loop would look like a fix and only
  // be one on a fast runner.
  //
  // Skipping under Bun keeps the pty leg honest on Node instead of trading a real
  // guard for a flaky one. `redactChildEnv` is transport-agnostic, and the
  // plain-spawn case below exercises the same env marshalling on BOTH runtimes,
  // so nothing about the leak vector goes unguarded here.
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

  const leakProbeScript = (sentinel: string) =>
    'if [ -z "${LARK_APP_ID+x}" ]; then echo "R=UNSET"; else echo "R=SET[$LARK_APP_ID]"; fi; '
    + `if [ -z "\${${sentinel}+x}" ]; then echo "S=UNSET"; else echo "S=SET[\$${sentinel}]"; fi`;

  /** Set the two vars, hand `redactChildEnv`'s output to `run`, always restore. */
  const withLeakyParentEnv = async (run: (env: NodeJS.ProcessEnv) => Promise<string>) => {
    const prev = process.env.LARK_APP_ID;
    const prevSentinel = process.env[PM2_GRACEFUL_EXIT_CODE_ENV];
    process.env.LARK_APP_ID = 'cli_parent_must_not_leak';
    // Simulate a PM2-managed daemon's env carrying the graceful-exit sentinel,
    // which must not survive into the forked CLI child.
    process.env[PM2_GRACEFUL_EXIT_CODE_ENV] = '90';
    try {
      return await run(redactChildEnv(process.env) as { [k: string]: string });
    } finally {
      if (prev === undefined) delete process.env.LARK_APP_ID;
      else process.env.LARK_APP_ID = prev;
      if (prevSentinel === undefined) delete process.env[PM2_GRACEFUL_EXIT_CODE_ENV];
      else process.env[PM2_GRACEFUL_EXIT_CODE_ENV] = prevSentinel;
    }
  };

  /** Both answers present — the only shape that proves the child actually ran. */
  const expectNoLeak = (out: string) => {
    expect(out).toContain('R=UNSET');
    expect(out).toContain('S=UNSET');
    expect(out).not.toContain('undefined');
  };

  it('real spawned child does NOT inherit a redacted var (not the string "undefined")', async () => {
    // End-to-end guard for the actual leak vector: a spawned child must see the
    // redacted var as genuinely UNSET. `${VAR+x}` expands to empty only when VAR
    // is unset, distinguishing "unset" from "set to the string 'undefined'".
    // Plain spawn, so this leg runs on Node AND Bun (measured 25/25 on both at
    // one core).
    const out = await withLeakyParentEnv((env) => new Promise<string>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', leakProbeScript(PM2_GRACEFUL_EXIT_CODE_ENV)], {
        cwd: '/tmp', env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buf = '';
      child.stdout.on('data', (d) => { buf += String(d); });
      child.on('error', reject);
      // `close` (not `exit`) fires only after both stdio streams are drained, so
      // the buffer is complete by definition — no grace period to tune.
      child.on('close', () => resolve(buf));
    }));
    expectNoLeak(out);
  });

  it.skipIf(isBun)('real node-pty child does NOT inherit a redacted var (not the string "undefined")', async () => {
    // Same guard across the PTY transport, which marshals env into raw K=V pairs
    // in native code rather than reusing libuv's spawn path — a distinct code
    // path worth covering. Node-only for the reason documented above.
    const pty = await import('node-pty');
    const out = await withLeakyParentEnv((env) => new Promise<string>((resolve, reject) => {
      const p = pty.spawn('/bin/sh', ['-c', leakProbeScript(PM2_GRACEFUL_EXIT_CODE_ENV)], {
        name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env: env as { [k: string]: string },
      });
      let buf = '';
      let settled = false;
      // node-pty delivers onData and onExit on independent paths: the child can be
      // reaped before the pty's pending output has been drained, so resolving
      // straight from onExit can hand back an empty string. Settle on having BOTH
      // answers, and let exit only START a short grace period rather than decide.
      // If the grace period expires with the output still incomplete, REJECT with
      // the raw buffer: a lost read must never be reported as a leak-shaped
      // assertion failure ("Expected to contain R=UNSET / Received: ''").
      const hasBothAnswers = () => /\bR=(UNSET|SET)/.test(buf) && /\bS=(UNSET|SET)/.test(buf);
      const finish = (settle: () => void) => { if (settled) return; settled = true; settle(); };
      const fail = () => finish(() => reject(new Error(
        'pty output incomplete — a lost read, not an env leak. '
        + `Expected both R= and S= answers, got ${JSON.stringify(buf)}`,
      )));
      const guard = setTimeout(fail, 10_000);
      guard.unref?.();
      p.onData((d) => {
        buf += d;
        if (hasBothAnswers()) { clearTimeout(guard); finish(() => resolve(buf)); }
      });
      p.onExit(() => {
        setTimeout(() => {
          clearTimeout(guard);
          if (hasBothAnswers()) finish(() => resolve(buf));
          else fail();
        }, 250);
      });
    }));
    expectNoLeak(out);
  });
});

describe('stripDashboardH5Env()', () => {
  it('deletes the whole named family plus any future prefix knob in place, keys absent not undefined', () => {
    // The daemon dotenv-loads ~/.botmux/.env wholesale, so at boot its env
    // holds the Dashboard's H5 APP_SECRET (a full Feishu app credential).
    // index-daemon.ts calls this right after dotenv: the daemon process itself
    // must hold nothing of the family — redactChildEnv/tmux pane unset stay as
    // the second layer at the CLI-child boundary. Same node-pty trap as
    // redactChildEnv: keys must be ABSENT, not present-with-"undefined".
    const future = `${DASHBOARD_H5_ENV_PREFIX}FUTURE_KNOB`;
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(DASHBOARD_H5_ENV_KEYS.map((key) => [key, 'secret'])),
      [future]: 'secret',
      KEEP: 'v',
      PATH: '/usr/bin',
    };

    stripDashboardH5Env(env);

    for (const key of DASHBOARD_H5_ENV_KEYS) {
      expect(key in env, key).toBe(false);
    }
    expect(future in env).toBe(false);
    // Non-H5 vars — including non-secret BOTMUX_DASHBOARD_* settings — survive.
    expect(env.KEEP).toBe('v');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('leaves non-H5 dashboard settings alone', () => {
    const env: NodeJS.ProcessEnv = { BOTMUX_DASHBOARD_PORT: '7991' };
    stripDashboardH5Env(env);
    expect(env.BOTMUX_DASHBOARD_PORT).toBe('7991');
  });
});

describe('scrubSessionCliHomeEnv()', () => {
  it('deletes inherited session-level CLI home pointers in place, keys absent not undefined', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CONFIG_DIR: '/root/.botmux/bots/sibling-bot/claude',
      CODEX_HOME: '/root/.botmux/bots/sibling-bot/codex',
      KEEP: 'v',
      PATH: '/usr/bin',
    };
    scrubSessionCliHomeEnv(env);
    // Same node-pty trap as redactChildEnv: the key must be ABSENT, or the
    // child sees the literal string "undefined" and still relocates its home.
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
    expect('CODEX_HOME' in env).toBe(false);
    expect(env.KEEP).toBe('v');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('leaves GROK_HOME alone — process-level by contract, never session-injected', () => {
    // grok-paths.ts: the worker installs ready-gate hooks and drains
    // transcripts under the process-level GROK_HOME; botmux never injects a
    // per-session value, so scrubbing it would only split-brain the worker
    // from the CLI child. Guards against GROK_HOME creeping into the list.
    const env: NodeJS.ProcessEnv = { GROK_HOME: '/custom/grok' };
    scrubSessionCliHomeEnv(env);
    expect(env.GROK_HOME).toBe('/custom/grok');
    expect(SESSION_CLI_HOME_ENV_KEYS).not.toContain('GROK_HOME');
  });
});

describe('scrubClaudeSessionMarkerEnv()', () => {
  it('deletes every inherited Claude session marker in place, keys absent not undefined', () => {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(CLAUDE_SESSION_MARKER_ENV_KEYS.map((k) => [k, 'stale'])),
      KEEP: 'v',
      PATH: '/usr/bin',
    };
    scrubClaudeSessionMarkerEnv(env);
    for (const key of CLAUDE_SESSION_MARKER_ENV_KEYS) {
      expect(key in env, key).toBe(false);
    }
    expect(env.KEEP).toBe('v');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('also drops CLAUDE_EFFORT at boundaries — inherited it can only be the issuing session\'s', () => {
    // An effort override that rode pm2 → daemon → worker would silently pin the
    // issuing Claude session's effort onto every bot (behavior/cost/latency).
    // The supported channels land AFTER this boundary scrub and keep working:
    // per-bot env injection (all backends, PTY included) and the pane shell's
    // profile (shell-wrapped backends) — hence the key is NOT in
    // CLAUDE_SESSION_MARKER_ENV_KEYS (no pane unset, no server scrub, and
    // redactChildEnv keeps it, as the marker test above pins).
    const env: NodeJS.ProcessEnv = { CLAUDE_EFFORT: 'high' };
    scrubClaudeSessionMarkerEnv(env);
    expect('CLAUDE_EFFORT' in env).toBe(false);
    expect(CLAUDE_SESSION_MARKER_ENV_KEYS).not.toContain('CLAUDE_EFFORT');
  });
});

describe('scrubWorkflowWorkerEnv()', () => {
  it('removes the complete workflow and goal identity in place', () => {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(WORKFLOW_WORKER_ENV_KEYS.map((key) => [key, 'leaked'])),
      BOTMUX_WORKFLOW_RUNS_DIR: '/shared/workflow-runs',
      KEEP: 'v',
    };

    scrubWorkflowWorkerEnv(env);

    for (const key of WORKFLOW_WORKER_ENV_KEYS) {
      expect(key in env, key).toBe(false);
    }
    // Global workflow storage configuration is not a node-worker identity.
    expect(env.BOTMUX_WORKFLOW_RUNS_DIR).toBe('/shared/workflow-runs');
    expect(env.KEEP).toBe('v');
  });

  it('covers the canonical goal contract without drifting', () => {
    for (const key of Object.values(GOAL_ENV)) {
      expect(WORKFLOW_WORKER_ENV_KEYS).toContain(key);
    }
  });
});

describe('scrubInvokerTerminalEnv()', () => {
  it('removes every invoker-terminal fingerprint in place, leaving machine env alone', () => {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(INVOKER_TERMINAL_ENV_KEYS.map((key) => [key, 'fingerprint'])),
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      HTTPS_PROXY: 'http://proxy:8080',
    };

    scrubInvokerTerminalEnv(env);

    for (const key of INVOKER_TERMINAL_ENV_KEYS) {
      expect(key in env, key).toBe(false);
    }
    // Machine/user env that legitimately flows into the fleet must survive.
    expect(env.PATH).toBe('/usr/bin');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080');
  });

  it('pins the observed agent-shell fingerprints that turned the fleet colorless', () => {
    // The 2026-08 incident baked exactly these from a Codex tool shell into
    // every daemon: NO_COLOR killed all session TUI colors, CODEX_CI marked
    // every child as CI, PAGER=cat + TERMINFO pointed at a terminal app's
    // private dir. Keep them pinned so a list refactor cannot drop them.
    for (const key of ['NO_COLOR', 'FORCE_COLOR', 'CODEX_CI', 'CI', 'TERM', 'TERMINFO', 'PAGER', 'GIT_PAGER', 'GH_PAGER']) {
      expect(INVOKER_TERMINAL_ENV_KEYS).toContain(key);
    }
    // TERMINFO_DIRS is machine-level terminfo search-path config on
    // NixOS/custom-ncurses hosts, not an invoker fingerprint — never scrub it.
    expect(INVOKER_TERMINAL_ENV_KEYS).not.toContain('TERMINFO_DIRS');
  });
});

describe('scrubSessionTurnMarkerEnv()', () => {
  it('removes turn-scoped session identity, leaving documented ambient config alone', () => {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(SESSION_TURN_MARKER_ENV_KEYS.map((key) => [key, 'stale-turn'])),
      // Documented ambient daemon config channels must NOT be swept by this
      // scrub (they are handled by resolveDaemonEnv / registry precedence).
      BOTS_CONFIG: '/alt/bots.json',
      BOTMUX_PUBLIC_URL: 'https://botmux.example',
      KEEP: 'v',
    };

    scrubSessionTurnMarkerEnv(env);

    for (const key of SESSION_TURN_MARKER_ENV_KEYS) {
      expect(key in env, key).toBe(false);
    }
    expect(env.BOTS_CONFIG).toBe('/alt/bots.json');
    expect(env.BOTMUX_PUBLIC_URL).toBe('https://botmux.example');
    expect(env.KEEP).toBe('v');
  });

  it('covers both owner channels so a stale owner can never be baked fleet-wide', () => {
    expect(SESSION_TURN_MARKER_ENV_KEYS).toContain('BOTMUX_OWNER_OPEN_ID');
    expect(SESSION_TURN_MARKER_ENV_KEYS).toContain('__OWNER_OPEN_ID');
    expect(SESSION_TURN_MARKER_ENV_KEYS).toContain('BOTMUX_SESSION_ID');
    expect(SESSION_TURN_MARKER_ENV_KEYS).toContain('BOTMUX_REPLY_STYLE');
  });

  it('covers session-only capabilities AND routing keys the pane transport never carries', () => {
    // The list is hand-maintained on the "session-scoped by construction"
    // criterion, NOT derived from BOTMUX_INJECTED_ENV_KEYS — that list is the
    // pane TRANSPORT whitelist and mixes in ambient config. Both directions
    // must hold: capabilities that ARE transported, and routing keys that are
    // NOT (BOTMUX_SESSION_SCOPE / BOTMUX_SEND_RELAY reach children outside
    // the pane injection list).
    for (const key of [
      'BOTMUX_MCP_GATEWAY_SOCKET',
      'BOTMUX_MCP_GATEWAY_REQUIRED',
      'BOTMUX_DAEMON_IPC_PORT',
      'BOTMUX_READ_ISOLATION',
      'BOTMUX_READ_ISOLATED',
      'BOTMUX_API_ONLY',
      'IS_SANDBOX',
      'BOTMUX_ORIGIN_CHANNEL_ID',
      'BOTMUX_LARK_APP_ID',
      'BOTMUX_SESSION_SCOPE',
      'BOTMUX_SEND_RELAY',
      // per-session shadowed user statusLine command (worker-computed from cwd)
      'BOTMUX_STATUSLINE_CHAIN',
    ]) {
      expect(SESSION_TURN_MARKER_ENV_KEYS, key).toContain(key);
    }
  });

  it('legitimate ambient/daemon config survives the FULL pm2/daemon-boot scrub stack', () => {
    // The regression this pins: CLAUDE_CODE_RESUME_TOKEN_THRESHOLD's only
    // legitimate channel is daemon ambient env (worker.ts reads process.env,
    // per-bot env rejects the key) — index-daemon loads ~/.botmux/.env via
    // dotenv and THEN runs these scrubs, so including it in any scrub family
    // silently kills the user's setting. Same for the HERMES install-location
    // roots (nothing in botmux sets them; ambient-only, like GROK_HOME) and
    // the documented ambient/ecosystem config keys.
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: '150000',
      HERMES_HOME: '/opt/hermes',
      HERMES_BOTMUX_SOURCE_HOME: '/opt/hermes-src',
      HERMES_BOTMUX_PROFILES_ROOT: '/opt/hermes-profiles',
      BOTS_CONFIG: '/alt/bots.json',
      SESSION_DATA_DIR: '/data/botmux',
      BOTMUX_LARK_LIST_BOTS_API_ENABLED: 'true',
      BOTMUX_LARK_LIST_BOTS_API_TIMEOUT_MS: '3000',
      GROK_HOME: '/opt/grok',
    };

    // The full boundary stack, in the index-daemon boot order.
    scrubSessionTurnMarkerEnv(env);
    scrubSessionCliHomeEnv(env);
    scrubClaudeSessionMarkerEnv(env);
    scrubWorkflowWorkerEnv(env);
    scrubInvokerTerminalEnv(env);

    expect(env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD).toBe('150000');
    expect(env.HERMES_HOME).toBe('/opt/hermes');
    expect(env.HERMES_BOTMUX_SOURCE_HOME).toBe('/opt/hermes-src');
    expect(env.HERMES_BOTMUX_PROFILES_ROOT).toBe('/opt/hermes-profiles');
    expect(env.BOTS_CONFIG).toBe('/alt/bots.json');
    expect(env.SESSION_DATA_DIR).toBe('/data/botmux');
    expect(env.BOTMUX_LARK_LIST_BOTS_API_ENABLED).toBe('true');
    expect(env.BOTMUX_LARK_LIST_BOTS_API_TIMEOUT_MS).toBe('3000');
    expect(env.GROK_HOME).toBe('/opt/grok');
  });

  it('true session-only values are deleted by the same stack', () => {
    const env: NodeJS.ProcessEnv = {
      BOTMUX_SESSION_ID: 's-1',
      BOTMUX_SESSION_SCOPE: 'thread',
      BOTMUX_SEND_RELAY: '/tmp/relay',
      BOTMUX_MCP_GATEWAY_SOCKET: '/tmp/mcp.sock',
      BOTMUX_DAEMON_IPC_PORT: '7951',
      BOTMUX_OWNER_OPEN_ID: 'ou_x',
      IS_SANDBOX: '1',
      CLAUDE_CONFIG_DIR: '/leak/claude',
      CLAUDECODE: '1',
      NO_COLOR: '1',
    };

    scrubSessionTurnMarkerEnv(env);
    scrubSessionCliHomeEnv(env);
    scrubClaudeSessionMarkerEnv(env);
    scrubWorkflowWorkerEnv(env);
    scrubInvokerTerminalEnv(env);

    for (const key of Object.keys(env)) {
      expect.fail(`expected every key deleted, found ${key}`);
    }
  });
});

describe('process-boundary env scrub call sites', () => {
  // Each scrub/strip helper is behavior-tested above; these pins keep a refactor
  // from silently dropping the boundary that makes it matter. The entry modules
  // run their scrubs at import time (importing them boots the process), so the
  // call sites can only be checked in the source.
  const read = (rel: string) =>
    readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf-8');
  const callsOnProcessEnv = (src: string, fn: string) =>
    new RegExp(`\\b${fn}\\(\\s*process\\.env\\s*\\)`).test(src);

  // 源码结构护栏(K2)：入口模块在 import 时即执行 boot 清洗，没有可调用的 seam；守的是长寿进程不把
  // 凭证/会话身份带进它 fork 的整个 fleet —— Dashboard H5 APP_SECRET 与 companion 凭证、兄弟 bot 的
  // CLAUDE_CONFIG_DIR/CODEX_HOME（385d189d6c）、owner/turn 标记（#877、#1207）、workflow 身份（#809）、
  // Claude 会话标记（b7a123c19e：实机事故，fleet 转写静默停写、--resume 全部失效）。
  it('every long-lived entry scrubs inherited credentials and session identity at boot', () => {
    const required: Record<string, string[]> = {
      'index-supervisor.ts': ['stripDashboardH5Env', 'scrubSessionTurnMarkerEnv', 'scrubSessionCliHomeEnv',
        'scrubClaudeSessionMarkerEnv', 'scrubWorkflowWorkerEnv'],
      'index-daemon.ts': ['stripDashboardH5Env', 'stripCompanionStartupEnv', 'scrubSessionTurnMarkerEnv',
        'scrubSessionCliHomeEnv', 'scrubClaudeSessionMarkerEnv', 'scrubWorkflowWorkerEnv'],
      'index-dashboard.ts': ['scrubSessionTurnMarkerEnv'],
      'dashboard.ts': ['scrubWorkflowWorkerEnv'],
      'worker.ts': ['scrubSessionCliHomeEnv', 'scrubClaudeSessionMarkerEnv'],
      'index-plugin-supervisor.ts': ['scrubExternalMemberEnv'],
    };
    for (const [rel, fns] of Object.entries(required)) {
      const src = read(rel);
      for (const fn of fns) expect(callsOnProcessEnv(src, fn), `${rel}: ${fn}(process.env)`).toBe(true);
    }
    // The daemon strips the H5 family only AFTER dotenv loaded it; the supervisor
    // never wholesale-loads ~/.botmux/.env into the long-lived parent of every bot.
    const daemon = read('index-daemon.ts');
    expect(daemon.indexOf('dotenvConfig(')).toBeGreaterThan(-1);
    expect(daemon.search(/stripDashboardH5Env\(\s*process\.env/)).toBeGreaterThan(daemon.indexOf('dotenvConfig('));
    expect(read('index-supervisor.ts')).not.toContain('dotenvConfig(');
    // The dashboard scrubs before it can fork start/stop-bot children.
    const dashboard = read('dashboard.ts');
    expect(dashboard.search(/scrubWorkflowWorkerEnv\(\s*process\.env/))
      .toBeLessThan(dashboard.indexOf('new BotOnboardingManager('));
    // A real workflow worker receives its identity explicitly; worker boot must keep it.
    expect(callsOnProcessEnv(read('worker.ts'), 'scrubWorkflowWorkerEnv')).toBe(false);
    // The external-member launcher scrubs the env it hands the plugin supervisor.
    expect(read('core/plugins/supervisor-client.ts')).toMatch(/\bscrubExternalMemberEnv\(/);
  });

  // 源码结构护栏(K2)：worker 的 CLI child / engine / runner env 都在 worker.ts 巨型闭包里拼装，没有
  // 行为 seam；守的是凭证脱敏（H5 secret 曾经漏进 CLI child 与 zellij 终端 viewer）和 CLAUDE.md
  // 「飞书 owner 身份边界」要求的 applySessionOwnerEnv 在每个执行边界注入并冻结。
  it('worker routes child envs through the shared redaction builder and freezes the session owner', () => {
    const worker = read('worker.ts');
    expect(worker).toMatch(/\bchildEnv\s*=\s*buildSessionChildEnv\(\s*process\.env\b/);
    expect(worker).toMatch(/\bzellijEnv\(\s*redactChildEnv\(\s*process\.env\s*\)/);
    for (const target of ['process\\.env', 'childEnv', 'engineEnv', 'mergedEnv']) {
      expect(worker, target).toMatch(new RegExp(`\\bapplySessionOwnerEnv\\(\\s*${target}\\s*,`));
    }
  });
});

// ─── read-isolation markers must reach the child ──────────────────────────

/**
 * Regression guard (2026-08-03): the sandbox bots.json fix hinges on the worker
 * telling the CLI it is isolated. buildBotmuxEnvAssignments() forwards ONLY the
 * keys in BOTMUX_INJECTED_ENV_KEYS, so leaving these out silently strips them on
 * the tmux backend — the fix would compile, pass every unit test, and do nothing
 * on a real machine. (Three review rounds did not catch this; the allowlist is
 * the kind of coupling that is invisible from the call site.)
 */
describe('BOTMUX_INJECTED_ENV_KEYS carries the read-isolation markers', () => {
  it('includes sandbox verdicts and the per-session reply-style snapshot', () => {
    expect(BOTMUX_INJECTED_ENV_KEYS).toContain('BOTMUX_READ_ISOLATION');
    expect(BOTMUX_INJECTED_ENV_KEYS).toContain('BOTMUX_API_ONLY');
    expect(BOTMUX_INJECTED_ENV_KEYS).toContain('BOTMUX_REPLY_STYLE');
    expect(BOTMUX_INJECTED_ENV_KEYS).toContain('BOTMUX_PLUGIN_CARD_ACTION_CAPABILITIES');
    expect(SESSION_TURN_MARKER_ENV_KEYS).toContain('BOTMUX_PLUGIN_CARD_ACTION_CAPABILITIES');
    // `botmux statusline` runs inside the pane and needs the worker-computed chain
    // command; without transport it would silently drop the user's own statusLine.
    expect(BOTMUX_INJECTED_ENV_KEYS).toContain('BOTMUX_STATUSLINE_CHAIN');
    expect(SESSION_TURN_MARKER_ENV_KEYS).toContain('BOTMUX_STATUSLINE_CHAIN');
  });

  it('keeps SSL_CERT_FILE OUT of the injected list and in its own CA-bundle list', () => {
    // BOTMUX_INJECTED_ENV_KEYS also drives the pane `unset` clause and
    // scrubTmuxServerGlobalEnv(), so a standard, user-ownable variable listed
    // there would delete the CA bundle a user configured for their own tmux
    // server — for every CLI, on every platform. Same reason PROXY_ENV_KEYS is
    // kept out. Per-pane forwarding happens in buildBotmuxEnvAssignments.
    expect(BOTMUX_INJECTED_ENV_KEYS).not.toContain('SSL_CERT_FILE');
    expect(CA_BUNDLE_ENV_KEYS).toContain('SSL_CERT_FILE');
    expect(PROXY_ENV_KEYS as readonly string[]).not.toContain('SSL_CERT_FILE');
  });
});

describe('scrubExternalMemberEnv (external fleet members)', () => {
  // The fixture carries every key family the old pm2 plugin boundary stripped
  // (pm2Env(): stripPm2GracefulExitMarker(...) then scrubPm2CallerEnv(...)), so
  // this spec fails if any of those strips is ever dropped — including the
  // graceful-exit sentinel, which once leaked into external members unnoticed.
  it('strips every key family the old pm2 plugin boundary stripped', () => {
    const env: NodeJS.ProcessEnv = {
      CODEX_HOME: '/bot/a/codex',
      CLAUDE_CONFIG_DIR: '/bot/a/claude',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'sess',
      BOTMUX_WORKFLOW: '1',
      BOTMUX_GOAL_PATH: '/tmp/goal',
      BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET: 'secret',
      NO_COLOR: '1',
      FORCE_COLOR: '3',
      BOTMUX_SESSION_ID: 'sess-1',
      BOTMUX_TURN_ID: 'turn-1',
      // resolveFleetDaemonEnv pins this for EVERY supervised member, so an
      // external member really does arrive here carrying it.
      [PM2_GRACEFUL_EXIT_CODE_ENV]: '90',
      PATH: '/usr/bin',
      HOME: '/root',
      UNRELATED: 'keep',
    };
    scrubExternalMemberEnv(env);
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/root',
      UNRELATED: 'keep',
      TERM: 'xterm-256color',
    });
  });

  it('never carries the Dashboard H5 login family (incl. future prefixed knobs) into external members', () => {
    const future = `${DASHBOARD_H5_ENV_PREFIX}FUTURE_KNOB`;
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(DASHBOARD_H5_ENV_KEYS.map((key) => [key, 'h5-secret'])),
      [future]: 'h5-secret',
      PATH: '/usr/bin',
      BOTMUX_DASHBOARD_PORT: '7891',
    };
    scrubExternalMemberEnv(env);
    for (const key of [...DASHBOARD_H5_ENV_KEYS, future]) {
      expect(key in env, key).toBe(false);
    }
    expect(Object.values(env)).not.toContain('h5-secret');
    // Non-secret operator settings still ride through.
    expect(env.PATH).toBe('/usr/bin');
    expect(env.BOTMUX_DASHBOARD_PORT).toBe('7891');
  });

  it('strips the graceful-exit sentinel (drift guard on the key name)', () => {
    // Spelled as a literal in child-env.ts (that module is dependency-free), so
    // pin it to the constant here the way REDACTED_CHILD_ENV_KEYS is pinned.
    const env: NodeJS.ProcessEnv = { [PM2_GRACEFUL_EXIT_CODE_ENV]: '90', PATH: '/usr/bin' };
    scrubExternalMemberEnv(env);
    expect(env[PM2_GRACEFUL_EXIT_CODE_ENV]).toBeUndefined();
  });

  it('keeps unrelated env and re-pins TERM rather than deleting it', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', UNRELATED: 'keep', TERM: 'dumb', NO_COLOR: '1' };
    scrubExternalMemberEnv(env);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.UNRELATED).toBe('keep');
    // Deleting TERM would make the child render colorless — the same end state
    // the invoker-terminal scrub exists to prevent — so it is pinned, not removed.
    expect(env.TERM).toBe('xterm-256color');
    expect(env.NO_COLOR).toBeUndefined();
  });
});
