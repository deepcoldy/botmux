import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as dotenvParse } from 'dotenv';

export interface GithubAuthResolveOptions {
  env?: NodeJS.ProcessEnv;
  envFilePath?: string | null;
  readTextFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
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

export function githubAuthHeaders(options?: GithubAuthResolveOptions): Record<string, string> {
  const token = resolveGithubToken(options);
  return token ? { Authorization: `Bearer ${token}` } : {};
}
