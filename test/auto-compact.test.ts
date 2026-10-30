import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AutoCompactCoordinator,
  isAutoCompactEligible,
  settleAutoCompactSafeComposerRefusal,
  supportsNativeAutoCompact,
  supportsNativeAutoCompactRuntime,
  type AutoCompactEligibilitySnapshot,
} from '../src/core/auto-compact.js';
import { promptCacheKeepaliveRefusal } from '../src/core/prompt-cache-keepalive-gate.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

describe('AutoCompactCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces an over-threshold idle session and rechecks before firing', () => {
    let percent = 76;
    let eligible = true;
    const trigger = vi.fn(() => true);
    const coordinator = new AutoCompactCoordinator(5_000, 600_000, () => Date.now());
    const observation = {
      sessionId: 's1', idle: true, threshold: 75,
      readThreshold: () => 75,
      readPercent: () => percent,
      eligible: () => eligible,
      trigger,
    };

    coordinator.observe(observation);
    vi.advanceTimersByTime(4_999);
    expect(trigger).not.toHaveBeenCalled();
    percent = 74;
    vi.advanceTimersByTime(1);
    expect(trigger).not.toHaveBeenCalled();

    percent = 80;
    coordinator.observe(observation);
    eligible = false;
    vi.advanceTimersByTime(5_000);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('cancels on busy and applies a cooldown after dispatch', () => {
    const trigger = vi.fn(() => true);
    const coordinator = new AutoCompactCoordinator(1_000, 10_000, () => Date.now());
    const make = (idle: boolean, percent = 90) => ({
      sessionId: 's1', idle, threshold: 75,
      readThreshold: () => 75,
      readPercent: () => percent,
      eligible: () => true,
      trigger,
    });

    coordinator.observe(make(true));
    coordinator.observe(make(false));
    vi.advanceTimersByTime(1_000);
    expect(trigger).not.toHaveBeenCalled();

    coordinator.observe(make(true));
    vi.advanceTimersByTime(1_000);
    expect(trigger).toHaveBeenCalledTimes(1);

    coordinator.observe(make(false));
    coordinator.observe(make(true));
    vi.advanceTimersByTime(1_000);
    expect(trigger).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(9_000);
    coordinator.observe(make(true));
    vi.advanceTimersByTime(1_000);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('clears cooldown state after context falls below threshold', () => {
    const trigger = vi.fn(() => true);
    const coordinator = new AutoCompactCoordinator(1_000, 60_000, () => Date.now());
    const observe = (percent: number) => coordinator.observe({
      sessionId: 's1', idle: true, threshold: 75,
      readThreshold: () => 75,
      readPercent: () => percent,
      eligible: () => true,
      trigger,
    });

    observe(90);
    vi.advanceTimersByTime(1_000);
    observe(20);
    observe(90);
    vi.advanceTimersByTime(1_000);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('rechecks the live switch and threshold before firing', () => {
    let threshold: number | undefined = 75;
    const trigger = vi.fn(() => true);
    const coordinator = new AutoCompactCoordinator(1_000, 60_000, () => Date.now());
    const observation = {
      sessionId: 's1', idle: true, threshold: 75,
      readThreshold: () => threshold,
      readPercent: () => 80,
      eligible: () => true,
      trigger,
    };

    coordinator.observe(observation);
    threshold = undefined;
    vi.advanceTimersByTime(1_000);
    expect(trigger).not.toHaveBeenCalled();

    threshold = 75;
    coordinator.observe(observation);
    threshold = 85;
    vi.advanceTimersByTime(1_000);
    expect(trigger).not.toHaveBeenCalled();

    coordinator.observe({ ...observation, threshold: 85, readPercent: () => 90 });
    vi.advanceTimersByTime(1_000);
    expect(trigger).toHaveBeenCalledWith(85);
  });

  it.each(['readThreshold', 'readPercent', 'eligible', 'trigger'] as const)(
    'contains %s failures and leaves coordinator state self-consistent',
    (stage) => {
      const onError = vi.fn();
      const trigger = vi.fn(() => {
        if (stage === 'trigger') throw new Error('trigger failed');
        return true;
      });
      let percentReads = 0;
      const coordinator = new AutoCompactCoordinator(1_000, 60_000, () => Date.now());
      const observation = {
        sessionId: 's1', idle: true, threshold: 75,
        readThreshold: () => {
          if (stage === 'readThreshold') throw new Error('threshold failed');
          return 75;
        },
        readPercent: () => {
          percentReads++;
          if (stage === 'readPercent' && percentReads > 1) throw new Error('percent failed');
          return 90;
        },
        eligible: () => {
          if (stage === 'eligible') throw new Error('eligibility failed');
          return true;
        },
        trigger,
        onError,
      };

      coordinator.observe(observation);
      expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: `${stage === 'readThreshold' ? 'threshold' : stage === 'readPercent' ? 'percent' : stage === 'eligible' ? 'eligibility' : 'trigger'} failed` }));
      expect(vi.getTimerCount()).toBe(0);

      if (stage === 'trigger') {
        // Dispatch claimed the cooldown before the failing write, so a noisy
        // worker cannot create a tight retry loop.
        coordinator.observe({ ...observation, trigger: () => true });
        expect(vi.getTimerCount()).toBe(0);
      } else {
        // Pre-dispatch failures do not poison the session: a later healthy
        // observation can arm and complete normally.
        coordinator.observe({
          ...observation,
          readThreshold: () => 75,
          readPercent: () => 90,
          eligible: () => true,
          trigger: () => true,
        });
        expect(vi.getTimerCount()).toBe(1);
        expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );

  it('contains the initial percentage read failure', () => {
    const onError = vi.fn();
    const coordinator = new AutoCompactCoordinator();
    expect(() => coordinator.observe({
      sessionId: 's1', idle: true, threshold: 75,
      readThreshold: () => 75,
      readPercent: () => { throw new Error('bot unregistered'); },
      eligible: () => true,
      trigger: () => true,
      onError,
    })).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'bot unregistered' }));
  });
});

