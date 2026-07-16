import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { posix, win32 } from 'node:path';

import { canonicalJsonStringify } from '../../utils/canonical-json.js';
import {
  computeSavedWorkflowGateDigest,
  computeSavedWorkflowSideEffects,
  validateSavedWorkflowRevisionDraft,
  type SavedWorkflowRevisionDraft,
} from './library-schema.js';
import {
  buildSavedWorkflowRevisionBaseline,
  collectSavedWorkflowReusableTextWarnings,
} from './library-materialize.js';
import type { LoadedAuthorizedV3Run } from './run-envelope.js';
import {
  assertSavedWorkflowSpecTemplateBindings,
  assertSavedWorkflowTemplateBindings,
} from './template-bindings.js';
import {
  V3_DISTILLATION_COMPILED_SCHEMA_VERSION,
  V3_DISTILLATION_COMPILER_VERSION,
  V3DistillationCompileError,
  fieldCategoryForV3DistillationPath,
  isAllowedV3DistillationDagPath,
  isAllowedV3DistillationSpecPath,
  parseV3DistillationCompiledBody,
  parseV3DistillationSuggestion,
  type DistilledReplacementV1,
  type V3DistillationCompiledBodyV1,
  type V3DistillationSafeFieldRefV1,
} from './distillation-schema.js';

export interface CompileV3DistillationProposalInput {
  /** Exact, host-built revision draft from one digest-validated source read. */
  baselineRevision: unknown;
  /** Untrusted model output. */
  suggestion: unknown;
}

export interface V3DistillationModelFieldV1 {
  /** Opaque within this one minimized worker input. */
  ref: `field-${string}`;
  /** Host-owned numeric pointer; suggestions copy it verbatim. */
  path: string;
  category: 'goal' | 'instruction';
  nodeOrdinal: number;
  text: string;
}

interface TextTarget {
  path: string;
  text: string;
  category: 'goal' | 'instruction' | 'spec';
  nodeOrdinal?: number;
}

interface PendingReplacement extends DistilledReplacementV1 {
  startChar: number;
  endChar: number;
  literal: string;
}

