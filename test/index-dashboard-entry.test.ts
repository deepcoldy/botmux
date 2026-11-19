import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import {
  DASHBOARD_ENV_ALLOWLIST,
  isDashboardEnvKey,
  loadDashboardEnvFile,
} from '../src/utils/dashboard-env.js';
import { DAEMON_ENV_KEYS } from '../src/cli/daemon-lifecycle-env.js';
import { DASHBOARD_H5_ENV_KEYS } from '../src/utils/child-env.js';

/**
 * Regression pins for the Dashboard's dedicated PM2 entry point.
 *
 * The Feishu H5 credential family (BOTMUX_DASHBOARD_FEISHU_H5_*, APP_SECRET
 * included) reaches the dashboard ONLY via index-dashboard.ts loading
 * ~/.botmux/.env — deliberately NOT via the shared PM2 env block
 * (DAEMON_ENV_KEYS), which every bot daemon receives and which persists on
 * disk in ~/.botmux/ecosystem.config.json. Three things keep that channel
 * working, and each has a way to rot silently:
 *  1. cli.ts must start dist/index-dashboard.js, not dist/dashboard.js —
 *     pointed back at dashboard.js, the dashboard boots with no .env load and
 *     a fully configured H5 login is silently `enabled:false` (entry 404).
 *  2. index-dashboard.ts must load the file BEFORE a DYNAMIC import of
 *     dashboard.js — made static, ESM hoisting evaluates dashboard.ts's import
 *     graph (incl. config.ts and its module-level process.env reads) before
 *     the entry's body, i.e. before the load ran.
 *  3. dashboard.ts must stay dotenv-free — a "convenient" dotenv at its top
 *     would still run AFTER its own static imports (config.ts included) and
 *     would re-create the broken half-loaded ordering in disguise.
 *
 * The load itself is ALLOWLISTED (utils/dashboard-env.ts) rather than a
 * wholesale dotenv; its behavior is covered by the second describe below.
 *
 * NOTE on depth: the pins in the FIRST describe are source-level, not a
 * behavior-level boot test. The honest behavior test would launch
 * dist/index-dashboard.js as a child process against a temp HOME/.env fixture
 * — but importing dashboard.js starts real HTTP/TCP servers, timers and daemon
 * probes during module evaluation, and the test would depend on a built dist/.
 * Deliberate trade-off: pin the exact mechanism (load position +
 * dynamic-import form + dotenv-free dashboard.ts) at source level, and test
 * the loader — the part that actually decides what enters process.env — for
 * real. The ESM evaluation-order semantics the pins rely on are Node
 * guarantees, not project code.
 */

const read = (rel: string) =>
  readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf-8');

/** Relative paths (under src/) of every module reachable from `entry` through
 *  STATIC value imports/re-exports, i.e. everything ESM evaluates before the
 *  entry's own body runs. `import type` is erased and dynamic import() is lazy. */
function staticImportClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const specifier = /(?:^|;)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm;
  const visit = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const match of read(rel).matchAll(specifier)) {
      const next = posix.normalize(posix.join(posix.dirname(rel), match[1].replace(/\.js$/, '.ts')));
      if (existsSync(new URL(`../src/${next}`, import.meta.url))) visit(next);
    }
  };
  visit(entry);
  return seen;
}

