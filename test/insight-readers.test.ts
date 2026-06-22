import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAntigravityInsight } from '../src/services/insight/antigravity-span-reader.js';
import { parseClaudeInsight } from '../src/services/insight/claude-span-reader.js';
import { parseCodexInsight } from '../src/services/insight/codex-span-reader.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-insight-readers-'));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fp(name: string): string {
  return join(dir, name);
}

describe('insight span readers', () => {
  it('pairs Claude tool_use/tool_result and ignores trailing partial JSONL', () => {
    const path = fp('claude.jsonl');
    writeFileSync(path, [
      JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:00.000Z', message: { role: 'user', content: 'run tests' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-17T01:00:01.000Z',
        message: { id: 'm1', role: 'assistant', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 }, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo $OPENAI_API_KEY' } }] },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-06-17T01:00:03.500Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'sk-secret-output' }] },
      }),
      '{"type":"assistant"',
    ].join('\n'), 'utf-8');

    const parsed = parseClaudeInsight(path);
    expect(parsed.partial).toBe(true);
    expect(parsed.spans).toHaveLength(1);
    expect(parsed.spans[0]).toMatchObject({
      tool: 'Bash',
      phase: 'run',
      turnIndex: 0,
      status: 'error',
      inputSummary: 'shell command',
      outputSummary: 'tool error',
      durationMs: 2500,
      intent: { kind: 'unknown' },
      result: { category: 'command_failed' },
      evidence: {
        command: { text: 'echo $OPENAI_API_KEY', truncated: false },
        output: { text: '<redacted>', truncated: false },
      },
    });
    expect(parsed.turnPrompts?.[0]).toEqual({ text: 'run tests', truncated: false });
    expect(parsed.turnContext?.[0]).toEqual({
      turnIndex: 0,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreateTokens: 4,
      contextTokens: 134,
      totalTokens: 154,
    });
  });

  it('pairs Codex calls by call_id and extracts wrapper duration/exit status safely', () => {
    const path = fp('codex.jsonl');
    writeFileSync(path, [
      JSON.stringify({ type: 'event_msg', timestamp: '2026-06-17T01:00:00.000Z', payload: { type: 'user_message', message: 'build' } }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-06-17T01:00:01.000Z',
        payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"npm test"}' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-06-17T01:00:09.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: 'Wall time: 7.25s\nProcess exited with code 1\nOutput:\nTOKEN=secret',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-17T01:00:10.000Z',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 1200, output_tokens: 80, cached_input_tokens: 400 } },
        },
      }),
    ].join('\n') + '\n', 'utf-8');

    const parsed = parseCodexInsight(path);
    expect(parsed.partial).toBe(false);
    expect(parsed.spans).toHaveLength(1);
    expect(parsed.spans[0]).toMatchObject({
      tool: 'exec_command',
      phase: 'run',
      status: 'error',
      inputSummary: 'shell command',
      outputSummary: 'exit 1',
      durationMs: 7250,
      intent: { kind: 'test', subject: 'npm test' },
      result: { category: 'test_failed', exitCode: 1 },
      evidence: {
        command: { text: 'npm test', truncated: false },
        output: { text: expect.stringContaining('TOKEN=<redacted>'), truncated: false },
      },
    });
    expect(parsed.turnPrompts?.[0]).toEqual({ text: 'build', truncated: false });
    expect(parsed.turnContext?.[0]).toEqual({
      turnIndex: 0,
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 400,
      cacheCreateTokens: 0,
      contextTokens: 1600,
      totalTokens: 1680,
    });
  });

  it('scrubs secrets from prompt previews while preserving prompt text', () => {
    const path = fp('codex-prompt.jsonl');
    writeFileSync(path, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-17T01:00:00.000Z',
        payload: { type: 'user_message', message: 'run deploy with token=sk-1234567890abcdef and explain result' },
      }),
    ].join('\n') + '\n', 'utf-8');

    const parsed = parseCodexInsight(path);
    expect(parsed.turnPrompts?.[0]?.text).toBe('run deploy with token=<redacted> and explain result');
  });

  it('keeps prompt previews short and marks long prompt text as truncated', () => {
    const path = fp('codex-long-prompt.jsonl');
    const longPrompt = `summarize this markdown\n\n${'x'.repeat(1500)}`;
    writeFileSync(path, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-17T01:00:00.000Z',
        payload: { type: 'user_message', message: longPrompt },
      }),
    ].join('\n') + '\n', 'utf-8');

    const parsed = parseCodexInsight(path);
    expect(parsed.turnPrompts?.[0]?.text.length).toBe(400);
    expect(parsed.turnPrompts?.[0]?.truncated).toBe(true);
  });

  it('extracts botmux user prompt text before scrubbing and truncating', () => {
    const path = fp('codex-botmux-prompt.jsonl');
    writeFileSync(path, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-17T01:00:00.000Z',
        payload: {
          type: 'user_message',
          message: [
            '<session_id>6d0a2343</session_id>',
            '<botmux_reminder>回复必须 botmux send</botmux_reminder>',
            '<user_message>',
            '[用户引用了消息 用 botmux quoted om_x 查看]',
            '请分析这轮失败，token=sk-1234567890abcdef',
            '</user_message>',
            '<sender type="user" open_id="ou_secret" name="老滕" />',
            '<mentions><mention name="codex" /></mentions>',
          ].join('\n'),
        },
      }),
    ].join('\n') + '\n', 'utf-8');

    const parsed = parseCodexInsight(path);
    expect(parsed.turnPrompts?.[0]).toEqual({
      text: '请分析这轮失败，token=<redacted>',
      truncated: false,
      source: {
        kind: 'user',
        senderType: 'user',
        senderName: '老滕',
        mentionedNames: ['codex'],
      },
    });
    expect(parsed.turnPrompts?.[0]?.text).not.toContain('<user_message>');
    expect(parsed.turnPrompts?.[0]?.text).not.toContain('<mentions>');
    expect(parsed.turnPrompts?.[0]?.text).not.toContain('用户引用了消息');
    expect(JSON.stringify(parsed.turnPrompts?.[0])).not.toContain('ou_secret');
  });

  it('marks bot-origin prompt wrappers as a2a source without exposing open_id', () => {
    const path = fp('codex-a2a-prompt.jsonl');
    writeFileSync(path, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-17T01:00:00.000Z',
        payload: {
          type: 'user_message',
          message: [
            '<user_message>',
            '[来自 claude-loopy 的 @mention]',
            '请接力看这个失败',
            '</user_message>',
            '<sender type="bot" open_id="ou_bot_secret" name="claude-loopy" />',
            '<mentions><mention name="codex-loopy" /></mentions>',
          ].join('\n'),
        },
      }),
    ].join('\n') + '\n', 'utf-8');

    const parsed = parseCodexInsight(path);
    expect(parsed.turnPrompts?.[0]).toEqual({
      text: '请接力看这个失败',
      truncated: false,
      source: {
        kind: 'a2a_agent',
        agentName: 'claude-loopy',
        senderType: 'bot',
        senderName: 'claude-loopy',
        isBotSender: true,
        isA2A: true,
        mentionedNames: ['codex-loopy', 'claude-loopy'],
      },
    });
    expect(JSON.stringify(parsed.turnPrompts?.[0])).not.toContain('ou_bot_secret');
  });

  it('infers human prompt source for legacy botmux messages without sender tag', () => {
    const path = fp('codex-legacy-human-prompt.jsonl');
    writeFileSync(path, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-17T01:00:00.000Z',
        payload: {
          type: 'user_message',
          message: [
            '<user_message>',
            '@claude-loopy 帮我看下这轮失败',
            '</user_message>',
          ].join('\n'),
        },
      }),
    ].join('\n') + '\n', 'utf-8');

    const parsed = parseCodexInsight(path);
    expect(parsed.turnPrompts?.[0]).toEqual({
      text: '@claude-loopy 帮我看下这轮失败',
      truncated: false,
      source: {
        kind: 'user',
        senderType: 'user',
      },
    });
  });

  it('classifies task-notification prompts as system source', () => {
    const path = fp('codex-task-notification-prompt.jsonl');
    writeFileSync(path, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-17T01:00:00.000Z',
        payload: {
          type: 'user_message',
          message: [
            '<user_message>',
            '<task-notification>',
            '后台任务完成',
            '</task-notification>',
            '</user_message>',
          ].join('\n'),
        },
      }),
    ].join('\n') + '\n', 'utf-8');

    const parsed = parseCodexInsight(path);
    expect(parsed.turnPrompts?.[0]).toEqual({
      text: '<task-notification>\n后台任务完成\n</task-notification>',
      truncated: false,
      source: {
        kind: 'system',
        senderType: 'system',
      },
    });
  });

  it('projects allow-listed Claude intents without exposing raw paths or tokens', () => {
    const path = fp('claude-intents.jsonl');
    writeFileSync(path, [
      JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:00.000Z', message: { role: 'user', content: 'inspect' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-17T01:00:01.000Z',
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/private/customer/src/app.ts' } },
          { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pnpm exec tsc --token sk-secret' } },
        ] },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-06-17T01:00:02.000Z',
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'r1', content: 'secret file body' },
          { type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'Type error with sk-secret' },
        ] },
      }),
    ].join('\n') + '\n', 'utf-8');

    const parsed = parseClaudeInsight(path);
    expect(parsed.spans[0]).toMatchObject({
      tool: 'Read',
      intent: { kind: 'read_file', subject: 'app.ts' },
      result: { category: 'ok' },
    });
    expect(parsed.spans[1]).toMatchObject({
      tool: 'Bash',
      intent: { kind: 'typecheck', subject: 'pnpm exec tsc' },
      result: { category: 'typecheck_failed' },
    });
    expect(JSON.stringify(parsed)).not.toContain('sk-secret');
  });

  it('maps Antigravity planner tool calls and result events into safe spans', () => {
    const path = fp('antigravity.jsonl');
    writeFileSync(path, [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-06-17T01:00:00Z',
        content: '<USER_REQUEST>run checks with token=sk-1234567890abcdef</USER_REQUEST><ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-06-17T01:00:01Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"pnpm test --token sk-secret"', Cwd: '"/repo"', toolSummary: '"Run tests"' } }],
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'RUN_COMMAND',
        status: 'DONE',
        created_at: '2026-06-17T01:00:03Z',
        content: 'Created At: 2026-06-17T01:00:01Z Completed At: 2026-06-17T01:00:03Z Process exited with code 1\nOPENAI_API_KEY=secret',
      }),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-06-17T01:00:04Z',
        tool_calls: [{ name: 'view_file', args: { AbsolutePath: '"file:///repo/src/app.ts"', toolSummary: '"Read app"' } }],
      }),
      JSON.stringify({
        step_index: 4,
        source: 'MODEL',
        type: 'VIEW_FILE',
        status: 'DONE',
        created_at: '2026-06-17T01:00:05Z',
        content: 'Created At: 2026-06-17T01:00:04Z Completed At: 2026-06-17T01:00:05Z File Path: `file:///repo/src/app.ts` Total Lines: 3',
      }),
    ].join('\n') + '\n', 'utf-8');

    const parsed = parseAntigravityInsight(path);
    expect(parsed.turnPrompts?.[0]).toEqual({
      text: 'run checks with token=<redacted>',
      truncated: false,
    });
    expect(parsed.spans).toHaveLength(2);
    expect(parsed.spans[0]).toMatchObject({
      tool: 'Bash',
      phase: 'run',
      turnIndex: 0,
      status: 'error',
      durationMs: 2000,
      intent: { kind: 'test', subject: 'pnpm test' },
      result: { category: 'test_failed', exitCode: 1 },
      evidence: {
        command: { text: 'pnpm test --token <redacted>', truncated: false },
        output: { text: expect.stringContaining('OPENAI_API_KEY=<redacted>'), truncated: false },
      },
    });
    expect(parsed.spans[1]).toMatchObject({
      tool: 'Read',
      phase: 'research',
      status: 'ok',
      filePaths: ['/repo/src/app.ts'],
      intent: { kind: 'read_file', subject: 'app.ts' },
    });
    expect(JSON.stringify(parsed)).not.toContain('sk-secret');
  });

  it('captures Claude agent narration (text blocks), scrubs secrets, excludes thinking, keeps tool_use', () => {
    const path = fp('claude-say.jsonl');
    writeFileSync(path, [
      JSON.stringify({ type: 'user', timestamp: '2026-06-17T01:00:00.000Z', message: { role: 'user', content: 'fix the bug' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-17T01:00:01.000Z', message: { id: 'm1', role: 'assistant', content: [
        { type: 'text', text: 'Let me look. token=sk-abcdef1234567890 is set.' },
        { type: 'thinking', thinking: 'hidden reasoning sk-shouldnotleak98765' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.ts' } },
      ] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-17T01:00:02.000Z', message: { id: 'm2', role: 'assistant', content: [
        { type: 'text', text: 'Done — fixed it.' },
      ] } }),
    ].join('\n') + '\n', 'utf-8');

    const parsed = parseClaudeInsight(path);
    // both narration segments in the same turn are concatenated
    expect(parsed.turnAgentSay?.[0]?.text).toContain('Let me look.');
    expect(parsed.turnAgentSay?.[0]?.text).toContain('Done — fixed it.');
    // a secret echoed in narration is scrubbed
    expect(parsed.turnAgentSay?.[0]?.text).toContain('token=<redacted>');
    expect(JSON.stringify(parsed.turnAgentSay)).not.toContain('sk-abcdef1234567890');
    // thinking / chain-of-thought is never captured
    expect(JSON.stringify(parsed.turnAgentSay)).not.toContain('hidden reasoning');
    expect(JSON.stringify(parsed.turnAgentSay)).not.toContain('sk-shouldnotleak98765');
    // the tool_use sharing the assistant message is still captured as a span
    expect(parsed.spans).toHaveLength(1);
    expect(parsed.spans[0]).toMatchObject({ tool: 'Read', turnIndex: 0 });
  });

  it('captures Codex agent narration (agent_message), scrubs secrets, excludes agent_reasoning', () => {
    const path = fp('codex-say.jsonl');
    writeFileSync(path, [
      JSON.stringify({ type: 'event_msg', timestamp: '2026-06-17T01:00:00.000Z', payload: { type: 'user_message', message: 'deploy' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-06-17T01:00:01.000Z', payload: { type: 'agent_message', message: 'Deploying with key=sk-deadbeef12345678 now.' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-06-17T01:00:02.000Z', payload: { type: 'agent_reasoning', message: 'hidden codex reasoning sk-reasonleak0000' } }),
    ].join('\n') + '\n', 'utf-8');

    const parsed = parseCodexInsight(path);
    expect(parsed.turnAgentSay?.[0]?.text).toContain('Deploying with');
    expect(parsed.turnAgentSay?.[0]?.text).toContain('key=<redacted>');
    expect(JSON.stringify(parsed.turnAgentSay)).not.toContain('sk-deadbeef12345678');
    // agent_reasoning is never captured
    expect(JSON.stringify(parsed.turnAgentSay)).not.toContain('hidden codex reasoning');
    expect(JSON.stringify(parsed.turnAgentSay)).not.toContain('sk-reasonleak0000');
  });
});
