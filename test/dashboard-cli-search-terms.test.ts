import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExecFields } from '../src/dashboard/web/agents-page.js';
import { cliSearchTerms, fetchCliOptions } from '../src/dashboard/web/bot-defaults.js';
import { BotOnboardingDialog } from '../src/dashboard/web/bot-onboarding.js';
import { filterDropdownOptions, type DropdownOption } from '../src/dashboard/web/dropdown-shared.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OLD_SERVER_ANTIGRAVITY = { id: 'antigravity', label: 'Antigravity', command: 'agy' };
const renderers: TestRenderer.ReactTestRenderer[] = [];

afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

function stubCliApi(options: unknown[]): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/cli-options' || url === '/api/cli-options?probe=none') {
      return new Response(JSON.stringify({
        options,
        ttadkModelDefault: 'glm-5.1',
        ttadkModelSuggestions: [],
        webSession: { status: 'scan_required' },
      }));
    }
    if (url.startsWith('/api/cli-options/models?')) {
      return new Response(JSON.stringify({ models: [], source: 'static' }));
    }
    if (url.startsWith('/api/cli-options/availability?')) {
      return new Response(JSON.stringify({ status: 'available' }));
    }
    throw new Error(`unexpected request: ${url}`);
  }));
}

function matchingValues(options: DropdownOption<string>[], query: string): string[] {
  return filterDropdownOptions(options, query).map(option => option.value);
}

describe('CLI search terms', () => {
  it('uses non-empty aliases and falls back to command for missing or empty aliases', () => {
    expect(cliSearchTerms({ searchTerms: ['claude', 'cc'], command: 'claude' })).toEqual(['claude', 'cc']);
    expect(cliSearchTerms({ searchTerms: [], command: 'agy' })).toEqual(['agy']);
    expect(cliSearchTerms({ command: 'agy' })).toEqual(['agy']);
    expect(cliSearchTerms({ searchTerms: [] })).toEqual([]);
  });

  it('keeps old-server command fallback end to end and sanitizes malformed aliases', async () => {
    stubCliApi([
      OLD_SERVER_ANTIGRAVITY,
      { id: 'broken', label: 'Broken', command: 'broken-bin', searchTerms: 'broken-bin' },
    ]);

    const state = await fetchCliOptions();
    expect(state.options.map(option => option.searchTerms)).toEqual([[], []]);
    const options = state.options.map(option => ({
      value: option.id,
      label: option.label,
      searchTerms: cliSearchTerms(option),
    }));
    expect(matchingValues(options, 'agy')).toEqual(['antigravity']);
    expect(matchingValues(options, 'broken-bin')).toEqual(['broken']);
  });

  it('passes search terms through the Agents ExecFields dropdown', async () => {
    stubCliApi([]);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(ExecFields, {
        draft: { on: true, cliId: 'antigravity', model: '', reasoningEffort: '', configDir: '' },
        cliState: {
          options: [{ ...OLD_SERVER_ANTIGRAVITY, searchTerms: ['agy'] }],
          ttadkModelDefault: 'glm-5.1',
          ttadkModelSuggestions: [],
        },
        disabled: false,
        onChange: vi.fn(),
      }));
    });
    renderers.push(renderer);

    const options = renderer.root.findByProps({ dataInput: 'agentExecCli' }).props.options;
    expect(matchingValues(options, 'agy')).toEqual(['antigravity']);
  });

  it('loads old-server options into ob-cli and sanitizes malformed aliases', async () => {
    stubCliApi([
      OLD_SERVER_ANTIGRAVITY,
      { id: 'broken', label: 'Broken', command: 'broken-bin', searchTerms: 'broken-bin' },
    ]);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(BotOnboardingDialog, { open: true, onClose: vi.fn() }));
      await Promise.resolve();
      await Promise.resolve();
    });
    renderers.push(renderer);

    const options = renderer.root.findByProps({ id: 'ob-cli' }).props.options;
    expect(matchingValues(options, 'agy')).toEqual(['antigravity']);
    expect(matchingValues(options, 'broken-bin')).toEqual(['broken']);
  });
});
