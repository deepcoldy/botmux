import { describe, expect, it } from 'vitest';
import {
  bridgeAtomcodeForm,
  bridgeAtomcodePermission,
  parseAtomcodeForm,
} from '../src/services/atomcode-user-input.js';

const ctx = {
  sessionId: 'sess-1',
  larkAppId: 'cli_test',
  chatId: 'oc_test',
};

describe('parseAtomcodeForm', () => {
  it('parses AtomCode single-choice enum, multi-choice items.enum, and free-text batch schema', () => {
    const parsed = parseAtomcodeForm({
      mode: 'form',
      message: 'Please answer the following questions.',
      requestedSchema: {
        type: 'object',
        properties: {
          q1: { type: 'string', title: 'Language', enum: ['Rust', 'TypeScript'] },
          q2: { type: 'array', title: 'Features', description: 'Pick any', items: { type: 'string', enum: ['ACP', 'V3'] } },
          q3: { type: 'string', title: 'Notes' },
        },
        required: ['q1', 'q2', 'q3'],
      },
    });
    expect(parsed.fields).toHaveLength(3);
    expect(parsed.fields[0]).toMatchObject({ id: 'q1', multi: false, required: true });
    expect(parsed.fields[0].options?.map(o => o.value)).toEqual(['Rust', 'TypeScript']);
    expect(parsed.fields[1]).toMatchObject({ id: 'q2', multi: true, required: true });
    expect(parsed.fields[1].options?.map(o => o.value)).toEqual(['ACP', 'V3']);
    expect(parsed.fields[2]).toMatchObject({ id: 'q3', multi: false, required: true, options: undefined });
  });

  it('rejects unsupported keywords or non-form schemas fail-closed', () => {
    expect(() => parseAtomcodeForm({ mode: 'url', requestedSchema: {} })).toThrow();
    expect(() => parseAtomcodeForm({
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: { a: { type: 'number' } },
      },
    })).toThrow();
    expect(() => parseAtomcodeForm({
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: { a: { type: 'string', pattern: '^[a-z]+$' } },
      },
    })).toThrow();
  });
});

describe('bridgeAtomcodeForm', () => {
  it('batches choice questions and asks text questions separately', async () => {
    const calls: unknown[] = [];
    const result = await bridgeAtomcodeForm(ctx, {
      mode: 'form',
      message: 'Please answer the following questions.',
      requestedSchema: {
        type: 'object',
        properties: {
          q1: { type: 'string', title: 'Env', enum: ['dev', 'prod'] },
          q2: { type: 'array', title: 'Targets', items: { type: 'string', enum: ['linux', 'macos'] } },
          q3: { type: 'string', title: 'Reason' },
        },
        required: ['q1', 'q2', 'q3'],
      },
    }, new AbortController().signal, async (_c, params) => {
      calls.push(params);
      if (calls.length === 1) {
        return { answers: { q1: { answers: ['prod'] }, q2: { answers: ['linux', 'macos'] } } };
      }
      return { answers: { q3: { answers: ['release cut'] } } };
    });

    expect(calls).toHaveLength(2);
    expect(result).toEqual({
      action: 'accept',
      content: { q1: 'prod', q2: ['linux', 'macos'], q3: 'release cut' },
    });
  });

  it('supports titled oneOf/anyOf options and optional skip', async () => {
    const result = await bridgeAtomcodeForm(ctx, {
      mode: 'form',
      message: 'Choose mode',
      requestedSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            title: 'Mode',
            oneOf: [
              { const: 'fast', title: 'Fast', description: 'Skip deep checks' },
              { const: 'safe', title: 'Safe', description: 'Run all checks' },
            ],
          },
          note: { type: 'string', title: 'Note' },
        },
        required: ['mode'],
      },
    }, new AbortController().signal, async (_c, params) => {
      const firstId = (params as any).questions[0].id;
      if (firstId === 'mode') return { answers: { mode: { answers: ['Safe'] } } };
      return { answers: { note: { answers: ['跳过'] } } };
    });

    expect(result).toEqual({ action: 'accept', content: { mode: 'safe' } });
  });
});

describe('bridgeAtomcodePermission', () => {
  it('bridges AtomCode permission options back to selected optionId', async () => {
    let seenQuestion = '';
    const res = await bridgeAtomcodePermission(ctx, {
      sessionId: 'acp-1',
      toolCall: { toolCallId: 'tc-1', title: 'bash', rawInput: { command: 'rm -rf tmp' } },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
      ],
    }, new AbortController().signal, async (_c, params) => {
      seenQuestion = (params as any).questions[0].question;
      return { answers: { permission: { answers: ['Always allow (2)'] } } };
    });

    expect(seenQuestion).toContain('AtomCode 请求权限：bash');
    expect(seenQuestion).toContain('rm -rf tmp');
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_always' } });
  });
});
