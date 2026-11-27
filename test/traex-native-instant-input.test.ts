import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { detectCliStartupBlocker } from '../src/core/cli-startup-blocker.js';
import { stripAnsiScreenText } from '../src/utils/idle-detector.js';

function harness() {
  const target = { sendSpecialKeys: vi.fn(() => true) };
  const scope: Record<string, any> = {
    backend: target, cliAdapter: { preemptsOnNewMessage: true, busyPattern: /Working/, interruptKey: 'esc' },
    lastInitConfig: { cliId: 'traex' }, effectiveBackendType: 'tmux',
    currentTraexObservedPid: () => 123, readProcessStartIdentity: () => 'birth',
    readCmdline: () => ['/native/traex'], codexRpcEngine: undefined,
    isPromptReady: false, awaitingFirstPrompt: false, isFlushing: false,
    injectionFlushing: false, commandLineWritesPending: 0, cliRestartInProgress: false,
    currentBotmuxTurnId: 'om_old', currentBotmuxDispatchAttempt: undefined,
    preemptedTurnId: undefined, preemptCooldownUntil: 0, PREEMPT_COOLDOWN_MS: 2000,
    captureBackendScreen: () => 'Working', busyProbeRegion: (screen: string) => screen,
    runAfterAmbiguousSubmissionWrites: async (_target: unknown, run: () => unknown) => run(),
    sendCriticalControlKey: async (_key: unknown, run: () => unknown) => run(),
    sendTermActionOnce: (backend: typeof target) => backend.sendSpecialKeys('Escape'),
    inflightInputs: { retireTurn: vi.fn() }, pendingMessages: [],
    retireStructuredTurnAttribution: vi.fn(), emitTurnTerminal: vi.fn(),
    invalidatePromptReadinessEvidence: vi.fn(), revokePromptReadiness: vi.fn(),
    idleDetector: { reset: vi.fn() }, log: vi.fn(), send: vi.fn(), cliName: () => 'TraeX',
  };
  scope.isUserImTurnId = loadWorkerFunction('isUserImTurnId', scope);
  return { scope, target, enabled: loadWorkerFunction('traexNativeInstantInputEnabled', scope),
    preempt: loadWorkerFunction('preemptActiveTurnForNewMessage', scope) };
}

