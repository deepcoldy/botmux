/**
 * Durable single-card delivery for v3 workflow progress.
 *
 * Runtime state remains `journal.ndjson`; the sidecar below stores only Lark
 * delivery intent/checkpoints. All failures are reported through `onError` and
 * collapse to `false` so chat transport can never fail a workflow.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { fsyncDirectorySyncPortable } from '../../utils/fs-durability.js';
import { withFileLock } from '../../utils/file-lock.js';
import { readJournal } from '../../workflows/v3/journal.js';
import { isValidRunId } from '../../workflows/v3/ops-projection.js';
import { projectV3Progress, type V3ProgressView } from '../../workflows/v3/progress-projection.js';
import {
  loadAuthorizedV3Run,
  type LoadedAuthorizedV3Run,
} from '../../workflows/v3/run-envelope.js';
import { materialize } from '../../workflows/v3/state.js';

export const V3_PROGRESS_SIDECAR = 'lark-progress-card.json';
const SIDECAR_SCHEMA_VERSION = 1 as const;
const LARK_DEDUPE_WINDOW_MS = 60 * 60 * 1_000;

type ProgressTarget = { kind: 'reply' | 'chat'; id: string };
type DeliveryState = 'pending' | 'active' | 'freeze_pending' | 'frozen' | 'withdrawn' | 'uncertain';

export interface V3ProgressCardSidecar {
  schemaVersion: typeof SIDECAR_SCHEMA_VERSION;
  runId: string;
  larkAppId: string;
  target: ProgressTarget;
  deliveryUuid: string;
  delivery: DeliveryState;
  messageId?: string;
  createdAt: string;
  lastProjection?: {
    journalEventCount: number;
    cardSha256: string;
    patchedAt: string;
  };
}

export interface V3ProgressCardTransport {
  reply(
    larkAppId: string,
    rootMessageId: string,
    cardJson: string,
    uuid: string,
  ): Promise<string>;
  send(
    larkAppId: string,
    chatId: string,
    cardJson: string,
    uuid: string,
  ): Promise<string>;
  patch(larkAppId: string, messageId: string, cardJson: string): Promise<void>;
}

export interface V3ProgressCardManagerDeps {
  baseDir: string;
  transport: V3ProgressCardTransport;
  buildCard(view: V3ProgressView, loaded: LoadedAuthorizedV3Run): string;
  onError?: (runId: string, error: unknown) => void;
  now?: () => Date;
  pollIntervalMs?: number;
}

interface RefreshState {
  promise: Promise<boolean>;
  rerunRequested: boolean;
  allowCreate: boolean;
}

export class V3ProgressCardManager {
  private readonly refreshes = new Map<string, RefreshState>();
  private readonly observers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly deps: V3ProgressCardManagerDeps) {}

  /** Start a polling observer and schedule an immediate best-effort refresh. */
  observe(runId: string): void {
    if (!isValidRunId(runId) || this.observers.has(runId)) return;
    void this.refresh(runId, { allowCreate: true });
    const timer = setInterval(() => {
      void this.refresh(runId, { allowCreate: true });
    }, this.deps.pollIntervalMs ?? 2_000);
    timer.unref?.();
    this.observers.set(runId, timer);
  }

  /** Stop polling and persist the latest suspended/terminal projection. */
  stopAndRefresh(runId: string): Promise<boolean> {
    this.stop(runId);
    return this.refresh(runId, { allowCreate: true });
  }

  /** Terminal refresh. Returns true only when one active card represents it. */
  finalize(runId: string): Promise<boolean> {
    this.stop(runId);
    return this.refresh(runId, { allowCreate: true });
  }

  stop(runId: string): void {
    const timer = this.observers.get(runId);
    if (timer) clearInterval(timer);
    this.observers.delete(runId);
  }

  close(): void {
    for (const timer of this.observers.values()) clearInterval(timer);
    this.observers.clear();
  }

  /**
   * Startup recovery refreshes the durable snapshot once; terminal history is
   * only patched when a sidecar proves that this daemon already owned one.
   * Continuous polling is attached exclusively by onDriveBegin. Recovery may
   * re-drive a journal-only attempt through the durable attempt barrier, but
   * cold attach itself must still avoid leaking a permanent observer timer.
   */
  async coldAttach(ownerLarkAppId: string): Promise<void> {
    if (!existsSync(this.deps.baseDir)) return;
    for (const runId of readdirSync(this.deps.baseDir)) {
      if (!isValidRunId(runId)) continue;
      const runDir = join(this.deps.baseDir, runId);
      try {
        if (!statSync(runDir).isDirectory()) continue;
        const loaded = loadAuthorizedV3Run(runDir, { expectedRunId: runId });
        if (loaded.envelope.chatBinding?.larkAppId !== ownerLarkAppId) continue;
        const events = readJournal(join(runDir, 'journal.ndjson'));
        if (events.length === 0) continue; // approved/materialized but never started
        const snapshot = materialize(events);
        const terminal = snapshot.runStatus === 'succeeded' ||
          snapshot.runStatus === 'failed' ||
          snapshot.runStatus === 'cancelled';
        const suspended = snapshot.runStatus === 'blocked' ||
          [...snapshot.nodes.values()].some((node) => node.status === 'gateWaiting');
        const hasSidecar = existsSync(join(runDir, V3_PROGRESS_SIDECAR));
        if (terminal && !hasSidecar) continue;
        if (terminal) {
          await this.refresh(runId, { allowCreate: false });
        } else if (suspended) {
          await this.refresh(runId, { allowCreate: true });
        } else await this.refresh(runId, { allowCreate: true });
      } catch (err) {
        this.deps.onError?.(runId, err);
      }
    }
  }

  refresh(runId: string, options: { allowCreate: boolean }): Promise<boolean> {
    if (!isValidRunId(runId)) return Promise.resolve(false);
    const active = this.refreshes.get(runId);
    if (active) {
      // At most one dirty rerun per run. A hung Lark request therefore cannot
      // accumulate one Promise/closure every polling tick, while finalize can
      // still demand a fresh pass after the in-flight snapshot settles.
      active.rerunRequested = true;
      active.allowCreate ||= options.allowCreate;
      return active.promise;
    }

    const state: RefreshState = {
      promise: Promise.resolve(false),
      rerunRequested: true,
      allowCreate: options.allowCreate,
    };
    this.refreshes.set(runId, state);
    state.promise = this.runRefreshLoop(runId, state);
    return state.promise;
  }

  private async runRefreshLoop(runId: string, state: RefreshState): Promise<boolean> {
    let result = false;
    try {
      do {
        const allowCreate = state.allowCreate;
        state.rerunRequested = false;
        state.allowCreate = false;
        try {
          result = await this.refreshOnce(runId, { allowCreate });
        } catch (err) {
          this.deps.onError?.(runId, err);
          result = false;
        }
      } while (state.rerunRequested);
      return result;
    } finally {
      if (this.refreshes.get(runId) === state) this.refreshes.delete(runId);
    }
  }

  private async refreshOnce(runId: string, options: { allowCreate: boolean }): Promise<boolean> {
    const runDir = join(this.deps.baseDir, runId);
    const initial = loadAuthorizedV3Run(runDir, { expectedRunId: runId });
    const binding = initial.envelope.chatBinding;
    if (!binding) return false;
    const target: ProgressTarget = binding.rootMessageId
      ? { kind: 'reply', id: binding.rootMessageId }
      : { kind: 'chat', id: binding.chatId };
    const sidecarPath = join(runDir, V3_PROGRESS_SIDECAR);
    const expectedUuid = deliveryUuid(runId, binding.larkAppId, target);

    return withFileLock(sidecarPath, async () => {
      let sidecar = await readSidecar(sidecarPath, runId);
      if (sidecar) assertSidecarIdentity(sidecar, runId, binding.larkAppId, target, expectedUuid);

      // A terminal action owns the card from this point on. Check it before
      // reading/rendering progress so no older observer can overwrite it.
      if (sidecar?.delivery === 'frozen' || sidecar?.delivery === 'freeze_pending') return true;
      if (sidecar?.delivery === 'withdrawn' || sidecar?.delivery === 'uncertain') return false;

      // Re-read every projection input *after* taking the cross-process card
      // lock. Otherwise daemon A can build running, daemon B PATCH succeeded,
      // then A acquire the lock and overwrite the terminal card with its stale
      // snapshot. run.json is immutable, but reloading also re-verifies every
      // pinned artifact at the exact update boundary.
      const loaded = loadAuthorizedV3Run(runDir, { expectedRunId: runId });
      const currentBinding = loaded.envelope.chatBinding;
      const currentTarget: ProgressTarget | undefined = currentBinding
        ? (currentBinding.rootMessageId
            ? { kind: 'reply', id: currentBinding.rootMessageId }
            : { kind: 'chat', id: currentBinding.chatId })
        : undefined;
      if (
        !currentBinding ||
        currentBinding.larkAppId !== binding.larkAppId ||
        !currentTarget ||
        currentTarget.kind !== target.kind ||
        currentTarget.id !== target.id
      ) throw new Error(`v3 progress binding changed while refreshing ${runId}`);

      const events = readJournal(join(runDir, 'journal.ndjson'));
      if ((sidecar?.lastProjection?.journalEventCount ?? 0) > events.length) {
        throw new Error(`v3 progress journal regressed for ${runId}`);
      }
      const view = projectV3Progress({
        envelope: loaded.envelope,
        dag: loaded.dag,
        ...(loaded.spec ? { spec: loaded.spec } : {}),
        events,
      });
      if (
        view.status === 'waiting' ||
        view.status === 'blocked' ||
        view.status === 'succeeded' ||
        view.status === 'failed' ||
        view.status === 'cancelled'
      ) {
        this.stop(runId);
      }
      const cardJson = this.deps.buildCard(view, loaded);
      // Parse once before transport: never persist/checkpoint malformed card JSON.
      JSON.parse(cardJson);
      const cardSha256 = sha256(cardJson);
      const now = (this.deps.now ?? (() => new Date()))();

      if (!sidecar) {
        if (!options.allowCreate) return false;
        sidecar = {
          schemaVersion: SIDECAR_SCHEMA_VERSION,
          runId,
          larkAppId: binding.larkAppId,
          target,
          deliveryUuid: expectedUuid,
          delivery: 'pending',
          createdAt: now.toISOString(),
        };
        await writeSidecar(sidecarPath, sidecar);
      }

      if (sidecar.delivery === 'pending') {
        if (now.getTime() - Date.parse(sidecar.createdAt) >= LARK_DEDUPE_WINDOW_MS) {
          sidecar = { ...sidecar, delivery: 'uncertain' };
          await writeSidecar(sidecarPath, sidecar);
          return false;
        }
        try {
          const messageId = target.kind === 'reply'
            ? await this.deps.transport.reply(binding.larkAppId, target.id, cardJson, sidecar.deliveryUuid)
            : await this.deps.transport.send(binding.larkAppId, target.id, cardJson, sidecar.deliveryUuid);
          assertMessageId(messageId);
          sidecar = {
            ...sidecar,
            delivery: 'active',
            messageId,
            lastProjection: projectionCheckpoint(events.length, cardSha256, now),
          };
          await writeSidecar(sidecarPath, sidecar);
          return true;
        } catch (err) {
          if (isWithdrawnError(err)) {
            await writeSidecar(sidecarPath, { ...sidecar, delivery: 'withdrawn' });
            return false;
          }
          throw err;
        }
      }

      assertMessageId(sidecar.messageId);
      if (sidecar.lastProjection?.cardSha256 === cardSha256) return true;
      try {
        await this.deps.transport.patch(binding.larkAppId, sidecar.messageId!, cardJson);
      } catch (err) {
        if (isWithdrawnError(err)) {
          await writeSidecar(sidecarPath, { ...sidecar, delivery: 'withdrawn' });
          return false;
        }
        throw err;
      }
      await writeSidecar(sidecarPath, {
        ...sidecar,
        lastProjection: projectionCheckpoint(events.length, cardSha256, now),
      });
      return true;
    });
  }
}

