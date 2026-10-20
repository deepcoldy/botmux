import { Buffer } from 'node:buffer';
import { logger } from './logger.js';
import type { ProgramStatusEvent } from './idle-detector.js';

export type { ProgramStatusEvent } from './idle-detector.js';

export type ProgramStatusState = ProgramStatusEvent['state'];

export type ProgramStatusPart =
  | { type: 'data'; text: string }
  | { type: 'probe' }
  | { type: 'status'; event: ProgramStatusEvent };

const VALID_STATES = new Set<ProgramStatusState>([
  'idle',
  'working',
  'done',
  'blocked',
  'error',
  'clear',
]);

const PREFIX_TARGET = '7501;';
const DEFAULT_MAX_BUFFER_SIZE = 4096;

/** Safe base64 decoding for msg; returns undefined on malformed base64 or control chars */
export function decodeProgramStatusMsg(val: string): string | undefined {
  if (!val) return undefined;
  // RFC 4648 base64 or URL-safe base64: [A-Za-z0-9+/=_-]
  if (!/^[A-Za-z0-9+/=_-]+$/.test(val)) return undefined;
  try {
    const text = Buffer.from(val, 'base64').toString('utf8');
    // Reject control characters (U+0000–U+001F, U+007F, U+0080–U+009F)
    if (/[\x00-\x1f\x7f-\x9f]/.test(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

/** Parse colon-separated key=value pairs into a ProgramStatusEvent */
export function parseProgramStatusPayload(payload: string): ProgramStatusEvent | null {
  const pairs = payload.split(':');
  let state: ProgramStatusState | undefined;
  let id: string | undefined;
  let app: string | undefined;
  let kind: string | undefined;
  let msg: string | undefined;
  let progress: number | undefined;

  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim();
    const val = pair.slice(eqIdx + 1).trim();

    switch (key) {
      case 'state':
        if (VALID_STATES.has(val as ProgramStatusState)) {
          state = val as ProgramStatusState;
        }
        break;
      case 'id':
        if (val) id = val;
        break;
      case 'app':
        if (val) app = val;
        break;
      case 'kind':
        if (val) kind = val;
        break;
      case 'msg': {
        const decoded = decodeProgramStatusMsg(val);
        if (decoded !== undefined) msg = decoded;
        break;
      }
      case 'progress': {
        const n = parseInt(val, 10);
        if (Number.isFinite(n) && n >= 0 && n <= 100) {
          progress = n;
        }
        break;
      }
    }
  }

  if (!state) return null;
  const event: ProgramStatusEvent = { state };
  if (id !== undefined) event.id = id;
  if (app !== undefined) event.app = app;
  if (kind !== undefined) event.kind = kind;
  if (msg !== undefined) event.msg = msg;
  if (progress !== undefined) event.progress = progress;
  return event;
}

export class ProgramStatusFramingStream {
  private buffered = '';
  private readonly maxBufferSize: number;

  constructor(options?: { maxBufferSize?: number }) {
    this.maxBufferSize = options?.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  }

  feed(chunk: string): ProgramStatusPart[] {
    const parts: ProgramStatusPart[] = [];
    const str = this.buffered + chunk;
    this.buffered = '';
    let cursor = 0;

    const emitData = (text: string) => {
      if (!text) return;
      const last = parts[parts.length - 1];
      if (last && last.type === 'data') {
        last.text += text;
      } else {
        parts.push({ type: 'data', text });
      }
    };

    while (cursor < str.length) {
      const escIdx = str.indexOf('\x1b', cursor);
      if (escIdx === -1) {
        emitData(str.slice(cursor));
        cursor = str.length;
        break;
      }

      if (escIdx > cursor) {
        emitData(str.slice(cursor, escIdx));
        cursor = escIdx;
      }

      // str[cursor] === '\x1b'
      if (cursor + 1 >= str.length) {
        // Chunk ends right at ESC byte
        this.buffered = '\x1b';
        cursor = str.length;
        break;
      }

      if (str[cursor + 1] !== ']') {
        // Non-OSC escape sequence (e.g. CSI \x1b[)
        emitData(str.slice(cursor, cursor + 2));
        cursor += 2;
        continue;
      }

      // str[cursor...cursor+2] === '\x1b]'
      const rem = str.slice(cursor + 2);
      if (rem.length < PREFIX_TARGET.length && PREFIX_TARGET.startsWith(rem)) {
        // Partial prefix of '7501;' at end of chunk
        this.buffered = str.slice(cursor);
        cursor = str.length;
        break;
      }

      if (rem.startsWith(PREFIX_TARGET)) {
        const contentStart = cursor + 2 + PREFIX_TARGET.length;
        const belIdx = str.indexOf('\x07', contentStart);
        const stIdx = str.indexOf('\x1b\\', contentStart);

        let termIdx = -1;
        let termLen = 0;
        if (belIdx !== -1 && stIdx !== -1) {
          if (belIdx < stIdx) {
            termIdx = belIdx;
            termLen = 1;
          } else {
            termIdx = stIdx;
            termLen = 2;
          }
        } else if (belIdx !== -1) {
          termIdx = belIdx;
          termLen = 1;
        } else if (stIdx !== -1) {
          termIdx = stIdx;
          termLen = 2;
        }

        // Check for an intervening ESC sequence before the terminator.
        // A valid 7501 payload never contains ESC (except as part of ST: ESC \).
        // If an ESC appears before termIdx (or when no terminator was found):
        // 1. If ESC is at the very end of the string, it might be the start of ST; buffer and wait.
        // 2. Otherwise (ESC is followed by something other than \), the 7501 sequence is
        //    unterminated/malformed. Emit the text up to ESC as data and resume parsing from ESC.
        const nextEscIdx = str.indexOf('\x1b', contentStart);
        if (nextEscIdx !== -1 && (termIdx === -1 || nextEscIdx < termIdx)) {
          if (nextEscIdx === str.length - 1) {
            this.buffered = str.slice(cursor);
            cursor = str.length;
            break;
          } else if (str[nextEscIdx + 1] !== '\\') {
            emitData(str.slice(cursor, nextEscIdx));
            cursor = nextEscIdx;
            continue;
          }
        }

        if (termIdx === -1) {
          // Terminator not yet found in current chunk
          if (str.length - cursor > this.maxBufferSize) {
            logger.warn(`[program-status] parser buffer exceeded ${this.maxBufferSize} bytes without terminator; dropping`);
            cursor += 2 + PREFIX_TARGET.length;
            continue;
          } else {
            this.buffered = str.slice(cursor);
            cursor = str.length;
            break;
          }
        }

        const payload = str.slice(contentStart, termIdx);
        if (payload.trim() === '?') {
          parts.push({ type: 'probe' });
        } else {
          const event = parseProgramStatusPayload(payload);
          if (event) {
            parts.push({ type: 'status', event });
          }
        }

        cursor = termIdx + termLen;
        continue;
      }

      // Another OSC code (e.g. \x1b]0;, \x1b]8;, \x1b]52;, \x1b]777;, \x1b]1989;)
      emitData(str.slice(cursor, cursor + 2));
      cursor += 2;
    }

    return parts;
  }

  flush(): ProgramStatusPart[] {
    if (this.buffered.length > 0) {
      const text = this.buffered;
      this.buffered = '';
      return [{ type: 'data', text }];
    }
    return [];
  }

  reset(): void {
    this.buffered = '';
  }
}
