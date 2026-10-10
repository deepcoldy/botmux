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
  /** Simulate setCaptureIdentity(): tuple change bumps the capture revision. */
  setTurn(turnId: string | undefined, attempt: number | undefined): void;
  revision(): number;
  /** Simulate applyDisplayMode(): mode change + generation bump + hash reset. */
  applyDisplayMode(mode: 'hidden' | 'screenshot'): void;
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
      projectedRuntimeScreenStatus, send, classifyScreenUsageLimit, log,
    } = deps;
    const {
      MIN_RENDER_COLS = 1, MAX_RENDER_COLS = 1000, MIN_RENDER_ROWS = 1, MAX_RENDER_ROWS = 1000,
    } = deps;
    let currentBotmuxTurnId = deps.currentBotmuxTurnId;
    let currentBotmuxDispatchAttempt = deps.currentBotmuxDispatchAttempt;
    let screenshotDisplayGeneration = 0;
    let captureRevision = 0;
    let displayMode = 'screenshot';
    let awaitingFirstPrompt = false;
    let apiOnlyForUpload = false;
    let larkAppIdForUpload = 'app';
    let larkAppSecretForUpload = 'secret';
    let larkBrandForUpload = 'feishu';
    let screenshotCaptureInFlight = false;
    let lastShotHash = '';
    let lastUploadLogAtMs = 0;
    ${captureJs}
    return {
      captureAndUpload,
      inFlight: () => screenshotCaptureInFlight,
      lastHash: () => lastShotHash,
      setLastHash: (hash) => { lastShotHash = hash; },
      setTurn: (turnId, attempt) => {
        // Mirrors production setCaptureIdentity's state effects.
        if (turnId !== currentBotmuxTurnId || attempt !== currentBotmuxDispatchAttempt) captureRevision += 1;
        currentBotmuxTurnId = turnId;
        currentBotmuxDispatchAttempt = attempt;
      },
      revision: () => captureRevision,
      applyDisplayMode: (mode) => {
        // Mirrors production applyDisplayMode's state effects (loop control is
        // outside the capture function under test).
        displayMode = mode;
        screenshotDisplayGeneration += 1;
        lastShotHash = '';
      },
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
      log: vi.fn(),
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
    // Dedup key = captureRevision:displayGeneration:pixelHash.
    expect(harness.lastHash()).toBe('0:0:same-frame');
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
      log: vi.fn(),
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
    expect(harness.lastHash()).toBe('0:0:attempted-frame');

    // applyDisplayMode() resets lastShotHash while an old upload may still be
    // pending. The old failure must not resurrect the pre-reset hash.
    harness.setLastHash('');
    rejectUpload(new Error('token request timed out'));
    await capture;

    expect(harness.lastHash()).toBe('');
    expect(harness.inFlight()).toBe(false);
  });

  function deferredUploadHarness(frameRef: { frame: string }) {
    const uploads: Array<{ resolve: (key: string) => void; reject: (err: Error) => void }> = [];
    const send = vi.fn();
    const logScreenshotSkip = vi.fn();
    const uploadImageBuffer = vi.fn(() => new Promise<string>((resolve, reject) => {
      uploads.push({ resolve, reject });
    }));
    const harness = executeProductionCapture({
      logScreenshotSkip,
      snapshotToPng: vi.fn(async () => ({
        ansi: frameRef.frame,
        png: Buffer.from('png'),
        content: frameRef.frame,
      })),
      backend: {},
      renderCols: 80,
      renderRows: 24,
      renderer: null,
      createHash: vi.fn(),
      clamp: vi.fn(),
      captureToPng: vi.fn(),
      uploadImageBuffer,
      logError: vi.fn(),
      log: vi.fn(),
      projectedRuntimeScreenStatus: () => 'working',
      send,
      classifyScreenUsageLimit: () => ({ status: 'working' }),
      currentBotmuxTurnId: 'turn_old',
      currentBotmuxDispatchAttempt: 1,
    });
    return { harness, uploads, send, uploadImageBuffer, logScreenshotSkip };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  }

  it('drops an old-turn frame whose upload finishes after the successor turn started, then recaptures under the new turn', async () => {
    const frameRef = { frame: 'old-turn-frame' };
    const { harness, uploads, send, uploadImageBuffer } = deferredUploadHarness(frameRef);

    const capture = harness.captureAndUpload();
    await Promise.resolve();
    await Promise.resolve();
    expect(uploads).toHaveLength(1);
    expect(harness.lastHash()).toBe('0:0:old-turn-frame');

    // Successor turn begins (its card POST completes daemon-side) while the
    // old image is still uploading.
    harness.setTurn('turn_new', 1);
    uploads[0].resolve('img_old_turn');
    await capture;

    // Never relabelled as the new turn, never sent at all.
    expect(send).not.toHaveBeenCalled();
    // Guarded rollback: the stale frame does not poison dedup.
    expect(harness.lastHash()).toBe('');

    // The skipped immediate capture is retried under the current identity.
    await settle();
    expect(uploadImageBuffer).toHaveBeenCalledTimes(2);
    uploads[1].resolve('img_new_turn');
    await settle();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({
      type: 'screenshot_uploaded',
      imageKey: 'img_new_turn',
      turnId: 'turn_new',
      dispatchAttempt: 1,
    });
  });

  it('labels a frame with the turn/attempt captured before the first await', async () => {
    const frameRef = { frame: 'frame-a' };
    const { harness, uploads, send } = deferredUploadHarness(frameRef);
    const capture = harness.captureAndUpload();
    await Promise.resolve();
    await Promise.resolve();
    uploads[0].resolve('img_a');
    await capture;
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({ imageKey: 'img_a', turnId: 'turn_old', dispatchAttempt: 1 });
  });

  it('drops a frame from a superseded dispatch attempt of the same turn', async () => {
    const frameRef = { frame: 'attempt-1-frame' };
    const { harness, uploads, send } = deferredUploadHarness(frameRef);
    const capture = harness.captureAndUpload();
    await Promise.resolve();
    await Promise.resolve();
    harness.setTurn('turn_old', 2);
    uploads[0].resolve('img_attempt_1');
    await capture;
    expect(send).not.toHaveBeenCalled();
  });

  it('show → hide → show during an upload does not let the old frame cross the display generation', async () => {
    const frameRef = { frame: 'pre-toggle-frame' };
    const { harness, uploads, send } = deferredUploadHarness(frameRef);
    const capture = harness.captureAndUpload();
    await Promise.resolve();
    await Promise.resolve();
    harness.applyDisplayMode('hidden');
    harness.applyDisplayMode('screenshot');
    uploads[0].resolve('img_pre_toggle');
    await capture;
    expect(send).not.toHaveBeenCalled();
    // The newer display reset already cleared the hash; the stale frame must
    // not restore anything over it.
    expect(harness.lastHash()).toBe('');
    // Fresh capture after the toggle is delivered.
    frameRef.frame = 'post-toggle-frame';
    await settle();
    expect(uploads).toHaveLength(2);
    uploads[1].resolve('img_post_toggle');
    await settle();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({ imageKey: 'img_post_toggle' });
  });

  it('drops a frame when output was hidden during the upload and does not recapture', async () => {
    const frameRef = { frame: 'hidden-frame' };
    const { harness, uploads, send, uploadImageBuffer } = deferredUploadHarness(frameRef);
    const capture = harness.captureAndUpload();
    await Promise.resolve();
    await Promise.resolve();
    harness.applyDisplayMode('hidden');
    uploads[0].resolve('img_hidden');
    await capture;
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(uploadImageBuffer).toHaveBeenCalledOnce();
  });
});

