import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  deriveIdempotencyKey,
  type IdempotencyKeyTuple,
} from '../src/workflows/shared/idempotency-key.js';
import {
  canonicalJson,
  computeInputHash,
} from '../src/utils/canonical-input-hash.js';

const baseTuple: IdempotencyKeyTuple = {
  workflowId: 'wf-demo',
  revisionId: 'rev-001',
  runId: 'run-abc',
  nodeId: 'n1',
  attemptId: 'at1',
};

// ─── canonicalJson ──────────────────────────────────────────────────────────

describe('canonicalJson — primitives', () => {
  it('serializes null', () => {
    expect(canonicalJson(null)).toBe('null');
  });

  it('serializes booleans', () => {
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
  });

  it('serializes integers and floats', () => {
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(-0.5)).toBe('-0.5');
  });

  it('serializes strings with escaping', () => {
    expect(canonicalJson('hello "world"')).toBe('"hello \\"world\\""');
    expect(canonicalJson('')).toBe('""');
  });

  it('throws on NaN/Infinity', () => {
    expect(() => canonicalJson(NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson(Infinity)).toThrow(/non-finite/);
    expect(() => canonicalJson(-Infinity)).toThrow(/non-finite/);
  });

  it('throws on bigint', () => {
    expect(() => canonicalJson(BigInt(123))).toThrow(/bigint/);
  });

  it('throws on function/symbol/undefined at root', () => {
    expect(() => canonicalJson(() => 1)).toThrow();
    expect(() => canonicalJson(Symbol('s'))).toThrow();
    expect(() => canonicalJson(undefined)).toThrow();
  });
});

