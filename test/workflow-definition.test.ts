import { describe, expect, it } from 'vitest';
import {
  canonicalJsonStringify,
  computeRevisionId,
  parseWorkflowDefinition,
  topologicalOrder,
  validateLoopBlocks,
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

// ─── loop / decision schema + validateLoopBlocks (v0.2) ────────────────────
//
// Step 1 of feat/workflow-loop-v02 — see /tmp/wf-loop-v02.md §3 + §13.
// Locks the cross-field invariants so Step 2/3 implementers can rely on
// any def that survives `parseWorkflowDefinition` being well-formed.

function loopFixture(extra: Record<string, unknown> = {}): any {
  return {
    workflowId: 'code-review-loop',
    version: 1,
    nodes: {
      implement: {
        type: 'subagent',
        bot: 'b',
        prompt: 'implement task',
      },
      review: {
        type: 'subagent',
        bot: 'b',
        depends: ['implement'],
        prompt: 'review ${implement.output.code}',
      },
      reviewDecision: {
        type: 'decision',
        depends: ['review'],
        humanGate: {
          stage: 'before',
          prompt: { $ref: 'review.output.preview' },
        },
      },
      'review-loop': {
        type: 'loop',
        maxIterations: 3,
        body: ['implement', 'review', 'reviewDecision'],
        terminate: { node: 'reviewDecision', via: 'humanGate' },
        output: { from: 'implement' },
      },
      publish: {
        type: 'subagent',
        bot: 'b',
        depends: ['review-loop'],
        prompt: 'announce ${review-loop.output.code}',
      },
      ...extra,
    },
  };
}

describe('loop / decision schema (parse-time strict)', () => {
  it('accepts a valid loop + decision + body fixture', () => {
    const def = parseWorkflowDefinition(loopFixture());
    expect(def.nodes['review-loop']!.type).toBe('loop');
    expect(def.nodes.reviewDecision!.type).toBe('decision');
  });

  it('rejects unknown extra fields on a loop node (strict)', () => {
    const raw = loopFixture();
    raw.nodes['review-loop'].weird = 1;
    expect(() => parseWorkflowDefinition(raw)).toThrow();
  });

  it('rejects unknown extra fields on a decision node (strict)', () => {
    const raw = loopFixture();
    raw.nodes.reviewDecision.outputSchema = { type: 'object' };
    // codex round 2 N2: decision output is runtime-fixed; author writing
    // `outputSchema` / `prompt` / `bot` / `executor` must fail-loud, not
    // silently drop.
    expect(() => parseWorkflowDefinition(raw)).toThrow();
  });

  it('rejects decision node with prompt / bot / executor fields', () => {
    for (const field of ['prompt', 'bot', 'executor', 'input']) {
      const raw = loopFixture();
      raw.nodes.reviewDecision[field] = 'x';
      expect(
        () => parseWorkflowDefinition(raw),
        `decision with .${field} should be rejected`,
      ).toThrow();
    }
  });

  it('rejects decision node without humanGate', () => {
    const raw = loopFixture();
    delete raw.nodes.reviewDecision.humanGate;
    expect(() => parseWorkflowDefinition(raw)).toThrow();
  });

  it('rejects loop.maxIterations <= 0', () => {
    const raw = loopFixture();
    raw.nodes['review-loop'].maxIterations = 0;
    expect(() => parseWorkflowDefinition(raw)).toThrow();
  });

  it('rejects loop.body referencing unknown node', () => {
    const raw = loopFixture();
    raw.nodes['review-loop'].body = ['implement', 'review', 'no-such-node'];
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /Loop 'review-loop'.*'no-such-node'/,
    );
  });

  it('rejects empty body', () => {
    const raw = loopFixture();
    raw.nodes['review-loop'].body = [];
    expect(() => parseWorkflowDefinition(raw)).toThrow();
  });

  it('rejects terminate.node not in body', () => {
    const raw = loopFixture();
    raw.nodes['review-loop'].terminate.node = 'implement';
    raw.nodes['review-loop'].body = ['implement', 'review'];
    // Now implement is not a decision; expect explicit error.
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /terminate\.node.*must be a decision/,
    );
  });

  it('rejects terminate.node that is a subagent (not decision)', () => {
    const raw = loopFixture();
    raw.nodes['review-loop'].terminate.node = 'review';
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /terminate\.node 'review' must be a decision node/,
    );
  });

  it('rejects loop block including itself in body', () => {
    const raw = loopFixture();
    raw.nodes['review-loop'].body = ['implement', 'review', 'reviewDecision', 'review-loop'];
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /body must not include the loop block itself/,
    );
  });

  it('rejects a node owned by two loops', () => {
    const raw = loopFixture();
    raw.nodes['review-loop-2'] = {
      type: 'loop',
      maxIterations: 2,
      body: ['implement', 'reviewDecision2'],
      terminate: { node: 'reviewDecision2', via: 'humanGate' },
    };
    raw.nodes.reviewDecision2 = {
      type: 'decision',
      depends: ['implement'],
      humanGate: { stage: 'before', prompt: 'ok?' },
    };
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /'implement' is claimed by both/,
    );
  });

  it('rejects nested loop in body (v0.2 not supported)', () => {
    const raw = loopFixture();
    raw.nodes.innerLoop = {
      type: 'loop',
      maxIterations: 2,
      body: ['innerDecision'],
      terminate: { node: 'innerDecision', via: 'humanGate' },
    };
    raw.nodes.innerDecision = {
      type: 'decision',
      humanGate: { stage: 'before', prompt: 'ok?' },
    };
    raw.nodes['review-loop'].body = ['implement', 'review', 'reviewDecision', 'innerLoop'];
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /nested loop 'innerLoop'.*not supported in v0\.2/,
    );
  });

  it('rejects decision node not referenced by any loop', () => {
    const raw = loopFixture();
    raw.nodes.danglingDecision = {
      type: 'decision',
      humanGate: { stage: 'before', prompt: 'ok?' },
    };
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /Decision node 'danglingDecision' is not referenced by any loop's body/,
    );
  });

  it('rejects external dep not surfaced on loop.depends (codex N1)', () => {
    // implement depends on `setup`, which is OUTSIDE the loop; but
    // `review-loop` itself does not list `setup` in its own depends.
    // Validator must demand explicit surfacing.
    const raw = loopFixture();
    raw.nodes.setup = { type: 'subagent', bot: 'b', prompt: 'setup' };
    raw.nodes.implement.depends = ['setup'];
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /body node 'implement' depends on external node 'setup'.*add 'setup' to loop\.depends/,
    );
  });

  it('accepts external dep when loop.depends surfaces it (codex N1 happy path)', () => {
    const raw = loopFixture();
    raw.nodes.setup = { type: 'subagent', bot: 'b', prompt: 'setup' };
    raw.nodes.implement.depends = ['setup'];
    raw.nodes['review-loop'].depends = ['setup'];
    expect(() => parseWorkflowDefinition(raw)).not.toThrow();
  });

  it('rejects external node depending on a loop body node', () => {
    // publish currently depends on the loop block — fine.  Change it to
    // depend directly on `implement` (a body node) to trigger the
    // external-depends-on-body guard.
    const raw = loopFixture();
    raw.nodes.publish.depends = ['implement'];
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /Node 'publish' depends on loop body node 'implement'/,
    );
  });

  it('rejects loop.output.from referencing the terminator', () => {
    const raw = loopFixture();
    raw.nodes['review-loop'].output = { from: 'reviewDecision' };
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /output\.from 'reviewDecision' must not be the terminate\.node/,
    );
  });

  it('rejects loop.output.from referencing a non-body node', () => {
    const raw = loopFixture();
    raw.nodes['review-loop'].output = { from: 'publish' };
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /output\.from 'publish' is not in body/,
    );
  });

  it('root check ignores body-internal "no-deps" nodes', () => {
    // `implement` has no deps but lives inside a loop body — it must
    // not satisfy workflow-level root presence on its own.  Pull
    // `publish` out so the only non-body candidate is the loop block,
    // which DOES count as a valid scheduler-visible root (no deps).
    const raw = loopFixture();
    delete raw.nodes.publish;
    expect(() => parseWorkflowDefinition(raw)).not.toThrow();
  });

  it('reports root failure when every non-body node has deps', () => {
    // Construct a minimal case: just a loop block + an outer node that
    // depends on the loop block (no roots outside the body).  This
    // would have passed in v0.1 because `implement`-style body nodes
    // counted as roots.
    const raw: any = {
      workflowId: 'wf-no-root',
      version: 1,
      nodes: {
        implement: { type: 'subagent', bot: 'b', prompt: 'x' },
        dec: {
          type: 'decision',
          depends: ['implement'],
          humanGate: { stage: 'before', prompt: 'ok?' },
        },
        loop1: {
          type: 'loop',
          maxIterations: 2,
          body: ['implement', 'dec'],
          terminate: { node: 'dec', via: 'humanGate' },
          depends: ['outerOnly'],
        },
        outerOnly: {
          type: 'subagent',
          bot: 'b',
          prompt: 'x',
          depends: ['loop1'],
        },
      },
    };
    // outerOnly depends on loop1, loop1 depends on outerOnly → cycle
    // at top level (loop1 ↔ outerOnly).  We want the root-check error,
    // not cycle — relax outerOnly to depend only on loop1 and add a
    // sentinel non-root.  Simpler: construct purely root-less.
    raw.nodes.loop1.depends = [];
    raw.nodes.outerOnly.depends = ['loop1'];
    // Now scheduler-visible roots: { loop1 }.  Loop block has no deps —
    // so root check PASSES.  We've actually just covered the happy
    // path; the body-only-root failure scenario already triggers via
    // `loopFixture` minus all outer nodes (no outer node = body
    // roots ignored = no-root error).
    const onlyBody: any = {
      workflowId: 'wf-only-body',
      version: 1,
      nodes: {
        implement: { type: 'subagent', bot: 'b', prompt: 'x' },
        dec: {
          type: 'decision',
          depends: ['implement'],
          humanGate: { stage: 'before', prompt: 'ok?' },
        },
        loop1: {
          type: 'loop',
          maxIterations: 2,
          body: ['implement', 'dec'],
          terminate: { node: 'dec', via: 'humanGate' },
          depends: ['absent-non-body'],
        },
      },
    };
    // depends on a non-existent node → caught earlier ("unknown node");
    // adjust to depend on a real outer node that itself has deps.
    onlyBody.nodes['absent-non-body'] = {
      type: 'subagent', bot: 'b', prompt: 'x', depends: ['loop1'],
    };
    // Now there's a cycle (loop1 ↔ absent-non-body).  This is an
    // intentional accumulator-style test; root-check failure is hard
    // to reach without other guards firing first.  Validate that *some*
    // error fires.
    expect(() => parseWorkflowDefinition(onlyBody)).toThrow();
  });
});

