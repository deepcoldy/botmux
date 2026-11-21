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
  effort?: 'max' | 'ultra';
  applyFooter?: boolean;
}

function fixture(opts: FixtureOpts = {}) {
  let page = 'idle';
  // `command()` only TYPES `/model`; the controller presses the submitting Enter
  // itself after its pre-submit screen re-check, so the picker appears on Enter.
  let typed = false;
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
    screen: async () => page === 'idle' ? (typed ? '› /model' : idle)
      : page === 'model' ? picker('Select Model and Effort', modelRows, selected)
      : page === 'effort' ? picker('Select Reasoning Level for GPT-6-Astra', ['Low', 'High (current)', 'More reasoning…'], selected, opts.session)
      : picker('Advanced Reasoning', ['Max', 'Ultra'], selected, opts.session)
        .replace('enter default', opts.applyFooter ? 'enter apply' : 'enter default'),
    command: vi.fn(async () => { typed = true; }),
    key: key => {
      // The submitting Enter is recorded as 'Submit' so the two distinct Enter
      // roles (submit the typed /model vs. navigate the picker) stay visible.
      if (key === 'Enter' && typed) {
        typed = false;
        keys.push('Submit');
        page = 'model';
        selected = opts.modelSelected ?? 1;
        return;
      }
      keys.push(key);
      if (opts.frozen) return;
      if (key === 'Escape') { page = 'idle'; typed = false; return; }
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
    settings: () => applied && opts.receipt !== false ? { model: receiptModel, reasoningEffort: opts.effort ?? 'max', serviceTier: 'default' } : undefined,
  };
  return { io, keys, abort, replace: () => { current = false; }, model };
}

