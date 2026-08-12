import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AsyncFileControlAuditSink,
  controlAuditRecord,
} from '../src/dashboard/control-audit.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('audit stream did not flush');
}

describe('async terminal input audit sink', () => {
  it('queues compact records to a 0600 append stream without retaining terminal bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-control-audit-'));
    roots.push(root);
    const path = join(root, 'nested', 'dashboard-control.ndjson');
    const sink = new AsyncFileControlAuditSink({ path });
    sink.append(controlAuditRecord('ou_owner', 's1', 'terminal.input', { bytes: 4 }));
    sink.append(controlAuditRecord('ou_owner', 's1', 'terminal.input', { bytes: 9 }));
    await waitFor(() => {
      try { return readFileSync(path, 'utf8').trim().split('\n').length === 2; }
      catch { return false; }
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const records = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(record => record.bytes)).toEqual([4, 9]);
    expect(Object.keys(records[0]).sort()).toEqual(['action', 'bytes', 'session', 'timestamp', 'user']);
  });
});
