import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  chmodSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import type { CliId, PtyHandle } from '../adapters/cli/types.js';

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const CANDIDATE_RUNTIME_DIR = 'candidate-runtime';
const BOTMUX_BUILD_MANIFEST = 'botmux-build-manifest.json';
const BOTMUX_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface CandidateRuntimeContract {
  schemaVersion: 1;
  incidentKey: string;
  eventId: string;
  candidateDispatchId: string;
  releaseId: string;
  releaseManifestSha256: string;
  runtimeBundleId: string;
  runtimeName: CliId;
  searchRcaCommit: string;
  botmuxCommit: string;
  botmuxArtifactSha256: string;
  workspaceSnapshot: {
    realpath: string;
    repository: string;
    commit: string;
  };
  capabilityLockSha256: string;
  skillsRoot: string;
  skillsSha256: string;
  executable: { realpath: string; sha256: string };
  disabledFeatures: ['memories'];
  model?: string;
  investigation: {
    title: string;
    symptom: string;
    preparedInput: { content: string; [key: string]: unknown };
    sourceSnapshot: Record<string, unknown> | null;
  };
  shadowTarget: { larkAppId: string; chatId: string };
}

export interface CandidateRuntimeIdentity {
  incidentKey: string;
  candidateDispatchId: string;
  larkAppId: string;
  chatId: string;
}

export interface CandidateBotmuxIdentityOptions {
  botmuxSourceRoot?: string;
  observeBotmuxIdentity?: () => CandidateBotmuxBuildIdentity;
}

export interface CandidateBotmuxBuildIdentity {
  commit: string;
  artifactSha256: string;
}

/** Search RCA's frozen `coco` bundle is TRAE CLI Next (0.200.x). Keep the
 * release-facing Runtime identity stable while selecting BotMux's rollout-
 * backed TRAE adapter instead of the legacy Coco events.jsonl adapter. */
export function candidateRuntimeCliId(runtimeName: CliId): CliId {
  return runtimeName === 'coco' ? 'traex' : runtimeName;
}

interface CandidateBuildManifest {
  schemaVersion: 1;
  botmuxCommit: string;
  treeSha256: string;
  files: Array<{ path: string; sha256: string }>;
}

export interface CandidateRuntimeAttestation {
  schemaVersion: 1;
  sessionId: string;
  workerGeneration: number;
  phase: 'fresh' | 'resume';
  candidateDispatchId: string;
  releaseId: string;
  releaseManifestSha256: string;
  runtimeBundleId: string;
  searchRcaCommit: string;
  botmuxCommit: string;
  botmuxArtifactSha256: string;
  capabilityLockSha256: string;
  executable: { realpath: string; sha256: string };
  argv: string[];
  workspace: { realpath: string; repository: string; commit: string };
  skills: { realpath: string; effectiveRoot: string; sha256: string };
  isolation: {
    home: string;
    runtimeName: CliId;
    runtimeHome: string;
    environment: Record<string, string>;
    traeHome?: string;
    cocoCacheRoot?: string;
    disabledFeatures: ['memories'];
  };
  createdAt: string;
}

export type CandidateRuntimeStartupStatus =
  | 'starting'
  | 'ready'
  | 'accepted'
  | 'responded'
  | 'runtime_incompatible';

export interface CandidateRuntimeStartupEvidence {
  schemaVersion: 1;
  status: CandidateRuntimeStartupStatus;
  runtimeName: string;
  sessionId: string;
  workerGeneration: number;
  phase: 'fresh' | 'resume';
  candidateDispatchId: string;
  releaseId: string;
  releaseManifestSha256: string;
  runtimeBundleId: string;
  searchRcaCommit: string;
  botmuxCommit: string;
  botmuxArtifactSha256: string;
  freshIsolatedEnvironment: boolean;
  humanInteractionCount: number;
  taskAcceptedByRuntime: boolean;
  responseObserved: boolean;
  transitions: Array<{
    status: CandidateRuntimeStartupStatus;
    occurredAt: string;
    evidence?: Record<string, unknown>;
  }>;
  diagnostic?: { readinessTimeoutMs: number; terminalTail: string };
  createdAt: string;
  updatedAt: string;
}

type CandidateRuntimeReadyEvidence = {
  kind: 'runtime_ready';
  evidenceRef: string;
};

type CandidateRuntimeAcceptEvidence = {
  kind: 'cli_transcript' | 'native_rpc';
  nativeSessionId: string;
  transcriptRef: string;
};

type CandidateRuntimeResponseEvidence = {
  kind: 'cli_transcript_terminal' | 'native_rpc_terminal';
  nativeSessionId: string;
  transcriptRef: string;
  output: string;
};

const STARTUP_DIAGNOSTIC_LIMIT = 64 * 1024;
const KNOWN_TRUST_PROMPT = /Yes, I trust this folder|Yes, continue/;

export function createCandidateRuntimeStartupInteractionHandler(): {
  readonly humanInteractionCount: 0;
  readonly automatedInteractionCount: number;
  handle(output: string, pty: PtyHandle): boolean;
} {
  let trustHandled = false;
  let automatedInteractionCount = 0;
  return {
    humanInteractionCount: 0,
    get automatedInteractionCount() { return automatedInteractionCount; },
    handle(output, pty) {
      if (trustHandled) return false;
      const plain = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      if (!KNOWN_TRUST_PROMPT.test(plain)) return false;
      trustHandled = true;
      automatedInteractionCount += 1;
      if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
      else pty.write('\r');
      return true;
    },
  };
}

