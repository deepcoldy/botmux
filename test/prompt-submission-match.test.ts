import { describe, expect, it } from 'vitest';
import { fingerprintPromptText, prefixOf } from '../src/services/prompt-context-store.js';
import { WrittenInputLedger } from '../src/services/prompt-submission-match.js';

const WAKE = '[workflow] run r1: checkpoint after node a. Review its result, then reply.';
const submitted = (text: string) => ({ fingerprint: fingerprintPromptText(text), prefix: prefixOf(text) });

describe('WrittenInputLedger', () => {
  it('the prompt is a written turn\'s text: that turn, once', () => {
    const ledger = new WrittenInputLedger();
    ledger.noteWritten('om_person', 'hello there');
    ledger.noteWritten('workflow-event:r1:3', WAKE);
    expect(ledger.takeSubmitted(submitted(WAKE))).toBe('workflow-event:r1:3');
    expect(ledger.takeSubmitted(submitted(WAKE))).toBeUndefined();
    expect(ledger.takeSubmitted(submitted('hello there'))).toBe('om_person');
  });

  it('the prompt starts with a written turn\'s text (a later write landed in the same box): that turn', () => {
    const ledger = new WrittenInputLedger();
    ledger.noteWritten('workflow-event:r1:3', WAKE);
    ledger.noteWritten('om_person', 'and one more thing');
    expect(ledger.takeSubmitted(submitted(`${WAKE}\nand one more thing`))).toBe('workflow-event:r1:3');
    expect(ledger.takeSubmitted(submitted('and one more thing'))).toBe('om_person');
  });

  it('another prompt typed in place of a cleared box submits no written turn', () => {
    const ledger = new WrittenInputLedger();
    ledger.noteWritten('workflow-event:r1:3', WAKE);
    expect(ledger.takeSubmitted(submitted('what is the status?'))).toBeUndefined();
    expect(ledger.takeSubmitted({})).toBeUndefined();
    expect(ledger.takeSubmitted({ prefix: '' })).toBeUndefined();
    expect(ledger.takeSubmitted(submitted(WAKE))).toBe('workflow-event:r1:3');
  });

  it('a prefix shared by two written turns (workflow wakes share their static preamble) proves neither and consumes nothing', () => {
    const ledger = new WrittenInputLedger();
    const second = WAKE.replace('node a', 'node b');
    ledger.noteWritten('workflow-event:r1:3', WAKE);
    ledger.noteWritten('workflow-event:r1:4', second);
    expect(prefixOf(WAKE)).toBe(prefixOf(second));
    // A prefix-only submit (the full fingerprint missed after an append, a
    // sanitization difference) cannot pick one over the other.
    expect(ledger.takeSubmitted({ prefix: prefixOf(second) })).toBeUndefined();
    // Nothing was consumed: the exact fingerprints still resolve both turns.
    expect(ledger.takeSubmitted(submitted(second))).toBe('workflow-event:r1:4');
    expect(ledger.takeSubmitted(submitted(WAKE))).toBe('workflow-event:r1:3');
  });

  it('a stale wake entry cannot steal a later wake submit whose prefix it shares', () => {
    const ledger = new WrittenInputLedger();
    const head = 'C'.repeat(40);
    ledger.noteWritten('workflow-event:r1:1', `${head} one`); // Esc-cleared, never submitted, still in the ledger
    ledger.noteWritten('workflow-event:r1:2', `${head} two`);
    const submittedPrompt = `${head} two\nappended in the same box after the write`;
    expect(ledger.takeSubmitted(submitted(submittedPrompt))).toBeUndefined();
  });

  it('with the stale entry gone, the same prefix-only submit resolves the one remaining turn', () => {
    const ledger = new WrittenInputLedger();
    const head = 'C'.repeat(40);
    ledger.noteWritten('workflow-event:r1:2', `${head} two`);
    const submittedPrompt = `${head} two\nappended in the same box after the write`;
    expect(ledger.takeSubmitted(submitted(submittedPrompt))).toBe('workflow-event:r1:2');
  });

  it('a prefix that already backed a claim never backs another one: recalled old text is not credited to the wake currently held', () => {
    const ledger = new WrittenInputLedger();
    const head = 'C'.repeat(40);
    const third = `${head} three`;
    const ninth = `${head} nine`;
    // The earlier wake was submitted normally: its fingerprint claim consumes
    // its entry and spends the shared prefix.
    ledger.noteWritten('workflow-event:r1:3', third);
    expect(ledger.takeSubmitted(submitted(third))).toBe('workflow-event:r1:3');
    // The wake the daemon now holds is the only entry with that prefix left.
    ledger.noteWritten('workflow-event:r1:9', ninth);
    // Up-arrow recalls the consumed wake's text and submits it verbatim: its
    // fingerprint has no entry, and the spent prefix must not credit wake 9.
    expect(ledger.takeSubmitted(submitted(third))).toBeUndefined();
    // The held entry was not consumed: its own exact submit still resolves.
    expect(ledger.takeSubmitted(submitted(ninth))).toBe('workflow-event:r1:9');
  });

  it('a claimed prefix spent through the prefix fallback is tainted as well', () => {
    const ledger = new WrittenInputLedger();
    const head = 'C'.repeat(40);
    ledger.noteWritten('workflow-event:r1:1', `${head} one`);
    const appended = `${head} one\nmore text in the same input box`;
    expect(ledger.takeSubmitted(submitted(appended))).toBe('workflow-event:r1:1');
    // A later held wake sharing the prefix cannot be credited via recall.
    ledger.noteWritten('workflow-event:r1:2', `${head} two`);
    expect(ledger.takeSubmitted(submitted(appended))).toBeUndefined();
  });

  it('a unique prefix belonging to a different text is untouched by the taint and still resolves', () => {
    const ledger = new WrittenInputLedger();
    ledger.noteWritten('workflow-event:r1:3', WAKE);
    expect(ledger.takeSubmitted(submitted(WAKE))).toBe('workflow-event:r1:3');
    ledger.noteWritten('om_person', 'a completely different human opening line');
    expect(ledger.takeSubmitted(submitted('a completely different human opening line, then more')))
      .toBe('om_person');
  });

  it('an entry pushed out by the size cap spends its prefix: recalling its text cannot credit the wake currently held', () => {
    const ledger = new WrittenInputLedger();
    const head = 'C'.repeat(40);
    const evicted = `${head} evicted wake text`;
    ledger.noteWritten('workflow-event:r1:3', evicted);
    for (let i = 0; i < 16; i++) {
      ledger.noteWritten(`filler-${i}`, `filler number ${i} with a clearly distinct opening line`);
    }
    // A later wake sharing the static preamble is now the only entry with that prefix.
    ledger.noteWritten('workflow-event:r1:9', `${head} held wake text`);
    // Up-arrow recalls the evicted wake's text verbatim: fingerprint misses,
    // and its prefix was spent when the entry left the window.
    expect(ledger.takeSubmitted(submitted(evicted))).toBeUndefined();
    // The held wake was not consumed: its own exact submit still resolves.
    expect(ledger.takeSubmitted(submitted(`${head} held wake text`))).toBe('workflow-event:r1:9');
  });

  it('a prefix made ambiguous and then orphaned by eviction stays unusable', () => {
    const ledger = new WrittenInputLedger();
    const head = 'D'.repeat(40);
    ledger.noteWritten('workflow-event:r1:1', `${head} first body`);
    ledger.noteWritten('workflow-event:r1:2', `${head} second body`);
    expect(ledger.takeSubmitted({ prefix: prefixOf(`${head} first body`) })).toBeUndefined();
    for (let i = 0; i < 15; i++) {
      ledger.noteWritten(`filler-${i}`, `different filler opening number ${i} padding`);
    }
    // Only the second wake remains in the window; the first one was evicted.
    expect(ledger.takeSubmitted(submitted(`${head} first body`))).toBeUndefined();
    expect(ledger.takeSubmitted(submitted(`${head} second body`))).toBe('workflow-event:r1:2');
  });

  it('a turn rewritten with different text spends the old text\'s prefix', () => {
    const ledger = new WrittenInputLedger();
    const oldHead = 'E'.repeat(40);
    const newHead = 'F'.repeat(40);
    const original = `${oldHead} original draft`;
    ledger.noteWritten('workflow-event:r1:1', original);
    ledger.noteWritten('workflow-event:r1:1', `${newHead} replaced draft`);
    // A later held wake reusing the abandoned text's prefix must not be
    // credited with the abandoned draft when input history recalls it.
    ledger.noteWritten('workflow-event:r1:2', `${oldHead} another held body`);
    expect(ledger.takeSubmitted(submitted(original))).toBeUndefined();
    // The replacement text and the held wake still resolve on their own fingerprints.
    expect(ledger.takeSubmitted(submitted(`${newHead} replaced draft`))).toBe('workflow-event:r1:1');
    expect(ledger.takeSubmitted(submitted(`${oldHead} another held body`))).toBe('workflow-event:r1:2');
  });

  it('a turn rewritten with the same opening keeps that prefix as evidence for itself', () => {
    const ledger = new WrittenInputLedger();
    const head = 'G'.repeat(40);
    ledger.noteWritten('workflow-event:r1:1', `${head} first draft`);
    ledger.noteWritten('workflow-event:r1:1', `${head} second draft`);
    // Both texts belong to this one turn, so the prefix still names it alone:
    // a later write appended in the same box resolves through the fallback.
    expect(ledger.takeSubmitted(submitted(`${head} second draft\nappended in the same box`)))
      .toBe('workflow-event:r1:1');
  });

  it('a turn written again is remembered once, and only the latest writes are kept', () => {
    const ledger = new WrittenInputLedger();
    ledger.noteWritten('t-0', 'first text');
    ledger.noteWritten('t-0', 'first text');
    expect(ledger.takeSubmitted(submitted('first text'))).toBe('t-0');
    expect(ledger.takeSubmitted(submitted('first text'))).toBeUndefined();
    for (let i = 0; i < 17; i++) ledger.noteWritten(`t-${i}`, `text number ${i}`);
    expect(ledger.takeSubmitted(submitted('text number 0'))).toBeUndefined();
    expect(ledger.takeSubmitted(submitted('text number 16'))).toBe('t-16');
  });
});
