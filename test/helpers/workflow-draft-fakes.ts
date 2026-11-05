/**
 * Fakes for Dashboard workflow draft tests (design 2026-11-03
 * workflow-dashboard-orchestration D2): the clarify session (a headless
 * session of the orchestrating bot), the Architect worker (the real
 * architect runner over a fake worker), a manual timer, and a bot fleet.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runArchitect, type RunArchitectInput } from '../../src/workflows/v3/architect.js';
import { GOAL_ENV, SPEC_SCHEMA_VERSION, type Manifest } from '../../src/workflows/v3/contract.js';
import type { ArchitectDeps } from '../../src/workflows/v3/host.js';
import {
  WorkflowDraftService,
  type DraftClarifier,
  type DraftClarifyResult,
  type WorkflowDraftServiceDeps,
} from '../../src/workflows/v3/draft-service.js';
import type { WorkflowDraftInitiator } from '../../src/workflows/v3/draft-store.js';

export const MAIN = 'cli_main';
export const DOC = 'cli_doc';
export const OFFLINE = 'cli_off';
export const STEWARD = 'cli_steward';
export const PI = 'cli_pi';

export const BOTS = [
  { larkAppId: MAIN, larkAppSecret: 's-main', name: 'main', cliId: 'claude-code' },
  { larkAppId: DOC, larkAppSecret: 's-doc', name: 'doc', cliId: 'claude-code' },
  { larkAppId: OFFLINE, larkAppSecret: 's-off', name: 'off', cliId: 'claude-code' },
  { larkAppId: STEWARD, larkAppSecret: 's-st', name: 'steward', cliId: 'claude-code', steward: { enabled: true } },
  { larkAppId: PI, larkAppSecret: 's-pi', name: 'pi', cliId: 'pi' },
] as any[];

export const NAMES: Record<string, string> = {
  [MAIN]: '主Bot', [DOC]: '文档Bot', [OFFLINE]: '离线Bot', [STEWARD]: '管家Bot', [PI]: 'PiBot',
};

export const OWNER: WorkflowDraftInitiator = { openId: 'ou_owner', source: 'dashboard-local' };
export const ALICE: WorkflowDraftInitiator = { openId: 'ou_alice', unionId: 'on_alice', source: 'dashboard-platform' };

export const SKETCHES = [
  { sketchId: 'inspect', goal: '看改动', input_needs: [], expected_outputs: ['changes.md'], acceptance: '列全', risk_gate: false, unknowns: [] },
  { sketchId: 'write', goal: '写报告', input_needs: ['改动清单'], expected_outputs: ['r.md'], acceptance: '有风险', risk_gate: false, unknowns: [], assignee: DOC },
];

export function specMarkdown(sketches: unknown[] = SKETCHES, extra: Record<string, unknown> = {}): string {
  return [
    '## 需求', '出一份代码风险报告', '',
    '```json',
    JSON.stringify({ schemaVersion: SPEC_SCHEMA_VERSION, runId: 'ignored', title: '代码风险报告', requirement: '出报告', nodes: sketches, ...extra }, null, 2),
    '```',
  ].join('\n');
}

export const goalNode = (id: string, bot?: string) => ({ id, type: 'goal', goal: id, depends: [], inputs: [], ...(bot ? { bot } : {}) });
export const DAG_NODES = [goalNode('inspect', MAIN), goalNode('write', DOC)];
export const NOTES = [
  '## Bot assignments',
  `- inspect → ${MAIN}: 默认交给主 Bot`,
  `- write → ${DOC}: 用户点名文档Bot`,
].join('\n');

function product(outputDir: string, path: string, content: string): Manifest['files'][number] {
  writeFileSync(join(outputDir, path), content);
  return {
    name: path, path, kind: path.endsWith('.json') ? 'json' : 'markdown',
    bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'),
    mime: path.endsWith('.json') ? 'application/json' : 'text/markdown',
  };
}

/**
 * The real architect runner over a fake worker. `mode`:
 *   ok    — writes DAG_NODES + NOTES;
 *   fail  — the worker fails;
 *   hang  — waits until the cancel signal fires, then fails (as the
 *           ephemeral pool does on abort).
 */