export function candidateRuntimeReadyOutput(
  adapter: { candidateReadyPattern?: RegExp },
  output: string,
): boolean {
  if (!adapter.candidateReadyPattern || !output) return false;
  const plain = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  adapter.candidateReadyPattern.lastIndex = 0;
  return adapter.candidateReadyPattern.test(plain);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function describeTree(target: string, base = target): Array<{ path: string; sha256: string }> {
  const info = lstatSync(target);
  if (info.isSymbolicLink()) {
    throw new Error(`Candidate runtime tree contains a symbolic link: ${target}`);
  }
  if (info.isFile()) return [{ path: relative(base, target) || '.', sha256: hashFile(target) }];
  if (!info.isDirectory()) throw new Error(`Unsupported Candidate runtime entry: ${target}`);
  return readdirSync(target, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => describeTree(join(target, entry.name), base));
}

function describeDistTree(target: string, base = target): Array<{ path: string; sha256: string }> {
  return readdirSync(target, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const absolute = join(target, entry.name);
      if (absolute === join(base, BOTMUX_BUILD_MANIFEST)) return [];
      if (entry.isDirectory()) return describeDistTree(absolute, base);
      if (!entry.isFile() || !lstatSync(absolute).isFile() || realpathSync(absolute) !== absolute) {
        throw new Error(`Candidate BotMux dist tree contains an unsupported entry: ${absolute}`);
      }
      return [{ path: relative(base, absolute).split(sep).join('/'), sha256: hashFile(absolute) }];
    });
}

export function hashCandidateRuntimeTree(target: string): string {
  const canonical = realpathSync(target);
  return createHash('sha256').update(JSON.stringify(describeTree(canonical))).digest('hex');
}

export function validateCandidateRuntimeContract(
  value: unknown,
  identity: CandidateRuntimeIdentity,
  botmuxIdentity: CandidateBotmuxIdentityOptions = {},
): CandidateRuntimeContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Candidate launch requires a runtime contract');
  }
  const contract = value as Partial<CandidateRuntimeContract>;
  if (contract.schemaVersion !== 1
    || !nonEmpty(contract.incidentKey)
    || !nonEmpty(contract.eventId)
    || !nonEmpty(contract.candidateDispatchId)
    || !nonEmpty(contract.releaseId)
    || !nonEmpty(contract.runtimeBundleId)
    || !nonEmpty(contract.runtimeName)
    || !COMMIT.test(contract.searchRcaCommit ?? '')
    || !COMMIT.test(contract.botmuxCommit ?? '')
    || !SHA256.test(contract.botmuxArtifactSha256 ?? '')
    || !nonEmpty(contract.skillsRoot)
    || !nonEmpty(contract.executable?.realpath)
    || !nonEmpty(contract.workspaceSnapshot?.realpath)
    || !nonEmpty(contract.workspaceSnapshot?.repository)
    || !COMMIT.test(contract.workspaceSnapshot?.commit ?? '')
    || !SHA256.test(contract.releaseManifestSha256 ?? '')
    || !SHA256.test(contract.capabilityLockSha256 ?? '')
    || !SHA256.test(contract.skillsSha256 ?? '')
    || !SHA256.test(contract.executable?.sha256 ?? '')
    || contract.disabledFeatures?.length !== 1
    || contract.disabledFeatures[0] !== 'memories'
    || !nonEmpty(contract.investigation?.title)
    || !nonEmpty(contract.investigation?.symptom)
    || !contract.investigation?.preparedInput
    || typeof contract.investigation.preparedInput !== 'object'
    || !nonEmpty(contract.investigation.preparedInput.content)
    || (contract.investigation.sourceSnapshot !== null
      && (typeof contract.investigation.sourceSnapshot !== 'object'
        || Array.isArray(contract.investigation.sourceSnapshot)))
    || !nonEmpty(contract.shadowTarget?.larkAppId)
    || !nonEmpty(contract.shadowTarget?.chatId)) {
    throw new Error('Candidate runtime contract is incomplete');
  }
  if (contract.incidentKey !== identity.incidentKey
    || contract.candidateDispatchId !== identity.candidateDispatchId
    || contract.shadowTarget.larkAppId !== identity.larkAppId
    || contract.shadowTarget.chatId !== identity.chatId) {
    throw new Error('Candidate runtime contract identity mismatch');
  }
  const observedBotmux = botmuxIdentity.observeBotmuxIdentity?.()
    ?? candidateBotmuxBuildIdentity(botmuxIdentity.botmuxSourceRoot, { requireClean: true });
  if (contract.botmuxCommit !== observedBotmux.commit) {
    throw new Error(
      `Candidate BotMux commit mismatch: expected ${contract.botmuxCommit}, got ${observedBotmux.commit}`,
    );
  }
  if (contract.botmuxArtifactSha256 !== observedBotmux.artifactSha256) {
    throw new Error('Candidate BotMux artifact mismatch');
  }
  if (!contract.executable.realpath.startsWith('/')
    || !contract.workspaceSnapshot.realpath.startsWith('/')
    || !contract.skillsRoot.startsWith('/')) {
    throw new Error('Candidate runtime contract paths must be absolute');
  }
  return structuredClone(contract as CandidateRuntimeContract);
}

/** Host-side preflight used before the durable launch ledger is allowed to
 * create a Feishu topic. The worker repeats the same checks immediately before
 * every fresh/resume spawn to close the time-of-check/time-of-use window. */
