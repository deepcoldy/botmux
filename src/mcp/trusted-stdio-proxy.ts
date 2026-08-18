import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { resolveTrustedTurnFromEnv } from '../utils/trusted-turn-store.js';
import { TRUSTED_IDENTITY_FIELDS, mergeTrustedIdentityArgs, redactTrustedIdentityFields } from '../utils/trusted-mcp.js';

type JsonObject = Record<string, unknown>;

const DATA_AGENT_TOOL_NAMES = new Set([
  'validate_sql_for_user',
  'run_query_for_user',
]);

const DATA_AGENT_UPSTREAM = {
  command: '/bin/bash',
  args: [
    '-lc',
    'launcher="$HOME/.config/ksher-agent-data-mcp/launcher.sh"; if [ ! -x "$launcher" ]; then echo "ksher-agent-data-mcp launcher not found or not executable: $launcher" >&2; exit 1; fi; exec "$launcher"',
  ],
};

export function getTrustedDataMcpProxyDiagnostics(env: NodeJS.ProcessEnv = process.env): JsonObject {
  const trustedTurnResolution = resolveTrustedTurnFromEnv(env);
  const trustedTurn = trustedTurnResolution.inspection;
  return {
    status: trustedTurnResolution.trustedCaller ? 'ok' : 'blocked',
    target: 'data-agent',
    injectTools: Array.from(DATA_AGENT_TOOL_NAMES),
    hiddenSchemaFields: Array.from(TRUSTED_IDENTITY_FIELDS),
    agentVisibleArguments: ['sql', 'datasource'],
    trustedTurn,
    trustedTurnAttempts: trustedTurnResolution.attempts,
    stdio: {
      clientReadProtocols: ['jsonl', 'content-length'],
      upstreamReadProtocols: ['jsonl', 'content-length'],
      upstreamWriteProtocol: 'jsonl',
      clientResponseProtocol: 'matches-client-request',
    },
    upstream: {
      command: DATA_AGENT_UPSTREAM.command,
      args: DATA_AGENT_UPSTREAM.args,
    },
    failClosedErrorCodes: ['missing_trusted_union_id', 'missing_union_id'],
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type WireFormat = 'headers' | 'jsonl';

function writeMessage(target: NodeJS.WritableStream, message: JsonObject, format: WireFormat): void {
  if (format === 'jsonl') {
    target.write(`${JSON.stringify(message)}\n`);
    return;
  }
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  target.write(`Content-Length: ${body.length}\r\n\r\n`);
  target.write(body);
}

class McpMessageReader {
  private buffer = Buffer.alloc(0);
  readonly detectedFormat: { value?: WireFormat } = {};

  constructor(private readonly onMessage: (message: JsonObject) => void) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const first = this.buffer.findIndex(byte => byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0a);
      if (first < 0) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (first > 0) this.buffer = this.buffer.subarray(first);
      if (this.buffer.subarray(0, 15).toString('ascii').toLowerCase().startsWith('content-length')) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = this.buffer.subarray(0, headerEnd).toString('ascii');
        const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
        if (!match) {
          this.buffer = Buffer.alloc(0);
          return;
        }
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (this.buffer.length < bodyEnd) return;
        this.detectedFormat.value ??= 'headers';
        this.emitBody(this.buffer.subarray(bodyStart, bodyEnd).toString('utf8'));
        this.buffer = this.buffer.subarray(bodyEnd);
        continue;
      }
      const lineEnd = this.buffer.indexOf('\n');
      if (lineEnd < 0) return;
      const line = this.buffer.subarray(0, lineEnd).toString('utf8').trim();
      this.buffer = this.buffer.subarray(lineEnd + 1);
      if (!line) continue;
      this.detectedFormat.value ??= 'jsonl';
      this.emitBody(line);
    }
  }

  private emitBody(body: string): void {
      try {
        const parsed = JSON.parse(body);
        if (isJsonObject(parsed)) this.onMessage(parsed);
      } catch {
        // Drop malformed frames. MCP peers will surface timeout/protocol errors.
      }
  }
}

function requestIdKey(id: unknown): string | undefined {
  if (typeof id === 'string' || typeof id === 'number') return String(id);
  return undefined;
}

function redactToolSchemas(message: JsonObject): JsonObject {
  if (!isJsonObject(message.result)) return message;
  const tools = (message.result as JsonObject).tools;
  if (!Array.isArray(tools)) return message;
  return {
    ...message,
    result: {
      ...(message.result as JsonObject),
      tools: tools.map(tool => {
        if (!isJsonObject(tool)) return tool;
        return { ...tool, inputSchema: redactTrustedIdentityFields((tool as JsonObject).inputSchema) };
      }),
    },
  };
}

function missingTrustedIdentityResponse(id: unknown): JsonObject {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32001,
      message: 'missing_trusted_union_id: current BotMux turn has no trusted request_user_union_id',
    },
  };
}

function injectTrustedIdentity(message: JsonObject): { ok: true; message: JsonObject } | { ok: false; response: JsonObject } {
  if (message.method !== 'tools/call' || !isJsonObject(message.params)) return { ok: true, message };
  const name = (message.params as JsonObject).name;
  if (typeof name !== 'string' || !DATA_AGENT_TOOL_NAMES.has(name)) return { ok: true, message };

  const trustedCaller = resolveTrustedTurnFromEnv(process.env).trustedCaller;
  const merged = mergeTrustedIdentityArgs((message.params as JsonObject).arguments, trustedCaller);
  if (!merged.ok) return { ok: false, response: missingTrustedIdentityResponse(message.id) };

  return {
    ok: true,
    message: {
      ...message,
      params: {
        ...(message.params as JsonObject),
        arguments: merged.args,
      },
    },
  };
}

export async function runTrustedDataMcpProxy(): Promise<void> {
  const upstream: ChildProcessWithoutNullStreams = spawn(DATA_AGENT_UPSTREAM.command, DATA_AGENT_UPSTREAM.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  const requestMethods = new Map<string, string>();

  const clientReader = new McpMessageReader((message) => {
    const idKey = requestIdKey(message.id);
    if (idKey && typeof message.method === 'string') requestMethods.set(idKey, message.method);
    const injected = injectTrustedIdentity(message);
    if (!injected.ok) {
      writeMessage(process.stdout, injected.response, clientReader.detectedFormat.value ?? 'jsonl');
      return;
    }
    writeMessage(upstream.stdin, injected.message, 'jsonl');
  });

  const upstreamReader = new McpMessageReader((message) => {
    const idKey = requestIdKey(message.id);
    const method = idKey ? requestMethods.get(idKey) : undefined;
    if (idKey) requestMethods.delete(idKey);
    writeMessage(
      process.stdout,
      method === 'tools/list' ? redactToolSchemas(message) : message,
      clientReader.detectedFormat.value ?? 'jsonl',
    );
  });

  process.stdin.on('data', chunk => clientReader.push(Buffer.from(chunk)));
  upstream.stdout.on('data', chunk => upstreamReader.push(Buffer.from(chunk)));
  upstream.stderr.on('data', chunk => process.stderr.write(chunk));
  upstream.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  process.on('SIGTERM', () => upstream.kill('SIGTERM'));
  process.on('SIGINT', () => upstream.kill('SIGINT'));
}
