import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { readFeedbackExtensionConfig, saveFeedbackExtensionConfig } from '../src/services/feedback-extension-config.js';
import { defaultFeedbackTemplate } from '../src/services/feedback-template.js';

describe('feedback extension configuration', () => {
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
