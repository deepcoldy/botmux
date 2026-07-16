/**
 * Tests for the shared `coerceWorkflowParams` module.
 *
 * Locks the v3 Saved Workflow IM/CLI input
 * coercion contract: type / required / default / unknown-rejection rules,
 * plus the JSON-channel escape hatch for `object` / `array` params.
 */

import { describe, it, expect } from 'vitest';
import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import {
  coerceWorkflowParams,
  coerceWorkflowParamsFromStrings,
  ParamCoerceFailure,
  validateWorkflowParamSchema,
  type WorkflowParamSchemaOwner,
} from '../src/workflows/shared/params.js';

const DEF = parseWorkflowDefinition({
  workflowId: 'wf-params',
  version: 1,
  params: {
    name: { type: 'string', required: true },
    retries: { type: 'number', required: false, default: 3 },
    dryRun: { type: 'boolean', required: false, default: false },
    tags: { type: 'array', required: false },
    config: { type: 'object', required: false },
  },
  nodes: {
    n: { type: 'subagent', bot: 'b', prompt: 'p' },
  },
});

const NO_PARAMS_DEF = parseWorkflowDefinition({
  workflowId: 'wf-no-params',
  version: 1,
  nodes: { n: { type: 'subagent', bot: 'b', prompt: 'p' } },
});

describe('coerceWorkflowParamsFromStrings — IM key=value path', () => {
  it('coerces string / number / boolean from raw strings', () => {
    expect(
      coerceWorkflowParamsFromStrings(DEF, {
        name: 'alice',
        retries: '5',
        dryRun: 'true',
      }),
    ).toEqual({ name: 'alice', retries: 5, dryRun: true });
  });

  it('materializes defaults for missing optionals', () => {
    expect(coerceWorkflowParamsFromStrings(DEF, { name: 'bob' })).toEqual({
      name: 'bob',
      retries: 3,
      dryRun: false,
    });
  });

  it('rejects missing required', () => {
    expect(() => coerceWorkflowParamsFromStrings(DEF, {})).toThrow(/缺少必填参数：name/);
  });

  it('rejects unknown param keys (typo guard)', () => {
    expect(() =>
      coerceWorkflowParamsFromStrings(DEF, { name: 'a', typo: 'x' }),
    ).toThrow(/未知参数：typo/);
  });

  it('rejects non-numeric strings for type=number', () => {
    expect(() =>
      coerceWorkflowParamsFromStrings(DEF, { name: 'a', retries: 'abc' }),
    ).toThrow(/参数 retries 必须是 number/);
  });

  it('rejects non-boolean strings for type=boolean', () => {
    expect(() =>
      coerceWorkflowParamsFromStrings(DEF, { name: 'a', dryRun: 'maybe' }),
    ).toThrow(/参数 dryRun 必须是 boolean/);
  });

  it('accepts boolean aliases (1/0/yes/no/y/n case-insensitive)', () => {
    expect(
      coerceWorkflowParamsFromStrings(DEF, { name: 'a', dryRun: 'YES' }).dryRun,
    ).toBe(true);
    expect(
      coerceWorkflowParamsFromStrings(DEF, { name: 'a', dryRun: 'n' }).dryRun,
    ).toBe(false);
    expect(
      coerceWorkflowParamsFromStrings(DEF, { name: 'a', dryRun: '1' }).dryRun,
    ).toBe(true);
  });

  it('refuses object / array via the string channel with a clear hint', () => {
    expect(() =>
      coerceWorkflowParamsFromStrings(DEF, {
        name: 'a',
        tags: '["x","y"]',
      }),
    ).toThrow(/--param-json/);
  });

  it('returns {} for a no-params workflow', () => {
    expect(coerceWorkflowParamsFromStrings(NO_PARAMS_DEF, {})).toEqual({});
  });
});

