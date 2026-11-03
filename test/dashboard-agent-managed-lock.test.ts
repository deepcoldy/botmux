import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { AgentManagedLock, BotAgentSection } from '../src/dashboard/web/bot-defaults-page.js';
import { BotMultiSelect } from '../src/dashboard/web/bot-multi-select.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const lock = { id: 'ag_main01', name: '主仓库 Claude', sections: ['exec', 'workspace'] };

function render(section: string, opts: { lock?: typeof lock | null; quiet?: boolean } = {}): string {
  return renderToStaticMarkup(createElement(
    AgentManagedLock,
    { lock: opts.lock === undefined ? lock : opts.lock, section, quiet: opts.quiet },
    createElement('button', { type: 'button' }, 'save'),
  ));
}

describe('AgentManagedLock (Bot config sections managed by an Agent)', () => {
  it('greys out and inerts a section the Agent manages, with a pointer to the graph', () => {
    const html = render('exec');
    expect(html).toContain('data-agent-lock="exec"');
    expect(html).toMatch(/class="bd-agent-lock-body" inert=""/);
    expect(html).toContain('主仓库 Claude');
    expect(html).toContain('href="#/agents"');
  });

  it('renders children untouched when the section is not managed or the bot is standalone', () => {
    expect(render('sandbox')).toBe('<button type="button">save</button>');
    expect(render('exec', { lock: null })).toBe('<button type="button">save</button>');
  });

  it('can lock a second slice of the same panel without repeating the note', () => {
    const html = render('exec', { quiet: true });
    expect(html).toContain('inert');
    expect(html).not.toContain('bd-agent-lock-note');
  });

  it('locks the Agent-managed CLI controls but leaves skill injection editable', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(BotAgentSection, {
        bot: { larkAppId: 'cli_locked', cliId: 'claude-code', model: '', skillInjectionSupport: 'dynamic' },
        sessionFallback: 'claude-code',
        cliState: { options: [{ id: 'claude-code', label: 'Claude' }], ttadkModelDefault: '', ttadkModelSuggestions: [] },
        patchBot: () => undefined,
        lock,
      }));
    });
    const lockedBodies = renderer.root.findAll(node => node.props.className === 'bd-agent-lock-body');
    const inLock = (input: string) => lockedBodies.some(body => body.findAll(node => node.props.dataInput === input).length > 0);
    expect(lockedBodies.length).toBeGreaterThan(0);
    expect(inLock('agentCliId')).toBe(true);
    expect(renderer.root.findAll(node => node.props.dataInput === 'skillInjection').length).toBeGreaterThan(0);
    expect(inLock('skillInjection')).toBe(false);
  });
});

describe('BotMultiSelect hint', () => {
  it('shows the hint in place of the app id when given', () => {
    const html = renderToStaticMarkup(createElement(BotMultiSelect, {
      bots: [{ larkAppId: 'cli_a', botName: 'Alpha', hint: '独立配置 · 2 项将改变' }, { larkAppId: 'cli_b', botName: 'Beta' }],
      selected: new Set<string>(),
      onToggle: () => {},
      searchPlaceholder: 's',
      noMatchLabel: 'n',
      emptyLabel: 'e',
      selectedCountLabel: count => String(count),
    }));
    expect(html).toContain('<small>独立配置 · 2 项将改变</small>');
    expect(html).toContain('<small>(cli_b)</small>');
  });
});
