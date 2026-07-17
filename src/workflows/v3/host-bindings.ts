/**
 * Typed bindings for v3 host-executor inputs.
 *
 * Host nodes cannot receive the goal worker's file-oriented `inputs.json` and
 * ask an LLM to interpret it: the host must materialize one exact provider
 * payload before approval.  This module resolves the deliberately small
 * binding language without doing any filesystem or provider I/O.
 */

export type V3HostBindingRef =
  | { kind: 'params'; path: string[] }
  | { kind: 'context'; path: string[] }
  | { kind: 'result'; nodeId: string; path: string[] };

export interface V3HostBindingContext {
  params: Readonly<Record<string, unknown>>;
  context: Readonly<Record<string, string>>;
  loadResult(nodeId: string): Promise<unknown>;
}

export class V3HostBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V3HostBindingError';
  }
}

const RESULT_MARKER = '.result.';
const PATH_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const STRING_MARKER_SOURCE = '\\$\\{([^{}]+)\\}';
const stringMarkerRe = (): RegExp => new RegExp(STRING_MARKER_SOURCE, 'g');
const SECRET_KEY_RE = /(?:secret|token|password|passwd|authorization|cookie|credential|private.?key)/i;
const HOST_GATE_PREVIEW_MARKER =
  '\n\n---\n以下内容由 host runtime 从冻结输入生成；批准只对该 hash 生效。\n';

export function composeV3HostGatePrompt(authoredPrompt: string, preview: string): string {
  return `${authoredPrompt}${HOST_GATE_PREVIEW_MARKER}${preview}`;
}

export function splitV3HostGatePrompt(prompt: string): {
  authoredPrompt: string;
  preview?: string;
} {
  const markerAt = prompt.lastIndexOf(HOST_GATE_PREVIEW_MARKER);
  if (markerAt < 0) return { authoredPrompt: prompt };
  return {
    authoredPrompt: prompt.slice(0, markerAt),
    preview: prompt.slice(markerAt + HOST_GATE_PREVIEW_MARKER.length),
  };
}

export function parseV3HostBindingRef(ref: string): V3HostBindingRef {
  if (ref.startsWith('params.')) {
    return { kind: 'params', path: parsePath(ref.slice('params.'.length), ref) };
  }
  if (ref.startsWith('context.')) {
    return { kind: 'context', path: parsePath(ref.slice('context.'.length), ref) };
  }
  const resultAt = ref.indexOf(RESULT_MARKER);
  if (resultAt <= 0) {
    throw new V3HostBindingError(
      `unsupported host binding ${JSON.stringify(ref)}; expected params.<path>, ` +
      'context.<path>, or <nodeId>.result.<path>',
    );
  }
  const nodeId = ref.slice(0, resultAt);
  if (!/^[A-Za-z0-9._-]+$/.test(nodeId)) {
    throw new V3HostBindingError(`host binding ${JSON.stringify(ref)} has an invalid node id`);
  }
  return {
    kind: 'result',
    nodeId,
    path: parsePath(ref.slice(resultAt + RESULT_MARKER.length), ref),
  };
}

function parsePath(raw: string, ref: string): string[] {
  if (!raw) throw new V3HostBindingError(`host binding ${JSON.stringify(ref)} has an empty path`);
  const path = raw.split('.');
  for (const segment of path) {
    if (!PATH_SEGMENT_RE.test(segment) || FORBIDDEN_SEGMENTS.has(segment)) {
      throw new V3HostBindingError(
        `host binding ${JSON.stringify(ref)} has unsafe/invalid path segment ${JSON.stringify(segment)}`,
      );
    }
  }
  return path;
}

function isExactRefObject(value: unknown): value is { $ref: string } {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === '$ref' && typeof value.$ref === 'string';
}

