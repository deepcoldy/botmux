/**
 * Session-long, read-only observer of a Kimi Code session's main wire log
 * that turns its thinking / narration / tool records into activity entries
 * (`CotEntry`) for the current botmux turn — the Kimi counterpart of the
 * Cursor / Antigravity CoT readers.
 *
 * It never drives a turn: no attribution queue, no terminal, no final reply.
 * If the log cannot be found or parsed, the card simply shows no activity and
 * every other Kimi behavior (OSC status, `botmux send`) is unchanged.
 *
 * Which log to follow:
 *   - resume: the session Kimi was resumed into — the same lookup the adapter
 *     used for `--session` (findKimiSessionForBotmuxSession); followed from its
 *     current end so history is never replayed;
 *   - fresh (or a resume that found nothing): Kimi creates the session lazily
 *     on the first prompt, so wait for a session that did not exist when this
 *     spawn started and carries this botmux session's routing marker, and read
 *     it from the start (its first turn is live);
 *   - a new generation inside the same process (`/new` / `/clear` passed
 *     through from Feishu): the same rule keeps applying while bound, so the
 *     observer moves to the newer session after finishing the old log.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { CotEntry } from '../types.js';
import { findKimiSessionForBotmuxSession, sameKimiWorkDir } from '../adapters/cli/kimi-session.js';
import {
  findKimiWireBySessionId,
  kimiSessionIndexStamp,
  kimiSessionPromptOwner,
  KimiActivityParser,
  listKimiSessions,
  type KimiIndexedSession,
} from './kimi-transcript.js';

const POLL_INTERVAL_MS = 1_000;
/** One poll never reads more than this; the rest is picked up next tick. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

export interface KimiActivityObserverOptions {
  /** Botmux session id the adapter resolved `--session` with (resume). */
  botmuxSessionId: string;
  /** Botmux session id in this session's routing envelope (fresh lookup). */
  markerSessionId?: string;
  workingDir?: string;
  env?: NodeJS.ProcessEnv;
  /** The spawn resumed an existing Kimi session. */
  resume: boolean;
  /** Entries read by the background poll. Synchronous drains return theirs. */
  onEntries: (entries: CotEntry[]) => void;
  pollIntervalMs?: number;
  log?: (message: string) => void;
}

export class KimiActivityObserver {
  private wirePath: string | undefined;
  private offset = 0;
  /** The read position sits inside a record (bound mid-write / oversized
   *  record skipped): the first line of the next read is its remainder. */
  private skipFirstLine = false;
  private readonly parser = new KimiActivityParser();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Wire logs never (re)considered: every session indexed before this spawn
   *  started, plus every one seen since (bound, candidate, or not ours). */
  private known = new Set<string>();
  /** Sessions indexed after the spawn in this working dir whose first prompt
   *  has not shown whose conversation they are yet, oldest first. Kimi
   *  indexes a `/new` session at once but its first prompt may come minutes
   *  later, so these are re-checked (state.json only) on every poll. */
  private candidates: KimiIndexedSession[] = [];
  private lastIndexKey = '';
  private stopped = false;

  constructor(private readonly opts: KimiActivityObserverOptions) {}

  get boundWirePath(): string | undefined { return this.wirePath; }

