import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { displayCliId } from '../src/dashboard/web/bot-defaults.js';
import { BotAgentSection } from '../src/dashboard/web/bot-defaults-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('bot defaults cli label', () => {
  it('prefers /api/bots cliId before session fallback', () => {
    expect(displayCliId({ larkAppId: 'cli_traex', cliId: 'traex' }, 'codex')).toBe('traex');
    expect(displayCliId({ larkAppId: 'cli_traex' }, 'codex')).toBe('codex');
    expect(displayCliId({ larkAppId: 'cli_traex', cliId: '' }, '')).toBe('');
  });

  it('renders an editable CLI and model section from /api/bots values', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAgentSection, {
        bot: { larkAppId: 'cli_traex', cliId: 'traex', model: 'glm-5.1' },
        sessionFallback: 'codex',
        cliState: {
          options: [
            { id: 'claude-code', label: 'Claude' },
            { id: 'codex', label: 'Codex' },
            { id: 'traex', label: 'traex' },
          ],
          ttadkModelDefault: 'glm-5.1',
          ttadkModelSuggestions: [],
        },
        patchBot: () => undefined,
      }));
    });
    const root = renderer.root;
    expect(root.findByProps({ 'data-input': 'agentCliId' }).props.value).toBe('traex');
    expect(root.findByProps({ 'data-input': 'agentModel' }).props.value).toBe('glm-5.1');
    expect(root.findAllByProps({ 'data-action': 'save-agent' })).toHaveLength(1);
  });
});
