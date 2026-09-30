import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export interface OncallGroupSource {
  appId: string;
  chatId: string;
  messageId: string;
  questionId: string;
  answer: string;
}

export interface OncallGroupRequest {
  status: 'pending' | 'succeeded' | 'failed' | 'unknown';
  flowId?: string;
  openChatId?: string;
}

function digest(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function read<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; }
  catch (error: any) { if (error?.code === 'ENOENT') return undefined; throw error; }
}

export class OncallGroupStore {
  constructor(private readonly dataDir: string) {}

  private path(kind: string, ids: string[]): string {
    return join(this.dataDir, 'oncall-groups', kind, `${digest(ids)}.json`);
  }

  private write(file: string, value: unknown): void {
    atomicWriteFileSync(file, JSON.stringify(value), { mode: 0o600, durable: true });
  }

  recordSource(source: OncallGroupSource): void {
    const file = this.path('messages', [source.appId, source.messageId]);
    mkdirSync(join(this.dataDir, 'oncall-groups', 'messages'), { recursive: true, mode: 0o700 });
    withFileLockSync(file, () => {
      if (!read(file)) this.write(file, source);
    });
  }

  findSource(appId: string, messageId: string): OncallGroupSource | undefined {
    return read(this.path('messages', [appId, messageId]));
  }

  private requestPath(source: OncallGroupSource): string {
    return this.path('requests', [source.appId, source.chatId, source.questionId]);
  }

  getRequest(source: OncallGroupSource): OncallGroupRequest | undefined {
    return read(this.requestPath(source));
  }

  claim(source: OncallGroupSource): boolean {
    const file = this.requestPath(source);
    mkdirSync(join(this.dataDir, 'oncall-groups', 'requests'), { recursive: true, mode: 0o700 });
    return withFileLockSync(file, () => {
      const previous = read<OncallGroupRequest>(file);
      // A crashed or timed-out request may already have created a group.
      if (previous && previous.status !== 'failed') return false;
      this.write(file, { status: 'pending' });
      return true;
    });
  }

  finish(source: OncallGroupSource, result: OncallGroupRequest): void {
    const file = this.requestPath(source);
    withFileLockSync(file, () => this.write(file, result));
  }
}