export function assertCandidateRuntimeArtifacts(
  contract: CandidateRuntimeContract,
  botmuxIdentity: CandidateBotmuxIdentityOptions = {},
): CandidateRuntimeContract {
  const observedBotmux = botmuxIdentity.observeBotmuxIdentity?.()
    ?? candidateBotmuxBuildIdentity(botmuxIdentity.botmuxSourceRoot, { requireClean: true });
  if (observedBotmux.commit !== contract.botmuxCommit) {
    throw new Error('Candidate BotMux commit mismatch');
  }
  if (observedBotmux.artifactSha256 !== contract.botmuxArtifactSha256) {
    throw new Error('Candidate BotMux artifact mismatch');
  }
  const executable = realpathSync(contract.executable.realpath);
  if (executable !== contract.executable.realpath
    || hashFile(executable) !== contract.executable.sha256) {
    throw new Error('Candidate executable attestation mismatch');
  }
  const workspace = realpathSync(contract.workspaceSnapshot.realpath);
  if (workspace !== contract.workspaceSnapshot.realpath) {
    throw new Error('Candidate workspace realpath mismatch');
  }
  const git = readGitAttestation(workspace);
  if (git.commit !== contract.workspaceSnapshot.commit) {
    throw new Error('Candidate workspace commit mismatch');
  }
  if (git.repository !== contract.workspaceSnapshot.repository) {
    throw new Error('Candidate workspace repository mismatch');
  }
  const skillsRoot = realpathSync(contract.skillsRoot);
  if (skillsRoot !== contract.skillsRoot
    || hashCandidateRuntimeTree(skillsRoot) !== contract.skillsSha256) {
    throw new Error('Candidate Skills digest mismatch');
  }
  return contract;
}

function candidateRuntimeRoot(dataDir: string, sessionId: string): string {
  return join(dataDir, CANDIDATE_RUNTIME_DIR, sessionId);
}

export function candidateRuntimeStartupProbePath(
  dataDir: string,
  sessionId: string,
  workerGeneration: number,
  phase: 'fresh' | 'resume',
): string {
  return join(
    candidateRuntimeRoot(dataDir, sessionId),
    'startup-probes',
    `${workerGeneration}-${phase}.json`,
  );
}

class CandidateRuntimeStartupProbe {
  readonly evidencePath: string;
  private readonly readinessTimeoutMs: number;
  private readonly onIncompatible?: (
    evidence: CandidateRuntimeStartupEvidence & { status: 'runtime_incompatible' },
  ) => void;
  private readonly evidence: CandidateRuntimeStartupEvidence;
  private readinessTimer: NodeJS.Timeout | undefined;
  private terminalTail = '';
  private acceptedNativeSessionId: string | undefined;

