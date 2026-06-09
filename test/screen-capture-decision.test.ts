/**
 * startScreenUpdates' per-tick capture gate. The idle optimization skips the
 * tmux/dump-screen capture when the PTY-activity watermark hasn't advanced —
 * EXCEPT when the screen is "self-driven" (an observe backend that paused its
 * change-emission poller for a live web-attach), where the watermark goes stale
 * and we must capture every tick. Regression guard for the zellij-attach case
 * Codex caught.
 * Run:  pnpm vitest run test/screen-capture-decision.test.ts
 */
import { describe, it, expect } from 'vitest';
import { shouldCaptureScreen, isScreenSelfDriven } from '../src/utils/transient-snapshot.js';

describe('shouldCaptureScreen', () => {
  it('captures when the activity watermark advanced', () => {
    expect(shouldCaptureScreen({ ptyActivity: 5, lastCapturedPtyActivity: 4, screenSelfDriven: false })).toBe(true);
  });

  it('skips when the watermark is unchanged and the screen is not self-driven (the idle optimization)', () => {
    expect(shouldCaptureScreen({ ptyActivity: 4, lastCapturedPtyActivity: 4, screenSelfDriven: false })).toBe(false);
  });

  it('captures despite an unchanged watermark when the screen is self-driven (live-attach regression fix)', () => {
    // The zellij live-attach window: poller paused → watermark frozen → but the
    // pane is still changing. Must capture or the Feishu card / ScreenAnalyzer
    // / status freeze on a stale screen until detach.
    expect(shouldCaptureScreen({ ptyActivity: 4, lastCapturedPtyActivity: 4, screenSelfDriven: true })).toBe(true);
  });

  it('captures when both signals fire', () => {
    expect(shouldCaptureScreen({ ptyActivity: 9, lastCapturedPtyActivity: 4, screenSelfDriven: true })).toBe(true);
  });
});

describe('isScreenSelfDriven', () => {
  const observeBase = {
    captureViewport: () => '',
    getPaneSize: () => null,
    captureCurrentScreen: () => '',
    isPaneAlive: () => true,
  };

  it('is false for a non-observe backend', () => {
    expect(isScreenSelfDriven(undefined)).toBe(false);
    expect(isScreenSelfDriven({})).toBe(false);
    expect(isScreenSelfDriven({ onData() {} })).toBe(false);
  });

  it('is false for an observe backend that never pauses emission (no isLiveAttachActive)', () => {
    // e.g. TmuxPipeBackend / herdr — their poller keeps emitting, watermark stays sound.
    expect(isScreenSelfDriven({ ...observeBase })).toBe(false);
  });

  it('tracks isLiveAttachActive() for a zellij-style observe backend', () => {
    let attached = false;
    const be = { ...observeBase, isLiveAttachActive: () => attached };
    expect(isScreenSelfDriven(be)).toBe(false); // no live attach → watermark trusted
    attached = true;
    expect(isScreenSelfDriven(be)).toBe(true);  // live attach → must self-capture
    attached = false;
    expect(isScreenSelfDriven(be)).toBe(false); // detached → optimization resumes
  });
});
