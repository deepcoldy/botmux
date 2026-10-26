/**
 * ZCode preemption: a new user message must STOP the running turn.
 *
 * Root cause this guards: ZCode's busy composer parks a submit in its queue
 * panel ("Submitted after the next tool call") and never drains it. On
 * 2026-10-18 the user asked ZCode to stop renting a GPU mid-turn; the message
 * was parked and silently dropped, and the turn ran to completion burning
 * money. Queuing behind the turn is therefore not an acceptable fix — the new
 * message has to interrupt it.
 *
 * The tests below execute the REAL `preemptActiveTurnForNewMessage` from
 * src/worker.ts inside a `vm` context, so the guard rails under test are the
 * ones that ship (same technique as worker-exact-interrupt.test.ts).
 *
 * Run:  pnpm vitest run test/zcode-preemption.test.ts
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createZcodeAdapter } from '../src/adapters/cli/zcode.js';
import { busyProbeRegion } from '../src/utils/busy-probe.js';

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const start = source.indexOf('/** Key name → ANSI escape sequence (for PtyBackend) */');
const end = source.indexOf('/**\n * Execute an AI-provided key sequence', start);
if (start < 0 || end < start) throw new Error('preemption helpers not found');
// `preemptedTurnId` / `preemptCooldownUntil` are module-level `let`s in
// worker.ts. Left inside the slice they become script-level bindings in the vm
// and SHADOW the context-provided globals, so the harness would neither seed
// nor observe the real state — the once-per-turn guard could be deleted and
// every test still passed on the 2s cooldown alone. Declare them with `var`
// (a bare `var` does not overwrite an existing global binding) so worker.ts's
// own references resolve to the harness state.
const helpers = transpileModule(
  source.slice(start, end)
    .replace(/^let preemptedTurnId.*$/m, 'var preemptedTurnId;')
    .replace(/^let preemptCooldownUntil.*$/m, 'var preemptCooldownUntil;'),
  { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } },
).outputText;


/** Live pane tail captured from zcode 0.16.9 mid-turn. */
const BUSY_SCREEN = [
  '   Tool Bash running',
  '     command: sleep 180; ssh instance shutdown',
  '',
  ' ╭─ Yolo ──────────────────────────────────────────────────────────────────╮',
  ' │ Type to queue input                                                     │',
  ' │ deepseek-flash 93c45030-2f68-4023-a6c4-d2cdf04543c3 | high              │',
  ' ╰─────────────────────────────────────────────────────────────────────────╯',
  '  ⠹ esc to interrupt                                              48.9K   /home/user/project',
].join('\n');

const IDLE_SCREEN = [
  '   已完成。',
  '',
  ' ╭─ Yolo ──────────────────────────────────────────────────────────────────╮',
  ' │ Type a prompt                                                           │',
  ' ╰─────────────────────────────────────────────────────────────────────────╯',
].join('\n');

type Opts = {
  screen?: string;
  adapter?: Partial<ReturnType<typeof createZcodeAdapter>>;
  cliRestartInProgress?: boolean;
  awaitingFirstPrompt?: boolean;
  isFlushing?: boolean;
  injectionFlushing?: boolean;
  commandLineWritesPending?: number;
  isPromptReady?: boolean;
  currentBotmuxTurnId?: string;
};

function harness(opts: Opts = {}) {
  const adapter: any = { ...createZcodeAdapter('/bin/zcode'), ...opts.adapter };
  const controlKey = vi.fn();
  const sendSpecial = vi.fn(() => true);
  const backend = { sendSpecialKeys: sendSpecial };
  const context = createContext({
    cliAdapter: adapter,
    backend,
    cliRestartInProgress: opts.cliRestartInProgress ?? false,
    awaitingFirstPrompt: opts.awaitingFirstPrompt ?? false,
    isFlushing: opts.isFlushing ?? false,
    injectionFlushing: opts.injectionFlushing ?? false,
    commandLineWritesPending: opts.commandLineWritesPending ?? 0,
    isPromptReady: opts.isPromptReady ?? false,
    currentBotmuxTurnId: opts.currentBotmuxTurnId ?? 'om_running',
    currentBotmuxDispatchAttempt: 1,
    preemptedTurnId: undefined,
    preemptCooldownUntil: 0,
    pendingMessages: [] as Array<{ turnId?: string }>,
    inflightInputs: { retireTurn: vi.fn() },
    emitTurnTerminal: vi.fn(),
    idleDetector: { reset: vi.fn() },
    tuiPromptBlocking: false,
    log: vi.fn(),
    cliName: () => 'ZCode',
    busyProbeRegion,
    captureBackendScreen: () => opts.screen ?? BUSY_SCREEN,
    runAfterAmbiguousSubmissionWrites: async (_b: unknown, action: () => unknown) => action(),
    sendCriticalControlKey: async (key: string, action: () => unknown) => { controlKey(key); return action(); },
    sendTermActionOnce: (target: unknown, key: string) => (target as any).sendSpecialKeys(key),
  });
  runInContext(helpers, context);
  const preempt = (incoming: Record<string, unknown> = { turnId: 'om_new' }) =>
    runInContext('preemptActiveTurnForNewMessage', context)(
      incoming, backend,
    ) as boolean;
  return { context, preempt, controlKey, sendSpecial, adapter };
}