  constructor(input: {
    contract: CandidateRuntimeContract;
    runtimeName: string;
    sessionId: string;
    workerGeneration: number;
    phase: 'fresh' | 'resume';
    isolatedHome: string;
    dataDir: string;
    readinessTimeoutMs?: number;
    onIncompatible?: (
      evidence: CandidateRuntimeStartupEvidence & { status: 'runtime_incompatible' },
    ) => void;
  }) {
    const runtimeName = input.runtimeName.trim();
    if (!runtimeName) throw new Error('Candidate startup probe requires runtimeName');
    if (!Number.isSafeInteger(input.workerGeneration) || input.workerGeneration < 1) {
      throw new Error('Candidate startup probe requires a worker generation');
    }
    this.readinessTimeoutMs = input.readinessTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.readinessTimeoutMs) || this.readinessTimeoutMs < 1) {
      throw new Error('Candidate startup probe readiness timeout is invalid');
    }
    const expectedHome = join(candidateRuntimeRoot(input.dataDir, input.sessionId), 'home');
    if (realpathSync(input.isolatedHome) !== realpathSync(expectedHome)) {
      throw new Error('Candidate startup probe HOME is not the isolated session HOME');
    }
    const now = new Date().toISOString();
    this.evidencePath = candidateRuntimeStartupProbePath(
      input.dataDir,
      input.sessionId,
      input.workerGeneration,
      input.phase,
    );
    this.onIncompatible = input.onIncompatible;
    this.evidence = {
      schemaVersion: 1,
      status: 'starting',
      runtimeName,
      sessionId: input.sessionId,
      workerGeneration: input.workerGeneration,
      phase: input.phase,
      candidateDispatchId: input.contract.candidateDispatchId,
      releaseId: input.contract.releaseId,
      releaseManifestSha256: input.contract.releaseManifestSha256,
      runtimeBundleId: input.contract.runtimeBundleId,
      searchRcaCommit: input.contract.searchRcaCommit,
      botmuxCommit: input.contract.botmuxCommit,
      botmuxArtifactSha256: input.contract.botmuxArtifactSha256,
      freshIsolatedEnvironment: input.phase === 'fresh',
      humanInteractionCount: 0,
      taskAcceptedByRuntime: false,
      responseObserved: false,
      transitions: [{ status: 'starting', occurredAt: now }],
      createdAt: now,
      updatedAt: now,
    };
    this.persist();
    this.readinessTimer = setTimeout(() => this.failIncompatible(), this.readinessTimeoutMs);
    this.readinessTimer.unref?.();
  }

  observeTerminalOutput(output: string): void {
    if (!['starting', 'ready'].includes(this.evidence.status) || !output) return;
    this.terminalTail = `${this.terminalTail}${output}`.slice(-STARTUP_DIAGNOSTIC_LIMIT);
  }

  recordHumanInteraction(): void {
    if (this.evidence.status === 'responded' || this.evidence.status === 'runtime_incompatible') return;
    this.evidence.humanInteractionCount += 1;
    this.evidence.updatedAt = new Date().toISOString();
    this.persist();
  }

  markReady(evidence: CandidateRuntimeReadyEvidence): void {
    if (this.evidence.status !== 'starting') {
      throw new Error(`Candidate Runtime ready transition is invalid from ${this.evidence.status}`);
    }
    if (evidence.kind !== 'runtime_ready' || !nonEmpty(evidence.evidenceRef)) {
      throw new Error('Candidate Runtime ready evidence is invalid');
    }
    this.transition('ready', evidence);
    this.armIncompatibleTimer();
  }

  markAccepted(evidence: CandidateRuntimeAcceptEvidence | Record<string, unknown>): void {
    if (this.evidence.status !== 'ready') {
      throw new Error(`Candidate Runtime accepted transition is invalid from ${this.evidence.status}`);
    }
    if (!['cli_transcript', 'native_rpc'].includes(String(evidence.kind))
      || !nonEmpty(evidence.nativeSessionId) || !nonEmpty(evidence.transcriptRef)) {
      throw new Error('Candidate Runtime acceptance evidence must be a durable transcript or native RPC');
    }
    this.acceptedNativeSessionId = evidence.nativeSessionId;
    this.evidence.taskAcceptedByRuntime = true;
    this.clearReadinessTimer();
    this.transition('accepted', evidence);
  }

  markResponse(evidence: CandidateRuntimeResponseEvidence | Record<string, unknown>): void {
    if (this.evidence.status !== 'accepted') {
      throw new Error(`Candidate Runtime response transition is invalid from ${this.evidence.status}`);
    }
    if (!['cli_transcript_terminal', 'native_rpc_terminal'].includes(String(evidence.kind))
      || !nonEmpty(evidence.nativeSessionId) || !nonEmpty(evidence.transcriptRef)
      || !nonEmpty(evidence.output)
      || evidence.nativeSessionId !== this.acceptedNativeSessionId) {
      throw new Error('Candidate Runtime response evidence is invalid');
    }
    this.evidence.responseObserved = true;
    this.transition('responded', evidence);
  }

  dispose(): void {
    this.clearReadinessTimer();
  }

  private transition(status: CandidateRuntimeStartupStatus, evidence: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.evidence.status = status;
    this.evidence.updatedAt = now;
    this.evidence.transitions.push({ status, occurredAt: now, evidence: structuredClone(evidence) });
    this.persist();
  }

  private clearReadinessTimer(): void {
    if (this.readinessTimer) clearTimeout(this.readinessTimer);
    this.readinessTimer = undefined;
  }

  private armIncompatibleTimer(): void {
    this.clearReadinessTimer();
    this.readinessTimer = setTimeout(() => this.failIncompatible(), this.readinessTimeoutMs);
    this.readinessTimer.unref?.();
  }

  private failIncompatible(): void {
    if (!['starting', 'ready'].includes(this.evidence.status)) return;
    this.readinessTimer = undefined;
    const now = new Date().toISOString();
    this.evidence.status = 'runtime_incompatible';
    this.evidence.updatedAt = now;
    this.evidence.diagnostic = {
      readinessTimeoutMs: this.readinessTimeoutMs,
      terminalTail: this.terminalTail,
    };
    this.evidence.transitions.push({
      status: 'runtime_incompatible',
      occurredAt: now,
      evidence: {
        errorCode: 'runtime_incompatible',
        readinessTimeoutMs: this.readinessTimeoutMs,
      },
    });
    this.persist();
    this.onIncompatible?.(structuredClone(
      this.evidence as CandidateRuntimeStartupEvidence & { status: 'runtime_incompatible' },
    ));
  }

  private persist(): void {
    mkdirSync(dirname(this.evidencePath), { recursive: true });
    atomicWriteFileSync(this.evidencePath, `${JSON.stringify(this.evidence, null, 2)}\n`, { mode: 0o600 });
    syncPath(this.evidencePath);
    syncPath(dirname(this.evidencePath));
  }
}

export function createCandidateRuntimeStartupProbe(
  input: ConstructorParameters<typeof CandidateRuntimeStartupProbe>[0],
): CandidateRuntimeStartupProbe {
  return new CandidateRuntimeStartupProbe(input);
}

export type CandidateRuntimeStartupCoordinatorInput =
  ConstructorParameters<typeof CandidateRuntimeStartupProbe>[0] & {
  turnId?: string;
  dispatchAttempt?: number;
  log?: (message: string) => void;
};

export interface CandidateRuntimeStartupSubmitted {
  turnId: string;
  dispatchAttempt?: number;
  kind: 'cli_transcript' | 'native_rpc';
  nativeSessionId: string;
  transcriptRef: string;
}

export interface CandidateRuntimeStartupTerminal {
  turnId: string;
  dispatchAttempt?: number;
  status: 'completed' | 'failed' | 'ambiguous' | 'cancelled';
  evidence?: { nativeSessionId: string; transcriptRef: string };
  responseOutput?: string;
}

/** Production coordinator for the Candidate startup proof. It deliberately
 * treats proof-state drift as diagnostic-only: turn IPC is authoritative and
 * must never be suppressed because a duplicate/redelivered transition reached
 * this auxiliary evidence state machine. */