describe('index-dashboard.ts — Dashboard PM2 entry', () => {
  // 源码结构护栏(K1)：ESM 先求值整张静态 import 图再跑入口正文，所以「先 load ~/.botmux/.env、再动态
  // import dashboard.js」只能靠模块结构保证——静态图里一旦出现 config.ts（模块级读 process.env）或
  // dashboard.ts，H5 登录凭据就会在 load 之前被快照成未配置。真跑入口要起 HTTP 服务并依赖 dist/，见文件头注释。
  it('evaluates the allowlisted .env load before anything that snapshots process.env', () => {
    const src = read('index-dashboard.ts');
    const loadAt = src.indexOf('loadDashboardEnvFile(');
    const importAt = src.search(/await import\(\s*['"]\.\/dashboard\.js['"]\s*\)/);
    expect(loadAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(loadAt);

    const closure = staticImportClosure('index-dashboard.ts');
    expect(closure).toContain('utils/dashboard-env.ts');
    for (const rel of closure) {
      expect(rel, 'index-dashboard.ts statically reaches a module that evaluates config.ts / dashboard.ts early')
        .not.toMatch(/^(config|dashboard)\.ts$|^dashboard\//);
    }
  });

  // 源码结构护栏(K2)：~/.botmux/.env 常含与 dashboard 无关的凭据，而 dashboard 会 fork start-bot / 全局 install /
  // 插件服务等子进程继承 process.env，所以只能经 allowlist 加载器（utils/dashboard-env.ts，下方行为测试覆盖）。
  // 入口或 dashboard.ts 里出现整包 dotenv，就会把全部凭据灌进进程环境（P1-9「.env secret 扩散」）。
  it('never loads .env wholesale in the entry or in dashboard.ts', () => {
    for (const rel of ['index-dashboard.ts', 'dashboard.ts']) {
      expect(read(rel), rel).not.toMatch(/from\s+['"]dotenv['"]|require\(\s*['"]dotenv['"]\s*\)/);
    }
  });
});

/**
 * Behavior-level cover for the allowlisted load itself (P1-9 «.env secret
 * 扩散»). ~/.botmux/.env is a general operator file: it commonly holds the
 * legacy single-bot LARK_APP_SECRET, GitHub tokens, model API keys and
 * whatever else the host needs. The dashboard used to dotenv the whole thing
 * into process.env — and it forks `botmux start-bot/stop-bot`, a global
 * npm/pnpm/bun install (arbitrary lifecycle scripts!), herdr plugin installs and plugin PM2 services, all of which
 * inherit that environment. Only keys with a named dashboard consumer may
 * cross into the process.
 */
describe('loadDashboardEnvFile() — allowlisted .env load', () => {
  let dir: string | null = null;
  const envFile = (body: string): string => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-dashboard-env-'));
    const p = join(dir, '.env');
    writeFileSync(p, body);
    return p;
  };
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  // A realistic, secret-stuffed ~/.botmux/.env: dashboard settings + the H5
  // login family + credentials that have NO dashboard consumer.
  const FULL_ENV = [
    'BOTMUX_DASHBOARD_PORT=7999',
    'BOTMUX_DASHBOARD_HOST=127.0.0.1',
    'BOTMUX_DASHBOARD_EXTERNAL_HOST=dash.example.com',
    'BOTMUX_DASHBOARD_PUBLIC_READONLY=false',
    'BOTMUX_PUBLIC_URL=https://botmux.example.com',
    'BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH=/var/lib/botmux/audit.ndjson',
    'BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS=300000',
    'BOTMUX_GLOBAL_CONFIG_FILE=/mnt/shared/global-config.json',
    'BOTMUX_GROUP_CONTEXT_SETTINGS_FILE=/mnt/shared/group-context-settings.json',
    'BOTMUX_DASHBOARD_FEISHU_H5_ENABLED=true',
    'BOTMUX_DASHBOARD_FEISHU_H5_APP_ID=cli_h5app',
    'BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET=h5-app-secret',
    'LARK_APP_ID=cli_legacy',
    'LARK_APP_SECRET=legacy-bot-secret',
    'GITHUB_TOKEN=ghp_leaked',
    'GH_TOKEN=gho_leaked',
    'BOTMUX_WORKTREE_SLUG_AI_API_KEY=sk-worktree',
    'MIDSCENE_MODEL_API_KEY=sk-midscene',
    'ANTHROPIC_API_KEY=sk-ant-operator',
    'OPENAI_API_KEY=sk-openai-operator',
    'PROD_DB_PASSWORD=hunter2',
    'AWS_SECRET_ACCESS_KEY=aws-secret',
  ].join('\n');

  it('keeps the dashboard settings and the H5 login family', () => {
    const env: NodeJS.ProcessEnv = {};
    loadDashboardEnvFile(envFile(FULL_ENV), env);
    expect(env.BOTMUX_DASHBOARD_PORT).toBe('7999');
    expect(env.BOTMUX_DASHBOARD_HOST).toBe('127.0.0.1');
    expect(env.BOTMUX_DASHBOARD_EXTERNAL_HOST).toBe('dash.example.com');
    expect(env.BOTMUX_PUBLIC_URL).toBe('https://botmux.example.com');
    expect(env.BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH).toBe('/var/lib/botmux/audit.ndjson');
    expect(env.BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS).toBe('300000');
    expect(env.BOTMUX_GLOBAL_CONFIG_FILE).toBe('/mnt/shared/global-config.json');
    expect(env.BOTMUX_GROUP_CONTEXT_SETTINGS_FILE).toBe('/mnt/shared/group-context-settings.json');
    // The dashboard IS the H5 family's only legitimate consumer — this entry
    // point exists to deliver it (resolveDashboardH5AuthConfig reads it).
    expect(env.BOTMUX_DASHBOARD_FEISHU_H5_ENABLED).toBe('true');
    expect(env.BOTMUX_DASHBOARD_FEISHU_H5_APP_ID).toBe('cli_h5app');
    expect(env.BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET).toBe('h5-app-secret');
  });

  it('leaves every non-consumed secret in the file — absent, not empty', () => {
    const env: NodeJS.ProcessEnv = {};
    loadDashboardEnvFile(envFile(FULL_ENV), env);
    for (const key of [
      'LARK_APP_ID', 'LARK_APP_SECRET', 'GITHUB_TOKEN', 'GH_TOKEN',
      'BOTMUX_WORKTREE_SLUG_AI_API_KEY', 'MIDSCENE_MODEL_API_KEY',
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PROD_DB_PASSWORD',
      'AWS_SECRET_ACCESS_KEY',
    ]) {
      expect(key in env, `${key} must never enter the dashboard process`).toBe(false);
    }
    // No secret VALUE reached the process under any name either.
    const values = Object.values(env);
    for (const secret of ['legacy-bot-secret', 'ghp_leaked', 'sk-worktree', 'hunter2', 'aws-secret']) {
      expect(values).not.toContain(secret);
    }
  });

  it('admits nothing beyond the allowlist, whatever the file contains', () => {
    const env: NodeJS.ProcessEnv = {};
    loadDashboardEnvFile(envFile(FULL_ENV), env);
    for (const key of Object.keys(env)) {
      expect(isDashboardEnvKey(key), `${key} entered process.env without a dashboard consumer`).toBe(true);
    }
  });

  it('sweeps the whole H5 prefix, so a knob added later works the day it ships', () => {
    const env: NodeJS.ProcessEnv = {};
    loadDashboardEnvFile(envFile('BOTMUX_DASHBOARD_FEISHU_H5_FUTURE_KNOB=on'), env);
    expect(env.BOTMUX_DASHBOARD_FEISHU_H5_FUTURE_KNOB).toBe('on');
  });

  it('never overrides a value already set (resolved fleet snapshot stays authoritative)', () => {
    // resolveDaemonEnv pins DAEMON_ENV_KEYS into the shared fleet env precisely
    // so a restart from inside a bot session is deterministic; the file must
    // not win over it — the historical dotenv semantics.
    const env: NodeJS.ProcessEnv = { BOTMUX_DASHBOARD_PORT: '7891' };
    loadDashboardEnvFile(envFile('BOTMUX_DASHBOARD_PORT=7999\nBOTMUX_DASHBOARD_HOST=10.0.0.1'), env);
    expect(env.BOTMUX_DASHBOARD_PORT).toBe('7891');
    expect(env.BOTMUX_DASHBOARD_HOST).toBe('10.0.0.1');
  });

  it('does not delete an inherited variable just because the file mentions it', () => {
    // The belt-and-braces sweep only removes keys that APPEARED during the
    // load. Dropping an inherited PATH/HOME because .env also sets it would be
    // far worse than the leak it guards against.
    const env: NodeJS.ProcessEnv = { PATH: '/inherited/bin', HOME: '/home/op' };
    loadDashboardEnvFile(envFile('PATH=/from/env/file\nLARK_APP_SECRET=nope'), env);
    expect(env.PATH).toBe('/inherited/bin');
    expect(env.HOME).toBe('/home/op');
    expect('LARK_APP_SECRET' in env).toBe(false);
  });

  it('is a no-op on a missing .env file', () => {
    const env: NodeJS.ProcessEnv = { BOTMUX_DASHBOARD_PORT: '7891' };
    loadDashboardEnvFile(join(tmpdir(), 'botmux-does-not-exist-.env'), env);
    expect(env).toEqual({ BOTMUX_DASHBOARD_PORT: '7891' });
  });

  it('covers every key baked into the shared PM2 env block (drift guard)', () => {
    // DAEMON_ENV_KEYS is the operator-facing settings contract for both managed
    // cores. A key baked there but missing here would be silently ignored by a
    // dashboard started outside pm2 (foreground `dist/index-dashboard.js`).
    for (const key of DAEMON_ENV_KEYS) {
      expect(isDashboardEnvKey(key), `${key} is baked for the dashboard but not loadable`).toBe(true);
    }
    expect(DASHBOARD_ENV_ALLOWLIST).toEqual(expect.arrayContaining([...DAEMON_ENV_KEYS]));
  });

  it('covers every H5 var the dashboard actually reads (drift guard)', () => {
    for (const key of DASHBOARD_H5_ENV_KEYS) {
      expect(isDashboardEnvKey(key), `${key} would never reach resolveDashboardH5AuthConfig`).toBe(true);
    }
  });
});
