import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentManagedLock } from '../src/dashboard/web/bot-defaults-page.js';
import { BotMultiSelect } from '../src/dashboard/web/bot-multi-select.js';

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

  it('wraps only Agent-managed fields: skill injection and auto-start stay editable', () => {
    const page = readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url), 'utf8');
    const agentSection = page.slice(page.indexOf('export function BotAgentSection'));
    const lockEnd = agentSection.indexOf('</AgentManagedLock>');
    expect(agentSection.indexOf("siSupport === 'dynamic'")).toBeGreaterThan(lockEnd);
    const workingDir = page.slice(page.indexOf('function WorkingDirSection'));
    expect(workingDir.indexOf('</AgentManagedLock>')).toBeLessThan(workingDir.indexOf('<AutoStartControls'));
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
