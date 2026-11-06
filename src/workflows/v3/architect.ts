/**
 * v3 architect runner.
 *
 * The grill layer produces `spec.md` + canonical `spec.json`; architect is a
 * single autonomous goal-worker that compiles those files into `dag.json` plus
 * `architect-notes.md`.  This helper keeps that fixed execution contract in one
 * place so host commands do not hand-roll goal-mode env/layout details.
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createEphemeralPool, type EphemeralPoolDeps } from './ephemeral-pool.js';
import { readAndValidateManifest, ManifestValidationError } from './manifest.js';
import {
  GOAL_ENV,
  SPEC_SCHEMA_VERSION,
  type BotSnapshot,
  type Manifest,
  type RunNode,
  type RunNodeRequest,
  type ValidateManifest,
  type WorkerSessionInfo,
} from './contract.js';
import type { V3ArchitectBotAssignment, V3RosterBot, V3SketchAssignee } from './bot-assignment.js';

const ARCHITECT_NODE_ID = 'architect';
const MAX_UNAVAILABLE_CHARS = 200;
const ARCHITECT_ATTEMPT_ID = 'architect/attempts/001';

export interface RunArchitectInput {
  runId: string;
  runDir: string;
  specPath: string;
  specJsonPath: string;
  botSnapshot: BotSnapshot;
  timeoutMs?: number;
  cancelSignal?: AbortSignal;
  /**
   * Test seam.  Production callers normally omit this and provide
   * `resolveLarkAppSecret` so the real ephemeral pool is used.
   */
  runNode?: RunNode;
  resolveLarkAppSecret?: EphemeralPoolDeps['resolveLarkAppSecret'];
  validateManifest?: ValidateManifest;
  /** Present only when the run's goal nodes will be handed to bots in the
   *  group chat (design 2026-11-03 §6): the roster to assign from. Absent =
   *  today's prompt, unchanged. */
  botAssignment?: V3ArchitectBotAssignment;
}

export interface RunArchitectResult {
  status: 'ok' | 'fail';
  dagPath?: string;
  notesPath?: string;
  manifestPath: string;
  problems?: string[];
  sessionInfo?: WorkerSessionInfo;
}