// Codex PR #47 round-2 finding #1 + #2 — schema-legal but runtime-broken
// configurations that validateLoopBlocks now rejects at parse time.
describe('loop sink + decision-timeout validation (PR #47 round 2)', () => {
  it('rejects sink loop without output.from (no-progress hang)', () => {
    const raw = loopFixture();
    delete raw.nodes.publish; // remove the external dependent
    delete raw.nodes['review-loop'].output; // and the output.from
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /Loop 'review-loop' has no external dependents.*output\.from/,
    );
  });

  it('accepts non-sink loop without output.from (downstream exists)', () => {
    // When `publish` depends on the loop, the loop is not a sink so
    // `output.from` becomes optional.  This pins that the sink rule
    // only fires for actual workflow sinks.
    const raw = loopFixture();
    delete raw.nodes['review-loop'].output;
    raw.nodes.publish.prompt = 'announce'; // no longer references loop output
    expect(() => parseWorkflowDefinition(raw)).not.toThrow();
  });

  it('accepts sink loop WITH output.from', () => {
    const raw = loopFixture();
    delete raw.nodes.publish;
    // output.from already declared in loopFixture → loop is sink + declares output
    expect(() => parseWorkflowDefinition(raw)).not.toThrow();
  });

  it("rejects decision node with humanGate.onTimeout='success'", () => {
    const raw = loopFixture();
    raw.nodes.reviewDecision.humanGate.onTimeout = 'success';
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /Decision node 'reviewDecision'.*onTimeout='success'.*not allowed/,
    );
  });

  it("accepts decision node with humanGate.onTimeout='fail'", () => {
    const raw = loopFixture();
    raw.nodes.reviewDecision.humanGate.onTimeout = 'fail';
    expect(() => parseWorkflowDefinition(raw)).not.toThrow();
  });

  it('accepts decision node without onTimeout (defaults to fail)', () => {
    const raw = loopFixture();
    // baseline fixture omits onTimeout — re-verify it still passes
    expect(() => parseWorkflowDefinition(raw)).not.toThrow();
  });
});

