/**
 * Tests for the workerless `/close` path and the shared launch-config builder.
 *
 * Why these exist: cancelling an orphaned mojo session runs in the DAEMON, which
 * never calls spawn() and therefore cannot pick up cwd/env/bin from SpawnOpts. So
 * a bot that ran fine on a pinned binary and a per-bot JWT could not be cancelled
 * once its worker died — the remote session kept burning cloud sandbox time while
 * still holding injected credentials. The fix is one shared builder used by both
 * sides; these tests pin that it is actually honoured, using a real fake `mojo`.
 *
 * Run:  pnpm vitest run test/mojo-orphan-cancel.test.ts
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { cancelMojoSessionById } from '../src/adapters/backend/mojo-backend.js';
import { isMojoRemoteGone } from '../src/adapters/backend/mojo-types.js';
import { buildEffectiveMojoConfig } from '../src/adapters/backend/mojo-types.js';

let root: string;

/** A fake mojo that records how it was invoked and returns a valid envelope. */
function writeRecordingMojo(fileName: string): string {
  const bin = join(root, fileName);
  writeFileSync(bin, `#!/usr/bin/env bash
export SELF="$0"
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.env.MOJO_DUMP, JSON.stringify({
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    self: process.env.SELF,
    env: {
      X_JWT_TOKEN: process.env.X_JWT_TOKEN,
      PER_BOT_TOKEN: process.env.PER_BOT_TOKEN,
      WRAPPER_MARK: process.env.WRAPPER_MARK,
    },
  }, null, 2));
' -- "$@"
echo '{"operation":"session.cancel","state":"ABORTED"}'
`);
  chmodSync(bin, 0o755);
  return bin;
}

interface Dump {
  argv: string[];
  cwd: string;
  self: string;
  env: Record<string, string | undefined>;
}

function readDump(dumpPath: string): Dump {
  return JSON.parse(readFileSync(dumpPath, 'utf-8')) as Dump;
}

// realpathSync: on macOS os.tmpdir() is a symlink (/var → /private/var), so a
// child process reports the RESOLVED cwd and a raw comparison would fail there.
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mojo-orphan-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('buildEffectiveMojoConfig', () => {
  it('takes the launch identity ONLY from the generic (frozen) source', () => {
    // Previously the block won for bin/model, which let a live `mojo.bin` added
    // after session creation override the FROZEN cliPathOverride — the workerless
    // cancel would then run a different binary than the one that created the
    // remote session. Both config entry points now reject these keys, so a value
    // reaching here means a hand-edited file and must be ignored, not honoured.
    const cfg = buildEffectiveMojoConfig(
      {
        bin: '/live/new-mojo',
        model: 'live-model',
        wrapperCli: 'env FROM_BLOCK=1 mojo',
        disableCliBypass: false,
        cwd: '/live/dir',
      } as never,
      {
        cliPathOverride: '/frozen/session-mojo',
        model: 'frozen-model',
        workingDir: '/frozen/dir',
        disableCliBypass: true,
        wrapperCli: 'env FROM_TOP=1 mojo',
      },
    );
    expect(cfg.bin).toBe('/frozen/session-mojo');
    expect(cfg.model).toBe('frozen-model');
    expect(cfg.cwd).toBe('/frozen/dir');
    expect(cfg.disableCliBypass).toBe(true);
    expect(cfg.wrapperCli).toBe('env FROM_TOP=1 mojo');
  });

  it('drops internal keys entirely when the generic source has none', () => {
    // Not "block wins because generic is absent" — the block is never a source
    // for these, so the result must be undefined rather than the live value.
    const cfg = buildEffectiveMojoConfig(
      { bin: '/live/new-mojo', model: 'live-model', wrapperCli: 'env X=1 mojo' } as never,
      {},
    );
    expect(cfg.bin).toBeUndefined();
    expect(cfg.model).toBeUndefined();
    expect(cfg.wrapperCli).toBeUndefined();
  });

  it('keeps genuinely mojo-specific block settings', () => {
    const cfg = buildEffectiveMojoConfig(
      { cloud: true, workspaceId: 'ws-1', idleTimeoutSec: 30, jwt: 'j' },
      { workingDir: '/dir' },
    );
    expect(cfg.cloud).toBe(true);
    expect(cfg.workspaceId).toBe('ws-1');
    expect(cfg.idleTimeoutSec).toBe(30);
    expect(cfg.jwt).toBe('j');
    expect(cfg.cwd).toBe('/dir');
  });

  it('layers env with the mojo block on top of per-bot env', () => {
    const cfg = buildEffectiveMojoConfig(
      { env: { SHARED: 'from-block' } },
      { env: { SHARED: 'from-per-bot', ONLY_PER_BOT: 'kept' } },
    );
    expect(cfg.env).toEqual({ SHARED: 'from-block', ONLY_PER_BOT: 'kept' });
  });

  it('treats a blank override as unset rather than as an empty bin', () => {
    // An empty string would otherwise become `spawn('')`.
    expect(buildEffectiveMojoConfig(undefined, { cliPathOverride: '   ' }).bin).toBeUndefined();
    expect(buildEffectiveMojoConfig(undefined, { wrapperCli: '  ' }).wrapperCli).toBeUndefined();
  });

  it('preserves an explicit generic disableCliBypass:false', () => {
    // `!== undefined` (not `||`) matters here — `false` is a real, meaningful
    // value meaning "do add --yolo", and must not be treated as absent.
    const cfg = buildEffectiveMojoConfig(undefined, { disableCliBypass: false });
    expect(cfg.disableCliBypass).toBe(false);
  });
});

