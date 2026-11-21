import { scanJsonlBackward } from './jsonl-cursor.js';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export interface CodexModelSettingsCursor { device: number; inode: number; offset: number }

/** Unlike the historical-tail baseline, a preference cursor must never skip a
 * long unfinished line. Search backwards within the same bounded read budget. */
export function readCodexModelSettingsCursor(path: string): { cursor: CodexModelSettingsCursor; complete: boolean } | undefined {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    const floor = Math.max(0, stat.size - 4 * 1024 * 1024);
    let end = stat.size;
    const buffer = Buffer.alloc(64 * 1024);
    while (end > floor) {
      const start = Math.max(floor, end - buffer.length);
      const count = readSync(fd, buffer, 0, end - start, start);
      const newline = buffer.subarray(0, count).lastIndexOf(0x0a);
      if (newline >= 0) {
        const offset = start + newline + 1;
        return { cursor: { device: stat.dev, inode: stat.ino, offset }, complete: offset === stat.size };
      }
      end = start;
    }
    return floor === 0
      ? { cursor: { device: stat.dev, inode: stat.ino, offset: 0 }, complete: stat.size === 0 }
      : undefined;
  } finally { closeSync(fd); }
}

/** The launch baseline is separate from Session.model: even a one-shot model
 * must be recognised as a launch default rather than a native user choice. */
export interface CodexModelSelection {
  nativeSessionId?: string;
  launchModel?: string;
  launchStartedAtMs: number;
  override?: string;
  observedModel?: string;
  awaitingLaunchModel?: boolean;
  settingsCursor?: CodexModelSettingsCursor;
}

export interface CodexModelSelectionSession {
  cliId?: string;
  cliSessionId?: string;
  model?: string;
  backendType?: string;
  adoptedFrom?: unknown;
  existingAppServerEndpoint?: string;
  dispatchLaunchSpec?: unknown;
  codexModelSelection?: CodexModelSelection;
}

export function supportsCodexModelSelection(session: CodexModelSelectionSession): boolean {
  return session.cliId === 'codex' && !session.adoptedFrom
    && !session.existingAppServerEndpoint && !session.dispatchLaunchSpec
    && (!session.backendType || ['pty', 'tmux'].includes(session.backendType));
}

/** Read confirmed native SETTINGS, never turn_context (which can describe an
 * automatic fallback). Ignore partial records, old generations and model names
 * embedded in messages. The bounded scan also works before a failed turn has
 * managed to write a turn_context. */
export function refreshCodexModelSelection(
  session: CodexModelSelectionSession,
  path: string,
  inheritedModel: string | undefined,
  verifiedNativeSessionId?: string,
): void {
  if (!supportsCodexModelSelection(session) || !session.cliSessionId) return;
  let previous = session.codexModelSelection;
  const rotated = !!previous?.nativeSessionId && previous.nativeSessionId !== session.cliSessionId;
  if (rotated) {
    delete session.codexModelSelection;
    previous = undefined;
    // Only the exact-session transcript resolver may supply a fresh source;
    // never replay an old file merely because the in-memory ID changed.
    if (verifiedNativeSessionId !== session.cliSessionId) return;
  }
  const startedAtMs = previous?.launchStartedAtMs ?? 0;
  const observations: string[] = [];
  const frontier = readCodexModelSettingsCursor(path);
  if (!frontier) return;
  const source = frontier.cursor;
  const endOffset = source.offset;
  const cursor = previous?.settingsCursor;
  const sameFile = cursor?.device === source.device && cursor.inode === source.inode && cursor.offset <= endOffset;
  const scanFloor = Math.max(sameFile ? cursor.offset : 0, endOffset - 4 * 1024 * 1024);
  scanJsonlBackward(path, {
    endOffset,
    floor: scanFloor,
    dropPartialAtFloor: !sameFile || scanFloor !== cursor.offset,
    onLine: bytes => {
      const line = bytes.toString('utf8');
      if (!line.includes('thread_settings_applied')) return false;
      let item: any;
      try { item = JSON.parse(line); } catch { return false; }
      if (item?.type !== 'event_msg' || item.payload?.type !== 'thread_settings_applied') return false;
      const timestamp = Date.parse(item.timestamp);
      if (!Number.isFinite(timestamp)) return false;
      if (!sameFile && timestamp < startedAtMs) return true;
      const model = item.payload.thread_settings?.model;
      if (typeof model === 'string' && model.trim()) observations.push(model.trim());
      return false;
    },
  });
  let model = rotated ? undefined : previous?.observedModel ?? previous?.launchModel ?? session.model;
  let override = previous?.override;
  let awaitingLaunchModel = previous?.awaitingLaunchModel ?? false;
  // Legacy rows have no process-time boundary: only the newest snapshot can
  // be compared with their last launch. Replaying old transitions would turn
  // an ordinary inherited model into a permanent preference.
  const changes = previous || rotated ? observations.reverse() : observations.slice(0, 1);
  for (const observed of changes) {
    // A requested launch is not proof that the old process was replaced. A
    // failed IPC must not turn its unchanged settings into a manual override.
    if (awaitingLaunchModel && observed === previous?.launchModel) {
      awaitingLaunchModel = false;
      model = observed;
      continue;
    }
    // A CLI-owned default is a baseline, not evidence of a user override.
    if (model !== undefined && observed !== model) {
      override = observed === inheritedModel ? undefined : observed;
      awaitingLaunchModel = false;
    }
    model = observed;
  }
  if (!previous && observations.length === 0) return;
  session.codexModelSelection = {
    ...previous,
    nativeSessionId: session.cliSessionId,
    launchStartedAtMs: startedAtMs,
    observedModel: model,
    awaitingLaunchModel,
    settingsCursor: source,
    ...(override ? { override } : {}),
  };
  if (!override) delete session.codexModelSelection.override;
}

