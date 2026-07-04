/**
 * Tests for the shared `coerceWorkflowParams` module.
 *
 * Locks the IM (`/template run`) and CLI (`botmux workflow run`) input
 * coercion contract: type / required / default / unknown-rejection rules,
 * plus the JSON-channel escape hatch for `object` / `array` params.
 */

import { describe, it, expect } from 'vitest';
import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import {
  coerceWorkflowParams,
  coerceWorkflowParamsFromStrings,
  ParamCoerceFailure,
} from '../src/workflows/params.js';

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
