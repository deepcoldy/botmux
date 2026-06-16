import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLedger } from '../src/verified-delivery/ledger.js';
import { buildReport, parseArtifactText } from '../src/verified-delivery/report.js';

const TS = 1_700_000_000_000;

describe('verified-delivery report (worker side)', () => {
  let baseDir: string;
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'vd-report-')); });
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

  it('parseArtifactText splits name=content, keeps bare content, tolerates = in value', () => {
    expect(parseArtifactText(['out=PASS', 'just content', 'k=a=b'])).toEqual([
      { name: 'out', content: 'PASS' },
      { content: 'just content' },
      { name: 'k', content: 'a=b' },
    ]);
  });

  it('builds a TaskReported draft with path + inline evidence and appends to the ledger', () => {
    const led = openLedger({ baseDir });
    const { draft, reportId, evidence } = buildReport({
      taskId: 'task-1', summary: 'done', ts: TS, chatId: 'oc_x', workerOpenId: 'ou_w',
      artifacts: ['/tmp/out.json'],
      inline: [{ name: 'check', content: 'PASS: ok\n' }],
    }, led);

    expect(reportId).toMatch(/^task-1-r[0-9a-f]{8}$/);
    expect(evidence[0]).toEqual({ kind: 'path', path: '/tmp/out.json' });
    expect(evidence[1].kind).toBe('inline');
    expect(draft).toMatchObject({ type: 'TaskReported', actor: 'worker', taskId: 'task-1', idempotencyKey: `reported:${reportId}` });

    led.append(draft);
    const t = led.task('task-1')!;
    expect(t.status).toBe('reported');
    expect(t.reports[0].evidence).toHaveLength(2);
    // inline content is retrievable for the orchestrator's verify step
    const inlineRef = (evidence[1] as any).ref;
    expect(led.readInlineEvidence(inlineRef)).toBe('PASS: ok\n');
  });

  it('reportId is stable for identical content, changes when evidence changes', () => {
    const led = openLedger({ baseDir });
    const a = buildReport({ taskId: 't', summary: 's', ts: TS, artifacts: ['/p/a'] }, led);
    const b = buildReport({ taskId: 't', summary: 's', ts: TS, artifacts: ['/p/a'] }, led);
    const c = buildReport({ taskId: 't', summary: 's', ts: TS, artifacts: ['/p/b'] }, led);
    expect(b.reportId).toBe(a.reportId);  // same → dedups (same attempt)
    expect(c.reportId).not.toBe(a.reportId); // changed evidence → new attempt
  });

  it('explicit reportId overrides derivation (strict retry idempotency)', () => {
    const led = openLedger({ baseDir });
    const { reportId } = buildReport({ taskId: 't', summary: 's', ts: TS, reportId: 'fixed-1', artifacts: ['/p/a'] }, led);
    expect(reportId).toBe('fixed-1');
  });

  it('refuses to build a report with no evidence', () => {
    const led = openLedger({ baseDir });
    expect(() => buildReport({ taskId: 't', summary: 's', ts: TS }, led)).toThrow(/at least one evidence/);
  });
});
