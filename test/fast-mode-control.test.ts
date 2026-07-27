import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  fastModeSessionSupported,
  parseFastModeAction,
  probeCodexFastServiceTier,
  requestWorkerFastModeChange,
} from '../src/core/fast-mode-control.js';
import { acknowledgeFastModeResult } from '../src/core/fast-mode-handshake.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex-rpc-server.mjs', import.meta.url));
beforeAll(() => { chmodSync(FIXTURE, 0o755); });

describe('Fast Mode control', () => {
  it('parses only the supported command actions', () => {
    expect(parseFastModeAction('/fast')).toBe('toggle');
    expect(parseFastModeAction('/fast on')).toBe('on');
    expect(parseFastModeAction('/FAST OFF')).toBe('off');
    expect(parseFastModeAction('/fast status')).toBe('status');
    expect(parseFastModeAction('/fast turbo')).toBe('invalid');
  });

  it('rejects non-Codex, adopted, and Aiden-wrapped sessions', () => {
    expect(fastModeSessionSupported({ cliId: 'codex' })).toBe(true);
    expect(fastModeSessionSupported({ cliId: 'claude-code' })).toBe(false);
    expect(fastModeSessionSupported({ cliId: 'codex', adopted: true })).toBe(false);
    expect(fastModeSessionSupported({ cliId: 'codex', wrapperCli: 'aiden x codex' })).toBe(false);
  });

  it('resolves the selected model Fast tier from app-server model/list', async () => {
    await expect(probeCodexFastServiceTier({
      cliBin: FIXTURE,
      cwd: '/tmp',
      env: process.env,
      model: 'gpt-fast',
    })).resolves.toEqual({
      ok: true,
      enabled: true,
      serviceTier: 'priority',
    });
  }, 20_000);

  it('fails closed when the selected model has no Fast tier', async () => {
    await expect(probeCodexFastServiceTier({
      cliBin: FIXTURE,
      cwd: '/tmp',
      env: process.env,
      model: 'gpt-standard',
    })).resolves.toEqual({
      ok: false,
      reason: 'unsupported_model',
    });
  }, 20_000);

  it('waits for the worker ACK instead of treating IPC send as success', async () => {
    let sent: any;
    const worker = {
      killed: false,
      connected: true,
      send(message: unknown, callback: (error: Error | null) => void) {
        sent = message;
        callback(null);
      },
    } as any;

    const pending = requestWorkerFastModeChange(worker, true, 1_000);
    await Promise.resolve();
    expect(sent).toMatchObject({ type: 'set_fast_mode', enabled: true });

    acknowledgeFastModeResult({
      type: 'fast_mode_result',
      requestId: sent.requestId,
      ok: true,
      enabled: true,
      serviceTier: 'priority',
    });
    await expect(pending).resolves.toEqual({
      ok: true,
      enabled: true,
      serviceTier: 'priority',
    });
  });
});
