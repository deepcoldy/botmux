/**
 * Session-env removals reach the CLI on every local backend: the worker drops
 * them from the child env, and the shell-wrapped backends (tmux / zellij / zmx)
 * also `env -u` them at the pane's last exec — after the terminal server's
 * global env and the login shell's startup file have had their say.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBotmuxEnvAssignments, shellCommandArgv, shellWrapperScript } from '../src/adapters/backend/tmux-backend.js';
import { ptyChildEnv } from '../src/adapters/backend/pty-backend.js';
import { strictPaneEnvArgs } from '../src/adapters/backend/strict-env.js';
import type { SpawnOpts } from '../src/adapters/backend/types.js';
import { buildSessionChildEnv } from '../src/core/env-policy.js';
import { envLayerArgvBytes, MAX_SESSION_ENV_LAYER_BYTES } from '../src/core/session-env.js';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function parseEnvDump(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe('buildBotmuxEnvAssignments', () => {
  it('emits -u flags before every KEY=VAL operand, filtered by the lock rule', () => {
    const argv = buildBotmuxEnvAssignments(
      { BOTMUX_SESSION_ID: 's1', HTTPS_PROXY: 'http://p' },
      { ANTHROPIC_BASE_URL: 'https://x' },
      ['LEAKED', 'PATH', 'BOTMUX_CHAT_ID', 'OTHER'],
    );
    expect(argv.slice(0, 4)).toEqual(['-u', 'LEAKED', '-u', 'OTHER']);
    expect(argv.slice(4).every(a => /^[A-Za-z_][A-Za-z0-9_]*=/.test(a))).toBe(true);
    expect(argv).toContain('BOTMUX_SESSION_ID=s1');
    expect(argv).toContain('ANTHROPIC_BASE_URL=https://x');
  });

  it('is byte-identical to the legacy argv when nothing is removed', () => {
    const env = { BOTMUX_SESSION_ID: 's1', HTTPS_PROXY: 'http://p', TMPDIR: '/t' };
    const inject = { ANTHROPIC_AUTH_TOKEN: 'tok' };
    expect(buildBotmuxEnvAssignments(env, inject, undefined)).toEqual(buildBotmuxEnvAssignments(env, inject));
    expect(buildBotmuxEnvAssignments(env, inject, [])).toEqual(buildBotmuxEnvAssignments(env, inject));
  });
});

describe('pane wrapper (real /usr/bin/env)', () => {
  it.skipIf(process.platform === 'win32')('removes a variable the pane shell already carries, keeps the rest', () => {
    const cwd = tempDir('se-wrap-');
    const script = shellWrapperScript(join(cwd, 'bin'), 'sh');
    const argv = [cwd, ...buildBotmuxEnvAssignments({}, { SET_BY_BOT: 'v' }, ['LEAKED_TOKEN']), '/usr/bin/env'];
    const out = execFileSync('/bin/sh', ['-c', script, '_', ...argv], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, LEAKED_TOKEN: 'from-terminal-server', CONTROL_VAR: 'kept' },
    });
    const env = parseEnvDump(out);
    expect(env.LEAKED_TOKEN).toBeUndefined();
    expect(env.CONTROL_VAR).toBe('kept');
    expect(env.SET_BY_BOT).toBe('v');
  });
});

const hasTmux = process.platform === 'linux' && spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const hasBash = existsSync('/bin/bash');

describe('real tmux pane', () => {
  it.skipIf(!hasTmux || !hasBash)('server global env and the shell startup file cannot re-add a removed variable', async () => {
    const work = tempDir('se-tmux-');
    const rcfile = join(work, 'rc.sh');
    const dump = join(work, 'env.out');
    writeFileSync(rcfile, 'export RC_TOKEN=from-rcfile\nexport RC_CONTROL=ran\n');
    // The first client freezes the server's global env — exactly how a shared
    // server ends up carrying whatever its starter had.
    execFileSync('tmux', ['new-session', '-d', '-s', 'seed', 'sleep', '30'], {
      env: { ...process.env, LEAKED_TOKEN: 'from-server', CONTROL_VAR: 'server-ok', BASH_ENV: rcfile },
    });
    try {
      const argv = shellCommandArgv(
        { shell: '/bin/bash', flags: [] },
        shellWrapperScript(join(work, 'bin'), 'sh'),
        [work, ...buildBotmuxEnvAssignments({}, { SET_BY_BOT: 'v' }, ['LEAKED_TOKEN', 'RC_TOKEN']), '/bin/sh', '-c', `env > ${dump}`],
      );
      execFileSync('tmux', ['new-session', '-d', '-s', 'pane', '--', ...argv]);
      const deadline = Date.now() + 10_000;
      while (!existsSync(dump) || !readFileSync(dump, 'utf8').includes('SET_BY_BOT')) {
        if (Date.now() > deadline) throw new Error('pane never wrote its env');
        await new Promise(r => setTimeout(r, 50));
      }
      const env = parseEnvDump(readFileSync(dump, 'utf8'));
      // Preconditions: the server env and the startup file really reached the pane.
      expect(env.CONTROL_VAR).toBe('server-ok');
      expect(env.RC_CONTROL).toBe('ran');
      expect(env.SET_BY_BOT).toBe('v');
      expect(env.LEAKED_TOKEN).toBeUndefined();
      expect(env.RC_TOKEN).toBeUndefined();
    } finally {
      // Sessions only (the fence keeps this server private anyway): the server
      // exits by itself once its last session is gone.
      for (const name of ['pane', 'seed']) spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
    }
  });
});

describe('pane argv budget', () => {
  /** A layer filled right up to the budget with set values. */
  function fullLayer(prefix: string): Record<string, string> {
    const set: Record<string, string> = {};
    for (let i = 0; ; i++) {
      const next = { ...set, [`${prefix}_${i}`]: 'v'.repeat(500) };
      if (envLayerArgvBytes({ set: next, unset: [] }) > MAX_SESSION_ENV_LAYER_BYTES) return set;
      Object.assign(set, next);
    }
  }

  it.skipIf(!hasTmux || !hasBash)('two full layers plus a typical managed pane command still fit one tmux command', () => {
    const work = tempDir('se-budget-');
    const inject = { ...fullLayer('GLOBAL'), ...fullLayer('BOT') };
    // The wrapper script is built for real below (~2.6 KiB). Stand-in for the
    // rest of a managed pane command — botmux's own per-session values and the
    // CLI argv — which on a live fleet adds up to < 4 KiB (pane start commands
    // measured ≤ 6.5 KiB in total).
    const restOfCommand = 'z'.repeat(4 * 1024);
    const argv = shellCommandArgv(
      { shell: '/bin/bash', flags: [] },
      shellWrapperScript(join(work, 'bin'), 'sh'),
      [work, ...buildBotmuxEnvAssignments({}, inject, []), '/bin/sh', '-c', 'exit 0', '_', restOfCommand],
    );
    try {
      execFileSync('tmux', ['new-session', '-d', '-s', 'budget', '--', ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    } finally {
      spawnSync('tmux', ['kill-session', '-t', 'budget'], { stdio: 'ignore' });
    }
  });
});

