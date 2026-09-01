import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import {
  closeSocket,
  closeWorker,
  FORGED_INPUT,
  FORGED_INPUT_HEX,
  openViewSocket,
  READ_ONLY_SCROLL_SESSION_BUDGET,
  readTextIfPresent,
  sendScroll,
  startOpenCodeWorker,
  waitForStableOccurrenceCount,
  WHEEL_UP,
  WHEEL_UP_HEX,
} from './helpers/worker-terminal-scroll-harness.js';

describe('worker read-only terminal remote scroll', () => {
  it('forwards one legal read-only scroll frame for an OpenCode opt-in view socket', async () => {
    const harness = await startOpenCodeWorker('opencode');
    const ws = await openViewSocket(harness);

    writeFileSync(harness.inputLog, '');
    sendScroll(ws);

    const count = await waitForStableOccurrenceCount(harness.inputLog, WHEEL_UP_HEX, { minimumCount: 1 });
    expect(count).toBe(1);

    closeSocket(ws);
    closeWorker(harness.child);
  }, 25_000);

  it('bounds repeated read-only scroll frames from one view socket by the session budget', async () => {
    const harness = await startOpenCodeWorker('opencode');
    const ws = await openViewSocket(harness);

    writeFileSync(harness.inputLog, '');
    for (let i = 0; i < READ_ONLY_SCROLL_SESSION_BUDGET + 8; i += 1) sendScroll(ws);

    const count = await waitForStableOccurrenceCount(harness.inputLog, WHEEL_UP_HEX, {
      minimumCount: READ_ONLY_SCROLL_SESSION_BUDGET,
    });
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(READ_ONLY_SCROLL_SESSION_BUDGET);

    closeSocket(ws);
    closeWorker(harness.child);
  }, 25_000);

  it('shares the read-only scroll budget across multiple view sockets in one session', async () => {
    const harness = await startOpenCodeWorker('opencode');
    const firstWs = await openViewSocket(harness);
    const secondWs = await openViewSocket(harness);

    writeFileSync(harness.inputLog, '');
    for (let i = 0; i < READ_ONLY_SCROLL_SESSION_BUDGET + 4; i += 1) {
      sendScroll(firstWs);
      sendScroll(secondWs);
    }

    const count = await waitForStableOccurrenceCount(harness.inputLog, WHEEL_UP_HEX, {
      minimumCount: READ_ONLY_SCROLL_SESSION_BUDGET,
    });
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(READ_ONLY_SCROLL_SESSION_BUDGET);

    closeSocket(firstWs);
    closeSocket(secondWs);
    closeWorker(harness.child);
  }, 25_000);

  it('keeps rejecting forged read-only input frames on a view socket', async () => {
    const harness = await startOpenCodeWorker('opencode');
    const ws = await openViewSocket(harness);

    writeFileSync(harness.inputLog, '');
    ws.send(JSON.stringify({ type: 'input', data: WHEEL_UP }));
    ws.send(JSON.stringify({ type: 'input', data: FORGED_INPUT }));

    const scrollCount = await waitForStableOccurrenceCount(harness.inputLog, WHEEL_UP_HEX);
    expect(scrollCount).toBe(0);
    expect(readTextIfPresent(harness.inputLog)).not.toContain(FORGED_INPUT_HEX);

    closeSocket(ws);
    closeWorker(harness.child);
  }, 25_000);
});
