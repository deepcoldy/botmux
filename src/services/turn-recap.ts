/**
 * Content of the「本轮回顾」panel on a turn's last reply card.
 *
 * Sources, cheapest first:
 *   - the CLI's own recap: Claude Code writes an away summary into its
 *     transcript (`type:"system", subtype:"away_summary"`) when the session
 *     has sat idle for a few minutes after a turn — no call by botmux;
 *   - facts from the turn's tool calls (files edited, commands run), recorded
 *     by the worker from the activity every CLI already reports (RecapRecorder);
 *   - optionally, a one-off small-model recap (its own switch, see
 *     recapModelPrompt) when the CLI wrote none.
 */
import type { CotEntry } from '../types.js';
import { subjectFromArgsString } from './cot-subject.js';

export interface RecapFacts {
  /** Files the turn edited, in first-edit order, displayed relative to the session directory. */
  files: string[];
  /** How many commands the turn ran. */
  commands: number;
  /** The last of them. */
  lastCommand?: string;
}

/** What a turn did, as recorded by the worker: the facts for the panel and the
 * latest activity for the optional model recap. */
export interface RecapTurnInput {
  facts: RecapFacts;
  /** The latest activity lines (assistant text and tool-call titles, never
   * tool output or thinking), oldest first. */
  activity: string[];
  /** Earlier activity lines left out to stay within the budget. */
  omitted: number;
}

export interface RecapSources {
  /** The CLI's own recap text. */
  cli?: string;
  /** A recap written by the optional model call. */
  model?: string;
  facts?: RecapFacts;
}

/** Claude Code appends this to its first few away summaries. */
const AWAY_SUMMARY_HINT_RE = /\s*\((?:disable recaps in \/config)\)\s*$/i;

/** The text of a Claude Code away-summary transcript record, else undefined. */
export function claudeAwaySummaryText(event: unknown): string | undefined {
  const record = event as { type?: unknown; subtype?: unknown; content?: unknown; isSidechain?: unknown } | null;
  if (!record || record.type !== 'system' || record.subtype !== 'away_summary' || record.isSidechain === true) return undefined;
  if (typeof record.content !== 'string') return undefined;
  const text = record.content.replace(AWAY_SUMMARY_HINT_RE, '').trim();
  return text || undefined;
}

export interface CliRecap {
  text: string;
  turnId: string;
  dispatchAttempt?: number;
}

/**
 * Picks the CLI's own recap out of newly drained transcript records, for the
 * turn the CLI was last given input for. Claude Code writes its away summary
 * minutes into an idle session, so one written before that turn's input
 * reached the CLI recaps an earlier turn and is dropped; each record is
 * reported at most once.
 */
export class CliRecapObserver {
  private readonly seen = new Set<string>();
  private turn?: { turnId: string; dispatchAttempt?: number; sinceMs: number };

  observe(
    events: readonly unknown[],
    current: { turnId?: string; dispatchAttempt?: number },
    nowMs: number,
  ): CliRecap | undefined {
    if (current.turnId !== this.turn?.turnId || current.dispatchAttempt !== this.turn?.dispatchAttempt) {
      // First seen now, so never earlier than the input that started it.
      this.turn = current.turnId
        ? { turnId: current.turnId, ...(current.dispatchAttempt !== undefined ? { dispatchAttempt: current.dispatchAttempt } : {}), sinceMs: nowMs }
        : undefined;
    }
    let found: CliRecap | undefined;
    for (const event of events) {
      const text = claudeAwaySummaryText(event);
      if (!text) continue;
      const { uuid, timestamp } = event as { uuid?: unknown; timestamp?: unknown };
      if (typeof uuid === 'string') {
        if (this.seen.has(uuid)) continue;
        this.seen.add(uuid);
        if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
      }
      if (!this.turn) continue;
      // Claude Code abandons a summary still being written once new input
      // starts a turn (2.1.325), so one written after that input is this turn's.
      const writtenAt = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
      if (!Number.isFinite(writtenAt) || writtenAt < this.turn.sinceMs) continue;
      found = {
        text,
        turnId: this.turn.turnId,
        ...(this.turn.dispatchAttempt !== undefined ? { dispatchAttempt: this.turn.dispatchAttempt } : {}),
      };
    }
    return found;
  }
}

const EDIT_TOOL_RE = /^(?:edit|multiedit|write|notebookedit|apply_patch|str_replace_based_edit_tool|edit_file|write_file)$/i;
/** Same command family the reply card's activity panel marks with 💻. */
const COMMAND_TOOL_RE = /bash|shell|command|(^|[^a-z])exec([^a-z]|$)/i;

function displayPath(path: string, workingDir?: string): string {
  const root = workingDir?.replace(/\/+$/, '');
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}

/** Files kept per turn (the panel names six); a turn that edits more still
 * shows the first ones. Paths and commands are bounded like activity lines,
 * so one report stays a few tens of KB at most. */