describe('isAutoCompactEligible', () => {
  const eligible: AutoCompactEligibilitySnapshot = {
    sessionActive: true,
    workerAlive: true,
    workerReady: true,
    cliReady: true,
    idle: true,
    streamCardSettled: true,
    transferring: false,
    protectedMutation: false,
    pendingTurns: false,
    pendingPrompt: false,
    pendingRawInput: false,
    pendingFollowUpInput: false,
    queuedActivationCount: 0,
    cascadeInFlight: false,
    usageLimited: false,
    agentAttention: false,
    finalDeliveriesInFlight: 0,
    backgroundTaskCount: 0,
    adopted: false,
    headless: false,
    vcMeetingReceiver: false,
    remoteRunner: false,
    supportsCompact: true,
  };

  it('admits only the fully idle local session', () => {
    expect(isAutoCompactEligible(eligible)).toBe(true);
  });

  it.each([
    ['sessionActive', false],
    ['workerAlive', false],
    ['workerReady', false],
    ['cliReady', false],
    ['idle', false],
    ['streamCardSettled', false],
    ['transferring', true],
    ['protectedMutation', true],
    ['pendingTurns', true],
    ['pendingPrompt', true],
    ['pendingRawInput', true],
    ['pendingFollowUpInput', true],
    ['queuedActivationCount', 1],
    ['cascadeInFlight', true],
    ['usageLimited', true],
    ['agentAttention', true],
    ['finalDeliveriesInFlight', 1],
    ['backgroundTaskCount', 1],
    ['adopted', true],
    ['headless', true],
    ['vcMeetingReceiver', true],
    ['remoteRunner', true],
    ['supportsCompact', false],
  ] satisfies Array<[keyof AutoCompactEligibilitySnapshot, boolean | number]>) (
    'rejects when %s is %s',
    (key, value) => {
      expect(isAutoCompactEligible({ ...eligible, [key]: value })).toBe(false);
    },
  );
});

describe('supportsNativeAutoCompact', () => {
  it('admits only CLIs with a confirmed native compact command', () => {
    expect(supportsNativeAutoCompact('claude-code')).toBe(true);
    expect(supportsNativeAutoCompact('codex')).toBe(true);
    expect(supportsNativeAutoCompact('traex')).toBe(false);
    expect(supportsNativeAutoCompact('grok')).toBe(false);
    expect(supportsNativeAutoCompact('seed')).toBe(false);
    expect(supportsNativeAutoCompact('relay')).toBe(false);
    expect(supportsNativeAutoCompact('gemini')).toBe(false);
    expect(supportsNativeAutoCompact('cursor')).toBe(false);
  });

  it('limits Codex unattended compaction to terminal-input tmux sessions', () => {
    expect(supportsNativeAutoCompactRuntime('codex', 'tmux', false)).toBe(true);
    expect(supportsNativeAutoCompactRuntime('codex', 'pty', false)).toBe(false);
    expect(supportsNativeAutoCompactRuntime('codex', 'zellij', false)).toBe(false);
    expect(supportsNativeAutoCompactRuntime('codex', 'herdr', false)).toBe(false);
    expect(supportsNativeAutoCompactRuntime('codex', 'tmux', true)).toBe(false);
    expect(supportsNativeAutoCompactRuntime('claude-code', 'pty', false)).toBe(true);
  });
});

