/**
 * Antigravity CLI (`agy`) hook adapter.
 *
 * agy runs `hooks.json` PreToolUse handlers before every tool step (main agent
 * and subagents alike) and blocks the agent loop until the handler exits. The
 * hook botmux installs (hook-installer `antigravity-hooks`) matches only the
 * `ask_question` tool. Payload (camelCase protojson, verified on 1.5.12;
 * `hookEventName` is sent from 1.5.4 on):
 *
 *   {
 *     hookEventName: 'PreToolUse',
 *     toolCall: {
 *       id: '…', name: 'ask_question',
 *       args: { questions: [{ question, options: string[], is_multi_select? }] },
 *     },
 *     conversationId, stepIdx, …
 *   }
 *
 * agy's own picker numbers the options and adds a "Write-in..." row; a
 * recommended option arrives first, prefixed with "(Recommended)".
 *
 * Writing the answer back: the PreToolUse contract has no way to supply a
 * tool result (`overwrite` only rewrites the call's arguments, and the
 * question tool would still open its picker). What reaches the model is the
 * `reason` of a `deny` decision — agy hands it over as the ask_question result
 * `Encountered error in tool execution: tool call denied by pre-tool hook:
 * <reason>` and never draws the picker. So the user's answer travels in that
 * reason, in the same `A1: …` lines agy's own picker returns, preceded by a
 * sentence telling the model it is an answer, not a failure.
 *
 * Measured stdout semantics (agy 1.5.12):
 *   - empty stdout, exit 0 → no decision: the tool runs, agy draws its picker
 *     (the passthrough);
 *   - `{}` → an empty decision, which agy treats as a DENY with an empty
 *     reason — never emit it;
 *   - non-zero exit, invalid JSON, or the hook's timeout (SIGKILL) → the tool
 *     call fails with the hook error (hence the guarded install command).
 */

import type { AskQuestion } from '../ask-types.js';
import type { HookAskAdapter, ParsedAsk, UnansweredAsk } from './types.js';

const TOOL_NAME = 'ask_question';

interface AgyQuestion {
  question: string;
  options: string[];
  multiSelect: boolean;
}

function agyQuestions(payload: unknown): AgyQuestion[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  // Releases before 1.5.4 sent no hookEventName; the install only registers
  // this hook for PreToolUse, so a missing name still means PreToolUse.
  if (p.hookEventName !== undefined && p.hookEventName !== 'PreToolUse') return null;
  const call = p.toolCall;
  if (!call || typeof call !== 'object') return null;
  const c = call as Record<string, unknown>;
  if (c.name !== TOOL_NAME) return null;
  const args = c.args;
  if (!args || typeof args !== 'object') return null;
  const raw = (args as Record<string, unknown>).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: AgyQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') return null;
    const qq = q as Record<string, unknown>;
    if (typeof qq.question !== 'string' || !qq.question.trim()) return null;
    if (!Array.isArray(qq.options) || qq.options.length < 2) return null;
    if (!qq.options.every(option => typeof option === 'string')) return null;
    out.push({ question: qq.question, options: qq.options as string[], multiSelect: qq.is_multi_select === true });
  }
  return out;
}

/** The card's option keys are positions ("1", "2", …): agy does not dedupe
 *  option strings, and a repeated key would make the daemon reject the whole
 *  card (and with it the question). */
function optionKey(index: number): string {
  return String(index + 1);
}

/** One answer line per question, as agy's own picker reports them
 *  (`A1: SQLite`, `A2: Auth, Search, also audit logs`, `A1: User Skipped`). */
function answerLines(
  questions: ReadonlyArray<AskQuestion>,
  answersByQuestion: ReadonlyArray<ReadonlyArray<string>>,
  comment: string | null | undefined,
  customAnswers: ReadonlyArray<string | null> | undefined,
): string[] {
  const customText = (comment ?? '').trim();
  return questions.map((q, i) => {
    // A per-question typed answer replaces that question's picks (AskResult
    // contract); a whole-card text reply stands in for unanswered questions.
    const custom = customAnswers?.[i]?.trim();
    const labels = (answersByQuestion[i] ?? []).map(key => q.options.find(o => o.key === key)?.label ?? key);
    const answer = custom || (labels.length > 0 ? labels.join(', ') : customText || 'User Skipped');
    return `A${i + 1}: ${answer.replace(/\r\n?/g, '\n')}`;
  });
}

function deny(reason: string): string {
  return JSON.stringify({ decision: 'deny', reason });
}

/** Model-facing; agy prefixes it with its "tool call denied by pre-tool hook" wording. */
const ANSWERED_PREAMBLE =
  'botmux showed these questions to the user in Lark/Feishu instead of the terminal picker, and the user answered there. '
  + 'This is the answer to your ask_question call, not a failure — continue with it:';

const antigravityAdapter: HookAskAdapter = {
  parseQuestions(payload: unknown): ParsedAsk | null {
    const raw = agyQuestions(payload);
    if (!raw) return null;
    const questions: AskQuestion[] = raw.map(q => ({
      prompt: q.question,
      multiSelect: q.multiSelect,
      options: q.options.map((label, i) => ({ key: optionKey(i), label })),
    }));
    return { questions, raw: payload };
  },

  formatAnswer(answersByQuestion, parsed, comment, customAnswers): string {
    return deny([ANSWERED_PREAMBLE, ...answerLines(parsed.questions, answersByQuestion, comment, customAnswers)].join('\n'));
  },

  formatUnanswered(outcome: UnansweredAsk): string {
    // The session is routed to Lark: a terminal picker now would wait on a
    // screen nobody watches, so the question ends here with the reason.
    if (outcome.kind === 'timedOut') {
      const minutes = Math.max(1, Math.round(outcome.timeoutMs / 60_000));
      return deny(
        `botmux showed these questions to the user in Lark/Feishu, but nobody answered within ${minutes} min, so they were withdrawn. `
        + 'Do not assume an answer: continue with what you can do without it, or ask the user again in your reply.',
      );
    }
    if (outcome.kind === 'invalidated' && outcome.failureCode !== 'card_delivery_failed') {
      return deny(
        `botmux showed these questions to the user in Lark/Feishu, but the question card was withdrawn before anyone answered (${outcome.reason}). `
        + 'Do not assume an answer: ask the user again in your reply if you still need it.',
      );
    }
    return deny(
      'botmux could not deliver these questions to the user in Lark/Feishu, and the user cannot see the terminal question picker. '
      + 'Ask the user the same questions in plain text in your reply instead.',
    );
  },

  passthrough(): string {
    // No decision: agy runs the tool and draws its own picker (standalone agy,
    // or a session botmux does not route). Never `{}` — agy denies on that.
    return '';
  },
};

export default antigravityAdapter;