/** Collect every ref and reject malformed `${...}` / `$ref` shapes early. */
export function collectV3HostBindingRefs(template: unknown): V3HostBindingRef[] {
  const refs: V3HostBindingRef[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const parsed = parseV3HostBindingRef(raw);
    const key = JSON.stringify(parsed);
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(parsed);
    }
  };
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (!value.includes('${')) return;
      const covered = new Array<boolean>(value.length).fill(false);
      const markerRe = stringMarkerRe();
      for (let match = markerRe.exec(value); match; match = markerRe.exec(value)) {
        add(match[1]!);
        for (let i = match.index; i < match.index + match[0].length; i++) covered[i] = true;
      }
      for (let i = value.indexOf('${'); i >= 0; i = value.indexOf('${', i + 2)) {
        if (!covered[i]) throw new V3HostBindingError(`malformed host binding marker at ${path}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (!isRecord(value)) {
      if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
      throw new V3HostBindingError(`host input at ${path} must be finite JSON`);
    }
    if (Object.prototype.hasOwnProperty.call(value, '$ref')) {
      if (!isExactRefObject(value)) {
        throw new V3HostBindingError(
          `host input at ${path} must use $ref as the exact object { "$ref": "..." }`,
        );
      }
      add(value.$ref);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_SEGMENTS.has(key)) {
        throw new V3HostBindingError(`host input at ${path} uses forbidden key ${JSON.stringify(key)}`);
      }
      walk(child, `${path}.${key}`);
    }
  };
  walk(template, 'input');
  return refs;
}

/** Resolve one host template into a plain JSON value. */
export async function resolveV3HostInputTemplate(
  template: unknown,
  ctx: V3HostBindingContext,
): Promise<unknown> {
  // Validate the whole tree before any async reads. A malformed sibling must
  // not cause a partial result-read side effect before the function rejects.
  collectV3HostBindingRefs(template);
  const resultCache = new Map<string, Promise<unknown>>();
  const resolveRef = async (raw: string): Promise<unknown> => {
    const ref = parseV3HostBindingRef(raw);
    if (ref.kind === 'params') return walkPath(ctx.params, ref.path, raw);
    if (ref.kind === 'context') return walkPath(ctx.context, ref.path, raw);
    let loaded = resultCache.get(ref.nodeId);
    if (!loaded) {
      loaded = ctx.loadResult(ref.nodeId);
      resultCache.set(ref.nodeId, loaded);
    }
    return walkPath(await loaded, ref.path, raw);
  };

  const walk = async (value: unknown, path: string): Promise<unknown> => {
    if (typeof value === 'string') {
      if (!value.includes('${')) return value;
      let out = '';
      let offset = 0;
      // Snapshot every match before the first await. A module-global /g regex
      // would share lastIndex across Promise.all sibling strings and could bind
      // the wrong frozen payload under concurrency.
      const matches = [...value.matchAll(stringMarkerRe())];
      for (const match of matches) {
        out += value.slice(offset, match.index);
        const resolved = await resolveRef(match[1]!);
        if (
          resolved !== null &&
          typeof resolved !== 'string' &&
          typeof resolved !== 'number' &&
          typeof resolved !== 'boolean'
        ) {
          throw new V3HostBindingError(
            `host string binding ${JSON.stringify(match[1])} at ${path} resolved to a non-scalar; use exact $ref`,
          );
        }
        out += resolved === null ? 'null' : String(resolved);
        offset = match.index + match[0].length;
      }
      return out + value.slice(offset);
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((child, index) => walk(child, `${path}[${index}]`)));
    }
    if (!isRecord(value)) return value;
    if (isExactRefObject(value)) return cloneFiniteJson(await resolveRef(value.$ref), `${path}.$ref`);
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value)) out[key] = await walk(child, `${path}.${key}`);
    return out;
  };
  return cloneFiniteJson(await walk(template, 'input'), 'input');
}

function walkPath(root: unknown, path: string[], ref: string): unknown {
  let cursor = root;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') {
      throw new V3HostBindingError(
        `host binding ${JSON.stringify(ref)} cannot read ${JSON.stringify(segment)} from a non-object`,
      );
    }
    if (Array.isArray(cursor)) {
      if (!/^\d+$/.test(segment)) {
        throw new V3HostBindingError(`host binding ${JSON.stringify(ref)} must use a numeric array index`);
      }
      const index = Number(segment);
      if (!Object.prototype.hasOwnProperty.call(cursor, index)) {
        throw new V3HostBindingError(`host binding ${JSON.stringify(ref)} is missing array index ${index}`);
      }
      cursor = cursor[index];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
      throw new V3HostBindingError(`host binding ${JSON.stringify(ref)} is missing path segment ${JSON.stringify(segment)}`);
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function cloneFiniteJson(value: unknown, path: string, seen: Set<object> = new Set()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new V3HostBindingError(`host value at ${path} must be finite`);
    return value;
  }
  if (typeof value !== 'object') throw new V3HostBindingError(`host value at ${path} is not JSON`);
  if (seen.has(value)) throw new V3HostBindingError(`host value at ${path} is cyclic`);
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((child, index) => cloneFiniteJson(child, `${path}[${index}]`, seen));
    seen.delete(value);
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new V3HostBindingError(`host value at ${path} is not a plain JSON object`);
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SEGMENTS.has(key)) {
      throw new V3HostBindingError(`host value at ${path} uses forbidden key ${JSON.stringify(key)}`);
    }
    out[key] = cloneFiniteJson(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
  return out;
}

/** A bounded, redacted preview safe to append to a gate prompt. */
export function renderV3HostInputPreview(executor: string, input: unknown, inputHash: string): string {
  const redact = (value: unknown, key?: string): unknown => {
    if (key && SECRET_KEY_RE.test(key)) return '[REDACTED]';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (isRecord(value)) {
      const out: Record<string, unknown> = Object.create(null);
      for (const [childKey, child] of Object.entries(value)) {
        out[childKey] = redact(child, childKey);
      }
      return out;
    }
    return value;
  };
  const body = JSON.stringify(redact(input), null, 2);
  return [
    `Executor: ${executor}`,
    `Frozen input hash: ${inputHash}`,
    '',
    '```json',
    body,
    '```',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