export function createCandidateRuntimeStartupCoordinator(
  input: CandidateRuntimeStartupCoordinatorInput,
): {
  readonly evidencePath: string;
  readonly humanInteractionCount: number;
  readonly automatedInteractionCount: number;
  observeTerminalOutput(output: string): void;
  handleTerminalOutput(
    output: string,
    adapter: { id?: string; candidateReadyPattern?: RegExp },
    pty: PtyHandle,
  ): boolean;
  markPromptReady(adapterId: string, evidenceRef?: string): boolean;
  recordSubmitted(submission: CandidateRuntimeStartupSubmitted): void;
  recordFinalOutput(output: { turnId: string; dispatchAttempt?: number; content: string }): void;
  recordTerminal(terminal: CandidateRuntimeStartupTerminal): void;
  recordHumanInteraction(): void;
  dispose(): void;
} {
  const probe = createCandidateRuntimeStartupProbe(input);
  const interactions = createCandidateRuntimeStartupInteractionHandler();
  const log = input.log ?? (() => undefined);
  const startupTurnId = input.turnId;
  const startupAttempt = input.dispatchAttempt;
  let retired = false;
  let ready = false;
  let finalOutput: string | undefined;
  let humanInteractionCount = 0;

  const sameStartupTurn = (turnId: string, dispatchAttempt?: number): boolean => (
    !retired
    && (!startupTurnId || turnId === startupTurnId)
    && (startupAttempt === undefined || dispatchAttempt === startupAttempt)
  );
  const ignored = (transition: string, reason: string): void => {
    log(`Candidate Runtime startup ${transition} ignored: ${reason}`);
  };
  const safely = (transition: string, action: () => void): boolean => {
    try {
      action();
      return true;
    } catch (error) {
      ignored(transition, error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  const markReady = (adapterId: string, evidenceRef: string): boolean => {
    if (retired) return false;
    if (ready) return true;
    ready = safely('ready', () => probe.markReady({
      kind: 'runtime_ready',
      evidenceRef: evidenceRef || `adapter:${adapterId || 'unknown'}:runtime-ready`,
    }));
    return ready;
  };

  return {
    evidencePath: probe.evidencePath,
    get humanInteractionCount() { return humanInteractionCount; },
    get automatedInteractionCount() { return interactions.automatedInteractionCount; },
    observeTerminalOutput(output) {
      if (!retired) probe.observeTerminalOutput(output);
    },
    handleTerminalOutput(output, adapter, pty) {
      if (retired) return false;
      probe.observeTerminalOutput(output);
      if (interactions.handle(output, pty)) return true;
      if (candidateRuntimeReadyOutput(adapter, output)) {
        markReady(
          adapter.id ?? 'unknown',
          `adapter:${adapter.id ?? 'unknown'}:candidate-ready-pattern`,
        );
      }
      return false;
    },
    markPromptReady(adapterId, evidenceRef) {
      if (evidenceRef) return markReady(adapterId, evidenceRef);
      if (!ready) ignored('ready', `adapter=${adapterId} has no Candidate readiness evidence`);
      return ready;
    },
    recordSubmitted(submission) {
      if (!sameStartupTurn(submission.turnId, submission.dispatchAttempt)) {
        ignored('accepted', `turn=${submission.turnId} attempt=${submission.dispatchAttempt ?? '-'}`);
        return;
      }
      safely('accepted', () => probe.markAccepted({
        kind: submission.kind,
        nativeSessionId: submission.nativeSessionId,
        transcriptRef: submission.transcriptRef,
      }));
    },
    recordFinalOutput(output) {
      if (!sameStartupTurn(output.turnId, output.dispatchAttempt) || !nonEmpty(output.content)) return;
      finalOutput = output.content;
    },
    recordTerminal(terminal) {
      if (!sameStartupTurn(terminal.turnId, terminal.dispatchAttempt)) {
        ignored('response', `turn=${terminal.turnId} attempt=${terminal.dispatchAttempt ?? '-'}`);
        return;
      }
      const output = terminal.responseOutput ?? finalOutput;
      if (terminal.status === 'completed' && terminal.evidence && nonEmpty(output)) {
        safely('response', () => probe.markResponse({
          kind: 'cli_transcript_terminal',
          nativeSessionId: terminal.evidence!.nativeSessionId,
          transcriptRef: terminal.evidence!.transcriptRef,
          output,
        }));
      } else {
        ignored('response', `terminal=${terminal.status} evidence=${Boolean(terminal.evidence)} output=${Boolean(output)}`);
      }
      retired = true;
      probe.dispose();
    },
    recordHumanInteraction() {
      if (retired) return;
      humanInteractionCount += 1;
      probe.recordHumanInteraction();
    },
    dispose() {
      retired = true;
      probe.dispose();
    },
  };
}

function linkReleaseSkills(sourceRoot: string, effectiveRoot: string): void {
  mkdirSync(effectiveRoot, { recursive: true });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    // Coco owns and may upgrade its built-in .system directory. Candidate
    // release Skills are linked one-by-one so those writes can never mutate
    // the immutable release tree.
    if (entry.name === '.system') continue;
    const source = join(sourceRoot, entry.name);
    const target = join(effectiveRoot, entry.name);
    if (existsSync(target)) {
      if (!lstatSync(target).isSymbolicLink() || realpathSync(target) !== realpathSync(source)) {
        throw new Error(`Candidate Skills binding conflicts at ${target}`);
      }
      continue;
    }
    symlinkSync(source, target, entry.isDirectory() ? 'dir' : 'file');
  }
}

export function prepareCandidateCocoHome(input: {
  contract: CandidateRuntimeContract;
  dataDir: string;
  sessionId: string;
  authFile?: string;
  cocoCacheRoot?: string;
  credentialHome?: string;
}, botmuxIdentity: CandidateBotmuxIdentityOptions = {}): {
  home: string;
  traeHome: string;
  skillsRoot: string;
  cocoCacheRoot: string;
} {
  assertCandidateRuntimeArtifacts(input.contract, botmuxIdentity);
  const sourceSkills = input.contract.skillsRoot;
  const root = candidateRuntimeRoot(input.dataDir, input.sessionId);
  const home = join(root, 'home');
  const traeHome = join(home, '.trae');
  const effectiveSkillsRoot = join(traeHome, 'skills');
  mkdirSync(join(traeHome, 'cli'), { recursive: true, mode: 0o700 });
  const migrationSkipMarker = join(traeHome, '.coco-migration-skip-all');
  if (existsSync(migrationSkipMarker) && !lstatSync(migrationSkipMarker).isFile()) {
    throw new Error(`Candidate Coco migration marker conflicts at ${migrationSkipMarker}`);
  }
  // Candidate isolation forbids importing ambient legacy CLI data.
  atomicWriteFileSync(migrationSkipMarker, '', { mode: 0o600 });
  linkReleaseSkills(sourceSkills, effectiveSkillsRoot);

  // Coco authentication is the sole imported host state. Memory, Skills and
  // CLI settings remain absent from the isolated HOME/TRAE_HOME.
  const authFile = input.authFile ?? join(homedir(), '.trae', 'cli', 'auth.json');
  if (existsSync(authFile)) {
    const target = join(traeHome, 'cli', 'auth.json');
    copyFileSync(authFile, target);
    chmodSync(target, 0o600);
  }
  linkEmployeeCredentialAuth(home, input.credentialHome);
  // The transcript bridge intentionally shares Coco's cache only. It contains
  // the long-lived Session event stream that BotMux must drain; Memory and
  // Skills live under TRAE_HOME and remain isolated above.
  const configuredCocoCacheRoot = input.cocoCacheRoot ?? (
    platform() === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'coco')
      : join(homedir(), '.cache', 'coco')
  );
  mkdirSync(configuredCocoCacheRoot, { recursive: true, mode: 0o700 });
  const cocoCacheRoot = realpathSync(configuredCocoCacheRoot);
  const effectiveCocoCacheRoot = platform() === 'darwin'
    ? join(home, 'Library', 'Caches', 'coco')
    : join(home, '.cache', 'coco');
  mkdirSync(dirname(effectiveCocoCacheRoot), { recursive: true });
  if (existsSync(effectiveCocoCacheRoot)) {
    if (!lstatSync(effectiveCocoCacheRoot).isSymbolicLink()
      || realpathSync(effectiveCocoCacheRoot) !== cocoCacheRoot) {
      throw new Error(`Candidate Coco cache binding conflicts at ${effectiveCocoCacheRoot}`);
    }
  } else {
    symlinkSync(cocoCacheRoot, effectiveCocoCacheRoot, 'dir');
  }
  return {
    home,
    traeHome,
    skillsRoot: effectiveSkillsRoot,
    cocoCacheRoot,
  };
}

// Employee evidence skills (argos-log / tce-query) authenticate through
// byte-cli, which resolves its credential store as $HOME/.byte_cli/auth. The
// host store is maintained by the credential vault and rotates hourly, so the
// isolated HOME gets a symlink to the host auth directory — rotation
// propagates without re-seeding, and executor log writes stay local. A
// pre-existing real auth directory (legacy session homes created before
// seeding existed) is replaced only when empty; a non-empty one is left
// untouched so live session state is never destroyed mid-flight.
function linkEmployeeCredentialAuth(home: string, hostHome: string = homedir()): void {
  const hostAuth = join(hostHome, '.byte_cli', 'auth');
  if (!existsSync(hostAuth) || !lstatSync(hostAuth).isDirectory()) return;
  const target = join(home, '.byte_cli');
  const link = join(target, 'auth');
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(link);
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      if (realpathSync(link) !== realpathSync(hostAuth)) {
        throw new Error(`Candidate credential binding conflicts at ${link}`);
      }
      return;
    }
    if (existing.isDirectory() && readdirSync(link).length === 0) {
      rmdirSync(link);
    } else {
      return;
    }
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  symlinkSync(hostAuth, link, 'dir');
}

