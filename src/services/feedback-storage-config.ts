import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import type { FeedbackStorageConfig, FeedbackStorageTarget } from './feedback-storage-types.js';

const secretReference = z.string().regex(/^(env:[A-Za-z_][A-Za-z0-9_]*|file:[0-9a-f-]{36})$/);
const postgresSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).max(63),
  user: z.string().min(1).max(63),
  schema: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  passwordRef: secretReference,
  tls: z.object({
    mode: z.enum(['verify-full', 'disable']),
    caRef: secretReference.optional(),
  }).strict(),
  connectTimeoutMs: z.number().int().min(100).max(60000),
}).strict();
const targetSchema = z.discriminatedUnion('backend', [
  z.object({ backend: z.literal('sqlite') }).strict(),
  z.object({ backend: z.literal('postgresql'), postgres: postgresSchema }).strict(),
]);
const configSchema = z.object({
  version: z.literal(1),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  instanceId: z.string().uuid(),
  active: targetSchema,
  candidate: targetSchema.optional(),
}).strict();

async function canonicalDirectory(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  return realpath(dataDir);
}

async function readPrivateFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 65536) {
      throw new Error('feedback_storage_file_invalid');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function readConfig(path: string): Promise<FeedbackStorageConfig | undefined> {
  let raw: string;
  try {
    raw = await readPrivateFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('feedback_storage_config_unreadable');
  }
  try {
    return configSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('feedback_storage_config_invalid');
  }
}

async function persistConfig(path: string, config: FeedbackStorageConfig): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(config), {
    mode: 0o600, durable: true, followTargetSymlink: false,
  });
}

export async function readFeedbackStorageConfig(dataDir: string): Promise<FeedbackStorageConfig> {
  const path = join(await canonicalDirectory(dataDir), 'feedback-storage.json');
  const existing = await readConfig(path);
  if (existing) return existing;
  return withFileLock(path, async () => {
    const current = await readConfig(path);
    if (current) return current;
    const initial: FeedbackStorageConfig = {
      version: 1, generation: 0, instanceId: randomUUID(), active: { backend: 'sqlite' },
    };
    await persistConfig(path, initial);
    return initial;
  });
}

export async function saveFeedbackStorageCandidate(
  dataDir: string, expectedGeneration: number, candidate: FeedbackStorageTarget,
): Promise<FeedbackStorageConfig> {
  const parsed = targetSchema.safeParse(candidate);
  if (!parsed.success) throw new Error('feedback_storage_target_invalid');
  await readFeedbackStorageConfig(dataDir);
  const path = join(await canonicalDirectory(dataDir), 'feedback-storage.json');
  return withFileLock(path, async () => {
    const current = await readConfig(path);
    if (!current || current.generation !== expectedGeneration) {
      throw new Error('feedback_storage_generation_conflict');
    }
    const next = configSchema.parse({ ...current, generation: current.generation + 1, candidate: parsed.data });
    await persistConfig(path, next);
    return next;
  });
}

export async function putFeedbackStorageSecret(dataDir: string, value: string): Promise<string> {
  if (!value || Buffer.byteLength(value) > 65536) throw new Error('feedback_storage_secret_invalid');
  const directory = join(await canonicalDirectory(dataDir), 'feedback-storage-secrets');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new Error('feedback_storage_secret_directory_invalid');
  const identity = randomUUID();
  await atomicWriteFile(join(directory, identity), value, {
    mode: 0o600, durable: true, followTargetSymlink: false,
  });
  return `file:${identity}`;
}

export async function readFeedbackStorageSecret(dataDir: string, reference: string): Promise<string> {
  if (!secretReference.safeParse(reference).success) throw new Error('feedback_storage_secret_reference_invalid');
  if (reference.startsWith('env:')) {
    const value = process.env[reference.slice(4)];
    if (!value) throw new Error('feedback_storage_secret_missing');
    return value;
  }
  const directory = join(await canonicalDirectory(dataDir), 'feedback-storage-secrets');
  try {
    if (await realpath(directory) !== directory) throw new Error('invalid_directory');
    const value = await readPrivateFile(join(directory, reference.slice(5)));
    if (!value) throw new Error('empty_secret');
    return value;
  } catch {
    throw new Error('feedback_storage_secret_missing');
  }
}

export async function activateFeedbackStorageCandidate(
  dataDir: string, expectedGeneration: number,
): Promise<FeedbackStorageConfig> {
  const path = join(await canonicalDirectory(dataDir), 'feedback-storage.json');
  return withFileLock(path, async () => {
    const current = await readConfig(path);
    if (!current || current.generation !== expectedGeneration || !current.candidate) {
      throw new Error('feedback_storage_generation_conflict');
    }
    const next: FeedbackStorageConfig = {
      version: 1, instanceId: current.instanceId, generation: current.generation + 1, active: current.candidate,
    };
    await persistConfig(path, next);
    return next;
  });
}
