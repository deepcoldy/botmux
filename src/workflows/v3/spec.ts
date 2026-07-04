/**
 * v3 spec — the grill layer's machine-readable output contract.
 *
 * grill writes `spec.md` (human narrative) containing a single fenced ```json
 * block that holds the canonical `Spec` (schemaVersion / runId / title /
 * requirement / acceptance? / nonGoals? / nodes[]).  `workflow spec-finalize`
 * extracts that block, validates it against the Spec schema, and materializes
 * `spec.json` — the structured truth the architect goal-worker reads.  Any
 * parse / validate failure throws and BLOCKS handoff (codex review 2026-06-02).
 *
 * Node sketch ships as fenced JSON (not YAML): the repo has no YAML dependency,
 * it mirrors v0.2's JSON workflow definitions, and an LLM emits valid JSON
 * reliably.  Validation is pure and mirrors `dag.ts` (accumulate `problems`,
 * throw once at the end).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { SPEC_SCHEMA_VERSION, type Spec, type SpecNodeSketch } from './contract.js';

/** Path-safe id (same shape as dag.ts node ids / runId). */
const SKETCH_ID_RE = /^[A-Za-z0-9._-]+$/;

export class SpecValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid v3 spec:\n  - ${problems.join('\n  - ')}`);
    this.name = 'SpecValidationError';
  }
}

/**
 * Pull the single fenced ```json block out of spec.md and `JSON.parse` it.
 * Throws `SpecValidationError` when the block is absent, unparseable, OR when
 * there is more than one — the spec contract says spec.md carries EXACTLY one
 * canonical-Spec json block, so a stale-block + new-block mix must be rejected
 * rather than silently finalizing the wrong (first) one (codex review).
 */
