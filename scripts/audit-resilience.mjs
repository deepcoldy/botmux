#!/usr/bin/env node
/**
 * Resilience source audit — a CI gate (run by `bun run build` via audit:domains
 * style wiring) that makes two failure shapes, which previously ran unattended
 * for days, structurally hard to reintroduce:
 *
 *  1. A raw `setInterval(... )` whose callback performs an outbound API poll.
 *     Outbound polling MUST go through a resilient runtime (services/resilient-
 *     poller.ts) or a per-key circuit (services/listener-circuit-breaker.ts),
 *     which classify permanent vs transient errors, back off, and open a
 *     circuit. A bare setInterval around an HTTP/Lark call is what let a
 *     removed-chat 230002 poll spin ~110k times over 19 days.
 *
 *  2. A non-empty `catch` that only logs (`logger.warn/error/debug/info` /
 *     console.*) and then `continue`s a polling loop — i.e. a permanent error
 *     is swallowed and retried forever. Empty catch blocks are allowed (they
 *     are deliberate best-effort ignores) and are audited elsewhere.
 *
 * This is a heuristic static gate, not a type system: it errs toward LOW false
 * positives by only flagging patterns that strongly match, and every rule has
 * an allowlist for deliberate exceptions. It complements — does not replace —
 * code review and the resilient runtime types.
 *
 * Output: exits 1 with an actionable list when violations are found; prints a
 * pass line otherwise.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const roots = ['src'];
const rootFiles = [];
const textExtensions = new Set(['.ts']);
const generatedDirectories = new Set(['node_modules', 'dist', 'doc_build']);

function* walk(path) {
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (generatedDirectories.has(entry.name) || entry.name === '.git') continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) yield* walk(child);
    else if (entry.isFile() && textExtensions.has(extname(entry.name))) yield child;
  }
}

/** Files that legitimately define or test the resilience primitives. */
const allowlistedFiles = new Set([
  'src/services/resilient-poller.ts',
  'src/services/listener-circuit-breaker.ts',
  'src/im/lark/error-classify.ts',
]);

/** Outbound-poll signal: interval callback (or a function it calls) reaches an
 * external API. We match conservative import/call tokens rather than full data
 * flow, which keeps the gate cheap and false-positive free. */
const OUTBOUND_POLL_TOKENS = [
  /setInterval\s*\(/g,
];
const OUTBOUND_CALL_HINTS = [
  'larkGet', 'c.request', 'fetcher(', 'fetchWithTimeout', 'fetch(',
  'listChatMessagesUntil', 'listDocComments', 'syncAllMemberships',
  'axios', '.request({',
];

const violations = [];

for (const file of [...walk(join(repoRoot, 'src'))]) {
  const rel = relative(repoRoot, file);
  if (allowlistedFiles.has(rel)) continue;
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');

  // Rule 1: setInterval whose callback body (roughly the interval's following
  // block) contains an outbound call hint AND no resilience/classification
  // token. We inspect a window after each setInterval( match.
  for (const m of source.matchAll(/setInterval\s*\(/g)) {
    const startLine = source.slice(0, m.index).split('\n').length;
    // Line-local opt-out: an explicit `resilience-audit-allow: <reason>` on the
    // setInterval line or within 3 lines before it suppresses this match. This
    // is for deliberately best-effort/opt-in polls (e.g. federation heartbeat,
    // which only runs after joining a team and surfaces failure in the UI);
    // it is narrower and more honest than a file-level allowlist.
    const preceding = lines.slice(Math.max(0, startLine - 4), startLine).join('\n');
    if (/resilience-audit-allow\s*:/.test(preceding)) continue;
    const windowText = lines.slice(startLine - 1, startLine + 24).join('\n');
    const callsOut = OUTBOUND_CALL_HINTS.some(hint => windowText.includes(hint));
    if (!callsOut) continue;
    const usesResilience =
      windowText.includes('CircuitBreaker')
      || windowText.includes('ResilientPoller')
      || windowText.includes('classifyLarkError')
      || windowText.includes('shouldPoll')
      || windowText.includes('recordPermanent');
    if (usesResilience) continue;
    // setInterval that merely *arms* a resilient poller elsewhere is fine;
    // the strong signal is an inline outbound fetch inside the callback.
    violations.push(`${rel}:${startLine}: setInterval performs an outbound poll without a resilient runtime/circuit (use services/resilient-poller or a circuit breaker)`);
  }

  // Rule 2: catch block that only logs and immediately `continue`s (a polling
  // loop swallowing an error forever). Match `catch (...) { ...log... continue; }`
  // with no classify/circuit/backoff token in between.
  const catchContinueRe = /catch\s*\([^)]*\)\s*\{([^{}]{0,400}?)\bcontinue\s*;/gs;
  for (const m of source.matchAll(catchContinueRe)) {
    const body = m[1];
    const onlyLogs = /logger\.(warn|error|debug|info)|console\.(log|warn|error)/.test(body);
    if (!onlyLogs) continue;
    const handles = /classify|Circuit|backoff|recordPermanent|shouldPoll|retryAfter|transient/i.test(body);
    if (handles) continue;
    const line = source.slice(0, m.index).split('\n').length;
    violations.push(`${rel}:${line}: catch only logs then continues the polling loop (classify permanent/transient or open a circuit instead)`);
  }
}

if (violations.length > 0) {
  throw new Error(
    `[resilience-audit] found ${violations.length} pattern(s) that risk silent infinite polling:\n`
    + `${[...new Set(violations)].map(v => `- ${v}`).join('\n')}\n`
    + 'Outbound polling must go through services/resilient-poller.ts or a per-key circuit; '
    + 'permanent errors must not be swallowed and retried forever. If this is a deliberate exception, add the file to the gate allowlist.',
  );
}
console.log('[resilience-audit] no bare outbound-interval or log-and-continue polling patterns found');
