/**
 * Scripted model for the oncall-sandbox CLI matrix (scripts/oncall-cli-matrix).
 *
 * Speaks the four wire formats the public CLIs use against a custom endpoint:
 * Anthropic Messages, OpenAI Chat Completions, OpenAI Responses and Gemini API
 * generateContent (Antigravity with `modelProvider: "gemini"`; streaming or
 * not). Every probe prompt carries a tag `SBXP-<tag>`; for the latest such
 * prompt the model
 *
 *   1. answers with ONE call of the shell tool the CLI declared, running the
 *      probe command the harness registered for that tag, then
 *   2. once the tool result is in the history, answers with the final text
 *      `SBXDONE-<tag> resumed=<yes|no>`, where `resumed` says whether the
 *      history also carries the session's FIRST tag (a resumed conversation
 *      re-sends it; a fresh one does not).
 *
 * Detection is textual on the raw request JSON, so it works the same for every
 * wire format: the command prints `SBXOUT-<tag>` through printf (the command
 * text itself never contains that literal), so "SBXOUT-<tag>" in the request
 * means the tool result came back.
 *
 * Anything else (title generation, routers, warm-up calls) gets a short text.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

export interface ProbeScript {
  /** Shell command for the tag's tool call. */
  command: string;
  /** The session's first tag; its presence in a later request = resumed. */
  firstTag: string;
}

export interface MockModel {
  baseUrl: string;
  port: number;
  register(tag: string, script: ProbeScript): void;
  /** Request log (path + which tag/phase it answered) for diagnostics. */
  log: Array<{ path: string; tag?: string; phase?: 'tool' | 'final' | 'other'; tool?: string; resumed?: string }>;
  close(): Promise<void>;
}

const TAG_RE = /SBXP-([a-z0-9]{6,})/g;

interface Declared { name: string; schema: any }

/** Tool declarations of any wire format. */
function declarations(body: any): Declared[] {
  const out: Declared[] = [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  for (const tool of tools) {
    if (Array.isArray(tool?.functionDeclarations)) {
      for (const fn of tool.functionDeclarations) if (typeof fn?.name === 'string') out.push({ name: fn.name, schema: fn.parametersJsonSchema ?? fn.parameters });
    } else if (typeof tool?.function?.name === 'string') {
      out.push({ name: tool.function.name, schema: tool.function.parameters });
    } else if (typeof tool?.name === 'string') {
      out.push({ name: tool.name, schema: tool.input_schema ?? tool.parameters });
    }
  }
  return out;
}

const EXACT = /^_?(bash|shell|exec_command|run_command|run_shell_command|run_terminal_command|run_terminal_cmd|terminal)$/i;
const LOOSE = /bash|shell|terminal|exec_command|command/i;

function pickShell(body: any): { name: string; args(command: string): Record<string, unknown> } | null {
  const declared = declarations(body);
  const tool = declared.find(d => EXACT.test(d.name))
    ?? declared.find(d => LOOSE.test(d.name) && !/kill|output|status|background|read/i.test(d.name));
  if (!tool) return null;
  const props: Record<string, any> = tool.schema?.properties ?? {};
  const required: string[] = Array.isArray(tool.schema?.required) ? tool.schema.required : [];
  return {
    name: tool.name,
    args(command: string) {
      const args: Record<string, unknown> = {};
      // Codex `shell` takes argv; `exec_command` takes `cmd`; Antigravity
      // `run_command` takes `CommandLine`; most take `command`.
      if (props.command?.type === 'array') args.command = ['bash', '-lc', command];
      else if ('cmd' in props && !('command' in props)) args.cmd = command;
      else if ('CommandLine' in props && !('command' in props)) args.CommandLine = command;
      else args.command = command;
      for (const field of required) {
        if (field in args) continue;
        const type = props[field]?.type;
        if (type === 'string') args[field] = field === 'workdir' || field === 'cwd' || field === 'directory' ? '.' : 'probe';
        else if (type === 'boolean') args[field] = false;
        // Antigravity's WaitMsBeforeAsync (500–10000): wait the longest so the probe runs synchronously.
        else if (type === 'integer' || type === 'number') args[field] = field.includes('timeout') ? 60_000 : field === 'WaitMsBeforeAsync' ? 10_000 : 1;
      }
      return args;
    },
  };
}

const id = (p: string) => `${p}${randomBytes(10).toString('hex')}`;

function sse(res: ServerResponse, events: Array<{ event?: string; data: unknown }>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const e of events) {
    if (e.event) res.write(`event: ${e.event}\n`);
    res.write(`data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`);
  }
  res.end();
}

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };

