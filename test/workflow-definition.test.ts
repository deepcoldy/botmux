import { describe, expect, it } from 'vitest';
import {
  canonicalJsonStringify,
  computeRevisionId,
  parseWorkflowDefinition,
  topologicalOrder,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from '../src/workflows/definition.js';

// ─── fixture: trip-planner v0 ──────────────────────────────────────────────

function tripPlannerFixture(): unknown {
  return {
    workflowId: 'trip-planner',
    version: 1,
    params: {
      city: { type: 'string', required: true },
      date: { type: 'string', format: 'date', required: true },
    },
    defaults: {
      retryPolicy: { maxAttempts: 3, backoff: 'exponential', baseMs: 2000 },
      timeoutMs: 300_000,
      maxOutputBytes: 65_536,
    },
    nodes: {
      weather: {
        type: 'subagent',
        bot: 'claude-loopy',
        prompt: 'check {{params.city}} {{params.date}} weather',
        outputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['temp', 'condition'],
        },
      },
      plan: {
        type: 'subagent',
        bot: 'codex-loopy',
        depends: ['weather'],
        prompt: 'plan based on {{weather.output}}',
        outputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['items'],
        },
      },
      book_plan: {
        type: 'subagent',
        bot: 'gemini-travel',
        depends: ['plan'],
        humanGate: {
          stage: 'before',
          prompt: 'confirm? {{plan.output}}',
          deadlineMs: 3_600_000,
          onTimeout: 'fail',
        },
        prompt: 'produce booking plan JSON',
        outputSchema: { type: 'object', required: ['items'] },
        timeoutMs: 600_000,
      },
    },
  };
}

// ─── parseWorkflowDefinition ──────────────────────────────────────────────

