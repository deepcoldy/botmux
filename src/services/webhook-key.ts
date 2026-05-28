import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';

const MASTER_KEY_FILE = 'webhook-master.key';
const SECRETS_FILE = 'webhook-secrets.json';

export interface WebhookSecretRecord {
  ref: string;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: string;
  updatedAt: string;
}

interface SecretStoreFile {
  version: 1;
  secrets: Record<string, WebhookSecretRecord>;
}

function masterKeyPath(dataDir: string): string {
  return join(dataDir, MASTER_KEY_FILE);
}

function secretStorePath(dataDir: string): string {
  return join(dataDir, SECRETS_FILE);
}

function readOrCreateMasterKey(dataDir: string): Buffer {
  const fp = masterKeyPath(dataDir);
  if (existsSync(fp)) {
    const raw = readFileSync(fp, 'utf-8').trim();
    const key = Buffer.from(raw, 'base64url');
    if (key.length !== 32) throw new Error(`invalid webhook master key length at ${fp}`);
    return key;
  }
  mkdirSync(dirname(fp), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(fp, key.toString('base64url') + '\n', { encoding: 'utf-8', mode: 0o600 });
  chmodSync(fp, 0o600);
  return key;
}

function emptyStore(): SecretStoreFile {
  return { version: 1, secrets: {} };
}

function readStore(dataDir: string): SecretStoreFile {
  const fp = secretStorePath(dataDir);
  if (!existsSync(fp)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const secrets = (parsed as any).secrets;
      return {
        version: 1,
        secrets: secrets && typeof secrets === 'object' && !Array.isArray(secrets) ? secrets : {},
      };
    }
  } catch { /* corrupt store falls through to empty */ }
  return emptyStore();
}

function writeStore(dataDir: string, store: SecretStoreFile): void {
  const fp = secretStorePath(dataDir);
  mkdirSync(dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, secrets: store.secrets }, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, fp);
}

function encryptSecret(plaintext: string, key: Buffer): Pick<WebhookSecretRecord, 'alg' | 'iv' | 'tag' | 'ciphertext'> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

function decryptSecret(record: WebhookSecretRecord, key: Buffer): string {
  if (record.alg !== 'aes-256-gcm') throw new Error(`unsupported webhook secret alg: ${record.alg}`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf-8');
}

export function createWebhookSecret(
  plaintext: string,
  dataDir: string = config.session.dataDir,
): WebhookSecretRecord {
  const ref = `whsec_${randomUUID()}`;
  return setWebhookSecret(ref, plaintext, dataDir);
}

export function generateWebhookSecretPlaintext(): string {
  return randomBytes(32).toString('base64url');
}

export function setWebhookSecret(
  ref: string,
  plaintext: string,
  dataDir: string = config.session.dataDir,
): WebhookSecretRecord {
  if (!ref) throw new Error('secret ref is required');
  if (!plaintext) throw new Error('secret plaintext is required');
  const key = readOrCreateMasterKey(dataDir);
  const store = readStore(dataDir);
  const now = new Date().toISOString();
  const prior = store.secrets[ref];
  const record: WebhookSecretRecord = {
    ref,
    ...encryptSecret(plaintext, key),
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
  store.secrets[ref] = record;
  writeStore(dataDir, store);
  return record;
}

export function getWebhookSecret(
  ref: string,
  dataDir: string = config.session.dataDir,
): string | null {
  if (!ref) return null;
  const record = readStore(dataDir).secrets[ref];
  if (!record) return null;
  return decryptSecret(record, readOrCreateMasterKey(dataDir));
}

export function deleteWebhookSecret(ref: string, dataDir: string = config.session.dataDir): boolean {
  const store = readStore(dataDir);
  if (!store.secrets[ref]) return false;
  delete store.secrets[ref];
  writeStore(dataDir, store);
  return true;
}

export function listWebhookSecretRefs(dataDir: string = config.session.dataDir): Array<Omit<WebhookSecretRecord, 'iv' | 'tag' | 'ciphertext'>> {
  return Object.values(readStore(dataDir).secrets)
    .map(({ iv: _iv, tag: _tag, ciphertext: _ciphertext, ...meta }) => meta);
}