const MAX_FILES_RECORDED = 100;
const MAX_ACTIVITY_LINE_CHARS = 2_000;
const MAX_FACT_CHARS = 500;

/** Budget for the turn record sent to the model (about 8k tokens). */
export const RECAP_MODEL_INPUT_MAX_CHARS = 24_000;
const MAX_REQUEST_CHARS = 4_000;
/** What is left of the budget for activity once the request is in. */
const ACTIVITY_BUDGET_CHARS = RECAP_MODEL_INPUT_MAX_CHARS - MAX_REQUEST_CHARS - 200;

/**
 * One turn's facts and latest activity, accumulated as its activity arrives.
 * Separate from the reply card's activity buffer, which stops growing at its
 * display cap: a long turn's last edits and commands are what the recap is
 * about, so every tool call counts here and the activity keeps its tail.
 */
export class RecapRecorder {
  private readonly files: string[] = [];
  private commands = 0;
  private lastCommand?: string;
  private readonly activity: string[] = [];
  private activityChars = 0;
  private omitted = 0;

  /** Runs in front of the reply card's own activity handling, so a malformed
   * entry is skipped here rather than allowed to throw. */
  observe(entries: readonly CotEntry[]): void {
    for (const entry of entries) {
      if (entry.kind === 'text' && typeof entry.text === 'string' && entry.text.trim()) {
        this.record(`Assistant: ${entry.text.trim()}`);
      } else if (entry.kind === 'tool_call' && typeof entry.name === 'string') {
        const subject = (typeof entry.subject === 'string' && entry.subject
          ? entry.subject : subjectFromArgsString(typeof entry.args === 'string' ? entry.args : '')).trim();
        this.record(`Tool ${entry.name}${subject ? `: ${subject}` : ''}`);
        if (!subject) continue;
        const fact = subject.length > MAX_FACT_CHARS ? `${subject.slice(0, MAX_FACT_CHARS - 1)}…` : subject;
        if (EDIT_TOOL_RE.test(entry.name)) {
          if (!this.files.includes(fact) && this.files.length < MAX_FILES_RECORDED) this.files.push(fact);
        } else if (COMMAND_TOOL_RE.test(entry.name.toLowerCase())) {
          this.commands += 1;
          this.lastCommand = fact;
        }
      }
    }
  }

  private record(line: string): void {
    const bounded = line.length > MAX_ACTIVITY_LINE_CHARS ? `${line.slice(0, MAX_ACTIVITY_LINE_CHARS - 1)}…` : line;
    this.activity.push(bounded);
    this.activityChars += bounded.length + 1;
    while (this.activityChars > ACTIVITY_BUDGET_CHARS && this.activity.length > 1) {
      this.activityChars -= this.activity.shift()!.length + 1;
      this.omitted += 1;
    }
  }

  get empty(): boolean {
    return this.activity.length === 0;
  }

  input(workingDir?: string): RecapTurnInput {
    return {
      facts: {
        files: this.files.map(file => displayPath(file, workingDir)),
        commands: this.commands,
        ...(this.lastCommand !== undefined ? { lastCommand: this.lastCommand } : {}),
      },
      activity: [...this.activity],
      omitted: this.omitted,
    };
  }
}

/** The recorder of the turn whose activity arrived last; a new turn starts a new one. */
export class TurnRecapRecorder {
  private current?: { turnId: string; dispatchAttempt?: number; recorder: RecapRecorder };

  observe(turn: { turnId: string; dispatchAttempt?: number }, entries: readonly CotEntry[]): void {
    if (entries.length === 0) return;
    if (this.current?.turnId !== turn.turnId || this.current.dispatchAttempt !== turn.dispatchAttempt) {
      this.current = { turnId: turn.turnId, ...(turn.dispatchAttempt !== undefined ? { dispatchAttempt: turn.dispatchAttempt } : {}), recorder: new RecapRecorder() };
    }
    this.current.recorder.observe(entries);
  }

  /** What the turn did, while it is still the latest one with activity. */
  input(turn: { turnId: string; dispatchAttempt?: number }, workingDir?: string): RecapTurnInput | undefined {
    const current = this.current;
    if (!current || current.turnId !== turn.turnId || current.dispatchAttempt !== turn.dispatchAttempt || current.recorder.empty) return undefined;
    return current.recorder.input(workingDir);
  }
}

const MAX_FILES_SHOWN = 6;
const MAX_INLINE_CHARS = 120;