describe('Codex CLI effort menu', () => {
  it('navigates the current model and advanced level, selects session-only and waits for native settings', async () => {
    const { io, keys } = fixture();
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toEqual({ status: 'future_only', reason: 'cli_next_turn' });
    expect(keys).toEqual(['Submit', 'Enter', 'Down', 'Enter', 's']);
  });

  it('does not claim success from the changed screen without a native receipt', async () => {
    const { io, keys } = fixture({ receipt: false });
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toEqual({ status: 'error' });
    expect(keys.filter(key => key === 's')).toHaveLength(1);
  });

  it('waits for the picker to visibly close after a native settings receipt', async () => {
    const { io } = fixture();
    const screen = io.screen;
    const settings = io.settings;
    let closingFrames = 0;
    io.screen = async () => {
      if (settings() && closingFrames++ < 2) {
        return picker('Advanced Reasoning', ['Max', 'Ultra'], 0);
      }
      return screen();
    };
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max'))
      .toEqual({ status: 'future_only', reason: 'cli_next_turn' });
    expect(closingFrames).toBeGreaterThanOrEqual(3);
  });

  it('selects Ultra session-only when a forked Codex 0.164 menu says enter apply', async () => {
    const { io, keys } = fixture({ effort: 'ultra', applyFooter: true });
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'ultra'))
      .toEqual({ status: 'future_only', reason: 'cli_next_turn' });
    expect(keys).toEqual(['Submit', 'Enter', 'Down', 'Enter', 'Down', 's']);
  });

  it('does not select Enter when an older CLI lacks session-scoped selection', async () => {
    const { io, keys } = fixture({ session: false });
    io.unavailable = vi.fn();
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'high')).toMatchObject({ status: 'unavailable' });
    expect(io.unavailable).toHaveBeenCalledWith('session_selection_unavailable');
    expect(keys).toEqual(['Submit', 'Enter', 'Escape']);
  });

  it('waits for an actual cursor/page change instead of repeatedly pressing keys', async () => {
    const { io, keys } = fixture({ frozen: true });
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toEqual({ status: 'error' });
    expect(keys.filter(key => key === 'Enter')).toHaveLength(1);
    expect(keys.filter(key => key === 'Submit')).toHaveLength(1);
    expect(keys.filter(key => key === 'Escape')).toHaveLength(1);
  });

  it.each(['› important unsent draft', '› /other-command', 'unknown layout'])('leaves %s untouched', async screen => {
    const { io, keys } = fixture();
    io.unavailable = vi.fn();
    io.screen = async () => screen;
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toMatchObject({ status: 'unavailable' });
    expect(io.unavailable).toHaveBeenCalledWith('composer_not_empty');
    expect(io.command).not.toHaveBeenCalled();
    expect(keys).toEqual([]);
  });

  it('identifies an already open picker without logging its contents or pressing keys', async () => {
    const { io, keys } = fixture();
    io.unavailable = vi.fn();
    io.screen = async () => picker('Advanced Reasoning', ['Max', 'Ultra'], 0);
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toMatchObject({ status: 'unavailable' });
    expect(io.unavailable).toHaveBeenCalledExactlyOnceWith('menu_already_open');
    expect(io.command).not.toHaveBeenCalled();
    expect(keys).toEqual([]);
  });

  it('aborts on generation replacement and never sends cleanup into the replacement', async () => {
    const { io, keys, replace } = fixture();
    io.delay = async () => { replace(); };
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toEqual({ status: 'error' });
    expect(keys).toEqual(['Submit', 'Enter']);
  });

  it('cancels a menu transaction before user input is released', async () => {
    const { io, keys, abort } = fixture();
    io.delay = async () => { abort.abort(); };
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toEqual({ status: 'error' });
    expect(keys).toEqual(['Submit', 'Enter', 'Escape']);
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
    expect(keys).toEqual(['Submit', 'Down', 'Enter', 'Down', 'Enter', 's']);
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
    expect(keys).toEqual(['Submit', 'Down', 'Enter', 'Down', 'Enter', 's']);
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
    expect(keys).toEqual(['Submit', 'Enter', 'Down', 'Enter', 's']);
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
      screen: async () => page === 'typed' ? '› /model'
        : page === 'model' ? modelScreen()
        : page === 'effort' ? levelScreen('effort')
          : page === 'advanced' ? levelScreen('advanced') : idle,
      command: vi.fn(async () => { page = 'typed'; }),
      key: key => {
        if (key === 'Enter' && page === 'typed') { keys.push('Submit'); page = 'model'; return; }
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
      'Submit', ...Array(14).fill('Down'), 'Enter', 'Down', 'Enter', 's',
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

describe('Codex CLI effort menu: modal surface guards', () => {
  // Real 0.164 "Enable full access?" dialog over a live composer row (see
  // test/fixtures/codex-choice-modal/). Reaching the effort controller with this
  // screen on a warm-reattached session is the shape that would otherwise type
  // /model and press Enter onto "› 1. Yes, continue anyway".
  const FULL_ACCESS_DIALOG = [
    '                         Enable full access?',
    '› Ask Codex to do anything  When Codex runs with full access, it can edit any file',
    '  GPT-6.1-Sol xhigh · /tmp/x  Exercise caution when enabling full access.',
    '',
    '› 1. Yes, continue anyway  Apply full access for this session',
    '  2. Cancel                Go back without enabling full access',
    '',
    '                          enter select · esc back',
  ].join('\n');

  it('refuses to type /model when a centered confirmation dialog owns Enter', async () => {
    const { io, keys } = fixture();
    io.unavailable = vi.fn();
    io.screen = async () => FULL_ACCESS_DIALOG;
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toMatchObject({ status: 'unavailable' });
    expect(io.unavailable).toHaveBeenCalledWith('modal_surface');
    // Not one byte of /model, and no Enter of any kind.
    expect(io.command).not.toHaveBeenCalled();
    expect(keys).toEqual([]);
  });

  it('withholds the submitting Enter when a dialog appears after the text is typed', async () => {
    // The popup can paint inside the beat between the typed text and the Enter.
    const { io, keys } = fixture();
    io.unavailable = vi.fn();
    io.submitGuard = vi.fn(async () => false);
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toMatchObject({ status: 'unavailable' });
    expect(io.submitGuard).toHaveBeenCalledTimes(1);
    expect(io.unavailable).toHaveBeenCalledWith('modal_surface');
    expect(keys).toEqual([]);
  });

  it('asks the guard after typing and before the Enter, never the other way round', async () => {
    const order: string[] = [];
    const { io } = fixture();
    const command = io.command;
    io.command = async () => { order.push('type'); await command(); };
    io.submitGuard = async () => { order.push('guard'); return true; };
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max'))
      .toEqual({ status: 'future_only', reason: 'cli_next_turn' });
    expect(order).toEqual(['type', 'guard']);
  });

  it('keeps working when the backend has no guard hook', async () => {
    // Backends that cannot render such a popup simply omit the hook; absence
    // must not be read as "guard said yes" or as a failure.
    const { io } = fixture();
    expect(io.submitGuard).toBeUndefined();
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max'))
      .toEqual({ status: 'future_only', reason: 'cli_next_turn' });
  });

  it('stops before pressing Enter when the generation changed during the guard', async () => {
    const { io, keys, replace } = fixture();
    io.submitGuard = async () => { replace(); return true; };
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toEqual({ status: 'error' });
    expect(keys).toEqual([]);
  });
});

describe('Codex CLI effort menu: refused guard must not leave /model behind', () => {
  // Reproduced on a real 0.164 PTY: with `/model` left in the composer, the next
  // user message is appended (`/model` + `fix the bug` → `modelfix the bug`) and
  // the turn is lost as a malformed slash command.
  it('discards the typed line when the guard refuses', async () => {
    const { io, keys } = fixture();
    io.submitGuard = async () => false;
    io.discardTypedCommand = vi.fn(async () => {});
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max')).toMatchObject({ status: 'unavailable' });
    expect(io.discardTypedCommand).toHaveBeenCalledTimes(1);
  });

  it('does not discard anything when the guard allows the submit', async () => {
    const { io } = fixture();
    io.discardTypedCommand = vi.fn(async () => {});
    expect(await applyCodexEffortMenu(io, 'gpt-6-astra', 'max'))
      .toEqual({ status: 'future_only', reason: 'cli_next_turn' });
    expect(io.discardTypedCommand).not.toHaveBeenCalled();
  });

  it('does not discard before typing when the initial check already refuses', async () => {
    const { io } = fixture();
    io.discardTypedCommand = vi.fn(async () => {});
    io.screen = async () => '› important unsent draft';
    await applyCodexEffortMenu(io, 'gpt-6-astra', 'max');
    expect(io.discardTypedCommand).not.toHaveBeenCalled();
  });
});
