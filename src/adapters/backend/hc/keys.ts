/**
 * tmux `send-keys` key names to the bytes the program reads. Names parse the
 * way tmux parses them (case-insensitive table, C-/M-/S- prefixes, `^x`,
 * anything else typed literally); bytes are what hc's own `keys` command
 * produces for the same key in the legacy xterm protocol.
 */

export interface KeyEncodingModes {
  /** DECCKM: unmodified arrows, Home and End are sent as SS3. */
  applicationCursorKeys: boolean;
  /** DECKPAM: keypad keys are sent as SS3. */
  applicationKeypad?: boolean;
}

type NamedKey =
  | { kind: 'cursor'; final: string }
  | { kind: 'function'; final: string }
  | { kind: 'tilde'; code: number }
  | { kind: 'control'; byte: string; code: number }
  | { kind: 'backspace' }
  | { kind: 'keypad'; char: string; app: string }
  | { kind: 'char'; char: string };

const ENTER: NamedKey = { kind: 'control', byte: '\r', code: 13 };
const TAB: NamedKey = { kind: 'control', byte: '\t', code: 9 };

const NAMED_KEYS: ReadonlyMap<string, NamedKey> = new Map<string, NamedKey>([
  ['up', { kind: 'cursor', final: 'A' }],
  ['down', { kind: 'cursor', final: 'B' }],
  ['right', { kind: 'cursor', final: 'C' }],
  ['left', { kind: 'cursor', final: 'D' }],
  ['home', { kind: 'cursor', final: 'H' }],
  ['end', { kind: 'cursor', final: 'F' }],
  ['f1', { kind: 'function', final: 'P' }],
  ['f2', { kind: 'function', final: 'Q' }],
  ['f3', { kind: 'function', final: 'R' }],
  ['f4', { kind: 'function', final: 'S' }],
  ['f5', { kind: 'tilde', code: 15 }],
  ['f6', { kind: 'tilde', code: 17 }],
  ['f7', { kind: 'tilde', code: 18 }],
  ['f8', { kind: 'tilde', code: 19 }],
  ['f9', { kind: 'tilde', code: 20 }],
  ['f10', { kind: 'tilde', code: 21 }],
  ['f11', { kind: 'tilde', code: 23 }],
  ['f12', { kind: 'tilde', code: 24 }],
  ['ic', { kind: 'tilde', code: 2 }],
  ['insert', { kind: 'tilde', code: 2 }],
  ['dc', { kind: 'tilde', code: 3 }],
  ['delete', { kind: 'tilde', code: 3 }],
  ['ppage', { kind: 'tilde', code: 5 }],
  ['pageup', { kind: 'tilde', code: 5 }],
  ['pgup', { kind: 'tilde', code: 5 }],
  ['npage', { kind: 'tilde', code: 6 }],
  ['pagedown', { kind: 'tilde', code: 6 }],
  ['pgdn', { kind: 'tilde', code: 6 }],
  ['enter', ENTER],
  ['tab', TAB],
  ['btab', TAB],
  ['escape', { kind: 'control', byte: '\x1b', code: 27 }],
  ['bspace', { kind: 'backspace' }],
  ['space', { kind: 'char', char: ' ' }],
  ['kp/', { kind: 'keypad', char: '/', app: 'o' }],
  ['kp*', { kind: 'keypad', char: '*', app: 'j' }],
  ['kp-', { kind: 'keypad', char: '-', app: 'm' }],
  ['kp+', { kind: 'keypad', char: '+', app: 'k' }],
  ['kp.', { kind: 'keypad', char: '.', app: 'n' }],
  ['kpenter', { kind: 'keypad', char: '\r', app: 'M' }],
  ['kp0', { kind: 'keypad', char: '0', app: 'p' }],
  ['kp1', { kind: 'keypad', char: '1', app: 'q' }],
  ['kp2', { kind: 'keypad', char: '2', app: 'r' }],
  ['kp3', { kind: 'keypad', char: '3', app: 's' }],
  ['kp4', { kind: 'keypad', char: '4', app: 't' }],
  ['kp5', { kind: 'keypad', char: '5', app: 'u' }],
  ['kp6', { kind: 'keypad', char: '6', app: 'v' }],
  ['kp7', { kind: 'keypad', char: '7', app: 'w' }],
  ['kp8', { kind: 'keypad', char: '8', app: 'x' }],
  ['kp9', { kind: 'keypad', char: '9', app: 'y' }],
]);

