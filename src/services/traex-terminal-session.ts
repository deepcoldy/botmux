import type { PtyHandle } from '../adapters/cli/types.js';
import { findTraexRolloutSetByPid } from './traex-transcript.js';
import { stripAnsiScreenText } from '../utils/idle-detector.js';
import { delay } from '../utils/timing.js';
import {
  TRAEX_EMPTY_COMPOSER_HINTS,
  TRAEX_PROGRESS_PATTERN,
  traexViewportFooterBusy,
} from '../adapters/cli/traex-footer.js';

type Snapshot = ReturnType<NonNullable<PtyHandle['captureInputState']>>;
type Resolution = { kind: 'legacy' | 'unavailable'; inputReleased?: boolean }
  | { kind: 'terminal'; sessionId: string; liveSinceMs?: number; inputReleased?: boolean };
const bindings = new WeakMap<PtyHandle, { pid: number; sessionId: string; viewport?: string }>();
const generations = new WeakMap<PtyHandle, { pid: number; value: number }>();
const unsupported = new WeakMap<PtyHandle, { pid: number; viewport: string }>();
const shared = new WeakMap<PtyHandle, number>();
const pending = new WeakMap<PtyHandle, Promise<Resolution>>();
const incompleteQueries = new WeakMap<PtyHandle, number>();
const changedAt = new WeakMap<PtyHandle, { pid: number; timestampMs: number }>();

function snapshot(terminal: PtyHandle): Snapshot {
  try { return terminal.captureInputState?.() ?? null; } catch { return null; }
}

function lastMatchingRow(rows: string[], pattern: RegExp): number {
  for (let i = rows.length - 1; i >= 0; i--) if (pattern.test(rows[i]!)) return i;
  return -1;
}

/** Read the live composer, never a prompt-looking line in scrollback. */
export function traexEmptyComposer(state: Snapshot): boolean {
  if (!state || traexViewportFooterBusy(state.viewport)) return false;
  const rows = stripAnsiScreenText(state.viewport).split(/\r?\n/);
  const row = rows[state.cursor.y];
  const match = /^(\s*)[›❯] ([^\r\n]*?)\s*$/.exec(row ?? '');
  if (!match || state.cursor.x !== match[1]!.length + 2) return false;
  // The cursor remains immediately after the prompt for a native placeholder;
  // real typed text moves it. Keep that geometry check separate from the hint
  // vocabulary so a human draft cannot become write permission.
  if (!TRAEX_EMPTY_COMPOSER_HINTS.has(match[2]!.trim())) return false;
  const footerStart = lastMatchingRow(rows, /^[▀▄█─]+\s*$/);
  if (footerStart <= state.cursor.y || rows.slice(state.cursor.y + 1, footerStart).some(line => line.trim())) return false;
  const footer = rows.slice(footerStart + 1).filter(line => line.trim());
  return footer.length >= 1 && footer.length <= 3
    && footer.some(line => /\bContext (?:\d+% (?:left|used)|[—–-])\b/.test(line))
    && footer.every(line => /\bContext\b|\? for shortcuts|← for agents/.test(line));
}

type TraexStatusPanel = { sessionId?: string; retryable: boolean };

/** Recognise the native panel separately from whether it carries a bindable
 * shared-server identity. A recognised negative result must still be closed. */
function traexStatusPanel(state: Snapshot, settleIncomplete = false): TraexStatusPanel | undefined {
  if (!state) return;
  const rows = stripAnsiScreenText(state.viewport).split(/\r?\n/);
  const header = lastMatchingRow(rows, /^\s*>_ TRAE CLI \(v[^\r\n]+\)\s*$/);
  if (header < 0 || state.cursor.y <= header) return;
  const panel = rows.slice(header);
  if (panel.some(line => /^\s*[›❯](?:\s|$)/.test(line))) return;
  if (panel.some(line => TRAEX_PROGRESS_PATTERN.test(line)
    // Pre-ellipsis recordings used a shorter activity row. Keep that legacy
    // guard alongside the complete shared spinner vocabulary.
    || /^\s*(?:[⋄◇◆✦◈❖✧]\s+)?(?:Working|Thinking|Queued)[^\r\n]*\besc to interr?upt\b/.test(line))) return;
  // Require native panel structure, not just a header quoted in scrollback.
  // Identity extraction below deliberately remains stricter than recognition.
  const nativeFields = panel.filter(line => /^\s*(?:Execution host|Directory|Session|Limits):/.test(line));
  if (nativeFields.length < 2) {
    return settleIncomplete && nativeFields.length > 0 ? { retryable: true } : undefined;
  }
  const host = panel.find(line => /^\s*Execution host:/.test(line));
  if (host && !/^\s*Execution host:\s+Local background server\s*$/.test(host)) {
    return { retryable: false };
  }
  const ids = panel.flatMap(line => {
    const m = /^\s*Session:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i.exec(line);
    return m ? [m[1]!.toLowerCase()] : [];
  });
  const limits = panel.some(line => /^\s*Limits:/.test(line));
  if (ids.length === 1 && limits && host) return { sessionId: ids[0], retryable: false };
  // Native panels are painted incrementally. Missing host/session/limits is a
  // pending frame, not proof of an unsupported frontend. Only the last poll
  // closes it as retryable; a complete ambiguous panel is a settled negative.
  if (!host || ids.length === 0 || !limits) return settleIncomplete ? { retryable: true } : undefined;
  return { retryable: false };
}