describe('coerceWorkflowParams — RawParamInput (CLI mixed channel)', () => {
  it('reads object via json channel', () => {
    const r = coerceWorkflowParams(DEF, {
      name: { kind: 'string', value: 'a' },
      config: { kind: 'json', value: { foo: 1, bar: 'b' } },
    });
    expect(r).toMatchObject({
      name: 'a',
      config: { foo: 1, bar: 'b' },
      retries: 3,
      dryRun: false,
    });
  });

  it('reads array via json channel', () => {
    const r = coerceWorkflowParams(DEF, {
      name: { kind: 'string', value: 'a' },
      tags: { kind: 'json', value: ['x', 'y'] },
    });
    expect(r.tags).toEqual(['x', 'y']);
  });

  it('rejects json channel value that is wrong shape for declared type', () => {
    expect(() =>
      coerceWorkflowParams(DEF, {
        name: { kind: 'string', value: 'a' },
        config: { kind: 'json', value: ['not', 'an', 'object'] },
      }),
    ).toThrow(/参数 config 必须是 object/);
  });

  it('rejects json string for number-typed param', () => {
    expect(() =>
      coerceWorkflowParams(DEF, {
        name: { kind: 'string', value: 'a' },
        retries: { kind: 'json', value: 'not-a-number' },
      }),
    ).toThrow(/参数 retries 必须是 number/);
  });

  it('aggregates multiple issues into a single ParamCoerceFailure', () => {
    try {
      coerceWorkflowParams(DEF, {
        retries: { kind: 'string', value: 'abc' },
        dryRun: { kind: 'string', value: 'whatever' },
        bogus: { kind: 'string', value: 'x' },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ParamCoerceFailure);
      const issues = (err as ParamCoerceFailure).issues;
      expect(issues.map((i) => i.code).sort()).toEqual([
        'missing_required',
        'type_mismatch',
        'type_mismatch',
        'unknown_param',
      ]);
    }
  });

  it('keeps defaults even when other params fail (validates whole record before throwing)', () => {
    // If a single failure short-circuited, the operator would see one error
    // at a time and have to keep re-trying.  Aggregate model lets them fix
    // everything in one round.
    try {
      coerceWorkflowParams(DEF, {
        name: { kind: 'string', value: 'a' },
        retries: { kind: 'string', value: 'not-num' },
        dryRun: { kind: 'string', value: 'not-bool' },
      });
      throw new Error('expected throw');
    } catch (err) {
      const issues = (err as ParamCoerceFailure).issues;
      // Two type_mismatch issues — one per bad value, neither got dropped.
      expect(issues.filter((i) => i.code === 'type_mismatch')).toHaveLength(2);
    }
  });

  it('default values are passed through verbatim (no extra coercion)', () => {
    const richDef = parseWorkflowDefinition({
      workflowId: 'wf-defaults',
      version: 1,
      params: {
        config: { type: 'object', required: false, default: { mode: 'safe' } },
        tags: { type: 'array', required: false, default: ['a', 'b'] },
      },
      nodes: { n: { type: 'subagent', bot: 'b', prompt: 'p' } },
    });
    expect(coerceWorkflowParams(richDef, {})).toEqual({
      config: { mode: 'safe' },
      tags: ['a', 'b'],
    });
  });
});

describe('engine-neutral param schema validation', () => {
  it('keeps legacy v2 coercion compatible while strict validation is opt-in', () => {
    const legacyOwner: WorkflowParamSchemaOwner = {
      params: {
        token: { type: 'string', format: 'secret', default: 'legacy-default' },
        count: { type: 'number', default: 'legacy-string-default' },
      },
    };

    expect(coerceWorkflowParams(legacyOwner, {})).toEqual({
      token: 'legacy-default',
      count: 'legacy-string-default',
    });
    expect(() => validateWorkflowParamSchema(legacyOwner)).toThrow();
  });

  it('accepts a plain schema owner without a v2 WorkflowDefinition', () => {
    const owner: WorkflowParamSchemaOwner = {
      params: {
        city: { type: 'string', required: true },
        days: { type: 'number', default: 3 },
      },
    };

    expect(coerceWorkflowParamsFromStrings(owner, { city: '上海' })).toEqual({
      city: '上海',
      days: 3,
    });
  });

  it.each([
    ['string', 'x'],
    ['number', 0],
    ['boolean', false],
    ['object', {}],
    ['array', []],
  ] as const)('accepts a %s default of the declared type', (type, value) => {
    expect(() => validateWorkflowParamSchema({ params: { value: { type, default: value } } }))
      .not.toThrow();
  });

  it.each([
    ['string', 1],
    ['number', '1'],
    ['boolean', 0],
    ['object', []],
    ['array', {}],
  ] as const)('rejects a %s param with a mismatched default', (type, value) => {
    expect(() => validateWorkflowParamSchema({ params: { value: { type, default: value } } }))
      .toThrow(/default 必须是/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a non-finite number default (%s)',
    (value) => {
      expect(() => validateWorkflowParamSchema({ params: { count: { type: 'number', default: value } } }))
        .toThrow(/default 必须是 number/);
    },
  );

  it.each(['bad.name', 'bad/name', 'has space', '__proto__', 'prototype', 'constructor'])(
    'rejects unsafe parameter name %s',
    (name) => {
      const params = Object.create(null) as Record<string, { type: 'string' }>;
      params[name] = { type: 'string' };
      expect(() => validateWorkflowParamSchema({ params })).toThrow(/参数名 .* 非法/);
    },
  );

  it('allows names that match the existing params.<segment> grammar', () => {
    expect(() => validateWorkflowParamSchema({
      params: {
        city: { type: 'string' },
        retry_count: { type: 'number' },
        'dry-run': { type: 'boolean' },
        '2026': { type: 'string' },
      },
    })).not.toThrow();
  });

  it('forbids defaults for sensitive declarations and recognized secret formats', () => {
    try {
      validateWorkflowParamSchema({
        params: {
          apiToken: { type: 'string', sensitive: true, default: 'embedded' },
          password: { type: 'string', format: 'password', default: 'embedded' },
        },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ParamCoerceFailure);
      expect((err as ParamCoerceFailure).issues.map((issue) => issue.code))
        .toEqual(['sensitive_default', 'sensitive_default']);
    }
  });

  it('still accepts non-secret format metadata and runtime secret values', () => {
    const owner: WorkflowParamSchemaOwner = {
      params: {
        date: { type: 'string', format: 'date', default: '2026-07-10' },
        token: { type: 'string', format: 'secret', required: true },
      },
    };
    expect(coerceWorkflowParamsFromStrings(owner, { token: 'runtime-only' })).toEqual({
      date: '2026-07-10',
      token: 'runtime-only',
    });
  });

  it('reports a runtime-invalid declaration type instead of silently coercing it', () => {
    const owner = {
      params: { value: { type: 'integer' } },
    } as unknown as WorkflowParamSchemaOwner;
    try {
      validateWorkflowParamSchema(owner);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ParamCoerceFailure);
      expect((err as ParamCoerceFailure).issues[0]).toMatchObject({
        name: 'value',
        code: 'invalid_param_type',
      });
    }
  });
});
