import { describe, expect, it } from 'vitest';
import { githubAuthHeaders, githubGitAuthEnv } from '../src/core/github-auth.js';

describe('githubAuthHeaders', () => {
  it('prefers process GITHUB_TOKEN over GH_TOKEN', () => {
    const headers = githubAuthHeaders({
      env: { GITHUB_TOKEN: ' ghp_primary ', GH_TOKEN: 'ghs_fallback' },
      envFilePath: null,
    });
    expect(headers.Authorization).toBe('Bearer ghp_primary');
  });

  it('falls back to process GH_TOKEN when GITHUB_TOKEN is absent', () => {
    const headers = githubAuthHeaders({
      env: { GH_TOKEN: ' ghs_fallback ' },
      envFilePath: null,
    });
    expect(headers.Authorization).toBe('Bearer ghs_fallback');
  });

  it('falls back to env-file GITHUB_TOKEN when process env is unset', () => {
    const headers = githubAuthHeaders({
      env: {},
      envFilePath: '/tmp/global.env',
      fileExists: () => true,
      readTextFile: () => 'GITHUB_TOKEN=ghp_from_file\nGH_TOKEN=ghs_ignored\n',
    });
    expect(headers.Authorization).toBe('Bearer ghp_from_file');
  });

  it('falls back to env-file GH_TOKEN when file GITHUB_TOKEN is absent', () => {
    const headers = githubAuthHeaders({
      env: {},
      envFilePath: '/tmp/global.env',
      fileExists: () => true,
      readTextFile: () => 'GH_TOKEN=ghs_from_file\n',
    });
    expect(headers.Authorization).toBe('Bearer ghs_from_file');
  });

  it('returns no auth header on missing or invalid env file', () => {
    expect(githubAuthHeaders({
      env: {},
      envFilePath: '/tmp/missing.env',
      fileExists: () => false,
    })).toEqual({});

    expect(githubAuthHeaders({
      env: {},
      envFilePath: '/tmp/bad.env',
      fileExists: () => true,
      readTextFile: () => {
        throw new Error('read failed');
      },
    })).toEqual({});
  });
});

describe('githubGitAuthEnv', () => {
  it('scopes a token to GitHub HTTPS without putting it in argv or a URL', () => {
    const env = githubGitAuthEnv({
      env: { GITHUB_TOKEN: 'ghp_private' },
      envFilePath: null,
      readGhToken: () => null,
    });

    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(Buffer.from(String(env.GIT_CONFIG_VALUE_0).split(' ').at(-1)!, 'base64').toString('utf8'))
      .toBe('x-access-token:ghp_private');
    expect(JSON.stringify(env)).not.toContain('https://x-access-token');
  });

  it('appends to existing environment config and stays empty without a token', () => {
    expect(githubGitAuthEnv({ env: {}, envFilePath: null, readGhToken: () => null })).toEqual({});
    expect(githubGitAuthEnv({
      env: { GH_TOKEN: 'ghs_private', GIT_CONFIG_COUNT: '2' },
      envFilePath: null,
      readGhToken: () => null,
    })).toMatchObject({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_2: 'http.https://github.com/.extraheader',
    });
  });

  it('falls back to the active gh account when env tokens are absent', () => {
    const env = githubGitAuthEnv({
      env: {},
      envFilePath: null,
      readGhToken: () => 'gho_from_keyring',
    });
    expect(Buffer.from(String(env.GIT_CONFIG_VALUE_0).split(' ').at(-1)!, 'base64').toString('utf8'))
      .toBe('x-access-token:gho_from_keyring');
  });
});
