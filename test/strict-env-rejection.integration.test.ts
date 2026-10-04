import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inheritBotEnv } from '../src/core/env-policy.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

const paths = [
  { name: 'adopt', config: { adoptMode: true, adoptTarget: 'external-pane' }, error: 'cannot control an adopted process' },
  { name: 'external App Server', config: { existingAppServerEndpoint: 'ws://127.0.0.1:1', cliSessionId: 'thread_probe' }, error: 'cannot control an adopted process' },
  { name: 'Forge', config: { cliLaunchMode: 'forge-traex' }, error: 'cannot control an adopted process' },
  ...['herdr', 'mojo', 'riff', 'remote-runner'].map(backendType => ({ name: backendType, config: { backendType }, error: 'currently supports pty, tmux, zellij and zmx' })),
];

describe('strict unsupported launches fail closed through real worker IPC', () => {
  it.each(paths)('refuses $name before launching or reporting ready', async ({ config, error }) => {
    const dir = mkdtempSync(join(tmpdir(), 'strict-refuse-'));
    const marker = join(dir, 'launched'); const bin = join(dir, 'bin'); mkdirSync(bin);
    // All possible local launchers are harmless sentinels; no real backend,
    // external server or model service is contacted by this test.
    const fake = `#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('codex-cli 0.136.0'); process.exit(); }\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched');\n`;
    for (const name of ['codex', 'herdr', 'mojo', 'riff', 'forge']) writeFileSync(join(bin, name), fake, { mode: 0o700 });
    const bots = join(dir, 'bots.json');
    writeFileSync(bots, JSON.stringify([{ larkAppId: 'app_probe', larkAppSecret: '', apiOnly: true, cliId: 'codex' }]));
    const worker = spawnNodeTsScript('src/worker.ts', [], {
      env: { ...inheritBotEnv(process.env, { mode: 'strict' }), PATH: `${bin}:${process.env.PATH}`, HOME: dir,
        SESSION_DATA_DIR: join(dir, 'data'), BOTS_CONFIG: bots, BOTMUX_NO_CLAIM: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const messages: Array<{ type?: string; message?: string }> = [];
    let diagnostics = '';
    worker.on('message', message => messages.push(message as typeof messages[number]));
    worker.stderr?.on('data', data => diagnostics += String(data));
    worker.stdout?.on('data', data => diagnostics += String(data));
    try {
      worker.send({ type: 'init', sessionId: '22222222-2222-4222-8222-222222222222', chatId: 'virtual_probe', rootMessageId: 'probe',
        workingDir: dir, cliId: 'codex', cliPathOverride: join(bin, 'codex'), backendType: 'pty', prompt: '',
        apiOnly: true, larkAppId: 'app_probe', larkAppSecret: '', ownerOpenId: 'ou_owner',
        loadedBotsConfigPath: bots, loadedBotsConfigProvenance: 'loaded', promptInjection: 'none',
        envPolicy: { mode: 'strict' }, ...config });
      await vi.waitFor(() => expect(messages.some(m => m.type === 'error'), diagnostics).toBe(true), { timeout: 20000 });
      expect(messages.find(m => m.type === 'error')?.message).toContain(`envPolicy strict ${error}`);
      await vi.waitFor(() => expect(worker.exitCode !== null || worker.signalCode !== null).toBe(true), { timeout: 5000 });
      expect(messages.some(m => m.type === 'ready' || m.type === 'prompt_ready')).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGKILL');
        await new Promise<void>(resolve => worker.once('exit', () => resolve()));
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