describe('parseWorkflowDefinition', () => {
  it('accepts the trip-planner fixture', () => {
    const def = parseWorkflowDefinition(tripPlannerFixture());
    expect(def.workflowId).toBe('trip-planner');
    expect(Object.keys(def.nodes)).toEqual(['weather', 'plan', 'book_plan']);
    const bookPlan = def.nodes.book_plan!;
    expect(bookPlan.type).toBe('subagent');
    expect(bookPlan.humanGate?.stage).toBe('before');
  });

  it('rejects subagent missing required `bot`', () => {
    const raw = tripPlannerFixture() as { nodes: Record<string, Record<string, unknown>> };
    delete raw.nodes.weather!.bot;
    expect(() => parseWorkflowDefinition(raw)).toThrow();
  });

  it('rejects hostExecutor missing `executor`', () => {
    const raw = {
      workflowId: 'wf-x',
      version: 1,
      nodes: {
        only: { type: 'hostExecutor', input: { foo: 1 } },
      },
    };
    expect(() => parseWorkflowDefinition(raw)).toThrow();
  });

  it('rejects depends → unknown node', () => {
    const raw = {
      workflowId: 'wf-x',
      version: 1,
      nodes: {
        a: { type: 'subagent', bot: 'b', prompt: 'x', depends: ['ghost'] },
      },
    };
    expect(() => parseWorkflowDefinition(raw)).toThrow(/unknown node 'ghost'/);
  });

  it('rejects self-depend', () => {
    const raw = {
      workflowId: 'wf-x',
      version: 1,
      nodes: {
        a: { type: 'subagent', bot: 'b', prompt: 'x', depends: ['a'] },
      },
    };
    expect(() => parseWorkflowDefinition(raw)).toThrow(/depends on itself/);
  });

  it('rejects cycle a→b→a', () => {
    const raw = {
      workflowId: 'wf-x',
      version: 1,
      nodes: {
        a: { type: 'subagent', bot: 'b', prompt: 'x', depends: ['b'] },
        b: { type: 'subagent', bot: 'b', prompt: 'y', depends: ['a'] },
      },
    };
    expect(() => parseWorkflowDefinition(raw)).toThrow(/cycle/);
  });

  it('rejects nodeId with path separator', () => {
    const raw = {
      workflowId: 'wf-x',
      version: 1,
      nodes: {
        'a/b': { type: 'subagent', bot: 'b1', prompt: 'x' },
      },
    };
    expect(() => parseWorkflowDefinition(raw)).toThrow(/nodeId must match/);
  });

  it('rejects nodeId equal to ".."', () => {
    const raw = {
      workflowId: 'wf-x',
      version: 1,
      nodes: {
        '..': { type: 'subagent', bot: 'b1', prompt: 'x' },
      },
    };
    expect(() => parseWorkflowDefinition(raw)).toThrow(/path-traversal/);
  });

  it('rejects nodeId containing ".."', () => {
    const raw = {
      workflowId: 'wf-x',
      version: 1,
      nodes: {
        'foo..bar': { type: 'subagent', bot: 'b1', prompt: 'x' },
      },
    };
    expect(() => parseWorkflowDefinition(raw)).toThrow(/path-traversal/);
  });

  it('allows compound dotted nodeId like "node.v2"', () => {
    const raw = {
      workflowId: 'wf-x',
      version: 1,
      nodes: {
        'node.v2': { type: 'subagent', bot: 'b1', prompt: 'x' },
      },
    };
    expect(() => parseWorkflowDefinition(raw)).not.toThrow();
  });

  it('preserves optional node descriptions for authoring tools', () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-x',
      version: 1,
      nodes: {
        draft: {
          type: 'subagent',
          bot: 'b1',
          prompt: 'x',
          description: 'Use b1 because it has domain context.',
        },
        send: {
          type: 'hostExecutor',
          executor: 'feishu-send',
          depends: ['draft'],
          input: { content: { $ref: 'draft.output.text' } },
          description: 'Send the approved draft to Feishu.',
          // This test only checks descriptions, not gate semantics — the
          // explicit opt-in keeps it passing under the safe-by-default rule.
          unsafeAllowUngated: true,
        },
      },
    });

    expect(def.nodes.draft!.description).toBe('Use b1 because it has domain context.');
    expect(def.nodes.send!.description).toBe('Send the approved draft to Feishu.');
  });

  it('accepts params refs in bound prompt and hostExecutor input', () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-params',
      version: 1,
      params: {
        name: { type: 'string', required: true },
        chatId: { type: 'string', required: true },
      },
      nodes: {
        greet: {
          type: 'subagent',
          bot: 'b1',
          prompt: { $ref: 'params.name' },
        },
        send: {
          type: 'hostExecutor',
          executor: 'feishu-send',
          depends: ['greet'],
          input: {
            chatId: { $ref: 'params.chatId' },
            content: { $ref: 'greet.output.text' },
          },
          // Same as above — focus is on params ref resolution; opt out of
          // the side-effect gate so the test passes for the intended reason.
          unsafeAllowUngated: true,
        },
      },
    });

    expect(def.nodes.greet!.type).toBe('subagent');
    expect(def.nodes.send!.type).toBe('hostExecutor');
  });

  it('rejects empty nodes map', () => {
    const raw = { workflowId: 'wf-x', version: 1, nodes: {} };
    expect(() => parseWorkflowDefinition(raw)).toThrow();
  });

  it('rejects workflow with no root (all nodes have deps)', () => {
    // Two-node back-and-forth is already a cycle; build a 3-node case
    // that fails the root check before cycle detection by constructing
    // a graph where DAG exists but no root — impossible by definition.
    // Instead test: ensure validateGraph catches the "all-deps" pattern
    // via cycle detection (which it does for any closed loop).
    // Here we explicitly cover the no-root branch with a contrived case:
    const raw = {
      workflowId: 'wf-x',
      version: 1,
      nodes: {
        a: { type: 'subagent', bot: 'b', prompt: 'x', depends: ['b'] },
        b: { type: 'subagent', bot: 'b', prompt: 'y', depends: ['c'] },
        c: { type: 'subagent', bot: 'b', prompt: 'z', depends: ['a'] },
      },
    };
    expect(() => parseWorkflowDefinition(raw)).toThrow();
  });

  describe('side-effect executor gate', () => {
    function withSend(extra: Record<string, unknown> = {}): unknown {
      return {
        workflowId: 'wf-gate',
        version: 1,
        nodes: {
          draft: { type: 'subagent', bot: 'b', prompt: 'x' },
          send: {
            type: 'hostExecutor',
            executor: 'feishu-send',
            depends: ['draft'],
            input: { content: { $ref: 'draft.output.text' } },
            ...extra,
          },
        },
      };
    }

    it('rejects feishu-send without humanGate or unsafeAllowUngated', () => {
      expect(() => parseWorkflowDefinition(withSend())).toThrow(
        /side-effect executor 'feishu-send'.*humanGate/,
      );
    });

    it('rejects feishu-reply without humanGate or unsafeAllowUngated', () => {
      const raw = withSend();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (raw as any).nodes.send.executor = 'feishu-reply';
      expect(() => parseWorkflowDefinition(raw)).toThrow(/feishu-reply/);
    });

    it('rejects botmux-schedule without humanGate or unsafeAllowUngated', () => {
      const raw = withSend();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (raw as any).nodes.send.executor = 'botmux-schedule';
      expect(() => parseWorkflowDefinition(raw)).toThrow(/botmux-schedule/);
    });

    it('accepts feishu-send when humanGate.stage="before" is declared', () => {
      const def = parseWorkflowDefinition(withSend({
        humanGate: { stage: 'before', prompt: 'Approve send?' },
      }));
      expect(def.nodes.send!.humanGate?.stage).toBe('before');
    });

    it('accepts feishu-send when unsafeAllowUngated: true', () => {
      const def = parseWorkflowDefinition(withSend({ unsafeAllowUngated: true }));
      // Cast: the discriminated union doesn't expose unsafeAllowUngated as a
      // type-narrowed member because it sits on NodeBaseShape, not the
      // hostExecutor variant.  Round-tripping through parse preserves it.
      expect((def.nodes.send as { unsafeAllowUngated?: boolean }).unsafeAllowUngated).toBe(true);
    });

    it('does not gate non-side-effect executors', () => {
      // A hypothetical pure-compute executor (e.g. `format-json`) should
      // parse without gate or opt-in — only the named side-effect set is
      // governed.
      const raw = withSend();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (raw as any).nodes.send.executor = 'format-json';
      expect(() => parseWorkflowDefinition(raw)).not.toThrow();
    });
  });
});

