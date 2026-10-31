import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  MockLlmServer,
  extractMarker,
  buildBotmuxSendCommand,
  buildMockReplyLine,
  RECALL_FIRST_MARKER_TOKEN,
  TapeRecorder,
  type FixtureTape,
} from './helpers/mock-llm-server/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('MockLlmServer', () => {
  let server: MockLlmServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new MockLlmServer({
      port: 0,
      mode: 'synthetic',
      chunkDelayMs: 0,
    });
    const res = await server.start();
    baseUrl = res.baseUrl;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('serves health check and model catalog', async () => {
    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = await healthRes.json() as any;
    expect(healthJson.status).toBe('ok');

    const modelsRes = await fetch(`${baseUrl}/v1/models`);
    expect(modelsRes.status).toBe(200);
    const modelsJson = await modelsRes.json() as any;
    expect(modelsJson.object).toBe('list');
    expect(modelsJson.data.some((m: any) => m.id.includes('claude'))).toBe(true);
  });

  it('validates constructor config for port and mode', () => {
    expect(() => new MockLlmServer({ mode: 'invalid' as any })).toThrow(/Invalid MOCK_LLM_MODE/);
    expect(() => new MockLlmServer({ port: -1 })).toThrow(/Invalid MOCK_LLM_PORT/);
  });

  describe('marker extractor', () => {
    it('extracts ACK markers correctly', () => {
      const msg = '请立刻调用 botmux send 在本话题里回复一行内容："ACK-e2e-claude-1728280000"';
      expect(extractMarker(msg)).toBe('ACK-e2e-claude-1728280000');
    });

    it('recalls the first ACK marker only when the latest turn asks for it', () => {
      const history = [
        { role: 'user', content: [{ type: 'text', text: 'see test/e2e-browser/cases-123 for context' }, { type: 'text', text: 'e2e-turn1-1 请回复 "ACK-e2e-turn1-1"' }] },
        { role: 'assistant', content: 'ACK-e2e-assistant-echo' },
        { role: 'user', content: `e2e-turn2-2 ${RECALL_FIRST_MARKER_TOKEN} 请回复 "ACK-e2e-turn2-2 RECALL <first>"` },
      ];
      expect(buildMockReplyLine(history, 'ACK-e2e-turn2-2')).toBe('ACK-e2e-turn2-2 RECALL ACK-e2e-turn1-1');
      expect(buildMockReplyLine(history.slice(0, 1), 'ACK-e2e-turn1-1')).toBe('ACK-e2e-turn1-1');
      // A fresh session recalls its own marker — distinct from a continued one.
      expect(buildMockReplyLine(history.slice(2), 'ACK-e2e-turn2-2')).toBe('ACK-e2e-turn2-2 RECALL ACK-e2e-turn2-2');
    });

    it('answers every probe batched into one turn', () => {
      const probe = (tag: string) =>
        `e2e-${tag} RECALL_FIRST_MARKER 请立刻调用 botmux send 在本话题里回复一行内容："ACK-e2e-${tag} RECALL <首条标记>"`;
      const batched = [
        { role: 'user', content: [{ type: 'text', text: probe('one-1792024163258') }, { type: 'text', text: probe('two-1792024163258') }] },
      ];
      expect(buildMockReplyLine(batched, 'ACK-e2e-two-1792024163258')).toBe(
        'ACK-e2e-one-1792024163258 RECALL ACK-e2e-one-1792024163258\n' +
          'ACK-e2e-two-1792024163258 RECALL ACK-e2e-one-1792024163258',
      );
      // Earlier turns are history, not this turn's probes.
      const later = [...batched, { role: 'assistant', content: 'done' }, { role: 'user', content: probe('three-1792024163258') }];
      expect(buildMockReplyLine(later, 'ACK-e2e-three-1792024163258')).toBe(
        'ACK-e2e-three-1792024163258 RECALL ACK-e2e-one-1792024163258',
      );
      // Plain ACK probes (testMessage) carry no RECALL.
      expect(buildMockReplyLine(
        [{ role: 'user', content: 'e2e-claude-1792020765509 请立刻调用 botmux send 在本话题里回复一行内容："ACK-e2e-claude-1792020765509"' }],
        'ACK-e2e-claude-1792020765509',
      )).toBe('ACK-e2e-claude-1792020765509');
    });

    it('extracts CODEX marker correctly', () => {
      const msg = '请在最终回复中原样包含 CODEX_E2E_MARKER_998877';
      expect(extractMarker(msg)).toBe('CODEX_E2E_MARKER_998877');
    });

    it('builds botmux send command with mention-back and shell single-quote escaping', () => {
      const cmd = buildBotmuxSendCommand("ACK-test-123'$(id)", true);
      expect(cmd).toBe("botmux send --mention-back 'ACK-test-123'\\''$(id)'");
    });
  });

  describe('Anthropic Messages API (/v1/messages)', () => {
    it('generates tool_use SSE stream on user turn with marker', async () => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-3-7-sonnet-20250219',
          messages: [
            {
              role: 'user',
              content: '测试消息 请立刻调用 botmux send 在本话题里回复一行内容："ACK-e2e-suite-999"',
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const bodyText = await res.text();
      expect(bodyText).toContain('event: message_start');
      expect(bodyText).toContain('event: content_block_start');
      expect(bodyText).toContain('"name":"Bash"');
      expect(bodyText).toContain('ACK-e2e-suite-999');
      expect(bodyText).toContain('"stop_reason":"tool_use"');
      expect(bodyText).toContain('event: message_stop');
    });

    it('generates text completion SSE stream on tool_result turn', async () => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-3-7-sonnet-20250219',
          messages: [
            {
              role: 'user',
              content: '测试消息 ACK-e2e-suite-999',
            },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: {} }],
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Sent OK' }],
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const bodyText = await res.text();
      expect(bodyText).toContain('event: message_start');
      expect(bodyText).toContain('"type":"text"');
      expect(bodyText).toContain('"stop_reason":"end_turn"');
    });

    it('generates text completion SSE stream on tool_result turn followed by trailing system message', async () => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-3-7-sonnet-20250219',
          messages: [
            {
              role: 'user',
              content: '测试消息 ACK-e2e-suite-999',
            },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: {} }],
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Sent OK' }],
            },
            {
              role: 'system',
              content: 'Reminder: keep answers concise',
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const bodyText = await res.text();
      expect(bodyText).toContain('event: message_start');
      expect(bodyText).toContain('"type":"text"');
      expect(bodyText).toContain('"stop_reason":"end_turn"');
      expect(bodyText).not.toContain('"stop_reason":"tool_use"');
    });
  });

  describe('OpenAI Chat Completions API (/v1/chat/completions)', () => {
    it('generates tool_calls SSE stream on user turn', async () => {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: '请在最终回复中原样包含 CODEX_E2E_MARKER_12345',
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const bodyText = await res.text();
      expect(bodyText).toContain('tool_calls');
      expect(bodyText).toContain('CODEX_E2E_MARKER_12345');
      expect(bodyText).toContain('data: [DONE]');
    });

    it('generates text SSE stream on tool response', async () => {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'user', content: 'CODEX_E2E_MARKER_12345' },
            { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'bash' } }] },
            { role: 'tool', tool_call_id: '1', content: 'success' },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const bodyText = await res.text();
      expect(bodyText).toContain('"finish_reason":"stop"');
      expect(bodyText).toContain('data: [DONE]');
    });
  });

  describe('shell tool of each CLI', () => {
    const post = (path: string, body: unknown) =>
      fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.text());
    const prompt = '请立刻调用 botmux send 在本话题里回复一行内容："ACK-e2e-cli-1793300000000"';

    it('calls Grok\'s run_terminal_command with its required description', async () => {
      const text = await post('/v1/messages', {
        model: 'mock-model',
        stream: true,
        tools: [
          { name: 'session_title', input_schema: { type: 'object', properties: { title: { type: 'string' } } } },
          {
            name: 'run_terminal_command',
            input_schema: { type: 'object', required: ['command', 'description'], properties: { command: { type: 'string' }, description: { type: 'string' } } },
          },
        ],
        messages: [{ role: 'user', content: prompt }],
      });
      const input = JSON.parse(JSON.parse(text.match(/"partial_json":("(?:[^"\\]|\\.)*")/)![1]));
      expect(text).toContain('"name":"run_terminal_command"');
      expect(input.command).toContain('ACK-e2e-cli-1793300000000');
      expect(typeof input.description).toBe('string');
    });

    it('answers a call whose tools hold no shell with text, not an unknown tool', async () => {
      const text = await post('/v1/messages', {
        model: 'mock-model',
        tools: [{ name: 'session_title', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: prompt }],
      });
      expect(text).not.toContain('tool_use');
    });

    it('prefers Claude\'s exact Bash over BashOutput and KillShell', async () => {
      const text = await post('/v1/messages', {
        model: 'mock-model',
        tools: ['BashOutput', 'KillShell', 'Bash'].map((name) => ({ name, input_schema: { type: 'object' } })),
        messages: [{ role: 'user', content: prompt }],
      });
      expect(text).toContain('"name":"Bash"');
    });

    it('calls the OpenAI-chat tool by the name the CLI offers (Kimi: Bash)', async () => {
      const text = await post('/v1/chat/completions', {
        model: 'mock-model',
        tools: [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } } } }],
        messages: [{ role: 'user', content: prompt }],
      });
      expect(text).toContain('"name":"Bash"');
      expect(text).toContain('ACK-e2e-cli-1793300000000');
    });

    it('speaks Gemini: a run_shell_command call, then text after the functionResponse', async () => {
      const tools = [{ functionDeclarations: [{ name: 'run_shell_command', parametersJsonSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } } }] }];
      const first = await post('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools,
      });
      const call = JSON.parse(first.replace(/^data: /, '').trim()).candidates[0].content.parts[0].functionCall;
      expect(call.name).toBe('run_shell_command');
      // The reply command carries an env-snapshot fragment (live diagnostic)
      // followed by the real `botmux send`.
      expect(call.args.command).toMatch(/^printf '%s %s %s\\n' "\$\(date \+%s\)" "[\s\S]*" >> \.e2e-gemini-shell-env\.log; /);
      expect(call.args.command).toContain("GITHUB_SHA={${GITHUB_SHA+x}:${GITHUB_SHA-}}");
      expect(call.args.command).toContain("botmux send --mention-back 'ACK-e2e-cli-1793300000000'");

      const second = await post('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
        contents: [
          { role: 'user', parts: [{ text: prompt }] },
          { role: 'model', parts: [{ functionCall: call }] },
          { role: 'user', parts: [{ functionResponse: { name: 'run_shell_command', response: { output: 'sent' } } }] },
        ],
        tools,
      });
      expect(JSON.parse(second.replace(/^data: /, '').trim()).candidates[0].content.parts[0].text).toBeTypeOf('string');

      const routed = await fetch(`${baseUrl}/v1beta/models/flash:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'route' }] }], generationConfig: { responseJsonSchema: {} } }),
      }).then((r) => r.json() as Promise<any>);
      expect(JSON.parse(routed.candidates[0].content.parts[0].text)).toHaveProperty('complexity_score');
    });

    it('warns only after a marker asks the router >2 times without a main-model call', async () => {
      const warnings: string[] = [];
      const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args.join(' '));
      });
      const postRouter = () =>
        post('/v1beta/models/flash:generateContent', {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseJsonSchema: {} },
        });
      try {
        await postRouter();
        await postRouter();
        expect(warnings.filter((w) => w.includes('gemini router'))).toHaveLength(0);
        await postRouter();
        const hits = warnings.filter((w) => w.includes('gemini router') && w.includes('hit 3 times'));
        expect(hits).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });

    // The warning is about a *streak* of router verdicts with no main-model
    // call between them. A normal multi-step turn (router → tool call → …)
    // must not accumulate toward it.
    it('resets the router streak once the main model issues a function call', async () => {
      const resetPrompt = '请立刻调用 botmux send 在本话题里回复一行内容："ACK-e2e-rstfc-1793300000101"';
      const warnings: string[] = [];
      const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args.join(' '));
      });
      const shellTools = [{ functionDeclarations: [{ name: 'run_shell_command', parametersJsonSchema: { type: 'object', properties: { command: { type: 'string' } } } }] }];
      const routerTurn = () =>
        post('/v1beta/models/flash:generateContent', {
          contents: [{ role: 'user', parts: [{ text: resetPrompt }] }],
          generationConfig: { responseJsonSchema: {} },
        });
      const functionCallTurn = () =>
        post('/v1beta/models/gemini-2.5-pro:generateContent', {
          contents: [{ role: 'user', parts: [{ text: resetPrompt }] }],
          tools: shellTools,
        });
      try {
        // Three (router verdict → main-model tool call) pairs in one turn:
        // the router is asked 3 times, but a main-model call follows each.
        await routerTurn();
        await functionCallTurn();
        await routerTurn();
        await functionCallTurn();
        await routerTurn();
        expect(warnings.filter((w) => w.includes('gemini router'))).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('resets the router streak once the main model answers with plain text', async () => {
      const resetPrompt = '请立刻调用 botmux send 在本话题里回复一行内容："ACK-e2e-rsttxt-1793300000202"';
      const warnings: string[] = [];
      const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args.join(' '));
      });
      const routerTurn = () =>
        post('/v1beta/models/flash:generateContent', {
          contents: [{ role: 'user', parts: [{ text: resetPrompt }] }],
          generationConfig: { responseJsonSchema: {} },
        });
      // Declares tools but no shell (a title call): the main-model request is
      // answered with plain text, not a function call.
      const textTurn = () =>
        post('/v1beta/models/gemini-2.5-pro:generateContent', {
          contents: [{ role: 'user', parts: [{ text: resetPrompt }] }],
          tools: [{ functionDeclarations: [{ name: 'session_title' }] }],
        });
      try {
        await routerTurn();
        await routerTurn();
        await textTurn();
        await routerTurn();
        expect(warnings.filter((w) => w.includes('gemini router'))).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('never warns for JSON-verdict requests carrying no extractable ACK marker', async () => {
      // Title/summary generateJson calls share no topic identity; attributing
      // them to one bucket (and across bots on a shared mock server) would
      // warn without any router loop.
      const warnings: string[] = [];
      const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args.join(' '));
      });
      try {
        for (let i = 0; i < 4; i++) {
          await post('/v1beta/models/flash:generateContent', {
            contents: [{ role: 'user', parts: [{ text: `summarize title request ${i}` }] }],
            generationConfig: { responseJsonSchema: {} },
          });
        }
        expect(warnings.filter((w) => w.includes('gemini router'))).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('OpenAI Responses API (/v1/responses)', () => {
    it('generates response SSE stream with extracted marker', async () => {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-6-astra',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '请在最终回复中原样包含 CODEX_E2E_MARKER_999' }],
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const bodyText = await res.text();
      expect(bodyText).toContain('response.created');
      expect(bodyText).toContain('response.output_text.delta');
      expect(bodyText).toContain('"type":"output_text"');
      expect(bodyText).toContain('【MOCK-REPLY】');
      expect(bodyText).toContain('CODEX_E2E_MARKER_999');
      expect(bodyText).toContain('response.completed');

      const verifiedRes = await fetch(`${baseUrl}/mock/verified?marker=CODEX_E2E_MARKER_999`);
      expect(verifiedRes.status).toBe(200);
      const verifiedJson = await verifiedRes.json() as any;
      expect(verifiedJson.verified).toBe(true);

      const unverifiedRes = await fetch(`${baseUrl}/mock/verified?marker=NON_EXISTENT`);
      const unverifiedJson = await unverifiedRes.json() as any;
      expect(unverifiedJson.verified).toBe(false);
    });
  });

  describe('TapeRecorder replay with dynamic marker replacement', () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tape-test-'));
    });

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('saves and matches tape, substituting dynamic markers on replay', async () => {
      const recorder = new TapeRecorder(tmpDir);
      const mockTape: FixtureTape = {
        id: 'tape-sample',
        timestamp: Date.now(),
        request: {
          method: 'POST',
          path: '/v1/messages',
          model: 'claude-3-7-sonnet-20250219',
          body: {},
        },
        response: {
          status: 200,
          headers: {},
          events: [
            {
              event: 'message_start',
              data: JSON.stringify({ type: 'message_start' }),
            },
            {
              event: 'content_block_delta',
              data: JSON.stringify({
                type: 'content_block_delta',
                delta: { text: "botmux send --mention-back 'ACK-e2e-old-1111'" },
              }),
            },
          ],
        },
      };

      recorder.saveTape(mockTape);
      // Path matching works even when request contains query params
      const found = recorder.findTape('/v1/messages?beta=true', 'claude-3-7-sonnet-20250219');
      expect(found).not.toBeNull();
      expect(found?.id).toBe('tape-sample');

      // Replay tape and assert dynamic marker replacement
      let output = '';
      const fakeRes = {
        writeHead: () => {},
        write: (chunk: string) => {
          output += chunk;
        },
        end: () => {},
        destroyed: false,
        writableEnded: false,
      } as any;

      await recorder.replayTape(fakeRes, found!, 'ACK-e2e-new-2222');
      expect(output).toContain('ACK-e2e-new-2222');
      expect(output).not.toContain('ACK-e2e-old-1111');
    });

    it('replays non-streaming JSON tape response', async () => {
      const recorder = new TapeRecorder(tmpDir);
      const mockTape: FixtureTape = {
        id: 'tape-json',
        timestamp: Date.now(),
        request: {
          method: 'GET',
          path: '/v1/models',
        },
        response: {
          status: 200,
          headers: {},
          bodyJson: { object: 'list', data: [{ id: 'mock-model' }] },
          events: [],
        },
      };

      recorder.saveTape(mockTape);
      let output = '';
      let statusCode = 0;
      const fakeRes = {
        writeHead: (code: number) => {
          statusCode = code;
        },
        end: (body: string) => {
          output = body;
        },
      } as any;

      await recorder.replayTape(fakeRes, mockTape, null);
      expect(statusCode).toBe(200);
      expect(JSON.parse(output)).toEqual({ object: 'list', data: [{ id: 'mock-model' }] });
    });
  });
});
