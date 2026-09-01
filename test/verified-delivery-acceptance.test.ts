import { describe, it, expect } from 'vitest';
import { parseAcceptanceCriteria, summarizeAcceptanceCriteria } from '../src/verified-delivery/acceptance.js';

describe('parseAcceptanceCriteria — back-compat gate', () => {
  it('treats empty / undefined as non-structured (no error)', () => {
    expect(parseAcceptanceCriteria(undefined)).toEqual({ structured: false });
    expect(parseAcceptanceCriteria('')).toEqual({ structured: false });
    expect(parseAcceptanceCriteria('   ')).toEqual({ structured: false });
  });

  it('leaves plain free-text hints untouched (legacy path)', () => {
    const r = parseAcceptanceCriteria('跑 npm test 全绿，再人工看一眼输出');
    expect(r).toEqual({ structured: false });
  });

  it('flags an explicit { ... } that is not valid JSON as a fail-fast error', () => {
    const r = parseAcceptanceCriteria('{ not json ]');
    expect(r.structured).toBe(true);
    expect(r.criteria).toBeUndefined();
    expect(r.error).toMatch(/不是合法 JSON/);
  });
});

describe('parseAcceptanceCriteria — validation', () => {
  it('accepts a valid v1 criteria with artifacts + commands', () => {
    const raw = JSON.stringify({
      version: 1,
      artifacts: [{ path: '/tmp/done.txt', kind: 'file', checks: [{ type: 'exists' }, { type: 'contains', text: 'PASS' }] }],
      commands: [{ cmd: 'npm test', cwd: '/repo', expectExitCode: 0, timeoutMs: 60000 }],
    });
    const r = parseAcceptanceCriteria(raw);
    expect(r.structured).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.criteria).toEqual({
      version: 1,
      artifacts: [{ path: '/tmp/done.txt', kind: 'file', checks: [{ type: 'exists' }, { type: 'contains', text: 'PASS' }] }],
      commands: [{ cmd: 'npm test', cwd: '/repo', expectExitCode: 0, timeoutMs: 60000 }],
    });
  });

  it('rejects wrong version', () => {
    const r = parseAcceptanceCriteria(JSON.stringify({ version: 2, artifacts: [{ path: '/x', checks: [{ type: 'exists' }] }] }));
    expect(r.error).toMatch(/version 必须为 1/);
  });

  it('rejects an artifact missing path or checks', () => {
    const r1 = parseAcceptanceCriteria(JSON.stringify({ version: 1, artifacts: [{ checks: [{ type: 'exists' }] }] }));
    expect(r1.error).toMatch(/缺少非空 path/);
    const r2 = parseAcceptanceCriteria(JSON.stringify({ version: 1, artifacts: [{ path: '/x', checks: [] }] }));
    expect(r2.error).toMatch(/缺少非空 checks/);
  });

  it('rejects an unknown check type and a contains without text', () => {
    const r1 = parseAcceptanceCriteria(JSON.stringify({ version: 1, artifacts: [{ path: '/x', checks: [{ type: 'matches' }] }] }));
    expect(r1.error).toMatch(/未知 check\.type/);
    const r2 = parseAcceptanceCriteria(JSON.stringify({ version: 1, artifacts: [{ path: '/x', checks: [{ type: 'contains' }] }] }));
    expect(r2.error).toMatch(/缺少非空 text/);
  });

  it('rejects a command missing cmd and a bad timeout', () => {
    const r1 = parseAcceptanceCriteria(JSON.stringify({ version: 1, commands: [{ cwd: '/x' }] }));
    expect(r1.error).toMatch(/缺少非空 cmd/);
    const r2 = parseAcceptanceCriteria(JSON.stringify({ version: 1, commands: [{ cmd: 'x', timeoutMs: -5 }] }));
    expect(r2.error).toMatch(/timeoutMs 必须是正数/);
  });

  it('rejects an empty criteria (no artifacts and no commands)', () => {
    const r = parseAcceptanceCriteria(JSON.stringify({ version: 1 }));
    expect(r.error).toMatch(/至少要有一个/);
  });

  it('defaults expectExitCode to omitted (summarized as 0)', () => {
    const r = parseAcceptanceCriteria(JSON.stringify({ version: 1, commands: [{ cmd: 'make' }] }));
    expect(r.criteria?.commands?.[0]).toEqual({ cmd: 'make' });
  });
});

describe('summarizeAcceptanceCriteria', () => {
  it('renders artifact + command checklist lines', () => {
    const lines = summarizeAcceptanceCriteria({
      version: 1,
      artifacts: [{ path: '/tmp/done.txt', kind: 'file', checks: [{ type: 'exists' }, { type: 'contains', text: 'PASS-R2' }] }],
      commands: [{ cmd: 'npm test', cwd: '/repo', timeoutMs: 30000 }],
    });
    expect(lines[0]).toBe('产物 /tmp/done.txt(file): 存在 + 含"PASS-R2"');
    expect(lines[1]).toBe('命令 `npm test`, cwd=/repo, 期望退出码 0, 超时 30000ms');
  });
});
