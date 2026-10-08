import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBotWorkerEnv, buildSessionChildEnv, botInjectedEnv } from '../src/core/env-policy.js';
import { strictPaneCommand, strictPaneEnvArgs } from '../src/adapters/backend/strict-env.js';
import { buildLayoutString } from '../src/adapters/backend/zellij-backend.js';
import { buildZmxLaunchFiles } from '../src/adapters/backend/zmx-backend.js';
import { type SpawnOpts } from '../src/adapters/backend/types.js';
import { nodeTsRunnerPrefix, spawnTsEval, spawnNodeTsScript } from './helpers/ts-runner.js';

// Native PTY and the fake CLI are Node fixtures even under the Bun runner.
// See nodeTsRunnerPrefix: Bun-native PTY fixtures otherwise exit with SIGHUP.
const runner = nodeTsRunnerPrefix();
const policy = { mode: 'strict' as const, inherit: ['GRANTED_TOOLCHAIN'] };
const probeSource = `const fs = require('node:fs'); const e = process.env;
fs.writeFileSync(process.argv[2], JSON.stringify({
  unknownAbsent: !('UNLISTED_CLOUD_CREDENTIAL' in e), siblingAbsent: !('SIBLING_AUTH' in e),
  profileAbsent: !('PROFILE_CREDENTIAL' in e), loaderAbsent: !('BASH_ENV' in e),
  auth: e.OPENAI_API_KEY === 'bot-sentinel', granted: e.GRANTED_TOOLCHAIN === 'tool-sentinel',
  home: e.CODEX_HOME === '/test/bot/codex', owner: e.BOTMUX_OWNER_OPEN_ID === 'ou_owner',
  daemonAbsent: !('LARK_APP_SECRET' in e), ghAbsent: !('GITHUB_TOKEN' in e)
})); setTimeout(() => {}, 10000);`;
function optsFor(dir: string): SpawnOpts {
  const base = buildBotWorkerEnv({ PATH: process.env.PATH, HOME: dir, SHELL: '/bin/zsh',
    UNLISTED_CLOUD_CREDENTIAL: 'host-sentinel', SIBLING_AUTH: 'sibling-sentinel',
    GRANTED_TOOLCHAIN: 'tool-sentinel', BASH_ENV: join(dir, 'poison.sh'), LARK_APP_SECRET: 'im-sentinel' }, policy);
  const env = buildSessionChildEnv(base, policy) as Record<string, string>;
  env.CODEX_HOME = '/test/bot/codex'; env.BOTMUX_OWNER_OPEN_ID = 'ou_owner';
  return { cwd: dir, cols: 80, rows: 24, env, injectEnv: botInjectedEnv({ OPENAI_API_KEY: 'bot-sentinel' }, policy), strictEnv: true };
}
async function report(path: string): Promise<Record<string, boolean>> {
  await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 10000 });
  const result = JSON.parse(readFileSync(path, 'utf8')) as Record<string, boolean>;
  for (const [key, ok] of Object.entries(result)) expect(ok, key).toBe(true);
  return result;
}
function prepare() {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-strict-probe-'));
  const script = join(dir, 'probe.cjs');
  writeFileSync(script, probeSource);
  writeFileSync(join(dir, '.zshrc'), 'export PROFILE_CREDENTIAL=profile-sentinel\n');
  writeFileSync(join(dir, 'poison.sh'), 'export PROFILE_CREDENTIAL=loader-sentinel\n');
  return { dir, script };
}

