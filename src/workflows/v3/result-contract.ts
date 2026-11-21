/**
 * Pure structured-result checks shared by the in-process worker path and the
 * external-submission path: `result.json` schema validation and the
 * cross-node revisit request a node may return instead of a success.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { V3ResultSchema } from './dag.js';
import type { Manifest } from './artifact-contract.js';

/** Validation outcome for an opt-in `result.json` against its node schema. */
export interface ResultValidation {
  ok: boolean;
  problems?: string[];
}

/** Read a worker's cross-node revisit request from `result.json` (if any).  A
 *  revisit is `{ "status": "revisit", "revisitTo": "<ancestor>", "reason"? }`.
 *  Absent result.json / non-revisit status → `{ ok:true }` (no request).  A
 *  malformed revisit (missing/blank revisitTo, non-string reason) → `ok:false`
 *  so the runtime blocks it as resultInvalid.  The ancestor membership check
 *  (toNodeId ∈ node.revisitTo) is the caller's (it has the node). */
export function readRevisitRequest(
  manifest: Manifest,
  outputDir: string,
): { ok: true; request?: { toNodeId: string; reason?: string } } | { ok: false; problems: string[] } {
  const entry = manifest.files.find((f) => f.path === 'result.json');
  if (!entry) return { ok: true };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(outputDir, entry.path), 'utf-8'));
  } catch {
    return { ok: true }; // unreadable result.json: not a revisit (resultSchema path reports it)
  }
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>).status !== 'revisit') {
    return { ok: true };
  }
  const v = value as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof v.revisitTo !== 'string' || v.revisitTo.trim() === '') {
    problems.push('result.json status "revisit" requires a non-empty string "revisitTo"');
  }
  if (v.reason !== undefined && typeof v.reason !== 'string') {
    problems.push('result.json "reason" must be a string when present');
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    request: {
      toNodeId: v.revisitTo as string,
      ...(typeof v.reason === 'string' && v.reason ? { reason: v.reason } : {}),
    },
  };
}

/**
 * Validate a `result.json` against the node's (already dag-validated) result
 * schema subset.  Top-level types only — see `V3ResultSchema`.  Undeclared
 * extra properties are allowed (JSON-Schema default).
 */
export function validateResult(filePath: string, schema: V3ResultSchema): ResultValidation {
  if (!existsSync(filePath)) return { ok: false, problems: [`result.json not found at ${filePath}`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return { ok: false, problems: [`result.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problems: ['result.json root must be a JSON object'] };
  }
  const obj = parsed as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of schema.required ?? []) {
    if (!(field in obj)) problems.push(`missing required field "${field}"`);
  }
  for (const [name, spec] of Object.entries(schema.properties)) {
    if (!(name in obj)) continue; // absence is only a problem when required
    const v = obj[name];
    const okType =
      spec.type === 'string' ? typeof v === 'string'
      : spec.type === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : spec.type === 'boolean' ? typeof v === 'boolean'
      : spec.type === 'array' ? Array.isArray(v)
      : typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!okType) {
      problems.push(`field "${name}" must be of type ${spec.type}`);
      continue;
    }
    // Enum enforcement (edge-activation design §1.3): a declared vocabulary
    // is part of the contract — an out-of-vocabulary value is `resultInvalid`
    // (blocked, retryable), same as a type violation.
    if (spec.type === 'string' && spec.enum && !spec.enum.includes(v as string)) {
      problems.push(`field "${name}" must be one of [${spec.enum.join(', ')}] (got ${JSON.stringify(v)})`);
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true };
}
