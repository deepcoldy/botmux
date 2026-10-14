/**
 * In-pane answering of the OSC 7501 (Program Status Protocol) probe.
 *
 * WHY THIS EXISTS: Claude Code probes `ESC ] 7501 ; ? BEL` and then sends DA1
 * (`CSI c`) in the same write as a sentinel. If the DA1 answer arrives before
 * the 7501 answer, it records "terminal does not support program status" and
 * never emits `ESC ] 7501 ; state=…`. Under the tmux backend tmux itself
 * answers DA1 synchronously while parsing pane output (measured ~1-2 ms),
 * whereas the worker only sees the probe after it has left tmux through
 * pipe-pane and can only answer via a fresh `tmux send-keys` client — always
 * later. A relay that sits between the CLI and the pane and answers the probe
 * BEFORE forwarding the bytes that follow it (including the DA1 query) makes
 * the ordering structural: tmux cannot answer a DA1 it has not been given yet.
 *
 * Operates on bytes (latin1 strings ↔ Buffers are a bijection), so UTF-8
 * characters split across chunks pass through untouched. Only the exact probe
 * forms are stripped; status reports and every other byte are forwarded as-is,
 * so the worker's existing pipe-pane + ProgramStatusFramingStream path keeps
 * seeing them.
 */

import { writeSync } from 'node:fs';

export const PROGRAM_STATUS_PROBE_REPLY = '\x1b]7501;?\x1b\\';

const PROBES = ['\x1b]7501;?\x07', '\x1b]7501;?\x1b\\'] as const;

/** Length of the longest suffix of `s` that is a proper prefix of some probe. */
function partialProbeSuffixLength(s: string): number {
  const max = Math.min(s.length, Math.max(...PROBES.map(p => p.length)) - 1);
  for (let len = max; len > 0; len--) {
    const tail = s.slice(s.length - len);
    if (PROBES.some(p => p.length > len && p.startsWith(tail))) return len;
  }
  return 0;
}

/** One step of relay output: forward these bytes, or answer the probe now. */
export type ProbeRelayAction = { forward: Buffer } | { answer: true };

/**
 * Stateful scanner over CLI output. `feed()` returns an ordered list of
 * actions: forward these bytes / answer the probe now. Callers must execute
 * them in order — answering before forwarding what follows the probe is the
 * whole point. A trailing partial probe is held back until the next chunk or
 * until `flush()` (callers flush on a short timer so a lone trailing ESC is
 * never delayed indefinitely).
 */
export class ProgramStatusProbeRelay {
  private held = '';

  feed(chunk: Buffer): ProbeRelayAction[] {
    const out: ProbeRelayAction[] = [];
    let s = this.held + chunk.toString('latin1');
    this.held = '';
    for (;;) {
      let at = -1;
      let len = 0;
      for (const probe of PROBES) {
        const i = s.indexOf(probe);
        if (i !== -1 && (at === -1 || i < at)) { at = i; len = probe.length; }
      }
      if (at === -1) break;
      if (at > 0) out.push({ forward: Buffer.from(s.slice(0, at), 'latin1') });
      out.push({ answer: true });
      s = s.slice(at + len);
    }
    const keep = partialProbeSuffixLength(s);
    if (keep > 0) {
      this.held = s.slice(s.length - keep);
      s = s.slice(0, s.length - keep);
    }
    if (s.length > 0) out.push({ forward: Buffer.from(s, 'latin1') });
    return out;
  }

  /** True while a partial probe prefix is being held back. */
  hasPending(): boolean {
    return this.held.length > 0;
  }

  /** Release any held-back bytes unchanged. */
  flush(): Buffer | null {
    if (!this.held) return null;
    const b = Buffer.from(this.held, 'latin1');
    this.held = '';
    return b;
  }
}

/**
 * Put the probe reply into the inner PTY BEFORE the bytes after the probe (the
 * DA1 query) are forwarded. node-pty's `write()` only enqueues — the actual
 * write happens later on the libuv thread pool — so it gives no ordering
 * guarantee against a DA1 answer tmux produces as soon as we forward the query.
 * Write the master fd synchronously instead; the reply is a few bytes, so it
 * lands whole. Fall back to the queued write only if the fd is unavailable.
 */
export function writeProbeReplySync(term: { fd?: number; write(data: string): void }): void {
  const fd = term.fd;
  if (typeof fd === 'number') {
    const reply = Buffer.from(PROGRAM_STATUS_PROBE_REPLY, 'latin1');
    let written = 0;
    for (let attempt = 0; attempt < 100 && written < reply.length; attempt++) {
      try {
        written += writeSync(fd, reply, written);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK' && code !== 'EINTR') break;
      }
    }
    if (written === reply.length) return;
    if (written > 0) {
      term.write(reply.subarray(written).toString('latin1'));
      return;
    }
  }
  term.write(PROGRAM_STATUS_PROBE_REPLY);
}
