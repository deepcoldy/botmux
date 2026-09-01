import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  AUDIT_ASYNC_MAX_PENDING,
  AsyncFileControlAuditSink,
  controlAuditRecord,
  type AuditStreamLike,
  type ControlAuditRecord,
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

/** 可控假流：write 的返回值手动指定、drain 手动触发——不碰真实文件系统。 */
class FakeAuditStream implements AuditStreamLike {
  written: string[] = [];
  /** write() 的返回值：false 表示「进了内核缓冲但请停手等 drain」。 */
  accept = true;
  private drains: Array<() => void> = [];
  write(chunk: string, _encoding: BufferEncoding): boolean {
    this.written.push(chunk);
    return this.accept;
  }
  once(_event: 'drain', listener: () => void): this {
    this.drains.push(listener);
    return this;
  }
  on(_event: 'error', _listener: (error: unknown) => void): this {
    return this;
  }
  emitDrain(): void {
    for (const listener of this.drains.splice(0)) listener();
  }
  records(): ControlAuditRecord[] {
    return this.written.map(line => JSON.parse(line) as ControlAuditRecord);
  }
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('async audit sink backpressure', () => {
  it('caps the queue under backpressure, drops oldest, and lands an audit.dropped marker on resume', async () => {
    const stream = new FakeAuditStream();
    stream.accept = false; // 慢盘：首条 write 即报「请等 drain」
    const sink = new AsyncFileControlAuditSink({
      path: '/unused-by-injected-stream',
      maxPending: 3,
      streamFactory: async () => stream,
    });
    sink.append(controlAuditRecord('u', 's1', 'terminal.input', { bytes: 1 }));
    await tick(); // 让 openStream 完成并 flush 首条
    expect(stream.written).toHaveLength(1);
    // 背压期间持续输入 10 条：内存里只留最新 3 条，最旧 7 条被丢并计数。
    for (let i = 2; i <= 11; i++) {
      sink.append(controlAuditRecord('u', 's1', 'terminal.input', { bytes: i }));
    }
    expect(stream.written).toHaveLength(1); // 等 drain 期间一条都不再写
    stream.accept = true;
    stream.emitDrain();
    const records = stream.records();
    // 顺序：首条 → 丢弃标记（丢的都比幸存者旧）→ 幸存的最新 3 条。
    expect(records.map(r => r.dropped ?? r.bytes)).toEqual([1, 7, 9, 10, 11]);
    expect(records[1]).toMatchObject({ action: 'audit.dropped', dropped: 7, user: 'system', session: 'audit' });
  });

  it('resumes direct writes after drain with no further queueing', async () => {
    const stream = new FakeAuditStream();
    stream.accept = false;
    const sink = new AsyncFileControlAuditSink({
      path: '/unused-by-injected-stream',
      maxPending: 3,
      streamFactory: async () => stream,
    });
    sink.append(controlAuditRecord('u', 's1', 'terminal.input', { bytes: 1 }));
    await tick();
    stream.accept = true;
    stream.emitDrain();
    const before = stream.written.length;
    sink.append(controlAuditRecord('u', 's1', 'terminal.input', { bytes: 2 }));
    sink.append(controlAuditRecord('u', 's1', 'terminal.input', { bytes: 3 }));
    expect(stream.written).toHaveLength(before + 2); // 恢复后逐条直写，不再积压
    expect(stream.records().map(r => r.dropped ?? r.bytes)).toEqual([1, 2, 3]); // 无丢弃标记
  });

  it('bounds the queue while the stream is still opening (the review scenario)', async () => {
    const stream = new FakeAuditStream();
    let release!: () => void;
    const opened = new Promise<void>(resolve => { release = resolve; });
    const sink = new AsyncFileControlAuditSink({
      path: '/unused-by-injected-stream',
      maxPending: 2,
      streamFactory: async () => { await opened; return stream; },
    });
    // open 一直没完成：7 条只留最新 2 条，其余 5 条丢并计数——不再无限增长。
    for (let i = 1; i <= 7; i++) {
      sink.append(controlAuditRecord('u', 's1', 'terminal.input', { bytes: i }));
    }
    expect(stream.written).toHaveLength(0);
    release();
    await tick();
    expect(stream.records().map(r => r.dropped ?? r.bytes)).toEqual([5, 6, 7]);
    expect(stream.records()[0].action).toBe('audit.dropped');
  });

  it('never blocks or hands the caller a promise: append stays synchronous fire-and-forget', async () => {
    expect(AUDIT_ASYNC_MAX_PENDING).toBe(2_000);
    const stream = new FakeAuditStream();
    stream.accept = false; // 永不 drain 的最坏情况
    const sink = new AsyncFileControlAuditSink({
      path: '/unused-by-injected-stream',
      maxPending: 5,
      streamFactory: async () => stream,
    });
    sink.append(controlAuditRecord('u', 's1', 'terminal.input', { bytes: 0 }));
    await tick();
    expect(stream.written).toHaveLength(1);
    // 同步循环 5000 次一口气跑完：没有返回值可 await，也不会随背压越写越多。
    for (let i = 1; i <= 5_000; i++) {
      const out = sink.append(controlAuditRecord('u', 's1', 'terminal.input', { bytes: i })) as unknown;
      expect(out).toBeUndefined();
    }
    expect(stream.written).toHaveLength(1);
    // 事后解除背压：落盘的只有「丢弃标记 + 上限内的最新 5 条」，内存从未囤过 5000 条。
    stream.accept = true;
    stream.emitDrain();
    const records = stream.records();
    expect(records).toHaveLength(1 + 1 + 5);
    expect(records[1]).toMatchObject({ action: 'audit.dropped', dropped: 4_995 });
    expect(records.slice(2).map(r => r.bytes)).toEqual([4_996, 4_997, 4_998, 4_999, 5_000]);
  });
});

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