export function buildArchitectGoal(
  specPath: string,
  specJsonPath: string,
  botAssignment?: V3ArchitectBotAssignment,
): string {
  const sketchFields = [
    'sketchId',
    'goal',
    'input_needs',
    'expected_outputs',
    'acceptance',
    'risk_gate',
    'unknowns',
    ...(botAssignment ? ['assignee'] : []),
  ].join(', ');
  return [
    'You are the botmux v3 workflow architect.',
    '',
    'Inputs:',
    `- Canonical machine-readable spec: ${specJsonPath}`,
    `- Human narrative spec: ${specPath}`,
    '',
    'Task:',
    `- Read the canonical spec first; it must use schemaVersion ${SPEC_SCHEMA_VERSION}. Use the narrative spec only for context.`,
    `- Each node sketch has these fields: ${sketchFields}.`,
    '- Compile the spec into a valid botmux v3 DAG JSON.',
    '- Resolve the exact output directory from `$BOTMUX_GOAL_OUTPUT_DIR`; do not infer it from `$BOTMUX_GOAL_MANIFEST_PATH`, the attempt directory, or previous runs.',
    '- Write exactly two primary files under `$BOTMUX_GOAL_OUTPUT_DIR`:',
    '  1. `$BOTMUX_GOAL_OUTPUT_DIR/dag.json`',
    '  2. `$BOTMUX_GOAL_OUTPUT_DIR/architect-notes.md`',
    '- Write the manifest only to `$BOTMUX_GOAL_MANIFEST_PATH`. Every `files[].path` in the manifest is relative to `$BOTMUX_GOAL_OUTPUT_DIR`, not relative to the manifest directory.',
    '- Do not start or run the workflow. Do not call botmux v3 run.',
    '- The host will validate dag.json with botmux v3 DAG validation and ask the human to review it.',
    '',
    'dag.json requirements:',
    '- Use the v3 DAG schema: { "schemaVersion": 2, runId, nodes: [ goal | host | loop ] }.',
    '- Convert each spec node sketch into one goal node unless it is one of the narrow deterministic host effects below, or the spec explicitly says to merge/drop it.',
    '- Treat input_needs as free-text requirements, NOT as pre-authored edges. Infer depends/inputs only when the dependency is justified by the spec.',
    '- Public artifact contract: a producing goal node declares `"outputs": { "<stable-output-key>": { "path": "relative/file.json", "kind": "json" } }` for every file consumed downstream.',
    '- A consuming node references one public product as `{ "from": "<nodeId>", "output": "<stable-output-key>" }`. The key is the stable interface; Manifest name is presentation-only.',
    '- Do not emit legacy `select.name` or `select.path` in schemaVersion 2. Use `{from}` only when the downstream intentionally consumes the entire manifest.',
    '- Every declared output is required: make the node goal explicitly require writing that path and listing it in the success Manifest with the declared kind. Extra private Manifest files are allowed.',
    '- Preserve risk_gate=true as a humanGate prompt on the corresponding node.',
    '- Estimate a per-node timeoutSec from the task size — err on the GENEROUS side (completion is detected early via the manifest, so an oversized budget costs nothing): quick single-file edits ~600, typical research/writing ~1800, long research / refactor / audit tasks 3600-7200. Hard ceiling 14400 (4h). Omit it only for trivially small nodes (default is 1800).',
    '- Keep node ids path-safe: [A-Za-z0-9._-].',
    '- Ensure the graph is acyclic and every inputs.from also appears in depends.',
    '',
    'Deterministic external effects (type:"host"):',
    '- Use a host node ONLY for one of: feishu-send, feishu-reply, botmux-schedule. Shape: { id, type:"host", executor, depends, inputs:[], input:<JSON>, humanGate:{prompt} }. It has no goal/bot/override/resultSchema/revisitTo.',
    '- Every host node MUST have a runtime humanGate. The prompt is static; the runtime automatically appends a trusted preview + hash of the exact frozen provider input. Never interpolate dynamic data into humanGate.prompt.',
    '- Keep host humanGate approval semantics fixed: use the default options, or explicitly set options containing "approve" with approveOptions exactly ["approve"]. Never authorize a custom-labelled/reject choice.',
    '- Host input supports exact typed refs {"$ref":"context.chatId"}, {"$ref":"context.larkAppId"}, {"$ref":"context.rootMessageId"}, {"$ref":"<dependency>.result.<field>"}. A result source MUST also be in depends and MUST emit result.json.',
    '- `${...}` inside host input strings is scalar-only. Prefer exact $ref for whole values/objects/arrays.',
    '- feishu-send identity must come from context.larkAppId + context.chatId; feishu-reply from context.larkAppId + context.rootMessageId. Do not hard-code or parameterize chat identity.',
    '- feishu-send input: `{ larkAppId:{"$ref":"context.larkAppId"}, chatId:{"$ref":"context.chatId"}, content:<string>, msgType?:<string> }`.',
    '- feishu-reply input: `{ larkAppId:{"$ref":"context.larkAppId"}, rootMessageId:{"$ref":"context.rootMessageId"}, content:<string>, msgType?:<string>, replyInThread?:<boolean> }`.',
    '- Never put `botmux send`, `botmux reply`, direct Feishu/Lark OpenAPI send/reply, or `bytedcli feishu ...` messaging commands in a goal node. Goal nodes only write artifacts such as result.json/final_message.md; add a downstream feishu-send/feishu-reply host node for the notification.',
    '- botmux-schedule input: `{ name:<string>, schedule:<string>, prompt:<string>, workingDir:<string>, larkAppId:{"$ref":"context.larkAppId"}, chatId:{"$ref":"context.chatId"}, chatType:{"$ref":"context.chatType"}, rootMessageId?:{"$ref":"context.rootMessageId"}, ownerOpenId?:{"$ref":"context.initiatorOpenId"}, scope?:"thread"|"chat", executionPosition?:"top-level"|"topic"|"new-topic"|"task", topicTitle?:<string>, silent?:<boolean>, repeat?:{times:number|null} }`. OMIT `parsed`: runtime derives and freezes it once per run. `ownerOpenId`, when included, MUST be the exact `{"$ref":"context.initiatorOpenId"}` — never a literal or a params ref (the scheduled turns run authenticated as that identity); omit it for ownerless templates. `topic` requires rootMessageId; `task` runs in its own independent session, is single-chat only, and MUST NOT carry rootMessageId; non-silent `new-topic`/`task` topicTitle supports fire-time `{{date}}`, signed offsets such as `{{date:-1d}}`, and `{{owner}}` (which requires ownerOpenId); dynamic titles are rejected with `silent`; `new-topic` creates a fresh topic each run; silent static `new-topic` defers the visible root until the first botmux send; only `top-level` consults ordinary-group reply mode.',
    '- Never place host nodes inside a structured loop or in a revisit cone: a fresh replay could duplicate an external effect.',
    '',
    'Structured rework loops (type:"loop"):',
    '- When the spec means "rework until verification passes" (fix→test, implement→review, generate→critique→revise), model it as ONE composite loop node — NEVER as a back-edge (the outer graph must stay acyclic; the validator rejects cycles).',
    '- Loop shape: { id, type:"loop", depends, inputs, maxIterations, body:{ nodes:[ <goal nodes> ] }, exit:{ node:"<verifier>", when:{ path:"result.<key>", equals:true } }, feedback:[ "<verifier>.result", "<verifier>.files" ], output:{ from:"<worker>" } }.',
    '- The exit node MUST declare a resultSchema covering the exit key (flat object subset; the key must be in `required`). When the predicate does not match, the loop continues automatically until maxIterations, then blocks for a human (who can grant +1 rounds).',
    '- `output.from` is what downstream consumes — usually the WORKER node\'s product (the fixed code/report), not the verifier\'s.',
    '- Pick maxIterations honestly from how many rework rounds are plausibly useful (typical 3; ceiling 20). Do NOT use a loop when the verification result IS the final product (a one-shot audit/report) — a plain node chain is correct there.',
    '- Cost note: a loop costs up to maxIterations × body-node-count worker runs. State this estimate in architect-notes.md for the Gate-2 reviewer.',
    '',
    'Conditional branching (edge activation):',
    '- When the spec means "decide once, then take ONE of several FORWARD paths" (review passes → deploy, review fails → report; classify → route by category), model it with conditional edges — NOT a loop (loops are for rework on the SAME work) and NEVER a back-edge.',
    '- A `depends` entry can be either a plain "<nodeId>" (unconditional) or { "from": "<nodeId>", "when": { "path": "result.<key>", <op>: <value> } } where <op> is one of equals/notEquals/gt/gte/lt/lte. The edge activates only when the predicate matches the source\'s result.json.',
    '- The judge pattern: give the deciding node a resultSchema with a string `enum` decision field, e.g. { "decision": { "type": "string", "enum": ["pass", "fail"] } } (required). Predicate values are validated against the enum at authoring time, so a typo fails validation, not the run.',
    '- The source of a conditional edge MUST be a goal node declaring a resultSchema covering the predicate key (key in `required`). To branch on a loop\'s outcome, put a verifier goal node AFTER the loop and branch on ITS result.',
    '- At most ONE edge per (from, to) pair. Express OR over outcomes inside the decision field\'s vocabulary, not as parallel edges.',
    '- Nodes on a branch that is not taken are SKIPPED (no worker runs, zero cost) and skip cascades to their downstream. COVER EVERY decision value with some path: if every final (sink) node ends up skipped the run FAILS as an authoring error (allSinksSkipped) — when in doubt, give the "nothing to do" outcome a cheap terminal node.',
    '- `triggerRule` controls a join over multiple incoming edges: default "all_success" (every edge active); "one_success" (any one active — racing alternatives); { "quorum": N } (at least N active — voting). One_success/quorum nodes receive only the products of ACTIVE upstream edges; the omitted rest is listed for the agent, so write their goal text to tolerate partial inputs.',
    '- Conditional edges are not allowed inside a loop body (first cut).',
    '',
    'Per-node capability override (optional):',
    '- A goal node (incl. loop body nodes) may set `override: { model?, systemPromptAppend? }`.',
    '- `model`: pick a cheaper/faster model for light nodes (research, summarize, verify) and reserve the strong default for code/synthesis nodes — state the cost reasoning in architect-notes.md.',
    '- Permission is NOT configurable per node: every workflow worker requires CLI bypass permissions; never emit `permissionMode`.',
    '- `systemPromptAppend`: short node-specific guardrails (≤8000 bytes), e.g. "只读分析，不要修改文件". Do not duplicate the goal text here.',
    '',
    'architect-notes.md requirements:',
    '- Summarize the DAG structure and the reasoning for dependencies/gates.',
    '- For each loop: why a loop, the exit condition, and the worst-case cost estimate (maxIterations × body nodes).',
    '- For each conditional branch: the decision field + its enum, which path each value takes, and confirmation that every value reaches some sink (no allSinksSkipped hole).',
    '- Include an artifact contract table listing producer node, output key, path, kind, and every consumer.',
    '- List any assumptions or unresolved risks for human review.',
    ...(botAssignment ? architectBotAssignmentLines(botAssignment) : []),
  ].join('\n');
}

