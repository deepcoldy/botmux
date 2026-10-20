import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