describe('TraeX native instant input configuration', () => {
  it('uses enabled native Enter mode without sending an upstream interrupt', async () => {
    const h = harness();
    h.scope.readCmdline = () => ['/native/traex', '-c', 'features.instant_interrupt=true'];
    expect(h.enabled()).toBe(true);
    expect(h.preempt({ turnId: 'om_new' }, h.target)).toBe(false);
    await Promise.resolve();
    expect(h.target.sendSpecialKeys).not.toHaveBeenCalled();
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it('honors a later false override and retains the existing upstream interrupt route', async () => {
    const h = harness();
    h.scope.readCmdline = () => ['/native/traex', '-c', 'features.instant_interrupt=true',
      '-c', 'features.instant_interrupt=false'];
    expect(h.enabled()).toBe(false);
    expect(h.preempt({ turnId: 'om_new' }, h.target)).toBe(true);
    await vi.waitFor(() => expect(h.target.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Escape'));
  });

  it.each([
    ['mixed enable', ['/native/traex', '-c', 'features.instant_interrupt=true', '--enable', 'instant_interrupt']],
    ['mixed disable', ['/native/traex', '-c', 'features.instant_interrupt=true', '--disable', 'instant_interrupt']],
    ['remote viewer', ['/native/traex', '-c', 'features.instant_interrupt=true', '--remote', 'ws://fixture']],
  ])('does not infer native mode from %s argv', (_label, argv) => {
    const h = harness(); h.scope.readCmdline = () => argv;
    expect(h.enabled()).toBe(false);
  });

  it('refuses an argv observation whose native process birth changes', () => {
    const h = harness();
    h.scope.readCmdline = () => ['/native/traex', '-c', 'features.instant_interrupt=true'];
    h.scope.readProcessStartIdentity = vi.fn().mockReturnValueOnce('old-birth').mockReturnValue('new-birth');
    expect(h.enabled()).toBe(false);
  });

  it('requires native argv and rejects an init flag, positional config or changing PID', () => {
    const h = harness(); h.scope.lastInitConfig.features = { instant_interrupt: true };
    h.scope.readCmdline = () => []; expect(h.enabled()).toBe(false);
    h.scope.readCmdline = () => ['/native/traex', '--', '-c', 'features.instant_interrupt=true'];
    expect(h.enabled()).toBe(false);
    h.scope.readCmdline = () => ['/native/traex', '-c', 'features.instant_interrupt=true'];
    h.scope.currentTraexObservedPid = vi.fn().mockReturnValueOnce(123).mockReturnValue(456);
    expect(h.enabled()).toBe(false);
  });
});

describe('native-mode trust input after observer reattach', () => {
  const trust = ['Folder access', '/fixture', 'Do you trust the contents of this directory?',
    '❯ 1. Yes, continue', '  2. No, quit', '  enter continue  |  esc quit'].join('\n');
  const current = '◆ Working… (2s • esc to interrupt)\n────────\n❯ Use /skills to list available skills\n────────\n  mock-model · ~ · Context 100% left';
  function trustHarness(viewport: string) {
    const h = harness();
    Object.assign(h.scope, {
      readCmdline: () => ['/native/traex', '-c', 'features.instant_interrupt=true'],
      trustHandled: false, TRUST_DIALOG_PATTERN: /Yes, I trust this folder|Yes, continue|Trust and continue/,
      dismissAidenCodexUpdateDialog: () => false, noticeCodexModelMigrationDialog: vi.fn(),
      isWorkflowWorker: () => false,
      detectCliStartupBlocker, stripAnsiScreenText, backendScreenEvidenceIsAuthoritativeForMutation: () => true,
      cliSpawnGeneration: 1, cliLifetimeNonce: 2, cliInterruptGeneration: 0,
      webTerminalInputGeneration: 0, promptReadinessRevision: 0, closeRequested: false,
      rawInputRestartGate: false, fatalWorkerErrorPending: false, cliSubmissionInFlight: undefined,
      sessionRenameInFlight: () => false, nativeSessionForkPending: () => false,
      pendingWebTerminalInput: () => false, webTerminalInputWireDirty: () => false,
    });
    h.target.captureViewport = () => viewport;
    return { ...h, handle: loadWorkerFunction('handleVisibleStartupInteraction', h.scope),
      setViewport: (text: string) => { viewport = text; } };
  }

  it('ignores replayed trust scrollback while the native viewport is already working', async () => {
    vi.useFakeTimers();
    try {
      const h = trustHarness(current);
      expect(h.handle(trust)).toBe(false);
      expect(h.scope.trustHandled).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(h.target.sendSpecialKeys).not.toHaveBeenCalled();
      expect(h.scope.invalidatePromptReadinessEvidence).not.toHaveBeenCalled();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it.each([
    ['viewport', (h: ReturnType<typeof trustHarness>) => h.setViewport(current)],
    ['interrupt generation', (h: ReturnType<typeof trustHarness>) => { h.scope.cliInterruptGeneration++; }],
    ['Web epoch', (h: ReturnType<typeof trustHarness>) => { h.scope.webTerminalInputGeneration++; }],
    ['active write', (h: ReturnType<typeof trustHarness>) => { h.scope.isFlushing = true; }],
  ])('rechecks %s before the delayed trust Enter', async (_name, change) => {
    vi.useFakeTimers();
    try {
      const h = trustHarness(trust);
      expect(h.handle(trust)).toBe(true);
      change(h);
      await vi.advanceTimersByTimeAsync(500);
      expect(h.target.sendSpecialKeys).not.toHaveBeenCalled();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('accepts the current selected trust page once when its lease stays current', async () => {
    vi.useFakeTimers();
    try {
      const h = trustHarness(trust);
      expect(h.handle(trust)).toBe(true);
      expect(h.handle(trust)).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(h.target.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Enter');
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });
});