function rosterEntry(bot: V3RosterBot): Record<string, unknown> {
  return {
    larkAppId: bot.larkAppId,
    name: bot.name,
    cli: bot.cli,
    ...(bot.model ? { model: bot.model } : {}),
    ...(bot.role ? { role: bot.role } : {}),
    ...(bot.main ? { main: true } : {}),
  };
}

function assigneeLine(entry: V3SketchAssignee): string {
  const sketch = `sketch ${JSON.stringify(entry.sketchId)}`;
  const named = `the user named ${JSON.stringify(entry.assignee)}`;
  const fallback = 'assign that node like any other and say so in its reason';
  if (entry.target.kind === 'bot' && !entry.unavailable) return `  - ${sketch} → ${entry.target.larkAppId} (${named})`;
  if (entry.target.kind === 'bot') {
    // The reason may carry probe / Lark error text: keep it one quoted value.
    const why = JSON.stringify((entry.unavailable ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_UNAVAILABLE_CHARS));
    return `  - ${sketch}: ${named} (${entry.target.larkAppId}), which cannot execute nodes here (${why}); ${fallback}.`;
  }
  if (entry.target.kind === 'ambiguous') {
    return `  - ${sketch}: ${named}, which matches several bots (${entry.target.larkAppIds.join(', ')}); ${fallback}.`;
  }
  return `  - ${sketch}: ${named}, which matches no bot on this host; ${fallback}.`;
}