/** Persisted atomically with the normal launch record before spawning. The
 * next resume re-reads native settings, so a lost worker notification or daemon
 * crash between a native /model and its next turn cannot lose the selection. */
export function recordCodexModelLaunch(
  session: CodexModelSelectionSession,
  model: string | undefined,
  now = Date.now(),
): boolean {
  if (!supportsCodexModelSelection(session)) return false;
  const previous = session.codexModelSelection;
  const sameConversation = !previous?.nativeSessionId || previous.nativeSessionId === session.cliSessionId;
  session.codexModelSelection = {
    nativeSessionId: session.cliSessionId,
    launchModel: model,
    launchStartedAtMs: now,
    observedModel: sameConversation ? previous?.observedModel ?? previous?.launchModel ?? model : model,
    awaitingLaunchModel: true,
    ...(sameConversation && previous?.settingsCursor ? { settingsCursor: previous.settingsCursor } : {}),
    ...(sameConversation && previous?.override ? { override: previous.override } : {}),
  };
  return true;
}

/** Reset the preference without letting an older native /model resurrect it.
 * The running CLI remains untouched; the next restart follows current defaults. */
export function resetCodexModelSelection(session: CodexModelSelectionSession, now = Date.now()): void {
  session.codexModelSelection = {
    ...session.codexModelSelection,
    nativeSessionId: session.cliSessionId,
    launchModel: session.codexModelSelection?.launchModel ?? session.model,
    launchStartedAtMs: now,
  };
  delete session.codexModelSelection.override;
}

export interface CodexModelLaunchObservation {
  model: string | null;
  startedAtMs: number;
  nativeSessionId?: string;
  settingsCursor?: CodexModelSettingsCursor;
}

/** Only a real fresh spawn may establish the new baseline. Merely sending a
 * restart request (or reattaching an old pane) cannot prove the launch model. */
export function confirmCodexModelLaunch(session: CodexModelSelectionSession, launch: CodexModelLaunchObservation): boolean {
  const state = session.codexModelSelection;
  if (!supportsCodexModelSelection(session) || !state?.awaitingLaunchModel
    || state.launchModel !== (launch.model ?? undefined)
    || !Number.isFinite(launch.startedAtMs) || launch.startedAtMs < state.launchStartedAtMs
    || (launch.nativeSessionId && launch.nativeSessionId !== session.cliSessionId)) return false;
  state.observedModel = launch.model ?? undefined;
  state.awaitingLaunchModel = false;
  state.launchStartedAtMs = launch.startedAtMs;
  state.settingsCursor = launch.settingsCursor;
  return true;
}

function launchReceiptPath(dataDir: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid model receipt session id');
  return join(dataDir, 'codex-model-launches', `${sessionId}.json`);
}

/** The physical spawn fact must survive a busy SQLite writer or daemon crash.
 * A single private receipt per session is replaced only by another real spawn. */
export function readCodexModelLaunchReceipt(dataDir: string, sessionId: string): CodexModelLaunchObservation | undefined {
  try {
    const path = launchReceiptPath(dataDir, sessionId);
    if (statSync(path).size > 16 * 1024) return undefined;
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (receipt.model !== null && typeof receipt.model !== 'string') return undefined;
    if (!Number.isFinite(receipt.startedAtMs)) return undefined;
    return receipt;
  } catch { return undefined; }
}

/** Remove a session's launch receipt when the session is closed, so
 *  codex-model-launches/ cannot grow one small file per session forever. */
export function removeCodexModelLaunchReceipt(dataDir: string, sessionId: string): void {
  try {
    unlinkSync(launchReceiptPath(dataDir, sessionId));
  } catch { /* already absent */ }
}

/** The real backend spawn and its publication share this executable seam.
 * Reattachment is tested AFTER spawn: a backend can discover a late live pane. */
export function spawnWithCodexModelLaunch(options: {
  dataDir: string; sessionId: string;
  launch?: CodexModelLaunchObservation;
  spawn: () => void; reattached: () => boolean;
  publish: (message: CodexModelLaunchObservation & { type: 'codex_model_launch' }) => void;
}): void {
  options.spawn();
  if (!options.launch || options.reattached()) return;
  const path = launchReceiptPath(options.dataDir, options.sessionId);
  mkdirSync(join(options.dataDir, 'codex-model-launches'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(options.launch), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
  options.publish({ type: 'codex_model_launch', ...options.launch });
}