interface ParameterSource {
  literal: string;
  literalSha256: string;
  fields: V3DistillationSafeFieldRefV1[];
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const KNOWN_SECRET_TOKEN_SOURCE = String.raw`(?:sk[-_][A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_-]{12,}|glpat-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9_-]{12,}|xapp-[A-Za-z0-9-]{12,})`;
const SENSITIVE_LABEL_SOURCE = String.raw`(?:api[_-]?key|access[_-]?(?:token|key(?:[_-]?id)?)|(?:client|session|refresh|id)?[_-]?token|client[_-]?secret|password|passwd|passphrase|credential(?:s)?|authorization|auth|bearer|private[_-]?key|cookie|secret)`;

function isKnownSecretToken(value: string): boolean {
  return new RegExp(`^${KNOWN_SECRET_TOKEN_SOURCE}$`).test(value);
}

function containsKnownSecretToken(value: string): boolean {
  return new RegExp(
    `(?:^|[^A-Za-z0-9_-])${KNOWN_SECRET_TOKEN_SOURCE}(?=$|[^A-Za-z0-9_-])`,
  ).test(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pointer(parts: readonly (string | number)[]): string {
  return `/${parts.map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

function decodePointer(path: string): string[] {
  return path.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function readPointer(root: unknown, path: string): unknown {
  let current = root;
  for (const part of decodePointer(path)) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return undefined;
      current = current[Number(part)];
    } else if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function writePointer(root: unknown, path: string, value: string): void {
  const parts = decodePointer(path);
  let current: unknown = root;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index]!;
    current = Array.isArray(current)
      ? current[Number(part)]
      : (current as Record<string, unknown>)[part];
  }
  const leaf = parts.at(-1)!;
  if (Array.isArray(current)) current[Number(leaf)] = value;
  else (current as Record<string, unknown>)[leaf] = value;
}

function enumerateDagTargets(revision: SavedWorkflowRevisionDraft): Map<string, TextTarget> {
  const targets = new Map<string, TextTarget>();
  let nodeOrdinal = 0;
  const visit = (nodes: readonly unknown[], prefix: (string | number)[]): void => {
    nodes.forEach((rawNode, index) => {
      if (!rawNode || typeof rawNode !== 'object') return;
      const node = rawNode as Record<string, unknown>;
      nodeOrdinal++;
      const base = [...prefix, 'nodes', index];
      if (node.type === 'goal' && typeof node.goal === 'string') {
        const path = pointer([...base, 'goal']);
        targets.set(path, { path, text: node.goal, category: 'goal', nodeOrdinal });
      }
      if (node.type === 'goal' && node.override && typeof node.override === 'object') {
        const instruction = (node.override as Record<string, unknown>).systemPromptAppend;
        if (typeof instruction === 'string') {
          const path = pointer([...base, 'override', 'systemPromptAppend']);
          targets.set(path, { path, text: instruction, category: 'instruction', nodeOrdinal });
        }
      }
      if (node.type === 'loop' && node.body && typeof node.body === 'object') {
        const bodyNodes = (node.body as Record<string, unknown>).nodes;
        if (Array.isArray(bodyNodes)) visit(bodyNodes, [...base, 'body']);
      }
    });
  };
  visit(revision.dagTemplate.nodes, ['dagTemplate']);
  return targets;
}

/** Canonical exact-save baseline from one verified in-memory source read. */
export function buildV3DistillationBaseline(
  loaded: LoadedAuthorizedV3Run,
): SavedWorkflowRevisionDraft {
  if (loaded.envelope.source.kind !== 'ad_hoc' || !loaded.spec || loaded.botSnapshots === undefined) {
    throw new V3DistillationCompileError('SOURCE_NOT_ELIGIBLE');
  }
  try {
    return buildSavedWorkflowRevisionBaseline(loaded).revision;
  } catch {
    throw new V3DistillationCompileError('TEMPLATE_VALIDATION_FAILED');
  }
}

/** Minimal model-visible execution text; no ids, topology, gates, or host input. */
export function enumerateV3DistillationModelFields(
  baselineRevision: unknown,
): V3DistillationModelFieldV1[] {
  let baseline: SavedWorkflowRevisionDraft;
  try {
    baseline = validateSavedWorkflowRevisionDraft(baselineRevision);
  } catch {
    throw new V3DistillationCompileError('TEMPLATE_VALIDATION_FAILED');
  }
  return [...enumerateDagTargets(baseline).values()].map((target, index) => ({
    ref: `field-${String(index + 1).padStart(3, '0')}`,
    path: target.path,
    category: target.category as 'goal' | 'instruction',
    nodeOrdinal: target.nodeOrdinal!,
    text: target.text,
  }));
}

export function computeV3DistillationBaselineSha256(baselineRevision: unknown): string {
  let baseline: SavedWorkflowRevisionDraft;
  try {
    baseline = validateSavedWorkflowRevisionDraft(baselineRevision);
  } catch {
    throw new V3DistillationCompileError('TEMPLATE_VALIDATION_FAILED');
  }
  return sha256(canonicalJsonStringify(baseline));
}

function enumerateSpecTargets(revision: SavedWorkflowRevisionDraft): Map<string, TextTarget> {
  const spec = revision.specTemplate;
  const targets = new Map<string, TextTarget>();
  const add = (parts: (string | number)[], value: unknown): void => {
    if (typeof value !== 'string') return;
    const path = pointer(['specTemplate', ...parts]);
    targets.set(path, { path, text: value, category: 'spec' });
  };
  add(['title'], spec.title);
  add(['requirement'], spec.requirement);
  add(['acceptance'], spec.acceptance);
  spec.nonGoals?.forEach((value, index) => add(['nonGoals', index], value));
  spec.nodes.forEach((node, nodeIndex) => {
    add(['nodes', nodeIndex, 'goal'], node.goal);
    add(['nodes', nodeIndex, 'acceptance'], node.acceptance);
    node.input_needs.forEach((value, index) => add(['nodes', nodeIndex, 'input_needs', index], value));
    node.expected_outputs.forEach((value, index) => add(['nodes', nodeIndex, 'expected_outputs', index], value));
    node.unknowns.forEach((value, index) => add(['nodes', nodeIndex, 'unknowns', index], value));
  });
  return targets;
}

function occurrences(text: string, literal: string): number[] {
  const found: number[] = [];
  for (let start = 0; start <= text.length - literal.length;) {
    const index = text.indexOf(literal, start);
    if (index < 0) break;
    found.push(index);
    start = index + literal.length;
  }
  return found;
}

function looksLikeSecretOrIdentity(literal: string, containingText: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(literal)) return true;
  if (isKnownSecretToken(literal)) return true;
  if (/^(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}$/.test(literal)) return true;
  if (/^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(literal)) return true;
  if (/^(?:ou|on|oc|om|cli)_[A-Za-z0-9_-]{8,}$/.test(literal)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(literal)) return true;
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `${SENSITIVE_LABEL_SOURCE}\\s*[:=]\\s*["']?${escaped}(?:["']|\\s|$)`,
    'i',
  ).test(containingText);
}

function isAbsoluteMachinePath(literal: string): boolean {
  return posix.isAbsolute(literal) || win32.isAbsolute(literal) ||
    /^~(?:[A-Za-z0-9._-]+)?[\\/]/.test(literal);
}

const SOURCE_FILE_SUFFIXES = new Set([
  '7z', 'avi', 'avro', 'bz2', 'c', 'cfg', 'cjs', 'conf', 'cpp', 'css', 'csv',
  'db', 'doc', 'docx', 'ex', 'exs', 'flac', 'gif', 'go', 'gql', 'graphql',
  'gz', 'h', 'hpp', 'html', 'ini', 'java', 'jpeg', 'jpg', 'js', 'json', 'jsx',
  'kt', 'lock', 'md', 'mjs', 'mov', 'mp3', 'mp4', 'parquet', 'pdf', 'php',
  'png', 'ppt', 'pptx', 'proto', 'py', 'r', 'rb', 'rs', 'scala', 'sh', 'sql',
  'sqlite', 'svelte', 'svg', 'swift', 'tar', 'tgz', 'toml', 'ts', 'tsx', 'txt',
  'vue', 'wasm', 'wav', 'webm', 'webp', 'xls', 'xlsx', 'xml', 'yaml', 'yml',
]);

const COMMON_SOURCE_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'tsconfig.json', 'jsconfig.json', 'composer.json', 'cargo.toml', 'cargo.lock',
  'go.mod', 'go.sum', 'requirements.txt', 'pyproject.toml', 'dockerfile',
  'readme.md', 'license.md', 'changelog.md',
]);

function isClearlyFileReferenceAt(
  literal: string,
  containingText: string,
  occurrenceStart: number,
): boolean {
  const normalized = literal.replace(/\.$/, '');
  if (COMMON_SOURCE_BASENAMES.has(normalized.toLowerCase())) return true;
  const labels = normalized.split('.');
  if (labels.length < 2 || !SOURCE_FILE_SUFFIXES.has(labels.at(-1)!.toLowerCase())) return false;
  if (!Number.isSafeInteger(occurrenceStart) || occurrenceStart < 0 ||
      containingText.slice(occurrenceStart, occurrenceStart + literal.length) !== literal) {
    return false;
  }
  // Classification is deliberately occurrence-local. A file-shaped use of a
  // token earlier in the field must not exempt a later hostname use of the
  // same bytes (for example, "read api.sh, then connect to api.sh").
  const before = containingText.slice(Math.max(0, occurrenceStart - 192), occurrenceStart);
  if (/(?:\b(?:file|filename|module|script|document|config(?:uration)?|manifest)\s+(?:named\s+)?[`"']?|\b(?:edit|update|refactor|fix|test|lint|format|compile|build|delete|create|read|write)\s+(?:the\s+)?(?:file\s+)?[`"']?)$/i.test(before)) {
    return true;
  }
  return /(?:^|[\s("'`])(?:\.\.?[\\/])?(?:[A-Za-z0-9_.-]+[\\/])+$/.test(before);
}

function looksLikeNetworkLocator(
  literal: string,
  containingText = literal,
  occurrenceStart = containingText === literal ? 0 : -1,
): boolean {
  if (literal !== literal.trim() || literal.length === 0) return false;
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(literal)) return false;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(literal)) {
    return false;
  }
  if (/^(?:node|python|ubuntu|debian|alpine|golang|ruby|php|openjdk):v?\d+(?:\.\d+){0,3}(?:-[a-z0-9.-]+)?$/i.test(literal)) {
    return false;
  }
  if (isIP(literal) !== 0) return true;
  const normalized = literal.replace(/[.:]+$/, '');
  if (/^[^@\s]+@(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252}):[^\s]+$/.test(normalized)) {
    return true;
  }
  const bracketedIpv6 = /^\[([0-9A-Fa-f:]+)\](?::\d{1,5})?$/.exec(normalized);
  if (bracketedIpv6 && isIP(bracketedIpv6[1]!) === 6) return true;
  const hasExplicitPort = /:\d{1,5}$/.test(normalized);
  const host = normalized.replace(/:\d{1,5}$/, '');
  if (isIP(host) !== 0) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(normalized)) return true;
  if (hasExplicitPort && /^(?=.{1,253}$)(?=.*[A-Za-z-])[A-Za-z0-9](?:[A-Za-z0-9-]{0,251}[A-Za-z0-9])?$/.test(host)) {
    return true;
  }
  if (/^(?:localhost|[^.]+\.(?:localhost|local|internal|corp|lan))$/i.test(host)) return true;
  if (/^(?:prod(?:uction)?|stag(?:e|ing)|dev|qa|uat|build|db|api|host|server|svc)(?=[a-z0-9-]{1,63}$)(?:[a-z0-9-]*\d[a-z0-9-]*|[a-z0-9]*-[a-z0-9-]+)$/i.test(host)) {
    return true;
  }
  if (/^(?:jenkins|jira|redis|mysql|postgres|kafka|elastic|grafana|corp)[a-z0-9-]*(?:\d|-(?:prod|primary|replica|db|cache|api|host|server|svc|internal))$/i.test(host)) {
    return true;
  }
  if (/^[a-z0-9-]+-(?:prod|primary|replica|db|cache|api|host|server|svc|internal)$/i.test(host)) {
    return true;
  }
  const namedService = /^(.+):[A-Za-z][A-Za-z0-9_-]{0,31}$/.exec(host);
  if (namedService) {
    const namedHost = namedService[1]!;
    if (isIP(namedHost) !== 0 ||
        /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/i.test(namedHost)) {
      return true;
    }
  }
  if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/i.test(host)) {
    return false;
  }
  return !isClearlyFileReferenceAt(host, containingText, occurrenceStart);
}

/** Strict host-side privacy predicate shared by source and display-name gates. */
export function containsUnsafeV3DistillationReusableText(text: string): boolean {
  // Authenticated context markers are a binding instruction, not a hostname.
  const scanned = text.replace(/\$\{context\.[A-Za-z0-9_.-]+\}/g, '');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(scanned)) return true;
  if (containsKnownSecretToken(scanned)) return true;
  if (/(?:^|[^A-Z0-9])(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}(?=$|[^A-Z0-9])/.test(scanned)) {
    return true;
  }
  if (/(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?=$|[^A-Za-z0-9_-])/.test(scanned)) {
    return true;
  }
  if (/(?:^|[^A-Za-z0-9_-])(?:ou|on|oc|om|cli)_[A-Za-z0-9_-]{8,}(?=$|[^A-Za-z0-9_-])/.test(scanned)) {
    return true;
  }
  if (/authorization\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9+/_.=-]{6,}/i.test(scanned)) return true;
  if (/(?:^|\s)[^\s@]+@[^\s@]+\.[^\s@]+(?=$|\s)/.test(scanned)) return true;
  if (new RegExp(
    `${SENSITIVE_LABEL_SOURCE}\\s*[:=]\\s*(?:["'][^"'\\r\\n]{1,4096}["']|[^\\s"']{1,4096})`,
    'i',
  ).test(scanned)) {
    return true;
  }
  if (
    /(?:^|[^A-Za-z0-9_.~+\\/-])\/(?:[^\s"'`<>]+)/.test(scanned) ||
    /(?:^|[^A-Za-z0-9_.~+\\/-])[A-Za-z]:[\\/][^\s"'`<>]+/.test(scanned) ||
    /(?:^|[^A-Za-z0-9_.~+\\/-])\\\\[^\\\s"'`<>]+\\[^\s"'`<>]+/.test(scanned) ||
    /(?:^|[^A-Za-z0-9_.~+\\/-])~(?:[A-Za-z0-9._-]+)?[\\/][^\s"'`<>]+/.test(scanned)
  ) {
    return true;
  }
  if (/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/i.test(scanned)) return true;
  if (/[^@\s]+@(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252}):[^\s"'`<>]+/.test(scanned)) {
    return true;
  }
  const locatorTokenRe = /\[[0-9A-Fa-f:]+\](?::\d{1,5})?|(?<![A-Za-z0-9])[0-9A-Fa-f:]*:[0-9A-Fa-f:]+|[A-Za-z0-9][A-Za-z0-9.:-]{2,252}/g;
  for (const match of scanned.matchAll(locatorTokenRe)) {
    const token = match[0];
    if (isIP(token) !== 0 || looksLikeNetworkLocator(token, scanned, match.index)) return true;
  }
  return false;
}

function enumerateAdditionalReusableText(revision: SavedWorkflowRevisionDraft): string[] {
  const out: string[] = [];
  const visitValue = (value: unknown): void => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(visitValue);
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      // Typed whole-value bindings were validated by the DAG schema. Their
      // dotted `$ref` payload is not reusable free text and must not be
      // mistaken for a network hostname.
      if (Object.keys(record).length === 1 && typeof record.$ref === 'string') return;
      for (const [key, child] of Object.entries(record)) {
        out.push(key);
        visitValue(child);
      }
    }
  };
  const visitNodes = (nodes: readonly unknown[]): void => {
    for (const raw of nodes) {
      if (!raw || typeof raw !== 'object') continue;
      const node = raw as Record<string, unknown>;
      const gate = node.humanGate;
      if (gate && typeof gate === 'object') {
        visitValue(gate);
      }
      if (node.type === 'host') visitValue(node.input);
      if (node.resultSchema && typeof node.resultSchema === 'object') visitValue(node.resultSchema);
      if (node.type === 'loop' && node.body && typeof node.body === 'object') {
        const bodyNodes = (node.body as Record<string, unknown>).nodes;
        if (Array.isArray(bodyNodes)) visitNodes(bodyNodes);
      }
    }
  };
  visitNodes(revision.dagTemplate.nodes);
  return out;
}

function assertNoUnsafeReusableSourceText(
  revision: SavedWorkflowRevisionDraft,
  dagTargets: ReadonlyMap<string, TextTarget>,
  specTargets: ReadonlyMap<string, TextTarget>,
): void {
  const values = [
    ...[...dagTargets.values()].map((target) => target.text),
    ...[...specTargets.values()].map((target) => target.text),
    ...enumerateAdditionalReusableText(revision),
  ];
  if (values.some(containsUnsafeV3DistillationReusableText)) {
    throw new V3DistillationCompileError('SECRET_OR_IDENTITY_LITERAL');
  }
}

function assertNoBaselineMarkers(
  dagTargets: ReadonlyMap<string, TextTarget>,
  specTargets: ReadonlyMap<string, TextTarget>,
): void {
  for (const target of [...dagTargets.values(), ...specTargets.values()]) {
    // Built-in context markers are an authenticated binding surface and are
    // preserved verbatim. Only an already-parameterized execution template is
    // outside P0's concrete-run abstraction contract.
    if (target.text.includes('${params.')) {
      throw new V3DistillationCompileError('BASELINE_ALREADY_PARAMETERIZED');
    }
  }
}

/** Privacy/eligibility preflight that must run before model-visible fields leave the host. */
export function assertV3DistillationBaselineSafe(baselineRevision: unknown): void {
  let baseline: SavedWorkflowRevisionDraft;
  try {
    baseline = validateSavedWorkflowRevisionDraft(baselineRevision);
  } catch {
    throw new V3DistillationCompileError('TEMPLATE_VALIDATION_FAILED');
  }
  if (Object.keys(baseline.inputs).length > 0 || baseline.specStatus !== 'current') {
    throw new V3DistillationCompileError('BASELINE_ALREADY_PARAMETERIZED');
  }
  const dagTargets = enumerateDagTargets(baseline);
  const specTargets = enumerateSpecTargets(baseline);
  assertNoUnsafeReusableSourceText(baseline, dagTargets, specTargets);
  assertNoBaselineMarkers(dagTargets, specTargets);
}

function assertNoStructuralResidue(
  revision: SavedWorkflowRevisionDraft,
  literal: string,
  allowedPaths: ReadonlySet<string>,
): void {
  const walk = (value: unknown, parts: (string | number)[]): void => {
    if (typeof value === 'string') {
      if (value.includes(literal) && !allowedPaths.has(pointer(parts))) {
        throw new V3DistillationCompileError('SOURCE_VALUE_RESIDUE');
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, [...parts, index]));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key.includes(literal)) {
          throw new V3DistillationCompileError('SOURCE_VALUE_RESIDUE');
        }
        walk(child, [...parts, key]);
      }
    }
  };
  walk(revision, []);
}

