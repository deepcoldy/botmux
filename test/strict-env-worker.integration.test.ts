import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMissingAskEnv } from '../src/core/ask-args.js';
import { inheritBotEnv } from '../src/core/env-policy.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional native tool */ }
const cases = ['codex', 'claude-code'].flatMap(cliId => ['thread', 'chat'].map(scope => ({ cliId, scope, restore: false })));
if (realTmux) cases.push({ cliId: 'claude-code', scope: 'chat', restore: true });
describe('strict worker IPC to real CLI child', () => {
  it.each(cases)('$cliId enforces $scope policy and identity (unstamped tmux restore=$restore)', async ({ cliId, scope, restore }) => {
    const sessionId = randomUUID();
    const tmuxSession = `bmx-${sessionId.slice(0, 8)}`;
    const dir = mkdtempSync(join(restore ? '/tmp' : tmpdir(), 'worker-env-probe-'));
    if (process.env.BOTMUX_TEST_FONT_DIR) {
      mkdirSync(join(dir, '.botmux'), { recursive: true });
      cpSync(process.env.BOTMUX_TEST_FONT_DIR, join(dir, '.botmux', 'fonts'), { recursive: true });
    }
    const socket = join(dir, 'socket'); let oldPid: number | undefined;
    const script = join(dir, 'fake-cli'); const report = join(dir, 'report');
    const bots = join(dir, 'bots.json');
    const codexHome = join(dir, 'bots/app_probe/codex');
    if (cliId === 'codex') {
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'own-file-auth' }), { mode: 0o600 });
    }
    const source = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(cliId === 'codex' ? 'codex-cli 0.136.0' : '2.1.0 (Claude Code)')}); process.exit(); }
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
 unknownAbsent: !('UNLISTED_CLOUD_CREDENTIAL' in process.env) && !('HOUSEHOLD_API_CREDENTIAL' in process.env) && !('FINANCE_SERVICE_SECRET' in process.env),
 runtimeContext: process.env.BOTS_CONFIG === ${JSON.stringify(bots)} && process.env.BOTMUX_CHAT_ID === 'virtual_probe',
 sessionScope: process.env.BOTMUX_SESSION_SCOPE === ${JSON.stringify(scope)},
 topicRoot: process.env.BOTMUX_ROOT_MESSAGE_ID === ${JSON.stringify(scope === 'thread' ? 'om_probe' : 'oc_probe')},
 askEnv: Object.fromEntries(['BOTMUX_SESSION_ID', 'BOTMUX_CHAT_ID', 'BOTMUX_LARK_APP_ID', 'BOTMUX_ROOT_MESSAGE_ID'].map(key => [key, process.env[key]])),
 modelKeyPresent: process.env.OPENAI_API_KEY === 'own-model-auth',
 workingDir: process.cwd() === fs.realpathSync(${JSON.stringify(dir)}),
 codexHome: ${JSON.stringify(cliId)} !== 'codex' || (fs.realpathSync(process.env.CODEX_HOME) === fs.realpathSync(${JSON.stringify(codexHome)}) && JSON.parse(fs.readFileSync(process.env.CODEX_HOME + '/auth.json')).OPENAI_API_KEY === 'own-file-auth'),
 authPresent: process.env.MODEL_AUTH === 'bot-sentinel',
 proxyPresent: process.env.HTTPS_PROXY === 'proxy-sentinel',
 owner: process.env.BOTMUX_OWNER_OPEN_ID === 'ou_owner' && process.env.__OWNER_OPEN_ID === 'ou_owner',
 daemonAbsent: !('LARK_APP_SECRET' in process.env),
 siblingAbsent: !('SIBLING_AUTH' in process.env)
}));
console.log('Ready >'); setTimeout(() => {}, 30000);
`;
    writeFileSync(script, source, { mode: 0o700 });
    writeFileSync(bots, JSON.stringify([{ larkAppId: 'app_probe', larkAppSecret: '', apiOnly: true, cliId }]));
    const env = { ...inheritBotEnv(process.env, { mode: 'strict' }), HOME: dir, SESSION_DATA_DIR: join(dir, 'data'),
      BOTS_CONFIG: bots, BOTMUX_NO_CLAIM: '1', HOUSEHOLD_API_CREDENTIAL: 'household-sentinel', FINANCE_SERVICE_SECRET: 'finance-sentinel', UNLISTED_CLOUD_CREDENTIAL: 'host-sentinel', SIBLING_AUTH: 'sibling-sentinel', HTTPS_PROXY: 'proxy-sentinel' };
    if (restore) {
      const bin = join(dir, 'bin'); mkdirSync(bin);
      writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -S '${socket}' "$@"\n`, { mode: 0o700 });
      env.PATH = `${bin}:${env.PATH}`;
      execFileSync(realTmux!, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', tmuxSession, '/bin/sleep', '60'], { env, stdio: 'ignore' });
      oldPid = Number(execFileSync(realTmux!, ['-S', socket, 'display-message', '-p', '-t', tmuxSession, '#{pane_pid}'], { encoding: 'utf8' }));
    }
    const worker = spawnNodeTsScript('src/worker.ts', [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let diagnostics = '';
    worker.stdout?.on('data', data => diagnostics += String(data));
    worker.stderr?.on('data', data => diagnostics += String(data));
    try {
      worker.send({ type: 'init', sessionId, chatId: 'virtual_probe', rootMessageId: scope === 'thread' ? 'om_probe' : 'oc_probe',
        workingDir: dir, cliId, cliPathOverride: script, backendType: restore ? 'tmux' : 'pty', prompt: '',
        apiOnly: true, larkAppId: 'app_probe', larkAppSecret: '', ownerOpenId: 'ou_owner',
        envPolicy: { mode: 'strict', inherit: ['HTTPS_PROXY'] }, env: { MODEL_AUTH: 'bot-sentinel', OPENAI_API_KEY: 'own-model-auth' },
        ...(cliId === 'codex' ? { codexAuthSync: 'isolated' } : {}),
        loadedBotsConfigPath: bots, loadedBotsConfigProvenance: 'loaded', promptInjection: 'none' });
      await vi.waitFor(() => expect(existsSync(report), diagnostics).toBe(true), { timeout: 20000 });
      const { askEnv, ...checks } = JSON.parse(readFileSync(report, 'utf8'));
      expect(findMissingAskEnv(askEnv)).toBeNull();
      for (const [key, ok] of Object.entries(checks)) expect(ok, `${key}\n${diagnostics}`).toBe(true);
      if (restore) {
        expect(() => process.kill(oldPid!, 0)).toThrow();
        await vi.waitFor(() => expect(existsSync(join(dir, `data/sessions/${sessionId}.env-policy`))).toBe(true));
      }
    } finally {
      const exited = once(worker, 'exit');
      if (worker.connected) worker.send({ type: 'close' });
      const killTimeout = setTimeout(() => worker.kill('SIGKILL'), 5000);
      try { if (worker.exitCode === null && worker.signalCode === null) await exited; }
      finally { clearTimeout(killTimeout); }
      if (restore) { try { execFileSync(realTmux!, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