// ─── canonical stringify + revisionId ────────────────────────────────────

describe('canonicalJsonStringify / computeRevisionId', () => {
  it('sorts object keys recursively', () => {
    const a = { b: 1, a: { y: 2, x: 1 } };
    const out = canonicalJsonStringify(a);
    expect(out).toBe('{"a":{"x":1,"y":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles null / numbers / booleans / strings', () => {
    const v = { z: null, a: 1, m: false, s: 'hi' };
    expect(canonicalJsonStringify(v)).toBe('{"a":1,"m":false,"s":"hi","z":null}');
  });

  it('revisionId stable across key reordering', () => {
    const original = tripPlannerFixture() as WorkflowDefinition;
    const reordered = {
      nodes: original.nodes,
      defaults: original.defaults,
      params: original.params,
      version: original.version,
      workflowId: original.workflowId,
    } as unknown as WorkflowDefinition;
    expect(computeRevisionId(original)).toBe(computeRevisionId(reordered));
  });

  it('revisionId changes when any value changes', () => {
    const a = parseWorkflowDefinition(tripPlannerFixture());
    const raw = tripPlannerFixture() as {
      nodes: Record<string, { prompt?: string }>;
    };
    raw.nodes.weather!.prompt = raw.nodes.weather!.prompt + ' MODIFIED';
    const b = parseWorkflowDefinition(raw);
    expect(computeRevisionId(a)).not.toBe(computeRevisionId(b));
  });

  it('revisionId is sha256:<64-hex>', () => {
    const def = parseWorkflowDefinition(tripPlannerFixture());
    expect(computeRevisionId(def)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ─── topologicalOrder ──────────────────────────────────────────────────────

describe('topologicalOrder', () => {
  it('returns deps before dependents', () => {
    const def = parseWorkflowDefinition(tripPlannerFixture());
    const order = topologicalOrder(def);
    expect(order).toEqual(['weather', 'plan', 'book_plan']);
  });

  it('handles diamond graph', () => {
    const def = parseWorkflowDefinition({
      workflowId: 'diamond',
      version: 1,
      nodes: {
        root: { type: 'subagent', bot: 'b', prompt: 'r' },
        left: { type: 'subagent', bot: 'b', prompt: 'l', depends: ['root'] },
        right: { type: 'subagent', bot: 'b', prompt: 'r', depends: ['root'] },
        sink: {
          type: 'subagent',
          bot: 'b',
          prompt: 's',
          depends: ['left', 'right'],
        },
      },
    });
    const order = topologicalOrder(def);
    expect(order[0]).toBe('root');
    expect(order[order.length - 1]).toBe('sink');
    expect(order.indexOf('left')).toBeLessThan(order.indexOf('sink'));
    expect(order.indexOf('right')).toBeLessThan(order.indexOf('sink'));
  });
});
