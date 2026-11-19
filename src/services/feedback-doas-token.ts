import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

export interface DoasTokenConfig {
  psm: string;
  environment: 'boe' | 'cn' | 'row' | 'nontt' | 'euttp' | 'usttp';
}
export interface DynamicToken {
  value: string;
  generation: number;
}
export interface TokenSource {
  get(): Promise<DynamicToken>;
  refresh(rejectedGeneration: number): Promise<DynamicToken>;
}
export type PostgresCredential = string | TokenSource;

function credentialCacheDeadline(token: string, now: number): number {
  let deadline = now + 60000;
  let expiresAt: number | undefined;
  const segments = token.split('.');
  if (segments.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
      const expiry = payload.expireTime ?? payload.exp;
      if (typeof expiry === 'number' && Number.isFinite(expiry) && expiry > 0) {
        expiresAt = expiry * 1000;
      }
    } catch {}
  }
  if (expiresAt !== undefined) {
    if (expiresAt <= now) throw new Error('feedback_doas_token_expired');
    deadline = Math.min(deadline, expiresAt - 30000);
  }
  return deadline;
}

async function readCachedCredential(path: string, generation: number, tokenHash?: string): Promise<DynamicToken | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 131072 || (info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid())) throw new Error('feedback_doas_cache_unsafe');
    const value = JSON.parse(await handle.readFile('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('feedback_doas_state_invalid');
    if (value.generation !== generation || value.tokenHash !== tokenHash) return undefined;
    if (typeof value.token !== 'string' || !value.token || value.token.length > 65536 || /[\s\0]/.test(value.token)
      || !Number.isFinite(value.validUntil) || value.validUntil > Date.now() + 60000
      || createHash('sha256').update(value.token).digest('hex') !== tokenHash) {
      throw new Error('feedback_doas_state_invalid');
    }
    if (value.validUntil <= Date.now()) return undefined;
    if (credentialCacheDeadline(value.token, Date.now()) <= Date.now()) return undefined;
    return { value: value.token, generation };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('feedback_doas_cache_unsafe');
    if (error instanceof SyntaxError) throw new Error('feedback_doas_state_invalid');
    throw error;
  } finally { await handle?.close(); }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('feedback_doas_cache_unsafe');
  }
}
function execute(executable: string, args: string[], directory: string): Promise<string> {
  const temporary = join(directory, 'tmp');
  const identity = join(directory, 'identity');
  const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, DOAS_IDENTITY_DIR: identity, DOAS_NO_INTERACTION: 'true' };
  const supervisor = [
    'use Fcntl qw(:flock :DEFAULT F_SETFD); use POSIX qw(setpgid);',
    'umask 0077; my $path = shift @ARGV;',
    'sysopen(my $lock, $path, O_RDWR|O_CREAT, 0600) or exit 120;',
    '$SIG{ALRM} = sub { exit 121 }; alarm 35;',
    'flock($lock, LOCK_EX) or exit 122; alarm 0;',
    'defined(fcntl($lock, F_SETFD, 0)) or exit 123;',
    'my $child = fork(); defined($child) or exit 123;',
    'if (!$child) { setpgid(0,0); exec {$ARGV[0]} @ARGV; exit 124; }',
    '$SIG{ALRM} = $SIG{TERM} = sub { kill 9, -$child; kill 9, $child; waitpid($child,0); exit 125; };',
    'alarm 15; waitpid($child,0); my $status=$?; alarm 0;',
    'exit(($status & 127) ? 126 : ($status >> 8));',
  ].join(' ');
  return new Promise((resolve, reject) => {
    execFile('perl', ['-e', supervisor, join(directory, 'command.lock'), executable, ...args], { env, cwd: directory, shell: false, timeout: 55000, maxBuffer: 128 * 1024, encoding: 'utf8', killSignal: 'SIGTERM' }, (error, stdout) => {
      if (error) { reject(new Error('feedback_doas_command_failed')); return; }
      resolve(stdout);
    });
  });
}
export function createDoasTokenSource(dataDir: string, config: DoasTokenConfig, executable = 'doas'): TokenSource & { directory: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(config.psm) || !['boe', 'cn', 'row', 'nontt', 'euttp', 'usttp'].includes(config.environment)) {
    throw new Error('feedback_doas_config_invalid');
  }
  const key = createHash('sha256').update(JSON.stringify([config.psm, config.environment])).digest('hex');
  const directory = join(dataDir, 'feedback-doas', key);
  let pending: Promise<DynamicToken> | undefined;
  let cached: DynamicToken | undefined;
  let cachedUntil = 0;
  const load = async (rejected?: number): Promise<DynamicToken> => {
    const canonical = await realpath(dataDir);
    const parent = join(canonical, 'feedback-doas');
    await privateDirectory(parent);
    const root = join(parent, key);
    await privateDirectory(root);
    await privateDirectory(join(root, 'tmp'));
    await privateDirectory(join(root, 'identity'));
    return withFileLock(join(root, 'refresh'), async () => {
      const generationPath = join(root, 'generation.json');
      const credentialPath = join(root, 'credential.json');
      let generation = 0, unusable = false;
      let rejectedHash: string | undefined;
      let tokenHash: string | undefined;
      try {
        const info = await lstat(generationPath);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('feedback_doas_cache_unsafe');
        const value = JSON.parse(await readFile(generationPath, 'utf8'));
        if (!Number.isSafeInteger(value.generation) || value.generation < 0 || typeof value.unusable !== 'boolean') throw new Error();
        generation = value.generation; unusable = value.unusable;
        if (value.rejectedHash !== undefined && !/^[0-9a-f]{64}$/.test(value.rejectedHash)) throw new Error();
        if (value.tokenHash !== undefined && !/^[0-9a-f]{64}$/.test(value.tokenHash)) throw new Error();
        rejectedHash = value.rejectedHash;
        tokenHash = value.tokenHash;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('feedback_doas_state_invalid');
        if (cached) throw new Error('feedback_doas_state_invalid');
      }
      if (rejected !== undefined && generation <= rejected && !unusable) {
        rejectedHash = tokenHash ?? (cached ? createHash('sha256').update(cached.value).digest('hex') : rejectedHash);
        cached = undefined;
        cachedUntil = 0;
        generation += 1;
        unusable = true;
        await atomicWriteFile(generationPath, JSON.stringify({ generation, unusable, rejectedHash }), { mode: 0o600, durable: true, followTargetSymlink: false });
        await unlink(credentialPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await execute(executable, ['--identity-dir', join(root, 'identity'), 'clean'], root);
      } else if (!unusable) {
        if (cached?.generation === generation && cachedUntil > Date.now()) return cached;
        const shared = await readCachedCredential(credentialPath, generation, tokenHash);
        if (shared) {
          cached = shared;
          cachedUntil = 0;
          return shared;
        }
      }
      const stdout = await execute(executable, ['--type', 'gdpr', '-p', config.psm, '--print-env', '-e', config.environment, '--no-interaction', '--identity-dir', join(root, 'identity')], root);
      const token = stdout.trim();
      if (!token || token.length > 65536 || /[\s\0]/.test(token)) throw new Error('feedback_doas_output_invalid');
      if (rejectedHash === createHash('sha256').update(token).digest('hex')) throw new Error('feedback_doas_refresh_failed');
      const nextHash = createHash('sha256').update(token).digest('hex');
      const validUntil = credentialCacheDeadline(token, Date.now());
      if (tokenHash && nextHash !== tokenHash && !unusable) generation += 1;
      tokenHash = nextHash;
      await atomicWriteFile(generationPath, JSON.stringify({ generation, unusable: false, rejectedHash, tokenHash }), { mode: 0o600, durable: true, followTargetSymlink: false });
      await atomicWriteFile(credentialPath, JSON.stringify({ generation, tokenHash, token, validUntil }),
        { mode: 0o600, durable: true, followTargetSymlink: false });
      cached = { value: token, generation };
      cachedUntil = validUntil;
      return cached;
    }, { maxWaitMs: 35000 });
  };
  const run = (rejected?: number): Promise<DynamicToken> => {
    if (pending) return pending.then(value => rejected !== undefined && value.generation <= rejected ? run(rejected) : value);
    const current = load(rejected);
    pending = current;
    void current.finally(() => { if (pending === current) pending = undefined; }).catch(() => {});
    return current;
  };
  return { directory, get: () => run(), refresh: generation => run(generation) };
}
