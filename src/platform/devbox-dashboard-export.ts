import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  readSecureHostFileSync,
  writeSecureHostFileSync,
} from './secure-host-file.js';

const CACHE_PATH = join(homedir(), '.botmux', 'devbox-dashboard-export.json');
const EXPORT_TIMEOUT_MS = 5_000;

interface DevboxDashboardExportCache {
  workspaceId: string;
  port: number;
  shortUrl: string;
}

export interface EnsureDevboxDashboardExportOptions {
  port: number;
  remoteBaseConfigured: boolean;
  env?: NodeJS.ProcessEnv;
  cachePath?: string;
  timeoutMs?: number;
  merlinCliPath?: string;
  runExport?: (binary: string, port: number, timeoutMs: number) => Promise<string>;
}

function enabled(env: NodeJS.ProcessEnv): boolean {
  return (env.BOTMUX_DEVBOX_AUTO_EXPORT ?? '1').trim().toLowerCase() !== '0'
    && (env.BOTMUX_DEVBOX_AUTO_EXPORT ?? '1').trim().toLowerCase() !== 'false';
}

function isExportablePort(port: number, env: NodeJS.ProcessEnv): boolean {
  if (port >= 9001 && port <= 9010) return true;
  return (env.PORT_LIST ?? '').split(',').some(value => Number(value.trim()) === port);
}

function validPrivateShortUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function readCache(path = CACHE_PATH): DevboxDashboardExportCache | null {
  try {
    const raw = readSecureHostFileSync(path);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DevboxDashboardExportCache>;
    const shortUrl = validPrivateShortUrl(parsed.shortUrl);
    if (typeof parsed.workspaceId !== 'string' || typeof parsed.port !== 'number'
      || !Number.isInteger(parsed.port) || !shortUrl) return null;
    return { workspaceId: parsed.workspaceId, port: parsed.port, shortUrl };
  } catch {
    return null;
  }
}

export function devboxDashboardBaseUrl(
  cachePath = CACHE_PATH,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const workspaceId = env.ARNOLD_WORKSPACE_ID?.trim();
  if (!enabled(env) || !workspaceId || !env.PORT_LIST) return null;
  const cached = readCache(cachePath);
  return cached?.workspaceId === workspaceId ? cached.shortUrl : null;
}

function findMerlinCli(): string | null {
  const candidates = [join(homedir(), '.merlin-cli', 'bin', 'merlin-cli')];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known installation location.
    }
  }
  // PATH-based installs are still supported. spawn() fails softly with ENOENT
  // when the command is absent, so this never invokes a shell or login prompt.
  return 'merlin-cli';
}

async function runMerlinExport(binary: string, port: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['cpu-devbox', 'export', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('devbox export timed out'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(`${stderr}\n${stdout}`);
      else reject(new Error(`merlin-cli exited ${code}`));
    });
  });
}

function parseExportOutput(output: string): { shortUrl: string; isPublic: boolean } | null {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as { short_url?: unknown; is_public?: unknown };
    const shortUrl = validPrivateShortUrl(parsed.short_url);
    if (!shortUrl || parsed.is_public !== false) return null;
    return { shortUrl, isPublic: false };
  } catch {
    return null;
  }
}

export async function ensureDevboxDashboardExport(
  opts: EnsureDevboxDashboardExportOptions,
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const workspaceId = env.ARNOLD_WORKSPACE_ID?.trim();
  if (!enabled(env) || opts.remoteBaseConfigured || !workspaceId || !env.PORT_LIST || !isExportablePort(opts.port, env)) {
    return null;
  }

  const cachePath = opts.cachePath ?? CACHE_PATH;
  const cached = readCache(cachePath);
  if (cached?.workspaceId === workspaceId && cached.port === opts.port) return cached.shortUrl;

  const binary = opts.merlinCliPath ?? findMerlinCli();
  if (!binary) return null;
  try {
    const output = await (opts.runExport ?? runMerlinExport)(binary, opts.port, opts.timeoutMs ?? EXPORT_TIMEOUT_MS);
    const result = parseExportOutput(output);
    if (!result) return null;
    writeSecureHostFileSync(cachePath, `${JSON.stringify({
      workspaceId,
      port: opts.port,
      shortUrl: result.shortUrl,
    }, null, 2)}\n`);
    return result.shortUrl;
  } catch {
    return null;
  }
}