describe('workerless orphan cancel', () => {
  it('runs the pinned binary and carries the per-bot JWT', async () => {
    const dump = join(root, 'cancel.json');
    const bin = writeRecordingMojo('mojo-pinned');
    process.env.MOJO_DUMP = dump;
    try {
      // Exactly what the daemon now builds for a dead worker.
      const cfg = buildEffectiveMojoConfig(undefined, {
        cliPathOverride: bin,
        workingDir: root,
        env: { X_JWT_TOKEN: 'per-bot-jwt', PER_BOT_TOKEN: 'per-bot-value' },
      });
      const outcome = await cancelMojoSessionById(cfg, 'sid-orphan-1');

      expect(outcome).toEqual({ kind: 'cancelled' });
      expect(existsSync(dump)).toBe(true);
      const d = readDump(dump);
      // The pinned binary ran — not a bare `mojo` off PATH.
      expect(d.self).toBe(bin);
      expect(d.argv).toEqual(['session', 'cancel', 'sid-orphan-1']);
      // The per-bot identity reached the cancel call.
      expect(d.env.X_JWT_TOKEN).toBe('per-bot-jwt');
      expect(d.env.PER_BOT_TOKEN).toBe('per-bot-value');
      expect(d.cwd).toBe(root);
    } finally {
      delete process.env.MOJO_DUMP;
    }
  }, 30_000);

  it('applies the wrapperCli prefix on the cancel invocation too', async () => {
    const dump = join(root, 'cancel-wrapped.json');
    writeRecordingMojo('mojo');
    process.env.MOJO_DUMP = dump;
    // NOTE: a wrapperCli names its own target (`… mojo`), and that name is
    // resolved on PATH — it deliberately does NOT inherit cliPathOverride. This
    // is pre-existing wrapperCli semantics shared with the other CLIs, so the
    // fake binary has to be discoverable on PATH here, exactly as in production.
    const pathBefore = process.env.PATH;
    process.env.PATH = `${root}:${pathBefore ?? ''}`;
    try {
      const cfg = buildEffectiveMojoConfig(undefined, {
        wrapperCli: 'env WRAPPER_MARK=wrapped mojo',
      });
      // The daemon has no worker to resolve the prefix, so the backend resolves it
      // from the config itself — otherwise a wrapper-dependent setup (a gateway
      // injecting auth, say) would be unreachable exactly at teardown.
      const outcome = await cancelMojoSessionById(cfg, 'sid-orphan-2');
      expect(outcome).toEqual({ kind: 'cancelled' });
      const d = readDump(dump);
      expect(d.argv).toEqual(['session', 'cancel', 'sid-orphan-2']);
      expect(d.env.WRAPPER_MARK).toBe('wrapped');
    } finally {
      process.env.PATH = pathBefore;
      delete process.env.MOJO_DUMP;
    }
  }, 30_000);

  it('does NOT apply a wrapper that exists only in the mojo block', async () => {
    // This is the exact divergence review reproduced: the worker builds its prefix
    // from the top-level wrapperCli only, but the cancel path resolves the prefix
    // from config — so a block-only wrapper meant "run bare, cancel wrapped",
    // potentially cancelling through a different gateway/tenant than the one that
    // created the remote session. buildEffectiveMojoConfig now drops it.
    const dump = join(root, 'cancel-block-wrapper.json');
    writeRecordingMojo('mojo');
    process.env.MOJO_DUMP = dump;
    const pathBefore = process.env.PATH;
    process.env.PATH = `${root}:${pathBefore ?? ''}`;
    try {
      const cfg = buildEffectiveMojoConfig(
        // A hand-edited bots.json could still contain this; `/config set mojo`
        // rejects it outright.
        { wrapperCli: 'env WRAPPER_MARK=nested mojo' } as never,
        { cliPathOverride: join(root, 'mojo') },
      );
      expect(cfg.wrapperCli).toBeUndefined();

      const outcome = await cancelMojoSessionById(cfg, 'sid-orphan-4');
      expect(outcome).toEqual({ kind: 'cancelled' });
      expect(readDump(dump).env.WRAPPER_MARK).toBeUndefined();
    } finally {
      process.env.PATH = pathBefore;
      delete process.env.MOJO_DUMP;
    }
  }, 30_000);

  it('reports failure (and does not throw) when the binary is missing', async () => {
    const outcome = await cancelMojoSessionById(
      { bin: join(root, 'definitely-not-here') },
      'sid-orphan-3',
    );
    // Must not throw (daemon teardown runs this), and must NOT be reported as
    // gone: an unreachable binary proves nothing about the remote session, so it
    // has to fail closed and stay retryable.
    expect(outcome.kind).toBe('failed');
    expect(isMojoRemoteGone(outcome)).toBe(false);
    if (outcome.kind === 'failed') expect(outcome.retryable).toBe(true);
  }, 30_000);
});
