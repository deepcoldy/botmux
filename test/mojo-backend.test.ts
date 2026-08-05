/**
 * Unit tests for MojoBackend — the stream/turn-boundary edge cases that are
 * easy to regress and expensive to debug in production.
 *
 * A fake `mojo` executable (a tiny shell script writing canned NDJSON) stands in
 * for the real binary, so these run with no @byted/mojo install and no JWT.
 * The pure-parser cases call `consume()` directly instead of going through a
 * subprocess, which is the only reliable way to control chunk boundaries.
 *
 * Run:  pnpm vitest run test/mojo-backend.test.ts
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MojoBackend } from '../src/adapters/backend/mojo-backend.js';
import type { EffectiveMojoConfig } from '../src/adapters/backend/mojo-types.js';

let binDir: string;

/** Write the fake mojo binary; `body` is bash executed on every invocation. */
function fakeMojo(body: string): string {
  const p = join(binDir, 'mojo');
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

interface TurnOutcome {
  out: string;
  taskIds: Array<string | null>;
}

/** Drive exactly one turn and resolve on its turn-boundary (onTaskDone). */
function runTurn(
  bin: string,
  prompt = 'hi',
  extra: Partial<EffectiveMojoConfig> = {},
): Promise<TurnOutcome> {
  return new Promise((resolve, reject) => {
    const backend = new MojoBackend({ bin, ...extra }, 'session-under-test');
    let out = '';
    const taskIds: Array<string | null> = [];
    backend.onData((d) => { out += d; });
    backend.onTaskId((id) => { taskIds.push(id); });
    backend.onTaskDone(() => resolve({ out, taskIds }));
    const timer = setTimeout(() => reject(new Error(`turn never settled; out=${out}`)), 30_000);
    timer.unref?.();
    backend.spawn('', [], {} as never);
    backend.write(prompt);
  });
}

beforeAll(() => { binDir = mkdtempSync(join(tmpdir(), 'mojo-fake-')); });
afterAll(() => { rmSync(binDir, { recursive: true, force: true }); });

describe('MojoBackend stream handling', () => {
  it('adopts the session id from the first init event and streams deltas once', async () => {
    const bin = fakeMojo(`cat <<'J'
a plain startup notice that is not json
{"type":"system","subtype":"init","session_id":"sid-42","model":"gpt-5.5-2026-04-24"}
{"type":"text_delta","text":"Hel"}
{"type":"text_delta","text":"lo\\nworld"}
{"type":"text","text":"Hello\\nworld"}
{"type":"result","status":"ok","result":"Hello world","session_id":"sid-42","warnings":[]}
J`);
    const { out, taskIds } = await runTurn(bin);

    // Lineage is published from the FIRST event, not recaptured at the end.
    expect(taskIds).toEqual(['sid-42']);
    // Bare \n must be normalized for xterm rendering.
    expect(out).toContain('lo\r\nworld');
    // --include-partial already rendered the text; the trailing whole-segment
    // `text` event must NOT duplicate it.
    expect(out.match(/Hello/g)?.length ?? 0).toBe(1);
    // A non-JSON startup notice must not leak into the transcript.
    expect(out).not.toContain('plain startup notice');
  });

  it('summarizes tool_call and both tool_result shapes', async () => {
    const bin = fakeMojo(`cat <<'J'
{"type":"system","subtype":"init","session_id":"sid-1"}
{"type":"tool_call","id":"t1","name":"Bash","input":{"command":"echo hi"}}
{"type":"tool_result","id":"t1","output":"{\\"return_code\\":0,\\"stdout\\":\\"hi\\\\n\\"}"}
{"type":"tool_result","id":"t2","output":"{\\"return_code\\":2,\\"stderr\\":\\"boom\\"}"}
{"type":"tool_result","id":"t3","output":"just prose"}
{"type":"result","status":"ok","result":"done","session_id":"sid-1","warnings":[]}
J`);
    const { out } = await runTurn(bin);
    expect(out).toContain('🔧 Bash');
    expect(out).toContain('↳ ✓ hi');
    expect(out).toContain('↳ ✗ exit 2 boom');
    expect(out).toContain('↳ just prose');
  });

  it('explains the auto-skipped ask-user turn instead of returning empty', async () => {
    const bin = fakeMojo(`cat <<'J'
{"type":"system","subtype":"init","session_id":"sid-9"}
{"type":"result","status":"cancelled","session_id":"sid-9","warnings":["agent 的提问（ask-user）在非交互模式下被自动跳过"],"error":{"code":"cancelled","message":"turn cancelled"}}
J
exit 1`);
    const { out } = await runTurn(bin);
    expect(out).toContain('被自动跳过');
    // The `cancelled` error is a CONSEQUENCE of the skip — surfacing both reads
    // as two unrelated failures.
    expect(out).not.toContain('turn cancelled');
    // `error` is an object; naive interpolation would print [object Object].
    expect(out).not.toContain('[object Object]');
  });

  it('formats an error object as [code] message', async () => {
    const bin = fakeMojo(`cat <<'J'
{"type":"system","subtype":"init","session_id":"sid-2"}
{"type":"result","status":"failed","session_id":"sid-2","warnings":[],"error":{"code":"rate_limited","message":"slow down","retryable":true}}
J`);
    const { out } = await runTurn(bin);
    expect(out).toContain('[rate_limited] slow down');
    expect(out).not.toContain('[object Object]');
  });

  it('retries the still-RUNNING race with backoff and never shows it to the user', async () => {
    const counter = join(binDir, 'attempts');
    writeFileSync(counter, '0');
    const bin = fakeMojo(`N=$(cat ${counter}); echo $((N+1)) > ${counter}
if [ "$N" = "0" ]; then
  echo "mojo: 会话 sid-9 正在执行中（RUNNING），稍后再试" >&2
  exit 1
fi
cat <<'J'
{"type":"system","subtype":"init","session_id":"sid-9"}
{"type":"result","status":"ok","result":"after retry","session_id":"sid-9","warnings":[]}
J`);
    const { out } = await runTurn(bin);
    expect(out).toContain('after retry');
    expect(out).not.toContain('❌');
  });

  it('reports an invalid model with the authoritative list from stderr', async () => {
    const bin = fakeMojo(`echo "未知模型 nope。可用模型：alpha、beta" >&2
exit 2`);
    const { out } = await runTurn(bin, 'hi', { model: 'nope' });
    expect(out).toContain('模型名无效');
    expect(out).toContain('可用模型：alpha、beta');
  });

  it('drops a dead resume lineage so the next message starts fresh', async () => {
    const bin = fakeMojo(`echo "mojo: 会话 sid-old 不存在" >&2
exit 1`);
    // resumeCliSessionId makes this turn pass `-r sid-old`.
    const { out, taskIds } = await runTurn(bin, 'hi', { resumeCliSessionId: 'sid-old' });
    // onTaskId fires once with the restored id, then null to clear the
    // daemon-side persisted lineage.
    expect(taskIds).toEqual(['sid-old', null]);
    expect(out).toContain('已失效');
  });

  it('does NOT drop the lineage when no resume was attempted', async () => {
    const bin = fakeMojo(`echo "mojo: 会话 whatever 不存在" >&2
exit 1`);
    const { taskIds } = await runTurn(bin);
    expect(taskIds).not.toContain(null);
  });

  it('reports a non-zero exit that produced no result event', async () => {
    const bin = fakeMojo(`echo "boom: something broke" >&2
exit 3`);
    const { out } = await runTurn(bin);
    expect(out).toContain('退出码 3');
    expect(out).toContain('something broke');
  });
});

describe('MojoBackend NDJSON framing', () => {
  /** Access the private incremental parser without going through a subprocess. */
  function parser() {
    const backend = new MojoBackend({}, 'session-framing');
    let out = '';
    const taskIds: Array<string | null> = [];
    let done = 0;
    backend.onData((d) => { out += d; });
    backend.onTaskId((id) => { taskIds.push(id); });
    backend.onTaskDone(() => { done += 1; });
    const inner = backend as unknown as {
      consume(chunk: string): void;
      flushTail(): void;
      turnSettled: boolean;
    };
    // A real turn clears this before reading stdout; emulate an in-flight turn.
    inner.turnSettled = false;
    return {
      feed: (chunk: string) => inner.consume(chunk),
      flush: () => inner.flushTail(),
      get out() { return out; },
      get taskIds() { return taskIds; },
      get done() { return done; },
    };
  }

  it('buffers a JSON line split across chunk boundaries', () => {
    const p = parser();
    // Split mid-key, mid-value and mid-escape — one event, three chunks.
    p.feed('{"type":"system","subtype":"init","sess');
    p.feed('ion_id":"sid-split"}\n{"type":"text","te');
    p.feed('xt":"tail\\nend"}\n');
    expect(p.taskIds).toEqual(['sid-split']);
    expect(p.out).toContain('tail\r\nend');
  });

  it('handles several events arriving in one chunk', () => {
    const p = parser();
    p.feed(
      '{"type":"system","subtype":"init","session_id":"sid-multi"}\n'
      + '{"type":"text","text":"one"}\n'
      + '{"type":"text","text":"two"}\n',
    );
    expect(p.taskIds).toEqual(['sid-multi']);
    expect(p.out).toContain('one');
    expect(p.out).toContain('two');
  });

  it('parses a final line that never got its trailing newline', () => {
    const p = parser();
    p.feed('{"type":"result","status":"ok","result":"no trailing newline","session_id":"s","warnings":[]}');
    // Still buffered — no newline yet.
    expect(p.done).toBe(0);
    p.flush();
    expect(p.done).toBe(1);
    expect(p.out).toContain('no trailing newline');
  });

  it('ignores an unparseable line without settling or crashing the turn', () => {
    const p = parser();
    p.feed('{this is not json}\n');
    expect(p.done).toBe(0);
    expect(p.out).toBe('');
  });

  it('fires the turn boundary exactly once per result event', () => {
    const p = parser();
    p.feed('{"type":"result","status":"ok","result":"x","session_id":"s","warnings":[]}\n');
    expect(p.done).toBe(1);
    // A late duplicate result (or a process exit after settle) must not re-fire.
    p.feed('{"type":"result","status":"ok","result":"y","session_id":"s","warnings":[]}\n');
    expect(p.done).toBe(1);
  });
});

describe('MojoBackend.applyLivePatch', () => {
  /** Records X_JWT_TOKEN for EVERY invocation, so turn 2 can be compared to turn 1. */
  function jwtRecordingMojo(dumpPath: string): string {
    const p = join(binDir, 'mojo');
    writeFileSync(p, `#!/usr/bin/env bash
echo "$X_JWT_TOKEN" >> ${dumpPath}
echo '{"type":"system","subtype":"init","session_id":"sid-jwt"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-jwt","warnings":[]}'
`);
    chmodSync(p, 0o755);
    return p;
  }

  it('a rotated JWT reaches the NEXT turn without a refork', async () => {
    // The bug: config was read once at worker init, so every later per-turn
    // invocation kept using the original token — a rotated credential never took
    // effect, contradicting the "credentials stay live" contract.
    const dump = join(binDir, 'jwts.txt');
    const bin = jwtRecordingMojo(dump);
    const backend = new MojoBackend({ bin, jwt: 'original-token' }, 'session-jwt');

    const turn = () => new Promise<void>((resolveTurn) => {
      backend.onTaskDone(() => resolveTurn());
      backend.write('hi');
    });

    backend.spawn('', [], {} as never);
    await turn();
    backend.applyLivePatch({ jwt: 'rotated-token' });
    await turn();

    const seen = readFileSync(dump, 'utf-8').trim().split('\n');
    expect(seen).toEqual(['original-token', 'rotated-token']);
  }, 30_000);

  it('ignores control-plane keys in a patch', () => {
    // A patch must never become the escape hatch for the frozen control plane.
    const backend = new MojoBackend({ cloud: true, baseUrl: 'https://tenant-a.example.com' }, 's');
    backend.applyLivePatch({ jwt: 'x', ...{ baseUrl: 'https://tenant-b.example.com', cloud: false } } as never);
    const cfg = (backend as unknown as { config: Record<string, unknown> }).config;
    expect(cfg.baseUrl).toBe('https://tenant-a.example.com');
    expect(cfg.cloud).toBe(true);
    expect(cfg.jwt).toBe('x');
  });

  it('is a no-op when nothing actually changed', () => {
    const backend = new MojoBackend({ jwt: 'same' }, 's');
    const before = { ...(backend as unknown as { config: Record<string, unknown> }).config };
    backend.applyLivePatch({ jwt: 'same' });
    expect((backend as unknown as { config: Record<string, unknown> }).config).toEqual(before);
  });
});