/** The bot-run-only part of the prompt (design 2026-11-03 §6.1/§6.2). */
function architectBotAssignmentLines(assignment: V3ArchitectBotAssignment): string[] {
  const main = assignment.roster.mainLarkAppId;
  return [
    '',
    'Bot assignment (each goal node of this run is executed by one bot in the group chat, in its own session):',
    '- Roster — the ONLY bots that may execute a node (one JSON object per line; "main": true is the bot running this workflow):',
    ...assignment.roster.bots.map((bot) => `  ${JSON.stringify(rosterEntry(bot))}`),
    '- Set `"bot": "<larkAppId>"` on every goal node (loop body nodes included), using only roster larkAppIds; the host rejects any other value.',
    '- Keep each sketch\'s sketchId as the id of the goal node that implements it.',
    ...(assignment.assignees.length > 0
      ? ['- The user named bots for these sketches (`assignee`, already resolved by the host); a resolved assignment is binding:',
        ...assignment.assignees.map(assigneeLine)]
      : []),
    `- Otherwise pick the roster bot whose CLI, model and role best fit the node; when unsure, use the main bot (${main}).`,
    '- architect-notes.md MUST contain a `## Bot assignments` section with exactly one line per goal node: `- <nodeId> → <larkAppId>: <one-line reason>` (a loop body node as `<loopId>.<bodyNodeId>`).',
    '- Optionally mark a goal node `"checkpoint": true` where, once it is done, its result should be looked at before deciding how the rest goes (e.g. an investigation whose findings decide the next steps). When it completes, the nodes that depend on it wait while the main bot reviews the result (it may change the rest of the flow), then the flow goes on. Do not mark routine nodes; loop body nodes cannot be checkpoints.',
    ...architectPlacementLines(assignment),
  ];
}

