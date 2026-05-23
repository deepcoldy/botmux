/**
 * WorkerSpawnFn factories for workflow subagent dispatch.
 *
 * Two layers:
 *
 *   1. **Output protocol** — agent-facing convention for delivering the
 *      structured output a workflow step needs.  The agent emits a
 *      well-known marker block in its final assistant message; the
 *      workflow runtime parses the marker and extracts JSON.
 *
 *   2. **Factories** —
 *        - `createStubSpawnFn(handler)`: dev / test seam.  Wraps a
 *          user-supplied `(input) => Promise<output>` so tests can
 *          drive the orchestrator/loop end-to-end without spinning up
 *          a real worker.
 *        - `createDaemonSpawnFn(deps)`: real daemon-backed spawn.
 *          v0 ships the signature + a TODO body; the daemon wiring
 *          (worker-pool fork, transcript capture, kill on timeout)
 *          lands as a Slice D follow-up.  The interface is stable so
 *          the orchestrator and loop don't have to change when the
 *          live spawner lands.
 *
 * Why a marker block instead of "last JSON message wins": the agent
 * naturally produces conversational prose plus tool calls plus a final
 * answer; a marker is the only thing that survives prose around it
 * cleanly.  The marker matches what the planned `botmux-workflow` skill
 * (UI doc §9) will inject as a tool wrapper.
 */

import type { BotSnapshot } from './events/payloads.js';
import type {
  WorkerSpawnFn,
  WorkerSpawnInput,
  WorkerSpawnResult,
  WorkerSessionInfo,
} from './runtime.js';

// ─── Output protocol ──────────────────────────────────────────────────────

export const WORKFLOW_OUTPUT_BEGIN = '<WORKFLOW_OUTPUT>';
export const WORKFLOW_OUTPUT_END = '</WORKFLOW_OUTPUT>';

/**
 * Augment a step's prompt with the output-protocol footer.  Callers
 * should prepend / replace the agent prompt with this so the agent
 * knows how to deliver structured output.  Idempotent: re-applying
 * doesn't double-stack the footer.
 */
export function withWorkflowOutputProtocol(prompt: string): string {
  if (prompt.includes(WORKFLOW_OUTPUT_BEGIN)) return prompt;
  return `${prompt}\n\n---\nWhen you finish, emit your final structured output between the markers below as a single valid JSON value.  Do not include anything else inside the markers.\n\n${WORKFLOW_OUTPUT_BEGIN}\n{"...your JSON output..."}\n${WORKFLOW_OUTPUT_END}\n`;
}

export type ParseWorkflowOutputResult =
  | { ok: true; value: unknown; raw: string }
  | { ok: false; reason: 'no-marker' | 'unclosed-marker' | 'invalid-json'; detail?: string };

/**
 * Extract structured JSON from an agent's final transcript.
 *
 * Strategy — anchored from the **last** `</WORKFLOW_OUTPUT>` (END)
 * marker:
 *   - find the most recent END
 *   - find the latest BEGIN that precedes that END
 *   - everything between is the "final" block
 *   - parse as JSON
 *
 * Why anchor from the end: real LLM transcripts often include earlier
 * draft markers (the agent revises mid-stream).  A naive
 * "first BEGIN → next END" scan can splice across a malformed early
 * block.  Anchoring from the END gives us the last *complete* block.
 *
 * Failure modes:
 *   - no BEGIN anywhere → `no-marker`
 *   - BEGIN(s) but no END → `unclosed-marker`
 *   - block exists but content isn't JSON → `invalid-json` + parser msg
 */
