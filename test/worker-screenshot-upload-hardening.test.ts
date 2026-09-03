import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function functionSlice(name: string, nextName: string): string {
  const asyncStart = source.indexOf(`async function ${name}`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

type CaptureHarness = {
  captureAndUpload(): Promise<void>;
  inFlight(): boolean;
  lastHash(): string;
  setLastHash(hash: string): void;
};

function executeProductionCapture(deps: Record<string, unknown>): CaptureHarness {
  // worker.ts is an executable process entrypoint and cannot be imported into a
  // unit test safely. Compile its exact production function body instead, then
  // inject only the globals used by the screenshot path under test.
  const captureJs = ts.transpileModule(
    functionSlice('captureAndUpload', 'applyDisplayMode'),
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const factory = new Function('deps', `
    const {
      logScreenshotSkip, snapshotToPng, backend, renderCols, renderRows,
      renderer, createHash, clamp, captureToPng, uploadImageBuffer, logError,
      projectedRuntimeScreenStatus, send, classifyScreenUsageLimit,
      currentBotmuxTurnId, currentBotmuxDispatchAttempt,
    } = deps;
    let displayMode = 'screenshot';
    let awaitingFirstPrompt = false;
    let apiOnlyForUpload = false;
    let larkAppIdForUpload = 'app';
    let larkAppSecretForUpload = 'secret';
    let larkBrandForUpload = 'feishu';
    let screenshotCaptureInFlight = false;
    let lastShotHash = '';
    ${captureJs}
    return {
      captureAndUpload,
      inFlight: () => screenshotCaptureInFlight,
      lastHash: () => lastShotHash,
      setLastHash: (hash) => { lastShotHash = hash; },
    };
  `);
  return factory(deps) as CaptureHarness;
}

afterEach(() => vi.useRealTimers());

describe('worker screenshot upload hardening', () => {
  it('single-flights a hanging upload, stays responsive, then retries the failed unchanged frame', async () => {
    vi.useFakeTimers();

    let frame = 'same-frame';
    let concurrentUploads = 0;
    let maxConcurrentUploads = 0;
    let uploadCalls = 0;
    let rejectFirstUpload!: (error: Error) => void;
    const snapshotToPng = vi.fn(async () => ({
      ansi: frame,
      png: Buffer.from('png'),
      content: frame,
    }));
    const uploadImageBuffer = vi.fn(async () => {
      uploadCalls += 1;
      concurrentUploads += 1;
      maxConcurrentUploads = Math.max(maxConcurrentUploads, concurrentUploads);
      if (uploadCalls === 1) {
        return await new Promise<string>((_resolve, reject) => {
          rejectFirstUpload = (error) => {
            concurrentUploads -= 1;
            reject(error);
          };
        });
      }
      concurrentUploads -= 1;
      return `img_${uploadCalls}`;
    });
    const send = vi.fn();
    const messageCallback = vi.fn();
    const harness = executeProductionCapture({
      logScreenshotSkip: vi.fn(),
      snapshotToPng,
      backend: {},
      renderCols: 80,
      renderRows: 24,
      renderer: null,
      createHash: vi.fn(),
      clamp: vi.fn(),
      captureToPng: vi.fn(),
      uploadImageBuffer,
      logError: vi.fn(),
      projectedRuntimeScreenStatus: () => 'working',
      send,
      classifyScreenUsageLimit: () => ({ status: 'working' }),
      currentBotmuxTurnId: 'turn_1',
      currentBotmuxDispatchAttempt: 1,
    });

    const firstCapture = harness.captureAndUpload();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.inFlight()).toBe(true);
    expect(uploadCalls).toBe(1);

    const ticker = setInterval(() => { void harness.captureAndUpload(); }, 10_000);
    setTimeout(messageCallback, 5_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(messageCallback).toHaveBeenCalledOnce();
    expect(snapshotToPng).toHaveBeenCalledOnce();
    expect(uploadCalls).toBe(1);
    expect(maxConcurrentUploads).toBe(1);
    expect(send).not.toHaveBeenCalled();

    rejectFirstUpload(new Error('token request timed out'));
    await firstCapture;
    expect(harness.inFlight()).toBe(false);
    expect(harness.lastHash()).toBe('');

    await harness.captureAndUpload();
    expect(uploadCalls).toBe(2);
    expect(snapshotToPng).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledOnce();
    expect(harness.lastHash()).toBe('same-frame');
    expect(harness.inFlight()).toBe(false);

    frame = 'next-frame';
    await harness.captureAndUpload();
    expect(uploadCalls).toBe(3);
    expect(send).toHaveBeenCalledTimes(2);
    expect(harness.inFlight()).toBe(false);
    clearInterval(ticker);
  });

  it('does not let a failed upload roll back a newer display-mode hash reset', async () => {
    let rejectUpload!: (error: Error) => void;
    const harness = executeProductionCapture({
      logScreenshotSkip: vi.fn(),
      snapshotToPng: vi.fn(async () => ({
        ansi: 'attempted-frame',
        png: Buffer.from('png'),
        content: 'attempted-frame',
      })),
      backend: {},
      renderCols: 80,
      renderRows: 24,
      renderer: null,
      createHash: vi.fn(),
      clamp: vi.fn(),
      captureToPng: vi.fn(),
      uploadImageBuffer: vi.fn(() => new Promise<string>((_resolve, reject) => {
        rejectUpload = reject;
      })),
      logError: vi.fn(),
      projectedRuntimeScreenStatus: () => 'working',
      send: vi.fn(),
      classifyScreenUsageLimit: () => ({ status: 'working' }),
      currentBotmuxTurnId: 'turn_1',
      currentBotmuxDispatchAttempt: 1,
    });

    harness.setLastHash('previous-frame');
    const capture = harness.captureAndUpload();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.lastHash()).toBe('attempted-frame');

    // applyDisplayMode() resets lastShotHash while an old upload may still be
    // pending. The old failure must not resurrect the pre-reset hash.
    harness.setLastHash('');
    rejectUpload(new Error('token request timed out'));
    await capture;

    expect(harness.lastHash()).toBe('');
    expect(harness.inFlight()).toBe(false);
  });
});
