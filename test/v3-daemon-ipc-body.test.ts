import { describe, expect, it } from 'vitest';

import { parseWorkflowDaemonMutationBody } from '../src/workflows/v3/daemon-ipc-body.js';

describe('parseWorkflowDaemonMutationBody', () => {
  it('accepts only canonical {} for start and rejects an empty transport body', () => {
    expect(parseWorkflowDaemonMutationBody('start', '{}')).toEqual({
      ok: true,
      body: { mutation: 'start', value: {} },
    });
    expect(parseWorkflowDaemonMutationBody('start', ''))
      .toEqual({ ok: false, error: 'bad_json' });
    expect(parseWorkflowDaemonMutationBody('start', '{"extra":1}'))
      .toEqual({ ok: false, error: 'bad_body' });
  });

  it.each([
    ['leading whitespace', ' {}'],
    ['pretty printed', '{\n}'],
    ['trailing whitespace', '{}\n'],
    ['duplicate keys', '{"reason":"first","reason":"second"}'],
  ])('rejects non-canonical JSON: %s', (_name, bodyRaw) => {
    expect(parseWorkflowDaemonMutationBody('cancel', bodyRaw))
      .toEqual({ ok: false, error: 'bad_json' });
  });

  it('strictly parses and trims the optional cancel reason', () => {
    expect(parseWorkflowDaemonMutationBody('cancel', '{"reason":"  stop now  "}')).toEqual({
      ok: true,
      body: { mutation: 'cancel', value: { reason: 'stop now' } },
    });
    for (const bodyRaw of [
      '{"reason":"   "}',
      '{"reason":42}',
      JSON.stringify({ reason: 'x'.repeat(501) }),
      JSON.stringify({ reason: 'bad\0reason' }),
    ]) {
      expect(parseWorkflowDaemonMutationBody('cancel', bodyRaw))
        .toEqual({ ok: false, error: 'bad_reason' });
    }
  });

  it('accepts safe node/loop ids and rejects ambiguous or path-like values', () => {
    expect(parseWorkflowDaemonMutationBody('retry', '{"nodeId":"node_1.a-b"}')).toEqual({
      ok: true,
      body: { mutation: 'retry', value: { nodeId: 'node_1.a-b' } },
    });
    expect(parseWorkflowDaemonMutationBody('grant', '{"loopId":"loop-2"}')).toEqual({
      ok: true,
      body: { mutation: 'grant', value: { loopId: 'loop-2' } },
    });
    const longButDagValidId = 'node'.repeat(80);
    expect(parseWorkflowDaemonMutationBody(
      'retry',
      JSON.stringify({ nodeId: longButDagValidId }),
    )).toEqual({
      ok: true,
      body: { mutation: 'retry', value: { nodeId: longButDagValidId } },
    });
    for (const [mutation, bodyRaw, error] of [
      ['retry', '{"nodeId":"../node"}', 'bad_node_id'],
      ['retry', '{"nodeId":"node with spaces"}', 'bad_node_id'],
      ['retry', '{"nodeId":1}', 'bad_node_id'],
      ['grant', '{"loopId":"loop/slash"}', 'bad_loop_id'],
      ['grant', '{"loopId":false}', 'bad_loop_id'],
    ] as const) {
      expect(parseWorkflowDaemonMutationBody(mutation, bodyRaw)).toEqual({ ok: false, error });
    }
  });

  it.each([
    ['cancel', '{'] as const,
    ['retry', '{'] as const,
    ['grant', '{'] as const,
  ])('rejects malformed JSON for %s', (mutation, bodyRaw) => {
    expect(parseWorkflowDaemonMutationBody(mutation, bodyRaw))
      .toEqual({ ok: false, error: 'bad_json' });
  });

  it.each([
    ['start', 'null'] as const,
    ['cancel', '[]'] as const,
    ['retry', '"node"'] as const,
    ['grant', '1'] as const,
    ['cancel', '{"reason":"ok","extra":true}'] as const,
    ['retry', '{"__proto__":{},"nodeId":"n"}'] as const,
    ['grant', '{"constructor":{},"loopId":"l"}'] as const,
  ])('rejects non-objects and unknown keys for %s', (mutation, bodyRaw) => {
    expect(parseWorkflowDaemonMutationBody(mutation, bodyRaw))
      .toEqual({ ok: false, error: 'bad_body' });
  });
});
