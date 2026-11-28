import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AntigravitySubmitLedger, type AntigravitySubmitBaseline } from '../src/services/antigravity-submit-ledger.js';

let brain: string;
beforeEach(() => { brain = mkdtempSync(join(tmpdir(), 'agy-ledger-')); });
afterEach(() => { rmSync(brain, { recursive: true, force: true }); });

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const logDir = (cid: string) => join(brain, cid, '.system_generated', 'logs');
const fullPath = (cid: string) => join(logDir(cid), 'transcript_full.jsonl');
const compactPath = (cid: string) => join(logDir(cid), 'transcript.jsonl');
const record = (step: number, payload: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  step_index: step, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE',
  content: `<USER_REQUEST>\n${payload}\n</USER_REQUEST>`, ...extra,
}) + '\n';

function seed(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

function baselineOf(cid: string, path: string): AntigravitySubmitBaseline {
  return { conversationId: cid, transcriptPath: path, transcriptSize: statSync(path).size, transcriptCreatedAfter: false };
}

describe('Antigravity submit ledger', () => {
  it('never proves from a baseline whose transcript size could not be measured', () => {
    const cid = randomUUID();
    seed(fullPath(cid), record(1, 'X'));
    const ledger = new AntigravitySubmitLedger(brain);
    // The only matching record predates the write; an unmeasured size must not
    // fall back to offset 0 and accept it.
    const entry = ledger.register(sha('X'), { ...baselineOf(cid, fullPath(cid)), transcriptSize: undefined });
    expect(ledger.tryClaim(entry, cid)).toBe(false);
    const measured = new AntigravitySubmitLedger(brain);
    expect(measured.tryClaim(measured.register(sha('X'), { ...baselineOf(cid, fullPath(cid)), transcriptSize: 0 }), cid)).toBe(true);
  });

  it('keeps claiming after agy adds the full transcript next to the compact one', () => {
    const cid = randomUUID();
    seed(compactPath(cid), record(1, 'old'));
    const ledger = new AntigravitySubmitLedger(brain);
    const first = ledger.register(sha('A'), baselineOf(cid, compactPath(cid)));
    appendFileSync(compactPath(cid), record(2, 'A'));
    expect(ledger.tryClaim(first, cid)).toBe(true);
    // agy now writes the full log too, holding the same steps.
    seed(fullPath(cid), record(1, 'old') + record(2, 'A'));
    const second = ledger.register(sha('B'), baselineOf(cid, fullPath(cid)));
    appendFileSync(compactPath(cid), record(3, 'B'));
    appendFileSync(fullPath(cid), record(3, 'B'));
    expect(ledger.tryClaim(second, cid)).toBe(true);
  });

  it('re-aligns a pending entry\'s scan when agy switches it from the compact to the full transcript', () => {
    const cid = randomUUID();
    const long = `Q${'x'.repeat(5_000)}`;
    seed(compactPath(cid), record(1, 'old'));
    const ledger = new AntigravitySubmitLedger(brain);
    const entry = ledger.register(sha(long), baselineOf(cid, compactPath(cid)));
    expect(ledger.tryClaim(entry, cid)).toBe(false); // probed on the compact file
    // The compact log cuts long fields; only the full log, which appears now
    // with the same steps, holds the whole payload.
    appendFileSync(compactPath(cid), record(2, `${long.slice(0, 100)}<truncated>`, { truncated_fields: '["content"]' }));
    seed(fullPath(cid), record(1, 'old') + record(2, long));
    expect(ledger.tryClaim(entry, cid)).toBe(true);
  });

  it('identifies a record by its step across compact and full, so it is never claimed twice', () => {
    const cid = randomUUID();
    seed(compactPath(cid), '');
    const ledger = new AntigravitySubmitLedger(brain);
    const first = ledger.register(sha('S'), baselineOf(cid, compactPath(cid)));
    appendFileSync(compactPath(cid), record(1, 'S'));
    expect(ledger.tryClaim(first, cid)).toBe(true);
    // A later identical submit written before the full log appeared: the full
    // log replays step 1, which is already the first submit's.
    const second = ledger.register(sha('S'), { conversationId: cid, transcriptPath: compactPath(cid), transcriptSize: 0, transcriptCreatedAfter: false });
    seed(fullPath(cid), record(1, 'S'));
    expect(ledger.tryClaim(second, cid)).toBe(false);
    appendFileSync(fullPath(cid), record(2, 'S'));
    expect(ledger.tryClaim(second, cid)).toBe(true);
  });

  it('picks up a record whose line was still being written at the previous probe', () => {
    const cid = randomUUID();
    seed(fullPath(cid), record(1, 'old'));
    const ledger = new AntigravitySubmitLedger(brain);
    const entry = ledger.register(sha('P'), baselineOf(cid, fullPath(cid)));
    const line = record(2, 'P');
    appendFileSync(fullPath(cid), line.slice(0, 20));
    expect(ledger.tryClaim(entry, cid)).toBe(false);
    appendFileSync(fullPath(cid), line.slice(20));
    expect(ledger.tryClaim(entry, cid)).toBe(true);
  });
});
