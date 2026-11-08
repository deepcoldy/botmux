import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
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
      }
      if (rejected !== undefined && generation <= rejected && !unusable) {
        rejectedHash = tokenHash ?? (cached ? createHash('sha256').update(cached.value).digest('hex') : rejectedHash);
        cached = undefined;
        generation += 1;
        unusable = true;
        await atomicWriteFile(generationPath, JSON.stringify({ generation, unusable, rejectedHash }), { mode: 0o600, durable: true, followTargetSymlink: false });
        await execute(executable, ['--identity-dir', join(root, 'identity'), 'clean'], root);
      } else if (cached?.generation === generation && !unusable) return cached;
      const stdout = await execute(executable, ['--type', 'gdpr', '-p', config.psm, '--print-env', '-e', config.environment, '--no-interaction', '--identity-dir', join(root, 'identity')], root);
      const token = stdout.trim();
      if (!token || token.length > 65536 || /[\s\0]/.test(token)) throw new Error('feedback_doas_output_invalid');
      if (rejectedHash === createHash('sha256').update(token).digest('hex')) throw new Error('feedback_doas_refresh_failed');
      const nextHash = createHash('sha256').update(token).digest('hex');
      if (tokenHash && nextHash !== tokenHash && !unusable) generation += 1;
      tokenHash = nextHash;
      await atomicWriteFile(generationPath, JSON.stringify({ generation, unusable: false, rejectedHash, tokenHash }), { mode: 0o600, durable: true, followTargetSymlink: false });
      cached = { value: token, generation };
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
