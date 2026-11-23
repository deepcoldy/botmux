import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from '../adapters/cli/tui-input.js';

export interface WebTerminalInputClassification {
  /** Bytes ready to forward, unchanged. A trailing undecided prefix is withheld. */
  data: string;
  hasUser: boolean;
  /** CR/LF outside bracketed paste; never inferred from reply contents. */
  maySubmit: boolean;
  /** The batch contains or continues bracketed-paste state. */
  pasteRelated: boolean;
  pending: boolean;
  deadline?: number;
  reason: 'protocol' | 'user' | 'timeout' | 'limit';
}

type Candidate = 'prefix' | 'protocol' | 'paste-start' | 'paste-end' | 'invalid';
const focuses = ['\x1b[I', '\x1b[O', '\x9bI', '\x9bO'];
const pasteStarts = [BRACKETED_PASTE_START, '\x9b200~'];
const pasteEnds = [BRACKETED_PASTE_END, '\x9b201~'];
const colors = ['\x1b]', '\x9d'].flatMap(start => [10, 11, 12].map(code => `${start}${code};rgb:`));

/** Only these response grammars are neutral. In particular, CPR and modified
 * F3 can have the same CSI shape; neither generic CSI nor generic OSC is safe. */
function candidateKind(value: string): Candidate {
  if (focuses.includes(value)) return 'protocol';
  if (pasteStarts.includes(value)) return 'paste-start';
  if (pasteEnds.includes(value)) return 'paste-end';
  if ([...focuses, ...pasteStarts, ...pasteEnds, ...colors].some(token => token.startsWith(value))) return 'prefix';
  const color = colors.find(prefix => value.startsWith(prefix));
  if (!color) return 'invalid';
  const tail = value.slice(color.length);
  let component = 0, digits = 0;
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i]!;
    if (/^[a-f0-9]$/i.test(ch)) {
      if (++digits > 4) return 'invalid';
      continue;
    }
    if (ch === '/' && component < 2 && digits > 0) {
      component++; digits = 0;
      continue;
    }
    if (component !== 2 || digits === 0) return 'invalid';
    if ((ch === '\x07' || ch === '\x9c') && i === tail.length - 1) return 'protocol';
    if (ch === '\x1b') {
      if (i === tail.length - 1) return 'prefix';
      return tail[i + 1] === '\\' && i + 2 === tail.length ? 'protocol' : 'invalid';
    }
    return 'invalid';
  }
  return 'prefix';
}

/**
 * One classifier per writable connection/physical target. State is bounded to
 * a grammar prefix; paste payload streams rather than being retained.
 * forceUser can only upgrade neutral bytes. It never disables paste tracking.
 */
export class WebTerminalInputClassifier {
  private candidate = '';
  private forwarded = 0;
  private userCandidate = false;
  private startedAt = 0;
  private paste = false;
  private readonly carryMs: number;
  private readonly maxCarry: number;
  private readonly keepPastePrefixes: boolean;

  constructor(options: { carryMs?: number; maxCarry?: number; keepPastePrefixes?: boolean } = {}) {
    this.carryMs = options.carryMs ?? 75;
    this.maxCarry = options.maxCarry ?? 256;
    this.keepPastePrefixes = options.keepPastePrefixes === true;
    if (!Number.isFinite(this.carryMs) || this.carryMs <= 0 || this.carryMs > 1000
      || !Number.isSafeInteger(this.maxCarry) || this.maxCarry < 1 || this.maxCarry > 4096) {
      throw new RangeError('invalid web input carry limits');
    }
  }