// ─── Ported from Alex's independent acceptance review (round 1) ───────────
describe('independent acceptance capture await boundaries', () => {
  it('independent acceptance: a reset during snapshot must not restore an old dedup hash and strand the new card', async () => {
    // Ported from Alex R1; upload-count requirement relaxed per Alex's R2
    // correction: a frame already known stale is cancelled, not uploaded.
    let resolveSnapshot!: (value: any) => void;
    let snapshots = 0;
    const send = vi.fn();
    const snapshotToPng = vi.fn(() => {
      snapshots++;
      if (snapshots === 1) return new Promise(resolve => { resolveSnapshot = resolve; });
      return Promise.resolve({ ansi: 'prior-frame', png: Buffer.from('new'), content: 'prior-frame' });
    });
    const uploadImageBuffer = vi.fn(async (_a: string, _b: string, png: Buffer) => `img_${png.toString()}`);
    const harness = executeProductionCapture({ logScreenshotSkip: vi.fn(), snapshotToPng, backend: {}, renderCols: 80, renderRows: 24, renderer: null, createHash: vi.fn(), clamp: vi.fn(), captureToPng: vi.fn(), uploadImageBuffer, logError: vi.fn(), log: vi.fn(), projectedRuntimeScreenStatus: () => 'working', send, classifyScreenUsageLimit: () => ({ status: 'working' }), currentBotmuxTurnId: 'old_turn', currentBotmuxDispatchAttempt: 1 });
    harness.setLastHash('0:0:prior-frame');
    const pending = harness.captureAndUpload();
    harness.setTurn('new_turn', 1);
    harness.applyDisplayMode('hidden'); harness.applyDisplayMode('screenshot');
    resolveSnapshot({ ansi: 'intermediate-old-frame', png: Buffer.from('old'), content: 'intermediate-old-frame' });
    await pending;
    await new Promise(resolve => setTimeout(resolve, 20));
    // Old identity never uploads or sends; new identity sends even though its
    // pixels equal the pre-reset frame.
    expect(uploadImageBuffer.mock.calls.map(c => (c[2] as Buffer).toString())).not.toContain('old');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ imageKey: 'img_new', turnId: 'new_turn', dispatchAttempt: 1, captureRevision: 1 });
  });
});