describe('local child env', () => {
  const opts = (extra: Partial<SpawnOpts>): SpawnOpts => ({
    cwd: '/', cols: 80, rows: 24, env: { KEEP: '1', LEAKED: 'x', PATH: '/bin' }, ...extra,
  });

  it('pty: removals first, then the configured values', () => {
    expect(ptyChildEnv(opts({ unsetEnv: ['LEAKED', 'PATH'], injectEnv: { NEW: 'n' } }))).toEqual({ KEEP: '1', PATH: '/bin', NEW: 'n' });
    // untouched configs keep the very same object (legacy path)
    const o = opts({});
    expect(ptyChildEnv(o)).toBe(o.env);
  });

  it('strict panes drop removed variables from their explicit list', () => {
    const argv = strictPaneEnvArgs(opts({ unsetEnv: ['LEAKED'] }));
    expect(argv[0]).toBe('-i');
    expect(argv).not.toContain('LEAKED=x');
    expect(argv).toContain('KEEP=1');
  });

  it('the worker boundary removes inherited variables but never botmux-owned ones', () => {
    const env = buildSessionChildEnv({ LEAKED: 'x', KEEP: '1', PATH: '/bin', SESSION_DATA_DIR: '/d' }, undefined, ['LEAKED', 'PATH', 'SESSION_DATA_DIR']);
    expect(env).toEqual({ KEEP: '1', PATH: '/bin', SESSION_DATA_DIR: '/d' });
  });
});