function assertNoOverlaps(replacements: readonly PendingReplacement[]): void {
  const byPath = new Map<string, PendingReplacement[]>();
  for (const replacement of replacements) {
    const list = byPath.get(replacement.path) ?? [];
    list.push(replacement);
    byPath.set(replacement.path, list);
  }
  for (const list of byPath.values()) {
    list.sort((left, right) => left.startChar - right.startChar || left.endChar - right.endChar);
    for (let index = 1; index < list.length; index++) {
      if (list[index]!.startChar < list[index - 1]!.endChar) {
        throw new V3DistillationCompileError('OVERLAPPING_REPLACEMENTS');
      }
    }
  }
}

function applyReplacements(
  revision: SavedWorkflowRevisionDraft,
  replacements: readonly PendingReplacement[],
): void {
  const byPath = new Map<string, PendingReplacement[]>();
  for (const replacement of replacements) {
    const list = byPath.get(replacement.path) ?? [];
    list.push(replacement);
    byPath.set(replacement.path, list);
  }
  for (const [path, list] of byPath) {
    const source = readPointer(revision, path);
    if (typeof source !== 'string') throw new V3DistillationCompileError('REVERSE_FILL_MISMATCH');
    let next = source;
    for (const replacement of [...list].sort((left, right) => right.startChar - left.startChar)) {
      if (source.slice(replacement.startChar, replacement.endChar) !== replacement.literal) {
        throw new V3DistillationCompileError('REVERSE_FILL_MISMATCH');
      }
      next = next.slice(0, replacement.startChar) + replacement.replacement + next.slice(replacement.endChar);
    }
    writePointer(revision, path, next);
  }
}

