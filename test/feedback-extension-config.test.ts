import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { readFeedbackExtensionConfig, saveFeedbackExtensionConfig } from '../src/services/feedback-extension-config.js';
import { defaultFeedbackTemplate } from '../src/services/feedback-template.js';

describe('feedback extension configuration', () => {
  it('validates inherited action and template combinations before saving a rule', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-inherited-'));
    try {
      const initial = await readFeedbackExtensionConfig(directory);
      const ratings = defaultFeedbackTemplate();
      ratings.id = 'ratings-only';
      ratings.elements = ratings.elements.filter(element => element.slot !== 'actionButtons');
      const input = {
        ...initial, templates: [defaultFeedbackTemplate(), ratings],
        hooks: [{ id: 'hook', version: 1, protocolVersion: 1, hostId: initial.hostId, command: ['/bin/true'],
          cwd: '/tmp', allowedBotAppIds: ['app'], allowedChatIds: ['chat'], allowedActionIds: ['help'],
          timeoutMs: 1000, concurrency: 1, envRefs: {}, enabled: false }],
        actions: [{ id: 'help', label: 'Help', hookId: 'hook' }],
        presentations: { app: { default: { enabled: true, actionIds: ['help'], templateId: 'default' },
          rules: [{ id: 'ratings', match: { chatId: 'chat' }, templateId: 'ratings-only' }] } },
      };
      await expect(saveFeedbackExtensionConfig(directory, 0, input, 'admin')).rejects.toThrow('feedback_template_action_slot_missing');
      expect((await readFeedbackExtensionConfig(directory)).version).toBe(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('does not replace the saved configuration with a template that cannot fit in a card', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-config-'));
    try {
      const initial = await readFeedbackExtensionConfig(directory);
      const template = defaultFeedbackTemplate();
      for (let index = 0; index < 8; index++) template.elements.push({ tag: 'markdown', content: 'a'.repeat(4000) });
      await expect(saveFeedbackExtensionConfig(directory, initial.version, { ...initial, templates: [template] }, 'admin')).rejects.toThrow();
      expect(await readFeedbackExtensionConfig(directory)).toEqual(initial);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('preserves optimistic versions and leaves valid configuration intact after a rejected save', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-config-'));
    try {
      const initial = await readFeedbackExtensionConfig(directory);
      const updated = await saveFeedbackExtensionConfig(directory, initial.version, { ...initial, templates: [defaultFeedbackTemplate()] }, 'admin');
      expect(updated.version).toBe(initial.version + 1);
      await expect(saveFeedbackExtensionConfig(directory, initial.version, initial, 'admin')).rejects.toThrow('conflict');
      expect(await readFeedbackExtensionConfig(directory)).toEqual(updated);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('rejects unresolved template and hook references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-config-'));
    try {
      const initial = await readFeedbackExtensionConfig(directory);
      await expect(saveFeedbackExtensionConfig(directory, 0, { ...initial, actions: [{ id: 'help', label: 'Help', hookId: 'missing' }] }, 'admin'))
        .rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