function projectionCheckpoint(
  journalEventCount: number,
  cardSha256: string,
  now: Date,
): NonNullable<V3ProgressCardSidecar['lastProjection']> {
  return { journalEventCount, cardSha256, patchedAt: now.toISOString() };
}

function deliveryUuid(runId: string, larkAppId: string, target: ProgressTarget): string {
  return createHash('sha256')
    .update(['v3-progress-card:v1', runId, larkAppId, target.kind, target.id].join('\0'))
    .digest('hex')
    .slice(0, 40);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readSidecar(path: string, expectedRunId: string): Promise<V3ProgressCardSidecar | undefined> {
  let fd: number | undefined;
  let text: string;
  try {
    // O_NOFOLLOW closes the lstat→read TOCTOU: a workflow child cannot swap a
    // checked regular file for a symlink and make the daemon read outside the
    // run directory. fstat validates the inode actually opened.
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) throw new Error(`v3 progress sidecar must be a regular file: ${path}`);
    text = readFileSync(fd, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`v3 progress sidecar must be a regular file: ${path}`);
    }
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error(`v3 progress sidecar is invalid JSON: ${path}`); }
  return validateSidecar(raw, expectedRunId);
}

function validateSidecar(raw: unknown, expectedRunId: string): V3ProgressCardSidecar {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('v3 progress sidecar must be an object');
  const item = raw as Record<string, unknown>;
  const allowed = new Set([
    'schemaVersion', 'runId', 'larkAppId', 'target', 'deliveryUuid', 'delivery',
    'messageId', 'createdAt', 'lastProjection',
  ]);
  if (Object.keys(item).some((key) => !allowed.has(key))) throw new Error('v3 progress sidecar has unknown fields');
  if (item.schemaVersion !== SIDECAR_SCHEMA_VERSION || item.runId !== expectedRunId) {
    throw new Error('v3 progress sidecar identity/version mismatch');
  }
  if (typeof item.larkAppId !== 'string' || !item.larkAppId) throw new Error('v3 progress sidecar has invalid app');
  if (typeof item.deliveryUuid !== 'string' || item.deliveryUuid.length > 50 || !item.deliveryUuid) {
    throw new Error('v3 progress sidecar has invalid deliveryUuid');
  }
  if (!['pending', 'active', 'freeze_pending', 'frozen', 'withdrawn', 'uncertain'].includes(String(item.delivery))) {
    throw new Error('v3 progress sidecar has invalid delivery state');
  }
  if (typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) {
    throw new Error('v3 progress sidecar has invalid createdAt');
  }
  const target = item.target as Record<string, unknown> | undefined;
  if (
    !target ||
    Object.keys(target).some((key) => key !== 'kind' && key !== 'id') ||
    (target.kind !== 'reply' && target.kind !== 'chat') ||
    typeof target.id !== 'string' ||
    !target.id
  ) throw new Error('v3 progress sidecar has invalid target');
  if (item.messageId !== undefined) assertMessageId(item.messageId);
  if ((item.delivery === 'pending' || item.delivery === 'freeze_pending') && item.messageId !== undefined) {
    throw new Error(`${String(item.delivery)} v3 progress sidecar must not have messageId`);
  }
  if ((item.delivery === 'active' || item.delivery === 'frozen') && item.messageId === undefined) {
    throw new Error(`${String(item.delivery)} v3 progress sidecar needs messageId`);
  }
  if (item.lastProjection !== undefined) {
    const checkpoint = item.lastProjection as Record<string, unknown>;
    if (
      !checkpoint ||
      Object.keys(checkpoint).some((key) =>
        key !== 'journalEventCount' && key !== 'cardSha256' && key !== 'patchedAt') ||
      typeof checkpoint.journalEventCount !== 'number' ||
      !Number.isInteger(checkpoint.journalEventCount) ||
      checkpoint.journalEventCount < 0 ||
      typeof checkpoint.cardSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(checkpoint.cardSha256) ||
      typeof checkpoint.patchedAt !== 'string' ||
      !Number.isFinite(Date.parse(checkpoint.patchedAt))
    ) throw new Error('v3 progress sidecar has invalid checkpoint');
  }
  return raw as V3ProgressCardSidecar;
}

