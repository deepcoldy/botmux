import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

it.each([{ envUnset: ['TOKEN'] }, { codexAuthSync: 'isolated' }])(
  'a real worker refuses Orca policies its runtime cannot enforce: %j', async policy => {
    const root = mkdtempSync(join(tmpdir(), 'orca-policy-'));
    const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      env: { ...process.env, BOTMUX_HOME: root, SESSION_DATA_DIR: root, BOTMUX_NO_CLAIM: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const messages: any[] = [];
    let output = '';
    child.stdout?.on('data', b => output += b);
    child.stderr?.on('data', b => output += b);
    child.on('message', m => messages.push(m));
    const exit = new Promise(resolve => child.once('exit', resolve));
    try {
      child.send!({ type: 'init', sessionId: 'policy-test', chatId: 'oc_test', rootMessageId: 'om_test',
        workingDir: root, cliId: 'orca-codex', backendType: 'remote-runner', prompt: '', ...policy });
      await expect.poll(() => messages.some(m => m.type === 'error'), { timeout: 20_000 }).toBe(true);
      expect(JSON.stringify(messages) + output).toContain('Orca-managed Agents use Orca accounts');
      expect(messages.some(m => m.type === 'ready')).toBe(false);
    } finally {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exit; clearTimeout(timer); rmSync(root, { recursive: true, force: true });
    }
  }, 30_000,
);
