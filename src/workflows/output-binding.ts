/**
 * Output binding resolver.
 *
 * Workflow author writes `{ "$ref": "<nodeId>.output.<path>" }` somewhere
 * inside a hostExecutor `input` or a subagent / humanGate `prompt`.  At
 * dispatch time we walk the value, find every `$ref`, and substitute
 * it with the corresponding upstream value.  The substitution happens
 * BEFORE `parseInput` / spawn / wait so consumers see fully-resolved
 * literals.
 *
 * Failure model (codex round 6 tightenings):
 *   - All errors are `BindingError` — caller maps to `activityFailed`
 *     with `errorCode = 'InputBindingFailed'`, `errorClass = 'userFault'`.
 *   - We never silently fall back to the event payload `externalRefs` —
 *     `outputRef` blob is the contract.  Missing blob file ⇒ binding fails
 *     loudly so the operator notices a write-side bug rather than getting
 *     a half-resolved input.
 *   - `{ "$ref": "..." }` is the typed binding primitive: an entire field
 *     value is replaced and objects/arrays/numbers are preserved.
 *   - String interpolation is intentionally narrow: `${...}` may embed the
 *     same ref grammar inside a string, and only scalar values are allowed.
 *     Objects/arrays must use whole-field `$ref`.
 *
 * Reference syntax:
 *   `<nodeId>.output.<segment>(.<segment>)*`
 *   `params.<segment>(.<segment>)*`
 *
 *   - `nodeId` is everything before the FIRST `.output.` occurrence.  We
 *     split on `.output.` rather than the first `.` because `NODE_ID_PATTERN`
 *     allows dots in node ids (e.g. `team.draft`).
 *   - `params.*` reads the immutable run input blob written at runCreated.
 *   - Each path segment must match `[A-Za-z0-9_-]+` or be a non-negative
 *     integer (array index).  `__proto__` / `prototype` / `constructor`
 *     are explicitly rejected to prevent prototype pollution.
 */

import { promises as fs } from 'node:fs';

import type { WorkflowDefinition } from './definition.js';
import type { EventLog } from './events/append.js';
import type { OutputRef } from './events/payloads.js';
import type { Snapshot } from './events/replay.js';
import { parseActivityId, workActivityId } from './orchestrator.js';

export class BindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingError';
  }
}

export type ParsedRef = {
  kind: 'output' | 'params' | 'previous';
  nodeId: string;
  pathSegments: string[];
};

const REF_MARKER = '.output.';
const PREVIOUS_MARKER = '.previous.';
const PARAMS_PREFIX = 'params.';
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export function parseRef(ref: string): ParsedRef {
  const idx = ref.indexOf(REF_MARKER);
  if (idx < 0 && ref.startsWith(PARAMS_PREFIX)) {
    const rawPath = ref.slice(PARAMS_PREFIX.length);
    return { kind: 'params', nodeId: 'params', pathSegments: parsePathSegments(rawPath, ref) };
  }
  const previousIdx = ref.indexOf(PREVIOUS_MARKER);
  if (idx < 0 && previousIdx >= 0) {
    const nodeId = ref.slice(0, previousIdx);
    if (!nodeId) {
      throw new BindingError(`$ref '${ref}' has empty nodeId before '.previous.'`);
    }
    const rawPath = ref.slice(previousIdx + PREVIOUS_MARKER.length);
    if (!rawPath) {
      throw new BindingError(`$ref '${ref}' has empty path after '.previous.'`);
    }
    return { kind: 'previous', nodeId, pathSegments: parsePathSegments(rawPath, ref) };
  }
  if (idx < 0) {
    throw new BindingError(
      `$ref '${ref}' missing '.output.' separator (expected '<nodeId>.output.<path>', '<nodeId>.previous.<path>', or 'params.<path>')`,
    );
  }
  const nodeId = ref.slice(0, idx);
  if (!nodeId) {
    throw new BindingError(`$ref '${ref}' has empty nodeId before '.output.'`);
  }
  const rawPath = ref.slice(idx + REF_MARKER.length);
  if (!rawPath) {
    throw new BindingError(`$ref '${ref}' has empty path after '.output.'`);
  }
  const segments = parsePathSegments(rawPath, ref);
  return { kind: 'output', nodeId, pathSegments: segments };
}

function parsePathSegments(rawPath: string, ref: string): string[] {
  if (!rawPath) {
    throw new BindingError(`$ref '${ref}' has empty path`);
  }
  const segments = rawPath.split('.');
  for (const seg of segments) {
    if (!seg) {
      throw new BindingError(`$ref '${ref}' has empty path segment`);
    }
    if (FORBIDDEN_SEGMENTS.has(seg)) {
      throw new BindingError(`$ref '${ref}' uses forbidden segment '${seg}'`);
    }
    if (!SEGMENT_PATTERN.test(seg)) {
      throw new BindingError(
        `$ref '${ref}' has invalid segment '${seg}' (must match [A-Za-z0-9_-]+)`,
      );
    }
  }
  return segments;
}

