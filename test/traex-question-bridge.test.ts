import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskQuestion, AskResult } from '../src/core/ask-types.js';
import {
  TRAEX_QUESTION_GONE_MS,
  TRAEX_QUESTION_POLL_MS,
  TRAEX_QUESTION_STABLE_MS,
  TraexQuestionBridge,
  type TraexQuestionNoticeKey,
} from '../src/core/traex-question-bridge.js';

/**
 * A TRAE question page as traecli 0.214.1 behaves (probed live, see
 * test/fixtures/traex-question): a digit on a single-choice question selects
 * and submits it, on a multiSelect one toggles it and moves the pointer;
 * Up/Down wrap; Tab opens the notes field of the pointed row; a paste with the
 * options focused also lands in the notes field (the reported bug); Enter
 * submits. Rendered in TRAE's layout (the parser itself is tested on the real
 * screens in traex-question-page.test.ts).
 */
interface Question { prompt: string; options: string[]; multiSelect?: boolean }
class FakeTraexQuestions {
  index = 0;
  pointer = 1;
  ticks = new Set<number>();
  notes: string | undefined;
  answers: string[] = [];
  inputs: string[] = [];
  /** A pane too short for the notes row (TRAE squeezes it out). */
  hideNotes = false;
  constructor(public questions: Question[]) {}
  get current(): Question | undefined { return this.questions[this.index]; }
  get count(): number { return this.current!.options.length + 1; }
  screen(): string {
    const q = this.current;
    if (!q) return '◆ Questions answered\n\n❯ \n  model · /tmp/repo · Context 99% left';
    const other = q.multiSelect ? 'Other' : 'None of the above';
    const labels = [...q.options, other];
    const width = Math.max(...labels.map(label => label.length));
    const rows = [
      '────────────────────────────────────────',
      '',
      `  Question ${this.index + 1}/${this.questions.length} (${this.questions.length - this.index} unanswered)`,
      `  ${q.prompt}`,
      '',
      ...labels.map((label, i) => {
        const n = i + 1;
        const box = q.multiSelect ? `[${this.ticks.has(n) ? '✓' : ' '}] ` : '';
        const description = n === labels.length ? 'Optionally, add details in notes (tab).' : `about ${label}`;
        return `  ${this.pointer === n ? '❯' : ' '} ${box}${n}. ${label.padEnd(width)}  ${description}`;
      }),
    ];
    if (this.notes !== undefined) {
      rows.push('  ──────────────────', ...(this.hideNotes ? [] : [`  ❯ ${this.notes || 'Add notes'}`]), '  ──────────────────', '  tab or esc clear notes  |  enter submit answer');
    } else {
      const last = this.index === this.questions.length - 1 && this.questions.length > 1;
      rows.push('', `  ${q.multiSelect ? 'space toggle  |  ' : ''}tab add notes  |  enter ${last ? 'submit all' : 'submit answer'}${this.questions.length > 1 ? '  |  ←/→ navigate questions' : ''}  |  esc interrupt`);
    }
    return rows.join('\n');
  }
  private submit(choice: string): void {
    const note = this.notes ? `+note:${this.notes}` : '';
    this.answers.push(`${this.index + 1}:${choice}${note}`);
    this.index++;
    this.pointer = 1;
    this.ticks.clear();
    this.notes = undefined;
  }
  private label(n: number): string {
    return n === this.count ? (this.current!.multiSelect ? 'Other' : 'None of the above') : this.current!.options[n - 1]!;
  }
  key(key: string): void {
    this.inputs.push(key);
    if (!this.current) return;
    if (this.notes !== undefined) {
      if (key === 'Enter') this.submit(this.current.multiSelect ? [...this.ticks].sort().map(n => this.label(n)).join(',') : this.label(this.pointer));
      else if (key === 'Tab' || key === 'Escape') this.notes = undefined;
      else if (key.length === 1) this.notes += key;
      return;
    }
    if (/^[1-9]$/.test(key) && Number(key) <= this.count) {
      const n = Number(key);
      if (!this.current.multiSelect) { this.pointer = n; this.submit(this.label(n)); return; }
      if (this.ticks.has(n)) this.ticks.delete(n); else this.ticks.add(n);
      this.pointer = n;
    } else if (key === 'Down') this.pointer = this.pointer % this.count + 1;
    else if (key === 'Up') this.pointer = (this.pointer + this.count - 2) % this.count + 1;
    else if (key === 'Tab') this.notes = '';
    else if (key === 'Enter') this.submit(this.current.multiSelect ? [...this.ticks].sort().map(n => this.label(n)).join(',') : this.label(this.pointer));
  }
  paste(text: string): void {
    this.inputs.push(`paste:${text}`);
    if (!this.current) return;
    this.notes = (this.notes ?? '') + text;
  }
}

