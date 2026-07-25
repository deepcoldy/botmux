import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  AbortDeadlineError,
  hasExactSafeJsonKeys,
  JsonBodyTooLargeError,
  readJsonBody,
  runWithAbortDeadline,
} from '../src/core/dashboard-ipc-server.js';

function requestFrom(text: string): import('node:http').IncomingMessage {
  return Readable.from([Buffer.from(text)]) as unknown as import('node:http').IncomingMessage;
}

describe('Codex notifier ingress boundaries', () => {
  it('rejects an oversized body before attempting JSON parsing', async () => {
    const invalidJson = `{"value":"${'x'.repeat(64)}`;
    await expect(readJsonBody(requestFrom(invalidJson), 16))
      .rejects.toBeInstanceOf(JsonBodyTooLargeError);
  });

  it('still parses a body at the configured byte limit', async () => {
    const body = JSON.stringify({ ok: true });
    await expect(readJsonBody(requestFrom(body), Buffer.byteLength(body)))
      .resolves.toEqual({ ok: true });
  });

  it('accepts only the exact safe legacy envelope shape', () => {
    const valid = JSON.parse('{"pluginId":"codex-watch","targetBotAppId":"app","event":{}}');
    expect(hasExactSafeJsonKeys(valid, ['pluginId', 'targetBotAppId', 'event'])).toBe(true);
    expect(hasExactSafeJsonKeys({ ...valid, extra: true }, ['pluginId', 'targetBotAppId', 'event']))
      .toBe(false);
    expect(hasExactSafeJsonKeys(
      JSON.parse('{"pluginId":"codex-watch","targetBotAppId":"app","event":{},"__proto__":{}}'),
      ['pluginId', 'targetBotAppId', 'event'],
    )).toBe(false);
    expect(hasExactSafeJsonKeys(
      Object.create({ pluginId: 'codex-watch', targetBotAppId: 'app', event: {} }),
      ['pluginId', 'targetBotAppId', 'event'],
    )).toBe(false);
  });

  it('aborts the underlying operation when the deadline expires', async () => {
    let capturedSignal: AbortSignal | undefined;
    const pending = runWithAbortDeadline('adoption', 20, signal => {
      capturedSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    await expect(pending).rejects.toBeInstanceOf(AbortDeadlineError);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('clears the deadline after a successful operation', async () => {
    await expect(runWithAbortDeadline('delivery', 100, async signal => {
      expect(signal.aborted).toBe(false);
      return 'ok';
    })).resolves.toBe('ok');
  });
});
