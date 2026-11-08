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