interface Harness {
  tui: FakeTraexQuestions;
  bridge: TraexQuestionBridge;
  asks: Array<{ question: AskQuestion; signal: AbortSignal; answer: (result: AskResult) => void; fail: (error: Error) => void }>;
  notices: TraexQuestionNoticeKey[];
  logs: string[];
  state: {
    enabled: boolean;
    lifetime: number;
    screen?: () => string | undefined;
    beforeCapture?: () => void;
    /** The terminal refuses this input (returns false, writes nothing). */
    refuse?: (input: string) => boolean;
    /** This key takes effect only after a lag. */
    keyLagMs?: (key: string) => number | undefined;
  };
}

function harness(questions: Question[]): Harness {
  const tui = new FakeTraexQuestions(questions);
  const asks: Harness['asks'] = [];
  const notices: TraexQuestionNoticeKey[] = [];
  const logs: string[] = [];
  const state: Harness['state'] = { enabled: true, lifetime: 1 };
  const bridge = new TraexQuestionBridge({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    enabled: () => state.enabled,
    lifetime: () => state.lifetime,
    capture: async () => {
      state.beforeCapture?.();
      return state.screen ? state.screen() : tui.screen();
    },
    ask: (question, signal) => new Promise<AskResult>((resolve, reject) => {
      asks.push({ question, signal, answer: resolve, fail: reject });
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    writeKey: async key => {
      if (state.refuse?.(key)) return false;
      const lag = state.keyLagMs?.(key);
      if (lag) setTimeout(() => tui.key(key), lag);
      else tui.key(key);
      return true;
    },
    paste: async text => {
      if (state.refuse?.(`paste:${text}`)) return false;
      tui.paste(text);
      return true;
    },
    notify: key => { notices.push(key); },
    log: message => { logs.push(message); },
  });
  return { tui, bridge, asks, notices, logs, state };
}

const answered = (answers: string[], extra: Partial<Extract<AskResult, { kind: 'answered' }>> = {}): AskResult => ({
  kind: 'answered', answers: [answers], by: 'ou_x', comment: null, timedOut: false, ...extra,
});

const DB: Question = { prompt: 'Which database should the new service use?', options: ['PostgreSQL (Recommended)', 'MySQL', 'SQLite'] };
const DEPLOY: Question = { prompt: 'Where should it be deployed first?', options: ['Staging (Recommended)', 'Production'] };
/** traecli 0.214.1's "Submit with unanswered questions?" page (real capture). */
const CONFIRM = readFileSync(new URL('./fixtures/traex-question/traex-0.214.1-submit-confirm-160x50.txt', import.meta.url), 'utf8');
const FEATURES: Question = { prompt: 'Which features do you want to enable?', options: ['Caching', 'Metrics', 'Tracing'], multiSelect: true };

/** Kick and let the page settle until a card is out. */
async function raiseCard(h: Harness): Promise<void> {
  const before = h.asks.length;
  h.bridge.kick();
  await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_STABLE_MS * 2 + 400);
  expect(h.asks.length).toBe(before + 1);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('TraexQuestionBridge', () => {
  it('raises one card per question once the page is stable, and enters the chosen option with its digit', async () => {
    const h = harness([DB]);
    await raiseCard(h);
    expect(h.asks[0]!.question).toMatchObject({
      prompt: 'Which database should the new service use?',
      options: [{ key: '1', label: 'PostgreSQL (Recommended)' }, { key: '2', label: 'MySQL' }, { key: '3', label: 'SQLite' }],
    });
    // Kicks and polls while the card is out raise nothing more.
    h.bridge.kick();
    await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_POLL_MS * 3);
    expect(h.asks).toHaveLength(1);
    h.asks[0]!.answer(answered(['2']));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.tui.inputs).toEqual(['2']);
    expect(h.tui.answers).toEqual(['1:MySQL']);
    expect(h.notices).toEqual([]);
    expect(h.bridge.hasOpenCard()).toBe(false);
  });

  it('a page seen only once (mid-redraw) raises no card', async () => {
    const h = harness([DB]);
    let frames = 0;
    h.state.screen = () => (frames++ === 0 ? h.tui.screen() : '❯ \n  model · Context 99% left');
    h.bridge.kick();
    await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_STABLE_MS * 4);
    expect(h.asks).toHaveLength(0);
  });

  it('answers a batch question by question, each on its own card', async () => {
    const h = harness([DB, DEPLOY]);
    await raiseCard(h);
    expect(h.asks[0]!.question.prompt).toBe('(1/2) Which database should the new service use?');
    h.asks[0]!.answer(answered(['1']));
    await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_STABLE_MS * 2 + 1_000);
    expect(h.asks).toHaveLength(2);
    expect(h.asks[1]!.question.prompt).toBe('(2/2) Where should it be deployed first?');
    h.asks[1]!.answer(answered(['2']));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.tui.answers).toEqual(['1:PostgreSQL (Recommended)', '2:Production']);
  });

  it('enters a custom answer as a note on "None of the above": move, Tab, paste, Enter — each re-checked', async () => {
    const h = harness([DB]);
    await raiseCard(h);
    h.asks[0]!.answer(answered([], { customAnswers: ['用 TiDB，兼容 MySQL 协议'] }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.tui.inputs).toEqual(['Up', 'Tab', 'paste:用 TiDB，兼容 MySQL 协议', 'Enter']);
    expect(h.tui.answers).toEqual(['1:None of the above+note:用 TiDB，兼容 MySQL 协议']);
  });

  it('ticks exactly the chosen boxes on a multiSelect question', async () => {
    const h = harness([FEATURES]);
    await raiseCard(h);
    expect(h.asks[0]!.question.multiSelect).toBe(true);
    h.asks[0]!.answer(answered(['3', '1']));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.tui.inputs).toEqual(['1', '3', 'Enter']);
    expect(h.tui.answers).toEqual(['1:Caching,Tracing']);
  });

  it('withdraws the card when the question leaves the screen (answered or interrupted in the terminal)', async () => {
    const h = harness([DB]);
    await raiseCard(h);
    h.tui.key('3'); // answered in the Web terminal
    await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_GONE_MS + TRAEX_QUESTION_POLL_MS * 2);
    expect(h.asks[0]!.signal.aborted).toBe(true);
    // A late click on the withdrawn card enters nothing.
    h.asks[0]!.answer(answered(['2']));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.tui.inputs).toEqual(['3']);
    expect(h.tui.answers).toEqual(['1:SQLite']);
  });

  it('a card answered after the page changed is dropped, never typed into the new page', async () => {
    const h = harness([DB, DEPLOY]);
    await raiseCard(h);
    // The terminal moves on to question 2 between the click and the write.
    h.state.beforeCapture = () => {
      if (h.tui.index === 0) h.tui.key('1');
    };
    h.asks[0]!.answer(answered(['2']));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.tui.inputs).toEqual(['1']);
    expect(h.tui.answers).toEqual(['1:PostgreSQL (Recommended)']);
    expect(h.notices).toEqual(['worker.traex_question.not_written']);
  });

  it('a card answered after the CLI was replaced is dropped', async () => {
    const h = harness([DB]);
    await raiseCard(h);
    h.state.beforeCapture = () => { h.state.lifetime = 2; };
    h.asks[0]!.answer(answered(['2']));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.tui.inputs).toEqual([]);
    expect(h.notices).toEqual(['worker.traex_question.not_written']);
  });

  it('never types over notes someone else is writing', async () => {
    const h = harness([DB]);
    await raiseCard(h);
    h.tui.key('Tab');
    h.tui.paste('typed in the terminal');
    h.asks[0]!.answer(answered(['2']));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.tui.inputs).toEqual(['Tab', 'paste:typed in the terminal']);
    expect(h.tui.answers).toEqual([]);
    expect(h.notices).toEqual(['worker.traex_question.not_written']);
  });

  it('a card that cannot be raised is reported once, and that question is not retried', async () => {
    const h = harness([DB]);
    await raiseCard(h);
    h.asks[0]!.fail(new Error('requestUserInput daemon is offline'));
    await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_POLL_MS * 5);
    expect(h.notices).toEqual(['worker.traex_question.card_unavailable']);
    expect(h.asks).toHaveLength(1);
    // A new CLI lifetime may try again.
    h.bridge.reset('CLI respawned');
    h.state.lifetime = 2;
    await raiseCard(h);
  });

  it('does nothing on a session that is not on the terminal path, and reset withdraws the card', async () => {
    const off = harness([DB]);
    off.state.enabled = false;
    off.bridge.kick();
    await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_STABLE_MS * 4);
    expect(off.asks).toHaveLength(0);

    const h = harness([DB]);
    await raiseCard(h);
    h.bridge.reset('CLI stopped');
    expect(h.asks[0]!.signal.aborted).toBe(true);
  });

  it('an answer that stops halfway closes the notes field it opened, so the next card still works', async () => {
    const h = harness([DB]);
    await raiseCard(h);
    h.state.refuse = input => input.startsWith('paste:');
    h.asks[0]!.answer(answered([], { customAnswers: ['用 TiDB'] }));
    await vi.advanceTimersByTimeAsync(3_000);
    // Up, Tab (opens), the refused paste, Tab (closes again).
    expect(h.tui.inputs).toEqual(['Up', 'Tab', 'Tab']);
    expect(h.tui.notes).toBeUndefined();
    expect(h.notices).toEqual(['worker.traex_question.write_failed']);
    // The page is as it was: a new card, and an option on it goes in.
    h.state.refuse = undefined;
    await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_STABLE_MS * 2 + 400);
    expect(h.asks).toHaveLength(2);
    h.asks[1]!.answer(answered(['2']));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.tui.answers).toEqual(['1:MySQL']);
  });

  it('a pane too short to show the notes row: closes it again and says why', async () => {
    const h = harness([DB]);
    h.tui.hideNotes = true;
    await raiseCard(h);
    h.asks[0]!.answer(answered([], { customAnswers: ['用 TiDB'] }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.tui.inputs).toEqual(['Up', 'Tab', 'Tab']);
    expect(h.tui.notes).toBeUndefined();
    expect(h.tui.answers).toEqual([]);
    expect(h.notices).toEqual(['worker.traex_question.notes_hidden']);
  });

  it('never closes notes that hold someone else\'s text', async () => {
    const h = harness([DB]);
    await raiseCard(h);
    h.state.beforeCapture = () => {
      // Someone types into the notes right after this answer's Tab.
      if (h.tui.notes === '' && h.tui.inputs.at(-1) === 'Tab') h.tui.paste('mine');
    };
    h.asks[0]!.answer(answered([], { customAnswers: ['用 TiDB'] }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.tui.inputs).toEqual(['Up', 'Tab', 'paste:mine']);
    expect(h.tui.notes).toBe('mine');
    expect(h.notices).toEqual(['worker.traex_question.not_written']);
  });

  it('a question whose card expired is carded again when it is asked again later', async () => {
    const h = harness([DB]);
    await raiseCard(h);
    h.asks[0]!.answer({ kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true });
    await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_POLL_MS * 3);
    expect(h.notices).toEqual(['worker.traex_question.card_expired']);
    expect(h.asks).toHaveLength(1);
    // Answered in the terminal; the agent later asks the very same question.
    h.tui.key('1');
    await vi.advanceTimersByTimeAsync(12_000);
    h.tui.index = 0;
    await raiseCard(h);
  });

  it('a card the daemon ended (not withdrawn here) is reported', async () => {
    const h = harness([DB]);
    await raiseCard(h);
    h.asks[0]!.answer({ kind: 'invalidated', reason: 'session closed', selected: null, by: null, comment: null, timedOut: false });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.notices).toEqual(['worker.traex_question.card_unavailable']);
  });

  it('a question page whose options cannot be read raises no card but says so once', async () => {
    const h = harness([DB]);
    // What a display snapshot keeps: the chrome, not the option columns.
    h.state.screen = () => h.tui.screen().split('\n').map(row => row.replace(/ {2,}/g, ' ')).join('\n');
    h.bridge.kick();
    await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_POLL_MS * 5);
    expect(h.asks).toHaveLength(0);
    expect(h.notices).toEqual(['worker.traex_question.unreadable']);
  });

  it('a Tab that takes effect late is still closed again when the answer gives up', async () => {
    const h = harness([DB]);
    await raiseCard(h);
    h.state.keyLagMs = key => (key === 'Tab' ? 2_700 : undefined);
    h.asks[0]!.answer(answered([], { customAnswers: ['用 TiDB'] }));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.tui.notes).toBeUndefined();
    expect(h.notices).toEqual(['worker.traex_question.write_failed']);
    h.state.keyLagMs = undefined;
    await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_STABLE_MS * 2 + 400);
    h.asks.at(-1)!.answer(answered(['2']));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.tui.answers).toEqual(['1:MySQL']);
  });

  it('a page must look the same for the whole stable window before its card goes out', async () => {
    const h = harness([DB]);
    h.bridge.kick();
    await vi.advanceTimersByTimeAsync(200);
    // A second look well inside the window (a kick from the next PTY chunk).
    h.bridge.kick();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.asks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_STABLE_MS * 2);
    expect(h.asks).toHaveLength(1);
  });

  it('another question taking the screen withdraws the open card before carding the new one', async () => {
    const h = harness([DB, DEPLOY]);
    await raiseCard(h);
    h.tui.key('1'); // question 1 answered in the Web terminal: question 2 is up
    await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_POLL_MS + TRAEX_QUESTION_STABLE_MS * 2 + 400);
    expect(h.asks[0]!.signal.aborted).toBe(true);
    expect(h.asks).toHaveLength(2);
    expect(h.asks[1]!.question.prompt).toBe('(2/2) Where should it be deployed first?');
    expect(h.asks[1]!.signal.aborted).toBe(false);
  });

  it('a card left open when the CLI is replaced is withdrawn on the next look', async () => {
    const h = harness([DB]);
    await raiseCard(h);
    h.state.lifetime = 2;
    h.bridge.kick();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.asks[0]!.signal.aborted).toBe(true);
  });

  it('a page that leaves mid-answer is reported, not taken for an entered answer', async () => {
    const h = harness([DB]);
    await raiseCard(h);
    // Interrupted in the terminal right after the answer's first key (Up).
    h.state.beforeCapture = () => {
      if (h.tui.inputs.length === 1) h.state.screen = () => '❯ \n  model · /tmp/repo · Context 99% left';
    };
    h.asks[0]!.answer(answered([], { customAnswers: ['用 TiDB'] }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.tui.inputs).toEqual(['Up']);
    expect(h.notices).toEqual(['worker.traex_question.not_written']);
    expect(h.logs.some(line => line.includes('card answer entered'))).toBe(false);
  });

  it('a final key that leaves the page on the same question is never pressed again', async () => {
    const h = harness([FEATURES]);
    await raiseCard(h);
    // TRAE takes the Enter without moving on, but its pointer moves.
    const key = h.tui.key.bind(h.tui);
    h.tui.key = k => {
      if (k !== 'Enter') return key(k);
      h.tui.inputs.push(k);
      h.tui.pointer = 2;
    };
    h.asks[0]!.answer(answered(['1']));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.tui.inputs).toEqual(['1', 'Enter']);
    expect(h.notices).toEqual(['worker.traex_question.not_confirmed']);
  });

  it('the unreadable-page notice is said once per appearance, however often the worker looks', async () => {
    const h = harness([DB]);
    h.state.screen = () => h.tui.screen().split('\n').map(row => row.replace(/ {2,}/g, ' ')).join('\n');
    for (let i = 0; i < 6; i++) {
      h.bridge.kick(); // the worker's screen tick keeps kicking while the page is up
      await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_POLL_MS);
    }
    expect(h.asks).toHaveLength(0);
    expect(h.notices).toEqual(['worker.traex_question.unreadable']);
  });

  it('the "Submit with unanswered questions?" confirmation raises no card and no unreadable notice', async () => {
    const h = harness([DB]);
    h.state.screen = () => CONFIRM;
    for (let i = 0; i < 4; i++) {
      h.bridge.kick();
      await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_POLL_MS);
    }
    expect(h.asks).toHaveLength(0);
    expect(h.notices).toEqual([]);
  });

  it('a question re-asked a few seconds after it left is carded again', async () => {
    const h = harness([DB]);
    await raiseCard(h);
    h.asks[0]!.answer({ kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true });
    await vi.advanceTimersByTimeAsync(500);
    h.tui.key('1');
    // The worker kicks the bridge when the page leaves the screen.
    h.bridge.kick();
    await vi.advanceTimersByTimeAsync(3_000);
    h.tui.index = 0;
    h.bridge.kick();
    await vi.advanceTimersByTimeAsync(TRAEX_QUESTION_STABLE_MS * 2 + 400);
    expect(h.asks, h.logs.join('\n')).toHaveLength(2);
  });
});
