import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { t } from '../src/i18n/index.js';

const WORKER_RESULT_WAIT_MS = 60_000;

// A real worker hands BotConfig.hideLocalAddresses (frozen into init by the
// daemon) to the adapter that builds the Botmux system prompt, and freezes the
// same value into the CLI env for a `botmux send` that cannot read bots.json.
it.each([true, undefined])('a real worker carries hideLocalAddresses=%s into the system prompt and the CLI env', async hideLocalAddresses => {
  const root = mkdtempSync(join(tmpdir(), 'worker-local-address-'));
  const dataDir = join(root, 'data'); mkdirSync(dataDir);
  const output = join(root, 'prompt-result.json');
  const fakeCli = join(root, 'fake-pi');
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({prompt:process.env.BOTMUX_APPEND_SYSTEM_PROMPT,snapshot:process.env.BOTMUX_HIDE_LOCAL_ADDRESSES}));
process.stdout.write('Ready\\n');
setInterval(()=>{},1000);
`, { mode: 0o755 });
  const env = { ...process.env, HOME: root, USERPROFILE: root, BOTMUX_HOME: join(root, '.botmux'),
    SESSION_DATA_DIR: dataDir, PATH: process.env.PATH, BOTMUX_NO_CLAIM: '1' };
  delete (env as Record<string, string | undefined>).BOTMUX_HIDE_LOCAL_ADDRESSES;
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], { env, cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; child.stdout?.on('data', b => logs += b); child.stderr?.on('data', b => logs += b);
  const exit = new Promise(resolveExit => child.once('exit', resolveExit));
  try {
    child.send!({ type: 'init', sessionId: randomUUID(), chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: dataDir, cliId: 'pi', cliPathOverride: fakeCli, backendType: 'pty', prompt: '',
      larkAppId: 'cli_current_app', larkAppSecret: 'test-only-secret', locale: 'zh',
      ...(hideLocalAddresses ? { hideLocalAddresses } : {}) });
    const deadline = Date.now() + WORKER_RESULT_WAIT_MS;
    while (!existsSync(output) && child.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    expect(existsSync(output), logs).toBe(true);
    const { prompt, snapshot } = JSON.parse(readFileSync(output, 'utf8'));
    expect(prompt).toContain('<botmux_routing>');
    const rule = t('ai.routing.no_local_addresses', undefined, 'zh');
    if (hideLocalAddresses) expect(prompt).toContain(rule); else expect(prompt).not.toContain(rule);
    expect(snapshot).toBe(hideLocalAddresses ? '1' : '0');
  } finally {
    if (child.connected) child.send!({ type: 'close' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit; clearTimeout(timer); rmSync(root, { recursive: true, force: true });
  }
}, WORKER_RESULT_WAIT_MS + 15_000);
