import type { SavedWorkflowRevisionDraft } from './library-schema.js';
import {
  isValidSavedWorkflowParamName,
  validateSavedWorkflowRevisionDraft,
} from './library-schema.js';

export const V3_DISTILLATION_COMPILER_VERSION = 'v1' as const;
export const V3_DISTILLATION_SUGGESTION_SCHEMA_VERSION = 1 as const;
export const V3_DISTILLATION_COMPILED_SCHEMA_VERSION = 1 as const;

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const MARKER_RE = /^\$\{params\.([A-Za-z_][A-Za-z0-9_]{0,63})\}$/;
// Matches the P0 approval card ceiling: every valid host proposal must remain
// representable in the mandatory all-or-nothing review surface.
const MAX_CANDIDATES = 32;
const MAX_LITERAL_BYTES = 16 * 1024;

export type V3DistillationReasonCode =
  | 'SOURCE_NOT_ELIGIBLE'
  | 'MALFORMED_SUGGESTION'
  | 'ZERO_CANDIDATES'
  | 'UNSUPPORTED_PATH'
  | 'SOURCE_LITERAL_NOT_FOUND'
  | 'DUPLICATE_CANDIDATE'
  | 'OVERLAPPING_REPLACEMENTS'
  | 'SECRET_OR_IDENTITY_LITERAL'
  | 'SOURCE_VALUE_RESIDUE'
  | 'BASELINE_ALREADY_PARAMETERIZED'
  | 'TEMPLATE_VALIDATION_FAILED'
  | 'REVERSE_FILL_MISMATCH'
  | 'MALFORMED_COMPILED_BODY';

/** Safe to surface: the message contains the stable class only. */
export class V3DistillationCompileError extends Error {
  constructor(public readonly code: V3DistillationReasonCode) {
    super(`Workflow parameter distillation failed (${code})`);
    this.name = 'V3DistillationCompileError';
  }
}

export interface V3DistillationCandidateV1 {
  path: string;
  literal: string;
  occurrence: number;
  type: 'string';
}

export interface V3DistillationSuggestionV1 {
  schemaVersion: typeof V3_DISTILLATION_SUGGESTION_SCHEMA_VERSION;
  candidates: V3DistillationCandidateV1[];
}

export type V3DistillationFieldCategory = 'goal' | 'instruction' | 'spec';

export interface DistilledReplacementV1 {
  /** Numeric-ordinal JSON pointer; it never carries a raw node/sketch id. */
  path: string;
  startUtf8: number;
  endUtf8: number;
  literalSha256: string;
  replacement: `\${params.${string}}`;
  paramName: string;
  fieldCategory: V3DistillationFieldCategory;
}

export interface V3DistillationSafeFieldRefV1 {
  nodeOrdinal: number;
  field: 'goal' | 'instruction';
}

export interface V3DistillationSafeParameterSummaryV1 {
  name: string;
  type: 'string';
  required: true;
  hasDefault: false;
  replacementCount: number;
  fields: V3DistillationSafeFieldRefV1[];
}

export interface V3DistillationSafeSummaryV1 {
  parameters: V3DistillationSafeParameterSummaryV1[];
  roundTripVerified: true;
  structuralFieldsUnchanged: true;
}