// ─── V3 capture identity: worker side ─────────────────────────────────────

type IdentityHarness = {
  setCaptureIdentity(turnId: string | undefined, attempt: number | undefined): void;
  state(): { turnId?: string; attempt?: number; revision: number };
};

function executeProductionSetCaptureIdentity(send: (msg: unknown) => void): IdentityHarness {
  const start = source.indexOf('function setCaptureIdentity(');
  const end = source.indexOf('\n}\n', start) + 3;
  expect(start).toBeGreaterThanOrEqual(0);
  const js = ts.transpileModule(
    source.slice(start, end),
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const factory = new Function('send', `
    let currentBotmuxTurnId;
    let currentBotmuxDispatchAttempt;
    let captureRevision = 0;
    let captureIdentityAnnounced = false;
    ${js}
    return {
      setCaptureIdentity,
      state: () => ({ turnId: currentBotmuxTurnId, attempt: currentBotmuxDispatchAttempt, revision: captureRevision }),
    };
  `);
  return factory(send) as IdentityHarness;
}

describe('V3 setCaptureIdentity (single identity writer)', () => {
  it('announces the initial (undefined, undefined) snapshot once, then bumps only on real tuple changes', () => {
    const send = vi.fn();
    const id = executeProductionSetCaptureIdentity(send);
    id.setCaptureIdentity(undefined, undefined);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual({ type: 'capture_identity', revision: 0 });
    id.setCaptureIdentity(undefined, undefined); // unchanged → no event
    expect(send).toHaveBeenCalledTimes(1);
    id.setCaptureIdentity('om_a', undefined);
    id.setCaptureIdentity('om_a', undefined); // same write point twice → idempotent
    id.setCaptureIdentity('om_a', 2); // attempt change is a new identity
    id.setCaptureIdentity(undefined, undefined); // CLI exit/clear
    expect(send.mock.calls.map(c => c[0])).toEqual([
      { type: 'capture_identity', revision: 0 },
      { type: 'capture_identity', revision: 1, turnId: 'om_a' },
      { type: 'capture_identity', revision: 2, turnId: 'om_a', dispatchAttempt: 2 },
      { type: 'capture_identity', revision: 3 },
    ]);
    // A CLI restart re-enters through the same writer; revision never resets.
    id.setCaptureIdentity('om_a', 2);
    expect(id.state().revision).toBe(4);
  });

  it('every former direct identity assignment in worker.ts goes through setCaptureIdentity', () => {
    const assignments = source.match(/currentBotmux(TurnId|DispatchAttempt) = /g) ?? [];
    // Only the two lines inside setCaptureIdentity itself.
    expect(assignments).toHaveLength(2);
    const start = source.indexOf('function setCaptureIdentity(');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).toContain('currentBotmuxTurnId = turnId;');
    // Receipts never move identity.
    const ack = functionSlice('acknowledgeTurnInputCommitted', 'acknowledgeTurnInputReceived');
    expect(ack).not.toContain('setCaptureIdentity');
    // Real write points do.
    const bodyOf = (name: string): string => {
      const at = source.indexOf(`async function ${name}(`);
      expect(at, name).toBeGreaterThanOrEqual(0);
      return source.slice(at, source.indexOf('\n}\n', at));
    };
    expect(bodyOf('deliverRawInput')).toContain('setCaptureIdentity(msg.turnId, undefined)');
    expect(bodyOf('writeAdoptMessage')).toContain('setCaptureIdentity(turnId, dispatchAttempt)');
    expect(bodyOf('flushPending')).toContain('setCaptureIdentity(item.turnId, item.dispatchAttempt)');
    for (const name of ['adoptInitialActiveTurn', 'adoptDisplacedActiveTurn', 'writeCliPidMarker', 'syncQueuedTurnsFromMarkerDisk', 'advanceQueuedTypeAheadTurn']) {
      const at = source.indexOf(`function ${name}(`);
      expect(at, name).toBeGreaterThanOrEqual(0);
      expect(source.slice(at, source.indexOf('\n}\n', at)), name).toContain('setCaptureIdentity(');
    }
  });

  it('keeps capture identity on the running turn while type-ahead is queued, then advances it with the actual queued promotion', () => {
    const tree = ts.createSourceFile('worker.ts', source, ts.ScriptTarget.Latest, true);
    const findNode = (predicate: (node: ts.Node) => boolean): ts.Node => {
      let found: ts.Node | undefined;
      const visit = (node: ts.Node): void => {
        if (found) return;
        if (predicate(node)) { found = node; return; }
        ts.forEachChild(node, visit);
      };
      visit(tree);
      expect(found).toBeDefined();
      return found!;
    };
    const functions = ['setCaptureIdentity', 'markTurnRetired', 'advanceQueuedTypeAheadTurn', 'acknowledgeTurnInputCommitted']
      .map(name => findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(tree));
    const preparation = findNode(node => ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name) && node.name.text === 'prepareNormalWrite') as ts.VariableDeclaration;
    // Execute the full production preparation callback and queue promotion,
    // preserving the upstream distinction between type-ahead submission and
    // actual turn activation. Only unrelated write/marker IO is stubbed.
    const js = ts.transpileModule(
      [...functions, `const prepareNormalWrite = ${preparation.initializer!.getText(tree)};`].join('\n'),
      { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const send = vi.fn();
    const harness = new Function('send', `
      let currentBotmuxTurnId, currentBotmuxDispatchAttempt, currentVcMeetingImTurnOrigin;
      let captureRevision = 0, captureIdentityAnnounced = false, currentTurnSteerPromoted = false;
      let queuedTypeAheadTurns = [], queuedTurnAdvanceConsumedForPrompt = false;
      const retiredTurnIds = new Set();
      const started = [];
      const syncQueuedTurnsFromMarkerDisk = () => false;
      const readSendMarkers = () => [];
      const markActiveTurnStarted = record => started.push(record);
      const writeCliPidMarker = () => {}, publishSandboxRelayCapability = () => {}, log = () => {};
      const ordinaryImTurnDedupe = { commit: () => {} };
      let normalWritePrepared = false, item, durableWrite = false, durableTurnInFlight = false;
      let promptReadyAtFlushStart = false, itemsWrittenInThisFlush = 0, turnSeq = 0, bridgeTurnId;
      const renderer = { markNewTurn: () => {} }, writeRpcEngine = undefined;
      const inflightInputs = { onWrite: () => {} }, stuckDetector = undefined;
      const usageLimitTracker = { beginTurn: () => 1 }, currentUsageLimitSnapshot = () => undefined;
      const claudeBridgeActive = false, codexBridgeActive = false;
      const lastInitConfig = { cliId: 'dsh-tui' }, cliAdapter = { reliableTurnTerminal: false };
      const stampMojoTurnMark = () => {}, markTurnExecutionStart = () => {};
      const logicalMsg = 'queued input', msg = logicalMsg;
      let submissionPreparationFailed = false;
      ${js}
      setCaptureIdentity('om_running', 1);
      return {
        enqueue: record => { item = record; durableWrite = record.dispatchAttempt !== undefined; normalWritePrepared = false; prepareNormalWrite(); },
        acknowledge: acknowledgeTurnInputCommitted,
        advance: () => advanceQueuedTypeAheadTurn('prompt_ready'),
        state: () => ({ turnId: currentBotmuxTurnId, attempt: currentBotmuxDispatchAttempt,
          revision: captureRevision, queued: queuedTypeAheadTurns, retired: [...retiredTurnIds], started }),
      };
    `)(send) as {
      enqueue(record: { turnId: string; dispatchAttempt: number }): void;
      acknowledge(turnId: string): void;
      advance(): boolean;
      state(): { turnId: string; attempt: number; revision: number; queued: unknown[]; retired: string[]; started: unknown[] };
    };
    send.mockClear();
    harness.enqueue({ turnId: 'om_queued', dispatchAttempt: 7 });
    harness.acknowledge('om_queued');
    expect(harness.state()).toEqual({
      turnId: 'om_running', attempt: 1, revision: 0,
      queued: [expect.objectContaining({ turnId: 'om_queued', dispatchAttempt: 7 })],
      retired: [], started: [],
    });
    expect(send.mock.calls.map(call => call[0])).toEqual([
      { type: 'turn_input_committed', turnId: 'om_queued' },
    ]);

    expect(harness.advance()).toBe(true);
    expect(harness.state()).toEqual({
      turnId: 'om_queued', attempt: 7, revision: 1, queued: [], retired: ['om_running'],
      started: [expect.objectContaining({ turnId: 'om_queued', dispatchAttempt: 7 })],
    });
    expect(send.mock.calls.at(-1)?.[0]).toEqual({
      type: 'capture_identity', revision: 1, turnId: 'om_queued', dispatchAttempt: 7,
    });
    expect(harness.advance()).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('V3 capture await boundaries (sequence 8)', () => {
  type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void };
  function deferred<T>(): Deferred<T> {
    let resolve!: (v: T) => void; let reject!: (e: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }
  async function settle(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 5; j += 1) await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  /** Pipe-path harness: first snapshot/upload deferred, later ones immediate. */
  function pipeHarness(frame = 'same-pixels') {
    const snapshots: Array<Deferred<any>> = [];
    const uploads: Array<Deferred<string>> = [];
    let deferSnapshots = 1;
    let deferUploads = 0;
    const send = vi.fn();
    const snapshotToPng = vi.fn(() => {
      if (deferSnapshots > 0) { deferSnapshots -= 1; const d = deferred<any>(); snapshots.push(d); return d.promise; }
      return Promise.resolve({ ansi: frame, png: Buffer.from('fresh'), content: frame });
    });
    const uploadImageBuffer = vi.fn((_a: string, _b: string, png: Buffer) => {
      if (deferUploads > 0) { deferUploads -= 1; const d = deferred<string>(); uploads.push(d); return d.promise; }
      return Promise.resolve(`img_${png.toString()}`);
    });
    const harness = executeProductionCapture({
      logScreenshotSkip: vi.fn(), snapshotToPng, backend: {}, renderCols: 80, renderRows: 24,
      renderer: null, createHash: vi.fn(), clamp: vi.fn(), captureToPng: vi.fn(), uploadImageBuffer,
      logError: vi.fn(), log: vi.fn(), projectedRuntimeScreenStatus: () => 'working', send,
      classifyScreenUsageLimit: () => ({ status: 'working' }),
      currentBotmuxTurnId: 'turn_a', currentBotmuxDispatchAttempt: 1,
    });
    return {
      harness, snapshots, uploads, send, uploadImageBuffer, snapshotToPng,
      deferNextUpload: () => { deferUploads += 1; },
    };
  }

  it.each([
    ['turn change', (h: CaptureHarness) => h.setTurn('turn_b', 1), { turnId: 'turn_b', dispatchAttempt: 1 }],
    ['attempt change', (h: CaptureHarness) => h.setTurn('turn_a', 2), { turnId: 'turn_a', dispatchAttempt: 2 }],
    ['show-hide-show', (h: CaptureHarness) => { h.applyDisplayMode('hidden'); h.applyDisplayMode('screenshot'); }, { turnId: 'turn_a', dispatchAttempt: 1 }],
  ])('during the snapshot await (%s), unchanged pixels: old identity is cancelled before upload, new identity sends', async (_label, change, expected) => {
    const t = pipeHarness('same-pixels');
    // The terminal already showed these exact pixels under the old identity.
    t.harness.setLastHash('0:0:same-pixels');
    const pending = t.harness.captureAndUpload();
    change(t.harness);
    t.snapshots[0].resolve({ ansi: 'same-pixels', png: Buffer.from('stale'), content: 'same-pixels' });
    await pending;
    await settle();
    expect(t.uploadImageBuffer.mock.calls.map(c => (c[2] as Buffer).toString())).not.toContain('stale');
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.send.mock.calls[0][0]).toMatchObject({ ...expected, captureRevision: t.harness.revision() });
  });

  it('during the upload await (turn change): old frame not sent, new identity sends', async () => {
    const t = pipeHarness('same-pixels');
    t.deferNextUpload();
    const pending = t.harness.captureAndUpload();
    t.snapshots[0].resolve({ ansi: 'same-pixels', png: Buffer.from('a-frame'), content: 'same-pixels' });
    await Promise.resolve(); await Promise.resolve();
    expect(t.uploads).toHaveLength(1);
    t.harness.setTurn('turn_b', 1);
    t.uploads[0].resolve('img_a_frame');
    await pending;
    await settle();
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.send.mock.calls[0][0]).toMatchObject({ turnId: 'turn_b', captureRevision: 1 });
    expect(t.send.mock.calls[0][0].imageKey).not.toBe('img_a_frame');
  });

  it('during the fallback render await: stale render is cancelled and the new identity sends', async () => {
    const renders: Array<Deferred<Buffer>> = [];
    const send = vi.fn();
    const uploadImageBuffer = vi.fn(async (_a: string, _b: string, png: Buffer) => `img_${png.toString()}`);
    const { createHash } = await import('node:crypto');
    const harness = executeProductionCapture({
      logScreenshotSkip: vi.fn(),
      snapshotToPng: vi.fn(async () => null),
      backend: {}, renderCols: 80, renderRows: 24,
      renderer: { xterm: { buffer: { active: { baseY: 0 } }, cols: 80, rows: 24 }, rawSnapshot: () => 'pty-pixels' },
      createHash, clamp: (v: number) => v,
      captureToPng: vi.fn(() => {
        if (renders.length === 0) { const d = deferred<Buffer>(); renders.push(d); return d.promise; }
        return Promise.resolve(Buffer.from('fresh-render'));
      }),
      uploadImageBuffer, logError: vi.fn(), log: vi.fn(),
      projectedRuntimeScreenStatus: () => 'working', send,
      classifyScreenUsageLimit: () => ({ status: 'working' }),
      currentBotmuxTurnId: 'turn_a', currentBotmuxDispatchAttempt: undefined,
    });
    const pending = harness.captureAndUpload();
    await Promise.resolve(); await Promise.resolve();
    expect(renders).toHaveLength(1);
    harness.setTurn('turn_raw', undefined);
    renders[0].resolve(Buffer.from('stale-render'));
    await pending;
    await settle();
    expect(uploadImageBuffer.mock.calls.map(c => (c[2] as Buffer).toString())).not.toContain('stale-render');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ imageKey: 'img_fresh-render', turnId: 'turn_raw', captureRevision: 1 });
  });

  it('hidden during the snapshot: nothing uploads, sends or recaptures', async () => {
    const t = pipeHarness('px');
    const pending = t.harness.captureAndUpload();
    t.harness.applyDisplayMode('hidden');
    t.snapshots[0].resolve({ ansi: 'px', png: Buffer.from('stale'), content: 'px' });
    await pending;
    await settle();
    expect(t.uploadImageBuffer).not.toHaveBeenCalled();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.snapshotToPng).toHaveBeenCalledTimes(1);
  });

  it('an old upload failing after an identity change neither restores its key over the new one nor blocks the new frame', async () => {
    const t = pipeHarness('px');
    t.deferNextUpload();
    const pending = t.harness.captureAndUpload();
    t.snapshots[0].resolve({ ansi: 'px', png: Buffer.from('old'), content: 'px' });
    await Promise.resolve(); await Promise.resolve();
    expect(t.uploads).toHaveLength(1);
    t.harness.setTurn('turn_b', 1);
    t.uploads[0].reject(new Error('token timeout'));
    await pending;
    await settle();
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.send.mock.calls[0][0]).toMatchObject({ turnId: 'turn_b', captureRevision: 1 });
    expect(t.harness.lastHash()).toBe('1:0:px');
  });
});