describe('settleAutoCompactSafeComposerRefusal', () => {
  it('clears only the matching synthetic turn pending marker', () => {
    const projection = {
      streamCardPending: true,
      streamCardPendingTurnId: 'auto-compact:abc',
    };
    expect(settleAutoCompactSafeComposerRefusal(projection, {
      turnId: 'auto-compact:abc', status: 'failed', errorCode: 'safe_composer_required',
    })).toBe(true);
    expect(projection).toEqual({
      streamCardPending: false,
      streamCardPendingTurnId: undefined,
    });
  });

  it.each([
    ['human turn', { turnId: 'om_123', status: 'failed', errorCode: 'safe_composer_required' }],
    ['other failure', { turnId: 'auto-compact:abc', status: 'failed', errorCode: 'worker_failed' }],
    ['completed turn', { turnId: 'auto-compact:abc', status: 'completed' }],
  ])('leaves the projection unchanged for %s', (_name, terminal) => {
    const projection = {
      streamCardPending: true,
      streamCardPendingTurnId: 'auto-compact:abc',
    };
    expect(settleAutoCompactSafeComposerRefusal(projection, terminal)).toBe(false);
    expect(projection).toEqual({
      streamCardPending: true,
      streamCardPendingTurnId: 'auto-compact:abc',
    });
  });
});

