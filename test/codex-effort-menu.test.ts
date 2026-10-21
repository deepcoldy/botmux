import { describe, expect, it, vi } from 'vitest';
import { applyCodexEffortMenu, hasEmptyCodexComposer, parseCodexEffortMenu, sameModelIdentity, type CodexEffortMenuIO } from '../src/utils/codex-effort-menu.js';

const idle = 'Working\n› Ask Codex to do anything\nGPT-6-Astra high';
function picker(title: string, labels: string[], selected: number, session = true): string {
  return `${title}\n${labels.map((label, i) => `${i === selected ? '›' : ' '} ${i + 1}. ${label}`).join('\n')}\n${title === 'Select Model and Effort'
    ? 'enter select · esc back' : session ? 'enter default · s session · esc back' : 'enter select · esc back'}`;
}

interface FixtureOpts {
  session?: boolean;
  receipt?: boolean;
  frozen?: boolean;
  /** Configured slug handed to the controller (turn_context preserves it verbatim). */
  model?: string;
  /** Model-page rows, in picker order. */
  modelRows?: string[];
  /** Initially highlighted model-page row. */
  modelSelected?: number;
  /** Model name the native thread_settings receipt records after `s`. */
  receiptModel?: string;
}

function fixture(opts: FixtureOpts = {}) {
  let page = 'idle';
  let selected = opts.modelSelected ?? 1;
  let time = 0;
  let applied = false;
  let current = true;
  const model = opts.model ?? 'gpt-6-astra';
  const modelRows = opts.modelRows ?? ['GPT-6-Sol', 'GPT-6-Astra (current)'];
  const receiptModel = opts.receiptModel ?? 'gpt-6-astra';
  const abort = new AbortController();
  const keys: string[] = [];
  const io: CodexEffortMenuIO = {
    signal: abort.signal, deadline: 2000, now: () => time,
    delay: async ms => { time += ms; }, isCurrent: () => current,
    screen: async () => page === 'idle' ? idle
      : page === 'model' ? picker('Select Model and Effort', modelRows, selected)
      : page === 'effort' ? picker('Select Reasoning Level for GPT-6-Astra', ['Low', 'High (current)', 'More reasoning…'], selected, opts.session)
      : picker('Advanced Reasoning', ['Max', 'Ultra'], selected, opts.session),
    command: vi.fn(async () => { page = 'model'; }),
    key: key => {
      keys.push(key);
      if (opts.frozen) return;
      if (key === 'Escape') { page = 'idle'; return; }
      // A real picker is bounded: Down/Up on the last/first row is a no-op and
      // the viewport stops changing (the controller detects end-of-list).
      const rowMax = page === 'model' ? modelRows.length - 1 : page === 'effort' ? 2 : 1;
      if (key === 'Down') selected = Math.min(selected + 1, rowMax);
      else if (key === 'Up') selected = Math.max(selected - 1, 0);
      else if (key === 'Enter' && page === 'model') { page = 'effort'; selected = 1; }
      else if (key === 'Enter' && page === 'effort') { page = 'advanced'; selected = 0; }
      else if (key === 's') { applied = true; page = 'idle'; }
      else throw new Error('Unexpected key: ' + key);
    },
    settings: () => applied && opts.receipt !== false ? { model: receiptModel, reasoningEffort: 'max', serviceTier: 'default' } : undefined,
  };
  return { io, keys, abort, replace: () => { current = false; }, model };
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

  it('finds the configured model row without a (current) marker when the slug casing differs (Codex 0.162)', async () => {
    // Lowercase config slug: the picker renders no (current) marker at all and
    // the native receipt records the catalog's canonical mixed-case slug.
    const { io, keys, model } = fixture({
      model: 'gpt-6.1-sol',
      modelRows: ['GPT-6-Sol', 'GPT-6.1 Sol'],
      modelSelected: 0,
      receiptModel: 'GPT-6.1-Sol',
    });
    expect(await applyCodexEffortMenu(io, model, 'max')).toEqual({ status: 'future_only', reason: 'cli_next_turn' });
    expect(keys).toEqual(['Down', 'Enter', 'Down', 'Enter', 's']);
  });

  it('matches the real picker rows whose name column is followed by a padded description column', async () => {
    // Real Codex 0.162 rows pad a description after the model name, e.g.
    // "15. GPT-6.1 Sol   GPT-6.1 Sol via Codex Bridge." — and the
    // no-(current) name fallback must compare only the name column.
    const { io, keys, model } = fixture({
      model: 'gpt-6.1-sol',
      modelRows: [
        'GPT-6-Sol   GPT-6-Sol via Codex Bridge.',
        'GPT-6.1 Sol   GPT-6.1 Sol via Codex Bridge.',
      ],
      modelSelected: 0,
      receiptModel: 'GPT-6.1-Sol',
    });
    expect(await applyCodexEffortMenu(io, model, 'max')).toEqual({ status: 'future_only', reason: 'cli_next_turn' });
    expect(keys).toEqual(['Down', 'Enter', 'Down', 'Enter', 's']);
  });

  it('still recognizes the (current) marker when a description column follows it', async () => {
    const { io, keys } = fixture({
      modelRows: [
        'GPT-6-Sol   GPT-6-Sol via Codex Bridge.',
        'GPT-6-Astra (current)   GPT-6-Astra via Codex Bridge.',
      ],
      modelSelected: 1,
    });
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toEqual({ status: 'future_only', reason: 'cli_next_turn' });
    expect(keys).toEqual(['Enter', 'Down', 'Enter', 's']);
  });

  it('pages the model list to the end then refuses when no row matches', async () => {
    const { io, keys } = fixture({
      model: 'gpt-6.1-sol',
      modelRows: ['GPT-6-Sol', 'GPT-7-Ultra'],
      modelSelected: 0,
    });
    expect(await applyCodexEffortMenu(io, 'gpt-6.1-sol', 'max')).toMatchObject({ status: 'invalid' });
    // It tries to reveal more rows (Down on each row) but never commits; the
    // final Escape dismisses the opened model page after end-of-list is reached.
    expect(keys.filter(k => k === 'Enter' || k === 's')).toEqual([]);
    expect(keys.at(-1)).toBe('Escape');
  });

  it('scrolls a long model list to reach the current model below the first viewport (no (current) marker)', async () => {
    // Real Codex 0.162 layout (captured at 160x50): without a (current) marker
    // the picker opens on rows 1..8 and does not auto-scroll; the configured
    // model is row 15, shown with a description column.
    const MODELS = [
      'GPT-5.5', 'GPT-5.4', 'GPT-5.3', 'GPT-5.2', 'GPT-5.1', 'GPT-5.0', 'GPT-5.6', 'GPT-5.7',
      'GPT-6.0', 'GPT-6-Ultra', 'GPT-6-Luna', 'GPT-6-Astra', 'GPT-6-Sol', 'GPT-6-Terra',
      'GPT-6.1 Sol   GPT-6.1 Sol via Codex Bridge.',
    ];
    const PAGE = 8;
    let page = 'idle';
    let modelSel = 0;
    let effortSel = 1;
    let applied = false;
    let time = 0;
    const keys: string[] = [];
    const abort = new AbortController();
    const numbered = (labels: string[], sel: number, offset: number): string =>
      labels.map((label, i) => `${offset + i === sel ? '›' : ' '} ${offset + i + 1}. ${label}`).join('\n');
    const modelScreen = (): string => {
      const start = Math.max(0, Math.min(modelSel, MODELS.length - PAGE));
      return `Select Model and Effort\n${numbered(MODELS.slice(start, start + PAGE), modelSel, start)}`
        + '\nenter select · esc back';
    };
    const levelScreen = (kind: 'effort' | 'advanced'): string => {
      const labels = kind === 'effort' ? ['Low', 'High (current)', 'More reasoning…'] : ['Max', 'Ultra'];
      return `${kind === 'effort' ? 'Select Reasoning Level for GPT-6.1 Sol' : 'Advanced Reasoning'}\n`
        + `${numbered(labels, effortSel, 0)}\nenter default · s session · esc back`;
    };
    const io: CodexEffortMenuIO = {
      signal: abort.signal, deadline: 5_000, now: () => time,
      delay: async ms => { time += ms; }, isCurrent: () => true,
      screen: async () => page === 'model' ? modelScreen()
        : page === 'effort' ? levelScreen('effort')
          : page === 'advanced' ? levelScreen('advanced') : idle,
      command: vi.fn(async () => { page = 'model'; }),
      key: key => {
        keys.push(key);
        if (key === 'Escape') { page = 'idle'; return; }
        if (key === 'Down') {
          if (page === 'model') modelSel = Math.min(modelSel + 1, MODELS.length - 1);
          else effortSel++;
          return;
        }
        if (key === 'Up') { effortSel--; return; }
        if (key === 'Enter' && page === 'model') { page = 'effort'; effortSel = 1; return; }
        if (key === 'Enter' && page === 'effort') { page = 'advanced'; effortSel = 0; return; }
        if (key === 's') { applied = true; page = 'idle'; return; }
        throw new Error('Unexpected key: ' + key);
      },
      settings: () => applied
        ? { model: 'GPT-6.1-Sol', reasoningEffort: 'max', serviceTier: 'default' } : undefined,
    };
    expect(await applyCodexEffortMenu(io, 'gpt-6.1-sol', 'max'))
      .toEqual({ status: 'future_only', reason: 'cli_next_turn' });
    // Fourteen Downs walk the highlight from row 1 onto row 15 (the viewport
    // follows), then Enter opens levels, Down/Enter reach Max via More reasoning,
    // and s applies it session-only — matching the real CLI key sequence.
    expect(keys).toEqual([
      ...Array(14).fill('Down'), 'Enter', 'Down', 'Enter', 's',
    ]);
  });

  it('normalizes model identity across casing and display spacing, keeping dots significant', () => {
    expect(sameModelIdentity('gpt-6.1-sol', 'GPT-6.1-Sol')).toBe(true);
    expect(sameModelIdentity('gpt-6.1-sol', 'GPT-6.1 Sol')).toBe(true);
    expect(sameModelIdentity('gpt-6-astra', 'GPT 6 Astra')).toBe(true);
    expect(sameModelIdentity('gpt-6.1-sol', 'gpt-61-sol')).toBe(false);
    expect(sameModelIdentity('gpt-6-astra', 'gpt-6-sol')).toBe(false);
    expect(sameModelIdentity(undefined, 'gpt-6-astra')).toBe(false);
  });

  it('does not parse old picker text followed by a live composer as an active menu', () => {
    expect(parseCodexEffortMenu(picker('Advanced Reasoning', ['Max', 'Ultra'], 0) + '\n› Ask Codex to do anything')).toBeUndefined();
    expect(hasEmptyCodexComposer(idle)).toBe(true);
  });
});