// ─── Ported from Alex's R2 review (capture) ───────────────────────────────

describe('R2 turn-only capture acceptance', () => {
  it('R2 capture acceptance: a turn change without a display reset must deliver unchanged current pixels to the new card', async () => {
    let resolveSnapshot!: (value: any) => void;
    let snapshots = 0;
    const send = vi.fn();
    const snapshotToPng = vi.fn(() => ++snapshots === 1
      ? new Promise(resolve => { resolveSnapshot = resolve; })
      : Promise.resolve({ ansi: 'prior-frame', png: Buffer.from('new'), content: 'prior-frame' }));
    const uploadImageBuffer = vi.fn(async () => 'img_uploaded');
    const harness = executeProductionCapture({ logScreenshotSkip: vi.fn(), snapshotToPng, backend: {}, renderCols: 80, renderRows: 24, renderer: null, createHash: vi.fn(), clamp: vi.fn(), captureToPng: vi.fn(), uploadImageBuffer, logError: vi.fn(), log: vi.fn(), projectedRuntimeScreenStatus: () => 'working', send, classifyScreenUsageLimit: () => ({ status: 'working' }), currentBotmuxTurnId: 'old_turn', currentBotmuxDispatchAttempt: 1 });
    // Alex's original fixture, unchanged: the prior hash is a bare pixel hash.
    harness.setLastHash('prior-frame');
    const pending = harness.captureAndUpload();
    harness.setTurn('new_turn', 1);
    resolveSnapshot({ ansi: 'intermediate-old-frame', png: Buffer.from('old'), content: 'intermediate-old-frame' });
    await pending;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(snapshotToPng).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'new_turn' }));
  });
});