export function parseWorkflowOutput(text: string): ParseWorkflowOutputResult {
  const lastEnd = text.lastIndexOf(WORKFLOW_OUTPUT_END);
  if (lastEnd < 0) {
    return text.includes(WORKFLOW_OUTPUT_BEGIN)
      ? { ok: false, reason: 'unclosed-marker' }
      : { ok: false, reason: 'no-marker' };
  }
  const beginBeforeEnd = text.lastIndexOf(WORKFLOW_OUTPUT_BEGIN, lastEnd);
  if (beginBeforeEnd < 0) {
    return { ok: false, reason: 'no-marker' };
  }
  const rawBlock = text.slice(beginBeforeEnd + WORKFLOW_OUTPUT_BEGIN.length, lastEnd).trim();
  const block = sanitizeWorkflowOutputBlock(rawBlock);
  try {
    return { ok: true, value: JSON.parse(block), raw: block };
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid-json',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function sanitizeWorkflowOutputBlock(block: string): string {
  // PTY fallback transcripts can include terminal control sequences and
  // hard-wrapped CR/LF bytes inside an otherwise valid one-line JSON block.
  // Agent transcript files remain preferred when available; this keeps the
  // fallback from rejecting clean model output just because the terminal view
  // polluted it.
  return block
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
}

// ─── Stub factory (test / dev) ────────────────────────────────────────────

export type StubSpawnHandler = (
  input: WorkerSpawnInput,
) => Promise<unknown> | unknown;

/**
 * Wrap a plain handler so it satisfies `WorkerSpawnFn`.  Always
 * returns success; the handler's return value is treated as the
 * structured output.  Use for tests / dev where you just need a
 * deterministic answer.
 *
 * NB: this factory is a structured-output shortcut.  It does NOT
 * simulate the agent-side marker protocol — the handler receives the
 * raw `WorkerSpawnInput` (not the prompt-with-protocol-footer) and
 * returns the output value directly.  Tests that want to exercise
 * `parseWorkflowOutput` should call `createDaemonSpawnFn` with a
 * `runOneShot` that fakes the transcript.
 */
export function createStubSpawnFn(handler: StubSpawnHandler): WorkerSpawnFn {
  return async (input) => {
    const startedAt = Date.now();
    const output = await Promise.resolve(handler(input));
    const session: WorkerSessionInfo = {
      sessionId: `stub-${input.activityId}-${input.attemptId}`,
      botName: input.botName,
      cliId: input.botSnapshot?.cliId,
      workingDir: input.workingDir,
      startedAt,
      endedAt: Date.now(),
    };
    return { kind: 'success', output, session };
  };
}

// ─── Daemon-backed factory (real worker spawn) ───────────────────────────

/**
 * Input the daemon's one-shot worker invocation needs from the
 * workflow runtime.  Carries the FULL frozen-identity + execution-
 * policy contract through — `botSnapshot` is what `runCreated`
 * froze, not whatever bot-registry currently says.  Per UI doc §3.4,
 * mutating bots.json after a run starts must not change execution.
 */
export type DaemonRunOneShotInput = {
  botName: string;
  botSnapshot?: BotSnapshot;
  prompt: string;
  workingDir?: string;
  modelOverrides?: { model?: string; reasoningEffort?: string };
  toolPolicy?: { allow?: string[]; deny?: string[] };
  timeoutMs?: number;
  /** Run/node/activity context — daemon may use to mint a worker id or
   *  tag sidecar artifacts.  Required so the daemon never has to
   *  back-resolve identity from globals. */
  runId: string;
  nodeId: string;
  activityId: string;
  attemptId: string;
  /** Conventional per-attempt execution log path. */
  attemptLogPath?: string;
  /**
   * Cooperative cancel handle (v0.1.4-a slice 2).  When `aborted` fires,
   * the daemon-backed runOneShot sends the worker a close message + SIGINT
   * for a graceful shutdown, then escalates to SIGKILL after `cancelGraceMs`.
   * Resolves the outer Promise via `WorkflowSpawnCancelledError` so
   * `createDaemonSpawnFn` can map it to `{ kind: 'cancelled', cancelOriginEventId }`.
   */
  cancelSignal?: AbortSignal;
};

/**
 * Sentinel error class used by `runOneShot` to signal cancel — caught by
 * `createDaemonSpawnFn` and translated into a `WorkerSpawnResult` of
 * `kind: 'cancelled'`.  Keeping it a distinct class (instead of e.g. a
 * `result.cancelled?` field) lets test stubs reject with it without
 * needing to know the `DaemonRunOneShotResult` shape.
 */
export class WorkflowSpawnCancelledError extends Error {
  readonly cancelOriginEventId: string;
  readonly session?: WorkerSessionInfo;
  constructor(cancelOriginEventId: string, session?: WorkerSessionInfo) {
    super('workflow spawn cancelled');
    this.name = 'WorkflowSpawnCancelledError';
    this.cancelOriginEventId = cancelOriginEventId;
    this.session = session;
  }
}

export type DaemonRunOneShotResult = {
  finalTranscript: string;
  session: WorkerSessionInfo;
};

/**
 * Hooks the workflow runtime needs from the daemon to spawn real
 * workers.  Caller (daemon startup) builds an instance of this shape
 * and passes it to `createDaemonSpawnFn`.
 *
 * v0 ships only the type; the runtime can keep going with stub spawns
 * while the daemon wiring lands.  The split lets us land workflow
 * runtime + cards + loop without blocking on worker.ts integration.
 */
export type DaemonSpawnDeps = {
  /**
   * Fork a worker bound to the named bot, hand it the prompt, and
   * resolve with the worker's final transcript text (or reject on
   * crash / timeout).  Implementation reuses
   * `src/core/worker-pool.ts forkWorker` + a transient root id.
   */
  runOneShot(input: DaemonRunOneShotInput): Promise<DaemonRunOneShotResult>;
};

/**
 * Compose a `WorkerSpawnFn` that uses real daemon hooks.  The hooks
 * are injected so the workflows package doesn't pull in daemon
 * internals.  v0 placeholder is documented; the daemon integration
 * lands as a follow-up.
 */
export function createDaemonSpawnFn(deps: DaemonSpawnDeps): WorkerSpawnFn {
  return async (input): Promise<WorkerSpawnResult> => {
    const prompt = withWorkflowOutputProtocol(input.prompt);
    let oneShot: DaemonRunOneShotResult;
    try {
      oneShot = await deps.runOneShot({
        botName: input.botName,
        botSnapshot: input.botSnapshot,
        prompt,
        workingDir: input.workingDir,
        modelOverrides: input.modelOverrides,
        toolPolicy: input.toolPolicy,
        runId: input.runId,
        nodeId: input.nodeId,
        activityId: input.activityId,
        attemptId: input.attemptId,
        attemptLogPath: input.attemptLogPath,
        cancelSignal: input.cancelSignal,
      });
    } catch (err) {
      // Translate the sentinel cancel error into a cancelled spawn result.
      if (err instanceof WorkflowSpawnCancelledError) {
        return {
          kind: 'cancelled',
          cancelOriginEventId: err.cancelOriginEventId,
          session: err.session,
        };
      }
      return {
        kind: 'failure',
        errorCode: 'WorkerCrashed',
        errorClass: 'retryable',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    const parsed = parseWorkflowOutput(oneShot.finalTranscript);
    if (!parsed.ok) {
      return {
        kind: 'failure',
        errorCode: 'OutputSchemaViolation',
        errorClass: 'manual',
        errorMessage: formatParseFailure(parsed, oneShot.finalTranscript),
        session: oneShot.session,
      };
    }
    return {
      kind: 'success',
      output: parsed.value,
      session: oneShot.session,
    };
  };
}

function formatParseFailure(
  parsed: Extract<ParseWorkflowOutputResult, { ok: false }>,
  transcript: string,
): string {
  // Truncate so log lines don't blow up — full transcript still lives
  // in the worker's terminal log / session sidecar for debugging.
  const SNIPPET_MAX = 240;
  const snippet =
    transcript.length > SNIPPET_MAX
      ? transcript.slice(0, SNIPPET_MAX) + '…(truncated)'
      : transcript;
  const detail = parsed.detail ? `: ${parsed.detail}` : '';
  return (
    `Worker output did not contain a parseable ` +
    `${WORKFLOW_OUTPUT_BEGIN}…${WORKFLOW_OUTPUT_END} block ` +
    `(${parsed.reason}${detail}).  Transcript: ${JSON.stringify(snippet)}`
  );
}