function isOutputRefSpec(value: unknown): value is { $ref: string } {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== '$ref') return false;
  return typeof (value as Record<string, unknown>).$ref === 'string';
}

export type BindingContext = {
  snapshot: Snapshot;
  def: WorkflowDefinition;
  log: EventLog;
  loadParams?: () => Promise<Record<string, unknown>>;
  loopContext?: {
    loopId: string;
    iteration: number;
  };
};

export async function resolveOutputRef(
  ref: string,
  ctx: BindingContext,
  options?: { allowMissingPrevious?: boolean },
): Promise<unknown> {
  const parsed = parseRef(ref);
  const { kind, nodeId, pathSegments } = parsed;

  if (kind === 'params') {
    const params = await loadRunParams(ref, ctx);
    return walkPath(params, pathSegments, ref);
  }

  const nodeDef = ctx.def.nodes[nodeId];
  if (!nodeDef) {
    throw new BindingError(
      `$ref '${ref}' targets unknown node '${nodeId}' (not in workflow definition)`,
    );
  }

  const outputRef = kind === 'previous'
    ? findPreviousLoopOutputRef(ref, nodeId, ctx, options)
    : findLatestOutputRef(nodeId, ctx);
  if (!outputRef) {
    throw new BindingError(
      `$ref '${ref}' references node '${nodeId}' which has not produced a successful output yet`,
    );
  }
  if (!outputRef.outputPath) {
    // OutputRef.outputPath is optional in the schema (for older runs whose
    // blob was inlined elsewhere), but v0 writes all blobs to disk via
    // writeJsonBlob.  Fail loud rather than reading from event payload —
    // codex round 6 finding: outputRef is the contract.
    throw new BindingError(
      `$ref '${ref}' resolved to node '${nodeId}' outputRef with no outputPath; blob not on disk`,
    );
  }

  let blob: unknown;
  try {
    const raw = await fs.readFile(outputRef.outputPath, 'utf-8');
    blob = JSON.parse(raw);
  } catch (err) {
    throw new BindingError(
      `$ref '${ref}' failed to read output blob at ${outputRef.outputPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // hostExecutor blob is `{ output, externalRefs }`; subagent blob is the
  // bare `output` payload.  The `.output.` prefix in `$ref` syntax means
  // "the logical output side" — for hostExecutor we go through the
  // wrapping `output` key, for subagent we walk directly.
  const logicalNodeDef = nodeDef.type === 'loop' && nodeDef.output
    ? ctx.def.nodes[nodeDef.output.from] ?? nodeDef
    : nodeDef;
  const root = logicalNodeDef.type === 'hostExecutor'
    ? (blob as { output?: unknown })?.output
    : blob;

  return walkPath(root, pathSegments, ref);
}

function findLatestOutputRef(nodeId: string, ctx: BindingContext): OutputRef | undefined {
  const plain = ctx.snapshot.outputs.get(workActivityId(ctx.snapshot.run.runId, nodeId));
  if (plain) return plain;
  return findLoopOutputRef(nodeId, ctx);
}

function findPreviousLoopOutputRef(
  ref: string,
  nodeId: string,
  ctx: BindingContext,
  options?: { allowMissingPrevious?: boolean },
): OutputRef | undefined {
  if (!ctx.loopContext) {
    throw new BindingError(
      `$ref '${ref}' uses '.previous.' outside a loop iteration context`,
    );
  }
  if (ctx.loopContext.iteration <= 1) {
    if (options?.allowMissingPrevious) return undefined;
    throw new BindingError(`$ref '${ref}' has no previous iteration for iteration 1`);
  }
  return findLoopOutputRef(nodeId, ctx, ctx.loopContext.loopId, ctx.loopContext.iteration - 1);
}

function findLoopOutputRef(
  nodeId: string,
  ctx: BindingContext,
  loopId?: string,
  iteration?: number,
): OutputRef | undefined {
  let best: { iteration: number; outputRef: OutputRef } | undefined;
  for (const [activityId, outputRef] of ctx.snapshot.outputs.entries()) {
    const parsed = parseActivityId(activityId);
    if (!parsed || parsed.kind !== 'loop') continue;
    if (parsed.nodeId !== nodeId) continue;
    const nodeDef = ctx.def.nodes[nodeId];
    const expectedKind = nodeDef?.type === 'decision' ? 'gate' : 'work';
    if (parsed.activityKind !== expectedKind) continue;
    if (loopId !== undefined && parsed.loopId !== loopId) continue;
    if (iteration !== undefined && parsed.iteration !== iteration) continue;
    if (!best || parsed.iteration > best.iteration) {
      best = { iteration: parsed.iteration, outputRef };
    }
  }
  return best?.outputRef;
}

async function loadRunParams(ref: string, ctx: BindingContext): Promise<Record<string, unknown>> {
  if (ctx.loadParams) return ctx.loadParams();
  const inputRef = ctx.snapshot.run.input;
  if (!inputRef?.outputPath) {
    throw new BindingError(
      `$ref '${ref}' requires run input params, but runCreated.inputRef has no outputPath`,
    );
  }
  let params: unknown;
  try {
    const raw = await fs.readFile(inputRef.outputPath, 'utf-8');
    params = JSON.parse(raw);
  } catch (err) {
    throw new BindingError(
      `$ref '${ref}' failed to read run params at ${inputRef.outputPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new BindingError(`$ref '${ref}' resolved run params to non-object input`);
  }
  return params as Record<string, unknown>;
}

function walkPath(value: unknown, segments: string[], ref: string): unknown {
  let cursor: unknown = value;
  for (const [i, seg] of segments.entries()) {
    if (cursor === null || cursor === undefined) {
      throw new BindingError(
        `$ref '${ref}' hit ${cursor === null ? 'null' : 'undefined'} at segment '${seg}' (index ${i})`,
      );
    }
    if (Array.isArray(cursor)) {
      if (!/^\d+$/.test(seg)) {
        throw new BindingError(
          `$ref '${ref}' segment '${seg}' is not a numeric index, but the current value is an array`,
        );
      }
      const idx = Number(seg);
      if (idx >= cursor.length) {
        throw new BindingError(
          `$ref '${ref}' segment '${seg}' is out of array bounds (length ${cursor.length})`,
        );
      }
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor !== 'object') {
      throw new BindingError(
        `$ref '${ref}' hit non-object '${typeof cursor}' at segment '${seg}' (index ${i})`,
      );
    }
    // Use Object.prototype.hasOwnProperty to refuse inherited / prototype
    // chain lookups even after the FORBIDDEN_SEGMENTS rejection in parseRef.
    if (!Object.prototype.hasOwnProperty.call(cursor, seg)) {
      throw new BindingError(
        `$ref '${ref}' segment '${seg}' not found on object (own-property check)`,
      );
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

/**
 * Recursive walker: every `$ref` form replaced by its resolved value,
 * every other value left as-is.  Arrays/objects are reconstructed
 * fresh so the caller gets a tree it can mutate without aliasing the
 * workflow definition.
 *
 * NOTE: We do not resolve refs nested inside resolved values.  i.e. if
 * upstream `output.x` itself contains a `$ref`-shaped object, that's
 * data, not a ref.  Refs only originate from the workflow definition.
 */
export async function resolveBindings(
  value: unknown,
  ctx: BindingContext,
): Promise<unknown> {
  if (isOutputRefSpec(value)) {
    return resolveOutputRef(value.$ref, ctx);
  }
  if (typeof value === 'string') {
    return interpolateStringRefs(value, ctx);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) {
      out.push(await resolveBindings(v, ctx));
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await resolveBindings(v, ctx);
    }
    return out;
  }
  return value;
}

async function interpolateStringRefs(value: string, ctx: BindingContext): Promise<string> {
  if (!value.includes('${')) return value;
  let out = '';
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf('${', cursor);
    if (start < 0) {
      out += value.slice(cursor);
      break;
    }
    out += value.slice(cursor, start);
    const end = value.indexOf('}', start + 2);
    if (end < 0) {
      throw new BindingError(`unterminated string ref interpolation in '${value}'`);
    }
    const ref = value.slice(start + 2, end);
    if (!ref) {
      throw new BindingError(`empty string ref interpolation in '${value}'`);
    }
    const parsed = parseRef(ref);
    const resolved = parsed.kind === 'previous' && ctx.loopContext?.iteration === 1
      ? undefined
      : await resolveOutputRef(ref, ctx, { allowMissingPrevious: true });
    if (resolved === undefined && parsed.kind === 'previous') {
      cursor = end + 1;
      continue;
    }
    out += stringifyInterpolatedValue(ref, resolved);
    cursor = end + 1;
  }
  return out;
}

function stringifyInterpolatedValue(ref: string, value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return value as string;
  if (t === 'number' || t === 'boolean') return String(value);
  throw new BindingError(
    `string interpolation '\${${ref}}' resolved to ${Array.isArray(value) ? 'array' : t} ` +
    `(expected string/number/boolean/null; use whole-field $ref for structured values)`,
  );
}

/**
 * Convenience for fields typed as `BoundString` — guaranteed to resolve
 * to a string.  Throws BindingError if a non-string ref slipped through.
 */
export async function resolveBoundString(
  value: unknown,
  ctx: BindingContext,
): Promise<string> {
  const resolved = await resolveBindings(value, ctx);
  if (typeof resolved !== 'string') {
    throw new BindingError(
      `bound string field resolved to ${typeof resolved} (expected string)`,
    );
  }
  return resolved;
}