function reverseFill(
  revision: SavedWorkflowRevisionDraft,
  sources: ReadonlyMap<string, ParameterSource>,
): SavedWorkflowRevisionDraft {
  const out = cloneJson(revision);
  for (const target of [
    ...enumerateDagTargets(out).values(),
    ...enumerateSpecTargets(out).values(),
  ]) {
    let next = target.text;
    for (const [name, source] of sources) {
      next = next.split(`\${params.${name}}`).join(source.literal);
    }
    writePointer(out, target.path, next);
  }
  return out;
}

function durableReplacement(replacement: PendingReplacement): DistilledReplacementV1 {
  const {
    startChar: _startChar,
    endChar: _endChar,
    literal: _literal,
    ...durable
  } = replacement;
  return durable;
}

export function compileV3DistillationProposal(
  input: CompileV3DistillationProposalInput,
): V3DistillationCompiledBodyV1 {
  let baseline: SavedWorkflowRevisionDraft;
  try {
    baseline = validateSavedWorkflowRevisionDraft(input.baselineRevision);
  } catch {
    throw new V3DistillationCompileError('TEMPLATE_VALIDATION_FAILED');
  }
  if (Object.keys(baseline.inputs).length > 0 || baseline.specStatus !== 'current') {
    throw new V3DistillationCompileError('BASELINE_ALREADY_PARAMETERIZED');
  }
  assertV3DistillationBaselineSafe(baseline);
  const suggestion = parseV3DistillationSuggestion(input.suggestion);
  if (suggestion.candidates.length === 0) {
    throw new V3DistillationCompileError('ZERO_CANDIDATES');
  }

  const dagTargets = enumerateDagTargets(baseline);
  const specTargets = enumerateSpecTargets(baseline);
  const allowedPaths = new Set([...dagTargets.keys(), ...specTargets.keys()]);
  const replacements: PendingReplacement[] = [];
  const sources = new Map<string, ParameterSource>();
  const candidateKeys = new Set<string>();

  // The model never controls persisted or rendered metadata.  Assign generic
  // parameter names from a host-canonical candidate order; identical literals
  // intentionally share one parameter so repeated concrete values remain tied.
  const canonicalCandidates = [...suggestion.candidates].sort((left, right) =>
    compareText(left.path, right.path) || left.occurrence - right.occurrence ||
    compareText(left.literal, right.literal));
  const parameterNameByLiteral = new Map<string, string>();
  for (const candidate of canonicalCandidates) {
    if (!parameterNameByLiteral.has(candidate.literal)) {
      parameterNameByLiteral.set(candidate.literal, `param_${parameterNameByLiteral.size + 1}`);
    }
  }

  for (const candidate of canonicalCandidates) {
    const paramName = parameterNameByLiteral.get(candidate.literal)!;
    if (!isAllowedV3DistillationDagPath(candidate.path)) {
      throw new V3DistillationCompileError('UNSUPPORTED_PATH');
    }
    const target = dagTargets.get(candidate.path);
    if (!target || !fieldCategoryForV3DistillationPath(candidate.path)) {
      throw new V3DistillationCompileError('UNSUPPORTED_PATH');
    }
    const candidateKey = canonicalJsonStringify([
      candidate.path, candidate.literal, candidate.occurrence,
    ]);
    if (candidateKeys.has(candidateKey)) {
      throw new V3DistillationCompileError('DUPLICATE_CANDIDATE');
    }
    candidateKeys.add(candidateKey);

    const starts = occurrences(target.text, candidate.literal);
    const startChar = starts[candidate.occurrence];
    if (startChar === undefined) {
      throw new V3DistillationCompileError('SOURCE_LITERAL_NOT_FOUND');
    }
    if (
      candidate.literal.includes('${') ||
      looksLikeSecretOrIdentity(candidate.literal, target.text) ||
      isAbsoluteMachinePath(candidate.literal) ||
      looksLikeNetworkLocator(candidate.literal, target.text, startChar)
    ) {
      throw new V3DistillationCompileError('SECRET_OR_IDENTITY_LITERAL');
    }
    const literalSha256 = sha256(candidate.literal);
    const existing = sources.get(paramName);
    const field: V3DistillationSafeFieldRefV1 = {
      nodeOrdinal: target.nodeOrdinal!,
      field: target.category as 'goal' | 'instruction',
    };
    const source = existing ?? { literal: candidate.literal, literalSha256, fields: [] };
    if (!source.fields.some((item) => item.nodeOrdinal === field.nodeOrdinal && item.field === field.field)) {
      source.fields.push(field);
    }
    sources.set(paramName, source);
    const endChar = startChar + candidate.literal.length;
    replacements.push({
      path: candidate.path,
      startChar,
      endChar,
      startUtf8: Buffer.byteLength(target.text.slice(0, startChar), 'utf8'),
      endUtf8: Buffer.byteLength(target.text.slice(0, endChar), 'utf8'),
      literalSha256,
      replacement: `\${params.${paramName}}`,
      paramName,
      fieldCategory: target.category,
      literal: candidate.literal,
    });
  }

  for (const source of sources.values()) {
    assertNoStructuralResidue(baseline, source.literal, allowedPaths);
  }

  // Spec is a deterministic mirror: replace every exact narrative occurrence.
  for (const [paramName, source] of sources) {
    for (const target of specTargets.values()) {
      for (const startChar of occurrences(target.text, source.literal)) {
        const endChar = startChar + source.literal.length;
        replacements.push({
          path: target.path,
          startChar,
          endChar,
          startUtf8: Buffer.byteLength(target.text.slice(0, startChar), 'utf8'),
          endUtf8: Buffer.byteLength(target.text.slice(0, endChar), 'utf8'),
          literalSha256: source.literalSha256,
          replacement: `\${params.${paramName}}`,
          paramName,
          fieldCategory: 'spec',
          literal: source.literal,
        });
      }
    }
  }

  assertNoOverlaps(replacements);
  const revisionDraft = cloneJson(baseline);
  applyReplacements(revisionDraft, replacements);
  revisionDraft.inputs = Object.fromEntries(
    [...sources.keys()].sort().map((name) => [name, { type: 'string', required: true }]),
  );
  revisionDraft.specStatus = 'current';
  revisionDraft.safety = {
    gateDigest: computeSavedWorkflowGateDigest(revisionDraft.dagTemplate),
    sideEffects: computeSavedWorkflowSideEffects(revisionDraft.dagTemplate),
  };

  const lintWarnings: string[] = [];
  collectSavedWorkflowReusableTextWarnings(revisionDraft.dagTemplate, 'dagTemplate', lintWarnings);
  collectSavedWorkflowReusableTextWarnings(revisionDraft.specTemplate, 'specTemplate', lintWarnings);
  if (lintWarnings.length > 0) {
    throw new V3DistillationCompileError('TEMPLATE_VALIDATION_FAILED');
  }
  try {
    assertSavedWorkflowTemplateBindings(
      revisionDraft.dagTemplate,
      revisionDraft.inputs,
      revisionDraft.contextRefs,
    );
    assertSavedWorkflowSpecTemplateBindings(
      revisionDraft.specTemplate,
      revisionDraft.inputs,
      revisionDraft.contextRefs,
    );
    validateSavedWorkflowRevisionDraft(revisionDraft);
  } catch {
    throw new V3DistillationCompileError('TEMPLATE_VALIDATION_FAILED');
  }

  const reversed = reverseFill(revisionDraft, sources);
  reversed.inputs = cloneJson(baseline.inputs);
  if (canonicalJsonStringify(reversed) !== canonicalJsonStringify(baseline)) {
    throw new V3DistillationCompileError('REVERSE_FILL_MISMATCH');
  }

  const durable = replacements
    .map(durableReplacement)
    .sort((left, right) => compareText(left.path, right.path) ||
      left.startUtf8 - right.startUtf8 || left.endUtf8 - right.endUtf8 ||
      compareText(left.paramName, right.paramName));
  const body: V3DistillationCompiledBodyV1 = {
    schemaVersion: V3_DISTILLATION_COMPILED_SCHEMA_VERSION,
    compilerVersion: V3_DISTILLATION_COMPILER_VERSION,
    baselineRevisionSha256: computeV3DistillationBaselineSha256(baseline),
    revisionDraft,
    replacements: durable,
    safeSummary: {
      parameters: [...sources.entries()].sort(([left], [right]) => compareText(left, right))
        .map(([name, source]) => ({
          name,
          type: 'string' as const,
          required: true as const,
          hasDefault: false as const,
          replacementCount: durable.filter((item) => item.paramName === name).length,
          fields: [...source.fields].sort((left, right) =>
            left.nodeOrdinal - right.nodeOrdinal || compareText(left.field, right.field)),
        })),
      roundTripVerified: true,
      structuralFieldsUnchanged: true,
    },
  };
  return parseV3DistillationCompiledBody(body);
}

