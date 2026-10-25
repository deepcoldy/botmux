import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { withFileLock } from '../utils/file-lock.js';
import { orcaOperationId, type OrcaCursor, type OrcaMutation } from './orca-session-protocol.js';
import type { OrcaSurface } from '../core/orca-support.js';

export type OrcaAgent = 'codex' | 'claude';
interface PendingTurn {
  turnId: string;
  dispatchAttempt?: number;
  startedAtMs: number;
  completed?: { content: string; failed?: string };
  delivery?: 'prepared' | 'delivered' | 'rejected' | 'unknown';
}
export interface OrcaChatTurn extends PendingTurn {
  cursor: OrcaCursor;
  request: OrcaMutation;
}
export interface OrcaTerminalTurn extends PendingTurn {
  operationId: string;
  content: string;
  baselineMessageId?: string;
  baselineTurnId?: string;
  inputPhase?: 'paste-attempted' | 'paste-confirmed' | 'submit-attempted';
}
export type OrcaPendingTurn = OrcaChatTurn | OrcaTerminalTurn;
export function orcaTurnOperationId(turn: OrcaPendingTurn): string {
  return 'request' in turn ? turn.request.envelope.clientOperationId : turn.operationId;
}

export interface OrcaTerminalIdentity {
  handle: string;
  ptyId: string;
  incarnationId: string;
  tabId: string;
  leafId: string;
  launchOperationId: string;
  transcriptPath?: string;
  providerConfirmed?: boolean;
}
export interface OrcaRunnerState {
  version: 1;
  botmuxSessionId: string;
  agent: OrcaAgent;
  /** Absent in the first Chat-only release; never reinterpret it as Terminal. */
  surface?: OrcaSurface;
  cwd: string;
  profile: string;
  generation: number;
  launchOperationId: string;
  launchOptions?: Record<string, string>;
  sessionId?: string;
  worktreeId?: string;
  terminal?: OrcaTerminalIdentity;
  reopenOperationId?: string;
  reopenArgs?: string;
  pending?: OrcaPendingTurn;
  closed?: boolean;
  rebuiltFromGeneration?: number;
}

/** Separate write-ahead state covers a crash before Botmux receives the first ready frame. */
export class OrcaRunnerStore {
  readonly path: string;
  constructor(directory: string, sessionId: string) {
    const root = join(directory, 'orca');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.path = join(root, createHash('sha256').update(sessionId).digest('hex') + '.json');
  }

  load(): OrcaRunnerState | undefined {
    let text: string;
    try { text = readFileSync(this.path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const state = JSON.parse(text) as OrcaRunnerState;
    if (state.version !== 1 || !state.launchOperationId || !state.botmuxSessionId
        || !['codex', 'claude'].includes(state.agent) || !state.cwd || !state.profile
        || !Number.isSafeInteger(state.generation) || state.generation < 1
        || (state.surface !== undefined && !['chat', 'terminal'].includes(state.surface))) {
      throw new Error('Invalid Orca runner state; refusing to create a replacement conversation');
    }
    if (state.pending && ((state.surface === 'terminal') === ('request' in state.pending))) {
      throw new Error('Orca turn mode differs from its saved conversation');
    }
    return state;
  }

  save(state: OrcaRunnerState): void {
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, this.path);
  }

  /** Hold the existing process-aware lock through the runner lifetime; a second owner fails closed. */
  async own<T>(run: () => Promise<T>): Promise<T> { return withFileLock(this.path, run); }

  initialize(identity: Pick<OrcaRunnerState, 'botmuxSessionId' | 'agent' | 'cwd' | 'profile' | 'surface'>): OrcaRunnerState {
    const saved = this.load();
    if (saved) {
      for (const key of ['botmuxSessionId', 'agent', 'cwd', 'profile'] as const) {
        if (saved[key] !== identity[key]) throw new Error(`Orca ${key} changed; start a new Botmux conversation`);
      }
      return saved;
    }
    const state: OrcaRunnerState = { ...identity, surface: identity.surface ?? 'terminal',
      version: 1, generation: 1, launchOperationId: orcaOperationId() };
    this.save(state);
    return state;
  }
}