function launchBackend(kind: string, script: string, dir: string, opts: SpawnOpts, session = 'bmx-strict-probe') {
  const options = join(dir, 'options.json');
  writeFileSync(options, JSON.stringify(opts), { mode: 0o600 });
  return spawnNodeTsScript('test/fixtures/strict-env-backend-probe.ts',
    [kind, runner.command, script, join(dir, 'report'), options, session], { env: opts.env, stdio: 'ignore' });
}
async function stopBackend(child: ReturnType<typeof spawnNodeTsScript>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
describe('strict environment real process probes', () => {
  it.each([false, true])('provider keys remain only without instance binding (bound=%s)', bound => {
    const opts = optsFor('/tmp');
    const provider = { OPENAI_API_KEY: 'inherited-key', CODEX_API_KEY: 'inherited-codex', OPENAI_BASE_URL: 'https://provider.invalid' };
    Object.assign(opts.env, provider, bound ? { BOTMUX_CODEX_INSTANCE_BINDING: 'binding' } : {});
    opts.injectEnv = { ...provider, OPENAI_API_KEY: 'bot-key', MODEL_AUTH: 'other-model' };
    const assignments = strictPaneEnvArgs(opts).slice(1);
    for (const key of Object.keys(provider)) expect(assignments.some(value => value.startsWith(`${key}=`)), key).toBe(!bound);
    expect(assignments).toContain('MODEL_AUTH=other-model');
    if (bound) expect(assignments).toContain('BOTMUX_CODEX_INSTANCE_BINDING=binding');
    else expect(assignments).toContain('OPENAI_API_KEY=bot-key');
  });
  it('supplies a terminal for v3 panes without ambient TERM and preserves explicit TERM', () => {
    const opts = optsFor('/tmp');
    expect(strictPaneEnvArgs(opts)).toContain('TERM=xterm-256color');
    opts.env.TERM = 'tmux-256color';
    expect(strictPaneEnvArgs(opts)).toContain('TERM=tmux-256color');
  });
  it('PTY child receives only approved bot runtime/auth and trusted identity', async () => {
    const { dir, script } = prepare(); let child: ReturnType<typeof spawnNodeTsScript> | undefined;
    try {
      child = launchBackend('pty', script, dir, optsFor(dir));
      await report(join(dir, 'report'));
    } finally { if (child) await stopBackend(child); rmSync(dir, { recursive: true, force: true }); }
  });
  it('the zellij layout executes the same empty-environment argv without a profile shell', async () => {
    const { dir, script } = prepare(); let child: ReturnType<typeof spawnTsEval> | undefined;
    try {
      const opts = optsFor(dir);
      const command = strictPaneCommand(runner.command, [script, join(dir, 'report')], opts);
      const layout = buildLayoutString(runner.command, [script, join(dir, 'report')], opts);
      expect(layout.includes('command="/usr/bin/env"')).toBe(true);
      expect(layout.includes('"-i"')).toBe(true);
      expect(layout.includes('shellWrapperScript')).toBe(false);
      // Use the runtime-aware helper to launch the actual pane command; the
      // layout is checked separately because zellij is not required for units.
      child = spawnTsEval(`import { spawn } from 'node:child_process'; const [bin, ...args] = ${JSON.stringify(command)}; const p = spawn(bin, args, { stdio: 'ignore' }); process.on('SIGTERM', () => { p.kill(); process.exit(); });`, { env: { ...process.env, UNLISTED_CLOUD_CREDENTIAL: 'server-sentinel' } });
      await report(join(dir, 'report'));
    } finally { child?.kill(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('the zmx private launch payload resets server env and uses a fixed non-profile shell', async () => {
    const { dir, script } = prepare(); let child: ReturnType<typeof spawnTsEval> | undefined;
    const launch = join(dir, 'launch'); mkdirSync(launch);
    const bootstrap = join(launch, 'bootstrap'); const payload = join(launch, 'payload');
    const ready = join(launch, 'ready'); const release = join(launch, 'release');
    try {
      const files = buildZmxLaunchFiles(runner.command, [script, join(dir, 'report')], optsFor(dir), payload, ready, 'nonce', release, 'release-token');
      expect(files.bootstrap.includes('/bin/zsh')).toBe(false);
      expect(files.payload.includes("'-i'")).toBe(true);
      writeFileSync(bootstrap, files.bootstrap, { mode: 0o700 });
      writeFileSync(payload, files.payload, { mode: 0o600 });
      writeFileSync(release, 'release-token');
      child = spawnTsEval(`import { spawn } from 'node:child_process'; const p = spawn('/bin/sh', [${JSON.stringify(bootstrap)}], { stdio: 'ignore' }); process.on('SIGTERM', () => { p.once('exit', () => process.exit()); p.kill(); setTimeout(() => process.exit(), 2000); });`, { env: { ...process.env, HOME: dir, BASH_ENV: join(dir, 'poison.sh'), UNLISTED_CLOUD_CREDENTIAL: 'server-sentinel' } });
      await report(join(dir, 'report'));
    } finally {
      child?.kill();
      if (child?.exitCode === null) await new Promise(resolve => child!.once('exit', resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
  let realTmux: string | undefined;
  try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* optional native tool */ }
  it.skipIf(!realTmux).each(['tmux', 'tmux-pipe'] as const)('%s excludes poisoned shared-server env, skips profile and isolates explicit bot credentials', async kind => {
    const { dir, script } = prepare(); const socket = join(dir, 'socket'); const binDir = join(dir, 'bin');
    const session = 'bmx-strict-probe'; let child: ReturnType<typeof spawnNodeTsScript> | undefined;
    try {
      mkdirSync(binDir);
      // Every backend/control command is redirected to THIS isolated socket.
      writeFileSync(join(binDir, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -S '${socket}' "$@"\n`, { mode: 0o700 });
      const launchEnv = { PATH: process.env.PATH, HOME: dir, SHELL: '/bin/zsh', UNLISTED_CLOUD_CREDENTIAL: 'server-sentinel', SIBLING_AUTH: 'sibling-sentinel' };
      execFileSync(realTmux!, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'poison', '/bin/sleep', '60'], { env: launchEnv, stdio: 'ignore' });
      vi.stubEnv('PATH', `${binDir}:${process.env.PATH}`);
      const opts = optsFor(dir); opts.env.PATH = `${binDir}:${opts.env.PATH}`;
      opts.env.BOTMUX_WORKFLOW = 'v3';
      writeFileSync(script, probeSource.replace('unknownAbsent:', "terminalPresent: e.TERM === 'xterm-256color', workflowPresent: e.BOTMUX_WORKFLOW === 'v3', unknownAbsent:"));
      child = launchBackend(kind, script, dir, opts, session);
      await report(join(dir, 'report'));
      // Let tmux's delayed per-session setup finish while PATH still points
      // only at the isolated test socket.
      await new Promise(resolve => setTimeout(resolve, 600));
      // Provider/toolchain values must not have been written to shared globals.
      const globals = execFileSync(realTmux!, ['-S', socket, 'show-environment', '-g'], { encoding: 'utf8' });
      expect(globals.includes('OPENAI_API_KEY=')).toBe(false);
      expect(globals.includes('GRANTED_TOOLCHAIN=')).toBe(false);
      expect(globals.includes('UNLISTED_CLOUD_CREDENTIAL=')).toBe(true);
    } finally {
      if (child) await stopBackend(child);
      try { execFileSync(realTmux!, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already exited */ }
      vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
    }
  });
});
