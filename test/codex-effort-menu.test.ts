import { describe, expect, it, vi } from 'vitest';
import { applyCodexEffortMenu, hasEmptyCodexComposer, parseCodexEffortMenu, type CodexEffortMenuIO } from '../src/utils/codex-effort-menu.js';

const idle = 'Working\n› Ask Codex to do anything\nGPT-6-Astra high';
function picker(title: string, labels: string[], selected: number, session = true): string {
  return `${title}\n${labels.map((label, i) => `${i === selected ? '›' : ' '} ${i + 1}. ${label}`).join('\n')}\n${title === 'Select Model and Effort'
    ? 'enter select · esc back' : session ? 'enter default · s session · esc back' : 'enter select · esc back'}`;
}

function fixture(opts: { session?: boolean; receipt?: boolean; frozen?: boolean } = {}) {
  let page = 'idle';
  let selected = 1;
  let time = 0;
  let applied = false;
  let current = true;
  const abort = new AbortController();
  const keys: string[] = [];
  const io: CodexEffortMenuIO = {
    signal: abort.signal, deadline: 2000, now: () => time,
    delay: async ms => { time += ms; }, isCurrent: () => current,
    screen: async () => page === 'idle' ? idle
      : page === 'model' ? picker('Select Model and Effort', ['GPT-6-Sol', 'GPT-6-Astra (current)'], 1)
      : page === 'effort' ? picker('Select Reasoning Level for GPT-6-Astra', ['Low', 'High (current)', 'More reasoning…'], selected, opts.session)
      : picker('Advanced Reasoning', ['Max', 'Ultra'], selected, opts.session),
    command: vi.fn(async () => { page = 'model'; }),
    key: key => {
      keys.push(key);
      if (opts.frozen) return;
      if (key === 'Escape') { page = 'idle'; return; }
      if (key === 'Down') selected++;
      else if (key === 'Up') selected--;
      else if (key === 'Enter' && page === 'model') { page = 'effort'; selected = 1; }
      else if (key === 'Enter' && page === 'effort') { page = 'advanced'; selected = 0; }
      else if (key === 's') { applied = true; page = 'idle'; }
      else throw new Error('Unexpected key: ' + key);
    },
    settings: () => applied && opts.receipt !== false ? { model: 'gpt-6-astra', reasoningEffort: 'max', serviceTier: 'default' } : undefined,
  };
  return { io, keys, abort, replace: () => { current = false; } };
}

describe('Codex CLI effort menu', () => {
  it('navigates the current model and advanced level, selects session-only and waits for native settings', async () => {
    const { io, keys } = fixture();
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toEqual({ status: 'future_only', reason: 'cli_next_turn' });
    expect(keys).toEqual(['Enter', 'Down', 'Enter', 's']);
  });

  it('does not claim success from the changed screen without a native receipt', async () => {
    const { io, keys } = fixture({ receipt: false });
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toEqual({ status: 'error' });
    expect(keys.filter(key => key === 's')).toHaveLength(1);
  });

  it('does not select Enter when an older CLI lacks session-scoped selection', async () => {
    const { io, keys } = fixture({ session: false });
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'high')).toMatchObject({ status: 'unavailable' });
    expect(keys).toEqual(['Enter', 'Escape']);
  });

  it('waits for an actual cursor/page change instead of repeatedly pressing keys', async () => {
    const { io, keys } = fixture({ frozen: true });
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toEqual({ status: 'error' });
    expect(keys.filter(key => key === 'Enter')).toHaveLength(1);
    expect(keys.filter(key => key === 'Escape')).toHaveLength(1);
  });

  it.each(['› important unsent draft', '› /other-command', 'unknown layout'])('leaves %s untouched', async screen => {
    const { io, keys } = fixture();
    io.screen = async () => screen;
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toMatchObject({ status: 'unavailable' });
    expect(io.command).not.toHaveBeenCalled();
    expect(keys).toEqual([]);
  });

  it('aborts on generation replacement and never sends cleanup into the replacement', async () => {
    const { io, keys, replace } = fixture();
    io.delay = async () => { replace(); };
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toEqual({ status: 'error' });
    expect(keys).toEqual(['Enter']);
  });

  it('cancels a menu transaction before user input is released', async () => {
    const { io, keys, abort } = fixture();
    io.delay = async () => { abort.abort(); };
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toEqual({ status: 'error' });
    expect(keys).toEqual(['Enter', 'Escape']);
  });

  it('rejects mismatched model receipts', async () => {
    const { io } = fixture();
    io.settings = () => ({ model: 'other-model', reasoningEffort: 'max', serviceTier: 'default' });
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toEqual({ status: 'error' });
  });

  it('does not parse old picker text followed by a live composer as an active menu', () => {
    expect(parseCodexEffortMenu(picker('Advanced Reasoning', ['Max', 'Ultra'], 0) + '\n› Ask Codex to do anything')).toBeUndefined();
    expect(hasEmptyCodexComposer(idle)).toBe(true);
  });
});