/** Only a freshly requested native status panel can supply this identity. */
export function traexStatusSessionId(state: Snapshot): string | undefined {
  return traexStatusPanel(state)?.sessionId;
}

export function traexTerminalSessionIsBound(terminal: PtyHandle, sessionId: string): boolean {
  const binding = bindings.get(terminal);
  return !!binding && binding.pid === terminal.cliPid && binding.sessionId === sessionId.toLowerCase();
}

function traexGeneration(terminal: PtyHandle): number {
  const current = generations.get(terminal);
  return current && current.pid === terminal.cliPid ? current.value : 0;
}

/** Public to the adapter so each write captures the identity epoch it belongs
 * to. A receipt from an older epoch may settle that write, never rotate the
 * terminal away from a newer native session. */
export function traexTerminalIdentityGeneration(terminal: PtyHandle): number {
  return traexGeneration(terminal);
}

function advanceTraexGeneration(terminal: PtyHandle, pid: number): void {
  generations.set(terminal, { pid, value: traexGeneration(terminal) + 1 });
}

/** A changed viewport needs a new native query to follow local session changes.
 * This catches local /new and /resume without guessing from cwd or daemon fds. */
export function traexTerminalIdentityNeedsRefresh(terminal: PtyHandle): boolean {
  if (shared.get(terminal) !== terminal.cliPid) return true;
  const current = snapshot(terminal);
  if (pending.has(terminal) || !current) return true;
  const unsupportedPanel = unsupported.get(terminal);
  if (unsupportedPanel && unsupportedPanel.pid === terminal.cliPid && unsupportedPanel.viewport === current.viewport) return false;
  const binding = bindings.get(terminal);
  return !binding?.viewport || binding.pid !== terminal.cliPid || binding.viewport !== current.viewport;
}

/** An uncertain native command must never be concatenated with a later task.
 * Only a positively empty composer or a new frontend generation releases it. */
export function traexTerminalInputBlocked(terminal: PtyHandle): boolean {
  const pid = incompleteQueries.get(terminal);
  if (pid === undefined || pid !== terminal.cliPid) return false;
  if (traexEmptyComposer(snapshot(terminal))) {
    incompleteQueries.delete(terminal);
    return false;
  }
  return true;
}

export function bindTraexSessionFromCorrelatedInput(
  terminal: PtyHandle,
  pid: number,
  sessionId: string,
  expectedGeneration: number,
): boolean {
  if (terminal.cliPid !== pid || pending.has(terminal)
    || traexGeneration(terminal) !== expectedGeneration) return false;
  const normalized = sessionId.toLowerCase();
  const existing = bindings.get(terminal);
  if (existing?.pid !== pid || existing.sessionId !== normalized) {
    bindings.set(terminal, { pid, sessionId: normalized });
    // This receipt is newer than the captured epoch. Advancing after accepting
    // it prevents another delayed receipt from the same older write from
    // overwriting this identity later.
    advanceTraexGeneration(terminal, pid);
  }
  unsupported.delete(terminal);
  return true;
}

/** Call under the worker's adopted-terminal write queue. No model prompt,
 * config edit, Ctrl+C, or daemon-wide transcript scan is involved. */
export function refreshTraexTerminalSession(
  terminal: PtyHandle,
  isCurrent: () => boolean = () => true,
): Promise<Resolution> {
  const existing = pending.get(terminal);
  if (existing) return existing;
  const task = refresh(terminal, isCurrent).finally(() => pending.delete(terminal));
  pending.set(terminal, task);
  return task;
}