describe('preemptActiveTurnForNewMessage', () => {
  it('interrupts a busy turn and settles it as cancelled', async () => {
    const h = harness();
    expect(h.preempt()).toBe(true);
    // The interrupt itself is async (bounded retry helper); let it settle.
    await vi.waitFor(() => expect(h.context.emitTurnTerminal).toHaveBeenCalled());
    expect(h.controlKey).toHaveBeenCalledWith('esc');
    expect(h.context.emitTurnTerminal).toHaveBeenCalledWith(
      'om_running', 'cancelled', 'preempted_by_user_message', 1,
    );
    expect(h.context.inflightInputs.retireTurn).toHaveBeenCalledWith('om_running');
    // The composer is now considered not-ready so the replacement turn waits
    // for the CLI's own redraw instead of being typed into a dying turn.
    expect(h.context.isPromptReady).toBe(false);
  });

  it('does nothing when the CLI is idle (nothing to interrupt)', () => {
    const h = harness({ screen: IDLE_SCREEN, isPromptReady: true });
    expect(h.preempt()).toBe(false);
    expect(h.controlKey).not.toHaveBeenCalled();
  });

  it('does nothing when the screen shows no busy marker (cannot prove a turn runs)', () => {
    // Positive evidence only: "not ready" is also true during startup/teardown,
    // and interrupting there would kill a healthy session.
    const h = harness({ screen: IDLE_SCREEN, isPromptReady: false });
    expect(h.preempt()).toBe(false);
    expect(h.controlKey).not.toHaveBeenCalled();
  });

  it('never preempts for internal runtime traffic', () => {
    for (const turnId of [
      'runtime_command_27',
      'pending_turn_abc_1',
      'local-headless-42',
      'scheduled-nightly',
    ]) {
      const h = harness();
      expect(h.preempt({ turnId })).toBe(false);
      expect(h.controlKey).not.toHaveBeenCalled();
    }
  });

  it('never preempts a queueAfterActiveTurn / at-most-once / continuation input', () => {
    for (const extra of [
      { queueAfterActiveTurn: true },
      { noReplay: true },
      { taskContinuation: { rpcGeneration: 1, authorizationMode: 'inherited' } },
      // A replay carries dispatchAttempt; crash recovery must never kill the
      // very turn it is restoring.
      { dispatchAttempt: 1 },
    ]) {
      const h = harness();
      expect(h.preempt({ turnId: 'om_new', ...extra })).toBe(false);
      expect(h.controlKey).not.toHaveBeenCalled();
    }
  });

  it('still preempts the FIRST delivery from upstream’s durable-primary inbox', () => {
    // v3.50 stamps dispatchAttempt on every ordinary IM turn (attempt 1 on the
    // first delivery, >1 on a claim retry), so "carries an attempt" can no
    // longer mean "replay". Treating it that way would silently disable
    // preemption the day durable coordination is enabled — reintroducing
    // exactly the dropped-message bug this mechanism exists to fix.
    const h = harness();
    expect(h.preempt({ turnId: 'om_new', dispatchAttempt: 1, durablePrimaryInbox: true })).toBe(true);
    expect(h.controlKey).toHaveBeenCalledWith('esc');
  });

  it('still refuses a durable inbox REDELIVERY (attempt > 1)', () => {
    const h = harness();
    expect(h.preempt({ turnId: 'om_new', dispatchAttempt: 2, durablePrimaryInbox: true })).toBe(false);
    expect(h.controlKey).not.toHaveBeenCalled();
  });

  it('refuses to splice an interrupt into an in-flight write', () => {
    for (const state of [
      { isFlushing: true },
      { injectionFlushing: true },
      { commandLineWritesPending: 1 },
      { cliRestartInProgress: true },
      { awaitingFirstPrompt: true },
    ]) {
      const h = harness(state);
      expect(h.preempt()).toBe(false);
      expect(h.controlKey).not.toHaveBeenCalled();
    }
  });

  it('preempts a turn only once', () => {
    const h = harness();
    expect(h.preempt()).toBe(true);
    // Clear the cooldown so the assertion below can only pass because of the
    // once-per-turn guard, not because 2s have not elapsed yet.
    h.context.preemptCooldownUntil = 0;
    // A second message while the first replacement is still landing must queue
    // behind it, not fire another interrupt into the same dying turn.
    expect(h.preempt({ turnId: 'om_second' })).toBe(false);
    expect(h.controlKey).toHaveBeenCalledTimes(1);
  });

  it('ignores a message from the same turn that is already running', () => {
    const h = harness();
    expect(h.preempt({ turnId: 'om_running' })).toBe(false);
  });

  it('does not preempt on adapters that do not opt in', () => {
    const h = harness({ adapter: { preemptsOnNewMessage: false } });
    expect(h.preempt()).toBe(false);
    expect(h.controlKey).not.toHaveBeenCalled();
  });

  it('falls back to the default Ctrl+C on adapters without interruptKey', () => {
    const h = harness({ adapter: { interruptKey: undefined } });
    expect(h.preempt()).toBe(true);
    expect(h.controlKey).toHaveBeenCalledWith('ctrlc');
  });
});