describe('auto-compact unattended worker write gate', () => {
  const RULE = '─'.repeat(80);
  const COMPOSER = [RULE, '❯ ', RULE].join('\n');
  const PERMISSION_DIALOG = [
    '⏺ BOTMUX_NOTHING_TO_SEND',
    '',
    RULE,
    ' Bash command',
    '',
    '   rm -rf build',
    '   Clean the build directory',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for rm commands in this project",
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n');
  const CODEX_COMPOSER = readFileSync(
    new URL('./fixtures/codex-startup/zmx-history-initialized.txt', import.meta.url),
    'utf8',
  );

  function codexInputState(viewport: string, cursorX = 2) {
    const lines = viewport.split(/\r?\n/);
    const cursorY = lines.findIndex(line => /^\s*[›»]/.test(line));
    if (cursorY < 0) throw new Error('fixture has no Codex composer');
    return { viewport, cursor: { x: cursorX, y: cursorY } };
  }

  function harness(overrides: Record<string, unknown> = {}) {
    const scope: Record<string, any> = {
      renderer: { rawSnapshot: vi.fn(() => COMPOSER) },
      backendScreenEvidenceIsAuthoritativeForMutation: () => true,
      promptCacheKeepaliveRefusal,
      backend: {},
      cliAdapter: { readyPattern: /❯/ },
      cliRestartInProgress: false,
      isPromptReady: true,
      tuiPromptBlocking: false,
      bareShellLaunchBlocked: false,
      isFlushing: false,
      injectionFlushing: false,
      pendingMessages: [],
      pendingRawInputs: [],
      pendingInjections: [],
      pendingSessionRename: null,
      lastInitConfig: { cliId: 'claude-code' },
      ...overrides,
    };
    const refuse = loadWorkerFunction<(msg: { requireSafeComposer?: true }) => string | undefined>(
      'unattendedRawInputRefusal',
      scope,
    );
    return { refuse, scope };
  }

  it('leaves ordinary human raw input unchanged', () => {
    const { refuse, scope } = harness({ renderer: undefined, backend: undefined });
    expect(refuse({})).toBeUndefined();
    expect(scope.backendScreenEvidenceIsAuthoritativeForMutation).toBeDefined();
  });

  it('admits unattended input only with a live empty framed composer', () => {
    const { refuse, scope } = harness();
    expect(refuse({ requireSafeComposer: true })).toBeUndefined();
    expect(scope.renderer.rawSnapshot).toHaveBeenCalledWith({ preserveFormatting: true });
  });

  it('refuses a permission selector even though it contains the ready pattern', () => {
    const { refuse } = harness({ renderer: { rawSnapshot: () => PERMISSION_DIALOG } });
    expect(refuse({ requireSafeComposer: true })).toBe('action_prompt_open');
  });

  it('admits the real Codex fixture without letting its footer steal the composer anchor', () => {
    const state = codexInputState(CODEX_COMPOSER);
    const { refuse } = harness({
      lastInitConfig: { cliId: 'codex' },
      backend: { captureInputState: () => state },
      cliAdapter: { readyPattern: /[›»](?!\s*\d+\.)|\d+% left/ },
    });
    expect(refuse({ requireSafeComposer: true })).toBeUndefined();
  });

  it('rejects real-gap Codex busy state but ignores identical historical scrollback', () => {
    const codexRefusal = (viewport: string) => {
      const state = codexInputState(viewport);
      return harness({
        lastInitConfig: { cliId: 'codex' },
        backend: { captureInputState: () => state },
        cliAdapter: { readyPattern: /[›»](?!\s*\d+\.)|\d+% left/ },
      }).refuse({ requireSafeComposer: true });
    };
    const withStatusGap = (status: string, gap: number) => {
      const lines = CODEX_COMPOSER.split(/\r?\n/);
      const composerY = lines.findIndex(line => /^\s*[›»]/.test(line));
      lines[composerY - gap] = status;
      return lines.join('\n');
    };
    const historical = withStatusGap('◆ Queued for capacity (51s…)', 8);
    const queuedAtNativeGap = withStatusGap('◆ Queued for capacity (51s…)', 2);
    const resumingAtNativeGap = withStatusGap('• Resuming session…', 3);

    expect(codexRefusal(historical)).toBeUndefined();
    expect(codexRefusal(queuedAtNativeGap)).toBe('prompt_not_framed');
    expect(codexRefusal(resumingAtNativeGap)).toBe('prompt_not_framed');
  });

  it('fails closed for a Codex draft, picker, or missing cursor evidence', () => {
    const draft = CODEX_COMPOSER.replace('› Ask Codex to do anything', '› delete everything');
    const picker = CODEX_COMPOSER.replace('› Ask Codex to do anything', '› 1. Continue');
    const codexHarness = (state: ReturnType<typeof codexInputState> | undefined) => harness({
      lastInitConfig: { cliId: 'codex' },
      backend: state ? { captureInputState: () => state } : {},
      cliAdapter: { readyPattern: /[›»](?!\s*\d+\.)|\d+% left/ },
    }).refuse({ requireSafeComposer: true });

    expect(codexHarness(codexInputState(draft, 20))).toBe('composer_not_empty');
    // Cursor-at-Home defeats the coarse cursor-only detector; the exact
    // placeholder/footer proof must still reject this non-empty draft.
    expect(codexHarness(codexInputState(draft))).toBe('prompt_not_framed');
    expect(codexHarness(codexInputState(picker))).toBe('prompt_not_framed');
    expect(codexHarness(undefined)).toBe('no_screen_evidence');
  });

  it.each([
    ['missing backend', { backend: undefined }, 'no_backend'],
    ['missing adapter', { cliAdapter: undefined }, 'no_backend'],
    ['restart', { cliRestartInProgress: true }, 'restarting'],
    ['prompt not ready', { isPromptReady: false }, 'prompt_not_ready'],
    ['TUI prompt', { tuiPromptBlocking: true }, 'tui_prompt_open'],
    ['bare shell', { bareShellLaunchBlocked: true }, 'bare_shell'],
    ['message flush', { isFlushing: true }, 'input_pending'],
    ['injection flush', { injectionFlushing: true }, 'input_pending'],
    ['queued message', { pendingMessages: [{}] }, 'input_pending'],
    ['queued raw input', { pendingRawInputs: [{}] }, 'input_pending'],
    ['queued injection', { pendingInjections: [{}] }, 'input_pending'],
    ['queued rename', { pendingSessionRename: {} }, 'input_pending'],
    ['non-authoritative backend', { backendScreenEvidenceIsAuthoritativeForMutation: () => false }, 'no_screen_evidence'],
    ['missing renderer', { renderer: undefined }, 'no_screen_evidence'],
    ['missing ready pattern', { cliAdapter: {} }, 'no_screen_evidence'],
  ] as const)('fails closed for %s', (_name, override, reason) => {
    const { refuse } = harness(override);
    expect(refuse({ requireSafeComposer: true })).toBe(reason);
  });

  // 源码结构护栏(K4)：无人值守标志必须跨 daemon/worker IPC 接线，session close 必须清理协调器状态。
  it('keeps the daemon-to-worker and close cleanup wiring as a K4 structural guard', () => {
    const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const workerPool = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
    expect(daemon).toContain('requireSafeComposer: true');
    expect(worker).toContain('const unattendedRefusal = unattendedRawInputRefusal(msg)');
    expect(worker).toContain("emitTurnTerminal(msg.turnId, 'failed', 'safe_composer_required')");
    expect(worker).toContain('codexInputState = backend.captureInputState?.()');
    expect(workerPool).toContain('settleAutoCompactSafeComposerRefusal(ds, msg)');
    expect(daemon).toContain('autoCompactCoordinator.cancel(session.sessionId)');
  });
});