function inline(text: string, max = MAX_INLINE_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  const bounded = chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
  // Shown as inline code, which the card renders literally (entities are not
  // decoded there, so nothing is escaped): it only cannot hold a backtick, and
  // mention markup is removed outright.
  return bounded.replace(/`/g, "'").replace(/<\/?at\b[^>]*>/gi, '[mention]');
}

function prose(text: string): string {
  // Model/CLI prose rendered as card markdown: never a live mention, image or
  // tag. Mention markup is removed outright (not only escaped), opening and
  // closing tags alike, so no form of it survives into the card.
  // `&` goes first (as in escapeLarkMd): an entity-encoded tag in the text
  // stays text instead of becoming markup when the card decodes entities.
  return text.trim()
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '[mention]')
    .replace(/<\/?at\b[^>]*>/gi, '[mention]')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Markdown for the panel body, or undefined when there is nothing to show. */
export function renderRecapMarkdown(sources: RecapSources, locale?: 'zh' | 'en'): string | undefined {
  const en = locale === 'en';
  const parts: string[] = [];
  const summary = sources.cli ?? sources.model;
  if (summary?.trim()) {
    parts.push(prose(summary));
    parts.push(`<font color='grey'>${sources.cli
      ? (en ? 'Recap written by the CLI' : '来自 CLI 自带的离开总结')
      : (en ? 'Recap written by a small model' : '由小模型生成的回顾')}</font>`);
  }
  const facts = sources.facts;
  const lines: string[] = [];
  if (facts?.files.length) {
    const shown = facts.files.slice(0, MAX_FILES_SHOWN).map(file => `\`${inline(file, 80)}\``).join(en ? ', ' : '、');
    const more = facts.files.length > MAX_FILES_SHOWN ? (en ? ` and ${facts.files.length - MAX_FILES_SHOWN} more` : ` 等`) : '';
    lines.push(en ? `- Edited ${facts.files.length} file${facts.files.length === 1 ? '' : 's'}: ${shown}${more}`
      : `- 改了 ${facts.files.length} 个文件：${shown}${more}`);
  }
  if (facts?.commands && facts.lastCommand) {
    const last = `\`${inline(facts.lastCommand)}\``;
    lines.push(en ? `- Ran ${facts.commands} command${facts.commands === 1 ? '' : 's'}, the last: ${last}`
      : `- 跑了 ${facts.commands} 条命令，最后一条：${last}`);
  }
  if (lines.length) parts.push(`**${en ? 'What was done' : '做了什么'}**\n${lines.join('\n')}`);
  return parts.length ? parts.join('\n\n') : undefined;
}

/** Instructions for the optional model recap. The answer is shown verbatim. */
export const RECAP_MODEL_SYSTEM_PROMPT = [
  'You write a short recap of one turn of a coding-assistant session for a person who stepped away.',
  'Cover: what was done, what is still unfinished or blocked, and the next step.',
  'At most three sentences and 300 characters, plain text, no headings or lists.',
  'Reply with the recap itself only: no preamble, no restating these instructions.',
  'Write in the language named on the first line of the input. Do not invent anything that the record does not show.',
].join(' ');

/** The turn record for the optional model recap: the request and the turn's
 * latest activity (RecapRecorder). Undefined when the turn left no activity:
 * a request alone would only invite a recap of work never done. */
export function recapModelPrompt(input: { userPrompt?: string; turn: RecapTurnInput; locale?: 'zh' | 'en' }): string | undefined {
  if (input.turn.activity.length === 0) return undefined;
  // The card around the recap is in the bot's language; a turn's "request"
  // may be a task notification in another one.
  const language = `Language: ${input.locale === 'en' ? 'English' : 'Simplified Chinese'}\n\n`;
  const request = input.userPrompt?.trim() ? `User request:\n${input.userPrompt.trim().slice(0, MAX_REQUEST_CHARS)}\n\n` : '';
  const omitted = input.turn.omitted ? ` (earliest ${input.turn.omitted} entries omitted)` : '';
  return `${language}${request}Turn record${omitted}:\n${input.turn.activity.join('\n')}`;
}

export interface RecapModelResult {
  text: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** `claude -p --output-format json` → the recap, or why there is none. */
export function parseRecapModelOutput(stdout: string): RecapModelResult | { error: string } {
  let parsed: any;
  try { parsed = JSON.parse(stdout.trim()); } catch { return { error: stdout.trim() ? 'output is not JSON' : 'no output' }; }
  if (parsed?.is_error === true) {
    return { error: typeof parsed.result === 'string' && parsed.result.trim() ? parsed.result.trim().slice(0, 200) : 'error result' };
  }
  if (!parsed || typeof parsed.result !== 'string') return { error: 'no result' };
  // Asked for plain text; a small model still sometimes opens with a heading.
  const text = parsed.result.split('\n').filter((line: string) => !/^\s*#{1,6}\s/.test(line)).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return { error: 'empty result' };
  const usage = parsed.usage ?? {};
  const input = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    .map(key => usage[key]).filter((n): n is number => typeof n === 'number');
  return {
    text: [...text].slice(0, 600).join(''),
    ...(typeof parsed.total_cost_usd === 'number' ? { costUsd: parsed.total_cost_usd } : {}),
    ...(input.length ? { inputTokens: input.reduce((a, b) => a + b, 0) } : {}),
    ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
  };
}