export function prepareCandidateRuntimeHome(input: {
  contract: CandidateRuntimeContract;
  dataDir: string;
  sessionId: string;
  authFile?: string;
  cocoCacheRoot?: string;
  credentialHome?: string;
}, botmuxIdentity: CandidateBotmuxIdentityOptions = {}): {
  home: string;
  runtimeHome: string;
  skillsRoot: string;
  env: Record<string, string>;
  traeHome?: string;
  cocoCacheRoot?: string;
} {
  if (input.contract.runtimeName === 'coco' || input.contract.runtimeName === 'traex') {
    const coco = prepareCandidateCocoHome(input, botmuxIdentity);
    return {
      ...coco,
      runtimeHome: coco.traeHome,
      env: { HOME: coco.home, TRAE_HOME: coco.traeHome },
    };
  }
  if (!['codex', 'claude-code'].includes(input.contract.runtimeName)) {
    throw new Error(`Candidate Runtime ${input.contract.runtimeName} lacks isolated HOME preparation`);
  }
  assertCandidateRuntimeArtifacts(input.contract, botmuxIdentity);
  const home = join(candidateRuntimeRoot(input.dataDir, input.sessionId), 'home');
  const runtimeDirName = input.contract.runtimeName === 'codex' ? '.codex' : '.claude';
  const runtimeHome = join(home, runtimeDirName);
  const skillsRoot = join(runtimeHome, 'skills');
  mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  linkReleaseSkills(input.contract.skillsRoot, skillsRoot);
  const defaultAuthFile = input.contract.runtimeName === 'codex'
    ? join(homedir(), '.codex', 'auth.json')
    : join(homedir(), '.claude', '.credentials.json');
  const authFile = input.authFile ?? defaultAuthFile;
  if (existsSync(authFile)) {
    const target = join(runtimeHome, input.contract.runtimeName === 'codex'
      ? 'auth.json'
      : '.credentials.json');
    copyFileSync(authFile, target);
    chmodSync(target, 0o600);
  }
  linkEmployeeCredentialAuth(home, input.credentialHome);
  return {
    home,
    runtimeHome,
    skillsRoot,
    env: input.contract.runtimeName === 'codex'
      ? { HOME: home, CODEX_HOME: runtimeHome }
      : { HOME: home, CLAUDE_CONFIG_DIR: runtimeHome },
  };
}