function anthropic(res: ServerResponse, body: any, reply: Reply): void {
  const model = body?.model ?? 'mock-model';
  const usage = { input_tokens: 10, output_tokens: 5 };
  const start = { type: 'message_start', message: { id: id('msg_'), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } };
  const isTool = 'tool' in reply;
  const block = isTool
    ? { type: 'tool_use', id: id('toolu_'), name: reply.tool, input: {} }
    : { type: 'text', text: '' };
  const delta = isTool
    ? { type: 'input_json_delta', partial_json: JSON.stringify(reply.args) }
    : { type: 'text_delta', text: reply.text };
  if (body?.stream === false) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...start.message, content: [isTool ? { ...block, input: reply.args } : { type: 'text', text: (reply as { text: string }).text }], stop_reason: isTool ? 'tool_use' : 'end_turn' }));
    return;
  }
  sse(res, [
    { event: 'message_start', data: start },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: block } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: isTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

function openaiChat(res: ServerResponse, body: any, reply: Reply): void {
  const model = body?.model ?? 'mock-model';
  const cid = id('chatcmpl-');
  const created = Math.floor(Date.now() / 1000);
  const isTool = 'tool' in reply;
  const message = isTool
    ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: id('call_'), type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }
    : { role: 'assistant', content: (reply as { text: string }).text };
  const finish = isTool ? 'tool_calls' : 'stop';
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if (!body?.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: cid, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }], usage }));
    return;
  }
  const chunk = (delta: unknown, finish_reason: string | null, extra: Record<string, unknown> = {}) =>
    ({ data: { id: cid, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }], ...extra } });
  sse(res, [
    chunk({ role: 'assistant', content: isTool ? null : '' }, null),
    chunk(isTool ? { tool_calls: message.tool_calls } : { content: message.content }, null),
    chunk({}, finish, { usage }),
    { data: '[DONE]' },
  ]);
}

function openaiResponses(res: ServerResponse, body: any, reply: Reply): void {
  const model = body?.model ?? 'mock-model';
  const rid = id('resp_');
  const isTool = 'tool' in reply;
  const item = isTool
    ? { id: id('fc_'), type: 'function_call', status: 'completed', call_id: id('call_'), name: reply.tool, arguments: JSON.stringify(reply.args) }
    : { id: id('msg_'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: (reply as { text: string }).text, annotations: [] }] };
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 };
  const base = { id: rid, object: 'response', model, created_at: Math.floor(Date.now() / 1000) };
  sse(res, [
    { event: 'response.created', data: { type: 'response.created', response: { ...base, status: 'in_progress', output: [] } } },
    { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } } },
    ...(isTool ? [] : [{ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: (reply as { text: string }).text } }]),
    { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 0, item } },
    { event: 'response.completed', data: { type: 'response.completed', response: { ...base, status: 'completed', output: [item], usage } } },
  ]);
}

function gemini(res: ServerResponse, reply: Reply, stream: boolean): void {
  const part = 'tool' in reply ? { functionCall: { name: reply.tool, args: reply.args } } : { text: reply.text };
  const payload = {
    candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }
  sse(res, [{ data: payload }]);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startMockModel(): Promise<MockModel> {
  const scripts = new Map<string, ProbeScript>();
  const log: MockModel['log'] = [];

  const decide = (raw: string, body: any): { reply: Reply; tag?: string; phase: 'tool' | 'final' | 'other'; resumed?: string } => {
    const tags = [...raw.matchAll(TAG_RE)].map(m => m[1]).filter(t => scripts.has(t));
    const tag = tags.at(-1);
    if (!tag) return { reply: { text: 'ok' }, phase: 'other' };
    const script = scripts.get(tag)!;
    if (raw.includes(`SBXOUT-${tag}`)) {
      const resumed = script.firstTag !== tag && raw.includes(`SBXP-${script.firstTag}`) ? 'yes' : 'no';
      return { reply: { text: `SBXDONE-${tag} resumed=${resumed}` }, tag, phase: 'final', resumed };
    }
    const shell = pickShell(body);
    if (!shell) return { reply: { text: 'ok' }, tag, phase: 'other' };
    return { reply: { tool: shell.name, args: shell.args(script.command) }, tag, phase: 'tool' };
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (/models/.test(path)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }], models: [{ name: 'models/mock-model' }] }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const raw = await readBody(req);
      let body: any = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* non-JSON */ }
      const { reply, tag, phase, resumed } = decide(raw, body);
      log.push({ path, tag, phase, tool: 'tool' in reply ? reply.tool : undefined, resumed });
      const gem = /:(streamGenerateContent|generateContent)$/.exec(path);
      if (gem) return gemini(res, reply, gem[1] === 'streamGenerateContent');
      if (path.endsWith('/messages')) return anthropic(res, body, reply);
      if (path.endsWith('/chat/completions')) return openaiChat(res, body, reply);
      if (path.endsWith('/responses')) return openaiResponses(res, body, reply);
      if (path.endsWith(':countTokens') || path.endsWith('/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ totalTokens: 10, input_tokens: 10 }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `mock: no route ${path}` } }));
    } catch (e) {
      // The detail stays in the lab log; the CLI only learns the request failed.
      console.error('[mock-model]', e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock model error' } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    register: (tag, script) => { scripts.set(tag, script); },
    log,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
