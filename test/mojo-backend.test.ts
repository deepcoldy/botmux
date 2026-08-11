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
import {
  MOJO_EXPLICIT_CLOSE_HEADROOM_MS,
  MOJO_EXPLICIT_CLOSE_RESULT_TIMEOUT_MS,
  MOJO_CLI_TIMEOUT_MS,
  MOJO_DESTROY_SETTLE_MS,
} from '../src/adapters/backend/mojo-budgets.js';
import type { EffectiveMojoConfig } from '../src/adapters/backend/mojo-types.js';

let binDir: string;

describe('Mojo close budgets', () => {
  it('keeps enough daemon headroom above settle plus CLI cancellation', () => {
    expect(MOJO_EXPLICIT_CLOSE_RESULT_TIMEOUT_MS).toBe(
      MOJO_DESTROY_SETTLE_MS + MOJO_CLI_TIMEOUT_MS + MOJO_EXPLICIT_CLOSE_HEADROOM_MS,
    );
    expect(MOJO_EXPLICIT_CLOSE_HEADROOM_MS).toBeGreaterThanOrEqual(5_000);
  });
});

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

describe('MojoBackend spawn contract', () => {
  it('refuses an unexpected launch wrapper instead of silently dropping it', () => {
    // spawn() assumed any non-empty bin could only be wrapperCli, because the
    // FILE sandbox is refused for this backend before spawn. But MANDATORY
    // device-credential isolation is a second, independent wrapping path
    // (read-isolation.ts: "independent of the optional bot sandbox toggle"), and
    // it rewrites spawnBin whenever the host is enrolled and the session is not
    // provably remote — e.g. a mojo bot with no `cloud` set. With wrapperCli
    // unset, the old code dropped that wrapper AND fed its argv to mojo as
    // extraCliArgs: the credential boundary silently disappeared.
    const backend = new MojoBackend({ bin: '/usr/bin/mojo' }, 'sid-wrap');
    expect(() => backend.spawn('/usr/bin/bwrap', ['--dev-bind', '/', '/', '/usr/bin/mojo'], {} as never))
      .toThrow(/unexpected launch wrapper/i);
  });

  it('still accepts a wrapper that came from wrapperCli', () => {
    const backend = new MojoBackend(
      { bin: '/usr/bin/mojo', wrapperCli: 'mywrap mojo' },
      'sid-wrap-ok',
    );
    expect(() => backend.spawn('/usr/bin/mywrap', [], {} as never)).not.toThrow();
  });

  it('still treats bare args as extra CLI args when no wrapper binary is given', () => {
    // Back-compat path for a caller that has not been updated: args without a
    // bin are generic CLI_EXTRA_ARGS, not a wrapper.
    const backend = new MojoBackend({ bin: '/usr/bin/mojo' }, 'sid-extra');
    expect(() => backend.spawn('', ['--verbose'], {} as never)).not.toThrow();
  });
});