export function candidateRuntimeAttestationPath(
  dataDir: string,
  sessionId: string,
  workerGeneration: number,
  phase: 'fresh' | 'resume',
): string {
  return join(
    dataDir,
    CANDIDATE_RUNTIME_DIR,
    sessionId,
    'attestations',
    `${workerGeneration}-${phase}.json`,
  );
}

function findGitMetadata(cwd: string): { gitDir: string; commonDir: string } {
  let current = realpathSync(cwd);
  while (true) {
    const dotGit = join(current, '.git');
    if (existsSync(dotGit)) {
      const gitDir = statSync(dotGit).isDirectory()
        ? dotGit
        : resolve(current, readFileSync(dotGit, 'utf8').trim().replace(/^gitdir:\s*/, ''));
      const commonDirFile = join(gitDir, 'commondir');
      const commonDir = existsSync(commonDirFile)
        ? resolve(gitDir, readFileSync(commonDirFile, 'utf8').trim())
        : gitDir;
      return { gitDir, commonDir };
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Candidate workspace is not a git checkout: ${cwd}`);
    current = parent;
  }
}

function readGitRef(gitDir: string, commonDir: string, ref: string): string {
  for (const file of [join(gitDir, ref), join(commonDir, ref)]) {
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  }
  const packed = join(commonDir, 'packed-refs');
  if (existsSync(packed)) {
    const match = readFileSync(packed, 'utf8')
      .split(/\r?\n/)
      .find(line => line.endsWith(` ${ref}`));
    if (match) return match.slice(0, 40);
  }
  throw new Error(`Candidate workspace git ref is unavailable: ${ref}`);
}

function readGitAttestation(cwd: string): { realpath: string; repository: string; commit: string } {
  const { gitDir, commonDir } = findGitMetadata(cwd);
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  const commit = head.startsWith('ref: ')
    ? readGitRef(gitDir, commonDir, head.slice(5))
    : head;
  if (!COMMIT.test(commit)) throw new Error('Candidate workspace git HEAD is invalid');
  const config = readFileSync(join(commonDir, 'config'), 'utf8');
  const originSection = config.match(/\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/);
  const url = originSection?.[1].match(/^\s*url\s*=\s*(.+)\s*$/m)?.[1]?.trim();
  if (!url) throw new Error('Candidate workspace git origin is unavailable');
  return { realpath: realpathSync(cwd), repository: url, commit };
}

export function candidateBotmuxCommit(
  sourceRoot = BOTMUX_PROJECT_ROOT,
  { requireClean = false }: { requireClean?: boolean } = {},
): string {
  const attestation = readGitAttestation(sourceRoot);
  if (requireClean) {
    const status = execFileSync('git', ['-C', attestation.realpath, 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    if (status) throw new Error('Candidate BotMux worktree must be clean');
  }
  return attestation.commit;
}

export function candidateBotmuxBuildIdentity(
  sourceRoot = BOTMUX_PROJECT_ROOT,
  { requireClean = false }: { requireClean?: boolean } = {},
): CandidateBotmuxBuildIdentity {
  const git = readGitAttestation(sourceRoot);
  if (requireClean) {
    const status = execFileSync('git', ['-C', git.realpath, 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    if (status) throw new Error('Candidate BotMux worktree must be clean');
  }
  const configuredDistRoot = join(git.realpath, 'dist');
  if (!lstatSync(configuredDistRoot).isDirectory()) {
    throw new Error('Candidate BotMux dist must be a real directory inside the source checkout');
  }
  const distRoot = realpathSync(configuredDistRoot);
  const manifestPath = join(distRoot, BOTMUX_BUILD_MANIFEST);
  if (!lstatSync(manifestPath).isFile()) {
    throw new Error('Candidate BotMux build manifest must be a regular file');
  }
  const manifestRaw = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestRaw.toString('utf8')) as Partial<CandidateBuildManifest>;
  if (manifest.schemaVersion !== 1 || manifest.botmuxCommit !== git.commit
    || !SHA256.test(manifest.treeSha256 ?? '')
    || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Candidate BotMux build manifest identity mismatch');
  }
  const actualFiles = describeDistTree(distRoot);
  const actualTreeSha256 = createHash('sha256').update(JSON.stringify(actualFiles)).digest('hex');
  if (JSON.stringify(manifest.files) !== JSON.stringify(actualFiles)
    || manifest.treeSha256 !== actualTreeSha256) {
    throw new Error('Candidate BotMux dist tree differs from its complete artifact summary');
  }
  const seen = new Set<string>();
  for (const rawEntry of manifest.files) {
    const entry = rawEntry as { path?: unknown; sha256?: unknown };
    if (typeof entry.path !== 'string' || !entry.path
      || isAbsolute(entry.path) || entry.path.includes('\\')
      || normalize(entry.path) !== entry.path
      || !SHA256.test(typeof entry.sha256 === 'string' ? entry.sha256 : '')
      || seen.has(entry.path)) {
      throw new Error('Candidate BotMux build manifest contains an invalid file identity');
    }
    seen.add(entry.path);
    const target = resolve(distRoot, entry.path);
    if (!target.startsWith(`${distRoot}${sep}`)
      || !lstatSync(target).isFile()
      || realpathSync(target) !== target
      || hashFile(target) !== entry.sha256) {
      throw new Error(`Candidate BotMux artifact mismatch: ${entry.path}`);
    }
  }
  for (const entrypoint of ['index-daemon.js', 'worker.js']) {
    if (!seen.has(entrypoint)) {
      throw new Error(`Candidate BotMux build manifest is missing ${entrypoint}`);
    }
  }
  return {
    commit: git.commit,
    artifactSha256: actualTreeSha256,
  };
}

function syncPath(file: string): void {
  const fd = openSync(file, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function attestCandidateRuntimeSpawn(input: {
  contract: CandidateRuntimeContract;
  phase: 'fresh' | 'resume';
  sessionId: string;
  workerGeneration: number;
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  dataDir: string;
  authFile?: string;
  cocoCacheRoot?: string;
} & CandidateBotmuxIdentityOptions): CandidateRuntimeAttestation {
  const observedBotmux = input.observeBotmuxIdentity?.()
    ?? candidateBotmuxBuildIdentity(input.botmuxSourceRoot, { requireClean: true });
  const executable = realpathSync(input.bin);
  const cwd = realpathSync(input.cwd);
  const skillsRoot = realpathSync(input.contract.skillsRoot);
  if (executable !== input.contract.executable.realpath
    || hashFile(executable) !== input.contract.executable.sha256) {
    throw new Error('Candidate executable attestation mismatch');
  }
  if (cwd !== input.contract.workspaceSnapshot.realpath) {
    throw new Error('Candidate workspace realpath mismatch');
  }
  const git = readGitAttestation(cwd);
  const { commit, repository } = git;
  if (commit !== input.contract.workspaceSnapshot.commit) {
    throw new Error('Candidate workspace commit mismatch');
  }
  if (repository !== input.contract.workspaceSnapshot.repository) {
    throw new Error('Candidate workspace repository mismatch');
  }
  const skillsSha256 = hashCandidateRuntimeTree(skillsRoot);
  if (skillsSha256 !== input.contract.skillsSha256) {
    throw new Error('Candidate Skills digest mismatch');
  }
  const expectedRuntime = prepareCandidateRuntimeHome({
    contract: input.contract,
    dataDir: input.dataDir,
    sessionId: input.sessionId,
    authFile: input.authFile,
    cocoCacheRoot: input.cocoCacheRoot,
  }, { observeBotmuxIdentity: () => observedBotmux });
  if (Object.entries(expectedRuntime.env).some(([key, value]) => input.env[key] !== value)) {
    throw new Error('Candidate HOME isolation mismatch');
  }
  if (input.contract.runtimeName === 'coco' || input.contract.runtimeName === 'traex') {
    const disableAt = input.args.findIndex((arg, index) => (
      arg === '--disable' && input.args[index + 1] === 'memories'
    ));
    if (disableAt < 0) throw new Error('Candidate runtime did not disable memories');
  }
  if (!Number.isSafeInteger(input.workerGeneration) || input.workerGeneration < 1) {
    throw new Error('Candidate worker generation is invalid');
  }

  const attestation: CandidateRuntimeAttestation = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    workerGeneration: input.workerGeneration,
    phase: input.phase,
    candidateDispatchId: input.contract.candidateDispatchId,
    releaseId: input.contract.releaseId,
    releaseManifestSha256: input.contract.releaseManifestSha256,
    runtimeBundleId: input.contract.runtimeBundleId,
    searchRcaCommit: input.contract.searchRcaCommit,
    botmuxCommit: observedBotmux.commit,
    botmuxArtifactSha256: observedBotmux.artifactSha256,
    capabilityLockSha256: input.contract.capabilityLockSha256,
    executable: { realpath: executable, sha256: input.contract.executable.sha256 },
    argv: [executable, ...input.args],
    workspace: { realpath: cwd, repository, commit },
    skills: {
      realpath: skillsRoot,
      effectiveRoot: expectedRuntime.skillsRoot,
      sha256: skillsSha256,
    },
    isolation: {
      home: expectedRuntime.home,
      runtimeName: input.contract.runtimeName,
      runtimeHome: expectedRuntime.runtimeHome,
      environment: expectedRuntime.env,
      ...(expectedRuntime.traeHome ? { traeHome: expectedRuntime.traeHome } : {}),
      ...(expectedRuntime.cocoCacheRoot ? { cocoCacheRoot: expectedRuntime.cocoCacheRoot } : {}),
      disabledFeatures: ['memories'],
    },
    createdAt: new Date().toISOString(),
  };
  const file = candidateRuntimeAttestationPath(
    input.dataDir,
    input.sessionId,
    input.workerGeneration,
    input.phase,
  );
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteFileSync(file, `${JSON.stringify(attestation, null, 2)}\n`, { mode: 0o600 });
  syncPath(file);
  syncPath(dirname(file));
  return attestation;
}
