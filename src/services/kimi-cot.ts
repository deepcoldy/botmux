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
 *     on the first prompt, so wait for a session created after this spawn
 *     that carries this botmux session's routing marker, and read it from the
 *     start (its first turn is live).
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CotEntry } from '../types.js';
import { findKimiSessionForBotmuxSession, kimiHome } from '../adapters/cli/kimi-session.js';
import { findKimiWireBySessionId, findKimiWireForBotmuxSession, KimiActivityParser } from './kimi-transcript.js';

/** Sessions are created a few ms before their first `turn.prompt`; allow for
 *  clock granularity and a slow first write between spawn and lookup. */
const BORN_AFTER_SLACK_MS = 5_000;
const POLL_INTERVAL_MS = 1_000;
/** One poll never reads more than this; the rest is picked up next tick. */
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** How long an index change keeps the fresh-session probe running. Measured:
 *  the first `turn.prompt` follows session creation by well under 1 s. */
const FIRST_PROMPT_PROBE_MS = 10_000;

export interface KimiActivityObserverOptions {
  /** Botmux session id the adapter resolved `--session` with (resume). */
  botmuxSessionId: string;
  /** Botmux session id in this session's routing envelope (fresh lookup). */
  markerSessionId?: string;
  workingDir?: string;
  env?: NodeJS.ProcessEnv;
  /** The spawn resumed an existing Kimi session. */
  resume: boolean;
  spawnStartMs: number;
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
  private bornAfterMs: number | undefined;
  private lastIndexKey = '';
  /** Keep probing an unchanged index until then: a just-indexed session may
   *  not have written its first prompt yet. */
  private probeUntilMs = 0;
  private stopped = false;

  constructor(private readonly opts: KimiActivityObserverOptions) {}

  get boundWirePath(): string | undefined { return this.wirePath; }

  start(): void {
    const env = this.opts.env ?? process.env;
    if (this.opts.resume) {
      const sid = findKimiSessionForBotmuxSession(this.opts.botmuxSessionId, this.opts.workingDir, env);
      const path = sid ? findKimiWireBySessionId(sid, env) : undefined;
      if (path) this.bind(path, 'end');
    }
    if (!this.wirePath) this.bornAfterMs = this.opts.spawnStartMs - BORN_AFTER_SLACK_MS;
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
    if (!this.wirePath && !this.tryBindFresh()) return [];
    return this.readNew();
  }

  private bind(path: string, from: 'start' | 'end'): void {
    this.wirePath = path;
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

  /** Fresh session: wait for a session born after this spawn carrying our
   *  marker. Re-scan only when the index changed, and briefly afterwards while
   *  a just-indexed session has not written its first prompt yet. */
  private tryBindFresh(): boolean {
    const env = this.opts.env ?? process.env;
    let indexKey = '';
    try {
      const st = statSync(join(kimiHome(env), 'session_index.jsonl'));
      indexKey = `${st.size}:${st.mtimeMs}`;
    } catch { return false; }
    const now = Date.now();
    if (indexKey !== this.lastIndexKey) {
      this.lastIndexKey = indexKey;
      this.probeUntilMs = now + FIRST_PROMPT_PROBE_MS;
    } else if (now > this.probeUntilMs) {
      return false;
    }
    const path = findKimiWireForBotmuxSession(this.opts.markerSessionId ?? this.opts.botmuxSessionId, this.opts.workingDir, {
      env, bornAfterMs: this.bornAfterMs,
    });
    if (!path) return false;
    this.bind(path, 'start');
    return true;
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