describe('MojoBackend teardown', () => {
  it('cancels the remote session even when /close lands before the init event', async () => {
    // Race: destroySession() read cliSessionId immediately, but that id only
    // exists after the first `system/init` line is parsed. A /close inside the
    // "turn dispatched, init not yet arrived" window therefore skipped the cancel
    // AND never fired taskIdCb, so the daemon's orphan fallback had no id either —
    // the remote session leaked, still holding the injected X_JWT_TOKEN and
    // burning cloud sandbox time.
    const argvLog = join(binDir, 'argv.log');
    const bin = fakeMojo(`echo "$@" >> ${argvLog}
if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
# A turn: the init line is deliberately LATE, so /close lands before it.
sleep 0.6
echo '{"type":"system","subtype":"init","session_id":"sid-late"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-late","warnings":[]}'`);

    const backend = new MojoBackend({ bin }, 'session-under-test');
    const taskIds: Array<string | null> = [];
    backend.onTaskId((id) => { taskIds.push(id); });
    backend.spawn('', [], {} as never);
    backend.write('a turn that is still in flight');

    // Close INSIDE the window: the turn is dispatched, init has not arrived.
    await new Promise<void>(r => setTimeout(r, 100));
    expect(backend.cliSessionIdForTest).toBeUndefined();
    await expect(backend.destroySession()).resolves.toEqual({
      ok: true,
      taskId: 'sid-late',
    });

    const argv = readFileSync(argvLog, 'utf-8');
    expect(argv, `argv was:\n${argv}`).toContain('session cancel sid-late');
    // The lineage must also reach the daemon, so its orphan fallback can retry.
    expect(taskIds).toContain('sid-late');
  });

  it('returns a failed prepare with the exact known lineage when cancel fails', async () => {
    const bin = fakeMojo(`if [ "$1" = "session" ]; then echo 'cancel failed' >&2; exit 1; fi
echo '{"type":"system","subtype":"init","session_id":"sid-known"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-known","warnings":[]}'`);
    const backend = new MojoBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('start');

    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-known'));
    await expect(backend.destroySession()).resolves.toMatchObject({
      ok: false,
      taskId: 'sid-known',
      error: expect.stringContaining('cancel failed'),
    });
    // A failed prepare is reversible: write admission can be restored for retry.
    backend.abortDestroySession();
  });
});

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
  /** Records X_JWT_TOKEN for EVERY invocation, so turns can be compared. */
  function jwtRecordingMojo(dumpPath: string): string {
    const p = join(binDir, 'mojo');
    writeFileSync(p, `#!/usr/bin/env bash
echo "[$X_JWT_TOKEN]" >> ${dumpPath}
echo '{"type":"system","subtype":"init","session_id":"sid-jwt"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-jwt","warnings":[]}'
`);
    chmodSync(p, 0o755);
    return p;
  }

  /** Drive N turns, applying a patch between each. */
  async function turns(
    backend: MojoBackend,
    patches: Array<{ jwt?: string | null } | undefined>,
    spawnEnv: Record<string, string> = {},
  ): Promise<void> {
    const one = () => new Promise<void>((done) => {
      backend.onTaskDone(() => done());
      backend.write('hi');
    });
    // Explicit env: this host has an ambient X_JWT_TOKEN, and buildEnv falls back
    // to it by design ("cleared" means "use the host login"). Passing a clean env
    // isolates what the PATCH did from what the host provides.
    backend.spawn('', [], { env: spawnEnv } as never);
    for (const patch of patches) {
      if (patch) backend.applyLivePatch(patch);
      await one();
    }
  }

  function seen(dumpPath: string): string[] {
    return readFileSync(dumpPath, 'utf-8').trim().split('\n');
  }

  it('rotates A → B on the next turn without a refork', async () => {
    const dump = join(binDir, 'rotate.txt');
    const bin = jwtRecordingMojo(dump);
    const backend = new MojoBackend({ bin, jwt: 'A' }, 's');
    await turns(backend, [undefined, { jwt: 'B' }]);
    expect(seen(dump)).toEqual(['[A]', '[B]']);
  }, 30_000);

  it('rolls back B → A (the daemon cannot diff against its init snapshot)', async () => {
    // Comparing the live config to the INIT snapshot made this look like "no
    // change", leaving the backend on B indefinitely.
    const dump = join(binDir, 'rollback.txt');
    const bin = jwtRecordingMojo(dump);
    const backend = new MojoBackend({ bin, jwt: 'A' }, 's');
    await turns(backend, [undefined, { jwt: 'B' }, { jwt: 'A' }]);
    expect(seen(dump)).toEqual(['[A]', '[B]', '[A]']);
  }, 40_000);

  it('CLEARS the credential on a null tombstone', async () => {
    // Deleting mojo.jwt used to leave the old token alive for the worker's whole
    // lifetime, because both the picker and the applier skipped `undefined`.
    const dump = join(binDir, 'clear.txt');
    const bin = jwtRecordingMojo(dump);
    const backend = new MojoBackend({ bin, jwt: 'A' }, 's');
    await turns(backend, [undefined, { jwt: null }]);
    expect(seen(dump)).toEqual(['[A]', '[]']);
  }, 30_000);

  it('a cleared credential does NOT fall back to an inherited one', async () => {
    // Semantics tightened per review: the daemon already folds the ambient
    // fallback into the snapshot it sends, so `null` means "no credential from any
    // layer". Previously a clear only unset config.jwt and buildEnv re-read
    // jwtEnv from the init-time env, reviving a stale token.
    const dump = join(binDir, 'clear-nofallback.txt');
    const bin = jwtRecordingMojo(dump);
    const backend = new MojoBackend({ bin, jwt: 'A' }, 's');
    await turns(backend, [undefined, { jwt: null }], { X_JWT_TOKEN: 'inherited' });
    expect(seen(dump)).toEqual(['[A]', '[]']);
  }, 30_000);

  it('a cleared credential also ignores a stale jwtEnv source', async () => {
    const dump = join(binDir, 'clear-jwtenv.txt');
    const bin = jwtRecordingMojo(dump);
    const backend = new MojoBackend(
      { bin, jwtEnv: 'MY_JWT', env: { MY_JWT: 'stale-A' } },
      's',
    );
    await turns(backend, [undefined, { jwt: null }]);
    expect(seen(dump)).toEqual(['[stale-A]', '[]']);
  }, 30_000);

  it('ignores an undefined jwt (the daemon had nothing to say)', async () => {
    const dump = join(binDir, 'noop.txt');
    const bin = jwtRecordingMojo(dump);
    const backend = new MojoBackend({ bin, jwt: 'A' }, 's');
    await turns(backend, [undefined, {}]);
    expect(seen(dump)).toEqual(['[A]', '[A]']);
  }, 30_000);


  it('cannot be used to change the control plane or the launcher', () => {
    // The patch now lands in a dedicated `liveJwt` field rather than mutating
    // config, so the frozen launch identity is structurally out of reach.
    const backend = new MojoBackend(
      { cloud: true, baseUrl: 'https://tenant-a.example.com', bin: '/frozen/mojo' },
      's',
    );
    backend.applyLivePatch({
      jwt: 'x',
      ...{ baseUrl: 'https://tenant-b.example.com', cloud: false, bin: '/evil/mojo', env: { PATH: '/evil' } },
    } as never);
    const inner = backend as unknown as {
      config: Record<string, unknown>;
      liveJwt: string | null | undefined;
    };
    expect(inner.config.baseUrl).toBe('https://tenant-a.example.com');
    expect(inner.config.cloud).toBe(true);
    expect(inner.config.bin).toBe('/frozen/mojo');
    expect(inner.config.env).toBeUndefined();
    expect(inner.liveJwt).toBe('x');
  });

  it('resolves the binary on the EFFECTIVE child PATH, not the daemon ambient one', async () => {
    // locateOnPath reads THIS process's env, so a per-bot PATH was ignored and the
    // child ran a different install than the one that was pinned — changing the
    // documented semantics of per-bot env.
    const perBotDir = mkdtempSync(join(tmpdir(), 'mojo-perbot-'));
    const perBotBin = join(perBotDir, 'mojo');
    writeFileSync(perBotBin, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(perBotBin, 0o755);
    try {
      const backend = new MojoBackend({}, 's');
      // injectEnv is the per-bot layer the worker hands over at spawn.
      backend.spawn('', [], { env: { PATH: '/nonexistent' }, injectEnv: { PATH: perBotDir } } as never);
      expect((backend as unknown as { resolveBin(): string }).resolveBin()).toBe(perBotBin);
    } finally {
      rmSync(perBotDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('lets mojo.env PATH win over the per-bot layer, matching buildEnv', async () => {
    const a = mkdtempSync(join(tmpdir(), 'mojo-a-'));
    const b = mkdtempSync(join(tmpdir(), 'mojo-b-'));
    for (const d of [a, b]) {
      writeFileSync(join(d, 'mojo'), '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(join(d, 'mojo'), 0o755);
    }
    try {
      const backend = new MojoBackend({ env: { PATH: b } }, 's');
      backend.spawn('', [], { env: {}, injectEnv: { PATH: a } } as never);
      expect((backend as unknown as { resolveBin(): string }).resolveBin()).toBe(join(b, 'mojo'));
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  }, 30_000);

  it('pins the binary once, so a later PATH change cannot swap it', async () => {
    // Belt and braces: env is no longer patchable, but the binary was previously
    // re-resolved from PATH on every turn.
    const dump = join(binDir, 'pin.txt');
    jwtRecordingMojo(dump);
    const backend = new MojoBackend({}, 's');
    const pathBefore = process.env.PATH;
    process.env.PATH = `${binDir}:${pathBefore ?? ''}`;
    try {
      backend.spawn('', [], {} as never);
      const first = (backend as unknown as { resolveBin(): string }).resolveBin();
      // Point PATH somewhere else entirely.
      process.env.PATH = '/nonexistent';
      expect((backend as unknown as { resolveBin(): string }).resolveBin()).toBe(first);
    } finally {
      process.env.PATH = pathBefore;
    }
  }, 30_000);
});
