import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as dotenvParse } from 'dotenv';

export interface GithubAuthResolveOptions {
  env?: NodeJS.ProcessEnv;
  envFilePath?: string | null;
  readTextFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
}

export interface GithubGitAuthOptions extends GithubAuthResolveOptions {
  /** Test seam; defaults to the active `gh auth` account on github.com. */
  readGhToken?: () => string | null;
}

function firstNonBlank(values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) return trimmed;
  }
  return null;
}

function readGithubTokenFromEnvFile(
  envFilePath: string | null | undefined,
  readTextFile: (path: string) => string,
  fileExists: (path: string) => boolean,
): string | null {
  if (!envFilePath || !fileExists(envFilePath)) return null;
  try {
    const parsed = dotenvParse(readTextFile(envFilePath));
    return firstNonBlank([parsed.GITHUB_TOKEN, parsed.GH_TOKEN]);
  } catch {
    return null;
  }
}

function defaultGlobalEnvPath(): string | null {
  try {
    return join(homedir(), '.botmux', '.env');
  } catch {
    return null;
  }
}

function resolveGithubToken(options?: GithubAuthResolveOptions): string | null {
  const env = options?.env ?? process.env;
  const processToken = firstNonBlank([env.GITHUB_TOKEN, env.GH_TOKEN]);
  if (processToken) return processToken;

  const envFilePath = options?.envFilePath === undefined ? defaultGlobalEnvPath() : options.envFilePath;
  return readGithubTokenFromEnvFile(
    envFilePath,
    options?.readTextFile ?? ((path) => readFileSync(path, 'utf8')),
    options?.fileExists ?? existsSync,
  );
}

/**
 * Inject GitHub HTTPS authentication without placing the token in the remote
 * URL or process argv. Git treats GIT_CONFIG_KEY/VALUE pairs exactly like
 * scoped `-c` configuration, while keeping command/error rendering secret-free.
 *
 * Existing injected config entries are preserved so callers that already use
 * this mechanism do not lose their Git settings.
 */
function readGithubTokenFromGhCli(env: NodeJS.ProcessEnv): string | null {
  try {
    const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

export function githubGitAuthEnv(options?: GithubGitAuthOptions): NodeJS.ProcessEnv {
  const env = options?.env ?? process.env;
  const token = resolveGithubToken(options)
    ?? (options?.readGhToken ?? (() => readGithubTokenFromGhCli(env)))();
  if (!token) return {};

  const parsedCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10);
  const count = Number.isSafeInteger(parsedCount) && parsedCount >= 0 ? parsedCount : 0;
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'http.https://github.com/.extraheader',
    [`GIT_CONFIG_VALUE_${count}`]: `Authorization: Basic ${basic}`,
  };
}

export function githubAuthHeaders(options?: GithubAuthResolveOptions): Record<string, string> {
  const token = resolveGithubToken(options);
  return token ? { Authorization: `Bearer ${token}` } : {};
}
