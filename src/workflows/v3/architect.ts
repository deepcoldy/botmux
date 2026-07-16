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

const ARCHITECT_NODE_ID = 'architect';
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
}

export interface RunArchitectResult {
  status: 'ok' | 'fail';
  dagPath?: string;
  notesPath?: string;
  manifestPath: string;
  problems?: string[];
  sessionInfo?: WorkerSessionInfo;
}

export function buildArchitectGoal(specPath: string, specJsonPath: string): string {
  const sketchFields = [
    'sketchId',
    'goal',
    'input_needs',
    'expected_outputs',
    'acceptance',
    'risk_gate',
    'unknowns',
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
    '- Write exactly two primary files under the output directory:',
    '  1. dag.json',
    '  2. architect-notes.md',
    '- Do not start or run the workflow. Do not call botmux v3 run.',
    '- The host will validate dag.json with botmux v3 DAG validation and ask the human to review it.',
    '',
    'dag.json requirements:',
    '- Use the v3 DAG schema: { runId, nodes: [ goal | host | loop ] }.',
    '- Convert each spec node sketch into one goal node unless it is one of the narrow deterministic host effects below, or the spec explicitly says to merge/drop it.',
    '- Treat input_needs as free-text requirements, NOT as pre-authored edges. Infer depends/inputs only when the dependency is justified by the spec.',
    '- An inputs entry may select ONE named product instead of the whole manifest: { "from": "<nodeId>", "select": { "name": "<manifest file name>" } } (or { "path": ... }). Prefer a selector when the downstream goal only needs a specific file — it keeps the worker\'s context small.',
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
    '- botmux-schedule input: `{ name:<string>, schedule:<string>, prompt:<string>, workingDir:<string>, larkAppId:{"$ref":"context.larkAppId"}, chatId:{"$ref":"context.chatId"}, chatType:{"$ref":"context.chatType"}, rootMessageId?:{"$ref":"context.rootMessageId"}, scope?:"thread"|"chat", repeat?:{times:number|null}, deliver?:"origin"|"new-topic" }`. OMIT `parsed`: runtime derives and freezes it once per run, so a relative time is never reused from an older run. P0 does not support deliver:"local".',
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
    '- List any assumptions or unresolved risks for human review.',
  ].join('\n');
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

  const goal = buildArchitectGoal(input.specPath, input.specJsonPath);
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