function assertSidecarIdentity(
  sidecar: V3ProgressCardSidecar,
  runId: string,
  larkAppId: string,
  target: ProgressTarget,
  uuid: string,
): void {
  if (
    sidecar.runId !== runId ||
    sidecar.larkAppId !== larkAppId ||
    sidecar.target.kind !== target.kind ||
    sidecar.target.id !== target.id ||
    sidecar.deliveryUuid !== uuid
  ) throw new Error(`v3 progress sidecar binding mismatch for ${runId}`);
}

function assertMessageId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\r\n]/.test(value)) {
    throw new Error('v3 progress sidecar has invalid messageId');
  }
}

async function writeSidecar(path: string, sidecar: V3ProgressCardSidecar): Promise<void> {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    // Deliberately do not use generic atomicWriteFile: it resolves a target
    // symlink to preserve dotfile semantics. A run-owned sidecar needs the
    // opposite contract — unique no-follow temp + rename over the directory
    // entry, which replaces a raced symlink itself instead of its target.
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    writeFileSync(fd, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf-8');
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    fsyncDirectorySyncPortable(dirname(path));
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * A terminal action replaced the progress card in-place (warning confirmation
 * or saved result). Freeze delivery so cold attach can never PATCH an older
 * progress projection over that user-facing terminal state.
 */
export async function freezeV3ProgressCard(runDir: string): Promise<void> {
  const runId = basename(runDir);
  if (!isValidRunId(runId)) return;
  const path = join(runDir, V3_PROGRESS_SIDECAR);
  await withFileLock(path, async () => {
    const sidecar = await readSidecar(path, runId);
    if (!sidecar || sidecar.delivery === 'frozen' || sidecar.delivery === 'freeze_pending') return;
    if (sidecar.delivery === 'active') {
      await writeSidecar(path, { ...sidecar, delivery: 'frozen' });
    } else if (sidecar.delivery === 'pending') {
      // The card callback proves the send actually landed, even if the daemon
      // crashed/failed before persisting its messageId. Do not retry create and
      // later overwrite the in-place saved/confirmation card with progress.
      await writeSidecar(path, { ...sidecar, delivery: 'freeze_pending' });
    }
  });
}

function isWithdrawnError(err: unknown): boolean {
  return err instanceof Error && err.name === 'MessageWithdrawnError';
}
