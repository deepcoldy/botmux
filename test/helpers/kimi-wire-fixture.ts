/**
 * Synthetic Kimi Code wire records. Shapes (field names, nesting, ordering)
 * are copied from real Kimi Code 2.5.0 `agents/main/wire.jsonl` logs (wire
 * protocol 1.5); all content is made up.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type WireRecord = Record<string, unknown>;

let clock = 1_794_000_000_000;
export const tick = (ms = 5) => (clock += ms);

const loop = (event: WireRecord, agentId = 'main'): WireRecord =>
  ({ type: 'context.append_loop_event', agentId, event, time: tick() });

export const wire = {
  metadata: (): WireRecord => ({ type: 'metadata', protocol_version: '1.5', created_at: tick() }),
  turnStarted: (turnId: number): WireRecord => ({ turnId, queueItemId: `q${turnId}`, type: 'agent.turn.started', time: tick(), kind: 'event' }),
  prompt: (turnId: number, text: string, agentId = 'main'): WireRecord => ({
    type: 'turn.prompt', agentId, input: [{ type: 'text', text }], origin: { kind: 'user' },
    promptId: `msg_${turnId}`, turnId, time: tick(),
  }),
  llmRequest: (modelAlias: string, effort = 'max', kind = 'loop'): WireRecord => ({
    type: 'llm.request', agentId: 'main', kind, provider: 'openai', model: modelAlias.split('/').pop(),
    modelAlias, thinkingEffort: effort, time: tick(),
  }),
  stepBegin: (step: number, turnId = '0'): WireRecord => loop({ type: 'step.begin', uuid: `s${step}`, turnId, step }),
  think: (text: string, step = 1, agentId = 'main'): WireRecord =>
    loop({ type: 'content.part', uuid: `p${tick(0)}`, turnId: '0', step, stepUuid: `s${step}`, part: { type: 'think', think: text, reasoningKey: 'reasoning_content' } }, agentId),
  text: (text: string, step = 1, agentId = 'main'): WireRecord =>
    loop({ type: 'content.part', uuid: `p${tick(0)}`, turnId: '0', step, stepUuid: `s${step}`, part: { type: 'text', text } }, agentId),
  toolCall: (id: string, name: string, args: unknown, display?: WireRecord, agentId = 'main'): WireRecord =>
    loop({ type: 'tool.call', uuid: `c${id}`, turnId: '0', step: 1, stepUuid: 's1', toolCallId: id, name, args, ...(display ? { display } : {}) }, agentId),
  toolResult: (id: string, output: unknown, extra: WireRecord = {}): WireRecord =>
    loop({ type: 'tool.result', parentUuid: `c${id}`, toolCallId: id, result: { output, durationMs: 12, ...extra } }),
  stepEnd: (finishReason: string, usage?: WireRecord): WireRecord =>
    loop({ type: 'step.end', uuid: 'e', turnId: '0', step: 1, finishReason, ...(usage ? { usage } : {}) }),
  usage: (inputOther: number, output: number, inputCacheRead: number, inputCacheCreation = 0, opts: { agentId?: string; scope?: string; model?: string } = {}): WireRecord => ({
    type: 'usage.record', agentId: opts.agentId ?? 'main', model: opts.model ?? 'kimi-code/k3.1-pro-highspeed',
    usage: { inputOther, output, inputCacheRead, inputCacheCreation }, usageScope: opts.scope ?? 'turn', time: tick(),
  }),
  measured: (tokens: number, agentId = 'main'): WireRecord => ({ type: 'token_counting.measured', agentId, length: 4, tokens, time: tick() }),
  rebased: (tokens: number): WireRecord => ({ type: 'token_counting.rebased', agentId: 'main', length: 8, tokens, measured: false, time: tick() }),
  agentTurnEnded: (turnId: number, outcome: 'done' | 'aborted' | 'failed'): WireRecord => ({ turnId, outcome, type: 'agent.turn.ended', time: tick(), kind: 'event' }),
  turnEnded: (turnId: number, reason: 'completed' | 'cancelled' | 'failed'): WireRecord => ({ type: 'turn.ended', agentId: 'main', turnId, reason, durationMs: 100, time: tick() }),
};

export const toJsonl = (records: readonly WireRecord[]) => records.map(r => JSON.stringify(r)).join('\n') + '\n';

function lastPromptText(records: readonly WireRecord[]): string | undefined {
  const prompt = [...records].reverse().find(r => r.type === 'turn.prompt' && r.agentId === 'main');
  const input = prompt?.input as Array<{ text?: string }> | undefined;
  return input?.[0]?.text;
}

/** Kimi rewrites state.json on every prompt (lastPrompt = that prompt). */
export function setLastPrompt(dir: string, text: string): void {
  const path = join(dir, 'state.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), lastPrompt: text, updatedAt: Date.now() }));
}

/** One Kimi session in a fake KIMI_CODE_HOME, indexed like Kimi does. */
export function makeKimiSession(home: string, opts: {
  id: string;
  workDir: string;
  records?: readonly WireRecord[];
  /** Defaults to the text of the last `turn.prompt` in `records`, as Kimi
   *  keeps it; `null` writes no lastPrompt at all. */
  lastPrompt?: string | null;
  createdAt?: number;
}): { dir: string; wirePath: string; append: (records: readonly WireRecord[]) => void } {
  const dir = join(home, 'sessions', 'wd_work_0123456789ab', opts.id);
  mkdirSync(join(dir, 'agents', 'main'), { recursive: true });
  const wirePath = join(dir, 'agents', 'main', 'wire.jsonl');
  writeFileSync(wirePath, opts.records ? toJsonl(opts.records) : '');
  const lastPrompt = opts.lastPrompt === undefined ? lastPromptText(opts.records ?? []) : opts.lastPrompt ?? undefined;
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    id: opts.id, version: 2, cwd: opts.workDir,
    ...(lastPrompt !== undefined ? { lastPrompt } : {}),
    createdAt: opts.createdAt ?? Date.now(), updatedAt: Date.now(),
  }));
  appendFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ sessionId: opts.id, sessionDir: dir, workDir: opts.workDir }) + '\n');
  return { dir, wirePath, append: records => appendFileSync(wirePath, toJsonl(records)) };
}

