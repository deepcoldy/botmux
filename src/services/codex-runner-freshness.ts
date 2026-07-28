export type CodexRunnerFreshnessState =
  | 'current'
  | 'stale_waiting_idle'
  | 'restarting_fresh'
  | 'failed'
  | 'unknown';

export interface CodexRunnerFreshnessDecision {
  state: CodexRunnerFreshnessState;
  reason:
    | 'not_codex_app'
    | 'adopt_session'
    | 'fresh_spawn'
    | 'build_match'
    | 'persisted_build_missing'
    | 'build_mismatch'
    | 'replacement_reattached'
    | 'current_build_unknown';
  persistOnReady: boolean;
}

export function decideCodexRunnerFreshness(input: {
  cliId: string;
  adoptMode: boolean;
  persistentReattach: boolean;
  replacementExpectedFresh?: boolean;
  currentBuildId?: string;
  persistedBuildId?: string;
}): CodexRunnerFreshnessDecision {
  if (input.cliId !== 'codex-app') {
    return { state: 'current', reason: 'not_codex_app', persistOnReady: false };
  }
  if (input.adoptMode) {
    return { state: 'current', reason: 'adopt_session', persistOnReady: false };
  }
  if (input.replacementExpectedFresh && input.persistentReattach) {
    return { state: 'failed', reason: 'replacement_reattached', persistOnReady: false };
  }
  if (!input.currentBuildId) {
    return { state: 'unknown', reason: 'current_build_unknown', persistOnReady: false };
  }
  if (!input.persistentReattach) {
    return { state: 'current', reason: 'fresh_spawn', persistOnReady: true };
  }
  if (!input.persistedBuildId) {
    return { state: 'stale_waiting_idle', reason: 'persisted_build_missing', persistOnReady: false };
  }
  if (input.persistedBuildId !== input.currentBuildId) {
    return { state: 'stale_waiting_idle', reason: 'build_mismatch', persistOnReady: false };
  }
  return { state: 'current', reason: 'build_match', persistOnReady: false };
}

export function shouldHoldCodexRunnerInput(state: CodexRunnerFreshnessState): boolean {
  return state === 'stale_waiting_idle' || state === 'restarting_fresh' || state === 'failed';
}

export function transitionOnCodexRunnerPrompt(state: CodexRunnerFreshnessState): {
  state: CodexRunnerFreshnessState;
  action: 'publish_ready' | 'reload' | 'ignore';
} {
  if (state === 'stale_waiting_idle') return { state: 'restarting_fresh', action: 'reload' };
  if (state === 'restarting_fresh') return { state: 'current', action: 'publish_ready' };
  if (state === 'failed') return { state: 'failed', action: 'ignore' };
  return { state, action: 'publish_ready' };
}

/**
 * Worker-owned input queues whose dequeue boundary is fenced by runner
 * freshness. Keeping this small seam outside worker.ts makes the stale-runner
 * contract executable without importing the worker process (which installs
 * IPC handlers and starts runtime services at module load).
 */
export class CodexRunnerFreshnessInputQueue<TNormal, TRaw> {
  readonly normal: TNormal[] = [];
  readonly raw: TRaw[] = [];

  constructor(
    private readonly getState: () => CodexRunnerFreshnessState,
    private readonly setState: (state: CodexRunnerFreshnessState) => void,
  ) {}

  enqueueNormal(input: TNormal): void {
    this.normal.push(input);
  }

  enqueueRaw(input: TRaw): void {
    this.raw.push(input);
  }

  takeNormal(): TNormal | undefined {
    if (shouldHoldCodexRunnerInput(this.getState())) return undefined;
    return this.normal.shift();
  }

  takeRaw(): TRaw | undefined {
    if (shouldHoldCodexRunnerInput(this.getState())) return undefined;
    return this.raw.shift();
  }

  onPromptReady(): 'publish_ready' | 'reload' | 'ignore' {
    const transition = transitionOnCodexRunnerPrompt(this.getState());
    this.setState(transition.state);
    return transition.action;
  }

  onReplacementFailed(): void {
    if (this.getState() === 'restarting_fresh') this.setState('failed');
  }
}
