import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../utils/file-lock.js';
import type { OncallGroupSource } from './oncall-group-store.js';
import type { NativeOncallResultQuery, OncallChoices } from './oncall-platform.js';
import type { OncallForwardMode } from './oncall-group-policy.js';

export interface OncallNativeSubmissionAttempt extends NativeOncallResultQuery {
  preparedAtMs: number;
  policyFingerprint: string;
  forwardMode: OncallForwardMode;
}
export interface OncallNativeSubmission {
  attempts: OncallNativeSubmissionAttempt[];
  completed?: boolean;
}

function normalizeNativeSubmission(draft: any): void {
  const submission = draft?.nativeSubmission;
  if (!submission || Array.isArray(submission.attempts) || typeof submission.sourceLocation !== 'string') return;
  const { completed, ...attempt } = submission;
  // The first native-form implementation persisted one slot and took the route
  // from the draft. Migrate that record without discarding its verified identity.
  draft.nativeSubmission = { attempts: [{ ...attempt, typeId: draft.typeId, region: draft.region }],
    ...(completed !== undefined ? { completed } : {}) };
}

export interface OncallFormDraft {
  id: string;
  version: number;
  appId: string;
  ownerOpenId: string;
  source: OncallGroupSource;
  choices: OncallChoices;
  region: string;
  typeId?: number;
  priority: 'P2' | 'P1' | 'P0';
  description: string;
  /** Prepared before publication, so custom-form confirmation opens the sidebar directly. */
  nativeFormLink?: string;
  /** Every published selection is retained until the card is retired. */
  nativeSubmission?: OncallNativeSubmission;
  oncallUsername?: string;
  /** Selected native form; selection stays frozen while the platform owns submission. */
  nativeEntry?: { href: string; categoryName: string; policyFingerprint: string };
  /** Read-only native form entry messages are excluded from conversation handoff. */
  nativeMessageIds?: string[];
  targetFingerprint?: string;
  visibility?: 'private' | 'thread';
  publishStartedAtMs?: number;
  messageId?: string;
  closed?: boolean;
  createdAtMs: number;
}

export class OncallFormStore {
  private readonly directory: string;
  constructor(dataDir: string) { this.directory = join(dataDir, 'oncall-groups', 'forms'); }
  private file(...ids: string[]): string {
    return join(this.directory, createHash('sha256').update(JSON.stringify(ids)).digest('hex') + '.json');
  }
  private read<T>(file: string): T | undefined {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      normalizeNativeSubmission(value);
      return value as T;
    }
    catch (e: any) { if (e.code === 'ENOENT') return undefined; throw e; }
  }
  private write(file: string, value: unknown): void {
    atomicWriteFileSync(file, JSON.stringify(value), { mode: 0o600, durable: true });
  }
  open(input: Omit<OncallFormDraft, 'id' | 'version' | 'createdAtMs'>): OncallFormDraft {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const index = this.file('index', input.appId, input.source.chatId, input.source.questionId, input.ownerOpenId);
    return withFileLockSync(index, () => {
      const id = this.read<{ id: string }>(index)?.id
        ?? this.read<{ id: string }>(this.file('index', input.appId, input.source.sessionId ?? input.source.questionId, input.ownerOpenId))?.id;
      const previous = id ? this.read<OncallFormDraft>(this.file(input.appId, id)) : undefined;
      if (previous && previous.source.chatId === input.source.chatId && previous.source.questionId === input.source.questionId
        && !previous.closed && Date.now() - previous.createdAtMs < 24 * 60 * 60_000) return previous;
      const draft: OncallFormDraft = { ...input, id: randomUUID(), version: 0, createdAtMs: Date.now() };
      this.write(this.file(input.appId, draft.id), draft);
      this.write(index, { id: draft.id });
      return draft;
    });
  }
  publishedMessageIds(source: OncallGroupSource): Set<string> {
    let files: string[];
    try { files = readdirSync(this.directory); }
    catch (error: any) { if (error.code === 'ENOENT') return new Set(); throw error; }
    const ids = new Set<string>();
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      const draft = this.read<OncallFormDraft>(join(this.directory, name));
      if (draft?.appId === source.appId && draft.source?.chatId === source.chatId
        && (source.sessionId ? draft.source.sessionId === source.sessionId : draft.source.questionId === source.questionId)) {
        if (draft.messageId) ids.add(draft.messageId);
        for (const id of draft.nativeMessageIds ?? []) ids.add(id);
      }
    }
    return ids;
  }
  pendingNativeSubmissions(appId: string): OncallFormDraft[] {
    let files: string[];
    try { files = readdirSync(this.directory); }
    catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
    return files.filter(name => name.endsWith('.json')).flatMap(name => {
      const draft = this.read<OncallFormDraft>(join(this.directory, name));
      return draft?.appId === appId && draft.nativeSubmission?.attempts.length && !draft.nativeSubmission.completed
        && Date.now() - draft.createdAtMs < 24 * 60 * 60_000 ? [draft] : [];
    });
  }
  async use<T>(appId: string, id: string, owner: string, operation: (draft: OncallFormDraft, persist: () => void) => Promise<T>, options: { allowClosed?: boolean; allowExpired?: boolean } = {}): Promise<T> {
    const file = this.file(appId, id);
    return withFileLock(file, async () => {
      const draft = this.read<OncallFormDraft>(file);
      if (!draft || draft.appId !== appId || draft.ownerOpenId !== owner || (draft.closed && !options.allowClosed)
        || (!options.allowExpired && Date.now() - draft.createdAtMs > 24 * 60 * 60_000)) throw new Error('此表单已失效或不属于当前用户');
      try { return await operation(draft, () => this.write(file, draft)); }
      finally { this.write(file, draft); }
    }, { maxWaitMs: 30_000 });
  }
}