/** Immutable compiler-owned body. Store/approval identity wraps this object. */
export interface V3DistillationCompiledBodyV1 {
  schemaVersion: typeof V3_DISTILLATION_COMPILED_SCHEMA_VERSION;
  compilerVersion: typeof V3_DISTILLATION_COMPILER_VERSION;
  baselineRevisionSha256: string;
  revisionDraft: SavedWorkflowRevisionDraft;
  replacements: DistilledReplacementV1[];
  safeSummary: V3DistillationSafeSummaryV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isAllowedV3DistillationDagPath(path: string): boolean {
  return /^\/dagTemplate\/nodes\/\d+(?:\/body\/nodes\/\d+)*\/(?:goal|override\/systemPromptAppend)$/.test(path);
}

export function isAllowedV3DistillationSpecPath(path: string): boolean {
  return path === '/specTemplate/title' ||
    path === '/specTemplate/requirement' ||
    path === '/specTemplate/acceptance' ||
    /^\/specTemplate\/nonGoals\/\d+$/.test(path) ||
    /^\/specTemplate\/nodes\/\d+\/(?:goal|acceptance)$/.test(path) ||
    /^\/specTemplate\/nodes\/\d+\/(?:input_needs|expected_outputs|unknowns)\/\d+$/.test(path);
}

export function fieldCategoryForV3DistillationPath(
  path: string,
): V3DistillationFieldCategory | undefined {
  if (isAllowedV3DistillationSpecPath(path)) return 'spec';
  if (path.endsWith('/goal') && isAllowedV3DistillationDagPath(path)) return 'goal';
  if (path.endsWith('/override/systemPromptAppend') && isAllowedV3DistillationDagPath(path)) {
    return 'instruction';
  }
  return undefined;
}

export function parseV3DistillationSuggestion(raw: unknown): V3DistillationSuggestionV1 {
  if (!isRecord(raw) || !hasExactKeys(raw, ['schemaVersion', 'candidates']) ||
      raw.schemaVersion !== V3_DISTILLATION_SUGGESTION_SCHEMA_VERSION ||
      !Array.isArray(raw.candidates) || raw.candidates.length > MAX_CANDIDATES) {
    throw new V3DistillationCompileError('MALFORMED_SUGGESTION');
  }
  const candidates = raw.candidates.map((item): V3DistillationCandidateV1 => {
    if (!isRecord(item) ||
        !hasExactKeys(item, ['path', 'literal', 'occurrence', 'type']) ||
        typeof item.path !== 'string' || item.path.length === 0 || item.path.length > 512 || item.path.includes('\0') ||
        typeof item.literal !== 'string' || item.literal.length === 0 || item.literal.includes('\0') ||
        Buffer.byteLength(item.literal, 'utf8') > MAX_LITERAL_BYTES ||
        !Number.isInteger(item.occurrence) || (item.occurrence as number) < 0 || (item.occurrence as number) > 9999 ||
        item.type !== 'string') {
      throw new V3DistillationCompileError('MALFORMED_SUGGESTION');
    }
    return {
      path: item.path,
      literal: item.literal,
      occurrence: item.occurrence as number,
      type: 'string',
    };
  });
  return { schemaVersion: V3_DISTILLATION_SUGGESTION_SCHEMA_VERSION, candidates };
}

function parseReplacement(raw: unknown): DistilledReplacementV1 {
  if (!isRecord(raw) || !hasExactKeys(raw, [
    'path', 'startUtf8', 'endUtf8', 'literalSha256', 'replacement', 'paramName', 'fieldCategory',
  ])) throw new V3DistillationCompileError('MALFORMED_COMPILED_BODY');
  const category = typeof raw.path === 'string'
    ? fieldCategoryForV3DistillationPath(raw.path)
    : undefined;
  const marker = typeof raw.replacement === 'string' ? MARKER_RE.exec(raw.replacement) : null;
  if (!category || category !== raw.fieldCategory ||
      !Number.isInteger(raw.startUtf8) || !Number.isInteger(raw.endUtf8) ||
      (raw.startUtf8 as number) < 0 || (raw.endUtf8 as number) <= (raw.startUtf8 as number) ||
      typeof raw.literalSha256 !== 'string' || !SHA256_RE.test(raw.literalSha256) ||
      typeof raw.paramName !== 'string' || !isValidSavedWorkflowParamName(raw.paramName) ||
      !marker || marker[1] !== raw.paramName) {
    throw new V3DistillationCompileError('MALFORMED_COMPILED_BODY');
  }
  return {
    path: raw.path as string,
    startUtf8: raw.startUtf8 as number,
    endUtf8: raw.endUtf8 as number,
    literalSha256: raw.literalSha256,
    replacement: raw.replacement as `\${params.${string}}`,
    paramName: raw.paramName,
    fieldCategory: category,
  };
}

function parseSafeSummary(raw: unknown): V3DistillationSafeSummaryV1 {
  if (!isRecord(raw) || !hasExactKeys(raw, [
    'parameters', 'roundTripVerified', 'structuralFieldsUnchanged',
  ]) || raw.roundTripVerified !== true || raw.structuralFieldsUnchanged !== true ||
      !Array.isArray(raw.parameters)) {
    throw new V3DistillationCompileError('MALFORMED_COMPILED_BODY');
  }
  const parameters = raw.parameters.map((item): V3DistillationSafeParameterSummaryV1 => {
    if (!isRecord(item) || !hasExactKeys(item, [
      'name', 'type', 'required', 'hasDefault', 'replacementCount', 'fields',
    ]) || typeof item.name !== 'string' || !isValidSavedWorkflowParamName(item.name) ||
        item.type !== 'string' || item.required !== true || item.hasDefault !== false ||
        !Number.isInteger(item.replacementCount) || (item.replacementCount as number) < 1 ||
        (item.replacementCount as number) > 10_000 ||
        !Array.isArray(item.fields) || item.fields.length < 1 || item.fields.length > 128) {
      throw new V3DistillationCompileError('MALFORMED_COMPILED_BODY');
    }
    const fields = item.fields.map((field): V3DistillationSafeFieldRefV1 => {
      if (!isRecord(field) || !hasExactKeys(field, ['nodeOrdinal', 'field']) ||
          !Number.isInteger(field.nodeOrdinal) || (field.nodeOrdinal as number) < 1 ||
          (field.field !== 'goal' && field.field !== 'instruction')) {
        throw new V3DistillationCompileError('MALFORMED_COMPILED_BODY');
      }
      return { nodeOrdinal: field.nodeOrdinal as number, field: field.field };
    });
    return {
      name: item.name,
      type: 'string',
      required: true,
      hasDefault: false,
      replacementCount: item.replacementCount as number,
      fields,
    };
  });
  return { parameters, roundTripVerified: true, structuralFieldsUnchanged: true };
}

export function parseV3DistillationCompiledBody(raw: unknown): V3DistillationCompiledBodyV1 {
  if (!isRecord(raw) || !hasExactKeys(raw, [
    'schemaVersion', 'compilerVersion', 'baselineRevisionSha256',
    'revisionDraft', 'replacements', 'safeSummary',
  ]) || raw.schemaVersion !== V3_DISTILLATION_COMPILED_SCHEMA_VERSION ||
      raw.compilerVersion !== V3_DISTILLATION_COMPILER_VERSION ||
      typeof raw.baselineRevisionSha256 !== 'string' || !SHA256_RE.test(raw.baselineRevisionSha256) ||
      !Array.isArray(raw.replacements) || raw.replacements.length < 1) {
    throw new V3DistillationCompileError('MALFORMED_COMPILED_BODY');
  }
  let revisionDraft: SavedWorkflowRevisionDraft;
  try {
    revisionDraft = validateSavedWorkflowRevisionDraft(raw.revisionDraft);
  } catch {
    throw new V3DistillationCompileError('MALFORMED_COMPILED_BODY');
  }
  const replacements = raw.replacements.map(parseReplacement);
  const safeSummary = parseSafeSummary(raw.safeSummary);
  const inputNames = Object.keys(revisionDraft.inputs).sort();
  const summaryNames = safeSummary.parameters.map((parameter) => parameter.name);
  if (new Set(summaryNames).size !== summaryNames.length ||
      JSON.stringify([...summaryNames].sort()) !== JSON.stringify(inputNames)) {
    throw new V3DistillationCompileError('MALFORMED_COMPILED_BODY');
  }
  for (const name of inputNames) {
    const definition = revisionDraft.inputs[name]!;
    if (JSON.stringify(Object.keys(definition).sort()) !== JSON.stringify(['required', 'type']) ||
        definition.type !== 'string' || definition.required !== true ||
        Object.prototype.hasOwnProperty.call(definition, 'default') || definition.sensitive === true) {
      throw new V3DistillationCompileError('MALFORMED_COMPILED_BODY');
    }
    const expected = replacements.filter((replacement) => replacement.paramName === name).length;
    const summary = safeSummary.parameters.find((parameter) => parameter.name === name);
    if (expected < 1 || summary?.replacementCount !== expected) {
      throw new V3DistillationCompileError('MALFORMED_COMPILED_BODY');
    }
  }
  return {
    schemaVersion: V3_DISTILLATION_COMPILED_SCHEMA_VERSION,
    compilerVersion: V3_DISTILLATION_COMPILER_VERSION,
    baselineRevisionSha256: raw.baselineRevisionSha256,
    revisionDraft,
    replacements,
    safeSummary,
  };
}