describe('canonicalJson — objects', () => {
  it('sorts keys ascending', () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it('produces same output regardless of input key order', () => {
    const a = canonicalJson({ x: 1, y: 2, z: 3 });
    const b = canonicalJson({ z: 3, y: 2, x: 1 });
    const c = canonicalJson({ y: 2, x: 1, z: 3 });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('recurses with sorted keys at every level', () => {
    const out = canonicalJson({
      outer2: { inner_b: 1, inner_a: 2 },
      outer1: { inner_d: 3, inner_c: 4 },
    });
    expect(out).toBe('{"outer1":{"inner_c":4,"inner_d":3},"outer2":{"inner_a":2,"inner_b":1}}');
  });

  it('drops undefined properties (matches JSON.stringify)', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('keeps null properties', () => {
    expect(canonicalJson({ a: null, b: 1 })).toBe('{"a":null,"b":1}');
  });

  it('rejects non-plain object (Date, Buffer, class instance)', () => {
    expect(() => canonicalJson(new Date())).toThrow(/non-plain-object/);
    expect(() => canonicalJson(Buffer.from('x'))).toThrow(/non-plain-object/);
    class C {
      x = 1;
    }
    expect(() => canonicalJson(new C())).toThrow(/non-plain-object/);
  });

  it('accepts object with null prototype', () => {
    const obj = Object.create(null);
    obj.x = 1;
    obj.y = 2;
    expect(canonicalJson(obj)).toBe('{"x":1,"y":2}');
  });
});

describe('canonicalJson — arrays', () => {
  it('preserves order (arrays are ordered)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('recurses into array elements', () => {
    expect(canonicalJson([{ b: 2, a: 1 }, [9, 8]])).toBe('[{"a":1,"b":2},[9,8]]');
  });

  it('handles empty array', () => {
    expect(canonicalJson([])).toBe('[]');
  });
});

// ─── computeInputHash ───────────────────────────────────────────────────────

describe('computeInputHash', () => {
  it('returns sha256:<64-hex> form', () => {
    const h = computeInputHash({ x: 1 });
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces same hash for equivalent inputs (different key order)', () => {
    const a = computeInputHash({ a: 1, b: 2, c: 3 });
    const b = computeInputHash({ c: 3, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('produces different hash when value changes', () => {
    const a = computeInputHash({ x: 1 });
    const b = computeInputHash({ x: 2 });
    expect(a).not.toBe(b);
  });

  it('produces different hash when a key is added', () => {
    const a = computeInputHash({ x: 1 });
    const b = computeInputHash({ x: 1, y: 2 });
    expect(a).not.toBe(b);
  });

  it('treats undefined and missing key as equivalent (per JSON.stringify)', () => {
    const a = computeInputHash({ x: 1, y: undefined });
    const b = computeInputHash({ x: 1 });
    expect(a).toBe(b);
  });

  it('treats null and undefined as distinct', () => {
    const a = computeInputHash({ x: null });
    const b = computeInputHash({});
    expect(a).not.toBe(b);
  });

  it('matches a hand-computed sha256 of canonical form', () => {
    const canonical = '{"a":1,"b":2}';
    const expected = 'sha256:' + createHash('sha256').update(canonical, 'utf-8').digest('hex');
    expect(computeInputHash({ a: 1, b: 2 })).toBe(expected);
  });

  it('keeps the stable golden digest used by schedule idempotency', () => {
    expect(computeInputHash({ b: 2, a: 1 })).toBe(
      'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    );
  });
});

// ─── deriveIdempotencyKey ───────────────────────────────────────────────────

describe('deriveIdempotencyKey — determinism', () => {
  it('keeps the persisted provider-key bytes stable across v2 retirement', () => {
    expect(deriveIdempotencyKey(baseTuple)).toBe(
      'wf_113030808efccfab58ec57afdb0187f286a0a9fb6d4f156',
    );
  });

  it('same tuple → same key', () => {
    const a = deriveIdempotencyKey(baseTuple);
    const b = deriveIdempotencyKey(baseTuple);
    expect(a).toBe(b);
  });

  it.each([
    ['workflowId', 'wf-other'],
    ['revisionId', 'rev-other'],
    ['runId', 'run-other'],
    ['nodeId', 'n2'],
    ['attemptId', 'at2'],
  ] as const)('changing tuple.%s → different key', (field, value) => {
    const a = deriveIdempotencyKey(baseTuple);
    const b = deriveIdempotencyKey({ ...baseTuple, [field]: value });
    expect(a).not.toBe(b);
  });
});

describe('deriveIdempotencyKey — length & namespace', () => {
  it('default output is ≤ 50 chars (Feishu uuid limit)', () => {
    const key = deriveIdempotencyKey(baseTuple);
    expect(key.length).toBe(50);
  });

  it('starts with default namespace "wf_"', () => {
    expect(deriveIdempotencyKey(baseTuple).startsWith('wf_')).toBe(true);
  });

  it('uses custom namespace', () => {
    expect(deriveIdempotencyKey(baseTuple, { namespace: 'sched_' }).startsWith('sched_')).toBe(true);
  });

  it('allows empty namespace (raw hex prefix)', () => {
    const key = deriveIdempotencyKey(baseTuple, { namespace: '' });
    expect(key.length).toBe(50);
    expect(key).toMatch(/^[0-9a-f]{50}$/);
  });

  it('honors custom maxLength', () => {
    expect(deriveIdempotencyKey(baseTuple, { maxLength: 32 }).length).toBe(32);
  });

  it('throws when namespace >= maxLength', () => {
    expect(() => deriveIdempotencyKey(baseTuple, { namespace: 'verylong_', maxLength: 8 })).toThrow(
      /leaves no room/,
    );
  });
});

describe('deriveIdempotencyKey — input validation', () => {
  it.each([
    ['workflowId', ''],
    ['revisionId', ''],
    ['runId', ''],
    ['nodeId', ''],
    ['attemptId', ''],
  ] as const)('throws if tuple.%s is empty', (field) => {
    expect(() => deriveIdempotencyKey({ ...baseTuple, [field]: '' })).toThrow(
      /must be non-empty string/,
    );
  });
});

describe('integration — deriveIdempotencyKey output fits Feishu uuid', () => {
  it('produced key matches the schema.ts ≤ 50-char rule', () => {
    const key = deriveIdempotencyKey(baseTuple);
    // Feishu uuid field upper bound is 50 chars (spike report §1.2).
    expect(key.length).toBeLessThanOrEqual(50);
    // No characters outside [\w-] (uuid-safe).
    expect(key).toMatch(/^[\w-]+$/);
  });
});
