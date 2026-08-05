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
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync as readSource } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { cancelMojoSessionById } from '../src/adapters/backend/mojo-backend.js';
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

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'botmux-mojo-orphan-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('buildEffectiveMojoConfig', () => {
  it('folds generic session settings in, with the mojo block winning', () => {
    const cfg = buildEffectiveMojoConfig(
      { model: 'block-model', bin: '/block/mojo' },
      {
        cliPathOverride: '/generic/mojo',
        workingDir: '/generic/dir',
        model: 'generic-model',
        disableCliBypass: true,
      },
    );
    // More specific block values win…
    expect(cfg.bin).toBe('/block/mojo');
    expect(cfg.model).toBe('block-model');
    // …and generic values fill the gaps.
    expect(cfg.cwd).toBe('/generic/dir');
    expect(cfg.disableCliBypass).toBe(true);
  });

  it('uses generic values when the mojo block is absent entirely', () => {
    const cfg = buildEffectiveMojoConfig(undefined, {
      cliPathOverride: '/generic/mojo',
      workingDir: '/generic/dir',
      model: 'generic-model',
    });
    expect(cfg.bin).toBe('/generic/mojo');
    expect(cfg.cwd).toBe('/generic/dir');
    expect(cfg.model).toBe('generic-model');
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

  it('preserves an explicit disableCliBypass:false instead of dropping it', () => {
    // `??` (not `||`) matters here — `false` is a real, meaningful value.
    const cfg = buildEffectiveMojoConfig({ disableCliBypass: false }, { disableCliBypass: true });
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
      const ok = await cancelMojoSessionById(cfg, 'sid-orphan-1');

      expect(ok).toBe(true);
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
      const ok = await cancelMojoSessionById(cfg, 'sid-orphan-2');
      expect(ok).toBe(true);
      const d = readDump(dump);
      expect(d.argv).toEqual(['session', 'cancel', 'sid-orphan-2']);
      expect(d.env.WRAPPER_MARK).toBe('wrapped');
    } finally {
      process.env.PATH = pathBefore;
      delete process.env.MOJO_DUMP;
    }
  }, 30_000);

  it('reports failure (and does not throw) when the binary is missing', async () => {
    const ok = await cancelMojoSessionById(
      { bin: join(root, 'definitely-not-here') },
      'sid-orphan-3',
    );
    // Best-effort by design: a dead session must not crash daemon teardown.
    expect(ok).toBe(false);
  }, 30_000);
});

describe('daemon wires the shared builder into the workerless path', () => {
  // The cancel itself is covered above with a real fake binary, but the daemon
  // call site lives inline in destroyOrphanedBackingSession and needs a full
  // DaemonSession + bot registry to exercise. A source assertion is the honest
  // way to pin it — this is the regression that reintroducing `botCfg.mojo ?? {}`
  // would cause, and it is otherwise invisible to the tests above.
  const src = readSource('src/core/worker-pool.ts', 'utf-8');

  it('passes a buildEffectiveMojoConfig result, not the bare mojo block', () => {
    const start = src.indexOf('function destroyOrphanedBackingSession');
    expect(start).toBeGreaterThanOrEqual(0);
    const region = src.slice(start, start + 3000);

    const builder = region.indexOf('buildEffectiveMojoConfig(botCfg.mojo');
    const call = region.indexOf('cancelMojoSessionById(launchCfg');
    expect(builder).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(builder);
    // The bare block must not be handed to the cancel helper.
    expect(region).not.toContain('cancelMojoSessionById(botCfg.mojo');
  });

  it('feeds the generic settings a dead worker cannot recover from SpawnOpts', () => {
    const start = src.indexOf('function destroyOrphanedBackingSession');
    const region = src.slice(start, start + 3000);
    for (const field of ['cliPathOverride', 'workingDir', 'env', 'wrapperCli']) {
      expect(region).toContain(`${field}:`);
    }
  });
});