export function extractSpecJsonBlock(specMd: string): unknown {
  const blocks = [...specMd.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length === 0) {
    throw new SpecValidationError(['spec.md 缺少 ```json 代码块（应包含 canonical Spec）']);
  }
  if (blocks.length > 1) {
    throw new SpecValidationError([
      `spec.md 有 ${blocks.length} 个 \`\`\`json 代码块，应只保留唯一一个 canonical Spec 块（删掉旧的/多余的）`,
    ]);
  }
  try {
    return JSON.parse(blocks[0][1]);
  } catch (err) {
    throw new SpecValidationError([
      `spec.md 的 \`\`\`json 块 JSON.parse 失败：${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
}

function normStringArray(v: unknown, where: string, problems: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    problems.push(`${where} 必须是字符串数组`);
    return [];
  }
  return v as string[];
}

/**
 * Validate an untrusted parsed value into a `Spec`.  Pure — throws
 * `SpecValidationError` with the full problem list on any issue, otherwise
 * returns the normalized Spec.
 */
export function validateSpec(raw: unknown): Spec {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    throw new SpecValidationError(['root 必须是 JSON object']);
  }
  const r = raw as Record<string, unknown>;

  if (r.schemaVersion !== SPEC_SCHEMA_VERSION) {
    problems.push(`schemaVersion 必须是 ${SPEC_SCHEMA_VERSION}（got ${JSON.stringify(r.schemaVersion)}）`);
  }
  if (typeof r.runId !== 'string' || !SKETCH_ID_RE.test(r.runId)) {
    problems.push(`runId 必须是 path-safe 字符串 ${SKETCH_ID_RE}（got ${JSON.stringify(r.runId)}）`);
  }
  if (typeof r.title !== 'string' || r.title.trim() === '') {
    problems.push('title 必须是非空字符串');
  }
  if (typeof r.requirement !== 'string' || r.requirement.trim() === '') {
    problems.push('requirement 必须是非空字符串');
  }
  if (r.acceptance !== undefined && typeof r.acceptance !== 'string') {
    problems.push('acceptance 必须是字符串或省略');
  }
  const nonGoals = r.nonGoals === undefined ? undefined : normStringArray(r.nonGoals, 'nonGoals', problems);

  if (!Array.isArray(r.nodes) || r.nodes.length === 0) {
    throw new SpecValidationError([...problems, 'nodes 必须是非空数组']);
  }

  const seen = new Set<string>();
  const nodes: SpecNodeSketch[] = [];
  r.nodes.forEach((rawNode, i) => {
    const where = `nodes[${i}]`;
    if (typeof rawNode !== 'object' || rawNode === null) {
      problems.push(`${where} 必须是 object`);
      return;
    }
    const n = rawNode as Record<string, unknown>;

    const sketchId = n.sketchId;
    if (typeof sketchId !== 'string' || !SKETCH_ID_RE.test(sketchId)) {
      problems.push(`${where}.sketchId 必须是 path-safe 字符串（got ${JSON.stringify(sketchId)}）`);
    } else if (seen.has(sketchId)) {
      problems.push(`重复 sketchId "${sketchId}"`);
    } else {
      seen.add(sketchId);
    }
    if (typeof n.goal !== 'string' || n.goal.trim() === '') {
      problems.push(`${where}.goal 必须是非空字符串`);
    }
    if (typeof n.acceptance !== 'string' || n.acceptance.trim() === '') {
      problems.push(`${where}.acceptance 必须是非空字符串`);
    }
    if (typeof n.risk_gate !== 'boolean') {
      problems.push(`${where}.risk_gate 必须是 boolean`);
    }
    // input_needs is FREE TEXT (descriptions of needed info/products), NOT a
    // list of upstream sketchIds — grill must not draw edges (codex 2026-06-02).
    const input_needs = normStringArray(n.input_needs, `${where}.input_needs`, problems);
    const expected_outputs = normStringArray(n.expected_outputs, `${where}.expected_outputs`, problems);
    const unknowns = normStringArray(n.unknowns, `${where}.unknowns`, problems);
    if (expected_outputs.length === 0) {
      problems.push(`${where}.expected_outputs 至少要有 1 个`);
    }

    nodes.push({
      sketchId: typeof sketchId === 'string' ? sketchId : '',
      goal: typeof n.goal === 'string' ? n.goal.trim() : '',
      input_needs,
      expected_outputs,
      acceptance: typeof n.acceptance === 'string' ? n.acceptance.trim() : '',
      risk_gate: n.risk_gate === true,
      unknowns,
    });
  });

  if (problems.length > 0) throw new SpecValidationError(problems);

  return {
    schemaVersion: SPEC_SCHEMA_VERSION,
    runId: r.runId as string,
    title: (r.title as string).trim(),
    requirement: (r.requirement as string).trim(),
    acceptance: r.acceptance as string | undefined,
    nonGoals,
    nodes,
  };
}

/** Parse + validate the canonical Spec out of spec.md content (no IO). */
export function parseSpecFromMarkdown(specMd: string): Spec {
  return validateSpec(extractSpecJsonBlock(specMd));
}

/**
 * Read `specMdPath`, parse + validate its fenced json block, and write the
 * canonical `spec.json` to `specJsonPath`.  Returns the Spec.  Throws
 * `SpecValidationError` (which the host surfaces and uses to BLOCK handoff).
 *
 * When `runId` is given it is the host-authoritative run id: it overrides
 * whatever grill put in the block (grill's value is advisory) before
 * validation, so spec.json's runId always matches the run dir.
 */
export function finalizeSpec(specMdPath: string, specJsonPath: string, runId?: string): Spec {
  const parsed = extractSpecJsonBlock(specMdPath ? readFileSync(specMdPath, 'utf-8') : '');
  if (runId !== undefined && typeof parsed === 'object' && parsed !== null) {
    (parsed as Record<string, unknown>).runId = runId;
  }
  const spec = validateSpec(parsed);
  writeFileSync(specJsonPath, JSON.stringify(spec, null, 2) + '\n', 'utf-8');
  return spec;
}
