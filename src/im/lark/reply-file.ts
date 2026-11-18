import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStandaloneBinary, resolveEntrySpawn } from '../../core/self-spawn.js';
import type { LocalAddressContext } from './local-address-policy.js';

export interface PreparedReplyFile {
  sourceDigest: string;
  policy: string;
  bytes: Buffer;
  digest: string;
  key?: string;
}

function scrubInChild(source: string, policy: string): Promise<Buffer> {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = !isStandaloneBinary() && import.meta.url.endsWith('.ts')
    ? { command: process.execPath, args: [
        ...(process.versions.bun ? [] : ['--import', createRequire(import.meta.url).resolve('tsx')]),
        resolve(here, '../../reply-file-sanitizer.ts'),
      ] }
    : resolveEntrySpawn('reply-file-sanitizer', resolve(here, '../..'));
  return new Promise((done, reject) => {
    const child = execFile(entry.command, [...entry.args, policy], {
      encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) reject(new Error('MiniMax reply file sanitizer failed', { cause: error.code }));
      else done(stdout);
    });
    child.stdin!.on('error', reject);
    child.stdin!.end(source, 'utf8');
  });
}

export async function prepareReplyFile(
  source: string, context: LocalAddressContext, previous?: PreparedReplyFile,
): Promise<PreparedReplyFile> {
  // Only the card-field policy uses the host-issued link callback. All prose
  // settings are plain data and form part of the retry cache identity.
  const policy = JSON.stringify(context);
  const sourceDigest = createHash('sha256').update(source).digest('hex');
  if (previous?.sourceDigest === sourceDigest && previous.policy === policy) return previous;
  const bytes = context.disabled ? Buffer.from(source) : await scrubInChild(source, policy);
  const digest = context.disabled ? sourceDigest : createHash('sha256').update(bytes).digest('hex');
  return { sourceDigest, policy, bytes, digest };
}
