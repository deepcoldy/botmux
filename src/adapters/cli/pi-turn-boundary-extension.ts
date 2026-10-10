/**
 * Pi turn-boundary extension.
 *
 * ## Why this exists
 *
 * Pi is an agent-loop CLI: its `stopReason` describes ONE model request, not
 * the user turn. When a provider request fails transiently, Pi persists an
 * assistant record with `stopReason:"error"` and then RETRIES inside the same
 * turn — `agent-session.ts` even strips that record from the LLM context while
 * deliberately keeping it in the session file ("Remove error message from agent
 * state (keep in session for history)"). So a mid-turn `error` record is a
 * historical breadcrumb, not a verdict.
 *
 * Reading those records as turn terminals made Botmux post a "model gateway
 * failure" card — and @mention a human — for turns that went on to succeed.
 * Measured over 231 real local sessions: 229 of 339 `error` records (67.6%)
 * were followed by the SAME turn continuing.
 *
 * Neither the error text nor the record shape separates the two cases (the
 * identical "EOF wait read" string appears 34x continuing and 1x ending; the
 * field sets are byte-identical). Only Pi itself knows, and it already says so:
 * `agent_settled` fires exactly once, after the whole retry / compaction /
 * queued-continuation loop drains.
 *
 * ## What it writes
 *
 * On `agent_settled` we append ONE `custom` entry to Pi's own session JSONL —
 * the very file the Botmux bridge already tails:
 *
 *   {"type":"custom","customType":"botmux-turn-settled","data":{"lastStopReason":"error"}}
 *
 * In-band placement is the point: the entry is ordered AFTER the assistant
 * records of the turn it closes, so the reader never has to correlate two files
 * by timestamp or worry about cross-file write races. `lastStopReason` is the
 * stop reason of the last assistant message of the last agent run — `"error"`
 * means the turn really ended in failure, anything else means it recovered.
 *
 * Custom entries never enter LLM context (`sessionEntryToContextMessages`
 * returns [] for them), so this cannot perturb the model.
 *
 * Loaded per-invocation via `--extension`, so it applies ONLY to Pi processes
 * Botmux spawns — a Pi the user starts by hand in a terminal is unaffected.
 */

export const PI_TURN_BOUNDARY_CUSTOM_TYPE = 'botmux-turn-settled';

/** Value written when the settled turn's last agent run ended in a provider
 *  error. The reader treats exactly this value as "report the failure". */
export const PI_TURN_BOUNDARY_STOP_REASON_ERROR = 'error';

import { existsSync, readFileSync } from 'node:fs';

export interface PiTurnBoundaryEntryData {
  /** Stop reason of the final assistant message in the settled turn, or null
   *  when the run produced no assistant message at all. */
  lastStopReason: string | null;
}

interface PiTurnBoundaryExtensionApi {
  on(event: 'session_start', handler: (event: unknown) => void): void;
  on(event: 'agent_end', handler: (event: unknown) => void): void;
  on(event: 'agent_settled', handler: (event: unknown) => void): void;
  on(event: 'before_agent_start', handler: (event: unknown) => { systemPrompt?: string | string[] } | void | Promise<{ systemPrompt?: string | string[] } | void>): void;
  appendEntry(customType: string, data?: unknown): void;
}

/** Last assistant message's stopReason within one agent run, or undefined when
 *  the run carried none. Exported for direct unit testing: the event payload
 *  shape (`messages[]`, newest last) is the part most likely to drift with Pi
 *  versions, and it must never throw inside a lifecycle handler. */
export function lastAssistantStopReason(event: unknown): string | undefined {
  const messages = (event as { messages?: unknown[] } | undefined)?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
    if (!message || typeof message !== 'object' || message.role !== 'assistant') continue;
    return typeof message.stopReason === 'string' ? message.stopReason : undefined;
  }
  return undefined;
}

export default function registerBotmuxTurnBoundaryExtension(pi: PiTurnBoundaryExtensionApi): void {
  // Announce presence before any turn can run. The reader uses the first
  // marker as proof that boundaries are coming, and until it sees one it must
  // fall back to weaker heuristics (releasing a held error on the next user
  // record). Without this announcement the session's FIRST turn has no such
  // proof, so a steer landing in that turn's retry backoff would be misread as
  // a new turn. `lastStopReason: null` carries no verdict — it only says
  // "the extension is live here".
  pi.on('session_start', () => {
    try {
      const data: PiTurnBoundaryEntryData = { lastStopReason: null };
      pi.appendEntry(PI_TURN_BOUNDARY_CUSTOM_TYPE, data);
    } catch { /* see the agent_settled handler */ }
  });

  // Tracks the most recent agent run. Pi emits one `agent_end` per ATTEMPT
  // (retries included) and a single `agent_settled` once the turn is really
  // over, so the value standing at settle time is the outcome that decides
  // whether this turn failed. Reset after each settle so a later turn can
  // never inherit a previous turn's verdict.
  let lastStopReason: string | undefined;

  pi.on('agent_end', (event) => {
    const stopReason = lastAssistantStopReason(event);
    // An agent run with no assistant message leaves the previous attempt's
    // reason standing: that is the retry shape (attempt N errored, attempt N+1
    // produced nothing yet), and forgetting it would lose the failure.
    if (stopReason !== undefined) lastStopReason = stopReason;
  });

  pi.on('agent_settled', () => {
    const data: PiTurnBoundaryEntryData = { lastStopReason: lastStopReason ?? null };
    lastStopReason = undefined;
    try {
      pi.appendEntry(PI_TURN_BOUNDARY_CUSTOM_TYPE, data);
    } catch {
      // Never let bookkeeping break the user's session. A missing boundary
      // degrades to the reader's timeout backstop, which is the same state as
      // an extension that failed to load at all.
    }
  });

  // Append Botmux routing rules after CLI native resource discovery and final
  // runtime project trust resolution are completed. This preserves existing
  // project/user APPEND_SYSTEM.md auto-discovery, respects interactive session
  // trust decisions and project_trust extensions, while injecting the session's
  // Botmux system prompt into every turn.
  pi.on('before_agent_start', (event: unknown) => {
    let prompt = process.env.BOTMUX_APPEND_SYSTEM_PROMPT;
    const promptFile = process.env.BOTMUX_APPEND_SYSTEM_PROMPT_FILE;
    if (!prompt && promptFile && existsSync(promptFile)) {
      try {
        prompt = readFileSync(promptFile, 'utf-8');
      } catch {
        // ignore read failure
      }
    }
    if (!prompt) return;
    const current = (event as { systemPrompt?: string | string[] } | undefined)?.systemPrompt;
    if (Array.isArray(current)) {
      return {
        systemPrompt: [...current, prompt],
      };
    }
    return {
      systemPrompt: current ? `${current}\n\n${prompt}` : prompt,
    };
  });
}