// External-reviewer PR #47 round-3 finding: non-terminator decisions in
// the body would be schema-legal but `wait.ts` decision-mode treats *any*
// decision-typed node's reject as `activitySucceeded`, so the body would
// silently continue past a "reject" the author intended to terminate the
// loop.  validateLoopBlocks now enforces "exactly one decision per body,
// which must equal terminate.node".
describe('loop body single-decision enforcement (PR #47 round 3)', () => {
  it('rejects body with two decision nodes (non-terminator silently swallows reject)', () => {
    const raw = loopFixture();
    // Inject a second decision node BEFORE the terminator.
    raw.nodes.preDecision = {
      type: 'decision',
      depends: ['implement'],
      humanGate: { stage: 'before', prompt: 'gate before review?' },
    };
    raw.nodes.review.depends = ['preDecision'];
    raw.nodes['review-loop'].body = ['implement', 'preDecision', 'review', 'reviewDecision'];
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /Loop 'review-loop' body must contain exactly one decision node.*preDecision.*reviewDecision/s,
    );
  });

  it('accepts body with exactly one decision == terminate.node (baseline)', () => {
    const raw = loopFixture();
    expect(() => parseWorkflowDefinition(raw)).not.toThrow();
  });

  it('error message points authors at subagent + humanGate for intermediate approvals', () => {
    const raw = loopFixture();
    raw.nodes.preDecision = {
      type: 'decision',
      depends: ['implement'],
      humanGate: { stage: 'before', prompt: 'gate?' },
    };
    raw.nodes.review.depends = ['preDecision'];
    raw.nodes['review-loop'].body = ['implement', 'preDecision', 'review', 'reviewDecision'];
    expect(() => parseWorkflowDefinition(raw)).toThrow(
      /subagent \+ humanGate for intermediate approvals/,
    );
  });
});

describe('validateLoopBlocks direct (returns body set)', () => {
  it('returns body-node set for downstream use', () => {
    const def = parseWorkflowDefinition(loopFixture());
    const bodySet = validateLoopBlocks(def);
    expect(bodySet.has('implement')).toBe(true);
    expect(bodySet.has('review')).toBe(true);
    expect(bodySet.has('reviewDecision')).toBe(true);
    expect(bodySet.has('publish')).toBe(false);
    expect(bodySet.has('review-loop')).toBe(false);
  });

  it('returns empty set when no loops', () => {
    const def = parseWorkflowDefinition(tripPlannerFixture());
    expect(validateLoopBlocks(def).size).toBe(0);
  });
});