  start(): void {
    const env = this.opts.env ?? process.env;
    // Snapshot before anything can bind: a dead previous generation of this
    // botmux session (even one created moments before the spawn) is history.
    // Kimi only creates a session once the first prompt is submitted, which
    // is after this point.
    this.lastIndexKey = kimiSessionIndexStamp(env);
    this.known = new Set(listKimiSessions(env).map(session => session.wirePath));
    if (this.opts.resume) {
      const sid = findKimiSessionForBotmuxSession(this.opts.botmuxSessionId, this.opts.workingDir, env);
      const path = sid ? findKimiWireBySessionId(sid, env) : undefined;
      if (path) this.bind(path, 'end');
    }
    const interval = this.opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.timer = setInterval(() => {
      try {
        const entries = this.drain();
        if (entries.length) this.opts.onEntries(entries);
      } catch (err: any) {
        this.opts.log?.(`Kimi activity poll failed: ${err?.message ?? err}`);
      }
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Read everything appended since the last read and return its entries. */
  drain(): CotEntry[] {
    if (this.stopped) return [];
    const entries: CotEntry[] = [];
    const next = this.findNewSession();
    if (next) {
      // Finish the previous generation's log first: its tail is still the
      // turn that ran there.
      if (this.wirePath) entries.push(...this.readNew());
      this.bind(next, 'start');
    }
    if (this.wirePath) entries.push(...this.readNew());
    return entries;
  }

  private bind(path: string, from: 'start' | 'end'): void {
    this.wirePath = path;
    this.known.add(path);
    this.skipFirstLine = false;
    this.offset = 0;
    if (from === 'end') {
      try { this.offset = statSync(path).size; } catch { this.offset = 0; }
      // Never start mid-line: skip to the end of a partially written record.
      this.skipPartialLineAtOffset();
    }
    this.opts.log?.(`Kimi activity observer bound to ${path} (${from === 'end' ? 'from end' : 'from start'})`);
  }

  private skipPartialLineAtOffset(): void {
    if (!this.wirePath || this.offset === 0) return;
    let fd: number | undefined;
    try {
      fd = openSync(this.wirePath, 'r');
      const probe = Buffer.alloc(1);
      readSync(fd, probe, 0, 1, this.offset - 1);
      if (probe[0] !== 0x0a) this.skipFirstLine = true;
    } catch { /* treat as line-aligned */ } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
    }
  }

  /** A session created after this spawn whose latest prompt carries our
   *  marker: the first session of a fresh spawn, or a `/new` generation while
   *  bound. The index is re-read only when it changed; pending candidates
   *  cost one small state.json read each per poll. */
  private findNewSession(): string | undefined {
    const env = this.opts.env ?? process.env;
    const indexKey = kimiSessionIndexStamp(env);
    if (indexKey && indexKey !== this.lastIndexKey) {
      this.lastIndexKey = indexKey;
      for (const session of listKimiSessions(env)) {
        if (this.known.has(session.wirePath)) continue;
        this.known.add(session.wirePath);
        const wd = this.opts.workingDir;
        if (wd && session.workDir && !sameKimiWorkDir(session.workDir, wd)) continue;
        this.candidates.push(session);
      }
    }
    const marker = this.opts.markerSessionId ?? this.opts.botmuxSessionId;
    // Newest first; never move back to an older generation than the one taken.
    for (let i = this.candidates.length - 1; i >= 0; i--) {
      const owner = kimiSessionPromptOwner(this.candidates[i].sessionDir, marker);
      if (owner === 'match') {
        const chosen = this.candidates[i];
        this.candidates = this.candidates.slice(i + 1);
        return chosen.wirePath;
      }
      if (owner === 'foreign') this.candidates.splice(i, 1);
    }
    return undefined;
  }

  private readNew(): CotEntry[] {
    const path = this.wirePath!;
    let size: number;
    try { size = statSync(path).size; } catch { return []; }
    if (size < this.offset) {
      // Truncated / replaced: never re-read history; follow from its new end.
      this.offset = size;
      this.skipFirstLine = false;
      return [];
    }
    if (size === this.offset) return [];
    const len = Math.min(size - this.offset, MAX_READ_BYTES);
    const buf = Buffer.alloc(len);
    let fd: number | undefined;
    let read = 0;
    try {
      fd = openSync(path, 'r');
      read = readSync(fd, buf, 0, len, this.offset);
    } catch { return []; } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
    }
    const chunk = buf.subarray(0, read);
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl < 0) {
      // No complete line yet. A single record larger than one read window is
      // skipped rather than stalling the observer forever.
      if (read === MAX_READ_BYTES) { this.offset += read; this.skipFirstLine = true; }
      return [];
    }
    const complete = chunk.subarray(0, lastNl + 1).toString('utf8');
    this.offset += lastNl + 1;
    const entries: CotEntry[] = [];
    const lines = complete.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i === 0 && this.skipFirstLine) {
        // Remainder of a record we started mid-way: drop it.
        this.skipFirstLine = false;
        continue;
      }
      const line = lines[i].trim();
      if (!line) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { continue; }
      entries.push(...this.parser.push(record));
    }
    return entries;
  }
}