async function refresh(terminal: PtyHandle, isCurrent: () => boolean): Promise<Resolution> {
  const pid = terminal.cliPid;
  if (!pid || !terminal.captureInputState) return { kind: 'legacy' };
  const owned = findTraexRolloutSetByPid(pid);
  if (owned === undefined || owned.size > 0) return { kind: 'legacy' };
  shared.set(terminal, pid);
  const state = snapshot(terminal);
  const binding = bindings.get(terminal);
  if (binding?.pid === pid && binding.viewport === state?.viewport) return { kind: 'terminal', sessionId: binding.sessionId };
  const unsupportedPanel = unsupported.get(terminal);
  if (unsupportedPanel?.pid === pid && unsupportedPanel.viewport === state?.viewport) {
    return { kind: 'unavailable' };
  }
  if (binding?.pid === pid && changedAt.get(terminal)?.pid !== pid) changedAt.set(terminal, { pid, timestampMs: Date.now() });
  if (!isCurrent() || !traexEmptyComposer(state)) return { kind: 'unavailable' };
  // Invalidate receipts from the previous viewport before deleting its binding.
  // A failed query must not reopen a window for the retired identity either.
  advanceTraexGeneration(terminal, pid);
  incompleteQueries.delete(terminal);
  bindings.delete(terminal);
  unsupported.delete(terminal);
  const current = () => terminal.cliPid === pid && isCurrent();
  const key = (name: 'Enter' | 'Escape') => terminal.sendSpecialKeys
    ? terminal.sendSpecialKeys(name) !== false
    : terminal.write(name === 'Enter' ? '\r' : '\x1b') !== false;
  try {
    // Recheck immediately before the first write. Never erase a person's draft.
    if (!current() || snapshot(terminal)?.viewport !== state?.viewport) return { kind: 'unavailable' };
    incompleteQueries.set(terminal, pid);
    if ((terminal.sendText ? terminal.sendText('/status') : terminal.write('/status')) === false) return { kind: 'unavailable' };
    await delay(250);
    for (let attempt = 0; attempt < 3 && current(); attempt++) {
      const beforeEnter = snapshot(terminal);
      if (!beforeEnter) return { kind: 'unavailable' };
      const rows = stripAnsiScreenText(beforeEnter.viewport).split(/\r?\n/);
      // TRAE may initially turn Enter into a soft newline while its key batch
      // settles. Retry only while the composer still contains exactly our query.
      const prompt = lastMatchingRow(rows, /^\s*[›❯] \/status\s*$/);
      const footerStart = lastMatchingRow(rows, /^[▀▄█─]+\s*$/);
      if (prompt < 0 || beforeEnter.cursor.y < prompt || beforeEnter.cursor.y > prompt + 2
        || footerStart <= prompt || rows.slice(prompt + 1, footerStart).some(line => line.trim())
        || !rows.slice(footerStart + 1).some(line => /\bContext (?:\d+% (?:left|used)|[—–-])\b/.test(line))) return { kind: 'unavailable' };
      if (!key('Enter')) return { kind: 'unavailable' };
      for (let poll = 0; poll < 20 && current(); poll++) {
        await delay(50);
        const panel = snapshot(terminal);
        const parsed = traexStatusPanel(panel, poll === 19);
        if (!parsed) continue;
        // Escape only the status panel we just read, never a changed screen.
        if (!current() || snapshot(terminal)?.viewport !== panel?.viewport || !key('Escape')) return { kind: 'unavailable' };
        for (let closePoll = 0; closePoll < 20 && current(); closePoll++) {
          await delay(50);
          if (!current()) return { kind: 'unavailable' };
          const restored = snapshot(terminal);
          if (!traexEmptyComposer(restored)) continue;
          if (!current()) return { kind: 'unavailable' };
          incompleteQueries.delete(terminal);
          if (!parsed.sessionId) {
            if (!parsed.retryable) {
              // Remember only a settled ineligible native surface at its
              // restored viewport. Incomplete local-host panels remain
              // retryable and must not suppress the next identity poll.
              unsupported.set(terminal, { pid, viewport: restored!.viewport });
            }
            return { kind: 'unavailable', inputReleased: true };
          }
          unsupported.delete(terminal);
          bindings.set(terminal, { pid, sessionId: parsed.sessionId, viewport: restored!.viewport });
          const change = changedAt.get(terminal);
          changedAt.delete(terminal);
          return {
            kind: 'terminal',
            sessionId: parsed.sessionId,
            inputReleased: true,
            ...(change?.pid === pid ? { liveSinceMs: change.timestampMs } : {}),
          };
        }
        return { kind: 'unavailable' };
      }
    }
  } catch { /* Unknown delivery is never replayed into a new backend. */ }
  return { kind: 'unavailable' };
}
