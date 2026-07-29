import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function freshStore() {
  vi.resetModules();
  return import('../src/services/chat-startup-commands-store.js');
}

describe('chat startup commands store', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-chat-startup-'));
    process.env.SESSION_DATA_DIR = dataDir;
  });

  afterEach(() => {
    delete process.env.SESSION_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists normalized commands independently per bot and chat', async () => {
    const store = await freshStore();

    expect(store.getChatStartupCommands('app_a', 'oc_1')).toEqual([]);
    expect(store.setChatStartupCommands('app_a', 'oc_1', [
      'effort max',
      '/effort max',
      '',
      42,
    ])).toEqual(['/effort max']);

    expect(store.getChatStartupCommands('app_a', 'oc_1')).toEqual(['/effort max']);
    expect(store.getChatStartupCommands('app_a', 'oc_2')).toEqual([]);
    expect(store.getChatStartupCommands('app_b', 'oc_1')).toEqual([]);

    store.setChatStartupCommands('app_b', 'oc_1', ['/model opus']);
    expect(store.getChatStartupCommands('app_b', 'oc_1')).toEqual(['/model opus']);

    const fp = join(dataDir, 'chat-startup-commands.json');
    expect(JSON.parse(readFileSync(fp, 'utf-8'))).toEqual({
      byBot: {
        app_a: { oc_1: ['/effort max'] },
        app_b: { oc_1: ['/model opus'] },
      },
    });
    expect(statSync(fp).mode & 0o777).toBe(0o600);
  });

  it('appends chat commands after bot defaults so the chat override wins', async () => {
    const store = await freshStore();
    store.setChatStartupCommands('app_a', 'oc_1', ['/effort max', '/model opus']);

    expect(store.resolveStartupCommands(
      'app_a',
      'oc_1',
      ['/effort high', '/model opus'],
    )).toEqual(['/effort high', '/model opus', '/effort max']);
    expect(store.resolveStartupCommands('app_a', 'oc_2', undefined)).toBeUndefined();
  });

  it('clears one chat without affecting sibling entries', async () => {
    const store = await freshStore();
    store.setChatStartupCommands('app_a', 'oc_1', ['/effort max']);
    store.setChatStartupCommands('app_a', 'oc_2', ['/effort low']);

    store.setChatStartupCommands('app_a', 'oc_1', []);

    expect(store.getChatStartupCommands('app_a', 'oc_1')).toEqual([]);
    expect(store.getChatStartupCommands('app_a', 'oc_2')).toEqual(['/effort low']);
  });
});