  get pending(): boolean { return this.candidate.length > 0 || this.paste; }
  get inPaste(): boolean { return this.paste; }
  get pastePrefixPending(): boolean {
    return /^(?:\x1b\[|\x9b)2/.test(this.candidate)
      && [...pasteStarts, ...pasteEnds].some(token => token.startsWith(this.candidate));
  }
  get deadline(): number | undefined {
    return this.candidate && !(this.keepPastePrefixes && this.pastePrefixPending)
      ? this.startedAt + this.carryMs : undefined;
  }
  get bufferedBytes(): number { return Buffer.byteLength(this.candidate.slice(this.forwarded), 'utf8'); }

  push(data: string, options: { forceUser?: unknown } = {}, now = Date.now()): WebTerminalInputClassification {
    const out = this.empty();
    if (this.deadline !== undefined && now >= this.deadline) this.release(out, 'timeout');
    const force = options.forceUser === true;
    for (const ch of data) {
      if (this.paste) out.pasteRelated = true;
      // A new introducer retires the previous incomplete sequence. The ESC
      // of an OSC string terminator is the exception: it still belongs to
      // the current color response and must survive split ST packets.
      if (this.candidate && (ch === '\x1b' || ch === '\x9b' || ch === '\x9d')
        && candidateKind(this.candidate + ch) === 'invalid') this.release(out, 'user');
      if (!this.candidate && (ch === '\x1b' || ch === '\x9b' || ch === '\x9d')) {
        this.startedAt = now;
        this.userCandidate = force || this.paste;
      } else if (!this.candidate) {
        this.user(out, ch);
        continue;
      }
      this.candidate += ch;
      this.userCandidate ||= force || this.paste;
      if (this.userCandidate) this.forwardUserCandidate(out);
      if (Buffer.byteLength(this.candidate, 'utf8') > this.maxCarry) {
        this.release(out, 'limit');
        continue;
      }
      const kind = candidateKind(this.candidate);
      if (kind === 'prefix') continue;
      if (kind === 'invalid') { this.release(out, 'user'); continue; }
      if (kind === 'paste-start' || kind === 'paste-end') out.pasteRelated = true;
      if (kind === 'protocol' && !this.userCandidate && !this.paste) {
        out.data += this.candidate;
      } else {
        this.forwardUserCandidate(out);
      }
      if (kind === 'paste-start') this.paste = true;
      if (kind === 'paste-end') this.paste = false;
      this.clearCandidate();
    }
    return this.finish(out);
  }

  expire(now = Date.now()): WebTerminalInputClassification {
    const out = this.empty();
    if (this.deadline !== undefined && now >= this.deadline) this.release(out, 'timeout');
    return this.finish(out);
  }

  /** Retirement/authorization loss discards state, never emits it to a successor. */
  reset(): void { this.clearCandidate(); this.paste = false; }

  /** Rebuild accepted-but-unwritten state from the actual physical writer. */
  copyFrom(other: WebTerminalInputClassifier): void {
    this.candidate = other.candidate;
    this.forwarded = other.forwarded;
    this.userCandidate = other.userCandidate;
    this.startedAt = other.startedAt;
    this.paste = other.paste;
  }

  private empty(): WebTerminalInputClassification {
    return { data: '', hasUser: false, maySubmit: false, pasteRelated: false, pending: false, reason: 'protocol' };
  }
  private finish(out: WebTerminalInputClassification): WebTerminalInputClassification {
    out.pending = this.pending;
    out.deadline = this.deadline;
    return out;
  }
  private user(out: WebTerminalInputClassification, data: string): void {
    if (!data) return;
    out.data += data; out.hasUser = true;
    if (out.reason === 'protocol') out.reason = 'user';
    if (!this.paste && /[\r\n]/.test(data)) out.maySubmit = true;
  }
  private forwardUserCandidate(out: WebTerminalInputClassification): void {
    this.user(out, this.candidate.slice(this.forwarded));
    this.forwarded = this.candidate.length;
  }
  private release(out: WebTerminalInputClassification, reason: 'timeout' | 'limit' | 'user'): void {
    this.forwardUserCandidate(out);
    if (reason !== 'user') out.reason = reason;
    this.clearCandidate();
  }
  private clearCandidate(): void {
    this.candidate = ''; this.forwarded = 0; this.userCandidate = false;
  }
}
