import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MockServerConfig } from './types.js';
import { TapeRecorder } from './recorder.js';
import {
  extractMarkerFromMessages,
  buildBotmuxSendCommand,
} from './marker-extractor.js';
import {
  buildAnthropicToolUseEvents,
  buildAnthropicTextEvents,
  streamSseEvents,
} from './anthropic-sse.js';
import {
  buildOpenAiToolCallEvents,
  buildOpenAiTextEvents,
  streamOpenAiEvents,
} from './openai-sse.js';
import {
  buildOpenAiResponsesTextEvents,
  streamResponsesEvents,
} from './openai-responses-sse.js';

export class MockLlmServer {
  private server: ReturnType<typeof createServer> | null = null;
  private config: Required<MockServerConfig>;
  private recorder: TapeRecorder;

  constructor(config?: MockServerConfig) {
    const validModes = ['synthetic', 'record', 'replay'];
    if (config?.mode && !validModes.includes(config.mode)) {
      throw new Error(
        `Invalid MOCK_LLM_MODE: "${config.mode}". Valid modes are: ${validModes.join(', ')}`,
      );
    }
    const rawPort = config?.port ?? 0;
    const port = Number(rawPort);
    if (Number.isNaN(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid MOCK_LLM_PORT: "${rawPort}"`);
    }

    this.config = {
      port,
      host: config?.host ?? '127.0.0.1',
      mode: config?.mode ?? 'synthetic',
      upstreamUrl: config?.upstreamUrl ?? '',
      fixturesDir: config?.fixturesDir ?? '',
      chunkDelayMs: config?.chunkDelayMs ?? 10,
      verbose: config?.verbose ?? false,
    };
    this.recorder = new TapeRecorder(this.config.fixturesDir || undefined);
  }

  async start(): Promise<{ port: number; baseUrl: string }> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          if (this.config.verbose) console.error('[mock-llm-server] Error:', err);
          if (!res.headersSent && !res.writableEnded) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: String(err) }));
          } else if (!res.writableEnded) {
            res.end();
          }
        });
      });

      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, () => {
        const addr = this.server?.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.config.port;
        const baseUrl = `http://${this.config.host}:${actualPort}`;
        if (this.config.verbose) {
          console.log(`[mock-llm-server] Running at ${baseUrl} in mode=${this.config.mode}`);
        }
        resolve({ port: actualPort, baseUrl });
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      if (typeof (this.server as any).closeAllConnections === 'function') {
        (this.server as any).closeAllConnections();
      }
      this.server?.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname;
    if (this.config.verbose) {
      console.log(`[mock-llm-server] Received ${req.method} ${pathname}`);
    }

    // Preflight health checks required by Claude Code
    if (
      pathname === '/health' ||
      pathname === '/ping' ||
      pathname === '/api/hello' ||
      pathname === '/v1/oauth/hello'
    ) {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(JSON.stringify({ status: 'ok', mode: this.config.mode }));
      return;
    }

    // Models catalog (Preflight support)
    if (pathname === '/v1/models' || pathname === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'claude-3-7-sonnet-20250219', object: 'model' },
            { id: 'claude-3-5-sonnet-20241022', object: 'model' },
            { id: 'gpt-4o', object: 'model' },
            { id: 'gpt-6-astra', object: 'model' },
          ],
        }),
      );
      return;
    }

    const body = await this.readBodyJson(req);

    // Record mode: Proxy to upstream if configured
    if (this.config.mode === 'record' && this.config.upstreamUrl) {
      await this.recorder.proxyAndRecord(req, res, body, this.config.upstreamUrl);
      return;
    }

    // Replay mode: Look for existing fixture tape
    if (this.config.mode === 'replay') {
      const tape = this.recorder.findTape(pathname, body?.model);
      if (tape) {
        const marker = extractMarkerFromMessages(body?.messages);
        await this.recorder.replayTape(res, tape, marker, this.config.chunkDelayMs);
        return;
      }
    }

    // Synthetic Mock mode (default or replay fall-through)
    if (pathname.includes('/messages')) {
      await this.handleAnthropicMessages(body, res);
      return;
    }

    if (pathname.includes('/chat/completions')) {
      await this.handleOpenAiChat(body, res);
      return;
    }

    if (pathname.includes('/responses')) {
      await this.handleOpenAiResponses(body, res);
      return;
    }

    // 404 Fallback
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Not found: ${pathname}` }));
  }

  private async handleOpenAiResponses(body: any, res: ServerResponse): Promise<void> {
    const rawInput = JSON.stringify(body?.input ?? []);
    const { extractMarker } = await import('./marker-extractor.js');
    const marker = extractMarker(rawInput) ?? 'ACK-codex-test-received';
    const model = body?.model ?? 'gpt-6-astra';

    if (this.config.verbose) {
      console.log(`[mock-llm-server] /responses model=${model}, marker=${marker}`);
    }

    const replyText = `已收到指令并完成操作：${marker}`;
    const events = buildOpenAiResponsesTextEvents({
      model,
      text: replyText,
    });
    await streamResponsesEvents(res, events, this.config.chunkDelayMs);
  }

  private async handleAnthropicMessages(body: any, res: ServerResponse): Promise<void> {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const lastMsg = messages[messages.length - 1];
    const marker = extractMarkerFromMessages(messages) ?? 'ACK-test-message-received';
    const model = body?.model;

    if (this.config.verbose) {
      console.log(`[mock-llm-server] /messages model=${model}, marker=${marker}, lastMsgRole=${lastMsg?.role}`);
      const toolNames = Array.isArray(body?.tools) ? body.tools.map((t: any) => t?.name) : [];
      console.log(`[mock-llm-server] Available tools: ${toolNames.join(', ')}`);
      console.log(`[mock-llm-server] Message roles: ${messages.map((m: any) => m?.role).join(' -> ')}`);
    }

    // Check if the latest turn is tool_result.
    // Real Claude Code sessions often append a trailing `system` message
    // (reminders/context update) after `user(tool_result)`. Scan backwards for
    // the latest user message to detect tool_result correctly.
    const lastUserMsg = [...messages].reverse().find((m: any) => m?.role === 'user');
    const isToolResult = Boolean(
      lastUserMsg &&
      Array.isArray(lastUserMsg.content) &&
      lastUserMsg.content.some((b: any) => b?.type === 'tool_result'),
    );

    if (isToolResult) {
      // Phase 2: Tool execution completed, output concluding text
      const events = buildAnthropicTextEvents({
        model,
        text: '已成功调用 botmux send 回复消息，本轮自动化测试结束。',
      });
      await streamSseEvents(res, events, this.config.chunkDelayMs);
      return;
    }

    // Find bash tool name from client tools definition
    let toolName = 'Bash';
    if (Array.isArray(body?.tools)) {
      const bashTool = body.tools.find((t: any) => typeof t?.name === 'string' && /bash/i.test(t.name));
      if (bashTool) toolName = bashTool.name;
    }

    // Phase 1: Call Bash tool to send botmux reply
    const cmd = buildBotmuxSendCommand(marker, true);
    const events = buildAnthropicToolUseEvents({
      model,
      toolName,
      command: cmd,
    });
    await streamSseEvents(res, events, this.config.chunkDelayMs);
  }

  private async handleOpenAiChat(body: any, res: ServerResponse): Promise<void> {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const lastMsg = messages[messages.length - 1];
    const marker = extractMarkerFromMessages(messages) ?? 'ACK-test-message-received';

    const lastNonSystemMsg = [...messages].reverse().find((m: any) => m?.role !== 'system');
    const isToolResult = lastNonSystemMsg?.role === 'tool';

    if (isToolResult) {
      const events = buildOpenAiTextEvents({
        model: body?.model,
        text: '已成功执行回复命令。',
      });
      await streamOpenAiEvents(res, events, this.config.chunkDelayMs);
      return;
    }

    const cmd = buildBotmuxSendCommand(marker, true);
    const events = buildOpenAiToolCallEvents({
      model: body?.model,
      command: cmd,
    });
    await streamOpenAiEvents(res, events, this.config.chunkDelayMs);
  }

  private async readBodyJson(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf-8');
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }
}
