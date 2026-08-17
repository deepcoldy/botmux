import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  applySessionOwnerEnv,
  BOTMUX_INJECTED_ENV_KEYS,
  CLAUDE_SESSION_MARKER_ENV_KEYS,
  DASHBOARD_H5_ENV_KEYS,
  DASHBOARD_H5_ENV_PREFIX,
  redactChildEnv,
  REDACTED_CHILD_ENV_KEYS,
  scrubClaudeSessionMarkerEnv,
  scrubSessionCliHomeEnv,
  scrubWorkflowWorkerEnv,
  SESSION_CLI_HOME_ENV_KEYS,
  stripDashboardH5Env,
  WORKFLOW_WORKER_ENV_KEYS,
} from '../src/utils/child-env.js';
import { pm2CallerEnv } from '../src/cli/pm2-env.js';
import { PM2_GRACEFUL_EXIT_CODE_ENV } from '../src/pm2-graceful-exit.js';
import { GOAL_ENV } from '../src/workflows/v3/contract.js';

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
      CLAUDECODE: '1',
      KEEP: 'v',
      PATH: '/usr/bin',
    });
    // The bug this guards: `{ ...env, LARK_APP_ID: undefined }` leaves the key
    // PRESENT (`'LARK_APP_ID' in obj === true`), and node-pty then stringifies
    // it to "undefined". Deleting makes the key absent. Assert ABSENCE, not
    // just falsy value.
    expect('LARK_APP_ID' in out).toBe(false);
    expect('LARK_APP_SECRET' in out).toBe(false);
    expect('CLAUDECODE' in out).toBe(false);
    // Unrelated vars pass through untouched.
    expect(out.KEEP).toBe('v');
    expect(out.PATH).toBe('/usr/bin');
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

  it('covers every H5 var the dashboard actually reads (drift guard)', () => {
    // resolveDashboardH5AuthConfig is the single consumer; scrape its source so
    // adding a knob there without extending the deny list fails here.
    const h5 = readFileSync(new URL('../src/dashboard/h5-auth.ts', import.meta.url), 'utf-8');
    const read = new Set(h5.match(/BOTMUX_DASHBOARD_FEISHU_H5_[A-Z0-9_]+/g) ?? []);
    expect(read.size).toBeGreaterThan(0);
    for (const key of read) {
      expect(DASHBOARD_H5_ENV_KEYS as readonly string[], key).toContain(key);
      expect(key.startsWith(DASHBOARD_H5_ENV_PREFIX), key).toBe(true);
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

  it('real node-pty child does NOT inherit a redacted var (not the string "undefined")', async () => {
    // End-to-end guard for the actual leak vector Codex found: a spawned child
    // must see the redacted var as genuinely UNSET. `${VAR+x}` expands to empty
    // only when VAR is unset, distinguishing "unset" from "set to the string
    // 'undefined'". Run against the real bundled node-pty + /bin/sh.
    const pty = await import('node-pty');
    const prev = process.env.LARK_APP_ID;
    const prevSentinel = process.env[PM2_GRACEFUL_EXIT_CODE_ENV];
    process.env.LARK_APP_ID = 'cli_parent_must_not_leak';
    // Simulate a PM2-managed daemon's env carrying the graceful-exit sentinel,
    // which must not survive into the forked CLI child.
    process.env[PM2_GRACEFUL_EXIT_CODE_ENV] = '90';
    try {
      const env = redactChildEnv(process.env) as { [k: string]: string };
      const script =
        'if [ -z "${LARK_APP_ID+x}" ]; then echo "R=UNSET"; else echo "R=SET[$LARK_APP_ID]"; fi; ' +
        `if [ -z "\${${PM2_GRACEFUL_EXIT_CODE_ENV}+x}" ]; then echo "S=UNSET"; else echo "S=SET[\$${PM2_GRACEFUL_EXIT_CODE_ENV}]"; fi`;
      const out: string = await new Promise((resolve) => {
        const p = pty.spawn('/bin/sh', ['-c', script], {
          name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env,
        });
        let buf = '';
        p.onData((d) => { buf += d; });
        p.onExit(() => resolve(buf));
      });
      expect(out).toContain('R=UNSET');
      expect(out).toContain('S=UNSET');
      expect(out).not.toContain('undefined');
    } finally {
      if (prev === undefined) delete process.env.LARK_APP_ID;
      else process.env.LARK_APP_ID = prev;
      if (prevSentinel === undefined) delete process.env[PM2_GRACEFUL_EXIT_CODE_ENV];
      else process.env[PM2_GRACEFUL_EXIT_CODE_ENV] = prevSentinel;
    }
  });
});

describe('stripDashboardH5Env()', () => {
  it('deletes the full 8-key family plus any future prefix knob in place, keys absent not undefined', () => {
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

  it('is called by index-daemon.ts after dotenv (source pin)', () => {
    // The unit test above proves the function; this pins the boundary that
    // makes it matter: the daemon strips the family it just dotenv-loaded
    // BEFORE any daemon code (or the session-var scrubs below it) can run.
    const src = readFileSync(new URL('../src/index-daemon.ts', import.meta.url), 'utf-8');
    const dotenvAt = src.indexOf('dotenvConfig(');
    const stripAt = src.indexOf('stripDashboardH5Env(process.env)');
    expect(dotenvAt).toBeGreaterThan(-1);
    expect(stripAt).toBeGreaterThan(dotenvAt);
  });

  it('is called by detachedRestartEnv so a dashboard-spawned restart drops the family (source pin)', () => {
    const src = readFileSync(new URL('../src/core/maintenance.ts', import.meta.url), 'utf-8');
    const fn = src.slice(src.indexOf('export function detachedRestartEnv('));
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain('stripDashboardH5Env(');
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

describe('session CLI home scrub call sites', () => {
  // The scrub only works if every process boundary actually invokes it. These
  // source-level pins keep a refactor from silently dropping a boundary:
  // pm2Env (bakes the caller env into pm2 apps + dump.pm2), daemon boot
  // (resurrected from a stale dump, workers fork from it), worker boot
  // (worker-side dynamic resolvers + childEnv seeding).
  const read = (rel: string) =>
    readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf-8');

  it('the pm2 caller env scrubs session CLI homes', () => {
    // cli.ts pm2Env() delegates to cli/pm2-env.ts; that is where the scrub set
    // lives (and where pm2CallerEnv() above proves it behaviorally).
    const src = read('cli/pm2-env.ts');
    const fn = src.slice(src.indexOf('export function scrubPm2CallerEnv('));
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain('scrubSessionCliHomeEnv(');
  });

  it('index-daemon.ts scrubs process.env at boot', () => {
    expect(read('index-daemon.ts')).toContain('scrubSessionCliHomeEnv(process.env)');
  });

  it('worker.ts scrubs process.env at boot', () => {
    expect(read('worker.ts')).toContain('scrubSessionCliHomeEnv(process.env)');
  });

  it('all three boundaries also scrub Claude session markers', () => {
    // Same rationale, same boundaries: a marker that survives pm2's persisted
    // env or a stale dump.pm2 reaches the daemon → the tmux server it forks →
    // every pane on the machine.
    const pm2 = read('cli/pm2-env.ts');
    const fn = pm2.slice(pm2.indexOf('export function scrubPm2CallerEnv('));
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain('scrubClaudeSessionMarkerEnv(');
    expect(read('index-daemon.ts')).toContain('scrubClaudeSessionMarkerEnv(process.env)');
    expect(read('worker.ts')).toContain('scrubClaudeSessionMarkerEnv(process.env)');
  });

  it('injects the canonical session owner at every worker execution boundary', () => {
    const worker = read('worker.ts');
    expect(worker).toContain('applySessionOwnerEnv(process.env, msg.ownerOpenId)');
    expect(worker).toContain('applySessionOwnerEnv(childEnv, cfg.ownerOpenId)');
    expect(worker).toContain('applySessionOwnerEnv(engineEnv, cfg.ownerOpenId)');
    expect(worker).toContain('applySessionOwnerEnv(mergedEnv, cfg.ownerOpenId)');
  });

  it('pm2, daemon, and dashboard boot scrub workflow identity without scrubbing real worker boot', () => {
    const pm2 = read('cli/pm2-env.ts');
    const fn = pm2.slice(pm2.indexOf('export function scrubPm2CallerEnv('));
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain('scrubWorkflowWorkerEnv(');
    expect(read('index-daemon.ts')).toContain('scrubWorkflowWorkerEnv(process.env)');
    const dashboard = read('dashboard.ts');
    const scrubAt = dashboard.indexOf('scrubWorkflowWorkerEnv(process.env)');
    expect(scrubAt).toBeGreaterThan(-1);
    // Must land before anything that can fork a host child — the onboarding
    // manager is wired to the start/stop-bot spawns (dashboard/managed-spawn.ts).
    expect(scrubAt).toBeLessThan(dashboard.indexOf('new BotOnboardingManager('));
    expect(read('worker.ts')).not.toContain('scrubWorkflowWorkerEnv(process.env)');
  });

  it('every CLI-child spawn boundary builds its env from redactChildEnv (source pin)', () => {
    // The H5 secret leak was a missing KEY, not a missing call — but the deny
    // list only protects boundaries that actually route through it. Pin the
    // non-obvious ones: the daemon-side one-shot that titles a session group,
    // and worker.ts's own child/engine envs.
    const oneShot = read('services/session-group-title.ts');
    const fn = oneShot.slice(oneShot.indexOf('export function buildOneShotEnv('));
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain('redactChildEnv(process.env)');
    const worker = read('worker.ts');
    expect(worker).toContain('const childEnv = redactChildEnv(process.env)');
    // The zellij web-terminal viewer used the raw process.env (zellijEnv only
    // drops ZELLIJ*), unlike the tmux viewer whose tmuxEnv folds in
    // REDACTED_CHILD_ENV_KEYS.
    expect(worker).toContain('zellijEnv(redactChildEnv(process.env))');
  });

  it('worker-pool strips the PM2 sentinel when forking a worker (source pin)', () => {
    // WORKER_REDACTED_ENV_KEYS is a private const in worker-pool.ts (worker fork
    // boundary, not importable without side effects), so pin at the source that
    // the sentinel is in the strip list. redactChildEnv covers the CLI child;
    // this covers the worker process itself so it also never exits 90.
    const src = read('core/worker-pool.ts');
    const decl = src.slice(src.indexOf('const WORKER_REDACTED_ENV_KEYS'));
    expect(decl.slice(0, decl.indexOf('\n'))).toContain(PM2_GRACEFUL_EXIT_CODE_ENV);
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
  it('includes BOTMUX_READ_ISOLATION and BOTMUX_API_ONLY', () => {
    expect(BOTMUX_INJECTED_ENV_KEYS).toContain('BOTMUX_READ_ISOLATION');
    expect(BOTMUX_INJECTED_ENV_KEYS).toContain('BOTMUX_API_ONLY');
  });
});

/**
 * pm2 invocation boundary (cli.ts pm2Env → cli/pm2-env.ts).
 *
 * pm2 copies the CALLER's environment into every managed app and into
 * dump.pm2, which `pm2 resurrect` replays after a reboot — so whatever survives
 * this scrub is handed to the whole fleet AND written to disk under
 * ~/.botmux/pm2, readable via `pm2 describe`/`jlist` for as long as that dump
 * lives. `botmux restart` is routinely issued from the dashboard process
 * (update/restart button), which legitimately holds the Feishu H5 login family.
 */
describe('pm2CallerEnv()', () => {
  it('never carries the Dashboard H5 login family into pm2 metadata/dump', () => {
    const future = `${DASHBOARD_H5_ENV_PREFIX}FUTURE_KNOB`;
    const base: NodeJS.ProcessEnv = {
      ...Object.fromEntries(DASHBOARD_H5_ENV_KEYS.map((key) => [key, 'h5-secret'])),
      [future]: 'h5-secret',
      PATH: '/usr/bin',
    };

    const env = pm2CallerEnv(base, '/tmp/pm2-home');

    for (const key of [...DASHBOARD_H5_ENV_KEYS, future]) {
      expect(key in env, key).toBe(false);
    }
    expect(Object.values(env)).not.toContain('h5-secret');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.PM2_HOME).toBe('/tmp/pm2-home');
  });

  it('keeps stripping session CLI homes, Claude markers and workflow identity', () => {
    const base: NodeJS.ProcessEnv = {
      CLAUDE_CONFIG_DIR: '/home/bot-a/.botmux/claude',
      CODEX_HOME: '/home/bot-a/.botmux/codex',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      BOTMUX_WORKFLOW: '1',
      BOTMUX_WORKFLOW_RUN_ID: 'run_1',
      BOTMUX_DASHBOARD_PORT: '7891',
    };

    const env = pm2CallerEnv(base, '/tmp/pm2-home');

    for (const key of [...SESSION_CLI_HOME_ENV_KEYS, ...CLAUDE_SESSION_MARKER_ENV_KEYS, ...WORKFLOW_WORKER_ENV_KEYS]) {
      expect(key in env, key).toBe(false);
    }
    // Non-secret operator settings still ride through — they are the point of
    // the baked env block.
    expect(env.BOTMUX_DASHBOARD_PORT).toBe('7891');
  });

  it('does not mutate the caller env', () => {
    const base: NodeJS.ProcessEnv = { BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET: 'h5-secret' };
    pm2CallerEnv(base, '/tmp/pm2-home');
    expect(base.BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET).toBe('h5-secret');
  });

  it('is the env cli.ts pm2Env() actually hands to pm2 (source pin)', () => {
    // The behavior above only matters if the real pm2 invocations use it: a
    // hand-rolled `{ ...process.env }` in cli.ts would reopen the hole.
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');
    const fn = src.slice(src.indexOf('function pm2Env('));
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain('pm2CallerEnv(process.env, home)');
  });
});
