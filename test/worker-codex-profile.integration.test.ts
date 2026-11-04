import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import type { DaemonToWorker } from '../src/types.js';

for (const [backendType, mode] of [['pty', 'valid'], ['tmux', 'valid'], ['pty', 'missing'], ['tmux', 'rpc'], ['pty', 'isolated'], ['pty', 'adopt']] as const) {
it.skipIf(backendType === 'tmux' && !probeTmuxFunctional().ok)(`validates real ${backendType} worker profile launch: ${mode}`, async () => {
  const dir = mkdtempSync(join('/tmp', 'worker-profile-'));
  const data = join(dir, 'data'); const home = join(dir, 'codex');
  mkdirSync(data); mkdirSync(home);
  const report = join(dir, 'launched.json'); const binary = join(dir, 'codex-fixture');
  writeFileSync(join(home, 'selected.config.toml'), 'model="profile-default"');
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.134.0'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--profile PROFILE'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({pid:process.pid, args:process.argv.slice(2), home:process.env.CODEX_HOME}));
process.stdout.write('› Ask Codex to do anything\\n  explicit-model · /tmp\\n');
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  if (backendType === 'tmux') execFileSync('tmux', ['new-session', '-d', '-s', 'fixture', 'sleep 60'], { env: privateTmuxEnv(dir) });
  if (mode === 'missing') rmSync(join(home, 'selected.config.toml'));
  const sessionId = randomUUID();
  const child = spawnTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'), env: privateTmuxEnv(dir, { SESSION_DATA_DIR: data, BOTMUX_SESSION_ID: sessionId, LARK_APP_ID: 'profile_test', LARK_APP_SECRET: 'test' }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  child.on('message', message => { logs += JSON.stringify(message); });
  child.stdout?.on('data', b => { logs += b.toString(); }); child.stderr?.on('data', b => { logs += b.toString(); });
  try {
    child.send!({ type: 'init', sessionId, chatId: 'oc_profile', rootMessageId: 'om_profile', workingDir: data,
      cliId: 'codex', cliRuntime: { id: 'fixture', displayName: 'Fixture', source: 'configured', executable: binary, update: { provider: 'none' } }, cliPathOverride: binary,
      codexProfile: 'selected', codexProfileHome: home, backendType, launchShell: '/bin/bash', codexRpcInput: mode === 'rpc',
      ...(mode === 'isolated' ? { codexAuthSync: 'isolated' as const } : {}),
      ...(mode === 'adopt' ? { adoptMode: true } : {}),
      model: 'explicit-model', prompt: '', larkAppId: 'profile_test', larkAppSecret: 'test', apiOnly: true,
    } satisfies DaemonToWorker);
    const deadline = Date.now() + 20000;
    while (!existsSync(report) && child.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    if (mode !== 'valid') {
      expect(existsSync(report)).toBe(false);
      expect(logs).toMatch(/not_found|unsupported_launch|not supported by the RPC|unsupported for adopted/);
      return;
    }
    if (backendType === 'tmux' && !existsSync(report)) {
      try { logs += execFileSync('tmux', ['capture-pane', '-p', '-t', `bmx-${sessionId.slice(0, 8)}`], { env: privateTmuxEnv(dir), encoding: 'utf8' }); } catch { /* logs still explain failure */ }
    }
    expect(existsSync(report), logs).toBe(true);
    const launch = JSON.parse(readFileSync(report, 'utf8'));
    expect(launch.home).toBe(home);
    expect(launch.args.slice(0, 2)).toEqual(['--profile', 'selected']);
    expect(launch.args).toContain('explicit-model');
  } finally {
    if (child.connected) child.send!({ type: 'close' }, () => {});
    await new Promise<void>(r => { if (child.exitCode !== null) return r(); const timer = setTimeout(() => { child.kill('SIGKILL'); r(); }, 3000); child.once('exit', () => { clearTimeout(timer); r(); }); });
    if (backendType === 'tmux') {
      try { execFileSync('tmux', ['kill-server'], { env: privateTmuxEnv(dir), stdio: 'ignore' }); } catch { /* stopped already */ }
    }
    if (existsSync(report)) {
      try { process.kill(JSON.parse(readFileSync(report, 'utf8')).pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

}
