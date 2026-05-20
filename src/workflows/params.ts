/**
 * Shared params coercion + validation for `workflow run`.
 *
 * Used by:
 *   - IM `/workflow run <id> key=value …`  (key=value strings from chat)
 *   - CLI `botmux workflow run <id> --param key=value [--param-json key=<json>]`
 *
 * Behaviour contract (matches the schema in `ParamDefSchema`):
 *   - Unknown param names → throw `unknown param` (don't silently pass through;
 *     the workflow author hasn't declared them, so any binding would be a
 *     latent typo).
 *   - Missing required → throw.
 *   - Missing optional + has `default` → fill with default verbatim.
 *   - Missing optional + no default → omit (downstream `${params.X}` lookup
 *     surfaces a `BindingError` on use, which is the right place to fail).
 *   - Present + type=string → keep as string.
 *   - Present + type=number → `Number(raw)`; reject NaN / Infinity.
 *   - Present + type=boolean → accept `true/1/yes/y` / `false/0/no/n` (case
 *     insensitive); reject anything else.
 *   - Present + type=object|array → only valid via the JSON channel; the
 *     plain string channel throws to tell the caller to use `--param-json`
 *     (CLI) or pre-decoded JSON (programmatic).
 */

import type { ParamDef, WorkflowDefinition } from './definition.js';

export type RawParamInput =
  | { kind: 'string'; value: string }
  | { kind: 'json'; value: unknown };

export type ParamCoerceError = {
  /** Param name that failed; undefined for whole-record-shape errors. */
  name?: string;
  /** Machine code for the failure category. */
  code:
    | 'unknown_param'
    | 'missing_required'
    | 'type_mismatch'
    | 'unsupported_string_channel'
    | 'invalid_json';
  /** Human-readable Chinese-localized message (matches existing CLI/IM output). */
  message: string;
};

export class ParamCoerceFailure extends Error {
  readonly issues: ParamCoerceError[];
  constructor(issues: ParamCoerceError[]) {
    super(issues.map((i) => i.message).join('; '));
    this.name = 'ParamCoerceFailure';
    this.issues = issues;
  }
}

/**
 * Validate + coerce raw caller input against the workflow's `params` schema.
 *
 * `rawParams` accepts a mixed map of `{ kind: 'string' | 'json' }` so that
 * the CLI can pipe `--param-json` through the same code path as `--param`.
 * The IM `/workflow run` legacy entry calls `coerceWorkflowParamsFromStrings`
 * below which wraps every value as `{ kind: 'string' }`.
 *
 * All errors are aggregated into a single `ParamCoerceFailure` so the caller
 * can render every issue at once instead of one-by-one Enter-key fixes.
 */
export function coerceWorkflowParams(
  def: WorkflowDefinition,
  rawParams: Record<string, RawParamInput>,
): Record<string, unknown> {
  const paramDefs = def.params ?? {};
  const issues: ParamCoerceError[] = [];

  // 1) Reject unknown keys first.  The user's mental model is "I told you
  //    everything I want"; unknown keys are likely typos.
  for (const key of Object.keys(rawParams)) {
    if (!Object.prototype.hasOwnProperty.call(paramDefs, key)) {
      issues.push({
        name: key,
        code: 'unknown_param',
        message: `未知参数：${key}`,
      });
    }
  }

  const out: Record<string, unknown> = {};

  // 2) Walk the schema (not the caller input) so required + default rules
  //    always apply.
  for (const [name, param] of Object.entries(paramDefs)) {
    const raw = rawParams[name];
    if (!raw) {
      if (param.default !== undefined) {
        out[name] = param.default;
        continue;
      }
      if (param.required) {
        issues.push({
          name,
          code: 'missing_required',
          message: `缺少必填参数：${name}`,
        });
      }
      continue;
    }
    try {
      out[name] = coerceParam(name, param, raw);
    } catch (err) {
      if (err instanceof ParamCoerceFailure) issues.push(...err.issues);
      else if (err instanceof Error) {
        issues.push({ name, code: 'type_mismatch', message: err.message });
      } else {
        issues.push({ name, code: 'type_mismatch', message: String(err) });
      }
    }
  }

  if (issues.length) throw new ParamCoerceFailure(issues);
  return out;
}

/**
 * Legacy convenience: when every input is a raw string (IM chat path), wrap
 * each value into `{ kind: 'string' }` and delegate to `coerceWorkflowParams`.
 */
export function coerceWorkflowParamsFromStrings(
  def: WorkflowDefinition,
  rawParams: Record<string, string>,
): Record<string, unknown> {
  const wrapped: Record<string, RawParamInput> = {};
  for (const [k, v] of Object.entries(rawParams)) {
    wrapped[k] = { kind: 'string', value: v };
  }
  return coerceWorkflowParams(def, wrapped);
}

function coerceParam(name: string, param: ParamDef, raw: RawParamInput): unknown {
  if (raw.kind === 'json') {
    return coerceParamFromJson(name, param, raw.value);
  }
  return coerceParamFromString(name, param, raw.value);
}

function coerceParamFromString(name: string, param: ParamDef, raw: string): unknown {
  switch (param.type) {
    case 'string':
      return raw;
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new ParamCoerceFailure([
          {
            name,
            code: 'type_mismatch',
            message: `参数 ${name} 必须是 number,收到 "${raw}"`,
          },
        ]);
      }
      return n;
    }
    case 'boolean':
      return coerceBoolean(name, raw);
    case 'object':
    case 'array':
      throw new ParamCoerceFailure([
        {
          name,
          code: 'unsupported_string_channel',
          message:
            `参数 ${name} 的 ${param.type} 类型不能用 key=value 字符串传入,` +
            `请用 CLI \`--param-json ${name}=<json>\` 或 IM 端目前不支持 object/array`,
        },
      ]);
  }
}

function coerceParamFromJson(name: string, param: ParamDef, value: unknown): unknown {
  switch (param.type) {
    case 'string':
      if (typeof value !== 'string') {
        throw typeMismatch(name, param.type, value);
      }
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw typeMismatch(name, param.type, value);
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw typeMismatch(name, param.type, value);
      }
      return value;
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw typeMismatch(name, param.type, value);
      }
      return value;
    case 'array':
      if (!Array.isArray(value)) {
        throw typeMismatch(name, param.type, value);
      }
      return value;
  }
}

function coerceBoolean(name: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  throw new ParamCoerceFailure([
    {
      name,
      code: 'type_mismatch',
      message: `参数 ${name} 必须是 boolean (true/false/1/0/yes/no),收到 "${raw}"`,
    },
  ]);
}

function typeMismatch(
  name: string,
  expected: ParamDef['type'],
  got: unknown,
): ParamCoerceFailure {
  const actual = Array.isArray(got) ? 'array' : got === null ? 'null' : typeof got;
  return new ParamCoerceFailure([
    {
      name,
      code: 'type_mismatch',
      message: `参数 ${name} 必须是 ${expected},收到 ${actual}`,
    },
  ]);
}
