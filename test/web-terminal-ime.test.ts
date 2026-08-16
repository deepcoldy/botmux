import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source-level regression guard for the iOS third-party IME fix injected into
// the web terminal page (getTerminalHtml in src/worker.ts). That block is a
// string of browser JS, so — like web-terminal-touch-scroll.test.ts — we assert
// on its source rather than execute a DOM. These assertions lock the two
// double-emit hardening invariants a Codex review flagged (composed gate +
// _claim reset on keydown/blur, not just keyup) so a future edit can't silently
// regress them, plus the core dead-path takeover behaviour.
const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

function imeBlock(): string {
  const start = workerSource.indexOf('// ── iOS third-party IME fix');
  const end = workerSource.indexOf('})();}', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // include the closing IIFE
  return workerSource.slice(start, end + '})();}'.length);
}

describe('web terminal iOS IME fix', () => {
  it('claims the keyCode=229 dead path (returns false so xterm skips its broken fallback)', () => {
    const block = imeBlock();
    expect(block).toContain('if(e.keyCode===229){ _claim=true; return false; }');
  });

  it('claims Backspace ONLY when the textarea is non-empty (empty = normal terminal backspace)', () => {
    const block = imeBlock();
    // The non-empty guard is what keeps a plain shell-line backspace flowing to
    // xterm (which sends its standard \x7f) instead of being swallowed.
    expect(block).toContain('if(e.keyCode===8 && _ta && _ta.value.length>0){ _claim=true; return false; }');
  });

  it('resets _claim at the START of every keydown (iOS IME keys often fire no keyup)', () => {
    const block = imeBlock();
    // Must reset before deciding to claim, so a stuck-open _claim from a prior
    // cycle (missing keyup) cannot leak into the next key.
    const keydownIdx = block.indexOf("if(e.type==='keydown'){");
    const resetIdx = block.indexOf('_claim=false;', keydownIdx);
    const claim229Idx = block.indexOf('if(e.keyCode===229)', keydownIdx);
    expect(keydownIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeGreaterThan(keydownIdx);
    // reset happens before the claim decision
    expect(resetIdx).toBeLessThan(claim229Idx);
  });

  it('also closes the cycle on keyup AND blur (belt-and-suspenders against stuck-open _claim)', () => {
    const block = imeBlock();
    expect(block).toContain("_ta.addEventListener('keyup',function(){_claim=false;}");
    expect(block).toContain("_ta.addEventListener('blur',function(){_claim=false;}");
  });

  it('forwards inserted text ONLY for inputType===insertText AND composed (whitelist, not just composed)', () => {
    const block = imeBlock();
    // composed is a shadow-DOM flag true for EVERY trusted InputEvent, so gating
    // on composed alone would still swallow insertFromPaste / insertReplacementText.
    // The whitelist restricts us to the exact dead path the target traces take.
    expect(block).toContain("if(e.data&&e.composed&&it==='insertText'){try{term.input(e.data,true)}catch(_e){}}");
    // the composed-only and unconditional forms are both regressions
    expect(block).not.toContain('if(e.data&&e.composed){try{term.input(e.data,true)}catch(_e){}}');
    expect(block).not.toContain('if(e.data){try{term.input(e.data,true)}catch(_e){}}');
  });

  it('maps each textarea delete to one terminal backspace (whole-run erase stays 1:1)', () => {
    const block = imeBlock();
    expect(block).toContain("if(it.indexOf('delete')===0){");
    expect(block).toContain("term.input('\\\\x7f',true)");
  });

  it('never takes over while a real composition is active (WeChat Chinese stays on xterm)', () => {
    const block = imeBlock();
    expect(block).toContain("_ta.addEventListener('compositionstart',function(){_composing=true;_claim=false;}");
    expect(block).toContain("_ta.addEventListener('compositionend',function(){_composing=false;_claim=false;}");
    // the input handler bails while composing
    expect(block).toContain('if(!_claim||_composing)return;');
  });

  it('uses term.input (not term.paste) so per-char input is not bracketed-paste-wrapped', () => {
    const block = imeBlock();
    expect(block).toContain('term.input(e.data,true)');
    expect(block).not.toContain('term.paste(e.data)');
  });

  it('is gated behind hasToken and an ?imefix=0 escape hatch', () => {
    const block = imeBlock();
    expect(block).toContain('if(hasToken && !/[?&]imefix=0');
  });
});

// ── Executable behavioural tests ────────────────────────────────────────────
// The source-level asserts above lock statement SHAPE; these run the real IIFE
// in a stub DOM and assert BEHAVIOUR, so a shape that "looks right" but emits
// twice is caught. We model xterm's own emitters (verified against @xterm/xterm
// 5.5.0 lib/xterm.js):
//   • _inputEvent(e): emits iff e.data && e.inputType==='insertText' &&
//     (!e.composed || !_keyDownSeen)   — nothing else, delete* never emits.
//   • paste: handlePasteEvent does stopPropagation but NOT preventDefault, so
//     xterm sends the text once AND the browser's default paste then fires an
//     input(insertFromPaste, composed=true) into the textarea.
// A regression that forwards a non-insertText composed event shows up as
// total emits > the single intended copy.
function buildImeRig() {
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
  new Function('term', 'location', 'hasToken', emitted)(term, { search: '?tok=1' }, true);

  const fire = (type: string, ev: any) => (listeners[type] || []).forEach((fn) => fn(ev));
  // xterm's own _inputEvent emit rule (5.5.0):
  const xtermInputEmits = (ev: any) =>
    !!(ev.data && ev.inputType === 'insertText' && (!ev.composed || !keyDownSeen));

  let xtermEmits = 0;
  return {
    setTextarea(v: string) {
      textarea.value = v;
    },
    keydown(keyCode: number) {
      keyDownSeen = true;
      handler?.({ type: 'keydown', keyCode });
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