/** The bot-run-only placement part of the prompt (design 2026-11-03 §5.2). */
function architectPlacementLines(assignment: V3ArchitectBotAssignment): string[] {
  const mainTopic = assignment.mainTopic;
  if (!mainTopic?.available) {
    const why = JSON.stringify((mainTopic?.why ?? 'unknown').replace(/\s+/g, ' ').trim().slice(0, MAX_UNAVAILABLE_CHARS));
    return [
      `- Placement: this run has no usable main topic (${why}), so every node is handed off in a node topic of its own. Do not set \`placement\`.`,
    ];
  }
  return [
    '',
    'Placement (where each top-level goal node is handed off):',
    '- `"placement": "topic"` (the default; omit the field) opens a node topic: the node\'s handoff, the bot\'s progress messages, questions and report all live there. `"placement": "main"` hands the node off right in the main topic (no node topic) — for small steps whose result the people in the main topic want to see directly.',
    '- Use a node topic when ANY of these holds: likely over ~10 minutes or several rounds of back-and-forth; may need to ask a person or discuss; many progress messages (editing code, running tests, fetching data); may be reworked by a revisit; runs in parallel with other nodes.',
    '- Use the main topic only when ALL of these hold: a one-step small job (summarize, rewrite, format, look up one number); strictly serial with the other main-topic nodes; its result is what the main topic wants to read.',
    '- Hard rules (the host rejects the DAG otherwise): (1) two main-topic nodes executed by the same bot must be ordered — one a transitive `depends` ancestor of the other — because a bot has only one session in the main topic; (2) the main bot\'s own main-topic nodes run in the main session itself, so rule 1 applies to them as well. Loop body nodes, loop and host nodes never take `placement`.',
    '- architect-notes.md MUST contain a `## Placements` section with exactly one line per top-level goal node: `- <nodeId> → main|topic: <one-line reason>`.',
  ];
}

