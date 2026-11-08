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

  it('turns sharing a prefix: the earliest written first', () => {
    const ledger = new WrittenInputLedger();
    const second = WAKE.replace('node a', 'node b');
    ledger.noteWritten('workflow-event:r1:3', WAKE);
    ledger.noteWritten('workflow-event:r1:4', second);
    expect(ledger.takeSubmitted({ prefix: prefixOf(second) })).toBe('workflow-event:r1:3');
    expect(ledger.takeSubmitted(submitted(second))).toBe('workflow-event:r1:4');
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
