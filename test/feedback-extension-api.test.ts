import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('../src/bot-registry.js', async original => ({
  ...await original<any>(), loadBotConfigs: () => [{ larkAppId: 'app', feedback: { enabled: true },
    feedbackPresentation: { default: { enabled: true, rounds: [1] }, rules: [] } }],
}));
import { authorizeFeedbackExtensionChange, handleFeedbackExtensionApi } from '../src/dashboard/feedback-extension-api.js';
import { readFeedbackExtensionConfig, saveFeedbackExtensionConfig } from '../src/services/feedback-extension-config.js';

async function call(dataDir: string, path: string, body: unknown) {
  const request = Readable.from([JSON.stringify(body)]) as any;
  request.method = 'POST';
  let status = 0;
  let result: any;
  await handleFeedbackExtensionApi(request, { writeHead: (code: number) => { status = code; },
    end: (value: string) => { result = JSON.parse(value); } } as any, new URL(`http://fixture/api/feedback/extensions/${path}`),
  { dataDir, hostAdmin: false, manager: true, csrf: true });
  return { status, result };
}

describe('feedback extension API permissions', () => {
  it('previews a bot-config presentation even when no extension override has been saved', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-api-'));
    try {
      const response = await call(directory, 'preview', { appId: 'app', round: 1 });
      expect(response.status).toBe(200);
      expect(response.result.presentation.matched).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('lets a manager bind an approved action without granting command registration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-api-'));
    try {
      const initial = await readFeedbackExtensionConfig(directory);
      const saved = await saveFeedbackExtensionConfig(directory, 0, { ...initial, hooks: [{
        id: 'hook', version: 1, protocolVersion: 1, hostId: initial.hostId, command: ['/bin/true'], cwd: '/tmp',
        allowedBotAppIds: ['app'], allowedChatIds: ['chat'], allowedActionIds: ['help'], timeoutMs: 1000,
        concurrency: 1, envRefs: {}, enabled: true,
      }] }, 'admin');
      const response = await call(directory, 'presentation', { appId: 'app', expectedVersion: saved.version,
        actions: [{ id: 'help', label: 'Help', hookId: 'hook' }],
        presentation: { default: { enabled: false }, rules: [{ id: 'chat', match: { chatId: 'chat' }, enabled: true, actionIds: ['help'] }] } });
      expect(response.status).toBe(200);
      expect((await readFeedbackExtensionConfig(directory)).actions).toHaveLength(1);
      expect((await call(directory, 'hooks', { hooks: [] })).status).toBe(403);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('requires host execution permission to modify command registrations', () => {
    expect(() => authorizeFeedbackExtensionChange({ hostAdmin: false, manager: true, csrf: true }, 'hooks')).toThrow();
    expect(() => authorizeFeedbackExtensionChange({ hostAdmin: true, manager: true, csrf: false }, 'hooks')).toThrow();
    expect(() => authorizeFeedbackExtensionChange({ hostAdmin: true, manager: true, csrf: true }, 'hooks')).not.toThrow();
  });
  it('allows managers to change presentation without allowing anonymous users', () => {
    expect(() => authorizeFeedbackExtensionChange({ hostAdmin: false, manager: true, csrf: true }, 'presentation')).not.toThrow();
    expect(() => authorizeFeedbackExtensionChange({ hostAdmin: false, manager: false, csrf: true }, 'presentation')).toThrow();
  });
});