export async function runArchitect(input: RunArchitectInput): Promise<RunArchitectResult> {
  const attemptDir = join(input.runDir, 'architect', 'attempts', '001');
  const outputDir = join(attemptDir, 'work');
  const inputsPath = join(attemptDir, 'inputs.json');
  const manifestPath = join(attemptDir, 'manifest.json');
  const goalPath = join(attemptDir, 'goal.txt');
  // Architect always reuses attempt 001 (no nextAttemptId increment). Wipe any
  // prior attempt first: otherwise a `revise-dag` re-architect leaves the old
  // manifest.json + work/dag.json in place, the pool's manifest watcher sees a
  // stable manifest and immediately finishes 'ok' WITHOUT running the new
  // worker, so the revision silently validates the previous dag and never takes.
  rmSync(attemptDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const goal = buildArchitectGoal(input.specPath, input.specJsonPath, input.botAssignment);
  const inputs = {
    inputs: [
      { from: 'grill', name: 'spec.json', path: input.specJsonPath, kind: 'json' },
      { from: 'grill', name: 'spec.md', path: input.specPath, kind: 'markdown' },
    ],
  };

  const req: RunNodeRequest = {
    runId: input.runId,
    attemptId: ARCHITECT_ATTEMPT_ID,
    node: {
      id: ARCHITECT_NODE_ID,
      type: 'goal',
      goal,
      bot: input.botSnapshot.larkAppId,
      depends: [],
      inputs: [],
      timeoutSec: Math.ceil((input.timeoutMs ?? 10 * 60_000) / 1000),
      humanGate: null,
    },
    botSnapshot: input.botSnapshot,
    runDir: input.runDir,
    attemptDir,
    inputsPath,
    outputDir,
    env: {
      [GOAL_ENV.GOAL_PATH]: goalPath,
      [GOAL_ENV.INPUTS_PATH]: inputsPath,
      [GOAL_ENV.OUTPUT_DIR]: outputDir,
      [GOAL_ENV.MANIFEST_PATH]: manifestPath,
      [GOAL_ENV.ATTEMPT_DIR]: attemptDir,
      [GOAL_ENV.V3_MARKER]: '1',
    },
    timeoutMs: input.timeoutMs ?? 10 * 60_000,
    cancelSignal: input.cancelSignal,
    stdoutPath: join(attemptDir, 'stdout.log'),
    stderrPath: join(attemptDir, 'stderr.log'),
  };

  await writeJsonFile(goalPath, goal);
  await writeJsonFile(inputsPath, inputs);

  const runNode = input.runNode ?? realRunNode(input.resolveLarkAppSecret);
  const validateManifest = input.validateManifest ?? defaultValidateManifest;
  const runResult = await runNode(req);
  const verdict = await validateManifest(runResult.manifestPath, outputDir);

  if (runResult.status !== 'ok') {
    return {
      status: 'fail',
      manifestPath: runResult.manifestPath,
      problems: ['architect worker failed before producing a successful result'],
      sessionInfo: runResult.sessionInfo,
    };
  }
  if (!verdict.ok || !verdict.manifest) {
    return {
      status: 'fail',
      manifestPath: runResult.manifestPath,
      problems: verdict.problems ?? ['architect manifest is invalid'],
      sessionInfo: runResult.sessionInfo,
    };
  }
  if (verdict.manifest.status !== 'ok') {
    return {
      status: 'fail',
      manifestPath: runResult.manifestPath,
      problems: [formatManifestError(verdict.manifest)],
      sessionInfo: runResult.sessionInfo,
    };
  }

  const dagPath = manifestPathFor(verdict.manifest, outputDir, 'dag.json');
  const notesPath = manifestPathFor(verdict.manifest, outputDir, 'architect-notes.md');
  const problems = [
    ...(dagPath ? [] : ['architect manifest must include dag.json']),
    ...(notesPath ? [] : ['architect manifest must include architect-notes.md']),
  ];
  if (problems.length > 0) {
    return {
      status: 'fail',
      manifestPath: runResult.manifestPath,
      problems,
      sessionInfo: runResult.sessionInfo,
    };
  }
  return {
    status: 'ok',
    manifestPath: runResult.manifestPath,
    dagPath,
    notesPath,
    sessionInfo: runResult.sessionInfo,
  };
}

function realRunNode(resolveLarkAppSecret: RunArchitectInput['resolveLarkAppSecret']): RunNode {
  if (!resolveLarkAppSecret) {
    throw new Error('runArchitect requires resolveLarkAppSecret when runNode is not injected');
  }
  return createEphemeralPool({ resolveLarkAppSecret }).runNode;
}

async function defaultValidateManifest(manifestPath: string, outputDir: string) {
  try {
    return { ok: true as const, manifest: await readAndValidateManifest(manifestPath, outputDir) };
  } catch (e) {
    return {
      ok: false as const,
      problems: e instanceof ManifestValidationError ? e.problems : [String(e)],
    };
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function manifestPathFor(manifest: Manifest, outputDir: string, expectedPath: string): string | undefined {
  const file = manifest.files.find((f) => f.path === expectedPath || f.name === expectedPath);
  if (!file) return undefined;
  const path = join(outputDir, file.path);
  try {
    readFileSync(path);
  } catch {
    return undefined;
  }
  return path;
}

function formatManifestError(manifest: Manifest): string {
  if (!manifest.error) return 'architect reported failure without error details';
  return `${manifest.error.code}: ${manifest.error.message}`;
}
