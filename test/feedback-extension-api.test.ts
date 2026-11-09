import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const receiptMock = vi.hoisted(() => ({ message: {} as any }));
vi.mock('../src/bot-registry.js', async original => ({
  ...await original<any>(), loadBotConfigs: () => [{ larkAppId: 'app', feedback: { enabled: true },
    feedbackPresentation: { default: { enabled: true, rounds: [1] }, rules: [] } }], getBotOpenId: () => 'ou_bot',
}));
vi.mock('../src/im/lark/client.js', async original => ({ ...await original<any>(), getMessageDetail: async () => receiptMock.message }));
import { authorizeFeedbackExtensionChange, handleFeedbackExtensionApi } from '../src/dashboard/feedback-extension-api.js';
import { readFeedbackExtensionConfig, saveFeedbackExtensionConfig } from '../src/services/feedback-extension-config.js';
import { FeedbackExtensionStore } from '../src/services/feedback-extension-store.js';
import { stampBotmuxCallbackMarkers } from '../src/im/lark/callback-button-marker.js';
import { defaultFeedbackTemplate } from '../src/services/feedback-template.js';

async function call(dataDir: string, path: string, body: unknown, hostAdmin = false) {
  const request = Readable.from([JSON.stringify(body)]) as any;
  request.method = 'POST';
  let status = 0;
  let result: any;
  await handleFeedbackExtensionApi(request, { writeHead: (code: number) => { status = code; },
    end: (value: string) => { result = JSON.parse(value); } } as any, new URL(`http://fixture/api/feedback/extensions/${path}`),
  { dataDir, hostAdmin, manager: true, csrf: true });
  return { status, result };
}

describe('feedback extension API permissions', () => {
  it('saves custom reference text and topic scope and previews their persisted configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-api-custom-'));
    try {
      const initial = await readFeedbackExtensionConfig(directory);
      const template = defaultFeedbackTemplate();
      template.elements = template.elements.map(element => element.slot === 'answerReference'
        ? { ...element, content: 'Reply {round}: {answerUrl}' } : element);
      const saved = await call(directory, 'presentation', { appId: 'app', expectedVersion: initial.version,
        templates: [template], presentation: { default: { enabled: true, rounds: [1], roundScope: 'topic' }, rules: [] } });
      expect(saved.status).toBe(200);
      const loaded = await readFeedbackExtensionConfig(directory);
      expect(loaded.presentations.app.default.roundScope).toBe('topic');
      const preview = await call(directory, 'preview', { appId: 'app', chatId: 'chat', round: 1 });
      expect(preview.status).toBe(200);
      expect(preview.result.card.body.elements[0].content).toBe('Reply 1: https://example.com/answer');
      expect(preview.result.presentation.roundScope).toBe('topic');
      expect(loaded.hooks).toEqual(initial.hooks);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('only reconciles a surface after verifying sender, scope and stamped card content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-receipt-api-'));
    const store = await FeedbackExtensionStore.open(directory);
    try {
      const card = { schema: '2.0', body: { elements: [{ tag: 'button', text: { tag: 'plain_text', content: 'Help' },
        behaviors: [{ type: 'callback', value: { action: 'feedback_custom_action', action_id: 'help' } }] }] } };
      store.ingest('source', 0, [{ sequence: 1, eventId: 'event', jobs: [{
        id: 'job', kind: 'surface', payload: { appId: 'app', chatId: 'chat', subjectId: 'question', card, mode: 'both' },
      }] }]);
      store.claim('surface', 1, 10);
      store.expire(12);
      const body = { jobId: 'job', messageId: 'om_surface', evidence: 'provider receipt', confirmed: true };
      receiptMock.message = { items: [{ sender: { id: 'ou_wrong' }, chat_id: 'chat', parent_id: 'question',
        body: { content: stampBotmuxCallbackMarkers(JSON.stringify(card)) } }] };
      expect((await call(directory, 'reconcile-surface', body, true)).status).toBe(400);
      expect(store.job('job')?.status).toBe('unknown');
      receiptMock.message.items[0].sender.id = 'ou_bot';
      expect((await call(directory, 'reconcile-surface', body)).status).toBe(403);
      expect((await call(directory, 'reconcile-surface', body, true)).status).toBe(200);
      expect(store.surface('app', 'om_surface')).toMatchObject({ subjectId: 'question' });
      expect((await call(directory, 'reconcile-surface', body, true)).status).toBe(409);
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  });
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
