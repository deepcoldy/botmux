import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Behavioural tests for the iOS third-party IME fix injected into the web
// terminal page (getTerminalHtml in src/worker.ts). That block is a string of
// browser JS inside a template literal, so we cut the real IIFE out of the
// source and run it against a stub DOM.
const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

// ── Executable rig ──────────────────────────────────────────────────────────
// Runs the real IIFE in a stub DOM so a shape that "looks right" but emits
// twice is caught. We model xterm's own emitters (verified against @xterm/xterm
// 5.5.0 lib/xterm.js):
//   • _inputEvent(e): emits iff e.data && e.inputType==='insertText' &&
//     (!e.composed || !_keyDownSeen)   — nothing else, delete* never emits.
//   • paste: handlePasteEvent does stopPropagation but NOT preventDefault, so
//     xterm sends the text once AND the browser's default paste then fires an
//     input(insertFromPaste, composed=true) into the textarea.
// A regression that forwards a non-insertText composed event shows up as
// total emits > the single intended copy.
function buildImeRig(opts: { hasToken?: boolean; search?: string } = {}) {
  const start = workerSource.indexOf('if(hasToken && !/[?&]imefix=0');
  const end = workerSource.indexOf('})();}', start) + '})();}'.length;
  // The block lives in a template literal: \\x7f → \x7f, \\b → \b at emit time.
  const emitted = workerSource.slice(start, end).replace(/\\\\/g, '\\');

  const listeners: Record<string, Array<(e: any) => void>> = {};
  const textarea = {
    value: 'abc',
    addEventListener(type: string, fn: (e: any) => void) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
  };
  const ours: string[] = [];
  let keyDownSeen = false;
  let handler: ((e: any) => boolean) | null = null;
  const term = {
    textarea,
    attachCustomKeyEventHandler(fn: (e: any) => boolean) {
      handler = fn;
    },
    input(d: string) {
      ours.push(d);
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('term', 'location', 'hasToken', emitted)(
    term,
    { search: opts.search ?? '?tok=1' },
    opts.hasToken ?? true,
  );

  const fire = (type: string, ev: any) => (listeners[type] || []).forEach((fn) => fn(ev));
  // xterm's own _inputEvent emit rule (5.5.0):
  const xtermInputEmits = (ev: any) =>
    !!(ev.data && ev.inputType === 'insertText' && (!ev.composed || !keyDownSeen));

  let xtermEmits = 0;
  return {
    setTextarea(v: string) {
      textarea.value = v;
    },
    /** Returns the custom key handler's verdict: false = claimed (xterm skips the key). */
    keydown(keyCode: number): boolean | undefined {
      keyDownSeen = true;
      return handler?.({ type: 'keydown', keyCode });
    },
    keyup() {
      keyDownSeen = false;
      fire('keyup', {});
    },
    compositionstart() {
      fire('compositionstart', {});
    },
    compositionend() {
      fire('compositionend', {});
    },
    blur() {
      fire('blur', {});
    },
    input(ev: any) {
      // Count what xterm's own input handler would emit for this event first…
      if (xtermInputEmits(ev)) xtermEmits += 1;
      // …then deliver to the patch's capture-phase listener.
      fire('input', ev);
    },
    xtermPaste() {
      // xterm's paste handler sends the text once (independent of _inputEvent).
      xtermEmits += 1;
    },
    get ours() {
      return ours;
    },
    get attached() {
      return handler !== null || Object.keys(listeners).length > 0;
    },
    get total() {
      return xtermEmits + ours.length;
    },
  };
}

describe('web terminal iOS IME fix — behaviour (exactly-once, no double-emit)', () => {
  it('豆包 single char: keydown229 → insertText forwards exactly once', () => {
    const rig = buildImeRig();
    rig.setTextarea('你');
    rig.keydown(229);
    rig.input({ inputType: 'insertText', data: '你', composed: true });
    expect(rig.ours).toEqual(['你']);
    expect(rig.total).toBe(1);
  });

  it('space→。 conversion (delete THEN insertText) in one claimed cycle', () => {
    const rig = buildImeRig();
    rig.setTextarea('。');
    rig.keydown(229);
    rig.input({ inputType: 'deleteContentBackward', composed: true });
    rig.input({ inputType: 'insertText', data: '。', composed: true });
    expect(rig.ours).toEqual(['\x7f', '。']);
    expect(rig.total).toBe(2);
  });

  it('voice correction: one Backspace → N deletes map 1:1 to N terminal backspaces', () => {
    const rig = buildImeRig();
    rig.setTextarea('整段文字');
    rig.keydown(8);
    rig.input({ inputType: 'deleteContentBackward', composed: true });
    rig.input({ inputType: 'deleteContentBackward', composed: true });
    rig.input({ inputType: 'deleteContentBackward', composed: true });
    expect(rig.ours).toEqual(['\x7f', '\x7f', '\x7f']);
  });

  it('WeChat composition is never taken over (patch stays silent, xterm owns it)', () => {
    const rig = buildImeRig();
    rig.compositionstart();
    rig.setTextarea('ni');
    rig.keydown(229);
    rig.input({ inputType: 'insertCompositionText', data: 'ni', composed: true });
    rig.compositionend();
    expect(rig.ours).toEqual([]);
  });

  it('empty-textarea Backspace is NOT claimed (normal terminal backspace flows to xterm)', () => {
    const rig = buildImeRig();
    rig.setTextarea('');
    rig.keydown(8);
    // No IME input event follows a plain terminal backspace; patch stays silent
    // and xterm emits its own \x7f (modelled outside this rig).
    expect(rig.ours).toEqual([]);
  });

  // ── The two sequences Codex's delta review flagged ──
  it('REGRESSION (Codex #1): stuck claim + iOS paste must NOT double (insertFromPaste is not insertText)', () => {
    const rig = buildImeRig();
    rig.setTextarea('x');
    rig.keydown(229); // claim; iOS omits the matching keyup → _claim stays open
    rig.xtermPaste(); // xterm's paste handler already sent the pasted text once
    // default paste (not preventDefault'd) then inserts into the textarea:
    rig.input({ inputType: 'insertFromPaste', data: 'hello', composed: true });
    expect(rig.ours).toEqual([]); // patch must NOT re-forward the paste
    expect(rig.total).toBe(1); // exactly one copy reaches the terminal
  });

  it('REGRESSION (Codex #2): WebKit replacement ㅎ→하→한 must not append (insertReplacementText is not insertText)', () => {
    const rig = buildImeRig();
    rig.setTextarea('한');
    rig.keydown(229);
    rig.input({ inputType: 'insertReplacementText', data: 'ㅎ', composed: true });
    rig.input({ inputType: 'insertReplacementText', data: '하', composed: true });
    rig.input({ inputType: 'insertReplacementText', data: '한', composed: true });
    // We do NOT own replacement semantics, so we forward nothing and let xterm's
    // own path handle it — critically we must not turn '한' into 'ㅎ하한'.
    expect(rig.ours.join('')).not.toBe('ㅎ하한');
    expect(rig.ours).toEqual([]);
  });

  it('REGRESSION (original P3): stuck claim + composed=false insertText stays single (xterm owns it)', () => {
    const rig = buildImeRig();
    rig.setTextarea('x');
    rig.keydown(229); // claim, no keyup
    // A composed=false insertText is one xterm's _inputEvent emits itself.
    rig.input({ inputType: 'insertText', data: 'Z', composed: false });
    expect(rig.ours).toEqual([]); // patch must not also forward it
    expect(rig.total).toBe(1);
  });

  it('a new keydown resets _claim so a later composed=false insertText is not double-forwarded', () => {
    const rig = buildImeRig();
    rig.setTextarea('x');
    rig.keydown(229); // claim, no keyup
    rig.keydown(65); // new key resets _claim at keydown start
    rig.input({ inputType: 'insertText', data: 'A', composed: false });
    expect(rig.ours).toEqual([]);
    expect(rig.total).toBe(1);
  });

  it('blur resets _claim (guards against a stuck-open claim when keyup never arrives)', () => {
    const rig = buildImeRig();
    rig.setTextarea('x');
    rig.keydown(229);
    rig.blur();
    rig.input({ inputType: 'insertFromPaste', data: 'zzz', composed: true });
    expect(rig.ours).toEqual([]);
  });
});

describe('web terminal iOS IME fix — key claiming and cycle boundaries', () => {
  it('claims keyCode 229 (xterm skips its broken fallback) and leaves ordinary keys to xterm', () => {
    const rig = buildImeRig();
    expect(rig.keydown(229)).toBe(false);
    expect(rig.keydown(65)).toBe(true);
  });

  it('claims Backspace only while the textarea holds a pending IME edit', () => {
    const rig = buildImeRig();
    rig.setTextarea('');
    // empty textarea = plain terminal backspace: xterm must keep sending its \x7f
    expect(rig.keydown(8)).toBe(true);
    rig.setTextarea('x');
    expect(rig.keydown(8)).toBe(false);
  });

  it('every new keydown closes a stuck-open claim before deciding to claim again', () => {
    const rig = buildImeRig();
    rig.keydown(229); // claimed; iOS IME keys often fire no keyup
    rig.keydown(65); // an unclaimed key starts a fresh, unclaimed cycle
    rig.input({ inputType: 'deleteContentBackward', composed: true });
    rig.input({ inputType: 'insertText', data: 'A', composed: true });
    expect(rig.ours).toEqual([]);
  });

  it.each(['keyup', 'blur'] as const)('%s closes a claimed cycle', (closer) => {
    const rig = buildImeRig();
    rig.setTextarea('x');
    rig.keydown(8);
    rig[closer]();
    rig.input({ inputType: 'deleteContentBackward', composed: true });
    rig.input({ inputType: 'insertText', data: 'y', composed: true });
    expect(rig.ours).toEqual([]);
  });

  it('neither claims nor forwards while a real composition is active', () => {
    const rig = buildImeRig();
    rig.compositionstart();
    rig.setTextarea('ni');
    expect(rig.keydown(229)).toBe(true);
    expect(rig.keydown(8)).toBe(true);
    rig.input({ inputType: 'insertText', data: '你', composed: true });
    rig.input({ inputType: 'deleteContentBackward', composed: true });
    expect(rig.ours).toEqual([]);
    rig.compositionend();
    expect(rig.keydown(229)).toBe(false);
  });

  it.each([
    ['without a write token', { hasToken: false }],
    ['behind the ?imefix=0 escape hatch', { search: '?tok=1&imefix=0' }],
  ])('installs nothing %s', (_label, opts) => {
    const rig = buildImeRig(opts);
    expect(rig.attached).toBe(false);
    expect(rig.keydown(229)).toBeUndefined();
  });
});