/** A completed tool-using turn as Kimi 2.5.0 writes it: per step the thinking,
 *  text and tool calls land together, `usage.record` precedes them, and the
 *  same usage is mirrored on `step.end`. */
export function toolTurn(turnId: number, prompt: string): WireRecord[] {
  return [
    wire.turnStarted(turnId),
    wire.prompt(turnId, prompt),
    wire.stepBegin(1),
    wire.llmRequest('kimi-code/k3.1-pro-highspeed', 'max'),
    wire.usage(1000, 200, 5000, 100),
    wire.measured(6300),
    wire.think('Need to look at the repo first.'),
    wire.text('Let me check the files.'),
    wire.toolCall('tool_a', 'Bash', { command: 'ls -la src' }, { kind: 'command', command: 'ls -la src' }),
    wire.toolResult('tool_a', 'index.ts\nworker.ts'),
    wire.stepEnd('tool_use', { inputOther: 1000, output: 200, inputCacheRead: 5000, inputCacheCreation: 100 }),
    wire.stepBegin(2),
    wire.llmRequest('kimi-code/k3.1-pro-highspeed', 'max'),
    wire.usage(300, 50, 6200, 0),
    wire.measured(6550),
    wire.think('Two files. Answer now.'),
    wire.text('There are two files: index.ts and worker.ts.'),
    wire.stepEnd('end_turn', { inputOther: 300, output: 50, inputCacheRead: 6200, inputCacheCreation: 0 }),
    wire.agentTurnEnded(turnId, 'done'),
    wire.turnEnded(turnId, 'completed'),
  ];
}
