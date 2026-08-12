/**
 * verified-delivery/acceptance.ts — parse + validate the orchestrator's structured
 * verification plan (P1 #7). This is the single seam both halves build on: the CLI
 * (`cmdDispatch`) calls `parseAcceptanceCriteria()` to fail-fast on a malformed
 * structured hint before any TaskDispatched is appended; the L2 avatar / watchdog
 * call `summarizeAcceptanceCriteria()` to render the checklist for a human/agent.
 *
 * Back-compat rule (agreed with codex): the existing free-text `acceptanceHint`
 * survives. We only treat an input as an *explicit structured attempt* when it
 * trims to something starting with `{`. Such an attempt MUST validate (error →
 * fail-fast, no dispatch). Anything else is a legacy plain-language hint and is
 * left untouched (structured:false, no error).
 */
import type { AcceptanceCriteria, AcceptanceArtifact, AcceptanceCommand, AcceptanceCheck } from './types.js';

export interface ParseAcceptanceResult {
  /** A valid, normalized structured criteria — present only on success. */
  criteria?: AcceptanceCriteria;
  /** Validation error — present only when an explicit structured attempt failed.
   *  Callers MUST fail-fast on this (do not dispatch). */
  error?: string;
  /** True when the input looked like an explicit structured attempt (`{...}`). */
  structured: boolean;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function validateCheck(raw: unknown, where: string, errs: string[]): AcceptanceCheck | undefined {
  if (!isPlainObject(raw)) { errs.push(`${where}: check 必须是对象`); return undefined; }
  const type = raw.type;
  if (type === 'exists') return { type: 'exists' };
  if (type === 'contains') {
    if (typeof raw.text !== 'string' || raw.text.length === 0) {
      errs.push(`${where}: contains check 缺少非空 text`);
      return undefined;
    }
    return { type: 'contains', text: raw.text };
  }
  errs.push(`${where}: 未知 check.type "${String(type)}"(v1 仅支持 exists / contains)`);
  return undefined;
}

function validateArtifact(raw: unknown, idx: number, errs: string[]): AcceptanceArtifact | undefined {
  const where = `artifacts[${idx}]`;
  if (!isPlainObject(raw)) { errs.push(`${where}: 必须是对象`); return undefined; }
  if (typeof raw.path !== 'string' || raw.path.trim().length === 0) {
    errs.push(`${where}: 缺少非空 path`);
    return undefined;
  }
  if (raw.kind !== undefined && raw.kind !== 'file' && raw.kind !== 'dir') {
    errs.push(`${where}: kind 只能是 "file" 或 "dir"`);
  }
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    errs.push(`${where}: 缺少非空 checks 数组`);
    return undefined;
  }
  const checks: AcceptanceCheck[] = [];
  raw.checks.forEach((c, i) => {
    const ok = validateCheck(c, `${where}.checks[${i}]`, errs);
    if (ok) checks.push(ok);
  });
  const art: AcceptanceArtifact = { path: raw.path.trim(), checks };
  if (raw.kind === 'file' || raw.kind === 'dir') art.kind = raw.kind;
  return art;
}

function validateCommand(raw: unknown, idx: number, errs: string[]): AcceptanceCommand | undefined {
  const where = `commands[${idx}]`;
  if (!isPlainObject(raw)) { errs.push(`${where}: 必须是对象`); return undefined; }
  if (typeof raw.cmd !== 'string' || raw.cmd.trim().length === 0) {
    errs.push(`${where}: 缺少非空 cmd`);
    return undefined;
  }
  const cmd: AcceptanceCommand = { cmd: raw.cmd.trim() };
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string') errs.push(`${where}: cwd 必须是字符串`);
    else cmd.cwd = raw.cwd;
  }
  if (raw.expectExitCode !== undefined) {
    if (typeof raw.expectExitCode !== 'number' || !Number.isInteger(raw.expectExitCode)) {
      errs.push(`${where}: expectExitCode 必须是整数`);
    } else cmd.expectExitCode = raw.expectExitCode;
  }
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== 'number' || raw.timeoutMs <= 0) {
      errs.push(`${where}: timeoutMs 必须是正数`);
    } else cmd.timeoutMs = raw.timeoutMs;
  }
  return cmd;
}

/**
 * Parse a possibly-structured acceptance hint. See file header for the back-compat
 * rule. Never throws — malformed structured input is reported via `.error`.
 */
export function parseAcceptanceCriteria(raw: string | null | undefined): ParseAcceptanceResult {
  const s = (raw ?? '').trim();
  if (!s || !s.startsWith('{')) return { structured: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    return { structured: true, error: `acceptanceHint 以 { 开头但不是合法 JSON:${(e as Error).message}` };
  }
  if (!isPlainObject(parsed)) {
    return { structured: true, error: 'acceptance criteria 必须是 JSON 对象' };
  }

  const errs: string[] = [];
  if (parsed.version !== 1) errs.push(`version 必须为 1(收到 ${JSON.stringify(parsed.version)})`);

  const artifacts: AcceptanceArtifact[] = [];
  if (parsed.artifacts !== undefined) {
    if (!Array.isArray(parsed.artifacts)) errs.push('artifacts 必须是数组');
    else parsed.artifacts.forEach((a, i) => { const ok = validateArtifact(a, i, errs); if (ok) artifacts.push(ok); });
  }

  const commands: AcceptanceCommand[] = [];
  if (parsed.commands !== undefined) {
    if (!Array.isArray(parsed.commands)) errs.push('commands 必须是数组');
    else parsed.commands.forEach((c, i) => { const ok = validateCommand(c, i, errs); if (ok) commands.push(ok); });
  }

  if (artifacts.length === 0 && commands.length === 0 && errs.length === 0) {
    errs.push('criteria 至少要有一个 artifact 或 command');
  }
  if (errs.length > 0) return { structured: true, error: errs.join('; ') };

  const criteria: AcceptanceCriteria = { version: 1 };
  if (artifacts.length) criteria.artifacts = artifacts;
  if (commands.length) criteria.commands = commands;
  return { structured: true, criteria };
}

/** Render a criteria as human/agent-readable checklist lines (for the watchdog
 *  injection + L2 prompt). Keep it terse — one line per check/command. */
export function summarizeAcceptanceCriteria(c: AcceptanceCriteria): string[] {
  const lines: string[] = [];
  for (const a of c.artifacts ?? []) {
    const checks = a.checks.map((ck) =>
      ck.type === 'exists' ? '存在' : `含"${ck.text}"`,
    ).join(' + ');
    lines.push(`产物 ${a.path}${a.kind ? `(${a.kind})` : ''}: ${checks}`);
  }
  for (const cmd of c.commands ?? []) {
    const bits = [`命令 \`${cmd.cmd}\``];
    if (cmd.cwd) bits.push(`cwd=${cmd.cwd}`);
    bits.push(`期望退出码 ${cmd.expectExitCode ?? 0}`);
    if (cmd.timeoutMs) bits.push(`超时 ${cmd.timeoutMs}ms`);
    lines.push(bits.join(', '));
  }
  return lines;
}
