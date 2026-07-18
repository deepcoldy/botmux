import { describe, expect, it } from 'vitest';
import { githubAuthHeaders } from '../src/core/github-auth.js';

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