interface ParsedKey {
  key: NamedKey;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** Bytes for one `send-keys` argument. */
export function encodeTmuxKey(name: string, modes: KeyEncodingModes): string {
  const parsed = parseTmuxKey(name);
  return parsed ? encodeKey(parsed, modes) : name;
}

/** Bytes for a `send-keys` argument list, in order. */
export function encodeTmuxKeys(names: readonly string[], modes: KeyEncodingModes): string {
  let out = '';
  for (const name of names) out += encodeTmuxKey(name, modes);
  return out;
}

/** tmux `paste-buffer -p`: LF becomes CR, markers only while the program has DEC 2004 on. */
export function pasteBufferBytes(text: string, bracketedPaste: boolean): string {
  if (text.length === 0) return '';
  const body = text.replace(/\n/g, '\r');
  return bracketedPaste ? `\x1b[200~${body}\x1b[201~` : body;
}

/** A bracketed paste whatever the program's modes, text verbatim. */
export function bracketedPasteFrame(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

/** TmuxPipeBackend.submitBracketedPaste: markers around the raw text, then Enter. */
export function submitBracketedPasteBytes(text: string): string {
  return `${bracketedPasteFrame(text)}\r`;
}

function parseTmuxKey(name: string): ParsedKey | null {
  let rest = name;
  let ctrl = false;
  let alt = false;
  let shift = false;
  if (rest.length > 1 && rest[0] === '^') {
    if (rest.length === 2) return { key: { kind: 'char', char: rest[1]!.toLowerCase() }, ctrl: true, alt, shift };
    ctrl = true;
    rest = rest.slice(1);
  }
  while (rest.length > 1 && rest[1] === '-') {
    switch (rest[0]) {
      case 'C': case 'c': ctrl = true; break;
      case 'M': case 'm': alt = true; break;
      case 'S': case 's': shift = true; break;
      default: return null;
    }
    rest = rest.slice(2);
  }
  if (rest.length === 0) return null;
  const codePoint = rest.codePointAt(0)!;
  if (String.fromCodePoint(codePoint).length === rest.length) {
    return codePoint < 0x20 ? null : { key: { kind: 'char', char: rest }, ctrl, alt, shift };
  }
  const lower = rest.toLowerCase();
  const key = NAMED_KEYS.get(lower);
  if (!key) return null;
  return { key, ctrl, alt, shift: shift || lower === 'btab' };
}

function encodeKey({ key, ctrl, alt, shift }: ParsedKey, modes: KeyEncodingModes): string {
  const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const esc = alt ? '\x1b' : '';
  switch (key.kind) {
    case 'cursor':
      if (modifier > 1) return `\x1b[1;${modifier}${key.final}`;
      return (modes.applicationCursorKeys ? '\x1bO' : '\x1b[') + key.final;
    case 'function':
      return modifier > 1 ? `\x1b[1;${modifier}${key.final}` : `\x1bO${key.final}`;
    case 'tilde':
      return modifier > 1 ? `\x1b[${key.code};${modifier}~` : `\x1b[${key.code}~`;
    case 'control':
      if (key === TAB && shift && !ctrl && !alt) return '\x1b[Z';
      if (ctrl || shift) return `\x1b[27;${modifier};${key.code}~`;
      return esc + key.byte;
    case 'backspace':
      return esc + (ctrl ? '\b' : '\x7f');
    case 'keypad':
      return esc + (modes.applicationKeypad ? `\x1bO${key.app}` : key.char);
    case 'char':
      if (ctrl) return esc + (controlCharacter(key.char) ?? key.char);
      return esc + (shift && key.char.toUpperCase().length === key.char.length ? key.char.toUpperCase() : key.char);
  }
}

function controlCharacter(char: string): string | null {
  if (char.length !== 1) return null;
  const code = char.charCodeAt(0);
  if (code >= 0x61 && code <= 0x7e) return String.fromCharCode(code - 0x60);
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40);
  switch (char) {
    case ' ':
    case '2':
      return '\x00';
    case '6':
      return '\x1e';
    case '-':
    case '/':
      return '\x1f';
    case '?':
      return '\x7f';
    default:
      return null;
  }
}