function charIndexAtUtf8Offset(text: string, offset: number): number | undefined {
  if (!Number.isInteger(offset) || offset < 0) return undefined;
  let utf8 = 0;
  for (let index = 0; index <= text.length;) {
    if (utf8 === offset) return index;
    if (index === text.length || utf8 > offset) return undefined;
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) return undefined;
    const width = codePoint > 0xffff ? 2 : 1;
    utf8 += Buffer.byteLength(text.slice(index, index + width), 'utf8');
    index += width;
  }
  return undefined;
}

/**
 * Re-derive every model-selected candidate from the authenticated baseline,
 * run the current deterministic compiler again, and require a byte-canonical
 * match. Approval therefore never trusts stored spans, hashes, summaries, or
 * revision bytes merely because they satisfy the storage schema.
 */
export function recompileV3DistillationProposal(
  baselineRevision: unknown,
  compiledBody: unknown,
): V3DistillationCompiledBodyV1 {
  let baseline: SavedWorkflowRevisionDraft;
  try {
    baseline = validateSavedWorkflowRevisionDraft(baselineRevision);
  } catch {
    throw new V3DistillationCompileError('TEMPLATE_VALIDATION_FAILED');
  }
  const compiled = parseV3DistillationCompiledBody(compiledBody);
  const dagTargets = enumerateDagTargets(baseline);
  const candidates = compiled.replacements
    .filter((replacement) => replacement.fieldCategory !== 'spec')
    .map((replacement) => {
      const target = dagTargets.get(replacement.path);
      if (!target) throw new V3DistillationCompileError('REVERSE_FILL_MISMATCH');
      const startChar = charIndexAtUtf8Offset(target.text, replacement.startUtf8);
      const endChar = charIndexAtUtf8Offset(target.text, replacement.endUtf8);
      if (startChar === undefined || endChar === undefined || endChar <= startChar) {
        throw new V3DistillationCompileError('REVERSE_FILL_MISMATCH');
      }
      const literal = target.text.slice(startChar, endChar);
      if (sha256(literal) !== replacement.literalSha256) {
        throw new V3DistillationCompileError('REVERSE_FILL_MISMATCH');
      }
      const occurrence = occurrences(target.text, literal).indexOf(startChar);
      if (occurrence < 0) throw new V3DistillationCompileError('REVERSE_FILL_MISMATCH');
      return { path: replacement.path, literal, occurrence, type: 'string' as const };
    });
  if (candidates.length === 0) throw new V3DistillationCompileError('REVERSE_FILL_MISMATCH');
  const recompiled = compileV3DistillationProposal({
    baselineRevision: baseline,
    suggestion: { schemaVersion: 1, candidates },
  });
  if (canonicalJsonStringify(recompiled) !== canonicalJsonStringify(compiled)) {
    throw new V3DistillationCompileError('REVERSE_FILL_MISMATCH');
  }
  return recompiled;
}