export function fakeArchitect() {
  const calls: RunArchitectInput[] = [];
  let mode: 'ok' | 'fail' | 'hang' = 'ok';
  let nodes: unknown[] = DAG_NODES;
  const run: ArchitectDeps['runArchitect'] = async (input) => {
    calls.push(input);
    return runArchitect({
      ...input,
      runNode: async (req) => {
        const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH]!;
        if (mode === 'hang') {
          await new Promise<void>((resolve) => {
            if (req.cancelSignal?.aborted) return resolve();
            req.cancelSignal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return { status: 'cancelled' as const, manifestPath };
        }
        if (mode === 'fail') return { status: 'fail' as const, manifestPath };
        const files = [
          product(req.outputDir, 'dag.json', JSON.stringify({ schemaVersion: 2, runId: input.runId, nodes })),
          product(req.outputDir, 'architect-notes.md', NOTES),
        ];
        writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, status: 'ok', summary: 'ok', files }));
        return { status: 'ok', manifestPath };
      },
    });
  };
  return {
    run,
    calls,
    set mode(next: 'ok' | 'fail' | 'hang') { mode = next; },
    set nodes(next: unknown[]) { nodes = next; },
  };
}

/** In-memory clarify sessions: every send opens a running turn the test
 *  completes with {@link reply}. */
export function fakeClarifier() {
  let n = 0;
  const sessions = new Map<string, { headlessId: string; prompts: string[]; closed: boolean; gone: boolean }>();
  const turns = new Map<string, { sessionId: string; result: DraftClarifyResult }>();
  const suspended: string[] = [];
  const order: string[] = [];
  const clarifier: DraftClarifier = {
    async create() {
      n += 1;
      const sessionId = `sess-${n}`;
      sessions.set(sessionId, { headlessId: `hl_draft_${String(n).padStart(8, '0')}`, prompts: [], closed: false, gone: false });
      return { ok: true, headlessId: `hl_draft_${String(n).padStart(8, '0')}`, sessionId };
    },
    async send({ sessionId, prompt }) {
      const session = sessions.get(sessionId);
      if (!session || session.closed || session.gone) return { ok: false, error: 'session_closed', disconnected: true };
      session.prompts.push(prompt);
      n += 1;
      const triggerId = `trg-${n}`;
      turns.set(triggerId, { sessionId, result: { state: 'running' } });
      order.push(triggerId);
      return { ok: true, triggerId };
    },
    result(sessionId, triggerId) {
      const turn = turns.get(triggerId);
      if (!turn || turn.sessionId !== sessionId || sessions.get(sessionId)?.gone) return { state: 'not_found' };
      return turn.result;
    },
    suspend(sessionId) {
      suspended.push(sessionId);
      return true;
    },
    async close({ sessionId }) {
      const session = sessions.get(sessionId);
      if (session) session.closed = true;
    },
  };
  return {
    clarifier,
    sessions,
    suspended,
    lastTrigger: () => order[order.length - 1],
    /** Complete the latest running turn with `content`. */
    reply(content: string) {
      const triggerId = order[order.length - 1]!;
      turns.get(triggerId)!.result = { state: 'completed', content };
    },
    /** The session disappears (e.g. its record was lost). */
    lose(sessionId: string) { sessions.get(sessionId)!.gone = true; },
  };
}

/** Manual timers: nothing fires until {@link fire}. */
export function manualTimers() {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    fire() {
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
    },
    pending: () => timers.filter((timer) => !timer.cancelled).length,
  };
}

export function makeService(baseDir: string, overrides: Partial<WorkflowDraftServiceDeps> = {}) {
  const architect = fakeArchitect();
  const clarify = fakeClarifier();
  const timers = manualTimers();
  let clock = Date.parse('2026-11-05T10:00:00.000Z');
  let online = new Set([MAIN, DOC, STEWARD, PI]);
  let suffix = 0;
  const deps: WorkflowDraftServiceDeps = {
    appId: MAIN,
    baseDir,
    now: () => new Date(clock),
    setTimer: timers.setTimer,
    loadBots: () => BOTS,
    nameOf: () => (appId) => NAMES[appId] ?? appId,
    isDaemonOnline: (appId) => online.has(appId),
    clarifier: clarify.clarifier,
    runArchitect: architect.run,
    randomSuffix: () => (suffix += 1).toString(16).padStart(8, '0'),
    ...overrides,
  };
  const service = new WorkflowDraftService(deps);
  return {
    service,
    deps,
    architect,
    clarify,
    timers,
    advance(ms: number) { clock += ms; },
    setOnline(next: string[]) { online = new Set(next); },
  };
}

/** Wait until the background Architect of `runId` has recorded its outcome. */
export async function architectSettled(service: WorkflowDraftService, runId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const view = await service.view(runId);
    if (view.architect && view.architect.state !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`architect of ${runId} did not settle`);
}
