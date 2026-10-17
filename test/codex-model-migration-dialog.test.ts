/**
 * Codex model-migration picker ("Meet <model>: 1. Try new model / 2. Use
 * existing model"). Fixtures below are bytes and screens captured from the
 * real codex-cli 0.162.1 binary (fresh CODEX_HOME with `model = "gpt-5.5"`).
 *
 * See test/worker-codex-model-migration-picker.integration.test.ts for the
 * end-to-end regression through the real worker.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import {
  CodexModelMigrationDialogGuard,
  codexModelMigrationSafeKeys,
  isCodexModelMigrationScreen,
} from '../src/utils/codex-model-migration-dialog.js';

// Codex 0.162.1 first paint: skeleton composer under a `loading` banner.
const SKELETON_CHUNK = '\x1b[?2026h\x1b[?2026h\x1b[3;1H\x1b[J\x1b[?25l\x1b[3;1H \x1b[4;1H  \x1b[38;2;99;168;248;49m>_ \x1b[1m\x1b[39;49mOpenAI Codex\x1b[22m\x1b[2m\x1b[2m (v0.162.1)\x1b[5;1H\x1b[22m     \x1b[2mloading\x1b[6;1H\x1b[22m \x1b[7;1H \x1b[8;1H\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[9;1H\x1b[22m \x1b[10;1H \x1b[39m\x1b[49m\x1b[0m\x1b[8;3H\x1b[?25h\x1b[?2026l';
const DIRECTORY_CHUNK = '\x1b[?2026h\x1b[?25l\x1b[5;6H\x1b[2m/tmp/work\x1b[39m\x1b[49m\x1b[0m\x1b[8;3H\x1b[?25h\x1b[?2026l';
// The picker as streamed: cursor-addressed words, no row layout.
const PICKER_CHUNK = '\x1b[1;2r\x1b[2;1H\r\n\r\n\x1b[r\x1b[8;3H\x1b[3;1H\x1b[J\x1b[?25l\x1b[2;3HMeet\x1b[2;8HGPT-6\x1b[2;14HSol\x1b[4;3HOur\x1b[4;7Hlatest\x1b[4;14HSol\x1b[4;18His\x1b[4;21Hmore\x1b[4;26Hintelligent\x1b[5;3Hcoding.\x1b[7;1H\x1b[7m\x1b[1m› 1. Try new model                                        \x1b[8;3H\x1b[27m\x1b[22m2.\x1b[8;6HUse\x1b[8;10Hexisting\x1b[8;19Hmodel\x1b[10;3H\x1b[1menter/esc\x1b[22m\x1b[2m\x1b[2m confirm · \x1b[22m\x1b[1m^c\x1b[22m\x1b[2m\x1b[2m quit\x1b[39m\x1b[49m\x1b[0m\x1b[?2026l';
// The composer Codex paints after the picker is resolved.
const COMPOSER_CHUNK = '\x1b[1;1H\x1b[J\x1b[?25l\x1b[1;1H \x1b[2;1H  \x1b[38;2;99;168;248;49m>_ \x1b[1m\x1b[39;49mOpenAI Codex\x1b[22m\x1b[2m\x1b[2m (v0.162.1)\x1b[3;1H\x1b[22m     \x1b[2m/tmp/work\x1b[4;1H\x1b[22m \x1b[5;1H \x1b[6;1H\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[7;1H\x1b[22m \x1b[8;1H \x1b[39m\x1b[49m\x1b[0m\x1b[6;3H\x1b[?25h\x1b[?2026l';

// `tmux capture-pane -p -e` of the rendered picker, before and after Down.
const PICKER_SCREEN = '  Meet GPT-6 Sol\n\n  Our latest Sol is more intelligent and more efficient so your usage limits go further.\n  coding.\n\n\x1b[1;7m› 1. Try new model                                        \n\x1b[0m\x1b[39m\x1b[49m  2. Use existing model\n\n  \x1b[1menter/esc\x1b[0;2m\x1b[39m\x1b[49m confirm · \x1b[0;1m\x1b[39m\x1b[49m^c\x1b[0;2m\x1b[39m\x1b[49m quit\n';
const PICKER_SCREEN_AFTER_DOWN = '  Meet GPT-6 Sol\n\n  Our latest Sol is more intelligent and more efficient so your usage limits go further.\n  coding.\n\n  1. Try new model\n\x1b[1;7m› 2. Use existing model                                   \n\x1b[0m\x1b[39m\x1b[49m\n  \x1b[1menter/esc\x1b[0;2m\x1b[39m\x1b[49m confirm · \x1b[0;1m\x1b[39m\x1b[49m^c\x1b[0;2m\x1b[39m\x1b[49m quit\n';
const COMPOSER_SCREEN = '  >_ OpenAI Codex (v0.162.1)\n     /tmp/work\n\n  permissions: YOLO mode\n\n› Ask Codex to do anything\n\n  GPT-5.5 default · /tmp/work · ← for agents\n';
// A resumed session whose restored transcript quotes the menu rows, with the
// live composer and footer below them (tmux `capture-pane -p -e` shape).
const RESUMED_TRANSCRIPT_SCREEN = '  >_ OpenAI Codex (v0.162.1)\n     /tmp/work\n\n\x1b[1m›\x1b[0m why did the menu show these choices?\n  Earlier I was asked to choose:\n\x1b[1m› 1. Try new model\x1b[0m\n  2. Use existing model\n  and kept the configured model.\n\n\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\n\n  GPT-5.5 default · /tmp/work · ← for agents\n';

describe('CodexModelMigrationDialogGuard (stream)', () => {
  it('detects the real cursor-addressed picker chunk', () => {
    expect(new CodexModelMigrationDialogGuard().inspect(PICKER_CHUNK)).toBe(true);
  });

  it('detects the picker when its rows arrive in separate chunks', () => {
    const guard = new CodexModelMigrationDialogGuard();
    const split = PICKER_CHUNK.indexOf('\x1b[8;3H');
    expect(guard.inspect(PICKER_CHUNK.slice(0, split))).toBe(false);
    expect(guard.inspect(PICKER_CHUNK.slice(split))).toBe(true);
  });

  it('ignores the skeleton composer, the resolved composer, the trust dialog and the update picker', () => {
    const guard = new CodexModelMigrationDialogGuard();
    for (const chunk of [
      SKELETON_CHUNK,
      DIRECTORY_CHUNK,
      COMPOSER_CHUNK,
      'Trust this folder?\n› 1. Trust and continue\n  2. Quit',
      '› 1. Update now\n  2. Skip',
    ]) {
      expect(guard.inspect(chunk), JSON.stringify(chunk.slice(0, 40))).toBe(false);
    }
  });

  it('requires the numbered option rows, not just the words', () => {
    const guard = new CodexModelMigrationDialogGuard();
    expect(guard.inspect('You can Try new model now or Use existing model later.')).toBe(false);
  });

  it('forgets menu words once matched and after a respawn reset', () => {
    const guard = new CodexModelMigrationDialogGuard();
    expect(guard.inspect(PICKER_CHUNK)).toBe(true);
    // A later composer redraw must not inherit the matched words.
    expect(guard.inspect(COMPOSER_CHUNK)).toBe(false);
    expect(guard.inspect('1. Try new model')).toBe(false);
    guard.reset();
    expect(guard.inspect('2. Use existing model')).toBe(false);
  });
});

describe('Codex model-migration picker (rendered screen)', () => {
  it('recognises the rendered picker and the resolved composer', () => {
    expect(isCodexModelMigrationScreen(PICKER_SCREEN)).toBe(true);
    expect(isCodexModelMigrationScreen(PICKER_SCREEN_AFTER_DOWN)).toBe(true);
    expect(isCodexModelMigrationScreen(COMPOSER_SCREEN)).toBe(false);
  });

  it('always navigates to "Use existing model" before confirming', () => {
    // Enter on the default row would accept the new model.
    expect(codexModelMigrationSafeKeys(PICKER_SCREEN)).toEqual(['Down', 'Enter']);
    expect(codexModelMigrationSafeKeys(PICKER_SCREEN_AFTER_DOWN)).toEqual(['Enter']);
    expect(codexModelMigrationSafeKeys('› 1. Use existing model\n  2. Try new model\n\n  enter/esc confirm · ^c quit')).toEqual(['Enter']);
    expect(codexModelMigrationSafeKeys('  1. Use existing model\n› 2. Try new model\n\n  enter/esc confirm · ^c quit')).toEqual(['Up', 'Enter']);
  });

  it('fails closed when the highlighted row is unknown', () => {
    expect(codexModelMigrationSafeKeys('  1. Try new model\n  2. Use existing model\n\n  enter/esc confirm · ^c quit')).toBeUndefined();
    expect(codexModelMigrationSafeKeys('› 1. Try new model\n› 2. Use existing model\n\n  enter/esc confirm · ^c quit')).toBeUndefined();
    expect(codexModelMigrationSafeKeys(COMPOSER_SCREEN)).toBeUndefined();
  });

  it('rejects menu rows quoted in a resumed transcript above a live composer', () => {
    expect(isCodexModelMigrationScreen(RESUMED_TRANSCRIPT_SCREEN)).toBe(false);
    expect(isCodexModelMigrationScreen(RESUMED_TRANSCRIPT_SCREEN.replace(/\n/g, '\r\n'))).toBe(false);
    expect(codexModelMigrationSafeKeys(RESUMED_TRANSCRIPT_SCREEN)).toBeUndefined();
    // Same rows with a draft in the composer, or with no composer but more
    // transcript below, are not the active input surface either.
    expect(isCodexModelMigrationScreen('› 1. Try new model\n  2. Use existing model\n\n› my draft')).toBe(false);
    expect(isCodexModelMigrationScreen('› 1. Try new model\n  2. Use existing model\na\nb\nc')).toBe(false);
    // The real picker only has its key-hint footer below the options.
    expect(isCodexModelMigrationScreen('› 1. Try new model\n  2. Use existing model\n\n  enter/esc confirm · ^c quit\n\n')).toBe(true);
  });

  it('requires the picker\'s own confirm footer as positive modal evidence', () => {
    // A reattached owned session whose multi-line composer draft holds the two
    // rows, above the ordinary model/path status footer.
    const draft = '  >_ OpenAI Codex (v0.162.1)\n     /tmp/work\n\n\x1b[1m›\x1b[0m 1. Try new model\n  2. Use existing model\n\n  gpt-5.5 default · /tmp/work · ← for agents\n';
    expect(isCodexModelMigrationScreen(draft)).toBe(false);
    expect(codexModelMigrationSafeKeys(draft), 'Down+Enter would submit the draft').toBeUndefined();
    // Same draft introduced by guidance text (the prompt row sits above).
    const guided = '› please pick one:\n  1. Try new model\n  2. Use existing model\n\n  gpt-5.5 default · /tmp/work\n';
    expect(isCodexModelMigrationScreen(guided)).toBe(false);
    // Footer present but not the last row below the options.
    expect(isCodexModelMigrationScreen('› 1. Try new model\n  2. Use existing model\n  enter/esc confirm · ^c quit\n  gpt-5.5 default · /tmp/work\n')).toBe(false);
    // A reworded footer is simply not recognised (input then flows as before).
    expect(isCodexModelMigrationScreen(PICKER_SCREEN.replace('enter/esc', 'return/esc'))).toBe(false);
    // The real picker: options, then only its confirm footer.
    expect(isCodexModelMigrationScreen(PICKER_SCREEN)).toBe(true);
  });

  it('does not treat prose or unrelated numbered lists as the picker', () => {
    expect(isCodexModelMigrationScreen('› You can Try new model or Use existing model later.')).toBe(false);
    expect(isCodexModelMigrationScreen('1. Try new model\n\nsome text\n\n2. Use existing model')).toBe(false);
    expect(isCodexModelMigrationScreen('› 1. Update now\n  2. Skip')).toBe(false);
  });
});

describe('worker wiring', () => {
  const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

  function slice(startMarker: string, endMarker: string): string {
    const start = workerSource.indexOf(startMarker);
    const end = workerSource.indexOf(endMarker, start);
    expect(start, startMarker).toBeGreaterThan(-1);
    expect(end, endMarker).toBeGreaterThan(start);
    return workerSource.slice(start, end);
  }

  function expectBefore(region: string, first: string, later: string): void {
    const a = region.indexOf(first);
    const b = region.indexOf(later);
    expect(a, first).toBeGreaterThan(-1);
    expect(b, later).toBeGreaterThan(-1);
    expect(a, `${first} must precede ${later}`).toBeLessThan(b);
  }

  it('observes the stream before the one-shot trust latch without consuming the chunk', () => {
    const helper = slice('function handleVisibleStartupInteraction(', 'const APP_RUNNER_OSC_CLI_IDS');
    expectBefore(helper, '\n  noticeCodexModelMigrationDialog(data);\n', 'if (trustHandled) return false;');
    // A coalesced read can carry the picker AND the composer replacing it.
    expect(helper).not.toMatch(/if \(noticeCodexModelMigrationDialog\(/);
  });

  it('never drops ready evidence from the stream alone', () => {
    // A stream match must not strand startup: only the screen gate holds.
    const notice = slice('function noticeCodexModelMigrationDialog(', 'function scheduleCodexModelMigrationRecheck(');
    expect(notice).toContain('): void {');
    expect(notice).not.toMatch(/idleDetector\??\.reset\(/);
  });

  it('holds a screen-idle while the picker owns the input surface', () => {
    const idle = slice("idleDetector.onIdle(async (evidenceSource) => {\n      log('Prompt detected (idle)');", 'drainBridgesThenMarkReady(evidenceSource);\n    });');
    const gate = "if (evidenceSource === 'screen' && await codexModelMigrationHoldsIdleInput(idleBackend)) return;";
    expectBefore(idle, gate, 'markReadyFromEvidence(evidenceSource)');
    expectBefore(idle, gate, 'const busyGuardedIdle');
    // Drain the async renderer before reading the screen, then decide from it.
    const helper = slice('async function codexModelMigrationHoldsIdleInput(', 'function handleVisibleStartupInteraction(');
    // The rejected edge's generation is captured before any await.
    expectBefore(helper, 'const readyGeneration = ptyOutputGeneration.snapshot();', 'await settleCodexModelMigrationRenderer();');
    expectBefore(helper, 'await settleCodexModelMigrationRenderer();', 'codexModelMigrationBlocksReady(readyGeneration)');
  });

  it('checks the picker before the first-prompt timeout clears startup state or force-writes', () => {
    const timeout = slice('const releaseFirstPromptTimeout = (elapsedMs: number, forced: boolean, rendererSettled = false)', 'setTimeout(() => releaseFirstPromptTimeout(FIRST_PROMPT_TIMEOUT_MS, false)');
    const gate = 'if (codexModelMigrationBlocksReady(ptyOutputGeneration.snapshot())) {';
    expectBefore(timeout, gate, 'awaitingFirstPrompt = false;');
    expectBefore(timeout, gate, 'probeBusyPatternIdle(');
    expectBefore(timeout, gate, 'flushPending();');
    expectBefore(timeout, gate, 'markPromptReady();');
  });

  it('holds every other PTY writer: queued/type-ahead flush, injections and raw passthrough', () => {
    const flush = slice('async function flushPending(): Promise<void> {', 'freshnessInputQueue.takeRaw()');
    expectBefore(flush, 'if (hookReviewInputHold) {', 'if (codexModelMigrationBlocksWrite()) return;');
    expectBefore(flush, 'if (codexModelMigrationBlocksWrite()) return;', 'isFlushing = true;');
    expectBefore(flush, 'if (codexModelMigrationBlocksWrite()) return;', 'await runStartupCommands();');
    const injections = slice('async function flushPendingInjections(): Promise<void> {', 'injectionFlushing = true;');
    expect(injections).toContain('if (codexModelMigrationBlocksWrite()) return;');
    const passthrough = slice('|| codexModelMigrationBlocksWrite()) {', "case 'rename_session':");
    expectBefore(passthrough, 'freshnessInputQueue.enqueueRaw(msg);', 'await deliverRawInput(msg);');
  });

  it('retries on its own fenced timer, not the chat screen-update loop (workflow workers skip it)', () => {
    const screenUpdates = slice('function startScreenUpdates()', 'function stopScreenUpdates()');
    expect(screenUpdates).not.toContain('codexModelMigration');
    const schedule = slice('function scheduleCodexModelMigrationRecheck(', 'async function recheckCodexModelMigration(');
    expect(schedule).toContain('cliSpawnGeneration !== generationAtSchedule');
    expect(workerSource).toMatch(/codexModelMigrationGuard\.reset\(\);\n\s*if \(codexModelMigrationRecheckTimer\) \{\n\s*clearTimeout\(codexModelMigrationRecheckTimer\);/);
  });

  it('drains the renderer before every writer and ready decision on the PTY path', () => {
    const flush = slice('async function flushPending(): Promise<void> {', 'freshnessInputQueue.takeRaw()');
    // First thing in flushPending: every later guard sees post-barrier state.
    expectBefore(flush, 'await settleCodexModelMigrationRenderer();', 'if (idleDetector?.isStartupPending()) return;');
    expectBefore(flush, 'cliSpawnGeneration !== generation) return;', 'if (isFlushing) return;');
    expectBefore(flush, 'await settleCodexModelMigrationRenderer();', 'if (codexModelMigrationBlocksWrite()) return;');
    const injections = slice('async function flushPendingInjections(): Promise<void> {', 'injectionFlushing = true;');
    expectBefore(injections, 'await settleCodexModelMigrationRenderer();', 'if (codexModelMigrationBlocksWrite()) return;');
    expect(injections).toContain('cliSpawnGeneration !== generation) return;');
    const raw = slice("case 'raw_input': {", 'await deliverRawInput(msg);');
    expectBefore(raw, 'await settleCodexModelMigrationRenderer();', 'codexModelMigrationBlocksWrite()');
    expect(raw).toContain('cliSpawnGeneration !== rawGeneration');
    const timeout = slice('const releaseFirstPromptTimeout = (elapsedMs: number, forced: boolean, rendererSettled = false)', 'setTimeout(() => releaseFirstPromptTimeout(FIRST_PROMPT_TIMEOUT_MS, false)');
    expectBefore(timeout, 'settleCodexModelMigrationRenderer().then(() => releaseFirstPromptTimeout(elapsedMs, forced, true))', 'codexModelMigrationBlocksReady(');
    const recheck = slice('async function recheckCodexModelMigration(', 'function holdCodexModelMigrationInput(');
    expectBefore(recheck, 'await settleCodexModelMigrationRenderer();', 'codexModelMigrationBlocksInput();');
  });

  it('never resets idle evidence from a picker check', () => {
    const gate = slice('function codexModelMigrationBlocksInput(', 'function codexModelMigrationBlocksWrite(');
    expect(gate).not.toMatch(/idleDetector\??\.reset\(/);
  });
});

describe('Codex model-migration gate (extracted from worker.ts)', () => {
  const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

  function extract(name: string): string {
    const start = workerSource.search(new RegExp(`(?:async )?function ${name}\\(`));
    if (start < 0) throw new Error(`${name} not found in worker.ts`);
    const open = workerSource.indexOf('{', workerSource.indexOf(')', start));
    let depth = 0;
    for (let i = open; i < workerSource.length; i++) {
      if (workerSource[i] === '{') depth++;
      else if (workerSource[i] === '}' && --depth === 0) return workerSource.slice(start, i + 1);
    }
    throw new Error(`${name} brace match failed`);
  }

  interface Api {
    barrierNeeded: () => boolean;
    settle: () => Promise<void>;
    blocks: () => boolean;
    blocksWrite: () => boolean;
    blocksReady: (generation: number) => boolean;
    state: () => { pending: boolean; cleared: boolean; attempts: number; heldReady: number | undefined; heldWrite: boolean; timer: boolean };
    setAwaiting: (value: boolean) => void;
  }

  function load(globals: Record<string, unknown>, awaitingFirstPrompt: boolean): Api {
    const source = [
      `let awaitingFirstPrompt = ${awaitingFirstPrompt};`,
      'let codexModelMigrationPending = false;',
      'let codexModelMigrationCleared = false;',
      'let codexModelMigrationHeldReadyGeneration = undefined;',
      'let codexModelMigrationHeldWrite = false;',
      'let codexModelMigrationRecheckTimer = null;',
      'let codexModelMigrationUnreadableLogged = false;',
      'let codexModelMigrationLastActionAt = 0;',
      'let codexModelMigrationAttempts = 0;',
      'let codexModelMigrationLimitNotified = false;',
      'let backendScreenRevision = 0;',
      ...['RETRY_MS', 'POLL_MS', 'MAX_ATTEMPTS'].map(name =>
        workerSource.match(new RegExp(`const CODEX_MODEL_MIGRATION_${name} = [^;]+;`))![0]),
      ...[
        'codexModelMigrationInScope', 'codexModelMigrationCheckNeeded', 'observeCodexModelMigrationScreen',
        'scheduleCodexModelMigrationRecheck', 'recheckCodexModelMigration', 'holdCodexModelMigrationInput',
        'scheduleCodexModelMigrationRelease', 'releaseCodexModelMigrationHold', 'codexModelMigrationBlocksInput',
        'codexModelMigrationBlocksWrite', 'codexModelMigrationBlocksReady',
        'codexModelMigrationRendererBarrierNeeded', 'settleCodexModelMigrationRenderer',
      ].map(extract),
      `return {
        barrierNeeded: codexModelMigrationRendererBarrierNeeded,
        settle: settleCodexModelMigrationRenderer,
        blocks: codexModelMigrationBlocksInput,
        blocksWrite: codexModelMigrationBlocksWrite,
        blocksReady: codexModelMigrationBlocksReady,
        setAwaiting: (value) => { awaitingFirstPrompt = value; },
        state: () => ({
          pending: codexModelMigrationPending, cleared: codexModelMigrationCleared, attempts: codexModelMigrationAttempts,
          heldReady: codexModelMigrationHeldReadyGeneration, heldWrite: codexModelMigrationHeldWrite,
          timer: codexModelMigrationRecheckTimer !== null,
        }),
      };`,
    ].join('\n');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
    });
    const names = Object.keys(globals);
    // eslint-disable-next-line no-new-func
    return new Function(...names, outputText)(...names.map(name => globals[name])) as Api;
  }

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
  afterEach(() => { vi.useRealTimers(); });

  interface HarnessOptions {
    cliId?: string;
    awaitingFirstPrompt?: boolean;
    /** Return value (or thrown error) per capture call. */
    capture?: () => string;
    /** Backend exposes no capture method and there is no renderer. */
    unobservable?: boolean;
    renderer?: { writeAndFlush: (data: string) => Promise<void> } | null;
    idleDetector?: { reset: () => void; fireIdle?: () => void };
    generation?: { current: number };
    /** PTY backend (no native capture): the screen IS this real renderer. */
    ptyRenderer?: TerminalRenderer;
  }

  function harness(screens: string[], opts: HarnessOptions = {}) {
    const sendSpecialKeys = vi.fn(() => true);
    const send = vi.fn();
    const reset = vi.fn();
    const fireIdle = vi.fn();
    const flushPending = vi.fn(async () => {});
    const flushPendingInjections = vi.fn(async () => {});
    let index = 0;
    const pty = opts.ptyRenderer;
    const capture = vi.fn(opts.capture ?? (pty
      ? () => pty.rawSnapshot()
      : () => screens[Math.min(index++, screens.length - 1)]!));
    const generation = opts.generation ?? { current: 7 };
    const backend = opts.unobservable || pty ? { sendSpecialKeys } : { sendSpecialKeys, captureViewport: () => '' };
    const renderer = pty ?? opts.renderer ?? null;
    const api = load({
      lastInitConfig: { cliId: opts.cliId ?? 'codex' },
      backend,
      cliSpawnGeneration: 1,
      renderer,
      backendScreenEvidenceIsAuthoritativeForMutation: () => true,
      canCaptureBusyPatternScreen: (be: { captureViewport?: unknown }) => !!be.captureViewport || !!renderer,
      captureBackendScreen: capture,
      stripAnsiScreenText: (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''),
      idleDetector: opts.idleDetector ?? { reset, fireIdle },
      ptyOutputGeneration: { snapshot: () => generation.current, isCurrent: (g: number) => g === generation.current },
      pendingInjections: [],
      hasPendingInputForFlush: () => true,
      flushPending,
      flushPendingInjections,
      isCodexModelMigrationScreen,
      codexModelMigrationSafeKeys,
      log: () => {},
      send,
      t: (key: string) => key,
      cliName: () => 'Codex',
      currentBotmuxTurnId: 'om_test',
    }, opts.awaitingFirstPrompt ?? true);
    return { api, sendSpecialKeys, send, reset, fireIdle, flushPending, capture, generation };
  }

  it('selects "Use existing model" and holds input while the picker is visible', () => {
    const { api, sendSpecialKeys, reset } = harness([PICKER_SCREEN]);
    expect(api.blocks()).toBe(true);
    expect(reset).not.toHaveBeenCalled();
    expect(sendSpecialKeys).toHaveBeenCalledWith('Down', 'Enter');
    expect(api.state()).toMatchObject({ pending: true, attempts: 1, timer: true });
  });

  it('keeps holding after startup state was cleared (first-prompt timeout / forced flush)', () => {
    const { api, sendSpecialKeys } = harness([PICKER_SCREEN], { awaitingFirstPrompt: false });
    expect(api.blocks()).toBe(true);
    expect(sendSpecialKeys).toHaveBeenCalledWith('Down', 'Enter');
    expect(api.state()).toMatchObject({ pending: true, cleared: false });
  });

  it('never injects keys or holds input for menu rows in a resumed transcript above the composer', () => {
    const { api, sendSpecialKeys, reset, send } = harness([RESUMED_TRANSCRIPT_SCREEN]);
    expect(api.blocks()).toBe(false);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(api.state()).toMatchObject({ pending: false, attempts: 0, timer: false });
  });

  it('stops capturing once the screen is verified picker-free after startup', () => {
    const { api, capture } = harness([COMPOSER_SCREEN], { awaitingFirstPrompt: false });
    expect(api.blocks()).toBe(false);
    expect(api.state().cleared).toBe(true);
    expect(api.blocks()).toBe(false);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  // ── renderer barrier for writers (PTY, real TerminalRenderer) ────────────

  it('a writer sees a picker repaint only after the renderer barrier (PTY path)', async () => {
    vi.useRealTimers();  // xterm's parser runs on real timers
    const renderer = new TerminalRenderer(160, 50);
    try {
      await renderer.writeAndFlush(COMPOSER_CHUNK);
      const { api, sendSpecialKeys } = harness([], { ptyRenderer: renderer, awaitingFirstPrompt: false });
      expect(api.barrierNeeded(), 'renderer is the screen source').toBe(true);
      // The picker repaint was just handed to xterm (as handlePtyDataChunk
      // does), and a raw passthrough / type-ahead message arrives now.
      renderer.write(PICKER_CHUNK);
      expect(isCodexModelMigrationScreen(renderer.rawSnapshot()), 'not parsed yet').toBe(false);
      await api.settle();
      expect(api.blocksWrite(), 'the writer must be held after the barrier').toBe(true);
      expect(sendSpecialKeys).toHaveBeenCalledWith('Down', 'Enter');
    } finally {
      renderer.dispose();
    }
  });

  it('needs no barrier when the backend captures natively (tmux)', () => {
    const { api } = harness([PICKER_SCREEN], { renderer: { writeAndFlush: async () => {} } });
    expect(api.barrierNeeded()).toBe(false);
  });

  // ── stale renderer frames (PTY) ──────────────────────────────────────────

  it('a stale picker frame never erases the composer redraw\'s idle evidence', () => {
    // The composer redraw was already fed; xterm has not parsed it yet, so the
    // capture still shows the picker.
    const detector = new IdleDetector(createCodexAdapter());
    const idle = vi.fn();
    detector.onIdle(idle);
    detector.feed(COMPOSER_CHUNK);
    const { api } = harness([PICKER_SCREEN], { idleDetector: detector });
    expect(api.blocks()).toBe(true);
    vi.advanceTimersByTime(2_500);
    expect(idle, 'the composer must still reach its ready edge').toHaveBeenCalledTimes(1);
  });

  it('the retry loop waits for the renderer to finish parsing before judging the screen', async () => {
    let parsed = false;
    const renderer = { writeAndFlush: vi.fn(async () => { parsed = true; }) };
    const { api, sendSpecialKeys } = harness([], {
      renderer,
      capture: () => (parsed ? COMPOSER_SCREEN : PICKER_SCREEN),
    });
    expect(api.blocks()).toBe(true);           // attempt 1 on the real picker
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
    parsed = false;                             // the closing redraw is fed but not parsed
    await vi.advanceTimersByTimeAsync(1_000);   // recheck: flush, then capture
    expect(renderer.writeAndFlush).toHaveBeenCalled();
    expect(sendSpecialKeys, 'no keys pressed on a stale frame').toHaveBeenCalledTimes(1);
    expect(api.state()).toMatchObject({ pending: false, timer: false });
  });

  it('re-drives a rejected ready edge on release when no output followed it', async () => {
    const screens = [PICKER_SCREEN];
    const { api, reset, fireIdle } = harness([], { capture: () => screens[0]! });
    expect(api.blocksReady(7)).toBe(true);
    screens[0] = COMPOSER_SCREEN;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(fireIdle).toHaveBeenCalledTimes(1);
    expect(api.state()).toMatchObject({ pending: false, heldReady: undefined });
  });

  it('leaves a fresh quiescence cycle alone when output followed the rejected edge', async () => {
    const screens = [PICKER_SCREEN];
    const generation = { current: 7 };
    const { api, reset, fireIdle } = harness([], { capture: () => screens[0]!, generation });
    expect(api.blocksReady(7)).toBe(true);
    screens[0] = COMPOSER_SCREEN;
    generation.current = 9;                     // the composer redraw was fed
    await vi.advanceTimersByTimeAsync(1_100);
    expect(reset).not.toHaveBeenCalled();
    expect(fireIdle).not.toHaveBeenCalled();
  });

  it('re-kicks a held writer asynchronously, never from inside the observing caller', async () => {
    const screens = [PICKER_SCREEN];
    const { api, flushPending } = harness([], { awaitingFirstPrompt: false, capture: () => screens[0]! });
    expect(api.blocksWrite()).toBe(true);
    screens[0] = COMPOSER_SCREEN;
    expect(api.blocksWrite()).toBe(false);      // e.g. flushPending itself sees it gone
    expect(flushPending, 'no re-entrant flush').not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(flushPending).toHaveBeenCalledTimes(1);
  });

  it('during startup leaves the first flush to the idle path instead of kicking writers', async () => {
    const screens = [PICKER_SCREEN];
    const { api, flushPending } = harness([], { capture: () => screens[0]! });
    expect(api.blocksWrite()).toBe(true);
    screens[0] = COMPOSER_SCREEN;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(api.state().pending).toBe(false);
    expect(flushPending).not.toHaveBeenCalled();
  });

  // ── capture failures (tmux) ──────────────────────────────────────────────

  it.each([
    ['a blank capture (TmuxPipeBackend timeout)', () => ''],
    ['a throwing capture', () => { throw new Error('tmux capture-pane timed out'); }],
  ])('keeps an existing hold on %s and never caches it as cleared', async (_label, failure) => {
    let fail = false;
    const { api, sendSpecialKeys } = harness([], {
      awaitingFirstPrompt: false,
      capture: () => (fail ? (failure as () => string)() : PICKER_SCREEN),
    });
    expect(api.blocks()).toBe(true);
    fail = true;
    expect(api.blocks()).toBe(true);
    expect(api.state()).toMatchObject({ pending: true, cleared: false });
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
    // The next readable capture still decides.
    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.state().pending).toBe(true);
    expect(sendSpecialKeys).toHaveBeenCalledTimes(2);
  });

  it('holds on an unreadable capture during startup, but not once startup is over without a hold', () => {
    const startup = harness([], { capture: () => '' });
    expect(startup.api.blocks()).toBe(true);
    const later = harness([], { awaitingFirstPrompt: false, capture: () => '' });
    expect(later.api.blocks()).toBe(false);
    expect(later.api.state()).toMatchObject({ pending: false, cleared: false });
  });

  it('keeps the previous behaviour when there is no screen source at all (workflow PTY worker)', () => {
    const { api, capture, sendSpecialKeys } = harness([PICKER_SCREEN], { unobservable: true });
    expect(api.blocks()).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  // ── retries without the chat screen-update loop (v3 workflow) ────────────

  it('exhausts the three attempts and notifies on its own timer, with no screen-update tick', async () => {
    const { api, sendSpecialKeys, send } = harness([PICKER_SCREEN]);
    expect(api.blocks()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendSpecialKeys).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ type: 'user_notify', message: 'worker.codex_model_migration_unresolved' });
    // It keeps polling (slower) so a later manual resolution is noticed.
    expect(api.state().timer).toBe(true);
  });

  it('throttles retries within the window', () => {
    const { api, sendSpecialKeys } = harness([PICKER_SCREEN]);
    expect(api.blocks()).toBe(true);
    expect(api.blocks()).toBe(true);
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
  });

  it('spends the budget on an unreadable selection and then notifies instead of guessing', async () => {
    const unreadable = PICKER_SCREEN.replace('› 1. Try new model', '  1. Try new model');
    expect(isCodexModelMigrationScreen(unreadable)).toBe(true);
    const { api, sendSpecialKeys, send } = harness([unreadable]);
    expect(api.blocks()).toBe(true);
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reads tmux captures whose rows end with CRLF', () => {
    const crlf = PICKER_SCREEN.replace(/\n/g, '\r\n');
    const { api, sendSpecialKeys } = harness([crlf]);
    expect(api.blocks()).toBe(true);
    expect(sendSpecialKeys).toHaveBeenCalledWith('Down', 'Enter');
  });

  it('is inert for other CLIs', () => {
    const { api, sendSpecialKeys, reset, capture } = harness([PICKER_SCREEN], { cliId: 'claude-code' });
    expect(api.blocks()).toBe(false);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});
